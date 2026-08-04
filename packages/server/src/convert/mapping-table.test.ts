/**
 * WP-H01 — unit + contract tests for the mapping-table reference and the frozen pipeline IR.
 *
 * Covers the acceptance criteria: rule-count + role-coverage; the `mapRole` matrix across
 * atomic/pro/experiment/tab-pairing contexts; `containerTagFor` enum clamping; `NO_ATOMIC_EQUIVALENT`
 * membership; purity (zero Playwright/fs/WP-client imports); the `STYLE_WHITELIST` snapshot; the
 * authoring-contract §4 atomic-type scan + the V3 known-type scan; and a type-level assertion that
 * `types.ts` exports every inter-stage IR / Result envelope (and does not redeclare shared types).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, expectTypeOf } from 'vitest';

import {
  MAPPING_TABLE,
  NESTED_ACCORDION_WIDGET,
  NO_ATOMIC_EQUIVALENT,
  STYLE_WHITELIST,
  accordionItemContainerTarget,
  containerTagFor,
  eTabsFamilyTarget,
  mapRole,
  nestedAccordionTarget,
  type ETabsFamilyMember,
  type MapContext,
  type MappingRule,
} from './mapping-table.js';
import type {
  A11yFinding,
  AssembleResult,
  ClassifyResult,
  CoverageReport,
  FidelityResult,
  HoistResult,
  IrNode,
  MapResult,
  MappingResult,
  NormalizeResult,
  ParseResult,
  SemanticRole,
  StyleExtractResult,
  StyledNode,
  VarResult,
  ElementNode,
  StyleDefinition,
  BreakpointKey,
  Generation,
  SiteCapabilities,
} from './types.js';

/* ─────────────────────────── fixtures / helpers ─────────────────────────────────────────────── */

/** Every `SemanticRole` member except the internal `unknown` (which has no §6.2 row). */
const ROLES_WITH_RULES: SemanticRole[] = [
  'structural-block',
  'flex-row',
  'flex-col',
  'grid',
  'heading',
  'text',
  'image',
  'button',
  'link',
  'divider',
  'icon-svg',
  'media-embed-youtube',
  'media-embed-video',
  'tabs',
  'tab',
  'tab-content',
  'form',
  'form-field',
  'nav-menu',
  'list',
  'list-item',
  'table',
  'accordion',
  'accordion-item',
];

/** The verified atomic element types (`11-authoring-contract.md §4`). No invented types allowed. */
const ATOMIC_TYPES: ReadonlySet<string> = new Set([
  // containers
  'e-div-block',
  'e-flexbox',
  'e-tabs',
  'e-tabs-menu',
  'e-tab',
  'e-tabs-content-area',
  'e-tab-content',
  'e-form',
  'e-form-success-message',
  'e-form-error-message',
  // widgets
  'e-heading',
  'e-paragraph',
  'e-image',
  'e-button',
  'e-svg',
  'e-youtube',
  'e-divider',
  'e-self-hosted-video',
  'e-form-input',
  'e-form-textarea',
  'e-form-checkbox',
  'e-form-radio-button',
  'e-form-select',
  'e-form-date-picker',
  'e-form-time-picker',
  'e-form-file-upload',
  'e-form-label',
  'e-form-submit-button',
]);

/** Non-atomic V4 elTypes a rule may legitimately reference (the generic V3 container). */
const NON_ATOMIC_V4_ELTYPES: ReadonlySet<string> = new Set(['container']);

/** Known V3 classic widget/elTypes the §6.2 table maps to (test contract). */
const KNOWN_V3_WIDGETS: ReadonlySet<string> = new Set([
  'heading',
  'text-editor',
  'image',
  'button',
  'divider',
  'icon',
  'video',
  'tabs',
  'nested-tabs',
  'form',
  'icon-list',
  'nav-menu',
  'accordion',
  'nested-accordion',
  'html',
]);

/** Known V3 classic container elTypes. */
const KNOWN_V3_ELTYPES: ReadonlySet<string> = new Set(['container', 'section', 'column', 'widget']);

