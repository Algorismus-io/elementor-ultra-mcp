/**
 * WP-H07 — STYLE-EXTRACT stage (impl of `extractStyles`, frozen seam `convert/types.ts`, WP-H01).
 *
 * The FIFTH HTML→native conversion stage (RESEARCH.md §6.3/§6.4, SUPPLEMENT §B.3/§C, authoring-contract
 * §5/§9): translate each mapped node's computed declaration set into atomic style VARIANTS
 * (`StyleDefinition`/`StyleVariant`, WP-F03) using ONLY `Style_Schema`-valid prop keys, with
 * direction-aware physical→logical conversion (WP-H02), per-breakpoint and per-state variants, and a
 * per-declaration fallback ladder (authoring-contract §9) for anything outside the schema.
 *
 * For each node it:
 *   1. groups the captured declarations by (breakpoint, state) — base/hover/focus + per-breakpoint
 *      deltas (state lives on `meta`, never on a prop; valid states = style-variant.schema.json),
 *   2. classifies every declaration via {@link classifyDeclaration} against the LIVE `style_schema`,
 *   3. relocates logical box props (`padding`/`margin`/`border-radius`/`border-width`/inset/
 *      `text-align`) via WP-H02 with the resolved direction (preserve VISUAL intent),
 *   4. builds one `StyleVariant` per non-empty (breakpoint, state) pair → a single local
 *      `StyleDefinition` with a PLACEHOLDER id (WP-H08 finalizes the `e-<elementId>-<7hex>` form and
 *      mirrors it into `settings.classes`, authoring-contract §5.1),
 *   5. records a {@link DeclFallback} for every unmappable/decomposition-failed declaration (tier in
 *      §9 priority; `custom_css` only when `ctx.pro_active` — then ALSO materialized into the
 *      variant's base64 `custom_css.raw` so it actually renders — else recorded as DROPPED under the
 *      `html_widget` tier, which coverage buckets as `dropped`), and
 *   6. flags literal colors / font stacks / recurring sizes into `proposed_variable_literals` for
 *      WP-H09 variable extraction (this stage only FLAGS).
 *
 * PURE module: deterministic given `(nodes, ctx)`, NO I/O, NO Playwright, NO WP client. The live
 * `style_schema` is passed IN by the orchestrator (this stage never fetches it). The produced styles
 * only RENDER after prime-css (WP-P05 `Css_Primer` / WP-S01), which the orchestrator (WP-H11) runs
 * after save — this WP makes NO claim that CSS is rendered. PHP `dry_run` (WP-P03) is authoritative.
 *
 * Owns ONLY `extractStyles` + local helpers; `StyleContext`/`StyleExtractResult`/`StyledNode`/
 * `DeclFallback`/`LiteralRef`/`MappedNode`/`StyleSchema`/`DeclIndex` are FROZEN in WP-H01 (`types.ts`);
 * `StyleDefinition`/`StyleVariant`/`StyleMeta`/`TypedValue` + envelope constructors are FROZEN in
 * WP-F03. None are redeclared here.
 */

import type { StyleDefinition, StyleVariant, TypedValue } from '../authoring/contract.js';
import { sizeValue, typedValue } from '../authoring/envelopes.js';
import {
  resolveDimensions,
  resolveBorderRadius,
  resolveBorderWidth,
  resolveInset,
  resolveLogicalKeyword,
  canCollapseToLogical,
  type Direction,
  type PhysicalBox,
  type PhysicalCorners,
  type SizeValue,
} from './logical-props.js';
import { classifyDeclaration, isComputedDefaultNoise } from './declaration-classifier.js';
import type {
  BreakpointKey,
  BreakpointSpec,
  ComputedStyleSet,
  DeclFallback,
  DeclIndex,
  IrNode,
  LiteralRef,
  MappedNode,
  StyleContext,
  StyleExtractResult,
  StyledNode,
} from './types.js';

/* ─────────────────────────── state / breakpoint grouping keys ───────────────────────────────── */

/** Style-variant states this stage emits from captured pseudo-state declarations. */
type EmittedState = 'hover' | 'focus' | null;

/** A grouped declaration bucket: the (breakpoint, state) selector + its raw declarations. */
interface DeclGroup {
  breakpoint: BreakpointKey;
  state: EmittedState;
  /** A stable `state|breakpoint` key for the `DeclIndex` (e.g. `'desktop'`, `'hover'`). */
  indexKey: string;
  decls: Array<{ prop: string; value: string }>;
}

/* ─────────────────────────── physical-box collection (for WP-H02) ───────────────────────────── */

/** Physical edges parsed from longhand props, for one box family (padding/margin/inset). */
function collectPhysicalBox(
  decls: Map<string, string>,
  longhands: { top: string; right: string; bottom: string; left: string },
): { box: PhysicalBox; consumed: string[] } {
  const box: PhysicalBox = {};
  const consumed: string[] = [];
  const top = decls.get(longhands.top);
  const right = decls.get(longhands.right);
  const bottom = decls.get(longhands.bottom);
  const left = decls.get(longhands.left);
  if (top !== undefined) {
    box.top = top;
    consumed.push(longhands.top);
  }
  if (right !== undefined) {
    box.right = right;
    consumed.push(longhands.right);
  }
  if (bottom !== undefined) {
    box.bottom = bottom;
    consumed.push(longhands.bottom);
  }
  if (left !== undefined) {
    box.left = left;
    consumed.push(longhands.left);
  }
  return { box, consumed };
}

/** Expand a `top right bottom left` (1–4 token) shorthand into the four physical edges. */
export function expandBoxShorthand(value: string): PhysicalBox {
  const t = value
    .trim()
    .split(/\s+/)
    .filter((x) => x.length > 0);
  if (t.length === 0) {
    return {};
  }
  const top = t[0] as string;
  const right = t[1] ?? top;
  const bottom = t[2] ?? top;
  const left = t[3] ?? right;
  return { top, right, bottom, left };
}

/** Expand the `border-radius` shorthand (1–4 tokens, ignoring the `/` elliptical form) to corners. */
export function expandRadiusShorthand(value: string): PhysicalCorners {
  // Drop the elliptical second group (`a b c d / e f g h`) — keep the first.
  const head = value.split('/')[0] ?? value;
  const t = head
    .trim()
    .split(/\s+/)
    .filter((x) => x.length > 0);
  if (t.length === 0) {
    return {};
  }
  const tl = t[0] as string;
  const tr = t[1] ?? tl;
  const br = t[2] ?? tl;
  const bl = t[3] ?? tr;
  return { 'top-left': tl, 'top-right': tr, 'bottom-right': br, 'bottom-left': bl };
}

/* ─────────────────────────── SizeValue → typed `size` envelope ──────────────────────────────── */

/** Wrap a raw WP-H02 `SizeValue` into a `{$$type:'size'}` envelope. */
function wrapSize(sv: SizeValue): TypedValue {
  return sizeValue(sv.size, sv.unit);
}

/** True for a non-null, non-array plain object (used to merge two `background` value objects). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Wrap a logical edge map (block-start/inline-end/...) into the nested `size` envelopes. */
function wrapEdgeMap(edges: Record<string, SizeValue | undefined>): Record<string, TypedValue> {
  const out: Record<string, TypedValue> = {};
  for (const [k, v] of Object.entries(edges)) {
    if (v !== undefined) {
      out[k] = wrapSize(v);
    }
  }
  return out;
}

/* ─────────────────────────── breakpoint key resolution (never hardcoded) ────────────────────── */

/**
 * Resolve a responsive computed-style key to a variant breakpoint key using the live `ctx.breakpoints`
 * (RESEARCH.md §6.7 — never hardcode px). The IR `responsive` map is already keyed by breakpoint key
 * strings; we accept a key only when it is in the active set, else fall back to the raw key (PHP is
 * authoritative on the live set).
 */
