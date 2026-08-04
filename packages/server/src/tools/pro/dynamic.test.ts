/**
 * WP-R11 — Pro dynamic-tag handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + a real WP-F04 {@link ToolRegistry}.
 * Asserts:
 *  - both §1.8 handlers attach by EXACT catalog name; they are NON-★; annotations match the catalog;
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`;
 *  - the descriptor `inputSchema` requires `base_hash` on `bind` and accepts §0.6 pagination on `list_tags`;
 *  - `bind` proxies `POST /pro/dynamic/bind`, returns the PHP-authoritative `dynamic_string`, synthesizes
 *    a one-element `modified` diff, sends a deterministic `op_id`, threads `base_hash`, and surfaces a replay;
 *  - `list_tags` proxies `GET /pro/dynamic/tags`, maps `{name,title,group,categories,settings_controls,
 *    available}`, and paginates per §0.6;
 *  - error mapping: a 422 `VALIDATION_FAILED` (`E_DYNAMIC_INCOMPATIBLE`), a 501 `PRO_REQUIRED`, a 404
 *    `NOT_FOUND`, a 409 `CONCURRENCY_STALE_HASH` → isError (never -326xx); a `surface:'protocol'` payload
 *    THROWS a {@link ProtocolError}; a non-client error rethrows (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type BindDynamicResponse,
  type ListDynamicTagsResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../../catalog/registry.js';
import type { ToolContext } from '../../runtime/context.js';
import { WpClientError } from '../../wp/types.js';
import { ProtocolError } from '../../wp/errors.js';
import { OP_ID_PATTERN } from '../../safety/idempotency.js';

import {
  attachDynamicHandlers,
  proDynamicBindHandler,
  proDynamicListTagsHandler,
  PRO_DYNAMIC_TOOL_NAMES,
  PRO_DYNAMIC_BIND,
  PRO_DYNAMIC_LIST_TAGS,
} from './dynamic.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the Pro dynamic routes the handlers call. */
interface MockWp {
  bindDynamic: ReturnType<typeof vi.fn>;
  listDynamicTags: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    bindDynamic: vi.fn(),
    listDynamicTags: vi.fn(),
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

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachDynamicHandlers', () => {
  it('attaches a handler for every §1.8 Pro dynamic tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachDynamicHandlers(registry);

    for (const name of PRO_DYNAMIC_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the two §1.8 Pro dynamic names', () => {
    expect([...PRO_DYNAMIC_TOOL_NAMES].sort()).toEqual(
      [PRO_DYNAMIC_BIND, PRO_DYNAMIC_LIST_TAGS].sort(),
    );
  });

  it('both Pro dynamic tools are NON-★ (Contract 13 §5.2 — registered disabled at boot)', () => {
    const registry = createToolRegistry();
    for (const name of PRO_DYNAMIC_TOOL_NAMES) {
      expect(registry.getDescriptor(name).star).toBe(false);
    }
  });

  it('annotations match the frozen catalog (bind idempotent; list_tags readOnly+idempotent)', () => {
    const registry = createToolRegistry();
    const bind = registry.getDescriptor(PRO_DYNAMIC_BIND).annotations as Record<string, boolean>;
    expect(bind.idempotentHint).toBe(true);
    const list = registry.getDescriptor(PRO_DYNAMIC_LIST_TAGS).annotations as Record<
      string,
      boolean
    >;
    expect(list.readOnlyHint).toBe(true);
    expect(list.idempotentHint).toBe(true);
  });
});

/* ───────────────────────────── inputSchema (frozen §1.8) ────────────────────────────────────── */

