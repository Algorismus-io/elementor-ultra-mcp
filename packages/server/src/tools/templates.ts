/**
 * WP-T10 — templates / kits tool HANDLERS (Contract 13 §1.7) + attachment to the WP-F04 registry.
 *
 * Implements the eight §1.7 templates/kits tools and attaches each to the WP-F04 {@link ToolRegistry}
 * by EXACT catalog name (13-tool-catalog.md §1.7). WP-F04 owns the descriptors
 * (`catalog/schemas/templates.ts`); the SDK has already validated `args` against `inputSchema` before a
 * handler runs and validates the returned `structuredContent` against `outputSchema` after
 * (Contract 13 §0.1). Handlers receive the single WP-T01 {@link ToolContext}.
 *
 * Tools handled here (Contract 13 §1.7 — none are ★, §5.2):
 *  - `elementor.templates.list`            (R, `GET /templates`) — paginated list + `type` filter.
 *  - `elementor.templates.get`             (R, `GET /templates/{id}`) — content + page_settings + type.
 *  - `elementor.templates.save`            (M, `POST /templates`) — pre-filter then persist (ids
 *    regenerated PHP-side by `Source_Local::save_item`; atomic-V4 correctness gated on Spike S2).
 *  - `elementor.templates.import`          (M, `POST /templates/import`) — image sideload + id remap +
 *    global-class/variable merge (PHP); surfaces `remapped_ids`; remap failure → `IMPORT_REMAP_FAILED`.
 *  - `elementor.templates.insert_into_page` (M, `POST /templates/{id}/insert`) — paste a block, minting
 *    FRESH ids over the inserted subtree against the document used-id set (Contract 11 §4.6) so a paste
 *    cannot collide; PHP validates+saves+primes; returns `{diff,base_hash}`.
 *  - `elementor.kit.export`                (R, `POST /kit/export`) — full-site kit export.
 *  - `elementor.kit.import`                (D, `POST /kit/import`) — elicitation-gated upload + import.
 *  - `elementor.kit.revert`                (D, `POST /kit/revert`) — elicitation-gated revert.
 *
 * THIN-PROXY MODEL (§Implementation Notes): kit ops are heavy/PHP-orchestrated, so the tools are thin
 * proxies + elicitation gating. The element-tree writes (`save`/`insert_into_page`) get a cheap TS
 * `prefilter` (WP-F03) for fast structural feedback WITHOUT a REST round-trip, but PHP remains the
 * AUTHORITATIVE validator (Contract 10 §0.9): a 422 writes NOTHING and surfaces here via the client
 * error path. `insert_into_page` is the highest-risk handler — it mints FRESH ids over the inserted
 * subtree (Spike S2: `save_item`/insert re-IDs elements AND dependent local-style ids) so the SAME
 * template pasted twice into one page never duplicates an id.
 *
 * FROZEN-TYPE vs LIVE divergences (read defensively, mirroring `tools/page.ts`):
 *  - `SaveTemplateResponse` is `{template_id,type}` but the catalog `outputSchema` requires `edit_url`;
 *    the LIVE P12 controller emits `edit_url` (like `page.create`), read defensively, `''` last resort.
 *  - `ImportTemplateResponse` is `{imported_ids,warnings}` but the catalog requires
 *    `{template_id,remapped_ids}`; map `imported_ids[0]`⇒`template_id` and read a PHP-supplied
 *    `remapped_ids` defensively (else `{}`).
 *  - `InsertTemplateResponse` is `{success,inserted_ids,base_hash,css_primed}` but the catalog requires
 *    `{diff,base_hash}`; synthesize a `Diff` from `inserted_ids` (one `added` NodeChange per id) and
 *    surface `css_primed` in the result text (the descriptor does NOT declare it).
 *  - `KitExportResponse.download_url`⇒catalog `file_path`; `KitRevertResponse.reverted`⇒catalog
 *    `success`; the catalog `kit.import` input `file`⇒REST `file_path`.
 *
 * Contract authority: 13-tool-catalog.md §1.7 (per-tool I/O), §0.6 (pagination), §0.7 (diff/base_hash),
 * §0.8 (base_hash on insert), §0.9 (input/business error split). 10-rest-api.md §7 (templates/kits),
 * §10 (used-id set). 11-authoring-contract.md §4.6 (replace ALL ids on insert). 12-error-taxonomy.md
 * §3.5 (`IMPORT_REMAP_FAILED`), §5 (surface rules), §5.5 (clean decline).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  isErrorCode,
  makeErrorPayload,
  type DocumentIdsResponse,
  type ElementNode as RestElementNode,
  type GetTemplateResponse,
  type ImportTemplateRequest,
  type ImportTemplateResponse,
  type InsertTemplateRequest,
  type InsertTemplateResponse,
  type KitExportRequest,
  type KitExportResponse,
  type KitImportRequest,
  type KitImportResponse,
  type KitRevertRequest,
  type KitRevertResponse,
  type ListTemplatesRequest,
  type ListTemplatesResponse,
  type SaveTemplateRequest,
  type SaveTemplateResponse,
  type TemplateListItem,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import type { ToolRegistry } from '../catalog/registry.js';
import { WpClientError } from '../wp/types.js';
import { fromClientError, declinedResult, type ToolResult } from '../wp/errors.js';

import type { Diff, ElementNode, NodeChange, ValidationError } from '../authoring/contract.js';
import { collectIds, dedupe } from '../authoring/ids.js';
import { prefilter } from '../authoring/prefilter.js';
import { presentDiff, summarizeDiff } from '../safety/diff.js';
import { mintOpId } from '../safety/idempotency.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.7) ────────────────────────── */

