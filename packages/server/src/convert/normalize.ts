/**
 * WP-H04 — NORMALIZE stage (impl of `normalizeIr`, frozen seam `convert/types.ts`, WP-H01).
 *
 * The SECOND HTML→native conversion stage. Takes the raw IR forest from PARSE (WP-H03) and normalizes
 * it for native authoring. The load-bearing job is **promoting block-level children out of `html-v3`
 * inline-only text** — because the atomic `html-v3` prop runs `wp_kses` with the inline allowlist
 * `[b,i,em,u,a,del,span,strong,sup,sub,s]` (`html-v3-prop-type.php:82,91`,
 * `11-authoring-contract.md §3.3`) and SILENTLY strips everything else. Promoted blocks and
 * synthesized pseudo nodes attach INSIDE the host's subtree at the correct index (contract 18 §7
 * P2-a/P2-b): the text-bearing host is restructured into a container whose children are
 * `[::before pseudo?, <host>::text content leaf, …promoted blocks, ::after pseudo?]` — NEVER
 * emitted as siblings, which at the forest root spilled stray TOP-LEVEL nodes after the page root
 * (page 2658: +20px height + global odiff ghosting). It also:
 *   - records every strip (`computeStrippedTags` mirror) so the coverage report's `stripped_text`
 *     (diff.schema.json `CoverageReport.stripped_text` / `HTML_V3_STRIPPED` soft error) is honest,
 *   - collapses whitespace-only text nodes / runs (respecting `white-space: pre*`),
 *   - unwraps redundant single-child styleless wrappers (conservative — never loses layout),
 *   - resolves relative URLs in media/links against `base_url`,
 *   - decodes HTML entities in text runs + attribute values.
 *
 * PURE transform: deterministic, NO I/O, NO Playwright, NO WP client, idempotent. NO classification
 * (WP-H05), NO Elementor mapping (WP-H06), NO typed envelopes (WP-H08). Output is still IR.
 *
 * `computeStrippedTags` is REPORT-ONLY: it mirrors the PHP `wp_kses` strip behaviour for the coverage
 * report. The authoritative final `html-v3` value is built in STYLE-EXTRACT/ASSEMBLE and validated by
 * PHP dry_run — never claim a tree is valid based on this TS mirror.
 *
 * Owns ONLY the FUNCTION + helpers; `NormalizeContext`/`NormalizeResult`/`StrippedRecord`/
 * `PromotionRecord`/`IrNode`/`SemanticRole`/`TextRun` are FROZEN in WP-H01 (`types.ts`) and imported.
 */

// Additive contract-17 #10 extension fields produced by PARSE (`pseudoBefore`/`pseudoAfter`) —
// type-only import, erased at runtime (never pulls in Playwright).
import type { PseudoIrNode } from './parse.js';
import type {
  BoxRect,
  ComputedStyleSet,
  IrNode,
  MediaRef,
  NormalizeContext,
  NormalizeResult,
  PromotionRecord,
  SemanticRole,
  StrippedRecord,
  TextRun,
} from './types.js';

/* ─────────────────────────── INLINE_ALLOWLIST (single source of truth) ──────────────────────── */

/**
 * The EXACT inline allowlist `wp_kses` keeps inside an `html-v3` value (`html-v3-prop-type.php:91`,
 * `11-authoring-contract.md §3.3`). Anything NOT in this set is silently stripped by PHP, so the
 * normalizer must promote block content out and the report must list the strips. This is the single
 * source of truth for what survives inside `html-v3`. Snapshot-tested for the 11 exact tags.
 */
export const INLINE_ALLOWLIST: ReadonlySet<string> = new Set([
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
]);

/**
 * The tags PARSE's in-page `extractTextRuns` recurses when folding inline content into a text node's
 * `textRuns` (`parse.ts` `INLINE_ALLOW`): the 11-tag `INLINE_ALLOWLIST` PLUS `mark`/`code`/`abbr`/
 * `cite` (whose TEXT survives `wp_kses` even though the tag itself is stripped) and the textless
 * `<br>`. A media-free child of a text-bearing node with any of these tags is ALREADY captured in the
 * parent's runs by PARSE, so {@link isInlineFoldableChild} must fold (drop) it — promoting it would
 * duplicate the text as a separate widget (`<p>x <mark>y</mark> z</p>`) or emit a phantom textless
 * block (`<p>a<br>b</p>`). REPORT accounting (`computeStrippedTags`) stays on the strict 11-tag
 * `INLINE_ALLOWLIST` so mark/code/br/abbr/cite strips remain visible in `stripped_text`.
 */
const PARSE_FOLDED_INLINE: ReadonlySet<string> = new Set([
  ...INLINE_ALLOWLIST,
  'mark',
  'code',
  'br',
  'abbr',
  'cite',
]);

/**
 * Block-level / sectioning / list tags that, when found inside a text-bearing node's raw inner markup,
 * are PROMOTED to sibling IR nodes (not just stripped). Used to drive promotion ordering. Anything not
 * here and not in `INLINE_ALLOWLIST` (e.g. `<mark>`, `<code>`, `<small>`, `<font>`, `<br>` inline) is
 * stripped-only (recorded, not promoted). This is a heuristic for WHICH non-allowlisted tags warrant
 * a structural sibling — `computeStrippedTags` still reports ALL non-allowlisted tags regardless.
 */
const PROMOTABLE_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
  'nav',
  'figure',
  'figcaption',
  'blockquote',
  'pre',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'form',
  'hr',
]);

/* ─────────────────────────── HTML entity decode (no deps — pure TS) ──────────────────────────── */

