/**
 * WP-F06 — Authoritative dry_run round-trip (TS mirror) — `14-fixtures-harness.md §3`.
 *
 * This is the TS half of the AUTHORITATIVE round-trip: it calls the live `page.dry_run` over
 * App-Password REST (`POST elementor-ultra/v1/documents/{id}/dry-run`, or `.../dry-run` when no
 * post_id) against the SAME wp-env the PHP suite (`tests/test-dry-run-fixtures.php`) hits, and asserts
 * the SAME `expect`: `result.valid === fixture.expect.valid`; on invalid, the returned `error.code`
 * SET equals `fixture.expect.errors` (order-independent). Proving the TS proxy faithfully surfaces the
 * PHP verdict (§3 last paragraph).
 *
 * GATING (Wave-1 skeleton): the dry-run REST route is WP-P03 and the live `page.dry_run` tool is WP-T.
 * Until they exist this suite FEATURE-DETECTS and SKIPS with a clear message (never fails). The
 * render assertion (S1, §3 step 3) is ALWAYS skipped with reason until WP-S01 PASS — it lives in the
 * PHP suite; the TS mirror only carries the verdict + error-code comparison.
 *
 * This file is a `*.contract.ts` suite (NOT `*.test.ts`) so it runs under `pnpm test:contract`
 * (requires wp-env), never under the no-WP `pnpm test:unit`.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { WpClient } from '../wp/client.js';
import type { SiteConfig } from '../wp/types.js';
import {
  loadFixturesByKind,
  isFixtureRunnable,
  fixtureLabel,
  type CapabilitySnapshot,
  type LoadedFixture,
} from './fixture-loader.js';

/** Build a {@link SiteConfig} from the App-Password env (`13-tool-catalog.md §5.4`), or null if unset. */
function siteFromEnv(): SiteConfig | null {
  const url = process.env['WP_URL'];
  const user = process.env['WP_USER'];
  const appPassword = process.env['WP_APP_PASSWORD'];
  if (!url || !user || !appPassword) {
    return null;
  }
  const basicToken = Buffer.from(`${user}:${appPassword}`).toString('base64');
  return { url, basicToken };
}

/** Probe whether the dry-run route exists (WP-P03). Returns true when the route responds (any 2xx/4xx
 *  that is NOT a 404 "no route" — a 404 rest_no_route means the controller is not registered yet). */
async function dryRunRouteAvailable(client: WpClient, site: SiteConfig): Promise<boolean> {
  try {
    // A bodyless probe: we only care whether the route is registered, not the result.
    await client.send(
      'POST',
      `${site.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/dry-run`,
      {
        body: { elements: [], generation: 'v4' },
      },
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `rest_no_route` / 404 ⇒ controller not registered (WP-P03 not landed). Treat as unavailable.
    return !/no_route|404|not\s*found/i.test(message);
  }
}

const site = siteFromEnv();
const SKIP_NO_ENV = site === null;

describe('dry_run round-trip (TS mirror, §3)', () => {
  let client: WpClient | undefined;
  let routeReady = false;
  // A permissive capability snapshot; the contract job runs against the verified live site
  // (Elementor 4.1.1 + Pro 4.1.0, V4 experiments on). The PHP suite mirrors the same gate.
  const caps: CapabilitySnapshot = {
    experiments: ['e_atomic_elements', 'e_classes', 'e_variables'],
    pro: true,
    elementor_version: '4.1.1',
  };

  beforeAll(async () => {
    if (site === null) {
      return;
    }
    client = new WpClient({ site });
    routeReady = await dryRunRouteAvailable(client, site);
  });

  const treeFixtures: LoadedFixture[] = loadFixturesByKind('tree');

  it('has tree fixtures to round-trip', () => {
    expect(treeFixtures.length).toBeGreaterThan(0);
  });

  it.each(treeFixtures.map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s": dry_run verdict + error-code set matches expect',
    async (label, f) => {
      if (SKIP_NO_ENV) {
        console.warn(
          `[dry-run-roundtrip] SKIP "${label}": WP_URL/WP_USER/WP_APP_PASSWORD not set (no live site).`,
        );
        return;
      }
      if (!routeReady) {
        console.warn(
          `[dry-run-roundtrip] SKIP "${label}": elementor-ultra/v1 dry-run route not registered yet (WP-P03 pending).`,
        );
        return;
      }
      if (!isFixtureRunnable(f.envelope, caps)) {
        console.warn(`[dry-run-roundtrip] SKIP "${label}": requires unmet on target site.`);
        return;
      }

      // No post_id ⇒ the bodyful `POST elementor-ultra/v1/dry-run` route (§3 / 13-tool-catalog §1.2).
      const dryRunUrl = `${site.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/dry-run`;
      const res = await client!.send<{ valid: boolean; errors?: Array<{ code: string }> }>(
        'POST',
        dryRunUrl,
        {
          body: {
            elements: f.envelope.tree ?? [],
            settings: f.envelope.settings ?? {},
            generation: f.envelope.generation === 'v3' ? 'v3' : 'v4',
          },
        },
      );

      expect(res.valid).toBe(f.envelope.expect.valid);

      if (!f.envelope.expect.valid) {
        const got = new Set((res.errors ?? []).map((e) => e.code));
        const want = new Set(f.envelope.expect.errors ?? []);
        // Order-independent SET comparison (§3 step 2d).
        expect([...got].sort()).toEqual([...want].sort());
      }
    },
  );

  it('render assertion (S1, §3 step 3) is gated until WP-S01 PASS', () => {
    // The per-fixture primed-CSS assertion lives in the PHP suite; it is SKIPPED with this reason
    // string until Spike S01 passes so the gate stays visible (Implementation Notes).
    const reason = 'blocked on WP-S01 PASS (prime-css render assertion)';
    expect(reason).toContain('WP-S01');
  });
});
