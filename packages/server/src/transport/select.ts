/**
 * Transport selector (WP-T02).
 *
 * Picks and starts one of the two shipped MCP transports from config:
 *   - `stdio` (default) — local dev / Claude Desktop (`startStdio`).
 *   - `http` — hosted / editor use, Streamable HTTP (`startHttp`).
 *
 * WP-F01's `index.ts` calls `startTransport(server, config)` with the built
 * `McpServer` (WP-T01 `buildServer`). This module is PURE PLUMBING — no business
 * logic (01-architecture.md §1.2; module-boundary table row "Transport").
 *
 * Defaults (WP-T02 req. 4): `mode='stdio'`; for `http`, `port` is required,
 * `host` defaults to `127.0.0.1` (inside `startHttp`), `stateful` defaults to
 * `true` (inside `startHttp`).
 *
 * This file owns the shared `TransportConfig` and `TransportHandle` types so the
 * three transport modules (and downstream WP-T01) reference one canonical shape.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { startStdio } from './stdio.js';
import { startHttp, type McpServerFactory } from './http.js';

/** Handle returned by every transport start fn; `close()` tears the transport down. */
export interface TransportHandle {
  close: () => Promise<void>;
}

/** HTTP-specific transport options (mirrors `startHttp`'s opts). */
export interface HttpModeConfig {
  /** TCP port to listen on (required in `http` mode). */
  port: number;
  /** Bind host; defaults to `127.0.0.1` (localhost). */
  host?: string;
  /** Stateful session Map (default) vs stateless per-request (serverless). */
  stateful?: boolean;
}

/**
 * Config selecting which transport to run.
 *
 * `mode: 'stdio'` ignores `http`. `mode: 'http'` requires `http.port`.
 */
export type TransportConfig = { mode: 'stdio' } | { mode: 'http'; http: HttpModeConfig };

/**
 * Connect `server` over the transport named by `config.mode` and return a close
 * handle. Dispatches on `config.mode` (WP-T02 req. 4).
 *
 * `server` may be a pre-built `McpServer` OR a factory. In `http` mode a FACTORY is the
 * multi-session path (M-f, contract 18 §7): each MCP session gets its own freshly built
 * `McpServer`, so a new `initialize` no longer evicts the previous session (the SDK allows exactly
 * one transport per Protocol instance). A single pre-built server degrades to one-live-session
 * (legacy seam). In `stdio` mode a factory is resolved once (stdio is single-session by nature).
 *
 * @param server - the built `McpServer`, or a factory building one per session (http).
 * @param config - transport selection + per-mode options.
 * @returns a handle whose `close()` stops the selected transport.
 */
export async function startTransport(
  server: McpServer | McpServerFactory,
  config: TransportConfig,
): Promise<TransportHandle> {
  switch (config.mode) {
    case 'http':
      return startHttp(server, config.http);
    case 'stdio':
      return startStdio(typeof server === 'function' ? server() : server);
    default: {
      // Exhaustiveness guard: a new mode added to the union without a case here
      // becomes a compile error (`never`), not a silent runtime fallthrough.
      const exhaustive: never = config;
      throw new Error(`Unknown transport mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}
