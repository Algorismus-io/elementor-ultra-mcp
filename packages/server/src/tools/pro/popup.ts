/**
 * WP-R08 — Pro Popup tool HANDLERS (Contract 13 §1.8; 10-rest-api.md §8.4; SUPPLEMENT.md §A.2).
 *
 * Implements the three Pro popup tools and attaches each handler to the WP-F04 {@link ToolRegistry} by
 * EXACT catalog name (13-tool-catalog.md §1.8). This WP does NOT define schemas (WP-F04 owns the
 * descriptors in `catalog/schemas/pro.ts`) — each handler is a {@link ToolHandler} (WP-T01
 * `runtime/context.ts`) attached via `registry.attachHandler(name, fn)`; the SDK has already validated
 * `args` against the descriptor's `inputSchema` before the handler runs (Contract 13 §0.1) and validates
 * the returned `structuredContent` against `outputSchema` after.
 *
 * Handlers are THIN proxies over the WP-F02 bound facade (`ctx.wp.*`): validate-by-SDK →
 * `ctx.wp.createPopup(…)` / `ctx.wp.setPopupDisplay(id, …)` → map the RAW REST `data` into the
 * descriptor's `outputSchema` shape → return `{ content, structuredContent }`. ALL business logic (the
 * three storage buckets `_elementor_page_settings`/`_elementor_popup_display_settings`/
 * `_elementor_conditions`, the triggers/timing MERGE, condition defaulting to `include/general`) lives in
 * PHP per Contract 15 §4.7 (WP-R02 `Display_Settings_Helper::merge()`) — these handlers add NO business
 * logic.
 *
 * Tools handled here (Contract 13 §1.8 — all NON-★, registered disabled at boot, enabled via
 * `tools.search`):
 *  - `elementor.pro.popup.create`        (M, `POST /pro/popup`)              — create a popup document.
 *  - `elementor.pro.popup.set_triggers`  (M, idempotentHint, `PUT /pro/popup/{id}/display`) — merge triggers.
 *  - `elementor.pro.popup.set_timing`    (M, idempotentHint, `PUT /pro/popup/{id}/display`) — merge timing.
 *
 * `set_triggers`/`set_timing` map to the SAME REST route (`PUT /pro/popup/{id}/display`) with their
 * respective sub-object; the merge happens server-side. A shared private {@link putDisplay} helper keeps
 * the two handlers DRY. The display object is intentionally `z.record` (open / Pro-versioned) — the typed
 * key catalog lives in SUPPLEMENT.md §A.2 and is surfaced via the tool descriptions, NOT as a brittle zod
 * constraint (PHP validates it softly per WP-R02).
 *
 * Error mapping (Contract 13 §0.9, Contract 12 §3): a Pro-inactive 501 (`PRO_REQUIRED`), a target-not-a-
 * popup / 422 validation failure (`VALIDATION_FAILED`, surfacing the PHP `actual_type` meta), a 404
 * (`NOT_FOUND`), or a 403 arrive as a {@link WpClientError} carrying the taxonomy payload and route
 * through WP-F05's `fromClientError` → protocol-throw vs `isError` result (§5). Tool-arg failures (a
 * non-string `title`, a non-int `post_id`) are `-32602` from the SDK's zod layer before the handler runs.
 *
 * Contract authority: 13-tool-catalog.md §1.8 (per-tool I/O), §0.9 (error semantics); 10-rest-api.md §8.4
 * (display-settings buckets, merge semantics); 12-error-taxonomy.md §3 (codes), §5 (surface rules); 15
 * §4.7 (business logic in PHP); SUPPLEMENT.md §A.2 (the triggers/timing key catalog).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  type ConditionTuple,
  type CreatePopupRequest,
  type CreatePopupResponse,
  type SetPopupDisplayRequest,
  type SetPopupDisplayResponse,
  type ElementNode,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../../runtime/context.js';
import type { ToolRegistry } from '../../catalog/registry.js';
import { WpClientError } from '../../wp/types.js';
import { fromClientError, type ToolResult } from '../../wp/errors.js';
import { mintOpId, isReplay } from '../../safety/idempotency.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.8) ─────────────────────────── */

