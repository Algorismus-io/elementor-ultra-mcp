/**
 * WP-F02 — Typed 1:1 route wrappers over {@link WpClient} (Seam B).
 *
 * ONE thin async function per REST route (`10-rest-api.md`, 76 routes). Each delegates to the client:
 * it shapes the typed request into path params / query / body and returns the unwrapped typed `data`.
 * NO business logic, NO tool-shaped logic (`01-architecture.md §1.2`). Tool WPs (WP-T##) and PHP
 * controller WPs (WP-P##) both target THESE signatures; neither reads the other's source.
 *
 * Write wrappers thread `op_id` / `base_hash` straight through from the caller (the client never
 * invents them, `10-rest-api.md §0.8`); `force` overrides lock/autosave 409s.
 *
 * All 74 wrappers are authored up front (even for routes whose controllers/tools land in later waves),
 * so a later route never needs to EDIT this file (`WP-F02` parallelization note).
 */

import type { WpClient } from './client.js';
import type {
  AddWooWidgetRequest,
  AddWooWidgetResponse,
  BackupDocumentRequest,
  BackupDocumentResponse,
  BatchApplyRequest,
  BatchApplyResponse,
  BatchPlanRequest,
  BatchPlanResponse,
  BatchVariablesRequest,
  BatchVariablesResponse,
  BindDynamicRequest,
  BindDynamicResponse,
  BindLoopGridRequest,
  BindLoopGridResponse,
  BindNavWidgetRequest,
  BindNavWidgetResponse,
  BuildFormRequest,
  BuildFormResponse,
  CacheFlushRequest,
  CacheFlushResponse,
  CacheRegenRequest,
  CacheRegenResponse,
  ConditionsConfigResponse,
  CreateDocumentRequest,
  CreateDocumentResponse,
  CreateLoopItemRequest,
  CreateLoopItemResponse,
  CreateNavMenuRequest,
  CreateNavMenuResponse,
  CreatePopupRequest,
  CreatePopupResponse,
  CreateThemeDocRequest,
  CreateThemeDocResponse,
  CreateVariableRequest,
  CreateVariableResponse,
  DeleteDocumentRequest,
  DeleteDocumentResponse,
  DeleteVariableResponse,
  DeployDesignRequest,
  DeployDesignResponse,
  DocumentIdsResponse,
  DryRunRequest,
  DryRunResponse,
  DuplicateDocumentRequest,
  DuplicateDocumentResponse,
  ElementOpsRequest,
  ElementOpsResponse,
  ExportDocumentRequest,
  ExportDocumentResponse,
  GetDocumentRequest,
  GetDocumentResponse,
  GetDocumentSettingsResponse,
  GetDynamicTagResponse,
  GetElementDefaultsResponse,
  GetGlobalColorsResponse,
  GetGlobalFontsResponse,
  GetTemplateResponse,
  GlobalClassesUsageRequest,
  GlobalClassesUsageResponse,
  ImportTemplateRequest,
  ImportTemplateResponse,
  InsertTemplateRequest,
  InsertTemplateResponse,
  ListInstalledFontsResponse,
  InstallFontRequest,
  InstallFontResponse,
  UploadFontZipRequest,
  UploadFontZipResponse,
  KitExportRequest,
  KitExportResponse,
  KitImportRequest,
  KitImportResponse,
  KitRevertRequest,
  KitRevertResponse,
  ListBackupsRequest,
  ListBackupsResponse,
  ListDocumentsRequest,
  ListDocumentsResponse,
  ListDynamicTagsResponse,
  ListFormActionsResponse,
  ListGlobalClassesRequest,
  ListGlobalClassesResponse,
  ListMediaRequest,
  ListMediaResponse,
  ListNavMenusResponse,
  ListTemplatesRequest,
  ListTemplatesResponse,
  ListVariablesResponse,
  LockStatusResponse,
  OpsLogRequest,
  OpsLogResponse,
  PrimeCssRequest,
  PrimeCssResponse,
  PutElementDefaultsRequest,
  PutElementDefaultsResponse,
  PutGlobalClassesRequest,
  PutGlobalClassesResponse,
  PutGlobalColorsRequest,
  PutGlobalColorsResponse,
  PutGlobalFontsRequest,
  PutGlobalFontsResponse,
  RemapIdsRequest,
  RemapIdsResponse,
  ReplaceTreeRequest,
  ReplaceTreeResponse,
  RestoreVariableRequest,
  RestoreVariableResponse,
  RollbackDocumentRequest,
  RollbackDocumentResponse,
  SaveDocumentRequest,
  SaveDocumentResponse,
  SaveTemplateRequest,
  SaveTemplateResponse,
  SchemaBreakpointsResponse,
  SchemaRegisteredTypesResponse,
  SchemaStylesResponse,
  SchemaWidgetResponse,
  SetPopupDisplayRequest,
  SetPopupDisplayResponse,
  SetThemeConditionsRequest,
  SetThemeConditionsResponse,
  SideloadMediaRequest,
  SideloadMediaResponse,
  SiteCapabilitiesResponse,
  SyncV4ToV3Request,
  SyncV4ToV3Response,
  UpdateDocumentSettingsRequest,
  UpdateDocumentSettingsResponse,
  VerifyRenderResponse,
  UpdateVariableRequest,
  UpdateVariableResponse,
  UploadMediaRequest,
  UploadMediaResponse,
  ValidateIdsRequest,
  ValidateIdsResponse,
} from './types.js';

