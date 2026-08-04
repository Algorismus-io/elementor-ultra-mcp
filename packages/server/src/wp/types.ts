/**
 * WP-F02 — Server-side REST seam types.
 *
 * The server's view of Seam B. Re-exports the shared REST request/response + envelope types
 * (`@elementor-ultra/shared`, WP-F02) and overlays the server-only concerns the client needs:
 * per-site auth config ({@link SiteConfig}) and the typed client error ({@link WpClientError}) that
 * carries the frozen {@link McpErrorPayload} (so tool WPs can convert a failure into an `isError`
 * result).
 *
 * The strict authoring node/diff types live in the WP-F03 authoring contract
 * (`../authoring/contract.js`); they are re-exported here under `Authoring*` aliases so tool WPs can
 * overlay them on the loosely-typed REST `ElementNode` where they need the discriminated union.
 *
 * Contract authority: spec/contracts/10-rest-api.md §0.2 (auth), spec/01-architecture.md §6.2
 * (per-site config) / §7 (TS forwards auth, never decides), spec/contracts/12-error-taxonomy.md.
 */

import type { ErrorCode, McpErrorPayload } from '@elementor-ultra/shared';

import type {
  Diff as AuthoringDiff,
  DryRunResult as AuthoringDryRunResult,
  ElementNode as AuthoringElementNode,
  NodeChange as AuthoringNodeChange,
  ValidationError as AuthoringValidationError,
} from '../authoring/contract.js';

/* Re-export the full shared REST surface so tool/controller WPs import from one server-side module. */
export type {
  RestSuccess,
  RestError,
  RestErrorData,
  RestFieldError,
  RestResponse,
  OpId,
  BaseHash,
  Pagination,
  Paginated,
  ElementNode,
  Generation,
  ConditionTuple,
  WatermarkToken,
  RestDiff,
  RestValidationError,
  DocumentListItem,
  ListDocumentsRequest,
  ListDocumentsResponse,
  CreateDocumentRequest,
  CreateDocumentResponse,
  GetDocumentRequest,
  GetDocumentResponse,
  GetDocumentSettingsResponse,
  UpdateDocumentSettingsRequest,
  UpdateDocumentSettingsResponse,
  DryRunRequest,
  DryRunResponse,
  SaveDocumentRequest,
  SaveDocumentResponse,
  SaveWarning,
  RenderProbeResult,
  VerifyRenderResponse,
  ReplaceTreeRequest,
  ReplaceTreeResponse,
  BackupHandle,
  ElementOp,
  ElementOpsRequest,
  ElementOpsResponse,
  PrimeCssRequest,
  PrimeCssResponse,
  BackupDocumentRequest,
  BackupDocumentResponse,
  BackupListItem,
  ListBackupsRequest,
  ListBackupsResponse,
  RollbackDocumentRequest,
  RollbackDocumentResponse,
  DuplicateDocumentRequest,
  DuplicateDocumentResponse,
  DeleteDocumentRequest,
  DeleteDocumentResponse,
  ExportDocumentRequest,
  ExportDocumentResponse,
  LockStatusResponse,
  DocumentIdsResponse,
  ValidateIdsRequest,
  ValidateIdsResponse,
  RemapIdsRequest,
  RemapIdsResponse,
  SchemaWidgetResponse,
  SchemaStylesResponse,
  SchemaRegisteredTypesResponse,
  Breakpoint,
  SchemaBreakpointsResponse,
  ClassVariant,
  GlobalClass,
  ListGlobalClassesRequest,
  ListGlobalClassesResponse,
  GlobalClassesChanges,
  PutGlobalClassesRequest,
  PutGlobalClassesResponse,
  GlobalClassesUsageRequest,
  ClassUsage,
  GlobalClassesUsageResponse,
  DesignVariable,
  ListVariablesResponse,
  CreateVariableRequest,
  CreateVariableResponse,
  UpdateVariableRequest,
  UpdateVariableResponse,
  DeleteVariableResponse,
  RestoreVariableRequest,
  RestoreVariableResponse,
  VariableBatchOp,
  BatchVariablesRequest,
  BatchVariablesResponse,
  KitColor,
  GetGlobalColorsResponse,
  PutGlobalColorsRequest,
  PutGlobalColorsResponse,
  KitFont,
  GetGlobalFontsResponse,
  PutGlobalFontsRequest,
  PutGlobalFontsResponse,
  ListInstalledFontsResponse,
  InstallFontRequest,
  InstallFontResponse,
  UploadFontZipRequest,
  UploadFontZipInstalledFace,
  UploadFontZipResponse,
  GetElementDefaultsResponse,
  PutElementDefaultsRequest,
  PutElementDefaultsResponse,
  SyncV4ToV3Request,
  SyncV4ToV3Response,
  DeployClassesBlock,
  DeployVariablesBlock,
  DeployDesignRequest,
  DeployDesignResponse,
  MediaItem,
  ListMediaRequest,
  ListMediaResponse,
  SideloadMediaRequest,
  SideloadMediaResponse,
  UploadMediaRequest,
  UploadMediaResponse,
  NavMenuItem,
  ListNavMenusResponse,
  NavMenuItemInput,
  CreateNavMenuRequest,
  CreateNavMenuResponse,
  BindNavWidgetRequest,
  BindNavWidgetResponse,
  TemplateListItem,
  ListTemplatesRequest,
  ListTemplatesResponse,
  GetTemplateResponse,
  SaveTemplateRequest,
  SaveTemplateResponse,
  ImportTemplateRequest,
  ImportTemplateResponse,
  InsertTemplateRequest,
  InsertTemplateResponse,
  KitExportRequest,
  KitExportResponse,
  KitImportRequest,
  KitImportResponse,
  KitRevertRequest,
  KitRevertResponse,
  CreateThemeDocRequest,
  CreateThemeDocResponse,
  ThemeConditionConflict,
  SetThemeConditionsRequest,
  SetThemeConditionsResponse,
  ConditionsConfigResponse,
  CreatePopupRequest,
  CreatePopupResponse,
  SetPopupDisplayRequest,
  SetPopupDisplayResponse,
  FormFieldInput,
  FormActionInput,
  BuildFormRequest,
  BuildFormResponse,
  FormAction,
  ListFormActionsResponse,
  CreateLoopItemRequest,
  CreateLoopItemResponse,
  BindLoopGridRequest,
  BindLoopGridResponse,
  BindDynamicRequest,
  BindDynamicResponse,
  DynamicTagItem,
  ListDynamicTagsResponse,
  GetDynamicTagResponse,
  AddWooWidgetRequest,
  AddWooWidgetResponse,
  CacheRegenRequest,
  CacheRegenResponse,
  CacheFlushRequest,
  CacheFlushResponse,
  OpLogEntry,
  OpsLogRequest,
  OpsLogResponse,
  ExperimentState,
  SiteCapabilitiesResponse,
  BatchStep,
  BatchPlanRequest,
  BatchPlanStepResult,
  BatchBackupRequirement,
  BatchPlanResponse,
  BatchApplyStep,
  BatchApplyRequest,
  BatchApplyStepResult,
  BatchApplyResponse,
} from '@elementor-ultra/shared';

