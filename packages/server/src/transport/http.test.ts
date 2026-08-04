/**
 * Streamable HTTP transport tests (WP-T02).
 *
 * Exercises `startHttp` (transport/http.ts) against a REAL `McpServer` from the
 * pinned SDK (`@modelcontextprotocol/sdk@^1.29`) on an ephemeral port. Using a
 * real server (not a stub) lets the full MCP `initialize` handshake actually run
 * through the `StreamableHTTPServerTransport`, which is the only way to assert the
 * stateful session lifecycle (initialize -> session id -> reuse), the stateless
 * path, and `close()` cleanup that the ticket's Acceptance Criteria require.
 *
 * The transport module under test is pure plumbing (01-architecture.md §1.2); the
 * server here is a throwaway with one trivial tool just so `tools/list` returns.
 *
 * No new dependencies: Node 20+ ships global `fetch`; the test parses the SSE
 * response the SDK emits by default (the transport does not set
 * `enableJsonResponse`, so initialize/list responses come back as
 * `text/event-stream`). A free TCP port is discovered with `node:net` and passed
 * explicitly to `startHttp` (which binds a concrete port, not `0`).
 */

import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { startHttp } from './http.js';
import { startTransport, type TransportHandle } from './select.js';

/** Latest MCP protocol version understood by the pinned SDK (sdk types.ts). */
const PROTOCOL_VERSION = '2025-11-25';

/** Both content types MUST be in Accept for a Streamable HTTP POST (sdk spec). */
const ACCEPT = 'application/json, text/event-stream';

const MCP_SESSION_HEADER = 'mcp-session-id';

/** Reserves and immediately releases an ephemeral port, returning its number. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Builds a fresh real `McpServer` with one trivial no-arg tool registered. */
function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  server.registerTool('ping', { description: 'Returns pong.' }, () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
}

/** A minimal MCP `initialize` request body. */
function initializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'vitest', version: '0.0.0' },
    },
  });
}

/** A `notifications/initialized` notification (completes the handshake). */
function initializedNotification(): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/** A `tools/list` request body. */
function toolsListBody(id: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
}

/**
 * Parses a Streamable-HTTP response body into the first JSON-RPC message it
 * carries. Handles both the SSE framing (`event: message\ndata: {...}`) the SDK
 * emits by default and a plain-JSON body, so the test does not depend on which
 * the transport chose.
 */
function parseRpc(contentType: string | null, body: string): unknown {
  if (contentType !== null && contentType.includes('text/event-stream')) {
    const dataLine = body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('data:'));
    if (dataLine === undefined) {
      throw new Error(`No SSE data line in body: ${JSON.stringify(body)}`);
    }
    return JSON.parse(dataLine.slice('data:'.length).trim());
  }
  return JSON.parse(body);
}

interface RpcResult {
  jsonrpc: string;
  id?: number;
  result?: { tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
}

interface McpResponse {
  status: number;
  sessionId: string | null;
  rpc: RpcResult;
}

/** POSTs an MCP frame to the given base URL and returns status + parsed body + headers. */
async function postMcp(base: string, body: string, sessionId?: string): Promise<McpResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: ACCEPT,
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  if (sessionId !== undefined) {
    headers[MCP_SESSION_HEADER] = sessionId;
  }
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body });
  const text = await res.text();
  const rpc: RpcResult =
    text.length > 0
      ? (parseRpc(res.headers.get('content-type'), text) as RpcResult)
      : { jsonrpc: '2.0' };
  return { status: res.status, sessionId: res.headers.get(MCP_SESSION_HEADER), rpc };
}

/**
 * POSTs a raw body with caller-controlled headers (no defaults) and returns the
 * status — for probing how the transport handles requests the SDK REJECTS
 * before minting a session (bad Accept, malformed JSON, non-initialize first
 * frame). The body is intentionally not parsed.
 */
async function postRaw(
  base: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body });
  await res.text();
  return res.status;
}

let handle: TransportHandle | undefined;

afterEach(async () => {
  if (handle !== undefined) {
    await handle.close();
    handle = undefined;
  }
});

