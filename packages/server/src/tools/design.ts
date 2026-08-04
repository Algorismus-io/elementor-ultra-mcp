/**
 * WP-T07 — design-system tool HANDLERS (Contract 13 §1.4) + attachment to the WP-F04 registry.
 *
 * Implements the design-system tool group and attaches each handler to the WP-F04 {@link ToolRegistry}
 * by EXACT catalog name (13-tool-catalog.md §1.4). WP-F04 owns the descriptors
 * (`catalog/schemas/design.ts`): the SDK validates `args` against `inputSchema` before a handler runs
 * and validates the returned `structuredContent` against `outputSchema` after (Contract 13 §0.1). Each
 * handler receives the single WP-T01 {@link ToolContext}.
 *
 * Families handled here (Contract 13 §1.4 / §5.2 ★):
 *  - global classes — `classes.list` ★ (R), `classes.upsert` ★ (M, diff-PUT), `classes.delete` (D),
 *    `classes.reorder` (M), `classes.usage` (R).
 *  - variables — `variables.list` ★ (R), `.create`/`.update`/`.restore`/`.batch` (M), `.delete` (D);
 *    ALL THREE variable types are FREE (size is NOT Pro-gated, 10-rest-api.md §4.4).
 *  - V3 globals — `globalColors.{list,upsert,delete}`, `globalFonts.{list,upsert,delete}` (R/M/D).
 *  - `fonts.install` (M, contract 18 §7-AI S4 — non-catalog @font-face install).
 *  - `element_defaults.{get,set}` (R/M), `sync_v4_to_v3` (M), `deploy` (D, BOTH).
 *
 * Cross-cutting rules (ticket §Detailed Requirements):
 *  - GATING (S5): `classes.*` + `deploy` write the global-class CPT which requires the
 *    `elementor_global_classes_update_class` capability. Even though companion activation grants it, the
 *    cap MUST still be PROBED via `ctx.capabilities` BEFORE the REST call; absent ⇒ `CAPABILITY_MISSING`
 *    isError with an actionable message (13-tool-catalog.md M6; 12-error-taxonomy.md §3.4).
 *  - DIFF-PUT (§4.2): `classes.upsert`/`.delete`/`.reorder` and `deploy` GET the current ids + FULL
 *    `order` FIRST (§4.1) then build the EXACT `{changes,items,order}` body via {@link buildClassesDiff}
 *    (items touched-only, order full+consistent, deletion never by omission). The 1000-item budget is
 *    pre-flighted CLIENT-side (fast `BUDGET_EXCEEDED`) — PHP also pre-flights (authoritative).
 *  - SOFT DUPLICATED_LABEL (§4.2): a non-empty `modified_labels` in the PUT response is a 200 soft
 *    outcome — surfaced as `modifiedLabels` on the SUCCESS result + a warning instructing the agent to
 *    rebind elements expecting the original label to the renamed id (Contract 12 §3.3 / §5.4).
 *  - WATERMARK (§4.4): variables writes thread the caller's `watermark`; a stale token surfaces as
 *    `WATERMARK_STALE` (retryable, but NO auto-retry — the agent re-reads via `variables.list` and
 *    retries, Contract 12 §5 rule 3). The ONLY REST transport that carries (and enforces) the
 *    watermark is `POST /design/variables/batch` (10-rest-api.md §4.4 — the single-variable
 *    PUT/DELETE/restore routes have NO watermark field), so `variables.update`/`.delete` are routed
 *    through the batch endpoint as single-op batches; `variables.restore` cannot be (Elementor's
 *    `Batch_Processor::op_restore` is broken upstream — see the handler) and uses a client-side
 *    watermark pre-check instead. Client-side id/label/value length limits are FAST pre-checks.
 *  - ELICITATION: destructive tools (`classes.delete`, `variables.delete`, `deploy`) confirm via
 *    `ctx.elicit` when `confirm!=true`; a DECLINE yields a CLEAN non-error result (Contract 12 §5.5).
 *  - CACHE / ATOMIC-CSS: EVERY design write auto-flushes the CSS cache PHP-side (Contract 10 §0.12) —
 *    there is NO separate cache call here — and class-variant changes are ATOMIC-CSS-affecting (the
 *    rendered atomic stylesheet is regenerated on the next prime/flush; locked: design-system WPs are
 *    atomic-CSS-affecting).
 *
 * Contract authority: 13-tool-catalog.md §1.4 (per-tool I/O), §0.6 (pagination), §0.8 (op_id). 10-rest-
 * api.md §4.1 (list + full order), §4.2 (NORMATIVE diff-PUT), §4.4 (variables FREE + watermark + limits),
 * §4.5 (V3 globals), §4.6 (defaults), §4.7 (sync), §4.8 (deploy all-or-nothing). 12-error-taxonomy.md
 * §3.3 (budget/dup-label/order/watermark), §3.4 (capability), §5 (surface rules).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  makeErrorPayload,
  type BatchVariablesRequest,
  type CreateVariableRequest,
  type DeployDesignRequest,
  type DesignVariable,
  type GetGlobalColorsResponse,
  type GetGlobalFontsResponse,
  type KitColor,
  type KitFont,
  type ListGlobalClassesResponse,
  type PutGlobalClassesRequest,
  type RestoreVariableRequest,
  type VariableBatchOp,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import type { ToolRegistry } from '../catalog/registry.js';
import type { StyleDefinition } from '../authoring/contract.js';
import { WpClientError } from '../wp/types.js';
import {
  declinedResult,
  fromClientError,
  toToolErrorResult,
  type ToolResult,
} from '../wp/errors.js';
import { mintOpId } from '../safety/idempotency.js';

import { buildClassesDiff, ClassesDiffError, type ClassesDiffBody } from './design-classes-diff.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.4) ────────────────────────── */

export const DESIGN_CLASSES_LIST = 'elementor.design.classes.list';
export const DESIGN_CLASSES_UPSERT = 'elementor.design.classes.upsert';
export const DESIGN_CLASSES_DELETE = 'elementor.design.classes.delete';
export const DESIGN_CLASSES_REORDER = 'elementor.design.classes.reorder';
export const DESIGN_CLASSES_USAGE = 'elementor.design.classes.usage';
export const DESIGN_VARIABLES_LIST = 'elementor.design.variables.list';
export const DESIGN_VARIABLES_CREATE = 'elementor.design.variables.create';
export const DESIGN_VARIABLES_UPDATE = 'elementor.design.variables.update';
export const DESIGN_VARIABLES_DELETE = 'elementor.design.variables.delete';
export const DESIGN_VARIABLES_RESTORE = 'elementor.design.variables.restore';
export const DESIGN_VARIABLES_BATCH = 'elementor.design.variables.batch';
export const DESIGN_GLOBAL_COLORS_LIST = 'elementor.design.globalColors.list';
export const DESIGN_GLOBAL_COLORS_UPSERT = 'elementor.design.globalColors.upsert';
export const DESIGN_GLOBAL_COLORS_DELETE = 'elementor.design.globalColors.delete';
export const DESIGN_GLOBAL_FONTS_LIST = 'elementor.design.globalFonts.list';
export const DESIGN_GLOBAL_FONTS_UPSERT = 'elementor.design.globalFonts.upsert';
export const DESIGN_GLOBAL_FONTS_DELETE = 'elementor.design.globalFonts.delete';
export const DESIGN_FONTS_INSTALL = 'elementor.design.fonts.install';
export const DESIGN_FONTS_UPLOAD_ZIP = 'elementor.design.fonts.upload_zip';
export const DESIGN_SYNC_V4_TO_V3 = 'elementor.design.sync_v4_to_v3';
export const DESIGN_ELEMENT_DEFAULTS_GET = 'elementor.design.element_defaults.get';
export const DESIGN_ELEMENT_DEFAULTS_SET = 'elementor.design.element_defaults.set';
export const DESIGN_DEPLOY = 'elementor.design.deploy';

