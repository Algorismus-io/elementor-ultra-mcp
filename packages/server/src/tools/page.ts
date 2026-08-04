/**
 * WP-T05 — page-CRUD tool HANDLERS (Contract 13 §1.2) + attachment to the WP-F04 registry.
 *
 * Implements the eight §1.2 page tools and attaches each to the WP-F04 {@link ToolRegistry} by EXACT
 * catalog name (13-tool-catalog.md §1.2). WP-F04 owns the descriptors (`catalog/schemas/page.ts`); the
 * SDK has already validated `args` against `inputSchema` before a handler runs and validates the
 * returned `structuredContent` against `outputSchema` after (Contract 13 §0.1). Handlers receive the
 * single WP-T01 {@link ToolContext}.
 *
 * Tools handled here (Contract 13 §1.2 / §5.2 ★):
 *  - `elementor.page.create`        ★ (M, `POST /documents`)
 *  - `elementor.page.build`         ★ (M, BOTH: mint+dedupe ids → pre-filter → create→save→prime-css)
 *  - `elementor.page.replace_tree`     (D, `POST /documents/{id}/save` w/ base_hash + elicitation)
 *  - `elementor.page.update_settings`  (M, `PUT /documents/{id}/settings` — GET-merge-PUT, S4)
 *  - `elementor.page.dry_run`       ★ (R, BOTH: TS pre-filter then PHP AUTHORITATIVE validator)
 *  - `elementor.page.duplicate`        (M, `POST /documents/{id}/duplicate`)
 *  - `elementor.page.delete`           (D, `DELETE /documents/{id}` + elicitation)
 *  - `elementor.page.export_template`  (R, `POST /documents/{id}/export`)
 *
 * Design notes (ticket §Detailed Requirements):
 *  - `page.build` is the M1 greenfield path. TS mints/dedupes ids (WP-F03 `dedupe`), pre-filters
 *    (WP-F03 `prefilter` — a hard `reject` short-circuits WITHOUT a REST round-trip; `defer`/`accept`
 *    proceed to PHP), v4→v3 falls back ONLY when atomic is inactive per the capability probe (locked
 *    decision 3), then proxies create→save→prime-css. PHP runs the AUTHORITATIVE validator internally;
 *    a 422 writes NOTHING and surfaces here as `ATOMIC_*`/`VALIDATION_FAILED` (Contract 10 §0.9).
 *  - `page.dry_run` runs the cheap TS pre-filter first, then ALWAYS the PHP dry-run. An invalid tree is
 *    a SUCCESS result `{valid:false,errors}`, never `isError` (Contract 13 §1.2): the PHP 422 envelope
 *    is normalized into that shape here (the route wrapper throws on 422).
 *  - Destructive tools (`replace_tree`, `delete`) gate on `ctx.elicit` when `confirm!=true`; a decline
 *    yields a CLEAN non-error result (Contract 12 §5.5).
 *  - A stale `base_hash` → `CONCURRENCY_STALE_HASH`; `force` overrides lock/autosave. A failed prime →
 *    `CSS_PRIME_FAILED` (retryable) WITHOUT failing the save (Contract 10 §2.7).
 *
 * Contract authority: 13-tool-catalog.md §1.2 (per-tool I/O), §0.7 (diff/base_hash/preview_url), §0.8
 * (base_hash on replace_tree; op_id on build; force), §0.9 (input/business error split). 10-rest-api.md
 * §2.2/§2.3/§2.5/§2.6/§2.7/§2.9, §0.9 (dry-run-before-commit), §0.10 (prime-css). 11-authoring-contract.md
 * §1-§4. 12-error-taxonomy.md §3/§5.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  isErrorCode,
  makeErrorPayload,
  type McpErrorPayload,
  type CreateDocumentRequest,
  type DeleteDocumentRequest,
  type DryRunRequest,
  type DryRunResponse,
  type DuplicateDocumentRequest,
  type ElementNode as RestElementNode,
  type ExportDocumentResponse,
  type ListBackupsResponse,
  type RestDiff,
  type RollbackDocumentRequest,
  type RollbackDocumentResponse,
  type SaveDocumentRequest,
  type SaveDocumentResponse,
  type SaveWarning,
  type UpdateDocumentSettingsRequest,
  type VerifyRenderResponse,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import type { ToolRegistry } from '../catalog/registry.js';
import { WpClientError, type RestFieldErrorLike } from '../wp/types.js';
import { declinedResult, fromClientError, type ToolResult } from '../wp/errors.js';

import type { Diff, ElementNode, Generation, ValidationError } from '../authoring/contract.js';
import { dedupe } from '../authoring/ids.js';
import { prefilter } from '../authoring/prefilter.js';
import { presentDiff, summarizeDiff } from '../safety/diff.js';
import { mintOpId, isReplay } from '../safety/idempotency.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.2) ────────────────────────── */

/** The page-CRUD tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.2). */
export const PAGE_CREATE = 'elementor.page.create';
export const PAGE_BUILD = 'elementor.page.build';
export const PAGE_REPLACE_TREE = 'elementor.page.replace_tree';
export const PAGE_UPDATE_SETTINGS = 'elementor.page.update_settings';
export const PAGE_DRY_RUN = 'elementor.page.dry_run';
export const PAGE_DUPLICATE = 'elementor.page.duplicate';
export const PAGE_DELETE = 'elementor.page.delete';
export const PAGE_EXPORT_TEMPLATE = 'elementor.page.export_template';
export const PAGE_LIST_BACKUPS = 'elementor.page.list_backups';
export const PAGE_ROLLBACK = 'elementor.page.rollback';
export const PAGE_VERIFY_RENDER = 'elementor.page.verify_render';

/** Every §1.2 tool name this WP owns a handler for (used by attach + tests). */
export const PAGE_TOOL_NAMES = [
  PAGE_CREATE,
  PAGE_BUILD,
  PAGE_REPLACE_TREE,
  PAGE_UPDATE_SETTINGS,
  PAGE_DRY_RUN,
  PAGE_DUPLICATE,
  PAGE_DELETE,
  PAGE_EXPORT_TEMPLATE,
  PAGE_LIST_BACKUPS,
  PAGE_ROLLBACK,
  PAGE_VERIFY_RENDER,
] as const;

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (Contract 13 §0.1), so the shapes below describe the POST-validation input — narrowing views over the
 * loose `unknown` the runtime {@link ToolHandler} declares, NOT re-validation. `elements` arrive as the
 * STRICT WP-F03 authoring {@link ElementNode} (validated against `elementNodeSchema`).
 */

interface PageCreateArgs {
  title?: string;
  post_type: string;
  template?: string;
  status: 'draft' | 'publish' | 'pending' | 'private';
}

