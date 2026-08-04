/**
 * WP-T03 — diff shaping tests.
 *
 * Covers acceptance criteria:
 *   - `presentDiff` validates a PHP-authored Diff against `diff.schema.json#/$defs/Diff` and returns it
 *     unchanged; a malformed diff throws `DiffShapeError`.
 *   - `summarizeDiff` counts changes by op + dedupes `touched_ids` (changes + id roll-ups).
 *   - `localDiff` is ADVISORY-only (`_advisory:true`, fenced from commit paths) and operates on
 *     normalized trees (round-trip noise like `_cssid` never registers as a change).
 */

import { describe, expect, it } from 'vitest';

import type { AtomicWidgetNode, Diff, ElementNode } from '../authoring/contract.js';

import { DiffShapeError, isAdvisoryDiff, localDiff, presentDiff, summarizeDiff } from './diff.js';

/* ─────────────────────────── fixtures ───────────────────────────────────────────────────────── */

const VALID_DIFF: Diff = {
  changes: [
    { id: 'abc1234', op: 'modified', elType: 'widget', changed_paths: ['settings.title'] },
    { id: 'hd00001', op: 'added', elType: 'widget' },
    { id: 'old0001', op: 'removed', elType: 'widget' },
    { id: 'mv00001', op: 'moved', from_parent: 'p1', to_parent: 'p2', from_index: 0, to_index: 1 },
  ],
  new_ids: ['hd00001'],
  changed_ids: ['abc1234'],
  removed_ids: ['old0001'],
  base_hash_before: '9f86d081884c7d659a2feaa0c55ad015',
  base_hash_after: '0cc175b9c0f1b6a831c399e269772661',
};

function atomicWidget(id: string, title: string): ElementNode {
  return {
    id,
    elType: 'widget',
    widgetType: 'e-heading',
    settings: { title: { $$type: 'string', value: title } },
  };
}

/* ─────────────────────────── presentDiff ────────────────────────────────────────────────────── */