/** Every §1.4 tool name this WP owns a handler for (used by attach + tests). */
export const DESIGN_TOOL_NAMES = [
  DESIGN_CLASSES_LIST,
  DESIGN_CLASSES_UPSERT,
  DESIGN_CLASSES_DELETE,
  DESIGN_CLASSES_REORDER,
  DESIGN_CLASSES_USAGE,
  DESIGN_VARIABLES_LIST,
  DESIGN_VARIABLES_CREATE,
  DESIGN_VARIABLES_UPDATE,
  DESIGN_VARIABLES_DELETE,
  DESIGN_VARIABLES_RESTORE,
  DESIGN_VARIABLES_BATCH,
  DESIGN_GLOBAL_COLORS_LIST,
  DESIGN_GLOBAL_COLORS_UPSERT,
  DESIGN_GLOBAL_COLORS_DELETE,
  DESIGN_GLOBAL_FONTS_LIST,
  DESIGN_GLOBAL_FONTS_UPSERT,
  DESIGN_GLOBAL_FONTS_DELETE,
  DESIGN_FONTS_INSTALL,
  DESIGN_FONTS_UPLOAD_ZIP,
  DESIGN_SYNC_V4_TO_V3,
  DESIGN_ELEMENT_DEFAULTS_GET,
  DESIGN_ELEMENT_DEFAULTS_SET,
  DESIGN_DEPLOY,
] as const;

/** The literal capability the global-class CPT writes require (Spike S5; never change the literal). */
export const CAP_UPDATE_CLASS = 'elementor_global_classes_update_class';

/* ───────────────────────────── client-side variable limits (§4.4) ──────────────────────────── */

/** id ≤ 64 chars, label ≤ 50 chars, value ≤ 512 chars (10-rest-api.md §4.4, `rest-api.php:31-33`). */
const VAR_LIMITS = { id: 64, label: 50, value: 512 } as const;

/* ───────────────────────────── result helpers ──────────────────────────────────────────────── */

/** Whether a thrown value is a {@link WpClientError} (carries a taxonomy `payload`). */
function isWpClientError(value: unknown): value is WpClientError {
  return value instanceof WpClientError;
}

/** Build a successful tool result (structured payload + a compact human-readable `text` line). */
function okResult(structured: Record<string, unknown>, text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/**
 * Run a thin design handler: invoke `fn` and, on a {@link WpClientError} (e.g. `BUDGET_EXCEEDED`,
 * `WATERMARK_STALE`, `DUPLICATED_LABEL`, `INVALID_ORDER` from PHP — the authoritative pre-flight),
 * route it through WP-F05's surface rules (`fromClientError` → protocol-throw or `isError` result,
 * 12-error-taxonomy.md §5). A local {@link ClassesDiffError} (client-side pre-flight, never reached
 * REST) maps to the matching taxonomy code. Non-client errors rethrow (the server core surfaces them).
 */
async function runDesign(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (error instanceof ClassesDiffError) {
      return diffErrorResult(error) as CallToolResult;
    }
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/** Map a client-side {@link ClassesDiffError} to the matching taxonomy `isError` result (§3.3). */
function diffErrorResult(error: ClassesDiffError): ToolResult {
  if (error.kind === 'budget_exceeded') {
    return toToolErrorResult(
      makeErrorPayload(ErrorCodes.BUDGET_EXCEEDED, error.message, {
        meta: {
          kind: 'classes',
          ...(error.currentCount !== undefined ? { current_count: error.currentCount } : {}),
          ...(error.maxAllowed !== undefined ? { max_allowed: error.maxAllowed } : {}),
        },
      }),
    );
  }
  return toToolErrorResult(
    makeErrorPayload(ErrorCodes.INVALID_ORDER, error.message, {
      meta: error.ids !== undefined ? { received_ids: error.ids } : {},
    }),
  );
}

/**
 * Probe + assert the `can_update_class` capability BEFORE a REST round-trip (S5; 13-tool-catalog.md M6).
 * Returns a `CAPABILITY_MISSING` isError result when absent (so the caller short-circuits), else null.
 * The probe is required DESPITE the activation grant (the grant is defensive — the cap may be revoked).
 */
async function requireUpdateClass(ctx: ToolContext): Promise<ToolResult | null> {
  const caps = await ctx.capabilities.get();
  if (caps.can_update_class) {
    return null;
  }
  return toToolErrorResult(
    makeErrorPayload(
      ErrorCodes.CAPABILITY_MISSING,
      `This operation writes global classes, which requires the "${CAP_UPDATE_CLASS}" capability. The current user lacks it — re-activate the companion plugin as an administrator (it grants the cap) or ask an admin to run this.`,
      { meta: { capability: CAP_UPDATE_CLASS } },
    ),
  );
}

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (Contract 13 §0.1), so the shapes below describe the POST-validation input — narrowing views over the
 * loose `unknown` the runtime {@link ToolHandler} declares, NOT re-validation. `added`/`modified`/
 * `globalClasses` arrive as `globalClassObjectSchema`-validated objects (= the authoring
 * {@link StyleDefinition} shape).
 */

interface ClassesListArgs {
  context: 'frontend' | 'preview';
  limit: number;
  cursor?: string;
  fields?: string[];
}

interface ClassesUpsertArgs {
  added?: StyleDefinition[];
  modified?: StyleDefinition[];
}

interface ClassesDeleteArgs {
  ids: string[];
  confirm: boolean;
}

interface ClassesReorderArgs {
  order: string[];
}

interface ClassesUsageArgs {
  id?: string;
  limit: number;
  cursor?: string;
  fields?: string[];
}

interface VariablesListArgs {
  limit: number;
  cursor?: string;
  fields?: string[];
}

type VariableType = DesignVariable['type'];

interface VariablesCreateArgs {
  type: VariableType;
  label: string;
  value: string;
}

interface VariablesUpdateArgs {
  id: string;
  label?: string;
  value?: string;
  watermark: number;
}

interface VariablesDeleteArgs {
  id: string;
  watermark: number;
  confirm: boolean;
}

interface VariablesRestoreArgs {
  id: string;
  watermark: number;
}

interface BatchOpArg {
  op: 'create' | 'update' | 'delete' | 'restore';
  id?: string;
  type?: string;
  label?: string;
  value?: string;
}

interface VariablesBatchArgs {
  watermark: number;
  operations: BatchOpArg[];
}

interface GlobalColorsUpsertArgs {
  colors: Array<{ _id?: string; title: string; color: string }>;
  bucket: 'system' | 'custom';
}

interface GlobalColorsDeleteArgs {
  ids: string[];
}

interface GlobalFontsUpsertArgs {
  /** The descriptor names this field `colors` (catalog row reuse), but the items are typography. */
  colors: Array<{ _id?: string; title: string; typography: Record<string, unknown> }>;
  bucket: 'system' | 'custom';
}

interface GlobalFontsDeleteArgs {
  ids: string[];
}

interface FontsInstallArgs {
  source: string;
  family: string;
  weight?: string | number;
  style?: 'normal' | 'italic' | 'oblique';
}

interface FontsUploadZipArgs {
  file_path?: string;
  zip_data?: string;
}

interface SyncV4ToV3Args {
  variable_id: string;
}

interface ElementDefaultsGetArgs {
  type: string;
}

interface ElementDefaultsSetArgs {
  type: string;
  settings: Record<string, unknown>;
}

interface DeployArgs {
  globalClasses?: StyleDefinition[];
  globalVariables?: Array<{ type: string; label: string; value: string }>;
  confirm: boolean;
}

/* ════════════════════════════════════ GLOBAL CLASSES (§4.1-§4.3) ═══════════════════════════ */

/**
 * `elementor.design.classes.list` handler (★, §1.4; 10-rest-api.md §4.1). Proxies
 * `GET /design/classes`: returns the global classes (with variants) + the FULL current `order` (which
 * the agent then feeds back into `classes.upsert`/`.reorder`). Paginated (§0.6). Read-only — no cap
 * gate (GET reads remain available even without `UPDATE_CLASS`, Spike S5).
 */
export async function classesListHandler(
  args: ClassesListArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const data: ListGlobalClassesResponse = await ctx.wp.listGlobalClasses({
      context: args.context,
      limit: args.limit,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.fields !== undefined ? { fields: args.fields } : {}),
    });
    const structured = {
      items: data.items,
      order: data.order,
      next_cursor: data.next_cursor,
      total: data.total ?? data.items.length,
    };
    return okResult(
      structured,
      `Listed ${data.items.length} global class(es)${data.next_cursor !== null ? ' (more available)' : ''}.`,
    );
  });
}

