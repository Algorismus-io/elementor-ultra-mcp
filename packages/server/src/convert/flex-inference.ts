/**
 * WP-H05 — FLEX INFERENCE (Locofy-style layout reconstruction, SUPPLEMENT §C.2/§C.4).
 *
 * The geometry/CSS-heuristic half of CLASSIFY. Given a normalized IR node, decide whether it is a
 * layout container and, if so, infer its flex INTENT — direction / wrap / justify / align / gap +
 * the children that become `flex:1` (Fill) or `position:absolute` (out-of-flow). This is the
 * Locofy/Visual-Copilot technique (SUPPLEMENT §C.2): read `display:flex` directly when present, but
 * when source CSS is dirty (absolute marketing HTML with no explicit flex) INFER the band from box
 * geometry rather than refusing — "infer flex intent from box geometry when source CSS is dirty …
 * rather than refusing (Visual Copilot 'without explicit breakpoints')".
 *
 * CONSERVATIVE about grid (RESEARCH.md §6.4 step 4 / authoring-contract §5.2): a single-row flex
 * misread as grid produces an unmappable `grid-template-areas` downstream and forces a fallback, so
 * `inferFlex` never claims grid — it only ever returns flex intent. The CLASSIFY caller owns the
 * `flex-row`/`flex-col`/`grid`/`structural-block` decision (see `isTrueGrid` here for the 2D test it
 * consults). `inferFlex` returns `null` for a non-container (leaf / single-child-styleless / text).
 *
 * PURE module: deterministic given an `IrNode`, NO I/O, NO Playwright, NO WP client. Owns ONLY the
 * functions + helpers; `IrNode`/`FlexIntent`/`ComputedStyleSet`/`BoxRect` are FROZEN in WP-H01
 * (`types.ts`) and imported, never redeclared.
 */

import type { BoxRect, ComputedStyleSet, FlexIntent, IrNode } from './types.js';

/* ─────────────────────────── small computed-style helpers ───────────────────────────────────── */

/** Lower-cased, trimmed computed value for a prop (empty string when absent). */
function cv(computed: ComputedStyleSet, prop: string): string {
  const v = computed[prop];
  return v === undefined ? '' : v.trim().toLowerCase();
}

