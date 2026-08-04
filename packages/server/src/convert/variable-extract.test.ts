/**
 * WP-H09 — VARIABLE-EXTRACT stage unit tests.
 *
 * Covers (Acceptance Criteria + Tests Required): color/font/size literal extraction + rebind to a
 * variable-reference envelope; existing-variable reuse; size variables NOT Pro-gated; single-use stays a
 * literal; budget pre-flight (under/over 1000); nested-literal rebind (box-shadow color). PURE — tiny
 * `ElementNode` fixtures, no Playwright, no WP client.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import { extractVariables, isPlaceholderVarId, placeholderVarId } from './variable-extract.js';
import type {
  AtomicContainerNode,
  Classes,
  StyleDefinition,
  StyleVariant,
  TypedValue,
} from '../authoring/contract.js';
import type { LiteralRef, VarContext, VariableDef } from './types.js';

/* ─────────────────────────── tiny ElementNode + ctx builders ─────────────────────────────────── */

function classesEnv(names: string[]): Classes {
  return { $$type: 'classes', value: [...names] };
}

/** A node carrying a single local style whose base variant has the given props. */
function node(id: string, props: Record<string, TypedValue>): AtomicContainerNode {
  const styleId = `e-${id}-1`;
  const variant: StyleVariant = { meta: { breakpoint: null, state: null }, props };
  const def: StyleDefinition = { id: styleId, type: 'class', label: 'local', variants: [variant] };
  return {
    id,
    elType: 'e-div-block',
    version: '0.0',
    settings: { classes: classesEnv([styleId]) },
    styles: { [styleId]: def },
    editor_settings: [],
    interactions: [],
    elements: [],
  };
}

function ctx(overrides: Partial<VarContext> = {}): VarContext {
  return {
    existing_variables: [],
    min_uses: 2,
    budget_max: 1000,
    ...overrides,
  };
}

/** Read the base variant props of a node's first local style. */
function baseProps(n: AtomicContainerNode): Record<string, TypedValue> {
  const def = Object.values(n.styles ?? {})[0]!;
  return def.variants[0]!.props;
}

/* ─────────────────────────── color literal extraction + rebind (criterion 6) ─────────────────── */

describe('extractVariables — color literal extraction', () => {
  it('a color on 2 nodes becomes a global-color-variable; nodes rebind to a var ref envelope', () => {
    const n1 = node('a1', { color: { $$type: 'color', value: '#6366f1' } });
    const n2 = node('b2', { 'background-color': { $$type: 'color', value: '#6366f1' } });

    const res = extractVariables([n1, n2], [], ctx());

    const proposal = res.proposed_variables.find((v) => v.type === 'global-color-variable');
    expect(proposal).toBeTruthy();
    expect(proposal!.value).toBe('#6366f1');

    const out = res.elements as AtomicContainerNode[];
    const ref1 = baseProps(out[0]!)['color'] as TypedValue;
    expect(ref1.$$type).toBe('global-color-variable');
    expect(typeof ref1.value).toBe('string');
    expect(isPlaceholderVarId(ref1.value as string)).toBe(true);
    expect(ref1.value).toBe(placeholderVarId('color', '#6366f1'));

    const ref2 = baseProps(out[1]!)['background-color'] as TypedValue;
    expect(ref2.$$type).toBe('global-color-variable');

    // var_rebinds records both element ids under the var id.
    expect(res.var_rebinds[ref1.value as string]).toEqual(expect.arrayContaining(['a1', 'b2']));
  });

  it('a single-use color stays a literal (not extracted)', () => {
    const n1 = node('a1', { color: { $$type: 'color', value: '#abc123' } });
    const res = extractVariables([n1], [], ctx());
    expect(res.proposed_variables).toHaveLength(0);
    const out = res.elements[0] as AtomicContainerNode;
    expect((baseProps(out)['color'] as TypedValue).$$type).toBe('color');
  });
});

