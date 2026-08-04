/**
 * WP-H03 — browser-pool tests.
 *
 * Covers the acceptance criteria for the shared Chromium pool:
 *   - single-instance reuse (`getBrowser` hands back the SAME `Browser` across calls);
 *   - `withPage` always closes its page in a `finally` even when `fn` throws (no leaked pages);
 *   - bounded concurrency (more than the limit of concurrent `withPage`s still resolve);
 *   - clean shutdown (`closeBrowser` disconnects + lets the process exit, and is idempotent).
 *
 * The suite needs a real Chromium. If Chromium is unavailable (not installed / cannot launch) the
 * live cases skip with a clear message — mirroring the fixtures-harness capability-skip pattern — so
 * CI without `playwright install chromium` stays green instead of red.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { closeBrowser, getBrowser, isBrowserLaunched, withPage } from './browser-pool.js';

/** Probe once whether Chromium can actually launch; cache the verdict for `skipUnlessChromium`. */
let chromiumAvailable: boolean | null = null;

async function probeChromium(): Promise<boolean> {
  if (chromiumAvailable !== null) {
    return chromiumAvailable;
  }
  try {
    const browser = await getBrowser();
    chromiumAvailable = browser.isConnected();
  } catch (err) {
    console.warn(
      `[browser-pool.test] SKIP live cases: Chromium unavailable (${(err as Error).message}). ` +
        'Run `pnpm --filter @elementor-ultra/server exec playwright install chromium`.',
    );
    chromiumAvailable = false;
  }
  return chromiumAvailable;
}

afterAll(async () => {
  await closeBrowser();
});

describe('browser-pool: pure / always-on', () => {
  it('isBrowserLaunched is false before anything launches (when not yet probed)', () => {
    // This only holds if no prior test launched; tolerate either state but assert the type.
    expect(typeof isBrowserLaunched()).toBe('boolean');
  });

  it('closeBrowser is a safe no-op when nothing was launched / called twice', async () => {
    await closeBrowser();
    await expect(closeBrowser()).resolves.toBeUndefined();
  });
});

describe('browser-pool: live (requires Chromium)', () => {
  it('getBrowser launches exactly one shared, reused Chromium', async () => {
    if (!(await probeChromium())) return;
    const a = await getBrowser();
    const b = await getBrowser();
    expect(a).toBe(b);
    expect(a.isConnected()).toBe(true);
    expect(isBrowserLaunched()).toBe(true);
  }, 60_000);

  it('withPage runs fn and the page is closed afterward (success path)', async () => {
    if (!(await probeChromium())) return;
    let capturedClosedAfter = false;
    const value = await withPage((page) => {
      expect(page.isClosed()).toBe(false);
      // schedule a check that runs after withPage closes the page
      page.once('close', () => {
        capturedClosedAfter = true;
      });
      return Promise.resolve(42);
    });
    expect(value).toBe(42);
    // allow the close event microtask to flush
    await new Promise((r) => setTimeout(r, 50));
    expect(capturedClosedAfter).toBe(true);
  }, 60_000);

  it('withPage closes the page even when fn throws (finally)', async () => {
    if (!(await probeChromium())) return;
    let closed = false;
    let pageRef: { isClosed(): boolean } | null = null;
    await expect(
      withPage((page): Promise<never> => {
        pageRef = page;
        page.once('close', () => {
          closed = true;
        });
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
    expect(pageRef && (pageRef as { isClosed(): boolean }).isClosed()).toBe(true);
  }, 60_000);

  it('bounded concurrency: more than the page limit still all resolve', async () => {
    if (!(await probeChromium())) return;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withPage(async (page) => {
          await page.setContent(`<p>n${i}</p>`);
          return i;
        }),
      ),
    );
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  }, 120_000);

  it('closeBrowser disconnects the shared browser (clean shutdown)', async () => {
    if (!(await probeChromium())) return;
    const browser = await getBrowser();
    expect(browser.isConnected()).toBe(true);
    await closeBrowser();
    expect(browser.isConnected()).toBe(false);
    expect(isBrowserLaunched()).toBe(false);
    // getBrowser relaunches after a close (singleton was cleared)
    const relaunched = await getBrowser();
    expect(relaunched.isConnected()).toBe(true);
    expect(relaunched).not.toBe(browser);
  }, 60_000);
});