describe('startHttp — stateful mode', () => {
  it('initializes, mints a session id, and reuses it for a follow-up tools/list', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: true });
    const base = `http://127.0.0.1:${port}`;

    // 1. initialize (no session id yet) -> SDK mints + returns a session id.
    const init = await postMcp(base, initializeBody(1));
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect(init.rpc.result).toBeDefined();
    const sid = init.sessionId as string;

    // 2. complete the handshake with the initialized notification (reuses session).
    const ack = await postMcp(base, initializedNotification(), sid);
    expect(ack.status).toBeLessThan(300);

    // 3. reuse the same session id for tools/list -> the trivial tool appears.
    const list = await postMcp(base, toolsListBody(2), sid);
    expect(list.status).toBe(200);
    const names = (list.rpc.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('ping');
  });

  it('rejects a request that carries an unknown session id', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: true });
    const base = `http://127.0.0.1:${port}`;

    const res = await postMcp(base, toolsListBody(1), 'does-not-exist');
    expect(res.status).toBe(404);
  });

  it('serves CONCURRENT sessions when given a server factory (one McpServer per session)', async () => {
    const port = await freePort();
    // Factory form: a fresh real McpServer per session — the SDK 1.29 stateful
    // pattern (one Protocol instance per connection).
    handle = await startHttp(() => buildTestServer(), { port, host: '127.0.0.1', stateful: true });
    const base = `http://127.0.0.1:${port}`;

    // Two clients initialize; BOTH must succeed (the single-server bug 500'd
    // the second with "Already connected to a transport").
    const initA = await postMcp(base, initializeBody(1));
    const initB = await postMcp(base, initializeBody(1));
    expect(initA.status).toBe(200);
    expect(initB.status).toBe(200);
    const sidA = initA.sessionId as string;
    const sidB = initB.sessionId as string;
    expect(sidA).toBeTruthy();
    expect(sidB).toBeTruthy();
    expect(sidA).not.toBe(sidB);

    // Both sessions stay live and independently usable.
    await postMcp(base, initializedNotification(), sidA);
    await postMcp(base, initializedNotification(), sidB);
    const listA = await postMcp(base, toolsListBody(2), sidA);
    const listB = await postMcp(base, toolsListBody(2), sidB);
    expect(listA.status).toBe(200);
    expect(listB.status).toBe(200);
    expect((listA.rpc.result?.tools ?? []).map((t) => t.name)).toContain('ping');
    expect((listB.rpc.result?.tools ?? []).map((t) => t.name)).toContain('ping');
  });

  it('single-server mode: a reconnect after a client drop (no DELETE) evicts the stale session instead of 500ing forever', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: true });
    const base = `http://127.0.0.1:${port}`;

    // First client initializes, then "drops" (no DELETE — onclose never fires,
    // which previously left the shared server wedged until process restart).
    const first = await postMcp(base, initializeBody(1));
    expect(first.status).toBe(200);
    const staleSid = first.sessionId as string;

    // Second initialize must succeed by evicting the stale session.
    const second = await postMcp(base, initializeBody(1));
    expect(second.status).toBe(200);
    const sid = second.sessionId as string;
    expect(sid).toBeTruthy();
    expect(sid).not.toBe(staleSid);

    // The evicted session is gone; the new one is fully usable.
    const staleRes = await postMcp(base, toolsListBody(2), staleSid);
    expect(staleRes.status).toBe(404);
    await postMcp(base, initializedNotification(), sid);
    const list = await postMcp(base, toolsListBody(3), sid);
    expect(list.status).toBe(200);
    expect((list.rpc.result?.tools ?? []).map((t) => t.name)).toContain('ping');
  });

  // The next three tests probe the PERMANENT-BRICK failure mode: in
  // single-server mode the shared server is connect()ed to a fresh transport
  // BEFORE handleRequest; when the SDK rejects the request without minting a
  // session, the transport never enters the sessions Map, so a Map-based
  // eviction guard alone never frees the shared Protocol — and EVERY later
  // initialize would 409 forever. Each probe must be rejected AND leave the
  // server fully initializable afterwards.

  it('single-server mode: a non-initialize first POST (no session id) is rejected without bricking later initializes', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: true });
    const base = `http://127.0.0.1:${port}`;

    // tools/list with no mcp-session-id: the SDK 400s ("Server not initialized")
    // AFTER the shared server was connected, without ever minting a session.
    const probe = await postRaw(base, toolsListBody(1), {
      'content-type': 'application/json',
      accept: ACCEPT,
      'mcp-protocol-version': PROTOCOL_VERSION,
    });
    expect(probe).toBe(400);

    // The orphan transport must have been closed: initialize succeeds (not 409).
    const init = await postMcp(base, initializeBody(2));
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
    const sid = init.sessionId as string;
    await postMcp(base, initializedNotification(), sid);
    const list = await postMcp(base, toolsListBody(3), sid);
    expect(list.status).toBe(200);
    expect((list.rpc.result?.tools ?? []).map((t) => t.name)).toContain('ping');
  });

  it('single-server mode: a malformed JSON body is rejected without bricking later initializes', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: true });
    const base = `http://127.0.0.1:${port}`;

    // Unparseable body: the SDK 400s (parse error) before minting a session.
    const probe = await postRaw(base, '{"jsonrpc": "2.0", "method": "initialize"', {
      'content-type': 'application/json',
      accept: ACCEPT,
      'mcp-protocol-version': PROTOCOL_VERSION,
    });
    expect(probe).toBe(400);

    const init = await postMcp(base, initializeBody(1));
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });

  it('single-server mode: an initialize with a wrong Accept header is rejected without bricking later initializes', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: true });
    const base = `http://127.0.0.1:${port}`;

    // Accept missing text/event-stream: the SDK 406s before minting a session.
    const probe = await postRaw(base, initializeBody(1), {
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
    });
    expect(probe).toBe(406);

    const init = await postMcp(base, initializeBody(2));
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeTruthy();
  });
});

