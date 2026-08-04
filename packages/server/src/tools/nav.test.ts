/**
 * WP-T09 — navigation / menu handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + `ctx.capabilities` + a real WP-F04
 * {@link ToolRegistry}. The tests assert:
 *  - all three §1.6 handlers attach by EXACT catalog name; annotations match the frozen catalog,
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`,
 *  - `menus.list` paginates locally (`limit`/`cursor`) over `GET /nav/menus` and maps the item verbatim,
 *  - `menus.create` builds REST items with `type` defaulting to `custom` + `parent_index`→`parent`,
 *    returns `{term_id,item_ids}`, sends a deterministic `op_id`, surfaces replay informationally,
 *  - `bind_widget` REQUIRES `base_hash`, returns a synthesized single-node `modified` diff + new
 *    `base_hash`, gates on Pro (`PRO_REQUIRED` when `capabilities.pro=false`, WITHOUT a REST call), and
 *    surfaces `IDEMPOTENT_REPLAY` informationally,
 *  - a `surface:'isError'` {@link WpClientError} (e.g. `NOT_FOUND`) renders an `isError` taxonomy result;
 *    a `surface:'protocol'` payload THROWS a {@link ProtocolError}; a non-client error rethrows
 *    (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type Capabilities,
  type BindNavWidgetResponse,
  type CreateNavMenuResponse,
  type ListNavMenusResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import { WpClientError } from '../wp/types.js';
import { ProtocolError } from '../wp/errors.js';
import { OP_ID_PATTERN } from '../safety/idempotency.js';

import {
  attachNavHandlers,
  navMenusListHandler,
  navMenusCreateHandler,
  navBindWidgetHandler,
  NAV_TOOL_NAMES,
  NAV_MENUS_LIST,
  NAV_MENUS_CREATE,
  NAV_BIND_WIDGET,
} from './nav.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the nav routes the handlers call. */
interface MockWp {
  listNavMenus: ReturnType<typeof vi.fn>;
  createNavMenu: ReturnType<typeof vi.fn>;
  bindNavWidget: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    listNavMenus: vi.fn(),
    createNavMenu: vi.fn(),
    bindNavWidget: vi.fn(),
  };
}

/** A minimal {@link Capabilities} probe with `pro` overridable (other fields are inert here). */
function makeCaps(pro: boolean): Capabilities {
  return {
    v4: true,
    atomic: true,
    global_classes: true,
    variables: true,
    pro,
    pro_atomic_form: false,
    breakpoints: [],
    experiments: {},
    can_update_class: true,
    classes_migrated: true,
    registered_types: { atomic: [], classic: [] },
    versions: { elementor: '4.1.1', pro: pro ? '4.1.0' : null, plugin: '0.0.0' },
    unfiltered_html: true,
  };
}

/** Build a minimal {@link ToolContext} carrying the mock `wp`, a `pro` capability probe, + a registry. */
function makeCtx(wp: MockWp, registry: ToolRegistry, pro = true): ToolContext {
  const capabilities = { get: vi.fn(() => Promise.resolve(makeCaps(pro))) };
  return {
    wp,
    registry,
    surface: {} as ToolContext['surface'],
    capabilities: capabilities as unknown as ToolContext['capabilities'],
    elicit: (() => Promise.resolve({ confirmed: false })) as unknown as ToolContext['elicit'],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolContext;
}

/** The WP-F04 descriptor `outputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function outputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).outputSchema);
}

/** Extract the `structuredContent` from a tool result. */
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** The first text content block of a tool result (content blocks are a union; narrow to text). */
function firstText(result: { content?: unknown }): string {
  const blocks = result.content as Array<{ type: string; text?: string }> | undefined;
  const block = blocks?.[0];
  return block?.text ?? '';
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachNavHandlers', () => {
  it('attaches a handler for every §1.6 nav tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachNavHandlers(registry);

    for (const name of NAV_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the three §1.6 nav names', () => {
    expect([...NAV_TOOL_NAMES].sort()).toEqual(
      [NAV_MENUS_LIST, NAV_MENUS_CREATE, NAV_BIND_WIDGET].sort(),
    );
  });

  it('none of the nav tools are ★ (Contract 13 §5.2)', () => {
    const registry = createToolRegistry();
    for (const name of NAV_TOOL_NAMES) {
      expect(registry.getDescriptor(name).star).toBe(false);
    }
  });

  it('annotations match the frozen catalog (menus.list R/idempotent; bind_widget idempotent)', () => {
    const registry = createToolRegistry();
    const list = registry.getDescriptor(NAV_MENUS_LIST).annotations as Record<string, boolean>;
    expect(list.readOnlyHint).toBe(true);
    expect(list.idempotentHint).toBe(true);
    const bind = registry.getDescriptor(NAV_BIND_WIDGET).annotations as Record<string, boolean>;
    expect(bind.idempotentHint).toBe(true);
  });
});