const fullCtx = (over: Partial<MapContext> = {}): MapContext => ({
  pro_active: true,
  atomic_active: true,
  child_count: 0,
  has_youtube: false,
  tab_pairing_ok: true,
  ...over,
});

/* ─────────────────────────── MAPPING_TABLE shape / coverage ─────────────────────────────────── */

describe('MAPPING_TABLE', () => {
  it('has a rule for every SemanticRole except internal `unknown`', () => {
    const rolesInTable = new Set(MAPPING_TABLE.map((r) => r.role));
    for (const role of ROLES_WITH_RULES) {
      expect(rolesInTable.has(role), `missing rule for role: ${role}`).toBe(true);
    }
    // `unknown` is resolved by mapRole, not via a table row.
    expect(rolesInTable.has('unknown')).toBe(false);
  });

  it('covers every RESEARCH §6.2 row + the SUPPLEMENT §C.4 accordion row (24 rules)', () => {
    expect(MAPPING_TABLE.length).toBe(ROLES_WITH_RULES.length);
    expect(MAPPING_TABLE.length).toBe(24);
  });

  it('references no atomic type outside the authoring-contract §4 list', () => {
    for (const rule of MAPPING_TABLE) {
      // V4 elType: either an atomic type, an atomic widget container marker (`widget`), or a
      // sanctioned non-atomic structural elType (`container`).
      if (rule.v4.elType === 'widget') {
        // widgetType MUST be an atomic widget type.
        expect(rule.v4.widgetType, `rule ${rule.role} widget missing widgetType`).toBeDefined();
        expect(
          ATOMIC_TYPES.has(rule.v4.widgetType as string),
          `rule ${rule.role} references non-atomic widgetType ${rule.v4.widgetType}`,
        ).toBe(true);
      } else {
        expect(
          ATOMIC_TYPES.has(rule.v4.elType) || NON_ATOMIC_V4_ELTYPES.has(rule.v4.elType),
          `rule ${rule.role} references unknown v4 elType ${rule.v4.elType}`,
        ).toBe(true);
      }
    }
  });

  it('maps every V3 fallback to a known classic type', () => {
    for (const rule of MAPPING_TABLE) {
      expect(
        KNOWN_V3_ELTYPES.has(rule.v3.elType),
        `rule ${rule.role} v3 elType ${rule.v3.elType} unknown`,
      ).toBe(true);
      if (rule.v3.widgetType !== undefined) {
        expect(
          KNOWN_V3_WIDGETS.has(rule.v3.widgetType),
          `rule ${rule.role} v3 widgetType ${rule.v3.widgetType} unknown`,
        ).toBe(true);
      }
    }
  });

  it('every rule has a non-empty notes string', () => {
    for (const rule of MAPPING_TABLE) {
      expect(rule.notes.length, `rule ${rule.role} has empty notes`).toBeGreaterThan(0);
    }
  });
});

/* ─────────────────────────── mapRole matrix ─────────────────────────────────────────────────── */

