#!/usr/bin/env node
/**
 * WP-Q08 — `pnpm verify:package` (`WP-Q08 Detailed Requirements #3/#4`, Acceptance Criteria,
 * `14-fixtures-harness.md §10` release gate).
 *
 * THE packaging test (Tests Required): it validates the PACKED artifacts, not the repo.
 *
 *   A) SDK 2.x release gate — re-run `scripts/ci/check-sdk-version.mjs` (`§7`). A 2.x dep fails here.
 *   B) Server tarball — build it via `pack:server` (unless `--server-tarball <path>` given), INSTALL
 *      it into a throwaway temp dir with `npm install --no-save <tgz>`, then RUN the installed bin:
 *        - with NO env: assert clean exit (0) + the "missing required environment variable(s)" notice
 *          (the bin's documented no-config probe path);
 *        - with env set: assert the bin does NOT crash on startup (exit 1) within a short window — a
 *          stdio server stays up, so a timeout == healthy; an immediate non-zero exit == defect.
 *      Also asserts the INSTALLED bin file carries the node shebang + the SDK `^1.29` pin in the
 *      installed manifest (the two npx traps, on the packed artifact — Implementation Notes).
 *   C) Plugin zip — build it via `pack:plugin` (unless `--plugin-zip <path>` given) and validate its
 *      STRUCTURE without unzipping to a WP install: exactly one top-level dir == the plugin slug; the
 *      bootstrap `<slug>.php` present with a `Plugin Name:` + `Version:` header, `Requires Plugins:
 *      elementor`, and a `register_activation_hook(` call; `readme.txt` with a `Stable tag:`.
 *
 * Any defect FAILS the release (exit 1). Pure Node; shells out to `npm`, `unzip -l`/`unzip -p`, and
 * the sibling pack scripts.
 *
 * Usage:
 *   node scripts/release/verify-package.mjs                          # pack both + verify
 *   node scripts/release/verify-package.mjs --server-tarball <tgz>   # verify a prebuilt tarball
 *   node scripts/release/verify-package.mjs --plugin-zip <zip>       # verify a prebuilt zip
 *   node scripts/release/verify-package.mjs --skip-server | --skip-plugin
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLISH_NAME, SDK_REQUIRED_RANGE, assertSdkPin } from './pack-server.mjs';
import { PLUGIN_SLUG } from './pack-plugin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

function log(msg) {
  console.log(`[verify:package] ${msg}`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

class VerifyError extends Error {}

/** Run a sibling pack script and return its last stdout line (the artifact path). */
function runPack(script, extraArgs = []) {
  const out = execFileSync(process.execPath, [join(HERE, script), ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n');
  return lines[lines.length - 1];
}

/** --- A) SDK 2.x release gate ------------------------------------------------------------------ */
function verifySdkGate() {
  log('A) SDK 2.x release gate...');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'ci', 'check-sdk-version.mjs')], {
    stdio: 'inherit',
  });
  ok('SDK pin clean (no @modelcontextprotocol 2.x).');
}

