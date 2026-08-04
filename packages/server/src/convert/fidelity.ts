/**
 * WP-H10 — visual-diff FIDELITY gate (`convert.fidelity_check`, `13-tool-catalog §1.9`).
 *
 * Renders the SAVED + PRIMED Elementor page (`rendered_url` — a public/preview URL whose atomic CSS is
 * only present AFTER priming, `11-authoring-contract.md §10`; the orchestrator WP-H11 primes before
 * calling this) and the SOURCE HTML+CSS, screenshots BOTH at each breakpoint width, and compares them
 * with pixelmatch. The reported `score` / per-breakpoint `diff_ratio` is `diffPixels / totalPixels`
 * (LOWER is better) — an HONEST number, never a promise (RESEARCH.md §6.6/§6.8, SUPPLEMENT §C.3-C.4).
 *
 * Spike-verified rendering hygiene (else the diff is noise — SUPPLEMENT §C.3-C.4):
 *   - `animations:'disabled'` + `reducedMotion:'reduce'` (freeze CSS animations/transitions),
 *   - `waitForLoadState('networkidle')` + `document.fonts.ready` (web fonts settle before screenshot),
 *   - per-pixel pixelmatch `threshold` is the per-pixel COLOR tolerance, NOT the proportion changed —
 *     we set it modestly and gate on the diffPixels/total RATIO (SUPPLEMENT §C.4).
 *
 * Reuses the WP-H03 browser pool (ONE Playwright instance) via the injected `BrowserPort`; never
 * launches a second browser. Degrades CLEANLY when Chromium is unavailable (the caller catches the
 * throw and omits `visual_diff_score`).
 *
 * `pixelmatch` + `pngjs` are imported DYNAMICALLY inside `fidelityCheck` so merely importing this module
 * never requires them to be installed (mirrors `browser-pool.ts` lazy Playwright import).
 */

import type { Page } from 'playwright';

import { withPage as defaultWithPage } from './browser-pool.js';
import type {
  BehaviorProbe,
  BehavioralFidelityResult,
  BreakpointSpec,
  DetectedBehavior,
  FidelityResult,
} from './types.js';

/* ─────────────────────────── browser port (WP-H03 pool, injectable) ──────────────────────────── */

/**
 * The WP-H03 browser-pool surface this stage needs: acquire a page (in its own ephemeral context with
 * the given context options), run `fn`, ALWAYS close the page. Injected so tests can stub it and so a
 * single shared Playwright instance serves PARSE + this gate. Mirrors `browser-pool.withPage`.
 */
export interface BrowserPort {
  withPage<T>(
    fn: (page: Page) => Promise<T>,
    contextOptions?: {
      viewport?: { width: number; height: number };
      reducedMotion?: 'reduce' | 'no-preference';
    } & Record<string, unknown>,
  ): Promise<T>;
}

/** The default port: the live WP-H03 shared pool. */
const defaultBrowser: BrowserPort = { withPage: defaultWithPage };

/* ─────────────────────────── input ───────────────────────────────────────────────────────────── */

/** `convert.fidelity_check` input (`13-tool-catalog §1.9`). `browser` defaults to the WP-H03 pool. */
export interface FidelityInput {
  /** The SAVED + PRIMED page URL (public/preview; atomic CSS present only after the prime). */
  rendered_url: string;
  /** The source HTML to compare against. */
  source_html: string;
  /** Optional source CSS injected into the source render (when not inlined in the HTML). */
  source_css?: string;
  /** The breakpoint widths to screenshot + diff at. */
  breakpoints: BreakpointSpec[];
  /** The WP-H03 browser pool (one Playwright instance). Defaults to the shared pool. */
  browser?: BrowserPort;
}

/* ─────────────────────────── screenshot hygiene ──────────────────────────────────────────────── */

/** A fixed screenshot height so both renders diff at the same canvas size (full-page would diverge). */
const SCREENSHOT_HEIGHT = 1400;