function resolveBreakpointKey(rawKey: string, breakpoints: BreakpointSpec[]): BreakpointKey {
  const match = breakpoints.find((b) => String(b.key) === rawKey);
  return match !== undefined ? match.key : rawKey;
}

/* ─────────────────────────── painted widget base defaults (contract 17 — I2 / #8) ───────────── */

/**
 * Widgets whose BASE styles PAINT (contract `17-conversion-integrity.md` I2): for the listed props,
 * the widget renders something visible even with no authored styles, so a source value that merely
 * LOOKS like a browser default (transparent background, zero padding/radius, `flex-direction:row`)
 * is a REAL override and MUST be emitted explicitly — "skip as no-op" is legal ONLY against a
 * transparent/neutral base. Keyed by the MAP target (`target.widgetType ?? target.elType`); the prop
 * names are the BASE-DEFAULT KEYS `baseDefaultKeyFor` resolves declaration props to.
 *
 * Kept consistent with the `integrity.ts` BASE_DEFAULTS table (the I2 pre-save check): e-button =
 * blue fill + padding + radius; e-flexbox = 10px padding + column direction; e-div-block = 10px
 * padding; e-svg = 50x50.
 */
export const PAINTED_BASE_DEFAULT_PROPS: Readonly<Record<string, ReadonlySet<string>>> = {
  'e-button': new Set(['background', 'padding', 'border-radius']),
  'e-flexbox': new Set(['padding', 'flex-direction']),
  'e-div-block': new Set(['padding']),
  'e-svg': new Set(['width', 'height']),
};

/** The empty exemption set for widgets with a fully neutral base (everything else). */
const NO_PAINTED_DEFAULTS: ReadonlySet<string> = new Set();

/**
 * Atomic text widgets whose `textRuns` MAP folds into html-v3 content (`title`/`paragraph`/`text`)
 * — the hosts whose folded in-text `<a href>` runs get the P2-e underline carry (contract 18 §7).
 * Classic (V3) targets are deliberately absent: classic nodes carry no local-styles map, so a
 * nested custom_css rule would silently vanish — claiming preservation there would be a lie.
 */
const HTML_V3_FOLDING_WIDGETS: ReadonlySet<string> = new Set([
  'e-heading',
  'e-paragraph',
  'e-button',
  'e-form-submit-button',
]);

/** Resolve a node's painted base-default exemption set from its MAP target. */
function paintedDefaultsFor(node: MappedNode): ReadonlySet<string> {
  const key = node.target.widgetType ?? node.target.elType;
  return PAINTED_BASE_DEFAULT_PROPS[key] ?? NO_PAINTED_DEFAULTS;
}

/**
 * Map a declaration prop to the base-default key the I2 table speaks (the FILL-carrying
 * `background` longhands answer to the widget's `background` fill; box-family longhands to their
 * family). The non-fill background RIDERS (`background-size`/`-position`/`-repeat`/…) deliberately
 * map to THEMSELVES: a default-valued rider cannot override a painted base fill, so exempting it
 * from the I4 noise filter only leaks `background-size: auto` rows into the tier ledger (the exact
 * violation `auditI4` flags).
 */
function baseDefaultKeyFor(prop: string): string {
  if (prop === 'background' || prop === 'background-color' || prop === 'background-image') {
    return 'background';
  }
  if (prop.startsWith('padding')) {
    return 'padding';
  }
  if (prop.startsWith('margin')) {
    return 'margin';
  }
  if (prop === 'border-radius' || /^border-.+-radius$/.test(prop)) {
    return 'border-radius';
  }
  if (prop === 'border-width' || /^border-.+-width$/.test(prop)) {
    return 'border-width';
  }
  return prop;
}

/* ─────────────────────────── computed-default noise filter (contract 17 — I4) ────────────────── */

/**
 * The synthetic `source_path` of the ONE summary `DeclFallback` record this stage emits when the I4
 * noise filter excluded computed-default declarations. The record carries the filtered COUNT in its
 * reason (no silent drops — contract 17 §0); `buildCoverageReport` (WP-H10) recognizes this path,
 * EXCLUDES the record from tier accounting (the whole point of I4), and surfaces it in the
 * `fallbacks[]` rollup so the report stays honest about what was filtered.
 */
export const NOISE_FILTER_SOURCE_PATH = '__i4_noise_filter__';

/** Every token of the value is a zero length (`0`, `0px`, `0%`, …) — a zero-effect box value. */
const ZERO_LEN_RE = /^0(?:\.0+)?(?:px|%|em|rem|vw|vh|pt)?$/i;
function isZeroBoxValue(value: string): boolean {
  const tokens = value.trim().split(/\s+/);
  return tokens.length > 0 && tokens.every((t) => ZERO_LEN_RE.test(t));
}

/**
 * Box families whose ALL-ZERO computed pick is noise (`getComputedStyle` reports `0px` per edge on
 * every unstyled element). Filtered as a FAMILY: a partially-zero box (e.g. `0 auto` margins) is
 * authored and kept whole.
 */
const ZERO_NOISE_BOX_FAMILIES: ReadonlyArray<{ key: string; props: readonly string[] }> = [
  {
    key: 'padding',
    props: ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  },
  {
    key: 'margin',
    props: ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  },
  {
    key: 'border-radius',
    props: [
      'border-radius',
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
    ],
  },
  {
    key: 'border-width',
    props: [
      'border-width',
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
    ],
  },
];

/** Zero-width borders paint nothing — their style/color carriers are zero-effect riders. */
const BORDER_RIDER_PROPS: readonly string[] = ['border-style', 'border-top-style', 'border-color'];

/**
 * I4 — strip computed-default noise from a BASE declaration group BEFORE classification/tier
 * accounting. Two passes: (1) the per-declaration `isComputedDefaultNoise` table, (2) all-zero box
 * FAMILIES (padding/margin/radius/border-width — plus the style/color riders of a zero border).
 * Props in the widget's PAINTED base-default set (I2) are exempt — a "default-looking" value there
 * is a real override the per-decl loop must emit. Deleted props are marked `consumed` so the
 * per-declaration loop skips them. Returns the filtered count (reported, never silent).
 */
function filterComputedDefaultNoise(
  declMap: Map<string, string>,
  baseDefaults: ReadonlySet<string>,
  consumed: Set<string>,
): number {
  let filtered = 0;
  const drop = (prop: string): void => {
    declMap.delete(prop);
    consumed.add(prop);
    filtered += 1;
  };

  // Outline: with `outline-style:none` (the browser default on every element) the computed
  // `outline-width` is STILL the UA default `medium` → `3px` — width/color are zero-effect riders.
  // Resolved BEFORE the table pass deletes the `none` style itself.
  const outlineStyle = declMap.get('outline-style');
  const outlineIsNone = outlineStyle === undefined || outlineStyle.trim().toLowerCase() === 'none';

  for (const [prop, value] of [...declMap.entries()]) {
    if (!isComputedDefaultNoise(prop, value)) {
      continue;
    }
    if (baseDefaults.has(baseDefaultKeyFor(prop))) {
      continue; // I2 — painted base default; the explicit override must survive to emission
    }
    drop(prop);
  }

  for (const family of ZERO_NOISE_BOX_FAMILIES) {
    if (baseDefaults.has(family.key)) {
      continue; // I2 — e.g. zero padding on e-button/e-flexbox overrides the painted default
    }
    const present = family.props.filter((p) => declMap.has(p));
    if (present.length === 0) {
      continue;
    }
    if (!present.every((p) => isZeroBoxValue(declMap.get(p) as string))) {
      continue;
    }
    for (const p of present) {
      drop(p);
    }
    if (family.key === 'border-width') {
      for (const rider of BORDER_RIDER_PROPS) {
        if (declMap.has(rider)) {
          drop(rider);
        }
      }
    }
  }

  if (outlineIsNone) {
    for (const rider of ['outline-width', 'outline-color']) {
      if (declMap.has(rider)) {
        drop(rider);
      }
    }
  }

  return filtered;
}

