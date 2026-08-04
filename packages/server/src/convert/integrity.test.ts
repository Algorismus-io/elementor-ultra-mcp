/**
 * Contract 17 §1 — INTEGRITY INVARIANT unit tests (I1–I4 + `runIntegrity`).
 *
 * Pure, no I/O, no browser: every fixture is a hand-built wire-ready `ElementNode[]` forest (the
 * exact shape ASSEMBLE/HOIST emit) plus hand-built tier ledgers. Includes a fixture reproducing the
 * page-1704 dangling-ref shape (12 `settings.classes` ids whose style definitions were dropped →
 * zero-size icons + deterministic CSS_PRIME_FAILED) — the bug class I1 exists to kill.
 */

import { describe, expect, it } from 'vitest';

import type { StyleState, TypedValue } from '../authoring/contract.js';
import { classesValue } from '../authoring/envelopes.js';
import {
  BASE_DEFAULTS,
  auditI4,
  checkI1,
  checkI2,
  checkI3,
  isComputedDefaultNoise,
  runIntegrity,
} from './integrity.js';
import type {
  AccountingLedger,
  BaseDefaultsTable,
  I1Violation,
  I2Violation,
  SourceComputedMap,
} from './integrity.js';
import type {
  BreakpointKey,
  DeclFallback,
  ElementNode,
  StyleDefinition,
  StyleVariant,
} from './types.js';

/* ─────────────────────────── builders ────────────────────────────────────────────────────────── */

/** A throwaway typed envelope — the invariants only read prop KEYS, never values. */
function tv(type = 'size'): TypedValue {
  return { $$type: type, value: type };
}

/** Build one style variant carrying the given prop keys (base variant by default). */
function variant(
  propKeys: string[],
  meta: { breakpoint?: BreakpointKey; state?: StyleState } = {},
  customCssRaw?: string,
): StyleVariant {
  const props: Record<string, TypedValue> = {};
  for (const key of propKeys) {
    props[key] = tv();
  }
  const built: StyleVariant = {
    meta: { breakpoint: meta.breakpoint ?? null, state: meta.state ?? null },
    props,
  };
  if (customCssRaw !== undefined) {
    built.custom_css = { raw: customCssRaw };
  }
  return built;
}

function styleDef(id: string, variants: StyleVariant[]): StyleDefinition {
  return { id, type: 'class', label: id, variants };
}

interface NodeOpts {
  classes?: string[];
  styles?: StyleDefinition[];
  children?: ElementNode[];
}

function stylesMapOf(defs: StyleDefinition[] | undefined): Record<string, StyleDefinition> {
  const map: Record<string, StyleDefinition> = {};
  for (const def of defs ?? []) {
    map[def.id] = def;
  }
  return map;
}

/** An atomic container node (`e-div-block` by default). */
function container(
  id: string,
  opts: NodeOpts & { elType?: 'e-div-block' | 'e-flexbox' } = {},
): ElementNode {
  return {
    id,
    elType: opts.elType ?? 'e-div-block',
    settings: { classes: classesValue(opts.classes ?? []) },
    styles: stylesMapOf(opts.styles),
    elements: opts.children ?? [],
  };
}

/** An atomic widget node (`elType:'widget'` + `widgetType:'e-*'`). */
function widget(
  id: string,
  widgetType: 'e-button' | 'e-svg' | 'e-heading',
  opts: NodeOpts = {},
): ElementNode {
  return {
    id,
    elType: 'widget',
    widgetType,
    settings: { classes: classesValue(opts.classes ?? []) },
    styles: stylesMapOf(opts.styles),
    elements: [],
  };
}

/** A classic V3 node — flat settings, no typed `classes` envelope, no styles map. */
function classic(id: string): ElementNode {
  return { id, elType: 'widget', widgetType: 'html', settings: { html: '<b>x</b>' }, elements: [] };
}

function fallback(
  declaration: string,
  tier: DeclFallback['tier'] = 'custom_css',
  source_path = 'body>div:0',
): DeclFallback {
  return { source_path, declaration, tier, reason: 'test placement' };
}

