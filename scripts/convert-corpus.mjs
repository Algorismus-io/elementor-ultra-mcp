#!/usr/bin/env node
/**
 * Contract 17 §4 — the conversion REGRESSION CORPUS runner (`pnpm test:convert-corpus`).
 *
 * Converts the corpus pages (`test.html` — wpos.ai, `test-landing.html` — CloudFlow) against a live
 * WordPress through the FRESH server dist (`packages/server/dist` — build first), then runs the W2
 * verification loop (`convert/verify-loop.js`) plus the NAMED regression checks pinned to past
 * field bugs (§4: every field-found conversion bug gets a corpus assertion — a bug without a
 * regression check is not fixed):
 *
 *   - prime green               css_primed:true on commit (a saved-but-unprimed page is unstyled)
 *   - V2 layout audits          scrollWidth == viewport at 1440 AND 390, no zero-area losses,
 *                               page height within tolerance
 *   - 390 scrollWidth           the mobile audit explicitly (the broken-mobile-widths class)
 *   - no dangling refs          zero V1 divergences attributed `dangling_ref` (I1 observable)
 *   - ghost buttons transparent no background-color divergence whose SOURCE was transparent
 *   - SVG wrappers sized        every visible `.e-svg-base` on the converted page has area > 0
 *   - accent <em> colored       source accent-colored inline text keeps its color when rendered
 *   - in-text links carry href  every in-text `<a href>` in the source renders as an anchor WITH
 *                               an href on the converted page (contract 17 §5 residual)
 *
 * Credentials: `WP_URL` / `WP_USER` / `WP_APP_PASSWORD` env first, then `.mcp.json`
 * (`mcpServers["elementor-ultra"].env`), then — CI fallback — an Application Password minted via
 * `wp-env run cli` (the `_setup-wp-env.yml` contract: CI fixes URL + user; runners mint the rest).
 *
 * Exits non-zero on ANY failed assertion. Created pages are deleted afterwards unless
 * `KEEP_CORPUS_PAGES=1`. The V3 pixel score is GATED BY DEFAULT (contract 17 §4 — the gate is a
 * standard loop output, not env-optional): desktop ≤ 0.04 (the W3 acceptance number) and mobile
 * ≤ 0.08. `CORPUS_MAX_PIXEL_RATIO` OVERRIDES both bounds (tightening or loosening is an explicit,
 * visible choice — e.g. a CI runner without the corpus webfonts).
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_DIST = pathToFileURL(join(ROOT, 'packages', 'server', 'dist')).href + '/';

/* ───────────────────────────── credentials ───────────────────────────────────────────────────── */

function resolveCreds() {
  let url = process.env.WP_URL;
  let user = process.env.WP_USER;
  let password = process.env.WP_APP_PASSWORD;

  if ((!url || !user || !password) && existsSync(join(ROOT, '.mcp.json'))) {
    try {
      const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'));
      const env = mcp?.mcpServers?.['elementor-ultra']?.env ?? {};
      url = url || env.WP_URL;
      user = user || env.WP_USER;
      password = password || env.WP_APP_PASSWORD;
    } catch {
      /* unreadable .mcp.json — fall through to the mint */
    }
  }

  if (url && user && !password) {
    // CI fallback (`_setup-wp-env.yml`): mint an Application Password via the wp-env CLI.
    try {
      const out = execSync(
        `pnpm wp-env run cli -- wp user application-password create ${user} emcp-corpus-${Date.now()} --porcelain`,
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const lines = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '');
      password = lines[lines.length - 1];
      console.log('[corpus] minted a wp-env Application Password for the run.');
    } catch (err) {
      console.error(`[corpus] could not mint an Application Password: ${err.message}`);
    }
  }

  if (!url || !user || !password) {
    console.error(
      '[corpus] missing credentials: set WP_URL / WP_USER / WP_APP_PASSWORD (or provide .mcp.json).',
    );
    process.exit(2);
  }
  return { url: url.replace(/\/$/, ''), user, password };
}