/* ─────────────────────────── responsive width policy (contract 17 — #7 / V2) ─────────────────── */

/** A plain px length (`getComputedStyle` always resolves `width` to one). */
const PX_LEN_RE = /^-?(?:\d*\.\d+|\d+)px$/;

/** Parse a px length to its number, or null. */
function parsePx(value: string | undefined): number | null {
  if (value === undefined || !PX_LEN_RE.test(value.trim())) {
    return null;
  }
  return Number.parseFloat(value.trim());
}

/**
 * A FRACTIONAL used px value is layout-derived: authored CSS px widths are (essentially always)
 * integers, while `fr` tracks, percentages and flex-resolved widths come back from
 * `getComputedStyle` with sub-pixel fractions (`533.391px` — the test.html hero grid columns).
 */
function isLayoutDerivedPx(px: number): boolean {
  return Math.abs(px - Math.round(px)) > 0.001;
}

/** A parent's CONTENT width (border-box rect minus computed horizontal padding). */
function contentWidthOf(parent: MappedNode): number {
  const pl = parsePx(parent.computed['padding-left']) ?? 0;
  const pr = parsePx(parent.computed['padding-right']) ?? 0;
  return parent.box.width - pl - pr;
}

/**
 * Does this node's computed `width` TRACK its container (contract 17 #7 / V2)? `getComputedStyle`
 * resolves `width` to the USED px value, so a fluid box (auto/100%/max-width container/grid track)
 * is indistinguishable from an authored fixed width by the base capture alone. Three signals:
 *   1. A fractional (layout-derived) used px at base or any breakpoint — `fr`/%/flex resolution.
 *   2. The per-breakpoint deltas (parse already captures them): a width that SHRINKS at narrower
 *      viewports (and never grows) is reflowing with the container. A width that GROWS at a
 *      narrower viewport is an authored media-query override → NOT fluid here; the breakpoint
 *      branch of the width policy decides whether that override is itself viewport-tracking.
 *   3. The base box geometry: a box filling ≥98% of its parent's CONTENT width tracks the container.
 * Baking such widths as fixed px broke every conversion at 390 (scrollWidth > viewport).
 */
function widthIsFluid(node: MappedNode, parent: MappedNode | null): boolean {
  const baseWidth = parsePx(node.computed['width']);
  if (baseWidth !== null && isLayoutDerivedPx(baseWidth)) {
    return true;
  }
  let sawDelta = false;
  let grew = false;
  for (const set of Object.values(node.responsive)) {
    const w = (set as Partial<ComputedStyleSet> | undefined)?.['width'];
    if (w === undefined) {
      continue;
    }
    sawDelta = true;
    const bpWidth = parsePx(w);
    if (bpWidth !== null && isLayoutDerivedPx(bpWidth)) {
      return true;
    }
    if (baseWidth === null || bpWidth === null || bpWidth >= baseWidth) {
      grew = true; // grew (or unparseable) at a narrower viewport → authored override
    }
  }
  if (sawDelta && !grew) {
    return true;
  }
  if (parent !== null) {
    const pw = contentWidthOf(parent);
    if (pw > 0 && node.box.width >= pw * 0.98) {
      return true;
    }
  }
  return false;
}

/**
 * A CONTENT-SIZED container child of a flex ROW (contract 17 #7 / I2): the source box does not
 * span its parent's content width, so its width is shrink-to-fit (`width:auto` as a flex item) —
 * but Elementor containers PAINT `width:100%` as their base (`.e-con{--width:100%}`), so leaving
 * width unemitted makes the child fill the row and WRAP under its siblings (page 2537: the footer
 * brand/link-columns row stacked vertically, +640px page height; same class as the header nav).
 * Such a child must carry an explicit `width:auto`. Widget children (e-heading/e-paragraph/…)
 * paint no base width and shrink-to-fit natively — only containers are affected.
 */
function isContentSizedRowChild(node: MappedNode, parent: MappedNode | null): boolean {
  if (parent === null || !node.target.is_container) {
    return false;
  }
  const display = (parent.computed['display'] ?? '').trim().toLowerCase();
  if (display !== 'flex' && display !== 'inline-flex') {
    return false;
  }
  const direction = (parent.computed['flex-direction'] ?? 'row').trim().toLowerCase();
  if (direction !== 'row' && direction !== 'row-reverse' && direction !== '') {
    return false;
  }
  const pw = contentWidthOf(parent);
  return pw > 0 && node.box.width < pw * 0.98;
}

/**
 * A flex container that SPREADS its children (`justify-content: space-between|around|evenly`) is
 * meaningless at shrink-to-fit width — the spacing only distributes when the container FILLS its
 * row. `getComputedStyle` resolves such a bar's `width` to its CONTENT used-px at capture (a
 * space-between header whose logo+nav+icons measure 413px), and the content-sized-row-child rule
 * above would then pin `width:auto` (shrink-to-fit). Both bake the capture content width, so the
 * bar LEFT-HUGS at any viewport wider than capture (the allbirds nav sat 413px-left at 1920 while
 * the source spreads edge-to-edge). Such a container must fill its row (`width:100%`) so its own
 * `justify-content` spreads the children across the real viewport. Only containers spread; a
 * genuinely content-packed row (`justify-content:flex-start|center`) keeps shrink-to-fit.
 */
function isSpreadRowContainer(node: MappedNode): boolean {
  if (!node.target.is_container) {
    return false;
  }
  const display = (node.computed['display'] ?? '').trim().toLowerCase();
  if (display !== 'flex' && display !== 'inline-flex') {
    return false;
  }
  const direction = (node.computed['flex-direction'] ?? 'row').trim().toLowerCase();
  if (direction !== 'row' && direction !== 'row-reverse' && direction !== '') {
    return false;
  }
  const justify = (node.computed['justify-content'] ?? '').trim().toLowerCase();
  return justify === 'space-between' || justify === 'space-around' || justify === 'space-evenly';
}

/**
 * The CENTERED-BLOCK margin signature (contract 17 #7): `max-width:… ; margin-inline:auto` is THE
 * centered-container pattern (`.wrap`), but `getComputedStyle` resolves the `auto` to the
 * CAPTURE-viewport px (80px at a 1280 capture for a 1120 wrap) — baking that px pins every
 * section's wrap off-center at any OTHER viewport (page 2584: the whole page sat 70px left of
 * center at 1440). Equal nonzero left/right margins alongside a declared max-width restore the
 * `auto` intent; the per-breakpoint margin deltas are the same reflow echoed at other capture
 * widths and are consumed as noise.
 */
function hasCenteredMarginSignature(node: MappedNode): boolean {
  const maxW = (node.computed['max-width'] ?? '').trim().toLowerCase();
  if (maxW === '' || maxW === 'none') {
    return false;
  }
  const ml = parsePx(node.computed['margin-left']);
  const mr = parsePx(node.computed['margin-right']);
  return ml !== null && mr !== null && ml > 0 && ml === mr;
}

/* ─────────────────────────── responsive grid-track policy (contract 18 §7 — P1-b) ────────────── */

/**
 * Parse a RESOLVED computed `grid-template-columns` track list (`352.5px 352.5px 352.5px` — what
 * `getComputedStyle` reports for a laid-out grid, regardless of the authored `repeat(3, 1fr)`) into
 * px numbers. Returns `null` for anything that is not a pure positive px list (authored keyword/fr/
 * minmax values pass through the generic free-string path verbatim — they are already fluid intent).
 */
function parseGridPxTracks(value: string): number[] | null {
  const tokens = value
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  const out: number[] = [];
  for (const tok of tokens) {
    const px = parsePx(tok);
    if (px === null || px <= 0) {
      return null;
    }
    out.push(px);
  }
  return out;
}

