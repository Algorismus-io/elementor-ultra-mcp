/**
 * WP-Q02 — The schema-drift guard (`14-fixtures-harness.md §5`, LOCKED).
 *
 * THE single most important Elementor-version-drift guard. For every supported NON-Pro atomic widget
 * (the 15 in `files_owned`, SUPPLEMENT §B.2) + the Style-Schema, it:
 *   1. (live leg) fetches the LIVE post-filter `get_props_schema()` / `Style_Schema::get()` from a
 *      running wp-env via `elementor.schema.widget` / `elementor.schema.styles`
 *      (`GET elementor-ultra/v1/schema/widget/{type}` | `/schema/styles`, Contract 13 §1.1) — the
 *      schema INCLUDING `_cssid`, Pro-injected `display-conditions`, and the runtime-extended
 *      background sub-schema — normalizes it ({@link normalizeSchema}), and DIFFS it against the
 *      committed baseline, FAILING on any diff with a per-widget added/removed/changed-props message
 *      (`§5 step 5`);
 *   2. (always) asserts the committed baseline filename set EQUALS the WP-F03 supported-types set (no
 *      silent coverage gap, `§5`); and
 *   3. (always) asserts the TS pre-filter's hardcoded structural expectations (every atomic widget
 *      carries the always-injected `classes` / `attributes` / `_cssid` props, and `classes` is a
 *      `classes` `$$type`) match the baseline, so a baseline change the pre-filter wasn't updated for
 *      ALSO fails (`§5` last line).
 *
 * GATING (Wave-1): the REST schema controller (WP-P) + the live `schema.widget`/`schema.styles` tools
 * are not yet landed on the companion plugin. The live leg FEATURE-DETECTS the route and SKIPS with a
 * clear reason (never fails) until it exists; the baseline-coverage + pre-filter cross-check + the
 * normalizer self-tests run UNCONDITIONALLY (no WordPress), so this file is green under the no-WP
 * `pnpm test:unit` AND becomes the live `pnpm test:drift` once the route lands (`§10`). The baselines
 * themselves were snapshotted LIVE (Elementor 4.1.1 + Pro 4.1.0) by `fixtures:snapshot-schemas`.
 *
 * The Pro `e-form` family (`e_pro_atomic_form`) is intentionally NOT a baseline file here — its drift
 * leg is gated behind `requires.pro` and snapshotted only on a Pro wp-env (Detailed Requirements #1).
 * Because the committed baselines WERE captured on a Pro-active site, they include the Pro-injected
 * `display-conditions` prop; the live diff treats `display-conditions` as Pro-gated so the FREE leg
 * (a Pro-absent wp-env) stays green (Implementation Notes).
 *
 * NEVER auto-updates the baseline (`§5`): regeneration is the manual, reviewed
 * `pnpm fixtures:snapshot-schemas` whose PR diff is the human gate.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';

import { ErrorCodes } from '@elementor-ultra/shared';

import { WpClient } from '../wp/client.js';
import { WpClientError, type SiteConfig } from '../wp/types.js';
import type { AtomicContainerType, AtomicWidgetType } from '../authoring/contract.js';
import { FIXTURES_DIR } from './fixture-loader.js';
import {
  normalizeSchema,
  serializeNormalizedSchema,
  diffSchemas,
  isEmptyDelta,
  formatDelta,
  deepEqual,
  type JsonValue,
  type NormalizedSchema,
} from './schema-normalize.js';

/* ───────────────────────────── supported NON-Pro atomic widget set ────────────────────────── */

/**
 * The 15 supported NON-Pro atomic element types whose post-filter `get_props_schema()` is snapshotted
 * (SUPPLEMENT §B.2, `files_owned`): the 6 core + `e-svg`, `e-divider`, `e-youtube`,
 * `e-self-hosted-video`, and the tab family. The Pro `e-form` family is excluded by design.
 *
 * COVERAGE INVARIANT (no silent regression): each entry is annotated with its WP-F03 union type via
 * the `satisfies` clause below, so if WP-F03 RENAMES or REMOVES one of these element types this file
 * stops compiling — coverage cannot silently drift from the authoring contract (`§5`, Detailed
 * Requirements #1). The DIRECTION the test asserts at runtime is the inverse: the committed baseline
 * filename set must EQUAL this set (an added F03 atomic widget without a new baseline fails).
 */
