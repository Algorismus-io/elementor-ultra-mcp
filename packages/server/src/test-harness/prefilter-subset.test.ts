/**
 * WP-F06 — TS pre-filter subset suite (`14-fixtures-harness.md §4`) + harness self-tests.
 *
 * This is the ONLY harness file that runs under `pnpm test:unit` (no WordPress). It asserts:
 *   1. envelope validity — every seeded fixture passes `validateFixtureObject` (the §2 envelope + the
 *      authoring tree where the tree is well-formed-by-design); a deliberately malformed fixture
 *      (bad envelope OR a raw throw-string in `expect.errors`) is REJECTED.
 *   2. pre-filter subset — for each `kind:"tree"`/`"roundtrip"` fixture, the real pre-filter's verdict
 *      is COMPATIBLE with `prefilter.verdict`: `accept` ⇒ pre-filter must NOT reject; `reject` ⇒
 *      pre-filter MUST reject; `defer` ⇒ pre-filter must NOT hard-decide.
 *   3. corpus meta-invariant — `accept ⇒ expect.valid:true`, `reject ⇒ expect.valid:false`.
 *   4. capability gating parity — the TS loader skips exactly the fixtures the PHP loader would skip
 *      for the same capability snapshot (the gate predicate is the shared single point).
 */

import { describe, expect, it } from 'vitest';

import { prefilter } from '../authoring/prefilter.js';
import type { ElementNode } from '../authoring/contract.js';
import {
  loadAllFixtures,
  loadFixturesByKind,
  validateFixtureObject,
  isFixtureRunnable,
  fixtureLabel,
  type CapabilitySnapshot,
  type FixtureEnvelope,
  type LoadedFixture,
} from './fixture-loader.js';

/** Fixtures whose embedded tree the pre-filter walks (tree + roundtrip + smoke carry an authoring tree). */
function fixturesWithTree(): LoadedFixture[] {
  return loadAllFixtures().filter(
    (f) => Array.isArray(treeOf(f.envelope)) && treeOf(f.envelope)!.length > 0,
  );
}

/** The authoring tree a fixture exposes (kind:tree uses `tree`, kind:roundtrip uses `input_tree`). */
function treeOf(env: FixtureEnvelope): ElementNode[] | undefined {
  if (env.tree !== undefined) {
    return env.tree;
  }
  if (env.input_tree !== undefined) {
    return env.input_tree;
  }
  if (env.arguments !== undefined && Array.isArray(env.arguments['elements'])) {
    return env.arguments['elements'] as ElementNode[];
  }
  return undefined;
}

