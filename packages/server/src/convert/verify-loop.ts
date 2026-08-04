/// <reference lib="dom" />
/**
 * W2 — contract 17 §2–3: the post-save VERIFICATION LOOP (the closed-loop converter).
 *
 * (The `dom` lib reference above is scoped to THIS file only — same rationale as `parse.ts`: the
 * in-page `page.evaluate` snapshot function executes in the browser and needs DOM globals typed.)
 *
 * The converter is not done when it saves — it is done when it has LOOKED at what it saved,
 * compared it to the source, and accounted for every divergence (§0). Three checks per active
 * breakpoint, all reusing the existing Playwright pool (`BrowserPort` — never a second browser):
 *
 *   - **V1 — element-matched render diff.** Render the SOURCE (reducedMotion) and the CONVERTED
 *     page, match elements via the assembler's source-correspondence (`SourcePathIdMap`,
 *     `source_path → data-id`; a unique-text fallback when no map is available, e.g. the external
 *     corpus runner), and diff the FIXED prop set (background / color / font-* / padding /
 *     border-* / width / height / display) per matched element. Every divergence carries a CAUSE
 *     attributed via the same logic as I1/I2 plus the I3 tier ledger (`DeclFallback[]`).
 *   - **V2 — layout audits.** `scrollWidth == viewport` (no horizontal overflow), no visible
 *     element with zero rendered area that had area in the source, page height within tolerance.
 *   - **V3 — visual score.** Pixelmatch per breakpoint — a STANDARD loop output, not an optional
 *     tool. The standalone harness `packages/server/_odiff.mjs` is the reference implementation
 *     (full-page shots, crop to the common box, mismatch ratio).
 *
 * **R1 repairs** (§3, bounded + mechanical-only): the loop RETURNS a list of patches
 * `{nodeId, prop, value, cause}` for `dangling_ref` / `base_default` / missing `overflow-x`
 * carry. It never applies them — the integrator (pipeline) applies repairs through the normal
 * save path (backup + base_hash), at most {@link MAX_REPAIR_ROUNDS} rounds, then re-verifies.
 * Everything non-mechanical stays in the divergence report (R2) — no guessing.
 *
 * Pure core (matching / diffing / attribution / audits / repair derivation) is exported for
 * browser-less unit tests; only {@link runVerifyLoop} touches Playwright (Chromium-gated tests,
 * like parse/fidelity). `pixelmatch`/`pngjs` load via the same dynamic-import indirection as
 * `fidelity.ts` so importing this module never requires them.
 *
 * **Contract 18 §7 hardening (P1-d / P1-e / P3-b)** — the v17.0 loop had measured blind spots
 * (Driftwell baseline R3); this is the HARDENED loop the gate must consume (§6 F6):
 *   - **P1-d (V2 for real):** a `max`-direction breakpoint used to render at its BOUNDARY width
 *     (mobile = 767), so a 743px-wide layout "passed at 390". Every breakpoint now renders at a
 *     representative DEVICE width INSIDE its range ({@link verifyRenderWidth}; mobile → 390) and
 *     the audit asserts the viewport was ACTUALLY applied (`viewport_ok`).
 *   - **P1-d (cause attribution):** ledger matching understands shorthand/logical declarations
 *     (`background:` covers `background-color`, `padding:` covers `padding-top`, …) so divergences
 *     attribute through the I3 tier ledger instead of falling to `unknown`; `causeStats` reports
 *     the attributed ratio (target ≥ {@link ATTRIBUTED_RATIO_TARGET}).
 *   - **P3-b (notation):** values are notation-normalized before diffing — a gradient whose first/
 *     last color stops carry explicit `0%`/`100%` equals the same gradient without them.
 *   - **P1-e (blind spots):** a CONTENT-PRESENCE audit (every source text string ≥3 chars must
 *     appear in the converted DOM or in an honest-drop entry), a source-vs-converted ELEMENT-COUNT
 *     delta report, and BEHAVIORAL probes (per-frame opacity sampling on `scrollIn` interaction
 *     elements — contract 16's fidelity-probe result shape, `BehaviorProbe`).
 * {@link evaluateVerifyGate} composes the hardened verdict for the R3 gate.
 */

import type { Page } from 'playwright';

import { withPage as defaultWithPage } from './browser-pool.js';
import type { BrowserPort } from './fidelity.js';
import type { SourcePathIdMap } from './coverage.js';
import type { BehaviorProbe, BreakpointSpec, DeclFallback } from './types.js';

/* ─────────────────────────── result shapes (contract 17 §2–3) ────────────────────────────────── */

/** The attributed root cause of one V1 divergence (§2 V1 + the #9/#10 loop-guard causes). */
export type DivergenceCause =
  | 'dangling_ref'
  | 'base_default'
  | 'dropped_declaration'
  | 'font_not_carried'
  | 'custom_css_unrendered'
  | 'pseudo_unrepresentable'
  | 'unknown';

/** One V1 element-matched render divergence (§2 V1 — the frozen row shape, + the breakpoint). */
export interface Divergence {
  /** The converted element id (`data-id`); `''` when the source element matched no rendered node. */
  element: string;
  source_path: string;
  prop: string;
  source_value: string;
  converted_value: string;
  cause: DivergenceCause;
  /** The breakpoint key this divergence was observed at (the loop diffs EVERY active breakpoint). */
  breakpoint: string;
}

/** A converted element that rendered with zero area although its source counterpart had area (V2). */
export interface ZeroAreaFinding {
  element: string;
  source_path: string;
}

/** One V2 layout audit (per breakpoint). `pass` is the R3 gate view (overflow / zero-size / height). */
export interface LayoutAudit {
  breakpoint: string;
  /**
   * The DEVICE width the loop asked Playwright to render at ({@link verifyRenderWidth} — INSIDE the
   * breakpoint's range, e.g. mobile → 390, never the 767 boundary; §7 P1-d).
   */
  render_width: number;
  /** The MEASURED `window.innerWidth` of the converted render (must equal `render_width`). */
  viewport_width: number;
  /**
   * `|viewport_width − render_width| ≤ 1` — the viewport was ACTUALLY applied. A snapshot taken at
   * the wrong width cannot be trusted, so a mismatch fails the audit (§7 P1-d: "measure
   * `document.scrollWidth` INSIDE each breakpoint viewport for real").
   */
  viewport_ok: boolean;
  /** Converted-page `document.scrollWidth` — must equal the viewport (no horizontal overflow). */
  scroll_width: number;
  scroll_width_ok: boolean;
  /** Source-page `document.scrollWidth` (a source that itself overflows excuses the converted page). */
  source_scroll_width: number;
  /** The source body's computed `overflow-x` — drives the R1 "missing overflow-x carry" repair. */
  source_overflow_x: string;
  source_height: number;
  converted_height: number;
  height_ok: boolean;
  zero_area: ZeroAreaFinding[];
  /**
   * The converted page's first ATOMIC `data-id` (the page-root wrapper; classic html widgets like
   * the prepended font carry are skipped) — the overflow-repair FALLBACK target when the
   * integrator supplies no `rootNodeId`.
   */
  root_element: string;
  /** `viewport_ok && scroll_width_ok && height_ok && zero_area empty` — the V2 verdict (R3 gate). */
  pass: boolean;
}

/** One source text string the content-presence audit could not find (§7 P1-e / P1-a corpus guard). */
export interface ContentMissingFinding {
  /** The structural path of the text node's PARENT element (same vocabulary as `source_path`). */
  source_path: string;
  /** The normalized source text-node string (≥ {@link TEXT_MATCH_MIN_LENGTH} chars). */
  text: string;
}

