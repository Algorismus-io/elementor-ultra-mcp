/**
 * WP-T01 — CapabilitiesCache tests (§Tests Required): memoizes ONE `siteCapabilities()` call; `refresh()`
 * re-fetches; concurrent first calls share one fetch; a rejection is not cached.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Capabilities } from '@elementor-ultra/shared';

import { CapabilitiesCache } from './capabilities-cache.js';

/** A minimal valid {@link Capabilities} stub. */
function stubCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    v4: true,
    atomic: true,
    global_classes: true,
    variables: true,
    pro: true,
    pro_atomic_form: false,
    breakpoints: [],
    experiments: {},
    can_update_class: true,
    classes_migrated: true,
    registered_types: { atomic: [], classic: [] },
    versions: { elementor: '4.1.1', pro: '4.1.0', plugin: '0.0.0' },
    unfiltered_html: true,
    ...overrides,
  };
}

describe('CapabilitiesCache', () => {
  it('memoizes a single fetch across repeated get() calls', async () => {
    const fetcher = vi.fn(() => Promise.resolve(stubCapabilities()));
    const cache = new CapabilitiesCache(fetcher);

    const a = await cache.get();
    const b = await cache.get();
    const c = await cache.get();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(cache.isCached()).toBe(true);
  });

  it('refresh() forces a re-fetch and returns the fresh value', async () => {
    let call = 0;
    const fetcher = vi.fn(() =>
      Promise.resolve(stubCapabilities({ can_update_class: call++ === 0 })),
    );
    const cache = new CapabilitiesCache(fetcher);

    const first = await cache.get();
    const refreshed = await cache.refresh();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.can_update_class).toBe(true);
    expect(refreshed.can_update_class).toBe(false);
  });

  it('dedupes concurrent first calls into one in-flight fetch', async () => {
    const fetcher = vi.fn(() => Promise.resolve(stubCapabilities()));
    const cache = new CapabilitiesCache(fetcher);

    const [a, b] = await Promise.all([cache.get(), cache.get()]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('does NOT cache a rejected probe (the next get retries)', async () => {
    let attempt = 0;
    const fetcher = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('probe failed'))
        : Promise.resolve(stubCapabilities());
    });
    const cache = new CapabilitiesCache(fetcher);

    await expect(cache.get()).rejects.toThrow('probe failed');
    expect(cache.isCached()).toBe(false);

    const ok = await cache.get();
    expect(ok.v4).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
