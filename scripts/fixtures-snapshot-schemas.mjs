#!/usr/bin/env node
/**
 * WP-F06 — `pnpm fixtures:snapshot-schemas` (`14-fixtures-harness.md §5`).
 *
 * Regenerates the schema-drift BASELINE under `packages/shared/fixtures/schemas/*.schema.json` from a
 * LIVE wp-env install, by fetching the post-filter `get_props_schema()` per supported atomic widget
 * (`GET elementor-ultra/v1/schema/widget/{type}`) and the flat Style-Schema
 * (`GET elementor-ultra/v1/schema/styles`), then normalizing (stable recursive key sort; strip
 * volatile label/description fields) so a re-snapshot is byte-stable.
 *
 * THIS IS A MANUAL, REVIEWED ACTION (§5): the diff in the PR is the human gate. The schema-drift CI
 * JOB (WP-Q02) NEVER calls this script — it only DIFFS the live schema against this committed
 * baseline and FAILS on mismatch. Running this script auto-updating the baseline inside the drift job
 * would defeat its purpose.
 *
 * Env (App-Password, `13-tool-catalog.md §5.4`): WP_URL, WP_USER, WP_APP_PASSWORD. If unset or the
 * route is absent (WP-P / schema controller pending), the script SKIPS with a clear message (exit 0)
 * so it is safe to invoke before the controllers land.
 *
 * Pure Node (global fetch), no npm deps.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCHEMAS_OUT = resolve(ROOT, 'packages/shared/fixtures/schemas');

/** The supported atomic widget/element types to snapshot (11-authoring-contract.md §4 / SUPPLEMENT §B.2). */
const ATOMIC_TYPES = [
  'e-heading',
  'e-paragraph',
  'e-button',
  'e-image',
  'e-svg',
  'e-divider',
  'e-youtube',
  'e-self-hosted-video',
  'e-div-block',
  'e-flexbox',
  'e-tabs',
  'e-tabs-menu',
  'e-tab',
  'e-tabs-content-area',
  'e-tab-content',
  'e-form',
  'e-form-success-message',
  'e-form-error-message',
];

const url = process.env.WP_URL;
const user = process.env.WP_USER;
const appPassword = process.env.WP_APP_PASSWORD;

if (!url || !user || !appPassword) {
  console.warn(
    '[fixtures:snapshot-schemas] SKIP: set WP_URL, WP_USER, WP_APP_PASSWORD to snapshot from a live ' +
      'wp-env install (this is a manual, reviewed action — never run in the drift job).',
  );
  process.exit(0);
}

const base = `${url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1`;
const auth = 'Basic ' + Buffer.from(`${user}:${appPassword}`).toString('base64');

/** Stable recursive key sort + strip volatile fields so a re-snapshot is byte-identical (§5 step 3). */
const VOLATILE_KEYS = new Set(['label', 'description', 'title', 'placeholder']);
function normalize(value) {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) {
        continue;
      }
      out[key] = normalize(value[key]);
    }
    return out;
  }
  return value;
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    // Plain-permalink false positive or missing route (S06/R4): bail clearly.
    throw new Error(
      `non-JSON response from ${path} (HTTP ${res.status}, content-type ${ct}) — route may be ` +
        `unregistered (WP-P pending) or permalinks are plain.`,
    );
  }
  const body = JSON.parse(text);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${path}: ${body?.code ?? 'error'}`);
  }
  // Unwrap the {success,data} envelope when present.
  return body && typeof body === 'object' && 'data' in body && body.success === true
    ? body.data
    : body;
}

function unwrapSchema(payload) {
  // schema.widget returns {kind, schema, dynamic_props, version}; we snapshot the post-filter `schema`.
  if (payload && typeof payload === 'object' && 'schema' in payload) {
    return payload.schema;
  }
  return payload;
}

async function main() {
  if (!existsSync(SCHEMAS_OUT)) {
    mkdirSync(SCHEMAS_OUT, { recursive: true });
  }

  let written = 0;
  try {
    for (const type of ATOMIC_TYPES) {
      const payload = await getJson(`/schema/widget/${encodeURIComponent(type)}`);
      const schema = normalize(unwrapSchema(payload));
      const out = join(SCHEMAS_OUT, `${type}.schema.json`);
      writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
      written += 1;
    }

    const styles = await getJson('/schema/styles');
    writeFileSync(
      join(SCHEMAS_OUT, 'style-schema.json'),
      JSON.stringify(normalize(styles), null, 2) + '\n',
    );
    written += 1;
  } catch (e) {
    console.warn(
      `[fixtures:snapshot-schemas] SKIP after ${written} file(s): ${e.message}\n` +
        `  The schema controllers (WP-P) may not be registered yet; re-run once they land.`,
    );
    process.exit(0);
  }

  console.log(
    `[fixtures:snapshot-schemas] OK: wrote ${written} baseline schema(s) to packages/shared/fixtures/schemas/.\n` +
      `  Review the diff in the PR — this is the human drift gate (§5).`,
  );
}

main();
