/**
 * WP-T04 — Discovery / read tool HANDLERS (Contract 13 §1.1).
 *
 * Implements the read-only discovery tools and attaches them to the WP-F04 {@link ToolRegistry} by
 * EXACT catalog name. This WP does NOT define schemas (WP-F04 owns the descriptors) — each handler is
 * a {@link ToolHandler} (WP-T01 `runtime/context.ts`) attached via `registry.attachHandler(name, fn)`;
 * the SDK has already validated `args` against the descriptor's `inputSchema` before the handler runs
 * (Contract 13 §0.1; §Detailed Requirements 1).
 *
 * Handlers are THIN (§Implementation Notes): validate-by-SDK → `ctx.wp.<route>(…)` (WP-F02 bound
 * facade) → map the RAW REST `data` into the descriptor's `outputSchema` shape → return
 * `{ content, structuredContent }`. A thrown {@link WpClientError} routes through WP-F05's
 * `fromClientError` so the surface rules (12-error-taxonomy.md §5) decide protocol-throw vs
 * isError-result; arg failures are `-32602` from the SDK's zod layer before the handler runs.
 *
 * Tools handled here (Contract 13 §1.1):
 *  - `elementor.tools.search` ★ (R, TS) — the ONLY handler with side effects: on a match it enables
 *    the matched disabled tools via `ctx.surface.enable([...])` (one `sendToolListChanged()`, §5.3).
 *  - `elementor.pages.list` ★ (R, `GET /documents`).
 *  - `elementor.page.get_structure` ★ (R, `GET /documents/{id}`) — depth / subtree / projection.
 *  - `elementor.page.get_settings` (R, `GET /documents/{id}/settings`).
 *  - `elementor.schema.widget` ★ (R, `GET /schema/widget/{type}`).
 *  - `elementor.schema.styles` ★ (R, `GET /schema/styles`).
 *  - `elementor.breakpoints.get` ★ (R, `GET /schema/breakpoints`).
 *  - `elementor.dynamic.list_tags` (R, `GET /pro/dynamic/tags`).
 *  - `elementor.dynamic.get_tag_schema` (R, `GET /pro/dynamic/tags/{name}`).
 *
 * `elementor.site.capabilities` is OWNED by WP-F05 (`tools/discovery-capabilities.ts`) and is NOT
 * implemented here (§Summary).
 *
 * Contract authority: 13-tool-catalog.md §1.1 (per-tool I/O), §0.6 (pagination), §5.2 (★ membership),
 * §5.3 (search→enable→listChanged); 10-rest-api.md §2.1/§2.4/§2.5/§3/§8/§12; 12-error-taxonomy.md §5.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type {
  Breakpoint,
  DocumentListItem,
  DynamicTagItem,
  ElementNode,
  GetDocumentRequest,
  Generation,
  ListDocumentsRequest,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import type { ToolRegistry } from '../catalog/registry.js';
import type { ToolDescriptor } from '../catalog/tools.js';
import { WpClientError } from '../wp/types.js';
import { fromClientError, type ToolResult } from '../wp/errors.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.1) ───────────────────────── */

/** The discovery/read tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.1). */
export const TOOLS_SEARCH = 'elementor.tools.search';
export const PAGES_LIST = 'elementor.pages.list';
export const PAGE_GET_STRUCTURE = 'elementor.page.get_structure';
export const PAGE_GET_SETTINGS = 'elementor.page.get_settings';
export const SCHEMA_WIDGET = 'elementor.schema.widget';
export const SCHEMA_STYLES = 'elementor.schema.styles';
export const BREAKPOINTS_GET = 'elementor.breakpoints.get';
export const DYNAMIC_LIST_TAGS = 'elementor.dynamic.list_tags';
export const DYNAMIC_GET_TAG_SCHEMA = 'elementor.dynamic.get_tag_schema';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const DISCOVERY_TOOL_NAMES = [
  TOOLS_SEARCH,
  PAGES_LIST,
  PAGE_GET_STRUCTURE,
  PAGE_GET_SETTINGS,
  SCHEMA_WIDGET,
  SCHEMA_STYLES,
  BREAKPOINTS_GET,
  DYNAMIC_LIST_TAGS,
  DYNAMIC_GET_TAG_SCHEMA,
] as const;

/* ───────────────────────────── result helpers ─────────────────────────────────────────────── */

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
 * Run a thin read handler: invoke `fn` and, on a {@link WpClientError}, route it through WP-F05's
 * surface rules (`fromClientError` → protocol-throw or `isError` result). Non-client errors rethrow
 * (the server core surfaces them). The {@link ToolResult} is structurally a {@link CallToolResult}.
 */