describe('elementor.pro.dynamic.bind inputSchema (frozen §1.8)', () => {
  it('requires base_hash (a bind without it fails → -32602 at the SDK layer)', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_DYNAMIC_BIND).safeParse({
      post_id: 42,
      element_id: 'abc1234',
      control: 'title',
      tag: 'post-title',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the minimal valid bind (post_id,element_id,control,tag,base_hash)', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_DYNAMIC_BIND).safeParse({
      post_id: 42,
      element_id: 'abc1234',
      control: 'title',
      tag: 'post-title',
      base_hash: 'h1',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts optional tag_settings (record) and fallback_value (any)', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_DYNAMIC_BIND).safeParse({
      post_id: 42,
      element_id: 'abc1234',
      control: 'title',
      tag: 'acf-text',
      tag_settings: { key: 'field_x:y' },
      fallback_value: 'Static',
      base_hash: 'h1',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('elementor.pro.dynamic.list_tags inputSchema (frozen §0.6)', () => {
  it('accepts empty input (limit defaults)', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_DYNAMIC_LIST_TAGS).safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('accepts {limit,cursor,fields}', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_DYNAMIC_LIST_TAGS).safeParse({
      limit: 5,
      cursor: '5',
      fields: ['name', 'categories'],
    });
    expect(parsed.success).toBe(true);
  });
});

/* ───────────────────────────── elementor.pro.dynamic.bind (§1.8 / §8.7) ─────────────────────── */

describe('proDynamicBindHandler', () => {
  function bindResp(overrides?: Partial<BindDynamicResponse>): BindDynamicResponse {
    return {
      dynamic_string: '[elementor-tag id="z9y8x7w" name="post-title" settings="%7B%7D"]',
      applied: true,
      base_hash: 'h2',
      ...overrides,
    };
  }

  it('proxies POST /pro/dynamic/bind, returns the PHP-authoritative dynamic_string + a valid output', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindDynamic.mockResolvedValue(bindResp());
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicBindHandler(
      {
        post_id: 42,
        element_id: 'abc1234',
        control: 'title',
        tag: 'post-title',
        base_hash: 'h1',
      },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PRO_DYNAMIC_BIND).parse(out);

    expect(wp.bindDynamic).toHaveBeenCalledTimes(1);
    const body = wp.bindDynamic.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.post_id).toBe(42);
    expect(body.element_id).toBe('abc1234');
    expect(body.control).toBe('title');
    expect(body.tag).toBe('post-title');
    expect(body.base_hash).toBe('h1');
    expect(body.tag_settings).toEqual({});
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);

    // The returned dynamic_string is the PHP-authoritative one (NOT a local random preview).
    expect(out.dynamic_string).toBe(
      '[elementor-tag id="z9y8x7w" name="post-title" settings="%7B%7D"]',
    );
    expect(out.applied).toBe(true);
    expect(out.base_hash).toBe('h2');
  });

  it('synthesizes a one-element modified diff naming the bound element + control path', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindDynamic.mockResolvedValue(bindResp());
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicBindHandler(
      { post_id: 42, element_id: 'abc1234', control: 'title', tag: 'post-title', base_hash: 'h1' },
      ctx,
    );
    const diff = structured(result).diff as {
      changes: Array<{ id: string; op: string; changed_paths?: string[] }>;
      changed_ids?: string[];
    };
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]?.id).toBe('abc1234');
    expect(diff.changes[0]?.op).toBe('modified');
    expect(diff.changes[0]?.changed_paths).toEqual(['__dynamic__.title']);
    expect(diff.changed_ids).toEqual(['abc1234']);
  });

  it('forwards tag_settings + fallback_value (string) to the REST body', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindDynamic.mockResolvedValue(bindResp());
    const ctx = makeCtx(wp, registry);

    await proDynamicBindHandler(
      {
        post_id: 42,
        element_id: 'abc1234',
        control: 'title',
        tag: 'acf-text',
        tag_settings: { key: 'field_x:y' },
        fallback_value: 'Static',
        base_hash: 'h1',
      },
      ctx,
    );
    const body = wp.bindDynamic.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.tag_settings).toEqual({ key: 'field_x:y' });
    expect(body.fallback_value).toBe('Static');
  });

  it('an empty (not applied) bind yields an empty diff and validates', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindDynamic.mockResolvedValue(bindResp({ applied: false }));
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicBindHandler(
      { post_id: 42, element_id: 'abc1234', control: 'title', tag: 'post-title', base_hash: 'h1' },
      ctx,
    );
    outputValidator(registry, PRO_DYNAMIC_BIND).parse(structured(result));
    const diff = structured(result).diff as { changes: unknown[] };
    expect(diff.changes).toHaveLength(0);
  });

  it('surfaces an idempotent replay informationally in the text', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindDynamic.mockResolvedValue({ ...bindResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicBindHandler(
      { post_id: 42, element_id: 'abc1234', control: 'title', tag: 'post-title', base_hash: 'h1' },
      ctx,
    );
    expect(firstText(result).toLowerCase()).toContain('replay');
  });

  it('maps a 422 E_DYNAMIC_INCOMPATIBLE → VALIDATION_FAILED isError (never -326xx)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // E_DYNAMIC_INCOMPATIBLE is a PHP marker that maps to the VALIDATION_FAILED taxonomy code
    // (Contract 12 §3); the carried `errors[].code` is the taxonomy code, the marker rides in meta.
    const payload = makeErrorPayload(
      ErrorCodes.VALIDATION_FAILED,
      'Control "title" is not dynamic-capable for tag "post-title".',
      {
        meta: {
          errors: [
            {
              code: ErrorCodes.VALIDATION_FAILED,
              message: 'category mismatch (E_DYNAMIC_INCOMPATIBLE)',
              prop: 'tag',
            },
          ],
        },
      },
    );
    wp.bindDynamic.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicBindHandler(
      { post_id: 42, element_id: 'abc1234', control: 'title', tag: 'post-title', base_hash: 'h1' },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.VALIDATION_FAILED);
  });

  it('maps a 501 PRO_REQUIRED → isError', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.');
    wp.bindDynamic.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicBindHandler(
      { post_id: 42, element_id: 'abc1234', control: 'title', tag: 'acf-text', base_hash: 'h1' },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });

  it('maps a 404 NOT_FOUND → isError', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'Element not found.');
    wp.bindDynamic.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicBindHandler(
      { post_id: 42, element_id: 'nope', control: 'title', tag: 'post-title', base_hash: 'h1' },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it('maps a 409 CONCURRENCY_STALE_HASH → isError', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.CONCURRENCY_STALE_HASH, 'Stale base_hash.');
    wp.bindDynamic.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicBindHandler(
      { post_id: 42, element_id: 'abc1234', control: 'title', tag: 'post-title', base_hash: 'old' },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.CONCURRENCY_STALE_HASH);
  });

  it('THROWS a ProtocolError for a surface:protocol payload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params');
    wp.bindDynamic.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    await expect(
      proDynamicBindHandler(
        {
          post_id: 42,
          element_id: 'abc1234',
          control: 'title',
          tag: 'post-title',
          base_hash: 'h1',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-WpClientError (server core surfaces it)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.bindDynamic.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(
      proDynamicBindHandler(
        {
          post_id: 42,
          element_id: 'abc1234',
          control: 'title',
          tag: 'post-title',
          base_hash: 'h1',
        },
        ctx,
      ),
    ).rejects.toThrow('boom');
  });
});