/** Parse a computed length to px number; non-finite / `auto` / `none` → `null`. */
function px(value: string): number | null {
  const m = /^(-?\d*\.?\d+)px$/.exec(value.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Is the computed `display` a flex (or inline-flex) container? */
export function isFlexDisplay(computed: ComputedStyleSet): boolean {
  const d = cv(computed, 'display');
  return d === 'flex' || d === 'inline-flex';
}

/** Is the computed `display` a CSS grid (or inline-grid) container? */
export function isGridDisplay(computed: ComputedStyleSet): boolean {
  const d = cv(computed, 'display');
  return d === 'grid' || d === 'inline-grid';
}

/** A child is removed from flow when `position:absolute|fixed`. */
function isAbsolute(child: IrNode): boolean {
  const p = cv(child.computed, 'position');
  return p === 'absolute' || p === 'fixed';
}

/**
 * A child is a "Fill" child (Locofy) when it grows to consume free space:
 * `flex:1`-ish — `flex-grow >= 1`, or a `flex`/`flex-basis` shorthand that grows.
 */
function isFillChild(child: IrNode): boolean {
  const grow = cv(child.computed, 'flex-grow');
  if (grow !== '' && Number(grow) >= 1) return true;
  // The `flex` shorthand may resolve to `1 1 0%` / `1 1 0px` etc. in computed style.
  const flex = cv(child.computed, 'flex');
  if (flex !== '') {
    const first = flex.split(/\s+/)[0];
    if (first !== undefined && Number(first) >= 1) return true;
  }
  return false;
}

/* ─────────────────────────── geometry-based band detection ──────────────────────────────────── */

/** The in-flow children (absolute/fixed are removed from the geometry analysis). */
function inFlowChildren(node: IrNode): IrNode[] {
  return node.children.filter((c) => !isAbsolute(c));
}

/** Two boxes overlap on the vertical axis (share a row band). */
function overlapsVertically(a: BoxRect, b: BoxRect): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Two boxes overlap on the horizontal axis (share a column band). */
function overlapsHorizontally(a: BoxRect, b: BoxRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}

/**
 * Infer a row-vs-column band from child box geometry (Locofy "infer flex intent from box geometry
 * when source CSS is dirty"). Children laid out in a horizontal band (boxes share a vertical span,
 * advancing in x) → `row`; a vertical band (share a horizontal span, advancing in y) → `column`.
 * Returns `null` when there are <2 boxed children to compare (caller falls back to a CSS signal).
 */
export function inferDirectionFromGeometry(children: IrNode[]): 'row' | 'column' | null {
  const boxed = children.filter((c) => c.box.width > 0 || c.box.height > 0);
  if (boxed.length < 2) return null;

  let rowVotes = 0;
  let colVotes = 0;
  for (let i = 1; i < boxed.length; i += 1) {
    const prev = boxed[i - 1] as IrNode;
    const cur = boxed[i] as IrNode;
    const dx = cur.box.x - prev.box.x;
    const dy = cur.box.y - prev.box.y;
    // Siblings sitting side-by-side (share a vertical band, advance in x) → a row.
    if (overlapsVertically(prev.box, cur.box) && dx > 0 && dx >= Math.abs(dy)) {
      rowVotes += 1;
    }
    // Siblings stacked (share a horizontal band, advance in y) → a column.
    else if (overlapsHorizontally(prev.box, cur.box) && dy > 0 && dy >= Math.abs(dx)) {
      colVotes += 1;
    } else if (dx > Math.abs(dy)) {
      rowVotes += 1;
    } else {
      colVotes += 1;
    }
  }
  if (rowVotes === 0 && colVotes === 0) return null;
  return rowVotes >= colVotes ? 'row' : 'column';
}

/**
 * Detect a TRUE 2D track grid (the only case CLASSIFY should label `grid`). A 2D grid has children
 * arranged in BOTH multiple rows AND multiple columns of ALIGNED boxes, OR an explicit
 * `grid-template-columns`/`-rows` that defines more than one track on each axis. A single row or a
 * single column of cells is NOT a grid (default to flex — authoring-contract §5.2 LAYOUT: grid is
 * raw strings only, no areas/place-items; a 1D layout misread as grid forces a fallback).
 *
 * Conservative: returns `true` only when the 2D structure is unambiguous.
 */
export function isTrueGrid(node: IrNode): boolean {
  // 1) Explicit grid with >1 track on BOTH axes.
  if (isGridDisplay(node.computed)) {
    const cols = countTracks(cv(node.computed, 'grid-template-columns'));
    const rows = countTracks(cv(node.computed, 'grid-template-rows'));
    if (cols >= 2 && rows >= 2) return true;
    // Explicit grid with multiple columns + enough children to wrap into >1 row.
    if (cols >= 2 && node.children.filter((c) => !isAbsolute(c)).length > cols) return true;
    // A single-track grid (1fr) is NOT a 2D grid → flex (no geometry fallback for 1-track grids).
    if (cols === 1 || rows === 1) return false;
    // Explicit grid display with no usable template (e.g. auto-flow only): fall through to geometry.
  }

  // 2) Geometry: children form >=2 distinct row bands AND >=2 distinct column bands of aligned boxes.
  const boxed = inFlowChildren(node).filter((c) => c.box.width > 0 && c.box.height > 0);
  if (boxed.length < 4) return false; // need at least a 2x2 to be a "true" grid
  const rowBands = distinctBands(boxed.map((c) => c.box.y));
  const colBands = distinctBands(boxed.map((c) => c.box.x));
  return rowBands >= 2 && colBands >= 2;
}

/** Count explicit tracks in a `grid-template-*` value (`none`/empty → 0). */
function countTracks(value: string): number {
  const v = value.trim();
  if (v === '' || v === 'none') return 0;
  // Strip bracketed line names, then count whitespace-separated track tokens.
  const stripped = v.replace(/\[[^\]]*\]/g, ' ').trim();
  if (stripped === '') return 0;
  return stripped.split(/\s+/).filter((t) => t !== '').length;
}

/** Count distinct alignment bands among a set of coordinates (tolerance 1px). */
function distinctBands(coords: number[]): number {
  const sorted = [...coords].sort((a, b) => a - b);
  let bands = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const c of sorted) {
    if (c - last > 1) {
      bands += 1;
      last = c;
    }
  }
  return bands;
}

