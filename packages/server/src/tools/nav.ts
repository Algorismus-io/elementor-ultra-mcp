/**
 * WP-T09 — navigation / menu tool HANDLERS (Contract 13 §1.6).
 *
 * Implements the navigation tool group and attaches each handler to the WP-F04 {@link ToolRegistry} by
 * EXACT catalog name (13-tool-catalog.md §1.6). This WP does NOT define schemas (WP-F04 owns the
 * descriptors `catalog/schemas/nav.ts`) — each handler is a {@link ToolHandler} (WP-T01
 * `runtime/context.ts`) attached via `registry.attachHandler(name, fn)`; the SDK has already validated
 * `args` against the descriptor's `inputSchema` before the handler runs (Contract 13 §0.1) and validates
 * the returned `structuredContent` against `outputSchema` after.
 *
 * Handlers are THIN proxies over the WP-F02 bound facade (`ctx.wp.*`): validate-by-SDK →
 * `ctx.wp.<route>(…)` → map the RAW REST `data` into the descriptor's `outputSchema` shape → return
 * `{ content, structuredContent }`. The SECURITY + validity boundary lives in PHP (WP-P11): a missing
 * post/element/term → `NOT_FOUND`; a Pro-inactive bind route → 501 `PRO_REQUIRED`. Those arrive here as
 * a {@link WpClientError} and route through WP-F05's `fromClientError` → protocol-throw vs `isError`
 * result (12-error-taxonomy.md §5); tool-arg failures are `-32602` from the SDK's zod layer before the
 * handler runs.
 *
 * Tools handled here (Contract 13 §1.6):
 *  - `elementor.nav.menus.list`   (R, `GET /nav/menus`)  — paginate WP nav menus.
 *  - `elementor.nav.menus.create` (M, `POST /nav/menus`) — create + populate a menu with hierarchy.
 *  - `elementor.nav.bind_widget`  (M, `POST /nav/bind-widget`) — bind a Pro nav/mega-menu widget to a
 *    menu TERM via `settings.menu` (an element-tree write → carries `base_hash`, returns the diff).
 *
 * `menus.*` are WP-core menu primitives (no dry_run / Pro dependency, work without Pro). `bind_widget`
 * mutates a single element's `settings.menu` (NOT styles) → it goes through the PHP transactional save
 * (validate → write), is NOT atomic-CSS-affecting (no prime-css / S01 gate), and is Pro-gated (the Pro
 * nav-menu/mega-menu widget is the bind target). See §Detailed Requirements 4-5.
 *
 * Contract authority: 13-tool-catalog.md §1.6 (per-tool I/O), §0.6 (pagination), §0.7 (edit diff), §0.8
 * (base_hash + op_id replay); 10-rest-api.md §6 (`wp_create_nav_menu` + `wp_update_nav_menu_item`; bind
 * sets `settings.menu` → derived `menu_id`, `elementor-pro …/nav-menu.php:69,1464-1485`); 12-error-
 * taxonomy.md §3.4 (`PRO_REQUIRED`), §3.5 (`NOT_FOUND`), §5 (surface rules).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  makeErrorPayload,
  type CreateNavMenuRequest,
  type CreateNavMenuResponse,
  type BindNavWidgetRequest,
  type BindNavWidgetResponse,
  type ListNavMenusResponse,
  type NavMenuItem,
  type NavMenuItemInput,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import type { ToolRegistry } from '../catalog/registry.js';
import type { Diff } from '../authoring/contract.js';
import { WpClientError } from '../wp/types.js';
import { fromClientError, toToolErrorResult, type ToolResult } from '../wp/errors.js';
import { presentDiff, summarizeDiff } from '../safety/diff.js';
import { mintOpId, isReplay } from '../safety/idempotency.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.6) ────────────────────────── */

/** The navigation tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.6). */
export const NAV_MENUS_LIST = 'elementor.nav.menus.list';
export const NAV_MENUS_CREATE = 'elementor.nav.menus.create';
export const NAV_BIND_WIDGET = 'elementor.nav.bind_widget';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const NAV_TOOL_NAMES = [NAV_MENUS_LIST, NAV_MENUS_CREATE, NAV_BIND_WIDGET] as const;