/* ───────────────────────────── elementor.pro.dynamic.list_tags (§1.8 / §8.7) ────────────────── */

describe('proDynamicListTagsHandler', () => {
  function tagsResp(): ListDynamicTagsResponse {
    // The live route returns settings_controls + available; the shared type narrows them away — the
    // handler widens the read. We supply the full shape here (cast through the shared type).
    return {
      items: [
        {
          name: 'post-title',
          title: 'Post Title',
          group: 'post',
          categories: ['text'],
          settings_controls: [],
          available: true,
        },
        {
          name: 'acf-text',
          title: 'ACF Field',
          group: 'post',
          categories: ['text'],
          settings_controls: ['key'],
          available: false,
        },
        {
          name: 'post-featured-image',
          title: 'Featured Image',
          group: 'media',
          categories: ['image', 'media'],
          settings_controls: ['fallback'],
          available: true,
        },
      ],
    } as unknown as ListDynamicTagsResponse;
  }

  it('proxies GET /pro/dynamic/tags, maps the §1.8 item shape, validates against the descriptor', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listDynamicTags.mockResolvedValue(tagsResp());
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicListTagsHandler({ limit: 50 }, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_DYNAMIC_LIST_TAGS).parse(out);

    const items = out.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      name: 'post-title',
      title: 'Post Title',
      group: 'post',
      categories: ['text'],
      settings_controls: [],
      available: true,
    });
    expect(items[1]?.available).toBe(false);
    expect(items[1]?.settings_controls).toEqual(['key']);
    expect(out.total).toBe(3);
    expect(out.next_cursor).toBeNull();
  });

  it('paginates per §0.6 (limit + opaque numeric cursor)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listDynamicTags.mockResolvedValue(tagsResp());
    const ctx = makeCtx(wp, registry);

    const page1 = await proDynamicListTagsHandler({ limit: 2 }, ctx);
    const out1 = structured(page1);
    outputValidator(registry, PRO_DYNAMIC_LIST_TAGS).parse(out1);
    expect((out1.items as unknown[]).length).toBe(2);
    expect(out1.next_cursor).toBe('2');
    expect(out1.total).toBe(3);

    const page2 = await proDynamicListTagsHandler({ limit: 2, cursor: '2' }, ctx);
    const out2 = structured(page2);
    expect((out2.items as unknown[]).length).toBe(1);
    expect(out2.next_cursor).toBeNull();
  });

  it('defaults settings_controls→[] and available→false when a row omits them', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listDynamicTags.mockResolvedValue({
      items: [{ name: 'post-url', title: 'Post URL', group: 'post', categories: ['url'] }],
    });
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicListTagsHandler({ limit: 50 }, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_DYNAMIC_LIST_TAGS).parse(out);
    const item = (out.items as Array<Record<string, unknown>>)[0];
    expect(item?.settings_controls).toEqual([]);
    expect(item?.available).toBe(false);
  });

  it('maps a 501 PRO_REQUIRED → isError (never -326xx)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.');
    wp.listDynamicTags.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proDynamicListTagsHandler({ limit: 50 }, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });
});