interface PageBuildArgs {
  title: string;
  post_type: string;
  elements: ElementNode[];
  settings?: Record<string, unknown>;
  generation: Exclude<Generation, 'mixed'>;
  status: 'draft' | 'publish' | 'pending' | 'private';
  op_id?: string;
  prime_css: boolean;
  /** §7-AI S2 — post-save+prime render verification (default TRUE for page_build). */
  verify_render?: boolean;
}

interface PageReplaceTreeArgs {
  post_id: number;
  elements: ElementNode[];
  settings?: Record<string, unknown>;
  base_hash: string;
  confirm: boolean;
  force: boolean;
  prime_css: boolean;
  /** §7-AI S2 — optional post-save+prime render verification (default false). */
  verify_render?: boolean;
}

interface PageUpdateSettingsArgs {
  post_id: number;
  settings: Record<string, unknown>;
  base_hash?: string;
}

interface PageDryRunArgs {
  post_id?: number;
  elements: ElementNode[];
  settings?: Record<string, unknown>;
  generation: Exclude<Generation, 'mixed'>;
}

interface PageDuplicateArgs {
  post_id: number;
  title?: string;
}

interface PageDeleteArgs {
  post_id: number;
  confirm: boolean;
  force_delete: boolean;
}

interface PageExportTemplateArgs {
  post_id: number;
}

interface PageListBackupsArgs {
  post_id: number;
  limit: number;
  cursor?: string;
  fields?: string[];
}

interface PageRollbackArgs {
  post_id: number;
  backup: string;
  confirm: boolean;
  prime_css: boolean;
}

interface PageVerifyRenderArgs {
  post_id: number;
}

/* ───────────────────────────── result helpers ──────────────────────────────────────────────── */

/** Whether a thrown value is a {@link WpClientError} (carries a taxonomy `payload`). */
function isWpClientError(value: unknown): value is WpClientError {
  return value instanceof WpClientError;
}

/**
 * Build a successful tool result: the structured payload (validated against the descriptor's
 * `outputSchema` by the SDK) plus a compact human-readable `text` line (the SDK requires `content`).
 */
