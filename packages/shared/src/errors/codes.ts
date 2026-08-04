/**
 * WP-F05 — Frozen error taxonomy: the stable `ErrorCode` enum + per-code metadata.
 *
 * Contract authority: spec/contracts/12-error-taxonomy.md §3 (catalog tables) + §6 (frozen
 * code list). Every error the system surfaces — on the TS side or the PHP side — MUST carry one
 * of these 31 codes. The codes are SCREAMING_SNAKE_CASE and stable forever; downstream WPs import
 * `ErrorCode` and the metadata table by these EXACT names.
 *
 * Cross-language invariant (12-error-taxonomy.md §6, ticket Detailed-Requirements #1): the TS
 * `ERROR_CODES` list, the PHP `Elementor\Ultra\Error_Codes` constants, and the machine-readable
 * `packages/shared/schemas/error-codes.json` MUST contain the identical set. WP-F06/F07 assert
 * this equality. The JSON file is the single source both sides read.
 */

/**
 * Where an error lands on the MCP wire (12-error-taxonomy.md §1):
 * - `protocol` — a JSON-RPC error (e.g. `-32602` Invalid params). The request was malformed.
 * - `isError`  — a normal tool *result* with `isError:true` and actionable text. Runtime/business
 *   failure the agent can react to or fix.
 */
export type ErrorSurface = 'protocol' | 'isError';

/**
 * The frozen set of error codes (12-error-taxonomy.md §6). Declared `as const` so `ErrorCode`
 * derives a precise string-literal union and the list is also usable at runtime (cross-language
 * equality test, schema generation).
 */
export const ERROR_CODES = [
  // §3.1 Validation / authoring
  'VALIDATION_FAILED',
  'SCHEMA_INVALID_PARAMS',
  'ATOMIC_SETTINGS_INVALID',
  'ATOMIC_STYLES_INVALID',
  'UNKNOWN_WIDGET_TYPE',
  'DUPLICATE_ELEMENT_ID',
  'LOCAL_STYLE_UNLINKED',
  'IMAGE_SRC_XOR_VIOLATION',
  'HTML_V3_STRIPPED',
  // Contract 18 §7-AI S1 — document-settings allowlist violation (kills AF1).
  'SETTINGS_INVALID',
  // §3.2 Concurrency / safety
  'LOCK_HELD',
  'AUTOSAVE_CONFLICT',
  'CONCURRENCY_STALE_HASH',
  'IDEMPOTENT_REPLAY',
  // §3.3 Design system / budget
  'BUDGET_EXCEEDED',
  'DUPLICATED_LABEL',
  'INVALID_ORDER',
  'WATERMARK_STALE',
  // §3.4 Capabilities / experiments / auth
  'CAPABILITY_MISSING',
  'EXPERIMENT_INACTIVE',
  'AUTH_FAILED',
  'PRO_REQUIRED',
  'WOO_CONTEXT_INVALID',
  // §3.5 Resource / lifecycle
  'NOT_FOUND',
  'NOT_EDITABLE',
  'CSS_PRIME_FAILED',
  // Contract 18 §7-AI S2 — post-save render verification failed (kills AF2). SOFT: the save
  // succeeded; `render_verified:false` rides the result and is op-logged.
  'RENDER_FAILED',
  'IMPORT_REMAP_FAILED',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'INTERNAL_ERROR',
] as const;

/** The frozen error-code union. 31 SCREAMING_SNAKE_CASE members (12-error-taxonomy.md §6). */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Enum-style const map so callers can write `ErrorCodes.ATOMIC_SETTINGS_INVALID` with full
 * type-narrowing instead of bare string literals. Values equal their keys.
 */
export const ErrorCodes = Object.freeze(
  Object.fromEntries(ERROR_CODES.map((c) => [c, c])) as { [K in ErrorCode]: K },
);

/**
 * Frozen per-code metadata (12-error-taxonomy.md §3 tables, EXACT values).
 * - `http_status` — the REST status the PHP route returns (informational for protocol/TS-only codes).
 * - `retryable`   — true ⇒ an identical / backoff retry MAY succeed (transient).
 * - `surface`     — default MCP surface; a code may be re-surfaced as `protocol` only when the
 *                   failure is genuinely a malformed request.
 * - `rpc_code`    — JSON-RPC error code, set ONLY when `surface === 'protocol'`, else null.
 * - `soft`        — true for the soft/informational codes that ride the diff/report and only
 *                   surface as `isError` when they change semantics the agent must act on
 *                   (12-error-taxonomy.md §5 rule 4: HTML_V3_STRIPPED, DUPLICATED_LABEL,
 *                   IDEMPOTENT_REPLAY).
 */
export interface ErrorCodeMeta {
  readonly http_status: number;
  readonly retryable: boolean;
  readonly surface: ErrorSurface;
  readonly rpc_code: number | null;
  readonly soft: boolean;
}

/** JSON-RPC standard error codes used by `surface:'protocol'` taxonomy codes (12-error-taxonomy.md §1). */
export const RPC_INVALID_PARAMS = -32602;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

/**
 * The frozen metadata table. Values transcribed verbatim from 12-error-taxonomy.md §3.1–§3.5.
 * Keyed by every member of `ErrorCode` (exhaustiveness enforced by the `Record` type).
 */
