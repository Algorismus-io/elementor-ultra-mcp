/**
 * WP-H05 — FLEX INFERENCE tests.
 *
 * PURE unit tests against hand-authored IR fixtures (no Chromium, no I/O — `inferFlex` is a pure
 * transform, ticket Parallelization Notes: unit-testable against hand-authored IR the moment WP-H01
 * lands). Covers the acceptance criteria:
 *   - row vs column inference (explicit `flex-direction` + geometry band inference for dirty CSS);
 *   - wrap detection;
 *   - justify/align extraction;
 *   - gap extraction;
 *   - fill_children (flex:1 / flex-grow>=1) vs absolute_children (position:absolute|fixed);
 *   - conservative grid classification (1D row/col → NOT grid; true 2x2 → grid);
 *   - `null` for non-containers.
 */

import { describe, expect, it } from 'vitest';

import {
  inferDirectionFromGeometry,
  inferFlex,
  isFlexDisplay,
  isGridDisplay,
  isTrueGrid,
} from './flex-inference.js';
import type { BoxRect, ComputedStyleSet, IrNode } from './types.js';

/* ─────────────────────────── tiny IR builders ───────────────────────────────────────────────── */

const ZERO_BOX: BoxRect = { x: 0, y: 0, width: 0, height: 0 };

function box(x: number, y: number, width: number, height: number): BoxRect {
  return { x, y, width, height };
}

function node(partial: Partial<IrNode> & { source_path: string; tag: string }): IrNode {
  return {
    source_path: partial.source_path,
    tag: partial.tag,
    role: partial.role ?? 'unknown',
    box: partial.box ?? ZERO_BOX,
    computed: partial.computed ?? {},
    responsive: partial.responsive ?? {},
    attrs: partial.attrs ?? {},
    textRuns: partial.textRuns ?? [],
    children: partial.children ?? [],
    ...(partial.media !== undefined ? { media: partial.media } : {}),
    ...(partial.hoverComputed !== undefined ? { hoverComputed: partial.hoverComputed } : {}),
    ...(partial.focusComputed !== undefined ? { focusComputed: partial.focusComputed } : {}),
  };
}

function flexContainer(computed: ComputedStyleSet, children: IrNode[], sp = 'c'): IrNode {
  return node({ source_path: sp, tag: 'div', computed, children });
}

/* ─────────────────────────── display detectors ──────────────────────────────────────────────── */

describe('flex-inference: display detectors', () => {
  it('isFlexDisplay matches flex + inline-flex', () => {
    expect(isFlexDisplay({ display: 'flex' })).toBe(true);
    expect(isFlexDisplay({ display: 'inline-flex' })).toBe(true);
    expect(isFlexDisplay({ display: 'block' })).toBe(false);
    expect(isFlexDisplay({})).toBe(false);
  });

  it('isGridDisplay matches grid + inline-grid', () => {
    expect(isGridDisplay({ display: 'grid' })).toBe(true);
    expect(isGridDisplay({ display: 'inline-grid' })).toBe(true);
    expect(isGridDisplay({ display: 'flex' })).toBe(false);
  });
});

/* ─────────────────────────── direction: explicit flex ───────────────────────────────────────── */

describe('flex-inference: explicit flex direction', () => {
  it('display:flex with flex-direction:row → direction row', () => {
    const c = flexContainer({ display: 'flex', 'flex-direction': 'row' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(110, 0, 100, 50) }),
    ]);
    const intent = inferFlex(c);
    expect(intent).not.toBeNull();
    expect(intent?.direction).toBe('row');
  });

  it('display:flex with flex-direction:column → direction column', () => {
    const c = flexContainer({ display: 'flex', 'flex-direction': 'column' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(0, 60, 100, 50) }),
    ]);
    expect(inferFlex(c)?.direction).toBe('column');
  });

  it('display:flex with no flex-direction defaults to row', () => {
    const c = flexContainer({ display: 'flex' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(60, 0, 50, 50) }),
    ]);
    expect(inferFlex(c)?.direction).toBe('row');
  });

  it('column-reverse resolves to column', () => {
    const c = flexContainer({ display: 'flex', 'flex-direction': 'column-reverse' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(0, 60, 50, 50) }),
    ]);
    expect(inferFlex(c)?.direction).toBe('column');
  });
});

