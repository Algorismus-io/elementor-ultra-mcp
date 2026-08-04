/**
 * WP-H07 — `classifyDeclaration` unit tests (declaration-classifier).
 *
 * Drives the single decision point with a STUB `style_schema` (the live flat `css-prop-name →
 * Prop_Type` map) and asserts the four verdict kinds + the SUPPLEMENT §B.3 / authoring-contract §5.2
 * corrections: schema-absent props → unmappable; enum snapping/rejection (font-weight, display);
 * typed-object decomposition (box-shadow success, gradient fallback); free-string DEFER; size unit
 * clamping; literal-color → variable-candidate. No I/O, no WP client (the module is pure).
 */

import { describe, expect, it } from 'vitest';

import {
  classifyDeclaration,
  snapFontWeight,
  decomposeBoxShadow,
  looksLikeColor,
  isGradientBackground,
  isComputedDefaultNoise,
} from './declaration-classifier.js';
import type { StyleSchema } from './types.js';

/* ─────────────────────────── a representative LIVE-shaped style schema stub (SUPPLEMENT §B.3) ── */

const SCHEMA: StyleSchema = {
  display: {
    $$type: 'string',
    enum: [
      'block',
      'inline',
      'inline-block',
      'flex',
      'inline-flex',
      'grid',
      'inline-grid',
      'flow-root',
      'none',
      'contents',
    ],
  },
  'font-weight': {
    $$type: 'string',
    enum: [
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
      '700',
      '800',
      '900',
      'normal',
      'bold',
      'bolder',
      'lighter',
    ],
  },
  'font-size': { $$type: 'size', units: ['px', 'em', 'rem', 'vw', 'vh', 'ch', '%', 'custom'] },
  width: { $$type: 'size', units: ['px', 'em', 'rem', 'vw', 'vh', 'ch', '%', 'auto', 'custom'] },
  color: { $$type: 'color' },
  'border-color': { $$type: 'color' },
  'z-index': { $$type: 'number' },
  padding: { $$type: 'dimensions' },
  margin: { $$type: 'dimensions' },
  'border-radius': { $$type: 'border-radius' },
  'border-width': { $$type: 'border-width' },
  'text-align': { $$type: 'string', enum: ['start', 'center', 'end', 'justify'] },
  'box-shadow': { $$type: 'box-shadow' },
  transform: { $$type: 'transform' },
  background: { $$type: 'background' },
  'aspect-ratio': { $$type: 'string' },
  'font-family': { $$type: 'string' },
  'inset-block-start': { $$type: 'size' },
  'inset-inline-start': { $$type: 'size' },
  'inset-block-end': { $$type: 'size' },
  'inset-inline-end': { $$type: 'size' },
};

/* ─────────────────────────── native vs fallback per declaration ──────────────────────────────── */

describe('classifyDeclaration — native vs fallback', () => {
  it('enum member (display:flex) is native', () => {
    const v = classifyDeclaration('display', 'flex', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.atomic_prop).toBe('display');
    expect(v.typed_value).toMatchObject({ $$type: 'string', value: 'flex' });
  });

  it('a prop absent from the schema is unmappable (custom_css tier)', () => {
    const v = classifyDeclaration('white-space', 'nowrap', SCHEMA);
    expect(v.kind).toBe('unmappable');
    expect(v.fallback_tier).toBe('custom_css');
    expect(v.reason).toMatch(/absent from/i);
  });

  it('grid-template-areas (absent feature) routes to fallback', () => {
    const v = classifyDeclaration('grid-template-areas', '"a b"', SCHEMA);
    expect(v.kind).toBe('unmappable');
  });

  it('a literal color is native AND flagged variable-candidate', () => {
    const v = classifyDeclaration('color', '#111', SCHEMA);
    expect(v.kind).toBe('variable-candidate');
    expect(v.atomic_prop).toBe('color');
    expect(v.typed_value).toMatchObject({ $$type: 'color', value: '#111' });
  });

  it('a number prop (z-index) is native', () => {
    const v = classifyDeclaration('z-index', '5', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.typed_value).toMatchObject({ $$type: 'number', value: 5 });
  });

  it('a global keyword (inherit) has no native value', () => {
    const v = classifyDeclaration('color', 'inherit', SCHEMA);
    expect(v.kind).toBe('unmappable');
  });
});

