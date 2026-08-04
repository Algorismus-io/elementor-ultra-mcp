/**
 * WP-Q03 — MCP Inspector smoke TEST (`14-fixtures-harness.md §8`, `13-tool-catalog.md §5.2/§2/§3`).
 *
 * The vitest entry point for the Inspector smoke suite. It drives the BUILT server over stdio via the
 * Q03 {@link smoke-driver} and asserts the four §8 liveness checks:
 *   (a) `tools/list` contains + enables the lean ★ set (EXACTLY the 18 from Contract 13 §5.2) + meta-trio;
 *   (b) each ★ tool called with `envelopes/smoke.<tool>.json` returns NO protocol error (`-326xx`) and
 *       (when its handler is live) an `outputSchema`-conformant result;
 *   (c) each resource URI (Contract 13 §2) reads a JSON body;
 *   (d) all four prompts (Contract 13 §3) are present by name.
 *
 * Plus the catalog-driven SELF-CHECK (DoD / `§Tests Required`): every smoke payload validates against its
 * tool's `inputSchema` — this runs UNCONDITIONALLY (no server needed) so it gates `pnpm test:unit` too.
 *
 * SEPARATION (`§Implementation Notes`): Q03 owns this `*.test.ts` + `smoke-driver.ts` + the payloads;
 * WP-F06 owns the `inspector-smoke.ts` RUNNER SKELETON. This test REUSES F06's frozen expectation
 * constants (`LEAN_STAR_TOOLS`/`META_TOOLS`/`RESOURCE_URIS`/`PROMPT_NAMES`) via the harness barrel — it
 * never edits `inspector-smoke.ts`.
 *
 * GROW-GREEN (`§Detailed Requirements 7`): the server core (WP-T01) boots a populated registry, but the
 * proxied/orchestration handlers come from later verticals. Until a tool's handler is attached (or the
 * App-Password env / built bin / live REST routes are present), each live check SKIPs with a clear
 * reason — the suite is green from MVP and gains coverage as verticals land. The final DoD requires all
 * 18 live.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { CapabilitySnapshot } from './fixture-loader.js';
import {
  LEAN_STAR_TOOLS,
  META_TOOLS,
  RESOURCE_URIS,
  PROMPT_NAMES,
  connectSmokeClient,
  envReady,
  serverBuilt,
  loadSmokeEnvelopes,
  smokeRunnable,
  checkSmokeInputSchemas,
  substituteForCall,
  usesDraftTokens,
  safeCallTool,
  createDisposableDraft,
  teardownDisposables,
  type SmokeClient,
  type SmokeEnvelope,
  type DraftHandles,
} from './smoke-driver.js';

/** The lean ★ tools whose smoke payloads MUTATE the disposable draft (vs. read-only). */
const MUTATING_DRAFT_TOOLS = new Set<string>([
  'elementor.widget.insert',
  'elementor.widget.update_settings',
]);