export const ERROR_CODE_META: Readonly<Record<ErrorCode, ErrorCodeMeta>> = Object.freeze({
  // §3.1 Validation / authoring
  VALIDATION_FAILED: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  SCHEMA_INVALID_PARAMS: {
    http_status: 400,
    retryable: false,
    surface: 'protocol',
    rpc_code: RPC_INVALID_PARAMS,
    soft: false,
  },
  ATOMIC_SETTINGS_INVALID: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  ATOMIC_STYLES_INVALID: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  UNKNOWN_WIDGET_TYPE: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  DUPLICATE_ELEMENT_ID: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  LOCAL_STYLE_UNLINKED: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  IMAGE_SRC_XOR_VIOLATION: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  // HTML_V3_STRIPPED is a soft (non-fatal) 200 outcome reported in CoverageReport.stripped_text.
  HTML_V3_STRIPPED: {
    http_status: 200,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: true,
  },
  // Contract 18 §7-AI S1 — a known document-settings key carries a render-fatal shape (e.g. an
  // object `custom_css` on PAGE settings, the inverse of the style-variant `{raw}` form).
  SETTINGS_INVALID: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },

  // §3.2 Concurrency / safety
  LOCK_HELD: { http_status: 409, retryable: true, surface: 'isError', rpc_code: null, soft: false },
  AUTOSAVE_CONFLICT: {
    http_status: 409,
    retryable: true,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  CONCURRENCY_STALE_HASH: {
    http_status: 409,
    retryable: true,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  // IDEMPOTENT_REPLAY is informational: a no-op replay, returned so the agent stops retrying.
  IDEMPOTENT_REPLAY: {
    http_status: 200,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: true,
  },

  // §3.3 Design system / budget
  BUDGET_EXCEEDED: {
    http_status: 400,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  // DUPLICATED_LABEL is a soft 200: diff-PUT auto-renamed; carried in Diff.design_system.modified_labels.
  DUPLICATED_LABEL: {
    http_status: 200,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: true,
  },
  INVALID_ORDER: {
    http_status: 400,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  WATERMARK_STALE: {
    http_status: 409,
    retryable: true,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },

  // §3.4 Capabilities / experiments / auth
  CAPABILITY_MISSING: {
    http_status: 403,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  EXPERIMENT_INACTIVE: {
    http_status: 409,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  AUTH_FAILED: {
    http_status: 401,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  PRO_REQUIRED: {
    http_status: 409,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  WOO_CONTEXT_INVALID: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },

  // §3.5 Resource / lifecycle
  NOT_FOUND: {
    http_status: 404,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  NOT_EDITABLE: {
    http_status: 403,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  CSS_PRIME_FAILED: {
    http_status: 500,
    retryable: true,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  // Contract 18 §7-AI S2 — the post-save permalink probe failed. SOFT: the save landed;
  // `render_verified:false` rides the result (next to `css_primed`) and is op-logged.
  RENDER_FAILED: {
    http_status: 200,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: true,
  },
  IMPORT_REMAP_FAILED: {
    http_status: 422,
    retryable: false,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  RATE_LIMITED: {
    http_status: 429,
    retryable: true,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  UPSTREAM_ERROR: {
    http_status: 502,
    retryable: true,
    surface: 'isError',
    rpc_code: null,
    soft: false,
  },
  INTERNAL_ERROR: {
    http_status: 500,
    retryable: false,
    surface: 'protocol',
    rpc_code: RPC_INTERNAL_ERROR,
    soft: false,
  },
});

/**
 * Transient codes the TS client (`wp/client.ts`) MAY auto-retry with backoff (12-error-taxonomy.md
 * §5 rule 3). Concurrency codes are retryable:true but are DELIBERATELY excluded — they require an
 * agent decision (re-read / `force`), never an automatic retry.
 */
export const AUTO_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'CSS_PRIME_FAILED',
]);

/**
 * Concurrency codes: retryable:true (a retry MAY succeed) but NEVER auto-retried by the client —
 * they need an agent decision first (12-error-taxonomy.md §5 rule 3).
 */
export const CONCURRENCY_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'LOCK_HELD',
  'AUTOSAVE_CONFLICT',
  'CONCURRENCY_STALE_HASH',
  'WATERMARK_STALE',
]);

/**
 * Soft codes that ride the diff/report and surface as `isError` only when they change semantics the
 * agent must act on (12-error-taxonomy.md §5 rule 4).
 */
export const SOFT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'DUPLICATED_LABEL',
  'HTML_V3_STRIPPED',
  'IDEMPOTENT_REPLAY',
  'RENDER_FAILED',
]);

/** Type guard: is `value` one of the frozen 31 error codes? */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Lookup helper for a code's frozen metadata. */
export function errorCodeMeta(code: ErrorCode): ErrorCodeMeta {
  return ERROR_CODE_META[code];
}

/** True iff the client may auto-retry this code with backoff (transient, non-concurrency). */
export function isAutoRetryable(code: ErrorCode): boolean {
  return AUTO_RETRYABLE_CODES.has(code);
}

/** True iff this code is a concurrency conflict that must NOT be auto-retried. */
export function isConcurrencyCode(code: ErrorCode): boolean {
  return CONCURRENCY_CODES.has(code);
}

/** True iff this code is soft (rides the diff/report unless it changes semantics). */
export function isSoftCode(code: ErrorCode): boolean {
  return SOFT_CODES.has(code);
}
