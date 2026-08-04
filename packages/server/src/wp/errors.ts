/**
 * WP-F05 — TS server error-mapping rules (Seam E, `12-error-taxonomy.md §5`).
 *
 * The complement to `wp/client.ts` (which owns the envelope→taxonomy mapping + the transport retry
 * policy). This module turns a taxonomy error into the MCP wire form the server returns to the agent:
 *
 *   §5.1  Tool-argument / Zod failures → throw at the protocol layer → `-32602`
 *         (`SCHEMA_INVALID_PARAMS`). `protocolErrorFromZod` / `isProtocolPayload` support this.
 *   §5.2  Any `surface:'isError'` taxonomy code → a tool RESULT `{isError:true, content:[text]}`
 *         (text = message + compact meta) WITH the full `McpErrorPayload` as structured content.
 *         `toToolErrorResult` builds it.
 *   §5.3  Retry policy — owned by `wp/client.ts` (`isClientRetryable`). Re-exported here for callers
 *         that reason about retryability without importing the client.
 *   §5.4  Soft codes (`DUPLICATED_LABEL`, `HTML_V3_STRIPPED`, `IDEMPOTENT_REPLAY`) surface as
 *         `isError` ONLY when they change semantics the agent must act on (`shouldSurfaceSoftCode`);
 *         otherwise they ride the diff/report.
 *   §5.5  Destructive declines (elicitation "no") → a clean NON-error result, not an error
 *         (`declinedResult`).
 *
 * This module is transport-agnostic: it produces the SDK's `CallToolResult` shape structurally
 * (`{ content, structuredContent?, isError? }`) so it can be used by every tool WP without coupling to
 * a specific SDK import here.
 */

import {
  ErrorCodes,
  RPC_INVALID_PARAMS,
  makeErrorPayload,
  formatErrorText,
  isSoftCode,
  type ErrorCode,
  type McpErrorPayload,
} from '@elementor-ultra/shared';

import { WpClientError } from './types.js';
import { isClientRetryable } from './client.js';

/* Re-export the client retry predicate so callers reason about retryability from one place (§5.3). */
export { isClientRetryable };

/* ───────────────────────────── MCP tool-result shapes (structural) ───────────────────────── */

/** A text content block in a tool result (the SDK's `{type:'text', text}` shape). */
export interface ToolTextContent {
  type: 'text';
  text: string;
}

/**
 * The structural `CallToolResult` shape the SDK returns from a tool handler. `isError:true` marks a
 * runtime/business failure the agent can react to (`12-error-taxonomy.md §1`); `structuredContent`
 * carries the full {@link McpErrorPayload} where the client supports it.
 */
export interface ToolResult {
  content: ToolTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/* ───────────────────────────── protocol-layer (§5.1) ─────────────────────────────────────── */

/**
 * A JSON-RPC protocol error the server THROWS (not a tool result). Tool-argument / schema failures
 * map here → `-32602` (`SCHEMA_INVALID_PARAMS`, `12-error-taxonomy.md §5.1`).
 *
 * CAUTION (SDK 1.29 reality): the SDK's tool dispatcher catches ANY throw and flattens it to a
 * text-only `{isError:true}` result built from `error.message` (`createToolError`) — it does NOT
 * emit a JSON-RPC error frame and `structuredContent` is dropped. The constructor therefore embeds
 * the taxonomy code and the compact `meta` summary in the message so the structured detail survives
 * that flattening. Wire-originated payloads must NOT be thrown at all — see {@link fromClientError}.
 */
export class ProtocolError extends Error {
  /** JSON-RPC error code (e.g. -32602). */
  readonly code: number;
  /** The structured taxonomy payload (surface:'protocol'). */
  readonly payload: McpErrorPayload;

  constructor(payload: McpErrorPayload) {
    // `formatErrorText` = message + compact meta summary; prefix the taxonomy code so the agent
    // still sees both after the SDK reduces the throw to a bare message string.
    super(`[${payload.code}] ${formatErrorText(payload)}`);
    this.name = 'ProtocolError';
    this.code = payload.rpc_code ?? RPC_INVALID_PARAMS;
    this.payload = payload;
  }
}

/** Minimal shape of a ZodError (without importing zod here) so callers can pass a caught error. */
interface ZodLikeError {
  issues?: Array<{ path?: Array<string | number>; message?: string; expected?: unknown }>;
  message?: string;
}

/** True when `value` looks like a Zod validation error (has an `issues[]` array). */
export function isZodLikeError(value: unknown): value is ZodLikeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'issues' in value &&
    Array.isArray((value as ZodLikeError).issues)
  );
}

/**
 * Build a `-32602` {@link ProtocolError} (`SCHEMA_INVALID_PARAMS`) from a Zod-like arg-validation
 * failure (`12-error-taxonomy.md §5.1`). The first issue's path/expected populate `meta`; the message
 * lists all issue messages.
 */