/* ─────────────────────────── direction: geometry band (dirty CSS) ───────────────────────────── */

describe('flex-inference: geometry band inference (dirty marketing CSS)', () => {
  it('horizontally-laid children with no explicit flex → row (infer from geometry)', () => {
    const c = flexContainer({ display: 'block' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 200, 100) }),
      node({ source_path: 'b', tag: 'div', box: box(220, 0, 200, 100) }),
      node({ source_path: 'd', tag: 'div', box: box(440, 0, 200, 100) }),
    ]);
    const intent = inferFlex(c);
    expect(intent).not.toBeNull();
    expect(intent?.direction).toBe('row');
  });

  it('vertically-stacked children with no explicit flex → column (infer from geometry)', () => {
    const c = flexContainer({ display: 'block' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 400, 100) }),
      node({ source_path: 'b', tag: 'div', box: box(0, 120, 400, 100) }),
      node({ source_path: 'd', tag: 'div', box: box(0, 240, 400, 100) }),
    ]);
    expect(inferFlex(c)?.direction).toBe('column');
  });

  it('inferDirectionFromGeometry returns null for <2 boxed children', () => {
    expect(
      inferDirectionFromGeometry([node({ source_path: 'a', tag: 'div', box: box(0, 0, 10, 10) })]),
    ).toBeNull();
    expect(inferDirectionFromGeometry([])).toBeNull();
  });

  it('inferDirectionFromGeometry classifies a side-by-side pair as row', () => {
    const dir = inferDirectionFromGeometry([
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 100) }),
      node({ source_path: 'b', tag: 'div', box: box(120, 5, 100, 100) }),
    ]);
    expect(dir).toBe('row');
  });
});

/* ─────────────────────────── wrap / justify / align / gap ───────────────────────────────────── */

describe('flex-inference: wrap, alignment, gap', () => {
  it('flex-wrap:wrap → wrap true', () => {
    const c = flexContainer({ display: 'flex', 'flex-wrap': 'wrap' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(60, 0, 50, 50) }),
    ]);
    expect(inferFlex(c)?.wrap).toBe(true);
  });

  it('flex-wrap:nowrap → wrap false', () => {
    const c = flexContainer({ display: 'flex', 'flex-wrap': 'nowrap' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(60, 0, 50, 50) }),
    ]);
    expect(inferFlex(c)?.wrap).toBe(false);
  });

  it('extracts justify-content and align-items', () => {
    const c = flexContainer(
      { display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' },
      [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
        node({ source_path: 'b', tag: 'div', box: box(60, 0, 50, 50) }),
      ],
    );
    const intent = inferFlex(c);
    expect(intent?.justify).toBe('space-between');
    expect(intent?.align).toBe('center');
  });

  it('drops normal/auto alignment defaults', () => {
    const c = flexContainer(
      { display: 'flex', 'justify-content': 'normal', 'align-items': 'normal' },
      [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
        node({ source_path: 'b', tag: 'div', box: box(60, 0, 50, 50) }),
      ],
    );
    const intent = inferFlex(c);
    expect(intent?.justify).toBeUndefined();
    expect(intent?.align).toBeUndefined();
  });

  it('extracts a non-zero gap and drops a zero gap', () => {
    const withGap = flexContainer({ display: 'flex', gap: '16px' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(70, 0, 50, 50) }),
    ]);
    expect(inferFlex(withGap)?.gap).toBe('16px');

    const zeroGap = flexContainer({ display: 'flex', gap: '0px' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(60, 0, 50, 50) }),
    ]);
    expect(inferFlex(zeroGap)?.gap).toBeUndefined();
  });

  it('reads row-gap when no shorthand gap is present', () => {
    const c = flexContainer({ display: 'flex', 'row-gap': '24px' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 50, 50) }),
      node({ source_path: 'b', tag: 'div', box: box(0, 80, 50, 50) }),
    ]);
    expect(inferFlex(c)?.gap).toBe('24px');
  });
});