function okResult(structured: Record<string, unknown>, text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/**
 * Run a page handler, routing any caught {@link WpClientError} through WP-F05's surface rules
 * (`fromClientError` → protocol-throw vs `isError` result, 12-error-taxonomy.md §5). Non-client errors
 * rethrow (the server core surfaces them). The {@link ToolResult} is structurally a
 * {@link CallToolResult}.
 */
async function runPage(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/** A 32-hex `base_hash` (the strict `diff.schema.json` `base_hash_*` pattern). */
const BASE_HASH_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Coerce a single upstream diff id to a string (#3a). PHP may serialize a styles-map id as a number;
 * the frozen `ElementId` is a string, so any scalar id is string-ified here at the HTTP boundary.
 */
function coerceId(id: unknown): string {
  return typeof id === 'string' ? id : String(id);
}

/**
 * Coerce an upstream diff id rollup to a clean `string[]` (#3a): string-ify scalar ids, drop empties /
 * non-scalars. Defensive against PHP serializing a styles-map id as a number.
 */
function coerceIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const id of value) {
    if (typeof id === 'string' && id.length > 0) {
      out.push(id);
    } else if (typeof id === 'number' || typeof id === 'bigint') {
      out.push(String(id));
    }
  }
  return out;
}

/* ───────────────────────────── REST diff → authoring Diff (Contract 13 §0.7) ────────────────── */

/**
 * The REST diff as it actually arrives. The frozen F02 type is {@link RestDiff}
 * (`{changed_ids,new_ids,removed_ids,before,after}`), but the LIVE P06 controller already emits the
 * authoring {@link Diff} shape (`{changes[],…}`) — verified against the dev controller. This widened
 * view lets {@link restDiffToDiff} accept BOTH without an unchecked cast.
 */
type UpstreamDiff = Partial<RestDiff> &
  Partial<Pick<Diff, 'changes' | 'base_hash_after' | 'base_hash_before' | 'design_system'>>;

/**
 * Map an upstream REST diff into the authoring {@link Diff} the catalog `outputSchema` (`diffSchema` →
 * `Diff`) expects, then run it through {@link presentDiff} so a malformed shape surfaces LOUDLY rather
 * than reaching the agent (`13-tool-catalog.md §0.7`).
 *
 * Shape-agnostic (the live controller and the frozen type disagree on diff shape):
 *  - When the upstream diff ALREADY carries `changes[]` (the authoring shape the live P06 controller
 *    emits), it is passed through verbatim (id roll-ups + a valid `base_hash_after` filled in when
 *    absent) — NEVER re-deriving or fabricating a change.
 *  - Otherwise the `before`/`after` {@link RestDiff} maps are flattened into `changes[]` (added from
 *    `new_ids`, modified from `changed_ids`, removed from `removed_ids`), carrying the node snapshots.
 *
 * `base_hash` (the REST optimistic-lock token) becomes `base_hash_after` ONLY when it matches the strict
 * 32-hex schema pattern (otherwise omitted so `presentDiff` never rejects).
 */
function restDiffToDiff(rest: UpstreamDiff, baseHashAfter?: string): Diff {
  // Coerce the flat id rollups to clean `string[]` — the LIVE save/build route can hand back a
  // non-string id when a styles map is involved (a styles-map key deserializes as a number), and the
  // frozen `NodeChange.id` (ElementId) is a string, so `presentDiff` would reject it (#3a).
  const newIds = coerceIdList(rest.new_ids);
  const changedIds = coerceIdList(rest.changed_ids);
  const removedIds = coerceIdList(rest.removed_ids);
  const before = rest.before ?? {};
  const after = rest.after ?? {};

  const changes: Diff['changes'] =
    rest.changes !== undefined
      ? // The controller already emits `changes[]` (authoring shape); string-coerce each change id so a
        // styles-touching op whose change id PHP serialized as a number does not trip the schema (#3a).
        rest.changes.map((change) => ({ ...change, id: coerceId(change.id) }))
      : [
          ...newIds.map((id) => ({
            id,
            op: 'added' as const,
            ...(after[id] !== undefined ? { after: after[id] } : {}),
          })),
          ...changedIds.map((id) => ({
            id,
            op: 'modified' as const,
            ...(before[id] !== undefined ? { before: before[id] } : {}),
            ...(after[id] !== undefined ? { after: after[id] } : {}),
          })),
          ...removedIds.map((id) => ({
            id,
            op: 'removed' as const,
            ...(before[id] !== undefined ? { before: before[id] } : {}),
          })),
        ];

  const resolvedBaseHashAfter = rest.base_hash_after ?? baseHashAfter;
  const diff: Diff = {
    changes,
    new_ids: [...newIds],
    changed_ids: [...changedIds],
    removed_ids: [...removedIds],
    ...(rest.base_hash_before !== undefined && BASE_HASH_PATTERN.test(rest.base_hash_before)
      ? { base_hash_before: rest.base_hash_before }
      : {}),
    ...(resolvedBaseHashAfter !== undefined && BASE_HASH_PATTERN.test(resolvedBaseHashAfter)
      ? { base_hash_after: resolvedBaseHashAfter }
      : {}),
    ...(rest.design_system !== undefined ? { design_system: rest.design_system } : {}),
  };
  return presentDiff(diff);
}

/* ───────────────────────────── pre-filter → reject result (Contract 13 §0.9) ────────────────── */

/**
 * Build a structured `isError` tool result from a hard pre-filter REJECT (WP-F03 `prefilter`) — fast
 * structural feedback WITHOUT a REST round-trip (ticket §Detailed Requirements 2c). Codes are the
 * taxonomy codes the pre-filter assigns (`VALIDATION_FAILED`/`ATOMIC_*`); the aggregate result carries
 * the per-node errors as `VALIDATION_FAILED` meta so the agent can act on them.
 */
function prefilterRejectResult(errors: ValidationError[]): ToolResult {
  const metaErrors = errors.map((e) => ({
    code: isErrorCode(e.code) ? e.code : ErrorCodes.VALIDATION_FAILED,
    message: e.message,
    ...(e.element_id !== undefined ? { element_id: e.element_id } : {}),
    ...(e.style_id !== undefined ? { style_id: e.style_id } : {}),
    ...(e.prop !== undefined ? { prop: e.prop } : {}),
    ...(e.retryable !== undefined ? { retryable: e.retryable } : {}),
  }));
  const payload = makeErrorPayload(
    ErrorCodes.VALIDATION_FAILED,
    `Element-tree pre-filter rejected the tree (${errors.length} structural error${errors.length === 1 ? '' : 's'}).`,
    { meta: { errors: metaErrors } },
  );
  return {
    content: [{ type: 'text', text: payload.message }],
    structuredContent: {
      code: payload.code,
      message: payload.message,
      http_status: payload.http_status,
      retryable: payload.retryable,
      surface: payload.surface,
      meta: payload.meta,
    },
    isError: true,
  };
}

/* ───────────────────────────── generation gating (locked decision 3) ────────────────────────── */

/** The outcome of the v4→v3 capability gate for `page.build`/`page.dry_run`. */
interface GenerationGate {
  /** The generation to author with (possibly downgraded from `v4` → `v3`). */
  generation: Exclude<Generation, 'mixed'>;
  /** A `report.warnings` entry recorded when a fallback was applied (else none). */
  warning?: string;
}

/**
 * Resolve the effective generation: when the requested generation is `v4` but the site's `atomic`
 * experiment is INACTIVE (per the memoized capability probe), FALL BACK to `v3` and record a warning
 * (locked decision 3 — fallback only when atomic is off, never as a preference). An explicit `v3`
 * request, or `v4` on an atomic-active site, passes through unchanged.
 */
async function resolveGeneration(
  ctx: ToolContext,
  requested: Exclude<Generation, 'mixed'>,
): Promise<GenerationGate> {
  if (requested !== 'v4') {
    return { generation: requested };
  }
  const caps = await ctx.capabilities.get();
  if (caps.atomic) {
    return { generation: 'v4' };
  }
  return {
    generation: 'v3',
    warning:
      'Requested generation "v4" but atomic (e_atomic_elements) is inactive on this site; fell back to "v3".',
  };
}

/* ───────────────────────────── REST element-node cast (F03 strict → loose REST) ─────────────── */

/**
 * Cross the authoring/REST boundary: the WP-F03 strict {@link ElementNode} union is structurally a
 * narrowing of the loose REST {@link RestElementNode} (index-signatured), but TS treats the two named
 * types as distinct, so this is the single explicit cast at the HTTP edge. No data is transformed.
 */
function toRestNodes(nodes: ElementNode[]): RestElementNode[] {
  return nodes as unknown as RestElementNode[];
}

/* ───────────────────────────── elementor.page.create (§1.2 / §2.2) ──────────────────────────── */

/**
 * `elementor.page.create` handler (★, 13-tool-catalog.md §1.2; 10-rest-api.md §2.2). Proxies
 * `POST /documents` to create a BLANK document. The catalog `template` input maps to the REST
 * `template_type` field; `title`/`template_type` are forwarded only when provided. Returns
 * `{id,edit_url,status,type}`.
 */
export async function pageCreateHandler(
  args: PageCreateArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    const body: CreateDocumentRequest = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      post_type: args.post_type,
      ...(args.template !== undefined ? { template_type: args.template } : {}),
      status: args.status,
    };
    const data = await ctx.wp.createDocument(body);
    return okResult(
      { id: data.id, edit_url: data.edit_url, status: data.status, type: data.type },
      `Created ${data.type} ${data.id} (${data.status}).`,
    );
  });
}

/* ───────────────────────────── elementor.page.build (§1.2 / §0.9 / §0.10) ───────────────────── */

/**
 * `elementor.page.build` handler (★, 13-tool-catalog.md §1.2; 10-rest-api.md §0.9 + §0.10). The M1
 * greenfield path. Pipeline (ticket §Detailed Requirements 2):
 *  a. Probe capabilities; default `v4` falls back to `v3` when atomic is inactive (locked decision 3),
 *     recording a `report.warnings` entry.
 *  b. `dedupe` the tree against itself (fresh page, no live ids); `mintOpId` deterministically when the
 *     caller omitted `op_id` (so a retried build is recognized as a replay by PHP).
 *  c. Cheap `prefilter`: a hard `reject` returns an `isError` with structural codes WITHOUT a REST call
 *     (fast feedback); `defer`/`accept` proceed (PHP is authoritative).
 *  d. `createDocument` (carrying the op_id so the PHP create replay guard can return the SAME post for
 *     a retried build instead of minting a duplicate) → `saveDocument({elements,settings,op_id,
 *     prime_css,backup})`. PHP runs the AUTHORITATIVE validator internally; a 422 writes nothing and
 *     surfaces here (via the client error path) as `ATOMIC_*`/`VALIDATION_FAILED`. Because the blank
 *     document was ALREADY created by then, a failed save is COMPENSATED: a definite validation 422
 *     deletes the just-created blank post (best-effort), and EVERY save failure re-throws with
 *     `created_post_id`/`orphan_cleanup` meta so the agent never silently accretes invisible orphans.
 *  e. The save chains the prime when `prime_css` (default true); `css_primed` is reported HONESTLY.
 *  f. Returns `{id,edit_url,preview_url,diff,base_hash,css_primed,report}`; an idempotent replay (on
 *     the create OR the save) rides the `report.warnings` (the write already landed — informational,
 *     not a failure).
 */
