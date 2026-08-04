/**
 * Contract 16 §4 — Tier 2 NATIVE INTERACTIONS emitter.
 *
 * Pure stage: `(elements, behaviors-on-IR, ctx) → { elements, report, authored, warnings }`. Takes
 * the ASSEMBLE/HOIST-produced `ElementNode[]` plus the CLASSIFY-annotated IR forest
 * (`IrNode.behaviors` + the PARSE probe carriers `animationProbe`/`transitionProbe`) and converts
 * every `entrance-animation` / `hover-effect` behavior with EXTRACTABLE intent into a native V4
 * interaction attached to its assembled element. All other behavior kinds belong to tiers 1/3/4 and
 * are NOT consumed (they are tiered by their own stages — nothing here is a silent drop, §0.2).
 *
 * Mapping (contract 16 §4, frozen):
 *   - opacity-only keyframes → `fade`; translate keyframes → `slide` + dominant-axis direction;
 *     scale keyframes → `scale`. Duration/delay/easing come from the captured computed values
 *     (duration clamped ≥{@link MIN_DURATION_MS}, default {@link DEFAULT_DURATION_MS}).
 *   - Scroll-triggered signals (AOS `data-aos` / aos|wow|reveal classnames) → trigger `scrollIn`,
 *     else `load`. `hover` triggers and easings beyond `easeIn` are Pro-gated per S08 per-enum
 *     gating (`capabilities.pro`); a Pro easing on a free site DEGRADES to the default easing
 *     (config omitted) with a warning, never a drop.
 *   - Emit EXACTLY the S08 frozen shape (`WP-S08-interactions-findings.md`): `$$type` keys
 *     `interaction-item` / `animation-preset-props` / `timing-config` / `config-v2` / `size`
 *     (NEVER `animation-config` / `time-size` — PHP `Validation::sanitize` drops wrong keys with
 *     NO error), `interaction_id` OMITTED (the Parser auto-assigns it on save), max
 *     {@link MAX_INTERACTIONS_PER_ELEMENT} items per element, and the element field is the native
 *     wire format: a JSON-encoded STRING of `{version:1, items:[…]}`.
 *   - Anything non-expressible lands tier 4 with a reason (the orchestrator may upgrade it to
 *     tier 3 when JS passthrough is bundled, §5).
 *
 * Honesty invariants (§8): every candidate behavior appears in `report` with a tier (2 or 4) —
 * count(candidates) == count(report). Tier 2 is PROVISIONAL until post-save readback: PHP
 * sanitizes with SILENT drop semantics, so the orchestrator MUST call {@link postSaveAssert} on
 * the read-back tree and downgrade any `dropped_by_sanitizer` element's behaviors (§0.3, §8.2).
 * Zero candidates → the element forest passes through byte-identically (§8.5).
 *
 * PURE + deterministic given `(elements, ir, ctx)`: no I/O, no WP client, inputs never mutated
 * (the returned `elements` are a deep clone; report entries are clones of the IR behaviors with
 * `tier`/`reason` assigned — the IR annotations themselves stay untouched).
 */

import { isAtomicNode } from '../authoring/contract.js';
import type { ElementNode } from '../authoring/contract.js';
import type { SourcePathIdMap } from './coverage.js';
import type { BoxRect, DetectedBehavior, IrNode, SiteCapabilities } from './types.js';

/* ─────────────────────────── constants (S08 / contract 16 §4) ────────────────────────────────── */

/** PHP `Validation` caps interactions at 5 per element (throws above 5 — S08). */
export const MAX_INTERACTIONS_PER_ELEMENT = 5;

/** Duration floor (contract 16 §4 "clamp ≥100ms"). */
export const MIN_DURATION_MS = 100;

/** Duration default when the computed value is missing/zero/unparseable (contract 16 §4). */
export const DEFAULT_DURATION_MS = 600;

/** Free-tier triggers (S08 per-enum Pro gating; `hover`/`click`/`scrollOut`/`scrollOn` are Pro). */
const FREE_TRIGGERS: ReadonlySet<string> = new Set(['load', 'scrollIn']);

/** Free-tier easings (S08: free = `easeIn`; everything else is Pro). */
const FREE_EASINGS: ReadonlySet<string> = new Set(['easeIn']);

/** Translation below this many px is noise, not a slide intent. */
const TRANSLATE_EPSILON_PX = 1;

/** Scale delta below this is noise, not a scale intent. */
const SCALE_EPSILON = 0.01;

/** Opacity delta below this is noise, not a fade intent. */
const OPACITY_EPSILON = 0.01;

/* ─────────────────────────── the S08 frozen wire shape ───────────────────────────────────────── */

/** A `{$$type:'string'}` envelope (S08 item fields). */
export interface InteractionStringProp {
  $$type: 'string';
  value: string;
}

/** A `{$$type:'size'}` ms envelope — NOTE: `$$type` is `size`, NOT `time-size` (S08 gotcha). */
export interface InteractionSizeProp {
  $$type: 'size';
  value: { unit: 'ms'; size: number };
}

/** The `animation-preset-props` value (S08; `config` is OPTIONAL and keyed `config-v2`). */
export interface InteractionAnimationValue {
  effect: InteractionStringProp;
  type: InteractionStringProp;
  /** REQUIRED by the sanitizer — may be the empty string. */
  direction: InteractionStringProp;
  timing_config: {
    $$type: 'timing-config';
    value: { duration: InteractionSizeProp; delay: InteractionSizeProp };
  };
  config?: {
    $$type: 'config-v2';
    value: { easing: InteractionStringProp };
  };
}

/** One S08 interaction item. `interaction_id` is OMITTED — the Parser auto-assigns it on save. */
export interface InteractionItem {
  $$type: 'interaction-item';
  value: {
    trigger: InteractionStringProp;
    animation: { $$type: 'animation-preset-props'; value: InteractionAnimationValue };
  };
}

/** The decoded interactions blob; the wire format is `JSON.stringify` of this (S08). */
export interface InteractionsBlob {
  version: 1;
  items: InteractionItem[];
}

/* ─────────────────────────── stage context / result shapes ───────────────────────────────────── */

