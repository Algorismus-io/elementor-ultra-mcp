/// <reference lib="dom" />
/**
 * WP-H03 — PARSE stage: render-then-extract via headless Playwright `getComputedStyle`.
 *
 * (The `dom` lib reference above is scoped to THIS file only — the server tsconfig deliberately omits
 * `dom` from its global `lib` because the server is a Node process. The in-page `page.evaluate`
 * functions here execute in the browser, so they need DOM globals (`document`, `getComputedStyle`,
 * `Element`, …) typed at compile time. The reference adds them for this module without changing the
 * shared tsconfig — no Node globals are lost since `dom` is additive.)
 *
 * The first and most safety-critical conversion stage. We DO NOT statically compute the CSS cascade
 * (no Node library computes it correctly — SUPPLEMENT §C.3). Instead we load HTML+CSS in a real
 * headless Chromium, let the browser resolve the full cascade (including external `<link>`/`@import`
 * stylesheets), then walk the live DOM in `page.evaluate` and read each element's EFFECTIVE styling
 * via `getComputedStyle`, whitelisted to exactly `STYLE_WHITELIST` (WP-H01), plus
 * `getBoundingClientRect()` for downstream flex-intent inference.
 *
 * The output is the pipeline IR forest (`IrNode[]` — WP-H01 `types.ts`); this stage performs NO
 * classification, mapping, or Elementor I/O (`role` is seeded `'unknown'` for CLASSIFY/WP-H05). The
 * function is implemented against the FROZEN `ParseInput`/`ParseResult` types owned by WP-H01 — they
 * are `import type`d here, never redeclared.
 *
 * Technique highlights (`WP-H03` Detailed Requirements):
 *   - Whitelisted `getComputedStyle` (exactly `STYLE_WHITELIST`, no more/less) → `IrNode.computed`.
 *   - Parent-diff: for INHERITED props, omit a node's value when equal to its parent's → small,
 *     clean style sets (SUPPLEMENT §C.2/§C.3).
 *   - Forced pseudo-states via the Chrome DevTools Protocol (`CSS.forcePseudoState`): plain
 *     `getComputedStyle` never returns `:hover`/`:focus` styling, so the CDP force is mandatory;
 *     we record ONLY the props that CHANGED vs. the base → `hoverComputed`/`focusComputed`.
 *   - Per-breakpoint capture at the passed-in widths (never hardcoded), storing only the DELTA vs.
 *     the base capture → `IrNode.responsive[bp]`.
 *   - Media refs (`<img>`/background-image/YouTube `<iframe>`/`<video>`/`<svg>`) recorded, NOT
 *     sideloaded.
 *   - `raw_inner_markup[source_path]` = verbatim inner HTML of text-bearing nodes (NORMALIZE diff).
 *   - `doc_direction` from the computed root direction (drives WP-H02 logical mapping).
 *
 * `css-tree` is used ONLY for a cheap selector/`@media` pre-scan (decide whether to capture states /
 * which breakpoints have overrides) — never for cascade computation. The AUTHORITATIVE style source
 * is always the browser.
 */

import { createRequire } from 'node:module';

import type { Page } from 'playwright';

import { withPage } from './browser-pool.js';
import { censusFontLinks, type FontAssets } from './fonts.js';
import { STYLE_WHITELIST } from './mapping-table.js';
import type {
  ComputedStyleSet,
  IrNode,
  MediaRef,
  PageScript,
  ParseInput,
  ParseResult,
  ParseWarning,
  SemanticRole,
  TextRun,
} from './types.js';

/* ─────────────────────────── Pure helpers (no Playwright — always unit-tested) ───────────────── */

/**
 * CSS properties that INHERIT by default (per the CSS spec). PARSE drops an inherited prop from a
 * child's `computed` when it equals the parent's computed value (parent-diff), yielding small style
 * sets instead of a per-node explosion. Non-inheritable props are ALWAYS kept. Only the subset that
 * also appears in `STYLE_WHITELIST` actually matters at runtime, but the full inheritable set is
 * listed for correctness + auditability (`WP-H03` Detailed Requirements §3).
 */
export const INHERITED_PROPS: ReadonlySet<string> = new Set<string>([
  'color',
  'cursor',
  'direction',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-decoration',
  'text-transform',
  'word-spacing',
  'visibility',
  'white-space',
  'list-style',
  'list-style-type',
  'list-style-position',
]);

/** Stable, frozen copy of the whitelist as a plain string[] (serializable into `page.evaluate`). */
const WHITELIST: readonly string[] = STYLE_WHITELIST;

/** The CDP-forced pseudo-states we capture, mapped 1:1 onto authoring states (authoring-contract §5.2). */
const FORCE_STATES: ReadonlyArray<{ pseudo: string; key: 'hover' | 'focus' }> = [
  { pseudo: 'hover', key: 'hover' },
  { pseudo: 'focus', key: 'focus' },
];

/**
 * The default seeded semantic role. PARSE assigns NO real roles (that is CLASSIFY/WP-H05); every node
 * starts `'unknown'` so the IR is well-typed without this stage classifying anything.
 */
const SEED_ROLE: SemanticRole = 'unknown';

/**
 * Diff a node's whitelisted computed set against its parent's, dropping INHERITED props whose value
 * equals the parent's (they were inherited, not authored on this node). Non-inheritable props are
 * always kept. Pure + browser-free so it is unit-testable directly.
 *
 * @param own the node's whitelisted `getComputedStyle` pick.
 * @param parent the parent's whitelisted pick (`undefined`/`null` for a root node → nothing dropped).
 */
export function diffInheritedAgainstParent(
  own: ComputedStyleSet,
  parent: ComputedStyleSet | null | undefined,
): ComputedStyleSet {
  if (!parent) {
    return { ...own };
  }
  const out: ComputedStyleSet = {};
  for (const [prop, value] of Object.entries(own)) {
    if (INHERITED_PROPS.has(prop) && parent[prop] === value) {
      continue; // inherited from parent — omit
    }
    out[prop] = value;
  }
  return out;
}

/**
 * Compute the per-state delta: the props in `state` whose value CHANGED relative to `base`. Used for
 * `hoverComputed`/`focusComputed` (record only what the pseudo-state actually changed) and for the
 * per-breakpoint `responsive[bp]` delta. Pure.
 */
export function computedDelta(
  base: ComputedStyleSet,
  state: ComputedStyleSet,
): Partial<ComputedStyleSet> {
  const out: Partial<ComputedStyleSet> = {};
  for (const [prop, value] of Object.entries(state)) {
    if (base[prop] !== value) {
      out[prop] = value;
    }
  }
  return out;
}

/**
 * Scan raw CSS text for the presence of interactive pseudo-state rules (`:hover`/`:focus`/
 * `:focus-visible`/`:active`) using `css-tree` when available, falling back to a cheap regex. This is
 * a PRE-SCAN only (decide whether to force states) — NOT cascade computation. Pure (no browser).
 *
 * @returns `true` if any state rule exists, so `balanced` fidelity knows to force states.
 */