/* ════════════════════════════════════ DOCUMENTS (§2) ════════════════════════════════════ */

export function listDocuments(
  client: WpClient,
  query?: ListDocumentsRequest,
): Promise<ListDocumentsResponse> {
  return client.request('listDocuments', { query: query as Record<string, never> });
}

export function createDocument(
  client: WpClient,
  body: CreateDocumentRequest,
): Promise<CreateDocumentResponse> {
  return client.request('createDocument', { body });
}

export function getDocument(
  client: WpClient,
  id: number,
  query?: GetDocumentRequest,
): Promise<GetDocumentResponse> {
  return client.request('getDocument', {
    pathParams: { id },
    query: query as Record<string, never>,
  });
}

export function getDocumentSettings(
  client: WpClient,
  id: number,
): Promise<GetDocumentSettingsResponse> {
  return client.request('getDocumentSettings', { pathParams: { id } });
}

export function updateDocumentSettings(
  client: WpClient,
  id: number,
  body: UpdateDocumentSettingsRequest,
): Promise<UpdateDocumentSettingsResponse> {
  return client.request('updateDocumentSettings', { pathParams: { id }, body });
}

export function dryRunDocument(
  client: WpClient,
  id: number,
  body: DryRunRequest,
): Promise<DryRunResponse> {
  return client.request('dryRunDocument', { pathParams: { id }, body });
}

export function saveDocument(
  client: WpClient,
  id: number,
  body: SaveDocumentRequest,
): Promise<SaveDocumentResponse> {
  return client.request('saveDocument', { pathParams: { id }, body });
}

export function replaceTree(
  client: WpClient,
  id: number,
  body: ReplaceTreeRequest,
): Promise<ReplaceTreeResponse> {
  return client.request('replaceTree', { pathParams: { id }, body });
}

export function elementOps(
  client: WpClient,
  id: number,
  body: ElementOpsRequest,
): Promise<ElementOpsResponse> {
  return client.request('elementOps', { pathParams: { id }, body });
}

export function primeCss(
  client: WpClient,
  id: number,
  body?: PrimeCssRequest,
): Promise<PrimeCssResponse> {
  return client.request('primeCss', { pathParams: { id }, body: body ?? {} });
}

export function backupDocument(
  client: WpClient,
  id: number,
  body?: BackupDocumentRequest,
): Promise<BackupDocumentResponse> {
  return client.request('backupDocument', { pathParams: { id }, body: body ?? {} });
}

export function listBackups(
  client: WpClient,
  id: number,
  query?: ListBackupsRequest,
): Promise<ListBackupsResponse> {
  return client.request('listBackups', {
    pathParams: { id },
    query: query as Record<string, never>,
  });
}

export function rollbackDocument(
  client: WpClient,
  id: number,
  body: RollbackDocumentRequest,
): Promise<RollbackDocumentResponse> {
  return client.request('rollbackDocument', { pathParams: { id }, body });
}

