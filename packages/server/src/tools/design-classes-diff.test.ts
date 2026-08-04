/**
 * WP-T07 — exhaustive unit tests for the diff-PUT body builder (10-rest-api.md §4.2, NORMATIVE).
 *
 * `buildClassesDiff` is the flagship complexity, split into its own module so it can be tested in
 * isolation (no ctx, no I/O). These tests cover the add/modify/delete/reorder permutations and assert
 * the NORMATIVE invariants (§Tests Required):
 *  - `items` is touched-only (added ∪ modified) — NEVER the full collection,
 *  - `order` (top-level) is the FULL final list, CONSISTENT with `final_item_ids` (no delete-by-omission),
 *  - the 1000-item budget pre-flight throws a `budget_exceeded` `ClassesDiffError`,
 *  - the INVALID_ORDER guards (modify/delete unknown id, add colliding/duplicate id),
 *  - `changes.order` flips only when the final order actually differs.
 */

import { describe, expect, it } from 'vitest';

import type { GlobalClass } from '@elementor-ultra/shared';

import type { StyleDefinition } from '../authoring/contract.js';
import {
  buildClassesDiff,
  ClassesDiffError,
  MAX_CLASSES,
  type BuildClassesDiffInput,
} from './design-classes-diff.js';

/* ───────────────────────────── fixtures ─────────────────────────────────────────────────────── */

/** Build a minimal valid {@link StyleDefinition} (one empty desktop variant). */
function klass(id: string, label = id): StyleDefinition {
  return {
    id,
    type: 'class',
    label,
    variants: [{ meta: { breakpoint: 'desktop', state: null }, props: {} }],
  };
}

/** Build a current-collection {@link GlobalClass} (REST seam shape) for the given id. */
function currentClass(id: string): GlobalClass {
  return { id, type: 'class', label: id, variants: [] };
}

/** Build the `currentItems`+`currentOrder` pair from a list of ids. */
function currentState(ids: string[]): Pick<BuildClassesDiffInput, 'currentItems' | 'currentOrder'> {
  return { currentItems: ids.map(currentClass), currentOrder: [...ids] };
}

/* ───────────────────────────── add ──────────────────────────────────────────────────────────── */

describe('buildClassesDiff — add', () => {
  it('appends new ids to the full order and puts only added ids in items', () => {
    const body = buildClassesDiff({
      added: [klass('g-new1'), klass('g-new2')],
      ...currentState(['g-a', 'g-b']),
    });

    expect(body.changes.added).toEqual(['g-new1', 'g-new2']);
    expect(body.changes.deleted).toEqual([]);
    expect(body.changes.modified).toEqual([]);
    expect(body.changes.order).toBe(true);
    // order is the FULL final list (existing + added).
    expect(body.order).toEqual(['g-a', 'g-b', 'g-new1', 'g-new2']);
    // items is touched-only.
    expect(Object.keys(body.items).sort()).toEqual(['g-new1', 'g-new2']);
    expect(body.context).toBe('frontend');
  });

  it('rejects an added id that already exists (INVALID_ORDER)', () => {
    expect(() =>
      buildClassesDiff({ added: [klass('g-a')], ...currentState(['g-a', 'g-b']) }),
    ).toThrowError(ClassesDiffError);
    try {
      buildClassesDiff({ added: [klass('g-a')], ...currentState(['g-a']) });
    } catch (e) {
      expect((e as ClassesDiffError).kind).toBe('invalid_order');
      expect((e as ClassesDiffError).ids).toEqual(['g-a']);
    }
  });

  it('rejects duplicate ids within added (INVALID_ORDER)', () => {
    try {
      buildClassesDiff({ added: [klass('g-x'), klass('g-x')], ...currentState([]) });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ClassesDiffError);
      expect((e as ClassesDiffError).kind).toBe('invalid_order');
      expect((e as ClassesDiffError).ids).toEqual(['g-x']);
    }
  });
});

/* ───────────────────────────── modify ───────────────────────────────────────────────────────── */

describe('buildClassesDiff — modify', () => {
  it('keeps the order unchanged and puts only modified ids in items', () => {
    const body = buildClassesDiff({
      modified: [klass('g-b', 'renamed')],
      ...currentState(['g-a', 'g-b', 'g-c']),
    });

    expect(body.changes.modified).toEqual(['g-b']);
    expect(body.changes.added).toEqual([]);
    expect(body.changes.deleted).toEqual([]);
    // order unchanged → changes.order false.
    expect(body.changes.order).toBe(false);
    expect(body.order).toEqual(['g-a', 'g-b', 'g-c']);
    expect(Object.keys(body.items)).toEqual(['g-b']);
    expect(body.items['g-b']?.label).toBe('renamed');
  });

  it('rejects a modified id that does not exist (INVALID_ORDER)', () => {
    try {
      buildClassesDiff({ modified: [klass('g-z')], ...currentState(['g-a']) });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ClassesDiffError);
      expect((e as ClassesDiffError).kind).toBe('invalid_order');
      expect((e as ClassesDiffError).ids).toEqual(['g-z']);
    }
  });
});

