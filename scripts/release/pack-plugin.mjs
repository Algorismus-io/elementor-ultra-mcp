#!/usr/bin/env node
/**
 * WP-Q08 — `pnpm pack:plugin` (`WP-Q08 Detailed Requirements #2`, `01-architecture.md §6.3`, RESEARCH §8).
 *
 * Produces `elementor-ultra-mcp.zip`: the installable companion WordPress plugin. The SAME codebase
 * is installable as a NORMAL plugin (`wp-content/plugins/elementor-ultra-mcp/`) OR droppable as a
 * network mu-plugin (`wp-content/mu-plugins/elementor-ultra-mcp/`) for multisite agency fan-out
 * (`01-architecture.md §6.3`, RESEARCH §8). One codebase, two install paths.
 *
 * Steps:
 *   1. `composer install --no-dev --optimize-autoloader` in the plugin dir IF composer is on PATH
 *      (Jetpack autoloader, `15-engineering-standards.md §1`). The plugin ALSO activates with NO
 *      vendor/ via its SPL fallback (`elementor-ultra-mcp.php` guards the require with file_exists),
 *      so when composer is absent we emit a notice and pack WITHOUT vendor/ rather than fail — the
 *      zip stays installable. CI (release.yml) has composer, so the published zip carries vendor/.
 *   2. Stage the plugin into a clean dir named `elementor-ultra-mcp/` (the zip's single top-level
 *      directory == the plugin slug, required for both the normal-plugin AND mu-plugin layouts).
 *   3. Prune via `.distignore` (owned here): drop tests/dev/build config; KEEP the bootstrap,
 *      includes/, readme.txt, and vendor/ (when present).
 *   4. Zip the staged dir to `<plugin>/elementor-ultra-mcp.zip`.
 *
 * Pruning honors `.distignore` (one gitignore-style glob per line; `#` comments). The Jetpack
 * autoloader + a guarded `vendor/autoload.php` mean the same zip works with or without vendor/.
 *
 * Pure Node; shells out to `composer` (optional) + the system `zip`. Idempotent.
 *
 * Usage:
 *   node scripts/release/pack-plugin.mjs                  # composer install (if present) + stage + zip
 *   node scripts/release/pack-plugin.mjs --no-composer    # skip composer (SPL-fallback zip)
 *   node scripts/release/pack-plugin.mjs --out <dir>      # zip output dir (default plugin/...)
 *
 * Exports (consumed by verify-package.mjs):
 *   PLUGIN_SLUG, PLUGIN_DIR, ZIP_NAME, loadDistignore(), isIgnored(), stagePlugin()
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const PLUGIN_SLUG = 'elementor-ultra-mcp';
export const PLUGIN_DIR = join(ROOT, 'plugin', PLUGIN_SLUG);
export const ZIP_NAME = `${PLUGIN_SLUG}.zip`;
const DISTIGNORE = join(PLUGIN_DIR, '.distignore');

function log(msg) {
  console.log(`[pack:plugin] ${msg}`);
}

/** Parse `.distignore` into a list of trimmed, comment-stripped glob patterns. */
export function loadDistignore(file = DISTIGNORE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * gitignore-ish match: a pattern matches a relative POSIX path if the path equals the pattern,
 * is under a directory pattern (`pattern/...`), or the trailing path segment matches a `*.ext` glob.
 * Deliberately small — `.distignore` only needs dir names, exact files, and `*.ext` extensions.
 * @param {string} relPath POSIX-style path relative to the plugin root
 * @param {string[]} patterns
 */
export function isIgnored(relPath, patterns) {
  const p = relPath.replace(/\\/g, '/').replace(/\/$/, '');
  const base = p.split('/').pop() ?? p;
  for (const raw of patterns) {
    const pat = raw.replace(/\/$/, '');
    if (pat === p) return true; // exact path
    if (p === pat || p.startsWith(`${pat}/`)) return true; // dir or under-dir
    if (base === pat) return true; // bare name anywhere
    if (pat.startsWith('*.')) {
      const ext = pat.slice(1); // ".ext"
      if (base.endsWith(ext)) return true;
    }
    if (pat.startsWith('/') && p === pat.slice(1)) return true; // root-anchored
  }
  return false;
}

/**
 * Recursively copy the plugin into `destDir/<slug>/`, skipping `.distignore` matches.
 * Returns the staged plugin dir path (`destDir/<slug>`).
 * @param {string} destDir clean staging root
 */
export function stagePlugin(destDir) {
  const patterns = loadDistignore();
  const stageDir = join(destDir, PLUGIN_SLUG);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  /** @param {string} dir absolute source dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(PLUGIN_DIR, abs).split(sep).join('/');
      if (isIgnored(rel, patterns)) continue;
      const dest = join(stageDir, rel);
      if (entry.isDirectory()) {
        mkdirSync(dest, { recursive: true });
        walk(abs);
      } else if (entry.isFile()) {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(abs, dest);
      }
    }
  };
  walk(PLUGIN_DIR);
  return stageDir;
}

function hasComposer() {
  try {
    execFileSync('composer', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = { composer: true, out: PLUGIN_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-composer') args.composer = false;
    else if (argv[i] === '--out') args.out = resolve(process.cwd(), argv[++i] ?? '.');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(PLUGIN_DIR) || !statSync(PLUGIN_DIR).isDirectory()) {
    throw new Error(`pack:plugin: plugin dir not found at ${PLUGIN_DIR}`);
  }

  // Step 1 — composer install --no-dev (Jetpack autoloader). Optional: the plugin activates without
  // vendor/ via its SPL fallback, so a missing composer degrades to an SPL-fallback zip + notice.
  if (args.composer && hasComposer()) {
    log('composer install --no-dev --optimize-autoloader ...');
    execFileSync(
      'composer',
      ['install', '--no-dev', '--optimize-autoloader', '--no-interaction', '--quiet'],
      { cwd: PLUGIN_DIR, stdio: 'inherit' },
    );
  } else {
    log(
      args.composer
        ? 'composer not on PATH — packing SPL-fallback zip WITHOUT vendor/ (plugin still activates; ' +
            'guarded require, 01-architecture §6.3). CI carries composer.'
        : '--no-composer — packing SPL-fallback zip WITHOUT vendor/.',
    );
  }

  // Steps 2-3 — stage into an OS temp dir (NOT inside the plugin tree, or walk() would recurse into
  // its own staging dir), pruned via .distignore.
  const zipPath = join(args.out, ZIP_NAME);
  const stageRoot = mkdtempSync(join(tmpdir(), 'ultra-pack-plugin-'));
  try {
    log(`staging pruned plugin -> ${join(stageRoot, PLUGIN_SLUG)}`);
    stagePlugin(stageRoot);

    // Step 4 — zip the single top-level dir (slug-named) so install + mu-plugin layouts both work.
    rmSync(zipPath, { force: true });
    mkdirSync(args.out, { recursive: true });
    log(`zip -> ${zipPath}`);
    execFileSync('zip', ['-r', '-q', '-X', zipPath, PLUGIN_SLUG], {
      cwd: stageRoot,
      stdio: 'inherit',
    });
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }

  if (!existsSync(zipPath)) {
    throw new Error(`pack:plugin: expected zip not found at ${zipPath}`);
  }
  log(`OK — plugin zip: ${zipPath}`);
  console.log(zipPath);
  return zipPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`[pack:plugin] FAILED: ${err.message}`);
    process.exit(1);
  }
}
