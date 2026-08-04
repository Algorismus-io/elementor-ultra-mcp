/**
 * WP-H09 — HOIST stage unit tests.
 *
 * Covers (Acceptance Criteria + Tests Required): fingerprint order-insensitivity; >=2-use hoisting +
 * rebind + local-style removal; single-use stays local; existing-class reuse; label-rule enforcement +
 * dedupe; `projectedOrder` consistency; budget pre-flight (under/over 1000); and a CONTRACT check that
 * every proposed `GlobalClassObject` validates against `style-variant.schema.json` (it is StyleDefinition-
 * shaped) and the rebound tree's nodes carry the class id in `settings.classes.value` with the local
 * style removed. PURE — tiny `ElementNode` fixtures, no Playwright, no WP client.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import {
  fingerprintVariants,
  hoistClasses,
  isPlaceholderClassId,
  isValidClassLabel,
  placeholderClassId,
  projectedOrder,
} from './hoist.js';
import type {
  AtomicContainerNode,
  Classes,
  StyleDefinition,
  StyleVariant,
  TypedValue,
} from '../authoring/contract.js';
import type { GlobalClassObject, HoistContext } from './types.js';

/* ─────────────────────────── tiny ElementNode + ctx builders ─────────────────────────────────── */

function classesEnv(names: string[]): Classes {
  return { $$type: 'classes', value: [...names] };
}

/** A simple color-prop variant (base/desktop). */
function colorVariant(color: string): StyleVariant {
  return {
    meta: { breakpoint: null, state: null },
    props: { color: { $$type: 'color', value: color } },
  };
}

/** A style definition with a placeholder local id + the given variants. */
function localStyle(id: string, variants: StyleVariant[], label = 'local'): StyleDefinition {
  return { id, type: 'class', label, variants };
}

/**
 * Build an atomic container node carrying one or more local styles (mirrored into classes per §5.1).
 */
function node(id: string, styles: StyleDefinition[], sourcePath?: string): AtomicContainerNode {
  const stylesMap: Record<string, StyleDefinition> = {};
  const classNames: string[] = [];
  for (const s of styles) {
    stylesMap[s.id] = s;
    classNames.push(s.id);
  }
  const n: AtomicContainerNode = {
    id,
    elType: 'e-div-block',
    version: '0.0',
    settings: { classes: classesEnv(classNames) },
    styles: stylesMap,
    editor_settings: [],
    interactions: [],
    elements: [],
  };
  // The IR carries source_path; ASSEMBLE drops it, but HOIST reads name_hints by source_path so the
  // tests attach it to exercise label derivation.
  if (sourcePath !== undefined) {
    (n as unknown as { source_path: string }).source_path = sourcePath;
  }
  return n;
}

function ctx(overrides: Partial<HoistContext> = {}): HoistContext {
  return {
    existing_classes: [],
    existing_order: [],
    min_uses: 2,
    name_hints: {},
    budget_max: 1000,
    ...overrides,
  };
}

/** Read a node's classes.value array. */
function classNames(n: AtomicContainerNode): string[] {
  const env = n.settings['classes'] as Classes;
  return env.value;
}

/* ─────────────────────────── fingerprint order-insensitivity ─────────────────────────────────── */

describe('fingerprintVariants — order-insensitive', () => {
  it('two styles with the same declarations in different prop order fingerprint equal', () => {
    const a = localStyle('e-1', [
      {
        meta: { breakpoint: null, state: null },
        props: {
          color: { $$type: 'color', value: '#111' },
          'background-color': { $$type: 'color', value: '#fff' },
        },
      },
    ]);
    const b = localStyle('e-2', [
      {
        meta: { breakpoint: null, state: null },
        props: {
          'background-color': { $$type: 'color', value: '#fff' },
          color: { $$type: 'color', value: '#111' },
        },
      },
    ]);
    expect(fingerprintVariants(a)).toBe(fingerprintVariants(b));
  });

  it('two styles with the same variants in different variant order fingerprint equal', () => {
    const base = colorVariant('#111');
    const hover: StyleVariant = {
      meta: { breakpoint: null, state: 'hover' },
      props: { color: { $$type: 'color', value: '#fff' } },
    };
    const a = localStyle('e-1', [base, hover]);
    const b = localStyle('e-2', [hover, base]);
    expect(fingerprintVariants(a)).toBe(fingerprintVariants(b));
  });

  it('different declarations fingerprint differently', () => {
    const a = localStyle('e-1', [colorVariant('#111')]);
    const b = localStyle('e-2', [colorVariant('#222')]);
    expect(fingerprintVariants(a)).not.toBe(fingerprintVariants(b));
  });

  it('nested object/array envelopes are order-insensitive over object keys', () => {
    const dimA: TypedValue = {
      $$type: 'dimensions',
      value: {
        'block-start': { $$type: 'size', value: { unit: 'px', size: 8 } },
        'inline-end': { $$type: 'size', value: { unit: 'px', size: 4 } },
      },
    };
    const dimB: TypedValue = {
      $$type: 'dimensions',
      value: {
        'inline-end': { $$type: 'size', value: { size: 4, unit: 'px' } },
        'block-start': { $$type: 'size', value: { size: 8, unit: 'px' } },
      },
    };
    const a = localStyle('e-1', [
      { meta: { breakpoint: null, state: null }, props: { padding: dimA } },
    ]);
    const b = localStyle('e-2', [
      { meta: { breakpoint: null, state: null }, props: { padding: dimB } },
    ]);
    expect(fingerprintVariants(a)).toBe(fingerprintVariants(b));
  });
});