/**
 * The named HTML entities that realistically appear in marketing copy + attribute values. A full
 * HTML5 named-entity table is ~2000 entries; this covers the common set and ALL numeric entities are
 * handled generically below. PHP `wp_kses` re-encodes as needed downstream, so decoding to the literal
 * character here is safe (`11-authoring-contract.md §3.3`, ticket req 6).
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  cent: '¢',
  yen: '¥',
  sect: '§',
  para: '¶',
  laquo: '«',
  raquo: '»',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  shy: '­',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  zwnj: '‌',
  zwj: '‍',
};

/**
 * Decode named + numeric (decimal `&#160;` and hex `&#xA0;`) HTML entities to their literal characters.
 * Unrecognized named entities are left verbatim (lossless — never corrupts unknown text). Pure +
 * deterministic; no DOM, no deps.
 */
export function decodeEntities(text: string): string {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* '#' */) {
      const isHex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88; /* x | X */
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : whole;
  });
}

/* ─────────────────────────── Tag scanning of raw inner markup (report mirror) ────────────────── */

/**
 * Extract the DISTINCT lowercased tag names appearing as elements in a raw HTML markup string, in
 * first-seen document order. Ignores comments, the contents of `<script>`/`<style>` raw-text elements,
 * and closing/self-closing slashes. Pure string scan (no DOM) so it works in Node without a parser.
 */
function scanTagNames(rawHtml: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  // Match opening or self-closing tags: <tag ...> / <tag/> ; skip closing </tag> and comments.
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*?)?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(rawHtml)) !== null) {
    const tag = (m[1] ?? '').toLowerCase();
    if (tag.length > 0 && !seen.has(tag)) {
      seen.add(tag);
      order.push(tag);
    }
  }
  return order;
}

/**
 * REPORT-ONLY mirror of the `html-v3` `wp_kses` strip: given a text node's raw inner markup, return the
 * distinct tag names (document order) that the inline allowlist would strip — i.e. everything NOT in
 * `INLINE_ALLOWLIST` (including `br`, `mark`, `code`, `small`, `font`, lists, headings, nested blocks).
 * This is the TS mirror used ONLY for the coverage report (`CoverageReport.stripped_text` /
 * `HTML_V3_STRIPPED`); PHP dry_run remains authoritative for the final tree.
 */
export function computeStrippedTags(rawInnerHtml: string): string[] {
  return scanTagNames(rawInnerHtml).filter((t) => !INLINE_ALLOWLIST.has(t));
}

/* ─────────────────────────── Style / wrapper helpers ────────────────────────────────────────── */

/**
 * CSS props whose presence means a wrapper carries real layout/visual intent and MUST NOT be unwrapped
 * (the "5+ nested divs reduce accuracy" failure is solved by keeping deliberate wrappers, but a styled
 * wrapper genuinely holds layout — removing it loses fidelity, SUPPLEMENT §C.1, ticket req 4).
 */
const LAYOUT_BEARING_PROPS: readonly string[] = [
  'display',
  'flex-direction',
  'flex-wrap',
  'justify-content',
  'align-items',
  'align-content',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-flow',
  'position',
  'background-color',
  'background-image',
  'background',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'padding-block',
  'padding-inline',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'margin-block',
  'margin-inline',
  'border',
  'border-width',
  'border-style',
  'border-radius',
  'box-shadow',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'transform',
  'filter',
  'opacity',
];

/** Computed values that count as "no own style" for a layout-bearing prop (default / inert). */
const INERT_LAYOUT_VALUES: ReadonlySet<string> = new Set([
  '',
  'none',
  'auto',
  'normal',
  'static',
  'visible',
  '0px',
  '0',
  '0px 0px 0px 0px',
  'rgba(0, 0, 0, 0)',
  'transparent',
  'block', // a bare default-block div carries no deliberate layout intent
  'inline',
]);

/** Tags that carry inherent semantic meaning and must never be silently unwrapped (would lose role). */
const SEMANTIC_TAGS: ReadonlySet<string> = new Set([
  'header',
  'footer',
  'main',
  'nav',
  'section',
  'article',
  'aside',
  'figure',
  'figcaption',
  'form',
  'a',
  'button',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
]);

/** True when a node carries deliberate layout/visual style that makes unwrapping it lossy. */
function hasNonDefaultStyle(node: IrNode): boolean {
  for (const prop of LAYOUT_BEARING_PROPS) {
    const v = node.computed[prop];
    if (v !== undefined && !INERT_LAYOUT_VALUES.has(v.trim())) {
      return true;
    }
  }
  return false;
}

/** True when a node is a generic non-semantic wrapper tag (`div`/`span`) safe to consider unwrapping. */
function isGenericWrapperTag(tag: string): boolean {
  return tag === 'div' || tag === 'span';
}

/**
 * True when a node carries no semantic role that would make unwrapping it lossy. NORMALIZE runs BEFORE
 * CLASSIFY (`types.ts` pipeline order), so PARSE-seeded nodes are all `'unknown'`; a generic structural
 * block is also safe to collapse. Any other assigned role (heading, button, flex, grid, ...) is kept.
 */
function hasNoSemanticRole(node: IrNode): boolean {
  return node.role === 'unknown' || node.role === 'structural-block';
}

/* ─────────────────────────── Whitespace ─────────────────────────────────────────────────────── */

/** True when a node's computed `white-space` preserves whitespace (`pre`, `pre-wrap`, `pre-line`...). */
function preservesWhitespace(node: IrNode): boolean {
  const ws = node.computed['white-space'];
  if (ws !== undefined) {
    return /^pre/.test(ws.trim());
  }
  // `white-space` is NOT a Style-Schema prop (authoring-contract §5.2); PARSE may omit it. `<pre>`
  // tags preserve by default. Otherwise default to collapse (ticket req 3).
  return node.tag === 'pre';
}

/** Collapse runs of whitespace to a single space and trim — the CSS `white-space: normal` behaviour. */
function collapseWhitespace(text: string): string {
  return text.replace(/[\t\n\r\f ]+/g, ' ');
}

/* ─────────────────────────── URL resolution ─────────────────────────────────────────────────── */

