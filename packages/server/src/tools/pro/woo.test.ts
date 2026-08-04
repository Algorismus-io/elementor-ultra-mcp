/**
 * WP-R12 — Pro WooCommerce handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + a real WP-F04 {@link ToolRegistry}.
 * The tests assert:
 *  - the §1.8 handler attaches by EXACT catalog name; it is NON-★; annotations match the catalog (none);
 *  - the descriptor `inputSchema` requires `base_hash` and accepts a free-string `widget`;
 *  - the handler proxies `POST /pro/woo/add-widget`, shapes `{element,diff,context_ok,context_warning?,
 *    base_hash}` (synthesizing the single-`added` diff from the returned element), sends a deterministic
 *    `op_id`, validates `structuredContent` against the descriptor `outputSchema`;
 *  - `context_ok:false` surfaces `context_warning` PROMINENTLY in the text AND structured content;
 *  - a `wc-add-to-cart` WITHOUT `product_id` short-circuits to a `VALIDATION_FAILED` isError BEFORE any
 *    REST call;
 *  - a 422 `WOO_CONTEXT_INVALID` {@link WpClientError} renders an isError carrying `{widget,
 *    required_context,actual_doc_type}` meta (never a -326xx);
 *  - a 501 `PRO_REQUIRED` / `EXPERIMENT_INACTIVE` (graceful woo-not-active) renders an isError CLEANLY
 *    (never a crash); a 409 `CONCURRENCY_STALE_HASH` and a 404 `NOT_FOUND` render isError;
 *  - a non-client error rethrows (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type AddWooWidgetResponse,
  type ElementNode,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../../catalog/registry.js';
import type { ToolContext } from '../../runtime/context.js';
import { WpClientError } from '../../wp/types.js';
import { OP_ID_PATTERN } from '../../safety/idempotency.js';

import {
  attachWooHandlers,
  proWooAddWidgetHandler,
  elementToAddedDiff,
  PRO_WOO_TOOL_NAMES,
  PRO_WOO_ADD_WIDGET,
  WC_ADD_TO_CART_WIDGET,
} from './woo.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the Pro Woo route the handler calls. */
interface MockWp {
  addWooWidget: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires the route it needs). */
function makeWp(): MockWp {
  return { addWooWidget: vi.fn() };
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

/** A minimal valid Woo widget node (passes `elementNodeSchema`). */
function wooWidgetNode(widgetType = 'woocommerce-cart', id = 'abcd123'): ElementNode {
  return {
    id,
    elType: 'widget',
    widgetType,
    settings: { classes: { $$type: 'classes', value: [] } },
  };
}

/** A minimal Woo add-widget REST response. */
function addResp(overrides?: Partial<AddWooWidgetResponse>): AddWooWidgetResponse {
  return {
    element: wooWidgetNode(),
    context_ok: true,
    context_warning: null,
    base_hash: 'newhash00000000000000000000000000',
    ...overrides,
  };
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachWooHandlers', () => {
  it('attaches a handler for every §1.8 Pro Woo tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachWooHandlers(registry);

    for (const name of PRO_WOO_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the one §1.8 Pro Woo name', () => {
    expect([...PRO_WOO_TOOL_NAMES]).toEqual([PRO_WOO_ADD_WIDGET]);
    expect(PRO_WOO_ADD_WIDGET).toBe('elementor.pro.woo.add_widget');
  });

  it('the Pro Woo tool is NON-★ (Contract 13 §5.2 — registered disabled at boot)', () => {
    const registry = createToolRegistry();
    expect(registry.getDescriptor(PRO_WOO_ADD_WIDGET).star).toBe(false);
  });

  it('annotations match the frozen catalog (none)', () => {
    const registry = createToolRegistry();
    expect(registry.getDescriptor(PRO_WOO_ADD_WIDGET).annotations).toEqual({});
  });
});

/* ───────────────────────────── inputSchema: base_hash required + free widget (§1.8) ─────────── */

