---
id: WP-T02
title: TS transport layer — stdio + Streamable HTTP transport selection
layer: ts
phase: MVP
status: planned
depends_on: [WP-F01]
files_owned:
  - packages/server/src/transport/stdio.ts
  - packages/server/src/transport/http.ts
  - packages/server/src/transport/select.ts
  - packages/server/src/transport/http.test.ts
contract_refs:
  - spec/contracts/15-engineering-standards.md §1 (transports LOCKED, SDK pin)
  - spec/01-architecture.md §6.1 (transports / deployment topology)
  - spec/contracts/13-tool-catalog.md §0.1 (SDK shape)
estimate: M
---

## Summary

Implements the two MCP transports the product ships: `StdioServerTransport` for local/Claude Desktop use and `StreamableHTTPServerTransport` for hosted/editor use, plus a selector that picks one from config. Transports are pure plumbing — they connect an already-built `McpServer` (from WP-T01 `buildServer`) to a wire protocol and contain NO business logic (architecture §1.2 "Transport ... MUST NOT contain business logic"). WP-F01's `index.ts` calls `startTransport(server, config)`.

## Interface / Contract

Exported from `packages/server/src/transport/select.ts`:

- `type TransportConfig = { mode: 'stdio' | 'http'; http?: { port: number; host?: string; stateful?: boolean } }`.
- `startTransport(server: McpServer, config: TransportConfig): Promise<{ close: () => Promise<void> }>` — connects the server over the chosen transport and returns a close handle.

Exported from `packages/server/src/transport/stdio.ts`:

- `startStdio(server: McpServer): Promise<{ close }>` — `new StdioServerTransport()` + `await server.connect(transport)`.

Exported from `packages/server/src/transport/http.ts`:

- `startHttp(server: McpServer, opts: { port; host?; stateful? }): Promise<{ close }>` — stands up an HTTP listener wiring `StreamableHTTPServerTransport`. Stateful mode keeps a `Map<sessionId, StreamableHTTPServerTransport>`; stateless/serverless mode uses `sessionIdGenerator: undefined` (architecture §6.1, Contract 15 §1).

## Dependencies & Inputs

- WP-F01 (scaffold + `@modelcontextprotocol/sdk@^1.29` dependency + tsconfig NodeNext; owns `index.ts` which calls `startTransport`).
- SDK 1.x deep imports (LOCKED, Contract 15 §1): `@modelcontextprotocol/sdk/server/stdio.js` (`StdioServerTransport`), `@modelcontextprotocol/sdk/server/streamableHttp.js` (`StreamableHTTPServerTransport`), `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer` type). Import specifiers MUST use the `.js` deep path.
- Architecture §6.1: stdio carries `WP_URL`/`WP_USER`/`WP_APP_PASSWORD`/`ULTRA_TOOLS` (read by `index.ts`); HTTP carries the MCP endpoint URL + `Authorization: Basic ...` from the client (inbound) — but OUTBOUND auth to Tier 3 is the WP-F02 client's job; the inbound HTTP transport just relays MCP frames.
- Consumes only the `McpServer` type from the SDK; the concrete server is injected by `index.ts`. Does NOT depend on WP-T01 code (only its caller passes the built server).

NOT a WRITE WP; no REST calls; no PHP/spike dependency.

## Detailed Requirements

1. `startStdio` constructs `StdioServerTransport`, `await server.connect(transport)`, returns `{ close }`. ENFORCE stderr-only diagnostics — any stdout write outside the transport corrupts the JSON-RPC stream.
2. `startHttp` (stateful default): HTTP listener; on `POST /mcp` route to the session's `StreamableHTTPServerTransport` (new sessions mint a `sessionIdGenerator` id + store in the Map; subsequent requests reuse via the `mcp-session-id` header); `GET` serves the server→client SSE stream; `DELETE`/close removes the session (architecture §6.1).
3. `startHttp` (stateless `stateful:false`): a fresh `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per request, connect→handle→teardown (serverless).
4. `startTransport` dispatches on `config.mode`. Defaults: `mode='stdio'`; for `http`, `port` required, `host` default `127.0.0.1`, `stateful` default `true`.
5. Inbound HTTP auth: the transport does NOT enforce auth (PHP `permission_callback` is the boundary; the OUTBOUND client forwards Basic auth). Bind localhost by default (local/dev target). No HTTPS enforcement.
6. `close()` closes transport(s) + the HTTP listener; drains the session Map.
7. No `any`; strict TS.

## Implementation Notes

- 1.29 `StreamableHTTPServerTransport` takes `{ sessionIdGenerator }`; stateful uses a UUID generator and the SDK manages the `mcp-session-id` header — key the Map by the id the SDK reports.
- Per the SDK 1.29 example: one `McpServer` + per-session transports keyed by session id, calling `server.connect(transport)` per new session. Confirm against the scaffold's SDK example; cite the SDK version in a comment.
- stdio: the SDK reads stdin / writes stdout; nothing else may write stdout. Document the stderr-only rule for the WP-T01 logger.

## Acceptance Criteria

- [ ] `startStdio(server)` connects; a `tools/list` over stdio returns with no stdout corruption.
- [ ] `startHttp(server,{port})` handles initialize → session id → session reuse; SSE `GET` works; stateless mode tears down per request.
- [ ] `startTransport` selects per `config.mode` with documented defaults.
- [ ] `close()` drains sessions + stops the listener.
- [ ] No stdout writes outside the transport on stdio; no `any`; strict `tsc` + lint clean.

## Tests Required

- `transport/http.test.ts` (vitest, no WP): `startHttp` against a stub `McpServer` on an ephemeral port; assert initialize→session id→reuse, stateless path, and `close()` cleanup (fetch/supertest).
- stdio is exercised by the WP-Q Inspector smoke suite (Contract 14 §8); a thin unit assertion confirms `startStdio` connects a `StdioServerTransport`.

## Parallelization Notes

- Owns only `transport/*` — disjoint from all other WPs.
- Wave 1: imported by WP-F01's `index.ts`. Integrates with WP-T01 via the `McpServer` from `buildServer` and the `TransportConfig` shape declared here; both build concurrently.
