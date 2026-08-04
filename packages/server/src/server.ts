/**
 * WP-T01 — the server-core COMPOSITION ROOT (`buildServer`) + the bin seam (`main`).
 *
 * Turns WP-F04's data-only catalog/registry into a live `McpServer` (@modelcontextprotocol/sdk ^1.29,
 * Contract 15 §1). It is the GLUE between F04 (data) and the SDK; it holds NO per-tool logic and NO
 * REST URLs — the only tool-specific knowledge is "look up the attached handler and call it with ctx"
 * (§Implementation Notes; 01-architecture.md §1.2 "Server core … Touch WP directly: NO", §4.3
 * data-driven registry: tool files never edit this file).
 *
 * `buildServer`:
 *   a. constructs the `McpServer` with `capabilities { tools:{listChanged:true}, resources:{}, prompts:{} }`;
 *   b. reads the WP-F04 registry and `server.registerTool(name, {…}, wrappedHandler)` for EVERY tool —
 *      the wrapper resolves the attached handler lazily (so registration order is irrelevant and a
 *      missing handler degrades to a clear "handler not registered" isError, WP-F04 §7);
 *   c. registers resources (`registerResource`/`ResourceTemplate`) + prompts (`registerPrompt`);
 *   d. applies the lean/full profile by `disable()`-ing the non-enabled set (meta-trio always enabled);
 *   e. returns `{ server, surface, ctx }`.
 *
 * `main(server)` is the seam WP-F01's `index.ts` lazily imports: it reads env ONCE (Contract 15 §2.10),
 * constructs the WP-F02 client + `WpRoutes`, calls `buildServer`, then `startTransport` (WP-T02).
 *
 * Call sequence WP-F01's index.ts matches:
 *   parse env once → construct WpClient + WpRoutes → buildServer(deps) → startTransport(server, cfg).
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { makeErrorPayload, ErrorCodes } from '@elementor-ultra/shared';

import {
  createToolRegistry,
  HandlerNotRegisteredError,
  type ToolRegistry,
} from './catalog/registry.js';
import { TOOL_NAME_PATTERN, type ToolDescriptor } from './catalog/tools.js';
import { RESOURCE_DESCRIPTORS } from './catalog/resources.js';
import { PROMPT_DESCRIPTORS } from './catalog/prompts.js';
import {
  resolveProfile,
  retiredToolNames,
  LEAN_STAR_TOOLS,
  type UltraToolsProfile,
} from './catalog/profiles.js';
import { attachPageHandlers } from './tools/page.js';
import { attachWidgetHandlers } from './tools/widget.js';
import { attachOpsHandlers } from './tools/ops.js';
import { attachMetaHandlers } from './tools/meta.js';
import { attachDiscoveryHandlers } from './tools/discovery.js';
import { attachCapabilitiesHandlers } from './tools/discovery-capabilities.js';
import { attachMediaHandlers } from './tools/media.js';
import { attachNavHandlers } from './tools/nav.js';
import { attachTemplatesHandlers } from './tools/templates.js';
import { attachDesignHandlers } from './tools/design.js';
import { attachThemeHandlers } from './tools/pro/theme.js';
import { attachPopupHandlers } from './tools/pro/popup.js';
import { attachWooHandlers } from './tools/pro/woo.js';
import { attachFormHandlers } from './tools/pro/form.js';
import { attachLoopHandlers } from './tools/pro/loop.js';
import { attachDynamicHandlers } from './tools/pro/dynamic.js';
import { attachConvertHandlers } from './tools/convert.js';

import { WpClient } from './wp/client.js';
import { toToolErrorResult } from './wp/errors.js';
import type { SiteConfig } from './wp/types.js';

import {
  bindRoutes,
  buildContext,
  stderrLogger,
  type Logger,
  type ToolContext,
  type ToolHandler,
} from './runtime/context.js';
import { CapabilitiesCache } from './runtime/capabilities-cache.js';
import { SurfaceController, type SurfaceToolHandle } from './runtime/surface.js';
import { makeElicitFn } from './runtime/elicit.js';
import { startTransport, type TransportConfig } from './transport/select.js';

/* ───────────────────────────── server identity ────────────────────────────────────────────── */

/** The MCP server name (matches the bin id WP-F01's `index.ts` uses). */
export const SERVER_NAME = 'elementor-ultra-mcp';
/** The MCP server version. */
export const SERVER_VERSION = '1.0.0';

/* ───────────────────────────── buildServer deps + result ──────────────────────────────────── */

