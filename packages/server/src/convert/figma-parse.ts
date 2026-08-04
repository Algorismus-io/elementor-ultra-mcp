/**
 * Contract 18 §1-§3/§5 — the FIGMA-PARSE stage: Figma node JSON → IrNode forest in a
 * ParseResult-compatible envelope `{ir, doc_direction:'ltr', viewport_used: frameWidth,
 * raw_inner_markup:{}}`. Everything downstream — normalize → classify → map → style-extract →
 * assemble → gates → contract-17 integrity/verify — reuses the HTML pipeline UNCHANGED (the
 * `types.ts` IR seam is pre-envelope and DOM-free).
 *
 * PRINCIPLE (§0): Figma input is RICHER than HTML input — auto-layout, tokens and variants carry
 * designer intent the HTML path must infer. Where the designer declared layout (auto-layout), the
 * declaration is emitted as EXPLICIT `display:flex/grid` computed styles + flex/grid roles, which
 * the classifier honors ahead of its geometry heuristics — designer intent REPLACES flex-inference.
 * Where no auto-layout exists, plain boxes + geometry are emitted and the existing Locofy-style
 * inference does its normal job.
 *
 * HONESTY (F1): every Figma node lands in exactly ONE of `native | flattened | dropped+reason` —
 * never silently lost. The §3 flatten policy lives in `figma-flatten.ts`; flattened subtrees become
 * ONE e-image (`{node_id, render_node_id, reason, covers}` recorded in the report) whose PNG the
 * orchestrator renders via `FigmaPort.renderNodes` (URLs are injected through
 * `FigmaParseOptions.render_urls` — F3: temp URLs never persist, ASSEMBLE sideloads them).
 *
 * RESPONSIVE (§5): sibling frames named `<Name>/Desktop|Tablet|Mobile` (or width-recognizable
 * duplicates) are diffed by node correspondence into per-breakpoint `IrNode.responsive` overrides
 * (`responsive:'frames'`). ABSENT variant frames, a conservative heuristic adaptation (rows stack,
 * type scales) is applied and REPORTED as `responsive:'synthesized'` — never silently.
 *
 * SEMANTICS (§5): heading levels from type scale + layer names; buttons/links from prototype
 * actions + shape+text composition; forms are NOT inferred (pictures of forms stay pictures —
 * reported via `FIGMA_FORM_NOT_INFERRED`).
 *
 * PURE: no I/O, no network — the extraction client (`figma-client.ts`) fetches to file; this stage
 * consumes the loaded payloads. Deterministic: same `(nodeJson, opts)` → same output.
 */

import type {
  AnimationProbe,
  ComputedStyleSet,
  DetectedBehavior,
  IrNode,
  MediaRef,
  ParseResult,
  ParseWarning,
  SemanticRole,
  TextRun,
  TransitionProbe,
} from './types.js';
import {
  CONTAINER_NODE_TYPES,
  flattenVerdict,
  descendantIds,
  isVisible,
  rawBox,
  subtreeHasVisibleText,
  visibleEffects,
  visiblePaints,
  type FigmaColor,
  type FigmaFlattenMode,
  type FigmaPaint,
  type FigmaRawNode,
  type FigmaTypeStyle,
} from './figma-flatten.js';
import { isCatalogFamily, normalizeFamilyKey } from './figma-fonts-catalog.js';

/* ─────────────────────────── options / report types ─────────────────────────────────────────── */

/** Per-family availability (§5 / §7 `cli.mjs fonts`): natively enqueueable, site-installed, or absent. */
export type FigmaFontAvailability = 'google' | 'local' | 'missing';

/** Options for {@link figmaParse}. */
export interface FigmaParseOptions {
  /** The §3 flatten boundary (default `'balanced'`). */
  flatten?: FigmaFlattenMode;
  /** Primary frame node id (colon form) when the payload carries several top-level nodes. */
  node_id?: string;
  /** `imageRef → temp URL` map (GET_IMAGE_FILLS) — image fills become sideloadable `MediaRef`s. */
  image_fills?: Record<string, string>;
  /** `node id → temp render URL` map for flatten roots (RENDER_IMAGES_OF_FILE_NODES). */
  render_urls?: Record<string, string>;
  /** Site-installed (non-catalog) families — resolve to `'local'` instead of `'missing'`. */
  local_families?: string[];
  /** Apply the §5 heuristic mobile adaptation when no variant frames exist (default `true`). */
  synthesize_responsive?: boolean;
}

/** One §3 flatten decision: the subtree rooted at `node_id` becomes ONE rendered e-image. */
export interface FigmaFlattenRecord {
  /** The flatten ROOT (the only IR node emitted for the subtree). */
  node_id: string;
  /** The node the orchestrator renders as PNG (== `node_id`; recorded explicitly per §3). */
  render_node_id: string;
  reason: string;
  /** Descendant ids subsumed into the render (F1: accounted as flattened with their root). */
  covers: string[];
  /**
   * Render WITHOUT `use_absolute_bounds` (the frame clips children that escape its box — W18
   * pinstripes: absolute-bounds renders baked a 2132px overhang into a 23px band). Set for
   * clip-escaping fan-outs only; the overlapping-icon recipe keeps absolute bounds.
   */
  clip_render?: boolean;
}

/** One honestly-dropped node (F1). */
export interface FigmaDropRecord {
  node_id: string;
  reason: string;
}

/** One prototype interaction the front-end could not map (§2 honest drop — never silent). */
export interface FigmaInteractionDrop {
  node_id: string;
  trigger: string;
  action: string;
  reason: string;
}

/** The `figma:{…}` report section (§6 — rides next to the contract-17 coverage envelope). */
export interface FigmaReport {
  frame: { node_id: string; name: string; width: number; height: number };
  /** Per-family availability for every family the frame's text uses. */
  fonts: Record<string, FigmaFontAvailability>;
  /** F1 bucket: converted-native node ids (includes nodes merged into a folded button). */
  native: string[];
  /** F1 bucket: §3 flatten records. */
  flattened: FigmaFlattenRecord[];
  /** F1 bucket: honest drops. */
  dropped: FigmaDropRecord[];
  /** §5: where the breakpoint story came from. */
  responsive: 'frames' | 'synthesized';
  /** The matched variant frames (`responsive:'frames'` only). */
  responsive_frames?: Partial<Record<'tablet' | 'mobile', string>>;
  /** Prototype interactions honestly dropped (§2: "honest-drop the rest"). */
  interaction_drops: FigmaInteractionDrop[];
}

/**
 * The figma-parse output: the frozen {@link ParseResult} envelope (downstream stages consume it
 * unchanged) + the `figma` report section.
 */
export interface FigmaParseResult extends ParseResult {
  doc_direction: 'ltr';
  figma: FigmaReport;
}

/* ─────────────────────────── payload mining (defensive raw shapes) ──────────────────────────── */

/** One top-level frame entry mined from the input payload. */
interface FrameEntry {
  node: FigmaRawNode;
}

/**
 * Mine the top-level node documents out of the supported payload shapes: a `GET_FILE_NODES`-style
 * `{nodes: {"id": {document}}}` response (raw.json), a single `{document}` wrapper, or a bare node.
 * Live-verified extras (Composio 2026-06-11): the execute envelope (`{data, raw_data, simplified}`
 * wrappers around any shape above) and the `/files` full-file shape, whose DOCUMENT/CANVAS roots
 * descend so the page FRAMES become the top-level entries.
 */
function extractTopNodes(nodeJson: unknown): FrameEntry[] {
  if (nodeJson === null || typeof nodeJson !== 'object') return [];
  const rec = nodeJson as Record<string, unknown>;

  const nodes = rec['nodes'];
  if (nodes !== null && typeof nodes === 'object' && !Array.isArray(nodes)) {
    const out: FrameEntry[] = [];
    for (const entry of Object.values(nodes as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object') continue;
      const doc = (entry as Record<string, unknown>)['document'];
      if (isRawNode(doc)) out.push(...descendToFrames(doc));
    }
    return out;
  }

  const doc = rec['document'];
  if (isRawNode(doc)) return descendToFrames(doc);
  if (isRawNode(nodeJson)) return descendToFrames(nodeJson as FigmaRawNode);

  // The Composio execute envelope: `{data: {…}}` / `{raw_data: {…}}` around any shape above
  // (`raw_data` first — when populated it is the raw API response; `data` may be simplified).
  for (const key of ['raw_data', 'data']) {
    const inner = rec[key];
    if (inner !== null && typeof inner === 'object') {
      const out = extractTopNodes(inner);
      if (out.length > 0) return out;
    }
  }
  return [];
}

/**
 * A DOCUMENT/CANVAS root (the `/files` full-file shape) is never itself a convertible frame —
 * descend to the page frames under it. Any other node type IS the entry (unchanged behavior).
 */
function descendToFrames(node: FigmaRawNode): FrameEntry[] {
  if (node.type === 'DOCUMENT') {
    return (node.children ?? []).flatMap((child) => descendToFrames(child));
  }
  if (node.type === 'CANVAS') {
    return (node.children ?? []).filter((child) => isRawNode(child)).map((child) => ({ node: child }));
  }
  return [{ node }];
}

/** Structural guard for a raw Figma node. */
function isRawNode(value: unknown): value is FigmaRawNode {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['id'] === 'string' &&
    typeof (value as Record<string, unknown>)['type'] === 'string'
  );
}

/** Every node id in the payload (all top-level documents, full subtrees) — the F1 universe. */
export function collectFigmaNodeIds(nodeJson: unknown): string[] {
  const out: string[] = [];
  for (const entry of extractTopNodes(nodeJson)) {
    const walk = (n: FigmaRawNode): void => {
      out.push(n.id);
      for (const c of n.children ?? []) walk(c);
    };
    walk(entry.node);
  }
  return out;
}