function balancedLedger(overrides: Partial<AccountingLedger> = {}): AccountingLedger {
  return {
    detected_declarations: 3,
    inline_fold_effects: 0,
    native_count: 2,
    declaration_fallbacks: [fallback('letter-spacing: 0.2em')],
    ...overrides,
  };
}

/**
 * The page-1704 dangling-ref shape: six converted icon-card wrappers whose TWO minted wrapper
 * style ids each survived in `settings.classes` but were dropped from the styles map (12 dangling
 * refs total → zero-size icons + CSS_PRIME_FAILED on the live page). Each wrapped `e-svg` keeps its
 * own intact, §5.1-mirrored local style — only the wrappers are broken.
 */
function page1704Fixture(): { elements: ElementNode[]; danglingIds: string[] } {
  const cards: ElementNode[] = [];
  const danglingIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const wrapperId = `w${String(i)}ab12cd`;
    const svgId = `s${String(i)}ef34ab`;
    const dropped = [`e-${wrapperId}-bbbbbb${String(i)}`, `e-${wrapperId}-cccccc${String(i)}`];
    danglingIds.push(...dropped);
    const svgStyle = styleDef(`e-${svgId}-aaaaaa${String(i)}`, [variant(['width', 'height'])]);
    cards.push(
      container(wrapperId, {
        classes: dropped, // minted, referenced — but their definitions were dropped
        children: [widget(svgId, 'e-svg', { classes: [svgStyle.id], styles: [svgStyle] })],
      }),
    );
  }
  return { elements: [container('root0001', { children: cards })], danglingIds };
}

/* ─────────────────────────── I1 — reference closure ──────────────────────────────────────────── */

describe('checkI1 — reference closure (both directions)', () => {
  it('passes a clean tree: mirrored local styles + resolvable global refs', () => {
    const local = styleDef('e-aaa1111-1234567', [variant(['padding'])]);
    const tree = [
      container('aaa1111', {
        classes: ['g-12345', local.id],
        styles: [local],
        children: [widget('bbb2222', 'e-heading', { classes: ['g-12345'] })],
      }),
    ];
    expect(checkI1(tree, ['g-12345'])).toEqual([]);
  });

  it('flags a classes id that resolves nowhere as dangling_ref', () => {
    const tree = [container('aaa1111', { classes: ['e-aaa1111-dead123'] })];
    const violations = checkI1(tree, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'I1',
      nodeId: 'aaa1111',
      styleId: 'e-aaa1111-dead123',
      direction: 'dangling_ref',
    });
  });

  it('does NOT flag a global-class reference covered by globalClassIds', () => {
    const tree = [container('aaa1111', { classes: ['g-77777'] })];
    expect(checkI1(tree, ['g-77777'])).toEqual([]);
  });

  it('flags a styles-map entry absent from the same node classes as orphaned_style', () => {
    const orphan = styleDef('e-aaa1111-7654321', [variant(['color'])]);
    const tree = [container('aaa1111', { classes: [], styles: [orphan] })];
    const violations = checkI1(tree, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'I1',
      nodeId: 'aaa1111',
      styleId: orphan.id,
      direction: 'orphaned_style',
    });
  });

  it('resolves a cross-node local ref (direction one) but still requires the §5.1 same-node mirror', () => {
    const shared = styleDef('e-aaa1111-1234567', [variant(['gap'])]);
    // Node A defines + mirrors; node B references A's local style.
    const tree = [
      container('aaa1111', { classes: [shared.id], styles: [shared] }),
      container('bbb2222', { classes: [shared.id] }),
    ];
    expect(checkI1(tree, [])).toEqual([]);
  });

  it('reports BOTH directions on the same node when ref and mirror are broken together', () => {
    const unmirrored = styleDef('e-ccc3333-1111111', [variant(['color'])]);
    const tree = [container('ccc3333', { classes: ['e-ccc3333-2222222'], styles: [unmirrored] })];
    const violations = checkI1(tree, []);
    const directions = violations.map((v) => v.direction).sort();
    expect(directions).toEqual(['dangling_ref', 'orphaned_style']);
  });

  it('walks nested children (a deep dangling ref is found)', () => {
    const tree = [
      container('top0001', {
        children: [
          container('mid0002', {
            children: [widget('leaf003', 'e-svg', { classes: ['e-leaf003-baddead'] })],
          }),
        ],
      }),
    ];
    const violations = checkI1(tree, []);
    expect(violations).toHaveLength(1);
    expect((violations[0] as I1Violation).nodeId).toBe('leaf003');
  });

  it('skips classic V3 nodes (flat settings, no typed classes envelope)', () => {
    expect(checkI1([classic('cls0001')], [])).toEqual([]);
  });

  it('ignores malformed classes envelopes and non-string members instead of throwing', () => {
    const tree: ElementNode[] = [
      {
        id: 'odd0001',
        elType: 'e-div-block',
        // malformed: classes is a bare array, not a typed envelope — node opts out of closure
        settings: { classes: ['e-odd0001-1234567'] as unknown as TypedValue },
        elements: [],
      },
      {
        id: 'odd0002',
        elType: 'e-div-block',
        settings: {
          classes: { $$type: 'classes', value: ['g-1', 42, null] },
        },
        elements: [],
      },
    ];
    const violations = checkI1(tree, ['g-1']);
    expect(violations).toEqual([]);
  });

  it('reproduces page 1704: 12 dangling wrapper refs, every one reported, svg styles stay clean', () => {
    const { elements, danglingIds } = page1704Fixture();
    const violations = checkI1(elements, []);
    expect(violations).toHaveLength(12);
    expect(violations.every((v) => v.direction === 'dangling_ref')).toBe(true);
    expect(violations.map((v) => v.styleId).sort()).toEqual([...danglingIds].sort());
  });
});