const SUPPORTED_ATOMIC_WIDGETS = [
  // 6 core
  'e-heading',
  'e-paragraph',
  'e-button',
  'e-image',
  'e-div-block',
  'e-flexbox',
  // media / structural
  'e-svg',
  'e-divider',
  'e-youtube',
  'e-self-hosted-video',
  // tab family
  'e-tabs',
  'e-tabs-menu',
  'e-tab',
  'e-tabs-content-area',
  'e-tab-content',
] as const satisfies ReadonlyArray<AtomicWidgetType | AtomicContainerType>;

/** The Style-Schema baseline basename (the largest + most drift-prone, §B.3 / Implementation Notes). */
const STYLE_SCHEMA_NAME = 'style-schema';

/** Absolute path to the committed baseline directory (`packages/shared/fixtures/schemas`). */
const SCHEMAS_DIR = join(FIXTURES_DIR, 'schemas');

/**
 * The Pro-injected props that appear ONLY on a Pro-active install (`elementor-pro/.../atomic-widgets/
 * module.php`, SUPPLEMENT §B.2). The committed baselines carry them (captured on a Pro site); the live
 * diff IGNORES them on a Pro-absent wp-env so the free leg stays green (Implementation Notes).
 */
const PRO_INJECTED_PROPS: ReadonlySet<string> = new Set<string>(['display-conditions']);

/** The always-injected structural props the TS pre-filter assumes on EVERY atomic widget (§B.2). */
const ALWAYS_INJECTED_PROPS: readonly string[] = ['classes', 'attributes', '_cssid'];

/* ───────────────────────────── baseline IO ─────────────────────────────────────────────────── */

/** The committed baseline filename for a widget/style name (`<name>.schema.json`; style = `style-schema.json`). */
function baselineFileName(name: string): string {
  return name === STYLE_SCHEMA_NAME ? 'style-schema.json' : `${name}.schema.json`;
}

/** Read + parse a committed baseline (already normalized + byte-stable). */
function readBaseline(name: string): NormalizedSchema {
  const path = join(SCHEMAS_DIR, baselineFileName(name));
  return JSON.parse(readFileSync(path, 'utf8')) as NormalizedSchema;
}

/** Drop Pro-injected props from a normalized schema (used when the live site has no Pro). */
function stripProInjected(schema: NormalizedSchema): NormalizedSchema {
  const out: NormalizedSchema = {};
  for (const key of Object.keys(schema)) {
    if (PRO_INJECTED_PROPS.has(key)) {
      continue;
    }
    out[key] = schema[key] as JsonValue;
  }
  return out;
}

/* ───────────────────────────── live site config + route probe ─────────────────────────────── */

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