/* ───────────────────────────── tiny assertion harness ────────────────────────────────────────── */

const failures = [];
let checks = 0;

function check(page, name, ok, detail) {
  checks += 1;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${page} :: ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${page} :: ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ───────────────────────────── in-browser probes (named checks) ──────────────────────────────── */

/** Source-page probe: accent inline text + in-text links + transparent button-like elements. */
function sourceProbe() {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const accents = [];
  const links = [];
  const TEXT_PARENTS = [
    'p',
    'li',
    'td',
    'span',
    'em',
    'strong',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
  ];
  for (const el of Array.from(document.body.querySelectorAll('em, strong, span, b, i'))) {
    const text = norm(el.textContent);
    if (text.length < 2 || text.length > 120) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    const own = getComputedStyle(el).color;
    const inherited = getComputedStyle(parent).color;
    if (own !== inherited) accents.push({ text, color: own });
  }
  for (const a of Array.from(document.body.querySelectorAll('a[href]'))) {
    const parent = a.parentElement;
    if (!parent || !TEXT_PARENTS.includes(parent.tagName.toLowerCase())) continue;
    const text = norm(a.textContent);
    const href = a.getAttribute('href') || '';
    if (text.length < 2 || href === '' || href === '#') continue;
    links.push({ text, href });
  }
  return { accents: accents.slice(0, 20), links: links.slice(0, 20) };
}

/** Converted-page probe: svg wrapper sizes + accent/link survival against the source findings. */
function convertedProbe(args) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const parseRgb = (v) => {
    const m = /^rgba?\(([^)]+)\)$/.exec((v || '').trim());
    if (!m) return null;
    return m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
  };
  const closeColor = (a, b) => {
    const ca = parseRgb(a);
    const cb = parseRgb(b);
    if (!ca || !cb) return a === b;
    for (let i = 0; i < 3; i++) if (Math.abs((ca[i] || 0) - (cb[i] || 0)) > 8) return false;
    return true;
  };

  const svgWrappers = Array.from(document.querySelectorAll('.e-svg-base')).map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      visible: cs.display !== 'none' && cs.visibility !== 'hidden',
      area: Math.round(r.width * r.height),
    };
  });

  const all = Array.from(document.body.querySelectorAll('*'));
  const accentResults = args.accents.map((accent) => {
    // The smallest element whose text is exactly the accent text (the inline carrier or its fold).
    let best = null;
    for (const el of all) {
      if (norm(el.textContent) !== accent.text) continue;
      if (best === null || el.textContent.length <= best.textContent.length) best = el;
    }
    if (best === null) return { text: accent.text, found: false, colored: false, color: '' };
    const color = getComputedStyle(best).color;
    return { text: accent.text, found: true, colored: closeColor(color, accent.color), color };
  });

  const linkResults = args.links.map((link) => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const hit = anchors.find(
      (a) => norm(a.textContent) === link.text && (a.getAttribute('href') || '') !== '',
    );
    return {
      text: link.text,
      carried: hit !== undefined,
      href: hit ? hit.getAttribute('href') : '',
    };
  });

  return { svgWrappers, accentResults, linkResults };
}

/* ───────────────────────────── main ──────────────────────────────────────────────────────────── */