/* ─────────────────────────── fill vs absolute children ──────────────────────────────────────── */

describe('flex-inference: fill vs absolute children', () => {
  it('flex:1 child → fill_children', () => {
    const c = flexContainer({ display: 'flex' }, [
      node({
        source_path: 'fill',
        tag: 'div',
        box: box(0, 0, 300, 50),
        computed: { flex: '1 1 0%' },
      }),
      node({ source_path: 'fixed', tag: 'div', box: box(310, 0, 100, 50) }),
    ]);
    const intent = inferFlex(c);
    expect(intent?.fill_children).toEqual(['fill']);
    expect(intent?.absolute_children).toEqual([]);
  });

  it('flex-grow:1 child → fill_children', () => {
    const c = flexContainer({ display: 'flex' }, [
      node({
        source_path: 'grow',
        tag: 'div',
        box: box(0, 0, 300, 50),
        computed: { 'flex-grow': '1' },
      }),
      node({ source_path: 'static', tag: 'div', box: box(310, 0, 100, 50) }),
    ]);
    expect(inferFlex(c)?.fill_children).toEqual(['grow']);
  });

  it('absolutely-positioned child → absolute_children (removed from flow)', () => {
    const c = flexContainer({ display: 'flex' }, [
      node({ source_path: 'flow1', tag: 'div', box: box(0, 0, 200, 100) }),
      node({ source_path: 'flow2', tag: 'div', box: box(210, 0, 200, 100) }),
      node({
        source_path: 'badge',
        tag: 'span',
        box: box(180, -10, 40, 40),
        computed: { position: 'absolute' },
      }),
    ]);
    const intent = inferFlex(c);
    expect(intent?.absolute_children).toEqual(['badge']);
    expect(intent?.fill_children).toEqual([]);
  });

  it('position:fixed also counts as absolute_children', () => {
    const c = flexContainer({ display: 'flex' }, [
      node({ source_path: 'flow', tag: 'div', box: box(0, 0, 200, 100) }),
      node({
        source_path: 'pin',
        tag: 'div',
        box: box(0, 0, 40, 40),
        computed: { position: 'fixed' },
      }),
    ]);
    expect(inferFlex(c)?.absolute_children).toEqual(['pin']);
  });
});

/* ─────────────────────────── conservative grid classification ───────────────────────────────── */

