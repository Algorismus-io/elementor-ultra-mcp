/**
 * stdio transport (WP-T02) — local dev / Claude Desktop.
 *
 * Connects an already-built `McpServer` (from WP-T01 `buildServer`) to the
 * standard `StdioServerTransport`. This module is PURE PLUMBING: it contains no
 * business logic (01-architecture.md §1.2 "Transport ... MUST NOT contain
 * business logic"; module-boundary table row "Transport").
 *
 * SDK pin (LOCKED, Contract 15 §1 / RESEARCH.md §3.2): `@modelcontextprotocol/sdk@^1.29`.
 * Transports are deep `.js` imports in 1.x; verified against the installed
 * `@modelcontextprotocol/sdk@1.29.0` `server/stdio.js` export.
 *
 * STDERR-ONLY DIAGNOSTICS (LOCKED, WP-T02 req. 1 / Implementation Notes):
 *   The SDK reads stdin and writes the JSON-RPC stream to stdout. ANY other
 *   write to stdout corrupts that stream. Every diagnostic / log line in the
 *   server core (the WP-T01 logger) MUST go to `process.stderr`, never
 *   `process.stdout` / `console.log`. This module never writes stdout itself.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { TransportHandle } from './select.js';

/**
 * Connect `server` over stdio.
 *
 * Constructs a `StdioServerTransport`, attaches it to the server
 * (`server.connect` starts the transport and begins reading stdin), and returns
 * a handle whose `close()` tears the connection down.
 *
 * @param server - the built `McpServer` (injected by `index.ts`; WP-T01 owns its construction).
 * @returns a handle to close the stdio transport.
 */
export async function startStdio(server: McpServer): Promise<TransportHandle> {
  const transport = new StdioServerTransport();
  // `server.connect` takes ownership of the transport and calls `transport.start()`,
  // which begins listening on stdin (SDK 1.29 `server/mcp.js` -> shared/protocol.connect).
  await server.connect(transport);

  return {
    close: async (): Promise<void> => {
      // Closing the server also closes the transport it owns; closing the
      // transport directly as well is a harmless idempotent no-op on a closed
      // stream. We close the server so the process can exit cleanly.
      await server.close();
    },
  };
}
