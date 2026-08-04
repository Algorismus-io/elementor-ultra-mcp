#!/usr/bin/env node
/**
 * WP-F02 — OpenAPI ⇄ route-registry drift check (the YAML is the source of truth).
 *
 * Full TS codegen from OpenAPI is impractical for this hand-authored, response-shaped surface, so per
 * the ticket ("Detailed Requirements #1") this script instead ASSERTS no drift between the frozen
 * `spec/contracts/openapi.yaml` and the realized route registry / wrappers:
 *
 *   1. Every `operationId` (with its path + method) in the YAML has a matching entry in
 *      `packages/shared/src/rest/routes.ts` `ROUTES` (same key, same METHOD, same path).
 *   2. `ROUTES` has no EXTRA routes the YAML does not declare.
 *   3. Every route name has a 1:1 typed wrapper exported from `packages/server/src/wp/routes.ts`.
 *
 * A missing / extra / mismatched route fails the script (exit 1) so CI catches contract drift. No npm
 * deps: the YAML `paths` block and the TS sources are parsed with line-oriented regexes (the YAML is
 * structurally regular; the TS registry is a flat const map).
 *
 * Usage: `node scripts/gen-openapi-types.mjs` (exit 0 = green, 1 = drift).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const OPENAPI = resolve(ROOT, 'spec/contracts/openapi.yaml');
const ROUTES_TS = resolve(ROOT, 'packages/shared/src/rest/routes.ts');
const WRAPPERS_TS = resolve(ROOT, 'packages/server/src/wp/routes.ts');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/**
 * Parse the OpenAPI `paths:` block. Returns a map of operationId → {method, path}. The YAML is
 * 2-space-indented and regular: a path key is `  /foo:` (2 spaces), a method key is `    get:`
 * (4 spaces), and `operationId:` sits under the method.
 */
function parseOpenApi(yaml) {
  const lines = yaml.split(/\r?\n/);
  const ops = new Map();
  let inPaths = false;
  let currentPath = null;
  let currentMethod = null;

  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    // A new top-level (0-indent, non-empty, non-comment) key ends the paths block.
    if (/^\S/.test(line) && !/^\s/.test(line)) {
      if (!/^paths:/.test(line)) break;
    }

    const pathMatch = line.match(/^ {2}(\/\S*):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentMethod = null;
      continue;
    }
    const methodMatch = line.match(/^ {4}([a-z]+):\s*$/);
    if (methodMatch && HTTP_METHODS.has(methodMatch[1])) {
      currentMethod = methodMatch[1];
      continue;
    }
    const opMatch = line.match(/^ {6}operationId:\s*(\S+)\s*$/);
    if (opMatch && currentPath && currentMethod) {
      ops.set(opMatch[1], { method: currentMethod.toUpperCase(), path: currentPath });
    }
  }
  return ops;
}

/**
 * Parse the `ROUTES` const map in routes.ts. Each entry is a single line:
 *   `  listDocuments: { method: 'GET', path: '/documents', cap: 'CAP_READ' },`
 */
function parseRoutes(ts) {
  const routes = new Map();
  const re =
    /^\s*([A-Za-z0-9_]+):\s*\{\s*method:\s*'([A-Z]+)',\s*path:\s*'([^']+)',\s*cap:\s*'[A-Z_]+'\s*\},/gm;
  let m;
  while ((m = re.exec(ts)) !== null) {
    routes.set(m[1], { method: m[2], path: m[3] });
  }
  return routes;
}

/** Parse the exported wrapper function names from wp/routes.ts. */
function parseWrappers(ts) {
  const names = new Set();
  const re = /^export function ([A-Za-z0-9_]+)\s*\(/gm;
  let m;
  while ((m = re.exec(ts)) !== null) {
    names.add(m[1]);
  }
  return names;
}

function main() {
  const ops = parseOpenApi(readFileSync(OPENAPI, 'utf8'));
  const routes = parseRoutes(readFileSync(ROUTES_TS, 'utf8'));
  const wrappers = parseWrappers(readFileSync(WRAPPERS_TS, 'utf8'));

  const errors = [];

  // 1. Every operationId has a matching ROUTES entry with the same method + path.
  for (const [opId, { method, path }] of ops) {
    const route = routes.get(opId);
    if (!route) {
      errors.push(
        `MISSING route: openapi operationId "${opId}" (${method} ${path}) has no ROUTES entry`,
      );
      continue;
    }
    if (route.method !== method) {
      errors.push(`METHOD drift for "${opId}": openapi=${method} routes=${route.method}`);
    }
    if (route.path !== path) {
      errors.push(`PATH drift for "${opId}": openapi=${path} routes=${route.path}`);
    }
  }

  // 2. No extra ROUTES entries the YAML does not declare.
  for (const opId of routes.keys()) {
    if (!ops.has(opId)) {
      errors.push(`EXTRA route: ROUTES has "${opId}" not present in openapi.yaml`);
    }
  }

  // 3. Every route has a 1:1 typed wrapper.
  for (const opId of routes.keys()) {
    if (!wrappers.has(opId)) {
      errors.push(`MISSING wrapper: route "${opId}" has no exported function in wp/routes.ts`);
    }
  }
  for (const name of wrappers) {
    if (!routes.has(name)) {
      errors.push(`EXTRA wrapper: wp/routes.ts exports "${name}" with no ROUTES entry`);
    }
  }

  if (errors.length > 0) {
    console.error(`gen-openapi-types: ${errors.length} drift error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `gen-openapi-types: OK — ${ops.size} openapi operations == ${routes.size} routes == ${wrappers.size} wrappers (no drift).`,
  );
}

main();