/** The templates / kits tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.7). */
export const TEMPLATES_LIST = 'elementor.templates.list';
export const TEMPLATES_GET = 'elementor.templates.get';
export const TEMPLATES_SAVE = 'elementor.templates.save';
export const TEMPLATES_IMPORT = 'elementor.templates.import';
export const TEMPLATES_INSERT_INTO_PAGE = 'elementor.templates.insert_into_page';
export const KIT_EXPORT = 'elementor.kit.export';
export const KIT_IMPORT = 'elementor.kit.import';
export const KIT_REVERT = 'elementor.kit.revert';

/** Every §1.7 tool name this WP owns a handler for (used by attach + tests). */
export const TEMPLATES_TOOL_NAMES = [
  TEMPLATES_LIST,
  TEMPLATES_GET,
  TEMPLATES_SAVE,
  TEMPLATES_IMPORT,
  TEMPLATES_INSERT_INTO_PAGE,
  KIT_EXPORT,
  KIT_IMPORT,
  KIT_REVERT,
] as const;

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
 * Run a templates/kits handler, routing any caught {@link WpClientError} (e.g. `IMPORT_REMAP_FAILED`,
 * `CONCURRENCY_STALE_HASH`, `VALIDATION_FAILED`, `NOT_FOUND` from PHP) through WP-F05's surface rules
 * (`fromClientError` → protocol-throw vs `isError` result, 12-error-taxonomy.md §5). Non-client errors
 * rethrow (the server core surfaces them). The {@link ToolResult} is structurally a
 * {@link CallToolResult}.
 */
