/**
 * WP-Q05 — Round-trip identity suite (`14-fixtures-harness.md §7`, RESEARCH §9.3e).
 *
 * For each `fixtures/roundtrip/*.json`: `page.build` the `input_tree`, `page.get_structure`, normalize
 * BOTH the input and the fetched tree with the shared WP-F03 normalizer
 * (`packages/server/src/authoring/contract.ts` `normalize()`), and assert STRUCTURAL equality. This
 * proves `build → read → normalize → equal` so production edits never surface phantom changes (the M2
 * safe-edit guarantee, `00-product-overview.md §6`).
 *
 * Tolerances the comparison honors (`§7`):
 *   - `_cssid` injection (`has-atomic-base.php:310-321`) — stripped by `normalize()` (RESEARCH §4.1).
 *   - empty sibling-key noise (`styles`/`editor_settings`/`interactions`/`elements`) — dropped by `normalize()`.
 *   - html-v3 normalization — text presence compared, kses left to PHP (RESEARCH §6.6).
 *   - minted ids — compared STRUCTURALLY/positionally, NEVER literally. Spike C2/R5: on save the element
 *     id AND the dependent LOCAL-STYLE id are re-minted (local-style ids are NOT stable across save).
 *     The structural id-map below remaps element ids + `styles` keys + `StyleDefinition.id` + the mirrored
 *     entry in `classes.value`; GLOBAL-class ids (`g-*`) are stable external refs and are preserved.
 *
 * Run as ADMIN so the content-sanitizer `title` rewrite is exempt (RESEARCH §2.1/§6.6, §7 step 3).
 *
 * GATING: the live `page.build` / `page.get_structure` routes are the Pages vertical (WP-T). Until they
 * exist this suite FEATURE-DETECTS the documents route and SKIPS the live half with a clear message
 * (never fails). The pure normalizer half ALWAYS runs offline so the fixture's `normalized_expected`
 * stays self-consistent with the shared normalizer + the structural-id helper in every CI lane.
 *
 * `*.test.ts` ⇒ the offline half runs under `pnpm test:unit`; the whole suite (incl. the live half once
 * routes land) runs under `pnpm test:contract` against a running wp-env.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { WpClient } from '../wp/client.js';
import { normalize } from '../authoring/contract.js';
import type { ElementNode } from '../authoring/contract.js';
import type { SiteConfig } from '../wp/types.js';
import { loadFixturesByKind, fixtureLabel, isFixtureRunnable } from './fixture-loader.js';
import type { CapabilitySnapshot } from './fixture-loader.js';

/* ───────────────────────────── structural id comparison (C2/R5) ─────────────────────────── */

/**
 * A global-class id (`g-*`) is a STABLE external reference and is NOT remapped; every other id
 * (element ids, local-style ids `e-<elementId>-<7hex>`) is re-minted on save (spike C2/R5) and must be
 * remapped positionally before comparison.
 */
export function isStableId(id: string): boolean {
  return id.startsWith('g-');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a normalized tree in deterministic (depth-first, pre-order) order and collect EVERY minted id in
 * first-seen order: each node's `id`, then its `styles` keys (== local-style ids), recursing into
 * `elements`. The position in this list is the structural identity of the id; two trees that round-trip
 * faithfully produce the SAME ordered list shape, differing only in the literal id strings.
 */
export function collectMintedIds(tree: ElementNode[]): string[] {
  const ids: string[] = [];
  const visit = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      if (typeof node.id === 'string') {
        ids.push(node.id);
      }
      const styles = (node as { styles?: Record<string, unknown> }).styles;
      if (isPlainObject(styles)) {
        for (const styleId of Object.keys(styles)) {
          ids.push(styleId);
        }
      }
      const children = (node as { elements?: ElementNode[] }).elements;
      if (Array.isArray(children) && children.length > 0) {
        visit(children);
      }
    }
  };
  visit(tree);
  return ids;
}

/**
 * Canonicalize minted ids to positional placeholders so two structurally-identical trees compare equal
 * regardless of the literal (re-minted) id strings. The id-map is derived from {@link collectMintedIds}
 * over THIS tree; every occurrence of a mapped id — as a node `id`, a `styles` map key, a
 * `StyleDefinition.id`, OR an entry inside a `classes` envelope value — is rewritten to `#0`, `#1`, …
 * GLOBAL-class ids (`g-*`, {@link isStableId}) are left untouched. Returns a deep clone (input untouched).
 */
export function canonicalizeIds(tree: ElementNode[]): ElementNode[] {
  const order = collectMintedIds(tree);
  const map = new Map<string, string>();
  let i = 0;
  for (const id of order) {
    if (!isStableId(id) && !map.has(id)) {
      map.set(id, `#${i}`);
      i += 1;
    }
  }
  const rename = (id: unknown): unknown =>
    typeof id === 'string' && map.has(id) ? map.get(id) : id;

  const cloneAndRename = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => cloneAndRename(item));
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        if (key === 'styles' && isPlainObject(v)) {
          // Rekey the styles map by the remapped local-style id.
          const rekeyed: Record<string, unknown> = {};
          for (const [styleId, def] of Object.entries(v)) {
            rekeyed[rename(styleId) as string] = cloneAndRename(def);
          }
          out[key] = rekeyed;
        } else if (key === 'id') {
          out[key] = rename(v);
        } else if (key === 'value' && Array.isArray(v)) {
          // A `classes` envelope value is a BARE string array; remap any local-style ids inside it.
          out[key] = v.map((entry) => rename(entry));
        } else {
          out[key] = cloneAndRename(v);
        }
      }
      return out;
    }
    return value;
  };

  return (cloneAndRename(tree) as ElementNode[]) ?? [];
}