export async function pageBuildHandler(
  args: PageBuildArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    const warnings: string[] = [];

    // (a) generation gate.
    const gate = await resolveGeneration(ctx, args.generation);
    if (gate.warning !== undefined) {
      warnings.push(gate.warning);
    }

    // (b) mint/dedupe ids over a FRESH set (greenfield — no live document ids yet).
    const { tree, remapped } = dedupe(args.elements);
    const remappedCount = Object.keys(remapped).length;
    if (remappedCount > 0) {
      warnings.push(`De-duplicated ${remappedCount} colliding element id(s) before building.`);
    }
    const opId =
      args.op_id ?? mintOpId(['page.build', args.title, args.post_type, gate.generation, tree]);

    // (c) cheap structural pre-filter — a hard reject short-circuits WITHOUT any REST round-trip.
    const pre = prefilter(tree);
    if (pre.verdict === 'reject') {
      return prefilterRejectResult(pre.errors);
    }

    // (d) create the blank document. The op_id rides along so the PHP create replay guard can return
    // the EXISTING post for a retried build (same op_id) instead of minting a duplicate page.
    const created = await ctx.wp.createDocument({
      title: args.title,
      post_type: args.post_type,
      status: args.status,
      op_id: opId,
    });
    // The frozen CreateDocumentResponse predates the create replay guard; read the flag defensively.
    const createWasReplay = isReplay(created as { idempotent_replay?: boolean });
    if (createWasReplay) {
      warnings.push(
        `Idempotent create replay: document ${created.id} already exists for this op_id; reusing it instead of creating a duplicate page.`,
      );
    }

    // (d/e) save the tree (PHP authoritative validation + chained prime when prime_css). The blank
    // document already exists, so a failed save is compensated — never a silent invisible orphan.
    // §7-AI S2 — verify_render defaults TRUE for page_build (the SDK default; defensive here too).
    const verifyRender = args.verify_render ?? true;
    const saveBody: SaveDocumentRequest = {
      elements: toRestNodes(tree),
      ...(args.settings !== undefined ? { settings: args.settings } : {}),
      op_id: opId,
      prime_css: args.prime_css,
      backup: true,
      // §7-AI S2 — the plugin runs the permalink probe after save+prime in the same request.
      verify_render: verifyRender,
    };
    let saved: SaveDocumentResponse;
    try {
      saved = await ctx.wp.saveDocument(created.id, saveBody);
    } catch (error: unknown) {
      if (isWpClientError(error)) {
        throw await compensateBuildSaveFailure(error, created.id, createWasReplay, ctx);
      }
      throw error;
    }

    if (isReplay(saved)) {
      warnings.push('Idempotent replay: this op_id was already applied; no new write occurred.');
    }
    const phpRemapped = saved.remapped_ids ?? {};
    const phpRemappedCount = Object.keys(phpRemapped).length;
    if (phpRemappedCount > 0) {
      warnings.push(
        `PHP remapped ${phpRemappedCount} element id(s) during the save: ${formatRemaps(phpRemapped)}. Use the new ids for follow-up element ops.`,
      );
    }
    if (args.prime_css && !saved.css_primed) {
      warnings.push(
        'Atomic CSS was NOT primed (the save succeeded; re-run prime-css or re-save). Front-end may render unstyled until primed.',
      );
    }
    foldSaveWarnings(saved.warnings, warnings);
    foldRenderWarning(verifyRender, saved, warnings);

    // (f) shape the output. The diff/base_hash come from the SAVE (the authoritative post-write state).
    // `remapped_ids` (authored id → live id; local dedupe + PHP-side remaps) is surfaced so follow-up
    // element ops target ids that actually exist on the page.
    const remappedIds: Record<string, string> = { ...remapped, ...phpRemapped };
    const diff = restDiffToDiff(saved.diff, saved.base_hash);
    const structured: Record<string, unknown> = {
      id: created.id,
      edit_url: created.edit_url,
      preview_url: saved.preview_url,
      diff,
      base_hash: saved.base_hash,
      css_primed: saved.css_primed,
      ...(saved.render_verified !== undefined ? { render_verified: saved.render_verified } : {}),
      ...(Object.keys(remappedIds).length > 0 ? { remapped_ids: remappedIds } : {}),
      ...(saved.dropped_elements && saved.dropped_elements.length > 0
        ? { dropped_elements: saved.dropped_elements }
        : {}),
      ...(warnings.length > 0 ? { report: { warnings } } : {}),
    };
    const summary = summarizeDiff(diff);
    return okResult(
      structured,
      `Built page ${created.id} (${gate.generation}); ${summary.added} added / ${summary.changed} changed; css_primed=${saved.css_primed}` +
        (saved.render_verified !== undefined ? `; render_verified=${saved.render_verified}` : '') +
        '.',
    );
  });
}

/** Fold PHP writer warnings (§7-AI S3 — e.g. `UNBOUND_MENU`) into the report warning strings. */
function foldSaveWarnings(saveWarnings: SaveWarning[] | undefined, warnings: string[]): void {
  for (const w of saveWarnings ?? []) {
    warnings.push(
      `[${w.code}]${w.element_id !== undefined ? ` element ${w.element_id}:` : ''} ${w.message}`,
    );
  }
}

/**
 * Fold a FAILED §7-AI S2 render probe into the report warnings (`RENDER_FAILED` is a SOFT taxonomy
 * code — the save landed; `render_verified:false` rides the structured result, op-logged PHP-side).
 */
function foldRenderWarning(
  requested: boolean,
  saved: SaveDocumentResponse,
  warnings: string[],
): void {
  if (!requested) {
    return;
  }
  if (saved.render_verified === false) {
    const probe = saved.render_probe;
    warnings.push(
      `[RENDER_FAILED] The saved page did NOT render cleanly (${probe?.method ?? 'probe'}: ` +
        `${probe?.fatal ?? `HTTP ${probe?.http_status ?? 'unknown'}`}). Inspect the page settings ` +
        `(an object custom_css fatals Pro) or roll back; the save itself succeeded.`,
    );
  } else if (saved.render_verified === undefined) {
    warnings.push(
      'verify_render was requested but the plugin did not return render_verified (older companion plugin?); the render is UNVERIFIED.',
    );
  }
}

/** Render a `{old: new}` id-remap map as a compact `old→new` list for warnings/summaries. */
function formatRemaps(remapped: Record<string, string>): string {
  return Object.entries(remapped)
    .map(([from, to]) => `${from}→${to}`)
    .join(', ');
}