/** Stage context: the live capability probe + the pipeline `source_path → element_id` map. */
export interface InteractionsContext {
  capabilities: SiteCapabilities;
  /** `buildSourcePathIdMap` output (pipeline); a miss reports the behavior tier 4, never guesses. */
  id_map: SourcePathIdMap;
}

/** One element this stage authored interactions onto (drives {@link postSaveAssert}). */
export interface AuthoredInteractions {
  element_id: string;
  /** The IR `source_path` of the (first) behavior node that landed on this element. */
  source_path: string;
  /** TOTAL item count written to the element (pre-existing + emitted) — the readback expectation. */
  items: number;
}

/** Stage result. `report` has one TIERED entry per candidate behavior (§8 invariant 1). */
export interface InteractionsResult {
  /** Deep-cloned forest with the interactions JSON strings attached (inputs never mutated). */
  elements: ElementNode[];
  /** Clones of every `entrance-animation`/`hover-effect` candidate, `tier` ALWAYS set (2 or 4). */
  report: DetectedBehavior[];
  authored: AuthoredInteractions[];
  warnings: string[];
}

/* ─────────────────────────── intent model (internal) ─────────────────────────────────────────── */

type Trigger = 'load' | 'scrollIn' | 'hover';
type Effect = 'fade' | 'slide' | 'scale';
type EffectType = 'in' | 'out';
type Easing = 'easeIn' | 'easeOut' | 'easeInOut' | 'linear';

/** The extracted animation intent one behavior maps to (pre-envelope). */
interface Intent {
  trigger: Trigger;
  effect: Effect;
  type: EffectType;
  direction: string;
  durationMs: number;
  delayMs: number;
  /** `null` = omit the optional `config` block (Elementor's default easing applies). */
  easing: Easing | null;
  /** Extra honesty note folded into the tier-2 reason (e.g. an assumed library default). */
  note?: string;
}

type IntentResult = { ok: true; intent: Intent } | { ok: false; reason: string };

/* ─────────────────────────── css value parsing ───────────────────────────────────────────────── */

/** Parse a computed time (`0.8s`, `800ms`, comma lists take the first segment) to ms, or null. */
function parseMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seg = (value.split(',')[0] ?? '').trim();
  const m = /^(-?\d*\.?\d+)(ms|s)?$/.exec(seg);
  if (m === null) return null;
  const n = Number.parseFloat(m[1] ?? '');
  if (Number.isNaN(n)) return null;
  // Computed time values default to seconds (`0.8s`); a bare number is treated as seconds too.
  return (m[2] ?? 's') === 's' ? n * 1000 : n;
}

/** Duration per §4: unparseable/non-positive → {@link DEFAULT_DURATION_MS}, else clamp ≥100ms. */
function resolveDurationMs(raw: string | undefined): number {
  const ms = parseMs(raw);
  if (ms === null || ms <= 0) return DEFAULT_DURATION_MS;
  return Math.max(MIN_DURATION_MS, Math.round(ms));
}

/** Delay: unparseable → 0, else clamp ≥0 (no floor — a 0ms delay is meaningful). */
function resolveDelayMs(raw: string | undefined): number {
  const ms = parseMs(raw);
  if (ms === null) return 0;
  return Math.max(0, Math.round(ms));
}

/** AOS `data-aos-duration`/`-delay` attrs are plain ms integers (no unit). */
function parseAttrMs(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a CSS timing-function (or an AOS easing name) to an Elementor easing preset. Prefix-matched
 * so AOS variants (`ease-in-sine`, …) resolve; `cubic-bezier(…)`/`steps(…)` map to null (omit the
 * optional config block — never guess a preset).
 */
function mapEasing(raw: string | undefined): Easing | null {
  if (raw === undefined) return null;
  const v = (raw.split(',')[0] ?? '').trim().toLowerCase();
  if (v === 'linear') return 'linear';
  if (v.startsWith('ease-in-out')) return 'easeInOut';
  if (v.startsWith('ease-out')) return 'easeOut';
  if (v.startsWith('ease-in')) return 'easeIn';
  if (v === 'ease') return 'easeInOut';
  return null;
}

/* ─────────────────────────── transform parsing (slide/scale intent) ──────────────────────────── */

/** Flattened 2D translate+scale view of a transform value (rotation/skew carry no §4 intent). */
interface Transform2D {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

const IDENTITY: Transform2D = { tx: 0, ty: 0, sx: 1, sy: 1 };

/** A transform length: `%` resolves against the box basis; other units keep their magnitude
 *  (sign + axis dominance is all the direction inference needs). */
function parseTransformLength(raw: string | undefined, basis: number): number {
  if (raw === undefined) return 0;
  const m = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(raw.trim());
  if (m === null) return 0;
  const n = Number.parseFloat(m[1] ?? '');
  if (Number.isNaN(n)) return 0;
  return (m[2] ?? '') === '%' ? (n / 100) * basis : n;
}

/** A bare number (scale factors / matrix entries). */
function parseFactor(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw.trim());
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Parse a transform value — author keyframe syntax (`translateY(40px)`) OR a computed matrix
 * (`matrix(a,b,c,d,tx,ty)`, what `getComputedStyle` returns for the hover delta) — into the flat
 * translate+scale view. Unrecognized functions (rotate/skew/perspective) contribute nothing.
 * `undefined` input → null (no information); `none`/`''` → identity.
 */
function parseTransform(value: string | undefined, box: BoxRect): Transform2D | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'none') return { ...IDENTITY };
  const t: Transform2D = { ...IDENTITY };
  const fnRe = /([a-z0-9]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(v)) !== null) {
    const fn = m[1] ?? '';
    const args = (m[2] ?? '').split(',').map((s) => s.trim());
    switch (fn) {
      case 'translate':
        t.tx += parseTransformLength(args[0], box.width);
        t.ty += parseTransformLength(args[1], box.height);
        break;
      case 'translatex':
        t.tx += parseTransformLength(args[0], box.width);
        break;
      case 'translatey':
        t.ty += parseTransformLength(args[0], box.height);
        break;
      case 'translate3d':
        t.tx += parseTransformLength(args[0], box.width);
        t.ty += parseTransformLength(args[1], box.height);
        break;
      case 'scale':
        t.sx *= parseFactor(args[0], 1);
        t.sy *= parseFactor(args[1] ?? args[0], 1);
        break;
      case 'scalex':
        t.sx *= parseFactor(args[0], 1);
        break;
      case 'scaley':
        t.sy *= parseFactor(args[0], 1);
        break;
      case 'scale3d':
        t.sx *= parseFactor(args[0], 1);
        t.sy *= parseFactor(args[1], 1);
        break;
      case 'matrix':
        // matrix(a, b, c, d, tx, ty) — a/d approximate scale, e/f are the translation.
        t.sx *= parseFactor(args[0], 1);
        t.sy *= parseFactor(args[3], 1);
        t.tx += parseFactor(args[4], 0);
        t.ty += parseFactor(args[5], 0);
        break;
      case 'matrix3d':
        // column-major 4x4: m11/m22 ≈ scale, m41/m42 = translation.
        t.sx *= parseFactor(args[0], 1);
        t.sy *= parseFactor(args[5], 1);
        t.tx += parseFactor(args[12], 0);
        t.ty += parseFactor(args[13], 0);
        break;
      default:
        // rotate/skew/perspective — no fade/slide/scale intent (§4).
        break;
    }
  }
  return t;
}