/** --- B) Server tarball ------------------------------------------------------------------------ */
function verifyServerTarball(tgzPath) {
  log('B) server tarball...');
  if (!existsSync(tgzPath)) throw new VerifyError(`server tarball not found: ${tgzPath}`);

  const tmp = mkdtempSync(join(tmpdir(), 'ultra-verify-server-'));
  try {
    // Install the PACKED tarball (no registry, no save) into an isolated project.
    execFileSync('npm', ['init', '-y'], { cwd: tmp, stdio: 'ignore' });
    log(`  installing ${tgzPath} into ${tmp} ...`);
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', tgzPath], {
      cwd: tmp,
      stdio: 'inherit',
    });

    // Resolve the installed package dir + bin from its manifest (asserts the publish name installed).
    const pkgDir = join(tmp, 'node_modules', PUBLISH_NAME);
    const manifestPath = join(pkgDir, 'package.json');
    if (!existsSync(manifestPath)) {
      throw new VerifyError(
        `installed package manifest not found at ${manifestPath} (publish name drift?)`,
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    ok(`installed as ${manifest.name}@${manifest.version}`);

    // npx trap #2 — SDK pin on the INSTALLED manifest.
    assertSdkPin(manifest);
    ok(`SDK pinned to ${SDK_REQUIRED_RANGE} in installed manifest`);

    // npx trap #1 — shebang on the INSTALLED bin file.
    const binRel =
      typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
    if (!binRel) throw new VerifyError('installed manifest has no bin entry.');
    const binAbs = join(pkgDir, binRel);
    if (!existsSync(binAbs)) throw new VerifyError(`installed bin not found at ${binAbs}`);
    const firstLine = readFileSync(binAbs, 'utf8').split('\n', 1)[0] ?? '';
    if (!/^#!.*\bnode\b/.test(firstLine)) {
      throw new VerifyError(
        `installed bin missing node shebang (got ${JSON.stringify(firstLine)})`,
      );
    }
    ok(`bin shebang present (${firstLine})`);

    // Run the bin with NO env: documented clean-exit probe path.
    const noEnv = spawnSync(process.execPath, [binAbs], {
      cwd: tmp,
      env: stripWpEnv(process.env),
      encoding: 'utf8',
      timeout: 20000,
    });
    if (noEnv.status !== 0) {
      throw new VerifyError(
        `bin (no env) exited ${noEnv.status} (expected 0). stderr:\n${noEnv.stderr}`,
      );
    }
    if (!/missing required environment variable/i.test(noEnv.stderr)) {
      throw new VerifyError(
        `bin (no env) did not print the missing-env notice. stderr:\n${noEnv.stderr}`,
      );
    }
    ok('bin runs + exits cleanly with no env (prints config notice)');

    // Run the bin WITH env over stdio: it must not crash (exit 1) on startup. A stdio server stays
    // up, so a clean timeout == healthy startup; an immediate non-zero exit == defect.
    const withEnv = spawnSync(process.execPath, [binAbs], {
      cwd: tmp,
      env: {
        ...stripWpEnv(process.env),
        WP_URL: 'http://localhost:8899',
        WP_USER: 'admin',
        WP_APP_PASSWORD: 'xxxx xxxx xxxx xxxx xxxx xxxx',
        ULTRA_TOOLS: 'lean',
        MCP_TRANSPORT: 'stdio',
      },
      encoding: 'utf8',
      timeout: 8000, // SIGTERM after 8s; a running stdio server is the success signal.
    });
    // timeout => signal 'SIGTERM' + null status: healthy (server stayed up). status 0: also fine
    // (scaffold core may exit 0). status 1 / other non-zero: a real startup crash.
    if (withEnv.status !== null && withEnv.status !== 0) {
      throw new VerifyError(
        `bin (with env) crashed on startup: exit ${withEnv.status}. stderr:\n${withEnv.stderr}`,
      );
    }
    ok(
      withEnv.signal
        ? `bin (with env) started over stdio and stayed up (clean ${withEnv.signal})`
        : 'bin (with env) started + exited cleanly',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Drop WP_* / MCP_* / ULTRA_* from an env clone so the "no env" probe is truly bare. */
function stripWpEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(WP_|MCP_|ULTRA_)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** --- C) Plugin zip --------------------------------------------------------------------------- */
function verifyPluginZip(zipPath) {
  log('C) plugin zip...');
  if (!existsSync(zipPath)) throw new VerifyError(`plugin zip not found: ${zipPath}`);

  // List entries (no extraction needed for the structure assertions).
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Exactly one top-level dir, == the plugin slug (the install + mu-plugin layout requirement).
  const topLevel = new Set(listing.map((e) => e.split('/')[0]));
  if (topLevel.size !== 1 || !topLevel.has(PLUGIN_SLUG)) {
    throw new VerifyError(
      `zip top-level must be a single dir "${PLUGIN_SLUG}/" (got: ${[...topLevel].join(', ')}). ` +
        `Required for both plugin install AND mu-plugin drop (01-architecture §6.3).`,
    );
  }
  ok(`single top-level dir "${PLUGIN_SLUG}/" (installable + mu-plugin-droppable)`);

  const expectFile = (rel) => {
    const entry = `${PLUGIN_SLUG}/${rel}`;
    if (!listing.includes(entry)) throw new VerifyError(`zip missing required entry: ${entry}`);
    return entry;
  };
  const bootstrap = expectFile(`${PLUGIN_SLUG}.php`);
  expectFile('readme.txt');
  ok('bootstrap + readme.txt present');

  // Tests/dev must be pruned (.distignore intent).
  const leaked = listing.filter(
    (e) => /\/(tests|node_modules)\//.test(`/${e}`) || /\.distignore$/.test(e),
  );
  if (leaked.length) {
    throw new VerifyError(
      `zip leaked dev/test files (.distignore not applied): ${leaked.join(', ')}`,
    );
  }
  ok('tests/dev pruned via .distignore');

  // Read the bootstrap + readme bodies from the zip stream and assert the headers/hook.
  const bootstrapBody = execFileSync('unzip', ['-p', zipPath, bootstrap], { encoding: 'utf8' });
  const assertIn = (body, re, what) => {
    if (!re.test(body)) throw new VerifyError(`bootstrap missing ${what}`);
  };
  assertIn(bootstrapBody, /Plugin Name:\s*\S/i, 'a "Plugin Name:" header');
  assertIn(bootstrapBody, /Version:\s*[0-9]/i, 'a "Version:" header');
  assertIn(
    bootstrapBody,
    /Requires Plugins:\s*elementor/i,
    'a "Requires Plugins: elementor" header',
  );
  assertIn(bootstrapBody, /register_activation_hook\s*\(/, 'a register_activation_hook() call');
  ok('bootstrap header (Plugin Name + Version + Requires Plugins: elementor) + activation hook');

  const readmeBody = execFileSync('unzip', ['-p', zipPath, `${PLUGIN_SLUG}/readme.txt`], {
    encoding: 'utf8',
  });
  if (!/Stable tag:\s*[0-9]/i.test(readmeBody)) {
    throw new VerifyError('readme.txt missing a "Stable tag:" header');
  }
  ok('readme.txt Stable tag present');
}

function parseArgs(argv) {
  const args = { server: true, plugin: true, serverTarball: null, pluginZip: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-server') args.server = false;
    else if (a === '--skip-plugin') args.plugin = false;
    else if (a === '--server-tarball')
      args.serverTarball = resolve(process.cwd(), argv[++i] ?? '.');
    else if (a === '--plugin-zip') args.pluginZip = resolve(process.cwd(), argv[++i] ?? '.');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  verifySdkGate();

  if (args.server) {
    const tgz = args.serverTarball ?? runPack('pack-server.mjs');
    verifyServerTarball(tgz);
  } else {
    log('B) server tarball — skipped (--skip-server).');
  }

  if (args.plugin) {
    const zip = args.pluginZip ?? runPack('pack-plugin.mjs');
    verifyPluginZip(zip);
  } else {
    log('C) plugin zip — skipped (--skip-plugin).');
  }

  log('OK — all packaged artifacts verified.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`[verify:package] FAILED: ${err.message}`);
    process.exit(1);
  }
}