export function detectStateRules(css: string): boolean {
  if (!css) {
    return false;
  }
  try {
    // css-tree is optional at runtime; if absent, the catch falls back to the regex below.
    const csstree = tryRequireCssTree();
    if (csstree) {
      let found = false;
      const ast = csstree.parse(css);
      csstree.walk(ast, {
        visit: 'PseudoClassSelector',
        enter(node: { name: string }) {
          if (/^(hover|focus|focus-visible|active)$/.test(node.name)) {
            found = true;
          }
        },
      });
      return found;
    }
  } catch {
    /* fall through to regex */
  }
  return /:(hover|focus|focus-visible|active)\b/.test(css);
}

/**
 * Scan raw CSS text for `@media` rules (breakpoint overrides). PRE-SCAN only; pure. When no `@media`
 * exists, the orchestrator/PARSE can skip per-breakpoint re-renders for `balanced` (each captured
 * breakpoint would just produce an empty delta).
 */
export function detectMediaRules(css: string): boolean {
  if (!css) {
    return false;
  }
  try {
    const csstree = tryRequireCssTree();
    if (csstree) {
      let found = false;
      const ast = csstree.parse(css);
      csstree.walk(ast, {
        visit: 'Atrule',
        enter(node: { name: string }) {
          if (node.name === 'media') {
            found = true;
          }
        },
      });
      return found;
    }
  } catch {
    /* fall through to regex */
  }
  return /@media\b/.test(css);
}

/**
 * Detect whether HTML references EXTERNAL stylesheets (`<link rel="stylesheet">` or `@import`). When
 * `base_url` is absent these may be unresolvable → PARSE surfaces a `ParseWarning` (not a crash).
 * Pure (regex over the raw HTML/CSS).
 */
export function hasExternalStyleRefs(html: string, css?: string): boolean {
  const linkRe = /<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/i;
  const importRe = /@import\b/i;
  if (linkRe.test(html) || importRe.test(html)) {
    return true;
  }
  if (css && importRe.test(css)) {
    return true;
  }
  return false;
}

/**
 * Resolve which fidelity tier captures states / which breakpoints. `fast` = single desktop capture,
 * no states. `balanced` = breakpoints + states only when `:hover`/`:focus` rules exist. `high` = all
 * breakpoints + all states. An explicit `capture_states` on the input overrides the tier heuristic.
 * Pure.
 */
export function resolveCapturePlan(input: ParseInput): {
  captureStates: boolean;
  captureBreakpoints: boolean;
} {
  const css = input.css ?? '';
  const stateRulesPresent = detectStateRules(css);
  switch (input.fidelity) {
    case 'fast':
      return { captureStates: false, captureBreakpoints: false };
    case 'high':
      return {
        captureStates: input.capture_states ?? true,
        captureBreakpoints: true,
      };
    case 'balanced':
    default:
      return {
        captureStates: input.capture_states ?? stateRulesPresent,
        captureBreakpoints: true,
      };
  }
}

/**
 * The tags the in-page walker treats as inherently text-bearing (known text tags — always extract
 * runs when they carry text, even with element children). MUST stay in lockstep with the regex
 * inside `inPageExtract`'s `isTextBearing` (that copy is serialized into `page.evaluate` and
 * cannot reference module scope).
 */
const TEXT_BEARING_TAG_RE =
  /^(h[1-6]|p|span|a|button|li|small|cite|blockquote|figcaption|label|strong|em|b|i|td|th|dt|dd|summary)$/;

/**
 * The text-bearing decision over a node's pre-computed shape, exported PURE for unit tests
 * (contract 18 §7 P1-a). A node extracts text runs iff it has non-whitespace text AND any of:
 *   (a) a known text tag ({@link TEXT_BEARING_TAG_RE});
 *   (b) a childless generic container (`<div class="price">$29</div>` is a leaf text node);
 *   (c) **P1-a — MIXED children**: a generic container with a non-whitespace bare TEXT node beside
 *       element children (`<div>$0<small>/forever</small></div>`). The previous childless-only rule
 *       silently dropped the bare text — `$0` belonged to no child element and a container emits no
 *       runs, so it vanished with no `stripped_text` record.
 * MUST stay in lockstep with `isTextBearing` inside `inPageExtract` (the in-page copy is serialized
 * into `page.evaluate` and cannot call this function).
 */
export function isTextBearingShape(shape: {
  tag: string;
  hasNonWhitespaceText: boolean;
  elementChildCount: number;
  hasBareTextChild: boolean;
}): boolean {
  if (!shape.hasNonWhitespaceText) {
    return false;
  }
  if (TEXT_BEARING_TAG_RE.test(shape.tag)) {
    return true;
  }
  if (shape.elementChildCount === 0) {
    return true;
  }
  return shape.hasBareTextChild;
}

/**
 * Script census (contract 16 §1/§2): record EVERY `<script>` tag in the SOURCE html —
 * `src`/`inline_bytes`/`external` — into `ParseResult.pageScripts` for Tier 3 bundling / behavior
 * coverage. Scans the raw input (the author's scripts are what Tier 3 would bundle), never the live
 * DOM (runtime-injected scripts are not source). Pure (regex over the raw HTML) + unit-testable.
 */
export function censusScripts(html: string): PageScript[] {
  const out: PageScript[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  const srcRe = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const srcMatch = srcRe.exec(attrs);
    const src = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? null) : null;
    out.push({
      src,
      inline_bytes: src !== null ? 0 : new TextEncoder().encode(body).length,
      external: src !== null,
    });
  }
  return out;
}

/* ─────────────────────────── Contract 17 #9/#10 — additive capture extensions ────────────────── */

/**
 * Additive extension of the frozen `ParseResult` (contract 17 #9): the webfont capture. Declared
 * here (the producing stage) rather than re-freezing WP-H01 — same additive pattern as the
 * `LinkedTextRun` link capture. `fontAssets` is ALWAYS populated by `parseHtml` (`links` from the
 * raw-source census, `families` from the CSSOM/FontFaceSet probe, best-effort).
 */
export interface FontAwareParseResult extends ParseResult {
  fontAssets: FontAssets;
}

/**
 * The fixed prop set captured for a RENDERING `::before`/`::after` pseudo-element (contract 17
 * #10): content + box size + paint + radius + positioning scheme + insets + display, plus
 * `mask-image` so NORMALIZE can refuse mask-bearing pseudos honestly (`pseudo_unrepresentable`).
 * Deliberately NOT `STYLE_WHITELIST` — pseudo capture is its own annotation channel and never
 * alters the element's own `computed` pick (same purity rule as the behavior probes, 16 §8 inv 5).
 */
export const PSEUDO_CAPTURE_PROPS: readonly string[] = [
  'content',
  'display',
  'position',
  'width',
  'height',
  'top',
  'right',
  'bottom',
  'left',
  'background-color',
  'background-image',
  'border-radius',
  'mask-image',
  // Padding longhands (contract 17 §1 I2): a synthesized pseudo maps to a container whose base
  // padding PAINTS (e-div-block/e-flexbox 10px), so the source padding — usually 0px — must be
  // captured for NORMALIZE to carry as an explicit override and for I2 to judge the node.
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
];