/**
 * Resolve a possibly-relative URL against `base_url`. Absolute URLs (with a scheme), protocol-relative
 * (`//`), data:, blob:, mailto:, tel:, and fragment-only (`#`) URLs are returned untouched. When no
 * `base_url` is supplied, the URL is returned unchanged (sideload happens in ASSEMBLE, ticket req 5).
 */
function resolveUrl(url: string, baseUrl: string | undefined): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return url;
  // Already absolute / non-resolvable schemes / protocol-relative / fragment.
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || // has a scheme (http:, data:, mailto:, tel:, blob:)
    trimmed.startsWith('//') ||
    trimmed.startsWith('#')
  ) {
    return trimmed;
  }
  if (baseUrl === undefined || baseUrl.length === 0) return url;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return url;
  }
}

/** Resolve every URL-bearing field of a media ref + decode its alt text. Returns a NEW ref. */
function resolveMedia(media: MediaRef, baseUrl: string | undefined): MediaRef {
  const out: MediaRef = { ...media };
  if (out.url !== undefined && out.kind !== 'svg') {
    // `svg` media stores raw outerHTML in `url` (PARSE convention) — never URL-resolve markup.
    out.url = resolveUrl(out.url, baseUrl);
  }
  if (out.srcset !== undefined) {
    out.srcset = resolveSrcset(out.srcset, baseUrl);
  }
  if (out.alt !== undefined) {
    out.alt = decodeEntities(out.alt);
  }
  return out;
}

/** Resolve each candidate URL in a `srcset` descriptor list against `base_url`. */
function resolveSrcset(srcset: string, baseUrl: string | undefined): string {
  return srcset
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed.length === 0) return trimmed;
      const sp = trimmed.indexOf(' ');
      if (sp === -1) return resolveUrl(trimmed, baseUrl);
      const urlPart = trimmed.slice(0, sp);
      const descriptor = trimmed.slice(sp); // keeps leading space + descriptor (e.g. " 2x")
      return resolveUrl(urlPart, baseUrl) + descriptor;
    })
    .join(', ');
}

/** Attribute names whose values are URLs and should resolve against `base_url`. */
const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src', 'poster', 'action', 'cite', 'data']);

/** Decode entities in every attribute value + resolve URL-bearing attributes. Returns a NEW map. */
function normalizeAttrs(
  attrs: Record<string, string>,
  baseUrl: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const decoded = decodeEntities(value);
    out[key] = URL_ATTRS.has(key.toLowerCase()) ? resolveUrl(decoded, baseUrl) : decoded;
  }
  return out;
}

/* ─────────────────────────── Promotion (the load-bearing job) ────────────────────────────────── */

const PROMOTED_PATH_SEP = '::promoted';

/** Build a deterministic synthetic source_path for a node promoted out of a text host's content. */
function promotedPath(parentPath: string, index: number): string {
  return `${parentPath}${PROMOTED_PATH_SEP}[${index}]`;
}

/** A fresh zero box for synthetic promoted nodes (geometry is unknown at NORMALIZE — CLASSIFY refines). */
function zeroBox(): BoxRect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Map a promotable block tag to the seed `SemanticRole` for its sibling node. NORMALIZE does NOT do
 * full classification (WP-H05) — it only assigns the obvious structural seed so document order + node
 * kind survive; CLASSIFY refines. Headings → `heading`, list → `list`, list-item → `list-item`, the
 * rest → `structural-block`.
 */
function seedRoleForBlock(tag: string): SemanticRole {
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'list-item';
  return 'structural-block';
}

/** Make a synthetic promoted IR node (empty husk) for a block tag found inside a text node. */
function makePromotedNode(
  tag: string,
  sourcePath: string,
  inheritedComputed: ComputedStyleSet,
): IrNode {
  return {
    source_path: sourcePath,
    tag,
    role: seedRoleForBlock(tag),
    box: zeroBox(),
    // Promoted siblings start with the inherited typography of the host text node so a later
    // STYLE-EXTRACT has a sane baseline; layout props are intentionally NOT copied.
    computed: { ...inheritedComputed },
    responsive: {},
    attrs: {},
    textRuns: [],
    children: [],
  };
}

/** Typography props worth carrying onto a promoted sibling (inherited, non-layout). */
const INHERITED_TYPOGRAPHY: readonly string[] = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'direction',
];

/** Pick the inheritable typography subset of a node's computed set (for promoted siblings). */
function inheritedTypographyOf(node: IrNode): ComputedStyleSet {
  const out: ComputedStyleSet = {};
  for (const p of INHERITED_TYPOGRAPHY) {
    const v = node.computed[p];
    if (v !== undefined) out[p] = v;
  }
  return out;
}

/* ── Host restructure (contract 18 §7 P2-a/P2-b) ──────────────────────────────────────────────── */

const TEXT_CONTENT_PATH_SEP = '::text';

/**
 * Deterministic synthetic source_path for the content leaf of a RESTRUCTURED text-bearing host
 * (P2-a). Same `::`-suffix convention as `::promoted`/`::pseudo-` (and MAP's own tab-panel `::text`
 * synthesis), so structural source paths never collide with it. Exported for downstream
 * source-correspondence consumers (verify-loop content-presence audit, P1-e).
 */
export function textContentPath(hostPath: string): string {
  return `${hostPath}${TEXT_CONTENT_PATH_SEP}`;
}

/**
 * Tags whose CLASSIFY `roleFromTag` forces a LEAF text widget even when the node has element
 * children and no runs (`h1-6` → heading → e-heading, `button` → e-button, `li` → list-item →
 * e-paragraph). A restructured host keeping such a tag would map to a leaf widget and ASSEMBLE
 * would silently drop the very children P2-a just attached — so the host container retags to `div`
 * while the synthesized `::text` content child keeps the original tag (the heading level / list-item
 * semantics survive on the leaf that actually carries the text). Generic text tags (`p`/`span`/
 * `blockquote`/…) fall through CLASSIFY's tag pass when run-less with children, and `a` must keep
 * its tag (the wrapping-anchor `link` role carries the href onto the container).
 */
