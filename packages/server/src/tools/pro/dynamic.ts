/**
 * WP-R11 — Pro DYNAMIC tool HANDLERS (Contract 13 §1.8; 10-rest-api.md §8.7; SUPPLEMENT.md §A.6/§A.7).
 *
 * Implements the two Pro dynamic-tag tools and attaches each handler to the WP-F04 {@link ToolRegistry}
 * by EXACT catalog name (13-tool-catalog.md §1.8). This WP does NOT define schemas (WP-F04 owns
 * `catalog/schemas/pro.ts`) — each handler is a {@link ToolHandler} (WP-T01 `runtime/context.ts`)
 * attached via `registry.attachHandler(name, fn)`; the SDK has already validated `args` against the
 * descriptor's `inputSchema` before the handler runs and validates the returned `structuredContent`
 * against `outputSchema` after.
 *
 *  - `elementor.pro.dynamic.bind`      (M, BOTH, `POST /pro/dynamic/bind`)   — byte-identical mirror of
 *    core `Manager::tag_to_text`. idempotentHint:true. The AUTHORITATIVE encode+write is PHP (WP-R05),
 *    which re-encodes server-side and validates `control.dynamic.active`/category intersection; the
 *    RETURNED `dynamic_string` is the PHP-authoritative one. The shared TS {@link encodeDynamicTag}
 *    (`authoring/dynamic-encoder.ts`) is the client-side preview/parity mirror (byte-equal to PHP).
 *  - `elementor.pro.dynamic.list_tags` (R, proxied-to-REST, `GET /pro/dynamic/tags`) — per-tag
 *    `{name,title,group,categories,settings_controls,available}`. readOnlyHint+idempotentHint.
 *    Paginates §0.6 over the materialized list (the REST route returns all tags in one shot).
 *
 * Both NON-★ (registered disabled at boot, enabled via `tools.search` match on `elementor.pro.dynamic*`).
 *
 * Error mapping (Contract 13 §0.9, Contract 12 §3/§5): a control-not-dynamic / category-mismatch 422
 * (`E_DYNAMIC_INCOMPATIBLE` → `VALIDATION_FAILED`), a Pro/ACF-unavailable 501 (`PRO_REQUIRED` /
 * `EXPERIMENT_INACTIVE`), a 404 (`NOT_FOUND`), or a stale-`base_hash` 409 (`CONCURRENCY_STALE_HASH`)
 * arrive as a {@link WpClientError} carrying the taxonomy payload and route through WP-F05's
 * `fromClientError` → protocol-throw vs `isError` result. Tool-arg failures (a missing `base_hash`, a
 * non-string `tag`) are `-32602` from the SDK's zod layer before the handler runs.
 *
 * Contract authority: 13-tool-catalog.md §1.8 (per-tool I/O), §0.6 (pagination), §0.8 (base_hash/op_id),
 * §0.9 (error semantics); 10-rest-api.md §8.7 (REST shapes); 12-error-taxonomy.md §3 (codes), §5 (surface).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { BindDynamicRequest, BindDynamicResponse } from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../../runtime/context.js';
import type { ToolRegistry } from '../../catalog/registry.js';
import { WpClientError } from '../../wp/types.js';
import { fromClientError, type ToolResult } from '../../wp/errors.js';
import { presentDiff } from '../../safety/diff.js';
import type { Diff } from '../../authoring/contract.js';
import { mintOpId, isReplay } from '../../safety/idempotency.js';
import { encodeDynamicTag } from '../../authoring/dynamic-encoder.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.8) ─────────────────────────── */

/** The Pro dynamic tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.8). */
export const PRO_DYNAMIC_BIND = 'elementor.pro.dynamic.bind';
export const PRO_DYNAMIC_LIST_TAGS = 'elementor.pro.dynamic.list_tags';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const PRO_DYNAMIC_TOOL_NAMES = [PRO_DYNAMIC_BIND, PRO_DYNAMIC_LIST_TAGS] as const;

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
 * Run a thin Pro dynamic handler: invoke `fn` and, on a {@link WpClientError} (a 422
 * `E_DYNAMIC_INCOMPATIBLE`→`VALIDATION_FAILED`, a 501 `PRO_REQUIRED`/`EXPERIMENT_INACTIVE`, a 404, a 409
 * `CONCURRENCY_STALE_HASH`), route it through WP-F05's surface rules (`fromClientError` → protocol-throw
 * or `isError` result, 12-error-taxonomy.md §5). Non-client errors rethrow (the server core surfaces
 * them). The {@link ToolResult} is structurally a {@link CallToolResult}.
 */