/**
 * The §7 P1-e CONTENT-PRESENCE audit: every visible source text string ≥3 chars must appear in the
 * converted DOM (`body_text`) or be accounted for by an honest-drop entry (`droppedTexts` — the
 * coverage report's `stripped_text` / inline-fold drops). A string in NEITHER bucket is SILENT
 * content loss (the `$0<small>/forever</small>` class, P1-a) and fails the audit.
 */
export interface ContentAudit {
  /** The breakpoint whose render pair was audited (the WIDEST render — most content visible). */
  breakpoint: string;
  /** Total visible source text strings ≥3 chars. */
  total: number;
  /** Strings found in the converted DOM. */
  present: number;
  /** Strings absent from the DOM but accounted for by an honest-drop entry. */
  dropped: number;
  /** Strings in NEITHER bucket — silent loss. */
  missing: ContentMissingFinding[];
  /** `missing.length === 0`. */
  pass: boolean;
}

/** §7 P1-e — the source-vs-converted rendered-element-count delta (REPORT-only, per breakpoint). */
export interface ElementCountDelta {
  breakpoint: string;
  /** Visible rendered elements on the source page (same census rules on both sides). */
  source_count: number;
  /** Visible rendered elements on the converted page. */
  converted_count: number;
  /** `converted_count − source_count` (a strongly negative delta = removed elements). */
  delta: number;
}

/** §7 P1-d — the cause-attribution summary over all V1 divergences (`attributed_ratio` target ≥0.8). */
export interface CauseStats {
  total: number;
  /** Divergences carrying a non-`unknown` cause. */
  attributed: number;
  unknown: number;
  /** `attributed / total` (1 when there are no divergences). */
  attributed_ratio: number;
}

/** One authored interaction the loop should behaviorally probe (§7 P1-e; wired by the integrator). */
export interface InteractionProbeTarget {
  /** The SAVED element id (matched against `data-id` / `data-interaction-id`, both spellings). */
  element_id: string;
  /** The authored trigger. `scrollIn` gets the STRICT `<1 → 1` opacity-ramp assertion (P1-c guard). */
  trigger: string;
}

/** One V3 pixelmatch score (per breakpoint). `ratio` is `diffPixels / totalPixels` (lower = better). */
export interface PixelScoreEntry {
  breakpoint: string;
  ratio: number;
  /** Present when the pixel diff itself failed (deps/render) — the ratio is then pinned to 1 (honest worst). */
  error?: string;
}

/** The cause vocabulary of a MECHANICAL repair (§3 R1 — the only auto-repairable causes). */
export type RepairCause = 'dangling_ref' | 'base_default' | 'missing_overflow_x';

/** One mechanical R1 repair patch. The integrator applies it via the NORMAL save path, never here. */
export interface RepairPatch {
  nodeId: string;
  prop: string;
  value: string;
  cause: RepairCause;
}

/** Everything one verification pass produces (§2 V1–V3 + §3 R1 + the §7 P1-d/P1-e hardening). */
export interface VerifyLoopResult {
  divergences: Divergence[];
  layoutAudits: LayoutAudit[];
  pixelScore: PixelScoreEntry[];
  repairs: RepairPatch[];
  /** §7 P1-e — the content-presence audit (computed over the WIDEST breakpoint render pair). */
  contentAudit: ContentAudit;
  /** §7 P1-e — rendered-element-count deltas per breakpoint (report-only, never gates alone). */
  elementCounts: ElementCountDelta[];
  /**
   * §7 P1-e — behavioral probes for the authored interactions (`input.interactions`); EMPTY when
   * the integrator supplied none. Contract 16's frozen probe row shape (`kind:'interactions'`).
   */
  behaviorProbes: BehaviorProbe[];
  /** §7 P1-d — the cause-attribution summary over `divergences`. */
  causeStats: CauseStats;
}

/* ─────────────────────────── input ───────────────────────────────────────────────────────────── */

/** The port slice the loop needs (structurally satisfied by the full `ConvertPorts` bundle). */
export interface VerifyPorts {
  browser: BrowserPort;
}

/** `runVerifyLoop` input. `idMap`/`ledger` come from the pipeline; both degrade honestly when absent. */
export interface VerifyLoopInput {
  /** The conversion SOURCE: a URL (`http(s)://`, `file://`, `data:`) or a raw HTML document string. */
  sourceUrlOrHtml: string;
  /** The SAVED + PRIMED converted page URL (atomic CSS present only after the prime). */
  pageUrl: string;
  /** The active breakpoints to verify at — EVERY one is rendered + diffed (§2 V1). */
  breakpoints: BreakpointSpec[];
  /** The assembler's `source_path → minted element id` correspondence (V1's primary matcher). */
  idMap?: SourcePathIdMap;
  /** The I3 tier ledger (STYLE-EXTRACT `declaration_fallbacks`) — drives cause attribution. */
  ledger?: DeclFallback[];
  /** The page-root node id (overflow-x repair target). Defaults to the rendered root `data-id`. */
  rootNodeId?: string;
  /** Page-height tolerance as a fraction of the source height (V2; default 0.15). */
  heightTolerance?: number;
  /**
   * Honest-drop text entries (the coverage report's `stripped_text` rows / inline-fold drops) —
   * a source string found here counts as `dropped` (accounted), never `missing` (§7 P1-e).
   */
  droppedTexts?: string[];
  /** The authored interactions to behaviorally probe (§7 P1-e; omit/empty = no probe page-load). */
  interactions?: InteractionProbeTarget[];
}

/* ─────────────────────────── constants (frozen check surface) ────────────────────────────────── */

/** §3 R1: never more than 2 repair rounds — the integrator's loop bound (exported so it is shared). */
export const MAX_REPAIR_ROUNDS = 2;

/** V2 default page-height tolerance (fraction of the source height). */
export const DEFAULT_HEIGHT_TOLERANCE = 0.15;

/** §7 P1-d corpus target: at least this fraction of divergences must carry a non-`unknown` cause. */
export const ATTRIBUTED_RATIO_TARGET = 0.8;

/**
 * §7 P1-d — representative DEVICE widths for `max`-direction breakpoints. A `max` breakpoint's
 * `width` is the UPPER BOUNDARY of its range; rendering AT the boundary is the field-measured lie
 * (a 743px-wide layout "passed mobile" because mobile rendered at 767). The verification render
 * happens INSIDE the range at the canonical device width instead (the project-wide 390/768
 * screenshot convention). Keys are the canonical Elementor `BreakpointKey`s; an unmapped key (or a
 * site whose custom boundary is below the device width) falls back to the boundary itself.
 */
export const VERIFY_DEVICE_WIDTHS: Readonly<Record<string, number>> = {
  mobile: 390,
  mobile_extra: 600,
  tablet: 768,
  tablet_extra: 1100,
  laptop: 1280,
};

/** The width one breakpoint is RENDERED + MEASURED at (`min` breakpoints stress their own boundary). */
export function verifyRenderWidth(bp: BreakpointSpec): number {
  if (bp.direction !== 'max') return bp.width;
  const device = VERIFY_DEVICE_WIDTHS[String(bp.key)];
  return device !== undefined && device <= bp.width ? device : bp.width;
}

/**
 * The FIXED V1 prop set (§2 V1: background, color, font-*, padding, border-*, width, height,
 * display) as computed-style longhands (Chromium returns canonical longhand values on both sides).
 */
export const VERIFY_PROPS: readonly string[] = [
  'background-color',
  'background-image',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-top-left-radius',
  'width',
  'height',
  'display',
];

/**
 * I2's base-default table, viewed from the loop: for each ATOMIC widget whose base styles PAINT,
 * the V1 props its base default can push through when the converter "skipped as no-op". A
 * divergence on one of these props on an element carrying the base class attributes `base_default`
 * (mechanically repairable — emit the explicit prop). e-div-block paints nothing (neutral base).
 */
