#!/usr/bin/env node
/**
 * WP-Q08 — `pnpm pack:server` (`15-engineering-standards.md §2.10`, `01-architecture.md §6.1`,
 * `WP-Q08 Detailed Requirements #1`).
 *
 * Produces the `npx`-distributable MCP server tarball. The published package is consumed as
 * `npx -y @youragency/elementor-ultra-mcp` (RESEARCH §8) over stdio / Streamable HTTP.
 *
 * Two npx traps this script is built around (`WP-Q08 Implementation Notes`):
 *   1. The `bin` entry MUST start with a `#!/usr/bin/env node` shebang or `npx` cannot exec it.
 *   2. `@modelcontextprotocol/sdk` MUST stay on `^1.29` (NEVER 2.x) — a 2.x silently breaks the
 *      ZodRawShape tool surface + deep transport imports (`§7`). We delegate the lockfile guard to
 *      `scripts/ci/check-sdk-version.mjs` and ALSO assert the staged manifest pin here.
 *
 * Monorepo realities this script resolves before packing:
 *   - `packages/server/package.json` is `"private": true` and declares
 *     `"@elementor-ultra/shared": "workspace:*"`. Neither survives a real `npm publish`/`npx`:
 *     `private` blocks publish and `workspace:*` only resolves inside the monorepo.
 *   - So we PACK in a STAGING dir: copy `dist/` + `bin` + README, write a publish-ready manifest
 *     (publish name, `private` dropped, the workspace dep rewritten to a co-bundled local copy),
 *     bundle `packages/shared/dist` into `node_modules/@elementor-ultra/shared` inside the package,
 *     and run `npm pack` there. The result is a single self-contained, npx-runnable tarball.
 *
 * The `.npmignore` (owned here) governs what `npm pack` keeps when packing the REPO package; the
 * staging copy applies the same intent (dist + bin + README only; no tests/fixtures/sources).
 *
 * Pure Node (no extra deps); shells out to `npm pack` only. Idempotent: rebuilds + repacks each run.
 *
 * Usage:
 *   node scripts/release/pack-server.mjs                 # build (unless --no-build) + stage + pack
 *   node scripts/release/pack-server.mjs --no-build      # assume `pnpm build` already ran
 *   node scripts/release/pack-server.mjs --out <dir>     # tarball output dir (default packages/server)
 *
 * Exports (consumed by verify-package.mjs + the bump unit test):
 *   PUBLISH_NAME, stageServerPackage(), assertShebang(), assertSdkPin()
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const SERVER_DIR = join(ROOT, 'packages', 'server');
export const SHARED_DIR = join(ROOT, 'packages', 'shared');

/**
 * The npm name the tarball is PUBLISHED + run under (`npx @youragency/elementor-ultra-mcp`,
 * RESEARCH §8 / `01-architecture.md §6.1`). The in-repo workspace name is `@elementor-ultra/server`;
 * the publish name is the agency-scoped, user-facing one. Override with `ULTRA_PUBLISH_NAME` for a
 * fork without editing this script.
 */
export const PUBLISH_NAME = process.env.ULTRA_PUBLISH_NAME || '@youragency/elementor-ultra-mcp';

/** The locked SDK pin (mirrors `scripts/ci/check-sdk-version.mjs`). */
export const SDK_PACKAGE = '@modelcontextprotocol/sdk';
export const SDK_REQUIRED_RANGE = '^1.29';

/** The shared workspace dep that must be co-bundled (it is imported at runtime by dist/). */
const SHARED_PKG = '@elementor-ultra/shared';

function log(msg) {
  console.log(`[pack:server] ${msg}`);
}

/**
 * Compiled-test / map / source artifacts that must NOT ship in the published tarball even though
 * they live alongside the runnable code in `dist/` (npm's `files` allowlist keeps all of `dist/`,
 * so the prune happens here on copy — `.npmignore` intent for the staged set). Keeps `.d.ts` types.
 */
