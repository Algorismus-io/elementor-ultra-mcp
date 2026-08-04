/**
 * WP-H05 — CLASSIFY stage (impl of `classifyIr` + the per-node deterministic classifier + smart
 * naming, frozen seam `convert/types.ts`, WP-H01).
 *
 * The THIRD HTML→native conversion stage (RESEARCH.md §6.1 step 3). Assigns a `SemanticRole` to every
 * normalized IR node from: ARIA `role`/`aria-*` > tag > class-name hint > computed `display` > box
 * geometry (the prioritized cascade documented in the WP Implementation Notes). It is the
 * DETERMINISTIC half of the Builder.io AI/deterministic split (SUPPLEMENT §C.2/§C.4): the classifier
 * produces the framework-agnostic IR roles; an OPTIONAL upstream AI hook may PRE-annotate
 * roles/hierarchy/naming via `ClassifyOptions.ai_hints`, but the AI is strictly UPSTREAM of envelope
 * emission (eng-standards §4.6, SUPPLEMENT §C.4 step 3) and every hint is RE-VALIDATED here — a hint
 * is adopted only when consistent with the deterministic signals, otherwise rejected and recorded in
 * `role_overrides`/`warnings`. With no hints, classification is fully deterministic.
 *
 * It also owns Locofy-style flex inference (delegated to `flex-inference.ts`) to distinguish
 * `flex-row`/`flex-col`/`grid`/`structural-block`, and computes tabs/accordion PAIRING (menu count ==
 * content count) which it stashes on the result for MAP (WP-H06) to gate `e-tabs` emission
 * (authoring-contract §4: "tab & content counts MUST match"). It does NOT map to Elementor element
 * types (WP-H06), does NOT emit style envelopes (WP-H07/H08), does NO I/O.
 *
 * PURE module: deterministic given `(ir, opts.ai_hints)`, NO Playwright, NO `fs`, NO WP client,
 * idempotent. Owns ONLY the functions + helpers; `IrNode`/`SemanticRole`/`ClassifyOptions`/
 * `AiRoleHint`/`ClassifyResult`/`RoleOverride`/`FlexIntent` are FROZEN in WP-H01 (`types.ts`) and
 * imported, never redeclared.
 */

import { inferFlex, isTrueGrid } from './flex-inference.js';
import type {
  AiRoleHint,
  ClassifyOptions,
  ClassifyResult,
  DetectedBehavior,
  IrNode,
  RoleOverride,
  SemanticRole,
} from './types.js';

/* ─────────────────────────── role precedence (auditable cascade) ────────────────────────────── */

/**
 * The deterministic signal precedence (most-specific wins), documented for auditability:
 *   1. ARIA role / `aria-*`   (an author-declared semantic — strongest)
 *   2. tag                    (`h1`-`h6`, `img`, `button`, `a`, `hr`, …)
 *   3. class-name hint        (`.btn`/`.cta`/`.card`/`.row`/`.col`)
 *   4. computed `display`     (`flex`/`grid`)
 *   5. box geometry           (Locofy band inference for dirty marketing HTML)
 * Falls through to `structural-block` (never `unknown` for a decisive container; `unknown` only when
 * a node is genuinely undecidable AND has no children).
 */

/* ─────────────────────────── tag → role tables ──────────────────────────────────────────────── */

/** Tags whose role is decided purely by the tag (the §6.1 step-3 / §6.2 convergent set). */
const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TEXT_TAGS: ReadonlySet<string> = new Set(['p', 'span', 'blockquote', 'figcaption', 'cite']);
const FORM_FIELD_TAGS: ReadonlySet<string> = new Set(['input', 'textarea', 'select']);
const LIST_TAGS: ReadonlySet<string> = new Set(['ul', 'ol', 'menu']);

/** Class-name substrings → role hint (lower-cased, matched against any class token). */
const BUTTON_CLASS_HINTS: ReadonlyArray<string> = ['btn', 'button', 'cta'];
const FLEX_ROW_CLASS_HINTS: ReadonlyArray<string> = ['row', 'd-flex', 'flex-row', 'hstack'];
const FLEX_COL_CLASS_HINTS: ReadonlyArray<string> = [
  'col',
  'column',
  'flex-col',
  'vstack',
  'stack',
];
const STRUCTURAL_CLASS_HINTS: ReadonlyArray<string> = ['card', 'panel', 'box', 'wrapper', 'inner'];

/** Icon-font class hints (`<i class="fa ...">`, `<span class="icon-...">`). */
const ICON_CLASS_HINTS: ReadonlyArray<string> = [
  'icon',
  'fa-',
  'fas',
  'far',
  'fab',
  'material-icons',
];

/* ─────────────────────────── attr / class helpers ───────────────────────────────────────────── */

/** Lower-cased attribute value (empty string when absent). */
function attr(node: IrNode, name: string): string {
  const v = node.attrs[name];
  return v === undefined ? '' : v.trim().toLowerCase();
}

/** The node's class tokens, lower-cased. */
function classTokens(node: IrNode): string[] {
  const raw = node.attrs['class'] ?? node.attrs['className'] ?? '';
  return raw
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '');
}

/** Does any class token contain any of the given substrings? */
function classMatches(node: IrNode, hints: ReadonlyArray<string>): boolean {
  const tokens = classTokens(node);
  return tokens.some((t) => hints.some((h) => t === h || t.includes(h)));
}

/** Lower-cased computed value (empty string when absent). */
function display(node: IrNode): string {
  const v = node.computed['display'];
  return v === undefined ? '' : v.trim().toLowerCase();
}

/**
 * Does the node carry a PARSE-captured runtime behavior signal (`animationProbe` — set for every
 * element whose computed `animation-name != none` — listeners, or a transition probe)? Contract 18
 * §7 P2-c: a behavior-bearing node must NEVER classify `unknown` — `unknown` is the "genuinely
 * empty + undecidable leaf" role, but an animated empty leaf (the page-2658 pulse dot: a childless,
 * textless `<div class="dot">` driven entirely by `@keyframes`) is a PAINTED box whose entire
 * purpose is the behavior; it must survive as a mappable container so the element never vanishes
 * and its `DetectedBehavior` has a node to ride on.
 */
function carriesBehaviorSignal(node: IrNode): boolean {
  return (
    node.animationProbe !== undefined ||
    node.transitionProbe !== undefined ||
    (node.listeners !== undefined && node.listeners.length > 0)
  );
}

/** Count of element children that are themselves block-ish containers (heuristic for structural). */
function blockChildCount(node: IrNode): number {
  return node.children.filter((c) => {
    const d = c.computed['display'];
    return (
      d === undefined ||
      d === '' ||
      d.startsWith('block') ||
      d.startsWith('flex') ||
      d.startsWith('grid')
    );
  }).length;
}