export const BASE_DEFAULT_PAINTED_PROPS: Readonly<Record<string, readonly string[]>> = {
  // e-button base: blue fill / padding / radius (the ghost-buttons-turn-blue class).
  'e-button-base': [
    'background-color',
    'color',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-top-left-radius',
  ],
  // e-flexbox base: 10px padding (+ column direction, outside the V1 prop set).
  'e-flexbox-base': ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  // e-svg base: 50x50.
  'e-svg-base': ['width', 'height'],
};

/** px-value comparison tolerance: `max(PX_TOLERANCE_MIN, PX_TOLERANCE_PCT * magnitude)`. */
const PX_TOLERANCE_MIN = 2;
const PX_TOLERANCE_PCT = 0.03;

/** Minimum normalized own-text length for the unique-text matcher fallback (avoid '·'/'×' collisions). */
const TEXT_MATCH_MIN_LENGTH = 3;

/* ─────────────────────────── page snapshots (the V1/V2 wire shapes) ──────────────────────────── */

/** One element's rendered facts (computed V1 props + geometry + the I1-relevant class refs). */
export interface ElementSnapshot {
  tag: string;
  /** The V1 prop set, as computed values. */
  props: Record<string, string>;
  /** Rendered area in px² (rounded). */
  area: number;
  /** `display != none && visibility != hidden`. */
  visible: boolean;
  /** Normalized DIRECT-child text (atomic text widgets carry their text directly on the `data-id` node). */
  text: string;
  /** Atomic base-style classes on the element (`e-<widget>-base`) — drives `base_default` attribution. */
  base_classes: string[];
  /** Local/global style classes (`e-<id>-<7hex>` / `g-<hex>`) with NO rendered CSS rule (I1 direction 1). */
  dangling_refs: string[];
}

/** One VISIBLE text-node string + its parent's structural path (drives the content audit, P1-e). */
export interface TextNodeRecord {
  path: string;
  text: string;
}

/** One rendered page at one breakpoint: elements keyed by `source_path` (source) / `data-id` (converted). */
export interface PageSnapshot {
  elements: Record<string, ElementSnapshot>;
  /**
   * Every VISIBLE text-node string ≥ {@link TEXT_MATCH_MIN_LENGTH} chars (whitespace-normalized),
   * captured per TEXT NODE — not per element — so a bare text node beside an element child
   * (`$0<small>/forever</small>`, the P1-a loss class) is its OWN auditable record.
   */
  text_nodes: TextNodeRecord[];
  /** The page's full visible text (normalized) — the content-audit presence haystack. */
  body_text: string;
  /** Count of VISIBLE rendered elements under `<body>` (same census rules on both sides; P1-e). */
  element_count: number;
  scroll_width: number;
  scroll_height: number;
  viewport_width: number;
  /** The body's computed `overflow-x` (source side: drives the R1 overflow carry). */
  overflow_x: string;
  /**
   * The first ATOMIC `data-id` on the page (converted side: the page-root wrapper — classic
   * `html` widgets such as the font carry are skipped, they cannot host repairs); `''` on the
   * source. The integrator's `rootNodeId` (derived from the actual tree) takes precedence.
   */
  first_element_id: string;
}

/* ─────────────────────────── pure: value comparison ──────────────────────────────────────────── */

/** Lowercase + collapse whitespace (computed values are canonical but quote/spacing-stable only per UA). */
function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Split on TOP-LEVEL commas only (gradient stops contain nested `rgb(...)` commas). */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Leading gradient arguments that are DIRECTION/SHAPE tokens, not color stops. */
const GRADIENT_PREAMBLE =
  /^(to |[-\d.]+(deg|grad|rad|turn)\b|circle\b|ellipse\b|closest-|farthest-|at |from )/;

/**
 * §7 P3-b — strip the REDUNDANT explicit positions a converter may add to gradient color stops:
 * `0%` on the FIRST stop and `100%` on the LAST stop are the CSS defaults, so
 * `linear-gradient(135deg, red 0%, blue 100%)` and `linear-gradient(135deg, red, blue)` are the
 * SAME gradient and must not count as a divergence. Middle-stop positions are semantic and kept.
 */
function stripRedundantGradientStops(value: string): string {
  let out = '';
  let rest = value;
  for (;;) {
    const m = /(?:repeating-)?(?:linear|radial|conic)-gradient\(/.exec(rest);
    if (m === null) {
      out += rest;
      break;
    }
    const open = m.index + m[0].length;
    let depth = 1;
    let close = open;
    while (close < rest.length && depth > 0) {
      const ch = rest[close];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      close += 1;
    }
    const inner = rest.slice(open, close - 1);
    const parts = splitTopLevel(inner).map((p) => p.trim());
    const firstStop = parts.findIndex((p) => !GRADIENT_PREAMBLE.test(p));
    if (firstStop !== -1) {
      const first = parts[firstStop];
      const last = parts[parts.length - 1];
      if (first !== undefined) parts[firstStop] = first.replace(/\s+0%$/, '');
      if (parts.length - 1 > firstStop && last !== undefined) {
        parts[parts.length - 1] = last.replace(/\s+100%$/, '');
      }
    }
    out += rest.slice(0, open) + parts.join(', ') + ')';
    rest = rest.slice(close);
  }
  return out;
}

/**
 * Notation-normalize a computed value BEFORE diffing (§7 P3-b): lowercase/whitespace plus the
 * gradient-stop default-position strip. Exported so corpus guards can assert notation-only pairs
 * normalize equal.
 */
export function normalizeNotation(value: string): string {
  const v = normalizeValue(value);
  return v.includes('gradient(') ? stripRedundantGradientStops(v) : v;
}

/** First font family of a `font-family` computed list, unquoted + lowercased. */
function firstFamily(value: string): string {
  const first = value.split(',')[0] ?? '';
  return first
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '');
}

/** Parse `rgb()`/`rgba()` into channels (`null` when not a color function). */
function parseRgb(value: string): number[] | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (m === null || m[1] === undefined) return null;
  const parts = m[1].split(/[\s,/]+/).filter((p) => p !== '');
  const nums = parts.map((p) => Number.parseFloat(p));
  if (nums.length < 3 || nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

/** A plain `<number>px` length, parsed (`null` otherwise). */
function parsePx(value: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  if (m === null || m[1] === undefined) return null;
  return Number.parseFloat(m[1]);
}

/**
 * Does a computed value pair count as a REAL divergence for `prop`? Tolerances keep the report
 * honest-but-quiet: ±2px-or-3% on px lengths (layout jitter), ±2/channel on colors (compositing),
 * first-family on `font-family` (fallback chains differ), and `url(...)` background-images compare
 * by PRESENCE (sideloading rewrites the URL by design — a url→url pair is the same image intent).
 * Values are NOTATION-normalized first (§7 P3-b — gradient-stop `0%`/`100%` defaults never count).
 */
export function valuesDiverge(prop: string, sourceValue: string, convertedValue: string): boolean {
  const a = normalizeNotation(sourceValue);
  const b = normalizeNotation(convertedValue);
  if (a === b) return false;

  if (prop === 'background-image') {
    // Sideloaded media rewrites the URL; same-presence url() pairs are NOT a divergence.
    if (a.includes('url(') && b.includes('url(')) return false;
    return true;
  }
  if (prop === 'font-family') {
    return firstFamily(a) !== firstFamily(b);
  }

  const colorA = parseRgb(a);
  const colorB = parseRgb(b);
  if (colorA !== null && colorB !== null) {
    const alphaA = colorA.length > 3 ? (colorA[3] ?? 1) : 1;
    const alphaB = colorB.length > 3 ? (colorB[3] ?? 1) : 1;
    // Fully-transparent equals fully-transparent regardless of the RGB channels underneath.
    if (alphaA <= 0.02 && alphaB <= 0.02) return false;
    for (let i = 0; i < 3; i++) {
      if (Math.abs((colorA[i] ?? 0) - (colorB[i] ?? 0)) > 2) return true;
    }
    return Math.abs(alphaA - alphaB) > 0.02;
  }

  const pxA = parsePx(a);
  const pxB = parsePx(b);
  if (pxA !== null && pxB !== null) {
    const tolerance = Math.max(
      PX_TOLERANCE_MIN,
      PX_TOLERANCE_PCT * Math.max(Math.abs(pxA), Math.abs(pxB)),
    );
    return Math.abs(pxA - pxB) > tolerance;
  }

  return true;
}

/* ─────────────────────────── pure: cause attribution (I1/I2 + the I3 ledger) ─────────────────── */

/** What `attributeCause` needs about one divergence (the converted element + the ledger context). */
export interface CauseContext {
  source_path: string;
  prop: string;
  converted: Pick<ElementSnapshot, 'base_classes' | 'dangling_refs'>;
  ledger?: DeclFallback[] | undefined;
}

/** Logical-property spellings that resolve to a V1 physical longhand (LTR/horizontal-tb resolution). */
const LOGICAL_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  'padding-top': ['padding-block-start'],
  'padding-right': ['padding-inline-end'],
  'padding-bottom': ['padding-block-end'],
  'padding-left': ['padding-inline-start'],
  'border-top-width': ['border-block-start-width'],
  'border-top-style': ['border-block-start-style'],
  'border-top-color': ['border-block-start-color'],
  'border-top-left-radius': ['border-start-start-radius'],
};