/* ─────────────────────────── enum snapping / rejection (§5.2) ────────────────────────────────── */

describe('classifyDeclaration — enum snapping/rejection', () => {
  it('font-weight:350 snaps to the nearest 100-step (400) with a recorded reason', () => {
    const v = classifyDeclaration('font-weight', '350', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.typed_value).toMatchObject({ value: '400' });
    expect(v.reason).toMatch(/snapped/i);
  });

  it('font-weight:600 (already a step) passes through un-snapped', () => {
    const v = classifyDeclaration('font-weight', '600', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.typed_value).toMatchObject({ value: '600' });
    expect(v.reason).not.toMatch(/snapped/i);
  });

  it('a raw font-weight numeric is NEVER emitted (only an enum member)', () => {
    const v = classifyDeclaration('font-weight', '350', SCHEMA);
    // The emitted value must be a 100-step member, never the raw 350.
    expect(v.typed_value).not.toMatchObject({ value: '350' });
  });

  it('display:table has no native enum member → fallback', () => {
    const v = classifyDeclaration('display', 'table', SCHEMA);
    expect(v.kind).toBe('unmappable');
    expect(v.reason).toMatch(/enum/i);
  });

  it('display:list-item → fallback', () => {
    expect(classifyDeclaration('display', 'list-item', SCHEMA).kind).toBe('unmappable');
  });
});

/* ─────────────────────────── typed-object decomposition ──────────────────────────────────────── */

