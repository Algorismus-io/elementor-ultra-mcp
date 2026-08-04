/**
 * WP-T04 — discovery / read handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade), use a real WP-F04
 * {@link ToolRegistry}, and a fake {@link SurfaceController}-shaped object. The tests assert:
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`
 *    (the ZodRawShape wrapped in `z.object(...)`),
 *  - `tools.search` enables matched DISABLED tools and triggers exactly one `surface.enable(...)`
 *    (the SurfaceController emits the single `sendToolListChanged` — covered by WP-T01's tests),
 *  - `pages.list` / `dynamic.list_tags` paginate (passthrough + local cursor),
 *  - a thrown {@link WpClientError} renders an `isError` taxonomy result (surface:'isError'), and a
 *    `surface:'protocol'` payload THROWS (ProtocolError) per 12-error-taxonomy.md §5.
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type Breakpoint,
  type DocumentListItem,
  type DynamicTagItem,
  type ElementNode,
  type SchemaBreakpointsResponse,
  type SchemaStylesResponse,
  type SchemaWidgetResponse,
  type ListDynamicTagsResponse,
  type ListDocumentsResponse,
  type GetDocumentResponse,
  type GetDocumentSettingsResponse,
  type GetDynamicTagResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import { WpClientError } from '../wp/types.js';
import { ProtocolError } from '../wp/errors.js';

import {
  attachDiscoveryHandlers,
  breakpointsGetHandler,
  dynamicGetTagSchemaHandler,
  dynamicListTagsHandler,
  pageGetSettingsHandler,
  pageGetStructureHandler,
  pagesListHandler,
  schemaStylesHandler,
  schemaWidgetHandler,
  toolsSearchHandler,
  DISCOVERY_TOOL_NAMES,
  TOOLS_SEARCH,
  PAGES_LIST,
  PAGE_GET_STRUCTURE,
  PAGE_GET_SETTINGS,
  SCHEMA_WIDGET,
  SCHEMA_STYLES,
  BREAKPOINTS_GET,
  DYNAMIC_LIST_TAGS,
  DYNAMIC_GET_TAG_SCHEMA,
} from './discovery.js';

/* ───────────────────────────── shared test helpers ────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the routes the handlers call. */
interface MockWp {
  listDocuments: ReturnType<typeof vi.fn>;
  getDocument: ReturnType<typeof vi.fn>;
  getDocumentSettings: ReturnType<typeof vi.fn>;
  schemaWidget: ReturnType<typeof vi.fn>;
  schemaStyles: ReturnType<typeof vi.fn>;
  schemaBreakpoints: ReturnType<typeof vi.fn>;
  listDynamicTags: ReturnType<typeof vi.fn>;
  getDynamicTag: ReturnType<typeof vi.fn>;
}

/** A fake SurfaceController exposing only the members `tools.search` uses, tracking enable calls. */
function makeSurface(enabledNames: Set<string>): {
  isEnabled: (name: string) => boolean;
  enable: ReturnType<typeof vi.fn>;
} {
  const enable = vi.fn((names: readonly string[]): string[] => {
    const changed: string[] = [];
    for (const n of names) {
      if (!enabledNames.has(n)) {
        enabledNames.add(n);
        changed.push(n);
      }
    }
    return changed;
  });
  return {
    isEnabled: (name: string): boolean => enabledNames.has(name),
    enable,
  };
}

/** Build a minimal {@link ToolContext} carrying the mock `wp`, a real registry, and a fake surface. */
function makeCtx(
  wp: MockWp,
  registry: ToolRegistry,
  surface: { isEnabled: (n: string) => boolean; enable: ReturnType<typeof vi.fn> },
): ToolContext {
  return {
    wp,
    registry,
    surface,
    capabilities: {} as ToolContext['capabilities'],
    elicit: (() => Promise.resolve(false)) as unknown as ToolContext['elicit'],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolContext;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    listDocuments: vi.fn(),
    getDocument: vi.fn(),
    getDocumentSettings: vi.fn(),
    schemaWidget: vi.fn(),
    schemaStyles: vi.fn(),
    schemaBreakpoints: vi.fn(),
    listDynamicTags: vi.fn(),
    getDynamicTag: vi.fn(),
  };
}