/** The classified motion between two transform states (`from` → `to`). */
interface Motion {
  slide: boolean;
  scale: boolean;
  /**
   * Elementor runtime direction semantics (`getKeyframes` in `interactions.js` /
   * `buildKeyframesFromPreset` in `interactions-pro.js`): for `in` the direction is the side the
   * element comes FROM (`in`+`bottom` → `y:[+d, 0]`, enters from below); for `out` it is the side
   * moved TOWARD (`out`+`bottom` → `y:[0, +d]`, exits downward) — the sign flips between the two.
   */
  direction: 'left' | 'right' | 'top' | 'bottom';
  /** Slide ends at rest (≈ identity) → entrance (`in`); ends offset → exit (`out`). */
  slideType: EffectType;
  /** Growing toward the end state → `in`; shrinking → `out`. */
  scaleType: EffectType;
}

/** Classify the §4 motion intent between two parsed transforms. */
function classifyMotion(from: Transform2D, to: Transform2D): Motion {
  const dx = from.tx - to.tx;
  const dy = from.ty - to.ty;
  const slide = Math.max(Math.abs(dx), Math.abs(dy)) > TRANSLATE_EPSILON_PX;
  const scale =
    Math.max(Math.abs(from.sx - to.sx), Math.abs(from.sy - to.sy)) > SCALE_EPSILON;
  const slideType: EffectType =
    Math.abs(to.tx) + Math.abs(to.ty) <= TRANSLATE_EPSILON_PX ? 'in' : 'out';
  // `in` = side the element comes FROM (sign of from−to); `out` = side moved TOWARD (sign of
  // to−from) — see the Motion.direction doc (runtime keyframe semantics, the sign flips for `out`).
  const ox = slideType === 'out' ? -dx : dx;
  const oy = slideType === 'out' ? -dy : dy;
  const direction: Motion['direction'] =
    Math.abs(ox) >= Math.abs(oy) ? (ox < 0 ? 'left' : 'right') : oy < 0 ? 'top' : 'bottom';
  const scaleType: EffectType = to.sx + to.sy >= from.sx + from.sy ? 'in' : 'out';
  return { slide, scale, direction, slideType, scaleType };
}

/* ─────────────────────────── trigger / declarative-signal helpers ────────────────────────────── */

/** Lowercased class tokens of an IR node. */
function classTokens(node: IrNode): string[] {
  return (node.attrs['class'] ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '');
}

/**
 * Scroll-trigger signal (§4: "IntersectionObserver/AOS classnames → scrollIn"). `data-aos` and the
 * scroll-reveal library classnames (exact `aos`/`wow` per the classifier's ambiguity rule,
 * substring `reveal`) all reveal on scroll; `animate__*`/plain keyframes run on load.
 */
function isScrollTriggered(node: IrNode): boolean {
  if (node.attrs['data-aos'] !== undefined) return true;
  return classTokens(node).some(
    (tok) => tok === 'aos' || tok === 'wow' || tok.includes('reveal') || tok.startsWith('aos-'),
  );
}

/** AOS direction token → the side the element comes FROM (`fade-up` moves up = comes from bottom). */
const AOS_VERTICAL: Readonly<Record<string, string>> = { up: 'bottom', down: 'top' };
const AOS_HORIZONTAL: Readonly<Record<string, string>> = { left: 'right', right: 'left' };

/** Map a `data-aos` value to a preset intent, or null when there is no fade/slide/scale equivalent. */
function aosIntent(
  value: string,
): { effect: Effect; type: EffectType; direction: string; note?: string } | null {
  const parts = value.split('-');
  const family = parts[0] ?? '';
  const vertical = parts.map((p) => AOS_VERTICAL[p]).find((d) => d !== undefined);
  const horizontal = parts.map((p) => AOS_HORIZONTAL[p]).find((d) => d !== undefined);
  const direction =
    vertical !== undefined && horizontal !== undefined
      ? `${vertical}-${horizontal}`
      : (vertical ?? horizontal ?? '');
  if (family === 'fade' || family === 'slide') {
    // A directional fade/slide is dominated by its motion → slide; a bare fade stays fade (§4).
    if (direction === '') {
      return family === 'fade' ? { effect: 'fade', type: 'in', direction: '' } : null;
    }
    return { effect: 'slide', type: 'in', direction };
  }
  if (family === 'zoom') {
    // Entrance zoom (in or out variant) → the scale preset; the zoom-out nuance is noted.
    return {
      effect: 'scale',
      type: 'in',
      direction: '',
      ...(parts[1] === 'out' ? { note: `aos '${value}' approximated as scale in` } : {}),
    };
  }
  return null; // flip-* etc. — not expressible as fade/slide/scale.
}

/* ─────────────────────────── per-kind intent derivation ──────────────────────────────────────── */

