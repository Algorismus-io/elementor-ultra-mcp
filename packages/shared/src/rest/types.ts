/**
 * WP-F02 — Shared REST request/response types (Seam B).
 *
 * Hand-authored, contract-accurate TypeScript types for EVERY route in the frozen REST contract
 * (`spec/contracts/10-rest-api.md`, 76 routes, namespace `elementor-ultra/v1`). The OpenAPI spec
 * (`spec/contracts/openapi.yaml`) is the machine authority; `scripts/gen-openapi-types.mjs` asserts
 * every `operationId` in the YAML has a matching exported `*Request`/`*Response` type here (drift
 * check). Where the two disagree, the Markdown wins.
 *
 * Types ONLY — no runtime HTTP (that lives in `packages/server/src/wp/client.ts`). The `data` payload
 * for each route is the `*Response` interface; the `{success,data}` wrapper is applied by
 * {@link RestSuccess} (envelopes.ts) and unwrapped by the client.
 *
 * `ElementNode` is loosely typed here (the strict authoring tree lives in WP-F03's authoring
 * contract, in `packages/server`; `packages/shared` must not depend on `packages/server`). The
 * server-side `wp/types.ts` re-exports these and overlays the strict F03 node/diff types where it
 * needs them.
 */

/* ─────────────────────────────── cross-cutting field types ──────────────────────────────── */

/**
 * Idempotency token (`10-rest-api.md §0.8`). Every WRITE route accepts an OPTIONAL `op_id`. Branded
 * so a raw string is not silently assignable; mint via {@link asOpId} after validating the pattern.
 * Pattern: `^[A-Za-z0-9_.-]{1,64}$` (`openapi.yaml#/components/schemas/OpId`).
 */
export type OpId = string & { readonly __brand: 'OpId' };

/** Validation pattern for {@link OpId} (`10-rest-api.md §0.8`). */
export const OP_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** True when `value` is a syntactically-valid {@link OpId}. */
export function isOpId(value: string): value is OpId {
  return OP_ID_PATTERN.test(value);
}

/** Brand a validated string as an {@link OpId}. Throws on a malformed value. */
export function asOpId(value: string): OpId {
  if (!isOpId(value)) {
    throw new RangeError(
      `Invalid op_id: ${JSON.stringify(value)} (expected ${OP_ID_PATTERN.source})`,
    );
  }
  return value;
}

/**
 * Optimistic-concurrency token (`10-rest-api.md §0.8`): `md5(get_post_meta($id,'_elementor_data'))`,
 * lowercase 32-char hex, returned by every document READ. Branded for safety.
 * Pattern: `^[a-f0-9]{32}$` (`openapi.yaml#/components/schemas/BaseHash`).
 */
export type BaseHash = string & { readonly __brand: 'BaseHash' };

/** Validation pattern for {@link BaseHash} (`10-rest-api.md §0.8`). */
export const BASE_HASH_PATTERN = /^[a-f0-9]{32}$/;

/** True when `value` is a syntactically-valid {@link BaseHash} (lowercase md5 hex). */
export function isBaseHash(value: string): value is BaseHash {
  return BASE_HASH_PATTERN.test(value);
}

/** Brand a validated string as a {@link BaseHash}. Throws on a malformed value. */
export function asBaseHash(value: string): BaseHash {
  if (!isBaseHash(value)) {
    throw new RangeError(
      `Invalid base_hash: ${JSON.stringify(value)} (expected ${BASE_HASH_PATTERN.source})`,
    );
  }
  return value;
}

/**
 * Pagination REQUEST params for ALL list routes (`10-rest-api.md §0.11`). `limit` defaults to 25,
 * max 100. `cursor` is opaque/server-defined (null/omitted = first page). `fields` projects to only
 * those top-level keys per item.
 */
export interface Pagination {
  /** Page size; default 25, max 100. */
  limit?: number;
  /** Opaque cursor; null/omitted = first page. */
  cursor?: string | null;
  /** Top-level keys to project per item. */
  fields?: string[];
}

/**
 * Pagination RESPONSE envelope for ALL list routes (`10-rest-api.md §0.11`,
 * `openapi.yaml#/components/schemas/Pagination`). `next_cursor: null` ⇒ last page. `total` is the
 * unfiltered count when cheaply computable, else `null`.
 */
export interface Paginated<T> {
  items: T[];
  next_cursor: string | null;
  total: number | null;
}

/**
 * An authoring-contract node (V4 atomic OR V3 classic), loosely typed at this seam
 * (`openapi.yaml#/components/schemas/ElementNode`). The strict, discriminated node union is the WP-F03
 * authoring contract (`packages/server/src/authoring`). `packages/shared` must not depend on
 * `packages/server`, so this is the loose shape; server code overlays the strict type.
 */
export interface ElementNode {
  id: string;
  elType: string;
  widgetType?: string;
  settings?: Record<string, unknown>;
  elements?: ElementNode[];
  styles?: Record<string, unknown>;
  editor_settings?: unknown;
  [key: string]: unknown;
}

/** Element generation hint (`10-rest-api.md §2.3`): V4 atomic vs V3 classic. */
export type Generation = 'v4' | 'v3';

/**
 * Display-condition tuple shared across Pro theme/popup routes (`10-rest-api.md §8`,
 * `openapi.yaml#/components/schemas/ConditionTuple`): `[type, name, sub_name?, sub_id?]` where
 * `type ∈ "include"|"exclude"`. Stored slash-joined via `Conditions_Manager::save_conditions()`.
 */
export type ConditionTuple =
  | [type: 'include' | 'exclude', name: string]
  | [type: 'include' | 'exclude', name: string, sub_name: string]
  | [type: 'include' | 'exclude', name: string, sub_name: string, sub_id: string];

/** Optimistic-concurrency token for the variables service (`10-rest-api.md §4.4`): a monotone int. */
export type WatermarkToken = number;

/**
 * The structured diff shape returned INSIDE document write/validate route payloads
 * (`10-rest-api.md §2.3/§2.6/§14`). Distinct from WP-F03's richer `Diff` (which models per-node
 * `NodeChange[]`); this is the REST-envelope flat shape (`openapi.yaml#/components/schemas/Diff`).
 */