/** Find a raw node by id across the payload's documents (hover-variant destinations). */
function findRawById(entries: FrameEntry[], id: string): FigmaRawNode | undefined {
  const walk = (n: FigmaRawNode): FigmaRawNode | undefined => {
    if (n.id === id) return n;
    for (const c of n.children ?? []) {
      const found = walk(c);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const entry of entries) {
    const found = walk(entry.node);
    if (found !== undefined) return found;
  }
  return undefined;
}

/* ─────────────────────────── css value helpers ──────────────────────────────────────────────── */

/** `n` → `'12px'` (rounded to 2 decimals, trailing zeros stripped). */
function px(n: number): string {
  return `${String(Math.round(n * 100) / 100)}px`;
}

/** Figma 0..1 channels (+ paint/extra opacity) → `rgb()`/`rgba()`. */
function cssColor(c: FigmaColor, extraOpacity = 1): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = Math.round(c.a * extraOpacity * 1000) / 1000;
  return a >= 1 ? `rgb(${String(r)}, ${String(g)}, ${String(b)})` : `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(a)})`;
}

/** The TOP (last visible) paint of a fill/stroke list, optionally filtered by type. */
function topPaint(paints: FigmaPaint[] | undefined, type?: string): FigmaPaint | undefined {
  const vis = visiblePaints(paints).filter((p) => type === undefined || p.type === type);
  return vis[vis.length - 1];
}

/** CSS gradient string for a Figma gradient paint (`null` for non-gradient paints). */
function gradientCss(paint: FigmaPaint): string | null {
  const stops = paint.gradientStops;
  if (stops === undefined || stops.length === 0) return null;
  const stopCss = stops
    .map((s) => `${cssColor(s.color, paint.opacity ?? 1)} ${String(Math.round(s.position * 10000) / 100)}%`)
    .join(', ');
  if (paint.type === 'GRADIENT_LINEAR') {
    const h = paint.gradientHandlePositions ?? [];
    let angle = 180; // CSS default: to bottom.
    if (h.length >= 2) {
      const dx = (h[1] as { x: number }).x - (h[0] as { x: number }).x;
      const dy = (h[1] as { y: number }).y - (h[0] as { y: number }).y;
      angle = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
    }
    return `linear-gradient(${String(angle)}deg, ${stopCss})`;
  }
  if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
    return `radial-gradient(${stopCss})`;
  }
  if (paint.type === 'GRADIENT_ANGULAR') {
    return `conic-gradient(${stopCss})`;
  }
  return null;
}

/* ─────────────────────────── style builders (§2 mapping rows) ───────────────────────────────── */

/** fills → `background-color`/`background-image` (+ the top visible IMAGE fill, for MediaRef). */
function fillStyles(node: FigmaRawNode): { computed: ComputedStyleSet; imageFill?: FigmaPaint } {
  const computed: ComputedStyleSet = {};
  const solid = topPaint(node.fills, 'SOLID');
  if (solid?.color !== undefined) {
    computed['background-color'] = cssColor(solid.color, solid.opacity ?? 1);
  }
  const gradient = visiblePaints(node.fills)
    .filter((p) => p.type.startsWith('GRADIENT_'))
    .pop();
  if (gradient !== undefined) {
    const css = gradientCss(gradient);
    if (css !== null) computed['background-image'] = css;
  }
  const image = topPaint(node.fills, 'IMAGE');
  if (image !== undefined) {
    // All background images default to cover — avoids stretching/whitespace for any scaleMode.
    // FIT → contain (designer explicitly chose letterbox); TILE → repeat; everything else → cover.
    if (image.scaleMode === 'FIT') computed['background-size'] = 'contain';
    else if (image.scaleMode === 'TILE') computed['background-repeat'] = 'repeat';
    else computed['background-size'] = 'cover';
    if (image.scaleMode !== 'TILE') {
      computed['background-repeat'] = 'no-repeat';
      computed['background-position'] = 'center center';
    }
    return { computed, imageFill: image };
  }
  return { computed };
}

/** strokes → border longhands (mirrors the HTML pick: 4 widths + top-style + color). */
function strokeStyles(node: FigmaRawNode): ComputedStyleSet {
  const computed: ComputedStyleSet = {};
  const stroke = topPaint(node.strokes, 'SOLID');
  if (stroke?.color === undefined) return computed;
  const w = node.individualStrokeWeights;
  const weight = node.strokeWeight ?? 1;
  computed['border-top-width'] = px(w?.top ?? weight);
  computed['border-right-width'] = px(w?.right ?? weight);
  computed['border-bottom-width'] = px(w?.bottom ?? weight);
  computed['border-left-width'] = px(w?.left ?? weight);
  computed['border-top-style'] = 'solid';
  computed['border-color'] = cssColor(stroke.color, stroke.opacity ?? 1);
  return computed;
}