/* ─────────────────────────── container test + main inference ────────────────────────────────── */

/**
 * Is this node a LAYOUT container worth inferring flex for? A container has >=2 in-flow children, OR
 * is an explicit flex/grid display with >=1 child, OR has any absolutely-positioned child to record.
 * A leaf, a text-only node, or a single styleless wrapper is NOT (returns `null` from `inferFlex`).
 */
function isLayoutContainer(node: IrNode): boolean {
  if (node.children.length === 0) return false;
  if (isFlexDisplay(node.computed) || isGridDisplay(node.computed)) return true;
  const inFlow = inFlowChildren(node);
  const hasAbsolute = node.children.length > inFlow.length;
  return inFlow.length >= 2 || (hasAbsolute && node.children.length >= 1);
}

/**
 * Map a computed `justify-content` / `align-items` value through to a Style-Schema-safe token. Returns
 * the raw computed token (lower-cased) so STYLE-EXTRACT can validate it against the live enum
 * (authoring-contract §5.2 ALIGNMENT); empty/`normal` defaults are dropped (not emitted).
 */
function alignToken(computed: ComputedStyleSet, prop: string): string | undefined {
  const v = cv(computed, prop);
  if (v === '' || v === 'normal' || v === 'auto') return undefined;
  return v;
}

/** A gap value worth recording (non-zero, finite). */
function gapToken(computed: ComputedStyleSet): string | undefined {
  // Prefer the shorthand `gap`; fall back to row/column-gap (use row-gap as the representative).
  const candidates = [cv(computed, 'gap'), cv(computed, 'row-gap'), cv(computed, 'column-gap')];
  for (const c of candidates) {
    if (c === '' || c === 'normal') continue;
    const first = c.split(/\s+/)[0];
    const n = first === undefined ? null : px(first);
    if (n === null) {
      // non-px gap (e.g. %, em) — still meaningful, record verbatim
      return c;
    }
    if (n > 0) return c;
  }
  return undefined;
}

/**
 * Infer the flex intent for a layout container (Locofy heuristics, SUPPLEMENT §C.2). Returns `null`
 * when `node` is NOT a layout container (leaf / text / single styleless wrapper).
 *
 * Direction: explicit `flex-direction` (`column`/`column-reverse` → column, else row) when the node
 * is `display:flex`; otherwise inferred from child box geometry (dirty marketing HTML).
 * Wrap: `flex-wrap:wrap|wrap-reverse` → `true`.
 * Justify/align: read from `justify-content`/`align-items` (validated downstream).
 * Gap: from `gap`/`row-gap`/`column-gap`.
 * fill_children: children with `flex:1`/`flex-grow>=1` (Locofy "Fill").
 * absolute_children: children with `position:absolute|fixed` (removed from flow → position variant).
 */
export function inferFlex(node: IrNode): FlexIntent | null {
  if (!isLayoutContainer(node)) return null;

  const explicitFlex = isFlexDisplay(node.computed);

  // Direction: explicit CSS first, then geometry, then default row.
  let direction: 'row' | 'column';
  if (explicitFlex) {
    const fd = cv(node.computed, 'flex-direction');
    direction = fd === 'column' || fd === 'column-reverse' ? 'column' : 'row';
  } else {
    direction = inferDirectionFromGeometry(inFlowChildren(node)) ?? 'row';
  }

  const fw = cv(node.computed, 'flex-wrap');
  const wrap = fw === 'wrap' || fw === 'wrap-reverse';

  const justify = alignToken(node.computed, 'justify-content');
  const align = alignToken(node.computed, 'align-items');
  const gap = gapToken(node.computed);

  const fill_children: string[] = [];
  const absolute_children: string[] = [];
  for (const child of node.children) {
    if (isAbsolute(child)) {
      absolute_children.push(child.source_path);
    } else if (isFillChild(child)) {
      fill_children.push(child.source_path);
    }
  }

  return {
    direction,
    wrap,
    fill_children,
    absolute_children,
    ...(justify !== undefined ? { justify } : {}),
    ...(align !== undefined ? { align } : {}),
    ...(gap !== undefined ? { gap } : {}),
  };
}