export interface RestDiff {
  changed_ids: string[];
  new_ids: string[];
  removed_ids: string[];
  before: Record<string, ElementNode>;
  after: Record<string, ElementNode>;
}

/** A single structured validation error inside an error envelope's `errors[]` (`10-rest-api.md §0.6`). */
export interface RestValidationError {
  path: string;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

/* ════════════════════════════════════ DOCUMENTS (§2) ════════════════════════════════════ */

/** Document list-item (`10-rest-api.md §2.1`). */
export interface DocumentListItem {
  id: number;
  title: string;
  status: string;
  url: string;
  type: string;
  edit_url: string;
  built_with_elementor: boolean;
}

/** `GET /documents` query (`10-rest-api.md §2.1`). */
export interface ListDocumentsRequest extends Pagination {
  status?: 'any' | 'publish' | 'draft' | 'trash' | 'pending' | 'private';
  post_type?: string | string[];
}

/** `GET /documents` response `data` (`10-rest-api.md §2.1`). */
export type ListDocumentsResponse = Paginated<DocumentListItem>;

/** `POST /documents` body (`10-rest-api.md §2.2`). */
export interface CreateDocumentRequest {
  title?: string;
  post_type?: string;
  template_type?: string;
  status?: 'draft' | 'publish' | 'pending' | 'private';
  op_id?: string;
}

/** `POST /documents` response `data` (`10-rest-api.md §2.2`). */
export interface CreateDocumentResponse {
  id: number;
  edit_url: string;
  status: string;
  type: string;
}

/** `GET /documents/{id}` query (`10-rest-api.md §2.4`). */
export interface GetDocumentRequest {
  depth?: number;
  subtree_id?: string;
  projection?: 'full' | 'summary';
}

/** `GET /documents/{id}` response `data` (`10-rest-api.md §2.4`). */
export interface GetDocumentResponse {
  id: number;
  elements: ElementNode[];
  settings: Record<string, unknown>;
  base_hash: string;
  generation: Generation;
  type: string;
}

/** `GET /documents/{id}/settings` response `data` (`10-rest-api.md §2.5`). */
export interface GetDocumentSettingsResponse {
  settings: Record<string, unknown>;
}

/** `PUT /documents/{id}/settings` body (`10-rest-api.md §2.5`). */
export interface UpdateDocumentSettingsRequest {
  settings: Record<string, unknown>;
  base_hash?: string;
  op_id?: string;
}

/** `PUT /documents/{id}/settings` response `data` (`10-rest-api.md §2.5`). */
export interface UpdateDocumentSettingsResponse {
  success: true;
  settings: Record<string, unknown>;
}

/** `POST /documents/{id}/dry-run` body (`10-rest-api.md §2.3`). `{id}` may be `0` for a new tree. */
export interface DryRunRequest {
  elements: ElementNode[];
  settings?: Record<string, unknown>;
  generation?: Generation;
  want_preview?: boolean;
  op_id?: string;
}

/** `POST /documents/{id}/dry-run` response `data` (validation PASSED) (`10-rest-api.md §2.3`). */
export interface DryRunResponse {
  valid: boolean;
  errors: RestValidationError[];
  diff: RestDiff;
  preview_url: string | null;
  id_collisions: string[];
  generation_detected: Generation;
}

/** Shared body for `save` (`10-rest-api.md §2.6`). `elements` optional when only settings change. */
export interface SaveDocumentRequest {
  elements?: ElementNode[];
  settings?: Record<string, unknown>;
  base_hash?: string;
  op_id?: string;
  prime_css?: boolean;
  force?: boolean;
  backup?: boolean;
  /** Contract 18 §7-AI S2 — run the post-save+prime render-verification probe in the same request. */
  verify_render?: boolean;
}

/** Body for `replace-tree` (`10-rest-api.md §2.6`): `elements` + `base_hash` REQUIRED. */
export interface ReplaceTreeRequest {
  elements: ElementNode[];
  base_hash: string;
  settings?: Record<string, unknown>;
  op_id?: string;
  prime_css?: boolean;
  force?: boolean;
  backup?: boolean;
}

/** Backup handle returned by save/backup (`10-rest-api.md §2.6/§2.8`). */
export interface BackupHandle {
  meta_key: string;
  revision_id: number;
  ts?: number;
  label?: string;
}

/** One writer warning row (contract 18 §7-AI S3 — e.g. `UNBOUND_MENU` on a slug-only nav widget). */
export interface SaveWarning {
  code: string;
  message: string;
  element_id?: string;
}

/** Contract 18 §7-AI S2 — the render-verification probe outcome (`/documents/{id}/verify-render`). */
export interface RenderProbeResult {
  render_verified: boolean;
  /** Which probe ran: HTTP loopback of the permalink, or in-process front-controller dispatch. */
  method: 'loopback' | 'dispatch';
  /** HTTP status of the loopback fetch (null in dispatch mode). */
  http_status: number | null;
  /** The fatal marker / thrown message detected when verification failed, else null. */
  fatal: string | null;
  /** The URL the loopback probe fetched (null in dispatch mode). */
  checked_url: string | null;
}

/** `POST /documents/{id}/verify-render` response `data` (contract 18 §7-AI S2). */
export interface VerifyRenderResponse extends RenderProbeResult {
  id: number;
}

/** Shared response `data` for `save` / `replace-tree` (`10-rest-api.md §2.6`). */
export interface SaveDocumentResponse {
  id: number;
  diff: RestDiff;
  base_hash: string;
  preview_url: string;
  backup_handle: BackupHandle;
  css_primed: boolean;
  prime_required: boolean;
  remapped_ids: Record<string, string>;
  idempotent_replay: boolean;
  op_id: string;
  /** Contract 18 §7-AI S2 — present when `verify_render:true` was requested. */
  render_verified?: boolean;
  /** Contract 18 §7-AI S2 — the probe detail (present alongside `render_verified`). */
  render_probe?: RenderProbeResult;
  /** Contract 18 §7-AI S3 — non-fatal writer warnings (e.g. `UNBOUND_MENU`). */
  warnings?: SaveWarning[];
  /**
   * Drop manifest (workbench feedback 2026-06-11): submitted elements that did NOT survive
   * `Document::save` (e.g. unhydratable widgetTypes). Present only when non-empty — silence
   * means everything persisted.
   */
  dropped_elements?: Array<{
    id: string;
    elType: string;
    widgetType: string | null;
    parent_id: string | null;
    reason: string;
  }>;
}

/** `replace-tree` shares the save response payload (`10-rest-api.md §2.6`). */
export type ReplaceTreeResponse = SaveDocumentResponse;

/** A single granular element op (`10-rest-api.md §14`). Open-ended per op kind. */
export interface ElementOp {
  op:
    | 'insert'
    | 'update_settings'
    | 'move'
    | 'delete'
    | 'set_classes'
    | 'set_local_style'
    | 'bind_dynamic'
    | 'bind_global';
  [key: string]: unknown;
}

/** `POST /documents/{id}/elements` body (`10-rest-api.md §14`): `base_hash` + `ops` REQUIRED. */
export interface ElementOpsRequest {
  base_hash: string;
  ops: ElementOp[];
  force?: boolean;
  prime_css?: boolean;
  op_id?: string;
}

/** `POST /documents/{id}/elements` response `data` (`10-rest-api.md §14`). */
export interface ElementOpsResponse {
  id: number;
  diff: Pick<RestDiff, 'changed_ids' | 'new_ids' | 'removed_ids'>;
  base_hash: string;
  css_primed: boolean;
  remapped_ids: Record<string, string>;
}

/** `POST /documents/{id}/prime-css` body (`10-rest-api.md §2.7`). */
export interface PrimeCssRequest {
  approach?: 'loopback' | 'programmatic' | 'auto';
  breakpoints?: string[];
  op_id?: string;
}

/** `POST /documents/{id}/prime-css` response `data` (`10-rest-api.md §2.7`). */
export interface PrimeCssResponse {
  id: number;
  css_primed: boolean;
  approach_used: 'loopback' | 'programmatic' | 'auto';
  css_files: string[];
  css_bytes: number;
  warnings: string[];
}

/** `POST /documents/{id}/backup` body (`10-rest-api.md §2.8`). */
export interface BackupDocumentRequest {
  label?: string;
  op_id?: string;
}

/** `POST /documents/{id}/backup` response `data` (`10-rest-api.md §2.8`). */
export interface BackupDocumentResponse {
  backup_handle: Required<Pick<BackupHandle, 'meta_key' | 'revision_id' | 'ts' | 'label'>>;
}

/** A backup snapshot list-item (`10-rest-api.md §2.8`). */
export interface BackupListItem {
  meta_key: string;
  ts: number;
  label: string;
  base_hash: string;
}

/** `GET /documents/{id}/backups` query (`10-rest-api.md §2.8`). */
export type ListBackupsRequest = Pagination;

/** `GET /documents/{id}/backups` response `data` (`10-rest-api.md §2.8`). */
export type ListBackupsResponse = Paginated<BackupListItem>;

/** `POST /documents/{id}/rollback` body (`10-rest-api.md §2.8`). */
export interface RollbackDocumentRequest {
  meta_key: string;
  prime_css?: boolean;
  op_id?: string;
}

/** `POST /documents/{id}/rollback` response `data` (`10-rest-api.md §2.8`). */
export interface RollbackDocumentResponse {
  id: number;
  restored_from: string;
  base_hash: string;
  css_primed: boolean;
}

/** `POST /documents/{id}/duplicate` body (`10-rest-api.md §2.9`). */
export interface DuplicateDocumentRequest {
  title?: string;
  status?: 'draft' | 'publish' | 'pending' | 'private';
  op_id?: string;
}

/** `POST /documents/{id}/duplicate` response `data` (`10-rest-api.md §2.9`). */
export interface DuplicateDocumentResponse {
  id: number;
  edit_url: string;
}

/** `DELETE /documents/{id}` query (`10-rest-api.md §2.9`). */
export interface DeleteDocumentRequest {
  force?: boolean;
}

/** `DELETE /documents/{id}` response `data` (`10-rest-api.md §2.9`). */
export interface DeleteDocumentResponse {
  id: number;
  deleted: boolean;
  trashed: boolean;
}

/** `POST /documents/{id}/export` body (empty) (`10-rest-api.md §2.9`). */
export type ExportDocumentRequest = Record<string, never>;

/** `POST /documents/{id}/export` response `data` (library-format JSON) (`10-rest-api.md §2.9`). */
export interface ExportDocumentResponse {
  content: ElementNode[];
  page_settings: Record<string, unknown>;
  type: string;
  version: string;
  global_classes: Record<string, unknown>;
  global_variables: Record<string, unknown>;
}

/** `GET /documents/{id}/lock-status` response `data` (`10-rest-api.md §2.10`). */
export interface LockStatusResponse {
  id: number;
  locked: boolean;
  locked_by: string | null;
  newer_autosave: boolean;
  autosave_ts: number | null;
  autosave_author: string | null;
  base_hash: string;
}

/* ════════════════════════════════════ IDS (§10) ════════════════════════════════════════ */

/** `GET /documents/{id}/ids` response `data` (`10-rest-api.md §10`). */
export interface DocumentIdsResponse {
  ids: string[];
  local_style_ids: string[];
}

/** `POST /ids/validate` body (`10-rest-api.md §10`). */
export interface ValidateIdsRequest {
  elements: ElementNode[];
  against_post_id?: number;
}

/** `POST /ids/validate` response `data` (`10-rest-api.md §10`). */
export interface ValidateIdsResponse {
  valid: boolean;
  collisions: string[];
  duplicate_local_styles: string[];
}

/** `POST /ids/remap` body (`10-rest-api.md §10`). */
export interface RemapIdsRequest {
  elements: ElementNode[];
  against_post_id?: number;
}

/** `POST /ids/remap` response `data` (`10-rest-api.md §10`). */
export interface RemapIdsResponse {
  elements: ElementNode[];
  remapped: Record<string, string>;
}

/* ════════════════════════════════════ SCHEMA (§3) ══════════════════════════════════════ */

/** `GET /schema/widget/{type}` response `data` (`10-rest-api.md §3.1`). Atomic OR classic shape. */
export interface SchemaWidgetResponse {
  type: string;
  generation: Generation;
  is_container?: boolean;
  props_schema?: Record<string, unknown>;
  dynamic_props?: string[];
  version?: string;
  /** Present for classic (V3) widgets instead of `props_schema`. */
  controls?: Record<string, unknown>;
}

/** `GET /schema/styles` response `data` (`10-rest-api.md §3.2`). */
export interface SchemaStylesResponse {
  props: Record<string, unknown>;
  units: Record<string, string[]>;
  states: string[];
}

/** `GET /schema/registered-types` response `data` (`10-rest-api.md §3.3`). */
export interface SchemaRegisteredTypesResponse {
  elements: string[];
  widgets: string[];
  atomic_available: boolean;
  pro_active: boolean;
}

/** A single active breakpoint (`10-rest-api.md §3.4`). */
export interface Breakpoint {
  key: string;
  label?: string;
  direction: 'min' | 'max';
  value: number;
}

/** `GET /schema/breakpoints` response `data` (`10-rest-api.md §3.4`). */
export interface SchemaBreakpointsResponse {
  items: Breakpoint[];
  active_direction: 'min' | 'max';
  desktop_first: boolean;
}

/* ════════════════════════════════════ DESIGN (§4) ══════════════════════════════════════ */

/** Variants are loosely typed at this seam (strict shape is the WP-F03 authoring contract). */
export type ClassVariant = Record<string, unknown>;

/** A global class definition (`10-rest-api.md §4.1`). */
export interface GlobalClass {
  id: string;
  label: string;
  type: 'class';
  variants: ClassVariant[];
}

/** `GET /design/classes` query (`10-rest-api.md §4.1`). */
export interface ListGlobalClassesRequest extends Pagination {
  context?: 'frontend' | 'preview';
}

/** `GET /design/classes` response `data` (`10-rest-api.md §4.1`). */
export interface ListGlobalClassesResponse extends Paginated<GlobalClass> {
  /** FULL current order array (needed to build a valid diff-PUT). */
  order: string[];
}

/**
 * The diff-PUT `changes` block (`10-rest-api.md §4.2`,
 * `openapi.yaml#/components/schemas/GlobalClassesChanges`). `added`/`deleted`/`modified` hold ids;
 * `order` is a boolean flag indicating the order changed.
 */
export interface GlobalClassesChanges {
  added: string[];
  deleted: string[];
  modified: string[];
  order?: boolean;
}

/**
 * `PUT /design/classes` diff-PUT body (`10-rest-api.md §4.2` — EXACT shape, do not reshape).
 * `items` contains ONLY touched ids (added + modified); `order` is the FULL final id list.
 */
export interface PutGlobalClassesRequest {
  context?: 'frontend' | 'preview';
  changes: GlobalClassesChanges;
  items: Record<string, GlobalClass>;
  order: string[];
  op_id?: string;
}

/** `PUT /design/classes` response `data` (`10-rest-api.md §4.2`). */
export interface PutGlobalClassesResponse {
  ok: boolean;
  /** `<id> -> {modified:<newLabel>}` auto-renames the caller MUST reconcile (DUPLICATED_LABEL soft). */
  modified_labels: Record<string, { modified: string }>;
  order: string[];
  total: number;
}

/** `GET /design/classes/usage` query (`10-rest-api.md §4.3`). */
export interface GlobalClassesUsageRequest {
  context?: 'frontend' | 'preview';
}

/** Per-class usage record (`10-rest-api.md §4.3`). */
export interface ClassUsage {
  total: number;
  pages: Array<{ post_id: number; count: number }>;
}

/** `GET /design/classes/usage` response `data` (`10-rest-api.md §4.3`). */
export interface GlobalClassesUsageResponse {
  usage: Record<string, ClassUsage>;
}

/** A design-system variable (`10-rest-api.md §4.4`). */
export interface DesignVariable {
  type: 'global-color-variable' | 'global-font-variable' | 'global-size-variable';
  label: string;
  value: string;
  order?: number;
}

/** `GET /design/variables` response `data` (`10-rest-api.md §4.4`). */
export interface ListVariablesResponse {
  variables: Record<string, DesignVariable>;
  total: number;
  watermark: WatermarkToken;
}

/** `POST /design/variables` body (`10-rest-api.md §4.4`). */
export interface CreateVariableRequest {
  type: 'global-color-variable' | 'global-font-variable' | 'global-size-variable';
  label: string;
  value: string;
  op_id?: string;
}

/** `POST /design/variables` response `data` (`10-rest-api.md §4.4`). */
export interface CreateVariableResponse {
  variable: DesignVariable;
  watermark: WatermarkToken;
}

/** `PUT /design/variables/{id}` body (`10-rest-api.md §4.4`): label + value REQUIRED. */
export interface UpdateVariableRequest {
  label: string;
  value: string;
  order?: number;
  type?: string;
  op_id?: string;
}

/** `PUT /design/variables/{id}` response `data` (`10-rest-api.md §4.4`). */
export interface UpdateVariableResponse {
  variable: DesignVariable;
  watermark: WatermarkToken;
}

/** `DELETE /design/variables/{id}` response `data` (`10-rest-api.md §4.4`). */
export interface DeleteVariableResponse {
  variable: DesignVariable;
  watermark: WatermarkToken;
}

/** `POST /design/variables/{id}/restore` body (`10-rest-api.md §4.4`): overrides optional. */
export interface RestoreVariableRequest {
  label?: string;
  value?: string;
  type?: string;
  op_id?: string;
}

/** `POST /design/variables/{id}/restore` response `data` (`10-rest-api.md §4.4`). */
export interface RestoreVariableResponse {
  variable: DesignVariable;
  watermark: WatermarkToken;
}

/** A single op in a variables batch (`10-rest-api.md §4.4`). */
export interface VariableBatchOp {
  type: 'create' | 'update' | 'delete' | 'restore' | 'reorder';
  id?: string;
  payload?: Record<string, unknown>;
  order?: string[];
}

/** `POST /design/variables/batch` body (`10-rest-api.md §4.4`): `watermark` REQUIRED. */
export interface BatchVariablesRequest {
  watermark: WatermarkToken;
  operations: VariableBatchOp[];
  op_id?: string;
}

/** `POST /design/variables/batch` response `data` (`10-rest-api.md §4.4`). */
export interface BatchVariablesResponse {
  variables: Record<string, DesignVariable>;
  watermark: WatermarkToken;
  total: number;
}

/** A V3 kit color entry (`10-rest-api.md §4.5`). */
export interface KitColor {
  _id: string;
  title: string;
  color: string;
}

/** `GET /design/global-colors` response `data` (`10-rest-api.md §4.5`). */
export interface GetGlobalColorsResponse {
  system_colors: KitColor[];
  custom_colors: KitColor[];
}

/** `PUT /design/global-colors` body (`10-rest-api.md §4.5`). */
export interface PutGlobalColorsRequest {
  system_colors?: KitColor[];
  custom_colors?: KitColor[];
  op_id?: string;
}

/** `PUT /design/global-colors` response `data` (`10-rest-api.md §4.5`). */
export type PutGlobalColorsResponse = GetGlobalColorsResponse;

/** A V3 kit typography entry (`10-rest-api.md §4.5`). Open-ended (typography_* control keys). */
export interface KitFont {
  _id: string;
  title: string;
  [key: string]: unknown;
}

/** `GET /design/global-fonts` response `data` (`10-rest-api.md §4.5`). */
export interface GetGlobalFontsResponse {
  system_typography: KitFont[];
  custom_typography: KitFont[];
}

/** `PUT /design/global-fonts` body (`10-rest-api.md §4.5`). */
export interface PutGlobalFontsRequest {
  system_typography?: KitFont[];
  custom_typography?: KitFont[];
  op_id?: string;
}

/** `PUT /design/global-fonts` response `data` (`10-rest-api.md §4.5`). */
export type PutGlobalFontsResponse = GetGlobalFontsResponse;

/** `GET /design/fonts` response `data` — list of installed non-catalog font families. */
export interface ListInstalledFontsResponse {
  /** Family names installed via `design/fonts/install` (Pro CPT or kit custom_css path). */
  families: string[];
}

/** `POST /design/fonts/install` body (contract 18 §7-AI S4 — NON-catalog faces only). */
export interface InstallFontRequest {
  /** Font bytes: an http(s) URL, a `data:` URI, or raw base64 (woff2/woff/ttf/otf — sniffed). */
  source: string;
  /** The font-family name to register (the exact string atomic `font-family` props should use). */
  family: string;
  /** Numeric weight 1-1000 (or normal/bold). One static face per call. */
  weight?: string | number;
  /** The font-style of this face. */
  style?: 'normal' | 'italic' | 'oblique';
  op_id?: string;
}

/** `POST /design/fonts/install` response `data` (contract 18 §7-AI S4). */
export interface InstallFontResponse {
  /** The resolved family string callers should put in `font-family` props. */
  family: string;
  weight: string;
  style: string;
  /** The REAL format sniffed from the magic bytes (woff2/woff/ttf/otf). */
  format: string;
  attachment_id: number;
  url: string;
  /** Pro Custom Fonts CPT (native enqueue) when available, else the kit custom-CSS string. */
  registered_via: 'pro_custom_fonts' | 'kit_custom_css';
  /** The registered @font-face CSS block. */
  font_face: string;
  warnings: string[];
}

/** `POST /design/fonts/upload-zip` body. */
export interface UploadFontZipRequest {
  /** Base64-encoded ZIP file containing OTF/TTF/WOFF/WOFF2 font files. Family names are read from each file's name table automatically. */
  zip_data: string;
  op_id?: string;
}

export interface UploadFontZipInstalledFace {
  family: string;
  weight: string;
  style: string;
  format: string;
  attachment_id: number;
  url: string;
  registered_via: 'pro_custom_fonts' | 'kit_custom_css';
  font_face: string;
  warnings: string[];
}

/** `POST /design/fonts/upload-zip` response `data`. */
export interface UploadFontZipResponse {
  installed: UploadFontZipInstalledFace[];
  /** Font file names that were skipped (not OTF/TTF/WOFF/WOFF2, or name-table unreadable). */
  skipped: string[];
}

/** `GET /design/element-defaults` response `data` (`10-rest-api.md §4.6`). */
export interface GetElementDefaultsResponse {
  defaults: Record<string, Record<string, unknown>>;
}

/** `PUT /design/element-defaults` body (`10-rest-api.md §4.6`). */
export interface PutElementDefaultsRequest {
  type: string;
  settings: Record<string, unknown>;
  op_id?: string;
}

/** `PUT /design/element-defaults` response `data` (`10-rest-api.md §4.6`). */
export type PutElementDefaultsResponse = GetElementDefaultsResponse;

/** `POST /design/sync-v4-to-v3` body (`10-rest-api.md §4.7`). */
export interface SyncV4ToV3Request {
  variable_id: string;
  op_id?: string;
}

/** `POST /design/sync-v4-to-v3` response `data` (`10-rest-api.md §4.7`). */
export interface SyncV4ToV3Response {
  success: boolean;
  bridge_var: string;
}

/** The classes block of a deploy (`10-rest-api.md §4.8`); diff-PUT-shaped (added/modified/...). */
export interface DeployClassesBlock {
  added?: string[];
  modified?: string[];
  deleted?: string[];
  items?: Record<string, GlobalClass>;
  order?: string[];
}

/** The variables block of a deploy (`10-rest-api.md §4.8`); batch-shaped (operations + watermark). */
export interface DeployVariablesBlock {
  operations?: VariableBatchOp[];
  watermark?: WatermarkToken;
}

/** `POST /design/deploy` body (`10-rest-api.md §4.8`). */
export interface DeployDesignRequest {
  global_classes?: DeployClassesBlock;
  global_variables?: DeployVariablesBlock;
  op_id?: string;
}

/** `POST /design/deploy` response `data` (`10-rest-api.md §4.8`). */
export interface DeployDesignResponse {
  classes: { ok: boolean; modified_labels: Record<string, { modified: string }> };
  variables: { watermark: WatermarkToken };
}

/* ════════════════════════════════════ MEDIA (§5) ═══════════════════════════════════════ */

/** A media attachment list-item (`10-rest-api.md §5.1`). */
export interface MediaItem {
  attachment_id: number;
  url: string;
  title: string;
  alt: string;
  mime: string;
  sizes: Record<string, unknown>;
}

/** `GET /media` query (`10-rest-api.md §5.1`). */
export interface ListMediaRequest extends Pagination {
  query?: string;
  mime?: string;
}

/** `GET /media` response `data` (`10-rest-api.md §5.1`). */
export type ListMediaResponse = Paginated<MediaItem>;

/** `POST /media/sideload` body (`10-rest-api.md §5.2`). */
export interface SideloadMediaRequest {
  url: string;
  alt?: string;
  title?: string;
  op_id?: string;
}

/** `POST /media/sideload` response `data` (`10-rest-api.md §5.2`). */
export interface SideloadMediaResponse {
  attachment_id: number;
  url: string;
  sizes: Record<string, unknown>;
  deduped: boolean;
}

/** `POST /media/upload` JSON body (`10-rest-api.md §5.3`); also accepts multipart/form-data. */
export interface UploadMediaRequest {
  data: string;
  filename: string;
  alt?: string;
  op_id?: string;
}

/** `POST /media/upload` response `data` (`10-rest-api.md §5.3`). */
export interface UploadMediaResponse {
  attachment_id: number;
  url: string;
  sizes: Record<string, unknown>;
}

/* ════════════════════════════════════ NAV (§6) ═════════════════════════════════════════ */

/** A WP nav menu list-item (`10-rest-api.md §6`). */
export interface NavMenuItem {
  term_id: number;
  name: string;
  slug: string;
  count: number;
}

/** `GET /nav/menus` response `data` (`10-rest-api.md §6`). */
export interface ListNavMenusResponse {
  items: NavMenuItem[];
}

/** A nav-menu item to create (`10-rest-api.md §6`). */
export interface NavMenuItemInput {
  title: string;
  url: string;
  parent: number;
  object_id: number;
  type: string;
}

/** `POST /nav/menus` body (`10-rest-api.md §6`). */
export interface CreateNavMenuRequest {
  name: string;
  items: NavMenuItemInput[];
  op_id?: string;
}

/** `POST /nav/menus` response `data` (`10-rest-api.md §6`). */
export interface CreateNavMenuResponse {
  term_id: number;
  item_ids: number[];
}

/** `POST /nav/bind-widget` body (`10-rest-api.md §6`). */
export interface BindNavWidgetRequest {
  post_id: number;
  element_id: string;
  term_id: number;
  base_hash?: string;
  op_id?: string;
}

/** `POST /nav/bind-widget` response `data` (`10-rest-api.md §6`). */
export interface BindNavWidgetResponse {
  success: boolean;
  base_hash: string;
}

/* ════════════════════════════════════ TEMPLATES / KITS (§7) ════════════════════════════ */

/** A template library list-item (`10-rest-api.md §7`). */
export interface TemplateListItem {
  template_id: number;
  title: string;
  type: string;
}

/** `GET /templates` query (`10-rest-api.md §7`). */
export interface ListTemplatesRequest extends Pagination {
  type?: string;
}

/** `GET /templates` response `data` (`10-rest-api.md §7`). */
export type ListTemplatesResponse = Paginated<TemplateListItem>;

/** `GET /templates/{id}` response `data` (`10-rest-api.md §7`). */
export interface GetTemplateResponse {
  template_id: number;
  title: string;
  type: string;
  content: ElementNode[];
  page_settings: Record<string, unknown>;
}

/** `POST /templates` body (`10-rest-api.md §7`). */
export interface SaveTemplateRequest {
  title: string;
  type: string;
  content: ElementNode[];
  page_settings?: Record<string, unknown>;
  op_id?: string;
}

/** `POST /templates` response `data` (`10-rest-api.md §7`). */
export interface SaveTemplateResponse {
  template_id: number;
  type: string;
}

/** `POST /templates/import` body (`10-rest-api.md §7`): one of `file_path`/`content`. */
export interface ImportTemplateRequest {
  file_path?: string;
  content?: Record<string, unknown>;
  import_mode?: string;
  op_id?: string;
}

/** `POST /templates/import` response `data` (`10-rest-api.md §7`). */
export interface ImportTemplateResponse {
  imported_ids: number[];
  warnings: string[];
}

/** `POST /templates/{id}/insert` body (`10-rest-api.md §7`). */
export interface InsertTemplateRequest {
  post_id: number;
  parent_id?: string;
  index?: number;
  content?: ElementNode[];
  base_hash?: string;
  op_id?: string;
}

/** `POST /templates/{id}/insert` response `data` (`10-rest-api.md §7`). */
export interface InsertTemplateResponse {
  success: boolean;
  inserted_ids: string[];
  base_hash: string;
  css_primed: boolean;
}

/** `POST /kit/export` body (`10-rest-api.md §7`). */
export interface KitExportRequest {
  include?: string[];
  kitInfo?: Record<string, unknown>;
  customization?: Record<string, unknown>;
}

/** `POST /kit/export` response `data` (`10-rest-api.md §7`). */
export interface KitExportResponse {
  download_url: string;
  session: string;
}

/** `POST /kit/import` body (`10-rest-api.md §7`). */
export interface KitImportRequest {
  session?: string;
  file_path?: string;
  include?: string[];
  customization?: Record<string, unknown>;
}

/** `POST /kit/import` response `data` (`10-rest-api.md §7`). */
export interface KitImportResponse {
  session: string;
  imported: Record<string, unknown>;
  warnings: string[];
}

/** `POST /kit/revert` body (`10-rest-api.md §7`). */
export interface KitRevertRequest {
  session: string;
}

/** `POST /kit/revert` response `data` (`10-rest-api.md §7`). */
export interface KitRevertResponse {
  reverted: boolean;
}

/* ════════════════════════════════════ PRO (§8) ═════════════════════════════════════════ */

/** `POST /pro/theme` body (`10-rest-api.md §8.1`). */
export interface CreateThemeDocRequest {
  type:
    | 'header'
    | 'footer'
    | 'single-post'
    | 'single-page'
    | 'archive'
    | 'search-results'
    | 'error-404'
    | 'section';
  title: string;
  status?: string;
  location?: string | null;
  elements?: ElementNode[];
  page_settings?: Record<string, unknown>;
  conditions?: ConditionTuple[];
  op_id?: string;
}

/** `POST /pro/theme` response `data` (`10-rest-api.md §8.1`). */
export interface CreateThemeDocResponse {
  post_id: number;
  edit_url: string;
  template_type: string;
  location: string | null;
  conditions_stored: string[];
}

/** A theme-condition conflict record (`10-rest-api.md §8.2`). */
export interface ThemeConditionConflict {
  template_id: number;
  template_title: string;
  edit_url: string;
}

/** `PUT /pro/theme/{id}/conditions` body (`10-rest-api.md §8.2`): REPLACES all conditions. */
export interface SetThemeConditionsRequest {
  conditions: ConditionTuple[];
  check_conflicts?: boolean;
  op_id?: string;
}

/** `PUT /pro/theme/{id}/conditions` response `data` (`10-rest-api.md §8.2`). */
export interface SetThemeConditionsResponse {
  saved: boolean;
  conditions_stored: string[];
  conflicts: ThemeConditionConflict[];
}

/** `GET /pro/theme/conditions-config` response `data` (`10-rest-api.md §8.3`). */
export interface ConditionsConfigResponse {
  tree: Record<string, unknown>;
  id_bearing: string[];
}

/** `POST /pro/popup` body (`10-rest-api.md §8.4`). */
export interface CreatePopupRequest {
  title: string;
  status?: string;
  elements?: ElementNode[];
  layout_settings?: Record<string, unknown>;
  display_settings?: {
    triggers?: Record<string, unknown>;
    timing?: Record<string, unknown>;
  };
  conditions?: ConditionTuple[];
  op_id?: string;
}

/** `POST /pro/popup` response `data` (`10-rest-api.md §8.4`). */
export interface CreatePopupResponse {
  post_id: number;
  edit_url: string;
  display_settings_meta: string;
  conditions_stored: string[];
}

/** `PUT /pro/popup/{id}/display` body (`10-rest-api.md §8.4`): MERGES into existing. */
export interface SetPopupDisplayRequest {
  triggers?: Record<string, unknown>;
  timing?: Record<string, unknown>;
  op_id?: string;
}

/** `PUT /pro/popup/{id}/display` response `data` (`10-rest-api.md §8.4`). */
export interface SetPopupDisplayResponse {
  saved: boolean;
  display_settings: {
    triggers: Record<string, unknown>;
    timing: Record<string, unknown>;
  };
}

/** A form field input (`10-rest-api.md §8.5`). */
export interface FormFieldInput {
  type: string;
  id: string;
  label: string;
  required?: boolean;
  width?: string;
  options?: string[];
  [key: string]: unknown;
}

/** A form action input (`10-rest-api.md §8.5`). */
export interface FormActionInput {
  type: string;
  [key: string]: unknown;
}

/** `POST /pro/form/build` body (`10-rest-api.md §8.5`). */
export interface BuildFormRequest {
  post_id?: number;
  container_id?: string;
  generation?: Generation;
  form_name?: string;
  button_text?: string;
  fields: FormFieldInput[];
  actions: FormActionInput[];
  base_hash?: string;
  op_id?: string;
}

/** `POST /pro/form/build` response `data` (`10-rest-api.md §8.5`). */
export interface BuildFormResponse {
  element: ElementNode;
  applied: boolean;
  base_hash?: string;
  warnings: string[];
}

/** A registered form action (`10-rest-api.md §8.5`). */
export interface FormAction {
  name: string;
  label: string;
  settings_controls: string[];
}

/** `GET /pro/form/actions` response `data` (`10-rest-api.md §8.5`). */
export interface ListFormActionsResponse {
  actions: FormAction[];
}

/** `POST /pro/loop/item` body (`10-rest-api.md §8.6`). */
export interface CreateLoopItemRequest {
  title: string;
  elements?: ElementNode[];
  op_id?: string;
}

/** `POST /pro/loop/item` response `data` (`10-rest-api.md §8.6`). */
export interface CreateLoopItemResponse {
  template_id: number;
  edit_url: string;
}

/** `POST /pro/loop/bind-grid` body (`10-rest-api.md §8.6`). */
export interface BindLoopGridRequest {
  post_id?: number;
  container_id?: string;
  widget?: 'loop-grid' | 'loop-carousel';
  template_id: string;
  skin?: string;
  columns?: string;
  posts_per_page?: number;
  query?: Record<string, unknown>;
  pagination?: Record<string, unknown>;
  base_hash?: string;
  op_id?: string;
}

/** `POST /pro/loop/bind-grid` response `data` (`10-rest-api.md §8.6`). */
export interface BindLoopGridResponse {
  element: ElementNode;
  applied: boolean;
  base_hash: string;
}

/** `POST /pro/dynamic/bind` body (`10-rest-api.md §8.7`). */
export interface BindDynamicRequest {
  post_id: number;
  element_id: string;
  control: string;
  tag: string;
  tag_settings?: Record<string, unknown>;
  fallback_value?: string;
  base_hash?: string;
  op_id?: string;
}

/** `POST /pro/dynamic/bind` response `data` (`10-rest-api.md §8.7`). */
export interface BindDynamicResponse {
  dynamic_string: string;
  applied: boolean;
  base_hash: string;
}

/** A dynamic-tag list-item (`10-rest-api.md §8.7`). */
export interface DynamicTagItem {
  name: string;
  title: string;
  group: string;
  categories: string[];
}

/** `GET /pro/dynamic/tags` response `data` (`10-rest-api.md §8.7`). */
export interface ListDynamicTagsResponse {
  items: DynamicTagItem[];
}

/** `GET /pro/dynamic/tags/{name}` response `data` (`10-rest-api.md §8.7`). */
export interface GetDynamicTagResponse {
  name: string;
  controls: Record<string, unknown>;
  categories: string[];
}

/** `POST /pro/woo/add-widget` body (`10-rest-api.md §8.8`). */
export interface AddWooWidgetRequest {
  post_id: number;
  container_id: string;
  widget: string;
  product_id?: number | null;
  settings?: Record<string, unknown>;
  base_hash?: string;
  op_id?: string;
}

/** `POST /pro/woo/add-widget` response `data` (`10-rest-api.md §8.8`). */
export interface AddWooWidgetResponse {
  element: ElementNode;
  context_ok: boolean;
  context_warning: string | null;
  base_hash: string;
}

/* ════════════════════════════════════ CACHE (§9) ═══════════════════════════════════════ */

/** `POST /cache/regen` body (`10-rest-api.md §9`): omit `post_id` ⇒ global regen. */
export interface CacheRegenRequest {
  post_id?: number;
  network?: boolean;
  op_id?: string;
}

/** `POST /cache/regen` response `data` (`10-rest-api.md §9`). */
export interface CacheRegenResponse {
  regenerated: boolean;
  scope: string;
  post_id?: number;
}

/** `DELETE /cache` query (`10-rest-api.md §9`). */
export interface CacheFlushRequest {
  network?: boolean;
}

/** `DELETE /cache` response `data` (`10-rest-api.md §9`). */
export interface CacheFlushResponse {
  flushed: boolean;
}

/* ════════════════════════════════════ OPS (§11) ════════════════════════════════════════ */

/**
 * An op-log row (`10-rest-api.md §11`). The PHP table allows NULL `op_id` (`op_id varchar(64)
 * DEFAULT NULL`) and writes recorded without a caller-supplied op_id keep it null on the wire (the
 * `ops.log` tool output schema is nullable accordingly); `post_id` is null for global/kit-scoped
 * ops, and `before_hash`/`after_hash` are null on create/insert ops with no prior/after document
 * hash.
 */
export interface OpLogEntry {
  /**
   * WARNING: nullable on the wire (PHP `DEFAULT NULL`); typed `string` only until the `ops.log`
   * projection in `tools/ops.ts` guards it — do not assume a string in new consumers.
   */
  op_id: string;
  post_id: number | null;
  user: string;
  tool: string;
  before_hash: string | null;
  after_hash: string | null;
  result: string;
  ts: number;
}

/** `GET /ops/log` query (`10-rest-api.md §11`). */
export interface OpsLogRequest extends Pagination {
  post_id?: number;
  user?: string;
}

/** `GET /ops/log` response `data` (`10-rest-api.md §11`). */
export type OpsLogResponse = Paginated<OpLogEntry>;

/* ════════════════════════════════════ SITE (§12) ═══════════════════════════════════════ */

/** Experiment activation state (`10-rest-api.md §12`). */
export type ExperimentState = 'active' | 'inactive' | 'default';

/** `GET /site/capabilities` response `data` (`10-rest-api.md §12`). */
export interface SiteCapabilitiesResponse {
  elementor_version: string;
  pro_version: string | null;
  pro_active: boolean;
  atomic_available: boolean;
  v4_default: boolean;
  experiments: Record<string, ExperimentState>;
  global_classes: boolean;
  variables: boolean;
  classes_migrated: boolean;
  can_update_class: boolean;
  unfiltered_html: boolean;
  /**
   * Contract 18 §7 M-g — whether the Pro LICENSE includes the (atomic) custom-css feature. `false`
   * on Pro-active sites whose license lacks it; absent on older companion plugins (treat as `pro`).
   */
  custom_css_licensed?: boolean;
  breakpoints: Breakpoint[];
  registered_types: { elements: string[]; widgets: string[] };
  multisite: boolean;
  is_local: boolean;
  app_passwords_available: boolean;
  abilities_adapter_present: boolean;
  plugin_version: string;
  health: string;
}

/* ════════════════════════════════════ BATCH (§13) ══════════════════════════════════════ */

/** A single step in a batch plan (`10-rest-api.md §13`). */
export interface BatchStep {
  route: string;
  body: Record<string, unknown>;
}

/** `POST /batch/plan` body (`10-rest-api.md §13`). */
export interface BatchPlanRequest {
  steps: BatchStep[];
  op_id?: string;
}

/** A per-step plan result (`10-rest-api.md §13`). */
export interface BatchPlanStepResult {
  step: number;
  route: string;
  valid: boolean;
  diff?: RestDiff;
}

/** A required-backup record (`10-rest-api.md §13`). */
export interface BatchBackupRequirement {
  post_id?: number;
  kit?: boolean;
}

/** `POST /batch/plan` response `data` (`10-rest-api.md §13`). */
export interface BatchPlanResponse {
  plan: BatchPlanStepResult[];
  backups_required: BatchBackupRequirement[];
  valid: boolean;
}

/** A pre-validated plan step to apply (`10-rest-api.md §13`). Mirrors plan output. */
export type BatchApplyStep = BatchPlanStepResult | BatchStep;

/** `POST /batch/apply` body (`10-rest-api.md §13`). */
export interface BatchApplyRequest {
  plan: BatchApplyStep[];
  op_id?: string;
}

/** A per-step apply result (`10-rest-api.md §13`). */
export interface BatchApplyStepResult {
  step: number;
  ok: boolean;
  post_id?: number;
  error?: { code: string; message?: string };
}

/** `POST /batch/apply` response `data` (`10-rest-api.md §13`). */
export interface BatchApplyResponse {
  results: BatchApplyStepResult[];
  compensated: boolean;
}
