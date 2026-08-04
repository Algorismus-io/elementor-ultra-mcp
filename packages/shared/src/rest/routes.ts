/**
 * WP-F02 — REST route registry (Seam B single source of route metadata).
 *
 * A const map of EVERY route in the frozen REST contract (`spec/contracts/10-rest-api.md §15`,
 * `spec/contracts/openapi.yaml`, 76 routes) keyed by the OpenAPI `operationId`. Each entry carries
 * the HTTP `method`, the `path` (with `{id}` / `{type}` / `{name}` placeholders) under the
 * `elementor-ultra/v1` namespace, and the `cap` gate.
 *
 * This is the ONE place the surface is enumerated — the client, the `wp/routes.ts` wrappers, and the
 * contract drift test (`scripts/gen-openapi-types.mjs`) all read from here. The `operationId` keys
 * MUST stay 1:1 with `openapi.yaml`.
 *
 * Contract authority: spec/contracts/10-rest-api.md §0.1/§0.3/§15, spec/contracts/openapi.yaml.
 */

/** The REST namespace constant (PHP `Plugin::REST_NAMESPACE`) (`10-rest-api.md §0.1`). */
export const REST_NAMESPACE = 'elementor-ultra/v1';

/** Base path segment under `${siteUrl}/wp-json` (`10-rest-api.md §0.1`). */
export const REST_BASE_PATH = `/wp-json/${REST_NAMESPACE}`;

/** HTTP methods used by the contract. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Capability gate id (`10-rest-api.md §0.3`). Each route declares exactly one. The concrete
 * `current_user_can(...)` argument lives in PHP (WP-P01) / the capability contract (WP-F05).
 */
export type CapGate =
  | 'CAP_READ'
  | 'CAP_EDIT_POST'
  | 'CAP_MANAGE'
  | 'CAP_UPDATE_CLASS'
  | 'CAP_UPLOAD';

/** One route descriptor. */
export interface RouteDef {
  method: HttpMethod;
  /** Path under {@link REST_NAMESPACE}, with `{id}`/`{type}`/`{name}` placeholders. */
  path: string;
  cap: CapGate;
}

/**
 * The frozen route registry, keyed by `operationId` (matches `openapi.yaml`). 76 entries.
 * `as const satisfies` keeps the keys/values literal AND type-checks the shape.
 */
