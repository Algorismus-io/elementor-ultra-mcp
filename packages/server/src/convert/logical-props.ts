/**
 * WP-H02 — direction-aware physical→logical CSS box-property reference module.
 *
 * A PURE reference module that relocates physical CSS box properties (`padding-left`, `margin-top`,
 * `border-top-left-radius`, `top/left/right/bottom`, `text-align: left`) into Elementor's V4 atomic
 * LOGICAL prop shapes (`dimensions.inline-start`, `border-radius.start-start`, `inset-inline-start`,
 * `text-align: start`) in a DIRECTION-AWARE way (RESEARCH.md §6.3 "physical->logical conversion is
 * DIRECTION-AWARE (corrected)").
 *
 * It is the load-bearing correctness module that prevents LTR/RTL mistakes: `padding-left` ->
 * `inline-start` is correct only for LTR; for RTL it is `inline-END`. Only the INLINE axis ever
 * mirrors — the BLOCK axis (top/bottom) is identical in both directions.
 *
 * SCOPE (`WP-H02` ticket):
 *  - This module owns NO Style-Schema validation (that is WP-H07 / STYLE-EXTRACT, which calls this).
 *  - It owns NO I/O, NO Playwright, NO WP client — deterministic given inputs.
 *  - It does NOT detect the source/target direction: `dir` is an INPUT the orchestrator resolves.
 *  - Output value placeholders are RAW `{ size, unit }` objects (or the `auto` sentinel), NOT typed
 *    `{$$type,value}` envelopes — envelope wrapping is WP-H08 (ASSEMBLE) / WP-H07's job.
 *
 * Output field names are FROZEN to match `atomic-prop-types.schema.json` (`dimensions`:
 * `block-start/inline-end/block-end/inline-start`) and the authoring-contract §5.2 logical box props
 * (`border-radius`: `start-start/start-end/end-start/end-end`; `border-width`:
 * `block-start/block-end/inline-start/inline-end`; inset: `inset-block-start` etc.). A wrong field
 * name is SILENTLY DROPPED by the PHP `Style_Parser` dry_run — get these EXACT.
 */

/* ─────────────────────────── Direction + value placeholders ─────────────────────────────────── */

/** The resolved writing-direction the orchestrator passes in (it is an INPUT, never detected here). */
export type Direction = 'ltr' | 'rtl';

/** A CSS length token as it arrives from the IR/computed styles (e.g. `'16px'`, `'0'`, `'auto'`). */
export type LenStr = string;

/**
 * The raw, pre-envelope value placeholder this module emits per edge/corner. Mirrors the atomic
 * `size` payload (`atomic-prop-types.schema.json#/$defs/Size` `value`): `{ size, unit }`. WP-H07/H08
 * wrap this into a `{$$type:'size',value:{...}}` envelope. The `auto` keyword survives as a sentinel
 * (`{ size: null, unit: 'auto' }`, per authoring-contract §3.1 "auto => size null") — never coerced
 * to a number.
 */
export interface SizeValue {
  /**
   * Numeric magnitude; `null` for the `auto` keyword (authoring-contract §3.1 "auto => size null");
   * a `string` for a `custom` value (`calc(...)`/`var(...)`) per the `Size` schema, which allows
   * `["number","string","null"]` (`atomic-prop-types.schema.json#/$defs/Size`).
   */
  size: number | string | null;
  /** CSS unit token (`px`, `%`, `em`, …), `auto`, or `custom` (per the `Size` schema unit examples). */
  unit: string;
}

/* ─────────────────────────── Physical inputs ───────────────────────────────────────────────── */

/** Physical box edges as authored in source CSS (`padding`/`margin`/inset shorthand expansion). */
export interface PhysicalBox {
  top?: LenStr;
  right?: LenStr;
  bottom?: LenStr;
  left?: LenStr;
}

/** Physical corner radii as authored in source CSS (`border-*-*-radius`). */
export interface PhysicalCorners {
  'top-left'?: LenStr;
  'top-right'?: LenStr;
  'bottom-right'?: LenStr;
  'bottom-left'?: LenStr;
}

/* ─────────────────────────── Logical outputs (FROZEN field names) ───────────────────────────── */

