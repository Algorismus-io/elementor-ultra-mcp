#!/usr/bin/env node
// Smoke test for the elementor-ultra skill lib (contract 18 §7-AI S3/S5/S6 client halves).
//
//   node scripts/smoke-skill-cli.mjs            offline checks only (kit helpers + crops + usage)
//   node scripts/smoke-skill-cli.mjs --live     additionally exercises audit/fonts against WP_URL
//                                               (creds from env or .mcp.json; never writes)
//
// Offline: M()/AUTO, _t tablet variant, RADT/RADB, css() variant custom_css, fontLoader,
// hamburgerNav _m deep-merge, emit() manifest validation (AF1 guard + nav_bindings shape),
// cli.mjs crops band slicing, and the P3-c convert exit-code contract (static assertion).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(REPO, '.claude/skills/elementor-ultra/lib');
const CLI = join(LIB, 'cli.mjs');
const live = process.argv.includes('--live');
let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`PASS  ${name}`);
};

/* ───────── kit helpers ───────── */
const { node, S, M, AUTO, RADT, RADB, css, fontLoader, hamburgerNav, emit } = await import(
  join(LIB, 'kit.mjs')
);

const m = M(0, 'auto', 0, AUTO);
assert.equal(m.value['inline-end'].value.unit, 'auto');
assert.equal(m.value['inline-start'].value.unit, 'auto');
assert.equal(m.value['block-start'].value.size, 0);
ok('kit: M(t,r,b,l) accepts numbers, "auto", and AUTO');

const n = node('e-flexbox', {
  tag: 'div',
  props: { padding: M(0), display: S('flex'), _t: { gap: S('8') }, _m: { display: S('none') } },
});
assert.deepEqual(
  Object.values(n.styles)[0].variants.map((v) => v.meta.breakpoint),
  ['desktop', 'tablet', 'mobile'],
);
ok('kit: props._t emits a tablet variant between desktop and mobile');

assert.equal(RADT(8).value['start-start'].value.size, 8);
assert.equal(RADT(8).value['end-end'].value.size, 0);
assert.equal(RADB(8).value['end-end'].value.size, 8);
assert.equal(RADB(8).value['start-start'].value.size, 0);
ok('kit: RADT/RADB per-corner radius');

css(n, '& em { color: #f43; }');
const dv = Object.values(n.styles)[0].variants.find((v) => v.meta.breakpoint === 'desktop');
assert.ok(
  Buffer.from(dv.custom_css.raw, 'base64').toString().includes('em'),
  'custom_css base64 round-trip',
);
const bare = node('e-div-block', { tag: 'div' });
css(bare, 'outline: 1px solid red;');
assert.ok(
  bare.settings.classes.value.includes(Object.keys(bare.styles)[0]),
  'css() links a created style',
);
ok('kit: css(node, decls) attaches base64 variant custom_css and keeps classes linked');

const fl = fontLoader('JetBrains Mono', [700, 400]);
assert.ok(fl.settings.html.includes('JetBrains+Mono:wght@400;700'));
assert.equal(fl.widgetType, 'html');
ok('kit: fontLoader emits one classic html widget with a sorted css2 link');

const h = hamburgerNav('main-nav', { _m: { gap: S('4') } });
const hm = Object.values(h.styles)[0].variants.find((v) => v.meta.breakpoint === 'mobile');
assert.equal(
  hm.props.display.value,
  'flex',
  'custom _m must MERGE with defaults, not replace them',
);
assert.equal(hm.props.gap.value, '4');
assert.equal(hm.props.margin.value['inline-start'].value.unit, 'auto');
ok('kit: hamburgerNav _m deep-merges with the display:flex + auto-margin defaults');