describe('presentDiff', () => {
  it('returns a schema-valid Diff unchanged (same reference)', () => {
    const out = presentDiff(VALID_DIFF);
    expect(out).toBe(VALID_DIFF);
  });

  it('accepts a minimal Diff (only required `changes`)', () => {
    const minimal: Diff = { changes: [] };
    expect(presentDiff(minimal)).toBe(minimal);
  });

  it('throws DiffShapeError on a malformed op enum', () => {
    const bad = { changes: [{ id: 'x1', op: 'frobnicated' }] } as unknown as Diff;
    expect(() => presentDiff(bad)).toThrow(DiffShapeError);
  });

  it('throws DiffShapeError when a change is missing required `op`', () => {
    const bad = { changes: [{ id: 'x1' }] } as unknown as Diff;
    let caught: unknown;
    try {
      presentDiff(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DiffShapeError);
    expect((caught as DiffShapeError).issues.length).toBeGreaterThan(0);
  });

  it('throws DiffShapeError on a bad base_hash pattern', () => {
    const bad = { changes: [], base_hash_after: 'NOT-A-HASH' } as unknown as Diff;
    expect(() => presentDiff(bad)).toThrow(DiffShapeError);
  });

  it('throws DiffShapeError on an unknown top-level property (additionalProperties:false)', () => {
    const bad = { changes: [], bogus: true } as unknown as Diff;
    expect(() => presentDiff(bad)).toThrow(DiffShapeError);
  });

  it('does not fabricate or drop changes (pass-through identity by value)', () => {
    const out = presentDiff(VALID_DIFF);
    expect(out.changes).toHaveLength(VALID_DIFF.changes.length);
    expect(out.changes).toEqual(VALID_DIFF.changes);
  });
});

/* ─────────────────────────── summarizeDiff ──────────────────────────────────────────────────── */

describe('summarizeDiff', () => {
  it('counts each op kind correctly', () => {
    const s = summarizeDiff(VALID_DIFF);
    expect(s.changed).toBe(1);
    expect(s.added).toBe(1);
    expect(s.removed).toBe(1);
    expect(s.moved).toBe(1);
  });

  it('collects distinct touched_ids in first-seen order', () => {
    const s = summarizeDiff(VALID_DIFF);
    expect(s.touched_ids).toEqual(['abc1234', 'hd00001', 'old0001', 'mv00001']);
  });

  it('dedupes ids that appear both in changes and in the id roll-ups', () => {
    const diff: Diff = {
      changes: [{ id: 'dup1', op: 'modified' }],
      changed_ids: ['dup1'],
      new_ids: ['new1'],
    };
    const s = summarizeDiff(diff);
    expect(s.touched_ids).toEqual(['dup1', 'new1']);
  });

  it('handles an empty diff', () => {
    const s = summarizeDiff({ changes: [] });
    expect(s).toEqual({ changed: 0, added: 0, removed: 0, moved: 0, touched_ids: [] });
  });
});

/* ─────────────────────────── localDiff (ADVISORY ONLY) ──────────────────────────────────────── */

describe('localDiff', () => {
  it('marks the result advisory and is detected by isAdvisoryDiff', () => {
    const out = localDiff([], []);
    expect(out._advisory).toBe(true);
    expect(isAdvisoryDiff(out)).toBe(true);
  });

  it('a committed (non-advisory) Diff is NOT detected as advisory', () => {
    expect(isAdvisoryDiff(VALID_DIFF)).toBe(false);
  });

  it('detects added nodes', () => {
    const before: ElementNode[] = [atomicWidget('a', 'A')];
    const after: ElementNode[] = [atomicWidget('a', 'A'), atomicWidget('b', 'B')];
    const out = localDiff(before, after);
    expect(out.new_ids).toEqual(['b']);
    expect(out.changes.find((c) => c.id === 'b')?.op).toBe('added');
  });

  it('detects removed nodes', () => {
    const before: ElementNode[] = [atomicWidget('a', 'A'), atomicWidget('b', 'B')];
    const after: ElementNode[] = [atomicWidget('a', 'A')];
    const out = localDiff(before, after);
    expect(out.removed_ids).toEqual(['b']);
    expect(out.changes.find((c) => c.id === 'b')?.op).toBe('removed');
  });

  it('detects a modified node body', () => {
    const before: ElementNode[] = [atomicWidget('a', 'A')];
    const after: ElementNode[] = [atomicWidget('a', 'CHANGED')];
    const out = localDiff(before, after);
    expect(out.changed_ids).toEqual(['a']);
    expect(out.changes.find((c) => c.id === 'a')?.op).toBe('modified');
  });

  it('treats round-trip noise (_cssid + empty sibling keys) as NO change (built on normalize)', () => {
    const clean = atomicWidget('a', 'A');
    const noisy: AtomicWidgetNode = {
      id: 'a',
      elType: 'widget',
      widgetType: 'e-heading',
      settings: {
        title: { $$type: 'string', value: 'A' },
        _cssid: { $$type: 'string', value: 'x' },
      },
      styles: {},
      elements: [],
    };
    const out = localDiff([clean], [noisy]);
    expect(out.changes).toHaveLength(0);
    expect(out.changed_ids).toEqual([]);
  });

  it('a parent is modified only for its own body, not because a child changed', () => {
    const mkParent = (childTitle: string): ElementNode => ({
      id: 'parent',
      elType: 'e-div-block',
      settings: {},
      elements: [atomicWidget('child', childTitle)],
    });
    const out = localDiff([mkParent('A')], [mkParent('B')]);
    // child modified; parent body unchanged
    expect(out.changed_ids).toContain('child');
    expect(out.changed_ids).not.toContain('parent');
  });

  it('an identical tree yields an empty diff', () => {
    const tree: ElementNode[] = [atomicWidget('a', 'A'), atomicWidget('b', 'B')];
    const out = localDiff(tree, structuredClone(tree));
    expect(out.changes).toHaveLength(0);
  });
});
