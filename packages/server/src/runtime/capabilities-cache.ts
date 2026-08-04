/**
 * WP-T01 — the memoized {@link CapabilitiesCache} (Seam: F02 probe ↔ tool gating).
 *
 * Tools gate on the site's capability/experiment probe BEFORE assuming a route/feature exists
 * (01-architecture.md §7; 13-tool-catalog.md M6: `can_update_class`, `atomic`, `pro`, `experiments`).
 * The probe is one REST round-trip (`GET elementor-ultra/v1/site/capabilities`, normalized by WP-F05);
 * this cache memoizes a SINGLE in-flight/resolved result so N tools in one session share one fetch.
 * `refresh()` invalidates (e.g. after a design-system deploy that flips `classes_migrated`).
 *
 * The fetch is injected (the `WpRoutes.siteCapabilities()` bound facade) so this module stays free of
 * HTTP + testable with a stub. Concurrent `get()` calls before the first resolves share the same
 * promise (no thundering herd); a rejected probe is NOT cached (next `get()` retries).
 */

import type { Capabilities } from '@elementor-ultra/shared';

/** The single fetch the cache memoizes — the normalized capability probe (`WpRoutes.siteCapabilities`). */
export type CapabilitiesFetcher = () => Promise<Capabilities>;

/**
 * Memoizes one {@link Capabilities} probe per server session. `get()` returns the cached value (or the
 * in-flight promise) after the first call; `refresh()` forces a re-fetch. A failed probe is not cached.
 */
export class CapabilitiesCache {
  private readonly fetcher: CapabilitiesFetcher;
  /** The resolved value once the probe succeeds (cleared by {@link refresh}). */
  private resolved: Capabilities | undefined;
  /** The in-flight probe promise (dedupes concurrent first calls; cleared on settle). */
  private inflight: Promise<Capabilities> | undefined;

  /**
   * @param fetcher The single capability fetch (typically `ctx.wp.siteCapabilities`).
   */
  constructor(fetcher: CapabilitiesFetcher) {
    this.fetcher = fetcher;
  }

  /**
   * Return the memoized capabilities, fetching once on the first call. Concurrent first calls share the
   * one in-flight promise; a rejection is propagated and NOT cached (the next call retries).
   */
  async get(): Promise<Capabilities> {
    if (this.resolved !== undefined) {
      return this.resolved;
    }
    if (this.inflight === undefined) {
      this.inflight = this.fetcher()
        .then((caps) => {
          this.resolved = caps;
          return caps;
        })
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  /**
   * Invalidate the cache so the next {@link get} re-fetches. Use after a mutation that changes the
   * probe (e.g. a migration grant, a deploy). If `await`ed, returns the freshly fetched value.
   */
  async refresh(): Promise<Capabilities> {
    this.resolved = undefined;
    this.inflight = undefined;
    return this.get();
  }

  /** Whether a successful probe is currently cached (no fetch needed for the next `get()`). */
  isCached(): boolean {
    return this.resolved !== undefined;
  }
}