/**
 * `elementor.design.classes.upsert` handler (★, §1.4; 10-rest-api.md §4.2 NORMATIVE). The flagship
 * diff-PUT. Pipeline (ticket §Detailed Requirements 2):
 *  a. GATE on `can_update_class` (S5) — absent ⇒ `CAPABILITY_MISSING` BEFORE any REST.
 *  b. GET the current ids + FULL `order` (`listGlobalClasses`, §4.1 required before PUT).
 *  c. {@link buildClassesDiff} → the EXACT `{changes,items,order}` body (items touched-only, order
 *     full+consistent, no delete-by-omission). Client-side budget pre-flight throws fast on overflow.
 *  d. `putGlobalClasses` (PHP re-validates as styles + re-pre-flights the budget — authoritative).
 *  e. A non-empty `modified_labels` is a 200 soft DUPLICATED_LABEL — surfaced as `modifiedLabels` + a
 *     warning so the agent rebinds elements to the renamed id (§4.2 / Contract 12 §3.3).
 * Auto-flushes the CSS cache PHP-side; class-variant changes are atomic-CSS-affecting (§0.12).
 */
export async function classesUpsertHandler(
  args: ClassesUpsertArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const gate = await requireUpdateClass(ctx);
    if (gate !== null) {
      return gate;
    }

    // (b) GET current ids + FULL order FIRST (§4.1 required before a diff-PUT).
    const current: ListGlobalClassesResponse = await ctx.wp.listGlobalClasses({
      context: 'frontend',
    });

    // (c) Build the EXACT §4.2 diff body (client-side budget pre-flight inside).
    const diff: ClassesDiffBody = buildClassesDiff({
      ...(args.added !== undefined ? { added: args.added } : {}),
      ...(args.modified !== undefined ? { modified: args.modified } : {}),
      currentItems: current.items,
      currentOrder: current.order,
    });

    // (d) PUT the diff (PHP authoritative validation + budget pre-flight + cache flush).
    const body: PutGlobalClassesRequest = {
      context: diff.context,
      changes: diff.changes,
      items: diff.items,
      order: diff.order,
      op_id: mintOpId(['design.classes.upsert', diff.changes, diff.items, diff.order]),
    };
    const resp = await ctx.wp.putGlobalClasses(body);

    // (e) Soft DUPLICATED_LABEL — surface the remap so the agent rebinds.
    const modifiedLabels = resp.modified_labels ?? {};
    const renamed = Object.keys(modifiedLabels);
    const structured: Record<string, unknown> = {
      ok: resp.ok === true,
      order: resp.order,
      total_count: resp.total,
      ...(renamed.length > 0 ? { modifiedLabels } : {}),
    };
    const renameNote =
      renamed.length > 0
        ? ` ${renamed.length} duplicate label(s) auto-renamed — REBIND elements using the original label to the new id(s): ${renamed.map((id) => `${id}→"${modifiedLabels[id]?.modified}"`).join(', ')}.`
        : '';
    return okResult(
      structured,
      `Upserted global classes (${args.added?.length ?? 0} added / ${args.modified?.length ?? 0} modified); ${resp.total} total. Cache auto-flushed (atomic CSS regenerates on next prime).${renameNote}`,
    );
  });
}

/**
 * `elementor.design.classes.delete` handler (D, §1.4; 10-rest-api.md §4.2). EXPLICIT deletion via the
 * diff-PUT `changes.deleted` (NEVER by omission). GATE on `can_update_class`; destructive ⇒ elicit
 * confirm when `confirm!=true` (a DECLINE → clean non-error). GETs the current order first, builds the
 * diff with the full consistent final order, then PUTs.
 */
export async function classesDeleteHandler(
  args: ClassesDeleteArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const gate = await requireUpdateClass(ctx);
    if (gate !== null) {
      return gate;
    }
    if (!args.confirm) {
      const outcome = await ctx.elicit(
        `Delete ${args.ids.length} global class(es) (${args.ids.join(', ')})? Elements referencing them lose their styling. This cannot be undone.`,
      );
      if (!outcome.confirmed) {
        // M-b: decline carries a schema-valid structured payload (no classes were removed).
        return declinedResult(
          'Class deletion cancelled by the user; no global classes were removed.',
          { success: false, order: [] },
        );
      }
    }

    const current: ListGlobalClassesResponse = await ctx.wp.listGlobalClasses({
      context: 'frontend',
    });
    const diff: ClassesDiffBody = buildClassesDiff({
      deleted: args.ids,
      currentItems: current.items,
      currentOrder: current.order,
    });
    const resp = await ctx.wp.putGlobalClasses({
      context: diff.context,
      changes: diff.changes,
      items: diff.items,
      order: diff.order,
      op_id: mintOpId(['design.classes.delete', args.ids, diff.order]),
    });
    return okResult(
      { success: resp.ok === true, order: resp.order },
      `Deleted ${args.ids.length} global class(es); ${resp.total} remain. Cache auto-flushed (atomic CSS regenerates on next prime).`,
    );
  });
}

/**
 * `elementor.design.classes.reorder` handler (M, §1.4; 10-rest-api.md §4.2). Sets the FULL final order
 * with NO add/modify/delete. GATE on `can_update_class`. The caller supplies the complete final id
 * list; we PUT it as the top-level `order` with `changes.order:true` and empty add/modify/delete +
 * empty items (no touched ids). PHP rejects an order that is not the full consistent id list
 * (`E_INVALID_ORDER`).
 */
export async function classesReorderHandler(
  args: ClassesReorderArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const gate = await requireUpdateClass(ctx);
    if (gate !== null) {
      return gate;
    }
    const resp = await ctx.wp.putGlobalClasses({
      context: 'frontend',
      changes: { added: [], deleted: [], modified: [], order: true },
      items: {},
      order: args.order,
      op_id: mintOpId(['design.classes.reorder', args.order]),
    });
    return okResult(
      { success: resp.ok === true },
      `Reordered ${args.order.length} global class(es). Cache auto-flushed.`,
    );
  });
}