await assert.rejects(
  emit(
    {
      title: 'x',
      elements: [node('e-flexbox', { props: { padding: M(0) } })],
      settings: { custom_css: { raw: 'x' } },
    },
    '/tmp/smoke-never.json',
  ),
  /AF1/,
);
ok('emit: page-settings custom_css OBJECT rejected (AF1 inverse trap)');
await assert.rejects(
  emit(
    {
      title: 'x',
      elements: [node('e-flexbox', { props: { padding: M(0) } })],
      nav_bindings: [{ widget_index: 0 }],
    },
    '/tmp/smoke-never.json',
  ),
  /menu_slug/,
);
ok('emit: nav_bindings entries require menu_slug');
const tmp = mkdtempSync(join(tmpdir(), 'skill-smoke-'));
const specPath = await emit(
  {
    title: 'smoke',
    elements: [node('e-flexbox', { props: { padding: M(0) } })],
    template: 'elementor_canvas',
    nav_bindings: [{ widget_index: 0, menu_slug: 'main' }],
  },
  join(tmp, 'spec.json'),
);
assert.ok(JSON.parse(readFileSync(specPath, 'utf8')).nav_bindings[0].menu_slug === 'main');
ok('emit: full manifest {title, elements, settings, template, nav_bindings} round-trips');

/* ───────── cli.mjs offline ───────── */
const usage = spawnSync('node', [CLI], { encoding: 'utf8' });
assert.equal(usage.status, 2);
for (const verb of [
  'replace',
  'deploy',
  'audit',
  'capture',
  'crops',
  'diff',
  'fonts',
  'font-install',
  'upload-from-path',
]) {
  assert.ok(usage.stderr.includes(verb), `usage mentions ${verb}`);
}
ok('cli: usage lists every contract-18 verb and exits 2');

// P3-c static guard: convert must exit 2 on css_primed:false (not warn-and-exit-0).
const cliSrc = readFileSync(CLI, 'utf8');
assert.ok(
  /css_primed === false[\s\S]{0,400}?process\.exit\(2\)/.test(cliSrc),
  'convert exits 2 on unprimed',
);
ok('cli: convert exits 2 when css_primed:false (P3-c)');

// crops: slice a synthetic 100x2500 PNG into 1000px bands.
const pngMod = await import(join(REPO, 'packages/server/node_modules/pngjs/lib/png.js'));
const PNG = pngMod.PNG ?? pngMod.default.PNG;
const tall = new PNG({ width: 100, height: 2500 });
tall.data.fill(200);
const tallPath = join(tmp, 'tall.png');
writeFileSync(tallPath, PNG.sync.write(tall));
const out = execFileSync('node', [CLI, 'crops', tallPath], { encoding: 'utf8' }).trim().split('\n');
assert.equal(out.length, 3, '2500px / 1000px bands = 3 slices');
assert.ok(existsSync(out[0]) && out[0].endsWith('band00.png'));
assert.equal(PNG.sync.read(readFileSync(out[2])).height, 500, 'last band is the 500px remainder');
const one = execFileSync('node', [CLI, 'crops', tallPath, '1'], { encoding: 'utf8' })
  .trim()
  .split('\n');
assert.equal(one.length, 1);
assert.ok(one[0].endsWith('band01.png'));
ok('cli: crops slices bands (all + single-band selection)');

/* ───────── live (opt-in) ───────── */
if (live) {
  const env = { ...process.env, ULTRA_REPO: REPO };
  const audit = spawnSync('node', [CLI, 'audit', `${wpUrl()}/?page_id=2778`], {
    encoding: 'utf8',
    env,
    timeout: 180000,
  });
  assert.ok(
    /AUDIT /.test(audit.stdout) &&
      /overflow @1440/.test(audit.stdout) &&
      /fonts \(STATUS enumeration\)/.test(audit.stdout),
    audit.stdout + audit.stderr,
  );
  ok(`cli: audit ran against page 2778 (exit ${audit.status})`);
  const fonts = spawnSync('node', [CLI, 'fonts'], { encoding: 'utf8', env, timeout: 120000 });
  assert.equal(fonts.status, 0, fonts.stderr);
  assert.ok(/FAMILY/.test(fonts.stdout));
  ok('cli: fonts lists registered families with Google-catalog match');
}

function wpUrl() {
  if (process.env.WP_URL) return process.env.WP_URL;
  return JSON.parse(readFileSync(join(REPO, '.mcp.json'), 'utf8')).mcpServers['elementor-ultra'].env
    .WP_URL;
}

console.log(
  `\n${passed} smoke check(s) passed${live ? ' (incl. live)' : ' (offline; pass --live for audit/fonts against the site)'}`,
);