/** The WP-F04 descriptor `outputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function outputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).outputSchema);
}

/** Extract the `structuredContent` from a tool result (assumes a success result). */
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/* ───────────────────────────── attachment (Acceptance) ────────────────────────────────────── */

describe('attachDiscoveryHandlers', () => {
  it('attaches a handler for every §1.1 discovery tool EXCEPT site.capabilities', () => {
    const registry = createToolRegistry();
    attachDiscoveryHandlers(registry);

    for (const name of DISCOVERY_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
    }
    // site.capabilities is WP-F05's — this WP must NOT attach it.
    expect(registry.hasHandler('elementor.site.capabilities')).toBe(false);
    // Every name we attach must exist in the frozen catalog (exact-name match).
    for (const name of DISCOVERY_TOOL_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('attaches exactly the nine discovery names this WP owns', () => {
    expect([...DISCOVERY_TOOL_NAMES].sort()).toEqual(
      [
        TOOLS_SEARCH,
        PAGES_LIST,
        PAGE_GET_STRUCTURE,
        PAGE_GET_SETTINGS,
        SCHEMA_WIDGET,
        SCHEMA_STYLES,
        BREAKPOINTS_GET,
        DYNAMIC_LIST_TAGS,
        DYNAMIC_GET_TAG_SCHEMA,
      ].sort(),
    );
  });
});

/* ───────────────────────────── elementor.tools.search (§5.3) ──────────────────────────────── */

describe('toolsSearchHandler', () => {
  it('matches by query + enables matched DISABLED tools (one surface.enable batch)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // Pretend everything is disabled at boot except nothing — the surface tracks enabled state.
    const enabled = new Set<string>();
    const surface = makeSurface(enabled);
    const ctx = makeCtx(wp, registry, surface);

    const result = await toolsSearchHandler({ query: 'breakpoint', limit: 30 }, ctx);
    const out = structured(result);

    // Output validates against the WP-F04 schema.
    outputValidator(registry, TOOLS_SEARCH).parse(out);

    // The breakpoints tool matched and was enabled in exactly one enable() batch.
    expect(surface.enable).toHaveBeenCalledTimes(1);
    const enabledArg = surface.enable.mock.calls[0]?.[0] as string[];
    expect(enabledArg).toContain('elementor.breakpoints.get');
    // The matched entry reports enabled:true (state AFTER the enable pass).
    const entry = (out['tools'] as Array<{ name: string; enabled: boolean }>).find(
      (t) => t.name === 'elementor.breakpoints.get',
    );
    expect(entry?.enabled).toBe(true);
  });

  it('does NOT call surface.enable when all matches are already enabled (no-op)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const enabled = new Set<string>(['elementor.breakpoints.get']);
    const surface = makeSurface(enabled);
    const ctx = makeCtx(wp, registry, surface);

    await toolsSearchHandler({ query: 'elementor.breakpoints.get', limit: 5 }, ctx);

    expect(surface.enable).not.toHaveBeenCalled();
  });

  it('filters by prefix and caps results at `limit`', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const surface = makeSurface(new Set<string>());
    const ctx = makeCtx(wp, registry, surface);

    const result = await toolsSearchHandler({ prefix: 'elementor.schema.', limit: 1 }, ctx);
    const out = structured(result);
    outputValidator(registry, TOOLS_SEARCH).parse(out);

    const tools = out['tools'] as Array<{ name: string }>;
    expect(tools.length).toBe(1); // capped at limit
    expect(tools.every((t) => t.name.startsWith('elementor.schema.'))).toBe(true);
    // total reflects ALL matches, not just the limited page.
    expect(out['total'] as number).toBeGreaterThanOrEqual(tools.length);
  });
});

/* ───────────────────────────── elementor.pages.list (§0.6 pagination) ─────────────────────── */

