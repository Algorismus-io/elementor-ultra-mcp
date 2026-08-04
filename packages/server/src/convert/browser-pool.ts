/**
 * WP-H03 — shared headless-Chromium browser pool (Playwright).
 *
 * ONE Playwright/Chromium launch is reused across the PARSE stage (`parse.ts`, this WP) and the
 * visual-diff fidelity gate (WP-H10) — a single Playwright dependency serving both stages
 * (`15-engineering-standards.md §4.6`: "reuses the Playwright instance for the visual-diff gate";
 * SUPPLEMENT §C.3). The pool is lazy: nothing launches at import time (the browser MUST NOT
 * auto-download/launch on `import` — `WP-H03` Implementation Notes), and `closeBrowser()` exists so
 * the MCP server can exit cleanly with no hanging handles.
 *
 * Concurrency is bounded: a default of ONE shared `Browser` and N concurrently-open `Page`s
 * (`PAGE_CONCURRENCY`). `withPage` acquires a page, runs `fn`, and ALWAYS closes the page in a
 * `finally`, so a thrown `fn` never leaks a page (acceptance: "always closes pages").
 *
 * This module imports the Playwright TYPES only at type level; the runtime module is imported
 * dynamically inside `getBrowser()` so that merely importing `browser-pool` (e.g. for `withPage`'s
 * type, or in a Chromium-less environment) does not require Playwright to be installed/launchable.
 */

import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright';

/** Default count of pages allowed to be open simultaneously against the single shared browser. */
const PAGE_CONCURRENCY = 4;

/** Launch flags kept minimal + CI-friendly (sandbox off, so the same launch works in containers). */
const LAUNCH_OPTIONS: LaunchOptions = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
};

/** Lazily-launched singletons. `null` until the first `getBrowser()`; reset on `closeBrowser()`. */
let browserPromise: Promise<Browser> | null = null;
let sharedBrowser: Browser | null = null;

/**
 * A tiny FIFO semaphore bounding how many pages are open at once. Acquiring beyond the limit waits
 * for a release; `release` always frees the next waiter (or restores a permit).
 */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.permits += 1;
  }
}

const pageSemaphore = new Semaphore(PAGE_CONCURRENCY);

/**
 * Lazily launch (or reuse) the single shared Chromium instance. The Playwright runtime is imported
 * dynamically here — NOT at module top-level — so that importing this module never forces Playwright
 * to be present/launchable. Concurrent callers share one in-flight launch promise.
 *
 * @throws if Playwright is not installed or Chromium is not available (callers/tests should treat a
 *   throw as "Chromium unavailable" and skip the live-browser leg).
 */
export async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  if (browserPromise) {
    return browserPromise;
  }
  browserPromise = (async (): Promise<Browser> => {
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch(LAUNCH_OPTIONS);
    sharedBrowser = browser;
    // If the browser disconnects (crash / external close), drop the cached singletons so the next
    // `getBrowser()` relaunches instead of handing back a dead instance.
    browser.on('disconnected', () => {
      if (sharedBrowser === browser) {
        sharedBrowser = null;
        browserPromise = null;
      }
    });
    return browser;
  })();
  try {
    return await browserPromise;
  } catch (err) {
    // Failed launch must not poison the singleton: clear it so a later attempt can retry.
    browserPromise = null;
    sharedBrowser = null;
    throw err;
  }
}

/**
 * Acquire a fresh `Page` (in its own ephemeral context so per-call options like viewport/reducedMotion
 * do not leak between callers), run `fn`, and ALWAYS close the page and context — even when `fn`
 * throws — so no page handle is ever leaked. Bounded by `PAGE_CONCURRENCY`.
 *
 * @param fn receives the live page and may return any value.
 * @param contextOptions optional Playwright context options (viewport, reducedMotion, baseURL, …).
 */
export async function withPage<T>(
  fn: (page: Page) => Promise<T>,
  contextOptions?: Parameters<Browser['newContext']>[0],
): Promise<T> {
  const browser = await getBrowser();
  await pageSemaphore.acquire();
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
    return await fn(page);
  } finally {
    if (page) {
      await page.close().catch(() => {
        /* page may already be closed; swallow so cleanup never masks the real error */
      });
    }
    if (context) {
      await context.close().catch(() => {
        /* context may already be closed; swallow */
      });
    }
    pageSemaphore.release();
  }
}

/**
 * Close the shared browser (if any) and clear the singletons so the process can exit with no hanging
 * handles (acceptance: "`closeBrowser()` makes the process exit cleanly"). Safe to call when nothing
 * was ever launched (no-op) and safe to call repeatedly.
 */
export async function closeBrowser(): Promise<void> {
  const browser = sharedBrowser;
  browserPromise = null;
  sharedBrowser = null;
  if (browser && browser.isConnected()) {
    await browser.close().catch(() => {
      /* already closed / disconnected — exiting cleanly is the goal, so swallow */
    });
  }
}

/** Whether a shared browser is currently launched + connected (used by tests for reuse assertions). */
export function isBrowserLaunched(): boolean {
  return Boolean(sharedBrowser && sharedBrowser.isConnected());
}