/* ─────────────────────────── >=2-use hoisting + rebind + local removal ───────────────────────── */

describe('hoistClasses — shared declaration-set hoisting (criterion 1)', () => {
  it('a declaration-set on 3 nodes is hoisted to ONE proposed class; nodes rebind; locals removed', () => {
    const v = [colorVariant('#6366f1')];
    const n1 = node('aaa1111', [localStyle('e-aaa1111-001', v)]);
    const n2 = node('bbb2222', [localStyle('e-bbb2222-001', v)]);
    const n3 = node('ccc3333', [localStyle('e-ccc3333-001', v)]);

    const res = hoistClasses([n1, n2, n3], ctx());

    expect(res.proposed_classes).toHaveLength(1);
    const proposed = res.proposed_classes[0]!;
    expect(proposed.type).toBe('class');
    expect(proposed.variants).toHaveLength(1);

    // class_rebinds lists the 3 element ids.
    expect(res.class_rebinds[proposed.id]).toEqual(
      expect.arrayContaining(['aaa1111', 'bbb2222', 'ccc3333']),
    );
    expect(res.class_rebinds[proposed.id]).toHaveLength(3);

    // Each node references the class id in classes.value and dropped its local style.
    const out = res.elements as AtomicContainerNode[];
    for (const n of out) {
      expect(classNames(n)).toContain(proposed.id);
      expect(classNames(n)).not.toContain('e-aaa1111-001');
      expect(Object.keys(n.styles ?? {})).toHaveLength(0);
    }
  });

  it('the proposed class id is a resolvable placeholder (__class:*)', () => {
    const v = [colorVariant('#0a0')];
    const res = hoistClasses(
      [node('a1', [localStyle('e-a1-1', v)]), node('b2', [localStyle('e-b2-1', v)])],
      ctx(),
    );
    const id = res.proposed_classes[0]!.id;
    expect(isPlaceholderClassId(id)).toBe(true);
    expect(id).toBe(placeholderClassId(fingerprintVariants(localStyle('x', v))));
  });
});

/* ─────────────────────────── single-use stays local (criterion 2) ────────────────────────────── */

describe('hoistClasses — single-use stays local', () => {
  it('a declaration-set used on ONE node is NOT hoisted', () => {
    const n1 = node('solo111', [localStyle('e-solo111-1', [colorVariant('#abc')])]);
    const res = hoistClasses([n1], ctx());
    expect(res.proposed_classes).toHaveLength(0);
    const out = res.elements[0] as AtomicContainerNode;
    expect(Object.keys(out.styles ?? {})).toContain('e-solo111-1');
    expect(classNames(out)).toContain('e-solo111-1');
  });

  it('min_uses=3 keeps a 2-use set local', () => {
    const v = [colorVariant('#abc')];
    const res = hoistClasses(
      [node('a1', [localStyle('e-a1-1', v)]), node('b2', [localStyle('e-b2-1', v)])],
      ctx({ min_uses: 3 }),
    );
    expect(res.proposed_classes).toHaveLength(0);
  });
});

/* ─────────────────────────── existing-class reuse (criterion 3) ───────────────────────────────── */