/* ─────────────────────────── ARIA-role classification (precedence 1) ────────────────────────── */

/** Map an explicit ARIA `role` to a `SemanticRole`, or `null` when it carries no mapping. */
function roleFromAria(node: IrNode): SemanticRole | null {
  const r = attr(node, 'role');
  switch (r) {
    case 'tablist':
      return 'tabs';
    case 'tab':
      return 'tab';
    case 'tabpanel':
      return 'tab-content';
    case 'button':
      return 'button';
    case 'link':
      return 'link';
    case 'heading':
      return 'heading';
    case 'navigation':
    case 'menubar':
    case 'menu':
      return 'nav-menu';
    case 'list':
      return 'list';
    case 'listitem':
      return 'list-item';
    case 'img':
    case 'figure':
      return 'image';
    case 'separator':
      return 'divider';
    case 'table':
    case 'grid':
      return 'table';
    default:
      return null;
  }
}

/* ─────────────────────────── tag classification (precedence 2) ──────────────────────────────── */

/** Is this `<iframe>`/embed a YouTube embed? (src host or youtube-nocookie). */
function isYoutube(node: IrNode): boolean {
  const src = attr(node, 'src');
  return (
    src.includes('youtube.com') || src.includes('youtu.be') || src.includes('youtube-nocookie.com')
  );
}

/** Is this `<iframe>`/embed a generic video host (vimeo/dailymotion)? */
function isVideoEmbed(node: IrNode): boolean {
  const src = attr(node, 'src');
  return src.includes('vimeo.com') || src.includes('dailymotion.com');
}

/** Is this `<a>` button-like? (`.btn`/`.button`/`.cta` class or `role=button`). */
function isButtonLikeAnchor(node: IrNode): boolean {
  return classMatches(node, BUTTON_CLASS_HINTS) || attr(node, 'role') === 'button';
}

/**
 * Resolve the role of an `<a>` element. Three cases:
 *   - button-like (`.btn`/`.cta`/`role=button`)  → `button` (e-button: text + link + its own chrome).
 *   - a LEAF anchor that carries text but NO element children (e.g. a `<nav>` link `<a>Features</a>`)
 *     → `text` (e-paragraph carrying the text + href). NOT `button`: e-button has a default solid
 *     background a bare text link must not inherit (it would render as a stray colored box). NOT `link`
 *     either — the `link` role maps to a text-less `e-div-block` container and would drop the label.
 *   - a WRAPPING anchor (element children — e.g. an `<a>` around an image/card) → `link`
 *     (an e-div-block container with the link applied; its children render inside it).
 */
function anchorRole(node: IrNode): SemanticRole {
  if (isButtonLikeAnchor(node)) return 'button';
  const isLeafTextAnchor = node.children.length === 0 && node.textRuns.length > 0;
  return isLeafTextAnchor ? 'text' : 'link';
}

/**
 * Resolve a role purely from tag (precedence 2). Returns `null` when the tag is structural/ambiguous
 * (a container tag like `div`/`section`/`nav` is left to class/display/geometry signals).
 */
function roleFromTag(node: IrNode): SemanticRole | null {
  const tag = node.tag.toLowerCase();

  if (HEADING_TAGS.has(tag)) return 'heading';
  if (tag === 'img' || tag === 'picture') return 'image';
  if (tag === 'svg') return 'icon-svg';
  if (tag === 'i') return classMatches(node, ICON_CLASS_HINTS) ? 'icon-svg' : null;
  if (tag === 'button') return 'button';
  if (tag === 'a') return anchorRole(node);
  if (tag === 'hr') return 'divider';
  if (tag === 'iframe' || tag === 'embed') {
    if (isYoutube(node)) return 'media-embed-youtube';
    if (isVideoEmbed(node)) return 'media-embed-youtube';
    return 'media-embed-video';
  }
  if (tag === 'video') return 'media-embed-video';
  if (LIST_TAGS.has(tag)) return 'list';
  if (tag === 'li') return 'list-item';
  if (tag === 'table') return 'table';
  if (tag === 'nav') return 'nav-menu';
  if (tag === 'form') return 'form';
  if (FORM_FIELD_TAGS.has(tag)) return 'form-field';
  if (tag === 'details') return 'accordion';
  if (tag === 'summary') return 'accordion-item';
  if (TEXT_TAGS.has(tag)) {
    // A text-tag WRAPPER with no text of its own but real element children (the hero
    // `<span class="spark"><svg/></span>`) is NOT text: 'text' maps to a LEAF paragraph and
    // silently swallows the child subtree (page 2439's missing spark icon). Fall through to the
    // class/display/geometry signals instead — a genuinely texty span always carries runs.
    return node.textRuns.length === 0 && node.children.length > 0 ? null : 'text';
  }

  return null;
}

/* ─────────────────────────── class-hint classification (precedence 3) ───────────────────────── */

/** Resolve a role from class-name hints (precedence 3). `null` when no class hint applies. */
function roleFromClassHint(node: IrNode): SemanticRole | null {
  if (classMatches(node, BUTTON_CLASS_HINTS)) {
    // Only treat as button when interactive-ish (anchor/button already handled by tag; a styled div
    // ".cta" with children is structural, a leaf ".btn" is a button).
    if (node.children.length === 0) return 'button';
  }
  if (
    classMatches(node, ICON_CLASS_HINTS) &&
    node.children.length === 0 &&
    node.textRuns.length === 0
  ) {
    return 'icon-svg';
  }
  if (classMatches(node, FLEX_ROW_CLASS_HINTS)) return 'flex-row';
  if (classMatches(node, FLEX_COL_CLASS_HINTS)) return 'flex-col';
  if (classMatches(node, STRUCTURAL_CLASS_HINTS)) return 'structural-block';
  return null;
}

/* ─────────────────────────── display + geometry (precedence 4 & 5) ──────────────────────────── */

/** Does the node carry an EXPLICIT `display:flex|inline-flex|grid|inline-grid`? */
function isExplicitLayout(node: IrNode): boolean {
  const d = display(node);
  return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
}

/**
 * Resolve a container role from computed `display` + geometry (precedence 4 & 5). Prefers FLEX by
 * default (RESEARCH.md §6.4 step 4: choose grid ONLY for a true 2D track grid because Style-Schema
 * grid support is limited). An ambiguous 1D layout → flex; a true 2D grid → `grid`; a block with
 * multiple block children → `structural-block`.
 */