/** Derive the intent of an `entrance-animation` behavior (probe first, declarative fallback). */
function deriveEntranceIntent(node: IrNode): IntentResult {
  const trigger: Trigger = isScrollTriggered(node) ? 'scrollIn' : 'load';
  const probe = node.animationProbe;

  if (probe !== undefined) {
    const from = parseTransform(probe.transform?.from, node.box);
    const to = parseTransform(probe.transform?.to, node.box);
    const motion = from !== null && to !== null ? classifyMotion(from, to) : null;
    const opacity =
      probe.opacity !== undefined &&
      Math.abs(probe.opacity.to - probe.opacity.from) > OPACITY_EPSILON
        ? probe.opacity
        : undefined;

    let effect: Effect;
    let direction = '';
    let type: EffectType;
    if (motion !== null && motion.slide) {
      effect = 'slide';
      direction = motion.direction;
      type = motion.slideType;
    } else if (motion !== null && motion.scale) {
      effect = 'scale';
      type = motion.scaleType;
    } else if (opacity !== undefined) {
      effect = 'fade';
      type = opacity.to > opacity.from ? 'in' : 'out';
    } else {
      const animated = probe.keyframeProps.join('+');
      return {
        ok: false,
        reason: `keyframes '${probe.name}' animate ${animated === '' ? 'no extractable property' : `'${animated}'`} — no opacity/translate/scale intent (fade/slide/scale only, §4)`,
      };
    }
    // Opacity sign (when both signals exist) is the stronger in/out cue.
    if (opacity !== undefined) type = opacity.to > opacity.from ? 'in' : 'out';
    return {
      ok: true,
      intent: {
        trigger,
        effect,
        type,
        direction,
        durationMs: resolveDurationMs(probe.duration),
        delayMs: resolveDelayMs(probe.delay),
        easing: mapEasing(probe.easing),
      },
    };
  }

  // Declarative fallback 1: AOS attribute (no keyframes run headless until the lib boots).
  const aos = node.attrs['data-aos'];
  if (aos !== undefined && aos.trim() !== '') {
    const mapped = aosIntent(aos.trim().toLowerCase());
    if (mapped === null) {
      return { ok: false, reason: `data-aos '${aos}' has no fade/slide/scale equivalent (§4)` };
    }
    const durAttr = parseAttrMs(node.attrs['data-aos-duration']);
    const delayAttr = parseAttrMs(node.attrs['data-aos-delay']);
    return {
      ok: true,
      intent: {
        trigger: 'scrollIn',
        effect: mapped.effect,
        type: mapped.type,
        direction: mapped.direction,
        durationMs:
          durAttr === null || durAttr <= 0
            ? DEFAULT_DURATION_MS
            : Math.max(MIN_DURATION_MS, Math.round(durAttr)),
        delayMs: delayAttr === null ? 0 : Math.max(0, Math.round(delayAttr)),
        easing: mapEasing(node.attrs['data-aos-easing']),
        ...(mapped.note !== undefined ? { note: mapped.note } : {}),
      },
    };
  }

  // Declarative fallback 2: classname intent (fade-in/animate__fade*…) or a bare reveal-library
  // token whose documented default is a fade reveal.
  const tokens = classTokens(node);
  const fadeTok = tokens.find((t) => t.includes('fade'));
  const libTok = tokens.find((t) => t === 'aos' || t === 'wow' || t.includes('reveal'));
  if (fadeTok !== undefined || libTok !== undefined) {
    return {
      ok: true,
      intent: {
        trigger,
        effect: 'fade',
        type: 'in',
        direction: '',
        durationMs: DEFAULT_DURATION_MS,
        delayMs: 0,
        easing: null,
        ...(fadeTok === undefined
          ? { note: `assumed '${libTok ?? ''}' library default (fade in)` }
          : {}),
      },
    };
  }

  return {
    ok: false,
    reason: 'no extractable animation intent (no keyframes probe, data-aos, or preset classname)',
  };
}

/** Derive the intent of a `hover-effect` behavior from the forced-`:hover` computed delta. */
function deriveHoverIntent(node: IrNode): IntentResult {
  const hover = node.hoverComputed ?? {};
  const transition = node.transitionProbe;

  const base = parseTransform(node.computed['transform'], node.box) ?? { ...IDENTITY };
  const hoverTransformRaw = hover['transform'];
  const hoverT =
    hoverTransformRaw !== undefined ? parseTransform(hoverTransformRaw, node.box) : null;
  const motion = hoverT !== null ? classifyMotion(base, hoverT) : null;

  const baseOpacity = Number.parseFloat(node.computed['opacity'] ?? '1');
  const hoverOpacityRaw = hover['opacity'];
  const hoverOpacity =
    hoverOpacityRaw !== undefined ? Number.parseFloat(hoverOpacityRaw) : Number.NaN;
  const opacityDelta =
    !Number.isNaN(hoverOpacity) && Math.abs(hoverOpacity - baseOpacity) > OPACITY_EPSILON;

  let effect: Effect;
  let direction = '';
  let type: EffectType;
  if (motion !== null && motion.slide) {
    effect = 'slide';
    direction = motion.direction;
    type = motion.slideType;
  } else if (motion !== null && motion.scale) {
    effect = 'scale';
    type = motion.scaleType;
  } else if (opacityDelta) {
    effect = 'fade';
    type = hoverOpacity > baseOpacity ? 'in' : 'out';
  } else {
    const changed = Object.keys(hover).join(',');
    return {
      ok: false,
      reason: `hover delta (${changed === '' ? 'none' : changed}) not expressible as fade/slide/scale (§4)`,
    };
  }
  return {
    ok: true,
    intent: {
      trigger: 'hover',
      effect,
      type,
      direction,
      durationMs: resolveDurationMs(transition?.duration),
      delayMs: 0, // transition-delay is not captured by the probe — honest 0.
      easing: mapEasing(transition?.easing),
    },
  };
}

/* ─────────────────────────── item building / blob handling ───────────────────────────────────── */

function str(value: string): InteractionStringProp {
  return { $$type: 'string', value };
}

function msSize(size: number): InteractionSizeProp {
  return { $$type: 'size', value: { unit: 'ms', size } };
}

