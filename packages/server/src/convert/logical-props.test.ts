/**
 * WP-H02 — unit + contract tests for the direction-aware physical→logical box-property module.
 *
 * Covers the acceptance criteria: LTR vs RTL inline-axis mirroring for dimensions / border-radius /
 * border-width / inset (block axis NEVER mirrored); the visual-equivalence (mirror) property; the
 * text-align mandatory translation both directions; alignment pass-through (preserve intent); the
 * `auto` sentinel survival; `canCollapseToLogical` cases; purity (no I/O imports); and a CONTRACT
 * snapshot asserting the emitted `dimensions` field names are exactly the frozen
 * `atomic-prop-types.schema.json#/$defs/Dimensions` property set.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type Direction,
  type PhysicalBox,
  type PhysicalCorners,
  type SizeValue,
  canCollapseToLogical,
  parseLen,
  resolveBorderRadius,
  resolveBorderWidth,
  resolveDimensions,
  resolveInset,
  resolveLogicalKeyword,
} from './logical-props.js';

/* ─────────────────────────── helpers ───────────────────────────────────────────────────────── */

const px = (n: number): SizeValue => ({ size: n, unit: 'px' });

/** Mirror a physical box on the inline axis (swap left/right) — block axis untouched. */
function mirror(box: PhysicalBox): PhysicalBox {
  const out: PhysicalBox = {};
  if (box.top !== undefined) out.top = box.top;
  if (box.bottom !== undefined) out.bottom = box.bottom;
  if (box.left !== undefined) out.right = box.left;
  if (box.right !== undefined) out.left = box.right;
  return out;
}

/* ─────────────────────────── parseLen ──────────────────────────────────────────────────────── */

describe('parseLen', () => {
  it('parses px / % / rem magnitudes and units', () => {
    expect(parseLen('16px')).toEqual({ size: 16, unit: 'px' });
    expect(parseLen('50%')).toEqual({ size: 50, unit: '%' });
    expect(parseLen('1.5rem')).toEqual({ size: 1.5, unit: 'rem' });
    expect(parseLen('-8px')).toEqual({ size: -8, unit: 'px' });
  });

  it('treats unitless 0 as px', () => {
    expect(parseLen('0')).toEqual({ size: 0, unit: 'px' });
  });

  it('passes `auto` through as the {size:null, unit:auto} sentinel (not coerced to a number)', () => {
    expect(parseLen('auto')).toEqual({ size: null, unit: 'auto' });
    expect(parseLen('AUTO')).toEqual({ size: null, unit: 'auto' });
    expect(parseLen('  auto ')).toEqual({ size: null, unit: 'auto' });
  });

  it('surfaces calc()/var() verbatim as a custom size (never throws)', () => {
    expect(parseLen('calc(100% - 8px)')).toEqual({ size: 'calc(100% - 8px)', unit: 'custom' });
    expect(parseLen('var(--gap)')).toEqual({ size: 'var(--gap)', unit: 'custom' });
  });
});

/* ─────────────────────────── resolveDimensions ─────────────────────────────────────────────── */

describe('resolveDimensions', () => {
  const box: PhysicalBox = { top: '8px', right: '4px', bottom: '8px', left: '12px' };

  it('maps LTR: left->inline-start, right->inline-end; block axis as-is', () => {
    expect(resolveDimensions(box, 'ltr')).toEqual({
      'block-start': px(8),
      'inline-end': px(4),
      'block-end': px(8),
      'inline-start': px(12),
    });
  });

  it('maps RTL: inline axis mirrored, block axis UNCHANGED', () => {
    expect(resolveDimensions(box, 'rtl')).toEqual({
      'block-start': px(8),
      'inline-end': px(12),
      'block-end': px(8),
      'inline-start': px(4),
    });
  });

  it('RTL(x) is visually equivalent to LTR(mirror(x)) — inline-axis mirror property', () => {
    expect(resolveDimensions(box, 'rtl')).toEqual(resolveDimensions(mirror(box), 'ltr'));
  });

  it('keeps absent edges absent (no synthetic 0 injected)', () => {
    expect(resolveDimensions({ left: '12px' }, 'ltr')).toEqual({ 'inline-start': px(12) });
    expect(resolveDimensions({ left: '12px' }, 'rtl')).toEqual({ 'inline-end': px(12) });
  });

  it('survives `margin: 0 auto` — auto inline edges stay the auto sentinel', () => {
    const margin: PhysicalBox = { top: '0', right: 'auto', bottom: '0', left: 'auto' };
    const out = resolveDimensions(margin, 'ltr');
    expect(out['inline-start']).toEqual({ size: null, unit: 'auto' });
    expect(out['inline-end']).toEqual({ size: null, unit: 'auto' });
    expect(out['block-start']).toEqual(px(0));
  });
});

