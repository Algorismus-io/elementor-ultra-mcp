/**
 * WP-R10 — Pro Loop Builder tool HANDLERS (Contract 13 §1.8; SUPPLEMENT.md §A.4/§A.7).
 *
 * Implements the two Pro Loop Builder tools and attaches each handler to the WP-F04 {@link ToolRegistry}
 * by EXACT catalog name (13-tool-catalog.md §1.8). This WP does NOT define schemas (WP-F04 owns the
 * descriptors `catalog/schemas/pro.ts`) — each handler is a {@link ToolHandler} (WP-T01
 * `runtime/context.ts`) attached via `registry.attachHandler(name, fn)`; the SDK has already validated
 * `args` against the descriptor's `inputSchema` (incl. the `skin`/`widget` enums and the `query` object)
 * before the handler runs (Contract 13 §0.1) and validates the returned `structuredContent` against
 * `outputSchema` after.
 *
 * Handlers are THIN proxies over the WP-F02 bound facade (`ctx.wp.*`): validate-by-SDK →
 * `ctx.wp.<route>(…)` → map the RAW REST `data` into the descriptor's `outputSchema` shape → return
 * `{ content, structuredContent }`. ALL business logic lives in PHP (WP-R04 `Loop_Service` /
 * `Loop_Query_Mapper`, Contract 15 §4.7): the `{skin}_query_` key prefixing, the top-level
 * `posts_per_page`/`columns` placement, the `_skin` set, AND the load-bearing loop-item assertion
 * (`template_id._elementor_template_type == 'loop-item'`, `base.php:32-35` / `loop-grid.php:154-190`).
 * These handlers add NO business logic and DO NOT pre-prefix the query keys — they send the ERGONOMIC
 * `{skin,query,posts_per_page,columns}` shape so PHP remains the single source of truth for the prefix
 * derivation (§Implementation Notes; §Detailed Requirements 1).
 *
 * Tools handled here (Contract 13 §1.8 — both NON-★, registered disabled at boot, enabled via
 * `tools.search` matching `elementor.pro.loop*`):
 *  - `elementor.pro.loop.create_item` (M, `POST /pro/loop/item`)      — create a loop-item template doc.
 *  - `elementor.pro.loop.bind_grid`   (BOTH, `POST /pro/loop/bind-grid`) — configure a loop-grid/carousel.
 *
 * Error mapping (Contract 13 §0.9, Contract 12 §3): a Pro-inactive 501 (`PRO_REQUIRED`), a stale
 * `base_hash` 409 (`CONCURRENCY_STALE_HASH`), a 404 (`NOT_FOUND`) arrive as a {@link WpClientError}
 * carrying the taxonomy payload and route through WP-F05's `fromClientError` → protocol-throw vs
 * `isError` result. The ONE handler-specific remap (§Detailed Requirements 5): a non-loop-item
 * `template_id` — the live PHP route returns `ATOMIC_SETTINGS_INVALID` (422) with
 * `meta.rest_code == 'E_LOOP_TEMPLATE_INVALID'` + `meta.actual_type` — is re-emitted as
 * `VALIDATION_FAILED` with ACTIONABLE text steering the agent to `elementor.pro.loop.create_item`
 * (the frozen surface for this case, §1.8). Tool-arg failures (a `skin`/`widget` outside the enum, a
 * malformed `query`) are `-32602` from the SDK's zod layer before the handler runs.
 *
 * Contract authority: 13-tool-catalog.md §1.8 (per-tool I/O), §0.9 (error semantics); 10-rest-api.md
 * §8.6 (REST shapes the client wraps; the `{skin}_query_` prefix + top-level `posts_per_page`/`columns`
 * + loop-item assertion); 12-error-taxonomy.md §3 (`PRO_REQUIRED`, `E_LOOP_TEMPLATE_INVALID`), §5
 * (surface rules); 15 §4.7 (business logic in PHP); SUPPLEMENT.md §A.4/§A.7 (query semantics).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  makeErrorPayload,
  type CreateLoopItemRequest,
  type CreateLoopItemResponse,
  type BindLoopGridRequest,
  type BindLoopGridResponse,
  type ElementNode,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../../runtime/context.js';
import type { ToolRegistry } from '../../catalog/registry.js';
import { WpClientError } from '../../wp/types.js';
import { fromClientError, toToolErrorResult, type ToolResult } from '../../wp/errors.js';
import { mintOpId, isReplay } from '../../safety/idempotency.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.8) ─────────────────────────── */