async function runProDynamic(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK parses `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs, so the
 * shapes below describe the POST-validation input — narrowing views over the loose `unknown` the runtime
 * {@link ToolHandler} declares, NOT re-validation.
 */

/** `elementor.pro.dynamic.bind` validated input (Contract 13 §1.8). */
interface ProDynamicBindArgs {
  post_id: number;
  element_id: string;
  control: string;
  tag: string;
  tag_settings?: Record<string, unknown>;
  fallback_value?: unknown;
  base_hash: string;
}

/** `elementor.pro.dynamic.list_tags` validated input — §0.6 pagination (Contract 13 §1.8). */
interface ProDynamicListTagsArgs {
  /** SDK-applied default `50` (descriptor `.default(50)`). */
  limit: number;
  cursor?: string;
  fields?: string[];
}

/* ───────────────────────────── elementor.pro.dynamic.bind (§1.8 / §8.7) ─────────────────────── */

/**
 * Synthesize the frozen {@link Diff} for a dynamic bind. The REST `BindDynamicResponse` ships only
 * `{dynamic_string,applied,base_hash}` (10-rest-api.md §8.7) — no diff rollup — but the tool
 * `outputSchema` requires a `Diff` whose only mandatory key is `changes[]` (11-authoring-contract.md §1).
 * The write modifies exactly ONE element (its `__dynamic__[control]` / atomic dynamic prop), so we
 * express that as a single `modified` {@link NodeChange} naming the bound `element_id` and the touched
 * `control` path. This faithfully re-expresses the one change PHP made; it never fabricates a change PHP
 * did not make. `presentDiff` validates it against `diff.schema.json` before it reaches the agent.
 */
function bindDiff(elementId: string, control: string, applied: boolean): Diff {
  const changes = applied
    ? [{ id: elementId, op: 'modified' as const, changed_paths: [`__dynamic__.${control}`] }]
    : [];
  return presentDiff({
    changes,
    changed_ids: applied ? [elementId] : [],
  });
}

/**
 * `elementor.pro.dynamic.bind` handler (M, BOTH, idempotentHint; 13-tool-catalog.md §1.8; 10-rest-api.md
 * §8.7). A THIN proxy over `POST /pro/dynamic/bind`: PHP is AUTHORITATIVE — it re-encodes the tag with
 * core `Manager::tag_to_text` byte-for-byte (matched by the shared {@link encodeDynamicTag}), writes
 * `settings.__dynamic__[control]` (V3) / the atomic dynamic envelope (V4), and VALIDATES
 * `control.dynamic.active==true` + tag registered + tag category ∩ control categories. The RETURNED
 * `dynamic_string` is the PHP-authoritative one (NOT the local preview).
 *
 * `base_hash` is REQUIRED (surgical write, §0.8); a deterministic `op_id` (derived from the binding
 * inputs) makes a retried bind a safe no-op and surfaces a replay informationally. A locally-computed
 * preview shortcode is logged (debug) so a divergence between the TS mirror and the PHP encoder is
 * observable, but it never overrides the authoritative response. Returns `{dynamic_string, diff, applied,
 * base_hash}`.
 */
export async function proDynamicBindHandler(
  args: ProDynamicBindArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProDynamic(async () => {
    const tagSettings = args.tag_settings ?? {};

    // Client-side PREVIEW (parity mirror of PHP `tag_to_text`) — logged only; the authoritative
    // `dynamic_string` comes from the PHP response below (§Detailed Requirements 3).
    const preview = encodeDynamicTag(args.tag, tagSettings);
    ctx.logger.debug('pro.dynamic.bind preview shortcode', {
      element_id: args.element_id,
      control: args.control,
      tag: args.tag,
      preview,
    });

    const body: BindDynamicRequest = {
      post_id: args.post_id,
      element_id: args.element_id,
      control: args.control,
      tag: args.tag,
      tag_settings: tagSettings,
      ...(typeof args.fallback_value === 'string' ? { fallback_value: args.fallback_value } : {}),
      base_hash: args.base_hash,
      op_id: mintOpId([
        'pro.dynamic.bind',
        args.post_id,
        args.element_id,
        args.control,
        args.tag,
        tagSettings,
      ]),
    };
    const data: BindDynamicResponse = await ctx.wp.bindDynamic(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    const structured = {
      dynamic_string: data.dynamic_string,
      diff: bindDiff(args.element_id, args.control, data.applied),
      applied: data.applied,
      base_hash: data.base_hash,
    };
    return okResult(
      structured,
      `Bound dynamic tag "${args.tag}" to control "${args.control}" on element ${args.element_id}` +
        `${data.applied ? '' : ' (not applied)'}` +
        `${replayed ? ' (idempotent replay — already bound)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.pro.dynamic.list_tags (§1.8 / §8.7) ────────────────── */

/**
 * One Pro dynamic-tag list-item enriched beyond the shared `DynamicTagItem` (`{name,title,group,
 * categories}`): the live `GET /pro/dynamic/tags` route ALSO returns `settings_controls` (the tag's
 * per-control keys) and `available` (license-gating). We widen the read at this boundary (without
 * redefining the shared type) so the §1.8 item shape is fully populated.
 */
interface ProDynamicTagItem {
  name: string;
  title: string;
  group: string;
  categories: string[];
  settings_controls?: string[];
  available?: boolean;
}

/**
 * Apply an opaque numeric-offset cursor to a fully-materialized list (the dynamic-tags route returns ALL
 * tags in one shot — no server pagination). The cursor is the stringified next offset; a `null`
 * next_cursor ⇒ last page (Contract 13 §0.6 / 10-rest-api.md §0.11).
 */
function paginateLocal<T>(
  all: T[],
  limit: number,
  cursor: string | undefined,
): { items: T[]; next_cursor: string | null; total: number } {
  const start = cursor !== undefined && /^\d+$/.test(cursor) ? Number.parseInt(cursor, 10) : 0;
  const safeStart = start >= 0 && start <= all.length ? start : 0;
  const end = limit >= 0 ? safeStart + limit : all.length;
  const items = all.slice(safeStart, end);
  const next_cursor = end < all.length ? String(end) : null;
  return { items, next_cursor, total: all.length };
}

/**
 * `elementor.pro.dynamic.list_tags` handler (R, readOnly+idempotent; 13-tool-catalog.md §1.8;
 * 10-rest-api.md §8.7). Proxies `GET /pro/dynamic/tags` and maps each raw item to the §1.8 shape
 * `{name,title,group,categories,settings_controls,available}` (`settings_controls`/`available` default
 * to `[]`/`false` when a row omits them), then paginates via `{limit,cursor}` (§0.6). The agent calls
 * this BEFORE `bind` to learn valid tags + categories + availability. A Pro-inactive 501 surfaces
 * informationally as `PRO_REQUIRED`/`EXPERIMENT_INACTIVE` via the client error path.
 */
export async function proDynamicListTagsHandler(
  args: ProDynamicListTagsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProDynamic(async () => {
    const data = await ctx.wp.listDynamicTags();
    const raw = data.items as unknown as ProDynamicTagItem[];
    const mapped = raw.map((tag) => ({
      name: tag.name,
      title: tag.title,
      group: tag.group,
      categories: tag.categories,
      settings_controls: Array.isArray(tag.settings_controls) ? tag.settings_controls : [],
      available: typeof tag.available === 'boolean' ? tag.available : false,
    }));
    const page = paginateLocal(mapped, args.limit, args.cursor);
    const structured = {
      items: page.items,
      next_cursor: page.next_cursor,
      total: page.total,
    };
    return okResult(
      structured,
      `Listed ${page.items.length} Pro dynamic tag(s)` +
        `${page.next_cursor !== null ? ' (more available)' : ''}.`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach every Pro dynamic handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Detailed
 * Requirements; §Acceptance). Both tools are NON-★ (registered disabled at boot, enabled via
 * `tools.search` — driven by the descriptor `star:false` flag, no per-tool work here). The registry
 * stores handlers under its loose `(args) => unknown` type; the runtime invokes them as `(args, ctx)`
 * (server core casts to the WP-T01 {@link ToolHandler} signature), so each handler is registered through
 * that signature here.
 */
export function attachDynamicHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [PRO_DYNAMIC_BIND]: (args, ctx) => proDynamicBindHandler(args as ProDynamicBindArgs, ctx),
    [PRO_DYNAMIC_LIST_TAGS]: (args, ctx) =>
      proDynamicListTagsHandler(args as ProDynamicListTagsArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
