/**
 * Streamable HTTP transport (WP-T02) — hosted / editor use.
 *
 * Stands up a Node `http` listener that wires inbound MCP frames to the SDK's
 * `StreamableHTTPServerTransport`. Two modes (01-architecture.md §6.1,
 * Contract 15 §1, RESEARCH.md §3.2):
 *
 *   - STATEFUL (default): one transport per MCP session, keyed by the SDK-minted
 *     `mcp-session-id`. `POST /mcp` with an `initialize` request mints a new
 *     session (via `sessionIdGenerator`) and stores its transport in a Map;
 *     subsequent `POST`/`GET`/`DELETE` reuse the transport via the
 *     `mcp-session-id` header. `GET` serves the server->client SSE stream;
 *     `DELETE`/transport-close removes the session from the Map.
 *   - STATELESS (`stateful: false`): a fresh `StreamableHTTPServerTransport`
 *     with `sessionIdGenerator: undefined` is created per request, connected,
 *     used to handle the request, then torn down (serverless).
 *
 * SESSION/SERVER PAIRING (SDK 1.29 invariant): a `Protocol` instance (which
 * `McpServer` wraps) holds exactly ONE transport — `protocol.js connect()`
 * throws `Already connected to a transport...` on a second `connect()`. The
 * SDK's own stateful guidance is "use a separate Protocol instance per
 * connection", so:
 *
 *   - When a {@link McpServerFactory} is injected, every session (stateful) /
 *     request (stateless) gets its OWN freshly built `McpServer`, connected to
 *     its own transport and dropped when the transport closes. This is the
 *     real multi-session mode.
 *   - When a single pre-built `McpServer` is injected (the legacy seam used by
 *     `startTransport`), only one session can be live at a time. The transport
 *     currently occupying the shared Protocol's slot is tracked in a dedicated
 *     variable (NOT just the sessions Map — a transport occupies the slot from
 *     the moment `connect()` succeeds, even when the SDK then rejects the
 *     request without ever minting a session: non-initialize first POST,
 *     malformed JSON, wrong `Accept`). A new `initialize` EVICTS whatever
 *     transport holds the slot (closing it frees the server via the SDK's
 *     `_onclose`), so neither a dropped client (one that vanished without
 *     `DELETE` — `transport.onclose` only fires on explicit close) nor a
 *     rejected pre-session request can wedge the process forever; and any
 *     transport that finishes `handleRequest` without a session id is closed
 *     immediately. Stateless requests are serialized for the same reason: each
 *     waits for the previous request's transport to finish closing before
 *     connecting, so the `res.on('close') -> transport.close()` teardown can
 *     never race the next `connect` into a 500.
 *
 * This module is PURE PLUMBING — no business logic (01-architecture.md §1.2;
 * module-boundary table row "Transport"). It does NOT enforce auth: the PHP
 * `permission_callback` is the security boundary and the OUTBOUND WP-F02 client
 * forwards `Authorization: Basic ...`; this inbound transport only relays MCP
 * frames (WP-T02 req. 5; 01-architecture.md §6.1). It binds localhost by default
 * (local/dev target) and does NOT enforce HTTPS.
 *
 * SDK pin (LOCKED): `@modelcontextprotocol/sdk@^1.29`; verified against the
 * installed `@modelcontextprotocol/sdk@1.29.0` `server/streamableHttp.js`
 * (`StreamableHTTPServerTransport({ sessionIdGenerator, onsessioninitialized })`,
 * `handleRequest(req, res)`, `sessionId`, `onclose`) and `shared/protocol.js`
 * (`connect()` chains a pre-set `transport.onclose` and rejects a second
 * transport; `close()` only closes the current transport).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { TransportHandle } from './select.js';

/** The path every MCP HTTP frame is routed through (architecture §6.1). */
const MCP_PATH = '/mcp';

/** The header the SDK uses to carry the session id (MCP Streamable HTTP spec). */
const SESSION_HEADER = 'mcp-session-id';

/** Default bind host: localhost only (local/dev target; WP-T02 req. 5). */
const DEFAULT_HOST = '127.0.0.1';

/**
 * Builds a fresh `McpServer` for one session (stateful) or one request
 * (stateless). The SDK allows exactly one transport per `Protocol` instance,
 * so concurrent sessions REQUIRE a factory (typically `buildServer`-based).
 */
export type McpServerFactory = () => McpServer;

/** Options for {@link startHttp}. */
export interface HttpTransportOptions {
  /** TCP port to listen on (required). */
  port: number;
  /** Bind host; defaults to `127.0.0.1` (localhost). */
  host?: string;
  /**
   * Session mode. `true` (default) keeps a `Map<sessionId, transport>` for
   * editor-style sessions; `false` uses `sessionIdGenerator: undefined` and a
   * fresh transport per request (stateless / serverless).
   */
  stateful?: boolean;
}

