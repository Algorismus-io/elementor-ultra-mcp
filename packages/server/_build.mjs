// Build a page from a tree JSON file via the fresh bin. Usage: node _build.mjs <tree.json>
// tree.json = { title, elements, settings? }
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const env = {
  ...process.env,
  WP_URL: 'http://localhost:8899',
  WP_USER: 'admin',
  WP_APP_PASSWORD: 'SET-VIA-WP_APP_PASSWORD-ENV',
  ULTRA_TOOLS: 'full',
};
const p = spawn('node', ['dist/index.js'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
p.stdout.on('data', (d) => (buf += d));
let er = '';
p.stderr.on('data', (d) => (er += d));
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'b', version: '1' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'elementor.page.build',
    arguments: {
      title: spec.title,
      elements: spec.elements,
      ...(spec.settings ? { settings: spec.settings } : {}),
      status: 'publish',
      generation: 'v4',
    },
  },
});
setTimeout(() => {
  const L = buf
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const r = L.find((l) => l.id === 2);
  if (!r) {
    console.log('NO RESPONSE');
    console.error(er.slice(-500));
    process.exit(1);
  }
  if (r.result?.isError) {
    console.log('ERR:', (r.result.content?.[0]?.text || '').slice(0, 400));
    process.exit(1);
  }
  const sc = r.result?.structuredContent || {};
  console.log('PAGEID=' + sc.id);
  p.kill();
  process.exit(0);
}, 30000);
