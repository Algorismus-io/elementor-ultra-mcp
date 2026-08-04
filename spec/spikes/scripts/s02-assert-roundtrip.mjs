#!/usr/bin/env node
/**
 * WP-S02 round-trip assertion harness (reusable by the Templates vertical).
 *
 * Reads /spikes/s02-roundtrip.json (produced by s02-roundtrip-clean.php) and
 * asserts the template save -> get_data -> process_global_styles(insert) pipeline
 * preserved STRUCTURE + ATOMIC STYLES + CLASS REFS with REMAPPED ids and a
 * correctly MERGED global-class relation (no orphan, no dup).
 *
 * Reads the JSON from inside the wpcli container (the scripts dir is mounted at
 * /spikes there). Usage:
 *   node spec/spikes/scripts/s02-assert-roundtrip.mjs [path-to-roundtrip.json]
 * If no path is given it execs `docker compose ... run wpcli cat /spikes/s02-roundtrip.json`.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const REPO = '/Users/shahmir/projects/elementor-mcp';
const COMPOSE = `docker compose -p elementor-mcp -f ${REPO}/tools/wp-stack/docker-compose.yml`;

function loadJson() {
  const argPath = process.argv[2];
  if (argPath && existsSync(argPath)) return JSON.parse(readFileSync(argPath, 'utf8'));
  // local mirror?
  const local = `${REPO}/spec/spikes/scripts/s02-roundtrip.json`;
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf8'));
  const raw = execSync(`${COMPOSE} run --rm -v ${REPO}/spec/spikes/scripts:/spikes wpcli cat /spikes/s02-roundtrip.json`, { encoding: 'utf8' });
  const start = raw.indexOf('{');
  return JSON.parse(raw.slice(start));
}

const data = loadJson();
let pass = 0, fail = 0;
const check = (cond, label) => { if (cond) { console.log(`[PASS] ${label}`); pass++; } else { console.log(`[FAIL] ${label}`); fail++; } };
const arr = (x) => Array.isArray(x) ? x : [];

const sr = data.save_and_read || {};
const ms = data.match_site || {};
const kc = data.keep_create || {};

// ---- SAVE + READ ----
check(sr.element_ids_remapped === true, 'save_item remapped ALL source element ids (replace_elements_ids)');
check(sr.local_style_ids_remapped === true, 'save_item remapped local-style ids to track new element ids');
check(sr.global_ref_present === true, 'stored DB content preserves the global-class ref (s02rt)');
check(arr(sr.stored_style_ids).length === 2, 'both local style maps survived in stored DB content');
check(arr(sr.template_relations).includes('s02rt'), 'save_item REGISTERED global-class relation (s02rt) like editor save');
check(arr(sr.getdata_class_refs).includes('s02rt'), 'get_data content keeps the global-class ref (s02rt)');
check(arr(sr.getdata_snapshot_ids).includes('s02rt'), 'get_data attaches populated global_classes snapshot incl. s02rt');

// ---- MATCH_SITE insert (label match -> reuse, no dup, ref preserved) ----
const msAdded = (ms.updated_global_classes && (ms.updated_global_classes.added_items_order || [])) || [];
check(ms.ref_preserved === true, 'match_site insert preserved the global-class ref in content');
check(msAdded.length === 0, 'match_site insert REUSED existing kit class (no new class added = no dup)');
const msLabelCount = Object.values(ms.kit_labels || {}).filter((l) => l === 's02rt').length;
check(msLabelCount === 1, 'kit has exactly ONE class labelled s02rt after match_site (no orphan/dup)');
check(arr(ms.target_relations).includes('s02rt'), 'match_site target doc relations include the resolved global class (s02rt)');
check(arr(ms.processed_class_refs).filter((c) => c.startsWith('e-')).length === 2, 'match_site processed content still carries both local styles');

// ---- KEEP_CREATE insert (foreign id -> create-as-new + id remap) ----
const kcAdded = (kc.updated_global_classes && (kc.updated_global_classes.added_items_order || [])) || [];
check(kcAdded.length === 1, 'keep_create created exactly one new global class');
check(kcAdded[0] && kcAdded[0].startsWith('g-'), 'keep_create new class id uses g- prefix (generated)');
check(!arr(kc.processed_class_refs).includes(kc.import_id), 'keep_create REMAPPED the foreign class id out of content (no stale id)');
check(arr(kc.processed_class_refs).includes(kcAdded[0]), 'keep_create content references the NEW kit class id (id_map applied)');

console.log(`\nVERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} pass / ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
