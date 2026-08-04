/**
 * WP-R12 — Pro WooCommerce tool HANDLER (Contract 13 §1.8; SUPPLEMENT.md §A.5/§A.7).
 *
 * Implements the single Pro WooCommerce tool and attaches its handler to the WP-F04 {@link ToolRegistry}
 * by EXACT catalog name (13-tool-catalog.md §1.8). This WP does NOT define schemas (WP-F04 owns the
 * descriptor `catalog/schemas/pro.ts`) — the handler is a {@link ToolHandler} (WP-T01 `runtime/context.ts`)
 * attached via `registry.attachHandler(name, fn)`; the SDK has already validated `args` against the
 * descriptor's `inputSchema` (incl. `base_hash` required) before the handler runs (Contract 13 §0.1) and
 * validates the returned `structuredContent` against `outputSchema` after.
 *
 * The handler is a THIN proxy over the WP-F02 bound facade (`ctx.wp.addWooWidget`): validate-by-SDK →
 * cheap `wc-add-to-cart`-needs-`product_id` client guard → `ctx.wp.addWooWidget(body)` → map the RAW
 * REST `data` into the descriptor's `outputSchema` shape → return `{ content, structuredContent }`. ALL
 * classification + context validation lives in the PHP `Woo_Context_Validator` (WP-R06, Contract 15 §4.7)
 * — this handler adds NO classification logic; it SURFACES the PHP verdict (`context_ok`/`context_warning`).
 *
 * Tool handled here (Contract 13 §1.8 — NON-★, registered disabled at boot, enabled via `tools.search`):
 *  - `elementor.pro.woo.add_widget` (M, Side BOTH, `POST /pro/woo/add-widget`) — add a context-validated
 *    WooCommerce widget. PHP classifies by `get_categories()`: single-product widgets need a Single-Product
 *    template, archive widgets need a Shop/Archive template, context-free widgets (cart/checkout/my-account/
 *    menu-cart) go anywhere, and `wc-add-to-cart` takes a `product_id` and is placeable anywhere.
 *
 * DIFF SHAPE: the `POST /pro/woo/add-widget` route returns `{element,context_ok,context_warning,base_hash}`
 * (10-rest-api.md §8.8) — it does NOT ship a `diff`, but the catalog `outputSchema` requires `diff: Diff`
 * (Contract 11 §1, `diff.schema.json`). The op adds exactly ONE widget node, so {@link elementToAddedDiff}
 * synthesizes a single-`added` {@link Diff} from `element.id` (faithful — one node added, nothing else) and
 * {@link presentDiff} validates it against the frozen schema before it reaches the agent.
 *
 * Error mapping (Contract 13 §0.9, Contract 12 §3): a context mismatch is a 422
 * `E_WOO_CONTEXT_INVALID` → mapped (via `wp/client.ts`) to a {@link WpClientError} carrying
 * `WOO_CONTEXT_INVALID` + `{widget,required_context,actual_doc_type}` meta → `isError` (§5.2). Pro/Woo
 * inactive → `PRO_REQUIRED` / `EXPERIMENT_INACTIVE` 501 → `isError` (the graceful woo-not-active surfaces
 * as a CLEAR result, never a crash). A stale `base_hash` 409 → `CONCURRENCY_STALE_HASH`; a 404 →
 * `NOT_FOUND`. The `wc-add-to-cart`-without-`product_id` guard short-circuits to a `VALIDATION_FAILED`
 * `isError` BEFORE a doomed REST round-trip. Tool-arg failures (a non-string `widget`, a missing
 * `base_hash`) are `-32602` from the SDK's zod layer before the handler runs.
 *
 * Contract authority: 13-tool-catalog.md §1.8 (per-tool I/O), §0.9 (error semantics); 10-rest-api.md
 * §8.8 (REST classification + context validation); 12-error-taxonomy.md §3.4 (`WOO_CONTEXT_INVALID`,
 * `PRO_REQUIRED`), §5 (surface rules); SUPPLEMENT.md §A.5 (widget×context table), §A.7 (tool contract);
 * 15 §4.7 (business logic in PHP).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  makeErrorPayload,
  type AddWooWidgetRequest,
  type AddWooWidgetResponse,
  type ElementNode,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../../runtime/context.js';
import type { ToolRegistry } from '../../catalog/registry.js';
import type { Diff } from '../../authoring/contract.js';
import { WpClientError } from '../../wp/types.js';
import { fromClientError, toToolErrorResult, type ToolResult } from '../../wp/errors.js';
import { presentDiff } from '../../safety/diff.js';
import { mintOpId, isReplay } from '../../safety/idempotency.js';

/* ───────────────────────────── frozen tool name (Contract 13 §1.8) ───────────────────────────── */