describe('pagesListHandler', () => {
  const item: DocumentListItem = {
    id: 10,
    title: 'Home',
    status: 'publish',
    url: 'http://x/home',
    type: 'page',
    edit_url: 'http://x/edit',
    built_with_elementor: true,
  };

  it('passes pagination through and projects items to {id,title,status,url,type}', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: ListDocumentsResponse = { items: [item], next_cursor: 'next-1', total: 42 };
    wp.listDocuments.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await pagesListHandler(
      { status: 'publish', post_type: 'page', limit: 25, cursor: 'c0', fields: ['id'] },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PAGES_LIST).parse(out);

    // Pagination passthrough to the F02 route — M-c (contract 18 §7): `fields` is FORWARDED, no
    // longer a silent no-op.
    expect(wp.listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'publish',
        post_type: 'page',
        limit: 25,
        cursor: 'c0',
        fields: ['id'],
      }),
    );
    expect(out['next_cursor']).toBe('next-1');
    expect(out['total']).toBe(42);
    // M-c guard: the projected response contains ONLY the requested fields.
    const got = (out['items'] as Array<Record<string, unknown>>)[0];
    expect(Object.keys(got ?? {}).sort()).toEqual(['id']);
  });

  it('returns the full 5-key catalog item shape when no fields projection is requested (M-c)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: ListDocumentsResponse = { items: [item], next_cursor: null, total: 1 };
    wp.listDocuments.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await pagesListHandler({ status: 'any', limit: 25 }, ctx);
    const out = structured(result);
    outputValidator(registry, PAGES_LIST).parse(out);
    const got = (out['items'] as Array<Record<string, unknown>>)[0];
    expect(Object.keys(got ?? {}).sort()).toEqual(['id', 'status', 'title', 'type', 'url']);
  });

  it('omits optional query params when not provided', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listDocuments.mockResolvedValue({ items: [], next_cursor: null, total: 0 });
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    await pagesListHandler({ status: 'any', limit: 50 }, ctx);

    const arg = wp.listDocuments.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('post_type' in arg).toBe(false);
    expect('cursor' in arg).toBe(false);
    expect('fields' in arg).toBe(false);
  });
});

/* ───────────────────────────── elementor.page.get_structure (§1.1) ────────────────────────── */

describe('pageGetStructureHandler', () => {
  const tree: ElementNode[] = [
    {
      id: 'sec1',
      elType: 'container',
      settings: {},
      elements: [{ id: 'w1', elType: 'widget', widgetType: 'e-heading', settings: {} }],
    },
  ];

  // `generation` is widened to include 'mixed' so the test can assert the handler passes 'mixed'
  // through (the REST `GetDocumentResponse.generation` type is v4|v3, but the tool output allows
  // 'mixed' per Contract 13 §1.1 — PHP may report a mixed tree).
  function docResp(generation: 'v4' | 'v3' | 'mixed'): GetDocumentResponse {
    return {
      id: 10,
      elements: tree,
      settings: {},
      base_hash: 'abc123',
      generation: generation as GetDocumentResponse['generation'],
      type: 'wp-page',
    };
  }

  it('threads depth/subtree/projection and returns base_hash + generation (full)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.getDocument.mockResolvedValue(docResp('v4'));
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await pageGetStructureHandler(
      { post_id: 10, depth: 2, subtree_id: 'sec1', projection: 'full' },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PAGE_GET_STRUCTURE).parse(out);

    expect(wp.getDocument).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ depth: 2, subtree_id: 'sec1', projection: 'full' }),
    );
    expect(out['base_hash']).toBe('abc123');
    expect(out['generation']).toBe('v4');
    // full projection returns the elements verbatim.
    expect((out['elements'] as ElementNode[])[0]?.id).toBe('sec1');
  });

  it('projection=summary reduces nodes to {id,elType,widgetType} (recursively)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.getDocument.mockResolvedValue(docResp('mixed'));
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await pageGetStructureHandler({ post_id: 10, projection: 'summary' }, ctx);
    const out = structured(result);
    outputValidator(registry, PAGE_GET_STRUCTURE).parse(out);

    const top = (out['elements'] as Array<Record<string, unknown>>)[0];
    expect(top?.['id']).toBe('sec1');
    expect(top?.['elType']).toBe('container');
    // summary keeps only {id,elType,widgetType?,settings:{},elements?} — settings reduced to {}.
    expect(top?.['settings']).toEqual({});
    expect(Object.keys(top ?? {}).sort()).toEqual(['elType', 'elements', 'id', 'settings']);
    const child = (top?.['elements'] as Array<Record<string, unknown>>)[0];
    expect(child?.['widgetType']).toBe('e-heading');
    expect(child?.['settings']).toEqual({});
    expect(Object.keys(child ?? {}).sort()).toEqual(['elType', 'id', 'settings', 'widgetType']);
    expect(out['generation']).toBe('mixed'); // generation passthrough incl. 'mixed'
  });
});

