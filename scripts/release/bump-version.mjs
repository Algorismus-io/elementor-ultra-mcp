#!/usr/bin/env node
/**
 * WP-Q08 — `pnpm bump` (`WP-Q08 Detailed Requirements #5`, Acceptance Criteria, Tests Required).
 *
 * Bumps the server + plugin versions IN LOCKSTEP and updates the changelog. The version lives in
 * FIVE places that MUST stay aligned (the release-lockstep invariant):
 *   1. `packages/server/package.json` `version`        (the npm/npx artifact version)
 *   2. `plugin/elementor-ultra-mcp/elementor-ultra-mcp.php` `Version:` header  (the WP plugin version)
 *   3. the same file's `define( 'EMCP_VERSION', '...' )`  (read by the capability probe)
 *   4. `plugin/elementor-ultra-mcp/readme.txt` `Stable tag:`  (the wp.org-style readme)
 *   5. the repo root `package.json` `version`  (the umbrella/tag version)
 *
 * Plus it prepends a release section to `CHANGELOG.md` (Keep-a-Changelog style): the new version +
 * today's date, with the `[Unreleased]` entries rolled into it (or a placeholder when empty).
 *
 * The TEXT-TRANSFORM core (`bumpSemver`, `setServerVersion`, `setPluginVersion`, `rollChangelog`,
 * `collectVersions`) is pure (string in, string out) so the bump unit test (Tests Required) asserts
 * server + plugin versions move in lockstep WITHOUT touching the filesystem.
 *
 * Usage:
 *   node scripts/release/bump-version.mjs patch|minor|major     # semver bump from current
 *   node scripts/release/bump-version.mjs 1.4.0                 # set an explicit version
 *   node scripts/release/bump-version.mjs --check               # assert all 5 are already aligned
 *   node scripts/release/bump-version.mjs --self-test           # run the embedded lockstep unit test
 *   node scripts/release/bump-version.mjs <bump> --dry-run      # print the new versions, write nothing
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');

export const PATHS = {
  serverPkg: join(ROOT, 'packages', 'server', 'package.json'),
  rootPkg: join(ROOT, 'package.json'),
  pluginBootstrap: join(ROOT, 'plugin', 'elementor-ultra-mcp', 'elementor-ultra-mcp.php'),
  pluginReadme: join(ROOT, 'plugin', 'elementor-ultra-mcp', 'readme.txt'),
  changelog: join(ROOT, 'CHANGELOG.md'),
};

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Apply a semver bump (`major`/`minor`/`patch`) OR pass through an explicit `x.y.z`. */
export function bumpSemver(current, kind) {
  if (SEMVER_RE.test(kind)) return kind; // explicit target
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`bump: cannot parse current version "${current}"`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`bump: unknown bump kind "${kind}" (use major|minor|patch or an explicit x.y.z)`);
}

/** Set the `version` field of a package.json TEXT body (preserves formatting/trailing newline). */
export function setPkgVersion(body, version) {
  if (!/"version"\s*:\s*"[^"]*"/.test(body)) {
    throw new Error('bump: package.json has no "version" field');
  }
  return body.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}

/** Read the `version` from a package.json TEXT body. */
export function getPkgVersion(body) {
  const m = /"version"\s*:\s*"([^"]*)"/.exec(body);
  return m ? m[1] : null;
}