/**
 * Atomic `dimensions` value (`atomic-prop-types.schema.json#/$defs/Dimensions`). Used for
 * `padding`/`margin` (and gap-as-dimensions). Each present edge carries a raw `SizeValue`.
 */
export interface LogicalDimensions {
  'block-start'?: SizeValue;
  'inline-end'?: SizeValue;
  'block-end'?: SizeValue;
  'inline-start'?: SizeValue;
}

/**
 * Atomic `border-radius` value (authoring-contract §5.2 BORDER; physical corners decomposed exactly).
 * Logical corner names: start/end of the block axis crossed with start/end of the inline axis.
 */
export interface LogicalCorners {
  'start-start'?: SizeValue;
  'start-end'?: SizeValue;
  'end-start'?: SizeValue;
  'end-end'?: SizeValue;
}

/**
 * Atomic `border-width` value (authoring-contract §5.2 BORDER). NOTE the field-name set differs from
 * `dimensions`: it is `block-start/block-end/inline-start/inline-end`.
 */
export interface LogicalEdges {
  'block-start'?: SizeValue;
  'block-end'?: SizeValue;
  'inline-start'?: SizeValue;
  'inline-end'?: SizeValue;
}

/**
 * The four `position` inset props (authoring-contract §5.2 POSITION; each a `size`,
 * `[dep position!=static]`). These are FULL CSS logical property names (not sub-fields of one object).
 */
export interface LogicalInset {
  'inset-block-start'?: SizeValue;
  'inset-inline-end'?: SizeValue;
  'inset-block-end'?: SizeValue;
  'inset-inline-start'?: SizeValue;
}

/* ─────────────────────────── Length parsing (auto-aware) ────────────────────────────────────── */

/**
 * Parse a CSS length token into a raw `SizeValue`. `auto` (any case, trimmed) becomes the
 * `{ size: null, unit: 'auto' }` sentinel; everything else is split into a numeric magnitude + unit.
 * Unitless `0` keeps `unit:'px'` by convention (it is the only valid unitless length in this context).
 * This module does NOT validate the unit against any preset list — that is WP-H07.
 */
export function parseLen(value: LenStr): SizeValue {
  const raw = value.trim();
  if (raw.toLowerCase() === 'auto') {
    return { size: null, unit: 'auto' };
  }
  // Match an optional sign, a number (int/float/exp-free), and a trailing unit/identifier.
  const match = /^([+-]?(?:\d*\.\d+|\d+))\s*([a-z%]*)$/i.exec(raw);
  if (match === null) {
    // Non-numeric, non-auto token (e.g. `calc(...)`, `var(...)`, `inherit`). Surface verbatim as a
    // `custom` size so WP-H07 can decide native-vs-fallback; do NOT throw (this module never throws).
    return { size: raw, unit: 'custom' };
  }
  const magnitude = Number(match[1]);
  const unit = match[2] === '' ? 'px' : (match[2] as string).toLowerCase();
  return { size: magnitude, unit };
}

/** Parse a maybe-absent physical edge; `undefined` stays `undefined` (the edge is simply absent). */
function parseEdge(value: LenStr | undefined): SizeValue | undefined {
  return value === undefined ? undefined : parseLen(value);
}

/* ─────────────────────────── Direction mapping (only the INLINE axis mirrors) ───────────────── */

/**
 * The single source of truth for direction: in LTR the visual-left edge is the inline-START and the
 * visual-right edge is the inline-END; in RTL they swap. The BLOCK axis (top/bottom) is NEVER
 * mirrored. Every box resolver derives its mapping from this one table so LTR/RTL can only diverge on
 * the inline axis (ticket: "Keep a single MIRROR_INLINE constant table … never mirror the block axis").
 */
const MIRROR_INLINE: Readonly<
  Record<
    Direction,
    { readonly left: 'inline-start' | 'inline-end'; readonly right: 'inline-start' | 'inline-end' }
  >
> = {
  ltr: { left: 'inline-start', right: 'inline-end' },
  rtl: { left: 'inline-end', right: 'inline-start' },
} as const;

/* ─────────────────────────── Box resolvers ─────────────────────────────────────────────────── */

/**
 * Collapse a physical `{ top, right, bottom, left }` box into the atomic `dimensions` shape, honoring
 * `dir`. LTR: left->inline-start, right->inline-end. RTL: left->inline-end, right->inline-start. The
 * block axis (top->block-start, bottom->block-end) is direction-independent. Absent physical edges
 * stay absent in the output (no synthetic `0` is injected — WP-H07 decides single-edge handling).
 */
