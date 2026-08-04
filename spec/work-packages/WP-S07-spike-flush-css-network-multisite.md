---
id: WP-S07
title: Spike — wp elementor flush-css --network reliability on current multisite
layer: spike
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - spec/spikes/S07-flush-css-network-multisite.md
  - spec/spikes/scripts/s07-multisite-flush.sh
  - spec/spikes/scripts/s07-assert-cache-cleared.mjs
contract_refs:
  - RESEARCH.md §0 (S7 secondary), §7.2 (full flush, line ~649), §8 (multisite fan-out)
  - spec/contracts/15-engineering-standards.md §6 (S7 gates multisite cache-flush polish)
  - spec/contracts/10-rest-api.md (POST /cache/regen; DELETE /cache)
estimate: S
---

## Summary

Verify whether `wp elementor flush-css --network` reliably clears + regenerates CSS across all sites on a current WordPress multisite, so the design-system cache-flush + multisite fan-out can rely on it. Gates the multisite fan-out polish for design-system writes (which auto-flush cache).

## Interface / Contract

- **QUESTION (RESEARCH.md §0, S7):** Is `wp elementor flush-css --network` reliable on current multisite — does it clear `uploads/elementor/css/*`, `_elementor_css`, `_elementor_element_cache`, assets meta across ALL subsites, and (with `--regenerate`) regenerate?
- **METHOD:** Boot a multisite wp-env (≥2 subsites with Elementor pages + global classes). Dirty the CSS cache on each. Run `wp elementor flush-css --network` (and `--regenerate`) via `s07-multisite-flush.sh`. Assert per-subsite that the cache was cleared/regenerated (`s07-assert-cache-cleared.mjs`).
- **PASS CRITERION:** `--network` flush demonstrably clears (and `--regenerate` regenerates) on all subsites, OR a reliable per-site fallback is identified.
- **GATES:** Multisite cache-flush behavior for design-system writes; the multisite fan-out polish (RESEARCH.md §8). Single-site `POST /cache/regen` / `DELETE /cache` are unaffected.

## Dependencies & Inputs

- Upstream: WP-F01 (wp-env). Multisite requires a multisite-configured wp-env (documented in the spike note). No product code dependency.
- Contracts: RESEARCH.md §0 (S7), §7.2 (line ~649 — full flush via `files_manager->clear_cache()` deletes `uploads/elementor/css/*`, `_elementor_css`, `_elementor_element_cache`, assets meta; `manager.php:107-117`; WP-CLI `wp elementor flush-css [--regenerate] [--network]`), §8 (multisite fan-out); `15-engineering-standards.md §6`; `10-rest-api.md` (`POST /cache/regen`, `DELETE /cache`).
- Elementor APIs (cited): `files_manager->clear_cache()` (`manager.php:107-117`); the `wp elementor flush-css` WP-CLI command + its `--network`/`--regenerate` flags; design writes auto-flush cache (`10-rest-api.md`).

## Detailed Requirements

1. Configure a multisite wp-env with ≥2 subsites, each with an Elementor page + ≥1 global class generating CSS.
2. Dirty the CSS cache on each subsite (e.g. touch a global class) and confirm stale CSS exists.
3. Run `wp elementor flush-css --network` and `--network --regenerate`; capture per-subsite outcomes.
4. Assert per-subsite cache cleared (and regenerated with `--regenerate`).
5. Record in `S07-...md`: reliability verdict per subsite, any flakiness, a per-site fallback recommendation if `--network` is unreliable, and how the design-system controller (which auto-flushes) should fan out on multisite.

## Implementation Notes

- Throwaway scripts; the cache-service / design controller (WP-P##) implement the chosen flush strategy in their own files informed by this note.
- If `--network` is unreliable, the recommended fallback is iterating subsites with per-site `wp elementor flush-css --regenerate` (record the exact approach).
- Single-site flush is already covered by `POST /cache/regen` / `DELETE /cache` (reusing `DELETE elementor/v1/cache`, `manage_options`) — this spike is ONLY about the multisite `--network` reliability.

## Acceptance Criteria

- [ ] A multisite wp-env with ≥2 Elementor subsites is reproducible.
- [ ] `wp elementor flush-css --network` (and `--regenerate`) outcomes are captured per subsite.
- [ ] Per-subsite cache-cleared/regenerated assertion runs.
- [ ] `S07-...md` records the reliability verdict, flakiness, a per-site fallback if needed, and the multisite fan-out recommendation for the design controller.
- [ ] Spike-gate status for S7 updated so the multisite fan-out polish is unblocked.

## Tests Required

- The spike IS the probe (verdict + note). The chosen flush strategy is implemented + tested by the cache-service / design controller WP.

## Parallelization Notes

- Wave 0 (spike week), LOWEST priority of the spikes (ULTRA-phase multisite polish). Parallel-safe with all other spikes (disjoint `spec/spikes/*` files). Depends only on WP-F01.
- GATES the multisite fan-out polish (gate dependency). Single-site cache flush is unaffected and proceeds without S07.
