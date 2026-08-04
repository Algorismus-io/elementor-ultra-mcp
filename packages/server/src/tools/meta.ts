/**
 * WP-T11 — the always-available META-TRIO HANDLERS (long-tail access, Contract 13 §1.11 / §5.3).
 *
 * The escape hatch for the large tool surface: these three are ALWAYS enabled regardless of
 * `ULTRA_TOOLS` (WP-F04 flags them `meta:true`; WP-T01 keeps them enabled) and lean ENTIRELY on the
 * WP-F04 {@link ToolRegistry} introspection (via `ctx.registry`) plus a dispatch helper — they stay
 * thin.
 *  - `elementor.tools.list_endpoints` (R, TS) — enumerate EVERY tool incl. disabled with
 *    `{name,title,class,enabled,star}`; `prefix` filter + §0.6 pagination.
 *  - `elementor.tools.get_schema` (R, TS) — the named tool's `{name,inputSchema,outputSchema,
 *    annotations}` straight from the registry descriptor.
 *  - `elementor.tools.invoke` (TS dispatch) — invoke any catalog tool by name INCLUDING disabled tools
 *    WITHOUT persistently enabling it (Contract 13 §5.3 one-shot — it MUST NOT call
 *    `ctx.surface.enable()`, which is `tools.search`'s persistent-enable path). It validates
 *    `arguments` against the TARGET tool's `inputSchema` (→ `-32602` on mismatch, §0.9) then dispatches
 *    the attached handler with the SAME `ctx`, so the target's own safety class + confirm gating apply
 *    unchanged (a destructive target still elicits). Returns `{result,isError}`.
 *
 * Contract authority: 13-tool-catalog.md §1.11 (per-tool I/O), §5.2/§6 (always-available),
 * §5.3 (invoke-disabled-without-enabling), §0.6 (pagination), §0.9 (arg validation → -32602);
 * 12-error-taxonomy.md §5.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import {
  HandlerNotRegisteredError,
  UnknownToolError,
  type ToolRegistry,
} from '../catalog/registry.js';
import type { ToolDescriptor } from '../catalog/tools.js';
import {
  isZodLikeError,
  protocolErrorFromZod,
  toToolErrorResult,
  type ToolResult,
} from '../wp/errors.js';
import { makeErrorPayload, ErrorCodes } from '@elementor-ultra/shared';

/* ───────────────────────────── frozen tool names (Contract 13 §1.11) ──────────────────────── */

/** The meta-trio tool names this module attaches (EXACT catalog names — 13-tool-catalog.md §1.11). */
export const TOOLS_LIST_ENDPOINTS = 'elementor.tools.list_endpoints';
export const TOOLS_GET_SCHEMA = 'elementor.tools.get_schema';
export const TOOLS_INVOKE = 'elementor.tools.invoke';

/** Every meta-trio tool name this module owns a handler for (used by attach + tests). */
export const META_TOOL_NAMES = [TOOLS_LIST_ENDPOINTS, TOOLS_GET_SCHEMA, TOOLS_INVOKE] as const;

/* ───────────────────────────── result helpers ─────────────────────────────────────────────── */

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

/* ───────────────────────────── typed validated args (post-SDK) ────────────────────────────── */
/*
 * The SDK has parsed `args` against THIS meta-tool's `inputSchema` before the handler runs (Contract 13
 * §0.9). For `tools.invoke` that covers only `{name, arguments}` — the inner `arguments` are validated
 * against the TARGET tool's schema by the handler (§Detailed Requirements 6).
 */

interface ListEndpointsArgs {
  prefix?: string;
  limit: number;
  cursor?: string;
  fields?: string[];
}

interface GetSchemaArgs {
  name: string;
}

interface InvokeArgs {
  name: string;
  arguments: Record<string, unknown>;
}

/* ───────────────────────────── elementor.tools.list_endpoints (§1.11 / §0.6) ──────────────── */

/** One enumerated endpoint row (13-tool-catalog.md §1.11 outputSchema). */
interface EndpointRow {
  name: string;
  title: string;
  class: 'R' | 'M' | 'D';
  enabled: boolean;
  star: boolean;
}

