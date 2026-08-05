#!/usr/bin/env node
/**
 * Docker-free local dev site for Elementor Ultra, on WordPress Playground (PHP-WASM in Node).
 * No Docker, no PHP, no MySQL — just Node. Stands up WordPress + Elementor (free) + the companion
 * plugin on http://127.0.0.1:8899, provisions everything (permalinks, local env-type baked into
 * wp-config, V4 experiments, app password), and prints WP_URL / WP_USER / WP_APP_PASSWORD.
 *
 *   node dev/playground/setup-playground.mjs
 *
 * Persists to dev/playground/.wordpress so pages + credentials survive restarts. Re-run to reboot;
 * delete that dir to reset.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PLUGIN = join(REPO, 'plugin', 'elementor-ultra-mcp');
const WP_DIR = join(HERE, '.wordpress');
const OUT = join(HERE, '.out');
const CREDS = join(OUT, 'credentials.json');
const PORT = Number(process.env.ULTRA_PORT || 8899);

const log = (m) => process.stdout.write(`\x1b[36m[playground]\x1b[0m ${m}\n`);

async function findCli() {
  // @wp-playground/cli is installed in THIS dir's own node_modules (dev/playground has its own
  // package.json), so it never touches the pnpm workspace at the repo root.
  const p = join(HERE, 'node_modules', '@wp-playground', 'cli', 'cli.js');
  if (existsSync(p)) return p;
  log('installing @wp-playground/cli (first run) …');
  await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: HERE });
  return p;
}

// On Windows `npm` is `npm.cmd`; spawn without a shell can't resolve it (ENOENT). Run through a
// shell on win32 so `npm`/`node` resolve the same as they do in the user's terminal.
const WIN = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: WIN, ...opts });
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

const provisioned = existsSync(join(WP_DIR, 'wp-config.php'));
mkdirSync(WP_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });

const cli = await findCli();
const args = [
  cli, 'server', '--port', String(PORT), '--php', '8.2',
  // persist the whole site so pages + credentials survive restarts
  // two-arg form (host, vfs) — a `host:vfs` colon collides with Windows drive letters (D:\\)
  '--mount-dir-before-install', WP_DIR, '/wordpress',
  // companion plugin, present before activation
  '--mount-dir-before-install', PLUGIN, '/wordpress/wp-content/plugins/elementor-ultra-mcp',
];
if (provisioned) {
  log('existing install found — booting without re-provisioning');
  args.push('--wordpress-install-mode', 'install-from-existing-files-if-needed');
} else {
  log('first run — provisioning Elementor + companion plugin + app password');
  args.push(
    // provisioning inputs live OUTSIDE /wordpress (a second mount over the site dir corrupts SQLite)
    '--mount-dir-before-install', HERE, '/ultra',
    '--mount-dir-before-install', OUT, '/ultra-out',
    '--blueprint', join(HERE, 'blueprint.json'),
  );
}

log(`booting WordPress on http://127.0.0.1:${PORT} …`);
const child = spawn('node', args, { stdio: ['ignore', 'ignore', 'inherit'] });

// poll for provisioning to finish (credentials file appears), then print + keep serving
const started = Date.now();
const timer = setInterval(() => {
  if (existsSync(CREDS)) {
    clearInterval(timer);
    const c = JSON.parse(readFileSync(CREDS, 'utf8'));
    process.stdout.write(`
  \x1b[32m✓\x1b[0m Elementor Ultra dev site is up (Docker-free, WordPress Playground).

  WordPress   http://127.0.0.1:${PORT}/wp-admin   (admin / password)
  Elementor   ${c.elementor} (free) + companion plugin ${c.plugin_active ? 'active' : 'INACTIVE'}
  App password (for MCP + exjsx deploy):
              WP_URL=${c.WP_URL}
              WP_USER=${c.WP_USER}
              WP_APP_PASSWORD=${c.WP_APP_PASSWORD}

  Verify:  curl -u ${c.WP_USER}:${c.WP_APP_PASSWORD} ${c.WP_URL}/wp-json/elementor-ultra/v1/site/capabilities
  Stop:    Ctrl-C            Reset: delete ${WP_DIR}

  Server is running — leave this process up while you work.\n`);
  } else if (Date.now() - started > 180000) {
    clearInterval(timer);
    log('provisioning did not finish in 3 min — check the server output above.');
  }
}, 1500);

process.on('SIGINT', () => { child.kill(); process.exit(0); });