describe('flex-inference: conservative grid (isTrueGrid)', () => {
  it('a single row of children is NOT a true grid (1D → flex)', () => {
    const c = flexContainer({ display: 'flex' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 100) }),
      node({ source_path: 'b', tag: 'div', box: box(110, 0, 100, 100) }),
      node({ source_path: 'd', tag: 'div', box: box(220, 0, 100, 100) }),
    ]);
    expect(isTrueGrid(c)).toBe(false);
  });

  it('a single column of children is NOT a true grid (1D → flex)', () => {
    const c = flexContainer({ display: 'flex' }, [
      node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 100) }),
      node({ source_path: 'b', tag: 'div', box: box(0, 110, 100, 100) }),
    ]);
    expect(isTrueGrid(c)).toBe(false);
  });

  it('a true 2x2 grid of aligned cells IS a true grid', () => {
    const c = flexContainer({ display: 'grid' }, [
      node({ source_path: 'r1c1', tag: 'div', box: box(0, 0, 100, 100) }),
      node({ source_path: 'r1c2', tag: 'div', box: box(110, 0, 100, 100) }),
      node({ source_path: 'r2c1', tag: 'div', box: box(0, 110, 100, 100) }),
      node({ source_path: 'r2c2', tag: 'div', box: box(110, 110, 100, 100) }),
    ]);
    expect(isTrueGrid(c)).toBe(true);
  });

  it('explicit grid-template-columns + rows with >1 track each is a true grid', () => {
    const c = node({
      source_path: 'g',
      tag: 'div',
      computed: {
        display: 'grid',
        'grid-template-columns': '1fr 1fr 1fr',
        'grid-template-rows': '200px 200px',
      },
      children: [node({ source_path: 'cell', tag: 'div', box: box(0, 0, 100, 100) })],
    });
    expect(isTrueGrid(c)).toBe(true);
  });

  it('explicit grid with multiple columns + enough children to wrap is a true grid', () => {
    const c = node({
      source_path: 'g',
      tag: 'div',
      computed: { display: 'grid', 'grid-template-columns': 'repeat(3, 1fr)' },
      children: [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 100) }),
        node({ source_path: 'b', tag: 'div', box: box(110, 0, 100, 100) }),
        node({ source_path: 'd', tag: 'div', box: box(220, 0, 100, 100) }),
        node({ source_path: 'e', tag: 'div', box: box(0, 110, 100, 100) }),
      ],
    });
    expect(isTrueGrid(c)).toBe(true);
  });

  it('display:grid with a single column track is NOT a true grid', () => {
    const c = node({
      source_path: 'g',
      tag: 'div',
      computed: { display: 'grid', 'grid-template-columns': '1fr' },
      children: [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 100) }),
        node({ source_path: 'b', tag: 'div', box: box(0, 110, 100, 100) }),
      ],
    });
    expect(isTrueGrid(c)).toBe(false);
  });
});

/* ─────────────────────────── non-containers → null ──────────────────────────────────────────── */

describe('flex-inference: non-containers return null', () => {
  it('a childless leaf returns null', () => {
    expect(inferFlex(node({ source_path: 'leaf', tag: 'p' }))).toBeNull();
  });

  it('a single styleless wrapper (one in-flow child, no explicit flex) returns null', () => {
    const c = node({
      source_path: 'wrap',
      tag: 'div',
      computed: { display: 'block' },
      children: [node({ source_path: 'only', tag: 'p', box: box(0, 0, 100, 20) })],
    });
    expect(inferFlex(c)).toBeNull();
  });

  it('a single child that is explicit flex still infers (display wins over child count)', () => {
    const c = node({
      source_path: 'wrap',
      tag: 'div',
      computed: { display: 'flex' },
      children: [node({ source_path: 'only', tag: 'p', box: box(0, 0, 100, 20) })],
    });
    expect(inferFlex(c)).not.toBeNull();
  });

  it('a block with an absolutely-positioned child is a container (records it)', () => {
    const c = node({
      source_path: 'hero',
      tag: 'section',
      computed: { display: 'block', position: 'relative' },
      children: [
        node({
          source_path: 'badge',
          tag: 'span',
          box: box(10, 10, 40, 40),
          computed: { position: 'absolute' },
        }),
      ],
    });
    const intent = inferFlex(c);
    expect(intent).not.toBeNull();
    expect(intent?.absolute_children).toEqual(['badge']);
  });
});

/* ─────────────────────────── determinism ────────────────────────────────────────────────────── */

describe('flex-inference: determinism', () => {
  it('same input → identical output', () => {
    const c = flexContainer({ display: 'flex', 'justify-content': 'center', gap: '8px' }, [
      node({
        source_path: 'a',
        tag: 'div',
        box: box(0, 0, 100, 50),
        computed: { 'flex-grow': '1' },
      }),
      node({
        source_path: 'b',
        tag: 'div',
        box: box(110, 0, 100, 50),
        computed: { position: 'absolute' },
      }),
    ]);
    expect(inferFlex(c)).toEqual(inferFlex(c));
  });
});