/** effects → `box-shadow` (+ `filter: blur(…)` always for simple shapes, or in `minimal` mode). */
function effectStyles(node: FigmaRawNode, mode: FigmaFlattenMode): ComputedStyleSet {
  const computed: ComputedStyleSet = {};
  const shadows = visibleEffects(node)
    .filter((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
    .map((e) => {
      const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
      const color = e.color !== undefined ? cssColor(e.color) : 'rgba(0, 0, 0, 0.25)';
      return `${inset}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.radius ?? 0)} ${px(e.spread ?? 0)} ${color}`;
    });
  if (shadows.length > 0) computed['box-shadow'] = shadows.join(', ');
  // Simple shapes (RECT/ELLIPSE, no image fill): decorative glows — emit native CSS blur.
  const isSimpleShape =
    (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') &&
    !visiblePaints(node.fills).some((p) => p.type === 'IMAGE');
  // Auto-layout containers with BACKGROUND_BLUR build natively (see flattenVerdict exemption):
  // emit backdrop-filter so the text panel gets the frosted glass effect directly on it, not on
  // a separate overlay div.
  const isBackdropContainer =
    typeof node.layoutMode === 'string' &&
    node.layoutMode !== 'NONE' &&
    visibleEffects(node).some((e) => e.type === 'BACKGROUND_BLUR');
  if (mode === 'minimal' || isSimpleShape || isBackdropContainer) {
    const blur = visibleEffects(node).find((e) => e.type === 'LAYER_BLUR');
    if (blur !== undefined) {
      computed['filter'] = `blur(${px(blur.radius ?? 0)})`;
      if (isSimpleShape) delete computed['box-shadow'];
    }
    const backdrop = visibleEffects(node).find((e) => e.type === 'BACKGROUND_BLUR');
    if (backdrop !== undefined) {
      computed['backdrop-filter'] = `blur(${px(backdrop.radius ?? 0)})`;
      if (isSimpleShape) delete computed['box-shadow'];
    }
  }
  return computed;
}

/** cornerRadius / rectangleCornerRadii → border-radius longhands (`'50%'` for ellipses).
 * `frameWidth`: when provided, large radii (>8px) are emitted as `min(Xpx, Xvw)` so they scale
 * proportionally on narrow viewports instead of overflowing the element. */
function radiusStyles(node: FigmaRawNode, frameWidth?: number): ComputedStyleSet {
  const computed: ComputedStyleSet = {};
  if (node.type === 'ELLIPSE') {
    for (const corner of RADIUS_PROPS) computed[corner] = '50%';
    return computed;
  }
  const rCss = (r: number): string => {
    if (frameWidth !== undefined && frameWidth > 0 && r > 8) {
      const vwVal = ((r / frameWidth) * 100).toFixed(2);
      return `min(${px(r)}, ${vwVal}vw)`;
    }
    return px(r);
  };
  const radii = node.rectangleCornerRadii;
  if (radii !== undefined && radii.length === 4) {
    RADIUS_PROPS.forEach((prop, i) => {
      const r = radii[i] ?? 0;
      if (r > 0) computed[prop] = rCss(r);
    });
    return computed;
  }
  if (node.cornerRadius !== undefined && node.cornerRadius > 0) {
    for (const corner of RADIUS_PROPS) computed[corner] = rCss(node.cornerRadius);
  }
  return computed;
}

const RADIUS_PROPS = [
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const;

/** Figma axis-align → CSS keyword. */
function alignKeyword(value: string | undefined): string {
  switch (value) {
    case 'CENTER':
      return 'center';
    case 'MAX':
      return 'flex-end';
    case 'SPACE_BETWEEN':
      return 'space-between';
    case 'BASELINE':
      return 'baseline';
    default:
      return 'flex-start';
  }
}

/**
 * Auto-layout → explicit flex/grid computed styles (THE designer-intent row: the classifier's
 * explicit-display check honors these ahead of geometry inference). Padding longhands are ALWAYS
 * emitted (even `0px`) — designer-declared zero padding must override e-flexbox's intrinsic 10px.
 */
function autoLayoutStyles(node: FigmaRawNode): ComputedStyleSet {
  const computed: ComputedStyleSet = {};
  if (node.layoutMode === 'GRID') {
    computed['display'] = 'grid';
    const cols = typeof node['gridColumnCount'] === 'number' ? node['gridColumnCount'] : 0;
    if (cols > 0) computed['grid-template-columns'] = `repeat(${String(cols)}, minmax(0, 1fr))`;
  } else {
    computed['display'] = 'flex';
    computed['flex-direction'] = node.layoutMode === 'VERTICAL' ? 'column' : 'row';
  }
  const justify = alignKeyword(node.primaryAxisAlignItems);
  computed['justify-content'] = justify;
  // align-items: only omit the default when it doesn't matter to preserve the natural CSS.
  // HORIZONTAL flex: CSS default 'stretch' = all children grow to equal row height — correct.
  //   Do NOT emit flex-start; it would collapse card heights in multi-column card rows.
  // VERTICAL flex: CSS default 'stretch' = children span the FULL container width.
  //   Figma's actual default is to hug the child's own width. Emit flex-start to match.
  if (node.counterAxisAlignItems !== undefined) {
    computed['align-items'] = alignKeyword(node.counterAxisAlignItems);
  } else if (node.layoutMode === 'VERTICAL') {
    computed['align-items'] = 'flex-start';
  }
  if (node.layoutWrap === 'WRAP') {
    computed['flex-wrap'] = 'wrap';
    if (node.counterAxisSpacing !== undefined) computed['row-gap'] = px(node.counterAxisSpacing);
  }
  if (justify !== 'space-between') computed['gap'] = px(node.itemSpacing ?? 0);
  computed['padding-top'] = px(node.paddingTop ?? 0);
  computed['padding-right'] = px(node.paddingRight ?? 0);
  computed['padding-bottom'] = px(node.paddingBottom ?? 0);
  computed['padding-left'] = px(node.paddingLeft ?? 0);
  return computed;
}

/** Is the node an auto-layout container? */
function isAutoLayout(node: FigmaRawNode): boolean {
  return typeof node.layoutMode === 'string' && node.layoutMode !== 'NONE';
}

/**
 * Child-side sizing intent inside an auto-layout parent: FILL on the parent's primary axis →
 * `flex-grow:1`; FILL on the counter axis → `align-self:stretch`; `layoutPositioning:'ABSOLUTE'` →
 * absolute offsets relative to the parent box.
 */
function childSizingStyles(node: FigmaRawNode, parent: FigmaRawNode | undefined): ComputedStyleSet {
  const computed: ComputedStyleSet = {};
  if (parent === undefined) {
    return computed;
  }
  if (!isAutoLayout(parent)) {
    // NONE-layout parent: the canvas truth is hand-placed geometry → absolute offsets relative
    // to the parent box (which carries `position:relative`). Before W18 these children carried
    // NO placement and reflowed into vertical stacks (page 3282: 14,485px vs the 6,225px frame).
    const pb = rawBox(parent);
    const b = rawBox(node);
    computed['position'] = 'absolute';
    computed['top'] = px(b.y - pb.y);
    computed['left'] = px(b.x - pb.x);
    if (b.width > 0 && node.type !== 'TEXT') {
      // Absolute boxes shrink-wrap — the canvas width is explicit (clamped like every fixed
      // width). TEXT keeps its own wrap semantics (textAutoResize → max-width, never width).
      computed['width'] = px(b.width);
      computed['max-width'] = '100%';
    }
    return computed;
  }
  if (node.layoutPositioning === 'ABSOLUTE') {
    const pb = rawBox(parent);
    const b = rawBox(node);
    computed['position'] = 'absolute';
    computed['top'] = px(b.y - pb.y);
    computed['left'] = px(b.x - pb.x);
    return computed;
  }
  const horizontalPrimary = parent.layoutMode === 'HORIZONTAL';
  const fillH = node.layoutSizingHorizontal === 'FILL' || (node.layoutGrow ?? 0) > 0;
  const fillV = node.layoutSizingVertical === 'FILL';
  if ((horizontalPrimary && fillH) || (!horizontalPrimary && fillV)) {
    computed['flex-grow'] = '1';
    // Horizontal FILL: without an explicit basis the child's content size dominates (a 1024px img
    // wrapper absorbs all space). width:100% + min-width:0 lets flex distribute space equally
    // when multiple FILL siblings share the row (each shrinks to its fair share).
    if (horizontalPrimary && fillH) {
      computed['width'] = '100%';
      computed['min-width'] = '0';
    }
  }
  if ((horizontalPrimary && fillV) || (!horizontalPrimary && fillH)) computed['align-self'] = 'stretch';
  if (node.layoutAlign === 'STRETCH' && computed['align-self'] === undefined) {
    computed['align-self'] = 'stretch';
  }
  return computed;
}

/* ─────────────────────────── text mapping (§2 TEXT row + §5 heading semantics) ──────────────── */

/** Figma `textAlignHorizontal` → CSS. */
function textAlignCss(value: string | undefined): string | undefined {
  switch (value) {
    case 'CENTER':
      return 'center';
    case 'RIGHT':
      return 'right';
    case 'JUSTIFIED':
      return 'justify';
    case 'LEFT':
      return 'left';
    default:
      return undefined;
  }
}

/** A type style → computed typography props (+ `color` from the style/node fills). */
function textStyles(style: FigmaTypeStyle | undefined, nodeFills: FigmaPaint[] | undefined): ComputedStyleSet {
  const computed: ComputedStyleSet = {};
  if (style === undefined) return computed;
  if (style.fontFamily !== undefined) computed['font-family'] = style.fontFamily;
  if (style.fontSize !== undefined) computed['font-size'] = px(style.fontSize);
  if (style.fontWeight !== undefined) computed['font-weight'] = String(style.fontWeight);
  if (style.italic === true) computed['font-style'] = 'italic';
  if (style.lineHeightPx !== undefined) computed['line-height'] = px(style.lineHeightPx);
  if (style.letterSpacing !== undefined && style.letterSpacing !== 0) {
    computed['letter-spacing'] = px(style.letterSpacing);
  }
  const align = textAlignCss(style.textAlignHorizontal);
  if (align !== undefined) computed['text-align'] = align;
  if (style.textCase === 'UPPER') computed['text-transform'] = 'uppercase';
  else if (style.textCase === 'LOWER') computed['text-transform'] = 'lowercase';
  else if (style.textCase === 'TITLE') computed['text-transform'] = 'capitalize';
  if (style.textDecoration === 'UNDERLINE') computed['text-decoration'] = 'underline';
  else if (style.textDecoration === 'STRIKETHROUGH') computed['text-decoration'] = 'line-through';
  const fill = topPaint(style.fills ?? nodeFills, 'SOLID');
  if (fill?.color !== undefined) computed['color'] = cssColor(fill.color, fill.opacity ?? 1);
  return computed;
}

/** Layer names that declare heading intent. */
const HEADING_NAME_RE = /head(?:ing|line)|\btitle\b/i;

/**
 * §5 heading semantics: level from the TYPE SCALE, refined by the LAYER NAME. An explicit `h1`-`h6`
 * token in the layer name wins; otherwise the scale maps ≥40 → h1, ≥32 → h2, ≥24 → h3, and a
 * heading-named layer ≥18 → h4. Everything else is a paragraph.
 */
export function headingTagFor(fontSize: number | undefined, layerName: string | undefined): string {
  const name = layerName ?? '';
  const explicit = /(?:^|[^a-z0-9])h([1-6])(?:[^a-z0-9]|$)/i.exec(name);
  if (explicit !== null) return `h${explicit[1] as string}`;
  const size = fontSize ?? 0;
  if (size >= 40) return 'h1';
  if (size >= 32) return 'h2';
  if (size >= 24) return 'h3';
  if (size >= 18 && HEADING_NAME_RE.test(name)) return 'h4';
  return 'p';
}

/**
 * `characters` + `characterStyleOverrides` + `styleOverrideTable` → `TextRun[]` (§2 TEXT row).
 * Hyperlink overrides become `linkHref`; underline/bold/italic deltas become inline tags; a run
 * fill color differing from the base color rides `run.color` (the contract-17 #8 accent leg).
 */
function figmaTextRuns(
  node: FigmaRawNode,
  warn: (code: string, message: string) => void,
): { runs: TextRun[]; families: string[] } {
  const text = node.characters ?? '';
  const families: string[] = [];
  if (node.style?.fontFamily !== undefined) families.push(node.style.fontFamily);
  if (text === '') return { runs: [], families };

  const overrides = node.characterStyleOverrides ?? [];
  const table = node.styleOverrideTable ?? {};
  const baseColor = textStyles(node.style, node.fills)['color'];
  const baseWeight = node.style?.fontWeight ?? 400;

  // Group consecutive characters sharing the same override key (0/absent = base style).
  const runs: TextRun[] = [];
  let start = 0;
  while (start < text.length) {
    const key = overrides[start] ?? 0;
    let end = start + 1;
    while (end < text.length && (overrides[end] ?? 0) === key) end += 1;
    const slice = text.slice(start, end);
    const run: TextRun = { text: slice, inlineTags: [] };
    if (key !== 0) {
      const ov = table[String(key)];
      if (ov !== undefined) {
        if (ov.fontFamily !== undefined) families.push(ov.fontFamily);
        const link = ov.hyperlink;
        if (link !== null && link !== undefined) {
          if (link.type === 'URL' && link.url !== undefined) {
            run.linkHref = link.url;
          } else {
            warn(
              'FIGMA_NODE_HYPERLINK_DROPPED',
              `text node ${node.id}: hyperlink to Figma node ${link.nodeID ?? '?'} has no web ` +
                'destination — dropped (in-file node links are a prototype concern).',
            );
          }
        }
        if (ov.textDecoration === 'UNDERLINE' && run.linkHref === undefined) {
          run.inlineTags.push('u');
        }
        if ((ov.fontWeight ?? baseWeight) >= 700 && baseWeight < 700) run.inlineTags.push('strong');
        if (ov.italic === true && node.style?.italic !== true) run.inlineTags.push('em');
        const ovColor = textStyles(ov, undefined)['color'];
        if (ovColor !== undefined && ovColor !== baseColor) run.color = ovColor;
      }
    }
    // A base-style hyperlink on the whole TEXT node applies to every run without its own.
    const baseLink = node.style?.hyperlink;
    if (
      run.linkHref === undefined &&
      baseLink !== null &&
      baseLink !== undefined &&
      baseLink.type === 'URL' &&
      baseLink.url !== undefined
    ) {
      run.linkHref = baseLink.url;
    }
    runs.push(run);
    start = end;
  }
  return { runs, families };
}

/* ─────────────────────────── buttons (§5: prototype actions + shape+text) ───────────────────── */

/** Layer-name button declaration (`Button` / `btn` / `CTA` as a standalone token). */
const BUTTON_NAME_RE = /(?:^|[^a-z])(?:button|btn|cta)(?:[^a-z]|$)/i;

/** Click-ish prototype triggers. */
const CLICK_TRIGGERS: ReadonlySet<string> = new Set(['ON_CLICK', 'ON_PRESS', 'MOUSE_UP']);

/** The first click action on the node or any descendant: a web URL or an in-file navigation. */
function findClickAction(
  node: FigmaRawNode,
): { kind: 'url'; url: string } | { kind: 'navigate'; destination: string } | undefined {
  const own = (node.interactions ?? []).flatMap((i) =>
    CLICK_TRIGGERS.has(i.trigger?.type ?? '') ? (i.actions ?? []) : [],
  );
  for (const action of own) {
    if (action.type === 'URL' && typeof action.url === 'string') {
      return { kind: 'url', url: action.url };
    }
    if (
      action.type === 'NODE' &&
      (action.navigation === 'NAVIGATE' || action.navigation === 'SCROLL_TO') &&
      typeof action.destinationId === 'string'
    ) {
      return { kind: 'navigate', destination: action.destinationId };
    }
  }
  for (const child of node.children ?? []) {
    if (!isVisible(child)) continue;
    const found = findClickAction(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * §5 button composition: a container whose VISIBLE leaves are all TEXT, declared a button by its
 * layer name or by carrying a click prototype action. Folded into ONE leaf `<a class="btn">` node
 * (paint merged depth-first so the deepest painted wrapper wins; typography from the first TEXT).
 */
function isButtonCandidate(node: FigmaRawNode): boolean {
  if (!CONTAINER_NODE_TYPES.has(node.type)) return false;
  if (!subtreeHasVisibleText(node)) return false;
  const leaves: FigmaRawNode[] = [];
  const walk = (n: FigmaRawNode): void => {
    const kids = (n.children ?? []).filter((c) => isVisible(c));
    if (kids.length === 0) {
      leaves.push(n);
      return;
    }
    for (const k of kids) walk(k);
  };
  walk(node);
  if (leaves.length === 0 || !leaves.every((l) => l.type === 'TEXT')) return false;
  return BUTTON_NAME_RE.test(node.name ?? '') || findClickAction(node) !== undefined;
}

/* ─────────────────────────── the parse context ──────────────────────────────────────────────── */

interface ParseCtx {
  mode: FigmaFlattenMode;
  imageFills: Record<string, string>;
  renderUrls: Record<string, string>;
  localFamilies: Set<string>;
  entries: FrameEntry[];
  frameBox: { x: number; y: number; width: number; height: number };
  warnings: ParseWarning[];
  native: string[];
  flattened: FigmaFlattenRecord[];
  dropped: FigmaDropRecord[];
  interactionDrops: FigmaInteractionDrop[];
  fonts: Map<string, FigmaFontAvailability>;
  /** raw figma id → emitted IR node (variant correspondence + tests). */
  byId: Map<string, IrNode>;
}

/** Record a warning. */
function warnCtx(ctx: ParseCtx, sourceId: string | undefined, code: string, message: string): void {
  ctx.warnings.push({
    ...(sourceId !== undefined ? { source_path: `figma:${sourceId}` } : {}),
    code,
    message,
  });
}

/** Drop a node AND its whole subtree (F1: every descendant gets a reason). */
function dropSubtree(ctx: ParseCtx, node: FigmaRawNode, reason: string): void {
  ctx.dropped.push({ node_id: node.id, reason });
  for (const id of descendantIds(node)) {
    ctx.dropped.push({ node_id: id, reason: `inside dropped node ${node.id} (${reason})` });
  }
}

/** Register a family in the availability map. */
function registerFamily(ctx: ParseCtx, family: string): void {
  if (ctx.fonts.has(family)) return;
  let availability: FigmaFontAvailability = 'missing';
  if (isCatalogFamily(family)) availability = 'google';
  else if (ctx.localFamilies.has(normalizeFamilyKey(family))) availability = 'local';
  ctx.fonts.set(family, availability);
}

/** Box relative to the frame origin (rounded to 2dp). */
function relBox(node: FigmaRawNode, frame: ParseCtx['frameBox']): IrNode['box'] {
  const b = rawBox(node);
  const round = (n: number): number => Math.round(n * 100) / 100;
  return {
    x: round(b.x - frame.x),
    y: round(b.y - frame.y),
    width: round(b.width),
    height: round(b.height),
  };
}

/** Bare IR node skeleton. */
function irNode(
  ctx: ParseCtx,
  raw: FigmaRawNode,
  tag: string,
  role: SemanticRole,
  computed: ComputedStyleSet,
): IrNode {
  const node: IrNode = {
    source_path: `figma:${raw.id}`,
    tag,
    role,
    box: relBox(raw, ctx.frameBox),
    computed,
    responsive: {},
    attrs: { 'data-figma-name': raw.name ?? '' },
    textRuns: [],
    children: [],
  };
  ctx.byId.set(raw.id, node);
  return node;
}

/* ─────────────────────────── prototype interactions (§2) ────────────────────────────────────── */

/** Hover-comparable visual styles of a raw node (for the variant-swap diff). */
function hoverComparableStyles(raw: FigmaRawNode, mode: FigmaFlattenMode): ComputedStyleSet {
  const out: ComputedStyleSet = {
    ...fillStyles(raw).computed,
    ...strokeStyles(raw),
    ...effectStyles(raw, mode),
    ...radiusStyles(raw),
  };
  if (raw.opacity !== undefined && raw.opacity < 1) {
    out['opacity'] = String(Math.round(raw.opacity * 1000) / 1000);
  }
  if (raw.type === 'TEXT') Object.assign(out, textStyles(raw.style, raw.fills));
  return out;
}

/** Shallow `a → b` delta (props whose value differs or only exists in `b`). */
function styleDelta(a: ComputedStyleSet, b: ComputedStyleSet): ComputedStyleSet {
  const delta: ComputedStyleSet = {};
  for (const [prop, value] of Object.entries(b)) {
    if (a[prop] !== value) delta[prop] = value;
  }
  for (const prop of Object.keys(a)) {
    if (b[prop] === undefined) delta[prop] = '';
  }
  return delta;
}

/**
 * §2 prototype-interaction mapping, applied to a NATIVE node:
 *  - ON_CLICK + URL / NAVIGATE → link (tag `a` + `href`) — tier-1 native;
 *  - ON_HOVER variant swap with the destination IN the payload → `hoverComputed` delta +
 *    `transitionProbe` + a `hover-effect` DetectedBehavior (tier-2 downstream);
 *  - AFTER_TIMEOUT DISSOLVE/SMART_ANIMATE → `animationProbe` + `entrance-animation` (tier-2 fade);
 *  - everything else → HONEST DROP (`interaction_drops[]` + warning). Silence is forbidden.
 */
function applyInteractions(ctx: ParseCtx, raw: FigmaRawNode, node: IrNode): void {
  for (const interaction of raw.interactions ?? []) {
    const trigger = interaction.trigger?.type ?? 'UNKNOWN';
    for (const action of interaction.actions ?? []) {
      const actionLabel = `${action.type ?? '?'}${action.navigation !== undefined ? `/${action.navigation}` : ''}`;
      if (CLICK_TRIGGERS.has(trigger)) {
        if (action.type === 'URL' && typeof action.url === 'string') {
          node.tag = node.tag === 'div' ? 'a' : node.tag;
          node.attrs['href'] = action.url;
          continue;
        }
        if (
          action.type === 'NODE' &&
          (action.navigation === 'NAVIGATE' || action.navigation === 'SCROLL_TO') &&
          typeof action.destinationId === 'string'
        ) {
          node.tag = node.tag === 'div' ? 'a' : node.tag;
          node.attrs['href'] = `#figma-${action.destinationId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
          node.attrs['data-figma-destination'] = action.destinationId;
          continue;
        }
        dropInteraction(ctx, raw, trigger, actionLabel, 'click action has no mappable destination');
        continue;
      }
      if (trigger === 'ON_HOVER' || trigger === 'MOUSE_ENTER') {
        if (action.type === 'NODE' && typeof action.destinationId === 'string') {
          const dest = findRawById(ctx.entries, action.destinationId);
          if (dest === undefined) {
            dropInteraction(
              ctx,
              raw,
              trigger,
              actionLabel,
              `hover variant target ${action.destinationId} is outside the extraction — no prop diff possible`,
            );
            warnCtx(
              ctx,
              raw.id,
              'FIGMA_HOVER_TARGET_MISSING',
              `hover variant target ${action.destinationId} not in the payload; interaction dropped honestly.`,
            );
            continue;
          }
          const delta = styleDelta(hoverComparableStyles(raw, ctx.mode), hoverComparableStyles(dest, ctx.mode));
          const hoverOverrides: ComputedStyleSet = {};
          for (const [prop, value] of Object.entries(delta)) {
            if (value !== '') hoverOverrides[prop] = value;
          }
          if (Object.keys(hoverOverrides).length > 0) {
            node.hoverComputed = { ...(node.hoverComputed ?? {}), ...hoverOverrides };
          }
          const duration = action.transition?.duration;
          const probe: TransitionProbe = {
            property: Object.keys(delta).join(', ') || 'all',
            duration: `${String(duration ?? 0.2)}s`,
            easing: 'ease',
          };
          node.transitionProbe = probe;
          const behavior: DetectedBehavior = {
            kind: 'hover-effect',
            confidence: 'high',
            evidence: [`figma:trigger=${trigger}`, `figma:action=${actionLabel}→${action.destinationId}`],
            nodeIds: [node.source_path],
          };
          node.behaviors = [...(node.behaviors ?? []), behavior];
          continue;
        }
        dropInteraction(ctx, raw, trigger, actionLabel, 'hover action is not a variant swap');
        continue;
      }
      if (
        trigger === 'AFTER_TIMEOUT' &&
        (action.transition?.type === 'DISSOLVE' || action.transition?.type === 'SMART_ANIMATE')
      ) {
        const duration = action.transition.duration ?? 0.3;
        const probe: AnimationProbe = {
          name: 'figma-appear',
          duration: `${String(duration)}s`,
          delay: `${String(interaction.trigger?.timeout ?? 0)}s`,
          easing: 'ease',
          keyframeProps: ['opacity'],
          opacity: { from: 0, to: 1 },
        };
        node.animationProbe = probe;
        const behavior: DetectedBehavior = {
          kind: 'entrance-animation',
          confidence: 'medium',
          evidence: [`figma:trigger=${trigger}`, `figma:transition=${action.transition.type ?? '?'}`],
          nodeIds: [node.source_path],
        };
        node.behaviors = [...(node.behaviors ?? []), behavior];
        continue;
      }
      dropInteraction(
        ctx,
        raw,
        trigger,
        actionLabel,
        'trigger/action pair has no web mapping (drag/smart-animate morphs/multi-screen flows are locked non-goals)',
      );
    }
  }
}

/** Record one honest interaction drop (+ warning). */
function dropInteraction(
  ctx: ParseCtx,
  raw: FigmaRawNode,
  trigger: string,
  action: string,
  reason: string,
): void {
  ctx.interactionDrops.push({ node_id: raw.id, trigger, action, reason });
  warnCtx(
    ctx,
    raw.id,
    'FIGMA_INTERACTION_DROPPED',
    `prototype interaction ${trigger}/${action} on ${raw.id} dropped: ${reason}`,
  );
}

/* ─────────────────────────── per-node visit (the F1 walk) ───────────────────────────────────── */

/** Returns the trimmed text of the first visible TEXT node in a subtree (DFS), or null. */
function findFirstVisibleText(node: FigmaRawNode): string | null {
  if (!isVisible(node)) return null;
  if (node.type === 'TEXT') {
    const t = (node.characters ?? '').trim();
    return t !== '' ? t : null;
  }
  for (const child of node.children ?? []) {
    const found = findFirstVisibleText(child);
    if (found !== null) return found;
  }
  return null;
}

/** Better alt text for flattened nodes: logo → "Site Logo"; generic "Frame N" → inner text. */
function flattenAlt(raw: FigmaRawNode): string {
  const name = raw.name ?? '';
  if (/\blogo\b/i.test(name)) return 'Site Logo';
  if (/^\s*(frame|group|component|instance|section)\s*\d+\s*$/i.test(name)) {
    const text = findFirstVisibleText(raw);
    if (text !== null) return text.slice(0, 80);
  }
  return name;
}

/** Sizing emission for containers/boxes (root frames never get a width — full-bleed). */
function sizingStyles(
  ctx: ParseCtx,
  raw: FigmaRawNode,
  parent: FigmaRawNode | undefined,
  isRoot: boolean,
): ComputedStyleSet {
  const computed: ComputedStyleSet = {};
  const b = rawBox(raw);
  const hasChildren = (raw.children ?? []).length > 0;

  if (isRoot) {
    if (b.height > 0) computed['min-height'] = px(b.height);
    return computed;
  }

  const inAutoParent = parent !== undefined && isAutoLayout(parent);
  const widthFixed = inAutoParent
    ? raw.layoutSizingHorizontal === 'FIXED'
    : b.width > 0 && b.width < ctx.frameBox.width * 0.98;
  if (widthFixed && b.width > 0) {
    computed['width'] = px(b.width);
    // Fixed px widths NEVER overflow a narrower viewport (the H07 responsive-width lesson —
    // Figma has no media queries, so the clamp is the synthesized-responsive floor).
    computed['max-width'] = '100%';
  } else if (inAutoParent && raw.layoutSizingHorizontal === 'HUG') {
    // HUG: e-flexbox atomic defaults --width:100% which overrides the flex shrink-wrap.
    // Explicit fit-content ensures the element collapses to its content width as designed.
    computed['width'] = 'fit-content';
  }

  const heightFixed = inAutoParent ? raw.layoutSizingVertical === 'FIXED' : b.height > 0;
  if (heightFixed && b.height > 0) {
    // Containers with children get `min-height` (content boxes must grow — the height→min-height
    // field lesson); empty painted boxes keep their exact height.
    computed[hasChildren ? 'min-height' : 'height'] = px(b.height);
  }
  return computed;
}

/** Flattened-subtree IR node: ONE e-image rendered by Figma (§3). */
function flattenNode(
  ctx: ParseCtx,
  raw: FigmaRawNode,
  reason: string,
  parent: FigmaRawNode | undefined,
): IrNode {
  ctx.flattened.push({
    node_id: raw.id,
    render_node_id: raw.id,
    reason,
    covers: descendantIds(raw),
    // Clip-escaping fan-outs render CLIPPED (the canvas truth is the frame's clipped view);
    // absolute bounds would bake the child overhang into the band image (W18 pinstripes).
    ...(reason === 'absolute-fan-out' && raw.clipsContent === true ? { clip_render: true } : {}),
  });
  const renderUrl = ctx.renderUrls[raw.id];
  if (renderUrl === undefined) {
    warnCtx(
      ctx,
      raw.id,
      'FIGMA_RENDER_URL_MISSING',
      `flattened node ${raw.id} (${reason}) has no render URL yet — the orchestrator must render ` +
        'it via FigmaPort.renderNodes before ASSEMBLE sideloads media.',
    );
  }
  const media: MediaRef = {
    kind: 'img',
    ...(renderUrl !== undefined ? { url: renderUrl } : {}),
    alt: flattenAlt(raw),
  };
  const b = rawBox(raw);
  const childSizing = childSizingStyles(raw, parent);
  // Small decorative ornaments (vine dividers, section separators) should be centered in their
  // flex container. Detect them as: small relative to the frame, in an auto-layout parent (so
  // they are flex items, not absolutely placed), and no explicit centering already present.
  const isSmallOrnament =
    b.width > 0 &&
    b.width < ctx.frameBox.width * 0.35 &&
    parent !== undefined &&
    isAutoLayout(parent) &&
    childSizing['position'] !== 'absolute';
  const node = irNode(ctx, raw, 'img', 'image', {
    // PLACEMENT FIRST: a flattened band inside a NONE-layout parent is hand-placed geometry like
    // any other child — without it the render sat IN FLOW and pushed every sibling down (page
    // 3414: the stripes band displaced the photo cards 1165px). TEXT-skip in childSizingStyles
    // does not apply (an e-image is never TEXT), so the explicit width below matches its output.
    ...childSizing,
    ...(b.width > 0 ? { width: px(b.width), 'max-width': '100%' } : {}),
    // height:auto — when max-width:100% shrinks the width on narrow viewports, height must scale
    // proportionally via the browser's natural aspect-ratio preservation (fixed px height stretches).
    height: 'auto',
    // Center decorative dividers in their flex container.
    ...(isSmallOrnament ? { 'align-self': 'center', 'margin-left': 'auto', 'margin-right': 'auto' } : {}),
  });
  node.media = media;
  node.attrs['data-figma-flatten'] = reason;
  return node;
}

/** The §5 folded button node (see {@link isButtonCandidate}). */
function buttonNode(ctx: ParseCtx, raw: FigmaRawNode): IrNode {
  const computed: ComputedStyleSet = {};
  let runs: TextRun[] = [];

  const mergeVisual = (n: FigmaRawNode): void => {
    Object.assign(computed, fillStyles(n).computed, strokeStyles(n), effectStyles(n, ctx.mode), radiusStyles(n));
    if (isAutoLayout(n)) {
      computed['padding-top'] = px(n.paddingTop ?? 0);
      computed['padding-right'] = px(n.paddingRight ?? 0);
      computed['padding-bottom'] = px(n.paddingBottom ?? 0);
      computed['padding-left'] = px(n.paddingLeft ?? 0);
    }
  };

  const walk = (n: FigmaRawNode): void => {
    if (!isVisible(n)) return;
    if (n.type === 'TEXT') {
      const { runs: r, families } = figmaTextRuns(n, (code, message) => warnCtx(ctx, n.id, code, message));
      runs = [...runs, ...r];
      for (const f of families) registerFamily(ctx, f);
      // Typography from the FIRST text leaf only (a button has one label by composition).
      const typo = textStyles(n.style, n.fills);
      for (const [prop, value] of Object.entries(typo)) {
        if (computed[prop] === undefined) computed[prop] = value;
      }
      return;
    }
    mergeVisual(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(raw);

  // Buttons must not stretch in flex-column parents (CSS default align-items:stretch would make
  // them full container width). Respect fixed Figma sizing; fall back to fit-content.
  if (raw.layoutSizingHorizontal === 'FIXED') {
    const bBox = rawBox(raw);
    if (bBox.width > 0) computed['width'] = px(bBox.width);
  } else {
    computed['width'] = 'fit-content';
  }
  const node = irNode(ctx, raw, 'a', 'button', computed);
  node.textRuns = runs;
  node.attrs['class'] = 'btn';
  const click = findClickAction(raw);
  if (click !== undefined) {
    node.attrs['href'] =
      click.kind === 'url' ? click.url : `#figma-${click.destination.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }
  applyInteractions(ctx, raw, node);

  // F1: the whole folded subtree converted — every descendant is native (merged into the button).
  ctx.native.push(raw.id, ...descendantIds(raw).filter((id) => idIsVisibleUnder(raw, id)));
  for (const id of descendantIds(raw).filter((id) => !idIsVisibleUnder(raw, id))) {
    ctx.dropped.push({ node_id: id, reason: `invisible inside folded button ${raw.id}` });
  }
  return node;
}

/** Is the descendant with `id` on an all-visible path under `root`? */
function idIsVisibleUnder(root: FigmaRawNode, id: string): boolean {
  const walk = (n: FigmaRawNode, visiblePath: boolean): boolean | undefined => {
    const vis = visiblePath && isVisible(n);
    if (n.id === id) return vis;
    for (const c of n.children ?? []) {
      const found = walk(c, vis);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(root, true) ?? false;
}

/**
 * Visit ONE raw node → at most one IR node (F1: the node is accounted native, flattened, or
 * dropped — exactly once). `parent` is the raw parent (sizing context); `isRoot` marks the frame.
 */
function visitNode(
  ctx: ParseCtx,
  raw: FigmaRawNode,
  parent: FigmaRawNode | undefined,
  isRoot: boolean,
): IrNode | null {
  if (!isVisible(raw)) {
    dropSubtree(ctx, raw, 'invisible (visible:false)');
    return null;
  }
  if (raw.type === 'SLICE') {
    dropSubtree(ctx, raw, 'slice (export marker, not content)');
    return null;
  }

  // §3 flatten policy — BEFORE per-type mapping (a flattened subtree is one e-image).
  const verdict = flattenVerdict(raw, ctx.mode);
  if (verdict.flatten) {
    return flattenNode(ctx, raw, verdict.reason ?? 'flatten', parent);
  }

  const b = rawBox(raw);
  if ((raw.children ?? []).length === 0 && raw.type !== 'TEXT' && b.width <= 0 && b.height <= 0) {
    dropSubtree(ctx, raw, 'zero-area leaf');
    return null;
  }

  // TEXT (§2 TEXT row + §5 heading semantics).
  if (raw.type === 'TEXT') {
    const characters = (raw.characters ?? '').trim();
    if (characters === '') {
      dropSubtree(ctx, raw, 'empty text');
      return null;
    }
    const tag = headingTagFor(raw.style?.fontSize, raw.name);
    const computed: ComputedStyleSet = {
      ...textStyles(raw.style, raw.fills),
      ...childSizingStyles(raw, parent),
    };
    const autoResize = raw.style?.textAutoResize;
    if ((autoResize === 'NONE' || autoResize === 'HEIGHT') && b.width > 0) {
      computed['max-width'] = px(b.width);
    }
    // Center-aligned text in an auto-layout parent: center the BOX itself, not just the text
    // within it. text-align:center aligns text inside the box; margin:auto aligns the box in the
    // parent. Only applies to non-FILL nodes (FILL already spans full width, margin has no effect).
    if (
      raw.style?.textAlignHorizontal === 'CENTER' &&
      raw.layoutSizingHorizontal !== 'FILL' &&
      parent !== undefined &&
      isAutoLayout(parent)
    ) {
      computed['margin-left'] = 'auto';
      computed['margin-right'] = 'auto';
    }
    const node = irNode(ctx, raw, tag, tag.startsWith('h') ? 'heading' : 'text', computed);
    const { runs, families } = figmaTextRuns(raw, (code, message) => warnCtx(ctx, raw.id, code, message));
    node.textRuns = runs;
    for (const f of families) registerFamily(ctx, f);
    applyInteractions(ctx, raw, node);
    ctx.native.push(raw.id);
    return node;
  }

  // §5 buttons: prototype action / name + all-text composition → ONE folded e-button.
  if (isButtonCandidate(raw)) {
    return buttonNode(ctx, raw);
  }

  // Containers (frame/group/component/instance/section).
  if (CONTAINER_NODE_TYPES.has(raw.type)) {
    if (/\bform\b/i.test(raw.name ?? '') && subtreeHasVisibleText(raw)) {
      warnCtx(
        ctx,
        raw.id,
        'FIGMA_FORM_NOT_INFERRED',
        `"${raw.name ?? ''}" looks like a form; forms are NOT inferred in v1 — converted as ` +
          'static boxes (pictures of forms stay pictures).',
      );
    }
    const fill = fillStyles(raw);
    const layoutPart: ComputedStyleSet = isAutoLayout(raw)
      ? { ...autoLayoutStyles(raw), position: 'relative' }
      : { display: 'block', position: 'relative' };
    // Root frame: sections are full-bleed stacks; Figma's itemSpacing gap would show as visible
    // white lines between sections. Remove it — section-to-section spacing comes from each
    // section's own padding, not the root container gap.
    if (isRoot) {
      delete layoutPart['gap'];
      delete layoutPart['row-gap'];
      delete layoutPart['column-gap'];
    }
    const computed: ComputedStyleSet = {
      // EVERY container anchors its absolutely-placed children (`position:relative`): NONE-layout
      // children are hand-placed geometry, and auto-layout containers can hold ABSOLUTE-escape
      // children — a static flex parent would let them anchor to a HIGHER relative ancestor and
      // double-apply the offsets (W18 page 3326: left 965 + width 1280 → scrollWidth 2245). A
      // child that is ITSELF absolutely placed overrides via the childSizingStyles spread below.
      ...layoutPart,
      // The canvas truth for `clipsContent`: overhanging children are HIDDEN (page 3370: an
      // off-canvas decorative child at left 885 + 1360w drove scrollWidth to 2245 because the
      // converted root let it overflow — the designer's frame clips it).
      ...(raw.clipsContent === true ? { overflow: 'hidden' } : {}),
      ...fill.computed,
      ...strokeStyles(raw),
      ...effectStyles(raw, ctx.mode),
      ...radiusStyles(raw, ctx.frameBox.width),
      ...childSizingStyles(raw, parent),
      ...sizingStyles(ctx, raw, parent, isRoot),
    };
    if (raw.opacity !== undefined && raw.opacity < 1) {
      computed['opacity'] = String(Math.round(raw.opacity * 1000) / 1000);
    }
    let role: SemanticRole = 'structural-block';
    if (raw.layoutMode === 'GRID') role = 'grid';
    else if (raw.layoutMode === 'HORIZONTAL') role = 'flex-row';
    else if (raw.layoutMode === 'VERTICAL') role = 'flex-col';

    const node = irNode(ctx, raw, 'div', role, computed);

    // A container with a VISIBLE image fill carries a background MediaRef (sideloaded by ASSEMBLE);
    // a childless one IS the image.
    if (fill.imageFill?.imageRef !== undefined) {
      const url = ctx.imageFills[fill.imageFill.imageRef];
      if (url === undefined) {
        warnCtx(
          ctx,
          raw.id,
          'FIGMA_IMAGE_FILL_URL_MISSING',
          `image fill ${fill.imageFill.imageRef} on ${raw.id} has no download URL — pass ` +
            'GET_IMAGE_FILLS output as options.image_fills.',
        );
      }
      const leaf = (raw.children ?? []).filter((c) => isVisible(c)).length === 0;
      node.media = {
        kind: leaf ? 'img' : 'background',
        ...(url !== undefined ? { url } : {}),
        alt: raw.name ?? '',
      };
      if (leaf) {
        node.tag = 'img';
        node.role = 'image';
      }
    }

    applyInteractions(ctx, raw, node);
    ctx.native.push(raw.id);
    for (const child of raw.children ?? []) {
      const childNode = visitNode(ctx, child, raw, false);
      if (childNode !== null) node.children.push(childNode);
    }
    return node;
  }

  // Simple geometry: RECTANGLE/ELLIPSE — a painted box, or an image when image-filled.
  if (raw.type === 'RECTANGLE' || raw.type === 'ELLIPSE') {
    const fill = fillStyles(raw);
    const computed: ComputedStyleSet = {
      ...fill.computed,
      ...strokeStyles(raw),
      ...effectStyles(raw, ctx.mode),
      ...radiusStyles(raw, ctx.frameBox.width),
      ...childSizingStyles(raw, parent),
      ...sizingStyles(ctx, raw, parent, false),
    };
    if (raw.opacity !== undefined && raw.opacity < 1) {
      computed['opacity'] = String(Math.round(raw.opacity * 1000) / 1000);
    }
    const node = irNode(ctx, raw, 'div', 'structural-block', computed);
    if (fill.imageFill?.imageRef !== undefined) {
      const url = ctx.imageFills[fill.imageFill.imageRef];
      if (url === undefined) {
        warnCtx(
          ctx,
          raw.id,
          'FIGMA_IMAGE_FILL_URL_MISSING',
          `image fill ${fill.imageFill.imageRef} on ${raw.id} has no download URL — pass ` +
            'GET_IMAGE_FILLS output as options.image_fills.',
        );
      }
      node.tag = 'img';
      node.role = 'image';
      node.media = { kind: 'img', ...(url !== undefined ? { url } : {}), alt: raw.name ?? '' };
      if (fill.imageFill.scaleMode === 'FILL') node.computed['object-fit'] = 'cover';
    }
    applyInteractions(ctx, raw, node);
    ctx.native.push(raw.id);
    return node;
  }

  // Unsupported leaf type — its only faithful output is a render (honest flatten, never silent).
  return flattenNode(ctx, raw, `unsupported-type:${raw.type}`, parent);
}

/* ─────────────────────────── §5 responsive: variant frames ──────────────────────────────────── */

/** Frame-name breakpoint suffix (`Landing/Mobile`, `Landing - Tablet`, …). */
const BP_SUFFIX_RE = /^(.*?)\s*[/|–—-]\s*(desktop|tablet|mobile)\s*$/i;

/** Width-recognizable buckets (§5: duplicates without the naming convention). */
function widthBucket(width: number): 'desktop' | 'tablet' | 'mobile' {
  if (width >= 1150) return 'desktop';
  if (width >= 600) return 'tablet';
  return 'mobile';
}

/** Parsed breakpoint identity of a top-level frame. */
function frameIdentity(node: FigmaRawNode): { base: string; bp: 'desktop' | 'tablet' | 'mobile' } {
  const name = node.name ?? '';
  const m = BP_SUFFIX_RE.exec(name);
  if (m !== null) {
    return { base: (m[1] as string).trim().toLowerCase(), bp: (m[2] as string).toLowerCase() as 'desktop' | 'tablet' | 'mobile' };
  }
  return { base: name.trim().toLowerCase(), bp: widthBucket(rawBox(node).width) };
}

/** Delta props applied as per-breakpoint overrides (the P1-b layout set + typography). */
const RESPONSIVE_DELTA_PROPS: ReadonlySet<string> = new Set([
  'display',
  'flex-direction',
  'flex-wrap',
  'gap',
  'row-gap',
  'column-gap',
  'justify-content',
  'align-items',
  'grid-template-columns',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-size',
  'line-height',
  'letter-spacing',
  'text-align',
]);

/** Breakpoint-comparable computed styles of a raw node (layout + typography). */
function bpComparableStyles(raw: FigmaRawNode): ComputedStyleSet {
  const source: ComputedStyleSet =
    raw.type === 'TEXT'
      ? textStyles(raw.style, raw.fills)
      : isAutoLayout(raw)
        ? autoLayoutStyles(raw)
        : { display: 'block' };
  const out: ComputedStyleSet = {};
  for (const [prop, value] of Object.entries(source)) {
    if (RESPONSIVE_DELTA_PROPS.has(prop)) out[prop] = value;
  }
  return out;
}

/**
 * §5 node-correspondence diff: walk the primary and variant raw trees in parallel, matching
 * children by `(type, name)` (first unused, falling back to position), and write each matched
 * pair's layout/typography delta onto the primary IR node's `responsive[bp]`. Unmatched variant
 * nodes are honestly dropped.
 */
function applyVariantOverrides(
  ctx: ParseCtx,
  primary: FigmaRawNode,
  variant: FigmaRawNode,
  bp: 'tablet' | 'mobile',
): void {
  const pair = (p: FigmaRawNode, v: FigmaRawNode): void => {
    ctx.native.push(v.id); // F1: the variant node converted — into responsive overrides.
    const target = ctx.byId.get(p.id);
    if (target !== undefined) {
      const delta = styleDelta(bpComparableStyles(p), bpComparableStyles(v));
      const overrides: ComputedStyleSet = {};
      for (const [prop, value] of Object.entries(delta)) {
        if (value !== '') overrides[prop] = value;
      }
      if (Object.keys(overrides).length > 0) {
        target.responsive[bp] = { ...(target.responsive[bp] ?? {}), ...overrides };
      }
    }

    // Child correspondence: greedy (type, name) match, positional fallback when counts align.
    const pKids = (p.children ?? []).filter((c) => isVisible(c));
    const vKids = (v.children ?? []).filter((c) => isVisible(c));
    const used = new Set<number>();
    for (const vk of vKids) {
      let matched = -1;
      for (let i = 0; i < pKids.length; i += 1) {
        if (used.has(i)) continue;
        const pk = pKids[i] as FigmaRawNode;
        if (pk.type === vk.type && (pk.name ?? '') === (vk.name ?? '')) {
          matched = i;
          break;
        }
      }
      if (matched === -1 && pKids.length === vKids.length) {
        const positional = vKids.indexOf(vk);
        if (!used.has(positional) && (pKids[positional])?.type === vk.type) {
          matched = positional;
        }
      }
      if (matched === -1) {
        dropSubtree(ctx, vk, `no correspondence in the primary frame (${bp} variant)`);
        warnCtx(
          ctx,
          vk.id,
          'FIGMA_VARIANT_UNMATCHED',
          `${bp} variant node "${vk.name ?? vk.id}" has no corresponding primary-frame node — its overrides were dropped.`,
        );
        continue;
      }
      used.add(matched);
      pair(pKids[matched] as FigmaRawNode, vk);
    }
  };
  pair(primary, variant);
}

/* ─────────────────────────── §5 responsive: synthesized fallback ────────────────────────────── */

/**
 * The heuristic mobile adaptation (REPORTED as `responsive:'synthesized'`, never silent): wide
 * flex rows stack to columns; display-scale headings step down. Conservative by design — the §5
 * convention is "honest fallback, not a full solution".
 */
function synthesizeResponsive(roots: IrNode[]): void {
  const visit = (node: IrNode): void => {
    if (
      node.computed['display'] === 'flex' &&
      node.computed['flex-direction'] === 'row' &&
      node.children.length >= 2 &&
      node.box.width > 700
    ) {
      node.responsive['mobile'] = { ...(node.responsive['mobile'] ?? {}), 'flex-direction': 'column' };
    }
    if (/^h[1-3]$/.test(node.tag)) {
      const size = Number.parseFloat(node.computed['font-size'] ?? '');
      if (Number.isFinite(size) && size >= 32) {
        node.responsive['mobile'] = {
          ...(node.responsive['mobile'] ?? {}),
          'font-size': px(Math.max(24, Math.round(size * 0.7))),
        };
      }
    }
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
}

/* ─────────────────────────── post-walk IR passes ────────────────────────────────────────────── */

/** Placement props carried from a collapsed wrapper onto the child that takes its slot. */
const WRAPPER_PLACEMENT_KEYS = [
  'position', 'top', 'left', 'right', 'bottom',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'align-self', 'flex-grow', 'flex-basis', 'order', 'z-index',
] as const;

/**
 * A REDUNDANT WRAPPER: a div holding EXACTLY ONE child that paints nothing itself (no bg/border/
 * shadow/clip), has no text/image/link, carries no STATE (hover/focus/interactions/behaviors/
 * responsive overrides — those are load-bearing), AND wraps its child TIGHTLY (box ≈ child's on
 * every edge). Dropping it removes a DOM level without moving anything.
 */
function isCollapsibleWrapper(w: IrNode): boolean {
  if (w.children.length !== 1) return false;
  if (w.textRuns.length > 0 || w.media !== undefined) return false;
  if (typeof w.attrs['href'] === 'string') return false;
  if (w.behaviors !== undefined && w.behaviors.length > 0) return false;
  if (w.hoverComputed !== undefined || w.focusComputed !== undefined) return false;
  if (w.animationProbe !== undefined || w.transitionProbe !== undefined) return false;
  if (Object.keys(w.responsive).length > 0) return false;
  const c = w.computed;
  if (
    c['background-color'] !== undefined ||
    c['background-image'] !== undefined ||
    c['box-shadow'] !== undefined ||
    c['border-style'] !== undefined ||
    c['border-top-width'] !== undefined ||
    c['border-width'] !== undefined ||
    c['overflow'] === 'hidden' ||
    c['overflow-x'] === 'hidden'
  ) return false;
  const wb = w.box;
  const cb = w.children[0]!.box;
  const tol = 2;
  return (
    Math.abs(wb.x - cb.x) <= tol &&
    Math.abs(wb.y - cb.y) <= tol &&
    Math.abs(wb.width - cb.width) <= tol &&
    Math.abs(wb.height - cb.height) <= tol
  );
}

/** Post-order: replace each tight redundant wrapper with its child, carrying the wrapper's placement. */
function collapseTightWrappers(node: IrNode): void {
  for (const child of node.children) collapseTightWrappers(child);
  const out: IrNode[] = [];
  for (let child of node.children) {
    while (isCollapsibleWrapper(child)) {
      const g = child.children[0]!;
      for (const k of WRAPPER_PLACEMENT_KEYS) {
        if (g.computed[k] === undefined && child.computed[k] !== undefined) {
          g.computed[k] = child.computed[k];
        }
      }
      if (child.computed['position'] === 'absolute') {
        g.computed['position'] = 'absolute';
        if (child.computed['top'] !== undefined) g.computed['top'] = child.computed['top'];
        if (child.computed['left'] !== undefined) g.computed['left'] = child.computed['left'];
      }
      child = g;
    }
    out.push(child);
  }
  node.children = out;
}

/**
 * LAYOUT GATE pre-empt — a flex ROW with a gap whose in-flow children carry `%` widths summing
 * to >=100% cannot fit (the gap is NEVER subtracted from the percentages), so Elementor's validator
 * rejects the whole tree (`check_flex_overflow`, VALIDATION_FAILED). Rewrite each overflowing `%`
 * column to an equal flex track (`flex:1 1 0` + width:0/min-width:0) so the gate never fires.
 * Post-order so nested rows convert first.
 */
export function gridifyOverflowingRows(node: IrNode): void {
  for (const child of node.children) gridifyOverflowingRows(child);
  const c = node.computed;
  if (c['display'] !== 'flex' && c['display'] !== 'inline-flex') return;
  if ((c['flex-direction'] ?? 'row') !== 'row') return;
  const gap = c['gap'];
  if (gap === undefined || Number.parseFloat(gap) === 0) return;
  const flow = node.children.filter((ch) => ch.computed['position'] !== 'absolute');
  if (flow.length < 2) return;
  const pctKids = flow.filter((ch) => {
    const w = ch.computed['width'];
    return w !== undefined && w.endsWith('%') && Number.isFinite(Number.parseFloat(w));
  });
  if (pctKids.length < 2) return;
  let sum = 0;
  for (const ch of pctKids) sum += Number.parseFloat(ch.computed['width']!);
  if (sum < 100) return;
  for (const ch of pctKids) {
    ch.computed['flex-grow'] = '1';
    ch.computed['flex-basis'] = '0';
    ch.computed['width'] = '0';
    ch.computed['min-width'] = '0';
  }
}

/**
 * CENTER full-bleed section content so it stays centered when the viewport exceeds the design
 * width ("pixel-perfect at 100% zoom, drifts left below ~90% / on a 1920 monitor"). Re-homes each
 * section's non-full-bleed absolute children into a centered max-width wrapper.
 */
function centerAbsoluteSectionContent(root: IrNode, frameWidth: number): void {
  if (frameWidth <= 0) return;
  if (root.computed['display'] !== 'flex' || root.computed['flex-direction'] !== 'column') return;
  for (const section of root.children) {
    if (section.computed['position'] === 'absolute') continue;
    if (section.computed['width'] !== '100%') continue;
    const display = section.computed['display'];
    if (display === 'flex' || display === 'grid') continue;
    const content: IrNode[] = [];
    const keep: IrNode[] = [];
    for (const ch of section.children) {
      const isAbsolute = ch.computed['position'] === 'absolute';
      const isFullBleed = ch.computed['width'] === '100%';
      if (isAbsolute && !isFullBleed) content.push(ch);
      else keep.push(ch);
    }
    if (content.length === 0) continue;
    section.computed['position'] = 'relative';
    const minHeight =
      section.computed['min-height'] ?? (section.box.height > 0 ? px(section.box.height) : undefined);
    const wrapper: IrNode = {
      source_path: `${section.source_path}:center`,
      tag: 'div',
      role: 'structural-block',
      box: { ...section.box },
      computed: {
        display: 'block',
        position: 'relative',
        width: '100%',
        'max-width': px(frameWidth),
        'margin-left': 'auto',
        'margin-right': 'auto',
        ...(minHeight !== undefined ? { 'min-height': minHeight } : {}),
      },
      responsive: {},
      attrs: {},
      textRuns: [],
      children: content,
    };
    section.children = [...keep, wrapper];
  }
}

/* ─────────────────────────── F1 accounting audit ────────────────────────────────────────────── */

/** The F1 audit verdict ({@link auditFigmaAccounting}). */
export interface FigmaAccountingAudit {
  ok: boolean;
  /** Source ids in NO bucket (silent loss — a converter bug). */
  missing: string[];
  /** Source ids in MORE THAN one bucket (double accounting — a converter bug). */
  duplicated: string[];
  total: number;
}

/**
 * Contract 18 F1: every Figma node lands in exactly one of `native | flattened | dropped+reason`.
 * Flattened subtrees count their root AND every `covers` descendant as flattened.
 */
export function auditFigmaAccounting(sourceIds: string[], report: FigmaReport): FigmaAccountingAudit {
  const seen = new Map<string, number>();
  const bump = (id: string): void => {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  };
  for (const id of report.native) bump(id);
  for (const rec of report.flattened) {
    bump(rec.node_id);
    for (const id of rec.covers) bump(id);
  }
  for (const rec of report.dropped) bump(rec.node_id);

  const missing = sourceIds.filter((id) => !seen.has(id));
  const duplicated = sourceIds.filter((id) => (seen.get(id) ?? 0) > 1);
  return { ok: missing.length === 0 && duplicated.length === 0, missing, duplicated, total: sourceIds.length };
}

/* ─────────────────────────── figmaParse (the stage entrypoint) ──────────────────────────────── */

/**
 * The figma-parse stage: Figma node JSON (a `GET_FILE_NODES`-shaped payload, a `{document}`
 * wrapper, or a bare node) → the frozen ParseResult envelope + the `figma` report. PURE — no I/O.
 * Throws only on an unusable payload (no frame); everything recoverable degrades to warnings.
 */
export function figmaParse(nodeJson: unknown, opts: FigmaParseOptions = {}): FigmaParseResult {
  const entries = extractTopNodes(nodeJson);
  if (entries.length === 0) {
    throw new Error(
      'figmaParse: no Figma node documents in the payload — expected {nodes:{id:{document}}}, ' +
        '{document}, or a bare node object.',
    );
  }

  // ── primary / variant / reference frame selection (§5). ──────────────────────────────────────
  let primary: FrameEntry | undefined;
  if (opts.node_id !== undefined) {
    primary = entries.find((e) => e.node.id === opts.node_id);
    if (primary === undefined) {
      throw new Error(`figmaParse: node ${opts.node_id} is not a top-level document in the payload.`);
    }
  } else {
    primary =
      entries.find((e) => frameIdentity(e.node).bp === 'desktop') ??
      entries.reduce((widest, e) => (rawBox(e.node).width > rawBox(widest.node).width ? e : widest), entries[0] as FrameEntry);
  }
  const primaryIdentity = frameIdentity(primary.node);

  const variants: Array<{ entry: FrameEntry; bp: 'tablet' | 'mobile' }> = [];
  const references: FrameEntry[] = [];
  for (const entry of entries) {
    if (entry === primary) continue;
    const identity = frameIdentity(entry.node);
    if (identity.base === primaryIdentity.base && (identity.bp === 'tablet' || identity.bp === 'mobile')) {
      variants.push({ entry, bp: identity.bp });
    } else {
      references.push(entry);
    }
  }

  const frameBox = rawBox(primary.node);
  const ctx: ParseCtx = {
    mode: opts.flatten ?? 'balanced',
    imageFills: opts.image_fills ?? {},
    renderUrls: opts.render_urls ?? {},
    localFamilies: new Set((opts.local_families ?? []).map((f) => normalizeFamilyKey(f))),
    entries,
    frameBox,
    warnings: [],
    native: [],
    flattened: [],
    dropped: [],
    interactionDrops: [],
    fonts: new Map(),
    byId: new Map(),
  };

  // ── the primary walk. ─────────────────────────────────────────────────────────────────────────
  const root = visitNode(ctx, primary.node, undefined, true);
  const ir: IrNode[] = root !== null ? [root] : [];

  // ── post-walk IR passes. ──────────────────────────────────────────────────────────────────────
  for (const r of ir) collapseTightWrappers(r);
  // Pre-empt Elementor's flex-overflow gate: rewrite %-width flex rows before the validator sees them.
  for (const r of ir) gridifyOverflowingRows(r);
  for (const r of ir) centerAbsoluteSectionContent(r, frameBox.width);
  // BUILD MARKER — probe the live page for `data-emcp-build`; absent ⇒ stale MCP, restart nest.
  if (ir[0] !== undefined) ir[0].attrs['data-emcp-build'] = 'r10-2026-06-28-valign-textcenter';

  // ── responsive: variant frames (node-correspondence diff) or synthesized adaptation. ─────────
  let responsive: FigmaReport['responsive'] = 'synthesized';
  const responsiveFrames: Partial<Record<'tablet' | 'mobile', string>> = {};
  if (variants.length > 0) {
    responsive = 'frames';
    for (const { entry, bp } of variants) {
      responsiveFrames[bp] = entry.node.id;
      applyVariantOverrides(ctx, primary.node, entry.node, bp);
    }
  } else if (opts.synthesize_responsive !== false) {
    synthesizeResponsive(ir);
  }

  // ── reference frames (hover-variant sources etc.) — honestly accounted, never converted. ─────
  for (const entry of references) {
    warnCtx(
      ctx,
      entry.node.id,
      'FIGMA_REFERENCE_FRAME',
      `top-level frame "${entry.node.name ?? entry.node.id}" is not a recognized breakpoint ` +
        'variant of the primary frame — kept as a reference (hover-variant lookups) but not converted.',
    );
    dropSubtree(ctx, entry.node, 'reference frame (not a recognized breakpoint variant)');
  }

  for (const [family, availability] of ctx.fonts) {
    if (availability === 'missing') {
      warnCtx(
        ctx,
        undefined,
        'FIGMA_FONT_UNAVAILABLE',
        `font family "${family}" is neither in the Elementor Google catalog nor site-installed — ` +
          'install it via design.fonts (contract 18 S4) or expect fallback rendering.',
      );
    }
  }

  const report: FigmaReport = {
    frame: {
      node_id: primary.node.id,
      name: primary.node.name ?? primary.node.id,
      width: Math.round(frameBox.width),
      height: Math.round(frameBox.height),
    },
    fonts: Object.fromEntries(ctx.fonts),
    native: ctx.native,
    flattened: ctx.flattened,
    dropped: ctx.dropped,
    responsive,
    ...(responsive === 'frames' ? { responsive_frames: responsiveFrames } : {}),
    interaction_drops: ctx.interactionDrops,
  };

  // ── the F1 invariant — violation is a converter BUG, surfaced loudly (never silently). ───────
  const audit = auditFigmaAccounting(collectFigmaNodeIds(nodeJson), report);
  if (!audit.ok) {
    warnCtx(
      ctx,
      undefined,
      'FIGMA_F1_VIOLATION',
      `F1 accounting violated: ${String(audit.missing.length)} unaccounted ` +
        `(${audit.missing.slice(0, 5).join(', ')}), ${String(audit.duplicated.length)} double-accounted ` +
        `(${audit.duplicated.slice(0, 5).join(', ')}) — converter bug.`,
    );
  }

  return {
    ir,
    doc_direction: 'ltr',
    viewport_used: Math.round(frameBox.width),
    warnings: ctx.warnings,
    raw_inner_markup: {},
    pageScripts: [],
    figma: report,
  };
}