describe('elementor.pro.woo.add_widget inputSchema (frozen §1.8)', () => {
  it('requires base_hash (a write without it → -32602 at the SDK layer)', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_WOO_ADD_WIDGET).safeParse({
      post_id: 42,
      container_id: 'abc1234',
      widget: 'woocommerce-cart',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a free-string widget + the four required fields', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_WOO_ADD_WIDGET);
    for (const widget of [
      'woocommerce-cart',
      'woocommerce-product-title',
      'wc-add-to-cart',
      'wc-archive-products',
    ]) {
      expect(
        v.safeParse({
          post_id: 42,
          container_id: 'abc1234',
          widget,
          base_hash: 'h'.repeat(32),
        }).success,
      ).toBe(true);
    }
  });

  it('rejects a non-integer post_id (→ -32602)', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_WOO_ADD_WIDGET);
    expect(
      v.safeParse({
        post_id: 4.2,
        container_id: 'abc1234',
        widget: 'woocommerce-cart',
        base_hash: 'h'.repeat(32),
      }).success,
    ).toBe(false);
  });
});

/* ───────────────────────────── elementToAddedDiff (diff synthesis §8.8) ─────────────────────── */

describe('elementToAddedDiff', () => {
  it('synthesizes a single-`added` diff from the returned widget node', () => {
    const diff = elementToAddedDiff(wooWidgetNode('woocommerce-cart', 'wid7777'));
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]?.id).toBe('wid7777');
    expect(diff.changes[0]?.op).toBe('added');
    expect(diff.changes[0]?.widgetType).toBe('woocommerce-cart');
    expect(diff.new_ids).toEqual(['wid7777']);
    expect(diff.changed_ids).toEqual([]);
    expect(diff.removed_ids).toEqual([]);
  });
});

/* ───────────────────────────── proWooAddWidgetHandler (§1.8 / §8.8) ─────────────────────────── */