/**
 * Compensate a failed `page.build` save: by the time the save runs, the blank document was ALREADY
 * created, so a save failure must NEVER strand an invisible orphan the agent cannot see (the blank
 * create has no `_elementor_data`, so it is invisible to every Elementor read tool — only
 * `pages_list` shows it). Policy:
 *
 *  - A DEFINITE validation 422 (`VALIDATION_FAILED`/`ATOMIC_*` — the transactional writer wrote
 *    NOTHING, so the post is still the blank create) on a post this very call minted ⇒ delete the
 *    orphan (best-effort, permanent — there is nothing to recover from a blank post). A create
 *    REPLAY reused a pre-existing post, which is never destroyed here.
 *  - Any OTHER failure (transport/lock/5xx — the save outcome is ambiguous and MAY have landed) ⇒
 *    keep the post.
 *
 * Either way the client error is re-thrown carrying `created_post_id` + `orphan_cleanup` meta and a
 * clarifying message tail, so the agent can reuse or delete the post instead of retrying blind (a
 * bare "nothing was written" would be actively misleading — a post WAS written).
 */
async function compensateBuildSaveFailure(
  error: WpClientError,
  createdId: number,
  createWasReplay: boolean,
  ctx: ToolContext,
): Promise<WpClientError> {
  let cleanup: 'deleted' | 'delete_failed' | 'kept' = 'kept';
  if (isValidationFailure(error) && !createWasReplay) {
    try {
      await ctx.wp.deleteDocument(createdId, { force: true });
      cleanup = 'deleted';
    } catch {
      cleanup = 'delete_failed';
    }
  }
  const tail =
    cleanup === 'deleted'
      ? `Note: the blank document ${createdId} created by this build was deleted again (no orphan page left behind).`
      : cleanup === 'delete_failed'
        ? `Note: a blank document ${createdId} was created by this build and could NOT be cleaned up; delete it (elementor.page.delete) or reuse it.`
        : `Note: document ${createdId} was created (or reused) by this build before the save failed and was KEPT (the save outcome is ambiguous); inspect, reuse, or delete it.`;
  const payload: McpErrorPayload = {
    ...error.payload,
    message: `${error.payload.message} ${tail}`,
    meta: { ...error.payload.meta, created_post_id: createdId, orphan_cleanup: cleanup },
  };
  return new WpClientError(payload, {
    httpStatus: error.httpStatus,
    ...(error.fieldErrors !== undefined ? { fieldErrors: error.fieldErrors } : {}),
    ...(error.opId !== undefined ? { opId: error.opId } : {}),
  });
}

/* ───────────────────────────── elementor.page.replace_tree (§1.2 / §2.6) ────────────────────── */

/**
 * `elementor.page.replace_tree` handler (D, 13-tool-catalog.md §1.2; 10-rest-api.md §2.6). Overwrites
 * a document's ENTIRE element tree in one optimistic-lock-guarded transaction. Destructive: when
 * `confirm!=true` it elicits a confirmation (flat-primitive schema, summarizing the would-be impact via
 * a local `dedupe`+pre-filter pass) — a DECLINE yields a CLEAN non-error result (Contract 12 §5.5).
 * `base_hash` is REQUIRED (§0.8); a stale hash → `CONCURRENCY_STALE_HASH`, and `force` overrides the
 * lock/autosave. Proxies `POST /documents/{id}/save` (full-tree replace). Returns
 * `{diff,preview_url,base_hash,css_primed}` plus `remapped_ids` (authored id → live id; local dedupe +
 * PHP-side remaps) whenever ids were remapped, so follow-up element ops target ids that exist.
 */
export async function pageReplaceTreeHandler(
  args: PageReplaceTreeArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    // Dedupe against the incoming tree itself (the replace wholesale-swaps the tree; live ids vanish).
    // `remapped` (authored id → live id) is surfaced in the result so follow-up ops target real ids.
    const { tree, remapped } = dedupe(args.elements);

    // Destructive gate: confirm before overwriting the whole tree. M-a/M-b: the decline result MUST
    // carry a schema-valid `structuredContent` (an empty diff + the caller's base_hash) — SDK 1.29
    // rejects a structured-content-less result on a tool with an outputSchema (-32602).
    if (!args.confirm) {
      const outcome = await ctx.elicit(
        `Replace the ENTIRE element tree of document ${args.post_id}? This overwrites all existing content (${tree.length} top-level node(s)).`,
      );
      if (!outcome.confirmed) {
        return declinedResult(
          `Replace cancelled by the user; document ${args.post_id} is unchanged.`,
          {
            diff: { changes: [], new_ids: [], changed_ids: [], removed_ids: [] },
            preview_url: '',
            base_hash: args.base_hash,
            css_primed: false,
          },
        );
      }
    }

    const saveBody: SaveDocumentRequest = {
      elements: toRestNodes(tree),
      base_hash: args.base_hash,
      ...(args.settings !== undefined ? { settings: args.settings } : {}),
      op_id: mintOpId(['page.replace_tree', args.post_id, args.base_hash, tree]),
      prime_css: args.prime_css,
      force: args.force,
      backup: true,
      verify_render: args.verify_render ?? false,
    };
    const saved: SaveDocumentResponse = await ctx.wp.saveDocument(args.post_id, saveBody);

    // Surface id remaps instead of dropping them: merge the local pre-save dedupe map with the
    // authoritative PHP-side remaps from the save response — the agent's authored ids may no longer
    // exist on the page, and follow-up element ops MUST use the remapped ids.
    const remappedIds: Record<string, string> = { ...remapped, ...(saved.remapped_ids ?? {}) };
    const remappedCount = Object.keys(remappedIds).length;
    const warnings: string[] = [];
    foldSaveWarnings(saved.warnings, warnings);
    foldRenderWarning(args.verify_render ?? false, saved, warnings);
    const diff = restDiffToDiff(saved.diff, saved.base_hash);
    const summary = summarizeDiff(diff);
    const structured: Record<string, unknown> = {
      diff,
      preview_url: saved.preview_url,
      base_hash: saved.base_hash,
      css_primed: saved.css_primed,
      ...(saved.render_verified !== undefined ? { render_verified: saved.render_verified } : {}),
      ...(remappedCount > 0 ? { remapped_ids: remappedIds } : {}),
      ...(saved.dropped_elements && saved.dropped_elements.length > 0
        ? { dropped_elements: saved.dropped_elements }
        : {}),
    };
    return okResult(
      structured,
      `Replaced tree of document ${args.post_id}: ${summary.added} added / ${summary.changed} changed / ${summary.removed} removed; css_primed=${saved.css_primed}.` +
        (remappedCount > 0
          ? ` ${remappedCount} element id(s) were remapped (${formatRemaps(remappedIds)}); use the new ids for follow-up ops.`
          : '') +
        (warnings.length > 0 ? ` Warnings: ${warnings.join(' | ')}` : ''),
    );
  });
}