/** Build one EXACT S08 interaction item from an intent (`interaction_id` omitted by design). */
export function buildInteractionItem(intent: {
  trigger: string;
  effect: string;
  type: string;
  direction: string;
  durationMs: number;
  delayMs: number;
  easing: string | null;
}): InteractionItem {
  const animation: InteractionAnimationValue = {
    effect: str(intent.effect),
    type: str(intent.type),
    direction: str(intent.direction),
    timing_config: {
      $$type: 'timing-config',
      value: { duration: msSize(intent.durationMs), delay: msSize(intent.delayMs) },
    },
  };
  if (intent.easing !== null) {
    animation.config = { $$type: 'config-v2', value: { easing: str(intent.easing) } };
  }
  return {
    $$type: 'interaction-item',
    value: {
      trigger: str(intent.trigger),
      animation: { $$type: 'animation-preset-props', value: animation },
    },
  };
}

/**
 * The `interactions` element field, widened locally: the native wire format is a JSON-encoded
 * STRING (S08); the WP-F03 TS field (`unknown[]`) predates the S08 re-freeze — the wire zod schema
 * (`catalog/schemas/shared.ts`) already accepts string | array | object.
 */
interface InteractionsCarrier {
  interactions?: unknown;
}

/**
 * Decode an element's existing `interactions` value into its items array. Accepts all three wire
 * forms (JSON string / `{version,items}` object / bare array — PHP emits `[]` when empty).
 * Returns null when the value is present but undecodable (the caller refuses to overwrite).
 */
export function decodeInteractionItems(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    if (value.trim() === '') return [];
    try {
      return decodeInteractionItems(JSON.parse(value));
    } catch {
      return null;
    }
  }
  // `Array.isArray` narrows `unknown` to `any[]` — re-widen to `unknown[]` (no-unsafe-return).
  if (Array.isArray(value)) return value as unknown[];
  if (typeof value === 'object') {
    const items = (value as { items?: unknown }).items;
    if (items === undefined) return [];
    return Array.isArray(items) ? items : null;
  }
  return null;
}