describe('proWooAddWidgetHandler', () => {
  it('proxies POST /pro/woo/add-widget, shapes the §1.8 output, sends a valid op_id, validates against the descriptor', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.addWooWidget.mockResolvedValue(addResp());
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: 'woocommerce-cart',
        base_hash: 'oldhash00000000000000000000000000',
      },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PRO_WOO_ADD_WIDGET).parse(out);

    expect(wp.addWooWidget).toHaveBeenCalledTimes(1);
    const body = wp.addWooWidget.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.post_id).toBe(42);
    expect(body.container_id).toBe('abc1234');
    expect(body.widget).toBe('woocommerce-cart');
    expect(body.base_hash).toBe('oldhash00000000000000000000000000');
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);

    expect(out.context_ok).toBe(true);
    expect(out.base_hash).toBe('newhash00000000000000000000000000');
    expect(out.element).toEqual(addResp().element);
    // A clean placement omits context_warning from the structured content.
    expect(out.context_warning).toBeUndefined();
    expect(firstText(result)).toContain('woocommerce-cart');
  });

  it('omits product_id + settings from the body when not supplied', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.addWooWidget.mockResolvedValue(addResp());
    const ctx = makeCtx(wp, registry);

    await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: 'woocommerce-cart',
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    const body = wp.addWooWidget.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('product_id' in body).toBe(false);
    expect('settings' in body).toBe(false);
  });

  it('passes product_id + settings through when supplied (wc-add-to-cart)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.addWooWidget.mockResolvedValue(
      addResp({ element: wooWidgetNode('wc-add-to-cart', 'cart999') }),
    );
    const ctx = makeCtx(wp, registry);

    await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: WC_ADD_TO_CART_WIDGET,
        product_id: 17,
        settings: { show: 'yes' },
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    const body = wp.addWooWidget.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.product_id).toBe(17);
    expect(body.settings).toEqual({ show: 'yes' });
  });

  it('short-circuits wc-add-to-cart WITHOUT product_id to a VALIDATION_FAILED isError BEFORE any REST call', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: WC_ADD_TO_CART_WIDGET,
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(firstText(result)).toContain('product_id');
    // The cheap guard must NOT hit the REST layer.
    expect(wp.addWooWidget).not.toHaveBeenCalled();
  });

  it('surfaces context_warning PROMINENTLY in the text AND structured content when context_ok:false', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.addWooWidget.mockResolvedValue(
      addResp({
        element: wooWidgetNode('woocommerce-product-title', 'pt55555'),
        context_ok: false,
        context_warning:
          "woocommerce-product-title requires a Single-Product template; placed on actual_doc_type='wp-page'",
      }),
    );
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: 'woocommerce-product-title',
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PRO_WOO_ADD_WIDGET).parse(out);

    expect(out.context_ok).toBe(false);
    expect(out.context_warning).toContain('Single-Product');
    expect(firstText(result)).toContain('WARNING');
    expect(firstText(result)).toContain('Single-Product');
  });

  it('surfaces an idempotent replay informationally in the text', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.addWooWidget.mockResolvedValue({ ...addResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: 'woocommerce-cart',
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    expect(firstText(result).toLowerCase()).toContain('replay');
  });

  it('maps a 422 WOO_CONTEXT_INVALID WpClientError to an isError carrying {widget,required_context,actual_doc_type}', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(
      ErrorCodes.WOO_CONTEXT_INVALID,
      'woocommerce-product-title requires a Single-Product template.',
      {
        meta: {
          widget: 'woocommerce-product-title',
          required_context: 'woocommerce-elements-single',
          actual_doc_type: 'wp-page',
        },
      },
    );
    wp.addWooWidget.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: 'woocommerce-product-title',
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    const out = structured(result);
    expect(out.code).toBe(ErrorCodes.WOO_CONTEXT_INVALID);
    const meta = out.meta as Record<string, unknown>;
    expect(meta.widget).toBe('woocommerce-product-title');
    expect(meta.required_context).toBe('woocommerce-elements-single');
    expect(meta.actual_doc_type).toBe('wp-page');
  });

  it('maps a 501 PRO_REQUIRED WpClientError (Pro inactive) to an isError result (never a crash / -326xx)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.', {
      meta: { feature: 'woocommerce' },
    });
    wp.addWooWidget.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: 'woocommerce-cart',
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });

  it('maps a 501 EXPERIMENT_INACTIVE WpClientError (graceful woo-not-active) to an isError result cleanly', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.EXPERIMENT_INACTIVE, 'WooCommerce is not active.', {
      meta: { required_for: 'woocommerce' },
    });
    wp.addWooWidget.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: 'woocommerce-cart',
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.EXPERIMENT_INACTIVE);
    // Surfaced as a clear result line, not a thrown crash.
    expect(firstText(result).toLowerCase()).toContain('woocommerce');
  });

  it('maps a 409 CONCURRENCY_STALE_HASH WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.CONCURRENCY_STALE_HASH, 'Stale base_hash.');
    wp.addWooWidget.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 42,
        container_id: 'abc1234',
        widget: 'woocommerce-cart',
        base_hash: 'stale00000000000000000000000000ab',
      },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.CONCURRENCY_STALE_HASH);
  });

  it('maps a 404 NOT_FOUND WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'Post not found.', {
      meta: { resource: 'post', id: 9999 },
    });
    wp.addWooWidget.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proWooAddWidgetHandler(
      {
        post_id: 9999,
        container_id: 'abc1234',
        widget: 'woocommerce-cart',
        base_hash: 'h'.repeat(32),
      },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.NOT_FOUND);
  });

  it('rethrows a non-WpClientError (server core surfaces it)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.addWooWidget.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(
      proWooAddWidgetHandler(
        {
          post_id: 42,
          container_id: 'abc1234',
          widget: 'woocommerce-cart',
          base_hash: 'h'.repeat(32),
        },
        ctx,
      ),
    ).rejects.toThrow('boom');
  });
});