/** Set BOTH the plugin `Version:` header AND `define( 'EMCP_VERSION', '...' )` in the bootstrap TEXT. */
export function setPluginVersion(body, version) {
  let out = body;
  if (!/^\s*\*\s*Version:\s*\S/m.test(out)) {
    throw new Error('bump: plugin bootstrap has no "Version:" header');
  }
  out = out.replace(/(^\s*\*\s*Version:\s*)\S+/m, `$1${version}`);
  if (!/define\(\s*'EMCP_VERSION'\s*,\s*'[^']*'\s*\)/.test(out)) {
    throw new Error("bump: plugin bootstrap has no define( 'EMCP_VERSION', ... )");
  }
  out = out.replace(/(define\(\s*'EMCP_VERSION'\s*,\s*')[^']*('\s*\))/, `$1${version}$2`);
  return out;
}

/** Read the plugin `Version:` header value from the bootstrap TEXT body. */
export function getPluginVersion(body) {
  const m = /^\s*\*\s*Version:\s*(\S+)/m.exec(body);
  return m ? m[1] : null;
}

/** Set the `Stable tag:` value in a readme.txt TEXT body. */
export function setReadmeStableTag(body, version) {
  if (!/^Stable tag:\s*\S/m.test(body)) {
    throw new Error('bump: readme.txt has no "Stable tag:" header');
  }
  return body.replace(/(^Stable tag:\s*)\S+/m, `$1${version}`);
}

/** Read the readme `Stable tag:` value from a readme.txt TEXT body. */
export function getReadmeStableTag(body) {
  const m = /^Stable tag:\s*(\S+)/m.exec(body);
  return m ? m[1] : null;
}

/**
 * Roll the changelog: convert the `[Unreleased]` section into a dated release header for `version`,
 * and start a fresh empty `[Unreleased]` above it. Pure string transform.
 * @param {string} body changelog text
 * @param {string} version new version
 * @param {string} date ISO date (YYYY-MM-DD)
 */
export function rollChangelog(body, version, date) {
  const header = `## [Unreleased]`;
  const released = `## [${version}] - ${date}`;
  const freshUnreleased = `## [Unreleased]\n\n## [${version}] - ${date}`;
  if (body.includes(header)) {
    // Replace the FIRST `## [Unreleased]` with a fresh-unreleased + dated release header.
    return body.replace(header, freshUnreleased);
  }
  // No Unreleased section yet — insert a release section after the top-level title.
  const lines = body.split('\n');
  const titleIdx = lines.findIndex((l) => l.startsWith('# '));
  const insertAt = titleIdx >= 0 ? titleIdx + 1 : 0;
  lines.splice(insertAt, 0, '', released, '', '- Release.');
  return lines.join('\n');
}

/** Read all five tracked versions from disk (for `--check` + the main report). */
export function collectVersions() {
  const out = {};
  out.server = getPkgVersion(readFileSync(PATHS.serverPkg, 'utf8'));
  out.root = getPkgVersion(readFileSync(PATHS.rootPkg, 'utf8'));
  const boot = readFileSync(PATHS.pluginBootstrap, 'utf8');
  out.pluginHeader = getPluginVersion(boot);
  const emcp = /define\(\s*'EMCP_VERSION'\s*,\s*'([^']*)'\s*\)/.exec(boot);
  out.emcp = emcp ? emcp[1] : null;
  out.readme = getReadmeStableTag(readFileSync(PATHS.pluginReadme, 'utf8'));
  return out;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Embedded lockstep unit test (Tests Required: server + plugin versions move together). */
function selfTest() {
  let fails = 0;
  const check = (name, cond) => {
    if (cond) console.log(`  ✓ ${name}`);
    else {
      fails++;
      console.error(`  ✗ ${name}`);
    }
  };

  // bumpSemver
  check('patch 1.2.3 -> 1.2.4', bumpSemver('1.2.3', 'patch') === '1.2.4');
  check('minor 1.2.3 -> 1.3.0', bumpSemver('1.2.3', 'minor') === '1.3.0');
  check('major 1.2.3 -> 2.0.0', bumpSemver('1.2.3', 'major') === '2.0.0');
  check('explicit 4.5.6 passthrough', bumpSemver('1.2.3', '4.5.6') === '4.5.6');

  // LOCKSTEP: server pkg + plugin header + EMCP + readme all land on the SAME new version.
  const target = '2.5.0';
  const serverPkg = setPkgVersion('{\n  "name": "x",\n  "version": "1.0.0"\n}\n', target);
  const pluginBody = setPluginVersion(
    " * Version:           1.0.0\n\ndefine( 'EMCP_VERSION', '1.0.0' );\n",
    target,
  );
  const readmeBody = setReadmeStableTag('Stable tag: 1.0.0\n', target);
  const serverV = getPkgVersion(serverPkg);
  const headerV = getPluginVersion(pluginBody);
  const emcpV = /define\(\s*'EMCP_VERSION'\s*,\s*'([^']*)'/.exec(pluginBody)?.[1];
  const readmeV = getReadmeStableTag(readmeBody);
  check(`server version -> ${target}`, serverV === target);
  check(`plugin header -> ${target}`, headerV === target);
  check(`EMCP_VERSION -> ${target}`, emcpV === target);
  check(`readme Stable tag -> ${target}`, readmeV === target);
  check(
    'LOCKSTEP: server === plugin === EMCP === readme',
    serverV === headerV && headerV === emcpV && emcpV === readmeV,
  );

  // Changelog roll keeps an Unreleased section + adds the dated release.
  const cl = rollChangelog('# Changelog\n\n## [Unreleased]\n\n- Added X.\n', target, '2026-06-07');
  check('changelog keeps [Unreleased]', /## \[Unreleased\]/.test(cl));
  check('changelog adds dated release', cl.includes(`## [${target}] - 2026-06-07`));

  if (fails) {
    console.error(`\nbump self-test: ${fails} case(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nbump self-test: all cases passed.');
}

function checkAligned() {
  const v = collectVersions();
  const set = new Set(Object.values(v));
  const aligned = set.size === 1;
  console.log('[bump] version map:', v);
  if (!aligned) {
    console.error(`[bump] --check FAILED: versions are NOT aligned (${[...set].join(', ')}).`);
    process.exit(1);
  }
  console.log(`[bump] --check OK: all five versions aligned at ${[...set][0]}.`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  if (argv.includes('--check')) return checkAligned();

  const dryRun = argv.includes('--dry-run');
  const kind = argv.find((a) => !a.startsWith('--'));
  if (!kind) {
    console.error(
      '[bump] usage: bump-version.mjs <major|minor|patch|x.y.z> [--dry-run] | --check | --self-test',
    );
    process.exit(1);
  }

  const current = getPkgVersion(readFileSync(PATHS.serverPkg, 'utf8'));
  const next = bumpSemver(current, kind);
  console.log(`[bump] ${current} -> ${next}${dryRun ? ' (dry-run)' : ''}`);

  const serverBody = setPkgVersion(readFileSync(PATHS.serverPkg, 'utf8'), next);
  const rootBody = setPkgVersion(readFileSync(PATHS.rootPkg, 'utf8'), next);
  const pluginBody = setPluginVersion(readFileSync(PATHS.pluginBootstrap, 'utf8'), next);
  const readmeBody = setReadmeStableTag(readFileSync(PATHS.pluginReadme, 'utf8'), next);
  const changelogBody = existsSync(PATHS.changelog)
    ? rollChangelog(readFileSync(PATHS.changelog, 'utf8'), next, today())
    : `# Changelog\n\n## [${next}] - ${today()}\n\n- Release.\n`;

  if (dryRun) {
    console.log('[bump] dry-run — no files written.');
    return;
  }

  writeFileSync(PATHS.serverPkg, serverBody);
  writeFileSync(PATHS.rootPkg, rootBody);
  writeFileSync(PATHS.pluginBootstrap, pluginBody);
  writeFileSync(PATHS.pluginReadme, readmeBody);
  writeFileSync(PATHS.changelog, changelogBody);
  console.log(
    '[bump] updated: server + root package.json, plugin Version/EMCP_VERSION, readme Stable tag, CHANGELOG.md',
  );
  console.log('[bump] verifying lockstep...');
  checkAligned();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`[bump] FAILED: ${err.message}`);
    process.exit(1);
  }
}
