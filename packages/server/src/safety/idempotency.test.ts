/**
 * WP-T03 — idempotency / op_id tests.
 *
 * Covers acceptance criteria:
 *   - `mintOpId` ALWAYS matches `^[A-Za-z0-9_.-]{1,64}$` (random + deterministic modes, edge inputs).
 *   - deterministic `mintOpId` is stable for structurally-equal payloads (key order independent) and
 *     differs for different payloads → PHP replay no-op (`10-rest-api.md §0.8`).
 *   - `payloadHash` is stable + key-order independent.
 *   - `isReplay` detects `data.idempotent_replay` (`12-error-taxonomy.md §3.2`).
 */

import { describe, expect, it } from 'vitest';

import { OP_ID_PATTERN, isReplay, mintOpId, payloadHash, stableStringify } from './idempotency.js';

/* ─────────────────────────── mintOpId ───────────────────────────────────────────────────────── */

describe('mintOpId', () => {
  it('random mode always matches the op_id regex', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = mintOpId();
      expect(OP_ID_PATTERN.test(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('random mode produces distinct ids (no fixed collision)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      ids.add(mintOpId());
    }
    expect(ids.size).toBe(500);
  });

  it('deterministic mode is stable for the same parts', () => {
    const a = mintOpId(['page.build', { post_id: 42 }]);
    const b = mintOpId(['page.build', { post_id: 42 }]);
    expect(a).toBe(b);
    expect(OP_ID_PATTERN.test(a)).toBe(true);
  });

  it('deterministic mode is key-order independent (stable hash)', () => {
    const a = mintOpId([{ post_id: 42, title: 'Home', status: 'draft' }]);
    const b = mintOpId([{ status: 'draft', title: 'Home', post_id: 42 }]);
    expect(a).toBe(b);
  });

  it('deterministic mode differs for different payloads', () => {
    const a = mintOpId(['page.build', { post_id: 42 }]);
    const b = mintOpId(['page.build', { post_id: 43 }]);
    expect(a).not.toBe(b);
  });

  it('handles edge-case parts (empty array, nested, unicode) and stays in spec', () => {
    const cases: readonly unknown[][] = [
      [],
      [''],
      [{ deeply: { nested: [1, 2, { x: 'ünîçödé' }] } }],
      [null, undefined, 0, false],
    ];
    for (const parts of cases) {
      const id = mintOpId(parts);
      expect(OP_ID_PATTERN.test(id)).toBe(true);
    }
  });
});

/* ─────────────────────────── payloadHash + stableStringify ──────────────────────────────────── */

describe('payloadHash', () => {
  it('is stable for the same input', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ a: 1, b: 2 }));
  });

  it('is key-order independent', () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it('differs for different inputs', () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });

  it('preserves array order (semantically meaningful)', () => {
    expect(payloadHash([1, 2, 3])).not.toBe(payloadHash([3, 2, 1]));
  });
});

describe('stableStringify', () => {
  it('sorts object keys recursively but preserves array order', () => {
    expect(stableStringify({ b: { d: 1, c: 2 }, a: [3, 1, 2] })).toBe(
      '{"a":[3,1,2],"b":{"c":2,"d":1}}',
    );
  });
});

/* ─────────────────────────── isReplay ───────────────────────────────────────────────────────── */

describe('isReplay', () => {
  it('detects idempotent_replay:true', () => {
    expect(isReplay({ idempotent_replay: true })).toBe(true);
  });

  it('returns false when the flag is false / absent', () => {
    expect(isReplay({ idempotent_replay: false })).toBe(false);
    expect(isReplay({})).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isReplay(null)).toBe(false);
    expect(isReplay(undefined)).toBe(false);
  });
});