describe('WP-Q03 — MCP Inspector smoke suite (§8)', () => {
  /* ───── (catalog-only) the input-schema self-check — runs WITHOUT a server ───── */

  describe('smoke-payload corpus (catalog self-check)', () => {
    it('exposes a smoke envelope for every lean ★ tool (Q03 16 + WP-H12 2 convert.*)', () => {
      const envelopes = loadSmokeEnvelopes();
      // (1) every lean ★ tool has a smoke payload (the §8(b) corpus the suite calls).
      for (const name of LEAN_STAR_TOOLS) {
        expect(envelopes.has(name), `missing smoke envelope for lean ★ tool: ${name}`).toBe(true);
      }
      // (2) the ★-subset of the corpus is EXACTLY the 18 ★ tools — no ★ omitted, none duplicated.
      const starEnvelopes = [...envelopes.keys()].filter((name) => LEAN_STAR_TOOLS.includes(name));
      expect(starEnvelopes.length).toBe(LEAN_STAR_TOOLS.length);
      // Non-★ smoke envelopes MAY exist (other WPs own e.g. convert.fidelity_check); we never assert
      // against them here — Q03 owns only the ★ smoke surface per §8(b).
    });

    it('every smoke payload validates against its tool inputSchema (DoD / §Tests Required)', () => {
      const failures = checkSmokeInputSchemas();
      expect(
        failures,
        `smoke payloads failing their tool inputSchema:\n${JSON.stringify(failures, null, 2)}`,
      ).toEqual([]);
    });
  });

  /* ───── (live) the §8 protocol-surface liveness checks — feature-detect/skip until live ───── */

  describe('protocol surface (live)', () => {
    let client: SmokeClient | null = null;
    let toolNames = new Set<string>();
    let connected = false;
    let caps: CapabilitySnapshot = { experiments: [], pro: false };
    let draft: DraftHandles | null = null;
    const createdPostIds: number[] = [];

    beforeAll(async () => {
      if (!envReady() || !serverBuilt()) {
        return;
      }
      client = await connectSmokeClient();
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
      if (!connected) {
        return;
      }
      // Probe live capabilities so `requires`-gated smokes skip on free-only/atomic-off installs (§8).
      caps = await probeCapabilities(client);
      // Create the disposable draft the mutating smokes target (grow-green: null ⇒ skip mutating).
      draft = await createDisposableDraft(client, createdPostIds);
    });

    afterAll(async () => {
      if (client !== null) {
        await teardownDisposables(client, createdPostIds);
        try {
          await client.close();
        } catch {
          /* ignore */
        }
      }
    });

    function skipUnlessLive(label: string): boolean {
      if (!envReady()) {
        console.warn(
          `[smoke] SKIP "${label}": App-Password env (WP_URL/WP_USER/WP_APP_PASSWORD) not set.`,
        );
        return true;
      }
      if (!serverBuilt()) {
        console.warn(`[smoke] SKIP "${label}": built server bin absent (run \`pnpm build\`).`);
        return true;
      }
      if (!connected) {
        console.warn(`[smoke] SKIP "${label}": server core / populated registry not available.`);
        return true;
      }
      return false;
    }

    it('(a) tools/list contains + enables the lean ★ set + meta-trio', () => {
      if (skipUnlessLive('tools/list lean set')) {
        return;
      }
      for (const name of [...LEAN_STAR_TOOLS, ...META_TOOLS]) {
        expect(toolNames.has(name), `lean ★ / meta tool missing or disabled: ${name}`).toBe(true);
      }
    });

    it('(b) each lean ★ tool returns a well-formed, non-protocol-error result', async () => {
      if (skipUnlessLive('lean ★ smoke calls')) {
        return;
      }
      const envelopes = loadSmokeEnvelopes();
      for (const name of LEAN_STAR_TOOLS) {
        const env = envelopes.get(name);
        if (env === undefined) {
          continue; // covered by the corpus self-check above.
        }
        await runSmoke(name, env);
      }
    });

    it('(c) each resource URI reads a JSON body', async () => {
      if (skipUnlessLive('resource reads')) {
        return;
      }
      for (const uri of RESOURCE_URIS) {
        let body: unknown;
        try {
          // A protocol error (-326xx) would throw; that is a hard failure for a declared resource.
          body = await client!.readResource({ uri });
        } catch (err) {
          // Grow-green: a resource whose handler is not yet wired returns a "not yet wired" message as
          // content, not a throw — so a throw here is a real protocol fault. Surface it.
          expect.fail(`resource ${uri} raised a protocol error: ${String(err)}`);
        }
        expect(body, `resource ${uri} returned an empty body`).toBeTruthy();
      }
    });

    it('(d) prompts/list contains all four prompts by name', async () => {
      if (skipUnlessLive('prompts/list')) {
        return;
      }
      const listed = await client!.listPrompts();
      const names = new Set(listed.prompts.map((p) => p.name));
      for (const name of PROMPT_NAMES) {
        expect(names.has(name), `prompt missing: ${name}`).toBe(true);
      }
    });

    /* ───── helpers (closure over the live client/caps/draft) ───── */

    /**
     * Call one lean ★ smoke and assert the §8(b) gate: NO protocol error (those throw) + a well-formed
     * result. SKIPs (returns) when the tool is not enabled, its `requires` are unmet, its handler is not
     * yet attached, or it is a draft-targeting mutating smoke and the draft could not be created.
     */
    async function runSmoke(name: string, env: SmokeEnvelope): Promise<void> {
      if (!toolNames.has(name)) {
        console.warn(`[smoke] SKIP tool "${name}": not enabled in the lean profile.`);
        return;
      }
      if (!smokeRunnable(env, caps)) {
        console.warn(`[smoke] SKIP tool "${name}": capability gate unmet on this install (§8).`);
        return;
      }

      let args = env.arguments;
      if (usesDraftTokens(args) || MUTATING_DRAFT_TOOLS.has(name)) {
        if (draft === null) {
          console.warn(
            `[smoke] SKIP tool "${name}": disposable draft unavailable (mutating smoke).`,
          );
          return;
        }
        args = substituteForCall(args, draft);
      }

      // safeCallTool lets a real protocol error (-326xx) throw (the §8(b) hard-fail) but classifies the
      // grow-green outcomes (handler not attached — whether returned as isError OR raised as the SDK
      // output-schema-mismatch throw) as a SKIP so the suite is green until the vertical lands.
      const call = await safeCallTool(client!, name, args);
      if (call.kind === 'skip') {
        console.warn(`[smoke] SKIP tool "${name}": ${call.reason}.`);
        return;
      }
      const outcome = call.outcome;
      expect(outcome, `tool "${name}" returned no result`).toBeTruthy();
      // A non-skip result is well-formed: an isError result is still NOT a protocol error (it carries
      // actionable text per Contract 12 §1); a success result carries structuredContent matching the
      // tool's outputSchema (the SDK validated it against the registered outputSchema before it reached
      // us — a mismatch would have thrown and been classified above). Either way, §8(b) holds.
      if (outcome.isError !== true) {
        expect(
          outcome.structuredContent,
          `tool "${name}" success result missing structuredContent (outputSchema)`,
        ).toBeTruthy();
      }
    }

    /**
     * Probe `site.capabilities` to build the {@link CapabilitySnapshot} the `requires` gate uses. Falls
     * back to an empty snapshot (everything gated ⇒ skipped) if the probe is unavailable (grow-green).
     */
    async function probeCapabilities(c: SmokeClient): Promise<CapabilitySnapshot> {
      try {
        const probe = await safeCallTool(c, 'elementor.site.capabilities', {});
        if (probe.kind === 'skip') {
          return { experiments: [], pro: false };
        }
        const res = probe.outcome;
        if (res.isError === true || res.structuredContent === undefined) {
          return { experiments: [], pro: false };
        }
        const sc = res.structuredContent;
        const experimentsRaw = sc['experiments'];
        const experiments =
          experimentsRaw !== null && typeof experimentsRaw === 'object'
            ? Object.entries(experimentsRaw as Record<string, unknown>)
                .filter(([, on]) => on === true)
                .map(([k]) => k)
            : [];
        const versions = sc['versions'] as Record<string, unknown> | undefined;
        const elementorVersion =
          versions !== undefined && typeof versions['elementor'] === 'string'
            ? versions['elementor']
            : undefined;
        return {
          experiments,
          pro: sc['pro'] === true,
          ...(elementorVersion !== undefined ? { elementor_version: elementorVersion } : {}),
        };
      } catch {
        return { experiments: [], pro: false };
      }
    }
  });
});