describe('mapRole', () => {
  it('heading → e-heading when atomic, heading when classic', () => {
    expect(mapRole('heading', fullCtx())).toMatchObject({
      elType: 'widget',
      widgetType: 'e-heading',
    });
    expect(mapRole('heading', fullCtx({ atomic_active: false }))).toMatchObject({
      elType: 'widget',
      widgetType: 'heading',
    });
  });

  it('nav-menu without Pro → e-div-block list, never the Pro nav-menu widget', () => {
    const res = mapRole('nav-menu', fullCtx({ pro_active: false }));
    expect(res.elType).toBe('e-div-block');
    expect(res.is_container).toBe(true);
    expect(res.widgetType).toBeUndefined();
  });

  it('nav-menu WITH Pro → still the e-div-block container path (bound widget filled by ASSEMBLE)', () => {
    const res = mapRole('nav-menu', fullCtx({ pro_active: true }));
    expect(res.elType).toBe('e-div-block');
  });

  it('form without Pro/experiment → fallback, never an e-form tree', () => {
    const res = mapRole('form', fullCtx({ pro_active: false }));
    expect(res.elType).not.toBe('e-form');
    // atomic inactive likewise never yields e-form
    const classic = mapRole('form', fullCtx({ atomic_active: false }));
    expect(classic.elType).not.toBe('e-form');
    expect(classic.widgetType).toBe('form');
  });

  it('form WITH Pro (+ experiment via Pro) → e-form', () => {
    expect(mapRole('form', fullCtx({ pro_active: true })).elType).toBe('e-form');
  });

  it('tabs with unpaired menu/content → structural e-div-block, not e-tabs', () => {
    const res = mapRole('tabs', fullCtx({ tab_pairing_ok: false }));
    expect(res.elType).toBe('e-div-block');
    expect(res.elType).not.toBe('e-tabs');
  });

  it('tabs with paired menu/content → e-tabs', () => {
    expect(mapRole('tabs', fullCtx({ tab_pairing_ok: true })).elType).toBe('e-tabs');
  });

  it('unknown → generic e-div-block (atomic) / container (classic); never throws', () => {
    expect(mapRole('unknown', fullCtx()).elType).toBe('e-div-block');
    expect(mapRole('unknown', fullCtx({ atomic_active: false })).elType).toBe('container');
  });

  it('atomic_active:false returns the V3 fallback for every role', () => {
    for (const role of ROLES_WITH_RULES) {
      const rule = MAPPING_TABLE.find((r) => r.role === role) as MappingRule;
      const res = mapRole(role, fullCtx({ atomic_active: false }));
      expect(res.elType, `role ${role}`).toBe(rule.v3.elType);
      if (rule.v3.widgetType !== undefined) {
        expect(res.widgetType, `role ${role}`).toBe(rule.v3.widgetType);
      }
    }
  });

  it('never throws for any role × context combination', () => {
    const ctxs: MapContext[] = [
      fullCtx(),
      fullCtx({ atomic_active: false }),
      fullCtx({ pro_active: false }),
      fullCtx({ tab_pairing_ok: false }),
      fullCtx({ atomic_active: false, pro_active: false, tab_pairing_ok: false }),
    ];
    const allRoles: SemanticRole[] = [...ROLES_WITH_RULES, 'unknown'];
    for (const role of allRoles) {
      for (const ctx of ctxs) {
        expect(() => mapRole(role, ctx)).not.toThrow();
      }
    }
  });

  it('container results carry a `tag` clamped to the div-block enum', () => {
    const res = mapRole('structural-block', fullCtx(), 'header');
    expect(res.tag).toBe('header');
    expect(res.settings_seed).toMatchObject({ tag: 'header' });
    // out-of-enum source tag clamps to div
    expect(mapRole('structural-block', fullCtx(), 'main').tag).toBe('div');
  });

  it('every result is the frozen MappingResult shape (generation v4, has v3_fallback)', () => {
    for (const role of [...ROLES_WITH_RULES, 'unknown'] as SemanticRole[]) {
      const res: MappingResult = mapRole(role, fullCtx());
      expect(res.generation).toBe('v4');
      expect(res.v3_fallback).toBeDefined();
      expect(typeof res.is_container).toBe('boolean');
    }
  });
});

/* ─────────────────────────── containerTagFor ────────────────────────────────────────────────── */

describe('containerTagFor', () => {
  it('passes through valid enum members (case-insensitive)', () => {
    for (const tag of ['div', 'header', 'section', 'article', 'aside', 'footer', 'a', 'button']) {
      expect(containerTagFor('structural-block', tag)).toBe(tag);
      expect(containerTagFor('structural-block', tag.toUpperCase())).toBe(tag);
    }
  });

  it('clamps unknown / non-enum tags to `div`', () => {
    for (const tag of ['main', 'nav', 'span', 'ul', 'li', 'details', 'summary', '']) {
      expect(containerTagFor('structural-block', tag)).toBe('div');
    }
  });
});

/* ─────────────────────────── NO_ATOMIC_EQUIVALENT ───────────────────────────────────────────── */