export function protocolErrorFromZod(error: ZodLikeError): ProtocolError {
  const issues = error.issues ?? [];
  const first = issues[0];
  const path = first?.path?.join('.') ?? undefined;
  const expected = typeof first?.expected === 'string' ? first.expected : undefined;
  const message =
    issues.length > 0
      ? `Invalid tool arguments: ${issues.map((i) => i.message ?? 'invalid').join('; ')}`
      : (error.message ?? 'Invalid tool arguments');
  const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, message, {
    meta: {
      ...(path !== undefined ? { path } : {}),
      ...(expected !== undefined ? { expected } : {}),
    },
  });
  return new ProtocolError(payload);
}

/** True when a payload should be THROWN as a protocol error rather than returned as a result (§5.1). */
export function isProtocolPayload(payload: McpErrorPayload): boolean {
  return payload.surface === 'protocol';
}

/* ───────────────────────────── isError tool-result (§5.2) ────────────────────────────────── */

/**
 * Build an `isError:true` tool result from a taxonomy payload (`12-error-taxonomy.md §5.2`). The text
 * is `message` + a compact meta summary; the full payload rides as `structuredContent` so capable
 * clients get the machine-readable form. Does NOT apply to `surface:'protocol'` payloads — those are
 * thrown via {@link ProtocolError} (`throwOrResult` enforces the split).
 */
export function toToolErrorResult(payload: McpErrorPayload): ToolResult {
  return {
    content: [{ type: 'text', text: formatErrorText(payload) }],
    structuredContent: payloadToStructured(payload),
    isError: true,
  };
}

/** Serialize a payload to a plain structured-content record (for `structuredContent`). */
function payloadToStructured(payload: McpErrorPayload): Record<string, unknown> {
  return {
    code: payload.code,
    message: payload.message,
    http_status: payload.http_status,
    retryable: payload.retryable,
    surface: payload.surface,
    rpc_code: payload.rpc_code,
    meta: payload.meta,
  };
}

/**
 * Apply the §5.1/§5.2 split: a `surface:'protocol'` payload is THROWN as a {@link ProtocolError}; any
 * other payload is RETURNED as an `isError:true` tool result. Tool handlers call this with the payload
 * carried by a {@link WpClientError} (or one they construct) so the surface decision is centralized.
 */
export function throwOrResult(payload: McpErrorPayload): ToolResult {
  if (isProtocolPayload(payload)) {
    throw new ProtocolError(payload);
  }
  return toToolErrorResult(payload);
}

/**
 * Convert a caught {@link WpClientError} (thrown by `wp/client.ts`) into the MCP result/throw per the
 * surface rules — the bridge tool handlers use after a `wp/routes.ts` call rejects.
 *
 * The §5.1 protocol throw is reserved for genuine request-shape failures (`SCHEMA_INVALID_PARAMS`).
 * Any OTHER protocol-surfaced payload arriving from the wire — notably `INTERNAL_ERROR`, e.g. the
 * batch runner's `E_COMPENSATION_FAILED` whose `meta.unrecovered` lists the half-applied items —
 * is re-surfaced as an `isError` RESULT instead: SDK 1.29 flattens any throw to a bare text message
 * (no structuredContent, no JSON-RPC frame), which would discard exactly the meta the message tells
 * the agent to consult. As an isError result the full payload rides `structuredContent`.
 */
export function fromClientError(error: WpClientError): ToolResult {
  const payload = error.payload;
  if (payload.surface === 'protocol' && payload.code !== ErrorCodes.SCHEMA_INVALID_PARAMS) {
    return toToolErrorResult({ ...payload, surface: 'isError', rpc_code: null });
  }
  return throwOrResult(payload);
}

/* ───────────────────────────── soft-code handling (§5.4) ─────────────────────────────────── */

/**
 * Whether a SOFT taxonomy code should surface as an `isError` result vs ride the diff/report
 * (`12-error-taxonomy.md §5.4`). Soft codes (`DUPLICATED_LABEL`, `HTML_V3_STRIPPED`,
 * `IDEMPOTENT_REPLAY`) surface ONLY when they change semantics the agent must act on — the caller
 * signals that via `changesSemantics`. Non-soft codes always surface.
 */
export function shouldSurfaceSoftCode(code: ErrorCode, changesSemantics: boolean): boolean {
  if (!isSoftCode(code)) {
    return true;
  }
  return changesSemantics;
}

/* ───────────────────────────── destructive decline (§5.5) ────────────────────────────────── */

/**
 * A CLEAN non-error result for a destructive op the user DECLINED via `elicitation/create`
 * (`12-error-taxonomy.md §5.5`): a user decision, not an error, so `isError` is unset. Optional
 * `message` overrides the default text.
 *
 * SDK 1.29 output validation: a non-error result from a tool registered with an `outputSchema` MUST
 * carry a `structuredContent` that VALIDATES against that schema, or the SDK replaces the whole
 * result with an opaque `-32602 Output validation error`. Decline call sites must therefore pass a
 * schema-valid `structured` record for their tool (e.g. `{success:false, trashed:false}` for
 * `page.delete`); a bare-content decline only survives on tools without an output schema.
 */
export function declinedResult(
  message = 'Operation cancelled by the user; no changes were made. Pass confirm:true to pre-confirm and skip the prompt.',
  structured?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}