const LEAF_FORCING_TAGS: ReadonlySet<string> = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'button',
  'li',
]);

/**
 * Synthesize the content LEAF for a restructured text-bearing host (P2-a): a childless text node
 * carrying the host's (already normalized) runs. Keeps the HOST's tag so leaf semantics survive
 * (an `<h2>` host's text stays a heading widget) and the host's inherited typography so
 * STYLE-EXTRACT has the same baseline the runs rendered with. Box is the host's box (the text
 * painted inside it; CLASSIFY's geometry passes refine).
 */
function makeTextContentNode(host: IrNode, runs: TextRun[]): IrNode {
  return {
    source_path: textContentPath(host.source_path),
    tag: host.tag,
    role: /^h[1-6]$/.test(host.tag) ? 'heading' : 'text',
    box: { ...host.box },
    computed: inheritedTypographyOf(host),
    responsive: {},
    attrs: {},
    textRuns: runs,
    children: [],
  };
}

/**
 * The result of promoting block content out of one text node: the nodes to attach INSIDE the
 * restructured host (document order) + the promotion record (or null when nothing was promoted).
 */
interface PromotionOutcome {
  promotedSiblings: IrNode[];
  record: PromotionRecord | null;
}

/**
 * SYNTHESIS FALLBACK ONLY: decide which block tags inside a text node's raw inner markup warrant
 * promotion and synthesize EMPTY husk nodes from the tag scan (attached inside the restructured
 * host by `normalizeNode`, P2-a). PARSE wires every element child as a real IR node, so
 * `normalizeNode` MOVES those real children (with their styles, boxes, text and subtrees) out of
 * the html-v3 content — this scan-based synthesis runs only when NO real non-inline child exists
 * (malformed markup the browser parser re-homed). Synthesizing INSTEAD of moving was the
 * content-loss bug: the empty husk shadowed the real child, which ASSEMBLE later silently dropped.
 */
function planPromotion(node: IrNode, rawInner: string | undefined): PromotionOutcome {
  if (rawInner === undefined || rawInner.length === 0) {
    return { promotedSiblings: [], record: null };
  }
  const allTags = scanTagNames(rawInner);
  const blockTags = allTags.filter((t) => PROMOTABLE_BLOCK_TAGS.has(t) && !INLINE_ALLOWLIST.has(t));
  if (blockTags.length === 0) {
    return { promotedSiblings: [], record: null };
  }
  const inherited = inheritedTypographyOf(node);
  const siblings: IrNode[] = [];
  const promotedTo: string[] = [];
  blockTags.forEach((tag, i) => {
    const path = promotedPath(node.source_path, i);
    siblings.push(makePromotedNode(tag, path, inherited));
    promotedTo.push(path);
  });
  return {
    promotedSiblings: siblings,
    record: {
      from_source_path: node.source_path,
      promoted_to: promotedTo,
      reason: `block content (${blockTags.join(', ')}) promoted out of html-v3 inline-only text`,
    },
  };
}

/* ─────────────────────────── Pseudo-element synthesis (contract 17 #10) ─────────────────────── */

/** Which pseudo-element a record refers to. */
export type PseudoKind = 'before' | 'after';

/** A representable pseudo synthesized as a real IR child/sibling node (honest accounting, I3). */
export interface PseudoSynthRecord {
  source_path: string;
  pseudo: PseudoKind;
  synthesized_path: string;
}

/** An unrepresentable pseudo, honestly dropped with the contract-17 #10 reason token (I3). */
export interface PseudoDropRecord {
  source_path: string;
  pseudo: PseudoKind;
  /** The computed `content` value of the dropped pseudo (e.g. `"→"`, `counter(li)`). */
  content: string;
  reason: 'pseudo_unrepresentable';
  /** Human detail on WHY it is unrepresentable (text content / mask-bearing / zero size). */
  detail: string;
}

/**
 * Additive extension of the frozen `NormalizeResult` (contract 17 #10) — declared here (the
 * producing stage) rather than re-freezing WP-H01, same pattern as `LinkedTextRun`. Both arrays are
 * ALWAYS present (empty on pseudo-free pages, and on a second normalize pass — idempotence).
 */
export interface NormalizeResultWithPseudo extends NormalizeResult {
  pseudo_synthesized: PseudoSynthRecord[];
  pseudo_drops: PseudoDropRecord[];
}

const PSEUDO_PATH_SEP = '::pseudo-';

/**
 * Deterministic synthetic source_path for a synthesized pseudo node — ALSO the path the pipeline
 * stamps onto the honest-drop ledger rows (#10/I3), so the verify loop's pseudo-child cause
 * attribution (`…>p` vs `…>p::pseudo-before` prefix match) sees producer and ledger in lockstep.
 */
export function pseudoPath(parentPath: string, pseudo: PseudoKind): string {
  return `${parentPath}${PSEUDO_PATH_SEP}${pseudo}`;
}

/** Unwrap a computed `content` string literal (`"…"`/`'…'` → inner); null = not a string literal. */
function unquoteContent(content: string): string | null {
  const t = content.trim();
  const m = /^"([\s\S]*)"$/.exec(t) ?? /^'([\s\S]*)'$/.exec(t);
  return m ? (m[1] ?? '') : null;
}

/** Parse a computed px length; null for `auto`/percentages/anything non-px. */
function pxValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m ? Number.parseFloat(m[1] as string) : null;
}

/**
 * Decide whether a captured pseudo (PARSE's `PSEUDO_CAPTURE_PROPS` pick) is REPRESENTABLE as a real
 * IR node (contract 17 #10): an EMPTY-content sized box (dots, dashes, accent bars). Text-content
 * pseudos (`content:"→"`, `counter()`, `attr()`, `url()`), mask-bearing pseudos, and zero/auto-size
 * boxes are honest drops with reason `pseudo_unrepresentable` (I3). Pure.
 */