describe('NO_ATOMIC_EQUIVALENT', () => {
  it('contains exactly the roles with no native atomic widget', () => {
    expect(NO_ATOMIC_EQUIVALENT.has('list')).toBe(true);
    expect(NO_ATOMIC_EQUIVALENT.has('table')).toBe(true);
    expect(NO_ATOMIC_EQUIVALENT.has('accordion')).toBe(true);
    expect(NO_ATOMIC_EQUIVALENT.has('accordion-item')).toBe(true);
    // roles WITH an atomic widget are not members
    expect(NO_ATOMIC_EQUIVALENT.has('heading')).toBe(false);
    expect(NO_ATOMIC_EQUIVALENT.has('tabs')).toBe(false);
  });
});

/* ─────────────────────────── Tier-1 behavior targets (contract 16 §3) ───────────────────────── */

describe('tier-1 behavior targets (contract 16 §3)', () => {
  const FAMILY: ETabsFamilyMember[] = [
    'e-tabs',
    'e-tabs-menu',
    'e-tab',
    'e-tabs-content-area',
    'e-tab-content',
  ];

  it('eTabsFamilyTarget: every member is a CONTAINER whose elType is the e-* type itself', () => {
    for (const member of FAMILY) {
      const t = eTabsFamilyTarget(member);
      expect(t.elType).toBe(member);
      expect(t.is_container).toBe(true);
      expect(t.widgetType).toBeUndefined();
      expect(t.generation).toBe('v4');
      // no `tag` seed — the family has no tag prop (recon: common props only + member extras)
      expect(t.settings_seed).toEqual({});
    }
  });

  it('eTabsFamilyTarget: V3 fallback is nested-tabs at the root, container for inner members', () => {
    expect(eTabsFamilyTarget('e-tabs').v3_fallback).toEqual({
      elType: 'widget',
      widgetType: 'nested-tabs',
    });
    for (const member of FAMILY.filter((m) => m !== 'e-tabs')) {
      expect(eTabsFamilyTarget(member).v3_fallback).toEqual({ elType: 'container' });
    }
  });

  it('nestedAccordionTarget: classic widget (NOT an e-* atomic type) in both generations', () => {
    const t = nestedAccordionTarget();
    expect(t.elType).toBe('widget');
    expect(t.widgetType).toBe(NESTED_ACCORDION_WIDGET);
    expect(t.widgetType?.startsWith('e-')).toBe(false);
    expect(t.is_container).toBe(false);
    expect(t.v3_fallback).toEqual({ elType: 'widget', widgetType: 'nested-accordion' });
  });

  it('accordionItemContainerTarget: classic container child (upstream item shape)', () => {
    const t = accordionItemContainerTarget();
    expect(t.elType).toBe('container');
    expect(t.is_container).toBe(true);
    expect(t.v3_fallback).toEqual({ elType: 'container' });
  });
});

/* ─────────────────────────── STYLE_WHITELIST snapshot ───────────────────────────────────────── */

describe('STYLE_WHITELIST', () => {
  it('includes every property required by Detailed Requirement 4', () => {
    const required = [
      'display',
      'flex-direction',
      'flex-wrap',
      'flex-grow',
      'flex-shrink',
      'flex-basis',
      'gap',
      'row-gap',
      'column-gap',
      'justify-content',
      'align-items',
      'align-self',
      'align-content',
      'justify-items',
      'order',
      'grid-template-columns',
      'grid-template-rows',
      'grid-auto-flow',
      'grid-column',
      'grid-row',
      'width',
      'height',
      'min-width',
      'max-width',
      'min-height',
      'max-height',
      'aspect-ratio',
      'object-fit',
      'object-position',
      'overflow',
      'position',
      'top',
      'right',
      'bottom',
      'left',
      'z-index',
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
      'font-family',
      'font-size',
      'font-weight',
      'font-style',
      'line-height',
      'letter-spacing',
      'word-spacing',
      'color',
      'text-align',
      'text-decoration',
      'text-transform',
      'direction',
      'background-color',
      'background-image',
      'background-size',
      'background-position',
      'background-repeat',
      'background-attachment',
      'background-clip',
      'border-top-width',
      'border-right-width',
      'border-bottom-width',
      'border-left-width',
      'border-top-style',
      'border-color',
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
      'box-shadow',
      'opacity',
      'mix-blend-mode',
      'filter',
      'backdrop-filter',
      'transform',
      'transition',
      'outline-width',
      'outline-style',
      'outline-color',
      'cursor',
    ];
    const set = new Set(STYLE_WHITELIST);
    for (const prop of required) {
      expect(set.has(prop), `STYLE_WHITELIST missing ${prop}`).toBe(true);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(STYLE_WHITELIST).size).toBe(STYLE_WHITELIST.length);
  });

  it('matches the frozen snapshot', () => {
    expect(STYLE_WHITELIST).toMatchSnapshot();
  });
});