/* ─────────────────────────── font literal extraction (criterion 6) ───────────────────────────── */

describe('extractVariables — font stack extraction', () => {
  it('a font-family on 2 nodes becomes a global-font-variable; rebinds to a font var ref', () => {
    const n1 = node('a1', { 'font-family': { $$type: 'string', value: 'Inter, sans-serif' } });
    const n2 = node('b2', { 'font-family': { $$type: 'string', value: 'Inter, sans-serif' } });

    const res = extractVariables([n1, n2], [], ctx());
    const proposal = res.proposed_variables.find((v) => v.type === 'global-font-variable');
    expect(proposal).toBeTruthy();
    expect(proposal!.value).toBe('Inter, sans-serif');
    expect(proposal!.label).toMatch(/^font-/i);

    const out = res.elements as AtomicContainerNode[];
    const ref = baseProps(out[0]!)['font-family'] as TypedValue;
    expect(ref.$$type).toBe('global-font-variable');
  });

  it('a plain string prop that is NOT font-family is never treated as a font literal', () => {
    const n1 = node('a1', { display: { $$type: 'string', value: 'flex' } });
    const n2 = node('b2', { display: { $$type: 'string', value: 'flex' } });
    const res = extractVariables([n1, n2], [], ctx());
    expect(res.proposed_variables).toHaveLength(0);
  });
});

/* ─────────────────────────── size variables NOT Pro-gated (criterion: size free) ─────────────── */

describe('extractVariables — size variables are extracted (NOT Pro-gated)', () => {
  it('a recurring size on 2 nodes becomes a global-size-variable; rebinds to a size var ref', () => {
    const sz: TypedValue = { $$type: 'size', value: { unit: 'px', size: 16 } };
    const n1 = node('a1', { 'font-size': sz });
    const n2 = node('b2', { 'font-size': { $$type: 'size', value: { unit: 'px', size: 16 } } });

    const res = extractVariables([n1, n2], [], ctx());
    const proposal = res.proposed_variables.find((v) => v.type === 'global-size-variable');
    expect(proposal).toBeTruthy();
    expect(proposal!.value).toBe('16px');

    const out = res.elements as AtomicContainerNode[];
    const ref = baseProps(out[0]!)['font-size'] as TypedValue;
    expect(ref.$$type).toBe('global-size-variable');
  });

  it('auto/custom size sentinels are not extracted as size literals', () => {
    const auto: TypedValue = { $$type: 'size', value: { unit: 'auto', size: null } };
    const n1 = node('a1', { width: auto });
    const n2 = node('b2', { width: { $$type: 'size', value: { unit: 'auto', size: null } } });
    const res = extractVariables([n1, n2], [], ctx());
    expect(res.proposed_variables).toHaveLength(0);
  });
});

/* ─────────────────────────── existing-variable reuse (criterion 7) ───────────────────────────── */

describe('extractVariables — existing-variable reuse', () => {
  it('a literal matching an existing kit variable REUSES its id (no duplicate proposal)', () => {
    const existing: VariableDef = {
      id: 'e-gv-brand',
      type: 'global-color-variable',
      label: 'brand',
      value: '#6366F1',
    };
    const n1 = node('a1', { color: { $$type: 'color', value: '#6366f1' } });

    // Single use, but matches an existing var → still reused (reuse-first).
    const res = extractVariables([n1], [], ctx({ existing_variables: [existing] }));
    expect(res.proposed_variables).toHaveLength(0);

    const out = res.elements[0] as AtomicContainerNode;
    const ref = baseProps(out)['color'] as TypedValue;
    expect(ref.$$type).toBe('global-color-variable');
    expect(ref.value).toBe('e-gv-brand'); // the EXISTING id, not a placeholder
    expect(isPlaceholderVarId(ref.value as string)).toBe(false);
    expect(res.var_rebinds['e-gv-brand']).toEqual(['a1']);
  });
});

