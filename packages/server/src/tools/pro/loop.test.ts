/**
 * WP-R10 — Pro Loop Builder handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + a real WP-F04 {@link ToolRegistry}.
 * The tests assert:
 *  - both §1.8 handlers attach by EXACT catalog name; they are NON-★; annotations match the catalog;
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`;
 *  - the descriptor `inputSchema` rejects a `skin`/`widget` outside the enum and a malformed `query`,
 *    and accepts the 4 valid skins + 2 valid widgets; `base_hash` is REQUIRED on `bind_grid` and
 *    ABSENT from `create_item`;
 *  - `create_item` proxies `POST /pro/loop/item`, shapes `{template_id,edit_url}`, sends a deterministic
 *    `op_id`, and surfaces an idempotent replay informationally;
 *  - `bind_grid` proxies `POST /pro/loop/bind-grid` sending the ERGONOMIC (UNPREFIXED) query keys,
 *    `posts_per_page` top-level, `template_id`/`columns` as strings, `base_hash`, and shapes
 *    `{element,diff,base_hash}` (synthesizing the §1.8 `diff` the REST `{element,applied,base_hash}` omits);
 *  - a non-loop-item `template_id` (`ATOMIC_SETTINGS_INVALID` + `meta.rest_code=E_LOOP_TEMPLATE_INVALID`)
 *    is re-emitted as a `VALIDATION_FAILED` isError with text steering to `elementor.pro.loop.create_item`
 *    (preserving `actual_type` meta);
 *  - a `surface:'isError'` {@link WpClientError} (501 `PRO_REQUIRED`, 409 `CONCURRENCY_STALE_HASH`, 404
 *    `NOT_FOUND`) renders an isError taxonomy result (never a -326xx); a `surface:'protocol'` payload
 *    THROWS a {@link ProtocolError}; a non-client error rethrows (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type CreateLoopItemResponse,
  type BindLoopGridResponse,
  type ElementNode,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../../catalog/registry.js';
import type { ToolContext } from '../../runtime/context.js';
import { WpClientError } from '../../wp/types.js';
import { ProtocolError } from '../../wp/errors.js';
import { OP_ID_PATTERN } from '../../safety/idempotency.js';

import {
  attachLoopHandlers,
  proLoopCreateItemHandler,
  proLoopBindGridHandler,
  PRO_LOOP_TOOL_NAMES,
  PRO_LOOP_CREATE_ITEM,
  PRO_LOOP_BIND_GRID,
  REST_CODE_LOOP_TEMPLATE_INVALID,
} from './loop.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the Pro loop routes the handlers call. */
interface MockWp {
  createLoopItem: ReturnType<typeof vi.fn>;
  bindLoopGrid: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    createLoopItem: vi.fn(),
    bindLoopGrid: vi.fn(),
  };
}

/** Build a minimal {@link ToolContext} carrying the mock `wp` + a registry (caps/surface inert here). */
function makeCtx(wp: MockWp, registry: ToolRegistry): ToolContext {
  return {
    wp,
    registry,
    surface: {} as ToolContext['surface'],
    capabilities: {
      get: vi.fn(() => Promise.resolve({})),
    } as unknown as ToolContext['capabilities'],
    elicit: (() => Promise.resolve({ confirmed: false })) as unknown as ToolContext['elicit'],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolContext;
}

/** The WP-F04 descriptor `outputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function outputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).outputSchema);
}

/** The WP-F04 descriptor `inputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function inputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).inputSchema);
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

/** Whether a result is an isError tool result (12-error-taxonomy.md §5.2). */
function isErrorResult(result: { isError?: unknown }): boolean {
  return result.isError === true;
}

/** A minimal valid loop-grid widget {@link ElementNode} (the bound widget the REST route returns). */
function widgetElement(): ElementNode {
  return {
    id: 'lg00001',
    elType: 'widget',
    widgetType: 'loop-grid',
    settings: {},
    elements: [],
  };
}

/** A minimal valid `bind_grid` args object (the SDK-validated input shape). */
function bindArgs(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    container_id: 'c0000001',
    post_id: 42,
    widget: 'loop-grid',
    template_id: 140,
    skin: 'post',
    posts_per_page: 6,
    query: { post_type: 'post' },
    base_hash: 'abc123',
    ...overrides,
  };
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachLoopHandlers', () => {
  it('attaches a handler for every §1.8 Pro loop tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachLoopHandlers(registry);

    for (const name of PRO_LOOP_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the two §1.8 Pro loop names', () => {
    expect([...PRO_LOOP_TOOL_NAMES].sort()).toEqual(
      [PRO_LOOP_CREATE_ITEM, PRO_LOOP_BIND_GRID].sort(),
    );
  });

  it('both Pro loop tools are NON-★ (Contract 13 §5.2 — registered disabled at boot)', () => {
    const registry = createToolRegistry();
    for (const name of PRO_LOOP_TOOL_NAMES) {
      expect(registry.getDescriptor(name).star).toBe(false);
    }
  });

  it('annotations match the frozen catalog (both: none)', () => {
    const registry = createToolRegistry();
    expect(registry.getDescriptor(PRO_LOOP_CREATE_ITEM).annotations).toEqual({});
    expect(registry.getDescriptor(PRO_LOOP_BIND_GRID).annotations).toEqual({});
  });
});

