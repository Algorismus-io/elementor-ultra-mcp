/** Build the self-contained npx package for @algorismus/elementor-ultra-mcp.
 * Bundles the compiled server core + workspace shared into one file, keeping the npm runtime deps
 * external (declared in packages/server/npm/package.json; playwright optional). Run AFTER `pnpm build`. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'packages', 'server', 'npm');
const entry = join(pub, 'entry.mjs');
const out = join(pub, 'index.mjs');

const ENTRY = `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { main, SERVER_VERSION } from '../dist/server.js';
function missingConnectionEnv(){const p=k=>{const v=process.env[k];return v!==undefined&&v.trim()!=='';};if(!p('WP_URL'))return['WP_URL'];if(p('WP_MCP_API_KEY'))return[];const m=['WP_USER','WP_APP_PASSWORD'].filter(k=>!p(k));return m.length>0?['WP_MCP_API_KEY (or WP_USER + WP_APP_PASSWORD)']:[];}
function selectTransport(){return (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase()==='http'?'http':'stdio';}
async function run(){const transport=selectTransport();const missing=missingConnectionEnv();
 if(missing.length>0){process.stderr.write('elementor-ultra-mcp: missing required environment variable(s): '+missing.join(', ')+'.\\nSet WP_URL plus EITHER WP_MCP_API_KEY OR (WP_USER + WP_APP_PASSWORD) (and optionally MCP_TRANSPORT=stdio|http, ULTRA_TOOLS=lean|full) before starting the server.\\nSelected transport would be: '+transport+'.\\n');process.exitCode=0;return;}
 const server=new McpServer({name:'elementor-ultra-mcp',version:SERVER_VERSION});await main(server);}
run().catch(e=>{process.stderr.write('elementor-ultra-mcp: fatal error during startup: '+(e?.message??e)+'\\n');process.exitCode=1;});
`;
writeFileSync(entry, ENTRY);
const EXTERNAL = ['@modelcontextprotocol/sdk','ajv','css-tree','pixelmatch','pngjs','playwright'];
execFileSync('npx', ['--yes','esbuild@0.24.0', entry, '--bundle','--platform=node','--format=esm','--target=node18',
  ...EXTERNAL.map(e=>`--external:${e}`), `--outfile=${out}`], { stdio: 'inherit' });
let s = readFileSync(out, 'utf8').replace(/^#!.*\n/, '');
writeFileSync(out, '#!/usr/bin/env node\n' + s);
execFileSync('rm', ['-f', entry]);
console.log('built', out);