function roleFromLayout(node: IrNode): SemanticRole {
  // A true 2D track grid is the only case we label `grid` (conservative — §5.2 / §6.4).
  if (isTrueGrid(node)) return 'grid';

  const intent = inferFlex(node);
  if (intent !== null) {
    return intent.direction === 'column' ? 'flex-col' : 'flex-row';
  }

  // Not a flex/grid container: a block with multiple block children is a structural block.
  if (blockChildCount(node) >= 1 || node.children.length >= 1) return 'structural-block';

  // Genuinely empty + undecidable leaf — UNLESS it carries a behavior signal (P2-c): an animated
  // empty leaf (keyframes pulse dot) is a painted box, never an `unknown` throwaway.
  if (node.textRuns.length > 0) return 'text';
  return carriesBehaviorSignal(node) ? 'structural-block' : 'unknown';
}

/* ─────────────────────────── per-node deterministic classifier ──────────────────────────────── */

/**
 * The per-node DETERMINISTIC classifier (the WP's `classifyNode`). Runs the prioritized cascade
 * (ARIA > tag > class hint > display > geometry) and returns a non-`unknown` role whenever the
 * signals are decisive; ambiguous containers degrade to `structural-block`, never throwing.
 *
 * `parent` is accepted for child-composition signals (e.g. a `<li>` inside a `<nav>` is a nav item)
 * but the classifier is robust without it.
 */
export function classifyNode(node: IrNode, parent?: IrNode): SemanticRole {
  // 1) ARIA role — strongest, author-declared semantic.
  const aria = roleFromAria(node);
  if (aria !== null) return aria;

  // 2) tag — decisive for leaf semantics (heading/text/img/button/link/divider/list/table/…).
  const byTag = roleFromTag(node);
  if (byTag !== null) {
    // A heading's level is enforced downstream; here a heading is a heading.
    return byTag;
  }

  // 3) class-name hint — for container tags (div/section) the class often declares intent.
  const byClass = roleFromClassHint(node);
  if (byClass !== null) {
    // Class said flex-row/col but the node is genuinely a 2D grid → prefer the true-grid signal.
    if ((byClass === 'flex-row' || byClass === 'flex-col') && isTrueGrid(node)) return 'grid';
    // A WEAK structural class hint (`.card`/`.wrapper`/`.inner`/…) must NOT mask an EXPLICIT
    // `display:flex|grid` — an explicit layout is the more specific signal. Refine to the layout role.
    if (byClass === 'structural-block' && isExplicitLayout(node)) return roleFromLayout(node);
    return byClass;
  }

  // 4 & 5) computed display + box geometry (Locofy band inference).
  const byLayout = roleFromLayout(node);

  // child-composition refinement: a list-like parent's direct element children are list-items.
  if (
    byLayout === 'structural-block' &&
    parent !== undefined &&
    (parent.role === 'list' || parent.role === 'nav-menu') &&
    node.tag.toLowerCase() === 'li'
  ) {
    return 'list-item';
  }

  return byLayout;
}

/* ─────────────────────────── tabs / accordion pairing ───────────────────────────────────────── */

/**
 * Detect whether a tabs structure is correctly PAIRED (menu/tab count == content/panel count). MAP
 * (WP-H06) reads `MapStageContext.tab_pairing[source_path]` to decide whether to emit `e-tabs`
 * (authoring-contract §4: "tab & content counts MUST match"). For a `details/summary` accordion each
 * summary pairs with its following content, so accordion pairing is structural (always reported).
 *
 * Returns a `source_path → paired?` map for every tabs/accordion container in the (already classified)
 * tree.
 */
export function computeTabPairing(ir: IrNode[]): Record<string, boolean> {
  const pairing: Record<string, boolean> = {};

  const walk = (node: IrNode): void => {
    if (node.role === 'tabs') {
      pairing[node.source_path] = isTabsPaired(node);
    } else if (node.role === 'accordion') {
      pairing[node.source_path] = isAccordionPaired(node);
    }
    for (const child of node.children) walk(child);
  };
  for (const root of ir) walk(root);
  return pairing;
}

/** Count `tab` (menu) vs `tab-content` (panel) roles anywhere under a tabs container; paired when ==. */
function isTabsPaired(tabs: IrNode): boolean {
  let menus = 0;
  let panels = 0;
  const walk = (n: IrNode): void => {
    for (const c of n.children) {
      if (c.role === 'tab') menus += 1;
      else if (c.role === 'tab-content') panels += 1;
      walk(c);
    }
  };
  walk(tabs);
  return menus > 0 && menus === panels;
}

/**
 * A `details/summary` accordion: each direct `summary` (accordion-item header) must have following
 * content. Paired when there is exactly one summary header and at least one sibling content node, OR
 * when summary count == content-group count for a multi-item accordion.
 */
function isAccordionPaired(accordion: IrNode): boolean {
  const summaries = accordion.children.filter((c) => c.tag.toLowerCase() === 'summary').length;
  const contents = accordion.children.filter((c) => c.tag.toLowerCase() !== 'summary').length;
  if (summaries === 0) return false;
  return contents >= summaries;
}

/* ─────────────────────────── behavior detection (contract 16 §2) ────────────────────────────── */

/*
 * The §2 signal table — ARIA/semantics > classname heuristics > runtime probes (PARSE-captured
 * `animationProbe`/`transitionProbe`/`listeners`) — producing `DetectedBehavior`s attached to the
 * pattern ROOT IrNode. Multiple signals raise confidence. PURE ANNOTATION (§8 invariant 5): a page
 * with zero behavior signals gets ZERO `behaviors` fields and classifies byte-identically to
 * pre-contract-16 output. Tiers are NOT assigned here (that is MAPPING's job, contract 16 §3-§5).
 */

/** Classname-heuristic hint lists (contract 16 §2, verbatim). Matched as substrings of class
 *  tokens, except the short ambiguous tokens in `EXACT_TOKEN_HINTS` which must match whole. */
const CAROUSEL_BEHAVIOR_HINTS: ReadonlyArray<string> = [
  'swiper',
  'slick',
  'splide',
  'carousel',
  'glide',
];
const ACCORDION_BEHAVIOR_HINTS: ReadonlyArray<string> = ['accordion', 'collapse'];
const TABS_BEHAVIOR_HINTS: ReadonlyArray<string> = ['tabs', 'tab-'];
const NAV_TOGGLE_BEHAVIOR_HINTS: ReadonlyArray<string> = [
  'navbar-toggler',
  'hamburger',
  'menu-toggle',
];
const ENTRANCE_BEHAVIOR_HINTS: ReadonlyArray<string> = [
  'aos',
  'animate__',
  'wow',
  'fade-in',
  'reveal',
];
const MARQUEE_BEHAVIOR_HINTS: ReadonlyArray<string> = ['marquee', 'ticker'];