/* ─────────────────────────── I2 — base-default safety ────────────────────────────────────────── */

const BLUE = 'rgb(55, 94, 251)';

function buttonSource(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'background-color': BLUE,
    'padding-top': '12px',
    'padding-right': '24px',
    'padding-bottom': '12px',
    'padding-left': '24px',
    'border-top-left-radius': '2px',
    'border-top-right-radius': '2px',
    'border-bottom-right-radius': '2px',
    'border-bottom-left-radius': '2px',
    'text-align': 'center',
    ...overrides,
  };
}

describe('BASE_DEFAULTS — the painting-base table', () => {
  it('pins the e-button base: blue fill, 12/24 padding, 2px radius x4, centered text', () => {
    const rules = BASE_DEFAULTS['e-button'] ?? [];
    const byProp = new Map(rules.map((r) => [r.source_prop, r.base_default]));
    expect(byProp.get('background-color')).toBe(BLUE);
    expect(byProp.get('padding-top')).toBe('12px');
    expect(byProp.get('padding-bottom')).toBe('12px');
    expect(byProp.get('padding-left')).toBe('24px');
    expect(byProp.get('padding-right')).toBe('24px');
    expect(byProp.get('border-top-left-radius')).toBe('2px');
    expect(byProp.get('border-top-right-radius')).toBe('2px');
    expect(byProp.get('border-bottom-right-radius')).toBe('2px');
    expect(byProp.get('border-bottom-left-radius')).toBe('2px');
    expect(byProp.get('text-align')).toBe('center');
  });

  it('pins e-flexbox (10px padding + column), e-div-block (10px padding), e-svg (50x50)', () => {
    const flex = new Map(
      (BASE_DEFAULTS['e-flexbox'] ?? []).map((r) => [r.source_prop, r.base_default]),
    );
    expect(flex.get('padding-top')).toBe('10px');
    expect(flex.get('padding-left')).toBe('10px');
    expect(flex.get('flex-direction')).toBe('column');

    const div = new Map(
      (BASE_DEFAULTS['e-div-block'] ?? []).map((r) => [r.source_prop, r.base_default]),
    );
    expect(div.get('padding-top')).toBe('10px');
    expect(div.get('padding-right')).toBe('10px');
    expect(div.get('padding-bottom')).toBe('10px');
    expect(div.get('padding-left')).toBe('10px');

    const svg = new Map((BASE_DEFAULTS['e-svg'] ?? []).map((r) => [r.source_prop, r.base_default]));
    expect(svg.get('width')).toBe('50px');
    expect(svg.get('height')).toBe('50px');
  });
});