/**
 * Convert a resolved px track list back to RATIO-PRESERVING fluid tracks. `minmax(0, <r>fr)` (not
 * bare `<r>fr` = `minmax(auto, <r>fr)`) so a long word can never push a track past its share —
 * the whole point is the scrollWidth==viewport guarantee. Equal tracks collapse to
 * `repeat(n, minmax(0, 1fr))`; ratios snap to 0.05 steps so the fr list stays human-readable.
 */
function gridTracksToFr(tracks: number[]): string {
  const min = Math.min(...tracks);
  if (min <= 0) {
    return tracks.length === 1
      ? 'minmax(0, 1fr)'
      : `repeat(${String(tracks.length)}, minmax(0, 1fr))`;
  }
  const ratios = tracks.map((t) => Math.max(0.05, Math.round((t / min) * 20) / 20));
  const allEqual = ratios.every((r) => Math.abs(r - (ratios[0] as number)) <= 0.05);
  if (allEqual) {
    return tracks.length === 1
      ? 'minmax(0, 1fr)'
      : `repeat(${String(tracks.length)}, minmax(0, 1fr))`;
  }
  return ratios.map((r) => `minmax(0, ${String(r)}fr)`).join(' ');
}

/**
 * Does this node's BASE `grid-template-columns` track its container (contract 18 §7 P1-b)?
 * `getComputedStyle` resolves grid tracks to USED px (`repeat(3, 1fr)` → `352.5px 352.5px
 * 352.5px`), so baking the base verbatim pins the capture-viewport geometry — and baking a
 * BREAKPOINT delta verbatim is worse: a grid-only `@media` collapse to `1fr` resolves to ~the
 * capture width (735px at the 767 capture) and overflows every narrower real viewport (Driftwell:
 * 743px scrollWidth @390). Two fluid signals, mirroring {@link widthIsFluid}:
 *   1. any track is layout-derived (fractional px — fr/% resolution),
 *   2. the tracks (+ column gaps) fill ≥97% of the node's own content width — fr/percent/stretch
 *      tracks fill by construction; an authored px list that happens to fill renders identically
 *      after the ratio-preserving fr conversion at the capture width and BETTER everywhere else.
 */
function gridTracksAreFluid(node: MappedNode): boolean {
  const tracks = parseGridPxTracks(node.computed['grid-template-columns'] ?? '');
  if (tracks === null) {
    return false;
  }
  if (tracks.some(isLayoutDerivedPx)) {
    return true;
  }
  const gap = parsePx(node.computed['column-gap']) ?? 0;
  const span = tracks.reduce((a, b) => a + b, 0) + gap * Math.max(0, tracks.length - 1);
  const cw = contentWidthOf(node);
  return cw > 0 && span >= cw * 0.97;
}

/** The per-node width/content policy `styleNode` resolves once and threads into every group. */
interface NodeStylePolicy {
  /** The node carries content (children or text) — it must be able to reflow (height/width policy). */
  contentBearing: boolean;
  /** The node's computed width tracks the container (see {@link widthIsFluid}). */
  widthFluid: boolean;
  /** Content-sized flex-row container child — must carry `width:auto` ({@link isContentSizedRowChild}). */
  flexRowAutoWidth: boolean;
  /** A spread (`justify-content:space-*`) flex-row container — must fill its row (`width:100%`) so
   *  the spacing distributes instead of left-hugging at wide viewports ({@link isSpreadRowContainer}). */
  spreadRowFill: boolean;
  /** Centered-block margins — restore `auto` ({@link hasCenteredMarginSignature}). */
  centeredMargins: boolean;
  /** The node's resolved grid tracks track the container ({@link gridTracksAreFluid}, P1-b). */
  gridFluid: boolean;
  /** The widget's painted base-default exemption set (I2). */
  baseDefaults: ReadonlySet<string>;
}

/* ─────────────────────────── per-node declaration grouping ──────────────────────────────────── */

/** Build the (breakpoint, state) declaration groups for a node from its computed/state/responsive maps. */
function groupDeclarations(node: IrNode, breakpoints: BreakpointSpec[]): DeclGroup[] {
  const groups: DeclGroup[] = [];

  const toPairs = (
    set: Partial<ComputedStyleSet> | undefined,
  ): Array<{ prop: string; value: string }> =>
    set === undefined
      ? []
      : Object.entries(set)
          .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
          .map(([prop, value]) => ({ prop, value: value as string }));

  // Base (desktop / null breakpoint).
  const base = toPairs(node.computed);
  if (base.length > 0) {
    groups.push({ breakpoint: null, state: null, indexKey: 'base', decls: base });
  }

  // Hover.
  const hover = toPairs(node.hoverComputed);
  if (hover.length > 0) {
    groups.push({ breakpoint: null, state: 'hover', indexKey: 'hover', decls: hover });
  }

  // Focus (captured into `focusComputed`; mapped to the `focus` state).
  const focus = toPairs(node.focusComputed);
  if (focus.length > 0) {
    groups.push({ breakpoint: null, state: 'focus', indexKey: 'focus', decls: focus });
  }

  // Per-breakpoint deltas (state:null at the resolved breakpoint key).
  for (const [rawKey, set] of Object.entries(node.responsive)) {
    const pairs = toPairs(set);
    if (pairs.length === 0) {
      continue;
    }
    const bp = resolveBreakpointKey(rawKey, breakpoints);
    groups.push({ breakpoint: bp, state: null, indexKey: String(bp), decls: pairs });
  }

  return groups;
}

/* ─────────────────────────── literal flagging (WP-H09 candidates) ───────────────────────────── */

/** Accumulate a literal occurrence (color/font/size) keyed by value, for variable extraction. */
function flagLiteral(
  acc: Map<string, LiteralRef>,
  kind: LiteralRef['kind'],
  value: string,
  sourcePath: string,
): void {
  const norm = value.trim();
  const key = `${kind}:${norm.toLowerCase()}`;
  const existing = acc.get(key);
  if (existing === undefined) {
    acc.set(key, { kind, value: norm, occurrences: [sourcePath] });
  } else {
    existing.occurrences.push(sourcePath);
  }
}

/* ─────────────────────────── per-group variant building ─────────────────────────────────────── */

/** Result of extracting one (breakpoint, state) group: a variant (or null) + fallbacks + literals. */
interface GroupExtract {
  variant: StyleVariant | null;
  fallbacks: DeclFallback[];
  rawDecls: Array<{ prop: string; value: string }>;
  /** I4 — computed-default no-op declarations excluded BEFORE tier accounting (counted, never silent). */
  noiseFiltered: number;
}

/**
 * Extract one declaration group into a single `StyleVariant`. Logical box families are collapsed via
 * WP-H02 (direction-aware); remaining declarations are classified individually. Unmappable/failed
 * declarations are recorded as `DeclFallback`s (custom_css only when Pro is active, else dropped).
 */