export function classifyPseudoCapture(
  capture: ComputedStyleSet,
): { representable: true } | { representable: false; detail: string } {
  const content = capture['content'] ?? 'none';
  const inner = unquoteContent(content);
  if (inner === null) {
    return { representable: false, detail: `non-string content (${content})` };
  }
  if (inner.trim().length > 0) {
    return { representable: false, detail: `text content (${content})` };
  }
  const mask = capture['mask-image'];
  if (mask !== undefined && mask !== 'none') {
    return { representable: false, detail: 'mask-bearing' };
  }
  const width = pxValue(capture['width']);
  const height = pxValue(capture['height']);
  if (width === null || height === null || width <= 0 || height <= 0) {
    return {
      representable: false,
      detail: `zero/auto size (${capture['width'] ?? 'auto'} × ${capture['height'] ?? 'auto'})`,
    };
  }
  return { representable: true };
}

/** Captured pseudo props carried onto the synthesized node only when NON-inert (I4 noise rule). */
const PSEUDO_CARRY_INERT: Readonly<Record<string, ReadonlySet<string>>> = {
  'background-color': new Set(['transparent', 'rgba(0, 0, 0, 0)']),
  'background-image': new Set(['none']),
  'border-radius': new Set(['0px']),
  display: new Set([]),
};

/**
 * Synthesize the real IR node for a representable pseudo (contract 17 #10). The node is a styled,
 * childless, textless `div` seeded `structural-block` (CLASSIFY refines): `width`/`height` always
 * carried (the box IS the content), paint/radius/display when non-inert, and — honoring absolutely
 * positioned pseudos — `position` plus its non-`auto` insets when the scheme is non-static (the
 * insets stay relative to the positioned ancestor exactly as the source pseudo was). The box rect
 * carries the px size so CLASSIFY's geometry passes see it. Pure; the caller decides placement
 * (`before` → first, `after` → last).
 */
export function synthesizePseudoNode(
  parent: IrNode,
  pseudo: PseudoKind,
  capture: ComputedStyleSet,
): IrNode {
  const computed: ComputedStyleSet = {};
  for (const prop of ['width', 'height']) {
    const v = capture[prop];
    if (v !== undefined) computed[prop] = v;
  }
  // Padding longhands are carried VERBATIM — including `0px` (contract 17 §1 I2): the synthesized
  // node maps to a container whose base padding PAINTS (e-div-block/e-flexbox: 10px per side), so a
  // zero source padding is a real override the extractor must emit (its noise filter exempts
  // painted base-default families), and the I2 source correspondence stays judgeable for the
  // synthesized node instead of letting the 10px base inflate an 8px dot to 28px.
  for (const side of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']) {
    const v = capture[side];
    if (v !== undefined) computed[side] = v;
  }
  for (const [prop, inert] of Object.entries(PSEUDO_CARRY_INERT)) {
    const v = capture[prop];
    if (v !== undefined && !inert.has(v.trim())) computed[prop] = v;
  }
  const position = capture['position'];
  if (position !== undefined && position !== 'static') {
    computed['position'] = position;
    for (const inset of ['top', 'right', 'bottom', 'left']) {
      const v = capture[inset];
      if (v !== undefined && v !== 'auto') computed[inset] = v;
    }
  }
  return {
    source_path: pseudoPath(parent.source_path, pseudo),
    tag: 'div',
    role: 'structural-block',
    box: {
      x: 0,
      y: 0,
      width: pxValue(capture['width']) ?? 0,
      height: pxValue(capture['height']) ?? 0,
    },
    computed,
    responsive: {},
    attrs: { 'data-emcp-pseudo': pseudo },
    textRuns: [],
    children: [],
  };
}

/* ─────────────────────────── Text-run normalization ─────────────────────────────────────────── */

/**
 * `TextRun` plus the optional inline-link capture PARSE attaches to runs wrapped in an `<a href>`
 * (`extractTextRuns`): `inlineTags` carries tag NAMES only, so the destination rides on the run.
 * Additive — the frozen `TextRun` seam is untouched; consumers that ignore the fields are unaffected.
 */
interface LinkedTextRun extends TextRun {
  linkHref?: string;
  linkTarget?: string;
}

/**
 * Normalize a node's text runs: decode entities + collapse/trim whitespace (unless the node preserves
 * whitespace). Drops runs that become empty after collapse. Preserves the per-run inline-link capture
 * (`linkHref`/`linkTarget`), resolving the href against `base_url` like every other URL attribute.
 * Returns a NEW array.
 */
function normalizeTextRuns(
  runs: TextRun[],
  preserve: boolean,
  baseUrl: string | undefined,
): TextRun[] {
  const out: TextRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] as LinkedTextRun | undefined;
    if (run === undefined) continue;
    let text = decodeEntities(run.text);
    if (!preserve) {
      text = collapseWhitespace(text);
    }
    if (!preserve) {
      // Trim leading space on the first run and trailing space on the last run of a node; collapse
      // internal boundaries are handled by `collapseWhitespace`. Keep a single inter-run space.
      if (i === 0) text = text.replace(/^ +/, '');
      if (i === runs.length - 1) text = text.replace(/ +$/, '');
    }
    if (text.length === 0) continue;
    const copy: LinkedTextRun = { text, inlineTags: [...run.inlineTags] };
    if (run.linkHref !== undefined) {
      copy.linkHref = resolveUrl(decodeEntities(run.linkHref), baseUrl);
    }
    if (run.linkTarget !== undefined) {
      copy.linkTarget = run.linkTarget;
    }
    if (run.color !== undefined) {
      // The contract-17 #8 accent capture rides the run through normalize — dropping it here
      // silently re-inked every recolored <em>/<span> downstream of a whitespace collapse.
      copy.color = run.color;
    }
    out.push(copy);
  }
  return out;
}

/* ─────────────────────────── Per-node normalize (recursive) ─────────────────────────────────── */

