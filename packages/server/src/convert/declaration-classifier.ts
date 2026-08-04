/**
 * WP-H07 — declaration-classifier (impl of `classifyDeclaration`, frozen seam `convert/types.ts`).
 *
 * The SINGLE decision point for "does this CSS declaration have a native atomic expression against
 * the LIVE `Style_Schema`?" (`11-authoring-contract.md §5.2`, SUPPLEMENT §B.3, RESEARCH.md §6.3/§6.4).
 * Given one CSS `(prop, value)` and the live flat `css-prop-name → Prop_Type` map (passed in by the
 * orchestrator — this module NEVER fetches it), it returns a {@link DeclVerdict}:
 *
 *   - `native`               — the prop is a schema key AND the value satisfies its `$$type`/enum/units;
 *                              `atomic_prop`/`typed_value` carry the typed-value payload to emit.
 *   - `variable-candidate`   — the value is a literal (color / font stack) that COULD become a global
 *                              variable; still emitted natively here (WP-H09 decides extraction). The
 *                              verdict flags it so STYLE-EXTRACT records a `LiteralRef`.
 *   - `global-class-candidate` — reserved tier marker for HOIST; this stage never emits it directly
 *                              (HOIST owns sharing decisions). Kept for verdict completeness.
 *   - `unmappable`           — no native expression (absent from schema, off-enum with no snap, a
 *                              raw shorthand that cannot be decomposed). Routes down the §9 ladder.
 *
 * PURE: deterministic given `(prop, value, schema)`. NO I/O, NO Playwright, NO WP client. The PHP
 * `dry_run` validator (WP-P03) is the AUTHORITATIVE gate; this is a cheap pre-filter. The optional
 * `css-tree` lexer is used only as an extra value sanity pre-check (SUPPLEMENT §C.3) — never the gate.
 *
 * Logical box decomposition (`padding`/`margin`/`border-radius`/`border-width`/inset/`text-align`) is
 * DIRECTION-AWARE and is owned by WP-H02 (`logical-props.ts`); STYLE-EXTRACT (`style-extract.ts`)
 * calls WP-H02 directly for those props with the resolved direction, so this classifier reports them
 * as `native` (when the prop is in the schema) and leaves the per-edge logical relocation to the
 * caller. The `typed_value` it returns for those box props is the RAW value string echo (the caller
 * replaces it with the WP-H02 logical object). For all OTHER native props it returns the finished
 * typed-value payload.
 */

import { createRequire } from 'node:module';

import { typedValue, sizeValue } from '../authoring/envelopes.js';
import type { TypedValue } from '../authoring/contract.js';
import type { DeclVerdict, StyleSchema } from './types.js';

/* ─────────────────────────── prop categories (SUPPLEMENT §B.3 / authoring-contract §5.2) ─────── */

/**
 * Box/logical props whose physical→logical relocation is DIRECTION-AWARE and owned by WP-H02. The
 * classifier reports them `native` (if the prop is in the schema) but returns a RAW echo as
 * `typed_value`; STYLE-EXTRACT replaces it with the WP-H02 logical object/inset props. `text-align` is
 * a keyword-translation case (also WP-H02) handled the same way.
 */
export const LOGICAL_BOX_PROPS: ReadonlySet<string> = new Set([
  'padding',
  'margin',
  'border-radius',
  'border-width',
  'text-align',
]);

/**
 * The four physical inset props. They are NOT schema keys themselves; their logical names
 * (`inset-block-start` etc.) are. STYLE-EXTRACT relocates them via WP-H02; the classifier only routes
 * the logical inset prop names through the schema check.
 */
export const PHYSICAL_INSET_PROPS: ReadonlySet<string> = new Set([
  'top',
  'right',
  'bottom',
  'left',
]);

/**
 * Free-string props (`is_string` only, `11-authoring-contract.md §5.2`): the TS pre-filter cannot
 * confirm validity (only PHP/visual-diff can). Emitted as a `string` typed value with the DEFER flag.
 */
export const FREE_STRING_PROPS: ReadonlySet<string> = new Set([
  'aspect-ratio',
  'font-family',
  'text-decoration',
  'grid-template-columns',
  'grid-template-rows',
  'content',
  'clip-path',
]);

/**
 * Typed-object props whose RAW shorthand string is rejected by PHP — they MUST be decomposed into the
 * exact nested envelope (`atomic-prop-types.schema.json`) or routed to fallback. The classifier
 * attempts a decomposition for the feasible cases (box-shadow incl. multi-layer, single gradient);
 * anything else (conic gradient `background`, multi-function transform) → `unmappable`.
 */