/* ───────────────────────────── elementor.nav.menus.list (§1.6 / §0.6) ───────────────────────── */

describe('navMenusListHandler', () => {
  function menusResp(): ListNavMenusResponse {
    return {
      items: [
        { term_id: 3, name: 'Main', slug: 'main', count: 5 },
        { term_id: 4, name: 'Footer', slug: 'footer', count: 2 },
        { term_id: 5, name: 'Mobile', slug: 'mobile', count: 1 },
      ],
    };
  }

  it('proxies GET /nav/menus, maps items verbatim, validates against the descriptor', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listNavMenus.mockResolvedValue(menusResp());
    const ctx = makeCtx(wp, registry);

    const result = await navMenusListHandler({ limit: 50 }, ctx);
    const out = structured(result);
    outputValidator(registry, NAV_MENUS_LIST).parse(out);

    expect(wp.listNavMenus).toHaveBeenCalledTimes(1);
    expect(out.items).toEqual([
      { term_id: 3, name: 'Main', slug: 'main', count: 5 },
      { term_id: 4, name: 'Footer', slug: 'footer', count: 2 },
      { term_id: 5, name: 'Mobile', slug: 'mobile', count: 1 },
    ]);
    expect(out.total).toBe(3);
    expect(out.next_cursor).toBeNull();
  });

  it('paginates locally with limit + cursor (§0.6)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listNavMenus.mockResolvedValue(menusResp());
    const ctx = makeCtx(wp, registry);

    const first = structured(await navMenusListHandler({ limit: 2 }, ctx));
    expect((first.items as unknown[]).length).toBe(2);
    expect(first.next_cursor).toBe('2');
    expect(first.total).toBe(3);

    const second = structured(
      await navMenusListHandler({ limit: 2, cursor: first.next_cursor as string }, ctx),
    );
    expect((second.items as unknown[]).length).toBe(1);
    expect(second.next_cursor).toBeNull();
  });

  it('a stale / out-of-range cursor degrades to the first page (read-only, never throws)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listNavMenus.mockResolvedValue(menusResp());
    const ctx = makeCtx(wp, registry);

    const out = structured(await navMenusListHandler({ limit: 50, cursor: '9999' }, ctx));
    expect((out.items as unknown[]).length).toBe(3);
    expect(out.next_cursor).toBeNull();
  });

  it('renders a NOT_FOUND-class WpClientError as an isError result (§5)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'No nav menus.', {
      meta: { resource: 'nav_menu' },
    });
    wp.listNavMenus.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await navMenusListHandler({ limit: 50 }, ctx);
    expect(result.isError).toBe(true);
    expect((structured(result) as { code?: string }).code).toBe(ErrorCodes.NOT_FOUND);
  });
});

/* ───────────────────────────── elementor.nav.menus.create (§1.6 / §6) ───────────────────────── */

describe('navMenusCreateHandler', () => {
  function createResp(): CreateNavMenuResponse {
    return { term_id: 7, item_ids: [10, 11] };
  }

  it('builds REST items (type=custom default, parent_index→parent), returns {term_id,item_ids}', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createNavMenu.mockResolvedValue(createResp());
    const ctx = makeCtx(wp, registry);

    const result = await navMenusCreateHandler(
      {
        name: 'Main',
        items: [
          { title: 'Home', url: '/' },
          { title: 'Services', url: '/services' },
          // Nested under the previous sibling (index 1); page-link item carries object_id/type.
          { title: 'Consulting', object_id: 42, type: 'post_type', parent_index: 1 },
        ],
      },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, NAV_MENUS_CREATE).parse(out);

    expect(out).toMatchObject({ term_id: 7, item_ids: [10, 11] });

    const body = wp.createNavMenu.mock.calls[0]?.[0] as {
      name: string;
      items: Array<Record<string, unknown>>;
      op_id?: string;
    };
    expect(body.name).toBe('Main');
    // First item: defaults applied — type=custom, parent=0, object_id=0.
    expect(body.items[0]).toEqual({
      title: 'Home',
      url: '/',
      parent: 0,
      object_id: 0,
      type: 'custom',
    });
    // Third item: parent_index→parent, explicit object_id/type, url defaults to ''.
    expect(body.items[2]).toEqual({
      title: 'Consulting',
      url: '',
      parent: 1,
      object_id: 42,
      type: 'post_type',
    });
    // Deterministic op_id rides the create (§0.8).
    expect(body.op_id).toMatch(OP_ID_PATTERN);
  });

  it('sends a DETERMINISTIC op_id (identical input ⇒ identical id)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createNavMenu.mockResolvedValue(createResp());
    const ctx = makeCtx(wp, registry);

    const args = { name: 'Main', items: [{ title: 'Home', url: '/' }] };
    await navMenusCreateHandler({ ...args, items: [...args.items] }, ctx);
    await navMenusCreateHandler({ ...args, items: [...args.items] }, ctx);

    const a = (wp.createNavMenu.mock.calls[0]?.[0] as { op_id?: string }).op_id;
    const b = (wp.createNavMenu.mock.calls[1]?.[0] as { op_id?: string }).op_id;
    expect(a).toBe(b);
  });

  it('surfaces an idempotent replay informationally (still a success result)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createNavMenu.mockResolvedValue({ ...createResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry);

    const result = await navMenusCreateHandler({ name: 'Main', items: [] }, ctx);
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toMatch(/idempotent replay/i);
  });

  it('renders a NOT_FOUND WpClientError (e.g. bad object_id) as an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'Linked object not found.', {
      meta: { resource: 'post', id: 999 },
    });
    wp.createNavMenu.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await navMenusCreateHandler(
      { name: 'Main', items: [{ title: 'Ghost', object_id: 999, type: 'post_type' }] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect((structured(result) as { code?: string }).code).toBe(ErrorCodes.NOT_FOUND);
  });
});