async function runRead(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── typed validated args (post-SDK) ────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler
 * runs (§Detailed Requirements 1), so the shapes below describe the POST-validation input. They are
 * narrowing views over the loose `unknown` the runtime `ToolHandler` declares — NOT re-validation.
 */

interface ToolsSearchArgs {
  query?: string;
  prefix?: string;
  limit: number;
}

interface PagesListArgs {
  status: 'any' | 'publish' | 'draft' | 'pending' | 'private' | 'trash';
  post_type?: string;
  limit: number;
  cursor?: string;
  fields?: string[];
}

interface PageGetStructureArgs {
  post_id: number;
  depth?: number;
  subtree_id?: string;
  projection: 'full' | 'summary';
}

interface PageGetSettingsArgs {
  post_id: number;
}

interface SchemaWidgetArgs {
  type: string;
}

interface DynamicListTagsArgs {
  categories?: string[];
  limit: number;
  cursor?: string;
  fields?: string[];
}

interface DynamicGetTagSchemaArgs {
  tag_name: string;
}

/* ───────────────────────────── elementor.tools.search (§1.1 / §5.3) ───────────────────────── */

/** One matched-tool entry in the `tools.search` output (13-tool-catalog.md §1.1 outputSchema). */
interface ToolSearchEntry {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  inputSchema: unknown;
  annotations: unknown;
}

/**
 * Match a descriptor against the search inputs (13-tool-catalog.md §1.1): `prefix` filters by name
 * prefix (e.g. `elementor.pro.`); `query` is a case-insensitive substring match against name + title +
 * description. With neither, every tool matches (bounded local registry, `limit`-capped).
 */
function matchesSearch(
  descriptor: ToolDescriptor,
  query: string | undefined,
  prefix: string | undefined,
): boolean {
  if (prefix !== undefined && prefix.length > 0 && !descriptor.name.startsWith(prefix)) {
    return false;
  }
  if (query !== undefined && query.length > 0) {
    const haystack =
      `${descriptor.name}\n${descriptor.title}\n${descriptor.description}`.toLowerCase();
    if (!haystack.includes(query.toLowerCase())) {
      return false;
    }
  }
  return true;
}

/**
 * `elementor.tools.search` handler (13-tool-catalog.md §1.1; §5.3). Finds matching tools in the
 * WP-F04 registry, ENABLES any matched-but-currently-disabled tools through the WP-T01
 * {@link SurfaceController} (which dedupes + emits EXACTLY ONE `sendToolListChanged()` for the batch),
 * and returns the matched descriptors. Pagination is via `limit` ONLY — no cursor (bounded registry).
 *
 * The `enabled` flag in each returned entry reflects state AFTER the enable pass, so a freshly-enabled
 * advanced tool reports `enabled:true` (RESEARCH.md §5.11 progressive discovery).
 */
export function toolsSearchHandler(
  args: ToolsSearchArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  // The registry/surface are in-memory (no REST), so the work is synchronous; `runRead` awaits the
  // inner fn (satisfying the async contract) and applies the uniform error surface as a bonus.
  return runRead(() => Promise.resolve(searchTools(args, ctx)));
}

/** Synchronous core of {@link toolsSearchHandler} — find matches, enable disabled matches, build the result. */
function searchTools(args: ToolsSearchArgs, ctx: ToolContext): ToolResult {
  const { query, prefix, limit } = args;

  const matched = ctx.registry.listDescriptors().filter((d) => matchesSearch(d, query, prefix));

  // Enable matched-but-disabled tools (§5.3). The SurfaceController dedupes already-enabled / unknown
  // names and emits one listChanged for the whole batch (or none on a no-op).
  const disabledMatches = matched.filter((d) => !ctx.surface.isEnabled(d.name)).map((d) => d.name);
  if (disabledMatches.length > 0) {
    ctx.surface.enable(disabledMatches);
  }

  const limited = limit >= 0 ? matched.slice(0, limit) : matched;
  const tools: ToolSearchEntry[] = limited.map((d) => ({
    name: d.name,
    title: d.title,
    description: d.description,
    enabled: ctx.surface.isEnabled(d.name),
    inputSchema: d.inputSchema,
    annotations: d.annotations,
  }));

  const structured = { tools, total: matched.length };
  const text =
    disabledMatches.length > 0
      ? `Matched ${matched.length} tool(s); enabled ${disabledMatches.length} previously-disabled tool(s).`
      : `Matched ${matched.length} tool(s).`;
  return okResult(structured, text);
}

/* ───────────────────────────── elementor.pages.list (§1.1 / §0.6) ─────────────────────────── */

/** The catalog item keys `pages.list` exposes (the §0.6 `fields` projection universe). */
const PAGES_LIST_ITEM_KEYS = ['id', 'title', 'status', 'url', 'type'] as const;

/**
 * `elementor.pages.list` handler (13-tool-catalog.md §1.1; 10-rest-api.md §2.1). Proxies `GET
 * /documents` with `{status, post_type}` + §0.6 pagination (`limit`/`cursor`/`fields`), then projects
 * each REST {@link DocumentListItem} to the catalog's `{id,title,status,url,type}` item shape. NEVER
 * unbounded — the SDK supplies the default `limit` (§0.6).
 *
 * M-c (contract 18 §7): `fields` is FORWARDED to the REST route AND re-applied locally (the local
 * projection guarantees the contract — "projected response contains ONLY requested fields" — even
 * if the REST layer ignores or mangles the param).
 */
export async function pagesListHandler(
  args: PagesListArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runRead(async () => {
    const query: ListDocumentsRequest = {
      status: args.status,
      ...(args.post_type !== undefined ? { post_type: args.post_type } : {}),
      limit: args.limit,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.fields !== undefined ? { fields: args.fields } : {}),
    };
    const data = await ctx.wp.listDocuments(query);
    // The catalog item universe, intersected with the requested `fields` (when present). Keys the
    // REST layer already projected away are simply absent (`fieldProjectedItem` output schema).
    const wanted =
      args.fields !== undefined
        ? PAGES_LIST_ITEM_KEYS.filter((k) => args.fields!.includes(k))
        : [...PAGES_LIST_ITEM_KEYS];
    const items = data.items.map((item: DocumentListItem) => {
      const out: Record<string, unknown> = {};
      for (const key of wanted) {
        const value = (item as unknown as Record<string, unknown>)[key];
        if (value !== undefined) {
          out[key] = value;
        }
      }
      return out;
    });
    const structured = {
      items,
      next_cursor: data.next_cursor,
      total: data.total ?? items.length,
    };
    return okResult(
      structured,
      `Listed ${items.length} page(s)${data.next_cursor !== null ? ' (more available)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.page.get_structure (§1.1) ────────────────────────── */

/**
 * A node projected to `{id,elType,widgetType}` (Contract 13 §1.1 `projection=summary`) plus an EMPTY
 * `settings: {}`. The catalog `outputSchema` types `elements` as `ElementNode` (which REQUIRES
 * `settings`), so summary mode strips the heavy real `settings`/`styles` payload but keeps an empty
 * `settings` bag so each node still validates against `elementNodeSchema` (the SDK validates the
 * handler's `structuredContent` against `outputSchema` at runtime). This preserves the §5.11 intent
 * (slim, structure-only nodes) while staying schema-valid.
 */
interface SummaryNode {
  id: string;
  elType: string;
  widgetType?: string;
  settings: Record<string, never>;
  elements?: SummaryNode[];
}

/** Recursively project an element tree to summary nodes (`{id,elType,widgetType}` + empty settings). */
function projectSummary(nodes: ElementNode[]): SummaryNode[] {
  return nodes.map((node) => {
    const summary: SummaryNode = { id: node.id, elType: node.elType, settings: {} };
    if (node.widgetType !== undefined) {
      summary.widgetType = node.widgetType;
    }
    const children = node.elements;
    if (Array.isArray(children) && children.length > 0) {
      // Carry children through so the summary preserves tree shape.
      summary.elements = projectSummary(children);
    }
    return summary;
  });
}

/**
 * `elementor.page.get_structure` handler (13-tool-catalog.md §1.1; 10-rest-api.md §2.4). Reads the
 * document element tree with `depth` / `subtree_id` / `projection` threaded to the REST query, returns
 * the `base_hash` (required by surgical writes) + `generation`. `projection=summary` reduces each node
 * to `{id,elType,widgetType}` (RESEARCH.md §5.11). PHP performs depth/subtree slicing server-side; the
 * `summary` projection is applied here so the TS layer never depends on PHP honoring it.
 */
export async function pageGetStructureHandler(
  args: PageGetStructureArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runRead(async () => {
    const query: GetDocumentRequest = {
      ...(args.depth !== undefined ? { depth: args.depth } : {}),
      ...(args.subtree_id !== undefined ? { subtree_id: args.subtree_id } : {}),
      projection: args.projection,
    };
    const data = await ctx.wp.getDocument(args.post_id, query);
    const elements: unknown[] =
      args.projection === 'summary' ? projectSummary(data.elements) : data.elements;
    const structured = {
      elements,
      base_hash: data.base_hash,
      generation: data.generation as Generation | 'mixed',
    };
    return okResult(
      structured,
      `Read ${elements.length} top-level element(s) of document ${args.post_id} (generation=${data.generation}).`,
    );
  });
}

/* ───────────────────────────── elementor.page.get_settings (§1.1) ─────────────────────────── */

/**
 * `elementor.page.get_settings` handler (13-tool-catalog.md §1.1; 10-rest-api.md §2.5). Proxies
 * `GET /documents/{id}/settings` and returns the raw `_elementor_page_settings` bag.
 */
export async function pageGetSettingsHandler(
  args: PageGetSettingsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runRead(async () => {
    const data = await ctx.wp.getDocumentSettings(args.post_id);
    const structured = { settings: data.settings };
    return okResult(
      structured,
      `Read ${Object.keys(data.settings).length} page setting(s) for document ${args.post_id}.`,
    );
  });
}

/* ───────────────────────────── elementor.schema.widget (§1.1) ─────────────────────────────── */

/**
 * `elementor.schema.widget` handler (13-tool-catalog.md §1.1; 10-rest-api.md §3.1). Proxies `GET
 * /schema/widget/{type}` and returns the POST-filter schema UNCHANGED (PHP injects `_cssid` + dynamic
 * flags — §Detailed Requirements 5; SUPPLEMENT.md §B.2). `kind` derives from `generation` (`v4`⇒
 * atomic, else classic); atomic uses `props_schema`, classic uses `controls`; `dynamic_props` comes
 * from the per-prop `dynamic.active` PHP exposes as `dynamic_props[]`.
 */
export async function schemaWidgetHandler(
  args: SchemaWidgetArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runRead(async () => {
    const data = await ctx.wp.schemaWidget(args.type);
    const kind: 'atomic' | 'classic' = data.generation === 'v4' ? 'atomic' : 'classic';
    const schema: Record<string, unknown> = data.props_schema ?? data.controls ?? {};
    const structured = {
      kind,
      schema,
      dynamic_props: data.dynamic_props ?? [],
      version: data.version ?? '',
    };
    return okResult(
      structured,
      `Schema for ${args.type} (kind=${kind}, ${Object.keys(schema).length} prop(s)).`,
    );
  });
}

/* ───────────────────────────── elementor.schema.styles (§1.1) ─────────────────────────────── */

/**
 * `elementor.schema.styles` handler (13-tool-catalog.md §1.1; 10-rest-api.md §3.2). Proxies `GET
 * /schema/styles` and returns the flat atomic Style-Schema (`props`), unit presets (`units`) and the
 * state enum (`states`) unchanged (live shape — Pro injects, SUPPLEMENT.md §B.3).
 */
export async function schemaStylesHandler(
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runRead(async () => {
    const data = await ctx.wp.schemaStyles();
    const structured = {
      props: data.props,
      units: data.units,
      states: data.states,
    };
    return okResult(
      structured,
      `Style-Schema: ${Object.keys(data.props).length} prop(s), ${data.states.length} state(s).`,
    );
  });
}

/* ───────────────────────────── elementor.breakpoints.get (§1.1 / §3.4) ────────────────────── */

/**
 * `elementor.breakpoints.get` handler (13-tool-catalog.md §1.1; 10-rest-api.md §3.4). Proxies `GET
 * /schema/breakpoints` and maps the RAW `{items, active_direction, desktop_first}` to the catalog
 * `{breakpoints[], default_direction}` shape. NEVER hardcodes 768/1024 (§Detailed Requirements 8 —
 * the route is the source of truth). `default_direction` derives from `desktop_first` (mobile-first ⇒
 * `min` widths, desktop-first ⇒ `max`); `label` defaults to the key when the route omits it.
 */
export async function breakpointsGetHandler(
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runRead(async () => {
    const data = await ctx.wp.schemaBreakpoints();
    const breakpoints = data.items.map((bp: Breakpoint) => ({
      key: bp.key,
      label: bp.label ?? bp.key,
      direction: bp.direction,
      value: bp.value,
    }));
    const structured = {
      breakpoints,
      default_direction: data.desktop_first ? 'desktop_first' : 'mobile_first',
    };
    return okResult(
      structured,
      `Active breakpoints: ${breakpoints.map((b) => b.key).join(', ') || '(none)'} (default_direction=${structured.default_direction}).`,
    );
  });
}

/* ───────────────────────────── elementor.dynamic.list_tags (§1.1 / §8) ────────────────────── */

/**
 * Apply an opaque numeric-offset cursor to a fully-materialized list (the dynamic-tags route returns
 * ALL tags in one shot — `ListDynamicTagsResponse` has no server pagination). The cursor is the
 * stringified next offset; `null` next_cursor ⇒ last page (10-rest-api.md §0.11 / Contract 13 §0.6).
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
 * `elementor.dynamic.list_tags` handler (13-tool-catalog.md §1.1; 10-rest-api.md §8.7). Proxies the
 * Pro dynamic-tags route (which ALSO returns free tags — §Detailed Requirements 7), filters by
 * `categories`, paginates via `{limit,cursor}` (§0.6), and maps each RAW {@link DynamicTagItem}
 * (`{name,title,group,categories}`) to the catalog `{name,label,group,categories}` item (`title`⇒
 * `label`). A Pro-inactive 501 surfaces informationally as `PRO_REQUIRED`/`EXPERIMENT_INACTIVE` via
 * the client error path.
 */
export async function dynamicListTagsHandler(
  args: DynamicListTagsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runRead(async () => {
    const data = await ctx.wp.listDynamicTags();
    const wanted = args.categories;
    const filtered =
      wanted !== undefined && wanted.length > 0
        ? data.items.filter((tag: DynamicTagItem) => tag.categories.some((c) => wanted.includes(c)))
        : data.items;
    const mapped = filtered.map((tag: DynamicTagItem) => ({
      name: tag.name,
      label: tag.title,
      group: tag.group,
      categories: tag.categories,
    }));
    const page = paginateLocal(mapped, args.limit, args.cursor);
    const structured = {
      items: page.items,
      next_cursor: page.next_cursor,
      total: page.total,
    };
    return okResult(
      structured,
      `Listed ${page.items.length} dynamic tag(s)${page.next_cursor !== null ? ' (more available)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.dynamic.get_tag_schema (§1.1 / §8) ───────────────── */

/**
 * `elementor.dynamic.get_tag_schema` handler (13-tool-catalog.md §1.1; 10-rest-api.md §8.7). Proxies
 * `GET /pro/dynamic/tags/{name}` and returns the per-tag `{controls, categories, group}`. The RAW
 * `GetDynamicTagResponse` omits `group`; it is read off `data.group` when present (PHP may inject it)
 * and falls back to `''` otherwise. Pro-inactive ⇒ informational `PRO_REQUIRED` via the client path.
 */
export async function dynamicGetTagSchemaHandler(
  args: DynamicGetTagSchemaArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runRead(async () => {
    const data = await ctx.wp.getDynamicTag(args.tag_name);
    const rawGroup = (data as unknown as { group?: unknown }).group;
    const group = typeof rawGroup === 'string' ? rawGroup : '';
    const structured = {
      controls: data.controls,
      categories: data.categories,
      group,
    };
    return okResult(
      structured,
      `Tag ${args.tag_name}: ${Object.keys(data.controls).length} control(s), categories=[${data.categories.join(', ')}].`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ───────────────── */

/**
 * Attach every discovery/read handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name
 * (§Detailed Requirements 1; §Acceptance). The registry stores handlers under its loose
 * `(args) => unknown` type; the runtime invokes them as `(args, ctx)` (server core casts to the
 * WP-T01 {@link ToolHandler} signature), so each handler is registered through that signature here.
 *
 * `elementor.site.capabilities` is intentionally NOT attached — WP-F05 owns it
 * (`tools/discovery-capabilities.ts`, §Summary).
 */
export function attachDiscoveryHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [TOOLS_SEARCH]: (args, ctx) => toolsSearchHandler(args as ToolsSearchArgs, ctx),
    [PAGES_LIST]: (args, ctx) => pagesListHandler(args as PagesListArgs, ctx),
    [PAGE_GET_STRUCTURE]: (args, ctx) => pageGetStructureHandler(args as PageGetStructureArgs, ctx),
    [PAGE_GET_SETTINGS]: (args, ctx) => pageGetSettingsHandler(args as PageGetSettingsArgs, ctx),
    [SCHEMA_WIDGET]: (args, ctx) => schemaWidgetHandler(args as SchemaWidgetArgs, ctx),
    [SCHEMA_STYLES]: (args, ctx) => schemaStylesHandler(args as Record<string, never>, ctx),
    [BREAKPOINTS_GET]: (args, ctx) => breakpointsGetHandler(args as Record<string, never>, ctx),
    [DYNAMIC_LIST_TAGS]: (args, ctx) => dynamicListTagsHandler(args as DynamicListTagsArgs, ctx),
    [DYNAMIC_GET_TAG_SCHEMA]: (args, ctx) =>
      dynamicGetTagSchemaHandler(args as DynamicGetTagSchemaArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