/** Inputs the composition root needs (parsed config is passed in; env is read ONCE in `main`). */
export interface BuildServerDeps {
  /** Per-site REST connection config (WP-F02). */
  site: SiteConfig;
  /** Resolved tool profile (from `resolveProfile(process.env.ULTRA_TOOLS)` — read once in `main`). */
  profile: UltraToolsProfile;
  /** Optional registry override (defaults to the full frozen catalog). */
  registry?: ToolRegistry;
  /** Optional pre-constructed `McpServer` (the bin seam passes the one `index.ts` built). */
  server?: McpServer;
  /** Optional `WpClient` override (tests inject a stub fetch via the client). */
  client?: WpClient;
  /** Optional logger override (defaults to the stderr-only logger). */
  logger?: Logger;
}

/** The wired server + its live surface driver + the shared handler context. */
export interface BuiltServer {
  server: McpServer;
  surface: SurfaceController;
  ctx: ToolContext;
}

/* ───────────────────────────── buildServer (composition root) ─────────────────────────────── */

/**
 * Compose the live MCP server from the frozen catalog (§Acceptance Criteria). Registers every
 * tool/resource/prompt, applies the profile (disable non-★ at boot; `full` enables all), and returns
 * the wired server. Called by `main` (and directly by tests with a stub client/registry).
 */
export function buildServer(deps: BuildServerDeps): BuiltServer {
  const logger = deps.logger ?? stderrLogger;
  const registry = deps.registry ?? createToolRegistry();

  // (a0) Attach the implemented vertical handlers to the registry so the SHIPPED bin is callable.
  // The registry's wrapped handlers resolve lazily at CALL time, but the spine MUST wire the verticals
  // it ships with — otherwise every tools/call returns "handler not yet attached" (the gap the Wave-6
  // MVP launcher worked around). `attachHandler` overwrites, so this is idempotent if a test or a future
  // wave pre-attached; verticals NOT yet built (Pro/convert/batch) stay unattached and degrade gracefully
  // via handlerNotRegisteredResult. Adding a new vertical = one more call here (the parallelism principle:
  // each tool module owns its `attach*Handlers`; the spine just invokes them).
  attachPageHandlers(registry);
  attachWidgetHandlers(registry);
  attachOpsHandlers(registry);
  attachMetaHandlers(registry);
  attachDiscoveryHandlers(registry);
  // WP-F05 site-capabilities probe (★, most-called tool) — owned by tools/discovery-capabilities.ts,
  // NOT by attachDiscoveryHandlers (which intentionally skips it). Must be wired here or it boots
  // unattached.
  attachCapabilitiesHandlers(registry);
  attachMediaHandlers(registry);
  attachNavHandlers(registry);
  attachTemplatesHandlers(registry);
  attachDesignHandlers(registry);
  // WP-R07 Pro theme-builder tools (NON-★; registered disabled at boot, enabled via tools.search).
  attachThemeHandlers(registry);
  // WP-R08 Pro popup tools (NON-★; registered disabled at boot, enabled via tools.search).
  attachPopupHandlers(registry);
  // WP-R12 Pro WooCommerce tool (NON-★; registered disabled at boot, enabled via tools.search).
  attachWooHandlers(registry);
  // WP-R09 Pro Forms tools (NON-★; registered disabled at boot, enabled via tools.search).
  attachFormHandlers(registry);
  // WP-R10 Pro Loop Builder tools (NON-★; registered disabled at boot, enabled via tools.search).
  attachLoopHandlers(registry);
  // WP-R11 Pro Dynamic-tag tools (NON-★; registered disabled at boot, enabled via tools.search).
  attachDynamicHandlers(registry);
  // WP-H11 the flagship HTML→native convert tools (html_to_tree/html_to_page ★; fidelity_check non-★).
  // The orchestrator enforces the LOCKED never-auto-commit flow (commit-gated + elicitation confirm).
  attachConvertHandlers(registry);

  // (a) Construct (or reuse) the McpServer with tools.listChanged advertised (§Detailed Requirements 1a).
  const server =
    deps.server ??
    new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
    );

  // The REST client + bound route facade (WP-F02). `main` builds the client from env; tests inject one.
  const client = deps.client ?? new WpClient({ site: deps.site });
  const wp = bindRoutes(client);

  // The memoized capability probe (one fetch per session, gates atomic/pro/design writes, M6).
  const capabilities = new CapabilitiesCache(() => wp.siteCapabilities());

  // Elicitation: bound to the SDK low-level server; it probes client support at CALL time and declines
  // safely when the client cannot elicit (destructive ops without `confirm:true` are then refused).
  const elicit = makeElicitFn(server.server);

  // The live SDK tool handles, populated below at registration. The SurfaceController holds the map by
  // reference, so handles registered in step (b) are visible to it for runtime enable/disable (§5.3).
  const handles = new Map<string, SurfaceToolHandle>();
  const surface = new SurfaceController(server, registry, handles);

  // The single context every handler receives (§Detailed Requirements 6).
  const ctx = buildContext({ wp, capabilities, surface, registry, elicit, logger });

  // (b) Register EVERY tool with a lazily-resolving wrapped handler — except RETIRED tools
  //     (catalog/profiles.ts RETIRED_TOOLS): those stay in the frozen catalog but are never
  //     registered, so no profile, tools.search, or surface enable() can surface them.
  const retired = new Set(retiredToolNames());
  if (retired.size > 0) {
    logger.info('retired tools skipped at registration', { tools: [...retired] });
  }
  for (const descriptor of registry.listDescriptors()) {
    if (retired.has(descriptor.name)) {
      continue;
    }
    assertValidName(descriptor.name);
    const handle = registerTool(server, registry, descriptor, ctx);
    handles.set(descriptor.name, handle);
  }

  // (c) Register resources + prompts (skeleton read/body until the resource/prompt WPs attach handlers).
  registerResources(server, logger);
  registerPrompts(server);

  // (d) Apply the profile: disable the non-enabled set (meta-trio stays enabled). Boot is BEFORE
  //     connect, so no listChanged is emitted here (the SurfaceController drives runtime emits, §5.3).
  applyProfileAtBoot(registry, handles, deps.profile, logger);

  return { server, surface, ctx };
}