/** Hints too short/ambiguous for substring matching (`chaos` ≠ aos, `wowzers` ≠ wow). */
const EXACT_TOKEN_HINTS: ReadonlySet<string> = new Set(['aos', 'wow']);

/** The matched class TOKEN for a behavior hint list (for `evidence`), or `null` when none match. */
function behaviorClassToken(node: IrNode, hints: ReadonlyArray<string>): string | null {
  for (const tok of classTokens(node)) {
    for (const h of hints) {
      if (EXACT_TOKEN_HINTS.has(h) ? tok === h : tok.includes(h)) return tok;
    }
  }
  return null;
}

/** Depth-first visit of `node` and every descendant. */
function walkSubtree(node: IrNode, fn: (n: IrNode) => void): void {
  fn(node);
  for (const c of node.children) walkSubtree(c, fn);
}

/** Every `source_path` in the subtree rooted at `node` (self included). */
function subtreePaths(node: IrNode): string[] {
  const out: string[] = [];
  walkSubtree(node, (n) => out.push(n.source_path));
  return out;
}

/** Union of click/touch listener event types captured anywhere in the subtree (PARSE probe). */
function subtreeListenerTypes(node: IrNode): string[] {
  const types = new Set<string>();
  walkSubtree(node, (n) => {
    for (const t of n.listeners ?? []) types.add(t);
  });
  return [...types];
}

/** One confidence step up (multiple signals raise confidence — contract 16 §2). */
function raiseConfidence(c: DetectedBehavior['confidence']): DetectedBehavior['confidence'] {
  return c === 'low' ? 'medium' : 'high';
}

/**
 * Detect behaviors over a CLASSIFIED IR forest (roles already assigned) and attach each
 * `DetectedBehavior` to its pattern ROOT node (`IrNode.behaviors`). Returns every behavior detected
 * (the same objects that were attached). The forest is annotated IN PLACE — `classifyIr` calls this
 * on the fresh tree it owns; external callers must pass a tree they own. Deterministic + I/O-free.
 */