describe('fixtures: envelope validity (§2)', () => {
  const all = loadAllFixtures();

  it('loads at least the seeded bootstrap set', () => {
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it.each(all.map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s" passes envelope + authoring validation',
    (_label, f) => {
      const issues = validateFixtureObject(f.envelope, fixtureLabel(f));
      expect(issues, JSON.stringify(issues, null, 2)).toHaveLength(0);
    },
  );

  it('the fixture id equals the filename minus .json', () => {
    for (const f of all) {
      const fromName = f.path
        .split('/')
        .pop()!
        .replace(/\.json$/, '');
      expect(f.envelope.id).toBe(fromName);
    }
  });
});

describe('fixtures: validator rejects malformed fixtures (self-test)', () => {
  it('rejects a bad envelope (missing required keys)', () => {
    const bad = { $fixture: 1, id: 'broken' };
    const issues = validateFixtureObject(bad, 'broken');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects a raw Elementor throw-string in expect.errors (not a taxonomy code)', () => {
    const bad = {
      $fixture: 1,
      id: 'raw-throw',
      kind: 'tree',
      generation: 'v4',
      expect: { valid: false, errors: ['Settings validation failed.'] },
      prefilter: { verdict: 'reject' },
    };
    const issues = validateFixtureObject(bad, 'raw-throw');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects a valid fixture that also lists errors (meta-invariant)', () => {
    const bad = {
      $fixture: 1,
      id: 'valid-with-errors',
      kind: 'tree',
      generation: 'v4',
      expect: { valid: true, errors: ['ATOMIC_SETTINGS_INVALID'] },
    };
    const issues = validateFixtureObject(bad, 'valid-with-errors');
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('fixtures: corpus meta-invariant (§4)', () => {
  it.each(loadAllFixtures().map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s": accept⇒valid, reject⇒invalid',
    (_label, f) => {
      const verdict = f.envelope.prefilter?.verdict;
      if (verdict === 'accept') {
        expect(f.envelope.expect.valid).toBe(true);
      } else if (verdict === 'reject') {
        expect(f.envelope.expect.valid).toBe(false);
      }
      // `defer` (and absent) impose no constraint on expect.valid.
    },
  );
});

describe('fixtures: pre-filter subset behavior (§4)', () => {
  it.each(fixturesWithTree().map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s": real pre-filter verdict is compatible with prefilter.verdict',
    (_label, f) => {
      const declared = f.envelope.prefilter?.verdict;
      const tree = treeOf(f.envelope)!;
      const result = prefilter(tree);

      if (declared === 'accept') {
        // accept ⇒ the pre-filter must NEVER reject (no false reject of PHP-valid input).
        expect(result.verdict).not.toBe('reject');
      } else if (declared === 'reject') {
        // reject ⇒ the pre-filter MUST reject (it only rejects what PHP also rejects).
        expect(result.verdict).toBe('reject');
      } else {
        // defer ⇒ the pre-filter must not hard-decide; defer is the safe outcome.
        expect(['defer', 'accept']).toContain(result.verdict);
      }
    },
  );

  it('a reject fixture yields taxonomy-coded errors from the pre-filter', () => {
    const rejects = fixturesWithTree().filter((f) => f.envelope.prefilter?.verdict === 'reject');
    expect(rejects.length).toBeGreaterThan(0);
    for (const f of rejects) {
      const result = prefilter(treeOf(f.envelope)!);
      expect(result.verdict).toBe('reject');
      expect(result.errors.length).toBeGreaterThan(0);
      for (const e of result.errors) {
        expect(e.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});

describe('pre-filter: non-envelope settings values (reject ⇒ PHP invalid, §4)', () => {
  /** Minimal atomic widget node with the given extra settings entries. */
  function atomicNode(settings: Record<string, unknown>): ElementNode {
    return {
      id: 'pf00001',
      elType: 'widget',
      widgetType: 'e-heading',
      settings: {
        classes: { $$type: 'classes', value: [] },
        ...settings,
      },
      styles: {},
      elements: [],
    } as unknown as ElementNode;
  }

  it('a null settings value DEFERS (PHP accepts null for non-required props)', () => {
    const result = prefilter([atomicNode({ someProp: null })]);
    expect(result.verdict).toBe('defer');
    expect(result.errors).toHaveLength(0);
  });

  it('a non-envelope object crumb DEFERS (unknown keys are silently dropped by PHP)', () => {
    const result = prefilter([atomicNode({ crumb: { value: 'no $$type here' } })]);
    expect(result.verdict).toBe('defer');
    expect(result.errors).toHaveLength(0);
  });

  it('a non-envelope array crumb DEFERS', () => {
    const result = prefilter([atomicNode({ crumb: ['raw'] })]);
    expect(result.verdict).toBe('defer');
    expect(result.errors).toHaveLength(0);
  });

  it('a bare scalar string still REJECTS (the frozen [R8] failure class)', () => {
    const result = prefilter([atomicNode({ tag: 'h1' })]);
    expect(result.verdict).toBe('reject');
    expect(result.errors.some((e) => e.code === 'VALIDATION_FAILED' && e.prop === 'tag')).toBe(
      true,
    );
  });
});

describe('fixtures: capability gating parity (§2/§3)', () => {
  // A free-only install WITHOUT the atomic experiment must skip the atomic fixtures; the SAME
  // predicate the PHP loader mirrors. Proves TS and PHP skip the same set for a given snapshot.
  const freeOnly: CapabilitySnapshot = { experiments: [], pro: false, elementor_version: '4.1.1' };
  const full: CapabilitySnapshot = {
    experiments: ['e_atomic_elements', 'e_classes', 'e_variables'],
    pro: true,
    elementor_version: '4.1.1',
  };

  it('skips e_atomic_elements fixtures on a free-only install', () => {
    const all = loadFixturesByKind('tree');
    const atomic = all.filter((f) =>
      f.envelope.requires?.experiments?.includes('e_atomic_elements'),
    );
    expect(atomic.length).toBeGreaterThan(0);
    for (const f of atomic) {
      expect(isFixtureRunnable(f.envelope, freeOnly)).toBe(false);
      expect(isFixtureRunnable(f.envelope, full)).toBe(true);
    }
  });

  it('a fixture below min_elementor is skipped', () => {
    const env: FixtureEnvelope = {
      $fixture: 1,
      id: 'needs-newer',
      kind: 'tree',
      generation: 'v4',
      expect: { valid: true },
      requires: { min_elementor: '4.1.1' },
    };
    expect(
      isFixtureRunnable(env, { experiments: [], pro: false, elementor_version: '4.0.0' }),
    ).toBe(false);
    expect(
      isFixtureRunnable(env, { experiments: [], pro: false, elementor_version: '4.1.1' }),
    ).toBe(true);
  });
});