async function runTpl(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
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

/* ───────────────────────────── pre-filter → reject result (Contract 13 §0.9) ────────────────── */

/**
 * Build a structured `isError` tool result from a hard pre-filter REJECT (WP-F03 `prefilter`) — fast
 * structural feedback WITHOUT a REST round-trip (§Detailed Requirements 2/3). Codes are the taxonomy
 * codes the pre-filter assigns (`VALIDATION_FAILED`/`ATOMIC_*`); the aggregate result carries the
 * per-node errors as `VALIDATION_FAILED` meta so the agent can act on them (mirrors `tools/page.ts`).
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
    `Template content pre-filter rejected the tree (${errors.length} structural error${errors.length === 1 ? '' : 's'}).`,
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

/* ───────────────────────────── inserted-ids → frozen Diff (Contract 13 §0.7) ────────────────── */

/**
 * Synthesize the frozen rich {@link Diff} the catalog `insert_into_page` `outputSchema` requires
 * (`changes[]` mandatory, Contract 11 §1 / `diff.schema.json`) from the REST insert response's
 * `inserted_ids` rollup (Contract 10 §7). One `added` {@link NodeChange} per inserted id — PHP owns the
 * AUTHORITATIVE post-write state, but the insert route only ships the inserted-id rollup, so this
 * faithfully re-expresses that rollup in the frozen shape (it never fabricates an id PHP did not name).
 * {@link presentDiff} (WP-T03) then validates the synthesized diff against the frozen schema.
 */
function insertedIdsToDiff(insertedIds: unknown, baseHashAfter: string): Diff {
  const ids = coerceIdList(insertedIds);
  const changes: NodeChange[] = ids.map((id) => ({ id, op: 'added' as const }));
  const diff: Diff = {
    changes,
    new_ids: ids,
    changed_ids: [],
    removed_ids: [],
    ...(BASE_HASH_PATTERN.test(baseHashAfter) ? { base_hash_after: baseHashAfter } : {}),
  };
  return presentDiff(diff);
}

/** A 32-hex `base_hash` (the strict `diff.schema.json` `base_hash_*` pattern). */
const BASE_HASH_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Coerce an upstream id rollup to a clean `string[]`: string-ify scalar ids, drop empties / non-scalars.
 * Defensive against PHP serializing a styles-map id as a number (mirrors `tools/page.ts`/`tools/widget.ts`).
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

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (Contract 13 §0.1), so the shapes below describe the POST-validation input — narrowing views over the
 * loose `unknown` the runtime {@link ToolHandler} declares, NOT re-validation. `content` (when present)
 * arrives as the STRICT WP-F03 authoring {@link ElementNode}; `import_mode`/`confirm` carry their
 * descriptor `.default(...)` so they arrive concrete.
 */

interface TemplatesListArgs {
  type?: string;
  limit: number;
  cursor?: string;
  fields?: string[];
}

interface TemplatesGetArgs {
  template_id: number;
}

interface TemplatesSaveArgs {
  title: string;
  type: string;
  content: ElementNode[];
  page_settings?: Record<string, unknown>;
}

interface TemplatesImportArgs {
  file_path?: string;
  content?: unknown;
  import_mode: 'match_site' | 'keep_existing';
}

interface TemplatesInsertIntoPageArgs {
  post_id: number;
  template_id?: number;
  content?: ElementNode[];
  parent_id?: string;
  index?: number;
  base_hash: string;
}

interface KitExportArgs {
  include: Array<'content' | 'templates' | 'settings' | 'plugins'>;
  kitInfo?: Record<string, unknown>;
  customization?: Record<string, unknown>;
}

interface KitImportArgs {
  session?: string;
  file?: string;
  include: string[];
  customization?: Record<string, unknown>;
  confirm: boolean;
}

interface KitRevertArgs {
  session: string;
  confirm: boolean;
}

/* ───────────────────────────── elementor.templates.list (§1.7 / §7 / §0.6) ──────────────────── */

/**
 * `elementor.templates.list` handler (R, 13-tool-catalog.md §1.7; 10-rest-api.md §7). Proxies
 * `GET /templates` with an optional `type` filter + §0.6 pagination (`limit`/`cursor`/`fields`), then
 * projects each RAW {@link TemplateListItem} (`{template_id,title,type}`) to the catalog item
 * `{template_id,title,type,source}`. The library-list route is `Source_Local`-backed, so `source`
 * defaults to `'local'` when PHP does not surface one (read defensively). NEVER unbounded — the SDK
 * supplies the default `limit` (§0.6). `type`/`cursor`/`fields` are forwarded only when provided.
 */
export async function templatesListHandler(
  args: TemplatesListArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runTpl(async () => {
    const query: ListTemplatesRequest = {
      ...(args.type !== undefined ? { type: args.type } : {}),
      limit: args.limit,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.fields !== undefined ? { fields: args.fields } : {}),
    };
    const data: ListTemplatesResponse = await ctx.wp.listTemplates(query);
    const items = data.items.map((item: TemplateListItem) => ({
      template_id: item.template_id,
      title: item.title,
      type: item.type,
      // `source` is required by the catalog item schema; `Source_Local` is the library backing store.
      // Read a PHP-supplied `source` defensively, else default to 'local'.
      source: readSource(item),
    }));
    const structured = {
      items,
      next_cursor: data.next_cursor,
      total: data.total ?? items.length,
    };
    return okResult(
      structured,
      `Listed ${items.length} template(s)${args.type !== undefined ? ` of type "${args.type}"` : ''}${data.next_cursor !== null ? ' (more available)' : ''}.`,
    );
  });
}