/* ───────────────────────────── elementor.nav.bind_widget (§1.6 / §6) ────────────────────────── */

describe('navBindWidgetHandler', () => {
  const VALID_HASH = 'a'.repeat(32);
  const NEW_HASH = 'b'.repeat(32);

  function bindResp(): BindNavWidgetResponse {
    return { success: true, base_hash: NEW_HASH };
  }

  function bindArgs(): {
    post_id: number;
    element_id: string;
    term_id: number;
    base_hash: string;
  } {
    return { post_id: 42, element_id: 'abc1234', term_id: 3, base_hash: VALID_HASH };
  }

  it('binds via POST /nav/bind-widget, returns a synthesized modified diff + new base_hash', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindNavWidget.mockResolvedValue(bindResp());
    const ctx = makeCtx(wp, registry, true);

    const result = await navBindWidgetHandler(bindArgs(), ctx);
    const out = structured(result);
    outputValidator(registry, NAV_BIND_WIDGET).parse(out);

    // base_hash echoed (the new optimistic-lock token).
    expect(out.base_hash).toBe(NEW_HASH);
    // The synthesized diff records exactly ONE modified node (settings.menu) — nothing fabricated.
    const diff = out.diff as {
      changes: Array<{ id: string; op: string; changed_paths?: string[] }>;
      changed_ids: string[];
      base_hash_after?: string;
    };
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ id: 'abc1234', op: 'modified' });
    expect(diff.changes[0]?.changed_paths).toEqual(['settings.menu']);
    expect(diff.changed_ids).toEqual(['abc1234']);
    expect(diff.base_hash_after).toBe(NEW_HASH);
  });

  it('REQUIRES base_hash on the wire + sends a deterministic op_id (§0.8)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindNavWidget.mockResolvedValue(bindResp());
    const ctx = makeCtx(wp, registry, true);

    await navBindWidgetHandler(bindArgs(), ctx);
    const body = wp.bindNavWidget.mock.calls[0]?.[0] as {
      post_id: number;
      element_id: string;
      term_id: number;
      base_hash: string;
      op_id?: string;
    };
    expect(body.base_hash).toBe(VALID_HASH);
    expect(body.post_id).toBe(42);
    expect(body.element_id).toBe('abc1234');
    expect(body.term_id).toBe(3);
    expect(body.op_id).toMatch(OP_ID_PATTERN);
  });

  it('GATES on Pro: capabilities.pro=false ⇒ PRO_REQUIRED isError WITHOUT a REST call', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry, false);

    const result = await navBindWidgetHandler(bindArgs(), ctx);
    expect(result.isError).toBe(true);
    expect((structured(result) as { code?: string }).code).toBe(ErrorCodes.PRO_REQUIRED);
    // Short-circuit: never round-tripped to the doomed route.
    expect(wp.bindNavWidget).not.toHaveBeenCalled();
  });

  it('surfaces an idempotent replay informationally (still a success result)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindNavWidget.mockResolvedValue({ ...bindResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry, true);

    const result = await navBindWidgetHandler(bindArgs(), ctx);
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toMatch(/idempotent replay/i);
  });

  it('renders a NOT_FOUND WpClientError (missing post/element/term) as an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'Element not found.', {
      meta: { resource: 'element', id: 'abc1234' },
    });
    wp.bindNavWidget.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry, true);

    const result = await navBindWidgetHandler(bindArgs(), ctx);
    expect(result.isError).toBe(true);
    expect((structured(result) as { code?: string }).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it('THROWS a ProtocolError for a surface:protocol payload (§5.1)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad', {
      surface: 'protocol',
    });
    wp.bindNavWidget.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry, true);

    await expect(navBindWidgetHandler(bindArgs(), ctx)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-client error (server core surfaces it)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindNavWidget.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry, true);

    await expect(navBindWidgetHandler(bindArgs(), ctx)).rejects.toThrow('boom');
  });
});
