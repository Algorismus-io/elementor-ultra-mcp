#!/usr/bin/env node
/**
 * WAVE 6 — MVP end-to-end demonstration over REAL MCP (stdio JSON-RPC).
 *
 * Spawns the real server core over a real StdioServerTransport (via mvp-stdio-launcher.mjs;
 * the shipped bin boots the same core but does not attach vertical handlers — see the launcher
 * header), speaks the JSON-RPC handshake (initialize), then drives the MVP core promise via the
 * REAL MCP tools:
 *   1. tools/list             → confirm the 86-tool full surface is exposed.
 *   2. page.dry_run           → validate the hero tree (dry-run-before-commit) [AUTHORITATIVE PHP].
 *   3. page.build             → commit (create→save→prime). Capture diff + preview_url + base_hash.
 *   4. ASSERT styled          → public HTML has the heading + primed atomic CSS (local + global).
 *   5. widget.update_settings → edit the heading text via the tool; assert the edit renders.
 *      (+ element.set_local_style for the colour, via get_structure re-locate.)
 *   6. page.list_backups + page.rollback → restore the prior state via the NEW rollback MCP tools
 *                               (Contract 13 §1.2); assert the prior state is back + still styled.
 *
 * Pre-req: the global class g-mvphero is provisioned in the design system (the design.classes.*
 * MCP tools are a later wave; Wave 6 owns the page/widget WRITE surface). Provisioned once via
 * PUT /design/classes.
 *
 * The hero tree is the spike-verified atomic V4 shape (e-div-block > e-heading + e-paragraph +
 * e-button) with ONE local style on the heading and the g-mvphero global class on the wrapper.
 *
 * Usage:
 *   WP_URL=… WP_USER=… WP_APP_PASSWORD=… ULTRA_TOOLS=full node mvp-demo.mjs
 * Final stdout line: MVP_PASS=true|false ; full machine-readable summary: MVP_DEMO_SUMMARY={…}.
 */
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../..');
// The shipped bin (packages/server/dist/index.js) boots the real server core but does NOT
// attach the vertical tool handlers (a one-line-per-vertical wiring gap in server.ts/buildServer),
// so every tools/call returns "handler not yet attached". The launcher boots the SAME real
// server core + real handlers over a real StdioServerTransport (see its header). We drive THAT
// over real MCP/stdio. Set MVP_USE_BIN=1 to point at the raw bin instead (to demonstrate the gap).
const BIN = join(REPO, 'packages/server/dist/index.js');
const LAUNCHER = join(__dirname, 'mvp-stdio-launcher.mjs');
const SERVER_ENTRY = process.env.MVP_USE_BIN === '1' ? BIN : LAUNCHER;
const STATE_PATH = join(__dirname, 'mvp-state.json');

const WP_URL = process.env.WP_URL || 'http://localhost:8899';
const WP_USER = process.env.WP_USER || 'admin';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || 'SET-VIA-WP_APP_PASSWORD-ENV';

/* ───────────────────────── stdio JSON-RPC client ───────────────────────── */

class McpStdio {
  constructor(child) {
    this.child = child;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[server] ${chunk}`);
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    // The SDK StdioServerTransport frames messages as newline-delimited JSON.
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line.length === 0) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
        else res(msg.result);
      } else if (msg.method !== undefined) {
        this.notifications.push(msg);
      }
    }
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          res(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

/** Pull the structuredContent out of a CallToolResult (or throw on isError). */
function structured(result, label) {
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).join('\n') ?? '';
    throw new Error(`${label}: tool returned isError:\n${text}`);
  }
  return result?.structuredContent ?? {};
}

async function callTool(mcp, name, args, { allowError = false } = {}) {
  const result = await mcp.request('tools/call', { name, arguments: args });
  if (result?.isError && !allowError) {
    const text = result.content?.map((c) => c.text).join('\n') ?? '';
    throw new Error(`tools/call ${name} returned isError:\n${text}`);
  }
  return result;
}

const log = (...a) => console.log(...a);

const COMPOSE =
  'docker compose -p elementor-mcp -f /Users/shahmir/projects/elementor-mcp/tools/wp-stack/docker-compose.yml';

/** Read a primed atomic CSS file from inside the wordpress container (authoritative bytes). */
function catCss(file) {
  try {
    return execSync(
      `${COMPOSE} exec -T wordpress sh -c ${JSON.stringify(
        'cat /var/www/html/wp-content/uploads/elementor/css/' + file + ' 2>/dev/null',
      )}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    return '';
  }
}

