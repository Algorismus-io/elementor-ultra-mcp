#!/usr/bin/env node
/**
 * ULTRA Elementor MCP — bin entry (WP-F01 scaffold).
 *
 * RESPONSIBILITY (kept deliberately minimal):
 *   1. Be the file referenced by `"bin"` in package.json with a shebang, so
 *      `npx @elementor-ultra/server` works (Engineering Standards §2.10, RESEARCH.md §8).
 *   2. Read env config once, select a transport (stdio default), and exit cleanly
 *      with a clear message when required env (WP_URL / WP_USER / WP_APP_PASSWORD)
 *      is absent — no business logic here.
 *   3. Hand off to the real server core via a LAZY `import('./server.js')`.
 *
 * OWNERSHIP SEAM (do not break — WP-F01 owns this file; WP-T01 owns server.ts):
 *   The real `McpServer` init, tool registry, and transport wiring live in
 *   `./server.ts`, which is created by WP-T01. To keep `files_owned` disjoint
 *   (01-architecture.md §4.3), this file NEVER imports server.ts statically.
 *   Instead it lazily `import()`s `./server.js` at runtime and calls its `main()`
 *   export. Until WP-T01 lands that module, the import fails (or the export is
 *   missing) and we print a clear "server core not yet wired" message and exit 0.
 *   This lets F01's index.ts compile + boot standalone, and lets WP-T01 wire the
 *   core by ADDING server.ts — without ever editing this file.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * PHASE 2 (T1): the server accepts EITHER the additive `X-MCP-API-Key` vector (`WP_MCP_API_KEY`)
 * OR Basic auth (`WP_USER` + `WP_APP_PASSWORD`). `WP_URL` is always required. Returns the list of
 * missing vars ([] when a valid combination is present).
 */
function missingConnectionEnv(): string[] {
  const present = (key: string): boolean => {
    const v = process.env[key];
    return v !== undefined && v.trim() !== '';
  };
  if (!present('WP_URL')) {
    return ['WP_URL'];
  }
  if (present('WP_MCP_API_KEY')) {
    return []; // MCP-key vector satisfies auth.
  }
  const missing = ['WP_USER', 'WP_APP_PASSWORD'].filter((k) => !present(k));
  // When neither vector is fully configured, guide toward WP_MCP_API_KEY first.
  return missing.length > 0 ? ['WP_MCP_API_KEY (or WP_USER + WP_APP_PASSWORD)'] : [];
}

/** Shape the lazily-loaded server core is expected to export (owned by WP-T01). */
interface ServerCoreModule {
  main?: (server: McpServer) => Promise<void> | void;
}

function selectTransport(): 'stdio' | 'http' {
  const requested = (process.env['MCP_TRANSPORT'] ?? 'stdio').toLowerCase();
  return requested === 'http' ? 'http' : 'stdio';
}

async function run(): Promise<void> {
  const transport = selectTransport();
  const missing = missingConnectionEnv();

  if (missing.length > 0) {
    // Clear, actionable message; clean exit (not an error) so harnesses can probe
    // the bin's presence without configured credentials.
    process.stderr.write(
      `elementor-ultra-mcp: missing required environment variable(s): ${missing.join(', ')}.\n` +
        `Set WP_URL plus EITHER WP_MCP_API_KEY OR (WP_USER + WP_APP_PASSWORD) (and optionally ` +
        `MCP_TRANSPORT=stdio|http, ULTRA_TOOLS=lean|full) before starting the server.\n` +
        `Selected transport would be: ${transport}.\n`,
    );
    process.exitCode = 0;
    return;
  }

  // Construct a minimal, empty MCP server. The real tool/resource/prompt registry
  // and transport binding are added by WP-T01 in ./server.ts (see seam note above).
  const server = new McpServer({
    name: 'elementor-ultra-mcp',
    version: '0.0.0',
  });

  // Lazily resolve the server core so this file does not statically depend on a
  // module owned by another work package (WP-T01 adds ./server.ts). The specifier
  // is built at runtime so TS does not try to resolve ./server.js at compile time
  // (it does not exist on the F01 scaffold); WP-T01 adds the module without editing
  // this file. The dynamic-import return is typed via the ServerCoreModule cast.
  const coreSpecifier = ['.', 'server.js'].join('/');
  let core: ServerCoreModule | undefined;
  try {
    core = (await import(coreSpecifier)) as ServerCoreModule;
  } catch {
    core = undefined;
  }

  if (!core || typeof core.main !== 'function') {
    process.stderr.write(
      `elementor-ultra-mcp: server core not yet wired (./server.js with a main() export is missing).\n` +
        `This is expected on the WP-F01 scaffold; WP-T01 adds the transport + tool registry.\n` +
        `Transport selected: ${transport}.\n`,
    );
    process.exitCode = 0;
    return;
  }

  await core.main(server);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`elementor-ultra-mcp: fatal error during startup: ${message}\n`);
  process.exitCode = 1;
});
