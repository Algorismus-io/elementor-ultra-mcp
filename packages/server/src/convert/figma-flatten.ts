/**
 * Contract 18 §3 — the FLATTEN POLICY (the 0.97% lesson, normative) + the raw Figma node shape
 * helpers the figma-parse stage shares with it.
 *
 * Complex visuals — blur/backdrop effects, layered photo clusters, device mockups, any subtree whose
 * faithful CSS reproduction is uncertain — are FLATTENED: rendered by Figma as a single PNG and
 * placed as ONE e-image. Native building is for what natively builds: boxes, text, simple gradients,
 * grids/stacks, simple shadows. The flatten/native boundary is tunable via
 * `flatten: 'aggressive' | 'balanced' | 'minimal'` (default `balanced`):
 *
 *  - every mode flattens VECTOR geometry (path data has no CSS reproduction) and any leaf whose
 *    only faithful output is a render (unsupported node types);
 *  - `balanced` additionally flattens blur/backdrop effects, device mockups, and layered
 *    no-text clusters (overlapping decorative stacks);
 *  - `aggressive` additionally flattens EVERY no-text absolute-layout container (uncertain
 *    subtrees — when in doubt, render);
 *  - `minimal` keeps everything `balanced` would flatten for visual-uncertainty reasons native
 *    (the blur/cluster declarations then ride the honest per-declaration fallback ladder).
 *
 * TEXT is sacred: a subtree containing visible TEXT is NEVER cluster/uncertainty-flattened
 * (text must stay selectable/SEO-real — the 0.97% run flattened complex VISUALS, not content).
 * Device mockups are the one named exception: a mockup's "text" is a picture of a UI by intent.
 *
 * Every decision is recorded by the caller in `flattened[] {node_id, render_node_id, reason}`
 * (F1: every Figma node lands in exactly one of native | flattened | dropped+reason).
 */

/* ─────────────────────────── raw Figma node shape (GET_FILE_JSON `document` form) ───────────── */

/**
 * The raw Figma REST node (`GET_FILE_JSON` / `GET_FILE_NODES` `document` subtree). Only the fields
 * the front-end reads are declared; everything else stays reachable through the index signature
 * (the payload is mined, never round-tripped).
 */
export interface FigmaRawNode {
  id: string;
  type: string;
  name?: string;
  visible?: boolean;
  children?: FigmaRawNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  effects?: FigmaEffect[];
  characters?: string;
  style?: FigmaTypeStyle;
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, FigmaTypeStyle>;
  interactions?: FigmaInteraction[];
  opacity?: number;
  clipsContent?: boolean;
  layoutMode?: string;
  layoutWrap?: string;
  layoutPositioning?: string;
  layoutGrow?: number;
  layoutAlign?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  itemSpacing?: number;
  counterAxisSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  strokeWeight?: number;
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  [key: string]: unknown;
}

/** A Figma paint (fill or stroke entry). `visible` ABSENT means visible. */
export interface FigmaPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
  imageRef?: string;
  scaleMode?: string;
  gradientHandlePositions?: Array<{ x: number; y: number }>;
  gradientStops?: Array<{ position: number; color: FigmaColor }>;
  [key: string]: unknown;
}

/** A Figma 0..1-channel color. */
export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A Figma effect (shadow / blur). `visible` ABSENT means visible. */
export interface FigmaEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  spread?: number;
  offset?: { x: number; y: number };
  color?: FigmaColor;
  [key: string]: unknown;
}

/** The TEXT node `style` / `styleOverrideTable` entry (the subset the front-end maps). */
export interface FigmaTypeStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  letterSpacing?: number;
  lineHeightPx?: number;
  textAlignHorizontal?: string;
  textCase?: string;
  textDecoration?: string;
  textAutoResize?: string;
  hyperlink?: { type: string; url?: string; nodeID?: string } | null;
  fills?: FigmaPaint[];
  [key: string]: unknown;
}