/* ───────────────────────────── inputSchema: enums + base_hash (§1.8) ────────────────────────── */

describe('elementor.pro.loop.bind_grid inputSchema (frozen §1.8)', () => {
  it('requires base_hash on bind_grid', () => {
    const registry = createToolRegistry();
    const args = bindArgs();
    delete args.base_hash;
    expect(inputValidator(registry, PRO_LOOP_BIND_GRID).safeParse(args).success).toBe(false);
  });

  it('create_item has NO base_hash key in its inputSchema', () => {
    const registry = createToolRegistry();
    expect(registry.getDescriptor(PRO_LOOP_CREATE_ITEM).inputSchema).not.toHaveProperty(
      'base_hash',
    );
  });

  it('accepts each of the 4 valid skins', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_LOOP_BIND_GRID);
    for (const skin of ['post', 'post_taxonomy', 'product', 'product_taxonomy']) {
      expect(v.safeParse(bindArgs({ skin })).success).toBe(true);
    }
  });

  it('rejects a skin outside the 4-enum (→ -32602 at the SDK layer)', () => {
    const registry = createToolRegistry();
    expect(
      inputValidator(registry, PRO_LOOP_BIND_GRID).safeParse(bindArgs({ skin: 'page' })).success,
    ).toBe(false);
  });

  it('accepts both valid widgets and rejects an unknown widget', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_LOOP_BIND_GRID);
    expect(v.safeParse(bindArgs({ widget: 'loop-grid' })).success).toBe(true);
    expect(v.safeParse(bindArgs({ widget: 'loop-carousel' })).success).toBe(true);
    expect(v.safeParse(bindArgs({ widget: 'loop-table' })).success).toBe(false);
  });

  it('rejects a query missing the required post_type', () => {
    const registry = createToolRegistry();
    expect(
      inputValidator(registry, PRO_LOOP_BIND_GRID).safeParse(
        bindArgs({ query: { orderby: 'date' } }),
      ).success,
    ).toBe(false);
  });

  it('applies defaults: widget=loop-grid, skin=post, posts_per_page=6', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_LOOP_BIND_GRID).parse({
      container_id: 'c0000001',
      post_id: 42,
      template_id: 140,
      query: { post_type: 'post' },
      base_hash: 'abc123',
    });
    expect(parsed.widget).toBe('loop-grid');
    expect(parsed.skin).toBe('post');
    expect(parsed.posts_per_page).toBe(6);
  });
});

/* ───────────────────────────── elementor.pro.loop.create_item (§1.8 / §8.6) ─────────────────── */