/**
 * Additive extension of the frozen `IrNode` (contract 17 #10): the per-element `::before`/
 * `::after` computed capture ({@link PSEUDO_CAPTURE_PROPS} pick; present ONLY when the pseudo
 * actually renders — `content != none` and `display != none`). NORMALIZE consumes these fields
 * (synthesizing representable pseudos as real child nodes) and does NOT carry them through, so a
 * normalized tree is pseudo-annotation-free (idempotence).
 */
export interface PseudoIrNode extends IrNode {
  pseudoBefore?: ComputedStyleSet;
  pseudoAfter?: ComputedStyleSet;
}

/**
 * Additive extension of the frozen `IrNode` (contract 18 §7 P2-d): the source element's `id`
 * attribute as an explicit first-class field — same additive pattern as `LinkedTextRun`/
 * {@link PseudoIrNode}. In-page `#anchor` hrefs are carried by the link capture, but the TARGET
 * ids died with the source markup (the attributes transformer downstream is a no-op), so every
 * `<a href="#pricing">` navigated to nothing. The raw attribute still rides `IrNode.attrs['id']`
 * verbatim; `sourceId` is the stable seam MAP/ASSEMBLE consume to re-emit the anchor target on
 * the converted node. Present ONLY when the source element had a non-empty `id` (no noise keys).
 */
export interface SourceIdIrNode extends IrNode {
  sourceId?: string;
}

/** Cached css-tree module handle: `undefined` = not yet probed, `null` = absent, else the module. */
let cssTreeCache: CssTreeLike | null | undefined;

/** Optional `css-tree` require, returning `null` when the dep is not installed. Keeps PARSE working
 * (browser is authoritative) even without `css-tree`; only the cheap pre-scan degrades to regex.
 * Uses `createRequire` (synchronous) so the pure pre-scan helpers stay synchronous. */
function tryRequireCssTree(): CssTreeLike | null {
  if (cssTreeCache !== undefined) {
    return cssTreeCache;
  }
  try {
    const req = createRequire(import.meta.url);
    cssTreeCache = req('css-tree') as CssTreeLike;
  } catch {
    cssTreeCache = null;
  }
  return cssTreeCache;
}

/** Minimal structural typing for the `css-tree` surface PARSE uses (parse + walk visitors). */
interface CssTreeLike {
  parse(css: string): unknown;
  walk(ast: unknown, options: { visit: string; enter(node: { name: string }): void }): void;
}

/* ─────────────────────────── In-page extraction (serialized into `page.evaluate`) ─────────────── */

/**
 * The flat per-node record the in-page walker emits. Kept small (only whitelisted props + the data
 * downstream stages need) to minimize the `page.evaluate` transfer payload (`WP-H03` Implementation
 * Notes). `responsive`/`hoverComputed`/`focusComputed` are filled in Node from per-capture maps keyed
 * by `source_path`.
 */
interface RawNode {
  source_path: string;
  tag: string;
  /** Whitelisted computed pick AFTER in-page parent-diff (inherited props already dropped). */
  computed: ComputedStyleSet;
  box: { x: number; y: number; width: number; height: number };
  attrs: Record<string, string>;
  textRuns: TextRun[];
  rawInnerMarkup?: string;
  media?: MediaRef;
  childPaths: string[];
}

/**
 * The in-page DOM-walk function. Serialized via `page.evaluate` and executed in the browser context
 * (so it must be SELF-CONTAINED — no Node closures except the two passed args). Walks `body`
 * depth-first, reading whitelisted `getComputedStyle`, doing the parent-diff in-page (cheap, parent
 * computed is local), and emitting `RawNode[]` plus the document direction.
 *
 * NOTE: this is defined as a stringifiable function and passed by reference to `page.evaluate`;
 * Playwright serializes it. Helpers it needs are declared INSIDE it.
 */