/** Find an element by id anywhere in a forest. */
function findElementById(elements: ElementNode[], id: string): ElementNode | null {
  for (const el of elements) {
    if (el.id === id) return el;
    const found = findElementById(el.elements ?? [], id);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Ids of every element carrying a NON-EMPTY decodable `interactions` payload — the
 * "interaction-bearing" census (contract 18 §7 P3-c guard: bearing count == authored count on a
 * freshly converted tree). An empty container (`[]` / `''` / `{items:[]}`) is NOT bearing; an
 * undecodable value IS counted (it is a payload, just a broken one — hiding it would be a lie).
 */
export function collectInteractionBearingIds(elements: ElementNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: ElementNode[]): void => {
    for (const el of nodes) {
      const raw = (el as InteractionsCarrier).interactions;
      if (raw !== undefined) {
        const items = decodeInteractionItems(raw);
        if (items === null || items.length > 0) out.push(el.id);
      }
      walk(el.elements ?? []);
    }
  };
  walk(elements);
  return out;
}

/**
 * P3-c (contract 18 §7) — drop EMPTY `interactions` containers from every element this stage did
 * not author onto, so `interactions` present ⇔ items exist. ASSEMBLE seeds `interactions: []` on
 * every element it mints (128/128 on the Driftwell baseline), which makes the whole saved tree
 * LOOK interaction-bearing; the DOM-side `data-interaction-id` attribute itself is stamped by
 * Elementor core on EVERY atomic element regardless (`atomic-element-base.php:135`,
 * `origin_id ?? id` — upstream, unconditional, not ours to change), so the honest "stamped ==
 * authored" measurement is the PAYLOAD census above, which this prune makes exact. Mutates the
 * stage's own clone only; undecodable and non-empty values are never touched.
 */
function pruneEmptyInteractions(elements: ElementNode[]): void {
  for (const el of elements) {
    const carrier = el as InteractionsCarrier;
    if (carrier.interactions !== undefined) {
      const items = decodeInteractionItems(carrier.interactions);
      if (items !== null && items.length === 0) {
        delete carrier.interactions;
      }
    }
    pruneEmptyInteractions(el.elements ?? []);
  }
}

/* ─────────────────────────── the stage ───────────────────────────────────────────────────────── */

/** A tier-2-candidate behavior + the IR node carrying it (document order). */
interface Candidate {
  node: IrNode;
  behavior: DetectedBehavior;
}

/** Internal per-candidate outcome before the per-element cap pass. */
type Outcome =
  | { kind: 'reject'; reason: string }
  | { kind: 'emit'; elementId: string; item: InteractionItem; summary: string };

/** Collect `entrance-animation`/`hover-effect` candidates in IR document order. */
function collectCandidates(ir: IrNode[]): Candidate[] {
  const out: Candidate[] = [];
  const walk = (node: IrNode): void => {
    for (const behavior of node.behaviors ?? []) {
      if (behavior.kind === 'entrance-animation' || behavior.kind === 'hover-effect') {
        out.push({ node, behavior });
      }
    }
    for (const child of node.children) walk(child);
  };
  for (const root of ir) walk(root);
  return out;
}

/**
 * The Tier-2 emitter (contract 16 §4). See the module doc for the full mapping; tier 2 entries are
 * provisional until {@link postSaveAssert} confirms sanitizer survival (§8 invariant 2).
 */
export function emitInteractions(
  elements: ElementNode[],
  ir: IrNode[],
  ctx: InteractionsContext,
): InteractionsResult {
  const out = structuredClone(elements);
  const warnings: string[] = [];
  const authored: AuthoredInteractions[] = [];
  const candidates = collectCandidates(ir);
  if (candidates.length === 0) {
    return { elements: out, report: [], authored, warnings };
  }

  const caps = ctx.capabilities;
  const interactionsAvailable =
    caps.atomic && caps.experiments['e_interactions'] !== false ? null : !caps.atomic
      ? 'atomic elements unavailable (e_atomic_elements inactive) — interactions are V4-only'
      : "the 'e_interactions' experiment is deactivated on this site";

  /* ── pass 1: per-candidate gating + intent derivation. ── */
  const outcomes: Outcome[] = candidates.map(({ node, behavior }): Outcome => {
    if (interactionsAvailable !== null) {
      return { kind: 'reject', reason: interactionsAvailable };
    }
    if (behavior.kind === 'hover-effect' && !caps.pro) {
      return {
        kind: 'reject',
        reason: "trigger 'hover' requires Elementor Pro (S08 per-enum gating)",
      };
    }
    const elementId = ctx.id_map[node.source_path];
    if (elementId === undefined || elementId === '') {
      return {
        kind: 'reject',
        reason: `no assembled element for IR node '${node.source_path}' (id_map miss)`,
      };
    }
    const el = findElementById(out, elementId);
    if (el === null) {
      return {
        kind: 'reject',
        reason: `element '${elementId}' not found in the assembled tree`,
      };
    }
    if (!isAtomicNode(el)) {
      return {
        kind: 'reject',
        reason: `element '${elementId}' is not atomic — interactions require Atomic_Element_Base (V4)`,
      };
    }
    const derived =
      behavior.kind === 'entrance-animation'
        ? deriveEntranceIntent(node)
        : deriveHoverIntent(node);
    if (!derived.ok) {
      return { kind: 'reject', reason: derived.reason };
    }
    const intent = derived.intent;
    if (!FREE_TRIGGERS.has(intent.trigger) && !caps.pro) {
      // Unreachable for the current kinds (hover is pre-gated) — kept as a §4 safety net.
      return {
        kind: 'reject',
        reason: `trigger '${intent.trigger}' requires Elementor Pro (S08 per-enum gating)`,
      };
    }
    if (intent.easing !== null && !FREE_EASINGS.has(intent.easing) && !caps.pro) {
      warnings.push(
        `easing '${intent.easing}' requires Elementor Pro — element '${elementId}' emitted with the default easing (config omitted)`,
      );
      intent.easing = null;
    }
    const summary =
      `native interaction: ${intent.effect} ${intent.type} on ${intent.trigger}` +
      `${intent.direction !== '' ? ` from ${intent.direction}` : ''} (${intent.durationMs}ms)` +
      `${intent.note !== undefined ? ` — ${intent.note}` : ''}`;
    return { kind: 'emit', elementId, item: buildInteractionItem(intent), summary };
  });

  /* ── pass 2: per-element merge + the 5-item Validation cap (S08). ── */
  interface ElementBucket {
    el: ElementNode;
    sourcePath: string;
    entries: Array<{ index: number; item: InteractionItem }>;
  }
  const buckets = new Map<string, ElementBucket>();
  outcomes.forEach((outcome, index) => {
    if (outcome.kind !== 'emit') return;
    let bucket = buckets.get(outcome.elementId);
    if (bucket === undefined) {
      // pass 1 already resolved the element — non-null by construction.
      const el = findElementById(out, outcome.elementId);
      if (el === null) return;
      const candidate = candidates[index];
      bucket = { el, sourcePath: candidate?.node.source_path ?? '', entries: [] };
      buckets.set(outcome.elementId, bucket);
    }
    bucket.entries.push({ index, item: outcome.item });
  });

  for (const [elementId, bucket] of buckets) {
    const carrier = bucket.el as InteractionsCarrier;
    const existing = decodeInteractionItems(carrier.interactions);
    if (existing === null) {
      warnings.push(
        `existing interactions on element '${elementId}' are undecodable — refusing to overwrite`,
      );
      for (const entry of bucket.entries) {
        outcomes[entry.index] = {
          kind: 'reject',
          reason: `existing interactions on element '${elementId}' are undecodable — refusing to overwrite`,
        };
      }
      continue;
    }
    const capacity = Math.max(0, MAX_INTERACTIONS_PER_ELEMENT - existing.length);
    const accepted = bucket.entries.slice(0, capacity);
    for (const entry of bucket.entries.slice(capacity)) {
      outcomes[entry.index] = {
        kind: 'reject',
        reason: `exceeds ${MAX_INTERACTIONS_PER_ELEMENT} interactions per element (PHP Validation cap, S08) on element '${elementId}'`,
      };
    }
    if (accepted.length === 0) continue;
    const blob: InteractionsBlob = {
      version: 1,
      items: [...existing, ...accepted.map((e) => e.item)] as InteractionItem[],
    };
    carrier.interactions = JSON.stringify(blob); // the native wire format (S08)
    authored.push({
      element_id: elementId,
      source_path: bucket.sourcePath,
      items: blob.items.length,
    });
  }

  /* ── pass 2b: P3-c — only interaction-bearing nodes keep an `interactions` payload. Runs only
   * when the stage actually AUTHORED something: a fully-rejected candidate set leaves the forest
   * untouched (reject ⇒ no side effects), and the zero-candidate early return above keeps the
   * §8.5 byte-identical passthrough. ── */
  if (authored.length > 0) {
    pruneEmptyInteractions(out);
  }

  /* ── pass 3: the tiered report, in candidate order (§8 invariant 1). ── */
  const report: DetectedBehavior[] = candidates.map(({ behavior }, index) => {
    const outcome = outcomes[index] as Outcome;
    const tiered: DetectedBehavior = {
      ...behavior,
      evidence: [...behavior.evidence],
      nodeIds: [...behavior.nodeIds],
    };
    if (outcome.kind === 'emit') {
      tiered.tier = 2;
      tiered.reason = `${outcome.summary} → element '${outcome.elementId}'`;
    } else {
      tiered.tier = 4;
      tiered.reason = outcome.reason;
    }
    return tiered;
  });

  return { elements: out, report, authored, warnings };
}

/* ─────────────────────────── post-save survival assertion (§8 invariant 2) ───────────────────── */

/** Per-element readback verdict. Any non-`survived` status means the report must be downgraded. */
export type PostSaveStatus = 'survived' | 'partial' | 'dropped_by_sanitizer' | 'element_missing';

/** One post-save interaction survival check (contract 16 §4 "Post-save assertion"). */
export interface PostSaveInteractionCheck {
  element_id: string;
  /** Items this stage wrote (pre-existing + emitted — the readback expectation). */
  authored: number;
  /** Items found on the read-back element. */
  survived: number;
  status: PostSaveStatus;
}

/**
 * Compare the stage's authored interactions against the READ-BACK document tree. PHP
 * `Validation::sanitize` drops invalid items with NO error (an all-invalid set stores `[]` — S08),
 * so an element whose authored interactions came back empty is `dropped_by_sanitizer` and its
 * tier-2 behaviors MUST be downgraded in the coverage report (§0.3, §8 invariant 2) — never report
 * fake success. Pure; the orchestrator supplies the read-back tree.
 */
export function postSaveAssert(
  authored: AuthoredInteractions[],
  elementsReadBack: ElementNode[],
): PostSaveInteractionCheck[] {
  return authored.map((a) => {
    const el = findElementById(elementsReadBack, a.element_id);
    if (el === null) {
      return { element_id: a.element_id, authored: a.items, survived: 0, status: 'element_missing' };
    }
    const items = decodeInteractionItems((el as InteractionsCarrier).interactions);
    const survived = items === null ? 0 : items.length;
    const status: PostSaveStatus =
      survived >= a.items ? 'survived' : survived === 0 ? 'dropped_by_sanitizer' : 'partial';
    return { element_id: a.element_id, authored: a.items, survived, status };
  });
}

/* ─────────────────────────── P1-c — frontend wiring diagnosis (contract 18 §7) ───────────────── */

/*
 * THE P1-c ROOT-CAUSE RECORD — what the contract-17 wave changed between this stage's emission and
 * the live page, vs the WORKING pre-17 build (page 1892, where the same tier-2 emission fired).
 *
 * The runtime contract (Elementor 4.1.1 frontend, verified against pinned source):
 *   1. The renderer stamps `data-interaction-id = origin_id ?? element.id` on EVERY atomic element
 *      UNCONDITIONALLY (`modules/atomic-widgets/elements/base/atomic-element-base.php:135`) — the
 *      field-observed "128 nodes stamped" is upstream behavior, NOT a converter emission bug; the
 *      converter-controllable surface is the `interactions` PAYLOAD (see `pruneEmptyInteractions`).
 *   2. On `Document::save()` the `elementor/document/save/data` filter runs
 *      `Validation::sanitize` (SILENT item drops) → `Parser::assign_interaction_ids` (re-encodes
 *      the blob string), and `elementor/document/after_save` rebuilds the
 *      `elementor-interactions-cache` postmeta from the SAVED tree, keyed by element id.
 *   3. At render, `Interactions_Frontend_Handler` prints `#elementor-interactions-data` — rows
 *      `{elementId, dataId, interactions: items[]}` from that cache — and the runtime
 *      (`assets/js/interactions.js`) matches `querySelectorAll('[data-interaction-id="<elementId>"]')`,
 *      so blob `elementId` ↔ stamped id correspondence holds EXACTLY when the saved element's id is
 *      the rendered element's id (origin_id is only set for looped/templated content).
 *   4. The runtime animates per item via `extractAnimationConfig` (typed-envelope unwrap; a null
 *      config or `getKeyframes` returning EMPTY keyframes is a SILENT no-op) and only the free
 *      triggers load/scrollIn/scrollOut are handled by the free runtime (`isSupportedInteraction`);
 *      the "initial hide" is the first keyframe of the triggered animation (fade-in: opacity [0,1]),
 *      NOT a pre-applied style — scrollIn applies it the moment the element enters view (amount 0).
 *
 * What 17 inserted between emission and the page (pre-17/1892 saved this stage's output verbatim):
 *   a. pipeline step 10 — `resolvePlaceholders` (JSON deep-clone) + `normalizeNodeForWire` (spread
 *      rebuild) now run AFTER `emitInteractions`. Both PRESERVE the `interactions` string today,
 *      but any future wire normalizer that whitelists keys would strip it silently — this
 *      diagnostic catches that class.
 *   b. `htmlToPage` translates authored ids through the writer's `remapped_ids` before
 *      `postSaveAssert`; a consumer that diffs ORIGINAL ids against the saved tree reports a false
 *      `element_missing` (or misses a real one). `diagnoseInteractionWiring` callers must apply
 *      `remapped_ids` first, exactly like `postSaveAssert`.
 *   c. the 17 verify loop RE-SAVES on every repair round and temporarily publishes/reverts — each
 *      re-save re-runs sanitize+Parser+cache rebuild (step 2 above), so the blob on the live page
 *      reflects the LAST save, not the original emission.
 * None of (a)-(c) is a proven 2658 root cause from code reading alone; this diagnostic exists so
 * the integrator can pin which leg broke (id correspondence, sanitizer drop, payload lost in a
 * post-emission rewrite, or a no-op item) instead of re-debugging the whole chain live.
 */

/** Triggers the FREE frontend runtime handles (`isSupportedInteraction`); `hover` is Pro-runtime. */
const RUNTIME_FREE_TRIGGERS: ReadonlySet<string> = new Set(['load', 'scrollIn', 'scrollOut']);

/** Slide directions `getKeyframes` recognizes (compound `top-left` splits on `-`). */
const RUNTIME_DIRECTIONS: ReadonlySet<string> = new Set(['left', 'right', 'top', 'bottom']);

/** Per-element wiring verdict (worst problem wins). */
export type InteractionWiringStatus =
  | 'wired'
  | 'element_missing'
  | 'not_atomic'
  | 'undecodable'
  | 'items_lost'
  | 'no_runtime_effect';

/** One authored element's frontend-wiring audit. */
export interface InteractionWiringFinding {
  element_id: string;
  source_path: string;
  /** The value the renderer will stamp as `data-interaction-id` (== element id on converted trees). */
  expected_stamp: string;
  /** Items this stage authored (the blob expectation). */
  authored_items: number;
  /** Decodable items found on the saved element (`-1` when undecodable). */
  found_items: number;
  status: InteractionWiringStatus;
  /** Human-readable evidence rows for every detected problem (empty when `wired`). */
  problems: string[];
}

/** The whole-tree diagnosis the integrator wires after save (and the CLI can print). */
export interface InteractionWiringDiagnosis {
  ok: boolean;
  findings: InteractionWiringFinding[];
  /** Every interaction-bearing element id in the saved tree (the P3-c census). */
  bearing_ids: string[];
  summary: string;
}

/** Unwrap a `{$$type, value}` string envelope (or accept a bare string) — runtime parity. */
function unwrapString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && '$$type' in value) {
    const inner = (value as { value?: unknown }).value;
    return typeof inner === 'string' ? inner : null;
  }
  return null;
}