function extractGroup(
  node: MappedNode,
  group: DeclGroup,
  ctx: StyleContext,
  dir: Direction,
  literals: Map<string, LiteralRef>,
  policy: NodeStylePolicy,
): GroupExtract {
  const props: Record<string, TypedValue> = {};
  const fallbacks: DeclFallback[] = [];
  const customCssDecls: string[] = [];
  const declMap = new Map<string, string>(group.decls.map((d) => [d.prop.toLowerCase(), d.value]));
  const isBaseGroup = group.breakpoint === null && group.state === null;
  let noiseFiltered = 0;

  // The set of longhand/shorthand keys consumed by box-family handling (skip in the per-decl loop).
  const consumed = new Set<string>();

  const recordFallback = (
    prop: string,
    value: string,
    baseTier: DeclFallback['tier'],
    reason: string,
  ): void => {
    let tier = baseTier;
    let finalReason = reason;
    if (baseTier === 'custom_css') {
      // Computed no-ops (`background-image: none`, transparent backgrounds) lose nothing — recording
      // them as a fallback (or worse, a drop) would just add noise to the report + gate math. They
      // are COUNTED into the I4 noise-filter summary record (contract 17 §0: never silent).
      if (reason.includes('(no-op)')) {
        noiseFiltered += 1;
        return;
      }
      if (ctx.pro_active) {
        // §9 custom_css tier: actually MATERIALIZE the declaration into this variant's `custom_css`
        // (base64 raw — `Styles_Renderer::custom_css_to_css_string` base64-DECODES it). Before this,
        // the tier was recorded but the value was never written anywhere, so every custom_css-routed
        // declaration silently vanished from the page while coverage counted it as preserved.
        customCssDecls.push(`${prop}: ${value};`);
        finalReason = `${reason}; preserved in variant custom_css`;
      } else {
        // No Pro → no custom_css channel: the declaration is genuinely DROPPED. Record it under the
        // tier that buckets to DROPPED in coverage (`html_widget` — the frozen DeclFallback vocabulary
        // has no per-declaration 'dropped' member), NEVER 'native': that counted every drop as covered
        // (inflating pct_native exactly when fidelity is worst) and hid it from the fallback rollup.
        tier = 'html_widget';
        finalReason = `${reason}; DROPPED (Pro inactive, no custom_css)`;
      }
    }
    fallbacks.push({
      source_path: node.source_path,
      declaration: `${prop}: ${value}`,
      tier,
      reason: finalReason,
    });
  };

  // ── I4 noise pre-pass (BASE group ONLY — a state/breakpoint DELTA is a change, never noise) ────
  // Computed-default no-ops are excluded BEFORE classification/tier accounting so the coverage
  // percentages reflect real loss only; the count is carried into the stage's summary record.
  // Props in the widget's painted base-default set (I2/#8) are exempt and flow on to emission.
  if (isBaseGroup) {
    noiseFiltered += filterComputedDefaultNoise(declMap, policy.baseDefaults, consumed);
  }

  // ── #7 centered-block margins: restore the `auto` the capture resolved away ────────────────────
  // (see {@link hasCenteredMarginSignature}); breakpoint margin deltas on a centered node are the
  // same reflow echoed at another capture width — consumed and counted, never baked.
  if (policy.centeredMargins) {
    if (isBaseGroup) {
      declMap.set('margin-left', 'auto');
      declMap.set('margin-right', 'auto');
    } else if (group.state === null) {
      const ml = declMap.get('margin-left');
      const mr = declMap.get('margin-right');
      for (const [edge, v] of [
        ['margin-left', ml],
        ['margin-right', mr],
      ] as const) {
        if (v !== undefined && PX_LEN_RE.test(v.trim())) {
          declMap.delete(edge);
          consumed.add(edge);
          noiseFiltered += 1;
        }
      }
    }
  }

  // ── box families via WP-H02 (padding/margin = dimensions; inset; border-radius/-width) ─────────
  handlePadding(declMap, dir, ctx, props, consumed, recordFallback);
  handleMargin(declMap, dir, ctx, props, consumed, recordFallback);
  handleInset(declMap, dir, props, consumed);
  handleBorderRadius(declMap, dir, props, consumed);
  handleBorderWidth(declMap, dir, props, consumed);
  handleFlex(declMap, props, consumed);

  // ── remaining declarations, one at a time ──────────────────────────────────────────────────
  for (const { prop, value } of group.decls) {
    const propName = prop.toLowerCase();
    if (consumed.has(propName)) {
      continue;
    }
    // I2/#8 — a transparent background on a widget whose base PAINTS a fill (e-button's blue) is a
    // real override, not a no-op: emit the explicit transparent color so the base default cannot
    // paint through (the ghost-buttons-turn-blue class). Applies to every group (a hover delta to
    // transparent is just as load-bearing). Merged like the normal background path so a gradient
    // overlay in the same group survives.
    if (
      (propName === 'background' || propName === 'background-color') &&
      policy.baseDefaults.has('background') &&
      isComputedDefaultNoise(propName, value)
    ) {
      const explicit: Record<string, unknown> = { color: typedValue('color', value.trim()) };
      const existing = props['background'];
      props['background'] = {
        $$type: 'background',
        value:
          existing !== undefined && isPlainObject((existing as { value?: unknown }).value)
            ? { ...(existing as { value: Record<string, unknown> }).value, ...explicit }
            : explicit,
      } as TypedValue;
      continue;
    }
    // #7 — responsive width policy: a resolved px `width` on a content-bearing box must not be
    // baked when it is only correct at the capture viewport (the broken-mobile-widths class).
    //   - FLUID box, base group: prefer `max-width:100%` (unless the source carries its own
    //     max-width constraint, which the generic loop emits).
    //   - FLUID box, breakpoint group: the delta px is the same reflow echoed at another viewport —
    //     excluded and counted; the base policy already lets the box track the container.
    //   - FIXED box, breakpoint group: an override that is layout-derived (fractional px) or fills
    //     ~the capture viewport is the collapse-to-full-width media-query pattern (`width:100%` at
    //     mobile resolves to ~viewport px) — emit `width:100%` so it overrides the kept base width
    //     at EVERY narrower viewport, not just the captured one. A genuinely authored breakpoint px
    //     (e.g. 250px at mobile) falls through and is kept.
    if (
      propName === 'width' &&
      group.state === null &&
      policy.contentBearing &&
      PX_LEN_RE.test(value.trim())
    ) {
      // A spread flex row (justify-content:space-*) must FILL its row so the spacing
      // distributes across the real viewport; the capture used-px pins it to its content
      // width and LEFT-HUGS at any wider viewport (see {@link isSpreadRowContainer}). This
      // overrides both the fluid (max-width:100%) and content-sized-row-child (width:auto)
      // branches below — a shrink-to-fit space-between bar is always wrong.
      if (policy.spreadRowFill && isBaseGroup) {
        consumed.add('width');
        props['width'] = sizeValue(100, '%');
        continue;
      }
      if (policy.widthFluid) {
        consumed.add('width');
        if (isBaseGroup) {
          // A content-sized flex-row container child is fluid via its CONTENT, not the container:
          // emit an explicit `width:auto` so the e-con `width:100%` base cannot fill the row and
          // wrap it under its siblings (see {@link isContentSizedRowChild}).
          if (policy.flexRowAutoWidth && 'width' in ctx.style_schema) {
            props['width'] = sizeValue(null, 'auto');
          }
          const declaredMax = declMap.get('max-width');
          const hasExplicitMax =
            declaredMax !== undefined &&
            declaredMax.trim() !== '' &&
            declaredMax.trim().toLowerCase() !== 'none';
          if (!hasExplicitMax && !('max-width' in props) && 'max-width' in ctx.style_schema) {
            props['max-width'] = sizeValue(100, '%');
          }
        } else {
          noiseFiltered += 1;
        }
        continue;
      }
      if (!isBaseGroup) {
        const px = Number.parseFloat(value.trim());
        const spec = ctx.breakpoints.find((b) => String(b.key) === String(group.breakpoint));
        if (isLayoutDerivedPx(px) || (spec !== undefined && px >= spec.width * 0.94)) {
          consumed.add('width');
          props['width'] = sizeValue(100, '%');
          continue;
        }
      }
      // authored fixed width — fall through to the generic classification (kept verbatim)
    }
    // P1-b (contract 18 §7) — responsive GRID policy: `getComputedStyle` resolves grid tracks to
    // USED px, so a grid-only `@media` delta arrives as a capture-resolved px list (`735px` at the
    // 767 capture for an authored `1fr`) and a fluid BASE arrives as fractional equal tracks. Both
    // must be re-fluidized (ratio-preserving `minmax(0, <r>fr)`) or the converted page pins the
    // capture geometry — Driftwell rendered 743px wide at 390 because the mobile single-column
    // override was baked as the 767-capture px. A fluid base makes EVERY state:null group's track
    // list fluid (the deltas are the same grid reflowed); a non-fluid base still fluidizes a
    // breakpoint delta that is layout-derived (fractional) or fills ~the breakpoint viewport (the
    // collapse-to-full-width pattern, same rule as the width policy above). Authored keyword/fr
    // values and genuinely fixed px tracks fall through verbatim.
    if (
      propName === 'grid-template-columns' &&
      group.state === null &&
      'grid-template-columns' in ctx.style_schema
    ) {
      const tracks = parseGridPxTracks(value);
      if (tracks !== null) {
        let fluid = policy.gridFluid || tracks.some(isLayoutDerivedPx);
        if (!fluid && !isBaseGroup) {
          const spec = ctx.breakpoints.find((b) => String(b.key) === String(group.breakpoint));
          const span = tracks.reduce((a, b) => a + b, 0);
          fluid = spec !== undefined && span >= spec.width * 0.94;
        }
        if (fluid) {
          consumed.add('grid-template-columns');
          props['grid-template-columns'] = { $$type: 'string', value: gridTracksToFr(tracks) };
          continue;
        }
      }
      // authored fixed tracks — fall through to the generic classification (kept verbatim)
    }
    // `height` from getComputedStyle is a RESOLVED value, not an authored one. Freezing it on a
    // content-bearing box (hero/card/section) clips content that reflows at other viewports — the hero
    // subtitle/button spilled out of a too-short fixed-height box. Remap such heights to `min-height`
    // so the box can always grow to fit; only a leaf decorative box (no children, no text — e.g. an
    // icon/avatar) keeps an exact `height`. EXCEPT when the widget's base paints a fixed size
    // (e-svg 50x50 — I2): `min-height: 16px` cannot override a painted 50px base height, so a
    // size-painting widget always keeps the exact override (its "children" are svg internals, not
    // reflowable content).
    if (
      propName === 'height' &&
      (node.children.length > 0 || node.textRuns.length > 0) &&
      !policy.baseDefaults.has('height')
    ) {
      consumed.add('height');
      if (!('min-height' in props) && declMap.get('min-height') === undefined) {
        const v = classifyDeclaration('min-height', value, ctx.style_schema);
        if (v.kind !== 'unmappable' && v.atomic_prop !== undefined && v.typed_value !== undefined) {
          props['min-height'] = v.typed_value as TypedValue;
        }
      }
      continue;
    }
    // text-align keyword translation is direction-aware (WP-H02), then schema-checked.
    if (propName === 'text-align') {
      const translated = resolveLogicalKeyword('text-align', value, dir);
      const verdict = classifyDeclaration('text-align', translated, ctx.style_schema);
      if (verdict.kind === 'unmappable' || verdict.atomic_prop === undefined) {
        recordFallback(prop, value, verdict.fallback_tier ?? 'custom_css', verdict.reason);
      } else {
        props['text-align'] = { $$type: 'string', value: translated };
      }
      continue;
    }

    const verdict = classifyDeclaration(propName, value, ctx.style_schema);
    if (
      verdict.kind === 'unmappable' ||
      verdict.atomic_prop === undefined ||
      verdict.typed_value === undefined
    ) {
      recordFallback(prop, value, verdict.fallback_tier ?? 'custom_css', verdict.reason);
      continue;
    }
    // `background` can be set by BOTH a solid `background-color` (→ {color}) and a gradient
    // `background-image` (→ {background-overlay}). Merge their `value` objects so one doesn't clobber
    // the other (a colored element with a gradient overlay keeps both); otherwise plain assignment.
    if (
      verdict.atomic_prop === 'background' &&
      props['background'] !== undefined &&
      isPlainObject((props['background'] as { value?: unknown }).value) &&
      isPlainObject((verdict.typed_value as { value?: unknown }).value)
    ) {
      props['background'] = {
        $$type: 'background',
        value: {
          ...(props['background'] as { value: Record<string, unknown> }).value,
          ...(verdict.typed_value as { value: Record<string, unknown> }).value,
        },
      } as TypedValue;
    } else {
      props[verdict.atomic_prop] = verdict.typed_value as TypedValue;
    }

    // Literal flagging for variable extraction (WP-H09 decides; this stage only FLAGS).
    if (verdict.kind === 'variable-candidate') {
      flagLiteral(literals, 'color', value, node.source_path);
    }
    if (propName === 'font-family') {
      flagLiteral(literals, 'font', value, node.source_path);
    }
  }

  // ── Contract 17 #8 — MAP's inline accents ride the BASE variant as NESTED custom_css rules ────
  // (`& em{color:…}` — the renderer injects the raw INSIDE the element's rule block, so CSS nesting
  // scopes the color to the folded inline tag). The style-attr carrier is a dead end:
  // `Html_Prop_Type` sanitizes html-v3 with a custom `wp_kses` allowlist that strips every attribute
  // except `a[href|target]` (live-verified — page 2486's saved `<em style>` came back bare). The
  // same Pro gate as every custom_css route applies; without it the accent is an HONEST drop.
  if (isBaseGroup && node.accent_rules !== undefined) {
    for (const rule of node.accent_rules) {
      if (ctx.pro_active) {
        customCssDecls.push(`& ${rule.tag}{color:${rule.color};}`);
        fallbacks.push({
          source_path: node.source_path,
          declaration: `color: ${rule.color}`,
          tier: 'custom_css',
          reason: `inline <${rule.tag}> accent (html-v3 strips attributes); preserved as a nested custom_css rule`,
        });
      } else {
        fallbacks.push({
          source_path: node.source_path,
          declaration: `color: ${rule.color}`,
          tier: 'html_widget',
          reason: `inline <${rule.tag}> accent (html-v3 strips attributes); DROPPED (Pro inactive, no custom_css)`,
        });
      }
    }
  }

  // ── Contract 18 §7 P2-e — folded in-text links keep their underline ──────────────────────────
  // A run carrying `linkHref` serializes as a live `<a href>` inside the host's html-v3 content
  // (contract 17 §5), but the anchor's UA-default `text-decoration: underline` lives on the FOLDED
  // inline element — it is never captured as a node of its own, and the target site's theme/reset
  // CSS strips it (the E2M field loss: in-text links rendered visually indistinguishable from the
  // surrounding copy). Carry it the same way as the #8 accents: one nested custom_css rule on the
  // host's BASE variant (`& a{…}` — html-v3 strips every attribute except a[href|target], so the
  // local style is the only carrier). The underline is the UA default for `<a href>`; a per-run
  // source decoration capture does not exist on the IR seam yet, so this assumes the dominant
  // in-text-link convention. Same Pro gate as every custom_css route; honest drop otherwise.
  if (
    isBaseGroup &&
    HTML_V3_FOLDING_WIDGETS.has(node.target.widgetType ?? '') &&
    node.textRuns.some((r) => r.linkHref !== undefined)
  ) {
    if (ctx.pro_active) {
      customCssDecls.push('& a{text-decoration:underline;}');
      fallbacks.push({
        source_path: node.source_path,
        declaration: 'text-decoration: underline',
        tier: 'custom_css',
        reason:
          'folded in-text <a> run keeps its underline (html-v3 strips attributes); preserved as a nested custom_css rule',
      });
    } else {
      fallbacks.push({
        source_path: node.source_path,
        declaration: 'text-decoration: underline',
        tier: 'html_widget',
        reason:
          'folded in-text <a> run underline (html-v3 strips attributes); DROPPED (Pro inactive, no custom_css)',
      });
    }
  }

  if (Object.keys(props).length === 0 && customCssDecls.length === 0) {
    return { variant: null, fallbacks, rawDecls: group.decls, noiseFiltered };
  }
  const variant: StyleVariant = {
    meta: { breakpoint: group.breakpoint, state: group.state },
    props,
    // The renderer injects the DECODED raw inside the variant's selector block
    // (`selector { props custom_css }`), so the raw is declarations + optional trailing NESTED
    // rules (the #8 accents), base64-encoded — the PHP style parser REJECTS non-base64 raw and the
    // renderer base64-decodes before emitting.
    ...(customCssDecls.length > 0
      ? { custom_css: { raw: Buffer.from(customCssDecls.join(' '), 'utf8').toString('base64') } }
      : {}),
  };
  return { variant, fallbacks, rawDecls: group.decls, noiseFiltered };
}