/** Side/corner tokens removed to reach the shorthand family (`padding-top` → `padding`). */
const SIDE_TOKEN = /-(top-left|top-right|bottom-left|bottom-right|top|right|bottom|left)(?=-|$)/;

/**
 * §7 P1-d — every declaration PROP NAME that covers one V1 longhand: the longhand itself, its
 * logical spellings, its side-stripped family (`border-top-width` → `border-width`,
 * `border-top-left-radius` → `border-radius`), and each dash-prefix shorthand (`background` covers
 * `background-color`, `font` covers `font-size`, `border` / `border-top` cover `border-top-width`).
 * Authors write SHORTHANDS; the v17.0 exact-prefix match missed them all → 100% `unknown` causes.
 */
export function propMatchCandidates(prop: string): Set<string> {
  const out = new Set<string>([prop]);
  for (const logical of LOGICAL_EQUIVALENTS[prop] ?? []) out.add(logical);
  out.add(prop.replace(SIDE_TOKEN, ''));
  const parts = prop.split('-');
  for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('-'));
  return out;
}

/** Does one ledger row's declaration (`"prop: value"`) cover the diverging V1 longhand? */
function declarationCoversProp(declaration: string, prop: string): boolean {
  const idx = declaration.indexOf(':');
  const rowProp = (idx === -1 ? declaration : declaration.slice(0, idx)).trim().toLowerCase();
  return propMatchCandidates(prop).has(rowProp);
}

/** §7 P1-d — summarize cause attribution over the V1 rows (corpus target: ratio ≥0.8 non-unknown). */
export function computeCauseStats(divergences: Divergence[]): CauseStats {
  const total = divergences.length;
  const unknown = divergences.filter((d) => d.cause === 'unknown').length;
  const attributed = total - unknown;
  return {
    total,
    attributed,
    unknown,
    attributed_ratio: total === 0 ? 1 : attributed / total,
  };
}

/**
 * Attribute one divergence to its root cause (§2 V1), in precedence order:
 *  1. `dangling_ref` — the element carries a style class with no rendered rule (I1 direction 1);
 *     EVERY prop on such an element is suspect, so this wins.
 *  2. `font_not_carried` — any `font-family` diff (contract #9's loop guard).
 *  3. ledger-attributed (`DeclFallback.declaration` is `"prop: value"`, keyed by `source_path`;
 *     SHORTHAND/LOGICAL declarations cover their longhands via {@link propMatchCandidates}, §7 P1-d):
 *     `pseudo_unrepresentable` reason (also matched on pseudo child paths, #10) →
 *     `custom_css` tier (emitted but not rendering) → `html_widget` tier (the dropped bucket, I3).
 *  4. `base_default` — the prop is in the element's painted base-default set (I2).
 *  5. `unknown` — R2 territory: stays in the report for a fixing agent, never guessed at.
 */
export function attributeCause(ctx: CauseContext): DivergenceCause {
  if (ctx.converted.dangling_refs.length > 0) return 'dangling_ref';
  if (ctx.prop === 'font-family') return 'font_not_carried';

  const ledger = ctx.ledger ?? [];
  const rows = ledger.filter(
    (r) => r.source_path === ctx.source_path && declarationCoversProp(r.declaration, ctx.prop),
  );
  if (rows.some((r) => r.reason.includes('pseudo_unrepresentable'))) {
    return 'pseudo_unrepresentable';
  }
  if (rows.some((r) => r.tier === 'custom_css')) return 'custom_css_unrendered';
  if (rows.some((r) => r.tier === 'html_widget')) return 'dropped_declaration';
  // Pseudo-CHILD rows (#10: paths extending the element's own path, e.g. `…>div::before`) — a
  // honestly-dropped pseudo element shows up as a divergence on its REAL parent.
  if (
    rows.length === 0 &&
    ledger.some(
      (r) =>
        r.source_path !== ctx.source_path &&
        r.source_path.startsWith(ctx.source_path) &&
        r.reason.includes('pseudo_unrepresentable'),
    )
  ) {
    return 'pseudo_unrepresentable';
  }

  for (const cls of ctx.converted.base_classes) {
    const painted = BASE_DEFAULT_PAINTED_PROPS[cls];
    if (painted !== undefined && painted.includes(ctx.prop)) return 'base_default';
  }
  return 'unknown';
}

/* ─────────────────────────── pure: element matching (V1) ─────────────────────────────────────── */

/** One matched source↔converted element pair. */
export interface MatchedElement {
  source_path: string;
  /** The converted `data-id`. */
  element: string;
  source: ElementSnapshot;
  converted: ElementSnapshot;
}

/** Candidate `data-id` spellings for a minted id (saved pages carry bare hex; mints carry `e-`). */
function idCandidates(id: string): string[] {
  const out = [id];
  if (id.startsWith('e-')) out.push(id.slice(2));
  else out.push(`e-${id}`);
  return out;
}

/**
 * Match source elements to converted elements (§2 V1). PRIMARY: the assembler's source-path
 * correspondence (`idMap`). FALLBACK (no map — e.g. the external corpus runner): pair elements
 * whose normalized direct text is UNIQUE on both sides (atomic text widgets carry their text on the
 * `data-id` node, so headings/paragraphs/buttons/links pair reliably). Unmatched elements simply do
 * not produce V1 rows — V2's zero-area audit and V3's pixel score still cover them.
 */
export function matchElements(
  source: PageSnapshot,
  converted: PageSnapshot,
  idMap?: SourcePathIdMap,
): MatchedElement[] {
  const matches: MatchedElement[] = [];

  if (idMap !== undefined) {
    for (const [path, id] of Object.entries(idMap)) {
      const src = source.elements[path];
      if (src === undefined) continue;
      for (const candidate of idCandidates(id)) {
        const conv = converted.elements[candidate];
        if (conv !== undefined) {
          matches.push({ source_path: path, element: candidate, source: src, converted: conv });
          break;
        }
      }
    }
    return matches;
  }

  // Unique-text fallback.
  const byTextSource = new Map<string, string[]>();
  for (const [path, snap] of Object.entries(source.elements)) {
    if (snap.text.length < TEXT_MATCH_MIN_LENGTH) continue;
    const list = byTextSource.get(snap.text) ?? [];
    list.push(path);
    byTextSource.set(snap.text, list);
  }
  const byTextConverted = new Map<string, string[]>();
  for (const [id, snap] of Object.entries(converted.elements)) {
    if (snap.text.length < TEXT_MATCH_MIN_LENGTH) continue;
    const list = byTextConverted.get(snap.text) ?? [];
    list.push(id);
    byTextConverted.set(snap.text, list);
  }
  for (const [text, paths] of byTextSource) {
    const ids = byTextConverted.get(text);
    if (paths.length !== 1 || ids === undefined || ids.length !== 1) continue;
    const path = paths[0];
    const id = ids[0];
    if (path === undefined || id === undefined) continue;
    const src = source.elements[path];
    const conv = converted.elements[id];
    if (src === undefined || conv === undefined) continue;
    matches.push({ source_path: path, element: id, source: src, converted: conv });
  }
  return matches;
}