export const TYPED_OBJECT_PROPS: ReadonlySet<string> = new Set([
  'transform',
  'transition',
  'filter',
  'backdrop-filter',
  'box-shadow',
  'background',
  // `background-color` (what render-then-extract actually emits) is routed here too — `classifyTypedObject`
  // maps both it and the `background` shorthand to the single native `background` schema prop. Without
  // this it falls to the generic path and is dropped ("absent from Style_Schema"), losing ALL solid
  // backgrounds — the single biggest convert-fidelity loss.
  'background-color',
  // `background-image` is what render-then-extract emits for a `background: linear-gradient(...)`
  // shorthand (getComputedStyle resolves it to background-image). `classifyTypedObject` decomposes a
  // single gradient into the NATIVE `background` overlay prop (which renders) instead of dropping it to
  // custom_css (which renders NOTHING) — the gradient hero/CTA backgrounds were silently lost.
  'background-image',
]);

/** Color-valued props (the value is a literal color → `variable-candidate` flag). */
export const COLOR_PROPS: ReadonlySet<string> = new Set([
  'color',
  'background-color',
  'border-color',
  'outline-color',
]);

/**
 * Size-valued props whose value is a single CSS length and whose typed value is a `size` envelope.
 * (Logical box props are handled separately by WP-H02.) Used to clamp the unit against the schema's
 * `units` preset and to wrap into `{$$type:'size'}`.
 */
const SCALAR_SIZE_TYPES: ReadonlySet<string> = new Set(['size']);

/** The `font-weight` 100-step enum members + named keywords (SUPPLEMENT §B.3). */
const FONT_WEIGHT_STEPS: readonly number[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const FONT_WEIGHT_KEYWORDS: ReadonlySet<string> = new Set(['normal', 'bold', 'bolder', 'lighter']);

/* ─────────────────────────── optional css-tree lexer (cheap pre-check only) ──────────────────── */

/** Minimal structural typing for the `css-tree` lexer surface used here. */
interface CssTreeLexer {
  matchProperty(prop: string, value: string): { error: unknown };
}
interface CssTreeLike {
  lexer: CssTreeLexer;
}

/** Cached css-tree handle: `undefined` = not yet probed, `null` = absent, else the module. */
let cssTreeCache: CssTreeLike | null | undefined;

/** Optional synchronous `css-tree` require; `null` when the dep is absent (graceful degrade). */
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

/**
 * Cheap, optional lexer sanity check: returns `false` ONLY when css-tree is present AND positively
 * reports the value as invalid for the prop. When css-tree is absent, or the prop is unknown to its
 * lexer, returns `true` (do not block — the schema `$$type`/enum is the real gate, PHP is final).
 */
export function lexerAccepts(prop: string, value: string): boolean {
  const ct = tryRequireCssTree();
  if (ct === null) {
    return true;
  }
  try {
    const res = ct.lexer.matchProperty(prop, value);
    return res.error === null || res.error === undefined;
  } catch {
    // Unknown property / lexer throw — do not block on the optional pre-check.
    return true;
  }
}

/* ─────────────────────────── value helpers ──────────────────────────────────────────────────── */

/** Trim + lowercase a CSS keyword for enum comparison (values, never the prop name). */
function kw(value: string): string {
  return value.trim().toLowerCase();
}

/** A value that should NEVER be emitted natively regardless of prop (drops silently in the schema). */
const GLOBAL_KEYWORDS: ReadonlySet<string> = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);

