#!/usr/bin/env node
/**
 * WP-F06 — `pnpm fixtures:validate` (`14-fixtures-harness.md §10`).
 *
 * Schema-validates EVERY fixture file under `packages/shared/fixtures/` against:
 *   1. the fixture envelope schema (`fixtures/envelope.schema.json`, §2) — incl. the rule that
 *      `expect.errors[]` are taxonomy CODES, never raw throw-strings;
 *   2. the embedded `tree[]` / `input_tree[]` / `normalized_expected[]` against the WP-F03 authoring
 *      JSON Schemas (`packages/shared/schemas/*.schema.json`) — EXCEPT for fixtures whose
 *      `prefilter.verdict === "reject"`, which carry a deliberately malformed tree by design (the
 *      [R8] bare-string class). For those the envelope is still validated and the reject is asserted
 *      by the pre-filter + PHP dry_run, not here.
 *
 * Pure Node + Ajv, NO WordPress (§10). Ajv is resolved via the `packages/shared` package (where it is
 * a declared dependency) so this root script needs no ajv at the repo root. Exit 1 on any issue.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHARED_DIR = resolve(ROOT, 'packages/shared');
const SCHEMAS_DIR = resolve(SHARED_DIR, 'schemas');
const FIXTURES_DIR = resolve(SHARED_DIR, 'fixtures');

// Resolve Ajv from the shared package (its dependency), not the repo root.
const sharedRequire = createRequire(join(SHARED_DIR, 'package.json'));
const ajvModule = sharedRequire('ajv/dist/2020.js');
const Ajv2020 = ajvModule.Ajv2020 ?? ajvModule.default ?? ajvModule;

const AUTHORING_SCHEMA_FILES = [
  'atomic-prop-types.schema.json',
  'style-variant.schema.json',
  'element-node.schema.json',
  'page-tree.schema.json',
  'diff.schema.json',
];

const ELEMENT_NODE_REF =
  'https://elementor-ultra-mcp/spec/contracts/schemas/element-node.schema.json#/$defs/ElementNode';

/** Sub-dirs that hold envelope-bearing `*.json` fixtures (mirrors fixture-loader.ts). */
const FIXTURE_SUBDIRS = [
  'trees/v4/valid',
  'trees/v4/invalid',
  'trees/v3/valid',
  'trees/v3/invalid',
  'trees/design',
  'roundtrip',
  'envelopes',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function buildAjv() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const file of AUTHORING_SCHEMA_FILES) {
    ajv.addSchema(readJson(join(SCHEMAS_DIR, file)));
  }
  ajv.addSchema(readJson(join(FIXTURES_DIR, 'envelope.schema.json')), 'fixture-envelope');
  return ajv;
}

const ajv = buildAjv();
const validateEnvelope = ajv.getSchema('fixture-envelope');
const validateNode = ajv.getSchema(ELEMENT_NODE_REF) ?? ajv.compile({ $ref: ELEMENT_NODE_REF });

const issues = [];
let fileCount = 0;

function checkTreeArray(label, key, nodes) {
  if (!Array.isArray(nodes)) {
    return;
  }
  nodes.forEach((node, i) => {
    if (!validateNode(node)) {
      for (const e of validateNode.errors ?? []) {
        issues.push(`${label}/${key}/${i}${e.instancePath} ${e.message}`);
      }
    }
  });
}

for (const sub of FIXTURE_SUBDIRS) {
  const dir = join(FIXTURES_DIR, sub);
  if (!existsSync(dir)) {
    continue;
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) {
      continue;
    }
    fileCount += 1;
    const path = join(dir, name);
    const label = `${sub}/${name}`;
    let obj;
    try {
      obj = readJson(path);
    } catch (e) {
      issues.push(`${label}: not valid JSON (${e.message})`);
      continue;
    }

    // 1. Envelope.
    if (!validateEnvelope(obj)) {
      for (const e of validateEnvelope.errors ?? []) {
        issues.push(`${label}${e.instancePath} ${e.message}`);
      }
      continue; // malformed envelope ⇒ skip the tree check
    }

    // id must equal filename minus .json.
    const expectedId = name.replace(/\.json$/, '');
    if (obj.id !== expectedId) {
      issues.push(`${label}: id "${obj.id}" != filename "${expectedId}" (§2)`);
    }

    // 2. Authoring-tree conformance (skip deliberate rejects).
    if (obj.prefilter?.verdict !== 'reject') {
      checkTreeArray(label, 'tree', obj.tree);
      checkTreeArray(label, 'input_tree', obj.input_tree);
      checkTreeArray(label, 'normalized_expected', obj.normalized_expected);
      if (obj.kind === 'smoke' && Array.isArray(obj.arguments?.elements)) {
        checkTreeArray(label, 'arguments/elements', obj.arguments.elements);
      }
    }
  }
}

if (issues.length > 0) {
  console.error(`[fixtures:validate] ${issues.length} issue(s) across ${fileCount} fixture(s):`);
  for (const issue of issues) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

console.log(
  `[fixtures:validate] OK: ${fileCount} fixture(s) valid (envelope + authoring schemas).`,
);
