#!/usr/bin/env node
/**
 * WP-S01 assertion harness.
 *
 * Reads the generated atomic CSS for the spike page from the container filesystem
 * (authoritative bytes) and asserts the presence of:
 *   - the LOCAL style selector + declaration
 *   - the GLOBAL class selector + declaration
 *   - the atomic base CSS
 *   - (best-effort) a fonts enqueue marker on the rendered page
 *
 * It shells into the wordpress container via docker compose to cat the files,
 * so it does not depend on the (cache-prone) HTTP delivery of the .css files.
 *
 * Usage:
 *   node s01-assert-css.mjs            # reads spec/spikes/scripts/s01-state.json
 *   node s01-assert-css.mjs <postId> <localStyleId> <globalClassId>
 *
 * Exit code 0 = PASS, 1 = FAIL.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE = [
  'docker', 'compose', '-p', 'elementor-mcp',
  '-f', '/Users/shahmir/projects/elementor-mcp/tools/wp-stack/docker-compose.yml',
].join(' ');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function catInContainer(absPath) {
  try {
    return sh(`${COMPOSE} exec -T wordpress sh -c ${JSON.stringify('cat ' + absPath + ' 2>/dev/null')}`);
  } catch {
    return '';
  }
}

function loadState() {
  const statePath = join(__dirname, 's01-state.json');
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  }
  return null;
}

const argv = process.argv.slice(2);
const state = loadState();
const postId = argv[0] || (state && state.post_id);
const localStyleId = argv[1] || (state && state.local_style_id);
const globalClassId = argv[2] || (state && state.global_class_id);
const cssDir = (state && state.css_dir) || '/var/www/html/wp-content/uploads/elementor/css/';
const permalink = (state && state.permalink) || `http://localhost:8899/?page_id=${postId}`;

if (!postId || !localStyleId || !globalClassId) {
  console.error('FAIL: missing postId/localStyleId/globalClassId (no state file & no args).');
  process.exit(1);
}

const localCss = catInContainer(`${cssDir}local-${postId}-frontend-desktop.css`);
const globalCss = catInContainer(`${cssDir}global-${postId}-frontend-desktop.css`);
const baseCss = catInContainer(`${cssDir}base-desktop.css`);

// Fonts enqueue: pull the rendered page and look for an elementor font handle / google fonts.
let pageHtml = '';
try {
  pageHtml = sh(`curl -s ${JSON.stringify(permalink)}`);
} catch { /* ignore */ }

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

const localSelector = `.e-${''}` && `.${localStyleId}`; // selector is `.elementor .<id>`
check('local CSS file non-empty', localCss.trim().length > 0, `${localCss.trim().length} bytes`);
check('local selector present', localCss.includes(`.${localStyleId}`), `looking for .${localStyleId}`);
check('local declaration present (color/font-size)', /color\s*:/.test(localCss) || /font-size\s*:/.test(localCss), localCss.trim());

check('global CSS file non-empty', globalCss.trim().length > 0, `${globalCss.trim().length} bytes`);
check('global selector present', globalCss.includes(`.${globalClassId}`), `looking for .${globalClassId}`);
check('global declaration present (background/padding)', /background-color\s*:/.test(globalCss) || /padding/.test(globalCss), globalCss.trim());

check('atomic base CSS present', baseCss.trim().length > 0, `${baseCss.trim().length} bytes`);

// Fonts enqueue is best-effort (the fixture uses no custom font-family, so Elementor
// still enqueues the base elementor fonts/icons stylesheet on an atomic render).
const fontsEnqueued = /elementor-frontend|google-fonts|fonts\.googleapis|elementor-icons/i.test(pageHtml);
check('fonts/frontend enqueue on page (best-effort)', fontsEnqueued, fontsEnqueued ? 'found enqueue marker' : 'no marker');

let pass = true;
console.log('S01 CSS ASSERTIONS');
console.log('==================');
for (const c of checks) {
  const required = !c.name.includes('best-effort');
  const status = c.ok ? 'PASS' : (required ? 'FAIL' : 'WARN');
  if (!c.ok && required) pass = false;
  console.log(`[${status}] ${c.name} -> ${c.detail}`);
}
console.log('==================');
console.log('local CSS  :', JSON.stringify(localCss.trim()));
console.log('global CSS :', JSON.stringify(globalCss.trim()));
console.log(pass ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(pass ? 0 : 1);