/**
 * `elementor.design.classes.usage` handler (R, §1.4; 10-rest-api.md §4.3). Proxies
 * `GET /design/classes/usage` and projects the RAW `{usage: {<id>: {total, pages:[{post_id,count}]}}}`
 * map into the catalog's flat paginated `items:[{id, post_id, element_ids}]` shape (one item per
 * (class,page) pair). The REST route does not page server-side here, so we page the flattened list
 * client-side over the opaque cursor (numeric offset) to honor §0.6.
 */
export async function classesUsageHandler(
  args: ClassesUsageArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const data = await ctx.wp.globalClassesUsage({ context: 'frontend' });
    const usage = data.usage ?? {};
    const all: Array<{ id: string; post_id: number; element_ids: string[] }> = [];
    for (const [id, rec] of Object.entries(usage)) {
      if (args.id !== undefined && id !== args.id) {
        continue;
      }
      for (const page of rec.pages ?? []) {
        all.push({ id, post_id: page.post_id, element_ids: [] });
      }
    }
    const offset = parseCursor(args.cursor);
    const slice = all.slice(offset, offset + args.limit);
    const nextOffset = offset + slice.length;
    const next_cursor = nextOffset < all.length ? String(nextOffset) : null;
    return okResult(
      { items: slice, next_cursor, total: all.length },
      `Found ${all.length} class-usage record(s)${next_cursor !== null ? ' (more available)' : ''}.`,
    );
  });
}

/** Parse the opaque numeric pagination cursor (defaults to 0 for the first page, §0.6). */
function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/* ════════════════════════════════════ VARIABLES (§4.4) ═════════════════════════════════════ */

/** Validate a variable id/label/value against the client-side limits (§4.4) — fast pre-checks. */
function checkVarLimits(parts: { id?: string; label?: string; value?: string }): ToolResult | null {
  const violations: string[] = [];
  if (parts.id !== undefined && parts.id.length > VAR_LIMITS.id) {
    violations.push(`id length ${parts.id.length} > ${VAR_LIMITS.id}`);
  }
  if (parts.label !== undefined && parts.label.length > VAR_LIMITS.label) {
    violations.push(`label length ${parts.label.length} > ${VAR_LIMITS.label}`);
  }
  if (parts.value !== undefined && parts.value.length > VAR_LIMITS.value) {
    violations.push(`value length ${parts.value.length} > ${VAR_LIMITS.value}`);
  }
  if (violations.length === 0) {
    return null;
  }
  return toToolErrorResult(
    makeErrorPayload(
      ErrorCodes.VALIDATION_FAILED,
      `Design variable exceeds the allowed limits (${violations.join('; ')}). Limits: id ≤ ${VAR_LIMITS.id}, label ≤ ${VAR_LIMITS.label}, value ≤ ${VAR_LIMITS.value}.`,
    ),
  );
}

/**
 * Reject a PRESENT-but-blank (trimmed-empty) `label`/`value`, or a `label` containing ANY whitespace,
 * with `SCHEMA_INVALID_PARAMS`. This is a FAST client-side mirror of the companion's
 * `validate_label`/`validate_value` rules — PHP is authoritative and re-runs the same checks on the
 * batch transport (`Variables_Service::validate_batch_payload`, threaded through
 * `translate_batch_operations`), because upstream `Variable::apply_changes()` validates only the
 * PRE-change state (`variable.php:137-154`) and an invalid label/value would otherwise PERSIST as a
 * broken, un-renameable design token. Omitting a field (partial update) stays legal — only a supplied
 * invalid string is rejected. `where` prefixes the message (e.g. `variables.update for g-abc`).
 */
function checkVarNonEmpty(
  parts: { label?: string; value?: string },
  where: string,
): ToolResult | null {
  const problems: { path: string; why: string }[] = [];
  if (parts.label !== undefined) {
    if (parts.label.trim() === '') {
      problems.push({ path: 'label', why: 'label must be a non-empty string when supplied' });
    } else if (/\s/.test(parts.label)) {
      problems.push({
        path: 'label',
        why: 'label must not contain spaces or whitespace (Elementor variable labels are whitespace-free tokens)',
      });
    }
  }
  if (parts.value !== undefined && parts.value.trim() === '') {
    problems.push({ path: 'value', why: 'value must be a non-empty string when supplied' });
  }
  if (problems.length === 0) {
    return null;
  }
  return toToolErrorResult(
    makeErrorPayload(
      ErrorCodes.SCHEMA_INVALID_PARAMS,
      `${where}: ${problems.map((p) => p.why).join('; ')} — an invalid token would be rejected by the companion (and, if it ever persisted, could not be renamed past Elementor's pre-change validation). Omit the field instead to keep its current value.`,
      { meta: { path: problems[0]?.path ?? 'label' } },
    ),
  );
}

/**
 * `elementor.design.variables.list` handler (★, §1.4; 10-rest-api.md §4.4). Proxies
 * `GET /design/variables` and projects the RAW `{variables:{<id>:{type,label,value,order}}}` map into
 * the catalog's flat paginated `items:[{id,type,label,value,order}]` + the optimistic `watermark` the
 * agent threads into every subsequent write. Read-only — no cap gate. Paginated client-side (§0.6).
 */
export async function variablesListHandler(
  args: VariablesListArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const data = await ctx.wp.listVariables();
    const variables = data.variables ?? {};
    const all = Object.entries(variables).map(([id, v]) => ({
      id,
      type: v.type,
      label: v.label,
      value: v.value,
      order: v.order ?? 0,
    }));
    const offset = parseCursor(args.cursor);
    const slice = all.slice(offset, offset + args.limit);
    const nextOffset = offset + slice.length;
    const next_cursor = nextOffset < all.length ? String(nextOffset) : null;
    return okResult(
      { items: slice, next_cursor, total: data.total ?? all.length, watermark: data.watermark },
      `Listed ${slice.length} design variable(s) (watermark ${data.watermark})${next_cursor !== null ? ' — more available' : ''}.`,
    );
  });
}

/**
 * `elementor.design.variables.create` handler (M, §1.4; 10-rest-api.md §4.4). Proxies
 * `POST /design/variables`. ALL THREE variable types are FREE — `global-size-variable` is NOT Pro-gated
 * (§4.4 / `variables/hooks.php:48-51`); this handler treats it identically to color/font. Enforces the
 * client-side label/value limits as a fast pre-check before the REST call. Returns the created variable
 * + the new `watermark`. The variable id is server-assigned (returned in the response).
 */
export async function variablesCreateHandler(
  args: VariablesCreateArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const limit = checkVarLimits({ label: args.label, value: args.value });
    if (limit !== null) {
      return limit;
    }
    const blank = checkVarNonEmpty(
      { label: args.label, value: args.value },
      `variables.create "${args.label}"`,
    );
    if (blank !== null) {
      return blank;
    }
    const body: CreateVariableRequest = {
      type: args.type,
      label: args.label,
      value: args.value,
      op_id: mintOpId(['design.variables.create', args.type, args.label, args.value]),
    };
    const data = await ctx.wp.createVariable(body);
    const created = data.variable as DesignVariable & { id?: string };
    const id = created.id ?? '';
    return okResult(
      {
        variable: { id, type: created.type, label: created.label, value: created.value },
        watermark: data.watermark,
      },
      `Created ${args.type} "${args.label}" (watermark ${data.watermark}). Cache auto-flushed.`,
    );
  });
}