describe('proLoopCreateItemHandler', () => {
  function createResp(overrides?: Partial<CreateLoopItemResponse>): CreateLoopItemResponse {
    return {
      template_id: 140,
      edit_url: 'http://localhost:8899/wp-admin/post.php?post=140&action=elementor',
      ...overrides,
    };
  }

  it('proxies POST /pro/loop/item, shapes {template_id,edit_url}, sends a valid op_id, validates against the descriptor', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createLoopItem.mockResolvedValue(createResp());
    const ctx = makeCtx(wp, registry);

    const result = await proLoopCreateItemHandler({ title: 'Card' }, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_LOOP_CREATE_ITEM).parse(out);

    expect(wp.createLoopItem).toHaveBeenCalledTimes(1);
    const body = wp.createLoopItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.title).toBe('Card');
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);

    expect(out).toEqual({
      template_id: 140,
      edit_url: createResp().edit_url,
    });
    // Steers the agent to bind_grid next.
    expect(firstText(result)).toContain(PRO_LOOP_BIND_GRID);
  });

  it('passes optional elements through to the body', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createLoopItem.mockResolvedValue(createResp());
    const ctx = makeCtx(wp, registry);

    const elements = [widgetElement()];
    await proLoopCreateItemHandler({ title: 'Card', elements }, ctx);
    const body = wp.createLoopItem.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.elements).toEqual(elements);
  });

  it('surfaces an idempotent replay informationally in the text', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createLoopItem.mockResolvedValue({ ...createResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry);

    const result = await proLoopCreateItemHandler({ title: 'Card' }, ctx);
    expect(firstText(result).toLowerCase()).toContain('replay');
  });

  it('maps a 501 PRO_REQUIRED WpClientError to an isError result (never a -326xx)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.', {
      meta: { feature: 'loop-builder' },
    });
    wp.createLoopItem.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proLoopCreateItemHandler({ title: 'Card' }, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });

  it('rethrows a non-WpClientError (server core surfaces it)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createLoopItem.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(proLoopCreateItemHandler({ title: 'Card' }, ctx)).rejects.toThrow('boom');
  });
});

/* ───────────────────────────── elementor.pro.loop.bind_grid (§1.8 / §8.6) ───────────────────── */

