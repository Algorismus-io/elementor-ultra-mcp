import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const spec = JSON.parse(readFileSync(process.argv[2] || '/tmp/ee.json', 'utf8'));
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
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'd', version: '1' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'elementor.page.dry_run',
    arguments: { elements: spec.elements, generation: 'v4' },
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
  const sc = L.find((l) => l.id === 2)?.result?.structuredContent || {};
  const errs = sc.errors || [];
  console.log('valid:', sc.valid, 'errors:', errs.length);
  // unique error messages (strip ids)
  const msgs = {};
  for (const e of errs) {
    const m = (e.message || '')
      .replace(/"[^"]*"/g, '"X"')
      .replace(/variants\[\d+\]/, 'variants[i]');
    msgs[m] = (msgs[m] || 0) + 1;
  }
  for (const [m, c] of Object.entries(msgs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15))
    console.log(c + '×', m);
  p.kill();
  process.exit(0);
}, 30000);
