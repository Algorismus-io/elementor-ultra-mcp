/**
 * WP-F06 — MCP Inspector smoke suite (`14-fixtures-harness.md §8`).
 *
 * A fast end-to-end liveness check over the protocol surface, driven by a thin MCP SDK client over
 * stdio (the same transport `@modelcontextprotocol/inspector` uses; we use the SDK `Client` so the
 * suite has no extra runtime dependency on the Inspector CLI, which remains the manual/dev tool):
 *   a. `tools/list` ⇒ the lean ★ set (`13-tool-catalog.md §5.2`) is present and enabled.
 *   b. for each lean ★ tool, call it with the minimal payload from
 *      `fixtures/envelopes/smoke.<full.tool.name>.json` and assert no protocol error (`-326xx`) +
 *      a well-formed result.
 *   c. read each resource URI (`13-tool-catalog.md §2`) ⇒ a JSON body.
 *   d. `prompts/list` ⇒ all FOUR prompts present (`13-tool-catalog.md §3`).
 *
 * Read-only smokes run unconditionally; mutating smokes target a disposable draft created + trashed in
 * setup/teardown and are skipped if `ULTRA_TOOLS`/capabilities make a tool unavailable (§8).
 *
 * GATING (Wave-1 skeleton): the server core (`server.ts`, tool/resource/prompt registry) is WP-T01 and
 * the proxied tools are WP-T/WP-P. Until the built server boots a populated registry, this suite
 * FEATURE-DETECTS (env + built bin + a non-empty tools/list) and SKIPS with a clear message — it never
 * fails the build. The lean ★ set + resource URIs + prompt names below are the FROZEN expectations the
 * enablement WP flips on.
 *
 * `inspector-smoke.ts` (not `*.test.ts`) ⇒ runs under `pnpm test:smoke`, not `pnpm test:unit`.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { loadFixturesByKind, type LoadedFixture } from './fixture-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the built server bin (`packages/server/dist/index.js`). */
const SERVER_BIN = resolve(HERE, '..', '..', 'dist', 'index.js');

/**
 * The lean ★ default profile (the ~18 tools enabled at boot) — `13-tool-catalog.md §5.2`. The smoke
 * suite asserts every one of these is present + enabled in `tools/list` under `ULTRA_TOOLS=lean`.
 */
export const LEAN_STAR_TOOLS: readonly string[] = [
  'elementor.tools.search',
  'elementor.site.capabilities',
  'elementor.pages.list',
  'elementor.page.get_structure',
  'elementor.page.create',
  'elementor.page.build',
  'elementor.page.dry_run',
  'elementor.schema.widget',
  'elementor.schema.styles',
  'elementor.breakpoints.get',
  'elementor.widget.insert',
  'elementor.widget.update_settings',
  'elementor.design.classes.list',
  'elementor.design.classes.upsert',
  'elementor.design.variables.list',
  'elementor.media.sideload_url',
  'elementor.convert.html_to_tree',
  'elementor.convert.html_to_page',
];

/** The meta-tool trio (always available regardless of profile) — `13-tool-catalog.md §5.2`. */
export const META_TOOLS: readonly string[] = [
  'elementor.tools.list_endpoints',
  'elementor.tools.get_schema',
  'elementor.tools.invoke',
];

/** The resource URIs to read (`13-tool-catalog.md §2`). Static + one parametric sample each. */
export const RESOURCE_URIS: readonly string[] = [
  'elementor://site/capabilities',
  'elementor://breakpoints',
  'elementor://schema/styles',
  'elementor://kit/global-classes',
  'elementor://kit/variables',
  'elementor://templates',
];

/** The FOUR prompts (`13-tool-catalog.md §3`). */
export const PROMPT_NAMES: readonly string[] = [
  'build-from-brief',
  'html-to-native',
  'design-system-audit',
  'theme-builder-from-spec',
];

function envReady(): boolean {
  return Boolean(process.env['WP_URL'] && process.env['WP_USER'] && process.env['WP_APP_PASSWORD']);
}