describe('classifyDeclaration — typed-object props', () => {
  it('a simple box-shadow decomposes to the nested shadow envelope', () => {
    const v = classifyDeclaration('box-shadow', '0 2px 8px 0 rgba(0,0,0,0.2)', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.atomic_prop).toBe('box-shadow');
    expect(v.typed_value).toMatchObject({ $$type: 'box-shadow' });
    const arr = (v.typed_value as { value: unknown[] }).value;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(1);
    expect(arr[0]).toMatchObject({ $$type: 'shadow' });
  });

  it('a multi-shadow box-shadow decomposes to one shadow envelope per layer (comma-split, paren-aware)', () => {
    const v = classifyDeclaration('box-shadow', '0 1px 2px #000, 0 4px 8px #111', SCHEMA);
    expect(v.kind).toBe('native');
    const arr = (v.typed_value as { value: unknown[] }).value;
    expect(arr).toHaveLength(2);
    expect(arr[0]).toMatchObject({ $$type: 'shadow' });
    expect(arr[1]).toMatchObject({ $$type: 'shadow' });
  });

  it('parses the Chrome getComputedStyle serialization (color-FIRST, spaces inside the function)', () => {
    // This is the EXACT form the live pipeline feeds (parse.ts reads raw computed values): the color
    // function comes first and carries spaces — a naive whitespace split shredded it to null.
    const v = classifyDeclaration('box-shadow', 'rgba(0, 0, 0, 0.2) 0px 2px 4px 0px', SCHEMA);
    expect(v.kind).toBe('native');
    const arr = (v.typed_value as { value: Array<{ value: Record<string, unknown> }> }).value;
    expect(arr).toHaveLength(1);
    expect(arr[0]!.value['color']).toMatchObject({ $$type: 'color', value: 'rgba(0, 0, 0, 0.2)' });
    expect(arr[0]!.value['hOffset']).toMatchObject({ value: { size: 0, unit: 'px' } });
    expect(arr[0]!.value['vOffset']).toMatchObject({ value: { size: 2, unit: 'px' } });
    expect(arr[0]!.value['blur']).toMatchObject({ value: { size: 4, unit: 'px' } });
    expect(arr[0]!.value['spread']).toMatchObject({ value: { size: 0, unit: 'px' } });
  });

  it('parses Chrome-serialized rgb() colors and multi-shadow lists', () => {
    expect(decomposeBoxShadow('rgb(51, 51, 51) 0px 1px 2px 0px')).not.toBeNull();
    const multi = decomposeBoxShadow(
      'rgba(0, 0, 0, 0.2) 0px 2px 4px 0px, rgba(0, 0, 0, 0.1) 0px 8px 16px 0px',
    );
    expect(multi).not.toBeNull();
    expect((multi as { value: unknown[] }).value).toHaveLength(2);
  });

  it('still bails to fallback on a genuinely unparseable layer', () => {
    expect(decomposeBoxShadow('0 1px 2px notacolor')).toBeNull();
    expect(decomposeBoxShadow('rgba(0, 0, 0, 0.2)')).toBeNull(); // no offsets
  });

  it('box-shadow:none clears to an empty box-shadow array (native)', () => {
    const v = classifyDeclaration('box-shadow', 'none', SCHEMA);
    expect(v.kind).toBe('native');
    expect((v.typed_value as { value: unknown[] }).value).toEqual([]);
  });

  it('a single linear gradient decomposes to the NATIVE background-overlay prop', () => {
    const v = classifyDeclaration('background', 'linear-gradient(90deg, #818cf8, #c084fc)', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.atomic_prop).toBe('background');
    const val = (v.typed_value as { value: Record<string, { value: unknown[] }> }).value;
    const overlay = val['background-overlay'];
    expect(overlay?.value).toHaveLength(1);
    const g = (overlay?.value[0] as { value: Record<string, { value: unknown }> }).value;
    expect((g['type'] as { value: string }).value).toBe('linear');
    expect((g['angle'] as { value: number }).value).toBe(90);
    const stops = (g['stops'] as { value: unknown[] }).value;
    expect(stops).toHaveLength(2);
    const s0 = (stops[0] as { value: Record<string, { value: unknown }> }).value;
    expect((s0['color'] as { value: string }).value).toBe('#818cf8');
    expect((s0['offset'] as { value: number }).value).toBe(0);
    const s1 = (stops[1] as { value: Record<string, { value: unknown }> }).value;
    expect((s1['offset'] as { value: number }).value).toBe(100);
  });

  it('computed background-image gradient also decomposes to native background', () => {
    const v = classifyDeclaration(
      'background-image',
      'linear-gradient(135deg, rgb(0, 102, 204) 0%, #0052a3 100%)',
      SCHEMA,
    );
    expect(v.kind).toBe('native');
    expect(v.atomic_prop).toBe('background');
    const g = (
      v.typed_value as {
        value: {
          'background-overlay': { value: Array<{ value: Record<string, { value: unknown }> }> };
        };
      }
    ).value['background-overlay'].value[0]?.value;
    expect((g?.['angle'] as { value: number }).value).toBe(135);
  });

  it('background-image:none is a silent no-op (no fallback noise)', () => {
    const v = classifyDeclaration('background-image', 'none', SCHEMA);
    expect(v.kind).toBe('unmappable');
  });

  it('a conic gradient still routes to fallback (custom_css)', () => {
    const v = classifyDeclaration('background', 'conic-gradient(#818cf8, #c084fc)', SCHEMA);
    expect(v.kind).toBe('unmappable');
    expect(v.fallback_tier).toBe('custom_css');
  });

  it('transform (complex typed object) routes to fallback in v1', () => {
    const v = classifyDeclaration('transform', 'translateX(10px) rotate(5deg)', SCHEMA);
    expect(v.kind).toBe('unmappable');
  });
});

/* ─────────────────────────── free-string props (DEFER) ──────────────────────────────────────── */

describe('classifyDeclaration — free-string props', () => {
  it('aspect-ratio is emitted as a string value marked DEFER', () => {
    const v = classifyDeclaration('aspect-ratio', '16 / 9', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.typed_value).toMatchObject({ $$type: 'string', value: '16 / 9' });
    expect(v.reason).toMatch(/defer/i);
  });

  it('font-family is a free-string native DEFER', () => {
    const v = classifyDeclaration('font-family', '"Inter", system-ui, sans-serif', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.typed_value).toMatchObject({ $$type: 'string' });
    expect(v.reason).toMatch(/defer/i);
  });
});

/* ─────────────────────────── size props + unit clamping ──────────────────────────────────────── */