describe('startHttp — stateless mode', () => {
  it('handles an initialize per request without minting a persistent session', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: false });
    const base = `http://127.0.0.1:${port}`;

    // Stateless: a fresh transport with `sessionIdGenerator: undefined` per request,
    // so no `mcp-session-id` is returned, yet the initialize still succeeds.
    const init = await postMcp(base, initializeBody(1));
    expect(init.status).toBe(200);
    expect(init.sessionId).toBeNull();
    expect(init.rpc.result).toBeDefined();
  });

  it('single-server mode: rapid sequential requests do not race teardown into a 500', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: false });
    const base = `http://127.0.0.1:${port}`;

    // Previously the res.on('close') -> transport.close() teardown of request N
    // raced request N+1's connect on the shared server ("Already connected").
    // Requests are now serialized on the single server's one-transport limit.
    for (let i = 1; i <= 3; i += 1) {
      const init = await postMcp(base, initializeBody(i));
      expect(init.status).toBe(200);
      expect(init.rpc.result).toBeDefined();
    }
  });

  it('factory mode: CONCURRENT stateless requests each get their own server', async () => {
    const port = await freePort();
    handle = await startHttp(() => buildTestServer(), { port, host: '127.0.0.1', stateful: false });
    const base = `http://127.0.0.1:${port}`;

    const results = await Promise.all([
      postMcp(base, initializeBody(1)),
      postMcp(base, initializeBody(1)),
      postMcp(base, initializeBody(1)),
    ]);
    for (const init of results) {
      expect(init.status).toBe(200);
      expect(init.rpc.result).toBeDefined();
    }
  });
});

describe('startTransport — per-session server factory (M-f, contract 18 §7)', () => {
  it('http mode with a factory serves TWO CONCURRENT sessions (a new initialize no longer evicts the previous one)', async () => {
    const port = await freePort();
    // The exact wiring `main()` now uses for http mode: a factory, through startTransport.
    handle = await startTransport(() => buildTestServer(), {
      mode: 'http',
      http: { port, host: '127.0.0.1', stateful: true },
    });
    const base = `http://127.0.0.1:${port}`;

    const initA = await postMcp(base, initializeBody(1));
    const initB = await postMcp(base, initializeBody(1));
    expect(initA.status).toBe(200);
    expect(initB.status).toBe(200);
    const sidA = initA.sessionId as string;
    const sidB = initB.sessionId as string;
    expect(sidA).not.toBe(sidB);

    // M-f guard: BOTH sessions serve tools/list — the first was NOT evicted by the second.
    await postMcp(base, initializedNotification(), sidA);
    await postMcp(base, initializedNotification(), sidB);
    const listA = await postMcp(base, toolsListBody(2), sidA);
    const listB = await postMcp(base, toolsListBody(2), sidB);
    expect(listA.status).toBe(200);
    expect(listB.status).toBe(200);
    expect((listA.rpc.result?.tools ?? []).map((t) => t.name)).toContain('ping');
    expect((listB.rpc.result?.tools ?? []).map((t) => t.name)).toContain('ping');
  });
});

describe('startHttp — routing & method guards', () => {
  it('404s a path other than /mcp', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: true });

    const res = await fetch(`http://127.0.0.1:${port}/not-mcp`, { method: 'GET' });
    await res.text();
    expect(res.status).toBe(404);
  });
});

describe('startHttp — close() cleanup', () => {
  it('drains sessions and stops the listener so the port is reusable', async () => {
    const port = await freePort();
    handle = await startHttp(buildTestServer(), { port, host: '127.0.0.1', stateful: true });
    const base = `http://127.0.0.1:${port}`;

    // Open one live session.
    const init = await postMcp(base, initializeBody(1));
    expect(init.sessionId).toBeTruthy();

    // close() must stop the listener AND drain the session Map.
    await handle.close();
    handle = undefined;

    // The listener is gone: a connection to the same port now fails to connect.
    await expect(fetch(`${base}/mcp`, { method: 'GET' })).rejects.toBeDefined();

    // And the port is free again — re-binding it succeeds.
    const rebind = createServer();
    await new Promise<void>((resolve, reject) => {
      rebind.once('error', reject);
      rebind.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => rebind.close(() => resolve()));
  });
});