function isPublishedDistArtifact(srcPath) {
  const name = srcPath.replace(/\\/g, '/');
  // Drop test/spec/contract artifacts in every compiled flavour: .js, .d.ts, .js.map, .d.ts.map.
  if (/\.(test|spec|contract)\.(d\.ts|[cm]?[jt]s)(\.map)?$/.test(name)) return false;
  if (/\.tsbuildinfo$/.test(name)) return false;
  return true;
}

/** Assert the bin file begins with a node shebang (npx trap #1). Throws on violation. */
export function assertShebang(binPath) {
  if (!existsSync(binPath)) {
    throw new Error(`pack:server: bin entry missing at ${binPath} (run \`pnpm build\` first).`);
  }
  const first = readFileSync(binPath, 'utf8').split('\n', 1)[0] ?? '';
  if (!/^#!\/usr\/bin\/env node\b/.test(first) && !/^#!.*\bnode\b/.test(first)) {
    throw new Error(
      `pack:server: bin entry ${binPath} is missing a node shebang (got: ${JSON.stringify(first)}). ` +
        `npx cannot exec it (15-engineering-standards.md §2.10).`,
    );
  }
  return first;
}

/**
 * Assert the SDK dependency pin in a manifest object is `^1.29` (npx trap #2). Throws on violation.
 * @param {Record<string, unknown>} manifest a parsed package.json
 */
export function assertSdkPin(manifest) {
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.peerDependencies ?? {}) };
  const spec = deps[SDK_PACKAGE];
  if (!spec) {
    throw new Error(`pack:server: manifest is missing ${SDK_PACKAGE} dependency.`);
  }
  if (String(spec) !== SDK_REQUIRED_RANGE) {
    throw new Error(
      `pack:server: ${SDK_PACKAGE} is pinned to "${spec}" but must be exactly "${SDK_REQUIRED_RANGE}" ` +
        `(15-engineering-standards.md §1/§7). No 2.x.`,
    );
  }
  return spec;
}

/**
 * Build a publish-ready manifest from the in-repo server package.json:
 *  - rename to the publish name; drop `private` so the tarball is publishable/npx-able;
 *  - rewrite the `workspace:*` shared dep to the co-bundled local copy (resolved from node_modules);
 *  - keep deps/peerDeps/bin/files/engines; the SDK pin is preserved + asserted.
 * @param {Record<string, any>} src the parsed packages/server/package.json
 */
export function buildPublishManifest(src) {
  const out = { ...src };
  out.name = PUBLISH_NAME;
  delete out.private;

  // Co-bundle the shared dep: it ships inside node_modules/@elementor-ultra/shared in the tarball,
  // so a `*` range resolves to the bundled copy on install (no registry fetch, no workspace proto).
  out.dependencies = { ...(src.dependencies ?? {}) };
  if (out.dependencies[SHARED_PKG]) {
    out.dependencies[SHARED_PKG] = '*';
  }

  // The staging dir contains exactly the published set already; `files` would still scope an
  // accidental extra, so keep dist + README and add the bundled dep.
  out.files = ['dist', 'README.md', 'node_modules/@elementor-ultra/shared'];
  out.bundledDependencies = [SHARED_PKG];

  assertSdkPin(out);
  return out;
}

/**
 * Stage the publishable package into `destDir` (created/emptied). Returns the staging dir path.
 * Copies dist + bin + README, writes the publish manifest, and co-bundles the shared package dist.
 * @param {string} destDir
 */