describe('hoistClasses — existing-class reuse', () => {
  it('an identical declaration-set already in existing_classes is REUSED (no duplicate proposed)', () => {
    const v = [colorVariant('#6366f1')];
    const existing: GlobalClassObject = {
      id: 'g-brand',
      type: 'class',
      label: 'brand',
      variants: v,
    };
    const n1 = node('a1', [localStyle('e-a1-1', v)]);
    const n2 = node('b2', [localStyle('e-b2-1', v)]);

    const res = hoistClasses(
      [n1, n2],
      ctx({ existing_classes: [existing], existing_order: ['g-brand'] }),
    );

    // No new proposal — reused the existing id.
    expect(res.proposed_classes).toHaveLength(0);
    expect(res.class_rebinds['g-brand']).toEqual(expect.arrayContaining(['a1', 'b2']));
    const out = res.elements as AtomicContainerNode[];
    expect(classNames(out[0]!)).toContain('g-brand');
    expect(classNames(out[0]!)).not.toContain('e-a1-1');
  });

  it("reuses an existing kit class whose persisted base breakpoint is 'desktop' (null ≡ desktop)", () => {
    // Candidates arrive from STYLE-EXTRACT with the IR base `breakpoint:null`, but a PERSISTED kit
    // class can only ever carry the literal 'desktop' (the PHP Style_Parser rejects a null base; the
    // orchestrator rewrites null → 'desktop' before the diff-PUT). The fingerprint must treat the two
    // forms as the same base token or kit reuse is dead against every live site.
    const candidate = [colorVariant('#6366f1')]; // IR base shape: breakpoint:null
    const existing: GlobalClassObject = {
      id: 'g-brand',
      type: 'class',
      label: 'brand',
      variants: [
        {
          meta: { breakpoint: 'desktop', state: null },
          props: { color: { $$type: 'color', value: '#6366f1' } },
        },
      ],
    };
    const res = hoistClasses(
      [
        node('a1', [localStyle('e-a1-1', candidate)]),
        node('b2', [localStyle('e-b2-1', candidate)]),
      ],
      ctx({ existing_classes: [existing], existing_order: ['g-brand'] }),
    );
    expect(res.proposed_classes).toHaveLength(0);
    expect(res.class_rebinds['g-brand']).toEqual(expect.arrayContaining(['a1', 'b2']));
  });

  it('a single-use set matching an existing class is still reused (reuse-first, collapses to kit)', () => {
    const v = [colorVariant('#6366f1')];
    const existing: GlobalClassObject = {
      id: 'g-brand',
      type: 'class',
      label: 'brand',
      variants: v,
    };
    const res = hoistClasses(
      [node('solo1', [localStyle('e-solo1-1', v)])],
      ctx({ existing_classes: [existing] }),
    );
    expect(res.proposed_classes).toHaveLength(0);
    expect(res.class_rebinds['g-brand']).toEqual(['solo1']);
  });
});

/* ─────────────────────────── label rules (criterion 4) ───────────────────────────────────────── */

describe('isValidClassLabel — authoring-contract R7', () => {
  it('accepts valid labels', () => {
    expect(isValidClassLabel('card')).toBe(true);
    expect(isValidClassLabel('hero-title')).toBe(true);
    expect(isValidClassLabel('btn_primary')).toBe(true);
    expect(isValidClassLabel('g-1a2b3c4d')).toBe(true);
  });
  it('rejects too short / too long', () => {
    expect(isValidClassLabel('a')).toBe(false);
    expect(isValidClassLabel('x'.repeat(51))).toBe(false);
  });
  it('rejects spaces, leading digit, leading -- / -digit, reserved container', () => {
    expect(isValidClassLabel('my card')).toBe(false);
    expect(isValidClassLabel('1card')).toBe(false);
    expect(isValidClassLabel('--card')).toBe(false);
    expect(isValidClassLabel('-1card')).toBe(false);
    expect(isValidClassLabel('container')).toBe(false);
    expect(isValidClassLabel('Container')).toBe(false);
  });
});

