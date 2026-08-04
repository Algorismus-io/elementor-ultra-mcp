/**
 * WP-T01 — server-wiring tests (§Tests Required): with a stub WP-F04 registry (synthetic descriptors
 * incl. ★ / non-★ / meta), assert `buildServer`:
 *  - registers ALL tools against the live `McpServer`;
 *  - disables the non-★ set for `lean` (★ + meta-trio stay enabled);
 *  - enables ALL for `full`;
 *  - keeps the meta-trio enabled in BOTH profiles;
 *  - returns a clear "handler not registered" isError for an UNATTACHED tool (server boots pre-vertical).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildServer, assertLeanBoot } from '../server.js';
import { ToolRegistry } from '../catalog/registry.js';
import { TOOL_DESCRIPTORS, type ToolDescriptor } from '../catalog/tools.js';
import type { SiteConfig } from '../wp/types.js';

/* A dummy site — no network calls happen during boot/registration. */
const SITE: SiteConfig = { url: 'http://localhost:8899', basicToken: 'dGVzdDp0ZXN0' };

/** Build a synthetic descriptor (real-enough shape; zod-raw-shape schemas). */
function descriptor(name: string, opts: { star?: boolean; meta?: boolean } = {}): ToolDescriptor {
  return {
    name,
    title: `Title ${name}`,
    description: `Description for ${name}`,
    inputSchema: { value: z.string().optional() },
    outputSchema: { ok: z.boolean() },
    annotations: { readOnlyHint: true },
    star: opts.star ?? false,
    class: 'R',
    side: 'TS',
    ...(opts.meta === true ? { meta: true } : {}),
  };
}

/**
 * A stub registry with one ★, one non-★, and one meta synthetic descriptor — PLUS the full real catalog.
 * `buildServer` now wires the shipped verticals (`attach*Handlers`) onto the registry it is given, so the
 * registry MUST contain the real catalog tools (`elementor.page.create`, …) or attachment throws. The
 * synthetic `elementor.demo.*` descriptors still exercise the ★ / non-★ / meta profile + disable logic.
 */
function stubRegistry(): ToolRegistry {
  return new ToolRegistry([
    ...TOOL_DESCRIPTORS,
    descriptor('elementor.demo.star', { star: true }),
    descriptor('elementor.demo.plain', { star: false }),
    descriptor('elementor.demo.meta', { meta: true }),
  ]);
}

describe('buildServer — registration + profile', () => {
  it('registers every tool against the live McpServer', () => {
    const registry = stubRegistry();
    const built = buildServer({ site: SITE, profile: 'lean', registry });

    // All three are present in the live surface (enabled or disabled).
    const live = new Set([...built.surface.enabledNames(), ...registry.listDisabled()]);
    expect(live.has('elementor.demo.star')).toBe(true);
    expect(live.has('elementor.demo.plain')).toBe(true);
    expect(live.has('elementor.demo.meta')).toBe(true);
  });

  it('lean profile disables the non-★ set; ★ + meta stay enabled', () => {
    const registry = stubRegistry();
    const built = buildServer({ site: SITE, profile: 'lean', registry });

    expect(built.surface.isEnabled('elementor.demo.star')).toBe(true);
    expect(built.surface.isEnabled('elementor.demo.meta')).toBe(true);
    expect(built.surface.isEnabled('elementor.demo.plain')).toBe(false);

    // Registry bookkeeping mirrors the live state.
    expect(registry.isEnabled('elementor.demo.plain')).toBe(false);
    expect(registry.isEnabled('elementor.demo.star')).toBe(true);
  });

  it('full profile enables ALL tools (meta still enabled)', () => {
    const registry = stubRegistry();
    const built = buildServer({ site: SITE, profile: 'full', registry });

    expect(built.surface.isEnabled('elementor.demo.star')).toBe(true);
    expect(built.surface.isEnabled('elementor.demo.plain')).toBe(true);
    expect(built.surface.isEnabled('elementor.demo.meta')).toBe(true);
  });

  it('keeps the meta-trio enabled even when explicitly part of the disabled candidates', () => {
    const registry = new ToolRegistry([
      ...TOOL_DESCRIPTORS,
      descriptor('elementor.demo.plain', { star: false }),
      descriptor('elementor.demo.meta', { meta: true }),
    ]);
    const built = buildServer({ site: SITE, profile: 'lean', registry });

    expect(built.surface.isEnabled('elementor.demo.meta')).toBe(true);
    expect(built.surface.isEnabled('elementor.demo.plain')).toBe(false);
  });
});

describe('buildServer — unattached handler', () => {
  it('returns a clear "handler not registered" isError for an unattached tool', async () => {
    const registry = stubRegistry();
    const built = buildServer({ site: SITE, profile: 'full', registry });

    // The tool exists in the catalog but has no attached handler — invoking it via the registry's
    // wrapped path should yield an isError result, not throw.
    expect(registry.hasHandler('elementor.demo.plain')).toBe(false);

    // Reach the live tool's wrapped callback through the SDK's registered tool map.
    const result = await invokeRegisteredTool(built.server, 'elementor.demo.plain', {});
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('handler is not yet attached');
  });

  it('dispatches to an ATTACHED handler with the args', async () => {
    const registry = stubRegistry();
    const built = buildServer({ site: SITE, profile: 'full', registry });

    registry.attachHandler('elementor.demo.plain', (args) => ({
      content: [{ type: 'text', text: `got ${JSON.stringify(args)}` }],
    }));

    const result = await invokeRegisteredTool(built.server, 'elementor.demo.plain', {
      value: 'hi',
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('hi');
  });
});

describe('assertLeanBoot (dev boot assertions, real catalog)', () => {
  it('passes for the real catalog under the lean profile', () => {
    const built = buildServer({ site: SITE, profile: 'lean' });
    const enabled = assertLeanBoot(built);
    // The real lean ★ set (18) + meta-trio (3) are enabled at boot.
    expect(enabled.length).toBeGreaterThanOrEqual(21);
    expect(built.surface.isEnabled('elementor.tools.search')).toBe(true); // ★
    expect(built.surface.isEnabled('elementor.tools.invoke')).toBe(true); // meta
    expect(built.surface.isEnabled('elementor.page.delete')).toBe(false); // non-★ disabled
  });
});

/* ───────────────────────────── helper: invoke a registered SDK tool ───────────────────────── */

/**
 * Reach into the live `McpServer` and call the wrapped handler registered for `name`. The SDK stores
 * registered tools on the private `_registeredTools` map; we access it structurally for the test only.
 */
async function invokeRegisteredTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }> {
  const tools = (server as { _registeredTools: Record<string, { handler: unknown }> })
    ._registeredTools;
  const entry = tools[name];
  if (entry === undefined) {
    throw new Error(`Tool "${name}" was not registered on the server.`);
  }
  const handler = entry.handler as (
    a: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ isError?: boolean; content?: Array<{ text?: string }> }>;
  return handler(args, { signal: new AbortController().signal });
}