export function stageServerPackage(destDir) {
  const srcManifestPath = join(SERVER_DIR, 'package.json');
  const srcManifest = JSON.parse(readFileSync(srcManifestPath, 'utf8'));

  const distDir = join(SERVER_DIR, 'dist');
  if (!existsSync(distDir)) {
    throw new Error(`pack:server: ${distDir} missing — run \`pnpm build\` first.`);
  }

  // bin entry from the manifest (e.g. ./dist/index.js) — validate the shebang BEFORE staging.
  const binRel =
    typeof srcManifest.bin === 'string' ? srcManifest.bin : Object.values(srcManifest.bin ?? {})[0];
  if (!binRel) throw new Error('pack:server: server package.json has no bin entry.');
  assertShebang(join(SERVER_DIR, binRel));

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  // dist/ (the runnable artifact incl. the bin), minus compiled test/contract/source-map cruft.
  cpSync(distDir, join(destDir, 'dist'), { recursive: true, filter: isPublishedDistArtifact });

  // README (npx user docs, owned here). Prefer the package README; fall back to repo root.
  const readmeSrc = existsSync(join(SERVER_DIR, 'README.md'))
    ? join(SERVER_DIR, 'README.md')
    : join(ROOT, 'README.md');
  cpSync(readmeSrc, join(destDir, 'README.md'));

  // Co-bundle @elementor-ultra/shared (runtime dep) so the tarball is self-contained for npx.
  const sharedDist = join(SHARED_DIR, 'dist');
  if (srcManifest.dependencies?.[SHARED_PKG]) {
    if (!existsSync(sharedDist)) {
      throw new Error(`pack:server: ${sharedDist} missing — build the shared package first.`);
    }
    const sharedDest = join(destDir, 'node_modules', SHARED_PKG);
    mkdirSync(dirname(sharedDest), { recursive: true });
    cpSync(sharedDist, join(sharedDest, 'dist'), {
      recursive: true,
      filter: isPublishedDistArtifact,
    });
    // A minimal publishable manifest for the bundled shared package (drop `private`, keep entrypoints).
    const sharedManifest = JSON.parse(readFileSync(join(SHARED_DIR, 'package.json'), 'utf8'));
    delete sharedManifest.private;
    delete sharedManifest.devDependencies;
    delete sharedManifest.scripts;
    sharedManifest.files = ['dist'];
    writeFileSync(join(sharedDest, 'package.json'), `${JSON.stringify(sharedManifest, null, 2)}\n`);
  }

  // The publish manifest.
  const publishManifest = buildPublishManifest(srcManifest);
  writeFileSync(join(destDir, 'package.json'), `${JSON.stringify(publishManifest, null, 2)}\n`);

  return destDir;
}

function parseArgs(argv) {
  const args = { build: true, out: SERVER_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-build') args.build = false;
    else if (argv[i] === '--out') args.out = resolve(process.cwd(), argv[++i] ?? '.');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Release gate (npx trap #2): the lockfile SDK guard must be clean before we pack (§7).
  log('running SDK 2.x release gate (scripts/ci/check-sdk-version.mjs)...');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'ci', 'check-sdk-version.mjs')], {
    stdio: 'inherit',
  });

  if (args.build) {
    log('building (pnpm -w build)...');
    const npx = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    execFileSync(npx, ['-w', 'build'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    log('skipping build (--no-build).');
  }

  const stageRoot = mkdtempSync(join(tmpdir(), 'ultra-pack-server-'));
  const stageDir = join(stageRoot, 'package');
  try {
    log(`staging publishable package -> ${stageDir}`);
    stageServerPackage(stageDir);

    log(`npm pack (publish name: ${PUBLISH_NAME})...`);
    mkdirSync(args.out, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const tgzName = execFileSync(npm, ['pack', '--silent', `--pack-destination=${args.out}`], {
      cwd: stageDir,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .pop();

    const tgzPath = join(args.out, tgzName);
    if (!existsSync(tgzPath)) {
      throw new Error(`pack:server: expected tarball not found at ${tgzPath}`);
    }
    log(`OK — server tarball: ${tgzPath}`);
    // Emit the path on stdout's last line for CI/verify to consume.
    console.log(tgzPath);
    return tgzPath;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(`[pack:server] FAILED: ${err.message}`);
    process.exit(1);
  }
}
