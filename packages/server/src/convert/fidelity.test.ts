/**
 * WP-H10 — visual-diff FIDELITY tests.
 *
 * Three layers, each skipping CLEANLY when its dependency is absent (no false failures in a
 * Chromium-less / dep-less env):
 *   (1) DIFF MATH via a STUBBED BrowserPort feeding controlled PNG buffers — requires `pixelmatch` +
 *       `pngjs` (optional deps). Identical images → score ~0; clearly different → high score;
 *       per-breakpoint deltas; reuse of the injected port (no second browser).
 *   (2) LIVE Chromium via the WP-H03 pool — identical content → low score; different content → high.
 *   Both skip with a clear message when the dependency is unavailable.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { closeBrowser, withPage } from './browser-pool.js';
import { behavioralFidelityCheck, fidelityCheck } from './fidelity.js';
import type { BrowserPort } from './fidelity.js';
import type { BreakpointSpec, DetectedBehavior } from './types.js';

/* ─────────────────────────── optional-dep + Chromium probes ──────────────────────────────────── */

/** Indirect specifiers so neither tsc nor ESLint resolves the optional deps at build time. */
const PIXELMATCH_SPEC = 'pixelmatch';
const PNGJS_SPEC = 'pngjs';

let pixelDepsAvailable: boolean | null = null;
async function probePixelDeps(): Promise<boolean> {
  if (pixelDepsAvailable !== null) return pixelDepsAvailable;
  try {
    await import(PIXELMATCH_SPEC);
    await import(PNGJS_SPEC);
    pixelDepsAvailable = true;
  } catch {
    console.warn(
      '[fidelity.test] SKIP diff cases: `pixelmatch`/`pngjs` not installed ' +
        '(declared in deps_needed). Run the workspace install to enable.',
    );
    pixelDepsAvailable = false;
  }
  return pixelDepsAvailable;
}

let chromiumAvailable: boolean | null = null;
async function probeChromium(): Promise<boolean> {
  if (chromiumAvailable !== null) return chromiumAvailable;
  try {
    const { getBrowser } = await import('./browser-pool.js');
    const browser = await getBrowser();
    chromiumAvailable = browser.isConnected();
  } catch (err) {
    console.warn(
      `[fidelity.test] SKIP live cases: Chromium unavailable (${(err as Error).message}). ` +
        'Run `pnpm --filter @elementor-ultra/server exec playwright install chromium`.',
    );
    chromiumAvailable = false;
  }
  return chromiumAvailable;
}

afterAll(async () => {
  await closeBrowser();
});

const BPS: BreakpointSpec[] = [
  { key: 'mobile', width: 400, direction: 'max' },
  { key: 'desktop', width: 1200, direction: 'min' },
];

/* ─────────────────────────── solid-color PNG generator (for the stub port) ───────────────────── */

/** Minimal local type of the `pngjs` module surface the test uses. */
interface PngModule {
  PNG: {
    new (o: { width: number; height: number }): { data: Buffer; width: number; height: number };
    sync: { write(p: unknown): Buffer };
  };
}

