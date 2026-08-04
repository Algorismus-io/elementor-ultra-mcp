/**
 * WP-T01 — the shared runtime `ToolContext` (Seam: F04 data ↔ live SDK ↔ F02 REST).
 *
 * Every tool / resource / prompt handler the verticals write receives EXACTLY ONE object: the
 * {@link ToolContext}. It carries the REST access ({@link WpRoutes} over the WP-F02 client), the
 * memoized {@link CapabilitiesCache}, the live {@link SurfaceController}, the WP-F04 `ToolRegistry`,
 * the elicitation helper, and a stderr-only logger. This WP owns the seam; it contains NO per-tool
 * logic (01-architecture.md §1.2 "Server core … only constructs context"; §4.3 data-driven registry).
 *
 * `ToolContext.wp` is a thin BOUND facade over the WP-F02 typed route wrappers (`wp/routes.ts`): each
 * route function `route(client, …)` becomes `wp.route(…)` with the per-site {@link WpClient} pre-bound,
 * plus the convenience `wp.siteCapabilities()` (normalized probe, 13-tool-catalog.md M6 gating) and the
 * raw `wp.client` for handlers that need bespoke flows. The route wrappers are the single Seam-B HTTP
 * boundary — this module never talks HTTP itself.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Capabilities } from '@elementor-ultra/shared';

import { WpClient } from '../wp/client.js';
import * as routes from '../wp/routes.js';
import { probeCapabilities } from '../tools/discovery-capabilities.js';

import type { CapabilitiesCache } from './capabilities-cache.js';
import type { SurfaceController } from './surface.js';
import type { ElicitFn } from './elicit.js';
import type { ToolRegistry } from '../catalog/registry.js';

/* ───────────────────────────── logger (stderr only, §Detailed Requirements 6) ────────────── */

/**
 * The runtime logger. EVERY line goes to `process.stderr` — stdout is reserved for the stdio
 * transport's JSON-RPC stream (any stdout write corrupts it, WP-T02 / Contract 15 §1). The default
 * {@link stderrLogger} writes prefixed lines; tests may inject a no-op / capturing logger.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** The default stderr-only logger (never touches stdout). */
export const stderrLogger: Logger = {
  debug: (message, meta) => writeStderr('debug', message, meta),
  info: (message, meta) => writeStderr('info', message, meta),
  warn: (message, meta) => writeStderr('warn', message, meta),
  error: (message, meta) => writeStderr('error', message, meta),
};

function writeStderr(level: string, message: string, meta?: Record<string, unknown>): void {
  const suffix =
    meta !== undefined && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  process.stderr.write(`[elementor-ultra-mcp] ${level}: ${message}${suffix}\n`);
}

/* ───────────────────────────── WpRoutes facade (over WP-F02 wp/routes.ts) ─────────────────── */

/**
 * The arguments a free route function takes AFTER its leading `client` parameter (e.g.
 * `getDocument(client, id, query?)` ⇒ `[id, query?]`). Used to derive the bound facade signatures.
 */
type DropClient<F> = F extends (client: WpClient, ...rest: infer R) => infer T
  ? (...rest: R) => T
  : never;

/** The bound form of the entire `wp/routes.ts` module: every `route(client, …)` ⇒ `route(…)`. */
type BoundRoutes = {
  readonly [K in keyof typeof routes]: DropClient<(typeof routes)[K]>;
};

/**
 * The runtime REST facade injected as `ToolContext.wp`. It exposes:
 *  - every WP-F02 typed route wrapper with the per-site {@link WpClient} pre-bound (so a handler calls
 *    `ctx.wp.getDocument(id)` instead of `getDocument(ctx.wp.client, id)`);
 *  - `siteCapabilities()` — the NORMALIZED capability probe (13-tool-catalog.md §1.1 / M6 gating), the
 *    method {@link CapabilitiesCache} memoizes;
 *  - `client` — the raw {@link WpClient} for bespoke flows (`wp/v2/*` media, cursor-follow).
 */