function inPageExtract(args: { whitelist: readonly string[]; inherited: readonly string[] }): {
  nodes: RawNode[];
  docDirection: 'ltr' | 'rtl';
  bodyBackground: string | null;
} {
  const { whitelist, inherited } = args;
  const inheritedSet = new Set(inherited);
  // Non-visual elements never become IR nodes: without this a body-level <script> falls through
  // `isTextBearing`'s childless-leaf rule and its SOURCE TEXT ships as an e-paragraph — script
  // bytes in the page under the default include_js:'none' (contract 16 §8.3). The Tier-3 script
  // census reads the RAW html separately (censusScripts), so nothing is silently lost.
  const NON_VISUAL = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);
  const INLINE_ALLOW = new Set([
    'b',
    'i',
    'em',
    'u',
    'a',
    'del',
    'span',
    'strong',
    'sup',
    'sub',
    's',
    'mark',
    'code',
    'br',
    'abbr',
    'cite',
  ]);

  function pickWhitelisted(el: Element): Record<string, string> {
    const cs = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const prop of whitelist) {
      const value = cs.getPropertyValue(prop);
      if (value !== '' && value !== undefined) {
        out[prop] = value.trim();
      }
    }
    return out;
  }

  function diffInherited(
    own: Record<string, string>,
    parent: Record<string, string> | null,
  ): Record<string, string> {
    if (!parent) {
      return own;
    }
    const out: Record<string, string> = {};
    for (const prop of Object.keys(own)) {
      if (inheritedSet.has(prop) && parent[prop] === own[prop]) {
        continue;
      }
      out[prop] = own[prop] as string;
    }
    return out;
  }

  function structuralPath(el: Element): string {
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
      const node: Element = cur;
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const sameTag = siblings.filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          segs.unshift(`${tag}:nth-child(${idx})`);
        } else {
          segs.unshift(tag);
        }
      } else {
        segs.unshift(tag);
      }
      cur = parent;
    }
    return segs.join('>');
  }

  function isTextBearing(el: Element): boolean {
    // MUST stay in lockstep with the module-scope `isTextBearingShape`/`TEXT_BEARING_TAG_RE`
    // (this copy is serialized into `page.evaluate` and cannot reference module scope).
    const t = el.tagName.toLowerCase();
    const hasText = el.textContent !== null && el.textContent.trim().length > 0;
    if (!hasText) {
      return false;
    }
    if (
      /^(h[1-6]|p|span|a|button|li|small|cite|blockquote|figcaption|label|strong|em|b|i|td|th|dt|dd|summary)$/.test(
        t,
      )
    ) {
      return true;
    }
    // A generic container (div/section/…) whose ONLY content is text — no ELEMENT children — is a leaf
    // text node. Extract its text so `<div class="price">$29</div>` doesn't silently drop its content
    // (CLASSIFY's geometry step maps a childless node with textRuns → the `text` role → e-paragraph).
    if (el.children.length === 0) {
      return true;
    }
    // P1-a (contract 18 §7) — MIXED children: a non-whitespace bare TEXT node beside element children
    // (`<div>$0<small>/forever</small></div>`). The childless-only rule silently dropped the bare text
    // ('$0' belongs to no child element, and a container emits no runs). Extracting runs here is safe:
    // `extractTextRuns` captures the bare text + INLINE_ALLOW descendants only (NORMALIZE's
    // PARSE_FOLDED_INLINE folds those duplicate inline child nodes), while non-inline element children
    // stay real IR child nodes that NORMALIZE PROMOTES to siblings of this text host — nothing is
    // duplicated and nothing is lost. Whitespace-only bare text (formatting between blocks) does NOT
    // make a container text-bearing.
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3 && (child.textContent ?? '').trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  function extractTextRuns(el: Element): {
    text: string;
    inlineTags: string[];
    linkHref?: string;
    linkTarget?: string;
    color?: string;
  }[] {
    type Run = {
      text: string;
      inlineTags: string[];
      linkHref?: string;
      linkTarget?: string;
      color?: string;
    };
    const runs: Run[] = [];
    // Inter-run whitespace tracker. Whitespace-ONLY text nodes (the gap in `<span>A</span>
    // <span>B</span>`) and `<br>` used to be dropped entirely, so MAP's run join glued adjacent
    // runs into one word ("Intelligence.Powered", "yourengineering" — field-found on a live-site
    // convert, 2026-07-02). Remember the separator and prepend ONE space to the next run.
    let pendingSpace = false;
    const parentColor = getComputedStyle(el).color;
    const walk = (
      node: Node,
      wrappers: string[],
      link: { href: string; target?: string } | null,
    ): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const text = child.textContent ?? '';
          if (text.trim().length === 0) {
            if (runs.length > 0) pendingSpace = true;
            continue;
          }
          {
            let runText = text;
            const prev = runs[runs.length - 1];
            if (
              pendingSpace &&
              prev !== undefined &&
              !/\s$/.test(prev.text) &&
              !/^\s/.test(runText)
            ) {
              runText = ` ${runText}`;
            }
            pendingSpace = false;
            const irRun: Run = { text: runText, inlineTags: [...wrappers] };
            // Carry the nearest wrapping <a>'s destination on the run: `inlineTags` holds tag NAMES
            // only, so without this every in-text link serialized back as a bare dead `<a>`
            // (html-v3's wp_kses explicitly keeps a[href][target] — html-prop-type.php).
            if (link !== null) {
              irRun.linkHref = link.href;
              if (link.target !== undefined) {
                irRun.linkTarget = link.target;
              }
            }
            // Contract 17 #8 — capture the run's computed color when an inline wrapper recolors it
            // (`.hero h1 em { color: var(--emerald) }`): MAP's html-v3 fold can only emit the accent
            // `style="color:…"` it was GIVEN, so without this capture every recolored run silently
            // fell back to the parent color (page 2439: an ink-colored hero <em>).
            const host = child.parentElement;
            if (host !== null && host !== el) {
              const runColor = getComputedStyle(host).color;
              if (runColor !== parentColor) {
                irRun.color = runColor;
              }
            }
            runs.push(irRun);
          }
        } else if (child.nodeType === 1) {
          const childEl = child as Element;
          const tag = childEl.tagName.toLowerCase();
          if (tag === 'br') {
            // A hard break inside a text node separates the surrounding runs — without this the
            // two lines glued into one word (same field bug as the whitespace-only node above).
            if (runs.length > 0) pendingSpace = true;
            continue;
          }
          if (INLINE_ALLOW.has(tag)) {
            let nextLink = link;
            if (tag === 'a') {
              const href = childEl.getAttribute('href');
              if (href !== null && href.trim().length > 0) {
                const target = childEl.getAttribute('target');
                nextLink = { href, ...(target !== null ? { target } : {}) };
              }
            }
            walk(childEl, [...wrappers, tag], nextLink);
          }
          // block-level descendants of a text node are NORMALIZE's concern; not recursed here.
        }
      }
    };
    walk(el, [], null);
    return runs;
  }

  function detectMedia(el: Element, computed: Record<string, string>): RawNode['media'] {
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? undefined;
      const srcset = el.getAttribute('srcset') ?? undefined;
      const alt = el.getAttribute('alt') ?? undefined;
      const m: Record<string, string> = { kind: 'img' };
      if (src !== undefined) m['url'] = src;
      if (srcset !== undefined) m['srcset'] = srcset;
      if (alt !== undefined) m['alt'] = alt;
      return m as unknown as RawNode['media'];
    }
    if (tag === 'video') {
      const src =
        el.getAttribute('src') ?? el.querySelector('source')?.getAttribute('src') ?? undefined;
      const m: Record<string, string> = { kind: 'video' };
      if (src !== undefined && src !== null) m['url'] = src;
      return m as unknown as RawNode['media'];
    }
    if (tag === 'svg') {
      return { kind: 'svg', url: el.outerHTML } as unknown as RawNode['media'];
    }
    if (tag === 'iframe') {
      const src = el.getAttribute('src') ?? '';
      const yt = src.match(
        /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{6,})/,
      );
      if (yt) {
        return {
          kind: 'youtube',
          url: src,
          embedId: yt[1],
        } as unknown as RawNode['media'];
      }
      return undefined;
    }
    // background-image (non-none) on any element
    const bg = computed['background-image'];
    if (bg && bg !== 'none') {
      const urlMatch = bg.match(/url\((['"]?)([^'")]+)\1\)/);
      if (urlMatch) {
        return {
          kind: 'background',
          url: urlMatch[2],
        } as unknown as RawNode['media'];
      }
    }
    return undefined;
  }

  const nodes: RawNode[] = [];
  const computedByPath = new Map<string, Record<string, string>>();

  const visit = (el: Element, parentComputed: Record<string, string> | null): string => {
    const sourcePath = structuralPath(el);
    const ownComputed = pickWhitelisted(el);
    computedByPath.set(sourcePath, ownComputed);
    const diffed = diffInherited(ownComputed, parentComputed);

    const rect = el.getBoundingClientRect();
    const attrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) {
      attrs[a.name] = a.value;
    }

    const childEls = Array.from(el.children).filter(
      (c) => !NON_VISUAL.has(c.tagName.toLowerCase()),
    );
    const childPaths: string[] = [];
    for (const child of childEls) {
      childPaths.push(visit(child, ownComputed));
    }

    const node: RawNode = {
      source_path: sourcePath,
      tag: el.tagName.toLowerCase(),
      computed: diffed,
      box: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      attrs,
      textRuns: isTextBearing(el) ? extractTextRuns(el) : [],
      childPaths,
    };
    if (isTextBearing(el)) {
      node.rawInnerMarkup = el.innerHTML;
    }
    const media = detectMedia(el, ownComputed);
    if (media) {
      node.media = media;
    }
    nodes.push(node);
    return sourcePath;
  };

  const body = document.body;
  for (const child of Array.from(body.children)) {
    if (NON_VISUAL.has(child.tagName.toLowerCase())) {
      continue;
    }
    visit(child, null);
  }

  const rootDir = getComputedStyle(document.documentElement).direction;
  const bodyDir = getComputedStyle(document.body).direction;
  const docDirection: 'ltr' | 'rtl' = bodyDir === 'rtl' || rootDir === 'rtl' ? 'rtl' : 'ltr';

  // Capture the page-level background (body, else <html>) so the pipeline can render a full-bleed
  // root container — a full-page conversion otherwise loses the document background (the converter
  // only walks body's CHILDREN), leaving a white page behind the content.
  const isTransparentBg = (c: string): boolean =>
    !c || c === 'transparent' || /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(c);
  const bodyBgRaw = getComputedStyle(document.body).backgroundColor;
  const htmlBgRaw = getComputedStyle(document.documentElement).backgroundColor;
  const bodyBackground: string | null = !isTransparentBg(bodyBgRaw)
    ? bodyBgRaw
    : !isTransparentBg(htmlBgRaw)
      ? htmlBgRaw
      : null;

  return { nodes, docDirection, bodyBackground };
}

/**
 * A lighter in-page re-read used for state/breakpoint re-captures: just the whitelisted computed pick
 * per `source_path` (NO parent-diff — deltas are computed against the BASE capture in Node, which is
 * how `responsive`/`hoverComputed` deltas are defined). Self-contained for `page.evaluate`.
 */
function inPageRecompute(args: {
  whitelist: readonly string[];
}): Record<string, Record<string, string>> {
  const { whitelist } = args;

  function structuralPath(el: Element): string {
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
      const node: Element = cur;
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const sameTag = siblings.filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          segs.unshift(`${tag}:nth-child(${idx})`);
        } else {
          segs.unshift(tag);
        }
      } else {
        segs.unshift(tag);
      }
      cur = parent;
    }
    return segs.join('>');
  }

  const out: Record<string, Record<string, string>> = {};
  const all = document.body.querySelectorAll('*');
  for (const el of Array.from(all)) {
    const cs = getComputedStyle(el);
    const pick: Record<string, string> = {};
    for (const prop of whitelist) {
      const v = cs.getPropertyValue(prop);
      if (v !== '' && v !== undefined) {
        pick[prop] = v.trim();
      }
    }
    out[structuralPath(el)] = pick;
  }
  return out;
}