/** The Pro Loop Builder tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.8). */
export const PRO_LOOP_CREATE_ITEM = 'elementor.pro.loop.create_item';
export const PRO_LOOP_BIND_GRID = 'elementor.pro.loop.bind_grid';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const PRO_LOOP_TOOL_NAMES = [PRO_LOOP_CREATE_ITEM, PRO_LOOP_BIND_GRID] as const;

/**
 * The PHP `meta.rest_code` label that flags a non-loop-item `template_id` binding (WP-R04
 * `Loop_Service::REST_CODE_LOOP_TEMPLATE_INVALID`; 10-rest-api.md §8.6; 12-error-taxonomy.md §3). The
 * live route returns the envelope code `ATOMIC_SETTINGS_INVALID` (→ mapped to `VALIDATION_FAILED` by
 * the §Detailed Requirements 5 remap) and carries this label in `data.meta.rest_code`.
 */
export const REST_CODE_LOOP_TEMPLATE_INVALID = 'E_LOOP_TEMPLATE_INVALID';

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
 * A non-loop-item `template_id` is a recoverable authoring mistake the agent can fix by creating a
 * proper loop-item first. The live PHP route (WP-R04) returns it as `ATOMIC_SETTINGS_INVALID` (422)
 * with `meta.rest_code == 'E_LOOP_TEMPLATE_INVALID'`; per §1.8 / §Detailed Requirements 5 the FROZEN
 * surface for this case is `VALIDATION_FAILED` with ACTIONABLE text steering to
 * `elementor.pro.loop.create_item`. This predicate detects the case off the {@link WpClientError}
 * payload meta regardless of the upstream envelope code (the load-bearing signal is `rest_code`).
 */
function isLoopTemplateInvalid(error: WpClientError): boolean {
  const meta = error.payload.meta as Record<string, unknown> | undefined;
  return meta?.['rest_code'] === REST_CODE_LOOP_TEMPLATE_INVALID;
}

/**
 * Re-emit a non-loop-item-`template_id` failure as the frozen `VALIDATION_FAILED` isError with
 * ACTIONABLE text (§Detailed Requirements 5; §Acceptance). Preserves the PHP `meta`
 * (`template_id`/`actual_type`/`expected_type`/`rest_code`) so a capable client keeps the
 * machine-readable detail, and appends the steer to `elementor.pro.loop.create_item`.
 */
function loopTemplateInvalidResult(error: WpClientError): ToolResult {
  const meta = (error.payload.meta as Record<string, unknown> | undefined) ?? {};
  const message =
    `template_id must be a loop-item template; a non-loop-item template renders nothing. ` +
    `Use \`${PRO_LOOP_CREATE_ITEM}\` to create a loop-item template, then pass the returned ` +
    `\`template_id\` to \`${PRO_LOOP_BIND_GRID}\`.`;
  const payload = makeErrorPayload(ErrorCodes.VALIDATION_FAILED, message, {
    meta: { ...meta },
  });
  return toToolErrorResult(payload);
}

/**
 * Run a thin Pro Loop handler: invoke `fn` and, on a {@link WpClientError}, FIRST apply the
 * loop-template-invalid remap (§Detailed Requirements 5), then route any other client error through
 * WP-F05's surface rules (`fromClientError` → protocol-throw or `isError` result, 12-error-taxonomy.md
 * §5 — a 501 `PRO_REQUIRED`, a 409 `CONCURRENCY_STALE_HASH`, a 404 `NOT_FOUND`). Non-client errors
 * rethrow (the server core surfaces them). The {@link ToolResult} is structurally a
 * {@link CallToolResult}.
 */