describe('proLoopBindGridHandler', () => {
  function bindResp(overrides?: Partial<BindLoopGridResponse>): BindLoopGridResponse {
    return {
      element: widgetElement(),
      applied: true,
      base_hash: 'def456',
      ...overrides,
    };
  }

  /** The SDK-validated args the handler receives (defaults already applied). */
  function args(overrides?: Record<string, unknown>): Parameters<typeof proLoopBindGridHandler>[0] {
    return bindArgs(overrides) as unknown as Parameters<typeof proLoopBindGridHandler>[0];
  }

  it('proxies POST /pro/loop/bind-grid and shapes {element,diff,base_hash} (synthesizes the diff)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindLoopGrid.mockResolvedValue(bindResp());
    const ctx = makeCtx(wp, registry);

    const result = await proLoopBindGridHandler(args(), ctx);
    const out = structured(result);
    // The §1.8 outputSchema requires {element,diff,base_hash} — the synthesized diff must validate.
    outputValidator(registry, PRO_LOOP_BIND_GRID).parse(out);

    expect(out.base_hash).toBe('def456');
    expect((out.element as ElementNode).id).toBe('lg00001');
    const diff = out.diff as { changes: Array<Record<string, unknown>> };
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]?.id).toBe('lg00001');
    expect(diff.changes[0]?.op).toBe('modified');
  });

  it('sends ERGONOMIC (unprefixed) query keys, posts_per_page top-level, template_id/columns as strings, base_hash, and a valid op_id', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindLoopGrid.mockResolvedValue(bindResp());
    const ctx = makeCtx(wp, registry);

    await proLoopBindGridHandler(
      args({
        columns: 3,
        posts_per_page: 9,
        query: {
          post_type: 'portfolio',
          orderby: 'menu_order',
          order: 'asc',
          include_term_ids: ['7'],
          query_id: 'my_loop',
        },
      }),
      ctx,
    );

    const body = wp.bindLoopGrid.mock.calls[0]?.[0] as Record<string, unknown>;
    // template_id + columns travel as STRINGS (the §8.6 wire form).
    expect(body.template_id).toBe('140');
    expect(body.columns).toBe('3');
    // posts_per_page is TOP-LEVEL (not in the query group).
    expect(body.posts_per_page).toBe(9);
    // query keys are ERGONOMIC — NOT pre-prefixed with `post_query_` (PHP owns the prefix).
    const query = body.query as Record<string, unknown>;
    expect(query.post_type).toBe('portfolio');
    expect(query.orderby).toBe('menu_order');
    expect(query.order).toBe('asc');
    expect(query.include_term_ids).toEqual(['7']);
    expect(query.query_id).toBe('my_loop');
    // No `{skin}_query_`-prefixed key leaked into the body or the query group.
    expect(Object.keys(query).some((k) => k.includes('_query_'))).toBe(false);
    expect(Object.keys(body).some((k) => k.includes('_query_'))).toBe(false);
    // posts_per_page must NOT appear inside the query group (§A.4 gotcha).
    expect(query).not.toHaveProperty('posts_per_page');
    // base_hash forwarded; op_id valid.
    expect(body.base_hash).toBe('abc123');
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);
  });

  it('omits columns from the body when not provided', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindLoopGrid.mockResolvedValue(bindResp());
    const ctx = makeCtx(wp, registry);

    await proLoopBindGridHandler(args(), ctx);
    const body = wp.bindLoopGrid.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('columns');
  });

  it('re-emits a non-loop-item template_id as VALIDATION_FAILED with text steering to create_item (preserving actual_type meta)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // The live PHP route returns ATOMIC_SETTINGS_INVALID (422) + meta.rest_code=E_LOOP_TEMPLATE_INVALID.
    const payload = makeErrorPayload(
      ErrorCodes.ATOMIC_SETTINGS_INVALID,
      'template_id must reference a loop-item template; a non-loop-item template renders nothing.',
      {
        http_status: 422,
        // The client casts the raw envelope `data.meta` to `never` (wp/client.ts) — the meta is OPEN at
        // runtime; cast here to mirror the live payload (arbitrary loop-template keys).
        meta: {
          template_id: '140',
          actual_type: 'wp-page',
          expected_type: 'loop-item',
          rest_code: REST_CODE_LOOP_TEMPLATE_INVALID,
        } as never,
      },
    );
    wp.bindLoopGrid.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proLoopBindGridHandler(args(), ctx);
    expect(isErrorResult(result)).toBe(true);
    // Re-mapped to the FROZEN surface code (§1.8 / §Detailed Requirements 5).
    expect(structured(result).code).toBe(ErrorCodes.VALIDATION_FAILED);
    // Actionable text steering to create_item.
    expect(firstText(result)).toContain(PRO_LOOP_CREATE_ITEM);
    expect(firstText(result).toLowerCase()).toContain('loop-item');
    // The PHP meta survives the remap (actual_type preserved).
    const meta = structured(result).meta as Record<string, unknown>;
    expect(meta.actual_type).toBe('wp-page');
    expect(meta.rest_code).toBe(REST_CODE_LOOP_TEMPLATE_INVALID);
  });

  it('maps a 501 PRO_REQUIRED WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.');
    wp.bindLoopGrid.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proLoopBindGridHandler(args(), ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });

  it('maps a stale base_hash 409 to a CONCURRENCY_STALE_HASH isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(
      ErrorCodes.CONCURRENCY_STALE_HASH,
      'base_hash is stale; re-read the document.',
      { http_status: 409, meta: { current_base_hash: 'live999' } as never },
    );
    wp.bindLoopGrid.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proLoopBindGridHandler(args(), ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.CONCURRENCY_STALE_HASH);
  });

  it('maps a 404 NOT_FOUND WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'Container element not found.', {
      http_status: 404,
    });
    wp.bindLoopGrid.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proLoopBindGridHandler(args(), ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it('THROWS a ProtocolError for a surface:protocol payload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params');
    wp.bindLoopGrid.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    await expect(proLoopBindGridHandler(args(), ctx)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-WpClientError (server core surfaces it)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindLoopGrid.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(proLoopBindGridHandler(args(), ctx)).rejects.toThrow('boom');
  });
});
