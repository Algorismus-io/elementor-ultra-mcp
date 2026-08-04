---
id: WP-S04
title: Spike — Document::save_settings() merge-vs-replace semantics (page.update_settings)
layer: spike
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - spec/spikes/S04-save-settings-merge-semantics.md
  - spec/spikes/scripts/s04-probe-merge.php
contract_refs:
  - RESEARCH.md §0 (S4 secondary), §5.2 (update_settings merge note line ~412), §10 OQ#4
  - spec/contracts/15-engineering-standards.md §6 (S4 gates page.update_settings merge)
  - spec/contracts/10-rest-api.md (PUT /documents/{id}/settings)
estimate: S
---

## Summary

Determine whether Elementor's `Document::save_settings()` deep-merges or replaces page settings, so the companion plugin's `PUT /documents/{id}/settings` (and the `page.update_settings` tool) knows whether it must GET-merge-PUT. Until PASS, the route MUST do GET-merge-PUT so a partial update never wipes unrelated keys.

## Interface / Contract

- **QUESTION (RESEARCH.md §0, S4):** Does `save(['settings'=>…])` / `save_settings()` deep-merge the patch into existing settings or REPLACE them wholesale? The built-in `update-page-settings` ability comments "merged" but it is unverified (RESEARCH.md §5.2 note).
- **METHOD:** In wp-env, set several page settings on a doc; call `save(['settings'=>{onlyOneKey}])` via `s04-probe-merge.php`; re-read full settings; assert whether the other keys survived (merge) or were wiped (replace).
- **PASS CRITERION:** A definitive merge-vs-replace verdict, with the exact behavior recorded.
- **GATES:** `page.update_settings` behavior. Until PASS, the PHP route implements GET-merge-PUT (read full settings, apply patch, write) per RESEARCH.md §5.2; a regression test (update one key, assert others survive) is mandatory regardless of the verdict.

## Dependencies & Inputs

- Upstream: WP-F01 (wp-env). No product code dependency.
- Contracts: RESEARCH.md §0 (S4), §5.2 (line ~412), §10 OQ#4; `15-engineering-standards.md §6`; `10-rest-api.md` (`PUT /documents/{id}/settings`).
- Elementor APIs (cited): `Document::save_settings()` / `save(['settings'=>…])` (`core/base/document.php` around the save path `:795-893`); the built-in ability `update-page-settings` for comparison.

## Detailed Requirements

1. Seed a doc with ≥3 page settings of different types.
2. Save a 1-key patch via `save(['settings'=>…])`; re-read; record which keys survived.
3. Record the verdict (MERGE or REPLACE) + the `path:line` of the behavior; note any nuance (nested keys, repeaters, kit-inherited defaults).
4. Recommend the route implementation: if REPLACE (or uncertain), mandate GET-merge-PUT in the PHP `PUT /documents/{id}/settings` controller; if confirmed MERGE, GET-merge-PUT may still be kept for safety but the verdict is recorded.
5. Specify the mandatory regression test for the route WP (update one key, assert others survive).

## Implementation Notes

- Throwaway script; the route WP (Documents controller, WP-P##) implements GET-merge-PUT in its own file informed by this verdict.
- Test nested/repeater settings too — a shallow merge could still wipe nested keys.

## Acceptance Criteria

- [ ] A reproducible probe demonstrates merge-vs-replace for top-level AND nested settings.
- [ ] `S04-...md` records the verdict, `path:line`, nuances, and the GET-merge-PUT recommendation + mandatory regression test.
- [ ] Spike-gate status for S4 updated so `page.update_settings` can be finalized.

## Tests Required

- The spike IS the probe (verdict + note). The mandatory route regression test is specified here and implemented by the Documents controller WP.

## Parallelization Notes

- Wave 0 (spike week), parallel-safe with all other spikes (disjoint `spec/spikes/*` files). Depends only on WP-F01.
- GATES `page.update_settings` finalization (gate dependency). The route can be built defensively (GET-merge-PUT) without waiting, so this is a low-risk gate.
