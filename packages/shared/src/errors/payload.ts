/**
 * WP-F05 — The frozen structured error payload `McpErrorPayload` (12-error-taxonomy.md §2),
 * its per-code `meta` key table (§3), and constructors.
 *
 * Every error — whether surfaced as `isError` text, carried in `DryRunResult.errors[]`, or in
 * `Diff.design_system.modified_labels` — serializes to this shape. It aligns with
 * `schemas/diff.schema.json#/$defs/ValidationError` (code/message/element_id/style_id/prop/retryable).
 *
 * Downstream WPs (WP-F02 REST client, every TS tool WP, the PHP side via the matching JSON Schema)
 * import `McpErrorPayload` and the constructors by these EXACT names.
 */

import { ErrorCodes, ERROR_CODE_META, type ErrorCode, type ErrorSurface } from './codes.js';

/**
 * Open, code-specific structured context (12-error-taxonomy.md §2/§3). Each code documents its
 * expected keys in §3; `ErrorMetaFor` (below) maps codes → their documented key shapes. The wire
 * type stays open (`Record<string, unknown>`) so additive meta keys never break old consumers.
 */
export type ErrorMeta = Record<string, unknown>;

/**
 * The FROZEN structured error payload (12-error-taxonomy.md §2). The TS server renders `message`
 * + a compact `meta` summary into the `isError` result text and ALSO returns the full payload as
 * structured content where the client supports it.
 */
export interface McpErrorPayload {
  /** One of the frozen 29 codes (codes.ts / 12-error-taxonomy.md §6). */
  code: ErrorCode;
  /** Human, actionable. Includes appended parser errors verbatim where applicable. */
  message: string;
  /** The REST status the plugin returned (informational; from ERROR_CODE_META by default). */
  http_status: number;
  /** True ⇒ an identical / backoff retry MAY succeed. */
  retryable: boolean;
  /** Where this lands on the MCP wire: 'protocol' (JSON-RPC error) or 'isError' (tool result). */
  surface: ErrorSurface;
  /** JSON-RPC code; non-null ONLY when `surface === 'protocol'` (e.g. -32602), else null. */
  rpc_code: number | null;
  /** Code-specific structured context (§3 documents the expected keys per code). */
  meta: ErrorMeta;
}

/* -------------------------------------------------------------------------------------------------
 * Per-code meta-key table (12-error-taxonomy.md §3, "meta keys" column).
 *
 * These describe the keys a producer SHOULD populate for each code so consumers know what to read.
 * The runtime payload's `meta` is the open `ErrorMeta`; these types are the documented contract for
 * each code's structured context. Keys are all optional because a producer may not always have every
 * field (e.g. a budget pre-flight without a `kind`).
 * ---------------------------------------------------------------------------------------------- */

/** §3.1 ATOMIC_SETTINGS_INVALID — `Props_Parser` threw on a bad prop. */
export interface AtomicSettingsInvalidMeta {
  element_id?: string;
  prop?: string;
  /** Appended parser errors, verbatim (DO NOT string-match the throw message). */
  parser_errors?: string[];
}

/** §3.1 ATOMIC_STYLES_INVALID — `Style_Parser` threw on a bad style. */
export interface AtomicStylesInvalidMeta {
  element_id?: string;
  style_id?: string;
  parser_errors?: string[];
}

/** §3.1 UNKNOWN_WIDGET_TYPE — widgetType/elType not registered on target. */
export interface UnknownWidgetTypeMeta {
  element_id?: string;
  requested_type?: string;
}

/** §3.1 DUPLICATE_ELEMENT_ID — two nodes share an id. */
export interface DuplicateElementIdMeta {
  element_id?: string;
}

/** §3.1 LOCAL_STYLE_UNLINKED — a styles-map id is absent from the element's `classes` prop. */
export interface LocalStyleUnlinkedMeta {
  element_id?: string;
  style_id?: string;
}

/** §3.1 IMAGE_SRC_XOR_VIOLATION — `image-src` had both or neither id/url. */
export interface ImageSrcXorViolationMeta {
  element_id?: string;
  prop?: string;
}

/** §3.1 HTML_V3_STRIPPED — non-allowlisted inline tags `wp_kses` stripped. */
export interface HtmlV3StrippedMeta {
  element_id?: string;
  stripped_tags?: string[];
}

/** §3.2 LOCK_HELD — `wp_check_post_lock` returned a holder. */
export interface LockHeldMeta {
  post_id?: number;
  locked_by?: string;
  locked_until?: number;
}

/** §3.2 AUTOSAVE_CONFLICT — a newer autosave exists. */
export interface AutosaveConflictMeta {
  post_id?: number;
  autosave_user?: string;
  autosave_ts?: number;
}

/** §3.2 CONCURRENCY_STALE_HASH — optimistic-lock base_hash mismatch. */
export interface ConcurrencyStaleHashMeta {
  post_id?: number;
  expected_hash?: string;
  actual_hash?: string;
}