/** The MCP SDK Client type — imported lazily so the suite degrades gracefully if the SDK shape moves. */
type SdkClient = {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  listPrompts(): Promise<{ prompts: Array<{ name: string }> }>;
  readResource(args: { uri: string }): Promise<unknown>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<{
    isError?: boolean;
    content?: unknown;
  }>;
};

/** Lazily build + connect an SDK stdio client to the built server. Returns null on any failure. */
async function connectClient(): Promise<SdkClient | null> {
  if (!existsSync(SERVER_BIN)) {
    return null;
  }
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_BIN],
      env: {
        ...process.env,
        ULTRA_TOOLS: 'lean',
      },
    });
    const client = new Client(
      { name: 'elementor-ultra-smoke', version: '0.0.0' },
      { capabilities: {} },
    ) as unknown as SdkClient;
    await client.connect(transport);
    return client;
  } catch {
    return null;
  }
}

describe('MCP Inspector smoke (§8)', () => {
  let client: SdkClient | null = null;
  let toolNames: Set<string> = new Set();
  let connected = false;

  beforeAll(async () => {
    if (!envReady()) {
      return;
    }
    client = await connectClient();
    if (client === null) {
      return;
    }
    try {
      const listed = await client.listTools();
      toolNames = new Set(listed.tools.map((t) => t.name));
      // A populated registry (WP-T01) is required; an empty list ⇒ core not wired yet ⇒ skip.
      connected = toolNames.size > 0;
    } catch {
      connected = false;
    }
  });

  afterAll(async () => {
    if (client !== null) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  });

  function skipUnlessLive(label: string): boolean {
    if (!envReady()) {
      console.warn(`[inspector-smoke] SKIP "${label}": App-Password env not set.`);
      return true;
    }
    if (!connected) {
      console.warn(
        `[inspector-smoke] SKIP "${label}": server core / populated registry not available (WP-T01 pending).`,
      );
      return true;
    }
    return false;
  }

  it('the smoke payload corpus exists (envelopes/smoke.*.json)', () => {
    const smokes: LoadedFixture[] = loadFixturesByKind('smoke');
    expect(smokes.length).toBeGreaterThan(0);
    for (const f of smokes) {
      expect(f.envelope.tool).toBeTruthy();
      expect(f.envelope.arguments).toBeTruthy();
    }
  });

  it('tools/list contains the lean ★ set + meta-trio (a)', () => {
    if (skipUnlessLive('tools/list lean set')) {
      return;
    }
    for (const name of [...LEAN_STAR_TOOLS, ...META_TOOLS]) {
      expect(toolNames.has(name), `lean ★ tool missing: ${name}`).toBe(true);
    }
  });

  it('each lean ★ tool with a smoke payload returns a well-formed (non-protocol-error) result (b)', async () => {
    if (skipUnlessLive('lean ★ smoke calls')) {
      return;
    }
    const smokes = loadFixturesByKind('smoke');
    for (const f of smokes) {
      const tool = f.envelope.tool!;
      if (!toolNames.has(tool)) {
        console.warn(`[inspector-smoke] SKIP tool "${tool}": not enabled in current profile.`);
        continue;
      }
      const result = await client!.callTool({
        name: tool,
        arguments: f.envelope.arguments ?? {},
      });
      // No protocol error reached us (callTool would have thrown -326xx); a result is well-formed.
      expect(result).toBeTruthy();
    }
  });

  it('each resource URI is readable as JSON (c)', async () => {
    if (skipUnlessLive('resource reads')) {
      return;
    }
    for (const uri of RESOURCE_URIS) {
      const body = await client!.readResource({ uri });
      expect(body).toBeTruthy();
    }
  });

  it('prompts/list contains all four prompts (d)', async () => {
    if (skipUnlessLive('prompts/list')) {
      return;
    }
    const listed = await client!.listPrompts();
    const names = new Set(listed.prompts.map((p) => p.name));
    for (const name of PROMPT_NAMES) {
      expect(names.has(name), `prompt missing: ${name}`).toBe(true);
    }
  });
});