/**
 * `elementor.design.variables.update` handler (M, §1.4; 10-rest-api.md §4.4). Routed through
 * `POST /design/variables/batch` as a single `update` op: the batch route is the ONLY §4.4 transport
 * that carries the `watermark`, and PHP enforces it there (a STALE token → `WATERMARK_STALE` via the
 * client error path; retryable, NO auto-retry — the agent re-reads via `variables.list` and retries).
 * The single-variable `PUT /design/variables/{id}` has no watermark field AND requires `label`+`value`,
 * whereas the batch `update` payload is a PARTIAL merge (omitted fields keep their current values) —
 * matching the catalog's optional `label`/`value`. Returns the new `watermark`.
 */
export async function variablesUpdateHandler(
  args: VariablesUpdateArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const limit = checkVarLimits({
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.value !== undefined ? { value: args.value } : {}),
    });
    if (limit !== null) {
      return limit;
    }
    if (args.label === undefined && args.value === undefined) {
      return toToolErrorResult(
        makeErrorPayload(
          ErrorCodes.SCHEMA_INVALID_PARAMS,
          `variables.update for ${args.id} received neither label nor value — there is nothing to change. Supply label and/or value.`,
          { meta: { path: 'label' } },
        ),
      );
    }
    const blank = checkVarNonEmpty(
      {
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.value !== undefined ? { value: args.value } : {}),
      },
      `variables.update for ${args.id}`,
    );
    if (blank !== null) {
      return blank;
    }
    const body: BatchVariablesRequest = {
      watermark: args.watermark,
      operations: [
        {
          type: 'update',
          id: args.id,
          payload: {
            ...(args.label !== undefined ? { label: args.label } : {}),
            ...(args.value !== undefined ? { value: args.value } : {}),
          },
        },
      ],
      op_id: mintOpId(['design.variables.update', args.id, args.label, args.value, args.watermark]),
    };
    const data = await ctx.wp.batchVariables(body);
    return okResult(
      { watermark: data.watermark },
      `Updated design variable ${args.id} (watermark ${data.watermark}). Cache auto-flushed.`,
    );
  });
}

/**
 * `elementor.design.variables.delete` handler (D, §1.4; 10-rest-api.md §4.4). Routed through
 * `POST /design/variables/batch` as a single `delete` op (a SOFT delete — restorable via
 * `variables.restore`): the batch route is the ONLY §4.4 transport that carries the `watermark`
 * (the single-variable DELETE has no body), so PHP genuinely enforces it (`WATERMARK_STALE` on a
 * stale token). Destructive ⇒ elicit confirm when `confirm!=true` (a DECLINE → clean non-error).
 * Returns the new `watermark`.
 */
export async function variablesDeleteHandler(
  args: VariablesDeleteArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    if (!args.confirm) {
      const outcome = await ctx.elicit(
        `Delete design variable ${args.id}? It is soft-deleted (restorable), but elements/classes referencing it lose the token until restored.`,
      );
      if (!outcome.confirmed) {
        // M-b: decline carries a schema-valid structured payload (the watermark is unchanged).
        return declinedResult(`Variable deletion cancelled by the user; ${args.id} is unchanged.`, {
          watermark: args.watermark,
        });
      }
    }
    const body: BatchVariablesRequest = {
      watermark: args.watermark,
      operations: [{ type: 'delete', id: args.id }],
      op_id: mintOpId(['design.variables.delete', args.id, args.watermark]),
    };
    const data = await ctx.wp.batchVariables(body);
    return okResult(
      { watermark: data.watermark },
      `Soft-deleted design variable ${args.id} (watermark ${data.watermark}); restore via variables.restore.`,
    );
  });
}

/**
 * `elementor.design.variables.restore` handler (M, §1.4; 10-rest-api.md §4.4). Proxies
 * `POST /design/variables/{id}/restore` to bring back a soft-deleted token, with a CLIENT-side
 * watermark guard: the live watermark is read via `GET /design/variables` first and a mismatch
 * returns `WATERMARK_STALE` (the agent re-reads via `variables.list` and retries) WITHOUT writing.
 *
 * Why not the batch route like `.update`/`.delete`? A `restore` op through Elementor's
 * `Batch_Processor::op_restore` (4.1.1) passes the WHOLE operation — including `type:'restore'` —
 * into `Variable::apply_changes`, tripping the type-change guard ("Type change is forbidden"), so
 * batch-restore always fails upstream (field-verified). The single restore route carries no
 * watermark, hence the pre-check here. NOTE: the pre-check is best-effort (read-then-write, not
 * atomic) — a write landing in the tiny window between the check and the restore is not detected.
 * Returns the new `watermark`.
 */
export async function variablesRestoreHandler(
  args: VariablesRestoreArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const live = await ctx.wp.listVariables();
    if (live.watermark !== args.watermark) {
      return toToolErrorResult(
        makeErrorPayload(
          ErrorCodes.WATERMARK_STALE,
          `The variables watermark is stale: you supplied ${args.watermark} but the live collection is at ${live.watermark}. Re-read variables.list for the current watermark and retry the restore.`,
          {
            meta: { expected_watermark: args.watermark, actual_watermark: live.watermark },
          },
        ),
      );
    }
    const body: RestoreVariableRequest = {
      op_id: mintOpId(['design.variables.restore', args.id, args.watermark]),
    };
    const data = await ctx.wp.restoreVariable(args.id, body);
    return okResult(
      { watermark: data.watermark },
      `Restored design variable ${args.id} (watermark ${data.watermark}). Cache auto-flushed.`,
    );
  });
}

/**
 * `elementor.design.variables.batch` handler (M, §1.4; 10-rest-api.md §4.4). Proxies
 * `POST /design/variables/batch` — an ATOMIC multi-edit on a SINGLE `watermark` (a stale token fails
 * the WHOLE batch, `WATERMARK_STALE`). Maps the catalog op shape `{op,id?,type?,label?,value?}` to the
 * REST `VariableBatchOp` `{type:<op>, id?, payload:{type,label,value}}`. Returns the new `watermark` +
 * a per-op `results[]` (the catalog shape `{op,id,ok,error}`); PHP's `variables` map echoes the final
 * state, so per-op success is derived from the absence of a batch error.
 */
export async function variablesBatchHandler(
  args: VariablesBatchArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    // Fast client-side limit pre-check across all create/update payloads.
    for (const op of args.operations) {
      const limit = checkVarLimits({
        ...(op.id !== undefined ? { id: op.id } : {}),
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...(op.value !== undefined ? { value: op.value } : {}),
      });
      if (limit !== null) {
        return limit;
      }
      const blank = checkVarNonEmpty(
        {
          ...(op.label !== undefined ? { label: op.label } : {}),
          ...(op.value !== undefined ? { value: op.value } : {}),
        },
        `variables.batch ${op.op}${op.id !== undefined ? ` for ${op.id}` : ''}`,
      );
      if (blank !== null) {
        return blank;
      }
    }

    const operations: VariableBatchOp[] = args.operations.map((op) => batchOpToRest(op));
    const body: BatchVariablesRequest = {
      watermark: args.watermark,
      operations,
      op_id: mintOpId(['design.variables.batch', args.watermark, args.operations]),
    };
    const data = await ctx.wp.batchVariables(body);
    // The batch is atomic: reaching here means every op succeeded (a failure throws WATERMARK_STALE /
    // E_BATCH_FAILED via the client path). Build the per-op results in the catalog shape.
    const results = args.operations.map((op) => ({
      op: op.op,
      id: op.id ?? '',
      ok: true,
      error: null as string | null,
    }));
    return okResult(
      { watermark: data.watermark, results },
      `Applied ${args.operations.length} variable op(s) atomically (watermark ${data.watermark}). Cache auto-flushed.`,
    );
  });
}