/** The Pro WooCommerce tool name this WP attaches (EXACT catalog name — 13-tool-catalog.md §1.8). */
export const PRO_WOO_ADD_WIDGET = 'elementor.pro.woo.add_widget';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const PRO_WOO_TOOL_NAMES = [PRO_WOO_ADD_WIDGET] as const;

/** The Woo widget that takes an explicit `product_id` and is placeable anywhere (SUPPLEMENT.md §A.5). */
export const WC_ADD_TO_CART_WIDGET = 'wc-add-to-cart';

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
 * Run the thin Pro Woo handler: invoke `fn` and, on a {@link WpClientError} (a 422
 * `WOO_CONTEXT_INVALID`, a 501 `PRO_REQUIRED` / `EXPERIMENT_INACTIVE` woo-not-active, a 409
 * `CONCURRENCY_STALE_HASH`, a 404 `NOT_FOUND`, a 403 `CAPABILITY_MISSING`), route it through WP-F05's
 * surface rules (`fromClientError` → protocol-throw or `isError` result, 12-error-taxonomy.md §5) — so a
 * graceful woo-not-active arrives as a CLEAR isError result, never a crash. Non-client errors rethrow
 * (the server core surfaces them). The {@link ToolResult} is structurally a {@link CallToolResult}.
 */