/* ───────────────────────────── elementor.page.update_settings (§1.2 / §2.5) ─────────────────── */

/**
 * `elementor.page.update_settings` handler (M, 13-tool-catalog.md §1.2; 10-rest-api.md §2.5, Spike S4).
 * Sends the settings PATCH to `PUT /documents/{id}/settings`; PHP does GET-merge-PUT via
 * `Document::update_settings()` (deep `array_replace_recursive`, S4) so a PARTIAL patch never wipes
 * unrelated keys (the bare `save(['settings'])` would REPLACE wholesale — never used here). `base_hash`
 * is forwarded only when provided. Returns `{success,settings}` (the merged settings PHP echoes back).
 */
export async function pageUpdateSettingsHandler(
  args: PageUpdateSettingsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    // GATE LOCK (contract 17 §3) — a raw `post_status` flip to a publicly-visible state via
    // update_settings is the ONE publish path that does NOT run the conversion verify gate. A build
    // used exactly this (after the gate had reverted a bad conversion to DRAFT) to force-publish an
    // unverified page. Publishing a converted page must go through `elementor.convert.html_to_page`
    // (commit:true) — it runs the pixel/layout gate and reverts to draft on failure — or be done by
    // a human in wp-admin. update_settings changes page SETTINGS, never publication state to a live
    // status, so the bypass is closed at the seam.
    const settings = (args.settings ?? {}) as Record<string, unknown>;
    const nextStatus =
      typeof settings['post_status'] === 'string'
        ? (settings['post_status'] as string).toLowerCase()
        : undefined;
    if (nextStatus === 'publish' || nextStatus === 'private' || nextStatus === 'future') {
      return declinedResult(
        `Refused: setting post_status to "${nextStatus}" via page.update_settings bypasses the ` +
          `conversion verify gate (contract 17 §3). Publish a converted page through ` +
          `elementor.convert.html_to_page (commit:true) — it runs the pixel/layout gate and reverts ` +
          `to draft on failure — or set the status in wp-admin. Re-send update_settings WITHOUT a ` +
          `post_status key to change other page settings.`,
        { refused: true, reason: 'publish_bypasses_verify_gate', attempted_status: nextStatus },
      );
    }
    const body: UpdateDocumentSettingsRequest = {
      settings: args.settings,
      ...(args.base_hash !== undefined ? { base_hash: args.base_hash } : {}),
    };
    const data = await ctx.wp.updateDocumentSettings(args.post_id, body);
    return okResult(
      { success: data.success === true, settings: data.settings },
      `Updated settings on document ${args.post_id} (deep-merged; unrelated keys preserved).`,
    );
  });
}

/* ───────────────────────────── elementor.page.dry_run (§1.2 / §0.9 / §2.3) ──────────────────── */

/**
 * Map a PHP dry-run 422 envelope's `errors[]` (carried on a {@link WpClientError} as `fieldErrors`) to
 * the catalog `page.dry_run` error shape (`{element_id,style_id,prop:nullable, code, message}`,
 * 13-tool-catalog.md §1.2). The PHP `path` (e.g. `elements[0].styles.e-x-7.variants…`) is preserved in
 * the message tail when present so the agent can locate the offending node; the structured id/style/prop
 * fields stay `null` (the route does not split them out — the path carries the locus).
 */
function fieldErrorsToDryRunErrors(errors: RestFieldErrorLike[] | undefined): Array<{
  element_id: string | null;
  style_id: string | null;
  prop: string | null;
  code: string;
  message: string;
}> {
  return (errors ?? []).map((e) => {
    // The frozen RestFieldErrorLike is `{path,code,message,meta}`, but the live validator emits richer
    // items carrying `element_id`/`style_id`/`prop` (verified against the dev controller). Read them
    // defensively so the agent gets the locus where the validator provides it.
    const extra = e as RestFieldErrorLike & {
      element_id?: string;
      style_id?: string;
      prop?: string;
    };
    return {
      element_id: typeof extra.element_id === 'string' ? extra.element_id : null,
      style_id: typeof extra.style_id === 'string' ? extra.style_id : null,
      prop: typeof extra.prop === 'string' ? extra.prop : null,
      code: e.code,
      message: e.path ? `${e.message} (at ${e.path})` : e.message,
    };
  });
}

/**
 * `elementor.page.dry_run` handler (★, 13-tool-catalog.md §1.2; 10-rest-api.md §0.9 + §2.3). Runs the
 * cheap TS `prefilter` first (informational — never authoritative), then ALWAYS the PHP dry-run (the
 * SINGLE SOURCE OF TRUTH). An INVALID tree is a SUCCESS result `{valid:false,errors}`, NOT `isError`
 * (Contract 13 §1.2): the route wrapper throws on the PHP 422 envelope, so a `WpClientError` carrying
 * validation field-errors is caught here and normalized into the success shape. Any non-validation
 * error (auth, lock, 5xx) still routes through the standard surface path. `{id}=0` / no `post_id`
 * validates a brand-new tree (Contract 10 §2.3).
 */
export async function pageDryRunHandler(
  args: PageDryRunArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  // Resolve the effective generation (probe-gated v4→v3); the warning is informational for dry_run.
  const gate = await resolveGeneration(ctx, args.generation);

  // Cheap TS pre-filter (never authoritative). Deduping mirrors what a build would do, but we do NOT
  // mutate the caller's intent: PHP receives the ORIGINAL tree so its verdict is over the real input.
  const pre = prefilter(args.elements);

  const id = args.post_id ?? 0;
  const body: DryRunRequest = {
    elements: toRestNodes(args.elements),
    ...(args.settings !== undefined ? { settings: args.settings } : {}),
    generation: gate.generation,
  };

  try {
    const data: DryRunResponse = await ctx.wp.dryRunDocument(id, body);
    const diff = restDiffToDiff(data.diff);
    const structured: Record<string, unknown> = {
      valid: data.valid,
      errors: data.errors.map((e) => ({
        element_id: null,
        style_id: null,
        prop: null,
        code: e.code,
        message: e.path ? `${e.message} (at ${e.path})` : e.message,
      })),
      diff,
      ...(data.preview_url !== null ? { preview_url: data.preview_url } : {}),
    };
    return okResult(
      structured,
      `Dry-run ${data.valid ? 'PASSED' : 'FAILED'} (${data.errors.length} error(s); pre-filter verdict: ${pre.verdict}).`,
    ) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error) && isValidationFailure(error)) {
      // A FAILED validation is a SUCCESS result for this read-only tool (Contract 13 §1.2).
      const errors = fieldErrorsToDryRunErrors(error.fieldErrors);
      const structured: Record<string, unknown> = {
        valid: false,
        errors: errors.length > 0 ? errors : metaErrorsToDryRunErrors(error),
      };
      return okResult(
        structured,
        `Dry-run FAILED (${(structured['errors'] as unknown[]).length} error(s); pre-filter verdict: ${pre.verdict}).`,
      ) as CallToolResult;
    }
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/** Whether a client error is a tree-VALIDATION failure (normalized to a dry_run success result). */
function isValidationFailure(error: WpClientError): boolean {
  return (
    error.code === ErrorCodes.VALIDATION_FAILED ||
    error.code === ErrorCodes.ATOMIC_SETTINGS_INVALID ||
    error.code === ErrorCodes.ATOMIC_STYLES_INVALID ||
    // §7-AI S1 — document-settings allowlist violations are validation verdicts too (A1: the R4
    // build-#1 spec must FAIL dry_run with SETTINGS_INVALID as a success {valid:false} result).
    error.code === ErrorCodes.SETTINGS_INVALID
  );
}