describe('classifyDeclaration — size props', () => {
  it('font-size:48px is a native size envelope', () => {
    const v = classifyDeclaration('font-size', '48px', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.typed_value).toMatchObject({ $$type: 'size', value: { size: 48, unit: 'px' } });
  });

  it('width:auto becomes {size:null,unit:auto}', () => {
    const v = classifyDeclaration('width', 'auto', SCHEMA);
    expect(v.typed_value).toMatchObject({ $$type: 'size', value: { size: null, unit: 'auto' } });
  });

  it('a disallowed unit is rejected (font-size in deg)', () => {
    const v = classifyDeclaration('font-size', '5deg', SCHEMA);
    expect(v.kind).toBe('unmappable');
    expect(v.reason).toMatch(/unit/i);
  });

  it('calc()/var() values survive as a custom size', () => {
    const v = classifyDeclaration('width', 'calc(100% - 20px)', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.typed_value).toMatchObject({ $$type: 'size', value: { unit: 'custom' } });
  });
});

/* ─────────────────────────── logical box props echoed for WP-H02 ─────────────────────────────── */

describe('classifyDeclaration — logical box props are native echoes for WP-H02', () => {
  it('padding is reported native (STYLE-EXTRACT does the WP-H02 relocation)', () => {
    const v = classifyDeclaration('padding', '8px 4px', SCHEMA);
    expect(v.kind).toBe('native');
    expect(v.atomic_prop).toBe('padding');
    expect(v.reason).toMatch(/WP-H02/i);
  });

  it('a physical inset (left) maps to logical when the logical name is in the schema', () => {
    const v = classifyDeclaration('left', '10px', SCHEMA);
    expect(v.kind).toBe('native');
  });
});

/* ─────────────────────────── computed-default noise (contract 17 — I4) ───────────────────────── */

