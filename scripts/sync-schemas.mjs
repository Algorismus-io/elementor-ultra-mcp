#!/usr/bin/env node
/**
 * WP-F03 — Schema sync guard: prove the runtime mirror is byte-identical to the frozen source.
 *
 * The five authoring JSON Schemas live (as the canonical SOURCE) at
 * `spec/contracts/schemas/*.schema.json` and are MIRRORED into `packages/shared/schemas/*` (the
 * runtime location fixtures validate against, `14-fixtures-harness.md §10`). Contracts are
 * append-only within a wave (`15-engineering-standards.md §5.5`): the spec copy is the source, the
 * shared copy is the mirror. This script normalizes both (stable recursive key sort) and asserts
 * structural byte-equality, failing CI (exit 1) on any drift.
 *
 * Run modes:
 *   - `node scripts/sync-schemas.mjs`          → check only (exit 1 on drift). CI default.
 *   - `node scripts/sync-schemas.mjs --write`  → copy spec → shared to repair drift, then re-check.
 *
 * No npm deps: pure Node (fs/path) + JSON.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SPEC_DIR = resolve(ROOT, 'spec/contracts/schemas');
const SHARED_DIR = resolve(ROOT, 'packages/shared/schemas');

/**
 * The frozen schema filenames: the five authoring schemas (the contract set,
 * `11-authoring-contract.md §1`) plus the contract-18 §7-AI S1 document-settings allowlist.
 */
const SCHEMA_FILES = [
  'atomic-prop-types.schema.json',
  'style-variant.schema.json',
  'element-node.schema.json',
  'page-tree.schema.json',
  'diff.schema.json',
  'page-settings.schema.json',
];

/** Recursively sort object keys so two structurally-equal schemas serialize identically. */
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

/** Parse + normalize (recursive key sort) a JSON file to a stable string. */
function normalized(path) {
  const raw = readFileSync(path, 'utf8');
  return JSON.stringify(sortKeys(JSON.parse(raw)), null, 2) + '\n';
}

const write = process.argv.includes('--write');
const drift = [];

for (const file of SCHEMA_FILES) {
  const specPath = resolve(SPEC_DIR, file);
  const sharedPath = resolve(SHARED_DIR, file);

  let specNorm;
  let sharedNorm;
  try {
    specNorm = normalized(specPath);
  } catch (e) {
    console.error(`[sync-schemas] cannot read source schema ${specPath}: ${e.message}`);
    process.exit(1);
  }

  if (write) {
    // Repair: copy the spec source verbatim into the shared mirror.
    writeFileSync(sharedPath, readFileSync(specPath, 'utf8'));
  }

  try {
    sharedNorm = normalized(sharedPath);
  } catch (e) {
    console.error(`[sync-schemas] cannot read mirror schema ${sharedPath}: ${e.message}`);
    process.exit(1);
  }

  if (specNorm !== sharedNorm) {
    drift.push(file);
  }
}

if (drift.length > 0) {
  console.error(
    `[sync-schemas] DRIFT: ${drift.join(', ')} differ between spec/contracts/schemas and ` +
      `packages/shared/schemas. The spec copy is the source; run with --write to repair.`,
  );
  process.exit(1);
}

console.log(`[sync-schemas] OK: ${SCHEMA_FILES.length} schemas byte-identical (normalized).`);