/* ─────────────────────────── pure: V1 diff + V2 audit + R1 repairs ───────────────────────────── */

/**
 * Diff the FIXED prop set over the matched pairs at one breakpoint (§2 V1). Source-invisible
 * elements are skipped entirely (nothing to be faithful to); every real divergence gets a cause.
 */
export function diffMatchedElements(
  matches: MatchedElement[],
  breakpoint: string,
  ledger?: DeclFallback[],
): Divergence[] {
  const out: Divergence[] = [];
  for (const m of matches) {
    if (!m.source.visible) continue;
    for (const prop of VERIFY_PROPS) {
      const sourceValue = m.source.props[prop];
      const convertedValue = m.converted.props[prop];
      if (sourceValue === undefined || convertedValue === undefined) continue;
      if (!valuesDiverge(prop, sourceValue, convertedValue)) continue;
      out.push({
        element: m.element,
        source_path: m.source_path,
        prop,
        source_value: sourceValue,
        converted_value: convertedValue,
        cause: attributeCause({
          source_path: m.source_path,
          prop,
          converted: m.converted,
          ledger,
        }),
        breakpoint,
      });
    }
  }
  return out;
}

/**
 * V2 layout audit for one breakpoint: horizontal overflow, zero-area elements that had area in the
 * source (via the matched pairs), and page height within tolerance of the source. `renderWidth` is
 * the DEVICE width the loop ASKED for ({@link verifyRenderWidth}) — a measured viewport that does
 * not match it means the snapshot was taken at the wrong width and the audit fails honestly
 * (§7 P1-d: the 743/390 lie came from measuring at the 767 boundary instead of inside the range).
 */
export function auditLayout(
  source: PageSnapshot,
  converted: PageSnapshot,
  matches: MatchedElement[],
  breakpoint: string,
  renderWidth?: number,
  heightTolerance: number = DEFAULT_HEIGHT_TOLERANCE,
): LayoutAudit {
  const requestedWidth = renderWidth ?? converted.viewport_width;
  const viewportOk = Math.abs(converted.viewport_width - requestedWidth) <= 1;
  // 1px slack: scrollWidth is rounded up from fractional layout widths in some engines.
  const scrollWidthOk = converted.scroll_width <= converted.viewport_width + 1;

  const zeroArea: ZeroAreaFinding[] = [];
  for (const m of matches) {
    if (m.source.visible && m.source.area > 1 && m.converted.visible && m.converted.area === 0) {
      zeroArea.push({ element: m.element, source_path: m.source_path });
    }
  }

  const sourceHeight = source.scroll_height;
  const heightOk =
    Math.abs(converted.scroll_height - sourceHeight) <= heightTolerance * Math.max(sourceHeight, 1);

  return {
    breakpoint,
    render_width: requestedWidth,
    viewport_width: converted.viewport_width,
    viewport_ok: viewportOk,
    scroll_width: converted.scroll_width,
    scroll_width_ok: scrollWidthOk,
    source_scroll_width: source.scroll_width,
    source_overflow_x: source.overflow_x,
    source_height: sourceHeight,
    converted_height: converted.scroll_height,
    height_ok: heightOk,
    zero_area: zeroArea,
    root_element: converted.first_element_id,
    pass: viewportOk && scrollWidthOk && heightOk && zeroArea.length === 0,
  };
}

/* ─────────────────────────── pure: content presence + element counts (§7 P1-e) ───────────────── */

/**
 * §7 P1-e — the CONTENT-PRESENCE audit (the P1-a corpus guard): every visible source text string
 * ≥3 chars must appear in the converted page's visible text or be accounted for by an honest-drop
 * entry. Comparison is whitespace-normalized + case-sensitive (text content never changes case on
 * the wire; CSS `text-transform` does not alter `textContent`).
 */
export function auditContentPresence(
  source: PageSnapshot,
  converted: PageSnapshot,
  breakpoint: string,
  droppedTexts: string[] = [],
): ContentAudit {
  const haystack = converted.body_text;
  const dropped = droppedTexts.map((d) => d.trim().replace(/\s+/g, ' ')).filter((d) => d !== '');
  let present = 0;
  let droppedCount = 0;
  const missing: ContentMissingFinding[] = [];
  const seenMissing = new Set<string>();
  for (const record of source.text_nodes) {
    if (haystack.includes(record.text)) {
      present += 1;
      continue;
    }
    if (dropped.some((d) => d.includes(record.text) || record.text.includes(d))) {
      droppedCount += 1;
      continue;
    }
    const key = `${record.path}|${record.text}`;
    if (!seenMissing.has(key)) {
      seenMissing.add(key);
      missing.push({ source_path: record.path, text: record.text });
    }
  }
  return {
    breakpoint,
    total: source.text_nodes.length,
    present,
    dropped: droppedCount,
    missing,
    pass: missing.length === 0,
  };
}

/* ─────────────────────────── pure: the hardened gate verdict (§6 F6) ─────────────────────────── */

/** {@link evaluateVerifyGate} options. `divergenceThreshold` is the pipeline's R3 `verify_gate`. */
export interface VerifyGateOptions {
  divergenceThreshold: number;
}

/** The composed hardened-loop verdict (every reason is a human-readable gate-failure line). */
export interface VerifyVerdict {
  pass: boolean;
  reasons: string[];
}

/**
 * Compose the HARDENED gate verdict over one loop result (§6 F6: "a gate verdict from the
 * pre-17.1 loop is not valid"): the v17.0 inputs (V2 layout audits + the V1 divergence threshold)
 * PLUS the §7 P1-e blind-spot audits — content presence and the behavioral probes. Element-count
 * deltas and `causeStats` stay REPORT-only (they inform a fixing agent, they do not gate alone).
 */