/** The Pro popup tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.8). */
export const PRO_POPUP_CREATE = 'elementor.pro.popup.create';
export const PRO_POPUP_SET_TRIGGERS = 'elementor.pro.popup.set_triggers';
export const PRO_POPUP_SET_TIMING = 'elementor.pro.popup.set_timing';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const PRO_POPUP_TOOL_NAMES = [
  PRO_POPUP_CREATE,
  PRO_POPUP_SET_TRIGGERS,
  PRO_POPUP_SET_TIMING,
] as const;

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
 * Run a thin Pro popup handler: invoke `fn` and, on a {@link WpClientError} (a 501 `PRO_REQUIRED`, a 422
 * `VALIDATION_FAILED` carrying `actual_type` for a target-not-a-popup, a 404 `NOT_FOUND`, a 403), route
 * it through WP-F05's surface rules (`fromClientError` → protocol-throw or `isError` result,
 * 12-error-taxonomy.md §5). Non-client errors rethrow (the server core surfaces them). The
 * {@link ToolResult} is structurally a {@link CallToolResult}.
 */
async function runProPopup(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
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
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (the `status` enum + default, the `ElementNode`/`ConditionTuple` shapes, the `display_settings`
 * `{triggers?,timing?}` object of `z.record`), so the shapes below describe the POST-validation input.
 * They are narrowing views over the loose `unknown` the runtime {@link ToolHandler} declares — NOT
 * re-validation.
 */

/** `elementor.pro.popup.create` validated input (Contract 13 §1.8). */
interface ProPopupCreateArgs {
  title: string;
  /** SDK-applied default `'publish'` (descriptor `.default('publish')`). */
  status: 'publish' | 'draft';
  elements?: ElementNode[];
  layout_settings?: Record<string, unknown>;
  display_settings?: {
    triggers?: Record<string, unknown>;
    timing?: Record<string, unknown>;
  };
  conditions?: ConditionTuple[];
}

/** `elementor.pro.popup.set_triggers` validated input (Contract 13 §1.8). */
interface ProPopupSetTriggersArgs {
  post_id: number;
  triggers: Record<string, unknown>;
}

/** `elementor.pro.popup.set_timing` validated input (Contract 13 §1.8). */
interface ProPopupSetTimingArgs {
  post_id: number;
  timing: Record<string, unknown>;
}

/* ───────────────────────────── elementor.pro.popup.create (§1.8 / §8.4) ─────────────────────── */

/**
 * `elementor.pro.popup.create` handler (M, 13-tool-catalog.md §1.8; 10-rest-api.md §8.4). Proxies
 * `POST /pro/popup`: PHP creates a `Modules\Popup\Document` and writes the THREE buckets —
 * `_elementor_page_settings` (layout), `_elementor_popup_display_settings` (triggers+timing), and
 * `_elementor_conditions` (location `popup`, SUPPLEMENT.md §A.2). When `conditions` is omitted PHP
 * defaults to `include/general` (site-wide) per WP-R02 — a popup with display settings but NO matching
 * condition never auto-opens, so omitting `conditions` makes the popup eligible site-wide.
 *
 * THIN proxy — no client-side business logic. A deterministic `op_id` makes a retried create a safe
 * no-op (§0.8); an idempotent replay is surfaced INFORMATIONALLY in the text. The RAW REST `data` also
 * carries `display_settings_meta` (the meta key string) which the frozen `outputSchema` drops — this
 * handler shapes the response to the frozen `{post_id, edit_url, conditions_stored}` exactly.
 */
export async function proPopupCreateHandler(
  args: ProPopupCreateArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProPopup(async () => {
    const body: CreatePopupRequest = {
      title: args.title,
      status: args.status,
      ...(args.elements !== undefined ? { elements: args.elements } : {}),
      ...(args.layout_settings !== undefined ? { layout_settings: args.layout_settings } : {}),
      ...(args.display_settings !== undefined ? { display_settings: args.display_settings } : {}),
      ...(args.conditions !== undefined ? { conditions: args.conditions } : {}),
      op_id: mintOpId([
        'pro.popup.create',
        args.title,
        args.status,
        args.display_settings ?? null,
        args.conditions ?? null,
      ]),
    };
    const data: CreatePopupResponse = await ctx.wp.createPopup(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    const structured = {
      post_id: data.post_id,
      edit_url: data.edit_url,
      conditions_stored: data.conditions_stored,
    };
    const conditionCount = data.conditions_stored.length;
    return okResult(
      structured,
      `Created popup "${args.title}" (post ${data.post_id})` +
        ` with ${conditionCount} display condition(s)` +
        `${replayed ? ' (idempotent replay — already created)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.pro.popup.set_triggers / set_timing (§1.8 / §8.4) ──── */

/**
 * Shared private helper for the two display-settings tools (§Implementation Notes): both
 * `set_triggers` and `set_timing` send ONLY their respective sub-object to `PUT /pro/popup/{id}/display`
 * — PHP MERGES it into the existing `_elementor_popup_display_settings` via
 * `Display_Settings_Helper::merge()` (WP-R02) and returns the FULL merged `{triggers,timing}`. The merge
 * makes these idempotent (`idempotentHint:true`). A deterministic `op_id` (seeded with the patch) makes a
 * retried merge a safe no-op (§0.8).
 *
 * Maps the RAW `SetPopupDisplayResponse` (`{saved, display_settings:{triggers,timing}}`) into the frozen
 * `outputSchema` (`{success, display_settings}`): `saved` → `success`; `display_settings` passes through
 * (the descriptor's `display_settings` is an open `z.record`, so the merged `{triggers,timing}` object
 * validates).
 */
async function putDisplay(
  ctx: ToolContext,
  postId: number,
  patch: SetPopupDisplayRequest,
  kind: 'triggers' | 'timing',
): Promise<ToolResult> {
  const body: SetPopupDisplayRequest = {
    ...patch,
    op_id: mintOpId(['pro.popup.set_display', kind, postId, patch[kind] ?? null]),
  };
  const data: SetPopupDisplayResponse = await ctx.wp.setPopupDisplay(postId, body);
  const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

  const structured = {
    success: data.saved,
    display_settings: data.display_settings as Record<string, unknown>,
  };
  return okResult(
    structured,
    `Merged popup ${kind} into the display settings of popup ${postId}` +
      `${replayed ? ' (idempotent replay — already saved)' : ''}.`,
  );
}

/**
 * `elementor.pro.popup.set_triggers` handler (M, idempotentHint, 13-tool-catalog.md §1.8;
 * 10-rest-api.md §8.4). Sends ONLY `{triggers}` to `PUT /pro/popup/{id}/display`; PHP merges it into the
 * existing display settings and returns the full merged `{triggers,timing}`. See {@link putDisplay}.
 */
export async function proPopupSetTriggersHandler(
  args: ProPopupSetTriggersArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProPopup(() => putDisplay(ctx, args.post_id, { triggers: args.triggers }, 'triggers'));
}

/**
 * `elementor.pro.popup.set_timing` handler (M, idempotentHint, 13-tool-catalog.md §1.8; 10-rest-api.md
 * §8.4). Sends ONLY `{timing}` to `PUT /pro/popup/{id}/display`; PHP merges it into the existing display
 * settings and returns the full merged `{triggers,timing}`. See {@link putDisplay}.
 */
export async function proPopupSetTimingHandler(
  args: ProPopupSetTimingArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProPopup(() => putDisplay(ctx, args.post_id, { timing: args.timing }, 'timing'));
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach every Pro popup handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Detailed
 * Requirements 1; §Acceptance). These tools are NON-★ (registered disabled at boot, enabled via
 * `tools.search` matching `elementor.pro.popup*` — driven by the descriptor `star:false` flag, no
 * per-tool work here). The registry stores handlers under its loose `(args) => unknown` type; the runtime
 * invokes them as `(args, ctx)` (the server core casts to the WP-T01 {@link ToolHandler} signature), so
 * each handler is registered through that signature here.
 */
export function attachPopupHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [PRO_POPUP_CREATE]: (args, ctx) => proPopupCreateHandler(args as ProPopupCreateArgs, ctx),
    [PRO_POPUP_SET_TRIGGERS]: (args, ctx) =>
      proPopupSetTriggersHandler(args as ProPopupSetTriggersArgs, ctx),
    [PRO_POPUP_SET_TIMING]: (args, ctx) =>
      proPopupSetTimingHandler(args as ProPopupSetTimingArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