interface NormalizeAccumulator {
  stripped: StrippedRecord[];
  promotions: PromotionRecord[];
  pseudoSynthesized: PseudoSynthRecord[];
  pseudoDrops: PseudoDropRecord[];
  warnings: string[];
  rawInner: Record<string, string>;
  unwrap: boolean;
  baseUrl: string | undefined;
}

/** A node is "text-bearing" for NORMALIZE purposes when it carries any text runs. */
function isTextBearing(node: IrNode): boolean {
  return node.textRuns.length > 0;
}

/**
 * True when a child of a TEXT-BEARING node is a pure INLINE-allowlist element whose text content is
 * already folded into the parent's `textRuns` (PARSE's `extractTextRuns` recurses
 * {@link PARSE_FOLDED_INLINE}, so an inline `<span>`/`<strong>`/`<mark>`/inline `<a>` inside a
 * heading/paragraph/button is BOTH a child IR node AND captured in the parent's runs). Such a child
 * MUST be DROPPED here so it is never promoted to a separate widget node — it survives only as inline
 * `html-v3` markup of the parent text widget (the load-bearing fix: a leaf text widget never gets
 * element children). It is foldable iff:
 *   (a) its tag is in `PARSE_FOLDED_INLINE` (everything `extractTextRuns` recurses — the 11 allowlist
 *       tags plus `mark`/`code`/`br`/`abbr`/`cite`; the extra 5 are stripped by `wp_kses` but their
 *       text already lives in the runs, and `computeStrippedTags` reports the strip),
 *   (b) it carries NO media (an inline `<a><img></a>` is a real image node, not inline text).
 * Block descendants nested INSIDE a foldable inline child (`<span><div>…</div></span>`) do not block
 * the drop — `normalizeNode` hoists them out via {@link collectNonInlineDescendants} before the
 * inline wrapper is folded, so no real (non-inline-text) node is ever lost.
 */
function isInlineFoldableChild(child: IrNode): boolean {
  if (!PARSE_FOLDED_INLINE.has(child.tag.toLowerCase())) return false;
  if (child.media !== undefined) return false;
  return true;
}

/**
 * Collect the REAL non-inline descendants of an inline-foldable child (depth-first, document order):
 * everything under it that is NOT itself inline-foldable (block elements, media-bearing inline
 * elements). These are the nodes whose content would be silently lost when the inline wrapper is
 * folded into the parent's `textRuns` — the caller promotes them to siblings instead.
 */