/* ───────────────────────────── tool registration ─────────────────────────────────────────── */

/**
 * Register one tool against the live `McpServer`, returning its {@link RegisteredTool} handle. The
 * wrapped handler resolves the attached vertical handler at CALL time (lazy — registration order is
 * irrelevant): an unattached tool returns a clear "handler not registered" isError so the server boots
 * before every vertical lands (§Detailed Requirements 1b; WP-F04 §7).
 */
function registerTool(
  server: McpServer,
  registry: ToolRegistry,
  descriptor: ToolDescriptor,
  ctx: ToolContext,
): RegisteredTool {
  const wrapped = async (...callArgs: unknown[]): Promise<CallToolResult> => {
    // SDK calls (args, extra) for tools with an inputSchema; (extra) for empty-schema tools. The first
    // arg is the parsed tool input (or the extra for no-input tools — handlers ignore it then).
    const args = callArgs.length > 1 ? callArgs[0] : {};
    if (!registry.hasHandler(descriptor.name)) {
      return handlerNotRegisteredResult(descriptor.name);
    }
    try {
      // Resolve the attached vertical handler and INJECT the shared ctx (the runtime ToolHandler
      // signature is `(args, ctx) => Promise<CallToolResult>`; WP-F04 stores it under the loose
      // `(args) => unknown` type, so we re-type to the runtime signature to pass ctx, §Interface).
      const handler = registry.getHandler(descriptor.name) as unknown as ToolHandler;
      const result = await handler(args, ctx);
      return result;
    } catch (error: unknown) {
      if (error instanceof HandlerNotRegisteredError) {
        return handlerNotRegisteredResult(descriptor.name);
      }
      throw error;
    }
  };

  // Cast to the SDK ToolCallback shape: our wrapper accepts the variadic (args, extra) the SDK passes.
  return server.registerTool(
    descriptor.name,
    {
      title: descriptor.title,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      outputSchema: descriptor.outputSchema,
      annotations: descriptor.annotations,
    },
    wrapped,
  );
}

/** Build the "handler not registered" isError result (WP-F04 §7 / Contract 12 §5). */
function handlerNotRegisteredResult(name: string): CallToolResult {
  const payload = makeErrorPayload(
    ErrorCodes.INTERNAL_ERROR,
    `Tool "${name}" is registered but its handler is not yet attached (the catalog can boot before every vertical lands). This tool is not callable in this build.`,
  );
  // `ToolResult` (WP-F05) is the structural `CallToolResult` content shape; cast to the SDK's nominal
  // type (which carries an extra index signature) for the handler return.
  return toToolErrorResult(payload) as CallToolResult;
}

/* ───────────────────────────── resource + prompt registration ────────────────────────────── */

/**
 * Register the frozen resource catalog (13-tool-catalog.md §2). Static URIs via `registerResource`;
 * parametric (`{type}`/`{id}`) URIs via `ResourceTemplate`. Resources resolve their attached handler
 * the same way tools do; until a resource WP lands, the read returns a clear "not yet wired" message.
 * SKELETON: the live read callbacks delegate to handlers attached by the resource WPs (none yet).
 */