describe('checkI2 — base-default safety', () => {
  it('flags the ghost button: transparent source background, no explicit background emitted', () => {
    const tree = [widget('btn0001', 'e-button')];
    const source: SourceComputedMap = {
      btn0001: buttonSource({ 'background-color': 'rgba(0, 0, 0, 0)' }),
    };
    const violations = checkI2(tree, source);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'I2',
      nodeId: 'btn0001',
      widget: 'e-button',
      prop: 'background-color',
      source_value: 'rgba(0, 0, 0, 0)',
      base_default: BLUE,
    });
  });

  it('passes when the differing prop IS explicitly emitted in a base variant', () => {
    const style = styleDef('e-btn0001-1234567', [variant(['background'])]);
    const tree = [widget('btn0001', 'e-button', { classes: [style.id], styles: [style] })];
    const source: SourceComputedMap = {
      btn0001: buttonSource({ 'background-color': 'rgba(0, 0, 0, 0)' }),
    };
    expect(checkI2(tree, source)).toEqual([]);
  });

  it('requires nothing when the source equals the base default (the base legitimately paints)', () => {
    const tree = [widget('btn0001', 'e-button')];
    expect(checkI2(tree, { btn0001: buttonSource() })).toEqual([]);
  });

  it('normalizes values: spacing inside rgb() and bare-0 vs 0px never produce false diffs', () => {
    const tree = [widget('btn0001', 'e-button'), container('box0001', { elType: 'e-flexbox' })];
    const source: SourceComputedMap = {
      btn0001: buttonSource({ 'background-color': 'RGB(55,94,251)' }),
      box0001: {
        'padding-top': '10px',
        'padding-right': '10px',
        'padding-bottom': '10px',
        'padding-left': '10px',
        'flex-direction': 'column',
      },
    };
    expect(checkI2(tree, source)).toEqual([]);
    // and a real zero diff still fires: source 0 (bare) vs 10px base
    const zeroPad = checkI2(tree, {
      box0001: { 'padding-top': '0' },
    });
    expect(zeroPad).toHaveLength(1);
    expect((zeroPad[0] as I2Violation).prop).toBe('padding-top');
  });

  it('a hover-only or mobile-only emission does NOT satisfy the base (desktop still paints default)', () => {
    const hoverOnly = styleDef('e-btn0001-1234567', [variant(['background'], { state: 'hover' })]);
    const mobileOnly = styleDef('e-btn0002-1234567', [
      variant(['background'], { breakpoint: 'mobile' }),
    ]);
    const tree = [
      widget('btn0001', 'e-button', { classes: [hoverOnly.id], styles: [hoverOnly] }),
      widget('btn0002', 'e-button', { classes: [mobileOnly.id], styles: [mobileOnly] }),
    ];
    const ghost = { 'background-color': 'rgba(0, 0, 0, 0)' };
    const violations = checkI2(tree, { btn0001: ghost, btn0002: ghost });
    expect(violations.map((v) => v.nodeId).sort()).toEqual(['btn0001', 'btn0002']);
  });

  it("an explicit 'desktop' breakpoint variant counts as base", () => {
    const desktop = styleDef('e-btn0001-1234567', [
      variant(['background'], { breakpoint: 'desktop' }),
    ]);
    const tree = [widget('btn0001', 'e-button', { classes: [desktop.id], styles: [desktop] })];
    expect(checkI2(tree, { btn0001: { 'background-color': 'rgba(0, 0, 0, 0)' } })).toEqual([]);
  });

  it('a referenced global class definition satisfies the rule when supplied', () => {
    const globalDef = styleDef('g-cards-1', [variant(['padding'])]);
    const tree = [container('box0001', { elType: 'e-flexbox', classes: ['g-cards-1'] })];
    const source: SourceComputedMap = { box0001: { 'padding-top': '0px' } };
    // without defs: violation (the check cannot see inside the global class)
    expect(checkI2(tree, source).length).toBe(1);
    // with defs: satisfied
    expect(checkI2(tree, source, BASE_DEFAULTS, { 'g-cards-1': globalDef })).toEqual([]);
  });

  it('a base-variant custom_css emission (base64) satisfies the rule', () => {
    const raw = Buffer.from('padding: 0;', 'utf8').toString('base64');
    const style = styleDef('e-box0001-1234567', [variant([], {}, raw)]);
    const tree = [container('box0001', { classes: [style.id], styles: [style] })];
    expect(checkI2(tree, { box0001: { 'padding-top': '0px' } })).toEqual([]);
  });

  it('flags an e-svg whose source size differs from 50x50 with no width/height/size emitted', () => {
    const tree = [widget('svg0001', 'e-svg')];
    const violations = checkI2(tree, { svg0001: { width: '24px', height: '24px' } });
    expect(violations.map((v) => v.prop).sort()).toEqual(['height', 'width']);
    // a 'size' prop satisfies both
    const sized = styleDef('e-svg0002-1234567', [variant(['size'])]);
    const okTree = [widget('svg0002', 'e-svg', { classes: [sized.id], styles: [sized] })];
    expect(checkI2(okTree, { svg0002: { width: '24px', height: '24px' } })).toEqual([]);
  });

  it('flags an e-flexbox whose source is row-direction with no flex-direction emitted', () => {
    const tree = [container('box0001', { elType: 'e-flexbox' })];
    const violations = checkI2(tree, { box0001: { 'flex-direction': 'row' } });
    expect(violations).toHaveLength(1);
    expect((violations[0] as I2Violation).prop).toBe('flex-direction');
  });

  it('skips nodes absent from the source map and props absent from the node entry', () => {
    const tree = [widget('btn0001', 'e-button'), widget('btn0002', 'e-button')];
    // btn0001 has no source entry; btn0002 only surfaces text-align (equal to base)
    expect(checkI2(tree, { btn0002: { 'text-align': 'center' } })).toEqual([]);
  });

  it('skips classic nodes and unmapped widget types', () => {
    const tree = [classic('cls0001'), widget('hd00001', 'e-heading')];
    expect(
      checkI2(tree, {
        cls0001: { 'padding-top': '0px' },
        hd00001: { 'padding-top': '0px' },
      }),
    ).toEqual([]);
  });

  it('respects a caller-supplied base-defaults table', () => {
    const table: BaseDefaultsTable = {
      'e-heading': [
        { source_prop: 'color', base_default: 'rgb(0, 0, 0)', satisfied_by: ['color'] },
      ],
    };
    const tree = [widget('hd00001', 'e-heading')];
    const violations = checkI2(tree, { hd00001: { color: 'rgb(255, 0, 0)' } }, table);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ widget: 'e-heading', prop: 'color' });
  });
});

