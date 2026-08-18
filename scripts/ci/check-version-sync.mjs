/** Version drift gate.
 *
 *  Four places state this server's version and they have already disagreed on a published release:
 *  the root package.json, packages/server/package.json, the npm PUBLISH manifest
 *  (packages/server/npm/package.json) and the SERVER_VERSION constant the server reports over MCP.
 *  The 1.0.2 release bumped the first two and missed the last two, so the shipped 1.0.2 introduced
 *  itself as 1.0.0 — and a downstream consumer gates on that string.
 *
 *  `--registry` additionally asserts the version is not already published; only meaningful pre-release.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const root = read('../../package.json');
const server = read('../../packages/server/package.json');
const manifest = read('../../packages/server/npm/package.json');
const src = readFileSync(new URL('../../packages/server/src/server.ts', import.meta.url), 'utf8');
const constant = (/export const SERVER_VERSION = '([^']+)'/.exec(src) || [])[1];

const seen = { 'package.json': root.version, 'packages/server/package.json': server.version,
  'npm publish manifest': manifest.version, SERVER_VERSION: constant };
const distinct = [...new Set(Object.values(seen))];

if (distinct.length !== 1) {
  console.error('✗ version drift:');
  for (const [k, v] of Object.entries(seen)) console.error(`    ${String(v).padEnd(10)} ${k}`);
  console.error('  the server reports SERVER_VERSION over MCP — a lagging constant misidentifies a release');
  process.exitCode = 1;
} else {
  console.log(`✓ all four version sources agree: ${distinct[0]}`);
}

if (process.argv.includes('--registry')) {
  try {
    const latest = execFileSync('npm', ['view', manifest.name, 'version'], { encoding: 'utf8' }).trim();
    if (latest === manifest.version) {
      console.error(`✗ ${manifest.name}@${manifest.version} is already published — bump before releasing`);
      process.exitCode = 1;
    } else console.log(`✓ registry latest ${latest}, releasing ${manifest.version}`);
  } catch { console.log('· registry unreachable — skipped'); }
}