/** Read a PHP-supplied `source` off a template list item (the live controller may emit it), else 'local'. */
function readSource(item: TemplateListItem): string {
  const source = (item as TemplateListItem & { source?: unknown }).source;
  return typeof source === 'string' && source.length > 0 ? source : 'local';
}

/* ───────────────────────────── elementor.templates.get (§1.7 / §7) ──────────────────────────── */

/**
 * `elementor.templates.get` handler (R, 13-tool-catalog.md §1.7; 10-rest-api.md §7). Proxies
 * `GET /templates/{id}` and returns `{content,page_settings,type}` (the RAW response also carries
 * `template_id`/`title`, dropped from the catalog `outputSchema`). A bad template id arrives as a
 * {@link WpClientError} (`NOT_FOUND`) and routes through the surface rules.
 */
export async function templatesGetHandler(
  args: TemplatesGetArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runTpl(async () => {
    const data: GetTemplateResponse = await ctx.wp.getTemplate(args.template_id);
    const structured = {
      content: data.content,
      page_settings: data.page_settings,
      type: data.type,
    };
    return okResult(
      structured,
      `Read template ${args.template_id} ("${data.title}", type ${data.type}; ${data.content.length} top-level node(s)).`,
    );
  });
}

/* ───────────────────────────── elementor.templates.save (§1.7 / §7 / §0.9) ──────────────────── */

/**
 * `elementor.templates.save` handler (M, 13-tool-catalog.md §1.7; 10-rest-api.md §7). Pipeline
 * (§Detailed Requirements 2):
 *  a. Cheap TS `prefilter` on `content` — a hard `reject` returns an `isError` with structural codes
 *     WITHOUT any REST round-trip (fast feedback); `defer`/`accept` proceed (PHP is authoritative).
 *  b. Proxy `POST /templates` — PHP validates content AUTHORITATIVELY (§0.9) then persists via
 *     `Source_Local::save_item`, which REGENERATES ids (the ids the caller authored are not stable;
 *     do NOT depend on them). A 422 writes NOTHING and surfaces via the client error path.
 *
 * Returns `{template_id,edit_url}` — `edit_url` is read from the LIVE controller's response (it emits
 * one like `page.create`; the frozen `SaveTemplateResponse` omits it), `''` as a last resort so the
 * descriptor `outputSchema` always validates. A deterministic `op_id` is threaded so a retried save
 * collapses to a PHP replay. Atomic-V4 correctness is SPIKE-GATED on S2 (§Implementation Notes).
 */
export async function templatesSaveHandler(
  args: TemplatesSaveArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runTpl(async () => {
    // (a) cheap structural pre-filter — a hard reject short-circuits WITHOUT any REST round-trip.
    const pre = prefilter(args.content);
    if (pre.verdict === 'reject') {
      return prefilterRejectResult(pre.errors);
    }

    // (b) persist (PHP authoritative validation + Source_Local::save_item id regeneration).
    const body: SaveTemplateRequest = {
      title: args.title,
      type: args.type,
      content: toRestNodes(args.content),
      ...(args.page_settings !== undefined ? { page_settings: args.page_settings } : {}),
      op_id: mintOpId(['templates.save', args.title, args.type, args.content]),
    };
    const data: SaveTemplateResponse = await ctx.wp.saveTemplate(body);
    const structured = {
      template_id: data.template_id,
      edit_url: readEditUrl(data),
    };
    return okResult(
      structured,
      `Saved template ${data.template_id} ("${args.title}", type ${data.type}; ids regenerated).`,
    );
  });
}

/** Read a PHP-supplied `edit_url` off a save response (the live controller emits it), else ''. */
function readEditUrl(data: SaveTemplateResponse): string {
  const editUrl = (data as SaveTemplateResponse & { edit_url?: unknown }).edit_url;
  return typeof editUrl === 'string' ? editUrl : '';
}

/* ───────────────────────────── elementor.templates.import (§1.7 / §7 / §3.5) ────────────────── */