/* ─────────────────────────── I3 — total accounting ───────────────────────────────────────────── */

describe('checkI3 — total accounting', () => {
  it('passes a balanced ledger (detected + folds == native + fallback rows)', () => {
    expect(checkI3(balancedLedger())).toEqual([]);
  });

  it('counts inline-fold side effects on the detected side', () => {
    // 3 detected + 2 folds = 5; 2 native + 3 fallback rows (incl. the 2 fold drops) = 5.
    const ledger = balancedLedger({
      inline_fold_effects: 2,
      declaration_fallbacks: [
        fallback('letter-spacing: 0.2em'),
        fallback('color: rgb(16, 185, 129)', 'html_widget', 'body>p:0>em:0'),
        fallback('font-style: italic', 'html_widget', 'body>p:0>em:0'),
      ],
    });
    expect(checkI3(ledger)).toEqual([]);
  });

  it('counts pseudo-element drops on the detected side (#10 — honest drops carry tier rows)', () => {
    // 3 detected + 1 pseudo drop = 4; 2 native + 2 fallback rows (incl. the drop row) = 4.
    const ledger = balancedLedger({
      pseudo_drop_effects: 1,
      declaration_fallbacks: [
        fallback('letter-spacing: 0.2em'),
        fallback('content: "→"', 'html_widget', 'body>div:0::pseudo-after'),
      ],
    });
    expect(checkI3(ledger)).toEqual([]);
  });

  it('flags a pseudo drop that never landed as a ledger row (the #10 silent-drop class)', () => {
    const violations = checkI3(balancedLedger({ pseudo_drop_effects: 1 }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 'I3', expected: 4, actual: 3 });
    expect(violations[0]?.detail).toContain('1 pseudo-element drops');
    expect(violations[0]?.detail).toContain('silently lost');
  });

  it('flags silent loss: detected entries that never received a tier', () => {
    const ledger = balancedLedger({ detected_declarations: 5 });
    const violations = checkI3(ledger);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 'I3', expected: 5, actual: 3 });
    expect(violations[0]?.detail).toContain('silently lost');
  });

  it('flags fabrication: more tier entries than detected work', () => {
    const ledger = balancedLedger({
      declaration_fallbacks: [fallback('a: b'), fallback('c: d'), fallback('e: f')],
    });
    const violations = checkI3(ledger);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ expected: 3, actual: 5 });
    expect(violations[0]?.detail).toContain('fabricated');
  });

  it('passes the degenerate all-zero ledger', () => {
    expect(
      checkI3({
        detected_declarations: 0,
        inline_fold_effects: 0,
        native_count: 0,
        declaration_fallbacks: [],
      }),
    ).toEqual([]);
  });
});