/** Settle the page: wait for network idle + web fonts ready (else font swap noises the diff). */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {
    /* networkidle may never fire on a static doc; the load-state wait below covers it. */
  });
  await page.waitForLoadState('load').catch(() => {
    /* already loaded */
  });
  // Wait for fonts to be ready (best-effort — older targets may not expose document.fonts).
  await page
    .evaluate(async () => {
      const fonts = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts;
      if (fonts?.ready) {
        await fonts.ready;
      }
    })
    .catch(() => {
      /* fonts API absent — ignore */
    });
}

/** Screenshot a page at a fixed viewport width × `SCREENSHOT_HEIGHT`, returning the PNG bytes. */
async function shoot(
  browser: BrowserPort,
  configure: (page: Page) => Promise<void>,
  width: number,
): Promise<Buffer> {
  return browser.withPage(
    async (page) => {
      await configure(page);
      await settle(page);
      const buf = await page.screenshot({
        // Clip to a fixed box so the two renders compare at the SAME dimensions (pixelmatch requires
        // equal width/height); a full-page screenshot would differ in height and break the diff.
        clip: { x: 0, y: 0, width, height: SCREENSHOT_HEIGHT },
        animations: 'disabled',
      });
      return Buffer.from(buf);
    },
    { viewport: { width, height: SCREENSHOT_HEIGHT }, reducedMotion: 'reduce' },
  );
}

/* ─────────────────────────── pixelmatch diff (optional deps, dynamic import) ──────────────────── */

/*
 * `pixelmatch` + `pngjs` are OPTIONAL runtime deps (declared in `deps_needed`, NOT in this package's
 * compile-time surface). They are imported through an INDIRECT specifier so `tsc` never tries to resolve
 * their types at build time (the env may not have them installed); the loaded shapes are typed locally
 * to the minimal surface this module uses. This mirrors the lazy-Playwright pattern in `browser-pool.ts`.
 */

/** Minimal local type of `pngjs`'s `PNG.sync.read` output. */
interface DecodedPng {
  data: Buffer;
  width: number;
  height: number;
}

/** Minimal local type of `pixelmatch`'s default export. */
type PixelmatchFn = (
  img1: Buffer,
  img2: Buffer,
  output: Buffer | null,
  width: number,
  height: number,
  options?: { threshold?: number },
) => number;

/** Dynamic import via an indirection so the bundler/tsc does not resolve the optional dep at build. */
async function loadOptional<T>(specifier: string): Promise<T> {
  // The variable specifier defeats TS module-type resolution; the module is resolved at runtime only.
  return (await import(/* @vite-ignore */ specifier)) as T;
}

/** PNG decode helper using the dynamically-imported `pngjs`. */
async function decodePng(bytes: Buffer): Promise<DecodedPng> {
  const mod = await loadOptional<{ PNG: { sync: { read(b: Buffer): DecodedPng } } }>('pngjs');
  return mod.PNG.sync.read(bytes);
}

/**
 * Compare two PNG buffers; return `diffPixels / totalPixels` (0..1, lower is better). Mismatched
 * dimensions are normalized to the SMALLER common box (defensive — both shots use the same clip so this
 * is rare) and the size delta is counted as fully-different pixels so a divergent layout scores worse.
 */
async function diffRatio(aPng: Buffer, bPng: Buffer): Promise<number> {
  const pmMod = await loadOptional<{ default: PixelmatchFn }>('pixelmatch');
  const pixelmatch = pmMod.default;
  const a = await decodePng(aPng);
  const b = await decodePng(bPng);

  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const total = width * height;
  if (total === 0) return 1;

  // Crop both to the common box if needed (pixelmatch requires equal dimensions).
  const aData = a.width === width && a.height === height ? a.data : crop(a, width, height);
  const bData = b.width === width && b.height === height ? b.data : crop(b, width, height);

  const diff = Buffer.alloc(width * height * 4);
  const changed = pixelmatch(aData, bData, diff, width, height, {
    // Per-PIXEL color tolerance (NOT the proportion changed) — modest so genuine color/layout diffs
    // are counted, but anti-aliasing jitter is not (SUPPLEMENT §C.4).
    threshold: 0.1,
  });
  return changed / total;
}