/**
 * In-page behavior probe (contract 16 §2 runtime probes). Self-contained for `page.evaluate`:
 *   - ANIMATIONS: for every element whose computed `animation-name != none`, extract the matching
 *     `@keyframes` rule via CSSOM (walking `document.styleSheets`, including nested `@media`/
 *     `@supports` groups; cross-origin sheets are skipped) and capture the animated property set,
 *     the first→last opacity/transform deltas, and the computed duration/delay/easing.
 *   - TRANSITIONS: for every element with a non-zero-duration computed transition, capture
 *     property/duration/easing (CLASSIFY pairs these with the forced-`:hover` deltas → hover-effect).
 * Returns plain serializable maps keyed by `source_path`. NEVER touches `STYLE_WHITELIST` — the
 * probe reads its own computed values so the visual `computed` pick stays byte-identical (§8 inv 5).
 */
function inPageBehaviorProbe(): {
  animations: Record<
    string,
    {
      name: string;
      duration: string;
      delay: string;
      easing: string;
      keyframeProps: string[];
      opacity?: { from: number; to: number };
      transform?: { from: string; to: string };
    }
  >;
  transitions: Record<string, { property: string; duration: string; easing: string }>;
} {
  function structuralPath(el: Element): string {
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
      const node: Element = cur;
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const sameTag = siblings.filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          segs.unshift(`${tag}:nth-child(${idx})`);
        } else {
          segs.unshift(tag);
        }
      } else {
        segs.unshift(tag);
      }
      cur = parent;
    }
    return segs.join('>');
  }

  // --- CSSOM @keyframes index (name → CSSKeyframesRule), incl. nested grouping rules. ---
  const keyframesByName = new Map<string, CSSKeyframesRule>();
  const collectRules = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) {
        keyframesByName.set((rule as CSSKeyframesRule).name, rule as CSSKeyframesRule);
      } else {
        const nested = (rule as { cssRules?: CSSRuleList }).cssRules;
        if (nested) collectRules(nested);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collectRules(sheet.cssRules);
    } catch {
      /* cross-origin sheet — CSSOM access throws; skip */
    }
  }

  const firstSeg = (v: string): string => (v.split(',')[0] ?? '').trim();
  const hasNonZeroDuration = (v: string): boolean =>
    v.split(',').some((seg) => Number.parseFloat(seg) > 0);

  const animations: Record<
    string,
    {
      name: string;
      duration: string;
      delay: string;
      easing: string;
      keyframeProps: string[];
      opacity?: { from: number; to: number };
      transform?: { from: string; to: string };
    }
  > = {};
  const transitions: Record<string, { property: string; duration: string; easing: string }> = {};

  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const cs = getComputedStyle(el);

    // --- entrance-animation raw capture ---
    const animName = firstSeg(cs.animationName);
    if (animName !== '' && animName !== 'none') {
      const probe: (typeof animations)[string] = {
        name: animName,
        duration: firstSeg(cs.animationDuration),
        delay: firstSeg(cs.animationDelay),
        easing: firstSeg(cs.animationTimingFunction),
        keyframeProps: [],
      };
      const kf = keyframesByName.get(animName);
      if (kf) {
        const props = new Set<string>();
        let fromStyle: CSSStyleDeclaration | null = null;
        let toStyle: CSSStyleDeclaration | null = null;
        for (const frame of Array.from(kf.cssRules) as CSSKeyframeRule[]) {
          const keys = frame.keyText.split(',').map((k) => k.trim().toLowerCase());
          for (let i = 0; i < frame.style.length; i += 1) {
            const p = frame.style.item(i);
            if (p !== '') props.add(p);
          }
          if (keys.includes('from') || keys.includes('0%')) fromStyle = frame.style;
          if (keys.includes('to') || keys.includes('100%')) toStyle = frame.style;
        }
        probe.keyframeProps = [...props].sort();
        if (props.has('opacity')) {
          // A missing endpoint defaults to the element's base computed value.
          const base = Number.parseFloat(cs.opacity);
          const fromV = fromStyle?.getPropertyValue('opacity');
          const toV = toStyle?.getPropertyValue('opacity');
          probe.opacity = {
            from: fromV !== undefined && fromV !== '' ? Number.parseFloat(fromV) : base,
            to: toV !== undefined && toV !== '' ? Number.parseFloat(toV) : base,
          };
        }
        if (props.has('transform')) {
          const fromV = fromStyle?.getPropertyValue('transform');
          const toV = toStyle?.getPropertyValue('transform');
          probe.transform = {
            from: fromV !== undefined && fromV !== '' ? fromV : 'none',
            to: toV !== undefined && toV !== '' ? toV : 'none',
          };
        }
      }
      animations[structuralPath(el)] = probe;
    }

    // --- transition raw capture (non-zero duration only — the default `all 0s` is noise) ---
    if (hasNonZeroDuration(cs.transitionDuration)) {
      transitions[structuralPath(el)] = {
        property: cs.transitionProperty,
        duration: cs.transitionDuration,
        easing: cs.transitionTimingFunction,
      };
    }
  }

  return { animations, transitions };
}