export function detectBehaviors(ir: IrNode[]): DetectedBehavior[] {
  const detected: DetectedBehavior[] = [];
  /** Per-kind claimed subtree paths — one behavior per pattern instance, highest root wins. */
  const claimedByKind = new Map<DetectedBehavior['kind'], Set<string>>();
  /** Union of all structurally-claimed paths (suppresses `custom-js` inside converted patterns). */
  const allClaimed = new Set<string>();

  const attach = (node: IrNode, behavior: DetectedBehavior): void => {
    node.behaviors = [...(node.behaviors ?? []), behavior];
    detected.push(behavior);
  };
  const claim = (kind: DetectedBehavior['kind'], node: IrNode): void => {
    let set = claimedByKind.get(kind);
    if (set === undefined) {
      set = new Set<string>();
      claimedByKind.set(kind, set);
    }
    for (const p of subtreePaths(node)) {
      set.add(p);
      allClaimed.add(p);
    }
  };
  const isClaimed = (kind: DetectedBehavior['kind'], path: string): boolean =>
    claimedByKind.get(kind)?.has(path) ?? false;
  /** Is the node inside a same-kind claim, or does its subtree contain one (it wraps a root)? */
  const intersectsClaim = (kind: DetectedBehavior['kind'], node: IrNode): boolean =>
    subtreePaths(node).some((p) => isClaimed(kind, p));

  /* ── pass 1: ARIA tabs — minimal common ancestor of tablist + tabs + panels (post-order). ── */
  interface TabSignals {
    tablists: string[];
    tabs: string[];
    panels: string[];
  }
  const tabsPass = (node: IrNode): TabSignals => {
    const sig: TabSignals = { tablists: [], tabs: [], panels: [] };
    for (const c of node.children) {
      const cs = tabsPass(c);
      sig.tablists.push(...cs.tablists);
      sig.tabs.push(...cs.tabs);
      sig.panels.push(...cs.panels);
    }
    if (node.role === 'tabs') sig.tablists.push(node.source_path);
    else if (node.role === 'tab') sig.tabs.push(node.source_path);
    else if (node.role === 'tab-content') sig.panels.push(node.source_path);

    if (
      !isClaimed('tabs', node.source_path) &&
      sig.tablists.length > 0 &&
      sig.tabs.length > 0 &&
      sig.panels.length > 0
    ) {
      const evidence = ['role=tablist', 'role=tab', 'role=tabpanel'];
      const classTok = behaviorClassToken(node, TABS_BEHAVIOR_HINTS);
      if (classTok !== null) evidence.push(`classname:${classTok}`);
      attach(node, {
        kind: 'tabs',
        confidence: 'high',
        evidence,
        nodeIds: [
          ...new Set([node.source_path, ...sig.tablists, ...sig.tabs, ...sig.panels]),
        ],
      });
      claim('tabs', node);
    }
    return sig;
  };
  for (const root of ir) tabsPass(root);

  /* ── pass 2: <details>/<summary> accordion (author-declared semantic — high). ── */
  for (const root of ir) {
    walkSubtree(root, (node) => {
      if (node.tag.toLowerCase() !== 'details' || isClaimed('accordion', node.source_path)) return;
      const evidence = ['tag:details'];
      if (node.children.some((c) => c.tag.toLowerCase() === 'summary')) {
        evidence.push('tag:summary');
      }
      const classTok = behaviorClassToken(node, ACCORDION_BEHAVIOR_HINTS);
      if (classTok !== null) evidence.push(`classname:${classTok}`);
      attach(node, {
        kind: 'accordion',
        confidence: 'high',
        evidence,
        nodeIds: [node.source_path, ...node.children.map((c) => c.source_path)],
      });
      claim('accordion', node);
    });
  }

  /* ── pass 3: classname/structural patterns, pre-order so the HIGHEST matching root claims. ── */
  const classnamePass = (node: IrNode): void => {
    // carousel: swiper|slick|splide|carousel|glide.
    const carouselTok = behaviorClassToken(node, CAROUSEL_BEHAVIOR_HINTS);
    if (carouselTok !== null && !intersectsClaim('carousel', node)) {
      const listeners = subtreeListenerTypes(node);
      const evidence = [`classname:${carouselTok}`];
      let confidence: DetectedBehavior['confidence'] = 'medium';
      if (listeners.length > 0) {
        evidence.push(...listeners.map((t) => `listener:${t}`));
        confidence = raiseConfidence(confidence);
      }
      attach(node, {
        kind: 'carousel',
        confidence,
        evidence,
        nodeIds: [node.source_path, ...node.children.map((c) => c.source_path)],
      });
      claim('carousel', node);
    }

    // tabs (classname-only — ARIA pass already claimed real ARIA tabs).
    const tabsTok = behaviorClassToken(node, TABS_BEHAVIOR_HINTS);
    if (tabsTok !== null && node.children.length > 0 && !intersectsClaim('tabs', node)) {
      const listeners = subtreeListenerTypes(node);
      const evidence = [`classname:${tabsTok}`];
      let confidence: DetectedBehavior['confidence'] = 'medium';
      if (listeners.length > 0) {
        evidence.push(...listeners.map((t) => `listener:${t}`));
        confidence = raiseConfidence(confidence);
      }
      attach(node, { kind: 'tabs', confidence, evidence, nodeIds: [node.source_path] });
      claim('tabs', node);
    }

    // accordion (classname-only — details pass already claimed semantic accordions).
    const accTok = behaviorClassToken(node, ACCORDION_BEHAVIOR_HINTS);
    if (accTok !== null && node.children.length > 0 && !intersectsClaim('accordion', node)) {
      const listeners = subtreeListenerTypes(node);
      const evidence = [`classname:${accTok}`];
      let confidence: DetectedBehavior['confidence'] = 'medium';
      if (listeners.length > 0) {
        evidence.push(...listeners.map((t) => `listener:${t}`));
        confidence = raiseConfidence(confidence);
      }
      attach(node, { kind: 'accordion', confidence, evidence, nodeIds: [node.source_path] });
      claim('accordion', node);
    }

    // nav-toggle: role=navigation + a toggle button descendant, else a bare toggle classname.
    if (node.role === 'nav-menu' && !intersectsClaim('nav-toggle', node)) {
      let toggle: IrNode | undefined;
      walkSubtree(node, (n) => {
        if (toggle !== undefined || n === node) return;
        const buttonish = n.tag.toLowerCase() === 'button' || n.role === 'button';
        const togglish =
          behaviorClassToken(n, NAV_TOGGLE_BEHAVIOR_HINTS) !== null ||
          n.attrs['aria-expanded'] !== undefined;
        if (buttonish && togglish) toggle = n;
      });
      if (toggle !== undefined) {
        const evidence = ['role=navigation', 'toggle-button'];
        const tok = behaviorClassToken(toggle, NAV_TOGGLE_BEHAVIOR_HINTS);
        if (tok !== null) evidence.push(`classname:${tok}`);
        attach(node, {
          kind: 'nav-toggle',
          confidence: 'high',
          evidence,
          nodeIds: [node.source_path, toggle.source_path],
        });
        claim('nav-toggle', node);
      }
    }
    const navTok = behaviorClassToken(node, NAV_TOGGLE_BEHAVIOR_HINTS);
    if (navTok !== null && !intersectsClaim('nav-toggle', node)) {
      attach(node, {
        kind: 'nav-toggle',
        confidence: 'medium',
        evidence: [`classname:${navTok}`],
        nodeIds: [node.source_path],
      });
      claim('nav-toggle', node);
    }

    // marquee: tag (high) or classname (medium).
    const isMarqueeTag = node.tag.toLowerCase() === 'marquee';
    const marqueeTok = behaviorClassToken(node, MARQUEE_BEHAVIOR_HINTS);
    if ((isMarqueeTag || marqueeTok !== null) && !intersectsClaim('marquee', node)) {
      const evidence: string[] = [];
      if (isMarqueeTag) evidence.push('tag:marquee');
      if (marqueeTok !== null) evidence.push(`classname:${marqueeTok}`);
      attach(node, {
        kind: 'marquee',
        confidence: isMarqueeTag ? 'high' : 'medium',
        evidence,
        nodeIds: [node.source_path],
      });
      claim('marquee', node);
    }

    for (const c of node.children) classnamePass(c);
  };
  for (const root of ir) classnamePass(root);

  /* ── pass 4: aria-expanded trigger + sibling panel → accordion (at the shared parent). ── */
  const ariaExpandedPass = (node: IrNode): void => {
    for (let i = 0; i < node.children.length; i += 1) {
      const trigger = node.children[i] as IrNode;
      const panel = node.children[i + 1];
      if (
        trigger.attrs['aria-expanded'] !== undefined &&
        panel !== undefined &&
        !isClaimed('accordion', node.source_path) &&
        !isClaimed('nav-toggle', trigger.source_path) &&
        !isClaimed('tabs', trigger.source_path)
      ) {
        const evidence = ['aria-expanded', 'sibling-panel'];
        const tok =
          behaviorClassToken(node, ACCORDION_BEHAVIOR_HINTS) ??
          behaviorClassToken(trigger, ACCORDION_BEHAVIOR_HINTS);
        let confidence: DetectedBehavior['confidence'] = 'medium';
        if (tok !== null) {
          evidence.push(`classname:${tok}`);
          confidence = raiseConfidence(confidence);
        }
        attach(node, {
          kind: 'accordion',
          confidence,
          evidence,
          nodeIds: [node.source_path, trigger.source_path, panel.source_path],
        });
        claim('accordion', node);
      }
    }
    for (const c of node.children) ariaExpandedPass(c);
  };
  for (const root of ir) ariaExpandedPass(root);

  /* ── pass 5: per-element detectors — form, video-embed, entrance-animation, hover-effect. ── */
  for (const root of ir) {
    walkSubtree(root, (node) => {
      // form (tag/ARIA semantic).
      if (node.role === 'form' && !isClaimed('form', node.source_path)) {
        const fields: string[] = [];
        walkSubtree(node, (n) => {
          if (n.role === 'form-field') fields.push(n.source_path);
        });
        attach(node, {
          kind: 'form',
          confidence: 'high',
          evidence: ['tag:form'],
          nodeIds: [node.source_path, ...fields],
        });
        claim('form', node);
      }

      // video-embed (already partially handled by mapping; routed through the behavior report).
      if (node.role === 'media-embed-youtube' || node.role === 'media-embed-video') {
        attach(node, {
          kind: 'video-embed',
          confidence: 'high',
          evidence: [node.role === 'media-embed-youtube' ? 'media:youtube' : `tag:${node.tag}`],
          nodeIds: [node.source_path],
        });
      }

      // entrance-animation: runtime keyframes probe (high) and/or animation-library classname.
      const entranceTok = behaviorClassToken(node, ENTRANCE_BEHAVIOR_HINTS);
      const hasAosAttr = node.attrs['data-aos'] !== undefined;
      if (node.animationProbe !== undefined || entranceTok !== null || hasAosAttr) {
        const evidence: string[] = [];
        let confidence: DetectedBehavior['confidence'] = 'medium';
        if (node.animationProbe !== undefined) {
          confidence = 'high';
          evidence.push(`keyframes:${node.animationProbe.name}`);
          if (node.animationProbe.keyframeProps.length > 0) {
            evidence.push(`animates:${node.animationProbe.keyframeProps.join('+')}`);
          } else {
            // P2-c honesty: the computed `animation-name` matched no readable `@keyframes` rule
            // (cross-origin sheet / CSSOM miss). The behavior must still APPEAR — the emitter will
            // honest-drop it tier 4 ("no extractable intent"), never silence (contract 18 §7).
            evidence.push('animates:unresolved(@keyframes rule not readable via CSSOM)');
          }
          evidence.push(`animation-duration:${node.animationProbe.duration}`);
        }
        if (entranceTok !== null) evidence.push(`classname:${entranceTok}`);
        if (hasAosAttr) evidence.push('attr:data-aos');
        attach(node, {
          kind: 'entrance-animation',
          confidence,
          evidence,
          nodeIds: [node.source_path],
        });
      }

      // hover-effect: forced-`:hover` delta + a transition covering a changed prop (both probes).
      const hoverProps = Object.keys(node.hoverComputed ?? {});
      const transition = node.transitionProbe;
      if (hoverProps.length > 0 && transition !== undefined) {
        const transitioned = transition.property
          .split(',')
          .map((p) => p.trim().toLowerCase())
          .filter((p) => p !== '');
        const covered =
          transitioned.includes('all') || hoverProps.some((p) => transitioned.includes(p));
        if (covered) {
          attach(node, {
            kind: 'hover-effect',
            confidence: 'high',
            evidence: [
              `hover-delta:${hoverProps.join(',')}`,
              `transition:${transition.property} ${transition.duration}`,
            ],
            nodeIds: [node.source_path],
          });
        }
      }
    });
  }

  /* ── pass 6: custom-js — unclaimed non-anchor click/touch listeners (candidate triggers). ── */
  for (const root of ir) {
    walkSubtree(root, (node) => {
      const listeners = node.listeners ?? [];
      if (listeners.length === 0 || allClaimed.has(node.source_path)) return;
      attach(node, {
        kind: 'custom-js',
        confidence: 'low',
        evidence: listeners.map((t) => `listener:${t}`),
        nodeIds: [node.source_path],
      });
    });
  }

  return detected;
}