/* ─────────────────────────── I4 — computed-default noise ─────────────────────────────────────── */

describe('isComputedDefaultNoise — the shared noise predicate', () => {
  it('treats normal/auto/none as noise', () => {
    expect(isComputedDefaultNoise('font-kerning', 'normal')).toBe(true);
    expect(isComputedDefaultNoise('cursor', 'auto')).toBe(true);
    expect(isComputedDefaultNoise('transform', 'none')).toBe(true);
    expect(isComputedDefaultNoise('float', 'NONE')).toBe(true);
  });

  it('treats zero-effect values as noise (single and multi token, any zero unit)', () => {
    expect(isComputedDefaultNoise('margin-top', '0px')).toBe(true);
    expect(isComputedDefaultNoise('margin', '0px 0px 0px 0px')).toBe(true);
    expect(isComputedDefaultNoise('transition-delay', '0s')).toBe(true);
    expect(isComputedDefaultNoise('text-indent', '0')).toBe(true);
  });

  it('keeps the meaningful carve-outs: display/text-decoration none, opacity zero, transparent', () => {
    expect(isComputedDefaultNoise('display', 'none')).toBe(false);
    expect(isComputedDefaultNoise('text-decoration', 'none')).toBe(false);
    expect(isComputedDefaultNoise('text-decoration-line', 'none')).toBe(false);
    expect(isComputedDefaultNoise('opacity', '0')).toBe(false);
    expect(isComputedDefaultNoise('background-color', 'transparent')).toBe(false);
  });

  it('never flags real values', () => {
    expect(isComputedDefaultNoise('color', 'rgb(16, 185, 129)')).toBe(false);
    expect(isComputedDefaultNoise('padding-top', '12px')).toBe(false);
    expect(isComputedDefaultNoise('margin', '0px 16px')).toBe(false);
    expect(isComputedDefaultNoise('font-weight', '700')).toBe(false);
  });
});