export function evaluateVerifyGate(
  result: VerifyLoopResult,
  opts: VerifyGateOptions,
): VerifyVerdict {
  const reasons: string[] = [];
  for (const audit of result.layoutAudits.filter((a) => !a.pass)) {
    const parts: string[] = [];
    if (!audit.viewport_ok) {
      parts.push(
        `viewport not applied (measured ${String(audit.viewport_width)} != requested ` +
          `${String(audit.render_width)})`,
      );
    }
    if (!audit.scroll_width_ok) {
      parts.push(
        `horizontal overflow (scrollWidth ${String(audit.scroll_width)} > viewport ` +
          `${String(audit.viewport_width)})`,
      );
    }
    if (!audit.height_ok) {
      parts.push(
        `page height ${String(audit.converted_height)}px vs source ${String(audit.source_height)}px`,
      );
    }
    if (audit.zero_area.length > 0) {
      parts.push(
        `${String(audit.zero_area.length)} zero-area element(s) that had area in the source`,
      );
    }
    reasons.push(`V2 layout audit failed at ${audit.breakpoint}: ${parts.join('; ')}`);
  }
  if (result.divergences.length > opts.divergenceThreshold) {
    reasons.push(
      `${String(result.divergences.length)} divergence(s) exceed the verify_gate threshold ` +
        `(${String(opts.divergenceThreshold)})`,
    );
  }
  if (!result.contentAudit.pass) {
    const sample = result.contentAudit.missing
      .slice(0, 3)
      .map((m) => `"${m.text}"`)
      .join(', ');
    reasons.push(
      `content-presence audit failed: ${String(result.contentAudit.missing.length)} source text ` +
        `string(s) neither in the converted DOM nor honestly dropped (e.g. ${sample})`,
    );
  }
  for (const probe of result.behaviorProbes.filter((p) => !p.pass)) {
    reasons.push(`behavioral probe failed on ${probe.nodeId}: ${probe.detail}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Derive the MECHANICAL R1 repairs (§3) from the loop outputs — and ONLY the mechanical ones:
 *  - `dangling_ref` / `base_default` divergences → emit the explicit prop with the SOURCE value
 *    (deduped on `nodeId|prop`; the first breakpoint observed — desktop-first — wins),
 *  - a failed overflow audit where the SOURCE did not overflow AND carried its own
 *    `overflow-x: hidden|clip` → carry it onto the page root (`missing_overflow_x`).
 * Everything else (R2) stays in the divergence report. The integrator applies these via the normal
 * save path, at most {@link MAX_REPAIR_ROUNDS} rounds.
 */
export function deriveRepairs(
  divergences: Divergence[],
  layoutAudits: LayoutAudit[],
  rootNodeId?: string,
): RepairPatch[] {
  const repairs: RepairPatch[] = [];
  const seen = new Set<string>();

  for (const d of divergences) {
    if (d.cause !== 'dangling_ref' && d.cause !== 'base_default') continue;
    if (d.element === '') continue;
    const key = `${d.element}|${d.prop}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repairs.push({ nodeId: d.element, prop: d.prop, value: d.source_value, cause: d.cause });
  }

  for (const audit of layoutAudits) {
    if (audit.scroll_width_ok) continue;
    // Body `overflow-x: hidden|clip` PROPAGATES to the viewport: the source shows no horizontal
    // scrollbar even though its `scrollWidth` still reports the clipped extent (field-measured:
    // 1440 on a 1280 viewport for an absolutely-positioned hero glow the body clips). Containment
    // is therefore judged by the DECLARED clip, never by scrollWidth — a source without its own
    // clip is not mechanically repairable and stays in the report (R2).
    const carried = audit.source_overflow_x === 'hidden' || audit.source_overflow_x === 'clip';
    if (!carried) continue;
    const nodeId = rootNodeId ?? audit.root_element;
    if (nodeId === '') continue;
    // The atomic Style-Schema has only the composite `overflow` (enum without `clip`) — emit the
    // placeable equivalent (`hidden`); a literal `overflow-x` would never classify and the applier
    // would skip every overflow repair.
    const key = `${nodeId}|overflow`;
    if (seen.has(key)) continue;
    seen.add(key);
    repairs.push({
      nodeId,
      prop: 'overflow',
      value: 'hidden',
      cause: 'missing_overflow_x',
    });
  }

  return repairs;
}

/* ─────────────────────────── in-page snapshot (serialized into `page.evaluate`) ──────────────── */

/** Arguments the in-page snapshot function receives (plain JSON — Playwright-serializable). */
interface SnapshotArgs {
  props: string[];
  mode: 'source' | 'converted';
}

/**
 * The in-page walker. Executed IN the browser via `page.evaluate` (self-contained — helpers are
 * declared inside; the structural-path function is the LOCKSTEP copy of `parse.ts`'s). Source mode
 * keys every visual element under `<body>` by structural path; converted mode keys every
 * `[data-id]` element (atomic widgets carry `data-id` directly on the semantic node). The function
 * name `emcpVerifySnapshot` is a stable marker test stubs key on.
 */
function emcpVerifySnapshot(args: SnapshotArgs): PageSnapshot {
  const NON_VISUAL = ['script', 'style', 'link', 'meta', 'noscript', 'template', 'head', 'title'];
  const LOCAL_CLASS = /^e-[0-9a-f]{7,8}-[0-9a-f]{7}$/;
  const GLOBAL_CLASS = /^g-[0-9a-f]{6,10}$/;

  // LOCKSTEP copy of parse.ts structuralPath (MUST match the in-page walker copies there).
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

  // All rendered selector text (same-origin sheets; cross-origin sheets throw and are skipped) —
  // the I1 dangling-ref probe checks each style class for a rendered rule.
  let selectorText = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        const sel = (rule as CSSStyleRule).selectorText;
        if (typeof sel === 'string') selectorText += `${sel}\n`;
        const inner = (rule as CSSMediaRule).cssRules;
        if (inner !== undefined) {
          for (const r2 of Array.from(inner)) {
            const s2 = (r2 as CSSStyleRule).selectorText;
            if (typeof s2 === 'string') selectorText += `${s2}\n`;
          }
        }
      }
    } catch {
      /* cross-origin stylesheet — unreadable, skip */
    }
  }

  function snap(el: Element): ElementSnapshot {
    const cs = getComputedStyle(el);
    const props: Record<string, string> = {};
    for (const p of args.props) {
      props[p] = cs.getPropertyValue(p);
    }
    const rect = el.getBoundingClientRect();
    let text = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) text += n.textContent ?? '';
    });
    const classes = Array.from(el.classList);
    const refClasses = classes.filter((c) => LOCAL_CLASS.test(c) || GLOBAL_CLASS.test(c));
    return {
      tag: el.tagName.toLowerCase(),
      props,
      area: Math.round(rect.width * rect.height),
      visible: cs.display !== 'none' && cs.visibility !== 'hidden',
      text: text.replace(/\s+/g, ' ').trim(),
      base_classes: classes.filter((c) => /^e-[a-z0-9-]+-base$/.test(c)),
      dangling_refs: refClasses.filter((c) => !selectorText.includes(`.${c}`)),
    };
  }

  const elements: Record<string, ElementSnapshot> = {};
  let firstElementId = '';

  if (args.mode === 'converted') {
    for (const el of Array.from(document.querySelectorAll('[data-id]'))) {
      const id = el.getAttribute('data-id');
      if (id === null || id === '') continue;
      // The page-root pick skips CLASSIC html widgets (font-carry / JS-passthrough are PREPENDED /
      // appended `widgetType:'html'` nodes that cannot carry an atomic repair) so the
      // `missing_overflow_x` repair targets a node the applier can actually patch.
      if (firstElementId === '' && !el.classList.contains('elementor-widget-html')) {
        firstElementId = id;
      }
      elements[id] = snap(el);
    }
  } else if (document.body !== null) {
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();
      if (NON_VISUAL.includes(tag)) continue;
      // Skip svg INTERNALS (the <svg> root itself is kept — its wrapper size matters).
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && tag !== 'svg') continue;
      elements[structuralPath(el)] = snap(el);
    }
  }

  // ── §7 P1-e census: per-TEXT-NODE strings (content audit) + visible-element count ─────────────
  // Captured per TEXT NODE (not per element) so a bare text node beside an element child — the
  // P1-a `$0<small>/forever</small>` loss class — is its OWN auditable record. A node inside a
  // `display:none` subtree has zero client rects and is skipped (it is not visible content).
  // `MIN_TEXT` is the LOCKSTEP copy of TEXT_MATCH_MIN_LENGTH (this function is serialized into the
  // page — module constants are out of reach).
  const MIN_TEXT = 3;
  const textNodes: TextNodeRecord[] = [];
  const bodyParts: string[] = [];
  let elementCount = 0;
  if (document.body !== null) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let tn = walker.nextNode(); tn !== null; tn = walker.nextNode()) {
      const parent = tn.parentElement;
      if (parent === null) continue;
      if (NON_VISUAL.includes(parent.tagName.toLowerCase())) continue;
      const text = (tn.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text === '') continue;
      const range = document.createRange();
      range.selectNodeContents(tn);
      if (range.getClientRects().length === 0) continue; // display:none subtree / unrendered
      if (getComputedStyle(parent).visibility === 'hidden') continue;
      bodyParts.push(text);
      if (text.length >= MIN_TEXT) textNodes.push({ path: structuralPath(parent), text });
    }
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const tag = el.tagName.toLowerCase();
      if (NON_VISUAL.includes(tag)) continue;
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && tag !== 'svg') continue;
      if (el.getClientRects().length === 0) continue; // not rendered
      elementCount += 1;
    }
  }

  const doc = document.documentElement;
  const bodyStyle = document.body !== null ? getComputedStyle(document.body) : null;
  return {
    elements,
    text_nodes: textNodes,
    body_text: bodyParts.join(' ').replace(/\s+/g, ' ').trim(),
    element_count: elementCount,
    scroll_width: doc.scrollWidth,
    scroll_height: doc.scrollHeight,
    viewport_width: window.innerWidth,
    overflow_x: bodyStyle !== null ? bodyStyle.overflowX : '',
    first_element_id: firstElementId,
  };
}