/* ─────────────────────────── box-family handlers (WP-H02) ───────────────────────────────────── */

type RecordFallback = (
  prop: string,
  value: string,
  tier: DeclFallback['tier'],
  reason: string,
) => void;

/** Resolve a box family's physical edges from the shorthand OR longhands present in the decl map. */
function resolvePhysicalBox(
  declMap: Map<string, string>,
  shorthand: string,
  longhands: { top: string; right: string; bottom: string; left: string },
  consumed: Set<string>,
): { box: PhysicalBox; complete: boolean } | null {
  const short = declMap.get(shorthand);
  if (short !== undefined) {
    consumed.add(shorthand);
    return { box: expandBoxShorthand(short), complete: true };
  }
  const { box, consumed: used } = collectPhysicalBox(declMap, longhands);
  if (used.length === 0) {
    return null;
  }
  for (const k of used) {
    consumed.add(k);
  }
  return { box, complete: canCollapseToLogical(box) };
}

function handlePadding(
  declMap: Map<string, string>,
  dir: Direction,
  ctx: StyleContext,
  props: Record<string, TypedValue>,
  consumed: Set<string>,
  recordFallback: RecordFallback,
): void {
  if (!('padding' in ctx.style_schema)) {
    return;
  }
  const resolved = resolvePhysicalBox(
    declMap,
    'padding',
    { top: 'padding-top', right: 'padding-right', bottom: 'padding-bottom', left: 'padding-left' },
    consumed,
  );
  if (resolved === null) {
    return;
  }
  const logical = resolveDimensions(resolved.box, dir);
  const wrapped = wrapEdgeMap(logical as Record<string, SizeValue | undefined>);
  if (Object.keys(wrapped).length > 0) {
    props['padding'] = { $$type: 'dimensions', value: wrapped };
  } else {
    recordFallback(
      'padding',
      JSON.stringify(resolved.box),
      'custom_css',
      'padding had no resolvable edges',
    );
  }
}