/** Fallback dry_run errors from the payload meta when the envelope carried no `fieldErrors[]`. */
function metaErrorsToDryRunErrors(error: WpClientError): Array<{
  element_id: string | null;
  style_id: string | null;
  prop: string | null;
  code: string;
  message: string;
}> {
  return [
    {
      element_id: null,
      style_id: null,
      prop: null,
      code: error.code,
      message: error.message,
    },
  ];
}

/* ───────────────────────────── elementor.page.duplicate (§1.2 / §2.9) ───────────────────────── */

/**
 * `elementor.page.duplicate` handler (M, 13-tool-catalog.md §1.2; 10-rest-api.md §2.9). Proxies
 * `POST /documents/{id}/duplicate` to deep-copy a document + its meta (PHP regenerates ids). `title` is
 * forwarded only when provided. Returns `{post_id,edit_url}` (the catalog renames the REST `id` ⇒
 * `post_id`).
 */
export async function pageDuplicateHandler(
  args: PageDuplicateArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    const body: DuplicateDocumentRequest = {
      ...(args.title !== undefined ? { title: args.title } : {}),
    };
    const data = await ctx.wp.duplicateDocument(args.post_id, body);
    return okResult(
      { post_id: data.id, edit_url: data.edit_url },
      `Duplicated document ${args.post_id} → ${data.id}.`,
    );
  });
}

/* ───────────────────────────── elementor.page.delete (§1.2 / §2.9) ──────────────────────────── */

/**
 * `elementor.page.delete` handler (D, 13-tool-catalog.md §1.2; 10-rest-api.md §2.9). Destructive: when
 * `confirm!=true` it elicits a confirmation — a DECLINE yields a CLEAN non-error result
 * (Contract 12 §5.5). `force_delete` selects trash-vs-permanent (it maps to the REST `force` query):
 * default trashes (recoverable); `force_delete:true` deletes PERMANENTLY. Proxies
 * `DELETE /documents/{id}`. Returns `{success,trashed}`.
 */
export async function pageDeleteHandler(
  args: PageDeleteArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    if (!args.confirm) {
      const what = args.force_delete ? 'PERMANENTLY delete' : 'move to trash';
      const outcome = await ctx.elicit(`Confirm: ${what} document ${args.post_id}?`);
      if (!outcome.confirmed) {
        // M-b: decline carries a schema-valid structured payload (nothing was deleted/trashed).
        return declinedResult(
          `Delete cancelled by the user; document ${args.post_id} is unchanged.`,
          { success: false, trashed: false },
        );
      }
    }

    const query: DeleteDocumentRequest = { force: args.force_delete };
    const data = await ctx.wp.deleteDocument(args.post_id, query);
    return okResult(
      { success: data.deleted === true, trashed: data.trashed === true },
      `${data.trashed ? 'Trashed' : 'Deleted'} document ${args.post_id}.`,
    );
  });
}

/* ───────────────────────────── elementor.page.export_template (§1.2 / §2.9) ─────────────────── */

/**
 * Project the RAW REST `global_classes` map (`Record<string,unknown>`) to the catalog `global_classes`
 * ARRAY (each item a `GlobalClassObject` / `StyleDefinition`-shaped record — 13-tool-catalog.md §1.2,
 * validated by the descriptor's `globalClassObjectSchema`). The library-format export keys classes by
 * id; this flattens to the array shape the `outputSchema` expects, dropping any entry that is not a
 * well-formed class object (defensive — never loses tree data, just an unrepresentable side record).
 */
function projectGlobalClasses(raw: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const value of Object.values(raw)) {
    if (typeof value === 'object' && value !== null && 'id' in value && 'label' in value) {
      out.push(value);
    }
  }
  return out;
}

/**
 * `elementor.page.export_template` handler (R, 13-tool-catalog.md §1.2; 10-rest-api.md §2.9). Proxies
 * `POST /documents/{id}/export` to emit a document in library-format JSON. Returns
 * `{content,page_settings,type,version}` plus the bundled `global_classes` (projected RAW map ⇒ array)
 * and `global_variables` when present (both optional in the catalog `outputSchema`).
 */
export async function pageExportTemplateHandler(
  args: PageExportTemplateArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    const data: ExportDocumentResponse = await ctx.wp.exportDocument(args.post_id);
    const globalClasses = projectGlobalClasses(data.global_classes);
    const structured: Record<string, unknown> = {
      content: data.content,
      page_settings: data.page_settings,
      type: data.type,
      version: data.version,
      ...(globalClasses.length > 0 ? { global_classes: globalClasses } : {}),
      ...(Object.keys(data.global_variables).length > 0
        ? { global_variables: data.global_variables }
        : {}),
    };
    return okResult(
      structured,
      `Exported document ${args.post_id} as ${data.type} template (${data.content.length} top-level node(s)).`,
    );
  });
}

/* ───────────────────────────── elementor.page.list_backups (§1.2 / §2.8) ────────────────────── */

/**
 * `elementor.page.list_backups` handler (R, 13-tool-catalog.md §1.2; 10-rest-api.md §2.8). Proxies
 * `GET /documents/{id}/backups` to list the pre-write backup snapshots for a document (paginated).
 * Each item carries the `meta_key` (the rollback handle) + the as-of `base_hash`. Returns the
 * `{items,next_cursor,total}` collection.
 */
export async function pageListBackupsHandler(
  args: PageListBackupsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    const data: ListBackupsResponse = await ctx.wp.listBackups(args.post_id, {
      limit: args.limit,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.fields !== undefined ? { fields: args.fields } : {}),
    });
    const structured: Record<string, unknown> = {
      items: data.items,
      next_cursor: data.next_cursor,
      total: data.total,
    };
    return okResult(
      structured,
      `Listed ${data.items.length} backup snapshot(s) for document ${args.post_id} (total ${data.total}).`,
    );
  });
}