/* ───────────────────────────── elementor.page.get_settings (§1.1) ─────────────────────────── */

describe('pageGetSettingsHandler', () => {
  it('returns the settings bag and validates against the schema', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: GetDocumentSettingsResponse = { settings: { background_color: '#fff' } };
    wp.getDocumentSettings.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await pageGetSettingsHandler({ post_id: 10 }, ctx);
    const out = structured(result);
    outputValidator(registry, PAGE_GET_SETTINGS).parse(out);

    expect(wp.getDocumentSettings).toHaveBeenCalledWith(10);
    expect((out['settings'] as Record<string, unknown>)['background_color']).toBe('#fff');
  });
});

/* ───────────────────────────── elementor.schema.widget (§1.1 / §3.1) ──────────────────────── */

describe('schemaWidgetHandler', () => {
  it('maps an atomic widget (props_schema → schema, kind=atomic)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: SchemaWidgetResponse = {
      type: 'e-heading',
      generation: 'v4',
      props_schema: { title: { kind: 'string' }, _cssid: { kind: 'string' } },
      dynamic_props: ['title'],
      version: '0.0.1',
    };
    wp.schemaWidget.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await schemaWidgetHandler({ type: 'e-heading' }, ctx);
    const out = structured(result);
    outputValidator(registry, SCHEMA_WIDGET).parse(out);

    expect(wp.schemaWidget).toHaveBeenCalledWith('e-heading');
    expect(out['kind']).toBe('atomic');
    expect(Object.keys(out['schema'] as Record<string, unknown>)).toContain('_cssid');
    expect(out['dynamic_props']).toEqual(['title']);
    expect(out['version']).toBe('0.0.1');
  });

  it('maps a classic widget (controls → schema, kind=classic, defaults dynamic_props/version)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: SchemaWidgetResponse = {
      type: 'heading',
      generation: 'v3',
      controls: { title: { type: 'text' } },
    };
    wp.schemaWidget.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await schemaWidgetHandler({ type: 'heading' }, ctx);
    const out = structured(result);
    outputValidator(registry, SCHEMA_WIDGET).parse(out);

    expect(out['kind']).toBe('classic');
    expect(out['schema']).toEqual({ title: { type: 'text' } });
    expect(out['dynamic_props']).toEqual([]);
    expect(out['version']).toBe('');
  });
});

/* ───────────────────────────── elementor.schema.styles (§1.1 / §3.2) ──────────────────────── */

describe('schemaStylesHandler', () => {
  it('returns props/units/states unchanged', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: SchemaStylesResponse = {
      props: { color: { kind: 'color' } },
      units: { 'font-size': ['px', 'em', 'rem'] },
      states: ['null', 'hover', 'active'],
    };
    wp.schemaStyles.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await schemaStylesHandler({}, ctx);
    const out = structured(result);
    outputValidator(registry, SCHEMA_STYLES).parse(out);

    expect(out['props']).toEqual({ color: { kind: 'color' } });
    expect(out['units']).toEqual({ 'font-size': ['px', 'em', 'rem'] });
    expect(out['states']).toEqual(['null', 'hover', 'active']);
  });
});

/* ───────────────────────────── elementor.breakpoints.get (§1.1 / §3.4) ────────────────────── */

describe('breakpointsGetHandler', () => {
  const bps: Breakpoint[] = [
    { key: 'mobile', label: 'Mobile', direction: 'max', value: 767 },
    { key: 'tablet', direction: 'max', value: 1024 }, // label omitted → defaults to key
  ];

  it('maps items → breakpoints, defaults label to key, derives default_direction', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: SchemaBreakpointsResponse = {
      items: bps,
      active_direction: 'max',
      desktop_first: true,
    };
    wp.schemaBreakpoints.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await breakpointsGetHandler({}, ctx);
    const out = structured(result);
    outputValidator(registry, BREAKPOINTS_GET).parse(out);

    const list = out['breakpoints'] as Array<{ key: string; label: string; value: number }>;
    expect(list[0]?.label).toBe('Mobile');
    expect(list[1]?.label).toBe('tablet'); // defaulted to key
    expect(out['default_direction']).toBe('desktop_first');
    // never hardcoded — values come from the route.
    expect(list[0]?.value).toBe(767);
  });

  it('derives mobile_first when desktop_first is false', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.schemaBreakpoints.mockResolvedValue({
      items: [],
      active_direction: 'min',
      desktop_first: false,
    } satisfies SchemaBreakpointsResponse);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const out = structured(await breakpointsGetHandler({}, ctx));
    expect(out['default_direction']).toBe('mobile_first');
  });
});