/**
 * `elementor.templates.import` handler (M, 13-tool-catalog.md §1.7; 10-rest-api.md §7;
 * 12-error-taxonomy.md §3.5). Proxies `POST /templates/import` with ONE of `file_path`/`content` +
 * `import_mode` (`match_site|keep_existing`). PHP sideloads images, REMAPS ids, and merges global
 * classes/variables (S2-adjacent — Spike S2: image sideload only on FILE import; `match_site` reuses
 * by LABEL, `keep_existing` mints fresh `g-` classes + remaps). The frozen `ImportTemplateResponse` is
 * `{imported_ids,warnings}`; the catalog requires `{template_id,remapped_ids}`, so this maps
 * `imported_ids[0]`⇒`template_id` and reads a PHP-supplied `remapped_ids` defensively (else `{}`).
 *
 * A REMAP failure surfaces as a {@link WpClientError} carrying `IMPORT_REMAP_FAILED` (PHP raises it,
 * `surface:'isError'`) which `runTpl`→`fromClientError` renders as an `isError` result (§Detailed
 * Requirements 4) — never re-fabricated here.
 */
export async function templatesImportHandler(
  args: TemplatesImportArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runTpl(async () => {
    const body: ImportTemplateRequest = {
      ...(args.file_path !== undefined ? { file_path: args.file_path } : {}),
      ...(args.content !== undefined ? { content: args.content as Record<string, unknown> } : {}),
      import_mode: args.import_mode,
      op_id: mintOpId([
        'templates.import',
        args.file_path ?? null,
        args.content ?? null,
        args.import_mode,
      ]),
    };
    const data: ImportTemplateResponse = await ctx.wp.importTemplate(body);
    const templateId = data.imported_ids[0] ?? 0;
    const structured = {
      template_id: templateId,
      remapped_ids: readRemappedIds(data),
    };
    const warned = data.warnings.length > 0 ? ` (${data.warnings.length} warning(s))` : '';
    return okResult(
      structured,
      `Imported template ${templateId} (mode ${args.import_mode}; ${data.imported_ids.length} item(s))${warned}.`,
    );
  });
}

/** Read a PHP-supplied `remapped_ids` map off an import response (the live controller may emit it), else {}. */
function readRemappedIds(data: ImportTemplateResponse): Record<string, string> {
  const raw = (data as ImportTemplateResponse & { remapped_ids?: unknown }).remapped_ids;
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [oldId, newId] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof newId === 'string') {
      out[oldId] = newId;
    } else if (typeof newId === 'number' || typeof newId === 'bigint') {
      out[oldId] = String(newId);
    }
  }
  return out;
}

/* ───────────────────────────── elementor.templates.insert_into_page (§1.7 / §7 / §0.8) ──────── */

/**
 * `elementor.templates.insert_into_page` handler (M, 13-tool-catalog.md §1.7; 10-rest-api.md §7;
 * 11-authoring-contract.md §4.6). Pastes a block into a document. Either `template_id` OR inline
 * `content` (the descriptor allows both optional; this REQUIRES exactly one). `base_hash` is REQUIRED
 * (§0.8 — this is an element write). Pipeline (§Detailed Requirements 3):
 *  a. When inline `content` is supplied, obtain the live document used-id set via `documentIds`
 *     (`GET /documents/{id}/ids`, Contract 10 §10) and mint FRESH ids over the ENTIRE inserted subtree
 *     (replace ALL ids on insert, Contract 11 §4.6) — incl. local-style mirrors — so a paste cannot
 *     collide with the document OR with a second paste of the same template. Achieved by seeding
 *     `dedupe`'s seen-set with BOTH the live ids AND the subtree's own ids, so even the FIRST occurrence
 *     of each subtree id collides and is re-minted. A cheap `prefilter` then gives fast feedback.
 *  b. Proxy `POST /templates/{id}/insert`: PHP runs the AUTHORITATIVE validator + save + (for atomic
 *     subtrees) primes CSS; a 422/409 surfaces via the client error path. For a `template_id` paste,
 *     PHP loads the template content and mints fresh ids server-side (Spike S2), so no TS id pass.
 *
 * Returns `{diff,base_hash}` (the catalog `outputSchema`). `css_primed` is reported in the result TEXT
 * (the descriptor does not declare a `css_primed` output key). A deterministic `op_id` collapses a retry.
 */