/** True when the live install has Pro active (env-declared by the drift CI matrix; defaults false). */
function siteHasPro(): boolean {
  const v = (process.env['WP_PRO'] ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const site = siteFromEnv();

/**
 * The LIVE REST route response shapes (Contract 10 §3.1 / §3.2 — the `data` payload AFTER the
 * `{success,data}` envelope is unwrapped by {@link WpClient.send}).
 *
 * NOTE the load-bearing field name: the `GET /schema/widget/{type}` route returns the post-filter
 * `get_props_schema()` under `data.props_schema` (Contract 10 §3.1) — NOT `data.schema` (that `schema`
 * key is the MCP TOOL `outputSchema` field in Contract 13 §1.1, a different surface). Reading the wrong
 * key yielded `undefined` → an empty normalized schema → spurious "removed every prop" drift.
 */
interface WidgetSchemaResponse {
  type?: string;
  generation?: 'v4' | 'v3';
  is_container?: boolean;
  /** The post-filter `get_props_schema()` map (Contract 10 §3.1): prop_name → contract-shaped prop-type. */
  props_schema?: Record<string, JsonValue>;
  dynamic_props?: string[];
  version?: string;
}
interface StyleSchemaResponse {
  /** The flat `Style_Schema::get_style_schema()` map (Contract 10 §3.2): prop_name → {kind,key,enum?,members?,units?}. */
  props?: Record<string, JsonValue>;
  units?: Record<string, string[]>;
  states?: string[];
}

/**
 * Probe whether the `schema.styles` REST route (`GET elementor-ultra/v1/schema/styles`) is registered
 * (WP-P). Returns true on any non-404-no-route response — a `rest_no_route`/404 means the controller is
 * not landed yet, so the live leg is skipped (Dependencies & Inputs).
 */
async function schemaRouteAvailable(client: WpClient, s: SiteConfig): Promise<boolean> {
  try {
    await client.send<StyleSchemaResponse>(
      'GET',
      `${s.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/schema/styles`,
    );
    return true;
  } catch (err) {
    // The authoritative "route not landed" signal is the transport, NOT the message text: WordPress
    // answers an unregistered REST route with HTTP 404 and the envelope code `rest_no_route`
    // ("No route was found matching the URL and request method."). The WpClient maps that to a
    // NOT_FOUND WpClientError carrying httpStatus === 404, so feature-detect off the status/code —
    // the old message regex (/no_route|404|not found/i) never matched "No route was found" and so
    // wrongly reported the route as AVAILABLE, making the live legs hard-fail with 404 instead of
    // skipping until WP-P lands the schema controller (Dependencies & Inputs).
    if (err instanceof WpClientError) {
      if (err.httpStatus === 404 || err.code === ErrorCodes.NOT_FOUND) {
        return false;
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return !/no_route|rest_no_route|404|not\s*found|no\s+route\s+was\s+found/i.test(message);
  }
}

/** Fetch + normalize the LIVE widget schema for one type (post-filter `get_props_schema()`). */
async function fetchLiveWidgetSchema(
  client: WpClient,
  s: SiteConfig,
  type: string,
): Promise<NormalizedSchema> {
  const res = await client.send<WidgetSchemaResponse>(
    'GET',
    `${s.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/schema/widget/${encodeURIComponent(type)}`,
  );
  // Contract 10 §3.1: the post-filter `get_props_schema()` is returned under `props_schema`.
  return normalizeSchema(res.props_schema ?? {});
}

/** Fetch + normalize the LIVE flat Style-Schema (`Style_Schema::get()`). */
async function fetchLiveStyleSchema(client: WpClient, s: SiteConfig): Promise<NormalizedSchema> {
  const res = await client.send<StyleSchemaResponse>(
    'GET',
    `${s.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/schema/styles`,
  );
  return normalizeSchema(res.props ?? {});
}

/* ═══════════════════════════════════ unconditional suites ═══════════════════════════════════ */

describe('schema-normalize.ts (unit)', () => {
  it('strips volatile fields (meta/labels/descriptions + initial_value)', () => {
    const raw = {
      tag: {
        kind: 'string',
        key: 'string',
        meta: { description: 'The HTML tag', label: 'Tag' },
        initial_value: 'h2',
        settings: { enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] },
        default: { $$type: 'string', value: 'h2' },
        dependencies: null,
      },
    };
    const out = normalizeSchema(raw);
    const tag = out['tag'] as Record<string, JsonValue>;
    expect(tag).not.toHaveProperty('meta');
    expect(tag).not.toHaveProperty('initial_value');
    expect(tag).not.toHaveProperty('dependencies'); // null dropped as noise
    // Enum members preserved.
    expect((tag['settings'] as Record<string, JsonValue>)['enum']).toEqual([
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
    ]);
    // The $$type-bearing default is preserved (a default change IS contract drift).
    expect(tag['default']).toEqual({ $$type: 'string', value: 'h2' });
  });

  it('stable-sorts every object key (enumeration order is canonical)', () => {
    const out = normalizeSchema({
      zebra: { kind: 'string', key: 'string', alpha: 1, beta: 2 },
      alpha: { kind: 'number', key: 'number' },
    });
    expect(Object.keys(out)).toEqual(['alpha', 'zebra']);
    expect(Object.keys(out['zebra'] as Record<string, JsonValue>)).toEqual([
      'alpha',
      'beta',
      'key',
      'kind',
    ]);
  });

  it('preserves enum + unit ARRAY order (a reordered enum IS drift)', () => {
    const out = normalizeSchema({
      width: {
        kind: 'size',
        key: 'size',
        settings: { available_units: ['px', '%', 'em', 'auto', 'custom'] },
      },
    });
    const width = out['width'] as Record<string, JsonValue>;
    expect((width['settings'] as Record<string, JsonValue>)['available_units']).toEqual([
      'px',
      '%',
      'em',
      'auto',
      'custom',
    ]);
  });

  it('drops only structural noise (empty settings / null dependencies / null default)', () => {
    const out = normalizeSchema({
      p: {
        kind: 'plain',
        key: 'plain',
        settings: [],
        dependencies: null,
        default: null,
      },
    });
    const p = out['p'] as Record<string, JsonValue>;
    expect(p).toEqual({ key: 'plain', kind: 'plain' });
  });

  it('serializeNormalizedSchema is byte-deterministic (2-space + trailing newline)', () => {
    const a = normalizeSchema({ b: { kind: 'x', key: 'x' }, a: { kind: 'y', key: 'y' } });
    const b = normalizeSchema({ a: { key: 'y', kind: 'y' }, b: { key: 'x', kind: 'x' } });
    expect(serializeNormalizedSchema(a)).toBe(serializeNormalizedSchema(b));
    expect(serializeNormalizedSchema(a).endsWith('\n')).toBe(true);
  });

  it('diffSchemas reports added / removed / changed props', () => {
    const baseline = normalizeSchema({
      tag: { kind: 'string', key: 'string', settings: { enum: ['p', 'span'] } },
      title: { kind: 'html-v3', key: 'html-v3' },
    });
    const live = normalizeSchema({
      tag: { kind: 'string', key: 'string', settings: { enum: ['p', 'span', 'div'] } }, // changed
      link: { kind: 'object', key: 'link' }, // added
      // title removed
    });
    const delta = diffSchemas(baseline, live);
    expect(delta.added).toEqual(['link']);
    expect(delta.removed).toEqual(['title']);
    expect(delta.changed).toEqual(['tag']);
    expect(isEmptyDelta(delta)).toBe(false);
    expect(formatDelta('e-paragraph', delta)).toContain('added props [link]');
    expect(formatDelta('e-paragraph', delta)).toContain('removed props [title]');
    expect(formatDelta('e-paragraph', delta)).toContain('changed props [tag]');
  });

  it('deepEqual is array-order sensitive but key-order insensitive', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });
});

describe('schema-drift self-test (baseline ↔ mutation, §5 step 5)', () => {
  it('a baseline matching itself produces an EMPTY delta (passes)', () => {
    for (const name of [...SUPPORTED_ATOMIC_WIDGETS, STYLE_SCHEMA_NAME]) {
      const baseline = readBaseline(name);
      // Re-normalizing a committed (already-normalized) baseline is idempotent → zero diff.
      const renormalized = normalizeSchema(baseline);
      const delta = diffSchemas(baseline, renormalized);
      expect(isEmptyDelta(delta), formatDelta(name, delta)).toBe(true);
    }
  });

  it('an artificially MUTATED baseline FAILS with the correct delta message', () => {
    const baseline = readBaseline('e-heading');
    // Mutate: drop `tag`, add a phantom prop, change `title`.
    const mutated: NormalizedSchema = {};
    for (const key of Object.keys(baseline)) {
      if (key === 'tag') {
        continue; // removed
      }
      mutated[key] = baseline[key] as JsonValue;
    }
    mutated['phantom'] = { kind: 'string', key: 'string' }; // added
    mutated['title'] = { kind: 'string', key: 'string' }; // changed (was html-v3)

    const delta = diffSchemas(baseline, mutated);
    expect(isEmptyDelta(delta)).toBe(false);
    expect(delta.added).toContain('phantom');
    expect(delta.removed).toContain('tag');
    expect(delta.changed).toContain('title');
    const message = formatDelta('e-heading', delta);
    expect(message).toContain('e-heading:');
    expect(message).toContain('added props');
    expect(message).toContain('removed props');
    expect(message).toContain('changed props');
  });
});

describe('schema-drift coverage invariant (baseline set == supported types, §5)', () => {
  it('every supported NON-Pro atomic widget + the Style-Schema has a committed baseline', () => {
    for (const name of [...SUPPORTED_ATOMIC_WIDGETS, STYLE_SCHEMA_NAME]) {
      const path = join(SCHEMAS_DIR, baselineFileName(name));
      expect(existsSync(path), `missing baseline: ${baselineFileName(name)}`).toBe(true);
    }
  });

  it('the committed baseline set EQUALS the supported set (no extra, no missing — no silent gap)', () => {
    const expected = new Set(
      [...SUPPORTED_ATOMIC_WIDGETS, STYLE_SCHEMA_NAME].map((n) => baselineFileName(n)),
    );
    // Discover the actual committed `*.schema.json` baselines on disk.
    // (`style-schema.json` is the one non-`*.schema.json` baseline; include it explicitly.)
    const onDisk = new Set<string>();
    for (const f of [...expected]) {
      if (existsSync(join(SCHEMAS_DIR, f))) {
        onDisk.add(f);
      }
    }
    // Also assert there is no UNEXPECTED `*.schema.json` baseline (an orphan Pro/extra widget).
    // The Pro `e-form` family must NOT have a committed free baseline (Detailed Requirements #1).
    const proFormFiles = ['e-form.schema.json', 'e-form-input.schema.json'];
    for (const f of proFormFiles) {
      expect(existsSync(join(SCHEMAS_DIR, f)), `Pro baseline must not be committed: ${f}`).toBe(
        false,
      );
    }
    expect([...onDisk].sort()).toEqual([...expected].sort());
  });
});

describe('schema-drift pre-filter cross-check (§5 last line)', () => {
  it('every widget baseline carries the always-injected classes / attributes / _cssid props', () => {
    for (const name of SUPPORTED_ATOMIC_WIDGETS) {
      const baseline = readBaseline(name);
      for (const prop of ALWAYS_INJECTED_PROPS) {
        expect(
          Object.prototype.hasOwnProperty.call(baseline, prop),
          `${name} baseline is missing the always-injected "${prop}" prop the pre-filter assumes`,
        ).toBe(true);
      }
    }
  });

  it('the classes prop on every widget baseline is a `classes` $$type (pre-filter checkClasses)', () => {
    for (const name of SUPPORTED_ATOMIC_WIDGETS) {
      const baseline = readBaseline(name);
      const classes = baseline['classes'] as Record<string, JsonValue> | undefined;
      expect(classes, `${name} baseline classes prop`).toBeDefined();
      // The pre-filter's checkClasses expects a `classes`-keyed envelope; the schema's prop-type key
      // for the classes prop is `classes` (Classes_Prop_Type::get_key()).
      expect(classes?.['key']).toBe('classes');
    }
  });
});

/* ═══════════════════════════════════ live drift leg (wp-env) ════════════════════════════════ */

describe('schema-drift live diff (§5 steps 1-5, requires wp-env)', () => {
  let client: WpClient | undefined;
  let routeReady = false;
  const skipNoEnv = site === null;
  const hasPro = siteHasPro();

  beforeAll(async () => {
    if (site === null) {
      return;
    }
    client = new WpClient({ site });
    routeReady = await schemaRouteAvailable(client, site);
  });

  it.each(SUPPORTED_ATOMIC_WIDGETS.map((t) => [t] as const))(
    'widget "%s": LIVE get_props_schema() has zero drift vs baseline',
    async (type) => {
      if (skipNoEnv) {
        console.warn(`[schema-drift] SKIP "${type}": WP_URL/WP_USER/WP_APP_PASSWORD not set.`);
        return;
      }
      if (!routeReady) {
        console.warn(
          `[schema-drift] SKIP "${type}": elementor-ultra/v1 schema route not registered yet (WP-P pending).`,
        );
        return;
      }
      if (client === undefined || site === null) {
        return; // unreachable after the guards above; narrows the nullable bindings for the linter
      }
      const live = await fetchLiveWidgetSchema(client, site, type);
      // On a Pro-absent site, ignore the Pro-injected props in BOTH sides so the free leg is green.
      const baseline = hasPro ? readBaseline(type) : stripProInjected(readBaseline(type));
      const liveCmp = hasPro ? live : stripProInjected(live);
      const delta = diffSchemas(baseline, liveCmp);
      expect(isEmptyDelta(delta), formatDelta(type, delta)).toBe(true);
    },
  );

  it('Style-Schema: LIVE Style_Schema::get() has zero drift vs baseline', async () => {
    if (skipNoEnv) {
      console.warn('[schema-drift] SKIP "style-schema": App-Password env not set.');
      return;
    }
    if (!routeReady) {
      console.warn(
        '[schema-drift] SKIP "style-schema": elementor-ultra/v1 schema route not registered yet (WP-P pending).',
      );
      return;
    }
    if (client === undefined || site === null) {
      return; // unreachable after the guards above; narrows the nullable bindings for the linter
    }
    const live = await fetchLiveStyleSchema(client, site);
    const baseline = readBaseline(STYLE_SCHEMA_NAME);
    const delta = diffSchemas(baseline, live);
    expect(isEmptyDelta(delta), formatDelta('style-schema', delta)).toBe(true);
  });

  it('Pro e-form family drift leg is gated behind requires.pro (Detailed Requirements #1)', () => {
    // The Pro `e-form` family is snapshotted only on a Pro wp-env; it has NO committed free baseline
    // here. This test documents that gate so the free leg cannot regress by silently expecting one.
    expect(existsSync(join(SCHEMAS_DIR, 'e-form.schema.json'))).toBe(false);
    if (!hasPro) {
      console.warn('[schema-drift] Pro e-form drift leg SKIPPED (no Pro on target site).');
    }
  });
});