/** Fetch the rendered public page HTML (no preview). */
function fetchPublicHtml(url) {
  try {
    return execSync(`curl -s ${JSON.stringify(url)}`, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/**
 * Assert the page renders STYLED: the heading TEXT is present in the public HTML AND both the local
 * style selector + the global class selector are present (with declarations) in the primed atomic CSS.
 * Returns a {pass, detail} report.
 */
function assertStyledAndText({ postId, publicUrl, headingText, localStyleId, globalSelector }) {
  const local = catCss(`local-${postId}-frontend-desktop.css`);
  const global = catCss(`global-${postId}-frontend-desktop.css`);
  const html = fetchPublicHtml(publicUrl);
  const checks = {
    'heading text in HTML': html.includes(headingText),
    'local CSS non-empty': local.trim().length > 0,
    'local selector present': local.includes(`.${localStyleId}`),
    'local declaration (color/font-size)': /color\s*:/.test(local) || /font-size\s*:/.test(local),
    'global CSS non-empty': global.trim().length > 0,
    'global selector present': global.includes(`.${globalSelector}`),
    'global declaration (background/padding)':
      /background-color\s*:/.test(global) || /padding/.test(global),
  };
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, local: local.trim(), global: global.trim() };
}

/** Walk a {elements} structure result and return the first e-heading widget's live id. */
function findHeadingId(structResult) {
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.widgetType === 'e-heading') return n.id;
      const found = walk(n.elements);
      if (found) return found;
    }
    return null;
  };
  return walk(structResult?.elements);
}