/* ─────────────────────────── render harness (one page-load per target per breakpoint) ────────── */

/** Is the source input a navigable URL (vs. a raw HTML document string)? */
function isUrl(sourceUrlOrHtml: string): boolean {
  return /^(https?|file|data):/i.test(sourceUrlOrHtml.trim());
}

/** Settle a rendered page: load + fonts + eager-decode lazy images (the `_odiff.mjs` recipe). */
async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {
    /* networkidle may never fire on a static doc */
  });
  await page.waitForLoadState('load').catch(() => {
    /* already loaded */
  });
  await page
    .evaluate(async () => {
      document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
        (img as HTMLImageElement).loading = 'eager';
      });
      // Scroll through the page so lazy/scroll-triggered content materializes, then return to top.
      for (let y = 0; y < document.body.scrollHeight; y += 800) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      window.scrollTo(0, 0);
      await Promise.all(
        Array.from(document.images).map((img) => img.decode().catch(() => undefined)),
      );
      const fonts = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts;
      if (fonts?.ready !== undefined) await fonts.ready;
    })
    .catch(() => {
      /* settle is best-effort */
    });
  await page.waitForTimeout(300);
}

/** One target render at one breakpoint: snapshot + full-page screenshot in a single page load. */
async function renderTarget(
  browser: BrowserPort,
  target: { url?: string; html?: string },
  width: number,
  mode: SnapshotArgs['mode'],
): Promise<{ snapshot: PageSnapshot; png: Buffer }> {
  return browser.withPage(
    async (page) => {
      if (target.url !== undefined) {
        await page.goto(target.url, { waitUntil: 'load' });
      } else {
        await page.setContent(target.html ?? '', { waitUntil: 'load' });
      }
      await settlePage(page);
      const snapshot = await page.evaluate(emcpVerifySnapshot, {
        props: [...VERIFY_PROPS],
        mode,
      });
      const png = Buffer.from(await page.screenshot({ fullPage: true, animations: 'disabled' }));
      return { snapshot, png };
    },
    { viewport: { width, height: 900 }, reducedMotion: 'reduce' },
  );
}

/* ─────────────────────────── V3 pixel diff (dynamic optional deps, as in fidelity.ts) ────────── */

/** Minimal local type of `pngjs`'s decoded PNG. */
interface DecodedPng {
  data: Buffer;
  width: number;
  height: number;
}

/** Minimal local type of `pixelmatch`'s default export. */
type PixelmatchFn = (
  img1: Buffer,
  img2: Buffer,
  output: Buffer | null,
  width: number,
  height: number,
  options?: { threshold?: number },
) => number;

/** Dynamic import via an indirection so tsc never resolves the optional dep at build time. */
async function loadOptional<T>(specifier: string): Promise<T> {
  return (await import(/* @vite-ignore */ specifier)) as T;
}

/** Crop an RGBA buffer to a top-left w×h box (row-by-row copy). */
function cropRgba(img: DecodedPng, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = y * img.width * 4;
    img.data.copy(out, y * w * 4, srcStart, srcStart + w * 4);
  }
  return out;
}

/** Full-page pixel mismatch ratio over the COMMON box (the `_odiff.mjs` reference recipe). */
async function pixelRatio(aPng: Buffer, bPng: Buffer): Promise<number> {
  const pngMod = await loadOptional<{ PNG: { sync: { read(b: Buffer): DecodedPng } } }>('pngjs');
  const pmMod = await loadOptional<{ default: PixelmatchFn }>('pixelmatch');
  const a = pngMod.PNG.sync.read(aPng);
  const b = pngMod.PNG.sync.read(bPng);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const total = width * height;
  if (total === 0) return 1;
  const aData = a.width === width && a.height === height ? a.data : cropRgba(a, width, height);
  const bData = b.width === width && b.height === height ? b.data : cropRgba(b, width, height);
  const changed = pmMod.default(aData, bData, null, width, height, { threshold: 0.1 });
  return changed / total;
}

/* ─────────────────────────── behavioral probes (§7 P1-e — contract 16 machinery) ─────────────── */

/** Arguments the in-page opacity probe receives (plain JSON — Playwright-serializable). */
interface OpacityProbeArgs {
  /** Per target: every `data-id`/`data-interaction-id` spelling to try + the authored trigger. */
  targets: Array<{ key: string; ids: string[] }>;
  /** Per-frame sampling cadence + count (≈1s of samples covers the default 600ms animations). */
  sampleMs: number;
  samples: number;
}

/** One target's raw opacity observations (in-page wire shape). */
export interface OpacityProbeRow {
  found: boolean;
  /** Computed opacity at scroll-top, BEFORE the element is scrolled into view (−1 when not found). */
  initial: number;
  /** Per-frame samples AFTER `scrollIntoView` (the entrance animation window). */
  series: number[];
}

/**
 * The in-page opacity sampler (self-contained, serialized via `page.evaluate`; the function name
 * `emcpOpacityProbe` is a stable marker test stubs key on). Initial opacities are read for ALL
 * targets at scroll-top FIRST (a correct scrollIn element below the fold is still hidden), then
 * each target is scrolled into view and sampled per frame. The page is loaded WITHOUT the settle
 * scroll-through and with `reducedMotion:'no-preference'` — pre-firing the entrance animations
 * would destroy the very ramp the probe asserts.
 */
async function emcpOpacityProbe(args: OpacityProbeArgs): Promise<Record<string, OpacityProbeRow>> {
  const find = (ids: string[]): Element | null => {
    for (const id of ids) {
      const el =
        document.querySelector(`[data-id="${id}"]`) ??
        document.querySelector(`[data-interaction-id="${id}"]`);
      if (el !== null) return el;
    }
    return null;
  };
  const opacity = (el: Element): number => {
    const v = Number.parseFloat(getComputedStyle(el).opacity);
    return Number.isNaN(v) ? 1 : v;
  };

  window.scrollTo(0, 0);
  const out: Record<string, OpacityProbeRow> = {};
  for (const t of args.targets) {
    const el = find(t.ids);
    out[t.key] = { found: el !== null, initial: el === null ? -1 : opacity(el), series: [] };
  }
  for (const t of args.targets) {
    const el = find(t.ids);
    const row = out[t.key];
    if (el === null || row === undefined) continue;
    el.scrollIntoView({ block: 'center' });
    for (let i = 0; i < args.samples; i++) {
      row.series.push(opacity(el));
      await new Promise((r) => setTimeout(r, args.sampleMs));
    }
  }
  return out;
}

/** Opacity considered "visible" (computed opacity is float-noisy at the end of a fade). */
const OPACITY_VISIBLE = 0.99;