describe('isComputedDefaultNoise — I4 computed-default noise predicate', () => {
  it('recognizes the per-element browser defaults that inflated custom_css (page 1704)', () => {
    expect(isComputedDefaultNoise('transform', 'none')).toBe(true);
    expect(isComputedDefaultNoise('filter', 'none')).toBe(true);
    expect(isComputedDefaultNoise('backdrop-filter', 'none')).toBe(true);
    expect(isComputedDefaultNoise('box-shadow', 'none')).toBe(true);
    expect(isComputedDefaultNoise('background-image', 'none')).toBe(true);
    expect(isComputedDefaultNoise('position', 'static')).toBe(true);
    expect(isComputedDefaultNoise('overflow', 'visible')).toBe(true);
    expect(isComputedDefaultNoise('z-index', 'auto')).toBe(true);
    expect(isComputedDefaultNoise('order', '0')).toBe(true);
    expect(isComputedDefaultNoise('opacity', '1')).toBe(true);
    expect(isComputedDefaultNoise('min-width', '0px')).toBe(true);
    expect(isComputedDefaultNoise('min-width', 'auto')).toBe(true);
    expect(isComputedDefaultNoise('max-width', 'none')).toBe(true);
    expect(isComputedDefaultNoise('letter-spacing', 'normal')).toBe(true);
    expect(isComputedDefaultNoise('flex-wrap', 'nowrap')).toBe(true);
    expect(isComputedDefaultNoise('grid-column', 'auto / auto')).toBe(true);
  });

  it('NEVER flags authored (non-default) values', () => {
    expect(isComputedDefaultNoise('transform', 'translateX(10px)')).toBe(false);
    expect(isComputedDefaultNoise('position', 'absolute')).toBe(false);
    expect(isComputedDefaultNoise('opacity', '0.5')).toBe(false);
    expect(isComputedDefaultNoise('order', '2')).toBe(false);
    expect(isComputedDefaultNoise('z-index', '10')).toBe(false);
    expect(isComputedDefaultNoise('min-width', '200px')).toBe(false);
    expect(isComputedDefaultNoise('width', '300px')).toBe(false);
    expect(isComputedDefaultNoise('overflow', 'hidden')).toBe(false);
    expect(isComputedDefaultNoise('grid-template-columns', 'repeat(3, 1fr)')).toBe(false);
  });

  it('transition is noise ONLY when every layer has a zero duration (the computed default)', () => {
    expect(isComputedDefaultNoise('transition', 'all 0s ease 0s')).toBe(true);
    expect(isComputedDefaultNoise('transition', 'none')).toBe(true);
    expect(isComputedDefaultNoise('transition', 'opacity 0.3s ease 0s')).toBe(false);
    // one real layer keeps the whole declaration (it can fire).
    expect(isComputedDefaultNoise('transition', 'all 0s ease 0s, opacity 0.2s linear 0s')).toBe(
      false,
    );
  });

  it('P3-a (contract 18 §7): a transition layer with NO time token is the zero-duration default', () => {
    // Modern Chrome serializes the all-default computed `transition` as just `all` (no time
    // tokens) — the omitted duration computes to the initial 0s, so the transition can never
    // fire. The old token-required predicate let this leak ~140 phantom custom_css rows per
    // page (one per node) through I4 on the Driftwell baseline.
    expect(isComputedDefaultNoise('transition', 'all')).toBe(true);
    expect(isComputedDefaultNoise('transition', 'opacity')).toBe(true);
    expect(isComputedDefaultNoise('transition', 'opacity, transform')).toBe(true);
    // A REAL declared transition in the same serialization style (duration only, default delay
    // omitted — `opacity 0.7s, transform 0.7s` is what Chrome reports for the Driftwell
    // `.reveal` rule) still survives.
    expect(isComputedDefaultNoise('transition', 'opacity 0.7s, transform 0.7s')).toBe(false);
    expect(isComputedDefaultNoise('transition', 'all 0.2s')).toBe(false);
  });

  it('transparent backgrounds are value-level noise (the I2 painted-base exemption is the caller)', () => {
    expect(isComputedDefaultNoise('background-color', 'rgba(0, 0, 0, 0)')).toBe(true);
    expect(isComputedDefaultNoise('background-color', 'transparent')).toBe(true);
    expect(isComputedDefaultNoise('background-color', '#fff')).toBe(false);
    expect(isComputedDefaultNoise('background', 'transparent')).toBe(true);
  });

  it("text-decoration's computed none-serialization is noise; an authored underline is not", () => {
    expect(isComputedDefaultNoise('text-decoration', 'none solid rgb(0, 0, 0)')).toBe(true);
    expect(isComputedDefaultNoise('text-decoration', 'underline')).toBe(false);
  });

  it('flex-direction:row is value-level noise (STYLE-EXTRACT exempts e-flexbox, whose base is column)', () => {
    expect(isComputedDefaultNoise('flex-direction', 'row')).toBe(true);
    expect(isComputedDefaultNoise('flex-direction', 'column')).toBe(false);
  });
});

/* ─────────────────────────── helper-level assertions ────────────────────────────────────────── */

describe('helpers', () => {
  it('snapFontWeight maps 350→400, 50→100, 950→900', () => {
    expect(snapFontWeight('350')).toEqual({ value: '400', snapped: true });
    expect(snapFontWeight('50')).toEqual({ value: '100', snapped: true });
    expect(snapFontWeight('950')).toEqual({ value: '900', snapped: true });
    expect(snapFontWeight('bold')).toEqual({ value: 'bold', snapped: false });
    expect(snapFontWeight('not-a-weight')).toBeNull();
  });

  it('looksLikeColor recognizes hex/rgb/named, rejects junk', () => {
    expect(looksLikeColor('#abc')).toBe(true);
    expect(looksLikeColor('rgba(0,0,0,0.2)')).toBe(true);
    expect(looksLikeColor('teal')).toBe(true);
    expect(looksLikeColor('123abc')).toBe(false);
  });

  it('isGradientBackground detects all gradient functions', () => {
    expect(isGradientBackground('radial-gradient(circle, #000, #fff)')).toBe(true);
    expect(isGradientBackground('#0f172a')).toBe(false);
  });

  it('decomposeBoxShadow handles inset', () => {
    const env = decomposeBoxShadow('inset 0 0 4px #000');
    expect(env).not.toBeNull();
    const shadow = (env as { value: Array<{ value: Record<string, unknown> }> }).value[0];
    expect(shadow?.value['position']).toMatchObject({ value: 'inset' });
  });
});
