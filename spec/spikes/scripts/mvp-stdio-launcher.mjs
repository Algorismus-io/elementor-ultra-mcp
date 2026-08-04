#!/usr/bin/env node
/**
 * WAVE 6 — MVP stdio launcher.
 *
 * Boots the REAL server core (`buildServer` from packages/server/dist) over a REAL
 * StdioServerTransport, then ATTACHES the implemented vertical tool handlers to the
 * registry buildServer uses.
 *
 * WHY THIS EXISTS (and is not the shipped bin): the shipped bin's `main()`
 * (packages/server/dist/index.js → server.js) registers every catalog DESCRIPTOR but
 * never calls the `attach*Handlers(registry)` functions the tool modules export, so the
 * bin currently answers every `tools/call` with
 *   "Tool … is registered but its handler is not yet attached."
 * That is a one-call-per-vertical wiring gap in the spine (server.ts buildServer), which
 * this launcher works around WITHOUT editing any owned spine file: it constructs the same
 * real registry, attaches the real handlers, and hands it to the real `buildServer`. The
 * server core, tool wrapper, REST client, capability probe, validators, writer and CSS
 * primer are all the genuine production code paths — only the boot wiring is supplied here.
 *
 * It then connects the genuine StdioServerTransport so an MCP client can speak real
 * JSON-RPC over stdio against the real server.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PKG = resolve(__dirname, '../../../packages/server');
const DIST = join(SERVER_PKG, 'dist');
const distUrl = (p) => pathToFileURL(join(DIST, p)).href;

// Resolve the MCP SDK through the SERVER package's own dependency tree (pnpm does not hoist it
// to a node_modules visible from this scripts dir; the server package can see it).
const requireFromServer = createRequire(pathToFileURL(join(SERVER_PKG, 'package.json')));
const sdkStdioPath = requireFromServer.resolve('@modelcontextprotocol/sdk/server/stdio.js');
const { StdioServerTransport } = await import(pathToFileURL(sdkStdioPath).href);

const { buildServer } = await import(distUrl('server.js'));
const { createToolRegistry } = await import(distUrl('catalog/registry.js'));
const { resolveProfile } = await import(distUrl('catalog/profiles.js'));

const { attachPageHandlers } = await import(distUrl('tools/page.js'));
const { attachWidgetHandlers } = await import(distUrl('tools/widget.js'));
const { attachOpsHandlers } = await import(distUrl('tools/ops.js'));
const { attachMetaHandlers } = await import(distUrl('tools/meta.js'));
const { attachDiscoveryHandlers } = await import(distUrl('tools/discovery.js'));
const { attachMediaHandlers } = await import(distUrl('tools/media.js'));

function readSiteConfigFromEnv() {
  const url = (process.env.WP_URL ?? '').trim();
  const user = (process.env.WP_USER ?? '').trim();
  const appPassword = process.env.WP_APP_PASSWORD ?? '';
  if (!url || !user || !appPassword) {
    process.stderr.write('mvp-stdio-launcher: missing WP_URL / WP_USER / WP_APP_PASSWORD\n');
    process.exit(1);
  }
  const basicToken = Buffer.from(`${user}:${appPassword}`, 'utf8').toString('base64');
  return { url, basicToken };
}

async function main() {
  const site = readSiteConfigFromEnv();
  const profile = resolveProfile(process.env.ULTRA_TOOLS ?? 'full');

  // Build the registry buildServer will consume, and attach the REAL implemented handlers
  // (the wrapper resolves handlers lazily at call time, but attaching up front is cleanest).
  const registry = createToolRegistry();
  attachPageHandlers(registry);
  attachWidgetHandlers(registry);
  attachOpsHandlers(registry);
  attachMetaHandlers(registry);
  attachDiscoveryHandlers(registry);
  attachMediaHandlers(registry);

  const { server } = buildServer({ site, profile, registry });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `mvp-stdio-launcher: real server core connected over stdio (profile=${profile}, handlers attached)\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`mvp-stdio-launcher: fatal: ${e?.stack ?? e?.message ?? e}\n`);
  process.exit(1);
});