/* ─────────────────────────── resolveBorderRadius ───────────────────────────────────────────── */

describe('resolveBorderRadius', () => {
  const corners: PhysicalCorners = {
    'top-left': '1px',
    'top-right': '2px',
    'bottom-right': '3px',
    'bottom-left': '4px',
  };

  it('maps LTR corners to start-start/start-end/end-end/end-start', () => {
    expect(resolveBorderRadius(corners, 'ltr')).toEqual({
      'start-start': px(1),
      'start-end': px(2),
      'end-end': px(3),
      'end-start': px(4),
    });
  });

  it('RTL mirrors ONLY the inline component of each corner (block component intact)', () => {
    // top-left(1) -> start-end ; top-right(2) -> start-start ; br(3) -> end-start ; bl(4) -> end-end
    expect(resolveBorderRadius(corners, 'rtl')).toEqual({
      'start-end': px(1),
      'start-start': px(2),
      'end-start': px(3),
      'end-end': px(4),
    });
  });

  it('keeps absent corners absent', () => {
    expect(resolveBorderRadius({ 'top-left': '5px' }, 'ltr')).toEqual({ 'start-start': px(5) });
  });
});

/* ─────────────────────────── resolveBorderWidth ────────────────────────────────────────────── */

describe('resolveBorderWidth', () => {
  const box: PhysicalBox = { top: '1px', right: '2px', bottom: '3px', left: '4px' };

  it('maps LTR edges to block-start/block-end/inline-start/inline-end', () => {
    expect(resolveBorderWidth(box, 'ltr')).toEqual({
      'block-start': px(1),
      'inline-end': px(2),
      'block-end': px(3),
      'inline-start': px(4),
    });
  });

  it('RTL mirrors only the inline axis', () => {
    expect(resolveBorderWidth(box, 'rtl')).toEqual({
      'block-start': px(1),
      'inline-start': px(2),
      'block-end': px(3),
      'inline-end': px(4),
    });
  });

  it('RTL(x) equals LTR(mirror(x))', () => {
    expect(resolveBorderWidth(box, 'rtl')).toEqual(resolveBorderWidth(mirror(box), 'ltr'));
  });
});

/* ─────────────────────────── resolveInset ──────────────────────────────────────────────────── */

describe('resolveInset', () => {
  const box: PhysicalBox = { top: '10px', right: '20px', bottom: '30px', left: '40px' };

  it('maps top/bottom to the block axis (NEVER mirrored), left/right to the inline axis', () => {
    expect(resolveInset(box, 'ltr')).toEqual({
      'inset-block-start': px(10),
      'inset-inline-end': px(20),
      'inset-block-end': px(30),
      'inset-inline-start': px(40),
    });
  });

  it('RTL mirrors only the inline insets; block insets unchanged', () => {
    expect(resolveInset(box, 'rtl')).toEqual({
      'inset-block-start': px(10),
      'inset-inline-start': px(20),
      'inset-block-end': px(30),
      'inset-inline-end': px(40),
    });
  });

  it('RTL(x) equals LTR(mirror(x))', () => {
    expect(resolveInset(box, 'rtl')).toEqual(resolveInset(mirror(box), 'ltr'));
  });
});

/* ─────────────────────────── resolveLogicalKeyword ─────────────────────────────────────────── */

describe('resolveLogicalKeyword — text-align (translation MANDATORY)', () => {
  it('left -> start (LTR) / end (RTL)', () => {
    expect(resolveLogicalKeyword('text-align', 'left', 'ltr')).toBe('start');
    expect(resolveLogicalKeyword('text-align', 'left', 'rtl')).toBe('end');
  });

  it('right -> end (LTR) / start (RTL) — the inverse of left', () => {
    expect(resolveLogicalKeyword('text-align', 'right', 'ltr')).toBe('end');
    expect(resolveLogicalKeyword('text-align', 'right', 'rtl')).toBe('start');
  });

  it('already-logical values pass through', () => {
    for (const v of ['start', 'center', 'end', 'justify']) {
      expect(resolveLogicalKeyword('text-align', v, 'ltr')).toBe(v);
    }
  });
});

