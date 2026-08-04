#!/usr/bin/env node
/** Diagnostic: run convert.html_to_page (commit) and DUMP the full structured validation errors. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../..');
const BIN = join(REPO, 'packages/server/dist/index.js');

class McpStdio {
  constructor(child) {
    this.child = child; this.buf = ''; this.nextId = 1; this.pending = new Map();
    child.stdout.on('data', (c) => this._onData(c));
    child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
  }
  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim(); this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) rej(Object.assign(new Error(msg.error.message), { rpc: msg.error })); else res(msg.result);
      }
    }
  }
  request(method, params, timeoutMs = 300000) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error(`RPC timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
}

import { readFileSync } from 'node:fs';
const SOURCE_HTML = readFileSync('/tmp/v1-html.resolved.txt', 'utf8').trim();
const SOURCE_CSS = readFileSync('/tmp/v1-css.resolved.txt', 'utf8').trim();

const child = spawn(process.execPath, [BIN], {
  env: { ...process.env, WP_URL: 'http://localhost:8899', WP_USER: 'admin', WP_APP_PASSWORD: 'SET-VIA-WP_APP_PASSWORD-ENV', ULTRA_TOOLS: 'full', MCP_TRANSPORT: 'stdio' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const mcp = new McpStdio(child);
await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'diag', version: '1' } });
mcp.notify('notifications/initialized', {});

const res = await mcp.request('tools/call', { name: 'elementor.convert.html_to_page', arguments: {
  html: SOURCE_HTML, css: SOURCE_CSS, title: 'V1 diag', generation: 'v4', commit: true, confirm: true,
} });
console.log('isError:', res.isError);
console.log('TEXT:', res.content?.map((c) => c.text).join('\n'));
console.log('STRUCTURED:', JSON.stringify(res.structuredContent, null, 2));
child.stdin.end();
setTimeout(() => child.kill('SIGTERM'), 300);