/* ─────────────────────────── detection-honesty extension (contract 18 §7) ───────────────────── */

/*
 * "Silence is the only forbidden outcome" (contract 18 §7, detection-honesty block / 16 residual):
 * behavior classes the converter CANNOT detect per-node — JS-driven text mutations like rAF
 * count-ups (no listeners, no keyframes, no classname library hint; the only evidence is the page
 * script census) — must still APPEAR in the conversion report as a report-level
 * `undetectable_classes[]` note with script-census evidence. Unmappable `@keyframes` (computed
 * `animation-name != none` that fade/slide/scale cannot express) are NOT this function's job: they
 * already appear as a DetectedBehavior (pass 5 above) that the interactions emitter honest-drops
 * to tier 4 with a reason. The PIPELINE (integrator) wires this function's output into the
 * report; this module only produces the deterministic census verdicts.
 */

/**
 * One page script as the honesty census sees it. Compatible with BOTH census producers: the frozen
 * `PageScript` (PARSE — `src`/`inline_bytes` only) and passthrough's `censusScriptsWithContent`
 * (adds the inline `content`, which is what the rAF detection needs — without content only the
 * src-based library heuristic can fire).
 */
export interface ScriptCensusEntry {
  src: string | null;
  inline_bytes?: number;
  /** Inline script body when the caller captured it (passthrough census); absent for external. */
  content?: string;
}

/** A report-level note for a behavior class detection cannot express per-node (contract 18 §7). */
export interface UndetectableClassNote {
  /** The undetectable behavior class (only rAF-driven text mutation is censused today). */
  class: 'raf-text-mutation';
  /** Script-census evidence rows substantiating the claim — never an empty array. */
  evidence: string[];
  /** Best-effort SUSPECT IR nodes (numeric stat leaves / counter classnames); may be empty. */
  nodeIds: string[];
}

/** Known count-up / odometer library fingerprints (script src or inline body). */
const COUNT_UP_LIB_RE = /count[-_.]?up|counterup|odometer|purecounter/i;

/** Inline-body signals for a rAF-driven text mutation (the count-up implementation shape). */
const RAF_RE = /requestAnimationFrame/;
const TEXT_WRITE_RE = /\.(?:textContent|innerText|innerHTML)\s*=|\.innerHTML\b/;

/** Counter-ish class tokens marking a suspect stat node. */
const COUNTER_CLASS_HINTS: ReadonlyArray<string> = ['count', 'counter', 'odometer', 'stat-number'];

