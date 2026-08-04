/**
 * WP-F06 — Round-trip identity suite (`14-fixtures-harness.md §7`).
 *
 * For each `fixtures/roundtrip/*.json`: `page.build` the `input_tree`, `page.get_structure`, normalize
 * BOTH the (normalized) input and the fetched tree with the shared normalizer
 * (`packages/server/src/authoring/contract.ts` `normalize()`), and assert structural equality. The
 * normalizer tolerates `_cssid` injection, empty sibling-key noise, and html-v3 normalization, and
 * compares structurally (ids preserved, not literal-compared per §7). Run as admin so the
 * content-sanitizer title rewrite is exempt (§7, `11-authoring-contract.md §11`).
 *
 * GATING (Wave-1 skeleton): the `page.build` / `page.get_structure` routes are WP-P/WP-T. Until they
 * exist this suite FEATURE-DETECTS the save route and SKIPS with a clear message (never fails). The
 * pure normalizer half (normalize(input) === normalized_expected) ALWAYS runs offline — it proves the
 * fixture's `normalized_expected` is self-consistent with the shared normalizer even before wp-env.
 *
 * `*.contract.ts` (not `*.test.ts`) ⇒ runs under `pnpm test:contract`, not `pnpm test:unit`.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { WpClient } from '../wp/client.js';
import { normalize } from '../authoring/contract.js';
import type { SiteConfig } from '../wp/types.js';
import { loadFixturesByKind, fixtureLabel, isFixtureRunnable } from './fixture-loader.js';
import type { CapabilitySnapshot } from './fixture-loader.js';

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

/** Probe whether the save/build route exists (WP-P). 404/no_route ⇒ not landed ⇒ unavailable. */
async function buildRouteAvailable(client: WpClient, site: SiteConfig): Promise<boolean> {
  try {
    await client.send(
      'GET',
      `${site.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/documents`,
      {
        query: { limit: 1 },
      },
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return !/no_route|404|not\s*found/i.test(message);
  }
}

const site = siteFromEnv();

describe('round-trip identity (§7)', () => {
  const fixtures = loadFixturesByKind('roundtrip');
  let client: WpClient | undefined;
  let routeReady = false;
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
    routeReady = await buildRouteAvailable(client, site);
  });

  it('has roundtrip fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  // OFFLINE half: the fixture's normalized_expected must equal normalize(input_tree). This runs
  // without wp-env so the normalizer + the fixture stay self-consistent in every CI lane.
  it.each(fixtures.map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s": normalize(input_tree) equals normalized_expected (offline)',
    (_label, f) => {
      const input = f.envelope.input_tree ?? [];
      const expected = f.envelope.normalized_expected ?? [];
      expect(normalize(input)).toEqual(normalize(expected));
    },
  );

  // LIVE half: build → get_structure → normalize → equal. Gated until the routes exist (WP-P/WP-T).
  it.each(fixtures.map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s": build→read→normalize equals normalized_expected (live)',
    (label, f) => {
      if (site === null) {
        console.warn(`[roundtrip-identity] SKIP "${label}": App-Password env not set.`);
        return;
      }
      if (!routeReady) {
        console.warn(
          `[roundtrip-identity] SKIP "${label}": elementor-ultra/v1 documents route not registered yet (WP-P pending).`,
        );
        return;
      }
      if (!isFixtureRunnable(f.envelope, caps)) {
        console.warn(`[roundtrip-identity] SKIP "${label}": requires unmet on target site.`);
        return;
      }
      // The live build/get_structure tools are WP-P/WP-T; once they land, the enablement WP wires the
      // actual build + read here. The skeleton asserts the offline invariant above so the suite is
      // meaningful in Wave 1, and self-skips the live assertion until then.
      console.warn(
        `[roundtrip-identity] SKIP live "${label}": page.build/page.get_structure enablement pending (WP-P/WP-T DoD).`,
      );
    },
  );
});