/** Map a catalog batch op `{op,...}` to the REST `VariableBatchOp` `{type:<op>, id?, payload?}`. */
function batchOpToRest(op: BatchOpArg): VariableBatchOp {
  const payload: Record<string, unknown> = {};
  if (op.type !== undefined) {
    payload['type'] = op.type;
  }
  if (op.label !== undefined) {
    payload['label'] = op.label;
  }
  if (op.value !== undefined) {
    payload['value'] = op.value;
  }
  return {
    type: op.op,
    ...(op.id !== undefined ? { id: op.id } : {}),
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
  };
}

/* ════════════════════════════════════ V3 GLOBALS (§4.5) ════════════════════════════════════ */

/**
 * `elementor.design.globalColors.list` handler (R, §1.4; 10-rest-api.md §4.5). Proxies
 * `GET /design/global-colors`; maps the REST `{system_colors,custom_colors}` to the catalog
 * `{system,custom}`. Read-only — no cap gate.
 */
export async function globalColorsListHandler(
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const data: GetGlobalColorsResponse = await ctx.wp.getGlobalColors();
    return okResult(
      { system: data.system_colors, custom: data.custom_colors },
      `Listed ${data.system_colors.length} system + ${data.custom_colors.length} custom V3 color(s).`,
    );
  });
}

/**
 * `elementor.design.globalColors.upsert` handler (M, §1.4; 10-rest-api.md §4.5). GET-merge-PUT on the
 * chosen `bucket` repeater (`system_colors`/`custom_colors`): GETs the current bucket, merges the
 * supplied colors by `_id` (an item WITHOUT an `_id` is appended as new), then PUTs ONLY that bucket
 * (the other bucket is sent unchanged so the kit save never drops it). Auto-flushes the kit cache.
 */
export async function globalColorsUpsertHandler(
  args: GlobalColorsUpsertArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const current: GetGlobalColorsResponse = await ctx.wp.getGlobalColors();
    const bucketKey = args.bucket === 'system' ? 'system_colors' : 'custom_colors';
    const existing = args.bucket === 'system' ? current.system_colors : current.custom_colors;
    const merged = mergeColors(existing, args.colors);
    const body =
      args.bucket === 'system'
        ? {
            system_colors: merged,
            op_id: mintOpId(['design.globalColors.upsert', 'system', merged]),
          }
        : {
            custom_colors: merged,
            op_id: mintOpId(['design.globalColors.upsert', 'custom', merged]),
          };
    const data = await ctx.wp.putGlobalColors(body);
    const out = bucketKey === 'system_colors' ? data.system_colors : data.custom_colors;
    return okResult(
      { success: true, colors: out },
      `Upserted ${args.colors.length} V3 color(s) into the ${args.bucket} bucket. Kit cache auto-flushed.`,
    );
  });
}

/** Merge supplied colors into the existing bucket by `_id` (no `_id` ⇒ append as new). */
function mergeColors(
  existing: KitColor[],
  supplied: Array<{ _id?: string; title: string; color: string }>,
): KitColor[] {
  const byId = new Map<string, KitColor>(existing.map((c) => [c._id, { ...c }]));
  const appended: KitColor[] = [];
  for (const c of supplied) {
    if (c._id !== undefined && byId.has(c._id)) {
      byId.set(c._id, { _id: c._id, title: c.title, color: c.color });
    } else {
      const _id = c._id ?? `c-${appended.length + byId.size + 1}`;
      appended.push({ _id, title: c.title, color: c.color });
    }
  }
  return [...byId.values(), ...appended];
}

/**
 * `elementor.design.globalColors.delete` handler (D, §1.4; 10-rest-api.md §4.5). Removes the given
 * `_id`s from BOTH V3 color buckets (GET → filter → PUT both buckets). Destructive class, but the
 * catalog input carries no `confirm` field (the descriptor omits it), so this proceeds directly —
 * deletion is by explicit id and the kit settings are restorable from a backup.
 */
export async function globalColorsDeleteHandler(
  args: GlobalColorsDeleteArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const current: GetGlobalColorsResponse = await ctx.wp.getGlobalColors();
    const drop = new Set(args.ids);
    const system_colors = current.system_colors.filter((c) => !drop.has(c._id));
    const custom_colors = current.custom_colors.filter((c) => !drop.has(c._id));
    await ctx.wp.putGlobalColors({
      system_colors,
      custom_colors,
      op_id: mintOpId(['design.globalColors.delete', args.ids]),
    });
    return okResult(
      { success: true },
      `Deleted ${args.ids.length} V3 color(s). Kit cache auto-flushed.`,
    );
  });
}

/**
 * `elementor.design.globalFonts.list` handler (R, §1.4; 10-rest-api.md §4.5). Proxies
 * `GET /design/global-fonts`; maps the REST `{system_typography,custom_typography}` kit repeaters to
 * the catalog `{system,custom}` of `{_id,title,typography}` (the typography control keys collapse into
 * the `typography` map). Read-only — no cap gate.
 */
export async function globalFontsListHandler(
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const data: GetGlobalFontsResponse = await ctx.wp.getGlobalFonts();
    return okResult(
      {
        system: data.system_typography.map(fontToCatalog),
        custom: data.custom_typography.map(fontToCatalog),
      },
      `Listed ${data.system_typography.length} system + ${data.custom_typography.length} custom V3 font(s).`,
    );
  });
}

/** Project a RAW kit font (`{_id,title,...typography keys}`) to the catalog `{_id,title,typography}`. */
function fontToCatalog(font: KitFont): {
  _id: string;
  title: string;
  typography: Record<string, unknown>;
} {
  const { _id, title, ...rest } = font;
  return { _id, title, typography: rest };
}

/** Flatten a catalog font `{_id?,title,typography}` back to the RAW kit font (`{_id,title,...typo}`). */
function fontToKit(
  item: { _id?: string; title: string; typography: Record<string, unknown> },
  fallbackId: string,
): KitFont {
  return { _id: item._id ?? fallbackId, title: item.title, ...item.typography };
}

/**
 * `elementor.design.globalFonts.upsert` handler (M, §1.4; 10-rest-api.md §4.5). GET-merge-PUT on the
 * chosen `bucket` typography repeater, mirroring {@link globalColorsUpsertHandler}. The catalog input
 * field is named `colors` (catalog row reuse) but the items carry `{_id?,title,typography}`. Flattens
 * each item's `typography` map back into the kit's `typography_*` control keys before PUT.
 */
export async function globalFontsUpsertHandler(
  args: GlobalFontsUpsertArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const current: GetGlobalFontsResponse = await ctx.wp.getGlobalFonts();
    const existing =
      args.bucket === 'system' ? current.system_typography : current.custom_typography;
    const merged = mergeFonts(existing, args.colors);
    const body =
      args.bucket === 'system'
        ? {
            system_typography: merged,
            op_id: mintOpId(['design.globalFonts.upsert', 'system', merged]),
          }
        : {
            custom_typography: merged,
            op_id: mintOpId(['design.globalFonts.upsert', 'custom', merged]),
          };
    const data = await ctx.wp.putGlobalFonts(body);
    const out = args.bucket === 'system' ? data.system_typography : data.custom_typography;
    return okResult(
      { success: true, colors: out.map(fontToCatalog) },
      `Upserted ${args.colors.length} V3 font(s) into the ${args.bucket} bucket. Kit cache auto-flushed.`,
    );
  });
}