/** Parse a single CSS length token into `{size,unit}`; `auto` → `{size:null,unit:'auto'}`. */
function parseLength(value: string): { size: number | string | null; unit: string } | null {
  const raw = value.trim();
  if (kw(raw) === 'auto') {
    return { size: null, unit: 'auto' };
  }
  const m = /^([+-]?(?:\d*\.\d+|\d+))\s*([a-z%]*)$/i.exec(raw);
  if (m === null) {
    // calc(...) / var(...) / clamp(...) → a `custom` size (the schema allows a string custom value).
    if (/^(?:calc|var|clamp|min|max|env)\s*\(/i.test(raw)) {
      return { size: raw, unit: 'custom' };
    }
    return null;
  }
  const unit = m[2] === '' ? 'px' : (m[2] as string).toLowerCase();
  return { size: Number(m[1]), unit };
}

/** Is the unit acceptable for this prop given the schema's `units` preset (when present)? */
function unitAllowed(unit: string, units: readonly string[] | undefined): boolean {
  if (unit === 'auto' || unit === 'custom') {
    return true; // sentinels always allowed by the size prop-type
  }
  if (units === undefined || units.length === 0) {
    return true; // schema did not constrain units — defer to PHP
  }
  return units.includes(unit);
}

/* ─────────────────────────── enum snapping (authoring-contract §5.2) ─────────────────────────── */

/**
 * Snap a `font-weight` value to a valid Style-Schema member, or report no-native. A numeric value not
 * on the 100-step grid (e.g. `350`) snaps to the nearest step; named keywords pass through; anything
 * else (e.g. `inherit`) has no native value.
 */
export function snapFontWeight(value: string): { value: string; snapped: boolean } | null {
  const v = kw(value);
  if (FONT_WEIGHT_KEYWORDS.has(v)) {
    return { value: v, snapped: false };
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return null;
  }
  if (FONT_WEIGHT_STEPS.includes(n)) {
    return { value: String(n), snapped: false };
  }
  // Nearest 100-step, clamped to [100, 900]; ties round UP to the heavier weight (e.g. 350 → 400).
  let nearest = FONT_WEIGHT_STEPS[0] as number;
  let best = Number.POSITIVE_INFINITY;
  for (const step of FONT_WEIGHT_STEPS) {
    const d = Math.abs(step - n);
    if (d < best || (d === best && step > nearest)) {
      best = d;
      nearest = step;
    }
  }
  return { value: String(nearest), snapped: true };
}

/* ─────────────────────────── typed-object decomposition (feasible cases only) ────────────────── */

/**
 * Decompose a `box-shadow` into the atomic `box-shadow` array envelope (one `shadow` object per layer):
 * `value:[{$$type:'shadow', value:{hOffset,vOffset,blur,spread:size; color:color; position?}}]`
 * (SUPPLEMENT §B.1; `Box_Shadow_Prop_Type` is an `Array_Prop_Type` of `Shadow_Prop_Type`, so MULTIPLE
 * layers are native). Layers are split on TOP-LEVEL commas only (paren-aware — the commas inside
 * `rgba(0, 0, 0, 0.2)` never split), and each layer is tokenized paren-aware because Chrome's
 * `getComputedStyle` serializes shadows COLOR-FIRST with spaces inside the color function
 * (`rgba(0, 0, 0, 0.2) 0px 2px 4px 0px`) — a naive whitespace split shredded the color and silently
 * lost every box-shadow on every real (render-then-extract) conversion. Returns `null` for any
 * unparseable layer → caller routes to fallback. `none` → an empty `box-shadow` array (cleared).
 */
export function decomposeBoxShadow(value: string): TypedValue | null {
  const v = value.trim();
  if (kw(v) === 'none') {
    return typedValue('box-shadow', []);
  }
  const shadows: TypedValue[] = [];
  for (const layer of splitTopLevelCommas(v)) {
    const inner = parseShadowLayer(layer);
    if (inner === null) {
      return null; // any unparseable layer — bail to fallback for the whole declaration
    }
    shadows.push(typedValue('shadow', inner));
  }
  if (shadows.length === 0) {
    return null;
  }
  return typedValue('box-shadow', shadows);
}

/** Parse ONE box-shadow layer (`[inset] <lengths 2-4> <color>` in any order) into the shadow inner map. */
function parseShadowLayer(layer: string): Record<string, TypedValue> | null {
  const inset = /\binset\b/i.test(layer);
  const body = layer.replace(/\binset\b/i, '').trim();
  // Tokenize on whitespace at parenthesis-depth 0 ONLY, so a spaced color function
  // (`rgba(0, 0, 0, 0.2)` — the Chrome computed serialization) stays one token.
  const tokens = splitTopLevelWhitespace(body);
  const lengths: Array<{ size: number | string | null; unit: string }> = [];
  let color: string | null = null;
  for (const tok of tokens) {
    const len = parseLength(tok);
    if (len !== null && len.unit !== 'auto') {
      lengths.push(len);
    } else if (looksLikeColor(tok)) {
      color = tok;
    } else {
      return null; // unknown token — bail to fallback
    }
  }
  // Need at least hOffset + vOffset; blur/spread optional. color required by the schema.
  if (lengths.length < 2 || color === null) {
    return null;
  }
  const [h, vOff, blur, spread] = lengths;
  const inner: Record<string, TypedValue> = {
    hOffset: sizeValue((h as { size: number | string | null }).size, (h as { unit: string }).unit),
    vOffset: sizeValue(
      (vOff as { size: number | string | null }).size,
      (vOff as { unit: string }).unit,
    ),
    blur: blur !== undefined ? sizeValue(blur.size, blur.unit) : sizeValue(0, 'px'),
    spread: spread !== undefined ? sizeValue(spread.size, spread.unit) : sizeValue(0, 'px'),
    color: typedValue('color', color),
  };
  if (inset) {
    inner['position'] = typedValue('string', 'inset');
  }
  return inner;
}

/** Split a string on commas that sit at parenthesis-depth 0 (keeps `rgb(…)` stop colors intact). */
function splitTopLevelCommas(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) {
    out.push(cur.trim());
  }
  return out;
}