/* ─────────────────────────── nested literal (box-shadow color) rebind ────────────────────────── */

describe('extractVariables — nested literal rebind', () => {
  it('a color nested inside a box-shadow / array envelope is extracted + rebound', () => {
    const shadow = (color: string): TypedValue => ({
      $$type: 'box-shadow',
      value: [
        {
          $$type: 'shadow',
          value: {
            hOffset: { $$type: 'size', value: { unit: 'px', size: 0 } },
            vOffset: { $$type: 'size', value: { unit: 'px', size: 2 } },
            blur: { $$type: 'size', value: { unit: 'px', size: 8 } },
            spread: { $$type: 'size', value: { unit: 'px', size: 0 } },
            color: { $$type: 'color', value: color },
          },
        },
      ],
    });
    const n1 = node('a1', { 'box-shadow': shadow('#123456') });
    const n2 = node('b2', { 'box-shadow': shadow('#123456') });

    const res = extractVariables([n1, n2], [], ctx());
    const proposal = res.proposed_variables.find((v) => v.value === '#123456');
    expect(proposal).toBeTruthy();
    expect(proposal!.type).toBe('global-color-variable');

    const out = res.elements[0] as AtomicContainerNode;
    const shadowOut = baseProps(out)['box-shadow'] as TypedValue;
    const inner = (shadowOut.value as Array<{ value: { color: TypedValue } }>)[0]!.value.color;
    expect(inner.$$type).toBe('global-color-variable');
  });
});

/* ─────────────────────────── LiteralRef seed (pre-assembly source_path) ──────────────────────── */

describe('extractVariables — LiteralRef seed does not double-count tree literals', () => {
  it('a tree literal counted by the scan is not inflated by the LiteralRef seed', () => {
    const n1 = node('a1', { color: { $$type: 'color', value: '#6366f1' } });
    // Only ONE node in the tree carries the color; the LiteralRef claims 2 source_path occurrences.
    const literals: LiteralRef[] = [
      { kind: 'color', value: '#6366f1', occurrences: ['sp1', 'sp2'] },
    ];
    const res = extractVariables([n1], literals, ctx());
    // Tree scan saw 1 occurrence (authoritative) → below min_uses=2 → NOT extracted.
    expect(res.proposed_variables).toHaveLength(0);
  });

  it('a LiteralRef for a literal absent from the tree can still drive a proposal (seed fallback)', () => {
    // No tree node carries this literal at all; the seed has 2 occurrences → considered + extracted,
    // but since nothing in the tree matches, there is no rebind (proposal only, no var_rebinds entry).
    const n1 = node('a1', { color: { $$type: 'color', value: '#000000' } });
    const literals: LiteralRef[] = [
      { kind: 'color', value: '#abcabc', occurrences: ['sp1', 'sp2'] },
    ];
    const res = extractVariables([n1], literals, ctx());
    const proposal = res.proposed_variables.find((v) => v.value === '#abcabc');
    expect(proposal).toBeTruthy();
  });
});

/* ─────────────────────────── budget pre-flight ───────────────────────────────────────────────── */

describe('extractVariables — budget pre-flight', () => {
  it('not exceeded under the cap', () => {
    const existing: VariableDef[] = Array.from({ length: 5 }, (_, i) => ({
      id: `e-gv-${String(i)}`,
      type: 'global-color-variable',
      label: `c${String(i)}`,
      value: `#${i.toString(16).padStart(6, '0')}`,
    }));
    const n1 = node('a1', { color: { $$type: 'color', value: '#777777' } });
    const n2 = node('b2', { color: { $$type: 'color', value: '#777777' } });
    const res = extractVariables([n1, n2], [], ctx({ existing_variables: existing }));
    expect(res.budget.current_count).toBe(5);
    expect(res.budget.would_add).toBe(1);
    expect(res.budget.projected).toBe(6);
    expect(res.budget.exceeded).toBe(false);
  });

  it('exceeded over the cap; warns + does not throw', () => {
    const existing: VariableDef[] = Array.from({ length: 1000 }, (_, i) => ({
      id: `e-gv-${String(i)}`,
      type: 'global-color-variable',
      label: `c${String(i)}`,
      value: `#${i.toString(16).padStart(6, '0')}`,
    }));
    const n1 = node('a1', { color: { $$type: 'color', value: '#abcdef' } });
    const n2 = node('b2', { color: { $$type: 'color', value: '#abcdef' } });
    const res = extractVariables([n1, n2], [], ctx({ existing_variables: existing }));
    expect(res.budget.projected).toBe(1001);
    expect(res.budget.exceeded).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/BUDGET_EXCEEDED/);
  });
});