/** One live stateful session: its transport and the server it is connected to. */
interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/** Extracts the `mcp-session-id` request header as a single string, if present. */
function sessionIdOf(req: IncomingMessage): string | undefined {
  const raw = req.headers[SESSION_HEADER];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

/** Returns the request pathname (without query), tolerating a missing/relative URL. */
function pathnameOf(req: IncomingMessage): string {
  // `req.url` is request-target relative (e.g. "/mcp?x=1"); a dummy base lets us
  // parse it with the WHATWG URL parser without trusting the Host header.
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.pathname;
}

/** Writes a small JSON error response (used only for routing-level rejects). */
function writeJsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/**
 * Start the Streamable HTTP transport.
 *
 * @param server - either a {@link McpServerFactory} (preferred: a fresh
 *   `McpServer` per session/request, enabling concurrent sessions) or a single
 *   pre-built `McpServer` (legacy seam: one live session at a time, with
 *   stale-session eviction on a new `initialize`).
 * @param opts - port (required), host (default `127.0.0.1`), stateful (default `true`).
 * @returns a handle whose `close()` stops the listener and drains all sessions.
 */
export async function startHttp(
  server: McpServer | McpServerFactory,
  opts: HttpTransportOptions,
): Promise<TransportHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const stateful = opts.stateful ?? true;

  // Resolve the server source ONCE. With a factory every connection gets its
  // own Protocol instance (the SDK 1.29 stateful pattern); with a single
  // injected server we must never hold two transports against it.
  let makeSessionServer: McpServerFactory;
  let sharesOneServer: boolean;
  if (typeof server === 'function') {
    makeSessionServer = server;
    sharesOneServer = false;
  } else {
    const single = server;
    makeSessionServer = (): McpServer => single;
    sharesOneServer = true;
  }

  /** Live sessions, keyed by the SDK-reported session id (stateful mode only). */
  const sessions = new Map<string, SessionEntry>();

  /**
   * The transport currently occupying the shared server's single transport
   * slot (single-server stateful mode only; stays `undefined` in factory
   * mode). Tracked OUTSIDE the sessions Map because a transport holds the slot
   * from the moment `connect()` succeeds — even when the SDK then rejects the
   * request WITHOUT minting a session (non-initialize first POST, malformed
   * JSON body, wrong `Accept` header), in which case `onsessioninitialized`
   * never fires and the transport never appears in the Map. Evicting via this
   * variable (set after a successful connect, cleared in the transport's
   * `onclose`) is what keeps such pre-session rejects from permanently
   * bricking every subsequent initialize with a 409.
   */
  let connectedTransport: StreamableHTTPServerTransport | undefined;

  /**
   * Tail of the stateless request chain (single-server mode only): each
   * request awaits the previous one's transport teardown before connecting,
   * because the shared Protocol instance can hold only one transport.
   */
  let statelessTail: Promise<void> = Promise.resolve();

  /**
   * Handle one request in STATEFUL mode: reuse the transport named by the
   * `mcp-session-id` header, or (for an initialize POST with no id) mint a new
   * session, connect a server to it, and store the pair in the Map.
   */
  async function handleStateful(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = sessionIdOf(req);

    if (id !== undefined) {
      const existing = sessions.get(id);
      if (existing === undefined) {
        writeJsonError(res, 404, `Unknown MCP session id: ${id}`);
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    // No session id present.
    if (req.method !== 'POST') {
      // GET (SSE) and DELETE require an existing session id; only an
      // initialize POST may arrive without one.
      writeJsonError(res, 400, `Missing ${SESSION_HEADER} header`);
      return;
    }

    // SINGLE-SERVER mode: the shared Protocol instance can hold only one
    // transport, so a new initialize EVICTS whatever transport currently holds
    // the slot — whether it minted a session (client dropped WITHOUT `DELETE`)
    // or never did (the SDK rejected its request pre-session, so it has no Map
    // entry). Closing it fires the SDK's `_onclose`, which clears the server's
    // `_transport` and makes it reconnectable; our chained `onclose` also
    // deletes any sessions-Map entry and clears `connectedTransport`.
    if (sharesOneServer && connectedTransport !== undefined) {
      const stale = connectedTransport;
      connectedTransport = undefined;
      await stale.close().catch(() => undefined);
    }

    // New session: the SDK mints the id via `sessionIdGenerator`, surfaces it on
    // `transport.sessionId`, and fires `onsessioninitialized`; we key the Map by
    // that id (WP-T02 Implementation Notes — "key the Map by the id the SDK reports").
    const sessionServer = makeSessionServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, { transport, server: sessionServer });
      },
    });

    // Remove the session from the Map when its transport closes (DELETE or drop).
    // The SDK's `Protocol.connect` CHAINS a pre-set `onclose` (ours runs first,
    // then its `_onclose` clears `_transport`), so this survives `connect`.
    // Per-session servers need no further teardown: `_onclose` aborts in-flight
    // handlers and detaches the transport, leaving the server collectable.
    transport.onclose = (): void => {
      if (connectedTransport === transport) {
        connectedTransport = undefined;
      }
      const sid = transport.sessionId;
      if (sid !== undefined) {
        sessions.delete(sid);
      }
    };

    // The SDK's `StreamableHTTPServerTransport` structurally implements `Transport`
    // but its `onclose`/`onmessage` accessors widen the optional members, which
    // `exactOptionalPropertyTypes` flags; cast to the interface it implements.
    try {
      await sessionServer.connect(transport as Transport);
    } catch (error) {
      // Two initialize POSTs racing in single-server mode can both pass the
      // eviction check; the loser gets the SDK's "Already connected" throw.
      // Surface that as a clear 409 (retryable) rather than an opaque 500.
      if (
        sharesOneServer &&
        error instanceof Error &&
        error.message.includes('Already connected')
      ) {
        writeJsonError(
          res,
          409,
          'MCP server is already serving another session (single-server mode supports one ' +
            'session at a time; inject a server factory for concurrent sessions). Retry initialize.',
        );
        return;
      }
      throw error;
    }
    if (sharesOneServer) {
      connectedTransport = transport;
    }
    try {
      await transport.handleRequest(req, res);
    } finally {
      // The SDK can reject the request AFTER connect but BEFORE minting a
      // session (non-initialize first POST -> 400, malformed JSON -> 400,
      // missing `text/event-stream` in Accept -> 406, or a thrown error). Such
      // a transport has no Map entry, so without this close it would occupy
      // the shared Protocol's slot forever and 409 every later initialize.
      // `close()` fires our `onclose`, clearing `connectedTransport`.
      if (transport.sessionId === undefined) {
        await transport.close().catch(() => undefined);
      }
    }
  }

  /**
   * Handle one request in STATELESS mode: a fresh transport per request with
   * `sessionIdGenerator: undefined`, connected, used, then torn down once the
   * response completes (serverless; WP-T02 req. 3). With a factory the server
   * is also fresh per request (fully concurrent); with a single injected
   * server, requests are serialized on its one-transport limit.
   */
  async function handleStateless(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Stateless mode = NO session id generator (the SDK's documented stateless
    // signal; streamableHttp.d.ts example shows `sessionIdGenerator: undefined`).
    // Omitting the key is equivalent: the SDK reads `options.sessionIdGenerator`
    // and treats `undefined` as "session management disabled"
    // (webStandardStreamableHttp.js:63,585). Omitting (rather than an explicit
    // `undefined`) keeps `exactOptionalPropertyTypes` happy while producing an
    // identical fresh per-request transport.
    const statelessOptions: StreamableHTTPServerTransportOptions = {};
    const transport = new StreamableHTTPServerTransport(statelessOptions);
    const requestServer = makeSessionServer();

    if (!sharesOneServer) {
      // Fresh server per request: no shared Protocol, no teardown race.
      res.on('close', () => {
        void transport.close();
      });
      await requestServer.connect(transport as Transport);
      await transport.handleRequest(req, res);
      return;
    }

    // SINGLE-SERVER mode: the shared Protocol can hold only one transport, so
    // the `res.on('close') -> transport.close()` teardown of request N must
    // FINISH before request N+1 connects — otherwise the next `connect` throws
    // "Already connected". Chain the requests; resolve the turn only after the
    // transport has fully closed.
    const closed = new Promise<void>((resolve) => {
      res.on('close', () => {
        transport.close().then(resolve, () => resolve());
      });
    });
    const turn = statelessTail.then(async (): Promise<void> => {
      try {
        await requestServer.connect(transport as Transport);
        await transport.handleRequest(req, res);
        await closed;
      } catch (error) {
        // Free the shared server even when handling failed, so the next
        // request in the chain can still connect.
        await transport.close().catch(() => undefined);
        throw error;
      }
    });
    // The stored tail must never reject (a failed request must not poison the
    // chain); the awaited `turn` still propagates the error to the 500 handler.
    statelessTail = turn.catch(() => undefined);
    await turn;
  }

  const httpServer: Server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      if (pathnameOf(req) !== MCP_PATH) {
        writeJsonError(res, 404, `Not found: only ${MCP_PATH} is served`);
        return;
      }
      const method = req.method ?? 'GET';
      if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
        writeJsonError(res, 405, `Method not allowed: ${method}`);
        return;
      }
      if (stateful) {
        await handleStateful(req, res);
      } else {
        await handleStateless(req, res);
      }
    };

    handle().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Diagnostics go to stderr only (stdout is reserved for the stdio JSON-RPC
      // stream elsewhere; keeping a single discipline avoids surprises).
      process.stderr.write(`elementor-ultra-mcp[http]: request handling error: ${message}\n`);
      writeJsonError(res, 500, 'Internal transport error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.listen(opts.port, host, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  return {
    close: async (): Promise<void> => {
      // Drain every live session transport (stateful mode); each `close()`
      // removes itself from the Map via its `onclose` handler, and the SDK's
      // chained `_onclose` detaches the paired server.
      const open = Array.from(sessions.values());
      await Promise.all(open.map((entry) => entry.transport.close()));
      sessions.clear();

      // Stop accepting connections and wait for the listener to fully close.
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