/**
 * In-page `::before`/`::after` probe (contract 17 #10). Self-contained for `page.evaluate`: for
 * every element under `<body>`, read `getComputedStyle(el, '::before'|'::after')` and — when the
 * pseudo actually RENDERS (`content != none/normal` and `display != none`) — capture the fixed
 * {@link PSEUDO_CAPTURE_PROPS} pick. Returns a plain serializable map keyed by `source_path`.
 * NEVER touches the element's own `computed` pick (same purity rule as the behavior probes).
 */
function inPagePseudoProbe(args: {
  props: readonly string[];
}): Record<string, { before?: Record<string, string>; after?: Record<string, string> }> {
  const { props } = args;

  function structuralPath(el: Element): string {
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
      const node: Element = cur;
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const sameTag = siblings.filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          segs.unshift(`${tag}:nth-child(${idx})`);
        } else {
          segs.unshift(tag);
        }
      } else {
        segs.unshift(tag);
      }
      cur = parent;
    }
    return segs.join('>');
  }

  const out: Record<string, { before?: Record<string, string>; after?: Record<string, string> }> =
    {};
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    for (const pseudo of ['before', 'after'] as const) {
      const cs = getComputedStyle(el, `::${pseudo}`);
      const content = cs.getPropertyValue('content').trim();
      // `none` (no pseudo rule) / `normal` (initial) → the pseudo does not render; skip.
      if (content === '' || content === 'none' || content === 'normal') continue;
      if (cs.getPropertyValue('display') === 'none') continue;
      const pick: Record<string, string> = {};
      for (const prop of props) {
        const v = cs.getPropertyValue(prop);
        if (v !== '' && v !== undefined) {
          pick[prop] = v.trim();
        }
      }
      const path = structuralPath(el);
      const entry = out[path] ?? (out[path] = {});
      entry[pseudo] = pick;
    }
  }
  return out;
}

/**
 * In-page `@font-face` family probe (contract 17 #9). Self-contained for `page.evaluate`. Two
 * complementary sources, unioned:
 *   - `document.fonts` (FontFaceSet) — sees faces loaded from CROSS-ORIGIN font CSS (Google Fonts
 *     responses), whose CSSOM rules are unreadable;
 *   - a CSSOM walk for `CSSFontFaceRule`s (incl. nested grouping rules) — sees same-origin/inline
 *     `@font-face` declarations even when the face never loaded (unreachable `src`).
 * Returns the distinct unquoted family names, sorted.
 */
function inPageFontFaceProbe(): string[] {
  const families = new Set<string>();
  const unquote = (name: string): string =>
    name
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();

  try {
    document.fonts.forEach((face) => {
      const n = unquote(face.family);
      if (n.length > 0) families.add(n);
    });
  } catch {
    /* FontFaceSet unavailable — the CSSOM walk below still covers same-origin faces */
  }

  const collectRules = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const n = unquote((rule as CSSFontFaceRule).style.getPropertyValue('font-family'));
        if (n.length > 0) families.add(n);
      } else {
        const nested = (rule as { cssRules?: CSSRuleList }).cssRules;
        if (nested) collectRules(nested);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collectRules(sheet.cssRules);
    } catch {
      /* cross-origin sheet — CSSOM access throws; document.fonts covered its loaded faces */
    }
  }
  return [...families].sort();
}

/* ─────────────────────────── Node-side IR assembly ──────────────────────────────────────────── */