/* ───────────────────────────── nav-item defaults (Contract 10 §6 / WP-core menu semantics) ──── */

/** Default WP menu-item `type` when the tool input omits it (a custom URL/link item). */
const DEFAULT_ITEM_TYPE = 'custom';

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
 * Run a thin nav handler: invoke `fn` and, on a {@link WpClientError} (e.g. `NOT_FOUND` from a missing
 * post/element/term, or a Pro-inactive `PRO_REQUIRED` 501 the probe missed), route it through WP-F05's
 * surface rules (`fromClientError` → protocol-throw or `isError` result, 12-error-taxonomy.md §5).
 * Non-client errors rethrow (the server core surfaces them). The {@link ToolResult} is structurally a
 * {@link CallToolResult}.
 */
async function runNav(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── local pagination (Contract 13 §0.6) ──────────────────────────── */

/** A locally-paginated slice over a fully-materialized list (cursor = numeric offset string). */
interface LocalPage<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
}

/**
 * Paginate a fully-materialized list locally (Contract 13 §0.6). `GET /nav/menus` returns ALL menus
 * (`wp_get_nav_menus` has no native cursor), so the cursor is a numeric offset into the list. An
 * out-of-range / non-numeric cursor restarts at 0 rather than throwing — a stale cursor degrades
 * gracefully to a fresh first page (read-only, never a write). `limit` is the SDK-supplied bound.
 */
function paginateLocal<T>(all: T[], limit: number, cursor: string | undefined): LocalPage<T> {
  const parsed = cursor !== undefined ? Number.parseInt(cursor, 10) : 0;
  const start = Number.isFinite(parsed) && parsed >= 0 && parsed <= all.length ? parsed : 0;
  const end = start + limit;
  const items = all.slice(start, end);
  const next_cursor = end < all.length ? String(end) : null;
  return { items, next_cursor, total: all.length };
}

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (§Detailed Requirements 6), so the shapes below describe the POST-validation input. They are narrowing
 * views over the loose `unknown` the runtime {@link ToolHandler} declares — NOT re-validation.
 */

interface NavMenusListArgs {
  limit: number;
  cursor?: string;
  fields?: string[];
}

/** One nav-menu item as the tool input carries it (Contract 13 §1.6 — most fields optional). */
interface NavMenuCreateItemArg {
  title: string;
  url?: string;
  object_id?: number;
  type?: string;
  /** Index of a SIBLING item (earlier in the array) this item nests under; PHP resolves `parent`. */
  parent_index?: number;
}

interface NavMenusCreateArgs {
  name: string;
  items: NavMenuCreateItemArg[];
}

interface NavBindWidgetArgs {
  post_id: number;
  element_id: string;
  term_id: number;
  base_hash: string;
}

/* ───────────────────────────── elementor.nav.menus.list (§1.6 / §0.6) ───────────────────────── */

/**
 * `elementor.nav.menus.list` handler (R, 13-tool-catalog.md §1.6; 10-rest-api.md §6). Proxies
 * `GET /nav/menus` (PHP wraps `wp_get_nav_menus`), then paginates locally (§0.6 — the route returns the
 * full list with no native cursor). The RAW {@link NavMenuItem} (`{term_id,name,slug,count}`) is ALREADY
 * the catalog item shape, so the slice is returned verbatim. NEVER unbounded — the SDK supplies the
 * default `limit` (§0.6). `fields` is accepted (descriptor §0.6) but the item set is already minimal, so
 * no projection is applied here.
 */