describe('hoistClasses — meaningful labels + dedupe (criterion 4)', () => {
  it('derives the label from a valid name hint', () => {
    const v = [colorVariant('#111')];
    const res = hoistClasses(
      [
        node('a1', [localStyle('e-a1-1', v)], 'body>div.card'),
        node('b2', [localStyle('e-b2-1', v)], 'body>div.card2'),
      ],
      ctx({ name_hints: { 'body>div.card': 'card', 'body>div.card2': 'card-alt' } }),
    );
    expect(res.proposed_classes[0]!.label).toBe('card');
  });

  it('falls back to g-<hex> when no valid hint', () => {
    const v = [colorVariant('#111')];
    const res = hoistClasses(
      [node('a1', [localStyle('e-a1-1', v)]), node('b2', [localStyle('e-b2-1', v)])],
      ctx(),
    );
    expect(res.proposed_classes[0]!.label).toMatch(/^g-[0-9a-f]{1,8}$/);
  });

  it('sanitizes a dirty hint toward R7', () => {
    const v = [colorVariant('#111')];
    const res = hoistClasses(
      [node('a1', [localStyle('e-a1-1', v)], 'sp1'), node('b2', [localStyle('e-b2-1', v)], 'sp2')],
      ctx({ name_hints: { sp1: 'My Card!!', sp2: 'My Card!!' } }),
    );
    expect(isValidClassLabel(res.proposed_classes[0]!.label)).toBe(true);
  });

  it('pre-dedupes label collisions within the proposal set + against existing labels', () => {
    const v1 = [colorVariant('#111')];
    const v2 = [colorVariant('#222')];
    const existing: GlobalClassObject = {
      id: 'g-old',
      type: 'class',
      label: 'card',
      variants: [colorVariant('#999')],
    };
    const res = hoistClasses(
      [
        node('a1', [localStyle('e-a1-1', v1)], 'sp1'),
        node('a2', [localStyle('e-a2-1', v1)], 'sp1b'),
        node('b1', [localStyle('e-b1-1', v2)], 'sp2'),
        node('b2', [localStyle('e-b2-1', v2)], 'sp2b'),
      ],
      ctx({
        existing_classes: [existing],
        name_hints: { sp1: 'card', sp1b: 'card', sp2: 'card', sp2b: 'card' },
      }),
    );
    const labels = res.proposed_classes.map((c) => c.label.toLowerCase());
    // 'card' already taken by the existing class → both proposals get unique suffixed labels.
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) {
      expect(l).not.toBe('card');
      expect(isValidClassLabel(l)).toBe(true);
    }
  });
});

/* ─────────────────────────── projectedOrder (criterion 5) ────────────────────────────────────── */

describe('projectedOrder', () => {
  it('returns existing order + appended new ids (consistent full list)', () => {
    expect(projectedOrder(['g-1', 'g-2'], ['g-3', 'g-4'])).toEqual(['g-1', 'g-2', 'g-3', 'g-4']);
  });
  it('is dedup-safe (an added id already in order is not duplicated)', () => {
    expect(projectedOrder(['g-1', 'g-2'], ['g-2', 'g-3'])).toEqual(['g-1', 'g-2', 'g-3']);
  });
  it('empty existing order yields just the new ids', () => {
    expect(projectedOrder([], ['g-1', 'g-2'])).toEqual(['g-1', 'g-2']);
  });
});

/* ─────────────────────────── budget pre-flight (criterion 7) ─────────────────────────────────── */

describe('hoistClasses — budget pre-flight', () => {
  it('not exceeded under the cap; budget projects correctly', () => {
    const v = [colorVariant('#111')];
    const existing: GlobalClassObject[] = Array.from({ length: 10 }, (_, i) => ({
      id: `g-${String(i)}`,
      type: 'class',
      label: `c${String(i)}`,
      variants: [colorVariant(`#00000${String(i)}`)],
    }));
    const res = hoistClasses(
      [node('a1', [localStyle('e-a1-1', v)]), node('b2', [localStyle('e-b2-1', v)])],
      ctx({ existing_classes: existing, budget_max: 1000 }),
    );
    expect(res.budget.current_count).toBe(10);
    expect(res.budget.would_add).toBe(1);
    expect(res.budget.would_delete).toBe(0);
    expect(res.budget.projected).toBe(11);
    expect(res.budget.exceeded).toBe(false);
    expect(res.warnings).toHaveLength(0);
  });

  it('exceeded over the cap; reports a consolidation warning and does NOT throw', () => {
    const v = [colorVariant('#111')];
    const existing: GlobalClassObject[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `g-${String(i)}`,
      type: 'class',
      label: `c${String(i)}`,
      variants: [colorVariant(`#${i.toString(16).padStart(6, '0')}`)],
    }));
    const res = hoistClasses(
      [node('a1', [localStyle('e-a1-1', v)]), node('b2', [localStyle('e-b2-1', v)])],
      ctx({ existing_classes: existing, budget_max: 1000 }),
    );
    expect(res.budget.projected).toBe(1001);
    expect(res.budget.exceeded).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/BUDGET_EXCEEDED/);
    expect(res.warnings.join(' ')).toMatch(/consolidat/i);
  });
});

/* ─────────────────────────── purity (criterion: no in-place mutation) ────────────────────────── */

describe('hoistClasses — does not mutate the input tree', () => {
  it('the caller tree is unchanged after hoisting', () => {
    const v = [colorVariant('#111')];
    const n1 = node('a1', [localStyle('e-a1-1', v)]);
    const n2 = node('b2', [localStyle('e-b2-1', v)]);
    const before = JSON.stringify([n1, n2]);
    hoistClasses([n1, n2], ctx());
    expect(JSON.stringify([n1, n2])).toBe(before);
  });
});

