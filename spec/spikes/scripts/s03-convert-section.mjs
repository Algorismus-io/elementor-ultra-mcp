#!/usr/bin/env node
/**
 * WP-S03 — HTML -> native convert PROTOTYPE (throwaway).
 *
 * This is NOT the product pipeline. Its only job is to produce an HONEST,
 * reproducible per-declaration coverage breakdown so S3 can anchor the
 * `corpus.manifest.json` thresholds and the `convert.*` coverage gate.
 * The real pipeline (WP-H##) reimplements this in packages/server/src/convert/*.
 *
 * METHOD (RESEARCH.md §6.1 + SUPPLEMENT.md §C.3/§C.4):
 *   1. PARSE  — render-then-extract. Load input.html + input.css in headless
 *               Playwright (chromium); for every CSS rule, find which rendered
 *               DOM nodes the selector matches (so we know the realized target
 *               role + computed value of each declaration). We measure the
 *               AUTHORED declaration set (what the source CSS actually writes),
 *               NOT the full computed cascade — counting every computed longhand
 *               getComputedStyle reports (height, inset, every border-radius
 *               corner, ...) would dishonestly inflate "native" with props the
 *               author never set. Authored declarations are parsed from
 *               input.css with css-tree (the §6.1 "css-tree to lexer-validate
 *               candidate values" stage); the rendered DOM resolves selector ->
 *               node(s) -> role + computed value for typed-prop classification.
 *   2. CLASSIFY — semantic role per matched node (heading/text/image/button/
 *               list/form/grid/flex/structural) from tag + display + role + class.
 *   3. MAP    — role -> atomic target element type (RESEARCH.md §6.2).
 *   4. STYLE-EXTRACT — for each AUTHORED declaration (counted once per node it
 *               lands on), classify against the LIVE Style_Schema
 *               (s03-style-schema.json, fetched from the running Elementor
 *               4.1.1 install) into one of:
 *                 native        — Style_Schema-valid prop + value (-> real native prop)
 *                 custom_css    — NOT representable as a native prop but a Pro
 *                                 custom_css.raw variant could carry it
 *                 dropped       — not representable at all / stripped text /
 *                                 whole-node html fallback
 *               The native tier is then split by HOISTING into local_class vs
 *               global_class (RESEARCH.md §6.3) — both are real native props;
 *               the split is a placement decision, not a fidelity loss.
 *
 * The "native" coverage number = native / total-authored-declarations. The
 * fidelity TAIL = custom_css + dropped. Per-property fallback rates for the hard
 * properties (grid areas/named-lines, transform, transition, filter, background
 * gradient, text-decoration shorthand, off-enum font-weight, display table/
 * list-item) are tallied so S3 reports WHICH props drive the tail.
 *
 * Usage:
 *   node s03-convert-section.mjs <section-dir>
 *   Writes <section-dir>/convert.result.json and prints a one-line summary.
 *
 * Requires: playwright (chromium) + css-tree. Declared in deps_needed; for the
 * spike run they were installed in a scratch dir (S03_PW_DIR). See findings.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFrom(mod) {
  const candidates = [
    process.env.S03_PW_DIR && join(process.env.S03_PW_DIR, 'node_modules'),
    join(__dirname, '..', '..', '..', 'node_modules'),
    '/tmp/s03-pw/node_modules',
  ].filter(Boolean);
  for (const base of candidates) {
    const entry = join(base, mod, 'package.json');
    if (existsSync(entry)) {
      const req = createRequire(join(base, 'noop.js'));
      return req(mod);
    }
  }
  return null;
}

const SCHEMA = JSON.parse(readFileSync(join(__dirname, 's03-style-schema.json'), 'utf8'));

// Longhands / shorthands the converter collapses onto a single Style_Schema key.
const COLLAPSE = {
  'margin-top': 'margin', 'margin-right': 'margin', 'margin-bottom': 'margin', 'margin-left': 'margin', margin: 'margin',
  'padding-top': 'padding', 'padding-right': 'padding', 'padding-bottom': 'padding', 'padding-left': 'padding', padding: 'padding',
  top: 'inset-block-start', right: 'inset-inline-end', bottom: 'inset-block-end', left: 'inset-inline-start',
  'inset-block-start': 'inset-block-start', 'inset-inline-end': 'inset-inline-end',
  'inset-block-end': 'inset-block-end', 'inset-inline-start': 'inset-inline-start',
  'row-gap': 'gap', 'column-gap': 'gap', gap: 'gap',
  'border-top-width': 'border-width', 'border-right-width': 'border-width',
  'border-bottom-width': 'border-width', 'border-left-width': 'border-width', 'border-width': 'border-width',
  'border-top-left-radius': 'border-radius', 'border-top-right-radius': 'border-radius',
  'border-bottom-left-radius': 'border-radius', 'border-bottom-right-radius': 'border-radius', 'border-radius': 'border-radius',
  'background-color': 'background', 'background-image': 'background', 'background': 'background',
  'flex-grow': 'flex', 'flex-shrink': 'flex', 'flex-basis': 'flex', flex: 'flex',
  'text-decoration-line': 'text-decoration', 'text-decoration': 'text-decoration',
  // 'border' shorthand is decomposed to width/style/color (all in schema) -> map to border-style as representative
  border: 'border-style',
};

// CSS props that exist but have NO key in Style_Schema at all -> automatic fallback.
// (Authoritative: not present in style-schema.php. Tracked for the report.)
const NO_SCHEMA_KEY = new Set([
  'grid-template-areas', 'place-items', 'place-content', 'place-self',
  'list-style', 'list-style-type', 'list-style-position',
  'white-space', 'visibility', 'pointer-events', 'user-select', 'quotes',
  'text-overflow', 'word-break', 'overflow-wrap', 'vertical-align', 'float', 'clear',
  'box-sizing', 'text-shadow', 'columns', 'caption-side', 'border-collapse',
  'background-position', 'background-size', 'background-repeat', 'background-attachment',
  'transform-origin', 'transition-property', 'transition-duration', 'transition-timing-function',
  'animation', 'will-change', 'backface-visibility', 'perspective', 'isolation',
  'outline', 'gap-row', 'inset', '-webkit-background-clip', 'background-clip', '-webkit-text-fill-color',
]);

// Props the converter does not extract (irrelevant to native styling / vendor noise).
const IGNORE = new Set([
  '-webkit-box-orient', '-webkit-line-clamp', '-webkit-font-smoothing', '-moz-osx-font-smoothing',
  'src', 'font-display', 'unicode-range', 'tab-size', 'speak', '-webkit-tap-highlight-color',
]);

function classifyDeclaration(prop, value) {
  const v = (value || '').trim();
  if (NO_SCHEMA_KEY.has(prop)) return { tier: 'custom_css', schemaProp: prop, reason: 'prop-not-in-schema' };
  const schemaProp = COLLAPSE[prop] || prop;
  const def = SCHEMA[schemaProp];
  if (!def) return { tier: 'custom_css', schemaProp, reason: 'prop-not-in-schema' };

  if (def.type === 'string' && def.enum) {
    // text-decoration is a free string in schema (no enum extracted) handled below.
    if (def.enum.includes(v)) return { tier: 'native', schemaProp, reason: 'enum-member' };
    // shorthand values like "1px solid #ccc" for border-style won't be a member
    return { tier: 'custom_css', schemaProp, reason: `enum-miss(${v})` };
  }

  switch (def.type) {
    case 'color':
      return { tier: 'native', schemaProp, reason: 'color' };
    case 'size':
      if (/^-?\d/.test(v) || /^calc\(/.test(v)) return { tier: 'native', schemaProp, reason: 'size' };
      return { tier: 'custom_css', schemaProp, reason: `size-nonnumeric(${v})` };
    case 'number':
      if (/^-?\d+(\.\d+)?$/.test(v)) return { tier: 'native', schemaProp, reason: 'number' };
      return { tier: 'custom_css', schemaProp, reason: `number-miss(${v})` };
    case 'dimensions':
      return { tier: 'native', schemaProp, reason: 'dimensions' };
    case 'background':
      if (/gradient\(/.test(v)) return { tier: 'custom_css', schemaProp, reason: 'gradient-typed-decompose' };
      if (/url\(/.test(v)) return { tier: 'native', schemaProp, reason: 'bg-image-url' };
      if (/^rgb|^#|^hsl/.test(v) || v === 'transparent' || /^[a-z]+$/.test(v)) return { tier: 'native', schemaProp, reason: 'bg-color' };
      return { tier: 'custom_css', schemaProp, reason: `bg-complex(${v.slice(0, 24)})` };
    case 'border-radius':
    case 'border-width':
      return { tier: 'native', schemaProp, reason: def.type };
    case 'box-shadow':
      return { tier: 'native', schemaProp, reason: 'box-shadow-decompose' };
    case 'transform':
      if (/matrix|matrix3d|perspective/.test(v)) return { tier: 'custom_css', schemaProp, reason: 'transform-matrix' };
      return { tier: 'native', schemaProp, reason: 'transform-decompose' };
    case 'transition':
      return { tier: 'custom_css', schemaProp, reason: 'transition-typed-decompose' };
    case 'filter':
      if (/url\(/.test(v)) return { tier: 'custom_css', schemaProp, reason: 'filter-url' };
      return ((v.match(/\w+\(/g) || []).length <= 1)
        ? { tier: 'native', schemaProp, reason: 'filter-decompose' }
        : { tier: 'custom_css', schemaProp, reason: 'filter-multi' };
    case 'flex':
      return { tier: 'native', schemaProp, reason: 'flex' };
    case 'span':
      if (/^(span\s+)?\d+$/.test(v) || v === 'auto') return { tier: 'native', schemaProp, reason: 'span' };
      return { tier: 'custom_css', schemaProp, reason: `span-complex(${v})` };
    case 'string':
      if (schemaProp === 'grid-template-columns' || schemaProp === 'grid-template-rows') {
        return { tier: 'native', schemaProp, reason: 'grid-raw-string' };
      }
      if (schemaProp === 'text-decoration') {
        // single line keyword -> native; shorthand (color/style) collapses to line only -> still native-ish but lossy
        if (/^(none|underline|overline|line-through|blink)$/.test(v)) return { tier: 'native', schemaProp, reason: 'text-decoration-line' };
        return { tier: 'custom_css', schemaProp, reason: `text-decoration-shorthand(${v})` };
      }
      return { tier: 'native', schemaProp, reason: 'free-string' };
    case 'stroke':
      return { tier: 'native', schemaProp, reason: 'stroke' };
    default:
      return { tier: 'custom_css', schemaProp, reason: `untyped(${def.type})` };
  }
}

function classifyNode(tag, classAttr, role, display) {
  if (/^h[1-6]$/.test(tag)) return { role: 'heading', target: 'e-heading' };
  if (tag === 'img') return { role: 'image', target: 'e-image' };
  if (tag === 'button' || (tag === 'a' && /btn|button|cta/.test(classAttr))) return { role: 'button', target: 'e-button' };
  if (tag === 'a') return { role: 'link', target: 'e-button' };
  if (tag === 'hr') return { role: 'divider', target: 'e-divider' };
  if (tag === 'svg') return { role: 'svg', target: 'e-svg' };
  if (tag === 'form') return { role: 'form', target: 'e-form', proOnly: true };
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return { role: 'form-field', target: 'e-form-field', proOnly: true };
  if (tag === 'ul' || tag === 'ol') return { role: 'list', target: 'e-div-block' };
  if (tag === 'li') return { role: 'list-item', target: 'e-paragraph' };
  if (['p', 'span', 'small', 'cite', 'blockquote', 'figcaption'].includes(tag)) return { role: 'text', target: 'e-paragraph' };
  if ((display || '').includes('grid')) return { role: 'grid', target: 'e-div-block' };
  if ((display || '').includes('flex')) return { role: 'flex', target: 'e-flexbox' };
  return { role: 'structural', target: 'e-div-block' };
}

const INLINE_ALLOW = new Set(['b', 'i', 'em', 'u', 'a', 'del', 'span', 'strong', 'sup', 'sub', 's']);

function hardTag(prop, value) {
  if (/gradient\(/.test(value)) return 'background_gradient';
  if (/grid/.test(prop)) return 'grid';
  if (prop === 'transform') return 'transform';
  if (prop === 'transition' || /^transition-/.test(prop)) return 'transition';
  if (/filter$/.test(prop)) return 'filter';
  if (/text-decoration/.test(prop)) return 'text-decoration';
  if (prop === 'font-weight') return 'font-weight';
  if (prop === 'display' && (value === 'table' || value === 'list-item' || value === 'table-cell')) return 'display-table-listitem';
  if (/^(list-style|list-style-type)$/.test(prop)) return 'list-style';
  if (prop === 'position' && (value === 'absolute' || value === 'fixed')) return 'absolute-position';
  if (prop === 'background-clip' || prop === '-webkit-background-clip') return 'text-clip';
  return null;
}

async function main() {
  const sectionDir = resolve(process.argv[2] || join(__dirname, '..', 'fixtures', 'sections', '01-pricing-table'));
  const html = readFileSync(join(sectionDir, 'input.html'), 'utf8');
  const css = readFileSync(join(sectionDir, 'input.css'), 'utf8');

  const pw = loadFrom('playwright');
  const csstree = loadFrom('css-tree');
  if (!pw || !csstree) {
    console.error('FAIL: playwright and/or css-tree not resolvable. Set S03_PW_DIR or install deps.');
    process.exit(2);
  }

  // --- parse authored declarations from input.css via css-tree ---
  // rules: [{ selector, decls: [{prop,value,important}], pseudoState }]
  const ast = csstree.parse(css);
  const rules = [];
  csstree.walk(ast, {
    visit: 'Rule',
    enter(node) {
      const selectorText = csstree.generate(node.prelude);
      // split comma groups so each simple selector is tested independently
      const groups = selectorText.split(',').map((s) => s.trim()).filter(Boolean);
      const decls = [];
      csstree.walk(node.block, {
        visit: 'Declaration',
        enter(d) {
          decls.push({ prop: d.property.toLowerCase(), value: csstree.generate(d.value).trim() });
        },
      });
      for (const g of groups) {
        // detect pseudo-state (hover/focus/active) and pseudo-element (::before/::after)
        const stateM = g.match(/:(hover|focus|focus-visible|active|checked)\b/);
        const isPseudoEl = /::(before|after|placeholder|marker|first-line|first-letter)\b/.test(g);
        const baseSel = g.replace(/::?[a-z-]+(\([^)]*\))?/g, '').trim() || g;
        rules.push({
          selector: g,
          baseSel,
          decls,
          pseudoState: stateM ? stateM[1] : null,
          pseudoEl: isPseudoEl,
        });
      }
    },
  });

  // --- render and resolve each rule's base selector to matched nodes ---
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}\n${css}</style></head><body>${html}</body></html>`;
  await page.setContent(doc, { waitUntil: 'networkidle' });

  // Build a node index: for each unique base selector, the matched elements'
  // {tag, classAttr, role, display, depth, idx}.
  const selData = await page.evaluate((selectors) => {
    const result = {};
    for (const sel of selectors) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch { els = []; }
      result[sel] = els.map((el) => {
        const cs = getComputedStyle(el);
        let depth = 0; let p = el; while (p && p !== document.body) { depth++; p = p.parentElement; }
        return {
          tag: el.tagName.toLowerCase(),
          classAttr: el.getAttribute('class') || '',
          role: el.getAttribute('role') || '',
          display: cs.display,
          depth,
        };
      });
    }
    return result;
  }, [...new Set(rules.map((r) => r.baseSel))]);

  // text-content / stripped audit per text/heading node
  const textAudit = await page.evaluate(() => {
    const out = [];
    const ALLOW = new Set(['b', 'i', 'em', 'u', 'a', 'del', 'span', 'strong', 'sup', 'sub', 's']);
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,figcaption,li,small,cite')) {
      const blocks = Array.from(el.children).map((c) => c.tagName.toLowerCase()).filter((t) => !ALLOW.has(t));
      // <br> shows as no children; detect via innerHTML
      const hasBr = /<br\s*\/?>(?!$)/i.test(el.innerHTML) || /<br/i.test(el.innerHTML);
      if (blocks.length || hasBr) out.push({ tag: el.tagName.toLowerCase(), stripped: [...blocks, ...(hasBr ? ['br'] : [])] });
    }
    return out;
  });

  await browser.close();

  // --- count AUTHORED declarations: each declaration counted once per node it lands on ---
  const decls = [];
  let nodeKeySet = new Set();
  for (const r of rules) {
    const matched = selData[r.baseSel] || [];
    if (matched.length === 0) continue; // selector matched nothing in this section (e.g. pseudo-only) -> still count on its base
    for (let i = 0; i < matched.length; i++) {
      const m = matched[i];
      const kind = classifyNode(m.tag, m.classAttr, m.role, m.display);
      const nodeKey = `${r.baseSel}#${i}`;
      nodeKeySet.add(nodeKey);
      for (const d of r.decls) {
        if (IGNORE.has(d.prop)) continue;
        if (d.prop.startsWith('--')) continue; // custom property definitions
        const c = classifyDeclaration(d.prop, d.value);
        decls.push({
          nodeKey,
          role: kind.role,
          target: kind.target,
          depth: m.depth,
          state: r.pseudoState,
          pseudoEl: r.pseudoEl,
          prop: d.prop,
          schemaProp: c.schemaProp,
          value: d.value,
          tier: c.tier,
          reason: c.reason,
          hard: hardTag(d.prop, d.value),
          proOnly: !!kind.proOnly,
        });
      }
    }
  }

  // --- HOIST: split native tier into local_class vs global_class ---
  const nodeFp = new Map();
  for (const d of decls) {
    if (d.tier !== 'native' || d.state || d.pseudoEl) continue;
    const arr = nodeFp.get(d.nodeKey) || [];
    arr.push(`${d.schemaProp}=${d.value}`);
    nodeFp.set(d.nodeKey, arr);
  }
  const fpCount = new Map();
  for (const [, arr] of nodeFp) {
    const fp = arr.slice().sort().join('|');
    fpCount.set(fp, (fpCount.get(fp) || 0) + 1);
  }
  for (const d of decls) {
    if (d.tier !== 'native') continue;
    if (d.state) { d.placement = 'local_class'; continue; } // state variants are per-node
    const fp = (nodeFp.get(d.nodeKey) || []).slice().sort().join('|');
    d.placement = (fpCount.get(fp) || 0) >= 2 ? 'global_class' : 'local_class';
  }

  const result = {
    section: basename(sectionDir),
    nodeCount: nodeKeySet.size,
    ruleCount: rules.length,
    declCount: decls.length,
    declarations: decls,
    stripped: textAudit,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(sectionDir, 'convert.result.json'), JSON.stringify(result, null, 2));

  const t = decls.reduce((a, d) => { a[d.tier] = (a[d.tier] || 0) + 1; return a; }, {});
  const nat = ((t.native || 0) / decls.length * 100).toFixed(1);
  console.log(`[${result.section}] nodes=${nodeKeySet.size} decls=${decls.length} ` +
    `native=${t.native || 0}(${nat}%) custom_css=${t.custom_css || 0} dropped=${t.dropped || 0}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