/** Parse a CSS gradient direction token (angle or `to <side(s)>`) → degrees [0,360), or null. */
function parseGradientAngle(token: string): number | null {
  const t = token.trim().toLowerCase();
  const norm = (n: number): number => ((n % 360) + 360) % 360;
  const num = /^(-?\d*\.?\d+)(deg|grad|rad|turn)$/.exec(t);
  if (num !== null) {
    const n = Number(num[1]);
    switch (num[2]) {
      case 'deg':
        return norm(n);
      case 'grad':
        return norm(n * 0.9);
      case 'rad':
        return norm((n * 180) / Math.PI);
      case 'turn':
        return norm(n * 360);
    }
  }
  if (/^to\s+/.test(t)) {
    const dir = t
      .replace(/^to\s+/, '')
      .trim()
      .split(/\s+/)
      .sort()
      .join(' ');
    const map: Record<string, number> = {
      top: 0,
      right: 90,
      bottom: 180,
      left: 270,
      'right top': 45,
      'bottom right': 135,
      'bottom left': 225,
      'left top': 315,
    };
    return dir in map ? (map[dir] as number) : null;
  }
  return null;
}

/**
 * Decompose a SINGLE-layer CSS gradient (`linear`/`radial`, optionally as the computed
 * `background-image`) into the NATIVE atomic `background` prop — a `background-overlay` carrying one
 * `background-gradient-overlay`. This is the live-verified renderable shape; gradients routed to
 * custom_css render NOTHING, so hero/CTA gradient backgrounds were silently lost. Bails (→ null →
 * custom_css) on conic / repeating / multi-layer / unparseable input. Pure.
 */
export function decomposeGradientBackground(value: string): TypedValue | null {
  const v = value.trim();
  // Exactly ONE gradient function (multi-layer backgrounds aren't modeled here).
  const fns = v.match(/(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/gi);
  if (fns === null || fns.length !== 1) {
    return null;
  }
  const head = fns[0].toLowerCase();
  if (/conic/.test(head) || /repeating/.test(head)) {
    return null; // no native conic / repeating support
  }
  const type = /radial/.test(head) ? 'radial' : 'linear';
  const inner = v.slice(v.indexOf('(') + 1, v.lastIndexOf(')')).trim();
  const parts = splitTopLevelCommas(inner);
  if (parts.length < 2) {
    return null;
  }
  // A leading direction/shape token (not a color) sets the angle; otherwise CSS default = to bottom.
  let angle = 180;
  let stopParts = parts;
  const firstWord = (parts[0] as string).trim().split(/\s+/)[0] ?? '';
  const firstIsColor = looksLikeColor(firstWord) || looksLikeColor((parts[0] as string).trim());
  if (!firstIsColor) {
    if (type === 'linear') {
      const a = parseGradientAngle(parts[0] as string);
      if (a !== null) {
        angle = a;
      }
    }
    stopParts = parts.slice(1);
  }
  if (stopParts.length < 2) {
    return null;
  }
  // Each stop is "<color> [<offset>%]". Pull a trailing percentage; the rest (rejoined) is the color.
  const parsed: Array<{ color: string; offset: number | null }> = [];
  for (const sp of stopParts) {
    const toks = sp.trim().split(/\s+/);
    let offset: number | null = null;
    const last = toks[toks.length - 1] ?? '';
    const pct = /^(-?\d*\.?\d+)%$/.exec(last);
    const colorToks = pct !== null ? toks.slice(0, -1) : toks;
    if (pct !== null) {
      offset = Number(pct[1]);
    }
    const color = colorToks.join(' ').trim();
    if (color.length === 0 || !looksLikeColor(color)) {
      return null;
    }
    parsed.push({ color, offset });
  }
  // Fill missing offsets: first→0, last→100, evenly distribute the interior.
  const n = parsed.length;
  parsed.forEach((s, i) => {
    if (s.offset === null) {
      s.offset = n === 1 ? 0 : Math.round((i / (n - 1)) * 100);
    }
  });
  const stops = parsed.map((s) =>
    typedValue('color-stop', {
      color: typedValue('color', s.color),
      offset: typedValue('number', s.offset as number),
    }),
  );
  const overlayInner: Record<string, TypedValue> = {
    type: typedValue('string', type),
    stops: typedValue('gradient-color-stop', stops),
  };
  if (type === 'linear') {
    overlayInner['angle'] = typedValue('number', angle);
  }
  return typedValue('background', {
    'background-overlay': typedValue('background-overlay', [
      typedValue('background-gradient-overlay', overlayInner),
    ]),
  });
}

/** Split a string on whitespace at parenthesis-depth 0 (keeps `rgba(0, 0, 0, 0.2)` one token). */
function splitTopLevelWhitespace(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (depth === 0 && /\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) {
    out.push(cur);
  }
  return out;
}

/** A cheap "is this token a color?" heuristic (hex/rgb/hsl/named-ish). Not authoritative. */
export function looksLikeColor(value: string): boolean {
  const v = kw(value);
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
    return true;
  }
  if (/^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(v)) {
    return true;
  }
  if (v === 'transparent' || v === 'currentcolor') {
    return true;
  }
  // Common CSS named colors (a small, high-signal subset — full set deferred to PHP).
  return NAMED_COLORS.has(v);
}