/**
 * Apply an opaque numeric-offset cursor to a fully-materialized list. The registry is bounded + in
 * memory (no server pagination), so the cursor is the stringified next offset; `null` next_cursor ⇒
 * last page (Contract 13 §0.6). Mirrors the local-pagination shape used by the discovery handlers.
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
 * `elementor.tools.list_endpoints` handler (13-tool-catalog.md §1.11; §5.3). Enumerates EVERY catalog
 * tool — INCLUDING disabled ones — from `ctx.registry`, reporting each tool's live `enabled` state
 * (registry bookkeeping, the source of truth WP-T01 mirrors into the SDK). `prefix` filters by name
 * prefix; the result paginates via §0.6 `{limit,cursor}`. READ-ONLY (no surface mutation).
 */
export function listEndpointsHandler(
  args: ListEndpointsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  const descriptors = ctx.registry.listDescriptors();
  const filtered =
    args.prefix !== undefined && args.prefix.length > 0
      ? descriptors.filter((d) => d.name.startsWith(args.prefix as string))
      : descriptors;
  const rows: EndpointRow[] = filtered.map((d) => ({
    name: d.name,
    title: d.title,
    class: d.class,
    // `enabled` reflects the registry bookkeeping (disabled long-tail tools report `false`, §5.3).
    enabled: ctx.registry.isEnabled(d.name),
    star: d.star,
  }));
  const page = paginateLocal(rows, args.limit, args.cursor);
  const structured = {
    items: page.items,
    next_cursor: page.next_cursor,
    total: page.total,
  };
  return Promise.resolve(
    okResult(
      structured,
      `Listed ${page.items.length} of ${page.total} tool endpoint(s)${
        page.next_cursor !== null ? ' (more available)' : ''
      }.`,
    ) as CallToolResult,
  );
}

/* ───────────────────────────── elementor.tools.get_schema (§1.11) ─────────────────────────── */

/**
 * `elementor.tools.get_schema` handler (13-tool-catalog.md §1.11). Returns the named tool's
 * `{name,inputSchema,outputSchema,annotations}` straight from the registry descriptor (the long-tail
 * access path's schema lookup). An unknown name surfaces as a clean `VALIDATION_FAILED` isError result
 * (the agent can fix the input — Contract 12 §0.9 / §5).
 */
export function getSchemaHandler(args: GetSchemaArgs, ctx: ToolContext): Promise<CallToolResult> {
  let descriptor: ToolDescriptor;
  try {
    descriptor = ctx.registry.getDescriptor(args.name);
  } catch (error: unknown) {
    if (error instanceof UnknownToolError) {
      return Promise.resolve(unknownToolResult(args.name) as CallToolResult);
    }
    throw error;
  }
  const structured = {
    name: descriptor.name,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    annotations: descriptor.annotations,
  };
  return Promise.resolve(
    okResult(
      structured,
      `Schema for ${descriptor.name} (class=${descriptor.class}).`,
    ) as CallToolResult,
  );
}

/* ───────────────────────────── elementor.tools.invoke (§1.11 / §5.3) ──────────────────────── */

/**
 * `elementor.tools.invoke` handler (13-tool-catalog.md §1.11; §5.3). The long-tail dispatch path:
 * invoke ANY catalog tool by name — INCLUDING disabled tools — WITHOUT persistently enabling it. It
 * MUST NOT call `ctx.surface.enable()` (that is `tools.search`'s persistent-enable path; §5.3
 * distinguishes search→enable from invoke→one-shot, §Implementation Notes).
 *
 * Flow:
 *  1. Resolve the target descriptor (unknown name ⇒ clean `VALIDATION_FAILED` isError result).
 *  2. Validate `arguments` against the TARGET tool's `inputSchema` (the SDK only validated the
 *     meta-tool's own `{name,arguments}` shape). A mismatch THROWS a `-32602` {@link ProtocolError}
 *     against the target schema (§Detailed Requirements 6; §0.9).
 *  3. Dispatch the attached handler with the SAME `ctx` so the target's safety class + confirm gating
 *     apply unchanged — a destructive target still elicits (it owns its own elicitation gate). The
 *     wrapped result is returned as `{result, isError}` (the target's `CallToolResult` rides `result`).
 */