/** Merge supplied fonts into the existing typography bucket by `_id` (no `_id` ⇒ append as new). */
function mergeFonts(
  existing: KitFont[],
  supplied: Array<{ _id?: string; title: string; typography: Record<string, unknown> }>,
): KitFont[] {
  const byId = new Map<string, KitFont>(existing.map((f) => [f._id, { ...f }]));
  const appended: KitFont[] = [];
  for (const f of supplied) {
    if (f._id !== undefined && byId.has(f._id)) {
      byId.set(f._id, fontToKit(f, f._id));
    } else {
      const _id = f._id ?? `t-${appended.length + byId.size + 1}`;
      appended.push(fontToKit({ ...f, _id }, _id));
    }
  }
  return [...byId.values(), ...appended];
}

/**
 * `elementor.design.globalFonts.delete` handler (D, §1.4; 10-rest-api.md §4.5). Removes the given
 * `_id`s from BOTH V3 typography buckets (GET → filter → PUT both). Mirrors
 * {@link globalColorsDeleteHandler}.
 */
export async function globalFontsDeleteHandler(
  args: GlobalFontsDeleteArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const current: GetGlobalFontsResponse = await ctx.wp.getGlobalFonts();
    const drop = new Set(args.ids);
    const system_typography = current.system_typography.filter((f) => !drop.has(f._id));
    const custom_typography = current.custom_typography.filter((f) => !drop.has(f._id));
    await ctx.wp.putGlobalFonts({
      system_typography,
      custom_typography,
      op_id: mintOpId(['design.globalFonts.delete', args.ids]),
    });
    return okResult(
      { success: true },
      `Deleted ${args.ids.length} V3 font(s). Kit cache auto-flushed.`,
    );
  });
}

/**
 * `elementor.design.fonts.install` handler (M, contract 18 §7-AI S4). Proxies
 * `POST /design/fonts/install` (CAP_MANAGE PHP-side): stores the woff2/woff/ttf/otf bytes under
 * uploads (font mimes are allowed ONLY on this route), registers the @font-face (Pro Custom Fonts
 * CPT when available → native enqueue, else the kit's custom-CSS STRING setting), and returns the
 * resolved family string callers should put in atomic `font-family` props. For NON-Google-catalog
 * faces only — catalog families load natively (§7 "Font system strategy").
 */
export async function fontsInstallHandler(
  args: FontsInstallArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const data = await ctx.wp.installFont({
      source: args.source,
      family: args.family,
      ...(args.weight !== undefined ? { weight: args.weight } : {}),
      ...(args.style !== undefined ? { style: args.style } : {}),
      op_id: mintOpId(['design.fonts.install', args.family, args.weight, args.style]),
    });
    return okResult(
      {
        family: data.family,
        weight: data.weight,
        style: data.style,
        format: data.format,
        attachment_id: data.attachment_id,
        url: data.url,
        registered_via: data.registered_via,
        font_face: data.font_face,
        warnings: data.warnings,
      },
      `Installed font face "${data.family}" ${data.weight} ${data.style} (${data.format}) via ${data.registered_via}; use font-family "${data.family}" in atomic props.`,
    );
  });
}

/**
 * `elementor.design.fonts.upload_zip` handler. Reads a ZIP from the local filesystem (file_path)
 * or accepts raw base64 (zip_data), then proxies to `POST /design/fonts/upload-zip` where PHP
 * extracts each OTF/TTF/WOFF/WOFF2 file, reads the name table, and installs it into the WP Font
 * Library. Returns all installed faces and any skipped file names.
 */
export async function fontsUploadZipHandler(
  args: FontsUploadZipArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    let zipData: string;
    if (args.file_path) {
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(args.file_path);
      zipData = buf.toString('base64');
    } else if (args.zip_data) {
      zipData = args.zip_data;
    } else {
      throw Object.assign(new Error('Provide either file_path or zip_data.'), { code: 'VALIDATION_FAILED' });
    }

    const data = await ctx.wp.uploadFontZip({
      zip_data: zipData,
      op_id: mintOpId(['design.fonts.upload_zip', args.file_path ?? zipData.slice(0, 32)]),
    });

    const names = data.installed.map((f: { family: string; weight: string }) => `"${f.family}" ${f.weight}`).join(', ');
    const summary = data.installed.length > 0
      ? `Installed ${data.installed.length} face(s): ${names}.`
      : 'No font faces installed.';
    const skippedNote = data.skipped.length > 0
      ? ` Skipped ${data.skipped.length} file(s): ${data.skipped.join(', ')}.`
      : '';
    return okResult(data as unknown as Record<string, unknown>, summary + skippedNote);
  });
}

/* ════════════════════════════════════ DEFAULTS / SYNC (§4.6-§4.7) ══════════════════════════ */

/**
 * `elementor.design.element_defaults.get` handler (R, §1.4; 10-rest-api.md §4.6). Proxies
 * `GET /design/element-defaults`, returning the per-widget default `settings` for the requested widget
 * `type` (the route returns the full `{defaults:{<type>:{...}}}` map; we project the one type). An
 * unknown type yields an empty `settings` map. Read-only.
 */
export async function elementDefaultsGetHandler(
  args: ElementDefaultsGetArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const data = await ctx.wp.getElementDefaults();
    const settings = data.defaults?.[args.type] ?? {};
    return okResult({ settings }, `Read default settings for "${args.type}".`);
  });
}

/**
 * `elementor.design.element_defaults.set` handler (M, §1.4; 10-rest-api.md §4.6). Proxies
 * `PUT /design/element-defaults` with `{type,settings}` to set the per-widget kit defaults. Auto-flushes
 * the kit cache. Returns `{success}`.
 */
export async function elementDefaultsSetHandler(
  args: ElementDefaultsSetArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    await ctx.wp.putElementDefaults({
      type: args.type,
      settings: args.settings,
      op_id: mintOpId(['design.element_defaults.set', args.type, args.settings]),
    });
    return okResult(
      { success: true },
      `Set default settings for "${args.type}". Kit cache auto-flushed.`,
    );
  });
}

/**
 * `elementor.design.sync_v4_to_v3` handler (M, §1.4; 10-rest-api.md §4.7). Proxies
 * `POST /design/sync-v4-to-v3` to flag a V4 variable `sync_to_v3` and regenerate the bridge stylesheet.
 * Returns `{success}` (the route also returns `bridge_var`, intentionally not surfaced in the catalog
 * output shape). Atomic-CSS-affecting (regenerates the V4→V3 bridge stylesheet).
 */
export async function syncV4ToV3Handler(
  args: SyncV4ToV3Args,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runDesign(async () => {
    const data = await ctx.wp.syncV4ToV3({
      variable_id: args.variable_id,
      op_id: mintOpId(['design.sync_v4_to_v3', args.variable_id]),
    });
    return okResult(
      { success: data.success === true },
      `Synced V4 variable ${args.variable_id} to V3${data.bridge_var ? ` (bridge ${data.bridge_var})` : ''}. Bridge stylesheet regenerated.`,
    );
  });
}

/* ════════════════════════════════════ DEPLOY (§4.8, BOTH) ══════════════════════════════════ */