/* ─────────────────────────── purity (no Playwright/fs/WP-client imports) ────────────────────── */

describe('purity', () => {
  const moduleSrc = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');

  for (const file of ['./mapping-table.ts', './types.ts']) {
    it(`${file} imports no Playwright / fs / WP client / tool runtime`, () => {
      const src = moduleSrc(file);
      // strip line + block comments so doc references to these names don't trip the scan
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
        expect(pattern.test(code), `${file} matched forbidden import ${String(pattern)}`).toBe(
          false,
        );
      }
    });
  }
});

/* ─────────────────────────── types.ts frozen-IR contract (type-level) ───────────────────────── */

describe('types.ts pipeline-IR contract (type-level)', () => {
  it('exports the per-stage Result envelopes shaped as the Interface section specifies', () => {
    // PARSE
    expectTypeOf<ParseResult>().toHaveProperty('ir');
    expectTypeOf<ParseResult['ir']>().toEqualTypeOf<IrNode[]>();
    expectTypeOf<ParseResult>().toHaveProperty('raw_inner_markup');
    expectTypeOf<ParseResult['doc_direction']>().toEqualTypeOf<'ltr' | 'rtl'>();
    // NORMALIZE
    expectTypeOf<NormalizeResult>().toHaveProperty('stripped');
    expectTypeOf<NormalizeResult>().toHaveProperty('promotions');
    // CLASSIFY
    expectTypeOf<ClassifyResult>().toHaveProperty('role_overrides');
    // MAP
    expectTypeOf<MapResult>().toHaveProperty('nodes');
    expectTypeOf<MapResult>().toHaveProperty('fallbacks');
    // STYLE-EXTRACT
    expectTypeOf<StyleExtractResult>().toHaveProperty('styled_nodes');
    expectTypeOf<StyleExtractResult['styled_nodes']>().toEqualTypeOf<StyledNode[]>();
    expectTypeOf<StyleExtractResult>().toHaveProperty('declaration_fallbacks');
    // ASSEMBLE
    expectTypeOf<AssembleResult>().toHaveProperty('elements');
    expectTypeOf<AssembleResult['elements']>().toEqualTypeOf<ElementNode[]>();
    expectTypeOf<AssembleResult>().toHaveProperty('local_style_ids');
    // HOIST / VAR
    expectTypeOf<HoistResult>().toHaveProperty('proposed_classes');
    expectTypeOf<HoistResult>().toHaveProperty('budget');
    expectTypeOf<VarResult>().toHaveProperty('proposed_variables');
    // COVERAGE / A11Y / FIDELITY
    expectTypeOf<CoverageReport>().toHaveProperty('coverage');
    expectTypeOf<CoverageReport>().toHaveProperty('a11y');
    expectTypeOf<CoverageReport['a11y']>().toEqualTypeOf<A11yFinding[]>();
    expectTypeOf<FidelityResult>().toHaveProperty('score');
    expectTypeOf<MappingResult>().toHaveProperty('v3_fallback');
  });

  it('re-exports the frozen shared/authoring types (imported, not redeclared)', () => {
    // These resolve through the seam; their identity is the frozen WP-F03/F05 type.
    expectTypeOf<BreakpointKey>().not.toBeAny();
    expectTypeOf<Generation>().not.toBeAny();
    expectTypeOf<ElementNode>().not.toBeAny();
    expectTypeOf<StyleDefinition>().not.toBeAny();
    expectTypeOf<SiteCapabilities>().not.toBeAny();
    // GlobalClassObject is StyleDefinition-shaped (aliased, never structurally redeclared).
    expectTypeOf<StyleDefinition>().toHaveProperty('variants');
    expectTypeOf<Generation>().not.toBeAny();
  });
});
