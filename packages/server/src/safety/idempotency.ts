/**
 * WP-T03 — Idempotency / `op_id` minting + replay detection.
 *
 * TS mints idempotency keys ONLY; PHP owns the lock and the replay no-op (`01-architecture.md §7`).
 * A deterministic `op_id` is the contract that makes a write SAFELY RETRYABLE: when the SAME `op_id`
 * is replayed against the SAME target whose state already reflects that op, the plugin returns the
 * prior result with `data.idempotent_replay:true` and does NOT re-apply (`10-rest-api.md §0.8`,
 * `12-error-taxonomy.md §3.2 IDEMPOTENT_REPLAY`).
 *
 * Contract authority:
 *   - `spec/contracts/10-rest-api.md §0.8` — `op_id` regex `^[A-Za-z0-9_.-]{1,64}$`; replay no-op.
 *   - `spec/contracts/12-error-taxonomy.md §3.2 / §5 rule 4` — `IDEMPOTENT_REPLAY` is informational.
 *   - `spec/contracts/13-tool-catalog.md §0.8` — insert/build tools accept `op_id`.
 */

import { createHash, randomBytes } from 'node:crypto';

/** The FROZEN `op_id` shape (`10-rest-api.md §0.8`): 1–64 of `[A-Za-z0-9_.-]`. */
export const OP_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Max length of a minted `op_id` (the regex upper bound). */
const OP_ID_MAX_LEN = 64;

/**
 * Base64url-encode a buffer (RFC 4648 §5): `+`→`-`, `/`→`_`, strip `=` padding. The resulting alphabet
 * is a STRICT subset of the `op_id` alphabet (`[A-Za-z0-9_-]`), so any slice of it matches
 * {@link OP_ID_PATTERN}.
 */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Stable, deterministic JSON serialization: object keys are sorted recursively so two payloads that
 * differ ONLY in key order hash identically. Arrays keep their order (order is semantically meaningful
 * for element trees / ops). Mirrors the round-trip-stable intent of WP-F03 `normalize` for hashing.
 */
export function stableStringify(input: unknown): string {
  return JSON.stringify(sortKeys(input));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeys(v));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable SHA-256 hash of a normalized payload, base64url-encoded (ticket §Interface). Deterministic for
 * structurally-equal inputs regardless of key order; used as the basis of a deterministic `op_id` and
 * directly where a payload fingerprint is wanted (e.g. dedupe). Full 256-bit digest (43 base64url
 * chars) — well within the 64-char `op_id` bound.
 */
export function payloadHash(input: unknown): string {
  return base64url(createHash('sha256').update(stableStringify(input)).digest());
}

/**
 * Mint an `op_id` that ALWAYS matches `^[A-Za-z0-9_.-]{1,64}$` (`10-rest-api.md §0.8`).
 *
 * - DETERMINISTIC mode (`parts` given): a stable hash of the normalized parts, prefixed `op-`. Identical
 *   inputs (any key order) yield the SAME id, so a retried write is recognized by PHP as a replay and
 *   NO-OPed (`§0.8`). This is what insert/build tools pass so a re-run never duplicates work.
 * - RANDOM mode (`parts` omitted): a fresh random id, prefixed `op-`. Use for genuinely new, one-shot
 *   writes where replay-collapse is not wanted.
 *
 * The `op-` prefix is purely cosmetic (still inside the alphabet); the body is a base64url hash/random
 * slice. Result length is fixed at 35 chars (`op-` + 32), comfortably ≤ 64.
 */
export function mintOpId(parts?: readonly unknown[]): string {
  const body =
    parts === undefined
      ? base64url(randomBytes(24))
      : base64url(createHash('sha256').update(stableStringify(parts)).digest());
  const id = `op-${body}`.slice(0, OP_ID_MAX_LEN);
  // Invariant guard: the construction can only produce alphabet chars, but assert so a future change
  // to the prefix/encoding can never silently emit an out-of-spec id.
  if (!OP_ID_PATTERN.test(id)) {
    throw new Error(`mintOpId produced an out-of-spec op_id: ${id}`);
  }
  return id;
}

/** A response (or its `data`) that MAY carry the PHP replay flag (`10-rest-api.md §0.8`). */
export interface MaybeReplay {
  idempotent_replay?: boolean;
}

/**
 * Detect a PHP idempotent-replay no-op (`12-error-taxonomy.md §3.2 IDEMPOTENT_REPLAY`). Reads the
 * `idempotent_replay` flag the plugin sets on a replayed write's `data`. Accepts either the unwrapped
 * `data` object or anything structurally carrying the flag. Tools surface this INFORMATIONALLY (the
 * write already landed; the agent should stop retrying — `§5 rule 4`), not as a hard failure.
 */
export function isReplay(resp: MaybeReplay | null | undefined): boolean {
  return resp != null && resp.idempotent_replay === true;
}