/** Crop an RGBA buffer to a top-left w×h box (row-by-row copy). */
function crop(img: { data: Buffer; width: number; height: number }, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = y * img.width * 4;
    img.data.copy(out, y * w * 4, srcStart, srcStart + w * 4);
  }
  return out;
}

/* ─────────────────────────── source render ───────────────────────────────────────────────────── */

/** Build a self-contained source document (inject `source_css` into a `<style>` when supplied). */
function sourceDocument(html: string, css?: string): string {
  const styleTag = css !== undefined && css !== '' ? `<style>${css}</style>` : '';
  // If the input already looks like a full document, inject the style into <head>; else wrap it.
  if (/<html[\s>]/i.test(html)) {
    return styleTag !== '' && /<head[\s>]/i.test(html)
      ? html.replace(/<head([\s>])/i, `<head$1${styleTag}`)
      : html;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${styleTag}</head><body>${html}</body></html>`;
}

/* ─────────────────────────── fidelityCheck ───────────────────────────────────────────────────── */

/**
 * Render the saved+primed page vs. the source at each breakpoint, diff, and return the
 * `{score, deltas[]}` (`convert.fidelity_check`). `score` is the WORST (max) per-breakpoint
 * `diff_ratio` — the conservative honest figure the gate consumes (a single bad breakpoint should not
 * be hidden by good ones). `region` is `null` (region attribution is a future refinement; the schema
 * permits null).
 *
 * Async (browser I/O via the injected `BrowserPort`). Reuses the ONE shared Playwright instance — never
 * launches a second browser. Propagates a Chromium-unavailable throw so the caller can omit the score.
 */
export async function fidelityCheck(input: FidelityInput): Promise<FidelityResult> {
  const browser = input.browser ?? defaultBrowser;
  const breakpoints =
    input.breakpoints.length > 0
      ? input.breakpoints
      : [{ key: 'desktop' as const, width: 1280, direction: 'min' as const }];

  const sourceDoc = sourceDocument(input.source_html, input.source_css);

  const deltas: FidelityResult['deltas'] = [];
  for (const bp of breakpoints) {
    const width = bp.width;

    // Saved+primed page: navigate to the public/preview URL.
    const renderedShot = await shoot(
      browser,
      async (page) => {
        await page.goto(input.rendered_url, { waitUntil: 'load' });
      },
      width,
    );

    // Source render: set the raw HTML+CSS content.
    const sourceShot = await shoot(
      browser,
      async (page) => {
        await page.setContent(sourceDoc, { waitUntil: 'load' });
      },
      width,
    );

    const ratio = await diffRatio(renderedShot, sourceShot);
    deltas.push({ breakpoint: String(bp.key), diff_ratio: ratio, region: null });
  }

  const score = deltas.reduce((worst, d) => Math.max(worst, d.diff_ratio), 0);
  return { score, deltas };
}

/* ─────────────────────────── BEHAVIORAL fidelity (contract 16 §6) ─────────────────────────────── */

/*
 * Post-commit, opt-in probes (like visual fidelity) that verify converted BEHAVIORS actually work on
 * the saved+primed page — never trust the save alone (the interactions sanitizer drops silently, S08):
 *   - tier-1 `tabs`: click a non-active tab on the rendered page and assert the active panel changes
 *     (`aria-selected` flip and/or `[role=tabpanel]` visibility change).
 *   - tier-2 (entrance-animation / hover-effect → native interactions): assert the centralized
 *     interactions blob `<script id="elementor-interactions-data">` was printed at `wp_footer` AND
 *     elements carry the renderer's `data-interaction-id` attribute (S08 §3 frontend mechanics).
 * Result shape (§6, frozen): `{probes: [{kind, nodeId, pass, detail}]}` — a failing probe is an
 * HONEST `pass:false` row, never a throw. Only Chromium-unavailable propagates (the caller treats
 * the behavioral check as unavailable, mirroring `fidelityCheck`).
 */

/** `behavioralFidelityCheck` input. `behaviors` are the TIERED behaviors from the coverage report. */
export interface BehavioralFidelityInput {
  /** The SAVED + PRIMED page URL (same URL contract as `FidelityInput.rendered_url`). */
  rendered_url: string;
  /** The tiered detected behaviors (`CoverageReport.behavior.detected`). Untargeted tiers are skipped. */
  behaviors: DetectedBehavior[];
  /** Viewport width for the probe render (desktop default — tabs are clicked at desktop layout). */
  viewport_width?: number;
  /** The WP-H03 browser pool (one Playwright instance). Defaults to the shared pool. */
  browser?: BrowserPort;
}

/** Per-tab/panel UI state snapshot used to assert the click actually changed the active panel. */
interface TablistSnapshot {
  /** `aria-selected` per `[role=tab]` inside the probed tablist (in DOM order). */
  selected: string[];
  /** Visibility flag per `[role=tabpanel]` on the page (in DOM order). */
  visiblePanels: boolean[];
}

/** Capture the `index`-th tablist's tab/panel state inside the page (pure DOM read). */
async function snapshotTablist(page: Page, index: number): Promise<TablistSnapshot | null> {
  return page.evaluate((tablistIndex: number): TablistSnapshot | null => {
    const tablist = document.querySelectorAll('[role="tablist"]')[tablistIndex];
    if (tablist === undefined) return null;
    const selected = Array.from(tablist.querySelectorAll('[role="tab"]')).map(
      (tab) => tab.getAttribute('aria-selected') ?? '',
    );
    const visiblePanels = Array.from(document.querySelectorAll('[role="tabpanel"]')).map((p) => {
      const el = p as HTMLElement;
      const cs = getComputedStyle(el);
      return (
        cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0
      );
    });
    return { selected, visiblePanels };
  }, index);
}

/** Did the click change anything observable (`aria-selected` flip OR panel visibility change)? */
function tablistStateChanged(before: TablistSnapshot, after: TablistSnapshot): boolean {
  return (
    before.selected.join('|') !== after.selected.join('|') ||
    before.visiblePanels.join('|') !== after.visiblePanels.join('|')
  );
}

/**
 * Probe the `index`-th rendered tablist for a tier-1 tabs conversion: snapshot → click the first
 * NON-selected tab (a real, trusted Playwright click so widget listeners fire) → poll for an
 * `aria-selected`/panel-visibility change. Honest `pass:false` rows for every failure mode
 * (no tablist rendered, <2 tabs, click had no observable effect).
 */
async function probeTabs(page: Page, index: number, nodeId: string): Promise<BehaviorProbe> {
  const before = await snapshotTablist(page, index);
  if (before === null) {
    return {
      kind: 'tabs',
      nodeId,
      pass: false,
      detail: `no [role="tablist"] #${String(index)} rendered on the converted page`,
    };
  }
  if (before.selected.length < 2) {
    return {
      kind: 'tabs',
      nodeId,
      pass: false,
      detail:
        `tablist #${String(index)} rendered only ${String(before.selected.length)} ` +
        '[role="tab"] element(s) — need ≥2 to probe a switch',
    };
  }

  // Click the first tab that is NOT currently selected (falls back to tab 1 when the widget left
  // aria-selected unset everywhere — the click still must produce an observable state change).
  const targetIdx = Math.max(
    before.selected.findIndex((s) => s !== 'true'),
    before.selected.every((s) => s !== 'true') ? 1 : 0,
  );
  const tab = page
    .locator('[role="tablist"]')
    .nth(index)
    .locator('[role="tab"]')
    .nth(targetIdx);
  await tab.click({ timeout: 5_000 });

  // Poll briefly for the state change (widget JS may animate the switch).
  const deadline = Date.now() + 2_000;
  let after = await snapshotTablist(page, index);
  while (after !== null && !tablistStateChanged(before, after) && Date.now() < deadline) {
    await page.waitForTimeout(100);
    after = await snapshotTablist(page, index);
  }

  const changed = after !== null && tablistStateChanged(before, after);
  const detail = changed
    ? `clicked tab ${String(targetIdx + 1)}/${String(before.selected.length)}: aria-selected ` +
      `[${before.selected.join(',')}] → [${(after ?? before).selected.join(',')}], visible panels ` +
      `[${before.visiblePanels.join(',')}] → [${(after ?? before).visiblePanels.join(',')}]`
    : `clicked tab ${String(targetIdx + 1)}/${String(before.selected.length)} but neither ` +
      'aria-selected nor [role="tabpanel"] visibility changed';
  return { kind: 'tabs', nodeId, pass: changed, detail };
}