/** Build a solid-color RGBA PNG buffer using the dynamically-imported `pngjs` (deps-gated). */
async function solidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
): Promise<Buffer> {
  const { PNG } = (await import(PNGJS_SPEC)) as PngModule;
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * A stub `BrowserPort` whose `withPage` ignores the real Playwright page and instead hands `fn` a
 * minimal fake page whose `screenshot()` returns a pre-seeded PNG (so we exercise the diff math without
 * a real browser). The screenshot returned advances per call via `shots` (rendered first, source second,
 * per breakpoint). The returned object exposes a live `calls` count so a test can assert no second
 * browser is used.
 */
interface StubHolder {
  port: BrowserPort;
  readonly calls: number;
}

function stubPort(shots: Buffer[]): StubHolder {
  const state = { calls: 0 };
  const port: BrowserPort = {
    withPage<T>(fn: (page: never) => Promise<T>): Promise<T> {
      const idx = state.calls;
      state.calls += 1;
      const fakePage = {
        goto: () => Promise.resolve(),
        setContent: () => Promise.resolve(),
        waitForLoadState: () => Promise.resolve(),
        evaluate: () => Promise.resolve(),
        screenshot: () => Promise.resolve(shots[idx % shots.length] ?? shots[0]!),
        close: () => Promise.resolve(),
      };
      return fn(fakePage as unknown as never);
    },
  };
  return {
    port,
    get calls(): number {
      return state.calls;
    },
  };
}

/* ─────────────────────────── diff math (stubbed port, deps-gated) ─────────────────────────────── */

describe('fidelityCheck: diff math (stubbed BrowserPort)', () => {
  it('identical renders → score ~0', async () => {
    if (!(await probePixelDeps())) return;
    const w = 64;
    const h = 1400; // matches the module SCREENSHOT_HEIGHT (clip box)
    const white = await solidPng(w, h, [255, 255, 255]);
    // rendered + source identical at each breakpoint (the stub returns the same buffer for every call).
    const { port } = stubPort([white]);
    const res = await fidelityCheck({
      rendered_url: 'http://example/preview',
      source_html: '<div>x</div>',
      breakpoints: [{ key: 'desktop', width: w, direction: 'min' }],
      browser: port,
    });
    expect(res.score).toBeCloseTo(0, 5);
    expect(res.deltas[0]?.diff_ratio).toBeCloseTo(0, 5);
    expect(res.deltas[0]?.region).toBeNull();
  });

  it('clearly different renders → high score', async () => {
    if (!(await probePixelDeps())) return;
    const w = 64;
    const h = 1400;
    const white = await solidPng(w, h, [255, 255, 255]);
    const black = await solidPng(w, h, [0, 0, 0]);
    // rendered (white) vs source (black): call 0 → white, call 1 → black.
    const { port } = stubPort([white, black]);
    const res = await fidelityCheck({
      rendered_url: 'http://example/preview',
      source_html: '<div>x</div>',
      breakpoints: [{ key: 'desktop', width: w, direction: 'min' }],
      browser: port,
    });
    expect(res.score).toBeGreaterThan(0.9); // nearly every pixel differs
  });

  it('reports one delta per breakpoint and score = worst ratio', async () => {
    if (!(await probePixelDeps())) return;
    const w = 64;
    const h = 1400;
    const white = await solidPng(w, h, [255, 255, 255]);
    const black = await solidPng(w, h, [0, 0, 0]);
    // 2 breakpoints × (rendered, source): bp0 identical (white,white), bp1 different (white,black).
    const { port } = stubPort([white, white, white, black]);
    const res = await fidelityCheck({
      rendered_url: 'http://example/preview',
      source_html: '<div>x</div>',
      breakpoints: BPS,
      browser: port,
    });
    expect(res.deltas.length).toBe(2);
    expect(res.deltas[0]?.breakpoint).toBe('mobile');
    expect(res.deltas[1]?.breakpoint).toBe('desktop');
    expect(res.deltas[0]?.diff_ratio).toBeCloseTo(0, 5);
    expect(res.deltas[1]?.diff_ratio).toBeGreaterThan(0.9);
    // score is the WORST (max) of the per-breakpoint ratios.
    expect(res.score).toBe(Math.max(res.deltas[0]!.diff_ratio, res.deltas[1]!.diff_ratio));
  });

  it('uses ONLY the injected port (no second browser launched)', async () => {
    if (!(await probePixelDeps())) return;
    const white = await solidPng(32, 1400, [255, 255, 255]);
    const holder = stubPort([white]);
    await fidelityCheck({
      rendered_url: 'http://example/preview',
      source_html: '<div>x</div>',
      breakpoints: [{ key: 'desktop', width: 32, direction: 'min' }],
      browser: holder.port,
    });
    // 1 breakpoint × 2 pages (rendered + source) = 2 withPage calls, all on the injected stub.
    expect(holder.calls).toBe(2);
  });
});

/* ─────────────────────────── BEHAVIORAL probes (contract 16 §6) ──────────────────────────────── */

/** Build a tiered `DetectedBehavior` for the behavioral-probe tests. */
function tieredBehavior(
  kind: DetectedBehavior['kind'],
  tier: 1 | 2 | 3 | 4,
  nodeId = `body>div.${kind}`,
): DetectedBehavior {
  return {
    kind,
    confidence: 'high',
    evidence: [`classname:${kind}`],
    nodeIds: [nodeId],
    tier,
    reason: `tier ${String(tier)}`,
  };
}

/** data: URL wrapper for a self-contained probe page (scripts DO run in data: documents). */
function dataUrl(body: string): string {
  return 'data:text/html,' + encodeURIComponent(`<!doctype html><html><body>${body}</body></html>`);
}

/** A two-tab `role=tablist/tab/tabpanel` page; `working:true` wires the click → switch script. */
function tabsPage(working: boolean): string {
  const script = working
    ? `<script>
        document.querySelectorAll('[role="tab"]').forEach((tab, i) => {
          tab.addEventListener('click', () => {
            document.querySelectorAll('[role="tab"]').forEach((t) =>
              t.setAttribute('aria-selected', String(t === tab)));
            document.querySelectorAll('[role="tabpanel"]').forEach((p, j) => { p.hidden = j !== i; });
          });
        });
      </script>`
    : '';
  return `
    <div role="tablist">
      <button role="tab" aria-selected="true">One</button>
      <button role="tab" aria-selected="false">Two</button>
    </div>
    <div role="tabpanel">Panel 1</div>
    <div role="tabpanel" hidden>Panel 2</div>
    ${script}`;
}

describe('behavioralFidelityCheck: probe selection (no browser needed)', () => {
  it('returns {probes: []} WITHOUT touching the browser when nothing is probeable', async () => {
    // tier-4 tabs (dropped), tier-3 custom-js (passthrough), tier-1 form (no v1 runtime probe):
    // none selects a probe, so the browser port must never be acquired.
    const holder = stubPort([Buffer.alloc(0)]);
    const res = await behavioralFidelityCheck({
      rendered_url: 'http://example/preview',
      behaviors: [
        tieredBehavior('tabs', 4),
        tieredBehavior('custom-js', 3),
        tieredBehavior('form', 1),
      ],
      browser: holder.port,
    });
    expect(res).toEqual({ probes: [] });
    expect(holder.calls).toBe(0);
  });
});

describe('behavioralFidelityCheck: live probes (real Chromium)', () => {
  it('tier-1 tabs: a WORKING tabs page passes; a dead (script-less) one honestly fails', async () => {
    if (!(await probeChromium())) return;
    const livePort: BrowserPort = { withPage };

    const working = await behavioralFidelityCheck({
      rendered_url: dataUrl(tabsPage(true)),
      behaviors: [tieredBehavior('tabs', 1, 'body>div.tabs-root')],
      browser: livePort,
    });
    expect(working.probes.length).toBe(1);
    expect(working.probes[0]).toMatchObject({ kind: 'tabs', nodeId: 'body>div.tabs-root' });
    expect(working.probes[0]?.pass).toBe(true);
    expect(working.probes[0]?.detail).toContain('aria-selected');

    const dead = await behavioralFidelityCheck({
      rendered_url: dataUrl(tabsPage(false)),
      behaviors: [tieredBehavior('tabs', 1)],
      browser: livePort,
    });
    expect(dead.probes[0]?.pass).toBe(false);
    expect(dead.probes[0]?.detail).toContain('changed');
  }, 120_000);

  it('tier-1 tabs: a missing tablist is an honest pass:false row, never a throw', async () => {
    if (!(await probeChromium())) return;
    const res = await behavioralFidelityCheck({
      rendered_url: dataUrl('<p>no tabs rendered here</p>'),
      behaviors: [tieredBehavior('tabs', 1)],
      browser: { withPage },
    });
    expect(res.probes[0]?.pass).toBe(false);
    expect(res.probes[0]?.detail).toContain('no [role="tablist"]');
  }, 120_000);

  it('tier-2: asserts the interactions blob + data-interaction-id carriers (S08 §3)', async () => {
    if (!(await probeChromium())) return;
    const livePort: BrowserPort = { withPage };

    // the S08 frontend markers present → pass.
    const withMarkers = await behavioralFidelityCheck({
      rendered_url: dataUrl(
        '<div data-interaction-id="123-abc1234-0">hero</div>' +
          '<script id="elementor-interactions-data" type="application/json">{}</script>',
      ),
      behaviors: [tieredBehavior('entrance-animation', 2, 'body>div.hero')],
      browser: livePort,
    });
    expect(withMarkers.probes.length).toBe(1);
    expect(withMarkers.probes[0]).toMatchObject({
      kind: 'interactions',
      nodeId: 'body>div.hero',
      pass: true,
    });
    expect(withMarkers.probes[0]?.detail).toContain('blob present');

    // sanitizer silently dropped everything (no blob, no carriers) → honest fail (§0.3).
    const sanitized = await behavioralFidelityCheck({
      rendered_url: dataUrl('<div>hero</div>'),
      behaviors: [tieredBehavior('entrance-animation', 2)],
      browser: livePort,
    });
    expect(sanitized.probes[0]?.pass).toBe(false);
    expect(sanitized.probes[0]?.detail).toContain('MISSING');
  }, 120_000);

  it('emits one probe row per probeable behavior (tabs by tablist index + per tier-2 row)', async () => {
    if (!(await probeChromium())) return;
    const res = await behavioralFidelityCheck({
      rendered_url: dataUrl(
        tabsPage(true) + '<div data-interaction-id="1-a-0"></div>' +
          '<script id="elementor-interactions-data" type="application/json">{}</script>',
      ),
      behaviors: [
        tieredBehavior('tabs', 1, 'tabs-a'),
        tieredBehavior('entrance-animation', 2, 'anim-a'),
        tieredBehavior('hover-effect', 2, 'hover-b'),
        tieredBehavior('carousel', 4), // dropped — no probe
      ],
      browser: { withPage },
    });
    expect(res.probes.map((p) => p.kind)).toEqual(['tabs', 'interactions', 'interactions']);
    expect(res.probes.map((p) => p.nodeId)).toEqual(['tabs-a', 'anim-a', 'hover-b']);
    expect(res.probes.every((p) => p.pass)).toBe(true);
  }, 120_000);
});

/* ─────────────────────────── live Chromium (deps + browser gated) ────────────────────────────── */

describe('fidelityCheck: live render (real Chromium)', () => {
  it('identical content → low score; different content → high score', async () => {
    if (!(await probePixelDeps())) return;
    if (!(await probeChromium())) return;

    const livePort: BrowserPort = { withPage };
    const html = '<div style="width:100%;height:1400px;background:#fff"></div>';

    // We cannot easily host a "saved page" URL here, so set both via setContent through a data: URL for
    // rendered and source HTML for source — identical content should score low.
    const dataUrl =
      'data:text/html,' + encodeURIComponent(`<!doctype html><html><body>${html}</body></html>`);
    const same = await fidelityCheck({
      rendered_url: dataUrl,
      source_html: html,
      breakpoints: [{ key: 'desktop', width: 200, direction: 'min' }],
      browser: livePort,
    });
    expect(same.score).toBeLessThan(0.2);

    const diffHtml = '<div style="width:100%;height:1400px;background:#000"></div>';
    const diffDataUrl =
      'data:text/html,' +
      encodeURIComponent(`<!doctype html><html><body>${diffHtml}</body></html>`);
    const different = await fidelityCheck({
      rendered_url: diffDataUrl,
      source_html: html, // white source vs black rendered
      breakpoints: [{ key: 'desktop', width: 200, direction: 'min' }],
      browser: livePort,
    });
    expect(different.score).toBeGreaterThan(same.score);
  }, 120_000);
});