export function resolveDimensions(physical: PhysicalBox, dir: Direction): LogicalDimensions {
  const inline = MIRROR_INLINE[dir];
  const out: LogicalDimensions = {};
  const top = parseEdge(physical.top);
  const bottom = parseEdge(physical.bottom);
  const left = parseEdge(physical.left);
  const right = parseEdge(physical.right);
  if (top !== undefined) out['block-start'] = top;
  if (bottom !== undefined) out['block-end'] = bottom;
  if (left !== undefined) out[inline.left] = left;
  if (right !== undefined) out[inline.right] = right;
  return out;
}

/**
 * Map physical corner radii to the atomic `border-radius` logical corners, honoring `dir`. In LTR:
 * top-left=start-start, top-right=start-end, bottom-right=end-end, bottom-left=end-start. RTL mirrors
 * ONLY the inline (second) axis component of each corner, leaving the block (first) component intact.
 */
export function resolveBorderRadius(physical: PhysicalCorners, dir: Direction): LogicalCorners {
  const inline = MIRROR_INLINE[dir];
  // The inline component of a corner: 'start' for the left edge, 'end' for the right edge, per dir.
  const leftInline = inline.left === 'inline-start' ? 'start' : 'end';
  const rightInline = inline.right === 'inline-start' ? 'start' : 'end';
  const out: LogicalCorners = {};
  const tl = parseEdge(physical['top-left']);
  const tr = parseEdge(physical['top-right']);
  const br = parseEdge(physical['bottom-right']);
  const bl = parseEdge(physical['bottom-left']);
  // First component = block axis (top->start, bottom->end); second = inline axis (dir-dependent).
  if (tl !== undefined) out[`start-${leftInline}` as keyof LogicalCorners] = tl;
  if (tr !== undefined) out[`start-${rightInline}` as keyof LogicalCorners] = tr;
  if (br !== undefined) out[`end-${rightInline}` as keyof LogicalCorners] = br;
  if (bl !== undefined) out[`end-${leftInline}` as keyof LogicalCorners] = bl;
  return out;
}

/**
 * Map physical edge widths to the atomic `border-width` logical edges, honoring `dir`. Same inline
 * mirroring rule as `resolveDimensions`, but the output field-name set is the `border-width` set
 * (`block-start/block-end/inline-start/inline-end`).
 */
export function resolveBorderWidth(physical: PhysicalBox, dir: Direction): LogicalEdges {
  const inline = MIRROR_INLINE[dir];
  const out: LogicalEdges = {};
  const top = parseEdge(physical.top);
  const bottom = parseEdge(physical.bottom);
  const left = parseEdge(physical.left);
  const right = parseEdge(physical.right);
  if (top !== undefined) out['block-start'] = top;
  if (bottom !== undefined) out['block-end'] = bottom;
  if (left !== undefined) out[inline.left] = left;
  if (right !== undefined) out[inline.right] = right;
  return out;
}

/**
 * Map the four physical `position` insets (`top/right/bottom/left`) to the logical inset CSS props,
 * honoring `dir`. top->inset-block-start, bottom->inset-block-end (never mirrored); left/right map to
 * inset-inline-(start|end) per `dir`.
 */
export function resolveInset(physical: PhysicalBox, dir: Direction): LogicalInset {
  const inline = MIRROR_INLINE[dir];
  const out: LogicalInset = {};
  const top = parseEdge(physical.top);
  const bottom = parseEdge(physical.bottom);
  const left = parseEdge(physical.left);
  const right = parseEdge(physical.right);
  if (top !== undefined) out['inset-block-start'] = top;
  if (bottom !== undefined) out['inset-block-end'] = bottom;
  if (left !== undefined) out[`inset-${inline.left}` as keyof LogicalInset] = left;
  if (right !== undefined) out[`inset-${inline.right}` as keyof LogicalInset] = right;
  return out;
}

/* ─────────────────────────── Keyword translation ───────────────────────────────────────────── */

/**
 * The Style-Schema enum for `text-align` is `start|center|end|justify` (authoring-contract §5.2
 * TYPOGRAPHY) — it has NO `left`/`right`. Translation is therefore MANDATORY: an un-translated
 * `left`/`right` would be DROPPED by `Style_Schema`.
 */