function registerResources(server: McpServer, logger: Logger): void {
  for (const descriptor of RESOURCE_DESCRIPTORS) {
    const config = { mimeType: descriptor.mimeType };
    const readCallback = (
      uri: URL,
    ): { contents: Array<{ uri: string; mimeType: string; text: string }> } => {
      logger.warn('resource read attempted before a handler is wired', { uri: descriptor.uri });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: descriptor.mimeType,
            text: JSON.stringify({
              code: ErrorCodes.INTERNAL_ERROR,
              message: `Resource "${descriptor.uri}" is registered but not yet wired in this build.`,
            }),
          },
        ],
      };
    };
    if (descriptor.template) {
      const template = new ResourceTemplate(descriptor.uri, { list: undefined });
      server.registerResource(descriptor.name, template, config, readCallback);
    } else {
      server.registerResource(descriptor.name, descriptor.uri, config, readCallback);
    }
  }
}

/**
 * Register the frozen prompt catalog (13-tool-catalog.md §3) via `registerPrompt`. SKELETON: each
 * prompt returns a clear "not yet wired" message until a prompt WP attaches the real body.
 */
function registerPrompts(server: McpServer): void {
  for (const descriptor of PROMPT_DESCRIPTORS) {
    server.registerPrompt(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        argsSchema: descriptor.argsSchema,
      },
      () => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Prompt "${descriptor.name}" is registered but its body is not yet wired in this build.`,
            },
          },
        ],
      }),
    );
  }
}

/* ───────────────────────────── profile application (§5.2 / §5.4) ──────────────────────────── */

/**
 * Apply the profile at BOOT (§Detailed Requirements 1d / 2), derived from the registry's OWN descriptor
 * flags so any registry (the real catalog or a stub) is driven consistently (§5.2/§5.4):
 *  - `full` ⇒ every registered tool is enabled;
 *  - `lean` ⇒ a tool is enabled iff `star === true` OR `meta === true` (the ★ set + always-on meta-trio).
 *
 * Non-enabled tools are `disable()`d — flipping the LIVE SDK handle AND mirroring into the registry
 * bookkeeping. The meta-trio is ALWAYS enabled (never disabled). No `sendToolListChanged` is emitted at
 * boot (the server is not yet connected; runtime emits are the SurfaceController's, §5.3).
 */
function applyProfileAtBoot(
  registry: ToolRegistry,
  handles: Map<string, SurfaceToolHandle>,
  profile: UltraToolsProfile,
  logger: Logger,
): void {
  let enabledCount = 0;
  let disabledCount = 0;
  for (const descriptor of registry.listDescriptors()) {
    const handle = handles.get(descriptor.name);
    if (handle === undefined) {
      continue;
    }
    const shouldEnable = profile === 'full' || descriptor.star === true || descriptor.meta === true;
    if (shouldEnable) {
      if (!handle.enabled) {
        handle.enabled = true; // set directly (no SDK auto-emit); boot is pre-connect anyway.
        registry.enable(descriptor.name);
      }
      enabledCount += 1;
    } else if (handle.enabled) {
      handle.enabled = false; // set directly (no SDK auto-emit); boot is pre-connect anyway.
      registry.disable(descriptor.name); // meta-trio is exempt inside the registry.
      disabledCount += 1;
    }
  }
  logger.info('tool profile applied', {
    profile,
    enabled: enabledCount,
    disabled: disabledCount,
  });
}

/* ───────────────────────────── boot assertions (dev, §Detailed Requirements 7) ────────────── */

/** Assert a tool name matches the frozen pattern `^[A-Za-z0-9_.-]{1,128}$` (§0.2). */
function assertValidName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid tool name "${name}" (must match ${TOOL_NAME_PATTERN.source}).`);
  }
}

/**
 * Dev boot assertions (§Detailed Requirements 7): the enabled-at-boot set for `lean` equals the WP-F04
 * ★ set (+ always-on meta-trio) and the meta-trio is enabled. Returns the enabled names for the caller
 * to log. Throws if the live surface diverges from the frozen profile.
 */