/** A prototype interaction (`node.interactions[]`). */
export interface FigmaInteraction {
  trigger?: { type?: string; timeout?: number; [key: string]: unknown } | null;
  actions?: Array<{
    type?: string;
    url?: string;
    destinationId?: string | null;
    navigation?: string;
    transition?: { type?: string; duration?: number; [key: string]: unknown } | null;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/* ─────────────────────────── shared raw-shape helpers ───────────────────────────────────────── */

/** Is the node visible? (Figma omits `visible` when true.) */
export function isVisible(node: FigmaRawNode): boolean {
  return node.visible !== false;
}

/** The node's VISIBLE paints, in paint order (bottom → top; the LAST visible paint is on top). */
export function visiblePaints(paints: FigmaPaint[] | undefined): FigmaPaint[] {
  return (paints ?? []).filter((p) => p.visible !== false);
}

/** The node's VISIBLE effects. */
export function visibleEffects(node: FigmaRawNode): FigmaEffect[] {
  return (node.effects ?? []).filter((e) => e.visible !== false);
}

/** The node's box (absoluteBoundingBox), or a 0-box when Figma omitted it (e.g. some groups). */
export function rawBox(node: FigmaRawNode): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const b = node.absoluteBoundingBox;
  if (b === undefined || b === null) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** Depth-first ids of every node STRICTLY BELOW `node` (the flatten `covers` set). */
export function descendantIds(node: FigmaRawNode): string[] {
  const out: string[] = [];
  const walk = (n: FigmaRawNode): void => {
    for (const c of n.children ?? []) {
      out.push(c.id);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** Does the subtree (self included) contain a VISIBLE, non-empty TEXT node? */
export function subtreeHasVisibleText(node: FigmaRawNode): boolean {
  if (!isVisible(node)) return false;
  if (node.type === 'TEXT' && (node.characters ?? '').trim() !== '') return true;
  return (node.children ?? []).some((c) => subtreeHasVisibleText(c));
}

/* ─────────────────────────── the §3 verdict ─────────────────────────────────────────────────── */

/** The tunable flatten boundary (`ConvertOptions.flatten`; default `balanced`). */
export type FigmaFlattenMode = 'aggressive' | 'balanced' | 'minimal';

/** One flatten decision: `flatten:false` → build native; `flatten:true` → render `reason` says why. */
export interface FlattenVerdict {
  flatten: boolean;
  reason: string | null;
}

/**
 * Node types whose ONLY faithful reproduction is a Figma render (CSS has no path data) — flattened
 * in EVERY mode. Simple geometry (RECTANGLE/ELLIPSE) is NOT here: those build natively as boxes.
 */
export const VECTOR_NODE_TYPES: ReadonlySet<string> = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'STAR',
  'POLYGON',
  'REGULAR_POLYGON',
  'LINE',
]);

/** Container node types (subtree-bearing). */
export const CONTAINER_NODE_TYPES: ReadonlySet<string> = new Set([
  'FRAME',
  'GROUP',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'SECTION',
]);

/** Layer names that declare a device mockup (a picture of a UI by intent — flatten in balanced+). */
const DEVICE_MOCKUP_NAME_RE =
  /\b(mock-?up|device|iphone|android|phone|macbook|laptop|browser|screenshot)\b/i;

/** Does the layer name declare a device mockup? */
export function isDeviceMockupName(name: string | undefined): boolean {
  return name !== undefined && DEVICE_MOCKUP_NAME_RE.test(name);
}

/** Overlap area of two boxes as a ratio of the SMALLER box's area (0 = disjoint, 1 = contained). */
export function overlapRatio(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  if (smaller <= 0) return 0;
  return (w * h) / smaller;
}

/**
 * A LAYERED CLUSTER: a no-text container of ≥2 visible children where some pair overlaps by >30%
 * of the smaller box — a decorative photo/shape stack whose faithful CSS layering is uncertain.
 * Auto-layout containers never cluster (auto-layout children do not overlap by construction).
 */
export function isLayeredCluster(node: FigmaRawNode): boolean {
  if (!CONTAINER_NODE_TYPES.has(node.type)) return false;
  if (typeof node.layoutMode === 'string' && node.layoutMode !== 'NONE') return false;
  if (subtreeHasVisibleText(node)) return false;
  const kids = (node.children ?? []).filter((c) => isVisible(c));
  if (kids.length < 2) return false;
  for (let i = 0; i < kids.length; i += 1) {
    for (let j = i + 1; j < kids.length; j += 1) {
      // Safe: i/j are bounded by kids.length.
      if (overlapRatio(rawBox(kids[i] as FigmaRawNode), rawBox(kids[j] as FigmaRawNode)) > 0.3) {
        return true;
      }
    }
  }
  return false;
}

/**
 * An ABSOLUTE FAN-OUT: a no-text NONE-layout container whose children the CSS path cannot place
 * (absolute offsets are only emitted INSIDE auto-layout parents — `childSizingStyles`), detected
 * by either signal of a repeated decorative pattern:
 *  - MANY visible children (≥8 — the W18 "stripes" pinstripe bands carried 255 rectangles that
 *    reflowed into a 543,000px vertical stack), or
 *  - a child box that ESCAPES the parent's clip box (<75% of the child inside — rotated stripe
 *    geometry, marquee overhangs).
 * Faithful CSS reproduction is uncertain by construction → §3 flattens it in `balanced`.
 */
export function isAbsoluteFanOut(node: FigmaRawNode): boolean {
  if (!CONTAINER_NODE_TYPES.has(node.type)) return false;
  if (typeof node.layoutMode === 'string' && node.layoutMode !== 'NONE') return false;
  if (subtreeHasVisibleText(node)) return false;
  const kids = (node.children ?? []).filter((c) => isVisible(c));
  if (kids.length >= 8) return true;
  if (kids.length < 2) return false;
  const pb = rawBox(node);
  return kids.some((kid) => {
    const b = rawBox(kid);
    if (b.width * b.height <= 0) return false;
    const w = Math.min(pb.x + pb.width, b.x + b.width) - Math.max(pb.x, b.x);
    const h = Math.min(pb.y + pb.height, b.y + b.height) - Math.max(pb.y, b.y);
    const inside = w > 0 && h > 0 ? (w * h) / (b.width * b.height) : 0;
    return inside < 0.75;
  });
}

/**
 * The §3 flatten verdict for ONE node (the subtree it roots flattens with it — the caller records
 * the descendants in the flatten record's `covers`). Decision order: vector geometry (every mode) →
 * blur/backdrop → device mockup → layered cluster (balanced+) → absolute fan-out (balanced+) →
 * uncertain absolute subtree (aggressive only) → native.
 */
export function flattenVerdict(node: FigmaRawNode, mode: FigmaFlattenMode): FlattenVerdict {
  // 1) Vector geometry — no CSS reproduction exists; every mode renders it.
  if (VECTOR_NODE_TYPES.has(node.type)) {
    return { flatten: true, reason: 'vector' };
  }

  if (mode !== 'minimal') {
    // 2) Blur / backdrop effects — CSS filter approximations diverge; balanced+ renders.
    // EXCEPTION A: RECTANGLE/ELLIPSE with NO image fill are pure CSS boxes — blur is faithfully
    // reproduced as filter:blur() / backdrop-filter:blur() (decorative glows, backdrops).
    // If the shape HAS an image fill, blurring clips the photo in a complex way → still flatten.
    const isSimpleShape =
      (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') &&
      !visiblePaints(node.fills).some((p) => p.type === 'IMAGE');
    // EXCEPTION B: auto-layout containers with ONLY backdrop blur (no layer blur) build natively.
    // CSS backdrop-filter on a flex/grid box is faithful reproduction and keeps text selectable.
    const isBackdropContainer =
      CONTAINER_NODE_TYPES.has(node.type) &&
      typeof node.layoutMode === 'string' &&
      node.layoutMode !== 'NONE' &&
      !visibleEffects(node).some((e) => e.type === 'LAYER_BLUR') &&
      visibleEffects(node).some((e) => e.type === 'BACKGROUND_BLUR');
    if (!(isSimpleShape || isBackdropContainer)) {
      const blur = visibleEffects(node).find(
        (e) => e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR',
      );
      if (blur !== undefined) {
        return {
          flatten: true,
          reason: blur.type === 'BACKGROUND_BLUR' ? 'backdrop-blur' : 'layer-blur',
        };
      }
    }

    // 3) Device mockups — pictures of UIs by intent (the one exception to text-is-sacred).
    if (isDeviceMockupName(node.name) && (node.children ?? []).length > 0) {
      return { flatten: true, reason: 'device-mockup' };
    }

    // 4) Layered no-text clusters — overlapping decorative stacks.
    if (isLayeredCluster(node)) {
      return { flatten: true, reason: 'layered-cluster' };
    }

    // 5) Absolute fan-outs — no-text NONE-layout containers the CSS path cannot place (absolute
    //    offsets only exist inside auto-layout parents); repeated decorative patterns reflow into
    //    catastrophic stacks when built natively (W18: 255 pinstripes → a 543,000px page).
    if (isAbsoluteFanOut(node)) {
      return { flatten: true, reason: 'absolute-fan-out' };
    }
  }

  // 5) Aggressive: ANY no-text absolute-layout container is an uncertain subtree — render it.
  if (
    mode === 'aggressive' &&
    CONTAINER_NODE_TYPES.has(node.type) &&
    (node.layoutMode === undefined || node.layoutMode === 'NONE') &&
    (node.children ?? []).length >= 2 &&
    !subtreeHasVisibleText(node)
  ) {
    return { flatten: true, reason: 'uncertain-absolute-subtree' };
  }

  return { flatten: false, reason: null };
}