/** Unwrap a `{$$type, value}` object envelope (or accept a bare object) — runtime parity. */
function unwrapObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  if ('$$type' in value) {
    const inner = (value as { value?: unknown }).value;
    return typeof inner === 'object' && inner !== null
      ? (inner as Record<string, unknown>)
      : null;
  }
  return value as Record<string, unknown>;
}

/**
 * Audit ONE saved interaction item the way the frontend runtime will consume it
 * (`extractAnimationConfig` → `isSupportedInteraction` → `getKeyframes`): returns the problems
 * that would make the item a SILENT no-op (no animation ⇒ no initial state ⇒ the P1-c
 * "opacity constant 1.0" symptom). An empty array means the item will animate when triggered.
 */
function auditItemRuntimeEffect(item: unknown): string[] {
  const problems: string[] = [];
  if (typeof item !== 'object' || item === null) {
    return [`item is not an object (${typeof item}) — extractAnimationConfig returns null`];
  }
  const wrapped = item as { $$type?: unknown; value?: unknown };
  const payload =
    wrapped.$$type === 'interaction-item' && typeof wrapped.value === 'object'
      ? (wrapped.value as Record<string, unknown>)
      : (item as Record<string, unknown>);

  const trigger = unwrapString(payload['trigger']) ?? 'load';
  if (!RUNTIME_FREE_TRIGGERS.has(trigger) && trigger !== 'hover') {
    problems.push(
      `trigger '${trigger}' is unsupported by the frontend runtime (isSupportedInteraction) — item skipped`,
    );
  }

  const animation = unwrapObject(payload['animation']);
  if (animation === null) {
    problems.push('animation block missing/unwrappable — extractAnimationConfig returns null');
    return problems;
  }
  const effect = unwrapString(animation['effect']) ?? 'fade';
  const direction = unwrapString(animation['direction']) ?? '';
  if (effect === 'custom') {
    problems.push("effect 'custom' is rejected by isSupportedInteraction — item skipped");
  }
  const directionMoves = direction.split('-').some((part) => RUNTIME_DIRECTIONS.has(part));
  if (effect !== 'fade' && effect !== 'scale' && !directionMoves) {
    // getKeyframes returns {} → Motion animates NOTHING: no initial state, no visible change.
    problems.push(
      `effect '${effect}' with direction '${direction}' produces EMPTY keyframes (getKeyframes) — ` +
        'the runtime animates nothing and no initial state ever applies',
    );
  }
  return problems;
}