/** Contract 18 §7-AI S2 — the standalone post-save render-verification probe (op-logged PHP-side). */
export function verifyRenderDocument(client: WpClient, id: number): Promise<VerifyRenderResponse> {
  return client.request('verifyRenderDocument', { pathParams: { id }, body: {} });
}

export function duplicateDocument(
  client: WpClient,
  id: number,
  body?: DuplicateDocumentRequest,
): Promise<DuplicateDocumentResponse> {
  return client.request('duplicateDocument', { pathParams: { id }, body: body ?? {} });
}

export function deleteDocument(
  client: WpClient,
  id: number,
  query?: DeleteDocumentRequest,
): Promise<DeleteDocumentResponse> {
  return client.request('deleteDocument', {
    pathParams: { id },
    query: query as Record<string, never>,
  });
}

export function exportDocument(
  client: WpClient,
  id: number,
  body?: ExportDocumentRequest,
): Promise<ExportDocumentResponse> {
  return client.request('exportDocument', { pathParams: { id }, body: body ?? {} });
}

export function lockStatus(client: WpClient, id: number): Promise<LockStatusResponse> {
  return client.request('lockStatus', { pathParams: { id } });
}

/* ════════════════════════════════════ IDS (§10) ════════════════════════════════════════ */

export function documentIds(client: WpClient, id: number): Promise<DocumentIdsResponse> {
  return client.request('documentIds', { pathParams: { id } });
}

export function validateIds(
  client: WpClient,
  body: ValidateIdsRequest,
): Promise<ValidateIdsResponse> {
  return client.request('validateIds', { body });
}

export function remapIds(client: WpClient, body: RemapIdsRequest): Promise<RemapIdsResponse> {
  return client.request('remapIds', { body });
}

/* ════════════════════════════════════ SCHEMA (§3) ══════════════════════════════════════ */

export function schemaWidget(client: WpClient, type: string): Promise<SchemaWidgetResponse> {
  return client.request('schemaWidget', { pathParams: { type } });
}

export function schemaStyles(client: WpClient): Promise<SchemaStylesResponse> {
  return client.request('schemaStyles');
}

export function schemaRegisteredTypes(client: WpClient): Promise<SchemaRegisteredTypesResponse> {
  return client.request('schemaRegisteredTypes');
}

export function schemaBreakpoints(client: WpClient): Promise<SchemaBreakpointsResponse> {
  return client.request('schemaBreakpoints');
}

/* ════════════════════════════════════ DESIGN (§4) ══════════════════════════════════════ */

export function listGlobalClasses(
  client: WpClient,
  query?: ListGlobalClassesRequest,
): Promise<ListGlobalClassesResponse> {
  return client.request('listGlobalClasses', { query: query as Record<string, never> });
}

export function putGlobalClasses(
  client: WpClient,
  body: PutGlobalClassesRequest,
): Promise<PutGlobalClassesResponse> {
  return client.request('putGlobalClasses', { body });
}

export function globalClassesUsage(
  client: WpClient,
  query?: GlobalClassesUsageRequest,
): Promise<GlobalClassesUsageResponse> {
  return client.request('globalClassesUsage', { query: query as Record<string, never> });
}

export function listVariables(client: WpClient): Promise<ListVariablesResponse> {
  return client.request('listVariables');
}

export function createVariable(
  client: WpClient,
  body: CreateVariableRequest,
): Promise<CreateVariableResponse> {
  return client.request('createVariable', { body });
}

export function updateVariable(
  client: WpClient,
  id: string,
  body: UpdateVariableRequest,
): Promise<UpdateVariableResponse> {
  return client.request('updateVariable', { pathParams: { id }, body });
}

export function deleteVariable(client: WpClient, id: string): Promise<DeleteVariableResponse> {
  return client.request('deleteVariable', { pathParams: { id } });
}

export function restoreVariable(
  client: WpClient,
  id: string,
  body?: RestoreVariableRequest,
): Promise<RestoreVariableResponse> {
  return client.request('restoreVariable', { pathParams: { id }, body: body ?? {} });
}