export type WpRoutes = BoundRoutes & {
  /** The underlying per-site HTTP client (raw access for bespoke flows). */
  readonly client: WpClient;
  /** Fetch + normalize the site capability probe (13-tool-catalog.md §1.1). */
  siteCapabilities(): Promise<Capabilities>;
};

/**
 * Build the {@link WpRoutes} facade by binding `client` as the first argument of every `wp/routes.ts`
 * wrapper. Pure plumbing — no business logic. The `client` and `siteCapabilities` members are added on
 * top of the bound route set.
 */
export function bindRoutes(client: WpClient): WpRoutes {
  const bound: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(routes)) {
    if (typeof fn === 'function') {
      bound[name] = (...args: unknown[]): unknown =>
        (fn as (...a: unknown[]) => unknown)(client, ...args);
    }
  }
  bound['client'] = client;
  bound['siteCapabilities'] = (): Promise<Capabilities> => probeCapabilities(client);
  return bound as WpRoutes;
}

/* ───────────────────────────── handler signatures (the vertical seam) ─────────────────────── */

/**
 * The tool-handler signature every vertical WP implements and `registry.attachHandler(name, fn)`s.
 * `args` is the (zod-parsed at the SDK boundary, but typed `unknown` here) tool input; the handler
 * returns the SDK's {@link CallToolResult}. Handlers receive the single {@link ToolContext}.
 */
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<CallToolResult>;

/**
 * The resource-handler signature. `uri` is the resolved request URI; `variables` carries any parsed
 * `{…}` template params. Returns the SDK resource-read result shape (structural).
 */
export type ResourceHandler = (
  uri: URL,
  variables: Record<string, string | string[]>,
  ctx: ToolContext,
) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>;

/**
 * The prompt-handler signature. `args` is the (string-valued) prompt args; returns the SDK prompt
 * result shape (structural).
 */
export type PromptHandler = (
  args: Record<string, string>,
  ctx: ToolContext,
) => Promise<{
  messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>;
}>;

/* ───────────────────────────── the ToolContext ────────────────────────────────────────────── */

/**
 * The SINGLE runtime object every handler receives (§Interface / §Detailed Requirements 6). Composed
 * once by {@link buildContext} and shared across all handlers for a server instance.
 */
export interface ToolContext {
  /** REST access — the WP-F02 route wrappers bound to the per-site client. */
  readonly wp: WpRoutes;
  /** Memoized site-capability probe (gate atomic / pro / design writes on this). */
  readonly capabilities: CapabilitiesCache;
  /** Live tool-surface driver (dynamic enable + `sendToolListChanged`). */
  readonly surface: SurfaceController;
  /** The WP-F04 data-driven registry (descriptors + enable/disable bookkeeping). */
  readonly registry: ToolRegistry;
  /** Elicitation helper (flat-primitive schema; destructive-op confirm gating). */
  readonly elicit: ElicitFn;
  /** Stderr-only logger (stdout reserved for the stdio transport). */
  readonly logger: Logger;
}

/** Inputs {@link buildContext} composes into a {@link ToolContext}. */
export interface BuildContextDeps {
  /** REST facade (from {@link bindRoutes}). */
  wp: WpRoutes;
  capabilities: CapabilitiesCache;
  surface: SurfaceController;
  registry: ToolRegistry;
  elicit: ElicitFn;
  /** Optional logger override (defaults to {@link stderrLogger}). */
  logger?: Logger;
}

/**
 * Compose the {@link ToolContext} from the WP-F02 REST facade, the cache, surface, registry, and
 * elicit helper (§Interface). The composition root ({@link buildServer}) calls this once.
 */
export function buildContext(deps: BuildContextDeps): ToolContext {
  return {
    wp: deps.wp,
    capabilities: deps.capabilities,
    surface: deps.surface,
    registry: deps.registry,
    elicit: deps.elicit,
    logger: deps.logger ?? stderrLogger,
  };
}