/* ───────────────────────────── elementor.page.rollback (§1.2 / §2.8) ─────────────────────────── */

/**
 * `elementor.page.rollback` handler (D, 13-tool-catalog.md §1.2; 10-rest-api.md §2.8). Restores a
 * document to a prior backup snapshot. `backup` is a snapshot `meta_key` (from
 * `elementor.page.list_backups`), or the literal `"latest"` to roll back to the most recent snapshot
 * (resolved here by listing backups and picking the newest by `ts`). Destructive: when `confirm!=true`
 * it elicits a confirmation — a DECLINE yields a CLEAN non-error result (Contract 12 §5.5). `prime_css`
 * re-primes atomic CSS after the restore. Proxies `POST /documents/{id}/rollback`. Returns
 * `{id,restored_from,base_hash,css_primed}`.
 */
export async function pageRollbackHandler(
  args: PageRollbackArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    // Resolve "latest" to the newest snapshot's meta_key (else use the explicit meta_key verbatim).
    let metaKey = args.backup;
    if (metaKey === 'latest') {
      // `limit` is capped at the route maximum (100, 10-rest-api.md §0.11). Backups per document are
      // few; the newest is resolved by `ts` below. (A value > 100 is rejected with rest_invalid_param.)
      const backups: ListBackupsResponse = await ctx.wp.listBackups(args.post_id, { limit: 100 });
      if (backups.items.length === 0) {
        const payload = makeErrorPayload(
          ErrorCodes.NOT_FOUND,
          `No backup snapshots exist for document ${args.post_id}; nothing to roll back to.`,
          { meta: { resource: 'backup', id: args.post_id } },
        );
        return {
          content: [{ type: 'text', text: payload.message }],
          structuredContent: {
            code: payload.code,
            message: payload.message,
            http_status: payload.http_status,
            retryable: payload.retryable,
            surface: payload.surface,
            meta: payload.meta,
          },
          isError: true,
        };
      }
      // Newest by ts (the snapshot list is not order-guaranteed across stores).
      const newest = backups.items.reduce((a, b) => (b.ts > a.ts ? b : a));
      metaKey = newest.meta_key;
    }

    // Destructive gate: confirm before overwriting the current state with the snapshot.
    if (!args.confirm) {
      const outcome = await ctx.elicit(
        `Roll back document ${args.post_id} to backup "${metaKey}"? This overwrites the current content with the snapshot.`,
      );
      if (!outcome.confirmed) {
        // M-b: decline carries a schema-valid structured payload (nothing was restored).
        return declinedResult(
          `Rollback cancelled by the user; document ${args.post_id} is unchanged.`,
          { id: args.post_id, restored_from: '', base_hash: '', css_primed: false },
        );
      }
    }

    const body: RollbackDocumentRequest = {
      meta_key: metaKey,
      prime_css: args.prime_css,
      op_id: mintOpId(['page.rollback', args.post_id, metaKey]),
    };
    const data: RollbackDocumentResponse = await ctx.wp.rollbackDocument(args.post_id, body);
    const structured: Record<string, unknown> = {
      id: data.id,
      restored_from: data.restored_from,
      base_hash: data.base_hash,
      css_primed: data.css_primed,
    };
    return okResult(
      structured,
      `Rolled back document ${data.id} to "${data.restored_from}"; base_hash=${data.base_hash}; css_primed=${data.css_primed}.`,
    );
  });
}

/* ───────────────────────────── elementor.page.verify_render (§7-AI S2) ──────────────────────── */

/**
 * `elementor.page.verify_render` handler (R, contract 18 §7-AI S2). Proxies
 * `POST /documents/{id}/verify-render`: the plugin fetches its own permalink unauthenticated
 * (in-process loopback; direct front-controller dispatch fallback is MANDATORY for containers that
 * cannot resolve their own siteurl), asserts HTTP 200 + no fatal marker, and op-logs the outcome.
 * A FAILED probe is a SUCCESS result with `render_verified:false` (the soft `RENDER_FAILED`
 * taxonomy code rides the payload) — the document is unchanged either way.
 */
export async function pageVerifyRenderHandler(
  args: PageVerifyRenderArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runPage(async () => {
    const data: VerifyRenderResponse = await ctx.wp.verifyRenderDocument(args.post_id);
    const structured: Record<string, unknown> = {
      id: data.id,
      render_verified: data.render_verified,
      method: data.method,
      http_status: data.http_status,
      fatal: data.fatal,
      checked_url: data.checked_url,
    };
    return okResult(
      structured,
      data.render_verified
        ? `Document ${data.id} renders cleanly (${data.method}${data.http_status !== null ? `, HTTP ${data.http_status}` : ''}).`
        : `RENDER_FAILED: document ${data.id} did NOT render cleanly (${data.method}: ${data.fatal ?? `HTTP ${data.http_status ?? 'unknown'}`}). The document is unchanged; inspect page settings or roll back.`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ─────────────────── */

/**
 * Attach every page-CRUD handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (ticket
 * §Detailed Requirements 1; §Acceptance). The registry stores handlers under its loose
 * `(args) => unknown` type; the runtime invokes them as `(args, ctx)` (the server core casts to the
 * WP-T01 {@link ToolHandler} signature), so each handler is registered through that signature here.
 */
export function attachPageHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [PAGE_CREATE]: (args, ctx) => pageCreateHandler(args as PageCreateArgs, ctx),
    [PAGE_BUILD]: (args, ctx) => pageBuildHandler(args as PageBuildArgs, ctx),
    [PAGE_REPLACE_TREE]: (args, ctx) => pageReplaceTreeHandler(args as PageReplaceTreeArgs, ctx),
    [PAGE_UPDATE_SETTINGS]: (args, ctx) =>
      pageUpdateSettingsHandler(args as PageUpdateSettingsArgs, ctx),
    [PAGE_DRY_RUN]: (args, ctx) => pageDryRunHandler(args as PageDryRunArgs, ctx),
    [PAGE_DUPLICATE]: (args, ctx) => pageDuplicateHandler(args as PageDuplicateArgs, ctx),
    [PAGE_DELETE]: (args, ctx) => pageDeleteHandler(args as PageDeleteArgs, ctx),
    [PAGE_EXPORT_TEMPLATE]: (args, ctx) =>
      pageExportTemplateHandler(args as PageExportTemplateArgs, ctx),
    [PAGE_LIST_BACKUPS]: (args, ctx) => pageListBackupsHandler(args as PageListBackupsArgs, ctx),
    [PAGE_ROLLBACK]: (args, ctx) => pageRollbackHandler(args as PageRollbackArgs, ctx),
    [PAGE_VERIFY_RENDER]: (args, ctx) =>
      pageVerifyRenderHandler(args as PageVerifyRenderArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