export async function invokeHandler(args: InvokeArgs, ctx: ToolContext): Promise<CallToolResult> {
  // 1) Resolve the target descriptor + handler. An unknown / unattached target is an input error the
  //    agent can fix → a clean isError result (NOT a protocol error, Contract 12 §0.9).
  let descriptor: ToolDescriptor;
  try {
    descriptor = ctx.registry.getDescriptor(args.name);
  } catch (error: unknown) {
    if (error instanceof UnknownToolError) {
      return unknownToolResult(args.name) as CallToolResult;
    }
    throw error;
  }

  // 2) Validate `arguments` against the TARGET tool's inputSchema. The descriptor stores the schema as
  //    a ZodRawShape; wrap it as `z.object(...)` and parse. A failure → `-32602` against the target.
  const parsed = z.object(descriptor.inputSchema).safeParse(args.arguments);
  if (!parsed.success) {
    // `protocolErrorFromZod` THROWS a ProtocolError (-32602, SCHEMA_INVALID_PARAMS) — the SDK frames it
    // as a protocol error. The zod error carries `issues[]` so `isZodLikeError` recognizes it.
    const zodError: unknown = parsed.error;
    if (isZodLikeError(zodError)) {
      throw protocolErrorFromZod(zodError);
    }
    throw protocolErrorFromZod({
      issues: [],
      message: 'Invalid tool arguments for the target tool.',
    });
  }

  // 3) Dispatch the attached handler ONE-SHOT (no surface.enable). Disabled tools are still in the
  //    registry with their handlers attached, so this reaches them without flipping their enabled flag.
  let handler: ToolHandler;
  try {
    handler = ctx.registry.getHandler(descriptor.name) as unknown as ToolHandler;
  } catch (error: unknown) {
    if (error instanceof HandlerNotRegisteredError) {
      return handlerNotAttachedResult(descriptor.name) as CallToolResult;
    }
    throw error;
  }

  // Pass the SAME ctx so the target's confirm gating / safety class apply unchanged (parity, §1.11).
  const targetResult = await handler(parsed.data, ctx);
  const isError = targetResult.isError === true;
  const structured = { result: targetResult, isError };
  const text = isError
    ? `Invoked ${descriptor.name}: the target reported an error.`
    : `Invoked ${descriptor.name}.`;
  return okResult(structured, text) as CallToolResult;
}

/* ───────────────────────────── error results (clean, agent-fixable) ───────────────────────── */

/** A clean `VALIDATION_FAILED` isError result for an unknown target tool name (Contract 12 §0.9 / §5). */
function unknownToolResult(name: string): ToolResult {
  const payload = makeErrorPayload(
    ErrorCodes.VALIDATION_FAILED,
    `Unknown tool "${name}" — not in the catalog. Use elementor.tools.list_endpoints to discover valid names.`,
  );
  return toToolErrorResult(payload);
}

/** A clean `INTERNAL_ERROR` isError result for a catalog tool whose handler is not attached in this build. */
function handlerNotAttachedResult(name: string): ToolResult {
  const payload = makeErrorPayload(
    ErrorCodes.INTERNAL_ERROR,
    `Tool "${name}" exists in the catalog but its handler is not attached in this build; it cannot be invoked here.`,
  );
  return toToolErrorResult(payload);
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ───────────────── */

/**
 * Attach the meta-trio handlers to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Detailed
 * Requirements 1; §Acceptance). This module ONLY attaches handlers — it does NOT touch enabled state:
 * the trio is flagged `meta:true` in WP-F04 and kept always-on by WP-T01 (§5.2/§6); attaching a handler
 * never disables a tool. The registry stores handlers under its loose `(args) => unknown` type; the
 * runtime invokes them as `(args, ctx)` (server core casts to the WP-T01 {@link ToolHandler}).
 */
export function attachMetaHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [TOOLS_LIST_ENDPOINTS]: (args, ctx) => listEndpointsHandler(args as ListEndpointsArgs, ctx),
    [TOOLS_GET_SCHEMA]: (args, ctx) => getSchemaHandler(args as GetSchemaArgs, ctx),
    [TOOLS_INVOKE]: (args, ctx) => invokeHandler(args as InvokeArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