describe('resolveLogicalKeyword — alignment (pass-through, preserve visual intent)', () => {
  it('justify-content left passes through (left is a valid Style-Schema alignment enum member)', () => {
    expect(resolveLogicalKeyword('justify-content', 'left', 'ltr')).toBe('left');
    expect(resolveLogicalKeyword('justify-content', 'left', 'rtl')).toBe('left');
    expect(resolveLogicalKeyword('justify-content', 'right', 'ltr')).toBe('right');
  });

  it('flex-start / center / space-between pass through unchanged on align props', () => {
    expect(resolveLogicalKeyword('align-items', 'flex-start', 'ltr')).toBe('flex-start');
    expect(resolveLogicalKeyword('justify-content', 'space-between', 'rtl')).toBe('space-between');
    expect(resolveLogicalKeyword('align-content', 'center', 'rtl')).toBe('center');
  });

  it('unrecognized values on an unknown prop return verbatim (never throws)', () => {
    expect(resolveLogicalKeyword('color', 'red', 'ltr')).toBe('red');
    expect(resolveLogicalKeyword('justify-content', 'safe center', 'ltr')).toBe('safe center');
  });
});

/* ─────────────────────────── canCollapseToLogical ──────────────────────────────────────────── */

describe('canCollapseToLogical', () => {
  it('true for a full four-edge box', () => {
    expect(canCollapseToLogical({ top: '1px', right: '1px', bottom: '1px', left: '1px' })).toBe(
      true,
    );
  });

  it('false for a single-edge-only box (ambiguous logical collapse)', () => {
    expect(canCollapseToLogical({ left: '12px' })).toBe(false);
  });

  it('false for two-edge and three-edge partial boxes', () => {
    expect(canCollapseToLogical({ top: '1px', bottom: '1px' })).toBe(false);
    expect(canCollapseToLogical({ top: '1px', right: '1px', bottom: '1px' })).toBe(false);
  });

  it('false for the empty box', () => {
    expect(canCollapseToLogical({})).toBe(false);
  });
});

/* ─────────────────────────── CONTRACT: field-name subset vs frozen schema ───────────────────── */

describe('contract — dimensions field names match atomic-prop-types.schema.json', () => {
  const schema = JSON.parse(
    readFileSync(
      new URL('../../../../spec/contracts/schemas/atomic-prop-types.schema.json', import.meta.url),
      'utf8',
    ),
  ) as {
    $defs: { Dimensions: { properties: { value: { properties: Record<string, unknown> } } } };
  };

  const schemaDimensionFields = Object.keys(schema.$defs.Dimensions.properties.value.properties);

  it('the frozen schema declares exactly block-start/inline-end/block-end/inline-start', () => {
    expect(new Set(schemaDimensionFields)).toEqual(
      new Set(['block-start', 'inline-end', 'block-end', 'inline-start']),
    );
  });

  it('every key resolveDimensions emits is a member of the frozen Dimensions def', () => {
    const allowed = new Set(schemaDimensionFields);
    for (const dir of ['ltr', 'rtl'] as Direction[]) {
      const out = resolveDimensions({ top: '1px', right: '2px', bottom: '3px', left: '4px' }, dir);
      for (const key of Object.keys(out)) {
        expect(allowed.has(key), `dimensions key ${key} not in frozen schema`).toBe(true);
      }
    }
  });

  it('matches the frozen Dimensions field-name snapshot', () => {
    expect([...schemaDimensionFields].sort()).toMatchSnapshot();
  });
});

/* ─────────────────────────── purity (no Playwright/fs/WP-client imports) ────────────────────── */

describe('purity', () => {
  it('logical-props.ts imports no Playwright / fs / WP client / transport', () => {
    const src = readFileSync(new URL('./logical-props.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const forbidden = [
      /from\s+['"]playwright['"]/,
      /from\s+['"]playwright-core['"]/,
      /from\s+['"]node:fs['"]/,
      /from\s+['"]fs['"]/,
      /from\s+['"]node:fs\/promises['"]/,
      /from\s+['"][^'"]*\/wp\/client/,
      /from\s+['"][^'"]*\/transport\//,
    ];
    for (const pattern of forbidden) {
      expect(pattern.test(code), `matched forbidden import ${String(pattern)}`).toBe(false);
    }
  });
});