const TEXT_ALIGN_ENUM: ReadonlySet<string> = new Set(['start', 'center', 'end', 'justify']);

/**
 * Props whose Style-Schema enum DOES include the physical `left|right` keywords (and the various
 * `flex-start|flex-end|start|end` logical members) — authoring-contract §5.2 ALIGNMENT. For these we
 * PASS THROUGH any value already in the enum and only translate values that are not enum members,
 * preserving the source's visual intent (do NOT force a translation that changes appearance).
 */
const ALIGNMENT_PROPS: ReadonlySet<string> = new Set([
  'justify-content',
  'align-items',
  'align-self',
  'align-content',
  'justify-items',
  'justify-self',
]);

/** The logical/physical members the ALIGNMENT enum accepts as-is (pass-through, never translated). */
const ALIGNMENT_ENUM: ReadonlySet<string> = new Set([
  'left',
  'right',
  'center',
  'start',
  'end',
  'flex-start',
  'flex-end',
  'space-between',
  'space-around',
  'space-evenly',
  'stretch',
  'baseline',
  'normal',
]);

/**
 * Translate a physical keyword value to its Style-Schema enum member, honoring `dir`.
 *
 * - `text-align`: `left`->`start` (LTR) / `end` (RTL); `right`->`end` (LTR) / `start` (RTL). Already-
 *   logical values (`start`/`center`/`end`/`justify`) pass through. Translation is MANDATORY because
 *   the schema has no `left`/`right` for `text-align`.
 * - `justify-content`/`align-*`: the schema enum already includes `left|right` (and `flex-start` etc.),
 *   so any value already in the enum passes through UNCHANGED (preserve visual intent). Only a value
 *   that is NOT an enum member is mapped via the inline-axis rule.
 * - Any other prop: returned unchanged (this module only owns the box/text-align relocation).
 *
 * Never throws; an unrecognized value is returned verbatim for WP-H07 to validate/route.
 */
export function resolveLogicalKeyword(prop: string, value: string, dir: Direction): string {
  const v = value.trim().toLowerCase();

  // left/right -> inline start/end honoring direction (shared by both prop families).
  const leftLogical = dir === 'ltr' ? 'start' : 'end';
  const rightLogical = dir === 'ltr' ? 'end' : 'start';

  if (prop === 'text-align') {
    if (v === 'left') return leftLogical;
    if (v === 'right') return rightLogical;
    if (TEXT_ALIGN_ENUM.has(v)) return v; // already logical (start/center/end/justify)
    return value; // unrecognized — pass verbatim, WP-H07 decides
  }

  if (ALIGNMENT_PROPS.has(prop)) {
    // Pass through any value already valid in the alignment enum — preserve the source's appearance.
    if (ALIGNMENT_ENUM.has(v)) return v;
    // Not an enum member: best-effort inline-axis translation (only `left`/`right` reach here if the
    // enum did not already accept them, which it does — so this is effectively a no-op safety net).
    if (v === 'left') return leftLogical;
    if (v === 'right') return rightLogical;
    return value;
  }

  return value;
}

/* ─────────────────────────── Collapsibility ─────────────────────────────────────────────────── */

/**
 * Report whether a physical box can be UNAMBIGUOUSLY collapsed to a logical box. True when all four
 * edges are present (a clean, complete box). False when only some edges are set, because a partial
 * physical box (e.g. only `padding-left`) cannot be relocated to a logical edge without losing intent
 * when the effective direction is uncertain (RESEARCH.md §6.3: "collapse to logical only when
 * unambiguous, otherwise keep physical or emit both").
 *
 * This module ONLY reports collapsibility — it never throws and never decides the fallback. WP-H07
 * (STYLE-EXTRACT) decides whether to keep a partial physical value via a single-edge atomic dimension
 * or route it to the fallback ladder.
 */
export function canCollapseToLogical(physical: PhysicalBox): boolean {
  const present = (['top', 'right', 'bottom', 'left'] as const).filter(
    (edge) => physical[edge] !== undefined,
  );
  // A complete box (all four edges) is unambiguous. Anything less risks intent loss under unknown dir.
  return present.length === 4;
}