async function runProLoop(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      if (isLoopTemplateInvalid(error)) {
        return loopTemplateInvalidResult(error) as CallToolResult;
      }
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (the `skin`/`widget`/`order` enums, the `query` object, the defaults), so the shapes below describe
 * the POST-validation input. They are narrowing views over the loose `unknown` the runtime
 * {@link ToolHandler} declares — NOT re-validation.
 */

/** `elementor.pro.loop.create_item` validated input (Contract 13 §1.8). */
interface ProLoopCreateItemArgs {
  title: string;
  elements?: ElementNode[];
}

/** The ergonomic loop query object (Contract 13 §1.8; SUPPLEMENT.md §A.4 — keys are NOT prefixed here). */
interface ProLoopQueryArgs {
  post_type: string;
  orderby?: string;
  order?: 'asc' | 'desc';
  include_term_ids?: string[];
  exclude_ids?: string[];
  posts_ids?: string[];
  query_id?: string;
}

/** `elementor.pro.loop.bind_grid` validated input (Contract 13 §1.8). */
interface ProLoopBindGridArgs {
  container_id: string;
  post_id: number;
  /** SDK-applied default `'loop-grid'` (descriptor `.default('loop-grid')`). */
  widget: 'loop-grid' | 'loop-carousel';
  template_id: number;
  /** SDK-applied default `'post'` (descriptor `.default('post')`). */
  skin: 'post' | 'post_taxonomy' | 'product' | 'product_taxonomy';
  columns?: number;
  /** SDK-applied default `6` (descriptor `.default(6)`). */
  posts_per_page: number;
  query: ProLoopQueryArgs;
  pagination?: { type: string; load_type: string };
  base_hash: string;
}

/* ───────────────────────────── elementor.pro.loop.create_item (§1.8 / §8.6) ─────────────────── */

/**
 * `elementor.pro.loop.create_item` handler (M, 13-tool-catalog.md §1.8; 10-rest-api.md §8.6). Proxies
 * `POST /pro/loop/item`: PHP creates a post with `_elementor_template_type='loop-item'` (WP-R04
 * `Loop_Service`, `documents->create('loop-item',…)`) and, when `elements` are present, validates them
 * (dry-run) then persists. The optional `elements` pass through the shared `ElementNode` schema
 * unchanged (validated by the SDK before this runs).
 *
 * A deterministic `op_id` makes a retried create a safe no-op (§0.8); an idempotent replay is surfaced
 * INFORMATIONALLY in the text. Returns the frozen `{template_id,edit_url}` — the agent then feeds
 * `template_id` to {@link proLoopBindGridHandler}.
 */
export async function proLoopCreateItemHandler(
  args: ProLoopCreateItemArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProLoop(async () => {
    const body: CreateLoopItemRequest = {
      title: args.title,
      ...(args.elements !== undefined ? { elements: args.elements } : {}),
      op_id: mintOpId(['pro.loop.create_item', args.title, args.elements ?? null]),
    };
    const data: CreateLoopItemResponse = await ctx.wp.createLoopItem(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    const structured = {
      template_id: data.template_id,
      edit_url: data.edit_url,
    };
    return okResult(
      structured,
      `Created loop-item template "${args.title}" (template ${data.template_id})` +
        `${replayed ? ' (idempotent replay — already created)' : ''}. ` +
        `Pass template_id ${data.template_id} to \`${PRO_LOOP_BIND_GRID}\` to render a loop grid.`,
    );
  });
}

/* ───────────────────────────── elementor.pro.loop.bind_grid (§1.8 / §8.6) ───────────────────── */

/**
 * Build the ergonomic `query` body for `POST /pro/loop/bind-grid` (Contract 13 §1.8; SUPPLEMENT.md
 * §A.4). The keys are passed THROUGH UNPREFIXED — PHP (`Loop_Query_Mapper`, `base.php:32-35`) is the
 * single source of truth for the `{skin}_query_` prefixing and the `_skin` set. Only present optional
 * keys are emitted (a clean, minimal body). `posts_per_page`/`columns` are NOT part of the query group
 * (they are top-level on the request body — §Detailed Requirements 1).
 */
function buildQueryBody(query: ProLoopQueryArgs): Record<string, unknown> {
  return {
    post_type: query.post_type,
    ...(query.orderby !== undefined ? { orderby: query.orderby } : {}),
    ...(query.order !== undefined ? { order: query.order } : {}),
    ...(query.include_term_ids !== undefined ? { include_term_ids: query.include_term_ids } : {}),
    ...(query.exclude_ids !== undefined ? { exclude_ids: query.exclude_ids } : {}),
    ...(query.posts_ids !== undefined ? { posts_ids: query.posts_ids } : {}),
    ...(query.query_id !== undefined ? { query_id: query.query_id } : {}),
  };
}

/**
 * `elementor.pro.loop.bind_grid` handler (BOTH, 13-tool-catalog.md §1.8; 10-rest-api.md §8.6). Proxies
 * `POST /pro/loop/bind-grid`: PHP asserts the `template_id` is a loop-item doc, then writes the
 * `loop-grid`/`loop-carousel` widget settings — prefixing the ergonomic query keys with `{skin}_query_`,
 * setting `_skin`, and placing `posts_per_page`/`columns` at top level (WP-R04 `Loop_Query_Mapper`).
 *
 * This handler sends the ERGONOMIC shape (NO TS-side prefixing — §Implementation Notes): the `query`
 * keys unprefixed via {@link buildQueryBody}, `posts_per_page` top-level, and `template_id`/`columns`
 * as STRINGS (the §8.6 wire form — the PHP route accepts string|integer). `base_hash` is REQUIRED (a
 * surgical widget write, §0.8). A deterministic `op_id` makes a retried bind a safe no-op.
 *
 * The live REST `data` is `{element,applied,base_hash}` (§8.6). The tool `outputSchema` is
 * `{element,diff,base_hash}` (§1.8): the bind is a single-widget mutate, so the synthesized `diff`
 * records the bound widget as a `modified` node change (the `diffSchema`'s only required key is
 * `changes`). A non-loop-item `template_id` surfaces as `VALIDATION_FAILED` steering to
 * `create_item` (handled by {@link runProLoop} / {@link loopTemplateInvalidResult}).
 */
export async function proLoopBindGridHandler(
  args: ProLoopBindGridArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProLoop(async () => {
    const body: BindLoopGridRequest = {
      container_id: args.container_id,
      post_id: args.post_id,
      widget: args.widget,
      // §8.6 wire form: template_id/columns travel as strings (the PHP route accepts string|integer).
      template_id: String(args.template_id),
      skin: args.skin,
      ...(args.columns !== undefined ? { columns: String(args.columns) } : {}),
      posts_per_page: args.posts_per_page,
      // Ergonomic, UNPREFIXED query keys — PHP owns the `{skin}_query_` prefix (§Implementation Notes).
      query: buildQueryBody(args.query),
      ...(args.pagination !== undefined ? { pagination: args.pagination } : {}),
      base_hash: args.base_hash,
      op_id: mintOpId([
        'pro.loop.bind_grid',
        args.post_id,
        args.container_id,
        args.widget,
        args.template_id,
        args.skin,
        args.columns ?? null,
        args.posts_per_page,
        args.query,
        args.pagination ?? null,
        args.base_hash,
      ]),
    };
    const data: BindLoopGridResponse = await ctx.wp.bindLoopGrid(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    // The §1.8 outputSchema requires `diff`; the §8.6 REST response is `{element,applied,base_hash}`.
    // A bind is a single-widget mutate, so synthesize the minimal diffSchema-valid `diff` recording the
    // bound widget node as modified (`element.id` when present). This keeps the tool's output contract
    // (§1.8) without inventing tree-wide change data PHP did not return.
    const widgetId = elementId(data.element);
    const diff = {
      changes: [
        {
          id: widgetId,
          op: 'modified' as const,
          elType: 'widget',
          widgetType: args.widget,
        },
      ],
      changed_ids: [widgetId],
      base_hash_after: data.base_hash,
    };

    const structured = {
      element: data.element,
      diff,
      base_hash: data.base_hash,
    };
    return okResult(
      structured,
      `Bound ${args.widget} (skin "${args.skin}") to loop-item template ${args.template_id} ` +
        `with page size ${args.posts_per_page}` +
        `${replayed ? ' (idempotent replay — already bound)' : ''}.`,
    );
  });
}

/** Read an {@link ElementNode}'s id (the bound widget); empty string when absent (defensive). */
function elementId(element: ElementNode | undefined): string {
  const id = (element as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : '';
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach every Pro Loop Builder handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name
 * (§Detailed Requirements 1; §Acceptance). These tools are NON-★ (registered disabled at boot, enabled
 * via `tools.search` matching `elementor.pro.loop*` — driven by the descriptor `star:false` flag, no
 * per-tool work here). The registry stores handlers under its loose `(args) => unknown` type; the
 * runtime invokes them as `(args, ctx)` (server core casts to the WP-T01 {@link ToolHandler}
 * signature), so each handler is registered through that signature here.
 */
export function attachLoopHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [PRO_LOOP_CREATE_ITEM]: (args, ctx) =>
      proLoopCreateItemHandler(args as ProLoopCreateItemArgs, ctx),
    [PRO_LOOP_BIND_GRID]: (args, ctx) => proLoopBindGridHandler(args as ProLoopBindGridArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