/** Build the `<style>`-injected document used by `setContent` (box-sizing reset + author CSS). */
function buildDocument(html: string, css?: string): string {
  const style = css ? `<style data-ultra-injected>${css}</style>` : '';
  // If the HTML is already a full document, inject the style into <head>; else wrap a minimal doc.
  if (/<html[\s>]/i.test(html)) {
    if (/<head[\s>]/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${style}`);
    }
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${style}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

/** Assemble the IR forest from the flat in-page `RawNode[]` (children resolved via `childPaths`). */
function buildIrForest(raw: RawNode[]): {
  roots: IrNode[];
  byPath: Map<string, IrNode>;
} {
  const byPath = new Map<string, IrNode>();
  for (const r of raw) {
    const node: IrNode = {
      source_path: r.source_path,
      tag: r.tag,
      role: SEED_ROLE,
      box: r.box,
      computed: r.computed,
      responsive: {},
      attrs: r.attrs,
      textRuns: r.textRuns,
      children: [],
    };
    if (r.media) {
      node.media = r.media;
    }
    // Contract 18 §7 P2-d: lift a non-empty source `id` attribute onto the additive `sourceId`
    // seam so MAP/ASSEMBLE can re-emit the in-page anchor target on the converted node.
    const sourceId = r.attrs['id'];
    if (typeof sourceId === 'string' && sourceId.trim().length > 0) {
      (node as SourceIdIrNode).sourceId = sourceId.trim();
    }
    byPath.set(r.source_path, node);
  }
  // Wire children + identify roots (a node is a root if no other node lists it as a child).
  const childPathSet = new Set<string>();
  for (const r of raw) {
    const parent = byPath.get(r.source_path);
    if (!parent) continue;
    for (const cp of r.childPaths) {
      const child = byPath.get(cp);
      if (child) {
        parent.children.push(child);
        childPathSet.add(cp);
      }
    }
  }
  const roots: IrNode[] = [];
  for (const r of raw) {
    if (!childPathSet.has(r.source_path)) {
      const node = byPath.get(r.source_path);
      if (node) roots.push(node);
    }
  }
  return { roots, byPath };
}

/* ─────────────────────────── PARSE entry point ──────────────────────────────────────────────── */

/**
 * PARSE: render `input` in headless Chromium, extract the whitelisted computed-style IR forest with
 * parent-diff, forced pseudo-states (CDP), per-breakpoint deltas, media refs, text runs, and raw
 * inner markup. Implemented against the FROZEN `ParseInput`/`ParseResult` (WP-H01).
 *
 * @throws only when Chromium itself is unavailable/unlaunchable (the browser pool throws). Malformed
 *   HTML is NEVER thrown on — Chromium is lenient and anomalies surface as `ParseWarning`s.
 */
export async function parseHtml(input: ParseInput): Promise<FontAwareParseResult> {
  const warnings: ParseWarning[] = [];

  // External-style resolution heuristics → warn (not crash) when links may be unreachable.
  if (hasExternalStyleRefs(input.html, input.css) && !input.base_url) {
    warnings.push({
      code: 'EXTERNAL_CSS_UNRESOLVED',
      message:
        'HTML references external <link rel=stylesheet>/@import but no base_url was provided; ' +
        'linked CSS may be unresolved and the cascade incomplete.',
    });
  }

  const plan = resolveCapturePlan(input);
  // The base viewport: the widest passed breakpoint (so per-breakpoint deltas are vs. the widest),
  // falling back to a reasonable desktop width when no breakpoints were supplied.
  const widest = input.breakpoints.reduce<number | null>(
    (max, bp) => (max === null || bp.width > max ? bp.width : max),
    null,
  );
  const baseViewport = widest ?? 1280;

  const result = await withPage(
    async (page) => {
      const doc = buildDocument(input.html, input.css);

      // Load via setContent (relative external refs resolve against the context `baseURL`, set in
      // the context options below when `base_url` is provided). `networkidle` for high fidelity so
      // external `<link>`/`@import` stylesheets finish loading and the cascade is complete.
      const waitUntil = input.fidelity === 'high' ? 'networkidle' : 'load';
      await page.setContent(doc, { waitUntil });
      // Best-effort: let webfonts settle for high fidelity (stable typography metrics).
      if (input.fidelity === 'high') {
        try {
          await page.evaluate(
            () => (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready,
          );
        } catch {
          /* fonts API unavailable — ignore */
        }
      }

      await page.setViewportSize({ width: baseViewport, height: 900 });

      // --- BASE capture: full walk with in-page parent-diff. ---
      const base = await page.evaluate(inPageExtract, {
        whitelist: WHITELIST,
        inherited: [...INHERITED_PROPS],
      });

      const { roots, byPath } = buildIrForest(base.nodes);

      // raw_inner_markup keyed by source_path (text-bearing nodes only).
      const rawInnerMarkup: Record<string, string> = {};
      for (const r of base.nodes) {
        if (r.rawInnerMarkup !== undefined) {
          rawInnerMarkup[r.source_path] = r.rawInnerMarkup;
        }
      }

      // Base FULL (non-diffed) computed per path is needed to compute state/bp deltas. Re-read once
      // at the base viewport without parent-diff so deltas are honest per-prop comparisons.
      const baseFull = await page.evaluate(inPageRecompute, { whitelist: WHITELIST });

      // --- Behavior runtime probes (contract 16 §2): @keyframes (CSSOM) + transitions. ---
      // Pure annotation onto OPTIONAL IrNode fields — never alters `computed` (§8 invariant 5).
      try {
        const probes = await page.evaluate(inPageBehaviorProbe);
        for (const [path, probe] of Object.entries(probes.animations)) {
          const node = byPath.get(path);
          if (node) node.animationProbe = probe;
        }
        for (const [path, probe] of Object.entries(probes.transitions)) {
          const node = byPath.get(path);
          if (node) node.transitionProbe = probe;
        }
      } catch (err) {
        warnings.push({
          code: 'BEHAVIOR_PROBE_FAILED',
          message: `Animation/transition probe skipped: ${(err as Error).message}`,
        });
      }

      // --- Click/touch listener probe via CDP getEventListeners (contract 16 §2). ---
      try {
        await captureListeners(page, byPath, warnings);
      } catch (err) {
        warnings.push({
          code: 'LISTENER_PROBE_FAILED',
          message: `Listener probe skipped: ${(err as Error).message}`,
        });
      }

      // --- ::before/::after computed capture (contract 17 #10). Pure annotation onto the additive
      // `PseudoIrNode` fields — NORMALIZE synthesizes representable ones as real child nodes. ---
      try {
        const pseudos = await page.evaluate(inPagePseudoProbe, { props: PSEUDO_CAPTURE_PROPS });
        for (const [path, entry] of Object.entries(pseudos)) {
          const node = byPath.get(path) as PseudoIrNode | undefined;
          if (!node) continue;
          if (entry.before) node.pseudoBefore = entry.before;
          if (entry.after) node.pseudoAfter = entry.after;
        }
      } catch (err) {
        warnings.push({
          code: 'PSEUDO_PROBE_FAILED',
          message: `::before/::after capture skipped: ${(err as Error).message}`,
        });
      }

      // --- @font-face family probe (contract 17 #9 — CSSOM/FontFaceSet). ---
      let fontFamilies: string[] = [];
      try {
        fontFamilies = await page.evaluate(inPageFontFaceProbe);
      } catch (err) {
        warnings.push({
          code: 'FONT_PROBE_FAILED',
          message: `@font-face family capture skipped: ${(err as Error).message}`,
        });
      }

      // --- Forced pseudo-states via CDP (hover/focus). ---
      if (plan.captureStates) {
        try {
          await captureForcedStates(page, byPath, baseFull, warnings);
        } catch (err) {
          warnings.push({
            code: 'STATE_CAPTURE_FAILED',
            message: `Forced pseudo-state capture skipped: ${(err as Error).message}`,
          });
        }
      }

      // --- Per-breakpoint capture (deltas vs. base). ---
      if (plan.captureBreakpoints && input.breakpoints.length > 0) {
        for (const bp of input.breakpoints) {
          if (bp.width === baseViewport) {
            // The base capture already IS this width; no separate delta needed.
            continue;
          }
          await page.setViewportSize({ width: bp.width, height: 900 });
          const bpFull = await page.evaluate(inPageRecompute, { whitelist: WHITELIST });
          const bpKey = String(bp.key);
          for (const [path, node] of byPath) {
            const at = bpFull[path];
            const baseAt = baseFull[path];
            if (!at || !baseAt) continue;
            const delta = computedDelta(baseAt, at);
            if (Object.keys(delta).length > 0) {
              node.responsive[bpKey] = delta;
            }
          }
        }
        // restore base viewport
        await page.setViewportSize({ width: baseViewport, height: 900 });
      }

      return {
        roots,
        docDirection: base.docDirection,
        rawInnerMarkup,
        bodyBackground: base.bodyBackground,
        fontFamilies,
      };
    },
    {
      viewport: { width: baseViewport, height: 900 },
      // reducedMotion + (later) animations:'disabled' keep captures + the screenshot stable
      // (SUPPLEMENT §C.4).
      reducedMotion: 'reduce',
      // base_url lets relative external <link>/@import refs resolve so the cascade is complete.
      ...(input.base_url ? { baseURL: input.base_url } : {}),
    },
  );

  return {
    ir: result.roots,
    doc_direction: result.docDirection,
    viewport_used: baseViewport,
    warnings,
    raw_inner_markup: result.rawInnerMarkup,
    ...(result.bodyBackground !== null ? { page_background: result.bodyBackground } : {}),
    pageScripts: censusScripts(input.html),
    // Contract 17 #9 webfont capture: links from the raw-source census (what the author shipped),
    // families from the in-page CSSOM/FontFaceSet probe (best-effort — [] when the probe failed).
    fontAssets: { links: censusFontLinks(input.html, input.css), families: result.fontFamilies },
  };
}

/**
 * Force `:hover` then `:focus` on EVERY element via the Chrome DevTools Protocol
 * (`CSS.forcePseudoState`), re-read computed styles, and record only the props that CHANGED vs. the
 * base into `hoverComputed`/`focusComputed`. Plain `getComputedStyle` never returns pseudo-state
 * styling — the CDP force is mandatory (SUPPLEMENT §C.3).
 *
 * Implementation: open ONE CDP session, snapshot the full DOM (`DOM.getDocument`, depth -1),
 * collect every element nodeId under `<body>`, then for each forced state push
 * `CSS.forcePseudoState{ forcedPseudoClasses:[pseudo] }` on all of them, re-read the whitelisted
 * computed styles in-page, diff vs. the base, and clear the forced state before the next pseudo.
 * Maps to authoring states `hover`/`focus` (authoring-contract §5.2). Best-effort: a node that
 * rejects the force is skipped, and total CDP unavailability degrades to a `ParseWarning`.
 */
async function captureForcedStates(
  page: Page,
  byPath: Map<string, IrNode>,
  baseFull: Record<string, ComputedStyleSet>,
  warnings: ParseWarning[],
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = (await client.send('DOM.getDocument', { depth: -1 })) as {
      root: CdpNode;
    };

    for (const { pseudo, key } of FORCE_STATES) {
      // Force the pseudo-state on every element node in the body subtree.
      const nodeIds = collectElementNodeIds(root);
      for (const nodeId of nodeIds) {
        try {
          await client.send('CSS.forcePseudoState', {
            nodeId,
            forcedPseudoClasses: [pseudo],
          });
        } catch {
          /* a node may not accept the forced state; skip it */
        }
      }
      const forcedFull = await page.evaluate(inPageRecompute, { whitelist: WHITELIST });
      for (const [path, node] of byPath) {
        const at = forcedFull[path];
        const baseAt = baseFull[path];
        if (!at || !baseAt) continue;
        const delta = computedDelta(baseAt, at);
        if (Object.keys(delta).length > 0) {
          if (key === 'hover') {
            node.hoverComputed = delta;
          } else {
            node.focusComputed = delta;
          }
        }
      }
      // Clear the forced state before the next pseudo.
      for (const nodeId of nodeIds) {
        try {
          await client.send('CSS.forcePseudoState', {
            nodeId,
            forcedPseudoClasses: [],
          });
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    warnings.push({
      code: 'CDP_FORCE_STATE_UNAVAILABLE',
      message: `CDP forcePseudoState unavailable: ${(err as Error).message}`,
    });
  } finally {
    await client.detach().catch(() => {
      /* session may already be detached */
    });
  }
}

/** The listener event types that mark a behavior trigger candidate (contract 16 §2: click/touch). */
const TRIGGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  'click',
  'dblclick',
  'touchstart',
  'touchend',
  'pointerdown',
  'pointerup',
]);

/** Self-contained structural-path function evaluated ON a CDP-resolved element (`this` = element).
 *  MUST stay in lockstep with `structuralPath` inside `inPageExtract`/`inPageRecompute`. */
const STRUCTURAL_PATH_FN = `function () {
  const segs = [];
  let cur = this;
  while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html') {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const sameTag = siblings.filter((c) => c.tagName === cur.tagName);
      if (sameTag.length > 1) {
        segs.unshift(tag + ':nth-child(' + (siblings.indexOf(cur) + 1) + ')');
      } else {
        segs.unshift(tag);
      }
    } else {
      segs.unshift(tag);
    }
    cur = parent;
  }
  return segs.join('>');
}`;

/**
 * Click/touch listener probe via CDP `DOMDebugger.getEventListeners` (contract 16 §2): for every
 * NON-ANCHOR element under `<body>` (anchors navigate natively — never behavior triggers), resolve
 * the node to a JS object, read its event listeners, and when any click/touch type is attached,
 * record the types onto `IrNode.listeners` (matched back by structural path via
 * `Runtime.callFunctionOn`). Best-effort: a node that fails to resolve is skipped; total CDP
 * unavailability degrades to a `ParseWarning` in the caller. Pure annotation (§8 invariant 5).
 */
async function captureListeners(
  page: Page,
  byPath: Map<string, IrNode>,
  warnings: ParseWarning[],
): Promise<void> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('DOM.enable');
    const { root } = (await client.send('DOM.getDocument', { depth: -1 })) as {
      root: CdpNode;
    };
    for (const { nodeId } of collectListenerCandidates(root)) {
      try {
        const { object } = (await client.send('DOM.resolveNode', { nodeId })) as {
          object?: { objectId?: string };
        };
        if (!object?.objectId) continue;
        const { listeners } = (await client.send('DOMDebugger.getEventListeners', {
          objectId: object.objectId,
        })) as { listeners?: Array<{ type: string }> };
        const types = [
          ...new Set(
            (listeners ?? []).map((l) => l.type).filter((t) => TRIGGER_EVENT_TYPES.has(t)),
          ),
        ];
        if (types.length === 0) continue;
        const { result } = (await client.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: STRUCTURAL_PATH_FN,
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        const path = result?.value;
        if (typeof path !== 'string') continue;
        const node = byPath.get(path);
        if (node) node.listeners = types;
      } catch {
        /* a node may fail to resolve (detached/special) — skip it */
      }
    }
  } catch (err) {
    warnings.push({
      code: 'CDP_GET_EVENT_LISTENERS_UNAVAILABLE',
      message: `CDP getEventListeners unavailable: ${(err as Error).message}`,
    });
  } finally {
    await client.detach().catch(() => {
      /* session may already be detached */
    });
  }
}

/** Element nodes under <body> eligible for the listener probe (anchors excluded — contract 16 §2). */
function collectListenerCandidates(root: CdpNode): Array<{ nodeId: number }> {
  const out: Array<{ nodeId: number }> = [];
  const walk = (n: CdpNode, insideBody: boolean): void => {
    const name = (n.nodeName ?? '').toLowerCase();
    const nowInside = insideBody || name === 'body';
    if (nowInside && n.nodeType === 1 && name !== 'body' && name !== 'a') {
      out.push({ nodeId: n.nodeId });
    }
    for (const c of n.children ?? []) {
      walk(c, nowInside);
    }
  };
  walk(root, false);
  return out;
}

/** A minimal CDP DOM.Node shape (only the fields the node-id collector reads). */
interface CdpNode {
  nodeId: number;
  nodeType: number;
  nodeName?: string;
  children?: CdpNode[];
}

/** Flatten a CDP DOM tree to the element-node ids under <body> (skip document/doctype/text nodes). */
function collectElementNodeIds(root: CdpNode): number[] {
  const ids: number[] = [];
  const walk = (n: CdpNode, insideBody: boolean): void => {
    const name = (n.nodeName ?? '').toLowerCase();
    const nowInside = insideBody || name === 'body';
    if (nowInside && n.nodeType === 1 && name !== 'body') {
      ids.push(n.nodeId);
    }
    for (const c of n.children ?? []) {
      walk(c, nowInside);
    }
  };
  walk(root, false);
  return ids;
}