describe('auditI4 — post-filter ledger audit', () => {
  it('flags noise rows that survived into the tier ledger', () => {
    const rows = [
      fallback('transform: none'),
      fallback('cursor: auto', 'html_widget', 'body>a:0'),
      fallback('margin: 0px 0px 0px 0px', 'local_style'),
    ];
    const violations = auditI4(rows);
    expect(violations).toHaveLength(3);
    expect(violations[0]).toMatchObject({
      invariant: 'I4',
      source_path: 'body>div:0',
      declaration: 'transform: none',
      tier: 'custom_css',
    });
  });

  it('passes a clean (real-loss-only) ledger', () => {
    const rows = [
      fallback('color: rgb(16, 185, 129)'),
      fallback('display: none'),
      fallback('clip-path: polygon(0 0, 100% 0, 100% 100%)'),
    ];
    expect(auditI4(rows)).toEqual([]);
  });

  it('ignores rows whose declaration is not prop:value shaped', () => {
    expect(auditI4([fallback('whole-node degrade')])).toEqual([]);
  });
});

/* ─────────────────────────── runIntegrity — the pre-save aggregate ───────────────────────────── */

describe('runIntegrity — aggregate + hardFail', () => {
  it('returns no violations and hardFail:false on a fully clean conversion', () => {
    const style = styleDef('e-btn0001-1234567', [variant(['background'])]);
    const result = runIntegrity({
      elements: [widget('btn0001', 'e-button', { classes: [style.id], styles: [style] })],
      global_class_ids: [],
      source_computed: { btn0001: buttonSource({ 'background-color': 'rgba(0, 0, 0, 0)' }) },
      ledger: balancedLedger(),
    });
    expect(result.violations).toEqual([]);
    expect(result.hardFail).toBe(false);
  });

  it('aggregates violations across all four invariants and hard-fails', () => {
    const orphan = styleDef('e-box0001-7654321', [variant(['color'])]);
    const result = runIntegrity({
      // I1: dangling ref + orphaned style; I2: ghost button.
      elements: [
        container('box0001', { classes: ['e-box0001-dead123'], styles: [orphan] }),
        widget('btn0001', 'e-button'),
      ],
      global_class_ids: [],
      source_computed: { btn0001: { 'background-color': 'rgba(0, 0, 0, 0)' } },
      // I3: unbalanced; I4: surviving noise row.
      ledger: balancedLedger({
        detected_declarations: 9,
        declaration_fallbacks: [fallback('transform: none')],
      }),
    });
    const byInvariant = result.violations.map((v) => v.invariant).sort();
    expect(byInvariant).toEqual(['I1', 'I1', 'I2', 'I3', 'I4']);
    expect(result.hardFail).toBe(true);
  });

  it('skips I2 when no source_computed map is supplied (the integrator owns the correspondence)', () => {
    const result = runIntegrity({
      elements: [widget('btn0001', 'e-button')], // would be an I2 ghost-button if judged
      global_class_ids: [],
      ledger: balancedLedger(),
    });
    expect(result.violations).toEqual([]);
    expect(result.hardFail).toBe(false);
  });

  it('skips I3/I4 when no ledger is supplied', () => {
    const result = runIntegrity({
      elements: [container('box0001')],
      global_class_ids: [],
    });
    expect(result.violations).toEqual([]);
    expect(result.hardFail).toBe(false);
  });

  it('a single violation is enough to hard-fail (contract 17 §1: converter bugs never persist)', () => {
    const result = runIntegrity({
      elements: [container('box0001', { classes: ['e-box0001-dead123'] })],
      global_class_ids: [],
    });
    expect(result.violations).toHaveLength(1);
    expect(result.hardFail).toBe(true);
  });

  it('hard-fails the page-1704 fixture with exactly the 12 dangling refs', () => {
    const { elements } = page1704Fixture();
    const result = runIntegrity({ elements, global_class_ids: [] });
    expect(result.violations).toHaveLength(12);
    expect(result.hardFail).toBe(true);
  });
});