const NAMED_COLORS: ReadonlySet<string> = new Set([
  'black',
  'white',
  'red',
  'green',
  'blue',
  'gray',
  'grey',
  'silver',
  'maroon',
  'olive',
  'lime',
  'aqua',
  'teal',
  'navy',
  'fuchsia',
  'purple',
  'orange',
  'yellow',
]);

/** True if a `background`/`background-image` value carries a gradient (multi-stop typed object). */
export function isGradientBackground(value: string): boolean {
  return /\b(?:linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient\s*\(/i.test(
    value,
  );
}

/* ─────────────────────────── computed-default noise (contract 17 — I4) ───────────────────────── */

/**
 * Browser-default computed values with ZERO rendered effect (contract `17-conversion-integrity.md`
 * I4). `getComputedStyle` reports a value for EVERY whitelisted prop on EVERY element, so each node
 * carries dozens of `normal`/`auto`/`none`/zero-effect defaults that say nothing about the source —
 * routing them down the fallback ladder inflated `pct_custom_css` (page 1704: 34.7%, ~3000 no-ops)
 * and emitting them natively inflated `pct_native` exactly when fidelity is worst. The values here
 * are the CSS initial values as Chrome serializes them (lowercased for lookup).
 *
 * The predicate is VALUE-level only — it knows nothing about the mapped widget. The base-default
 * exemption (I2: a no-op vs. a PAINTED widget base default must still be emitted, e.g. transparent
 * background on `e-button`) is owned by STYLE-EXTRACT, which consults this predicate together with
 * its `PAINTED_BASE_DEFAULT_PROPS` table and applies it to BASE groups only (a state/breakpoint
 * DELTA is by definition a change from base, never noise).
 */
const COMPUTED_DEFAULT_VALUES: Readonly<Record<string, readonly string[]>> = {
  transform: ['none'],
  filter: ['none'],
  'backdrop-filter': ['none'],
  'box-shadow': ['none'],
  'background-image': ['none'],
  'background-size': ['auto', 'auto auto'],
  'background-position': ['0% 0%'],
  'background-repeat': ['repeat'],
  'background-attachment': ['scroll'],
  'background-clip': ['border-box'],
  'text-transform': ['none'],
  'letter-spacing': ['normal'],
  'word-spacing': ['normal', '0px'],
  'font-style': ['normal'],
  'line-height': ['normal'],
  'min-width': ['auto', '0px'],
  'min-height': ['auto', '0px'],
  'max-width': ['none'],
  'max-height': ['none'],
  width: ['auto'],
  height: ['auto'],
  'z-index': ['auto'],
  order: ['0'],
  opacity: ['1'],
  'mix-blend-mode': ['normal'],
  cursor: ['auto'],
  position: ['static'],
  overflow: ['visible'],
  'object-fit': ['fill'],
  'object-position': ['50% 50%'],
  'aspect-ratio': ['auto'],
  'grid-auto-flow': ['row'],
  'grid-column': ['auto', 'auto / auto'],
  'grid-row': ['auto', 'auto / auto'],
  'grid-template-columns': ['none'],
  'grid-template-rows': ['none'],
  'flex-direction': ['row'],
  'flex-wrap': ['nowrap'],
  'align-items': ['normal'],
  'align-self': ['auto'],
  'align-content': ['normal'],
  'justify-content': ['normal'],
  'justify-items': ['normal', 'legacy'],
  'justify-self': ['auto'],
  gap: ['normal', 'normal normal', '0px'],
  'row-gap': ['normal', '0px'],
  'column-gap': ['normal', '0px'],
  'outline-width': ['0px'],
  'outline-style': ['none'],
};

/** A time token in a computed `transition` segment (`0s`, `0.3s`, `200ms`). */
const TRANSITION_TIME_RE = /^-?(?:\d*\.\d+|\d+)m?s$/;

/**
 * I4 — is this declaration computed-default NOISE (a browser default / zero-effect value that loses
 * nothing when excluded)? Pure value-level check; the caller (STYLE-EXTRACT) owns the I2 painted
 * base-default exemption and restricts the filter to BASE declaration groups. Beyond the static
 * table this recognizes:
 *   - `transition` with every layer's DURATION at 0 (`all 0s ease 0s` — the computed default; a
 *     zero-duration transition can never animate),
 *   - fully transparent `background-color`/`background` (the computed default paint of nothing —
 *     I2's e-button exemption is the caller's job),
 *   - `text-decoration`'s computed `none solid rgb(0, 0, 0)` serialization.
 */
export function isComputedDefaultNoise(prop: string, value: string): boolean {
  const p = prop.trim().toLowerCase();
  const v = kw(value);
  if (p === 'transition') {
    if (v === 'none') {
      return true;
    }
    // Noise iff EVERY comma layer's duration is zero — a real duration on any layer means the
    // transition can fire. Two zero-duration serializations exist in the wild: the classic
    // `all 0s ease 0s` (an explicit first time token of 0) and modern Chrome's bare `all`
    // (the all-default shorthand collapses to the property name alone — NO time token; the
    // omitted duration computes to the initial `0s`). The old predicate required a parseable
    // time token to call a layer noise, so the bare-`all` default leaked one phantom
    // custom_css `transition` row per node (~140 on the Driftwell baseline) straight through
    // I4 — contract 18 §7 P3-a.
    return splitTopLevelCommas(v).every((seg) => {
      const time = splitTopLevelWhitespace(seg).find((t) => TRANSITION_TIME_RE.test(t));
      return time === undefined || Number.parseFloat(time) === 0;
    });
  }
  if (p === 'background-color' || p === 'background') {
    return v === 'transparent' || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(v);
  }
  if (p === 'text-decoration') {
    return /^none\b/.test(v);
  }
  const defaults = COMPUTED_DEFAULT_VALUES[p];
  return defaults !== undefined && defaults.includes(v);
}

/* ─────────────────────────── the single decision point ──────────────────────────────────────── */

/** Build an `unmappable` verdict with a recorded reason + the suggested ladder tier. */
function unmappable(reason: string, tier?: DeclVerdict['fallback_tier']): DeclVerdict {
  return tier === undefined
    ? { kind: 'unmappable', reason }
    : { kind: 'unmappable', reason, fallback_tier: tier };
}

/** Build a `native` verdict with the typed payload to emit. */
function native(
  atomic_prop: string,
  typed: unknown,
  reason: string,
  kind: DeclVerdict['kind'] = 'native',
): DeclVerdict {
  return { kind, atomic_prop, typed_value: typed, reason };
}

/**
 * Classify ONE CSS declaration against the LIVE `Style_Schema`. The contract: a declaration is
 * `native` ONLY if its prop is a schema key AND its value satisfies the prop's `$$type`/enum/units.
 * Everything else is routed (with a recorded reason + suggested fallback tier).
 *
 * NOTE on logical box props: when the prop is one of {@link LOGICAL_BOX_PROPS} or a physical inset,
 * the verdict is `native` with the RAW value echoed as `typed_value` — STYLE-EXTRACT does the
 * direction-aware WP-H02 relocation and supplies the real logical object. (This keeps the
 * direction-aware decision in one place, WP-H02, per the ticket.)
 */
export function classifyDeclaration(prop: string, value: string, schema: StyleSchema): DeclVerdict {
  const propName = prop.trim().toLowerCase();
  const raw = value.trim();

  // Global CSS keywords (inherit/initial/...) have no native atomic expression on most props.
  if (GLOBAL_KEYWORDS.has(kw(raw))) {
    return unmappable(`global keyword "${raw}" has no native value`, 'custom_css');
  }

  // Physical inset props relocate to logical inset names (WP-H02). They map natively iff the LOGICAL
  // name is a schema key (it is, in the live schema). Echo raw; STYLE-EXTRACT supplies the logical.
  if (PHYSICAL_INSET_PROPS.has(propName)) {
    // The schema exposes inset-{block,inline}-{start,end}; require at least one to be present.
    const hasLogicalInset =
      'inset-block-start' in schema ||
      'inset-inline-start' in schema ||
      'inset-block-end' in schema ||
      'inset-inline-end' in schema;
    if (!hasLogicalInset) {
      return unmappable(`inset prop "${propName}" absent from schema`, 'custom_css');
    }
    return native(propName, raw, 'physical inset → logical (WP-H02)');
  }

  // Logical box props (padding/margin/border-radius/border-width/text-align): native iff the prop is a
  // schema key; WP-H02 does the relocation/translation in STYLE-EXTRACT.
  if (LOGICAL_BOX_PROPS.has(propName)) {
    if (!(propName in schema)) {
      return unmappable(`"${propName}" absent from Style_Schema`, 'custom_css');
    }
    return native(propName, raw, 'logical box prop → WP-H02');
  }

  // Typed-object props: must decompose exactly or fall back. Decide BEFORE the generic schema check
  // (a raw shorthand string would otherwise look "present" but PHP rejects it).
  if (TYPED_OBJECT_PROPS.has(propName)) {
    return classifyTypedObject(propName, raw, schema);
  }

  // Free-string props: emit a `string` typed value but mark DEFER (TS cannot fully validate).
  if (FREE_STRING_PROPS.has(propName)) {
    if (!(propName in schema)) {
      return unmappable(`free-string prop "${propName}" absent from schema`, 'custom_css');
    }
    return {
      kind: 'native',
      atomic_prop: propName,
      typed_value: typedValue('string', raw),
      reason: 'free-string prop (is_string only) — DEFER to PHP/visual-diff',
    };
  }

  // Generic: the prop MUST be a schema key.
  const entry = schema[propName];
  if (entry === undefined) {
    return unmappable(`"${propName}" absent from Style_Schema`, 'custom_css');
  }

  return classifyBySchemaType(propName, raw, entry);
}

/** Decompose/route a typed-object prop (transform/transition/filter/box-shadow/background). */
function classifyTypedObject(prop: string, value: string, schema: StyleSchema): DeclVerdict {
  // `background`/`background-color` BOTH target the single schema key `background` (render-then-extract
  // emits the computed `background-color`, which is NOT itself a schema key). Handle them BEFORE the
  // generic `prop in schema` guard so `background-color` isn't dropped as "absent from schema".
  // `background-image: none` is the computed no-op for "no background image" — drop silently (it is NOT
  // a fidelity loss and would otherwise be a noisy custom_css fallback on nearly every node).
  if (prop === 'background-image' && kw(value) === 'none') {
    return unmappable('background-image:none (no-op)', 'custom_css');
  }
  if (prop === 'background' || prop === 'background-color' || prop === 'background-image') {
    if (!('background' in schema)) {
      return unmappable('background prop absent from schema', 'custom_css');
    }
    if (isGradientBackground(value)) {
      // A single linear/radial gradient → the NATIVE `background` overlay prop (renders). Conic /
      // repeating / multi-layer fall through to custom_css.
      const grad = decomposeGradientBackground(value);
      if (grad !== null) {
        return native('background', grad, 'gradient background → native background-overlay prop');
      }
      return unmappable(
        'gradient background not decomposable (conic/repeating/multi-layer)',
        'custom_css',
      );
    }
    // A `background-image: url(...)` (non-gradient) has no decomposition here — defer to custom_css/media.
    if (prop === 'background-image') {
      return unmappable('background-image url/other not decomposable here', 'custom_css');
    }
    // A plain solid background color → emit the NATIVE atomic `background` prop. The Style_Schema models
    // it as `{$$type:'background', value:{color:{$$type:'color', value:<color>}}}` (VERIFIED valid via
    // live dry_run). Backgrounds are the most visually-load-bearing style, so dropping them to custom_css
    // (which renders nothing) was the single biggest fidelity loss — this recovers it. Skip fully
    // transparent (rgba(0,0,0,0)/transparent) — emitting it would paint nothing and add noise.
    const cv = value.trim();
    if (/^transparent$/i.test(cv) || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(cv)) {
      return unmappable('transparent background (no-op)', 'custom_css');
    }
    if (looksLikeColor(cv)) {
      return native(
        'background',
        { $$type: 'background', value: { color: typedValue('color', cv) } },
        'solid background color → native background prop',
        'variable-candidate',
      );
    }
    return unmappable('background value not decomposable (image/multi-layer)', 'custom_css');
  }
  if (!(prop in schema)) {
    return unmappable(`typed-object prop "${prop}" absent from schema`, 'custom_css');
  }
  if (prop === 'box-shadow') {
    const decomposed = decomposeBoxShadow(value);
    if (decomposed !== null) {
      return native('box-shadow', decomposed, 'box-shadow decomposed to nested shadow envelope');
    }
    return unmappable('box-shadow not decomposable (unparseable layer)', 'custom_css');
  }
  // transform / transition / filter / backdrop-filter: complex typed objects. v1 routes to fallback
  // (honest coverage; SUPPLEMENT §C.4 — these are 100% of the realistic tail) rather than guessing.
  return unmappable(`typed-object prop "${prop}" requires exact decomposition`, 'custom_css');
}

/** Classify a generic prop whose schema entry is known (`$$type`/enum/units). */
function classifyBySchemaType(
  prop: string,
  value: string,
  entry: { $$type: string; enum?: string[]; units?: string[] },
): DeclVerdict {
  const v = kw(value);

  // ── enum-constrained props ────────────────────────────────────────────────────────────────
  if (entry.enum !== undefined && entry.enum.length > 0) {
    // font-weight: numeric snapping to the 100-step grid.
    if (prop === 'font-weight') {
      const snap = snapFontWeight(value);
      if (snap === null) {
        return unmappable(`font-weight "${value}" has no native enum member`, 'custom_css');
      }
      if (!entry.enum.includes(snap.value)) {
        return unmappable(`font-weight "${snap.value}" not in schema enum`, 'custom_css');
      }
      return {
        kind: 'native',
        atomic_prop: prop,
        typed_value: typedValue('string', snap.value),
        reason: snap.snapped ? `font-weight snapped ${value}→${snap.value}` : 'font-weight native',
      };
    }
    if (entry.enum.includes(v)) {
      return native(
        prop,
        typedValue(entry.$$type === 'number' ? 'number' : 'string', v),
        'enum member',
      );
    }
    return unmappable(`"${value}" not in ${prop} enum [${entry.enum.join(',')}]`, 'custom_css');
  }

  // ── size props ────────────────────────────────────────────────────────────────────────────
  if (SCALAR_SIZE_TYPES.has(entry.$$type)) {
    const len = parseLength(value);
    if (len === null) {
      return unmappable(`"${value}" is not a valid ${prop} length`, 'custom_css');
    }
    if (!unitAllowed(len.unit, entry.units)) {
      return unmappable(
        `unit "${len.unit}" not in ${prop} units [${(entry.units ?? []).join(',')}]`,
        'custom_css',
      );
    }
    if (!lexerAccepts(prop, value)) {
      return unmappable(`css-tree rejects ${prop}:${value}`, 'custom_css');
    }
    return native(prop, sizeValue(len.size, len.unit), 'size native');
  }

  // ── color props ───────────────────────────────────────────────────────────────────────────
  if (entry.$$type === 'color') {
    if (!looksLikeColor(value)) {
      return unmappable(`"${value}" is not a recognizable color`, 'custom_css');
    }
    // A literal color → native AND a variable-candidate (WP-H09 may extract it).
    return native(prop, typedValue('color', value.trim()), 'literal color', 'variable-candidate');
  }

  // ── number props ──────────────────────────────────────────────────────────────────────────
  if (entry.$$type === 'number') {
    const n = Number(value.trim());
    if (!Number.isFinite(n)) {
      return unmappable(`"${value}" is not numeric for ${prop}`, 'custom_css');
    }
    return native(prop, typedValue('number', n), 'number native');
  }

  // ── plain string props with no enum (e.g. is_string) ───────────────────────────────────────
  if (entry.$$type === 'string') {
    return {
      kind: 'native',
      atomic_prop: prop,
      typed_value: typedValue('string', value.trim()),
      reason: 'string native — DEFER to PHP',
    };
  }

  // Unknown/complex $$type we do not model → fallback honestly rather than guess.
  return unmappable(
    `prop "${prop}" $$type "${entry.$$type}" not modeled in TS pre-filter`,
    'custom_css',
  );
}