export async function navMenusListHandler(
  args: NavMenusListArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runNav(async () => {
    const data: ListNavMenusResponse = await ctx.wp.listNavMenus();
    const all = data.items.map((item: NavMenuItem) => ({
      term_id: item.term_id,
      name: item.name,
      slug: item.slug,
      count: item.count,
    }));
    const page = paginateLocal(all, args.limit, args.cursor);
    const structured = {
      items: page.items,
      next_cursor: page.next_cursor,
      total: page.total,
    };
    return okResult(
      structured,
      `Listed ${page.items.length} nav menu(s)${page.next_cursor !== null ? ' (more available)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.nav.menus.create (§1.6 / §6) ───────────────────────── */

/**
 * Map a tool-input nav item (Contract 13 §1.6, most fields optional) to the REST {@link NavMenuItemInput}
 * the route requires (Contract 10 §6 — all fields present). Defaults follow WP-core menu semantics: a
 * custom URL/link item (`type='custom'`) with no associated object. `parent_index` is forwarded as the
 * REST body's `parent` (a SIBLING index); PHP resolves it to the real parent menu-item id after each item
 * is created — see §Detailed Requirements 3. `object_id`/`type` carry page/category/post associations
 * when the item links to existing content.
 */
function toRestMenuItem(item: NavMenuCreateItemArg): NavMenuItemInput {
  return {
    title: item.title,
    url: item.url ?? '',
    parent: item.parent_index ?? 0,
    object_id: item.object_id ?? 0,
    type: item.type ?? DEFAULT_ITEM_TYPE,
  };
}

/**
 * `elementor.nav.menus.create` handler (M, 13-tool-catalog.md §1.6; 10-rest-api.md §6). Proxies
 * `POST /nav/menus`: PHP wraps `wp_create_nav_menu` + `wp_update_nav_menu_item` per item. Each input item
 * is normalized to the REST shape ({@link toRestMenuItem}) with `type` defaulting to `custom`;
 * `parent_index` (a SIBLING index for hierarchy) rides the REST `parent` field and PHP resolves it to the
 * created parent's menu-item id (§Detailed Requirements 3). A deterministic `op_id` makes a retried
 * create a safe no-op (§0.8); an idempotent replay is surfaced INFORMATIONALLY in the text. Returns the
 * frozen `{term_id,item_ids}`.
 */
export async function navMenusCreateHandler(
  args: NavMenusCreateArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runNav(async () => {
    const items = args.items.map(toRestMenuItem);
    const body: CreateNavMenuRequest = {
      name: args.name,
      items,
      op_id: mintOpId(['nav.menus.create', args.name, items]),
    };
    const data: CreateNavMenuResponse = await ctx.wp.createNavMenu(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });
    const structured = {
      term_id: data.term_id,
      item_ids: data.item_ids,
    };
    return okResult(
      structured,
      `Created nav menu "${args.name}" (term ${data.term_id}) with ${data.item_ids.length} item(s)${replayed ? ' (idempotent replay — already created)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.nav.bind_widget (§1.6 / §6) ────────────────────────── */

/**
 * Build the `PRO_REQUIRED` `isError` result for a bind attempted on a Pro-inactive site (12-error-
 * taxonomy.md §3.4). Emitted by the CHEAP capability pre-check ({@link ctx.capabilities}) so the agent
 * gets immediate, actionable feedback without a doomed REST round-trip; the live PHP route is the final
 * authority and re-asserts the same gate (501 → the SAME code via the client error path) when the probe
 * was stale.
 */
function proRequiredResult(): ToolResult {
  const payload = makeErrorPayload(
    ErrorCodes.PRO_REQUIRED,
    'nav.bind_widget targets an Elementor Pro nav-menu / mega-menu widget, but Elementor Pro is not active on this site.',
    { meta: { feature: 'nav-menu-widget' } },
  );
  return toToolErrorResult(payload);
}

/**
 * Synthesize the minimal authoritative-shape {@link Diff} for a nav-bind write. The `POST /nav/bind-widget`
 * route returns only `{success,base_hash}` (Contract 10 §6) — it does NOT echo a node diff — but the
 * catalog `outputSchema` (§0.7) requires `diff: Diff`. The bind mutates exactly ONE node's `settings.menu`
 * (a `modified` change on `element_id`), so this records that single change WITHOUT fabricating any other
 * edit, then runs it through {@link presentDiff} so the shape is schema-validated like every other diff.
 * `base_hash_after` is filled in only when it matches the strict 32-hex pattern (else omitted so
 * `presentDiff` never rejects an otherwise-valid bind).
 */
function bindDiff(elementId: string, baseHashAfter: string): Diff {
  const BASE_HASH_PATTERN = /^[a-f0-9]{32}$/;
  const diff: Diff = {
    changes: [{ id: elementId, op: 'modified', changed_paths: ['settings.menu'] }],
    new_ids: [],
    changed_ids: [elementId],
    removed_ids: [],
    ...(BASE_HASH_PATTERN.test(baseHashAfter) ? { base_hash_after: baseHashAfter } : {}),
  };
  return presentDiff(diff);
}

/**
 * `elementor.nav.bind_widget` handler (M, 13-tool-catalog.md §1.6; 10-rest-api.md §6). Binds a Pro
 * nav-menu / mega-menu widget to a `nav_menu` TERM by setting `settings.menu` → derived `menu_id`
 * (`elementor-pro …/nav-menu.php:69,1464-1485`). This is an element-tree WRITE: it REQUIRES `base_hash`
 * (§0.8) — a stale hash surfaces as `CONCURRENCY_STALE_HASH` via the client path — and goes through the
 * PHP transactional save (validate → write).
 *
 * Pro gating (§Detailed Requirements 5): the bind target is a Pro widget, so a cheap
 * `ctx.capabilities.get().pro` pre-check short-circuits to `PRO_REQUIRED` when Pro is inactive (no doomed
 * round-trip); the PHP route re-asserts the gate (501 → the same code) if the probe was stale.
 *
 * Returns `presentDiff(diff)` (a synthesized single-node `modified` diff — the route returns no node diff)
 * + the new `base_hash`. A deterministic `op_id` makes a retried bind a safe no-op (`idempotentHint`); an
 * `IDEMPOTENT_REPLAY` is surfaced INFORMATIONALLY in the text (the write already landed). A missing
 * post/element/term surfaces as `NOT_FOUND` via the client path.
 */
export async function navBindWidgetHandler(
  args: NavBindWidgetArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runNav(async () => {
    // Cheap Pro pre-check (§Detailed Requirements 5): the bind target is a Pro widget.
    const caps = await ctx.capabilities.get();
    if (!caps.pro) {
      return proRequiredResult();
    }

    const body: BindNavWidgetRequest = {
      post_id: args.post_id,
      element_id: args.element_id,
      term_id: args.term_id,
      base_hash: args.base_hash,
      op_id: mintOpId([
        'nav.bind_widget',
        args.post_id,
        args.element_id,
        args.term_id,
        args.base_hash,
      ]),
    };
    const data: BindNavWidgetResponse = await ctx.wp.bindNavWidget(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    const diff = bindDiff(args.element_id, data.base_hash);
    const summary = summarizeDiff(diff);
    const structured = {
      diff,
      base_hash: data.base_hash,
    };
    return okResult(
      structured,
      `Bound nav widget ${args.element_id} on document ${args.post_id} to menu term ${args.term_id} (${summary.changed} change)${replayed ? ' (idempotent replay — already bound)' : ''}.`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach every navigation handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Detailed
 * Requirements 1; §Acceptance). The registry stores handlers under its loose `(args) => unknown` type;
 * the runtime invokes them as `(args, ctx)` (server core casts to the WP-T01 {@link ToolHandler}
 * signature), so each handler is registered through that signature here.
 */
export function attachNavHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [NAV_MENUS_LIST]: (args, ctx) => navMenusListHandler(args as NavMenusListArgs, ctx),
    [NAV_MENUS_CREATE]: (args, ctx) => navMenusCreateHandler(args as NavMenusCreateArgs, ctx),
    [NAV_BIND_WIDGET]: (args, ctx) => navBindWidgetHandler(args as NavBindWidgetArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