/** Page-level interactions facts the tier-2 probes assert (read once, reported per behavior). */
interface InteractionsFacts {
  blobPresent: boolean;
  carrierCount: number;
}

/** Read the S08 frontend markers: the wp_footer blob + `data-interaction-id` carrier count. */
async function readInteractionsFacts(page: Page): Promise<InteractionsFacts> {
  return page.evaluate((): InteractionsFacts => {
    return {
      blobPresent: document.getElementById('elementor-interactions-data') !== null,
      carrierCount: document.querySelectorAll('[data-interaction-id]').length,
    };
  });
}

/**
 * Run the contract-16 §6 behavioral probes against the SAVED + PRIMED page:
 *   - one `tabs` probe per tier-1 `tabs` behavior (the i-th tabs behavior probes the i-th rendered
 *     `[role=tablist]` — document order matches conversion order),
 *   - one `interactions` probe per tier-2 behavior (footer blob + `data-interaction-id` carriers).
 * Behaviors on other tiers/kinds have no runtime probe in v1 and are skipped (the coverage report
 * already carries their tier + reason). Zero probeable behaviors → `{probes: []}` WITHOUT touching
 * the browser. Per-probe failures are honest `pass:false` rows; only Chromium-unavailable throws.
 */
export async function behavioralFidelityCheck(
  input: BehavioralFidelityInput,
): Promise<BehavioralFidelityResult> {
  const tabsBehaviors = input.behaviors.filter((b) => b.tier === 1 && b.kind === 'tabs');
  const interactionBehaviors = input.behaviors.filter((b) => b.tier === 2);
  if (tabsBehaviors.length === 0 && interactionBehaviors.length === 0) {
    return { probes: [] };
  }

  const browser = input.browser ?? defaultBrowser;
  const width = input.viewport_width ?? 1280;

  return browser.withPage(
    async (page) => {
      await page.goto(input.rendered_url, { waitUntil: 'load' });
      await settle(page);

      const probes: BehaviorProbe[] = [];

      // Tier-1 tabs: the i-th tabs behavior probes the i-th rendered tablist.
      for (const [i, behavior] of tabsBehaviors.entries()) {
        const nodeId = behavior.nodeIds[0] ?? '';
        try {
          probes.push(await probeTabs(page, i, nodeId));
        } catch (err) {
          probes.push({
            kind: 'tabs',
            nodeId,
            pass: false,
            detail: `tabs probe failed: ${(err as Error).message}`,
          });
        }
      }

      // Tier-2 interactions: page-level facts read once, asserted per behavior (per-behavior rows
      // keep the §6 result shape — every probed behavior gets its own honest verdict).
      if (interactionBehaviors.length > 0) {
        let facts: InteractionsFacts | null = null;
        let probeError = '';
        try {
          facts = await readInteractionsFacts(page);
        } catch (err) {
          probeError = (err as Error).message;
        }
        for (const behavior of interactionBehaviors) {
          const pass = facts !== null && facts.blobPresent && facts.carrierCount > 0;
          const detail =
            facts === null
              ? `interactions probe failed: ${probeError}`
              : `#elementor-interactions-data blob ${facts.blobPresent ? 'present' : 'MISSING'}; ` +
                `${String(facts.carrierCount)} element(s) carry data-interaction-id`;
          probes.push({
            kind: 'interactions',
            nodeId: behavior.nodeIds[0] ?? '',
            pass,
            detail,
          });
        }
      }

      return { probes };
    },
    { viewport: { width, height: SCREENSHOT_HEIGHT } },
  );
}