/** Turn one target's raw observations into the honest contract-16 probe row. */
export function judgeOpacityProbe(
  target: InteractionProbeTarget,
  row: OpacityProbeRow | undefined,
): BehaviorProbe {
  if (row === undefined || !row.found) {
    return {
      kind: 'interactions',
      nodeId: target.element_id,
      pass: false,
      detail: `element not rendered (no [data-id]/[data-interaction-id] match for "${target.element_id}")`,
    };
  }
  const final =
    row.series.length > 0 ? (row.series[row.series.length - 1] ?? row.initial) : row.initial;
  const lowest = Math.min(row.initial, ...row.series);
  const visible = final >= OPACITY_VISIBLE;
  const ramped = lowest < OPACITY_VISIBLE && visible;
  const observed =
    `opacity ${String(row.initial)} → [${row.series.map((s) => String(s)).join(', ')}]` +
    ` (trigger '${target.trigger}')`;
  if (target.trigger === 'scrollIn') {
    // P1-c guard: the sample MUST show a <1 → 1 ramp — a constant 1.0 is exactly the
    // "no initial hide" bug class (blob present, nodes stamped, nothing actually animates).
    return {
      kind: 'interactions',
      nodeId: target.element_id,
      pass: ramped,
      detail: ramped
        ? `scrollIn ramp observed: ${observed}`
        : `NO <1 → 1 opacity ramp on a scrollIn element (initial hide missing or animation dead): ${observed}`,
    };
  }
  // Non-scroll triggers (load/hover/…) may have completed before sampling — assert end-state
  // visibility and report the ramp honestly when it was observable.
  return {
    kind: 'interactions',
    nodeId: target.element_id,
    pass: visible,
    detail: visible
      ? `element visible at end state${ramped ? ' (ramp observed)' : ' (ramp not observable post-load)'}: ${observed}`
      : `element NOT visible at end state: ${observed}`,
  };
}

/**
 * §7 P1-e — behaviorally probe the authored interactions on the SAVED page: ONE extra page load
 * (animations ENABLED — the snapshot renders use `reducedMotion:'reduce'`, which would freeze the
 * very ramp this asserts), per-frame opacity sampling per element. Probe failures are honest
 * `pass:false` rows; an evaluation fault yields one failing row per target, never a silent skip.
 */
async function probeInteractions(
  browser: BrowserPort,
  pageUrl: string,
  width: number,
  targets: InteractionProbeTarget[],
): Promise<BehaviorProbe[]> {
  return browser.withPage(
    async (page) => {
      await page.goto(pageUrl, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle').catch(() => {
        /* static page */
      });
      // NO settlePage here: its scroll-through would pre-fire every scrollIn animation.
      await page.waitForTimeout(200);
      let rows: Record<string, OpacityProbeRow> = {};
      let probeError = '';
      try {
        rows = await page.evaluate(emcpOpacityProbe, {
          targets: targets.map((t) => ({ key: t.element_id, ids: idCandidates(t.element_id) })),
          sampleMs: 80,
          samples: 12,
        });
      } catch (err) {
        probeError = (err as Error).message;
      }
      if (probeError !== '') {
        return targets.map((t) => ({
          kind: 'interactions' as const,
          nodeId: t.element_id,
          pass: false,
          detail: `opacity probe failed: ${probeError}`,
        }));
      }
      return targets.map((t) => judgeOpacityProbe(t, rows[t.element_id]));
    },
    { viewport: { width, height: 900 }, reducedMotion: 'no-preference' },
  );
}

/* ─────────────────────────── runVerifyLoop (the loop entry) ──────────────────────────────────── */

/** The default browser port (the WP-H03 shared pool) when the caller passes a partial bundle. */
const defaultPorts: VerifyPorts = { browser: { withPage: defaultWithPage } };

/**
 * Run the verification loop (§2 + the §7 P1-d/P1-e hardening): render the SOURCE and the CONVERTED
 * page at EVERY breakpoint — each at its representative DEVICE width ({@link verifyRenderWidth},
 * never a `max` boundary) — element-match, diff the fixed prop set with cause attribution (V1),
 * audit layout (V2, viewport-asserted), pixel-diff (V3), audit content presence + element counts,
 * behaviorally probe the authored interactions, and derive the bounded mechanical repairs (R1).
 * READ-ONLY — never saves; the integrator applies `repairs` through the normal save path
 * (≤ {@link MAX_REPAIR_ROUNDS} rounds) and re-runs. Only a Chromium-unavailable error propagates
 * (mirrors `fidelityCheck`); a failed pixel diff is an honest `{ratio: 1, error}` row, never a
 * silent omission.
 */
export async function runVerifyLoop(
  ports: VerifyPorts | undefined,
  input: VerifyLoopInput,
): Promise<VerifyLoopResult> {
  const browser = ports?.browser ?? defaultPorts.browser;
  const breakpoints =
    input.breakpoints.length > 0
      ? input.breakpoints
      : [{ key: 'desktop', width: 1280, direction: 'min' } as BreakpointSpec];
  const sourceTarget = isUrl(input.sourceUrlOrHtml)
    ? { url: input.sourceUrlOrHtml.trim() }
    : { html: input.sourceUrlOrHtml };

  const divergences: Divergence[] = [];
  const layoutAudits: LayoutAudit[] = [];
  const pixelScore: PixelScoreEntry[] = [];
  const elementCounts: ElementCountDelta[] = [];

  // The content audit runs over the WIDEST render pair (most content visible at desktop widths).
  let widest: {
    width: number;
    breakpoint: string;
    source: PageSnapshot;
    converted: PageSnapshot;
  } | null = null;

  for (const bp of breakpoints) {
    const breakpoint = String(bp.key);
    // §7 P1-d: measure INSIDE the breakpoint's range — a `max` breakpoint renders at its device
    // width (mobile → 390), never at the boundary (767) that let a 743px-wide layout "pass".
    const renderWidth = verifyRenderWidth(bp);
    const source = await renderTarget(browser, sourceTarget, renderWidth, 'source');
    const converted = await renderTarget(browser, { url: input.pageUrl }, renderWidth, 'converted');

    const matches = matchElements(source.snapshot, converted.snapshot, input.idMap);
    divergences.push(...diffMatchedElements(matches, breakpoint, input.ledger));
    layoutAudits.push(
      auditLayout(
        source.snapshot,
        converted.snapshot,
        matches,
        breakpoint,
        renderWidth,
        input.heightTolerance ?? DEFAULT_HEIGHT_TOLERANCE,
      ),
    );
    elementCounts.push({
      breakpoint,
      source_count: source.snapshot.element_count,
      converted_count: converted.snapshot.element_count,
      delta: converted.snapshot.element_count - source.snapshot.element_count,
    });
    if (widest === null || renderWidth > widest.width) {
      widest = {
        width: renderWidth,
        breakpoint,
        source: source.snapshot,
        converted: converted.snapshot,
      };
    }

    try {
      pixelScore.push({ breakpoint, ratio: await pixelRatio(source.png, converted.png) });
    } catch (err) {
      // Honest worst-score row — the loop's V1/V2 outputs stand on their own.
      pixelScore.push({ breakpoint, ratio: 1, error: (err as Error).message });
    }
  }

  // `widest` is always set (breakpoints is non-empty by construction); guarded for the type system.
  const contentAudit: ContentAudit =
    widest !== null
      ? auditContentPresence(widest.source, widest.converted, widest.breakpoint, input.droppedTexts)
      : { breakpoint: '', total: 0, present: 0, dropped: 0, missing: [], pass: true };

  const probeTargets = input.interactions ?? [];
  const behaviorProbes =
    probeTargets.length > 0
      ? await probeInteractions(browser, input.pageUrl, widest?.width ?? 1280, probeTargets)
      : [];

  return {
    divergences,
    layoutAudits,
    pixelScore,
    repairs: deriveRepairs(divergences, layoutAudits, input.rootNodeId),
    contentAudit,
    elementCounts,
    behaviorProbes,
    causeStats: computeCauseStats(divergences),
  };
}