/** §3.2 IDEMPOTENT_REPLAY — an op_id was already applied; write was a no-op. */
export interface IdempotentReplayMeta {
  op_id?: string;
  post_id?: number;
}

/** §3.3 BUDGET_EXCEEDED — would exceed MAX_ITEMS=1000 (classes|variables). */
export interface BudgetExceededMeta {
  current_count?: number;
  max_allowed?: number;
  kind?: 'classes' | 'variables';
}

/** §3.3 DUPLICATED_LABEL — diff-PUT auto-renamed a duplicate global-class label. */
export interface DuplicatedLabelMeta {
  /** `{ id: { modified: newLabel } }` — the renames the agent must reconcile. */
  modified_labels?: Record<string, { modified: string }>;
}

/** §3.3 INVALID_ORDER — diff-PUT `order` array is not the full, consistent final id list. */
export interface InvalidOrderMeta {
  expected_ids?: string[];
  received_ids?: string[];
}

/** §3.3 WATERMARK_STALE — variables batch op used a stale watermark. */
export interface WatermarkStaleMeta {
  expected_watermark?: number;
  actual_watermark?: number;
}

/** §3.4 CAPABILITY_MISSING — `current_user_can(<cap>)` failed. */
export interface CapabilityMissingMeta {
  capability?: string;
  user_id?: number;
}

/** §3.4 EXPERIMENT_INACTIVE — a required experiment is off. */
export interface ExperimentInactiveMeta {
  /** Slug, e.g. `e_atomic_elements`, `e_classes`, `e_variables`, `e_opt_in_v4_page`, ... */
  experiment?: string;
  required_for?: string;
}

/** §3.4 AUTH_FAILED — App-Password Basic auth rejected. */
export interface AuthFailedMeta {
  reason?: string;
}

/** §3.4 PRO_REQUIRED — a Pro-only surface was requested but Pro is inactive / license-gated. */
export interface ProRequiredMeta {
  feature?: string;
}

/** §3.4 WOO_CONTEXT_INVALID — a Woo widget was placed outside its required theme-builder context. */
export interface WooContextInvalidMeta {
  widget?: string;
  required_context?: string;
  actual_doc_type?: string;
}

/** §3.5 NOT_FOUND — a resource id does not exist. */
export interface NotFoundMeta {
  resource?: string;
  id?: string | number;
}

/** §3.5 NOT_EDITABLE — `!is_editable_by_current_user()` for the document. */
export interface NotEditableMeta {
  post_id?: number;
}

/** §3.5 CSS_PRIME_FAILED — the V4 atomic prime-css step failed. */
export interface CssPrimeFailedMeta {
  post_id?: number;
  approach?: 'loopback' | 'programmatic';
}

/** §3.5 IMPORT_REMAP_FAILED — template/kit import could not remap ids / class relations. */
export interface ImportRemapFailedMeta {
  template_id?: string | number;
}

/** §3.5 RATE_LIMITED — upstream WP/host rate limit. */
export interface RateLimitedMeta {
  retry_after?: number;
}

/** §3.5 UPSTREAM_ERROR — unexpected non-2xx from WP the plugin could not classify. */
export interface UpstreamErrorMeta {
  status?: number;
  body_excerpt?: string;
}

/** §3.5 INTERNAL_ERROR — unhandled server-side fault. */
export interface InternalErrorMeta {
  trace_id?: string;
}

/** §3.1 VALIDATION_FAILED — generic structural pre-filter / aggregate dry_run failure. */
export interface ValidationFailedMeta {
  /** Aligns with diff.schema.json#/$defs/ValidationError items. */
  errors?: Array<{
    code: ErrorCode;
    message: string;
    element_id?: string;
    style_id?: string;
    prop?: string;
    retryable?: boolean;
  }>;
}

/** Contract 18 §7-AI S1 SETTINGS_INVALID — a known document-settings key has a render-fatal shape. */
export interface SettingsInvalidMeta {
  key?: string;
  expected?: string;
  received?: string;
}

/** Contract 18 §7-AI S2 RENDER_FAILED — the post-save render-verification probe failed (soft). */
export interface RenderFailedMeta {
  post_id?: number;
  method?: 'loopback' | 'dispatch';
  http_status?: number | null;
  fatal?: string | null;
}

/**
 * The frozen meta-key table mapping each code → its documented `meta` shape (12-error-taxonomy.md
 * §3). Codes with no documented keys map to the open `ErrorMeta`.
 */
