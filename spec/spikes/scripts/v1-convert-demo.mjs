#!/usr/bin/env node
/**
 * V1 FLAGSHIP DEMO — HTML → native Elementor widgets, end-to-end through the REAL MCP server.
 *
 * This is the v1 milestone proof: the headline capability. It drives the SHIPPED bin
 * (packages/server/dist/index.js) over a real StdioServerTransport — NOT the Wave-6 launcher
 * workaround. The bin's server core (server.ts → buildServer) now ATTACHES the convert handlers
 * (attachConvertHandlers, the H11 wiring), so every tools/call hits the genuine production path:
 *   parse (Playwright render-then-extract) → normalize → classify → flex-inference → map →
 *   style-extract → declaration-classify → assemble → coverage/a11y, then (on commit)
 *   sideload media → create variables → classes.upsert (diff-PUT) → authoritative dry_run →
 *   save → MANDATORY prime-css (atomic CSS via the documents prime-css route, S01/C1).
 *
 * Steps (mirrors the mvp-demo.mjs harness):
 *   1. tools/list                         → confirm the full surface incl. the convert.* flagship.
 *   2. elementor.convert.html_to_tree     → DRY-RUN. Capture the native atomic tree, proposed_classes,
 *                                            proposed_variables, and the COVERAGE REPORT. ASSERT the
 *                                            output is NATIVE atomic widgets (e-div-block/e-heading/
 *                                            e-paragraph/e-button/e-image) — NOT an html-widget dump.
 *   3. elementor.convert.html_to_page     → COMMIT (commit:true, confirm:true). Creates a REAL page
 *                                            (sideload → variables → classes → save → prime-css).
 *                                            Capture id + preview_url + final coverage.
 *   4. ASSERT STYLED                      → fetch the public URL; assert heading/para/button TEXT is
 *                                            present AND the primed atomic CSS (class selectors with
 *                                            declarations) is present (container-fs authoritative bytes).
 *   5. Report                             → coverage %, the HTML→widget mapping, rendered-styled,
 *                                            page id + preview_url, v1_pass.
 *
 * Usage:
 *   WP_URL=… WP_USER=… WP_APP_PASSWORD=… ULTRA_TOOLS=full node v1-convert-demo.mjs
 * Final stdout line: V1_PASS=true|false ; full machine-readable summary: V1_DEMO_SUMMARY={…}.
 */