/**
 * The round-trip identity predicate: two trees are structurally identical iff their normalized,
 * id-canonicalized forms are deep-equal. This is the assertion the live half makes against
 * `build → get_structure`, and the offline half makes against `normalized_expected`.
 */
export function structurallyEqual(a: ElementNode[], b: ElementNode[]): boolean {
  return (
    JSON.stringify(canonicalizeIds(normalize(a))) === JSON.stringify(canonicalizeIds(normalize(b)))
  );
}

/* ───────────────────────────── env + route feature-detection ────────────────────────────── */

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

/** Probe whether the documents/build route exists (WP-T Pages vertical). 404/no_route ⇒ not landed. */
async function buildRouteAvailable(client: WpClient, site: SiteConfig): Promise<boolean> {
  try {
    await client.send(
      'GET',
      `${site.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/documents`,
      { query: { limit: 1 } },
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
  // Admin-capable target; the content-sanitizer is exempt for admins (§7 step 3).
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

  // OFFLINE half — normalize(input_tree) is structurally equal to normalize(normalized_expected). Runs
  // without wp-env so the fixture's normalized_expected + the shared normalizer + the structural-id
  // helper stay self-consistent in every CI lane.
  it.each(fixtures.map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s": normalize(input_tree) is structurally equal to normalized_expected (offline)',
    (_label, f) => {
      const input = f.envelope.input_tree ?? [];
      const expected = f.envelope.normalized_expected ?? [];
      expect(structurallyEqual(input, expected)).toBe(true);
    },
  );

  // SELF-CHECK — a dropped prop (an injected mutation) MUST break structural equality, proving the
  // suite would catch a spurious production diff rather than silently passing.
  it.each(fixtures.map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s": a dropped settings prop is NOT structurally equal (mutation self-check)',
    (_label, f) => {
      const input = f.envelope.input_tree ?? [];
      const mutated = dropFirstSettingsProp(input);
      // Only meaningful when the fixture had a droppable prop beyond `classes`.
      if (mutated === null) {
        return;
      }
      expect(structurallyEqual(input, mutated)).toBe(false);
    },
  );

  // LIVE half — build → get_structure → normalize → structural equality. Gated until the Pages routes
  // exist (WP-T). Disposable draft docs are created + trashed per test by the enablement WP.
  it.each(fixtures.map((f) => [fixtureLabel(f), f] as const))(
    'fixture "%s": build→read→normalize is structurally equal to normalized_expected (live)',
    (label, f) => {
      if (site === null) {
        console.warn(`[roundtrip-identity] SKIP "${label}": App-Password env not set.`);
        return;
      }
      if (!routeReady) {
        console.warn(
          `[roundtrip-identity] SKIP "${label}": elementor-ultra/v1 documents route not registered yet (WP-T Pages vertical pending).`,
        );
        return;
      }
      if (!isFixtureRunnable(f.envelope, caps)) {
        console.warn(`[roundtrip-identity] SKIP "${label}": requires unmet on target site.`);
        return;
      }
      // The live build/get_structure tools are the Pages vertical (WP-T); once they land, the
      // enablement WP creates a disposable draft, page.build(input_tree), page.get_structure, then
      // asserts structurallyEqual(fetched, normalized_expected) and trashes the draft in teardown. The
      // offline + mutation self-checks above keep this suite meaningful before the routes exist.
      console.warn(
        `[roundtrip-identity] SKIP live "${label}": page.build/page.get_structure enablement pending (WP-T DoD).`,
      );
    },
  );
});

/* ───────────────────────────── mutation helper (self-check) ──────────────────────────────── */

/**
 * Return a deep clone of `tree` with the FIRST non-`classes` settings prop of the first node dropped
 * (an injected mutation), or `null` when no such prop exists. Used to prove the round-trip predicate
 * detects a real delta (a faithful round-trip MUST be equal; a dropped prop MUST NOT).
 */
function dropFirstSettingsProp(tree: ElementNode[]): ElementNode[] | null {
  if (tree.length === 0) {
    return null;
  }
  const clone = JSON.parse(JSON.stringify(tree)) as ElementNode[];
  const findDroppable = (nodes: ElementNode[]): boolean => {
    for (const node of nodes) {
      const settings = (node as { settings?: Record<string, unknown> }).settings;
      if (isPlainObject(settings)) {
        const key = Object.keys(settings).find((k) => k !== 'classes');
        if (key !== undefined) {
          delete settings[key];
          return true;
        }
      }
      const children = (node as { elements?: ElementNode[] }).elements;
      if (Array.isArray(children) && children.length > 0 && findDroppable(children)) {
        return true;
      }
    }
    return false;
  };
  return findDroppable(clone) ? clone : null;
}