/* Strict authoring overlays from WP-F03 (the discriminated node union + rich diff). */
export type {
  AuthoringDiff,
  AuthoringDryRunResult,
  AuthoringElementNode,
  AuthoringNodeChange,
  AuthoringValidationError,
};

/**
 * Per-site connection config (`01-architecture.md §6.2`). The TS server resolves one of these per
 * target site and the client injects `Authorization: Basic <basicToken>` on EVERY call to both
 * `wp/v2/*` and `elementor-ultra/v1/*`. The server makes NO trust decisions — AuthN/Z is PHP's
 * (`01-architecture.md §7`).
 */
export interface SiteConfig {
  /** Site base URL, e.g. `https://example.test` (no trailing slash; the client normalizes). */
  url: string;
  /**
   * Pre-encoded `base64("<wp_user>:<application_password>")` (the value after `Basic `). Optional:
   * when {@link mcpApiKey} is set the client authenticates via `X-MCP-API-Key` instead and this may
   * be absent/empty (PHASE 2 T1 — additive; Basic remains the standalone/dev default).
   */
  basicToken?: string;
  /**
   * PHASE 2 (T1): the WPCursor `X-MCP-API-Key` value. When present the client sends
   * `X-MCP-API-Key: <mcpApiKey>` on every call INSTEAD of `Authorization: Basic <basicToken>`.
   * The companion plugin's additive `determine_current_user` bridge maps it to the least-privilege
   * service user. Falls back to Basic when unset.
   */
  mcpApiKey?: string;
  /** Optional cached capability probe (`GET /site/capabilities`) to short-circuit feature gating. */
  capabilities?: Record<string, unknown>;
}

/**
 * Typed error thrown by the WP client when the plugin returns an error envelope (or the transport
 * fails). Carries the full frozen {@link McpErrorPayload} so tool WPs can convert it into an `isError`
 * tool result (`12-error-taxonomy.md §5`). `httpStatus` is the transport status; `opId` echoes the
 * request `op_id` when the envelope carried one.
 */
export class WpClientError extends Error {
  /** The frozen taxonomy code. */
  readonly code: ErrorCode;
  /** HTTP status of the failing response (0 when the transport itself failed). */
  readonly httpStatus: number;
  /** True ⇒ a backoff retry MAY succeed (transient codes only). */
  readonly retryable: boolean;
  /** The full structured payload (for `isError` conversion / structured content). */
  readonly payload: McpErrorPayload;
  /** Per-field validation errors when the envelope carried `data.errors[]`. */
  readonly fieldErrors: RestFieldErrorLike[] | undefined;
  /** Echoed request `op_id`, when present. */
  readonly opId: string | undefined;

  constructor(
    payload: McpErrorPayload,
    options?: { httpStatus?: number; fieldErrors?: RestFieldErrorLike[]; opId?: string },
  ) {
    super(payload.message);
    this.name = 'WpClientError';
    this.code = payload.code;
    this.httpStatus = options?.httpStatus ?? payload.http_status;
    this.retryable = payload.retryable;
    this.payload = payload;
    this.fieldErrors = options?.fieldErrors;
    this.opId = options?.opId;
  }
}

/** Minimal field-error shape carried on {@link WpClientError} (mirrors the envelope `errors[]`). */
export interface RestFieldErrorLike {
  path: string;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}