/**
 * P1-c diagnostic (contract 18 §7) — given the SAVED element tree (ids already translated through
 * the writer's `remapped_ids`, exactly like {@link postSaveAssert}) and this stage's authored
 * ledger, verify the full frontend wiring chain: the blob `elementId` ↔ stamped
 * `data-interaction-id` correspondence (leg: element exists under the authored id AND is atomic —
 * only `Atomic_Element_Base` stamps the attribute, so a classic fallback host matches no blob row)
 * AND that the initial state (the pre-animation hide) will actually apply (leg: items decodable,
 * none lost to the sanitizer, ≥1 item the runtime will animate rather than silently no-op).
 *
 * PURE — the integrator (pipeline / CLI) wires it after save; it never fetches the live page. A
 * `wired` verdict means "the runtime WILL animate this element if its scripts load"; it cannot see
 * enqueue/config failures (those belong to the verify-loop behavioral probe, P1-e).
 */
export function diagnoseInteractionWiring(
  authored: AuthoredInteractions[],
  savedElements: ElementNode[],
): InteractionWiringDiagnosis {
  const findings: InteractionWiringFinding[] = authored.map((a) => {
    const base = {
      element_id: a.element_id,
      source_path: a.source_path,
      expected_stamp: a.element_id,
      authored_items: a.items,
    };
    const el = findElementById(savedElements, a.element_id);
    if (el === null) {
      return {
        ...base,
        found_items: 0,
        status: 'element_missing' as const,
        problems: [
          `element '${a.element_id}' is not in the saved tree — the blob row (keyed by saved element ` +
            `id) cannot correspond to any stamped data-interaction-id; if the writer remapped ids, ` +
            'translate through remapped_ids before diagnosing',
        ],
      };
    }
    const problems: string[] = [];
    if (!isAtomicNode(el)) {
      problems.push(
        `element '${a.element_id}' is not atomic — only Atomic_Element_Base stamps ` +
          'data-interaction-id (atomic-element-base.php:135), so its blob row matches no DOM node',
      );
    }
    const items = decodeInteractionItems((el as InteractionsCarrier).interactions);
    if (items === null) {
      return {
        ...base,
        found_items: -1,
        status: problems.length > 0 ? ('not_atomic' as const) : ('undecodable' as const),
        problems: [
          ...problems,
          'saved interactions value is undecodable — the postmeta cache will register no items',
        ],
      };
    }
    if (problems.length > 0) {
      return { ...base, found_items: items.length, status: 'not_atomic' as const, problems };
    }
    if (items.length < a.items) {
      return {
        ...base,
        found_items: items.length,
        status: 'items_lost' as const,
        problems: [
          `authored ${String(a.items)} item(s), saved tree carries ${String(items.length)} — ` +
            'Validation::sanitize drops invalid items with NO error (S08)',
        ],
      };
    }
    const itemProblems = items.flatMap((item, i) =>
      auditItemRuntimeEffect(item).map((p) => `item ${String(i)}: ${p}`),
    );
    const animatable = items.filter((item) => auditItemRuntimeEffect(item).length === 0).length;
    if (animatable === 0) {
      return {
        ...base,
        found_items: items.length,
        status: 'no_runtime_effect' as const,
        problems: itemProblems,
      };
    }
    return { ...base, found_items: items.length, status: 'wired' as const, problems: itemProblems };
  });

  const bearing = collectInteractionBearingIds(savedElements);
  const broken = findings.filter((f) => f.status !== 'wired');
  const summary =
    `${String(findings.length - broken.length)}/${String(findings.length)} authored element(s) ` +
    `wired; ${String(bearing.length)} interaction-bearing element(s) in the saved tree` +
    (broken.length > 0
      ? `; BROKEN: ${broken.map((f) => `${f.element_id}(${f.status})`).join(', ')}`
      : '');
  return { ok: broken.length === 0, findings, bearing_ids: bearing, summary };
}
