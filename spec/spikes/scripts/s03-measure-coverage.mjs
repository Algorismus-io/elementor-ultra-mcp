#!/usr/bin/env node
/**
 * WP-S03 — coverage measurement harness (reusable; basis for WP-Q04 corpus
 * assertion + convert.fidelity_check scoring).
 *
 * Reads each section's convert.result.json (produced by s03-convert-section.mjs)
 * and computes the honest coverage breakdown:
 *
 *   native        — declaration mapped to a save-valid native Style_Schema prop
 *                   (the native tier is further split into local_class /
 *                    global_class by hoisting; both are real native props)
 *   custom_css    — not representable natively; a Pro custom_css.raw variant
 *                   could carry it (Pro-only; stripped on free)
 *   dropped       — not representable at all / stripped text / html-dump
 *
 * Two coverage BANDS are reported (the spec's typed-object props transform/
 * transition/filter/background "must be decomposed into the exact shape or
 * routed to fallback", RESEARCH.md §6.6):
 *
 *   OPTIMISTIC  — credits a converter that PERFECTLY decomposes every typed
 *                 prop (transform, filter, single box-shadow, border radius and
 *                 width) into the exact typed envelope. Upper bound. Empirically
 *                 these
 *                 envelopes DO pass Style_Parser::parse (see s03-validate-tree).
 *   REALISTIC   — the v1-converter band that anchors the gate: typed-object
 *                 props that a v1 converter does not reliably decompose with
 *                 correct visual fidelity (transform, filter/backdrop-filter,
 *                 box-shadow with multiple/complex shadows, background gradients)
 *                 are counted as fallback, not native. This is the number the
 *                 spec's ~60-80% band refers to and the one corpus.manifest.json
 *                 should anchor.
 *
 * Per-property fallback rates for the known-hard properties are tallied so the
 * findings report WHICH props drive the tail.
 *
 * Usage:
 *   node s03-measure-coverage.mjs                 # all sections under fixtures/sections
 *   node s03-measure-coverage.mjs <dir> [<dir>..] # specific section dirs
 *   --json   emit machine-readable JSON (for corpus.manifest.json derivation)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECTIONS_ROOT = join(__dirname, '..', 'fixtures', 'sections');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
let dirs = args.filter((a) => !a.startsWith('--'));
if (dirs.length === 0) {
  dirs = readdirSync(SECTIONS_ROOT)
    .map((d) => join(SECTIONS_ROOT, d))
    .filter((p) => existsSync(join(p, 'convert.result.json')));
}

// REALISTIC policy: reasons (from s03-convert-section classifyDeclaration) that
// the OPTIMISTIC band credits as native via perfect typed decomposition but the
// REALISTIC v1 band demotes to fallback.
const REALISTIC_DEMOTE = new Set([
  'transform-decompose',   // typed transform repeater — visual fidelity risk on real combos
  'filter-decompose',      // typed filter repeater
  'box-shadow-decompose',  // typed shadow repeater (we keep simple ones optimistic, demote here)
]);

function pct(n, d) { return d === 0 ? 0 : +(n / d * 100).toFixed(1); }

function measure(dir) {
  const r = JSON.parse(readFileSync(join(dir, 'convert.result.json'), 'utf8'));
  const total = r.declarations.length;

  // Optimistic tiers straight from the classifier.
  const opt = { native: 0, local_class: 0, global_class: 0, custom_css: 0, dropped: 0 };
  // Realistic tiers (demote typed-decompose native -> custom_css).
  const real = { native: 0, local_class: 0, global_class: 0, custom_css: 0, dropped: 0 };

  for (const d of r.declarations) {
    // optimistic
    if (d.tier === 'native') {
      opt.native++;
      if (d.placement === 'global_class') opt.global_class++;
      else opt.local_class++;
    } else {
      opt[d.tier]++;
    }
    // realistic
    let rtier = d.tier;
    if (d.tier === 'native' && REALISTIC_DEMOTE.has(d.reason)) rtier = 'custom_css';
    if (rtier === 'native') {
      real.native++;
      if (d.placement === 'global_class') real.global_class++;
      else real.local_class++;
    } else {
      real[rtier]++;
    }
  }

  // per-property hard-prop fallback rates: among declarations of each hard family,
  // how many fall to custom_css/dropped (realistic band).
  const hardFamilies = {};
  for (const d of r.declarations) {
    if (!d.hard) continue;
    const f = hardFamilies[d.hard] || { total: 0, fellOpt: 0, fellReal: 0 };
    f.total++;
    if (d.tier !== 'native') f.fellOpt++;
    let rtier = d.tier;
    if (d.tier === 'native' && REALISTIC_DEMOTE.has(d.reason)) rtier = 'custom_css';
    if (rtier !== 'native') f.fellReal++;
    hardFamilies[d.hard] = f;
  }

  return {
    section: r.section,
    nodes: r.nodeCount,
    declarations: total,
    stripped: r.stripped,
    optimistic: {
      native_pct: pct(opt.native, total),
      local_class_pct: pct(opt.local_class, total),
      global_class_pct: pct(opt.global_class, total),
      custom_css_pct: pct(opt.custom_css, total),
      dropped_pct: pct(opt.dropped, total),
      counts: opt,
    },
    realistic: {
      native_pct: pct(real.native, total),
      local_class_pct: pct(real.local_class, total),
      global_class_pct: pct(real.global_class, total),
      custom_css_pct: pct(real.custom_css, total),
      dropped_pct: pct(real.dropped, total),
      counts: real,
    },
    hard_properties: hardFamilies,
  };
}

const perSection = dirs.map((d) => measure(resolve(d)));

// corpus aggregate (declaration-weighted across all sections)
const agg = (band) => {
  const totals = { native: 0, local_class: 0, global_class: 0, custom_css: 0, dropped: 0 };
  let decls = 0;
  for (const s of perSection) {
    decls += s.declarations;
    for (const k of Object.keys(totals)) totals[k] += s[band].counts[k];
  }
  return {
    declarations: decls,
    native_pct: pct(totals.native, decls),
    local_class_pct: pct(totals.local_class, decls),
    global_class_pct: pct(totals.global_class, decls),
    custom_css_pct: pct(totals.custom_css, decls),
    dropped_pct: pct(totals.dropped, decls),
  };
};

const corpus = { optimistic: agg('optimistic'), realistic: agg('realistic') };

// corpus-wide hard-property fallback rates (realistic)
const hardCorpus = {};
for (const s of perSection) {
  for (const [fam, f] of Object.entries(s.hard_properties)) {
    const h = hardCorpus[fam] || { total: 0, fellReal: 0, fellOpt: 0 };
    h.total += f.total; h.fellReal += f.fellReal; h.fellOpt += f.fellOpt;
    hardCorpus[fam] = h;
  }
}

if (asJson) {
  console.log(JSON.stringify({ perSection, corpus, hardCorpus }, null, 2));
  process.exit(0);
}

// ---- human report ----
console.log('WP-S03 HTML->native COVERAGE MEASUREMENT');
console.log('=======================================');
for (const s of perSection) {
  console.log(`\n## ${s.section}  (nodes=${s.nodes}, authored-declarations=${s.declarations})`);
  console.log(`   OPTIMISTIC  native=${s.optimistic.native_pct}%  ` +
    `[local=${s.optimistic.local_class_pct}% global=${s.optimistic.global_class_pct}%]  ` +
    `custom_css=${s.optimistic.custom_css_pct}%  dropped=${s.optimistic.dropped_pct}%`);
  console.log(`   REALISTIC   native=${s.realistic.native_pct}%  ` +
    `[local=${s.realistic.local_class_pct}% global=${s.realistic.global_class_pct}%]  ` +
    `custom_css=${s.realistic.custom_css_pct}%  dropped=${s.realistic.dropped_pct}%`);
  const hp = Object.entries(s.hard_properties)
    .map(([k, f]) => `${k} ${f.fellReal}/${f.total} fall`).join('  ');
  if (hp) console.log(`   hard-props: ${hp}`);
  if (s.stripped.length) {
    const tags = [...new Set(s.stripped.flatMap((x) => x.stripped))];
    console.log(`   stripped-text tags: ${tags.join(', ')}`);
  }
}
console.log('\n=======================================');
console.log('CORPUS (declaration-weighted):');
console.log(`   OPTIMISTIC  native=${corpus.optimistic.native_pct}%  ` +
  `custom_css=${corpus.optimistic.custom_css_pct}%  dropped=${corpus.optimistic.dropped_pct}%`);
console.log(`   REALISTIC   native=${corpus.realistic.native_pct}%  ` +
  `custom_css=${corpus.realistic.custom_css_pct}%  dropped=${corpus.realistic.dropped_pct}%`);
console.log('\nCORPUS hard-property fallback rates (realistic):');
for (const [fam, h] of Object.entries(hardCorpus).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`   ${fam.padEnd(24)} ${h.fellReal}/${h.total} fall  (${pct(h.fellReal, h.total)}%)`);
}