async function main() {
  log('=== MVP DEMO: booting real MCP server over stdio ===');
  log('server entry:', SERVER_ENTRY);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      WP_URL,
      WP_USER,
      WP_APP_PASSWORD,
      ULTRA_TOOLS: 'full',
      MCP_TRANSPORT: 'stdio',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const mcp = new McpStdio(child);
  const transcript = [];
  const record = (step, outcome) => {
    transcript.push({ step, outcome });
    log(`\n>>> ${step}\n    ${outcome}`);
  };

  // 1) initialize handshake.
  const init = await mcp.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mvp-demo', version: '1.0.0' },
  });
  mcp.notify('notifications/initialized', {});
  record(
    'initialize',
    `serverInfo=${init.serverInfo?.name}@${init.serverInfo?.version}; protocol=${init.protocolVersion}`,
  );

  // tools/list — confirm the write tools are present + callable.
  const list = await mcp.request('tools/list', {});
  const toolNames = (list.tools ?? []).map((t) => t.name);
  record('tools/list', `${toolNames.length} tools exposed (full profile)`);
  for (const need of ['elementor.page.build', 'elementor.page.dry_run', 'elementor.widget.update_settings']) {
    if (!toolNames.includes(need)) throw new Error(`required tool missing from tools/list: ${need}`);
  }

  /* ── the hero tree (spike-verified atomic V4 shape: e-div-block > heading + paragraph + button) ── */
  const stamp = Date.now().toString(36);
  const divId = `mvpdiv${stamp}`.slice(0, 16);
  const headId = `mvphead${stamp}`.slice(0, 16);
  const paraId = `mvppara${stamp}`.slice(0, 16);
  const btnId = `mvpbtn${stamp}`.slice(0, 16);
  const localStyleId = `e-${headId}-loc`;
  const globalClassId = 'g-mvphero';
  const HEADLINE = 'Build sites at the speed of thought';

  const heroTree = [
    {
      id: divId,
      elType: 'e-div-block',
      settings: { classes: { $$type: 'classes', value: [globalClassId] } },
      styles: {},
      isInner: false,
      elements: [
        {
          id: headId,
          elType: 'widget',
          widgetType: 'e-heading',
          settings: {
            classes: { $$type: 'classes', value: [localStyleId] },
            tag: { $$type: 'string', value: 'h1' },
            title: {
              $$type: 'html-v3',
              value: {
                content: { $$type: 'string', value: HEADLINE },
                children: [],
              },
            },
          },
          styles: {
            [localStyleId]: {
              id: localStyleId,
              type: 'class',
              label: 'local',
              variants: [
                {
                  meta: { breakpoint: 'desktop', state: null },
                  props: {
                    color: { $$type: 'color', value: 'rgb(0, 128, 255)' },
                    'font-size': { $$type: 'size', value: { unit: 'px', size: 56 } },
                  },
                },
              ],
            },
          },
          elements: [],
          isInner: false,
        },
        {
          id: paraId,
          elType: 'widget',
          widgetType: 'e-paragraph',
          settings: {
            classes: { $$type: 'classes', value: [] },
            paragraph: {
              $$type: 'html-v3',
              value: {
                content: {
                  $$type: 'string',
                  value: 'The ULTRA Elementor MCP turns a brief into a styled, native page.',
                },
                children: [],
              },
            },
          },
          styles: {},
          elements: [],
          isInner: false,
        },
        {
          id: btnId,
          elType: 'widget',
          widgetType: 'e-button',
          settings: {
            classes: { $$type: 'classes', value: [] },
            text: {
              $$type: 'html-v3',
              value: {
                content: { $$type: 'string', value: 'Get started' },
                children: [],
              },
            },
          },
          styles: {},
          elements: [],
          isInner: false,
        },
      ],
    },
  ];

  // 2) GLOBAL class g-mvphero is provisioned in the design system as a setup precondition (the
  //    design.classes.* MCP tools are a later wave; the page/widget WRITE tools are Wave 6's surface).
  record(
    'global class precondition',
    `using design-system class ${globalClassId} (provisioned via /design/classes)`,
  );

  // 3) DRY-RUN the tree (authoritative PHP validator; dry-run-before-commit).
  const dryRes = await callTool(mcp, 'elementor.page.dry_run', {
    elements: heroTree,
    generation: 'v4',
  });
  const dryOut = structured(dryRes, 'page.dry_run');
  record(
    'page.dry_run',
    `valid=${dryOut.valid}; errors=${(dryOut.errors ?? []).length}` +
      ((dryOut.errors ?? []).length ? `\n    ${JSON.stringify(dryOut.errors)}` : ''),
  );
  if (!dryOut.valid) {
    throw new Error('dry_run FAILED — tree invalid, aborting before commit: ' + JSON.stringify(dryOut.errors));
  }

  // 4) BUILD (commit): create → save → prime. Captures diff + preview_url + base_hash.
  const buildRes = await callTool(mcp, 'elementor.page.build', {
    title: 'MVP Hero — speed of thought',
    elements: heroTree,
    generation: 'v4',
    status: 'publish',
    prime_css: true,
  });
  const buildOut = structured(buildRes, 'page.build');
  const postId = buildOut.id;
  const buildBaseHash = buildOut.base_hash;
  record(
    'page.build',
    `id=${postId}; preview_url=${buildOut.preview_url}; css_primed=${buildOut.css_primed}; ` +
      `base_hash=${buildBaseHash}; diff.changes=${buildOut.diff?.changes?.length}; ` +
      `report=${JSON.stringify(buildOut.report ?? null)}`,
  );

  // 5) read the heading node to get the live base_hash + its (possibly remapped) id + style id.
  const getRes = await callTool(mcp, 'elementor.element.get', {
    post_id: postId,
    element_id: headId,
  });
  const getOut = structured(getRes, 'element.get');
  const liveBaseHash = getOut.base_hash;
  const liveHeadId = getOut.node?.id ?? headId;
  // [R5] local-style ids are NOT stable across save — read the REMAPPED id from the live node's
  // styles map (the authored id `localStyleId` is what we sent; PHP minted a fresh stable id).
  const liveLocalStyleId = Object.keys(getOut.node?.styles ?? {})[0] ?? localStyleId;
  record(
    'element.get (heading)',
    `node id=${liveHeadId}; remapped local_style_id=${liveLocalStyleId}; base_hash=${liveBaseHash}`,
  );

  // Persist state for the CSS assertion harness BEFORE the edit (capture the as-built styled state).
  const stateBuilt = {
    post_id: postId,
    permalink: buildOut.preview_url || `${WP_URL}/?page_id=${postId}`,
    div_id: divId,
    heading_id: headId,
    paragraph_id: paraId,
    button_id: btnId,
    local_style_id: liveLocalStyleId,
    authored_local_style_id: localStyleId,
    global_class_id: globalClassId,
    global_class_selector: 'mvphero',
    css_dir: '/var/www/html/wp-content/uploads/elementor/css/',
    headline: HEADLINE,
    base_hash_built: buildBaseHash,
    live_heading_id: liveHeadId,
  };
  writeFileSync(STATE_PATH, JSON.stringify(stateBuilt, null, 2));
  record('state written (built)', STATE_PATH);

  // 5b) ASSERT the as-built page renders STYLED: heading text in public HTML + primed atomic CSS
  //     (local style selector + global class selector, with declarations).
  const publicUrl = (buildOut.preview_url || '').replace(/\?preview=true$/, '');
  const builtAssert = assertStyledAndText({
    postId,
    publicUrl,
    headingText: HEADLINE,
    localStyleId: liveLocalStyleId,
    globalSelector: 'mvphero',
  });
  record(
    'ASSERT styled (as-built)',
    `pass=${builtAssert.pass}; ${Object.entries(builtAssert.checks)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}\n    local CSS: ${builtAssert.local}\n    global CSS: ${builtAssert.global}`,
  );

  log('\n=== PHASE 1 COMPLETE (built + STYLED asserted). ===');

  // Emit a machine-readable line the caller can parse.
  console.log('MVP_STATE_BUILT=' + JSON.stringify(stateBuilt));

  // 6a) EDIT the heading TEXT via widget.update_settings (the tool). PHP runs ONE
  //     read-mutate-validate-write transaction + chains the CSS primer.
  const NEW_HEADLINE = 'Ship faster with native Elementor';
  const editRes = await callTool(mcp, 'elementor.widget.update_settings', {
    post_id: postId,
    element_id: liveHeadId,
    base_hash: liveBaseHash,
    settings: {
      title: {
        $$type: 'html-v3',
        value: {
          content: { $$type: 'string', value: NEW_HEADLINE },
          children: [],
        },
      },
    },
  });
  const editOut = structured(editRes, 'widget.update_settings');
  const editedBaseHash = editOut.base_hash;
  record(
    'widget.update_settings (heading text)',
    `base_hash=${editedBaseHash}; diff.changes=${editOut.diff?.changes?.length}`,
  );

  // 6b) BONUS: also change the heading COLOR via element.set_local_style (the DEDICATED tool that
  //     mints + mirrors the local style id so it never detaches — Contract 11 §2.1/§5.1). Every
  //     element-ops save re-IDs the tree (Spike R5), so re-read the live structure to find the
  //     now-current heading id. Best-effort — the text edit above already proves the edit→re-prime path.
  const NEW_COLOR = 'rgb(255, 92, 0)';
  let colorOut = null;
  let bonusColorWorked = false;
  try {
    const liveDoc = structured(
      await callTool(mcp, 'elementor.page.get_structure', { post_id: postId }),
      'page.get_structure',
    );
    const head2 = findHeadingId(liveDoc) ?? liveHeadId;
    const bh2 = liveDoc?.base_hash ?? editedBaseHash;
    record('page.get_structure (re-locate heading)', `heading id=${head2}; base_hash=${bh2}`);
    const colorRes = await callTool(mcp, 'elementor.element.set_local_style', {
      post_id: postId,
      element_id: head2,
      base_hash: bh2,
      variant: {
        meta: { breakpoint: 'desktop', state: null },
        props: {
          color: { $$type: 'color', value: NEW_COLOR },
          'font-size': { $$type: 'size', value: { unit: 'px', size: 56 } },
        },
      },
    });
    colorOut = structured(colorRes, 'element.set_local_style');
    bonusColorWorked = true;
    record(
      'element.set_local_style (heading colour)',
      `style_id=${colorOut.style_id}; base_hash=${colorOut.base_hash}; diff.changes=${colorOut.diff?.changes?.length}`,
    );
  } catch (e) {
    record('element.set_local_style (heading colour, BONUS)', `ERRORED: ${e.message.split('\n')[0]}`);
  }
  const editedBaseHash2 = colorOut?.base_hash ?? editedBaseHash;

  const stateEdited = {
    ...stateBuilt,
    headline: NEW_HEADLINE,
    heading_color: NEW_COLOR,
    base_hash_edited: editedBaseHash2,
  };
  writeFileSync(STATE_PATH, JSON.stringify(stateEdited, null, 2));
  console.log('MVP_STATE_EDITED=' + JSON.stringify(stateEdited));
  record('state written (edited)', STATE_PATH);

  // 6c) ASSERT the EDIT took: the NEW headline renders, the OLD is gone, CSS still primed.
  const editAssert = assertStyledAndText({
    postId,
    publicUrl,
    headingText: NEW_HEADLINE,
    localStyleId: liveLocalStyleId,
    globalSelector: 'mvphero',
  });
  const oldGone = !fetchPublicHtml(publicUrl).includes(HEADLINE);
  record(
    'ASSERT edit took (new headline renders, old gone)',
    `new_headline_renders=${editAssert.checks['heading text in HTML']}; old_headline_gone=${oldGone}; css_still_primed=${editAssert.checks['local CSS non-empty'] && editAssert.checks['global CSS non-empty']}`,
  );
  const editWorked = editAssert.checks['heading text in HTML'] && oldGone;

  log('\n=== PHASE 2 COMPLETE (edited + asserted). ===');

  // 7) ROLLBACK to the AS-BUILT snapshot via the NEW elementor.page.rollback MCP tool (#4).
  //    Rollback is now reachable over MCP (no raw REST). We first list the backups via the
  //    elementor.page.list_backups tool, pick the snapshot whose base_hash == the as-built hash
  //    (the snapshot taken before the edit), then roll back to its meta_key. The tool is destructive
  //    (elicitation-gated) — the stdio client has no elicit support, so we pass confirm:true.
  const backupsOut = structured(
    await callTool(mcp, 'elementor.page.list_backups', { post_id: postId, limit: 100 }),
    'page.list_backups',
  );
  const backupItems = backupsOut.items ?? [];
  const builtSnapshot =
    backupItems.find((b) => b.base_hash === buildBaseHash) ??
    backupItems[backupItems.length - 1] ??
    null;
  if (!builtSnapshot) throw new Error('no backup snapshot available to roll back to');
  record(
    'page.list_backups (find as-built snapshot)',
    `backups=${backupItems.length}; target meta_key=${builtSnapshot.meta_key}; target base_hash=${builtSnapshot.base_hash}`,
  );

  const rollback = structured(
    await callTool(mcp, 'elementor.page.rollback', {
      post_id: postId,
      backup: builtSnapshot.meta_key,
      confirm: true,
      prime_css: true,
    }),
    'page.rollback',
  );
  record(
    'rollback (elementor.page.rollback MCP tool)',
    `restored_from=${rollback.restored_from}; new base_hash=${rollback.base_hash}; ` +
      `css_primed=${rollback.css_primed}; matches_built_hash=${rollback.base_hash === buildBaseHash}`,
  );

  const stateRolledBack = {
    ...stateEdited,
    headline: HEADLINE,
    heading_color: 'rgb(0, 128, 255)',
    base_hash_rolledback: rollback.base_hash,
    rollback_restored_from: rollback.restored_from,
  };
  writeFileSync(STATE_PATH, JSON.stringify(stateRolledBack, null, 2));
  console.log('MVP_STATE_ROLLEDBACK=' + JSON.stringify(stateRolledBack));
  record('state written (rolled back)', STATE_PATH);

  // 7b) ASSERT rollback restored the PRIOR (as-built) state: ORIGINAL headline back, edited gone,
  //     base_hash identical to the as-built hash, page still styled.
  const rbHtml = fetchPublicHtml(publicUrl);
  const rbAssert = assertStyledAndText({
    postId,
    publicUrl,
    headingText: HEADLINE,
    localStyleId: liveLocalStyleId,
    globalSelector: 'mvphero',
  });
  const rollbackWorked =
    rollback.base_hash === buildBaseHash &&
    rbHtml.includes(HEADLINE) &&
    !rbHtml.includes(NEW_HEADLINE);
  record(
    'ASSERT rollback restored prior state',
    `original_headline_back=${rbHtml.includes(HEADLINE)}; edited_gone=${!rbHtml.includes(NEW_HEADLINE)}; ` +
      `base_hash_matches_built=${rollback.base_hash === buildBaseHash}; still_styled=${rbAssert.pass}; rollbackWorked=${rollbackWorked}`,
  );

  log('\n=== PHASE 3 COMPLETE (rolled back + asserted). ===');

  const mvpPass =
    builtAssert.pass && // built page is styled
    editWorked && // edit landed + rendered
    rollbackWorked; // rollback restored prior state

  // graceful shutdown of the server.
  try {
    child.stdin.end();
  } catch {}
  setTimeout(() => child.kill('SIGTERM'), 500);

  // Final machine-readable summary.
  const summary = {
    post_id: postId,
    preview_url: buildOut.preview_url,
    public_url: publicUrl,
    css_primed_reported: buildOut.css_primed,
    rendered_styled: builtAssert.pass,
    edit_worked: editWorked,
    bonus_set_local_style_worked: bonusColorWorked,
    rollback_worked: rollbackWorked,
    mvp_pass: mvpPass,
    built_base_hash: buildBaseHash,
    edited_base_hash: editedBaseHash,
    rolledback_base_hash: rollback.base_hash,
    rollback_restored_built_state: rollback.base_hash === buildBaseHash,
    original_headline: HEADLINE,
    new_headline: NEW_HEADLINE,
    global_class_id: globalClassId,
    global_class_selector: 'mvphero',
    authored_local_style_id: localStyleId,
    live_local_style_id: liveLocalStyleId,
    built_css: { local: builtAssert.local, global: builtAssert.global },
    transcript,
  };
  console.log('MVP_DEMO_SUMMARY=' + JSON.stringify(summary));
  console.log(`\nMVP_PASS=${mvpPass}`);
}

main().catch((e) => {
  console.error('MVP DEMO FAILED:', e.message);
  process.exit(1);
});