/* ───────────────────────────── elementor.dynamic.list_tags (§1.1 / §8) ────────────────────── */

describe('dynamicListTagsHandler', () => {
  const tags: DynamicTagItem[] = [
    { name: 'post-title', title: 'Post Title', group: 'post', categories: ['text'] },
    { name: 'site-logo', title: 'Site Logo', group: 'site', categories: ['image'] },
    { name: 'author-name', title: 'Author Name', group: 'author', categories: ['text'] },
  ];

  it('maps title→label, filters by categories, validates schema', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listDynamicTags.mockResolvedValue({ items: tags } satisfies ListDynamicTagsResponse);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await dynamicListTagsHandler({ categories: ['text'], limit: 50 }, ctx);
    const out = structured(result);
    outputValidator(registry, DYNAMIC_LIST_TAGS).parse(out);

    const items = out['items'] as Array<{ name: string; label: string }>;
    expect(items.map((i) => i.name).sort()).toEqual(['author-name', 'post-title']);
    expect(items.find((i) => i.name === 'post-title')?.label).toBe('Post Title');
  });

  it('paginates locally via limit/cursor (next_cursor + total)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listDynamicTags.mockResolvedValue({ items: tags } satisfies ListDynamicTagsResponse);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const page1 = structured(await dynamicListTagsHandler({ limit: 2 }, ctx));
    expect((page1['items'] as unknown[]).length).toBe(2);
    expect(page1['next_cursor']).toBe('2');
    expect(page1['total']).toBe(3);

    const page2 = structured(
      await dynamicListTagsHandler({ limit: 2, cursor: page1['next_cursor'] as string }, ctx),
    );
    expect((page2['items'] as unknown[]).length).toBe(1);
    expect(page2['next_cursor']).toBeNull();
  });
});

/* ───────────────────────────── elementor.dynamic.get_tag_schema (§1.1 / §8) ───────────────── */

describe('dynamicGetTagSchemaHandler', () => {
  it('returns controls/categories and defaults group to "" when absent', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: GetDynamicTagResponse = {
      name: 'post-title',
      controls: { before: { type: 'text' } },
      categories: ['text'],
    };
    wp.getDynamicTag.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await dynamicGetTagSchemaHandler({ tag_name: 'post-title' }, ctx);
    const out = structured(result);
    outputValidator(registry, DYNAMIC_GET_TAG_SCHEMA).parse(out);

    expect(wp.getDynamicTag).toHaveBeenCalledWith('post-title');
    expect(out['categories']).toEqual(['text']);
    expect(out['group']).toBe('');
  });

  it('uses an injected group when PHP provides one', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.getDynamicTag.mockResolvedValue({
      name: 'post-title',
      controls: {},
      categories: ['text'],
      group: 'post',
    });
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const out = structured(await dynamicGetTagSchemaHandler({ tag_name: 'post-title' }, ctx));
    expect(out['group']).toBe('post');
  });
});

/* ───────────────────────────── error rendering (12-error-taxonomy.md §5) ──────────────────── */

describe('error rendering', () => {
  it('renders an isError taxonomy result for a surface:isError WpClientError (NOT_FOUND)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'No such document', {
      http_status: 404,
    });
    wp.getDocument.mockRejectedValue(new WpClientError(payload, { httpStatus: 404 }));
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    const result = await pageGetStructureHandler({ post_id: 999, projection: 'full' }, ctx);

    expect(result.isError).toBe(true);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc['code']).toBe(ErrorCodes.NOT_FOUND);
    expect(sc['surface']).toBe('isError');
  });

  it('THROWS a ProtocolError for a surface:protocol payload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params');
    wp.getDocumentSettings.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    await expect(pageGetSettingsHandler({ post_id: 1 }, ctx)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-WpClientError unchanged', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.schemaStyles.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry, makeSurface(new Set()));

    await expect(schemaStylesHandler({}, ctx)).rejects.toThrow('boom');
  });
});