async function runProWoo(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── diff synthesis (REST element → frozen Diff) ──────────────────── */

/**
 * Synthesize the frozen {@link Diff} the catalog `outputSchema` requires from the single widget node the
 * REST route returns (10-rest-api.md §8.8 ships `element` but NO `diff`). The op adds exactly ONE widget,
 * so the diff is a single `added` {@link NodeChange} for `element.id` (+ the matching `new_ids` rollup) —
 * faithful, never fabricating a change the op did not make. {@link presentDiff} (WP-T03) validates it
 * against `diff.schema.json` before it reaches the agent. The widget's `widgetType` (or `elType` for the
 * rare container case) rides along when present so the agent can identify the new node.
 */
export function elementToAddedDiff(element: ElementNode): Diff {
  const id = typeof element.id === 'string' ? element.id : '';
  const widgetType = 'widgetType' in element ? element.widgetType : undefined;
  const diff: Diff = {
    changes: [
      {
        id,
        op: 'added',
        elType: element.elType,
        ...(widgetType !== undefined ? { widgetType } : {}),
        after: element,
      },
    ],
    new_ids: id.length > 0 ? [id] : [],
    changed_ids: [],
    removed_ids: [],
  };
  return presentDiff(diff);
}

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before the handler runs
 * (`widget` a string, `base_hash` required, `post_id`/`product_id` ints), so the shape below describes the
 * POST-validation input. It is a narrowing view over the loose `unknown` the runtime {@link ToolHandler}
 * declares — NOT re-validation.
 */

/** `elementor.pro.woo.add_widget` validated input (Contract 13 §1.8). */
interface ProWooAddWidgetArgs {
  post_id: number;
  container_id: string;
  /** A `woocommerce-*` / `wc-*` widget name (free string — the Woo set is large + version-dependent). */
  widget: string;
  /** Only meaningful for `wc-add-to-cart`. */
  product_id?: number;
  settings?: Record<string, unknown>;
  base_hash: string;
}

/* ───────────────────────────── elementor.pro.woo.add_widget (§1.8 / §8.8) ───────────────────── */

/**
 * Build the `VALIDATION_FAILED` `isError` result for `wc-add-to-cart` requested WITHOUT a `product_id`
 * (12-error-taxonomy.md §3.4; §Detailed Requirements 6). This is the CHEAP client-side guard — it
 * short-circuits before a doomed `POST /pro/woo/add-widget` round-trip and hands the agent an actionable
 * next step (pass the WooCommerce product id). The PHP route is the final authority and re-asserts it.
 */
function addToCartProductIdRequiredResult(): ToolResult {
  const message =
    '`wc-add-to-cart` requires a `product_id` (the WooCommerce product to add to the cart); pass the product id and retry.';
  const payload = makeErrorPayload(ErrorCodes.VALIDATION_FAILED, message, {
    meta: {
      errors: [{ code: ErrorCodes.VALIDATION_FAILED, message, prop: 'product_id' }],
    },
  });
  return toToolErrorResult(payload);
}

/**
 * `elementor.pro.woo.add_widget` handler (M, Side BOTH, 13-tool-catalog.md §1.8; 10-rest-api.md §8.8).
 * Proxies `POST /pro/woo/add-widget`: PHP `Woo_Context_Validator` classifies the widget by
 * `get_categories()` and enforces the required theme-builder context, then writes the widget surgically
 * against `base_hash` (SUPPLEMENT.md §A.5/§A.7). This handler validates by SDK, applies the cheap
 * `wc-add-to-cart`-needs-`product_id` guard, calls the route, then shapes the frozen
 * `{element,diff,context_ok,context_warning,base_hash}`.
 *
 * The `diff` is synthesized from the returned widget node (the route ships `element` but no `diff`,
 * §8.8) via {@link elementToAddedDiff}. The PHP context verdict is surfaced in BOTH the result text AND
 * `structuredContent`: when `context_ok:false`, `context_warning` is surfaced PROMINENTLY in the text
 * (§Detailed Requirements 4) so the agent knows to create the right theme-builder doc (via
 * `elementor.pro.theme.create`) before placing single/archive widgets. A deterministic `op_id` makes a
 * retried add a safe no-op (§0.8); an idempotent replay is surfaced INFORMATIONALLY in the text.
 *
 * Error mapping (§Detailed Requirements 6): a 422 `WOO_CONTEXT_INVALID` (single widget on a page) → an
 * `isError` carrying `{widget,required_context,actual_doc_type}` meta; Pro/Woo inactive →
 * `PRO_REQUIRED` / `EXPERIMENT_INACTIVE` (the graceful woo-not-active surfaces cleanly, never a crash); a
 * stale `base_hash` → `CONCURRENCY_STALE_HASH`; a 404 → `NOT_FOUND` — all via {@link runProWoo}.
 */
export async function proWooAddWidgetHandler(
  args: ProWooAddWidgetArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProWoo(async () => {
    // Cheap client-side guard (§Detailed Requirements 6): wc-add-to-cart needs a product_id.
    if (args.widget === WC_ADD_TO_CART_WIDGET && args.product_id === undefined) {
      return addToCartProductIdRequiredResult();
    }

    const body: AddWooWidgetRequest = {
      post_id: args.post_id,
      container_id: args.container_id,
      widget: args.widget,
      ...(args.product_id !== undefined ? { product_id: args.product_id } : {}),
      ...(args.settings !== undefined ? { settings: args.settings } : {}),
      base_hash: args.base_hash,
      op_id: mintOpId([
        'pro.woo.add_widget',
        args.post_id,
        args.container_id,
        args.widget,
        args.product_id ?? null,
        args.settings ?? null,
        args.base_hash,
      ]),
    };
    const data: AddWooWidgetResponse = await ctx.wp.addWooWidget(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    const diff = elementToAddedDiff(data.element);
    // `context_warning` is `string | null` over REST but `string?` (optional) in the outputSchema — omit
    // a null so a clean placement validates without a `context_warning: null` riding the structured content.
    const hasWarning = typeof data.context_warning === 'string' && data.context_warning.length > 0;

    const structured: Record<string, unknown> = {
      element: data.element,
      diff,
      context_ok: data.context_ok,
      ...(hasWarning ? { context_warning: data.context_warning } : {}),
      base_hash: data.base_hash,
    };

    const elementId = typeof data.element.id === 'string' ? data.element.id : '(unknown id)';
    const contextNote = data.context_ok
      ? ' (context OK)'
      : ` — WARNING: ${hasWarning ? data.context_warning : 'widget placed outside its required WooCommerce context'}`;
    return okResult(
      structured,
      `Added WooCommerce widget "${args.widget}" (element ${elementId}) to container ${args.container_id} on post ${args.post_id}${contextNote}${replayed ? ' (idempotent replay — already added)' : ''}.`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach the Pro WooCommerce handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name
 * (§Detailed Requirements 1; §Acceptance). The tool is NON-★ (registered disabled at boot, enabled via
 * `tools.search` — driven by the descriptor `star:false` flag, no per-tool work here). The registry
 * stores handlers under its loose `(args) => unknown` type; the runtime invokes them as `(args, ctx)`
 * (server core casts to the WP-T01 {@link ToolHandler} signature), so the handler is registered through
 * that signature here.
 */
export function attachWooHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [PRO_WOO_ADD_WIDGET]: (args, ctx) => proWooAddWidgetHandler(args as ProWooAddWidgetArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