export function assertLeanBoot(built: BuiltServer): string[] {
  const enabledNames = new Set(built.surface.enabledNames());
  const metaNames = built.ctx.registry
    .listDescriptors()
    .filter((d) => d.meta === true)
    .map((d) => d.name);
  const expected = new Set<string>([...LEAN_STAR_TOOLS, ...metaNames]);

  for (const name of expected) {
    if (!enabledNames.has(name)) {
      throw new Error(`Boot assertion failed: expected lean tool "${name}" to be enabled.`);
    }
  }
  for (const name of metaNames) {
    if (!enabledNames.has(name)) {
      throw new Error(`Boot assertion failed: meta-trio tool "${name}" must always be enabled.`);
    }
  }
  return [...enabledNames];
}

/* ───────────────────────────── main (the WP-F01 bin seam) ─────────────────────────────────── */

/**
 * The entry the WP-F01 `index.ts` lazily imports + calls (`core.main(server)`). It reads env ONCE
 * (Contract 15 §2.10 — `WP_URL`/`WP_USER`/`WP_APP_PASSWORD`/`ULTRA_TOOLS`/`MCP_TRANSPORT`), constructs
 * the WP-F02 client + `WpRoutes`, builds the server, runs the dev boot assertions, and starts the
 * transport (WP-T02; stdio default). `index.ts` constructs the bare `McpServer` and passes it in —
 * `buildServer` reuses it (so the bin's server name/version is preserved).
 *
 * @param server The `McpServer` constructed by `index.ts` (reused as the wired server).
 */
export async function main(server: McpServer): Promise<void> {
  const site = readSiteConfigFromEnv();
  const profile = resolveProfile(process.env['ULTRA_TOOLS']);
  const transport = readTransportConfigFromEnv();

  const built = buildServer({ site, profile, server });

  // Dev boot assertions for the lean profile (§Detailed Requirements 7 / Acceptance Criteria).
  if (profile === 'lean') {
    assertLeanBoot(built);
  }

  // M-f (contract 18 §7): HTTP mode gets a per-session SERVER FACTORY so concurrent sessions each
  // hold their own Protocol instance — a new `initialize` no longer evicts the previous session.
  // The first session reuses the already-built (and boot-asserted) server; later sessions build
  // fresh ones from the same env-derived config.
  if (transport.mode === 'http') {
    let firstSession: McpServer | undefined = built.server;
    const factory = (): McpServer => {
      if (firstSession !== undefined) {
        const reuse = firstSession;
        firstSession = undefined;
        return reuse;
      }
      return buildServer({ site, profile }).server;
    };
    await startTransport(factory, transport);
  } else {
    await startTransport(built.server, transport);
  }
  stderrLogger.info('elementor-ultra-mcp server started', {
    transport: transport.mode,
    profile,
    site: site.url,
  });
}

/**
 * Read the per-site config from env ONCE (Contract 15 §2.10). The bin (`index.ts`) already guards that
 * the three required vars are present before calling `main`; this re-reads them to construct the
 * {@link SiteConfig} (the Basic-auth token is `base64("user:app_password")`, 10-rest-api.md §0.2).
 */
function readSiteConfigFromEnv(): SiteConfig {
  const url = (process.env['WP_URL'] ?? '').trim();
  const mcpApiKey = (process.env['WP_MCP_API_KEY'] ?? '').trim();
  const user = (process.env['WP_USER'] ?? '').trim();
  const appPassword = process.env['WP_APP_PASSWORD'] ?? '';

  if (url === '') {
    throw new Error('Missing required env: WP_URL.');
  }

  // PHASE 2 (T1): prefer the additive X-MCP-API-Key vector when configured; else fall back to
  // Basic (WP_USER + WP_APP_PASSWORD) for the standalone/dev path.
  if (mcpApiKey !== '') {
    return { url, mcpApiKey };
  }

  if (user === '' || appPassword === '') {
    throw new Error(
      'Missing required env: set WP_MCP_API_KEY, or WP_USER + WP_APP_PASSWORD (with WP_URL).',
    );
  }
  const basicToken = Buffer.from(`${user}:${appPassword}`, 'utf8').toString('base64');
  return { url, basicToken };
}

/** Read the transport selection from env ONCE (`MCP_TRANSPORT`; stdio default, WP-T02). */
function readTransportConfigFromEnv(): TransportConfig {
  const mode = (process.env['MCP_TRANSPORT'] ?? 'stdio').trim().toLowerCase();
  if (mode === 'http') {
    const port = Number.parseInt(process.env['MCP_HTTP_PORT'] ?? '3000', 10);
    const host = (process.env['MCP_HTTP_HOST'] ?? '').trim();
    return {
      mode: 'http',
      http: {
        port: Number.isFinite(port) ? port : 3000,
        ...(host !== '' ? { host } : {}),
      },
    };
  }
  return { mode: 'stdio' };
}