export async function templatesInsertIntoPageHandler(
  args: TemplatesInsertIntoPageArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runTpl(async () => {
    const hasContent = args.content !== undefined && args.content.length > 0;
    const hasTemplate = args.template_id !== undefined;
    if (hasContent === hasTemplate) {
      // Exactly one of `template_id` / `content` is required (Contract 10 §7: one OR the other).
      const payload = makeErrorPayload(
        ErrorCodes.VALIDATION_FAILED,
        'templates.insert_into_page requires exactly ONE of `template_id` or non-empty `content`.',
        { meta: {} },
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

    let freshContent: ElementNode[] | undefined;
    if (hasContent) {
      // (a) FRESH-id mint over the WHOLE inserted subtree against the live document used-id set.
      const liveIds: DocumentIdsResponse = await ctx.wp.documentIds(args.post_id);
      // Seed the seen-set with BOTH the live document ids AND the subtree's own ids, so EVERY subtree
      // id (even the first occurrence) collides and is re-minted — replacing ALL ids on insert
      // (Contract 11 §4.6), so the same template pasted twice never collides.
      const seen = new Set<string>([
        ...liveIds.ids,
        ...liveIds.local_style_ids,
        ...collectIds(args.content as ElementNode[]),
      ]);
      const { tree } = dedupe(args.content as ElementNode[], seen);
      freshContent = tree;

      // Cheap structural pre-filter — a hard reject short-circuits WITHOUT any REST round-trip.
      const pre = prefilter(freshContent);
      if (pre.verdict === 'reject') {
        return prefilterRejectResult(pre.errors);
      }
    }

    // (b) proxy the insert. The route id is the template id (0 for an inline-content paste, which PHP
    // dispatches on the `content` body field).
    const routeId = args.template_id ?? 0;
    const body: InsertTemplateRequest = {
      post_id: args.post_id,
      base_hash: args.base_hash,
      ...(args.parent_id !== undefined ? { parent_id: args.parent_id } : {}),
      ...(args.index !== undefined ? { index: args.index } : {}),
      ...(freshContent !== undefined ? { content: toRestNodes(freshContent) } : {}),
      op_id: mintOpId([
        'templates.insert_into_page',
        args.post_id,
        args.template_id ?? null,
        args.parent_id ?? null,
        args.index ?? null,
        args.base_hash,
        freshContent ?? null,
      ]),
    };
    const data: InsertTemplateResponse = await ctx.wp.insertTemplate(routeId, body);

    const diff = insertedIdsToDiff(data.inserted_ids, data.base_hash);
    const summary = summarizeDiff(diff);
    const structured = {
      diff,
      base_hash: data.base_hash,
    };
    const cssNote = data.css_primed
      ? 'css_primed=true'
      : 'css_primed=false (re-prime if the subtree is atomic and renders unstyled)';
    return okResult(
      structured,
      `Inserted ${summary.added} node(s) into document ${args.post_id} (fresh ids); ${cssNote}.`,
    );
  });
}

/* ───────────────────────────── elementor.kit.export (§1.7 / §7) ─────────────────────────────── */

/**
 * `elementor.kit.export` handler (R, 13-tool-catalog.md §1.7; 10-rest-api.md §7). Proxies
 * `POST /kit/export` (read-only — it produces a zip, no destructive change). The frozen
 * `KitExportResponse.download_url` maps to the catalog `file_path`; `session` passes through. A thin
 * proxy (kit ops are PHP-orchestrated, §Implementation Notes). `kitInfo`/`customization` forwarded only
 * when provided.
 */
export async function kitExportHandler(
  args: KitExportArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runTpl(async () => {
    const body: KitExportRequest = {
      include: args.include,
      ...(args.kitInfo !== undefined ? { kitInfo: args.kitInfo } : {}),
      ...(args.customization !== undefined ? { customization: args.customization } : {}),
    };
    const data: KitExportResponse = await ctx.wp.kitExport(body);
    const structured = {
      file_path: data.download_url,
      session: data.session,
    };
    return okResult(
      structured,
      `Exported kit (session ${data.session}; include: ${args.include.join(', ') || 'none'}).`,
    );
  });
}

/* ───────────────────────────── elementor.kit.import (D, §1.7 / §7) ──────────────────────────── */

/**
 * `elementor.kit.import` handler (D, 13-tool-catalog.md §1.7; 10-rest-api.md §7). DESTRUCTIVE — when
 * `confirm!=true` it ELICITS a confirm round-trip (Contract 13 §0.3); a DECLINE returns a CLEAN
 * non-error result (Contract 12 §5.5), no REST call made. On confirm it proxies `POST /kit/import`. The
 * catalog input `file` maps to the REST `file_path`; `session`/`customization` forwarded only when
 * provided. The frozen `KitImportResponse` is `{session,imported,warnings}`; the catalog returns
 * `{session,imported}` (warnings folded into the result text). A thin proxy + elicitation gating.
 */
export async function kitImportHandler(
  args: KitImportArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runTpl(async () => {
    if (args.confirm !== true) {
      const outcome = await ctx.elicit(
        `Import a kit into this site? This is DESTRUCTIVE — it overwrites content/settings/templates per the selected scope (${args.include.join(', ') || 'none'}). Revert with elementor.kit.revert using the returned session.`,
      );
      if (!outcome.confirmed) {
        // M-b: decline carries a schema-valid structured payload (nothing was imported).
        return declinedResult('Kit import cancelled by the user; the site is unchanged.', {
          session: args.session ?? '',
          imported: {},
        });
      }
    }

    const body: KitImportRequest = {
      ...(args.session !== undefined ? { session: args.session } : {}),
      ...(args.file !== undefined ? { file_path: args.file } : {}),
      include: args.include,
      ...(args.customization !== undefined ? { customization: args.customization } : {}),
    };
    const data: KitImportResponse = await ctx.wp.kitImport(body);
    const structured = {
      session: data.session,
      imported: data.imported,
    };
    const warned = data.warnings.length > 0 ? ` (${data.warnings.length} warning(s))` : '';
    return okResult(
      structured,
      `Imported kit (session ${data.session})${warned}. Revert with kit.revert if needed.`,
    );
  });
}

/* ───────────────────────────── elementor.kit.revert (D, §1.7 / §7) ──────────────────────────── */

/**
 * `elementor.kit.revert` handler (D, 13-tool-catalog.md §1.7; 10-rest-api.md §7). DESTRUCTIVE — when
 * `confirm!=true` it ELICITS a confirm round-trip; a DECLINE returns a CLEAN non-error result
 * (Contract 12 §5.5), no REST call made. On confirm it proxies `POST /kit/revert` to undo a prior import
 * session. The frozen `KitRevertResponse.reverted` maps to the catalog `success`. A thin proxy +
 * elicitation gating.
 */
export async function kitRevertHandler(
  args: KitRevertArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runTpl(async () => {
    if (args.confirm !== true) {
      const outcome = await ctx.elicit(
        `Revert kit import session "${args.session}"? This undoes the import and restores the prior state.`,
      );
      if (!outcome.confirmed) {
        // M-b: decline carries a schema-valid structured payload (nothing was reverted).
        return declinedResult(
          `Kit revert cancelled by the user; import session "${args.session}" is unchanged.`,
          { success: false },
        );
      }
    }

    const body: KitRevertRequest = { session: args.session };
    const data: KitRevertResponse = await ctx.wp.kitRevert(body);
    return okResult(
      { success: data.reverted === true },
      `Reverted kit import session "${args.session}".`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ─────────────────── */

/**
 * Attach every templates / kits handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name
 * (§Detailed Requirements 1; §Acceptance). The registry stores handlers under its loose
 * `(args) => unknown` type; the runtime invokes them as `(args, ctx)` (the server core casts to the
 * WP-T01 {@link ToolHandler} signature), so each handler is registered through that signature here.
 */
export function attachTemplatesHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [TEMPLATES_LIST]: (args, ctx) => templatesListHandler(args as TemplatesListArgs, ctx),
    [TEMPLATES_GET]: (args, ctx) => templatesGetHandler(args as TemplatesGetArgs, ctx),
    [TEMPLATES_SAVE]: (args, ctx) => templatesSaveHandler(args as TemplatesSaveArgs, ctx),
    [TEMPLATES_IMPORT]: (args, ctx) => templatesImportHandler(args as TemplatesImportArgs, ctx),
    [TEMPLATES_INSERT_INTO_PAGE]: (args, ctx) =>
      templatesInsertIntoPageHandler(args as TemplatesInsertIntoPageArgs, ctx),
    [KIT_EXPORT]: (args, ctx) => kitExportHandler(args as KitExportArgs, ctx),
    [KIT_IMPORT]: (args, ctx) => kitImportHandler(args as KitImportArgs, ctx),
    [KIT_REVERT]: (args, ctx) => kitRevertHandler(args as KitRevertArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