/* ─────────────────────────── multi-style node: only shared set hoists ────────────────────────── */

describe('hoistClasses — partial hoist on a multi-style node', () => {
  it('hoists only the shared style, leaving the single-use local style intact', () => {
    const shared = [colorVariant('#6366f1')];
    const unique = [colorVariant('#ff0000')];
    const n1 = node('a1', [localStyle('e-a1-1', shared), localStyle('e-a1-2', unique)]);
    const n2 = node('b2', [localStyle('e-b2-1', shared)]);

    const res = hoistClasses([n1, n2], ctx());
    expect(res.proposed_classes).toHaveLength(1);
    const out0 = res.elements[0] as AtomicContainerNode;
    // The unique local style stays.
    expect(Object.keys(out0.styles ?? {})).toContain('e-a1-2');
    expect(classNames(out0)).toContain('e-a1-2');
    // The shared one is gone, replaced by the class id.
    expect(Object.keys(out0.styles ?? {})).not.toContain('e-a1-1');
    expect(classNames(out0)).toContain(res.proposed_classes[0]!.id);
  });
});

/* ─────────────────────────── CONTRACT: proposed classes validate against the schema ─────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(HERE, '..', '..', '..', 'shared', 'schemas');

function compileStyleDefinitionValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const atomic = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'atomic-prop-types.schema.json'), 'utf8'),
  ) as AnySchemaObject;
  ajv.addSchema(atomic);
  const styleVariant = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'style-variant.schema.json'), 'utf8'),
  ) as AnySchemaObject;
  return ajv.compile(styleVariant);
}

describe('hoistClasses — proposed classes are StyleDefinition-shaped (schema-valid)', () => {
  const validate = compileStyleDefinitionValidator();

  it('a proposed GlobalClassObject validates against style-variant.schema.json (sans placeholder id)', () => {
    const v = [colorVariant('#6366f1')];
    const res = hoistClasses(
      [node('a1', [localStyle('e-a1-1', v)], 'sp1'), node('b2', [localStyle('e-b2-1', v)], 'sp2')],
      ctx({ name_hints: { sp1: 'brand', sp2: 'brand2' } }),
    );
    const proposed = res.proposed_classes[0]!;
    // The placeholder id (__class:*) is an internal handshake; the real g-* id is minted by the PUT.
    // Validate the StyleDefinition SHAPE with a regex-valid id substituted (WP-H11 supplies the real id).
    const forValidation = { ...proposed, id: 'g-brand' };
    const ok = validate(forValidation);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });
});

/* ─────────────────────────── CONTRACT: rebound tree validates (element-node) ──────────────────── */

function compileElementNodeValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const file of ['atomic-prop-types.schema.json', 'style-variant.schema.json']) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8')) as AnySchemaObject);
  }
  const elementNode = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'element-node.schema.json'), 'utf8'),
  ) as AnySchemaObject;
  return ajv.compile(elementNode);
}

/**
 * Resolve HOIST placeholder class ids (`__class:*`) to schema-valid `g-*` ids the way WP-H11 will after
 * the diff-PUT mints them, so the rebound tree can be schema-validated at the unit level (the corpus
 * dry_run round-trip is WP-H11's job, Contract 14 §6).
 */
function resolvePlaceholders(
  nodes: AtomicContainerNode[],
  rebinds: Record<string, string[]>,
): void {
  const map = new Map<string, string>();
  let i = 0;
  for (const ph of Object.keys(rebinds)) {
    map.set(ph, isPlaceholderClassId(ph) ? `g-resolved${String(i++)}` : ph);
  }
  const walk = (n: AtomicContainerNode): void => {
    const env = n.settings['classes'] as Classes;
    env.value = env.value.map((name) => map.get(name) ?? name);
    for (const child of (n.elements ?? []) as AtomicContainerNode[]) {
      walk(child);
    }
  };
  for (const n of nodes) {
    walk(n);
  }
}

describe('hoistClasses — the rebound tree validates against element-node.schema.json (criterion)', () => {
  const validate = compileElementNodeValidator();

  it('after placeholder resolution, every rebound node is schema-valid', () => {
    const v = [colorVariant('#6366f1')];
    const res = hoistClasses(
      [
        node('aaa1111', [localStyle('e-aaa1111-001', v)]),
        node('bbb2222', [localStyle('e-bbb2222-001', v)]),
      ],
      ctx(),
    );
    const out = res.elements as AtomicContainerNode[];
    resolvePlaceholders(out, res.class_rebinds);
    for (const n of out) {
      const ok = validate(n);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    }
  });
});