export function batchVariables(
  client: WpClient,
  body: BatchVariablesRequest,
): Promise<BatchVariablesResponse> {
  return client.request('batchVariables', { body });
}

export function getGlobalColors(client: WpClient): Promise<GetGlobalColorsResponse> {
  return client.request('getGlobalColors');
}

export function putGlobalColors(
  client: WpClient,
  body: PutGlobalColorsRequest,
): Promise<PutGlobalColorsResponse> {
  return client.request('putGlobalColors', { body });
}

export function getGlobalFonts(client: WpClient): Promise<GetGlobalFontsResponse> {
  return client.request('getGlobalFonts');
}

export function putGlobalFonts(
  client: WpClient,
  body: PutGlobalFontsRequest,
): Promise<PutGlobalFontsResponse> {
  return client.request('putGlobalFonts', { body });
}

export function listInstalledFonts(client: WpClient): Promise<ListInstalledFontsResponse> {
  return client.request('listInstalledFonts');
}

export function installFont(
  client: WpClient,
  body: InstallFontRequest,
): Promise<InstallFontResponse> {
  return client.request('installFont', { body });
}

export function uploadFontZip(
  client: WpClient,
  body: UploadFontZipRequest,
): Promise<UploadFontZipResponse> {
  return client.request('uploadFontZip', { body });
}

export function getElementDefaults(client: WpClient): Promise<GetElementDefaultsResponse> {
  return client.request('getElementDefaults');
}

export function putElementDefaults(
  client: WpClient,
  body: PutElementDefaultsRequest,
): Promise<PutElementDefaultsResponse> {
  return client.request('putElementDefaults', { body });
}

export function syncV4ToV3(client: WpClient, body: SyncV4ToV3Request): Promise<SyncV4ToV3Response> {
  return client.request('syncV4ToV3', { body });
}

export function deployDesign(
  client: WpClient,
  body: DeployDesignRequest,
): Promise<DeployDesignResponse> {
  return client.request('deployDesign', { body });
}

/* ════════════════════════════════════ MEDIA (§5) ═══════════════════════════════════════ */

export function listMedia(client: WpClient, query?: ListMediaRequest): Promise<ListMediaResponse> {
  return client.request('listMedia', { query: query as Record<string, never> });
}

export function sideloadMedia(
  client: WpClient,
  body: SideloadMediaRequest,
): Promise<SideloadMediaResponse> {
  return client.request('sideloadMedia', { body });
}

export function uploadMedia(
  client: WpClient,
  body: UploadMediaRequest,
): Promise<UploadMediaResponse> {
  return client.request('uploadMedia', { body });
}

/* ════════════════════════════════════ NAV (§6) ═════════════════════════════════════════ */

export function listNavMenus(client: WpClient): Promise<ListNavMenusResponse> {
  return client.request('listNavMenus');
}

export function createNavMenu(
  client: WpClient,
  body: CreateNavMenuRequest,
): Promise<CreateNavMenuResponse> {
  return client.request('createNavMenu', { body });
}

export function bindNavWidget(
  client: WpClient,
  body: BindNavWidgetRequest,
): Promise<BindNavWidgetResponse> {
  return client.request('bindNavWidget', { body });
}

/* ════════════════════════════════════ TEMPLATES / KITS (§7) ════════════════════════════ */

export function listTemplates(
  client: WpClient,
  query?: ListTemplatesRequest,
): Promise<ListTemplatesResponse> {
  return client.request('listTemplates', { query: query as Record<string, never> });
}

export function getTemplate(client: WpClient, id: number): Promise<GetTemplateResponse> {
  return client.request('getTemplate', { pathParams: { id } });
}

export function saveTemplate(
  client: WpClient,
  body: SaveTemplateRequest,
): Promise<SaveTemplateResponse> {
  return client.request('saveTemplate', { body });
}

export function importTemplate(
  client: WpClient,
  body: ImportTemplateRequest,
): Promise<ImportTemplateResponse> {
  return client.request('importTemplate', { body });
}

export function insertTemplate(
  client: WpClient,
  id: number,
  body: InsertTemplateRequest,
): Promise<InsertTemplateResponse> {
  return client.request('insertTemplate', { pathParams: { id }, body });
}