export const ROUTES = {
  /* DOCUMENTS (§2) */
  listDocuments: { method: 'GET', path: '/documents', cap: 'CAP_READ' },
  createDocument: { method: 'POST', path: '/documents', cap: 'CAP_EDIT_POST' },
  getDocument: { method: 'GET', path: '/documents/{id}', cap: 'CAP_READ' },
  getDocumentSettings: { method: 'GET', path: '/documents/{id}/settings', cap: 'CAP_READ' },
  updateDocumentSettings: { method: 'PUT', path: '/documents/{id}/settings', cap: 'CAP_EDIT_POST' },
  dryRunDocument: { method: 'POST', path: '/documents/{id}/dry-run', cap: 'CAP_EDIT_POST' },
  saveDocument: { method: 'POST', path: '/documents/{id}/save', cap: 'CAP_EDIT_POST' },
  replaceTree: { method: 'POST', path: '/documents/{id}/replace-tree', cap: 'CAP_EDIT_POST' },
  elementOps: { method: 'POST', path: '/documents/{id}/elements', cap: 'CAP_EDIT_POST' },
  primeCss: { method: 'POST', path: '/documents/{id}/prime-css', cap: 'CAP_EDIT_POST' },
  backupDocument: { method: 'POST', path: '/documents/{id}/backup', cap: 'CAP_EDIT_POST' },
  listBackups: { method: 'GET', path: '/documents/{id}/backups', cap: 'CAP_READ' },
  rollbackDocument: { method: 'POST', path: '/documents/{id}/rollback', cap: 'CAP_EDIT_POST' },
  verifyRenderDocument: { method: 'POST', path: '/documents/{id}/verify-render', cap: 'CAP_READ' },
  duplicateDocument: { method: 'POST', path: '/documents/{id}/duplicate', cap: 'CAP_EDIT_POST' },
  deleteDocument: { method: 'DELETE', path: '/documents/{id}', cap: 'CAP_EDIT_POST' },
  exportDocument: { method: 'POST', path: '/documents/{id}/export', cap: 'CAP_READ' },
  lockStatus: { method: 'GET', path: '/documents/{id}/lock-status', cap: 'CAP_READ' },

  /* IDS (§10) */
  documentIds: { method: 'GET', path: '/documents/{id}/ids', cap: 'CAP_READ' },
  validateIds: { method: 'POST', path: '/ids/validate', cap: 'CAP_READ' },
  remapIds: { method: 'POST', path: '/ids/remap', cap: 'CAP_READ' },

  /* SCHEMA (§3) */
  schemaWidget: { method: 'GET', path: '/schema/widget/{type}', cap: 'CAP_READ' },
  schemaStyles: { method: 'GET', path: '/schema/styles', cap: 'CAP_READ' },
  schemaRegisteredTypes: { method: 'GET', path: '/schema/registered-types', cap: 'CAP_READ' },
  schemaBreakpoints: { method: 'GET', path: '/schema/breakpoints', cap: 'CAP_READ' },

  /* DESIGN (§4) */
  listGlobalClasses: { method: 'GET', path: '/design/classes', cap: 'CAP_READ' },
  putGlobalClasses: { method: 'PUT', path: '/design/classes', cap: 'CAP_UPDATE_CLASS' },
  globalClassesUsage: { method: 'GET', path: '/design/classes/usage', cap: 'CAP_MANAGE' },
  listVariables: { method: 'GET', path: '/design/variables', cap: 'CAP_READ' },
  createVariable: { method: 'POST', path: '/design/variables', cap: 'CAP_MANAGE' },
  updateVariable: { method: 'PUT', path: '/design/variables/{id}', cap: 'CAP_MANAGE' },
  deleteVariable: { method: 'DELETE', path: '/design/variables/{id}', cap: 'CAP_MANAGE' },
  restoreVariable: { method: 'POST', path: '/design/variables/{id}/restore', cap: 'CAP_MANAGE' },
  batchVariables: { method: 'POST', path: '/design/variables/batch', cap: 'CAP_MANAGE' },
  getGlobalColors: { method: 'GET', path: '/design/global-colors', cap: 'CAP_READ' },
  putGlobalColors: { method: 'PUT', path: '/design/global-colors', cap: 'CAP_MANAGE' },
  getGlobalFonts: { method: 'GET', path: '/design/global-fonts', cap: 'CAP_READ' },
  putGlobalFonts: { method: 'PUT', path: '/design/global-fonts', cap: 'CAP_MANAGE' },
  listInstalledFonts: { method: 'GET', path: '/design/fonts', cap: 'CAP_READ' },
  installFont: { method: 'POST', path: '/design/fonts/install', cap: 'CAP_MANAGE' },
  uploadFontZip: { method: 'POST', path: '/design/fonts/upload-zip', cap: 'CAP_MANAGE' },
  getElementDefaults: { method: 'GET', path: '/design/element-defaults', cap: 'CAP_READ' },
  putElementDefaults: { method: 'PUT', path: '/design/element-defaults', cap: 'CAP_MANAGE' },
  syncV4ToV3: { method: 'POST', path: '/design/sync-v4-to-v3', cap: 'CAP_MANAGE' },
  deployDesign: { method: 'POST', path: '/design/deploy', cap: 'CAP_UPDATE_CLASS' },

  /* MEDIA (§5) */
  listMedia: { method: 'GET', path: '/media', cap: 'CAP_READ' },
  sideloadMedia: { method: 'POST', path: '/media/sideload', cap: 'CAP_UPLOAD' },
  uploadMedia: { method: 'POST', path: '/media/upload', cap: 'CAP_UPLOAD' },

  /* NAV (§6) */
  listNavMenus: { method: 'GET', path: '/nav/menus', cap: 'CAP_READ' },
  createNavMenu: { method: 'POST', path: '/nav/menus', cap: 'CAP_MANAGE' },
  bindNavWidget: { method: 'POST', path: '/nav/bind-widget', cap: 'CAP_EDIT_POST' },

  /* TEMPLATES / KITS (§7) */
  listTemplates: { method: 'GET', path: '/templates', cap: 'CAP_READ' },
  getTemplate: { method: 'GET', path: '/templates/{id}', cap: 'CAP_READ' },
  saveTemplate: { method: 'POST', path: '/templates', cap: 'CAP_EDIT_POST' },
  importTemplate: { method: 'POST', path: '/templates/import', cap: 'CAP_MANAGE' },
  insertTemplate: { method: 'POST', path: '/templates/{id}/insert', cap: 'CAP_EDIT_POST' },
  kitExport: { method: 'POST', path: '/kit/export', cap: 'CAP_MANAGE' },
  kitImport: { method: 'POST', path: '/kit/import', cap: 'CAP_MANAGE' },
  kitRevert: { method: 'POST', path: '/kit/revert', cap: 'CAP_MANAGE' },

  /* PRO (§8) */
  createThemeDoc: { method: 'POST', path: '/pro/theme', cap: 'CAP_EDIT_POST' },
  setThemeConditions: { method: 'PUT', path: '/pro/theme/{id}/conditions', cap: 'CAP_EDIT_POST' },
  getConditionsConfig: { method: 'GET', path: '/pro/theme/conditions-config', cap: 'CAP_READ' },
  createPopup: { method: 'POST', path: '/pro/popup', cap: 'CAP_EDIT_POST' },
  setPopupDisplay: { method: 'PUT', path: '/pro/popup/{id}/display', cap: 'CAP_EDIT_POST' },
  buildForm: { method: 'POST', path: '/pro/form/build', cap: 'CAP_EDIT_POST' },
  listFormActions: { method: 'GET', path: '/pro/form/actions', cap: 'CAP_READ' },
  createLoopItem: { method: 'POST', path: '/pro/loop/item', cap: 'CAP_EDIT_POST' },
  bindLoopGrid: { method: 'POST', path: '/pro/loop/bind-grid', cap: 'CAP_EDIT_POST' },
  bindDynamic: { method: 'POST', path: '/pro/dynamic/bind', cap: 'CAP_EDIT_POST' },
  listDynamicTags: { method: 'GET', path: '/pro/dynamic/tags', cap: 'CAP_READ' },
  getDynamicTag: { method: 'GET', path: '/pro/dynamic/tags/{name}', cap: 'CAP_READ' },
  addWooWidget: { method: 'POST', path: '/pro/woo/add-widget', cap: 'CAP_EDIT_POST' },

  /* CACHE (§9) */
  cacheRegen: { method: 'POST', path: '/cache/regen', cap: 'CAP_MANAGE' },
  cacheFlush: { method: 'DELETE', path: '/cache', cap: 'CAP_MANAGE' },

  /* OPS (§11) */
  opsLog: { method: 'GET', path: '/ops/log', cap: 'CAP_MANAGE' },

  /* SITE (§12) */
  getSiteCapabilities: { method: 'GET', path: '/site/capabilities', cap: 'CAP_READ' },

  /* BATCH (§13) */
  batchPlan: { method: 'POST', path: '/batch/plan', cap: 'CAP_EDIT_POST' },
  batchApply: { method: 'POST', path: '/batch/apply', cap: 'CAP_EDIT_POST' },
} as const satisfies Record<string, RouteDef>;

/** The `operationId` of every route in {@link ROUTES}. */
export type RouteName = keyof typeof ROUTES;

/** Frozen list of all route names (75) for enumeration / drift checks. */
export const ROUTE_NAMES = Object.keys(ROUTES) as RouteName[];

/** Total number of routes in the frozen contract. */
export const ROUTE_COUNT: number = ROUTE_NAMES.length;

/** Look up a route descriptor by its `operationId`. */
export function getRoute(name: RouteName): RouteDef {
  return ROUTES[name];
}

/**
 * Build a concrete path by substituting `{id}` / `{type}` / `{name}` placeholders, URL-encoding each
 * value. Leaves the namespace prefix off — the client prepends {@link REST_BASE_PATH}.
 */
export function buildRoutePath(
  name: RouteName,
  params: Record<string, string | number> = {},
): string {
  return ROUTES[name].path.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing path param "${key}" for route "${name}" (${ROUTES[name].path})`);
    }
    return encodeURIComponent(String(value));
  });
}
