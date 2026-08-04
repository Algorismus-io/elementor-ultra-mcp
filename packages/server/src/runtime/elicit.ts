/**
 * WP-T01 — the elicitation helper (`ElicitFn`) wrapping the SDK `elicitInput`
 * (13-tool-catalog.md §0.3; 01-architecture.md §4 corollary; §7 destructive-op gating is TS-owned).
 *
 * Destructive tools (class `D`) that are called WITHOUT `confirm:true` ask the user to confirm via the
 * MCP `elicitation/create` round-trip. The MCP elicitation `requestedSchema` MUST be FLAT PRIMITIVES
 * ONLY — `{ type:'object', properties:{ field: <string|number|boolean|enum> } }`, no nested objects or
 * arrays (Contract 13 §0.3). This module enforces that at the type level ({@link FlatPrimitiveShape})
 * and provides a default {@link confirmSchema} (`{ confirm: boolean }`).
 *
 * Result mapping (12-error-taxonomy.md §5.5): `action:'accept'` ⇒ `{confirmed:true, values}`;
 * `decline`/`cancel` ⇒ `{confirmed:false}` (handlers then return a CLEAN non-error `declinedResult`).
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';

/* ───────────────────────────── flat-primitive schema (LOCKED, §0.3) ───────────────────────── */

/** A single flat-primitive field in an elicitation schema (no nested objects/arrays, §0.3). */
export type FlatPrimitiveField =
  | { type: 'string'; title?: string; description?: string; enum?: string[]; default?: string }
  | { type: 'number' | 'integer'; title?: string; description?: string; default?: number }
  | { type: 'boolean'; title?: string; description?: string; default?: boolean };

/**
 * A flat-primitives-only elicitation shape: `field → primitive`. This is the ONLY shape `ElicitFn`
 * accepts (Contract 13 §0.3). It maps 1:1 to the MCP `requestedSchema.properties`.
 */
export type FlatPrimitiveShape = Record<string, FlatPrimitiveField>;

/** The default confirm-only schema for destructive ops (`{ confirm: boolean }`). */
export const confirmSchema: FlatPrimitiveShape = {
  confirm: {
    type: 'boolean',
    title: 'Confirm',
    description: 'Confirm this destructive operation.',
  },
};

/**
 * Add scalar fields to (a copy of) the default {@link confirmSchema}. Convenience for destructive tools
 * that want to elicit confirm + a couple of extra primitive values in one round-trip (§Implementation
 * Notes: "a way to add scalar fields").
 */
export function confirmSchemaWith(extra: FlatPrimitiveShape): FlatPrimitiveShape {
  return { ...confirmSchema, ...extra };
}

/* ───────────────────────────── ElicitFn ───────────────────────────────────────────────────── */

/** The outcome of an elicitation round-trip (12-error-taxonomy.md §5.5). */
export interface ElicitOutcome {
  /** True iff the user ACCEPTED (`action:'accept'`); `decline`/`cancel` ⇒ false. */
  confirmed: boolean;
  /** The user-provided primitive values (present only on `accept`). */
  values?: Record<string, string | number | boolean>;
}

/**
 * The elicitation function injected into every {@link ToolContext}. Destructive tools call this when
 * `confirm!=true`; a decline ⇒ a clean non-error result (Contract 12 §5 rule 5).
 *
 * @param prompt The human-readable message shown to the user.
 * @param schema The FLAT-PRIMITIVES-ONLY field shape (no nested objects/arrays, §0.3).
 */
export type ElicitFn = (prompt: string, schema?: FlatPrimitiveShape) => Promise<ElicitOutcome>;

/* ───────────────────────────── SDK binding ────────────────────────────────────────────────── */

/**
 * Map a {@link FlatPrimitiveShape} to the MCP `requestedSchema` (`{ type:'object', properties, required
 * }`). Every field is `required` so the client returns a complete value set on accept; the values are
 * already validated flat primitives.
 */
function toRequestedSchema(shape: FlatPrimitiveShape): {
  type: 'object';
  properties: Record<string, FlatPrimitiveField>;
  required: string[];
} {
  return {
    type: 'object',
    properties: { ...shape },
    required: Object.keys(shape),
  };
}

/** The slice of the SDK `Server` the elicit helper needs (lazily probed at call time). */
export interface ElicitServer {
  elicitInput: Server['elicitInput'];
  getClientCapabilities: Server['getClientCapabilities'];
}

/**
 * Build the live {@link ElicitFn} bound to the SDK's low-level `Server`. The default schema (when none
 * is passed) is {@link confirmSchema}. Capability is probed at CALL time: if the connected client does
 * NOT advertise `elicitation`, the helper DECLINES safely (`{confirmed:false}`) so a destructive op
 * without `confirm:true` is refused rather than silently proceeding. On `accept` the returned `content`
 * is coerced to a flat `Record<string, string|number|boolean>`; `decline`/`cancel` ⇒ `{confirmed:false}`.
 *
 * @param server The underlying SDK `Server` (i.e. `mcpServer.server`).
 */
export function makeElicitFn(server: ElicitServer): ElicitFn {
  return async (
    prompt: string,
    schema: FlatPrimitiveShape = confirmSchema,
  ): Promise<ElicitOutcome> => {
    if (!clientSupportsElicitation(server)) {
      return { confirmed: false };
    }
    const result: ElicitResult = await server.elicitInput({
      mode: 'form',
      message: prompt,
      requestedSchema: toRequestedSchema(schema),
    });
    if (result.action !== 'accept') {
      return { confirmed: false };
    }
    const content = (result.content ?? {}) as Record<string, string | number | boolean>;
    return { confirmed: true, values: content };
  };
}

/** Whether the connected client advertises the `elicitation` capability (false before connect). */
function clientSupportsElicitation(server: Pick<ElicitServer, 'getClientCapabilities'>): boolean {
  try {
    return server.getClientCapabilities()?.elicitation !== undefined;
  } catch {
    return false;
  }
}

/**
 * A non-interactive {@link ElicitFn}: always DECLINES (`{confirmed:false}`). Useful in tests / for
 * transports with no client-elicitation channel.
 */
export const noElicitFn: ElicitFn = () => Promise.resolve({ confirmed: false });