function handleMargin(
  declMap: Map<string, string>,
  dir: Direction,
  ctx: StyleContext,
  props: Record<string, TypedValue>,
  consumed: Set<string>,
  recordFallback: RecordFallback,
): void {
  if (!('margin' in ctx.style_schema)) {
    return;
  }
  const resolved = resolvePhysicalBox(
    declMap,
    'margin',
    { top: 'margin-top', right: 'margin-right', bottom: 'margin-bottom', left: 'margin-left' },
    consumed,
  );
  if (resolved === null) {
    return;
  }
  const logical = resolveDimensions(resolved.box, dir);
  const wrapped = wrapEdgeMap(logical as Record<string, SizeValue | undefined>);
  if (Object.keys(wrapped).length > 0) {
    props['margin'] = { $$type: 'dimensions', value: wrapped };
  } else {
    recordFallback(
      'margin',
      JSON.stringify(resolved.box),
      'custom_css',
      'margin had no resolvable edges',
    );
  }
}

function handleInset(
  declMap: Map<string, string>,
  dir: Direction,
  props: Record<string, TypedValue>,
  consumed: Set<string>,
): void {
  const { box, consumed: used } = collectPhysicalBox(declMap, {
    top: 'top',
    right: 'right',
    bottom: 'bottom',
    left: 'left',
  });
  if (used.length === 0) {
    return;
  }
  for (const k of used) {
    consumed.add(k);
  }
  const logical = resolveInset(box, dir);
  // Each logical inset is its OWN top-level Style-Schema prop (`inset-block-start` etc.).
  const wrapped = wrapEdgeMap(logical as Record<string, SizeValue | undefined>);
  for (const [k, v] of Object.entries(wrapped)) {
    props[k] = v;
  }
}

function handleBorderRadius(
  declMap: Map<string, string>,
  dir: Direction,
  props: Record<string, TypedValue>,
  consumed: Set<string>,
): void {
  const short = declMap.get('border-radius');
  let corners: PhysicalCorners | null = null;
  if (short !== undefined) {
    consumed.add('border-radius');
    corners = expandRadiusShorthand(short);
  } else {
    const per: PhysicalCorners = {};
    const map: Array<[keyof PhysicalCorners, string]> = [
      ['top-left', 'border-top-left-radius'],
      ['top-right', 'border-top-right-radius'],
      ['bottom-right', 'border-bottom-right-radius'],
      ['bottom-left', 'border-bottom-left-radius'],
    ];
    let any = false;
    for (const [corner, longhand] of map) {
      const val = declMap.get(longhand);
      if (val !== undefined) {
        per[corner] = val;
        consumed.add(longhand);
        any = true;
      }
    }
    if (any) {
      corners = per;
    }
  }
  if (corners === null) {
    return;
  }
  const logical = resolveBorderRadius(corners, dir);
  const wrapped = wrapEdgeMap(logical as Record<string, SizeValue | undefined>);
  if (Object.keys(wrapped).length > 0) {
    props['border-radius'] = { $$type: 'border-radius', value: wrapped };
  }
}

function handleBorderWidth(
  declMap: Map<string, string>,
  dir: Direction,
  props: Record<string, TypedValue>,
  consumed: Set<string>,
): void {
  const short = declMap.get('border-width');
  let box: PhysicalBox | null = null;
  if (short !== undefined) {
    consumed.add('border-width');
    box = expandBoxShorthand(short);
  } else {
    const { box: collected, consumed: used } = collectPhysicalBox(declMap, {
      top: 'border-top-width',
      right: 'border-right-width',
      bottom: 'border-bottom-width',
      left: 'border-left-width',
    });
    if (used.length > 0) {
      for (const k of used) {
        consumed.add(k);
      }
      box = collected;
    }
  }
  if (box === null) {
    return;
  }
  const logical = resolveBorderWidth(box, dir);
  const wrapped = wrapEdgeMap(logical as Record<string, SizeValue | undefined>);
  if (Object.keys(wrapped).length > 0) {
    props['border-width'] = { $$type: 'border-width', value: wrapped };
    // A border NEVER paints without `border-style` — the atomic schema has ONE `border-style` string
    // key, but getComputedStyle emits per-side `border-top-style`. Without mapping it, every width+color
    // border rendered as nothing (cards looked borderless). Emit it alongside a non-zero width.
    const styleRaw = declMap.get('border-style') ?? declMap.get('border-top-style');
    const sv = styleRaw?.trim().toLowerCase();
    if (sv !== undefined && sv !== '' && sv !== 'none') {
      props['border-style'] = { $$type: 'string', value: sv };
    }
  }
  consumed.add('border-style');
  consumed.add('border-top-style');
}

/**
 * Combine the `flex-grow`/`flex-shrink`/`flex-basis` longhands into the COMPOSITE atomic `flex` prop
 * (the Style_Schema has only the composite `flex` key — the longhands are not schema keys, so emitting
 * them individually silently no-ops). ALWAYS consumes the longhands (so a default `0 1 auto` does not
 * create fallback noise / depress coverage); emits the `flex` prop only when a component is non-default.
 * VERIFIED: composite flex renders (flexGrow 1:2:1 → widths 1:2:1 on the live frontend).
 */
