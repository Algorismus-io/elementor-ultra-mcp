/**
 * WP-F05 — Error taxonomy public barrel.
 *
 * Re-exports the frozen `ErrorCode` enum + metadata (codes.ts) and the `McpErrorPayload` type +
 * constructors (payload.ts). The shared package's root entry (`src/index.ts`, owned by WP-F01)
 * re-exports from here so consumers can `import { ErrorCode, McpErrorPayload } from '@elementor-ultra/shared'`.
 *
 * Contract authority: spec/contracts/12-error-taxonomy.md.
 */

export {
  ERROR_CODES,
  ErrorCodes,
  ERROR_CODE_META,
  AUTO_RETRYABLE_CODES,
  CONCURRENCY_CODES,
  SOFT_CODES,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_INTERNAL_ERROR,
  isErrorCode,
  errorCodeMeta,
  isAutoRetryable,
  isConcurrencyCode,
  isSoftCode,
  type ErrorCode,
  type ErrorSurface,
  type ErrorCodeMeta,
} from './codes.js';

export {
  makeErrorPayload,
  formatMetaSummary,
  formatErrorText,
  type McpErrorPayload,
  type ErrorMeta,
  type ErrorMetaByCode,
  type ErrorMetaFor,
  type MakeErrorPayloadOptions,
  // Per-code meta shapes (12-error-taxonomy.md §3).
  type ValidationFailedMeta,
  type AtomicSettingsInvalidMeta,
  type AtomicStylesInvalidMeta,
  type UnknownWidgetTypeMeta,
  type DuplicateElementIdMeta,
  type LocalStyleUnlinkedMeta,
  type ImageSrcXorViolationMeta,
  type HtmlV3StrippedMeta,
  type LockHeldMeta,
  type AutosaveConflictMeta,
  type ConcurrencyStaleHashMeta,
  type IdempotentReplayMeta,
  type BudgetExceededMeta,
  type DuplicatedLabelMeta,
  type InvalidOrderMeta,
  type WatermarkStaleMeta,
  type CapabilityMissingMeta,
  type ExperimentInactiveMeta,
  type AuthFailedMeta,
  type ProRequiredMeta,
  type WooContextInvalidMeta,
  type NotFoundMeta,
  type NotEditableMeta,
  type CssPrimeFailedMeta,
  type ImportRemapFailedMeta,
  type RateLimitedMeta,
  type UpstreamErrorMeta,
  type InternalErrorMeta,
} from './payload.js';