/* ─────────────────────────── purity ──────────────────────────────────────────────────────────── */

describe('extractVariables — does not mutate the input tree', () => {
  it('the caller tree is unchanged after extraction', () => {
    const n1 = node('a1', { color: { $$type: 'color', value: '#6366f1' } });
    const n2 = node('b2', { color: { $$type: 'color', value: '#6366f1' } });
    const before = JSON.stringify([n1, n2]);
    extractVariables([n1, n2], [], ctx());
    expect(JSON.stringify([n1, n2])).toBe(before);
  });
});

/* ─────────────────────────── CONTRACT: rebound tree validates (element-node) ──────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(HERE, '..', '..', '..', 'shared', 'schemas');

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

/** Resolve `__var:*` placeholders to schema-valid `e-gv-*` ids the way WP-H11 will after the batch. */
function resolveVarPlaceholders(n: AtomicContainerNode): void {
  let i = 0;
  const map = new Map<string, string>();
  const resolve1 = (tv: TypedValue): TypedValue => {
    if (
      typeof tv.value === 'string' &&
      (tv.$$type === 'global-color-variable' ||
        tv.$$type === 'global-font-variable' ||
        tv.$$type === 'global-size-variable') &&
      isPlaceholderVarId(tv.value)
    ) {
      let real = map.get(tv.value);
      if (real === undefined) {
        real = `e-gv-${String(i++)}`;
        map.set(tv.value, real);
      }
      return { ...tv, value: real };
    }
    if (Array.isArray(tv.value)) {
      const items = tv.value as unknown[];
      const mapped: unknown[] = items.map((x) => (isTv(x) ? resolve1(x) : x));
      return { ...tv, value: mapped };
    }
    if (typeof tv.value === 'object' && tv.value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(tv.value as Record<string, unknown>)) {
        out[k] = isTv(x) ? resolve1(x) : x;
      }
      return { ...tv, value: out };
    }
    return tv;
  };
  for (const def of Object.values(n.styles ?? {})) {
    for (const variant of def.variants) {
      for (const [p, tv] of Object.entries(variant.props)) {
        variant.props[p] = resolve1(tv);
      }
    }
  }
}

function isTv(v: unknown): v is TypedValue {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && '$$type' in v && 'value' in v;
}

describe('extractVariables — the rebound tree validates against element-node.schema.json', () => {
  const validate = compileElementNodeValidator();

  it('after var placeholder resolution, every rebound node is schema-valid', () => {
    const sz: TypedValue = { $$type: 'size', value: { unit: 'px', size: 16 } };
    const n1 = node('a1', {
      color: { $$type: 'color', value: '#6366f1' },
      'font-family': { $$type: 'string', value: 'Inter, sans-serif' },
      'font-size': sz,
    });
    const n2 = node('b2', {
      color: { $$type: 'color', value: '#6366f1' },
      'font-family': { $$type: 'string', value: 'Inter, sans-serif' },
      'font-size': { $$type: 'size', value: { unit: 'px', size: 16 } },
    });
    const res = extractVariables([n1, n2], [], ctx());
    for (const n of res.elements as AtomicContainerNode[]) {
      resolveVarPlaceholders(n);
      const ok = validate(n);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    }
  });
});