export interface ErrorMetaByCode {
  VALIDATION_FAILED: ValidationFailedMeta;
  SCHEMA_INVALID_PARAMS: { path?: string; expected?: string };
  ATOMIC_SETTINGS_INVALID: AtomicSettingsInvalidMeta;
  ATOMIC_STYLES_INVALID: AtomicStylesInvalidMeta;
  UNKNOWN_WIDGET_TYPE: UnknownWidgetTypeMeta;
  DUPLICATE_ELEMENT_ID: DuplicateElementIdMeta;
  LOCAL_STYLE_UNLINKED: LocalStyleUnlinkedMeta;
  IMAGE_SRC_XOR_VIOLATION: ImageSrcXorViolationMeta;
  HTML_V3_STRIPPED: HtmlV3StrippedMeta;
  SETTINGS_INVALID: SettingsInvalidMeta;
  LOCK_HELD: LockHeldMeta;
  AUTOSAVE_CONFLICT: AutosaveConflictMeta;
  CONCURRENCY_STALE_HASH: ConcurrencyStaleHashMeta;
  IDEMPOTENT_REPLAY: IdempotentReplayMeta;
  BUDGET_EXCEEDED: BudgetExceededMeta;
  DUPLICATED_LABEL: DuplicatedLabelMeta;
  INVALID_ORDER: InvalidOrderMeta;
  WATERMARK_STALE: WatermarkStaleMeta;
  CAPABILITY_MISSING: CapabilityMissingMeta;
  EXPERIMENT_INACTIVE: ExperimentInactiveMeta;
  AUTH_FAILED: AuthFailedMeta;
  PRO_REQUIRED: ProRequiredMeta;
  WOO_CONTEXT_INVALID: WooContextInvalidMeta;
  NOT_FOUND: NotFoundMeta;
  NOT_EDITABLE: NotEditableMeta;
  CSS_PRIME_FAILED: CssPrimeFailedMeta;
  RENDER_FAILED: RenderFailedMeta;
  IMPORT_REMAP_FAILED: ImportRemapFailedMeta;
  RATE_LIMITED: RateLimitedMeta;
  UPSTREAM_ERROR: UpstreamErrorMeta;
  INTERNAL_ERROR: InternalErrorMeta;
}

/** The documented meta shape for a given code (open at runtime via `McpErrorPayload.meta`). */
export type ErrorMetaFor<C extends ErrorCode> = ErrorMetaByCode[C];

/* -------------------------------------------------------------------------------------------------
 * Constructors
 * ---------------------------------------------------------------------------------------------- */

/** Optional overrides for `makeErrorPayload` (defaults come from ERROR_CODE_META). */
export interface MakeErrorPayloadOptions<C extends ErrorCode> {
  /** Code-specific structured context (the §3 keys for `code`). */
  meta?: ErrorMetaFor<C>;
  /** Override the default HTTP status (e.g. the actual status the plugin returned). */
  http_status?: number;
  /** Override the default retryability. */
  retryable?: boolean;
  /** Override the default surface (e.g. re-surface a malformed request as `protocol`). */
  surface?: ErrorSurface;
  /** Override the JSON-RPC code (only meaningful when surface is `protocol`). */
  rpc_code?: number | null;
}

/**
 * Build a frozen-shape `McpErrorPayload` for `code`, pulling `http_status`/`retryable`/`surface`/
 * `rpc_code` defaults from `ERROR_CODE_META` (12-error-taxonomy.md §3) and letting callers override
 * where the live conditions differ (e.g. the actual HTTP status the plugin returned).
 *
 * When `surface` is forced to `protocol` without an explicit `rpc_code`, the code's default rpc_code
 * is used if present, else -32603 (internal). When forced to `isError`, `rpc_code` is nulled unless
 * explicitly provided.
 */
export function makeErrorPayload<C extends ErrorCode>(
  code: C,
  message: string,
  options: MakeErrorPayloadOptions<C> = {},
): McpErrorPayload {
  const defaults = ERROR_CODE_META[code];
  const surface = options.surface ?? defaults.surface;

  let rpc_code: number | null;
  if (options.rpc_code !== undefined) {
    rpc_code = options.rpc_code;
  } else if (surface === 'protocol') {
    rpc_code = defaults.rpc_code ?? -32603;
  } else {
    rpc_code = null;
  }

  return {
    code,
    message,
    http_status: options.http_status ?? defaults.http_status,
    retryable: options.retryable ?? defaults.retryable,
    surface,
    rpc_code,
    meta: (options.meta as ErrorMeta | undefined) ?? {},
  };
}

/**
 * Render a payload's `meta` into a compact, single-line summary appended to the `isError` text
 * (12-error-taxonomy.md §2 "renders the `message` + a compact `meta` summary"). Returns '' when meta
 * is empty.
 */
export function formatMetaSummary(meta: ErrorMeta): string {
  const keys = Object.keys(meta);
  if (keys.length === 0) {
    return '';
  }
  const parts = keys.map((k) => {
    const v = meta[k];
    const rendered =
      v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v);
    return `${k}=${rendered}`;
  });
  return `[${parts.join(', ')}]`;
}

/**
 * The human-facing `isError` result text for a payload: `message` plus a compact meta summary
 * (12-error-taxonomy.md §2). The full payload travels separately as structured content.
 */
export function formatErrorText(payload: McpErrorPayload): string {
  const summary = formatMetaSummary(payload.meta);
  return summary ? `${payload.message} ${summary}` : payload.message;
}

/** Re-export the enum-style code map for ergonomic payload construction at call sites. */
export { ErrorCodes };