/* ───────────────────────────── delete ───────────────────────────────────────────────────────── */

describe('buildClassesDiff — delete', () => {
  it('removes deleted ids from the full order (never by omission) and empties items', () => {
    const body = buildClassesDiff({
      deleted: ['g-b'],
      ...currentState(['g-a', 'g-b', 'g-c']),
    });

    expect(body.changes.deleted).toEqual(['g-b']);
    expect(body.changes.added).toEqual([]);
    expect(body.changes.modified).toEqual([]);
    expect(body.changes.order).toBe(true);
    // order is the FULL final list with the deletion removed.
    expect(body.order).toEqual(['g-a', 'g-c']);
    // no touched items for a pure delete.
    expect(body.items).toEqual({});
  });

  it('rejects a deleted id that does not exist (INVALID_ORDER)', () => {
    try {
      buildClassesDiff({ deleted: ['g-nope'], ...currentState(['g-a']) });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ClassesDiffError);
      expect((e as ClassesDiffError).kind).toBe('invalid_order');
    }
  });
});

/* ───────────────────────────── combined add+modify+delete ───────────────────────────────────── */

describe('buildClassesDiff — combined', () => {
  it('produces a full consistent order = existing − deleted + added with touched-only items', () => {
    const body = buildClassesDiff({
      added: [klass('g-new')],
      modified: [klass('g-a', 'A2')],
      deleted: ['g-b'],
      ...currentState(['g-a', 'g-b', 'g-c']),
    });

    expect(body.changes).toEqual({
      added: ['g-new'],
      deleted: ['g-b'],
      modified: ['g-a'],
      order: true,
    });
    // final order: g-a kept, g-b dropped, g-c kept, g-new appended.
    expect(body.order).toEqual(['g-a', 'g-c', 'g-new']);
    // items = added ∪ modified (NOT g-c, NOT the deleted g-b).
    expect(Object.keys(body.items).sort()).toEqual(['g-a', 'g-new']);

    // order is CONSISTENT with final_item_ids (existing − deleted + added) — the §4.2 invariant.
    const finalItemIds = new Set([...['g-a', 'g-b', 'g-c'].filter((id) => id !== 'g-b'), 'g-new']);
    expect(new Set(body.order)).toEqual(finalItemIds);
    expect(body.order.length).toBe(finalItemIds.size);
  });

  it('emits empty changes + unchanged order when nothing is touched', () => {
    const body = buildClassesDiff({ ...currentState(['g-a', 'g-b']) });
    expect(body.changes).toEqual({ added: [], deleted: [], modified: [], order: false });
    expect(body.order).toEqual(['g-a', 'g-b']);
    expect(body.items).toEqual({});
  });
});

/* ───────────────────────────── budget pre-flight ────────────────────────────────────────────── */

describe('buildClassesDiff — budget pre-flight', () => {
  it('throws budget_exceeded when existing − deleted + added > MAX_CLASSES', () => {
    const existing = Array.from({ length: MAX_CLASSES }, (_, i) => `g-${i}`);
    try {
      buildClassesDiff({ added: [klass('g-over')], ...currentState(existing) });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ClassesDiffError);
      const err = e as ClassesDiffError;
      expect(err.kind).toBe('budget_exceeded');
      expect(err.currentCount).toBe(MAX_CLASSES + 1);
      expect(err.maxAllowed).toBe(MAX_CLASSES);
    }
  });

  it('allows reaching exactly MAX_CLASSES', () => {
    const existing = Array.from({ length: MAX_CLASSES - 1 }, (_, i) => `g-${i}`);
    const body = buildClassesDiff({ added: [klass('g-last')], ...currentState(existing) });
    expect(body.order.length).toBe(MAX_CLASSES);
  });

  it('counts deletions against the budget (delete one, add one stays under)', () => {
    const existing = Array.from({ length: MAX_CLASSES }, (_, i) => `g-${i}`);
    const body = buildClassesDiff({
      added: [klass('g-fresh')],
      deleted: ['g-0'],
      ...currentState(existing),
    });
    expect(body.order.length).toBe(MAX_CLASSES);
  });
});