/**
 * `elementor.design.deploy` handler (D, BOTH, §1.4; 10-rest-api.md §4.8). One-shot ALL-OR-NOTHING
 * deploy of global classes + variables in a single transaction. Pipeline (ticket §Detailed
 * Requirements 7):
 *  a. GATE on `can_update_class` (it writes classes, S5) — absent ⇒ `CAPABILITY_MISSING` BEFORE REST.
 *  b. Destructive ⇒ elicit confirm when `confirm!=true` (a DECLINE → clean non-error).
 *  c. When classes are supplied, GET the current ids + order (§4.1) → {@link buildClassesDiff} (the
 *     CLIENT-side budget pre-flight runs here, fast); the REST `global_classes` block is the diff
 *     (added/modified/items/order). When variables are supplied, GET the current `watermark` (§4.4) and
 *     build the batch `operations` (each new token a `create`).
 *  d. `deployDesign` applies BOTH in one transaction; PHP pre-flights BOTH 1000-item budgets and applies
 *     NEITHER if either would exceed (`E_BUDGET_EXCEEDED`, all-or-nothing). Full cache flush after.
 *  e. Surface `modifiedLabels` (soft DUPLICATED_LABEL) so the agent rebinds.
 */
export async function deployHandler(args: DeployArgs, ctx: ToolContext): Promise<CallToolResult> {
  return runDesign(async () => {
    const gate = await requireUpdateClass(ctx);
    if (gate !== null) {
      return gate;
    }
    if (!args.confirm) {
      const outcome = await ctx.elicit(
        `Deploy the design system (${args.globalClasses?.length ?? 0} global class(es) + ${args.globalVariables?.length ?? 0} variable(s)) in one all-or-nothing transaction? This overwrites the existing design system.`,
      );
      if (!outcome.confirmed) {
        // M-b: decline carries a schema-valid structured payload (nothing was deployed).
        return declinedResult('Design-system deploy cancelled by the user; nothing was changed.', {
          success: false,
          classes_order: [],
          variables_watermark: -1,
        });
      }
    }

    const body: DeployDesignRequest = {
      op_id: mintOpId(['design.deploy', args.globalClasses, args.globalVariables]),
    };

    // (c) classes block — GET order, build the diff (client budget pre-flight inside).
    if (args.globalClasses !== undefined && args.globalClasses.length > 0) {
      const current: ListGlobalClassesResponse = await ctx.wp.listGlobalClasses({
        context: 'frontend',
      });
      const currentIds = new Set(current.order);
      // Partition supplied classes into added (new id) vs modified (existing id).
      const added = args.globalClasses.filter((c) => !currentIds.has(c.id));
      const modified = args.globalClasses.filter((c) => currentIds.has(c.id));
      const diff: ClassesDiffBody = buildClassesDiff({
        added,
        modified,
        currentItems: current.items,
        currentOrder: current.order,
      });
      body.global_classes = {
        added: diff.changes.added,
        modified: diff.changes.modified,
        deleted: diff.changes.deleted,
        items: diff.items,
        order: diff.order,
      };
    }

    // (c) variables block — GET watermark, build create operations.
    if (args.globalVariables !== undefined && args.globalVariables.length > 0) {
      const vars = await ctx.wp.listVariables();
      const operations: VariableBatchOp[] = args.globalVariables.map((v) => ({
        type: 'create',
        payload: { type: v.type, label: v.label, value: v.value },
      }));
      body.global_variables = { operations, watermark: vars.watermark };
    }

    const data = await ctx.wp.deployDesign(body);
    const modifiedLabels = data.classes?.modified_labels ?? {};
    const renamed = Object.keys(modifiedLabels);
    const structured: Record<string, unknown> = {
      success: data.classes?.ok === true,
      classes_order: body.global_classes?.order ?? [],
      variables_watermark: data.variables?.watermark ?? 0,
      ...(renamed.length > 0 ? { modifiedLabels } : {}),
    };
    const renameNote =
      renamed.length > 0
        ? ` ${renamed.length} duplicate label(s) auto-renamed — rebind elements to the new id(s).`
        : '';
    return okResult(
      structured,
      `Deployed design system (${args.globalClasses?.length ?? 0} class(es) + ${args.globalVariables?.length ?? 0} variable(s)) atomically; watermark ${String(structured['variables_watermark'])}. Full cache flushed.${renameNote}`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach every design-system handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Detailed
 * Requirements 1; §Acceptance). The registry stores handlers under its loose `(args) => unknown` type;
 * the runtime invokes them as `(args, ctx)` (the server core casts to the WP-T01 {@link ToolHandler}
 * signature), so each handler is registered through that signature here.
 */
export function attachDesignHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [DESIGN_CLASSES_LIST]: (args, ctx) => classesListHandler(args as ClassesListArgs, ctx),
    [DESIGN_CLASSES_UPSERT]: (args, ctx) => classesUpsertHandler(args as ClassesUpsertArgs, ctx),
    [DESIGN_CLASSES_DELETE]: (args, ctx) => classesDeleteHandler(args as ClassesDeleteArgs, ctx),
    [DESIGN_CLASSES_REORDER]: (args, ctx) => classesReorderHandler(args as ClassesReorderArgs, ctx),
    [DESIGN_CLASSES_USAGE]: (args, ctx) => classesUsageHandler(args as ClassesUsageArgs, ctx),
    [DESIGN_VARIABLES_LIST]: (args, ctx) => variablesListHandler(args as VariablesListArgs, ctx),
    [DESIGN_VARIABLES_CREATE]: (args, ctx) =>
      variablesCreateHandler(args as VariablesCreateArgs, ctx),
    [DESIGN_VARIABLES_UPDATE]: (args, ctx) =>
      variablesUpdateHandler(args as VariablesUpdateArgs, ctx),
    [DESIGN_VARIABLES_DELETE]: (args, ctx) =>
      variablesDeleteHandler(args as VariablesDeleteArgs, ctx),
    [DESIGN_VARIABLES_RESTORE]: (args, ctx) =>
      variablesRestoreHandler(args as VariablesRestoreArgs, ctx),
    [DESIGN_VARIABLES_BATCH]: (args, ctx) => variablesBatchHandler(args as VariablesBatchArgs, ctx),
    [DESIGN_GLOBAL_COLORS_LIST]: (args, ctx) =>
      globalColorsListHandler(args as Record<string, never>, ctx),
    [DESIGN_GLOBAL_COLORS_UPSERT]: (args, ctx) =>
      globalColorsUpsertHandler(args as GlobalColorsUpsertArgs, ctx),
    [DESIGN_GLOBAL_COLORS_DELETE]: (args, ctx) =>
      globalColorsDeleteHandler(args as GlobalColorsDeleteArgs, ctx),
    [DESIGN_GLOBAL_FONTS_LIST]: (args, ctx) =>
      globalFontsListHandler(args as Record<string, never>, ctx),
    [DESIGN_GLOBAL_FONTS_UPSERT]: (args, ctx) =>
      globalFontsUpsertHandler(args as GlobalFontsUpsertArgs, ctx),
    [DESIGN_GLOBAL_FONTS_DELETE]: (args, ctx) =>
      globalFontsDeleteHandler(args as GlobalFontsDeleteArgs, ctx),
    [DESIGN_FONTS_INSTALL]: (args, ctx) => fontsInstallHandler(args as FontsInstallArgs, ctx),
    [DESIGN_FONTS_UPLOAD_ZIP]: (args, ctx) =>
      fontsUploadZipHandler(args as FontsUploadZipArgs, ctx),
    [DESIGN_SYNC_V4_TO_V3]: (args, ctx) => syncV4ToV3Handler(args as SyncV4ToV3Args, ctx),
    [DESIGN_ELEMENT_DEFAULTS_GET]: (args, ctx) =>
      elementDefaultsGetHandler(args as ElementDefaultsGetArgs, ctx),
    [DESIGN_ELEMENT_DEFAULTS_SET]: (args, ctx) =>
      elementDefaultsSetHandler(args as ElementDefaultsSetArgs, ctx),
    [DESIGN_DEPLOY]: (args, ctx) => deployHandler(args as DeployArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