function collectNonInlineDescendants(child: IrNode): IrNode[] {
  const out: IrNode[] = [];
  for (const c of child.children) {
    if (isInlineFoldableChild(c)) {
      for (const nested of collectNonInlineDescendants(c)) out.push(nested);
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * True when a child node is a droppable WHITESPACE TEXT NODE (ticket req 3 — "drop whitespace-only text
 * nodes between block elements"). It must (a) actually carry text runs that are ALL whitespace, (b) have
 * no media, no children, and (c) carry no deliberate layout/visual style (a styled empty spacer is NOT
 * whitespace). A merely-empty element (no text at all — e.g. a promoted block container, an empty `<div>`
 * spacer) is NOT whitespace and is kept; idempotence depends on not dropping promoted empty siblings.
 */
function isWhitespaceOnly(node: IrNode): boolean {
  if (node.textRuns.length === 0) return false;
  if (node.media !== undefined) return false;
  if (node.children.length > 0) return false;
  if (hasNonDefaultStyle(node)) return false;
  return node.textRuns.every((r) => collapseWhitespace(r.text).trim().length === 0);
}

/**
 * True when a node carries a contract-16 §2 behavior-detection signal CLASSIFY reads downstream
 * (NORMALIZE runs first — `types.ts` pipeline order): an ARIA `role`/`aria-*` attr (tabs/accordion/
 * nav-toggle detection), an animation-library attr (`data-aos*`), or a PARSE runtime probe
 * (listeners / animationProbe / transitionProbe). Unwrapping such a wrapper would silently erase the
 * detection evidence — e.g. a single-child `role=tabpanel` div is exactly the panel node ARIA tabs
 * detection anchors on.
 */
function carriesBehaviorSignal(node: IrNode): boolean {
  if (node.listeners !== undefined && node.listeners.length > 0) return true;
  if (node.animationProbe !== undefined || node.transitionProbe !== undefined) return true;
  for (const name of Object.keys(node.attrs)) {
    if (name === 'role' || name.startsWith('aria-') || name.startsWith('data-aos')) return true;
  }
  return false;
}

/**
 * Try to unwrap a redundant single-child wrapper: returns the child (with merged non-conflicting
 * styles) when safe, else null. SAFE iff the wrapper is a generic `div`/`span`, has exactly one child,
 * carries no deliberate layout/visual style, no semantic tag, no media, no text, no semantic role, and
 * no behavior-detection signal (contract 16 §2 — CLASSIFY detects AFTER this stage).
 * Merge: copy the wrapper's (default-only, by construction) computed entries the child lacks — this is
 * effectively a no-op for layout props (none survived the guard) but preserves any inherited typography.
 */
function tryUnwrap(node: IrNode): IrNode | null {
  if (!isGenericWrapperTag(node.tag)) return null;
  if (SEMANTIC_TAGS.has(node.tag)) return null;
  if (node.children.length !== 1) return null;
  if (node.media !== undefined) return null;
  if (node.textRuns.length > 0) return null;
  if (!hasNoSemanticRole(node)) return null;
  if (hasNonDefaultStyle(node)) return null;
  if (carriesBehaviorSignal(node)) return null;
  // A wrapper whose ::before/::after paints (contract 17 #10) is NOT styleless — unwrapping it
  // would silently erase the pseudo capture before synthesis runs.
  const pseudoHost = node as PseudoIrNode;
  if (pseudoHost.pseudoBefore !== undefined || pseudoHost.pseudoAfter !== undefined) return null;
  const child = node.children[0];
  if (child === undefined) return null;
  // Merge: wrapper computed entries the child does not already have (non-conflicting only).
  const mergedComputed: ComputedStyleSet = { ...child.computed };
  for (const [prop, value] of Object.entries(node.computed)) {
    if (mergedComputed[prop] === undefined) {
      mergedComputed[prop] = value;
    }
  }
  return { ...child, computed: mergedComputed };
}

/**
 * Normalize one node and its subtree. Returns EXACTLY ONE node (contract 18 §7 P2-a): a text-bearing
 * host whose content spawns promoted blocks and/or synthesized pseudos is RESTRUCTURED into a
 * container holding them — they are never returned as siblings (sibling placement leaked stray
 * TOP-LEVEL nodes when the host was a forest root, and rendered an inline-flex host's `::before`
 * at its parent's top-left instead of inline, P2-b). Mutates `acc` with records.
 */
function normalizeNode(node: IrNode, acc: NormalizeAccumulator): IrNode {
  // 1. Redundant-wrapper unwrap (before recursing, so we recurse the hoisted child directly).
  if (acc.unwrap) {
    let current: IrNode = node;
    // Iteratively unwrap chains of redundant wrappers (e.g. div>div>div around one node).
    for (;;) {
      const unwrapped = tryUnwrap(current);
      if (unwrapped === null) break;
      acc.warnings.push(
        `unwrapped redundant <${current.tag}> wrapper around <${unwrapped.tag}> (${current.source_path})`,
      );
      current = unwrapped;
    }
    if (current !== node) {
      return normalizeNode(current, acc);
    }
  }

  const preserve = preservesWhitespace(node);

  // 2. Text-run normalization (entity decode + whitespace) for the node's own text.
  const normalizedRuns = isTextBearing(node)
    ? normalizeTextRuns(node.textRuns, preserve, acc.baseUrl)
    : node.textRuns;

  // 3. Stripped-tag accounting (report mirror) for text-bearing nodes.
  const nodeIsTextBearing = isTextBearing(node);
  const rawInner = nodeIsTextBearing ? acc.rawInner[node.source_path] : undefined;
  if (nodeIsTextBearing) {
    const strippedTags = rawInner !== undefined ? computeStrippedTags(rawInner) : [];
    if (strippedTags.length > 0) {
      acc.stripped.push({ source_path: node.source_path, stripped_tags: strippedTags });
    }
  }

  // 4. Recurse into children, dropping whitespace-only text nodes between blocks, FOLDING inline-allowlist
  //    children of a text node into the parent's html-v3 (they are already in `textRuns` — never a child
  //    widget), and MOVING a text node's REAL non-inline children into `promotedChildren` (a leaf text
  //    widget drops element children in ASSEMBLE — synthesizing empty husks here while the real child
  //    stayed nested was the content-loss bug). Promoted nodes are attached back INSIDE the restructured
  //    host below (P2-a) — never returned as siblings.
  const newChildren: IrNode[] = [];
  const promotedChildren: IrNode[] = [];
  for (const child of node.children) {
    if (!preserve && isWhitespaceOnly(child)) {
      continue; // drop whitespace-only node between block elements
    }
    if (nodeIsTextBearing) {
      // A leaf text node (heading/paragraph/button text) NEVER keeps an inline-allowlist element child:
      // PARSE already captured the inline text in this node's `textRuns`, and MAP serializes it back into
      // the html-v3 `content` as inline markup. But any REAL non-inline descendant nested inside the
      // inline wrapper (<span><div>…</div></span>) must be hoisted out before the wrapper is folded.
      if (isInlineFoldableChild(child)) {
        for (const hoisted of collectNonInlineDescendants(child)) {
          if (!preserve && isWhitespaceOnly(hoisted)) continue;
          promotedChildren.push(normalizeNode(hoisted, acc));
        }
        continue;
      }
      // A REAL block/media child of a text node: MOVE it out of the html-v3 content, carrying its
      // computed styles, box, attrs, text and subtree intact (CLASSIFY/MAP see the real content).
      promotedChildren.push(normalizeNode(child, acc));
      continue;
    }
    newChildren.push(normalizeNode(child, acc));
  }

  // Promotion accounting: real moved children are authoritative. ONLY when no real non-inline child
  // existed (markup the browser parser re-homed so PARSE produced no node) fall back to synthesizing
  // empty husks from the raw-inner-markup tag scan.
  if (promotedChildren.length > 0) {
    const movedTags = [...new Set(promotedChildren.map((s) => s.tag))];
    acc.promotions.push({
      from_source_path: node.source_path,
      promoted_to: promotedChildren.map((s) => s.source_path),
      reason: `block content (${movedTags.join(', ')}) moved out of html-v3 inline-only text`,
    });
  } else if (nodeIsTextBearing) {
    const outcome = planPromotion(node, rawInner);
    for (const s of outcome.promotedSiblings) promotedChildren.push(s);
    if (outcome.record !== null) {
      acc.promotions.push(outcome.record);
    }
  }

  // 4c. Pseudo-element synthesis (contract 17 #10): a REPRESENTABLE captured ::before/::after
  //     (empty-content sized box — dot, dash, accent bar) becomes a real IR node; everything else
  //     is an honest drop with reason `pseudo_unrepresentable` (I3). Placement (contract 18 §7
  //     P2-a/P2-b): ::before renders before the element's content → FIRST child of the host;
  //     ::after → LAST child. A TEXT-BEARING host is restructured into a container below, so its
  //     pseudos land inside it too (leading/trailing) — an inline/inline-flex host's ::before dash
  //     stays in the host's own layout flow instead of escaping to the parent (P2-b). The pseudo
  //     fields are CONSUMED here (the step-5 rebuild does not carry them), so a second normalize
  //     pass synthesizes nothing — idempotence.
  const pseudoHost = node as PseudoIrNode;
  const leadingChildren: IrNode[] = [];
  const trailingChildren: IrNode[] = [];
  const synthesizePseudo = (pseudo: PseudoKind, capture: ComputedStyleSet | undefined): void => {
    if (capture === undefined) return;
    const verdict = classifyPseudoCapture(capture);
    if (!verdict.representable) {
      acc.pseudoDrops.push({
        source_path: node.source_path,
        pseudo,
        content: capture['content'] ?? 'none',
        reason: 'pseudo_unrepresentable',
        detail: verdict.detail,
      });
      acc.warnings.push(
        `::${pseudo} on ${node.source_path} dropped (pseudo_unrepresentable: ${verdict.detail})`,
      );
      return;
    }
    const synth = synthesizePseudoNode(node, pseudo, capture);
    acc.pseudoSynthesized.push({
      source_path: node.source_path,
      pseudo,
      synthesized_path: synth.source_path,
    });
    if (nodeIsTextBearing) {
      (pseudo === 'before' ? leadingChildren : trailingChildren).push(synth);
    } else if (pseudo === 'before') {
      newChildren.unshift(synth);
    } else {
      newChildren.push(synth);
    }
  };
  synthesizePseudo('before', pseudoHost.pseudoBefore);
  synthesizePseudo('after', pseudoHost.pseudoAfter);

  // 5. Rebuild the node (media + attr URL resolution / entity decode). A text-bearing host with
  //    attached nodes is RESTRUCTURED (P2-a): it becomes a container — its runs move to a
  //    synthesized `::text` content leaf — and the attachments land INSIDE it at the correct index:
  //    [::before, content, …promoted blocks (document order), ::after]. This is also the source
  //    geometry (the blocks/pseudos painted inside the host's box), and it can never spill stray
  //    top-level nodes when the host is a forest root.
  const attached = leadingChildren.length + promotedChildren.length + trailingChildren.length;
  const restructure = nodeIsTextBearing && attached > 0;
  let outTag = node.tag;
  let outRuns = normalizedRuns;
  let outChildren = newChildren;
  if (restructure) {
    const content = normalizedRuns.length > 0 ? [makeTextContentNode(node, normalizedRuns)] : [];
    // CLASSIFY's tag pass would force a leaf widget for h1-6/button/li even with children — the
    // container retags to `div`; the `::text` leaf keeps the original tag (semantics survive).
    outTag = LEAF_FORCING_TAGS.has(node.tag.toLowerCase()) ? 'div' : node.tag;
    outRuns = [];
    outChildren = [...leadingChildren, ...content, ...promotedChildren, ...trailingChildren];
    acc.warnings.push(
      `restructured text-bearing <${node.tag}> (${node.source_path}) into a container — ` +
        `${attached} attached node(s) placed inside (P2-a)` +
        (content.length > 0 ? `; text carried by ${content[0]!.source_path}` : ''),
    );
  }
  const out: IrNode = {
    source_path: node.source_path,
    tag: outTag,
    role: node.role,
    box: node.box,
    computed: node.computed,
    responsive: node.responsive,
    attrs: normalizeAttrs(node.attrs, acc.baseUrl),
    textRuns: outRuns,
    children: outChildren,
  };
  if (node.hoverComputed !== undefined) out.hoverComputed = node.hoverComputed;
  if (node.focusComputed !== undefined) out.focusComputed = node.focusComputed;
  // Contract 16 §2 probe carriers (PARSE → CLASSIFY) — pure annotation carried through verbatim so
  // behavior detection (which runs AFTER normalize, in CLASSIFY) still sees the runtime probes.
  if (node.animationProbe !== undefined) out.animationProbe = node.animationProbe;
  if (node.transitionProbe !== undefined) out.transitionProbe = node.transitionProbe;
  if (node.listeners !== undefined) out.listeners = node.listeners;
  if (node.media !== undefined) {
    out.media = resolveMedia(node.media, acc.baseUrl);
  }

  return out;
}

/* ─────────────────────────── Public entry point ─────────────────────────────────────────────── */

/**
 * NORMALIZE: clean the PARSE IR forest for native authoring. Promotes block children out of `html-v3`
 * inline-only text (attaching them INSIDE the restructured host — contract 18 §7 P2-a, never as
 * top-level strays), records stripped tags + promotions honestly, collapses whitespace (respecting
 * `pre`), unwraps redundant single-child wrappers (conservative), resolves relative URLs against
 * `base_url`, and decodes HTML entities.
 *
 * PURE + deterministic + idempotent: re-running on an already-normalized tree changes nothing and
 * yields empty `stripped`/`promotions` (the second pass sees no non-allowlisted raw inner markup and
 * no whitespace to collapse). NO I/O, NO Playwright, NO WP client. The output forest never has MORE
 * roots than the input (P2-a corpus guard: converted top-level count == 1 root [+ font widget]).
 *
 * @param ir  the PARSE IR forest (`ParseResult.ir`).
 * @param ctx `{ base_url?, raw_inner_markup, unwrap_redundant }` (`raw_inner_markup` from `ParseResult`).
 */
export function normalizeIr(ir: IrNode[], ctx: NormalizeContext): NormalizeResultWithPseudo {
  const acc: NormalizeAccumulator = {
    stripped: [],
    promotions: [],
    pseudoSynthesized: [],
    pseudoDrops: [],
    warnings: [],
    rawInner: ctx.raw_inner_markup,
    unwrap: ctx.unwrap_redundant,
    baseUrl: ctx.base_url,
  };

  const roots: IrNode[] = [];
  for (const node of ir) {
    if (!isWhitespaceOnly(node)) {
      roots.push(normalizeNode(node, acc));
    }
  }

  return {
    ir: roots,
    stripped: acc.stripped,
    promotions: acc.promotions,
    warnings: acc.warnings,
    pseudo_synthesized: acc.pseudoSynthesized,
    pseudo_drops: acc.pseudoDrops,
  };
}