export function kitExport(client: WpClient, body: KitExportRequest): Promise<KitExportResponse> {
  return client.request('kitExport', { body });
}

export function kitImport(client: WpClient, body: KitImportRequest): Promise<KitImportResponse> {
  return client.request('kitImport', { body });
}

export function kitRevert(client: WpClient, body: KitRevertRequest): Promise<KitRevertResponse> {
  return client.request('kitRevert', { body });
}

/* ════════════════════════════════════ PRO (§8) ═════════════════════════════════════════ */

export function createThemeDoc(
  client: WpClient,
  body: CreateThemeDocRequest,
): Promise<CreateThemeDocResponse> {
  return client.request('createThemeDoc', { body });
}

export function setThemeConditions(
  client: WpClient,
  id: number,
  body: SetThemeConditionsRequest,
): Promise<SetThemeConditionsResponse> {
  return client.request('setThemeConditions', { pathParams: { id }, body });
}

export function getConditionsConfig(client: WpClient): Promise<ConditionsConfigResponse> {
  return client.request('getConditionsConfig');
}

export function createPopup(
  client: WpClient,
  body: CreatePopupRequest,
): Promise<CreatePopupResponse> {
  return client.request('createPopup', { body });
}

export function setPopupDisplay(
  client: WpClient,
  id: number,
  body: SetPopupDisplayRequest,
): Promise<SetPopupDisplayResponse> {
  return client.request('setPopupDisplay', { pathParams: { id }, body });
}

export function buildForm(client: WpClient, body: BuildFormRequest): Promise<BuildFormResponse> {
  return client.request('buildForm', { body });
}

export function listFormActions(client: WpClient): Promise<ListFormActionsResponse> {
  return client.request('listFormActions');
}

export function createLoopItem(
  client: WpClient,
  body: CreateLoopItemRequest,
): Promise<CreateLoopItemResponse> {
  return client.request('createLoopItem', { body });
}

export function bindLoopGrid(
  client: WpClient,
  body: BindLoopGridRequest,
): Promise<BindLoopGridResponse> {
  return client.request('bindLoopGrid', { body });
}

export function bindDynamic(
  client: WpClient,
  body: BindDynamicRequest,
): Promise<BindDynamicResponse> {
  return client.request('bindDynamic', { body });
}

export function listDynamicTags(client: WpClient): Promise<ListDynamicTagsResponse> {
  return client.request('listDynamicTags');
}

export function getDynamicTag(client: WpClient, name: string): Promise<GetDynamicTagResponse> {
  return client.request('getDynamicTag', { pathParams: { name } });
}

export function addWooWidget(
  client: WpClient,
  body: AddWooWidgetRequest,
): Promise<AddWooWidgetResponse> {
  return client.request('addWooWidget', { body });
}

/* ════════════════════════════════════ CACHE (§9) ═══════════════════════════════════════ */

export function cacheRegen(
  client: WpClient,
  body?: CacheRegenRequest,
): Promise<CacheRegenResponse> {
  return client.request('cacheRegen', { body: body ?? {} });
}

export function cacheFlush(
  client: WpClient,
  query?: CacheFlushRequest,
): Promise<CacheFlushResponse> {
  return client.request('cacheFlush', { query: query as Record<string, never> });
}

/* ════════════════════════════════════ OPS (§11) ════════════════════════════════════════ */

export function opsLog(client: WpClient, query?: OpsLogRequest): Promise<OpsLogResponse> {
  return client.request('opsLog', { query: query as Record<string, never> });
}

/* ════════════════════════════════════ SITE (§12) ═══════════════════════════════════════ */

export function getSiteCapabilities(client: WpClient): Promise<SiteCapabilitiesResponse> {
  return client.request('getSiteCapabilities');
}

/* ════════════════════════════════════ BATCH (§13) ══════════════════════════════════════ */

export function batchPlan(client: WpClient, body: BatchPlanRequest): Promise<BatchPlanResponse> {
  return client.request('batchPlan', { body });
}

export function batchApply(client: WpClient, body: BatchApplyRequest): Promise<BatchApplyResponse> {
  return client.request('batchApply', { body });
}