function handleFlex(
  declMap: Map<string, string>,
  props: Record<string, TypedValue>,
  consumed: Set<string>,
): void {
  const g = declMap.get('flex-grow');
  const sh = declMap.get('flex-shrink');
  const ba = declMap.get('flex-basis');
  if (g === undefined && sh === undefined && ba === undefined) {
    return;
  }
  consumed.add('flex-grow');
  consumed.add('flex-shrink');
  consumed.add('flex-basis');

  const grow = g !== undefined ? Number.parseFloat(g) : 0;
  const shrink = sh !== undefined ? Number.parseFloat(sh) : 1;
  let basis: { unit: string; size: number | null } | null = null;
  if (ba !== undefined) {
    const trimmed = ba.trim();
    const m = trimmed.match(/^(-?[\d.]+)(px|%|em|rem|vw|vh)$/);
    if (m !== null) {
      basis = { unit: m[2] ?? 'px', size: Number.parseFloat(m[1] ?? '0') };
    } else if (/^0$/.test(trimmed)) {
      basis = { unit: 'px', size: 0 };
    } else {
      // `auto` (and the content-ish keywords) MUST be emitted EXPLICITLY: the PHP Flex_Transformer
      // renders an omitted basis as the CSS shorthand `flex: <grow> <shrink>`, whose spec meaning
      // is basis **0%** — that zero-sized every width-styled icon in a flex row (page 2390:
      // `flex: 0 0 auto` → `flex: 0 0 0%` → 11 zero-area SVGs). `{unit:'auto', size:null}` is the
      // atomic auto encoding (Size_Prop_Type validates it; the transformer renders `auto`).
      basis = { unit: 'auto', size: null };
    }
  }

  const gNorm = Number.isNaN(grow) ? 0 : grow;
  const shNorm = Number.isNaN(shrink) ? 1 : shrink;
  if (gNorm === 0 && shNorm === 1 && (basis === null || basis.unit === 'auto')) {
    return; // default flex (`0 1 auto`) — consumed (no fallback) but nothing meaningful to emit
  }

  const value: Record<string, TypedValue> = {
    flexGrow: { $$type: 'number', value: gNorm },
    flexShrink: { $$type: 'number', value: shNorm },
    // Always emit the basis alongside grow+shrink — `grow shrink` without it means basis 0%.
    flexBasis: { $$type: 'size', value: basis ?? { unit: 'auto', size: null } },
  };
  props['flex'] = { $$type: 'flex', value };
}

/* ─────────────────────────── placeholder local-style id (WP-H08 finalizes) ──────────────────── */

/**
 * The placeholder local-style id this stage emits. WP-H08 (ASSEMBLE) mints the real element id and
 * rewrites this into the `e-<elementId>-<7hex>` form AND mirrors it into `settings.classes` (the §5.1
 * HARD rule; `LOCAL_STYLE_UNLINKED` if missed). The placeholder is deterministic per source_path so
 * downstream fingerprinting (HOIST, WP-H09) is stable. It satisfies the classes name regex
 * `/^[A-Za-z][A-Za-z0-9_-]*$/` so it round-trips structurally before WP-H08 finalization.
 */
export function placeholderLocalStyleId(sourcePath: string): string {
  // Deterministic 7-hex-ish suffix from a cheap string hash of the source path (collision-tolerant;
  // WP-H08 re-mints against the live id set anyway).
  let h = 2166136261 >>> 0;
  for (let i = 0; i < sourcePath.length; i++) {
    h ^= sourcePath.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const suffix = h.toString(16).padStart(7, '0').slice(0, 7);
  return `e-local-${suffix}`;
}

/** A human label for a local style (always `'local'` per the frozen `StyledNode` shape). */
const LOCAL_LABEL = 'local';

/* ─────────────────────────── the stage entry point ──────────────────────────────────────────── */

/**
 * STYLE-EXTRACT: turn a `MappedNode[]` forest into a `StyledNode[]` forest, attaching one local
 * `StyleDefinition` per node (when it has surviving native declarations), plus the per-declaration
 * fallback report and the proposed variable literals. Recurses into children.
 *
 * Direction: VISUAL intent is preserved by passing the EFFECTIVE direction to WP-H02. We use
 * `ctx.target_rtl` to decide the target's writing direction (the relocation that keeps the source's
 * visual left/right), falling back to `ctx.doc_direction` (RESEARCH.md §6.3).
 */
export function extractStyles(nodes: MappedNode[], ctx: StyleContext): StyleExtractResult {
  const literals = new Map<string, LiteralRef>();
  const allFallbacks: DeclFallback[] = [];
  const dir: Direction = ctx.target_rtl ? 'rtl' : ctx.doc_direction;
  const noise = { count: 0 };
  const detected = { count: 0 };

  const styledNodes = nodes.map((node) =>
    styleNode(node, ctx, dir, literals, allFallbacks, null, noise, detected),
  );

  // I4 — the filtered computed-default count is REPORTED (one summary record; never a silent
  // exclusion). Tier `native` is the only zero-loss member of the frozen DeclFallback vocabulary;
  // `buildCoverageReport` recognizes the synthetic source_path, keeps the record OUT of the tier
  // tally, and surfaces it in the fallbacks rollup.
  if (noise.count > 0) {
    allFallbacks.push({
      source_path: NOISE_FILTER_SOURCE_PATH,
      declaration: `(${noise.count} computed-default declarations)`,
      tier: 'native',
      reason: `I4 noise filter: ${noise.count} computed-default no-op declaration(s) excluded before tier accounting`,
    });
  }

  return {
    styled_nodes: styledNodes,
    declaration_fallbacks: allFallbacks,
    proposed_variable_literals: [...literals.values()],
    detected_declarations: detected.count,
  };
}

/** Style one node (recursing into children) into a `StyledNode`. */
function styleNode(
  node: MappedNode,
  ctx: StyleContext,
  dir: Direction,
  literals: Map<string, LiteralRef>,
  allFallbacks: DeclFallback[],
  parent: MappedNode | null,
  noise: { count: number },
  detected: { count: number },
): StyledNode {
  const groups = groupDeclarations(node, ctx.breakpoints);
  const variants: StyleVariant[] = [];
  const declIndex: DeclIndex = {};
  const policy: NodeStylePolicy = {
    contentBearing: node.children.length > 0 || node.textRuns.length > 0,
    widthFluid: widthIsFluid(node, parent),
    flexRowAutoWidth: isContentSizedRowChild(node, parent),
    spreadRowFill: isSpreadRowContainer(node),
    centeredMargins: hasCenteredMarginSignature(node),
    gridFluid: gridTracksAreFluid(node),
    baseDefaults: paintedDefaultsFor(node),
  };

  for (const group of groups) {
    const extract = extractGroup(node, group, ctx, dir, literals, policy);
    declIndex[group.indexKey] = extract.rawDecls;
    noise.count += extract.noiseFiltered;
    // I3 — count the group's accounting units AT THE EXTRACTION SEAM (the producer's own tally,
    // before any pipeline-side merging/filtering): every typed prop this group emitted + every
    // fallback row it recorded. The integrator compares its post-merge ledger against this number.
    detected.count +=
      (extract.variant !== null ? Object.keys(extract.variant.props).length : 0) +
      extract.fallbacks.length;
    for (const fb of extract.fallbacks) {
      allFallbacks.push(fb);
    }
    if (extract.variant !== null) {
      variants.push(extract.variant);
    }

    // Flag recurring SIZE literals from the raw declarations (variable candidates, WP-H09).
    for (const { prop, value } of extract.rawDecls) {
      if (/^(?:width|height|font-size|gap|line-height)$/.test(prop.toLowerCase())) {
        if (/^[+-]?(?:\d*\.\d+|\d+)(?:px|rem|em)$/i.test(value.trim())) {
          flagLiteral(literals, 'size', value, node.source_path);
        }
      }
    }
  }

  const localStyles: StyleDefinition[] = [];
  if (variants.length > 0) {
    localStyles.push({
      id: placeholderLocalStyleId(node.source_path),
      type: 'class',
      label: LOCAL_LABEL,
      variants,
    });
  }

  // `node.children` is `MappedNode[]` (the intersection's narrower member); the explicit annotation
  // keeps TS from widening `child` to the `IrNode` base under `exactOptionalPropertyTypes`.
  const children: StyledNode[] = node.children.map((child: MappedNode) =>
    styleNode(child, ctx, dir, literals, allFallbacks, node, noise, detected),
  );

  return {
    ...node,
    children,
    local_styles: localStyles,
    decl_index: declIndex,
  };
}
