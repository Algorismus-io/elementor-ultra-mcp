import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const html = readFileSync(process.argv[2], 'utf8');
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
    clientInfo: { name: 'c', version: '1' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'elementor.convert.html_to_page',
    arguments: { html, title: 'Convert Regress', commit: true, confirm: true, status: 'publish' },
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
  if (r?.result?.isError) {
    console.log('ISERROR:', (r.result.content?.[0]?.text || '').slice(0, 400));
  }
  const sc = r?.result?.structuredContent || {};
  console.log(
    'status:',
    sc.status,
    'id:',
    sc.id,
    'committed:',
    sc.committed,
    'coverage:',
    JSON.stringify(sc.report?.coverage || {}),
  );
  if (sc.errors) console.log('errors:', JSON.stringify(sc.errors).slice(0, 500));
  p.kill();
  process.exit(0);
}, 25000);