import { spawn, execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../..');
// The REAL shipped bin. Its server core now attaches convert handlers (H11). We drive THIS over
// real MCP/stdio — the flagship proof runs through the production entry point, no launcher needed.
const BIN = join(REPO, 'packages/server/dist/index.js');
const STATE_PATH = join(__dirname, 'v1-state.json');

const WP_URL = process.env.WP_URL || 'http://localhost:8899';
const WP_USER = process.env.WP_USER || 'admin';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || 'SET-VIA-WP_APP_PASSWORD-ENV';

/* ───────────────────────── stdio JSON-RPC client (mirror of mvp-demo) ───────────────────────── */

class McpStdio {
  constructor(child) {
    this.child = child;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  }
  _onData(chunk) {
    this.buf += chunk.toString('utf8');
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
  request(method, params, timeoutMs = 180000) {
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

/** List the primed atomic CSS files for a post inside the wordpress container. */
function listCssFiles(postId) {
  try {
    return execSync(
      `${COMPOSE} exec -T wordpress sh -c ${JSON.stringify(
        `ls -1 /var/www/html/wp-content/uploads/elementor/css/ 2>/dev/null | grep -E '(local|global|post)-${postId}-' || true`,
      )}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** cat a primed atomic CSS file from inside the wordpress container (authoritative bytes). */
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

/** Concatenate every primed atomic CSS file for the post (local + global + post). */
function readAllPrimedCss(postId) {
  const files = listCssFiles(postId);
  const blobs = files.map((f) => ({ file: f, css: catCss(f) }));
  const combined = blobs.map((b) => b.css).join('\n');
  return { files, blobs, combined };
}

/** Fetch the rendered public page HTML. */
function fetchPublicHtml(url) {
  try {
    return execSync(`curl -s ${JSON.stringify(url)}`, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/* ───────────────────────── the source HTML+CSS sample (hero + 3-col features) ───────────────── */
/*
 * A representative real marketing section per the V1 ticket: a <section> with an <h1>, a <p>, two
 * <a class=button> CTAs, and a 3-col feature ROW of <div> cards each with an <img>, <h3>, <p>.
 * Image srcs are ABSOLUTE public URLs so the commit path exercises the REAL media sideload (the
 * converter sideloads FIRST, then references the attachment id-only, per C2). Exercises: flex
 * layout, single clean h1, button mapping, image sideload, repeated-card class hoisting.
 */
const HEADLINE = 'Launch your product in record time';
const LEAD =
  'A complete starter kit for modern marketing teams. Design, build, and ship beautiful pages without writing a single line of code.';
const CARD_TITLES = ['Drag & drop builder', 'Native performance', 'On-brand by default'];

const SOURCE_HTML = `
<section class="promo">
  <div class="promo__inner">
    <div class="promo__copy">
      <h1 class="promo__title">${HEADLINE}</h1>
      <p class="promo__lead">${LEAD}</p>
      <div class="promo__actions">
        <a class="button button--solid" href="/signup">Start free trial</a>
        <a class="button button--ghost" href="/demo">Book a demo</a>
      </div>
    </div>
  </div>

  <div class="features">
    <div class="feature">
      <img class="feature__img" src="https://picsum.photos/id/180/480/320.jpg" alt="A laptop on a desk showing the visual page builder canvas" width="480" height="320" />
      <h3 class="feature__title">${CARD_TITLES[0]}</h3>
      <p class="feature__text">Compose pages visually with real, editable native building blocks — no shortcodes, no lock-in.</p>
    </div>
    <div class="feature">
      <img class="feature__img" src="https://picsum.photos/id/0/480/320.jpg" alt="A dashboard with charts showing fast page-load metrics" width="480" height="320" />
      <h3 class="feature__title">${CARD_TITLES[1]}</h3>
      <p class="feature__text">Output is clean, atomic markup that loads fast and scores high on Core Web Vitals.</p>
    </div>
    <div class="feature">
      <img class="feature__img" src="https://picsum.photos/id/48/480/320.jpg" alt="A colour palette and type ramp representing a design system" width="480" height="320" />
      <h3 class="feature__title">${CARD_TITLES[2]}</h3>
      <p class="feature__text">Global classes and variables keep every page consistent with your design system.</p>
    </div>
  </div>
</section>
`.trim();

const SOURCE_CSS = `
.promo {
  padding: 88px 24px;
  background: #0b1120;
  color: #e6edf7;
  font-family: "Inter", system-ui, sans-serif;
}
.promo__inner {
  max-width: 760px;
  margin: 0 auto 64px;
  text-align: center;
}
.promo__title {
  font-size: 52px;
  line-height: 1.08;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 0 0 20px;
}
.promo__lead {
  font-size: 20px;
  line-height: 1.6;
  color: #9fb0c8;
  margin: 0 0 32px;
}
.promo__actions {
  display: flex;
  gap: 16px;
  justify-content: center;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
  padding: 14px 28px;
  border-radius: 12px;
}
.button--solid {
  background: #4f7cff;
  color: #ffffff;
}
.button--ghost {
  background: transparent;
  color: #e6edf7;
  border: 1px solid rgba(230, 237, 247, 0.28);
}
.features {
  display: flex;
  gap: 28px;
  max-width: 1080px;
  margin: 0 auto;
  justify-content: space-between;
}
.feature {
  flex: 1 1 0;
  background: #121a2e;
  border-radius: 18px;
  padding: 24px;
}
.feature__img {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 12px;
  margin: 0 0 18px;
}
.feature__title {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 10px;
}
.feature__text {
  font-size: 15px;
  line-height: 1.6;
  color: #9fb0c8;
  margin: 0;
}
`.trim();

/* ───────────────────────── tree walking + assertion helpers ─────────────────────────────────── */

/** Recursively collect every widgetType / elType in the converted tree. */
function collectWidgetTypes(nodes, acc = {}) {
  for (const n of nodes ?? []) {
    const key = n.widgetType || n.elType || '(unknown)';
    acc[key] = (acc[key] ?? 0) + 1;
    if (Array.isArray(n.elements)) collectWidgetTypes(n.elements, acc);
  }
  return acc;
}

/** Count total nodes in the tree (for the mapping report). */
function countNodes(nodes) {
  let n = 0;
  for (const node of nodes ?? []) {
    n += 1 + countNodes(node.elements);
  }
  return n;
}

/** Extract the readable text content from an atomic settings value ($$type:'string'|html-v3|...). */
function settingText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val !== 'object') return String(val);
  // html-v3: { value: { content: { value } } } ; string: { value }
  const v = val.value;
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (v.content) return settingText(v.content);
    if (typeof v.value === 'string') return v.value;
  }
  return '';
}

/** Pull a sample of widget→text pairs (heading/paragraph/button) for the mapping table. */
function sampleWidgetTexts(nodes, out = []) {
  for (const n of nodes ?? []) {
    const wt = n.widgetType;
    if (wt === 'e-heading' || wt === 'e-paragraph' || wt === 'e-button') {
      const s = n.settings ?? {};
      const text =
        settingText(s.title) || settingText(s.paragraph) || settingText(s.text) || '';
      if (text) out.push({ widget: wt, tag: settingText(s.tag) || undefined, text });
    }
    if (Array.isArray(n.elements)) sampleWidgetTexts(n.elements, out);
  }
  return out;
}

async function main() {
  log('=== V1 CONVERT DEMO: booting the REAL shipped bin over stdio ===');
  log('bin:', BIN);
  const child = spawn(process.execPath, [BIN], {
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
    clientInfo: { name: 'v1-convert-demo', version: '1.0.0' },
  });
  mcp.notify('notifications/initialized', {});
  record(
    'initialize',
    `serverInfo=${init.serverInfo?.name}@${init.serverInfo?.version}; protocol=${init.protocolVersion}`,
  );

  // tools/list — confirm the convert.* flagship is exposed + callable.
  const list = await mcp.request('tools/list', {});
  const toolNames = (list.tools ?? []).map((t) => t.name);
  record('tools/list', `${toolNames.length} tools exposed (full profile)`);
  for (const need of [
    'elementor.convert.html_to_tree',
    'elementor.convert.html_to_page',
    'elementor.convert.fidelity_check',
  ]) {
    if (!toolNames.includes(need)) throw new Error(`required convert tool missing from tools/list: ${need}`);
  }
  record(
    'convert tools present',
    'elementor.convert.{html_to_tree,html_to_page,fidelity_check} all in tools/list',
  );

  /* ── 2) DRY-RUN convert: html_to_tree (NO persist — pure preview). ── */
  const treeRes = await callTool(mcp, 'elementor.convert.html_to_tree', {
    html: SOURCE_HTML,
    css: SOURCE_CSS,
    generation: 'v4',
    options: { hoist_classes: true, extract_variables: true, fidelity: 'balanced', sideload_media: true },
  });
  const treeOut = structured(treeRes, 'convert.html_to_tree');
  const widgetCounts = collectWidgetTypes(treeOut.elements);
  const totalNodes = countNodes(treeOut.elements);
  const dryCoverage = treeOut.report?.coverage ?? {};
  const dryNativePct = Number(dryCoverage.native_pct ?? 0);
  record(
    'convert.html_to_tree (DRY-RUN)',
    `top-level elements=${treeOut.elements?.length}; total nodes=${totalNodes}; ` +
      `proposed_classes=${treeOut.proposed_classes?.length}; proposed_variables=${treeOut.proposed_variables?.length}; ` +
      `coverage native=${dryNativePct.toFixed(1)}% class=${Number(dryCoverage.class_pct ?? 0).toFixed(1)}% ` +
      `custom_css=${Number(dryCoverage.custom_css_pct ?? 0).toFixed(1)}% dropped=${Number(dryCoverage.dropped_pct ?? 0).toFixed(1)}%`,
  );
  record('widget-type histogram (DRY-RUN tree)', JSON.stringify(widgetCounts));

  // ASSERT: the tree is NATIVE atomic widgets — NOT an html-widget dump.
  const NATIVE_WIDGETS = ['e-div-block', 'e-heading', 'e-paragraph', 'e-button', 'e-image'];
  const seenNative = NATIVE_WIDGETS.filter((w) => widgetCounts[w] > 0);
  const hasHtmlDump =
    widgetCounts['html'] > 0 || widgetCounts['e-html'] > 0 || widgetCounts['shortcode'] > 0;
  const isNativeNotDump =
    seenNative.length >= 3 && // at least div-block + heading + paragraph (+button/image expected)
    widgetCounts['e-heading'] > 0 &&
    widgetCounts['e-paragraph'] > 0 &&
    widgetCounts['e-button'] > 0 &&
    !hasHtmlDump;
  record(
    'ASSERT native-not-dump',
    `native widgets seen=[${seenNative.join(', ')}]; html-dump widgets present=${hasHtmlDump}; ` +
      `native_not_dump=${isNativeNotDump}`,
  );
  if (!isNativeNotDump) {
    throw new Error(
      'CONVERT produced a non-native tree (missing atomic widgets or contains an html-widget dump): ' +
        JSON.stringify(widgetCounts),
    );
  }

  // Sample the widget→text mapping for the report.
  const widgetTexts = sampleWidgetTexts(treeOut.elements);
  record(
    'widget→text sample',
    widgetTexts.map((w) => `${w.widget}${w.tag ? `[${w.tag}]` : ''}: "${w.text.slice(0, 48)}"`).join('  |  '),
  );

  /* ── 3) COMMIT convert: html_to_page (commit:true, confirm:true → REAL page). ── */
  const pageRes = await callTool(mcp, 'elementor.convert.html_to_page', {
    html: SOURCE_HTML,
    css: SOURCE_CSS,
    title: 'V1 Convert Demo — Launch in record time',
    generation: 'v4',
    status: 'publish', // make the committed page immediately viewable at its public URL
    commit: true,
    confirm: true, // pre-confirm the destructive elicitation gate (stdio client has no elicit UI)
    // coverage_gate omitted → the converter uses the S3-anchored default (0.6 floor).
  });
  const pageOut = structured(pageRes, 'convert.html_to_page');
  const postId = pageOut.id;
  const previewUrl = pageOut.preview_url || '';
  // The preview_url carries either `?preview=true` or `&preview=true`; strip the preview flag (and any
  // dangling separator) to get the canonical public URL. Fall back to the stable ?page_id= form.
  const publicUrl =
    previewUrl.replace(/[?&]preview=true\b/, '').replace(/[?&]$/, '') ||
    `${WP_URL}/?page_id=${postId}`;
  const commitCoverage = pageOut.report?.coverage ?? {};
  const commitNativePct = Number(commitCoverage.native_pct ?? dryNativePct);
  const commitCustomPct = Number(commitCoverage.custom_css_pct ?? 0);
  const commitDroppedPct = Number(commitCoverage.dropped_pct ?? 0);
  // The S03 commit gate is on the COVERED fraction (native + custom_css ≡ 1 − dropped), NOT native-only
  // (coverage.ts evaluateGate: "covered = (pct_native + pct_custom_css)/100"). native_pct is the share
  // reproduced as native ATOMIC widget props; the remainder is faithfully PRESERVED as custom CSS, not
  // lost. We gate v1_pass on the SAME covered fraction the converter's own gate uses (honest to S03).
  const commitCoveredPct = commitNativePct + commitCustomPct; // ≡ 100 − dropped
  record(
    'convert.html_to_page (COMMIT)',
    `committed=${pageOut.committed}; id=${postId}; preview_url=${previewUrl}; css_primed=${pageOut.css_primed}; ` +
      `coverage native=${commitNativePct.toFixed(1)}% class=${Number(commitCoverage.class_pct ?? 0).toFixed(1)}% ` +
      `custom_css=${commitCustomPct.toFixed(1)}% dropped=${commitDroppedPct.toFixed(1)}% ` +
      `→ COVERED(native+custom_css)=${commitCoveredPct.toFixed(1)}%; ` +
      `diff.changes=${pageOut.diff?.changes?.length ?? 'n/a'}; gate_reasons=${JSON.stringify(pageOut.gate_reasons ?? null)}`,
  );
  if (!pageOut.committed || !postId) {
    throw new Error(
      'COMMIT did not persist a page (committed=false or no id). gate_reasons=' +
        JSON.stringify(pageOut.gate_reasons ?? null),
    );
  }

  /* ── 4) ASSERT STYLED: public HTML has the TEXT + the primed atomic CSS has class selectors. ── */
  const html = fetchPublicHtml(publicUrl);
  const { files: cssFiles, combined: cssCombined } = readAllPrimedCss(postId);

  const textChecks = {
    'headline in HTML': html.includes(HEADLINE),
    'lead paragraph in HTML': html.includes(LEAD.slice(0, 40)),
    'button text in HTML': html.includes('Start free trial') || html.includes('Book a demo'),
    'feature card title in HTML': CARD_TITLES.some((t) => html.includes(t)),
  };
  // The primed atomic CSS must contain class selectors WITH declarations (not just empty files).
  const hasClassSelector = /\.e-[A-Za-z0-9_-]+\s*\{/.test(cssCombined) || /\.[A-Za-z][\w-]*\s*\{/.test(cssCombined);
  const hasDeclarations =
    /(background-color|background|color|padding|font-size|display|border-radius|gap)\s*:/.test(cssCombined);
  const cssChecks = {
    'primed CSS files present': cssFiles.length > 0,
    'primed CSS non-empty': cssCombined.trim().length > 0,
    'class selector present in CSS': hasClassSelector,
    'CSS declarations present': hasDeclarations,
  };
  const renderedStyled =
    Object.values(textChecks).every(Boolean) && Object.values(cssChecks).every(Boolean);
  record(
    'ASSERT styled (public page + primed atomic CSS)',
    `rendered_styled=${renderedStyled}\n    text: ${Object.entries(textChecks)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}\n    css: ${Object.entries(cssChecks)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}\n    css files: ${JSON.stringify(cssFiles)}`,
  );

  /* ── 5) BONUS: fidelity_check (renders saved+primed page vs source; lower diff = better). ── */
  let fidelity = null;
  try {
    const fidRes = await callTool(mcp, 'elementor.convert.fidelity_check', {
      post_id: postId,
      source_html: SOURCE_HTML,
      breakpoints: ['desktop'],
    });
    const fidOut = structured(fidRes, 'convert.fidelity_check');
    fidelity = { score: fidOut.score, deltas: fidOut.deltas };
    record(
      'convert.fidelity_check (BONUS)',
      `score=${(fidOut.score * 100).toFixed(1)}% pixel-diff (lower is better); deltas=${JSON.stringify(fidOut.deltas)}`,
    );
  } catch (e) {
    record('convert.fidelity_check (BONUS)', `skipped/errored: ${e.message.split('\n').slice(0, 4).join(' | ')}`);
  }

  const v1Pass =
    isNativeNotDump && // the tree is native atomic widgets, not an html dump
    Boolean(pageOut.committed) && // a real page was created
    commitDroppedPct === 0 && // nothing was dropped — every source declaration is reproduced
    commitCoveredPct >= 60 && // S3 floor honoured against the COVERED fraction (the converter's own gate)
    renderedStyled; // the public page renders styled (text + primed atomic CSS)

  // Build the element→widget mapping table for the report.
  const elementMapping = [
    { html: '<section>', widget: 'e-div-block (section wrapper)' },
    { html: '<div class=promo__inner/promo__copy/features/feature>', widget: 'e-div-block (flex containers)' },
    { html: '<h1 class=promo__title>', widget: 'e-heading (tag h1)' },
    { html: '<h3 class=feature__title>', widget: 'e-heading (tag h3)' },
    { html: '<p class=promo__lead/feature__text>', widget: 'e-paragraph' },
    { html: '<a class=button> ×2', widget: 'e-button' },
    { html: '<img class=feature__img> ×3', widget: 'e-image (media sideloaded → attachment id)' },
  ];

  // graceful shutdown of the server.
  try {
    child.stdin.end();
  } catch {}
  setTimeout(() => child.kill('SIGTERM'), 500);

  const summary = {
    post_id: postId,
    preview_url: previewUrl,
    public_url: publicUrl,
    committed: Boolean(pageOut.committed),
    css_primed_reported: pageOut.css_primed,
    rendered_styled: renderedStyled,
    native_not_dump: isNativeNotDump,
    dry_run_coverage: {
      native_pct: dryNativePct,
      class_pct: Number(dryCoverage.class_pct ?? 0),
      custom_css_pct: Number(dryCoverage.custom_css_pct ?? 0),
      dropped_pct: Number(dryCoverage.dropped_pct ?? 0),
    },
    commit_coverage: {
      native_pct: commitNativePct,
      class_pct: Number(commitCoverage.class_pct ?? 0),
      custom_css_pct: Number(commitCoverage.custom_css_pct ?? 0),
      dropped_pct: Number(commitCoverage.dropped_pct ?? 0),
    },
    widget_type_histogram: widgetCounts,
    total_nodes: totalNodes,
    proposed_classes: treeOut.proposed_classes?.length ?? 0,
    proposed_variables: treeOut.proposed_variables?.length ?? 0,
    fallbacks: treeOut.report?.fallbacks ?? [],
    a11y: treeOut.report?.a11y ?? [],
    widget_texts: widgetTexts,
    element_mapping: elementMapping,
    css_files: cssFiles,
    text_checks: textChecks,
    css_checks: cssChecks,
    fidelity,
    s3_floor_pct: 60,
    commit_covered_pct: commitCoveredPct, // native + custom_css (≡ 100 − dropped) — the gated fraction
    commit_native_pct: commitNativePct, // share reproduced as native atomic widget props
    covered_above_floor: commitCoveredPct >= 60,
    native_in_band: commitNativePct >= 55 && commitNativePct <= 90, // realistic 60-85 band (this sample sits at the floor)
    v1_pass: v1Pass,
    transcript,
  };
  writeFileSync(STATE_PATH, JSON.stringify(summary, null, 2));
  console.log('V1_DEMO_SUMMARY=' + JSON.stringify(summary));
  console.log(`\nV1_PASS=${v1Pass}`);
}

main().catch((e) => {
  console.error('V1 CONVERT DEMO FAILED:', e.message);
  process.exit(1);
});