/** A short, purely numeric-ish stat text (`120`, `4,500+`, `98%`, `$12M`) — a count-up target. */
const NUMERIC_STAT_RE = /^[~+\-$€£#]?\s?\d[\d,.\s]*\s?[%+kKmMxX]?\+?$/;

/** Whole text of a node's runs, trimmed. */
function joinedText(node: IrNode): string {
  return node.textRuns
    .map((r) => r.text)
    .join('')
    .trim();
}

/**
 * Census the page scripts for behavior classes per-node detection CANNOT see (today: rAF-driven
 * text mutation / count-ups) and pair them with best-effort suspect nodes from the IR. Returns at
 * most one note per class; an empty array means the census found no evidence (an honest negative,
 * not silence — there is nothing to report). PURE + deterministic; the pipeline surfaces the notes
 * as report-level `undetectable_classes[]` (contract 18 §7 detection-honesty guard: the WPOS
 * fixture's count-up must appear somewhere in the report).
 */
export function detectUndetectableClasses(
  scripts: ReadonlyArray<ScriptCensusEntry>,
  ir: IrNode[],
): UndetectableClassNote[] {
  const evidence: string[] = [];
  for (const script of scripts) {
    const label =
      script.src !== null && script.src !== ''
        ? script.src
        : `inline script (${String(script.inline_bytes ?? script.content?.length ?? 0)}B)`;
    if (script.content !== undefined && RAF_RE.test(script.content)) {
      if (TEXT_WRITE_RE.test(script.content)) {
        evidence.push(
          `script-census: ${label} calls requestAnimationFrame and writes textContent/innerText/innerHTML (rAF text mutation)`,
        );
      } else {
        evidence.push(`script-census: ${label} calls requestAnimationFrame`);
      }
      continue;
    }
    if (script.src !== null && COUNT_UP_LIB_RE.test(script.src)) {
      evidence.push(`script-census: count-up library script ${script.src}`);
    } else if (script.content !== undefined && COUNT_UP_LIB_RE.test(script.content)) {
      evidence.push(`script-census: ${label} contains a count-up library fingerprint`);
    }
  }
  if (evidence.length === 0) return [];

  // Best-effort suspects: leaf text nodes whose entire text is a short numeric stat, or whose
  // classname carries a counter hint. Suspects are HINTS for the report reader, never a gate.
  const nodeIds: string[] = [];
  for (const root of ir) {
    walkSubtree(root, (node) => {
      if (nodeIds.length >= 20 || node.children.length > 0) return;
      const text = joinedText(node);
      const counterClass = classMatches(node, COUNTER_CLASS_HINTS);
      const numericStat = text !== '' && text.length <= 16 && NUMERIC_STAT_RE.test(text);
      if (numericStat || (counterClass && node.textRuns.length > 0)) {
        nodeIds.push(node.source_path);
      }
    });
  }

  return [{ class: 'raf-text-mutation', evidence, nodeIds }];
}

/* ─────────────────────────── smart naming (Anima/Locofy, §C.2) ──────────────────────────────── */

/** Reserved global-class label that must NEVER be a suggested name (authoring-contract R7). */
const RESERVED_LABELS: ReadonlySet<string> = new Set(['container']);

/** Source-class validity per authoring-contract R7: `/^[a-z][a-z-_0-9]*$/i`. */
const CLASS_NAME_RE = /^[a-z][a-z-_0-9]*$/i;

/** A role → readable base slug used when no usable source class / text is available. */
const ROLE_SLUGS: Readonly<Record<SemanticRole, string>> = {
  'structural-block': 'block',
  'flex-row': 'row',
  'flex-col': 'column',
  grid: 'grid',
  heading: 'heading',
  text: 'text',
  image: 'image',
  button: 'button',
  link: 'link',
  divider: 'divider',
  'icon-svg': 'icon',
  'media-embed-youtube': 'youtube',
  'media-embed-video': 'video',
  tabs: 'tabs',
  tab: 'tab',
  'tab-content': 'tab-content',
  form: 'form',
  'form-field': 'field',
  'nav-menu': 'nav',
  list: 'list',
  'list-item': 'list-item',
  table: 'table',
  accordion: 'accordion',
  'accordion-item': 'accordion-item',
  unknown: 'block',
};

/**
 * Slugify an arbitrary string into a class-name CANDIDATE: lower-case, non-alnum → `-`, collapse
 * repeats, trim leading/trailing `-`, ensure a leading letter (R7: no leading digit), clamp to 50
 * chars (R7: 2-50). Returns `''` when nothing usable remains.
 */
function slugify(raw: string): string {
  let s = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  // R7: no leading digit / `--` / `-digit`.
  s = s.replace(/^[0-9]+/, '');
  s = s.replace(/^-+/, '');
  if (s.length > 50) s = s.slice(0, 50).replace(/-+$/, '');
  return s;
}

/** Is `s` a valid, non-reserved global-class label candidate (2-50, leading letter, R7)? */
function isUsableLabel(s: string): boolean {
  if (s.length < 2 || s.length > 50) return false;
  if (RESERVED_LABELS.has(s)) return false;
  if (!/^[a-z]/.test(s)) return false; // leading letter (no digit/`-`)
  return true;
}

/**
 * The first usable source class token, preferring a strictly R7-valid token
 * (`/^[a-z][a-z-_0-9]*$/i`). When no token is strictly valid, recover a meaningful label by
 * slugifying a near-valid token (e.g. `3col-grid` → `col-grid`, leading digit stripped per R7) —
 * still more meaningful than the bare role slug, and the slug is always re-validated against the
 * label rules (so the returned candidate is always a valid global-class label).
 */
function firstUsableSourceClass(node: IrNode): string | undefined {
  const tokens = classTokens(node);
  // Pass 1: strictly R7-valid source class.
  for (const tok of tokens) {
    if (CLASS_NAME_RE.test(tok)) {
      const slug = slugify(tok);
      if (isUsableLabel(slug)) return slug;
    }
  }
  // Pass 2: recover a meaningful slug from a near-valid token (e.g. leading-digit class).
  for (const tok of tokens) {
    const slug = slugify(tok);
    if (isUsableLabel(slug)) return slug;
  }
  return undefined;
}

/** Leading text (first run) as a slug candidate (truncated to a few words). */
function leadingTextSlug(node: IrNode): string | undefined {
  const first = node.textRuns[0];
  if (first === undefined) return undefined;
  const words = first.text.trim().split(/\s+/).slice(0, 4).join(' ');
  const slug = slugify(words);
  return isUsableLabel(slug) ? slug : undefined;
}

/**
 * Derive a human-meaningful name CANDIDATE for a node (Anima/Locofy smart-naming, SUPPLEMENT §C.2),
 * used downstream by HOIST (WP-H09) to label global classes meaningfully instead of `g-<hex>`.
 *
 * Priority (WP Detailed Requirement 5): a valid source class (R7) → the role → leading text. NEVER
 * returns `g-<hex>` (that is HOIST's last resort) and always respects the label rules (2-50 chars, no
 * leading digit/`--`, not reserved `container`). Always returns a usable label (worst case the role
 * slug, which is always valid).
 */
export function suggestName(node: IrNode): string {
  const fromClass = firstUsableSourceClass(node);
  if (fromClass !== undefined) return fromClass;

  const roleSlug = ROLE_SLUGS[node.role];
  // For leaf text/heading/button, leading text is more meaningful than the bare role slug.
  if (
    node.role === 'heading' ||
    node.role === 'text' ||
    node.role === 'button' ||
    node.role === 'link'
  ) {
    const fromText = leadingTextSlug(node);
    if (fromText !== undefined) return `${roleSlug}-${fromText}`.slice(0, 50).replace(/-+$/, '');
  }

  if (isUsableLabel(roleSlug)) return roleSlug;

  const fromText = leadingTextSlug(node);
  if (fromText !== undefined) return fromText;

  // ROLE_SLUGS are all valid labels, so this is unreachable; keep a safe default.
  return 'block';
}

/* ─────────────────────────── AI-hint consistency (the seam) ─────────────────────────────────── */

/**
 * Is an AI-suggested `role` CONSISTENT with the node's deterministic signals? A hint is adopted only
 * when it does not contradict a decisive tag/ARIA signal (SUPPLEMENT §C.4: AI proposes, the
 * deterministic compiler is authoritative). Rules:
 *   - a hint matching the deterministic role is trivially consistent;
 *   - a hint is REJECTED when the tag/ARIA decisively says otherwise (e.g. hint=button on an `<h1>`,
 *     or hint=heading on an `<img>`);
 *   - for ambiguous container tags (div/section) where the deterministic role is structural/flex/grid,
 *     the AI MAY refine among the LAYOUT family (structural-block/flex-row/flex-col/grid) — those are
 *     all plausible for a container — but may NOT turn a container into a leaf widget it cannot be.
 */
const LAYOUT_FAMILY: ReadonlySet<SemanticRole> = new Set<SemanticRole>([
  'structural-block',
  'flex-row',
  'flex-col',
  'grid',
]);

/** Roles whose deterministic source is the TAG (decisive — the AI cannot override these). */
function isTagDecisive(node: IrNode): boolean {
  return roleFromTag(node) !== null || roleFromAria(node) !== null;
}

function isHintConsistent(
  node: IrNode,
  deterministic: SemanticRole,
  hintRole: SemanticRole,
): boolean {
  if (hintRole === deterministic) return true;

  // A decisive tag/ARIA signal is authoritative — the AI may not contradict it.
  if (isTagDecisive(node)) return false;

  // Ambiguous container: allow refinement within the layout family only.
  if (LAYOUT_FAMILY.has(deterministic) && LAYOUT_FAMILY.has(hintRole)) {
    // …but never claim `grid` for something that is clearly not a 2D grid.
    if (hintRole === 'grid' && !isTrueGrid(node)) return false;
    return true;
  }

  return false;
}

/* ─────────────────────────── classifyIr (the stage entrypoint) ──────────────────────────────── */

/**
 * The CLASSIFY stage entrypoint. Walks the normalized IR, runs the deterministic classifier on every
 * node, merges any AI `ai_hints` (adopting only consistent ones), and returns the role-assigned IR +
 * the override audit trail + warnings. `infer_flex` is honored by the layout classifier (when `false`
 * the classifier still labels containers from explicit `display`/class hints but does NOT fall back to
 * box-geometry band inference for dirty CSS — it degrades ambiguous containers to `structural-block`).
 *
 * Determinism: same `(ir, opts)` → same output. PURE: no I/O. The returned `ir` is a NEW tree (the
 * input is not mutated) with `IrNode.role` populated/refined.
 */
export function classifyIr(ir: IrNode[], opts: ClassifyOptions): ClassifyResult {
  const hintsByPath = indexHints(opts.ai_hints);
  const role_overrides: RoleOverride[] = [];
  const warnings: string[] = [];

  const classify = (node: IrNode, parent?: IrNode): IrNode => {
    // 1) deterministic role (optionally without geometry inference when infer_flex=false).
    const deterministic = opts.infer_flex
      ? classifyNode(node, parent)
      : classifyNodeNoGeometry(node, parent);

    let finalRole = deterministic;

    // 2) AI hint seam — adopt only when consistent; always record the verdict.
    const hint = hintsByPath.get(node.source_path);
    if (hint !== undefined && hint.role !== undefined && hint.role !== deterministic) {
      const accepted = isHintConsistent(node, deterministic, hint.role);
      role_overrides.push({
        source_path: node.source_path,
        from: deterministic,
        to: hint.role,
        source: 'ai',
        accepted,
      });
      if (accepted) {
        finalRole = hint.role;
      } else {
        warnings.push(
          `CLASSIFY: rejected AI role hint '${hint.role}' for ${node.source_path} ` +
            `(inconsistent with deterministic '${deterministic}'); kept '${deterministic}'.`,
        );
      }
    }

    // 3) record a deterministic refinement of the input role (observability) when it changed.
    if (
      finalRole !== node.role &&
      (hint === undefined || hint.role === undefined || finalRole === deterministic)
    ) {
      role_overrides.push({
        source_path: node.source_path,
        from: node.role,
        to: finalRole,
        source: 'deterministic',
        accepted: true,
      });
    }

    const out: IrNode = { ...node, role: finalRole, children: [] };
    // Behaviors are re-detected on the fresh tree below — never carried over from the input
    // (keeps re-classification idempotent instead of duplicating annotations).
    delete out.behaviors;
    out.children = node.children.map((c) => classify(c, out));
    return out;
  };

  const classified = ir.map((root) => classify(root, undefined));

  // Behavior detection (contract 16 §2) — pure annotation onto pattern-ROOT nodes of the fresh tree
  // this stage owns. A page with zero behavior signals gets zero `behaviors` fields (§8 invariant 5).
  detectBehaviors(classified);

  return { ir: classified, role_overrides, warnings };
}

/** Index AI hints by `source_path` (last one wins on duplicate, deterministically by array order). */
function indexHints(hints: AiRoleHint[] | undefined): Map<string, AiRoleHint> {
  const map = new Map<string, AiRoleHint>();
  if (hints === undefined) return map;
  for (const h of hints) map.set(h.source_path, h);
  return map;
}

/**
 * The deterministic classifier WITHOUT box-geometry band inference (used when `infer_flex:false`).
 * ARIA > tag > class hint > explicit `display:flex/grid` only; an ambiguous container that would
 * otherwise be inferred from geometry degrades to `structural-block`.
 */
function classifyNodeNoGeometry(node: IrNode, parent?: IrNode): SemanticRole {
  const aria = roleFromAria(node);
  if (aria !== null) return aria;
  const byTag = roleFromTag(node);
  if (byTag !== null) return byTag;
  const byClass = roleFromClassHint(node);
  // Explicit display only (no geometry fallback).
  const d = display(node);
  const explicitGrid = isTrueGrid(node);
  if (byClass !== null) {
    if ((byClass === 'flex-row' || byClass === 'flex-col') && explicitGrid) return 'grid';
    // A weak structural class hint must NOT mask an explicit flex/grid display (precedence parity
    // with `classifyNode`).
    if (byClass === 'structural-block' && isExplicitLayout(node)) {
      if (explicitGrid) return 'grid';
      const fd = node.computed['flex-direction'];
      return fd === 'column' || fd === 'column-reverse' ? 'flex-col' : 'flex-row';
    }
    return byClass;
  }
  if (explicitGrid) return 'grid';
  if (d === 'flex' || d === 'inline-flex') {
    const fd = node.computed['flex-direction'];
    return fd === 'column' || fd === 'column-reverse' ? 'flex-col' : 'flex-row';
  }
  if (
    parent !== undefined &&
    (parent.role === 'list' || parent.role === 'nav-menu') &&
    node.tag.toLowerCase() === 'li'
  ) {
    return 'list-item';
  }
  if (node.children.length >= 1) return 'structural-block';
  if (node.textRuns.length > 0) return 'text';
  // P2-c parity with `classifyNode`: a behavior-bearing empty leaf is never `unknown`.
  return carriesBehaviorSignal(node) ? 'structural-block' : 'unknown';
}