async function main() {
  const creds = resolveCreds();
  const basicToken = Buffer.from(`${creds.user}:${creds.password}`).toString('base64');

  // Fresh-dist imports (build first: `pnpm build`).
  const { htmlToPage } = await import(new URL('convert/pipeline.js', SERVER_DIST));
  const { buildPorts } = await import(new URL('convert/ports.js', SERVER_DIST));
  const { runVerifyLoop } = await import(new URL('convert/verify-loop.js', SERVER_DIST));
  const { WpClient } = await import(new URL('wp/client.js', SERVER_DIST));
  const { bindRoutes } = await import(new URL('runtime/context.js', SERVER_DIST));
  const { CapabilitiesCache } = await import(new URL('runtime/capabilities-cache.js', SERVER_DIST));
  const { withPage, closeBrowser } = await import(new URL('convert/browser-pool.js', SERVER_DIST));

  const client = new WpClient({ site: { url: creds.url, basicToken } });
  const wp = bindRoutes(client);
  // buildPorts only touches ctx.wp + ctx.capabilities — a minimal context is sufficient here.
  const ctx = { wp, capabilities: new CapabilitiesCache(() => wp.siteCapabilities()) };
  const ports = buildPorts(ctx);

  const BREAKPOINTS = [
    { key: 'desktop', width: 1440, direction: 'min' },
    { key: 'mobile', width: 390, direction: 'max' },
  ];
  const CORPUS = [
    { file: 'test.html', label: 'test.html (wpos.ai)' },
    { file: 'test-landing.html', label: 'test-landing.html (CloudFlow)' },
  ];
  const createdPageIds = [];
  // Contract 17 §4 — the V3 pixel gate runs by DEFAULT (never env-optional): the W3 acceptance
  // bound at desktop/1440 (≤4%), a 2x allowance at mobile/390 (no pinned contract number).
  // `CORPUS_MAX_PIXEL_RATIO` overrides BOTH bounds explicitly.
  const DEFAULT_MAX_PIXEL_RATIO = { desktop: 0.04, mobile: 0.08 };
  const pixelRatioOverride =
    process.env.CORPUS_MAX_PIXEL_RATIO !== undefined
      ? Number.parseFloat(process.env.CORPUS_MAX_PIXEL_RATIO)
      : null;
  const maxPixelRatioFor = (breakpoint) =>
    pixelRatioOverride ?? DEFAULT_MAX_PIXEL_RATIO[breakpoint] ?? DEFAULT_MAX_PIXEL_RATIO.desktop;

  for (const entry of CORPUS) {
    const htmlPath = join(ROOT, entry.file);
    if (!existsSync(htmlPath)) {
      check(entry.label, 'corpus file exists', false, `${htmlPath} missing`);
      continue;
    }
    const html = readFileSync(htmlPath, 'utf8');
    const sourceUrl = pathToFileURL(htmlPath).href;
    console.log(`\n[corpus] converting ${entry.label} ...`);

    // ── convert + commit (the real pipeline — gates, classes, variables, save, prime) ──────────
    let result;
    try {
      result = await htmlToPage(
        {
          html,
          title: `EMCP corpus — ${entry.label}`,
          commit: true,
          confirm: true,
          status: 'publish',
        },
        ports,
        async () => true,
      );
    } catch (err) {
      check(entry.label, 'convert committed', false, `htmlToPage threw: ${err.message}`);
      continue;
    }
    check(
      entry.label,
      'convert committed',
      result.status === 'committed',
      `status=${result.status}${result.gate_reasons ? ` gate=${JSON.stringify(result.gate_reasons)}` : ''}${result.errors ? ` errors=${JSON.stringify(result.errors).slice(0, 300)}` : ''}`,
    );
    if (result.status !== 'committed') continue;
    if (result.id !== undefined) createdPageIds.push(result.id);

    // NAMED: prime green.
    check(
      entry.label,
      'CSS prime green',
      result.css_primed === true,
      `css_primed=${result.css_primed}`,
    );

    // Contract 17 §4 — DIRECT I1–I4 assertion: every invariant hard-fails the pipeline pre-save
    // (a violation throws ConvertIntegrityError → 'convert committed' already failed above), and a
    // committed result must carry ZERO residual integrity rows (the wire-compat carrier stays
    // empty on a clean conversion). I2-skip degradations surface as an explicit warning — assert
    // the correspondence stayed sound so I2 was actually JUDGED, not skipped.
    const integrityRows = result.integrity ?? [];
    check(
      entry.label,
      'integrity invariants I1–I4 hold (pre-save, hard-gated)',
      integrityRows.length === 0,
      integrityRows.length > 0 ? JSON.stringify(integrityRows).slice(0, 300) : undefined,
    );
    const i2Skipped = (result.warnings ?? []).filter((w) =>
      w.includes('I2 base-default check SKIPPED'),
    );
    check(
      entry.label,
      'I2 judged on a sound source correspondence (not skipped)',
      i2Skipped.length === 0,
      i2Skipped[0],
    );

    // Surface the PIPELINE's own verification verdict (contract 17 §2–3 — the in-pipeline loop
    // runs at the LIVE breakpoints and may have R3-reverted the page to draft).
    if (result.verification !== undefined) {
      const g = result.verification.gate;
      console.log(
        `  [info] ${entry.label} :: pipeline verify gate ${g.pass ? 'PASS' : 'FAIL'} ` +
          `(${g.divergence_count} divergence(s), action=${g.action})`,
      );
      if (g.action === 'reverted_to_draft') {
        // Re-publish for the corpus's OWN measurement pass (otherwise every probe below renders
        // the theme 404 and the numbers are garbage). The page is deleted at the end regardless.
        await fetch(`${creds.url}/wp-json/wp/v2/pages/${result.id}`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basicToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'publish' }),
        });
        console.log(
          `  [info] ${entry.label} :: R3 had reverted the page to draft — re-published for the corpus measurement (deleted afterwards)`,
        );
      }
    }

    // Resolve the public permalink (the page was published above).
    const pageResp = await fetch(`${creds.url}/wp-json/wp/v2/pages/${result.id}`, {
      headers: { Authorization: `Basic ${basicToken}` },
    });
    const pageJson = await pageResp.json();
    const pageUrl = pageJson.link;
    check(
      entry.label,
      'page URL resolvable',
      typeof pageUrl === 'string' && pageUrl !== '',
      pageUrl,
    );
    if (typeof pageUrl !== 'string' || pageUrl === '') continue;

    // ── the W2 verification loop (V1 text-fallback matching, V2 audits, V3 pixel score) ────────
    const loop = await runVerifyLoop(
      { browser: ports.browser },
      { sourceUrlOrHtml: sourceUrl, pageUrl, breakpoints: BREAKPOINTS },
    );

    for (const audit of loop.layoutAudits) {
      check(
        entry.label,
        `V2 layout audit @ ${audit.breakpoint}`,
        audit.pass,
        `scrollWidth=${audit.scroll_width}/${audit.viewport_width} height=${audit.converted_height}/${audit.source_height} zeroArea=${audit.zero_area.length}`,
      );
    }
    // NAMED: 390 scrollWidth.
    const mobileAudit = loop.layoutAudits.find((a) => a.breakpoint === 'mobile');
    check(
      entry.label,
      '390 scrollWidth == 390',
      mobileAudit !== undefined && mobileAudit.scroll_width_ok,
      mobileAudit ? `scrollWidth=${mobileAudit.scroll_width}` : 'no mobile audit',
    );
    // I1 observable: no divergence attributed to a dangling style reference.
    const dangling = loop.divergences.filter((d) => d.cause === 'dangling_ref');
    check(
      entry.label,
      'no dangling style refs (I1)',
      dangling.length === 0,
      `${dangling.length} divergence(s)`,
    );
    // NAMED: ghost buttons transparent (no bg divergence whose SOURCE was transparent).
    const ghostHits = loop.divergences.filter(
      (d) =>
        d.prop === 'background-color' && /rgba\([^)]*,\s*0\)$|transparent/.test(d.source_value),
    );
    check(
      entry.label,
      'ghost buttons stay transparent',
      ghostHits.length === 0,
      ghostHits.length > 0 ? JSON.stringify(ghostHits[0]) : undefined,
    );
    // V3: the pixel gate is a STANDARD corpus assertion (contract 17 §4 — never env-optional).
    for (const score of loop.pixelScore) {
      const pct = (score.ratio * 100).toFixed(2);
      const bound = maxPixelRatioFor(score.breakpoint);
      console.log(
        `  [info] ${entry.label} :: V3 pixel mismatch @ ${score.breakpoint} = ${pct}%${score.error ? ` (error: ${score.error})` : ''}`,
      );
      check(
        entry.label,
        `V3 pixel ratio @ ${score.breakpoint} <= ${bound}`,
        score.ratio <= bound,
        `${pct}%`,
      );
    }
    if (loop.repairs.length > 0) {
      console.log(
        `  [info] ${entry.label} :: ${loop.repairs.length} mechanical repair(s) proposed:`,
      );
      for (const r of loop.repairs.slice(0, 10)) {
        console.log(`           - ${r.nodeId} ${r.prop} := ${r.value} (${r.cause})`);
      }
    }

    // ── named checks needing targeted probes (accent em, in-text hrefs, svg wrapper sizes) ─────
    const probes = await withPage(
      async (page) => {
        await page.goto(sourceUrl, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle').catch(() => {});
        return page.evaluate(sourceProbe);
      },
      { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' },
    );
    const conv = await withPage(
      async (page) => {
        await page.goto(pageUrl, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle').catch(() => {});
        return page.evaluate(convertedProbe, probes);
      },
      { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' },
    );

    // NAMED: SVG wrappers have size.
    const zeroSvg = conv.svgWrappers.filter((s) => s.visible && s.area === 0);
    check(
      entry.label,
      'SVG wrappers sized',
      zeroSvg.length === 0,
      `${conv.svgWrappers.length} wrapper(s), ${zeroSvg.length} zero-area`,
    );
    // NAMED: accent <em>/<span> color carried.
    const accentMisses = conv.accentResults.filter((a) => !a.found || !a.colored);
    check(
      entry.label,
      'accent inline color carried',
      accentMisses.length === 0,
      conv.accentResults.length === 0
        ? 'no accent inline text in source (vacuous)'
        : `${conv.accentResults.length} accent(s), ${accentMisses.length} miss(es)${accentMisses[0] ? `; first: ${JSON.stringify(accentMisses[0])}` : ''}`,
    );
    // NAMED: in-text links carry href.
    const linkMisses = conv.linkResults.filter((l) => !l.carried);
    check(
      entry.label,
      'in-text links carry href',
      linkMisses.length === 0,
      probes.links.length === 0
        ? 'no in-text links in source (vacuous)'
        : `${probes.links.length} link(s), ${linkMisses.length} miss(es)${linkMisses[0] ? `; first: ${JSON.stringify(linkMisses[0])}` : ''}`,
    );
  }

  // ── cleanup ──────────────────────────────────────────────────────────────────────────────────
  if (process.env.KEEP_CORPUS_PAGES !== '1') {
    for (const id of createdPageIds) {
      await fetch(`${creds.url}/wp-json/wp/v2/pages/${id}?force=true`, {
        method: 'DELETE',
        headers: { Authorization: `Basic ${basicToken}` },
      }).catch(() => {});
    }
    if (createdPageIds.length > 0) {
      console.log(
        `\n[corpus] deleted ${createdPageIds.length} corpus page(s) (KEEP_CORPUS_PAGES=1 to keep).`,
      );
    }
  } else if (createdPageIds.length > 0) {
    console.log(`\n[corpus] kept corpus page(s): ${createdPageIds.join(', ')}`);
  }

  await closeBrowser().catch(() => {});

  console.log(`\n[corpus] ${checks} check(s), ${failures.length} failure(s).`);
  if (failures.length > 0) {
    console.error('\n[corpus] FAILED assertions:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('[corpus] all green.');
}

main().catch((err) => {
  console.error(`[corpus] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
