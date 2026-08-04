---
id: WP-S01
title: Spike — headless atomic save + CSS priming (which prime-css approach emits front-end CSS)
layer: spike
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - spec/spikes/S01-headless-atomic-save-css-priming.md
  - spec/spikes/scripts/s01-save-atomic-tree.php
  - spec/spikes/scripts/s01-prime-approach-a-loopback.php
  - spec/spikes/scripts/s01-prime-approach-b-programmatic.php
  - spec/spikes/scripts/s01-assert-css.mjs
  - spec/spikes/fixtures/s01-atomic-hero.json
contract_refs:
  - RESEARCH.md §0 (S1 row), §2.1 (atomic CSS render hooks), §7.4 (prime-css approaches A/B)
  - spec/contracts/15-engineering-standards.md §6 (spike-gate table; S1 gates atomic-CSS writes + prime-css)
  - spec/contracts/12-error-taxonomy.md (CSS_PRIME_FAILED)
estimate: M
---

## Summary

The single most load-bearing spike. Determine whether a HEADLESS `Document::save(['elements'=>…])` of an atomic V4 tree produces visible front-end CSS, and WHICH prime-css approach (loopback render vs programmatic enqueue) actually emits the per-breakpoint atomic CSS files. The result gates ALL atomic-CSS-affecting work packages and the prime-css PHP WP. Output is a written PASS/FAIL verdict + the working approach recorded for downstream consumers.

## Interface / Contract

- **QUESTION (RESEARCH.md §0, S1):** Does `Document::save(['elements'=>…])` on an atomic tree, run from WP-CLI/REST with no editor session, produce visible front-end CSS? If not, which prime-css approach in RESEARCH.md §7.4 emits the local-style + global-class rules?
- **METHOD:** In wp-env (Elementor 4.1.1 + Pro 4.1.0, `e_atomic_elements`/`e_classes` active): (1) hand-author `e-div-block > e-heading + e-button` with ONE local style + ONE global class (fixture `s01-atomic-hero.json`); (2) save it headless via WP-CLI eval (`s01-save-atomic-tree.php`); (3) fetch the public URL and inspect the generated CSS BEFORE priming — confirm the unstyled residual; (4) run Approach A loopback (`wp_remote_get(get_wp_preview_url($id))` or public URL, `s01-prime-approach-a-loopback.php`) and Approach B programmatic (dispatch `elementor/post/render` + the enqueue flow, `s01-prime-approach-b-programmatic.php`); (5) after each, re-fetch the CSS and run `s01-assert-css.mjs` to assert the generated per-breakpoint CSS contains the local-style selector + the global-class selector + the fonts enqueue.
- **PASS CRITERION (RESEARCH.md §0):** After the working approach, the generated CSS for the public URL contains BOTH the local-style rule and the global-class rule (and fonts enqueue). Record WHICH approach worked and whether `do_action('elementor/atomic-widgets/styles/register')` fires outside a render context.
- **GATES (downstream, `15-engineering-standards.md §6`):** ALL atomic-CSS-affecting writes — the prime-css PHP WP (WP-P04), `page.build`, `page.replace_tree`, `convert.html_to_page`, and the Contract 14 §3-step-3 render assertion (WP-Q06). These remain BLOCKED until S01 PASS with a recorded approach.

## Dependencies & Inputs

- Upstream: WP-F01 (wp-env, repo scaffold). No product code dependency — spikes precede the build.
- Contracts: RESEARCH.md §0 (S1), §2.1, §7.4; `15-engineering-standards.md §6`; `12-error-taxonomy.md` `CSS_PRIME_FAILED`.
- Elementor APIs (cited): atomic CSS renders only on `elementor/frontend/after_enqueue_post_styles` + `elementor/post/render`, emitted in `enqueue_styles()` via `do_action('elementor/atomic-widgets/styles/register',…)` + `CSS_Files_Manager->get(...)` per breakpoint (`atomic-styles-manager.php:47-150`). `Post_CSS::create($id)->update()` is the V3 path and DOES NOT emit atomic CSS. Save path `Document::save()` (`core/base/document.php:795-893`).

## Detailed Requirements

1. Author the atomic hero fixture (`s01-atomic-hero.json`) using the FROZEN authoring shape (`11-authoring-contract.md`): typed envelopes, one local style mirrored into `classes`, one referenced global class. (May reuse / contribute the canonical `hero-section.composite.json` shape so WP-Q01 can adopt it.)
2. Headless save script: instantiate the documents manager, `Document::save(['elements'=>…,'settings'=>…])`, capture the post id; confirm `_elementor_data` written; assert NO atomic CSS file exists yet (the residual).
3. Approach A (loopback): server-side HTTP GET of the preview/public URL; re-check the per-breakpoint CSS files under `uploads/elementor/css/`.
4. Approach B (programmatic): dispatch the frontend render path directly (`elementor/post/render` + enqueue flow); re-check.
5. Assertion harness (`s01-assert-css.mjs`): fetch the public CSS, assert presence of the local-style selector (`.e-<localStyleId>` style) and the global-class selector, plus fonts enqueue. Emit a structured PASS/FAIL.
6. Record findings in `spec/spikes/S01-...md`: which approach worked, timing/cost, whether `styles/register` fires outside render, any caveats (caching, multisite), and the `CSS_PRIME_FAILED` conditions WP-P04 must handle.
7. Determine the residual behavior (unstyled-until-primed) and document the mitigation for WP-P04.

## Implementation Notes

- These scripts are THROWAWAY (live under `spec/spikes/scripts/`); they are NOT product files. WP-P04 (CssPrimer) implements the chosen approach in `includes/core/class-css-primer.php` (its own file) informed by this spike's recorded approach.
- Run via `wp eval-file` inside wp-env. Clear caches between approaches (`files_manager->clear_cache()`) to avoid false positives.
- If neither approach works cleanly, the verdict must still record the closest-working path and explicitly flag the residual + `CSS_PRIME_FAILED` handling for WP-P04 — the milestone (RESEARCH.md §9.1 spike week) is "S1 passing OR a working prime-css approach identified."
- Capture the exact per-breakpoint file paths the approach produces so the render-assertion suite (WP-Q06) can target them.

## Acceptance Criteria

- [ ] A reproducible headless save of the atomic hero tree exists and writes `_elementor_data`.
- [ ] The pre-prime residual (no atomic CSS) is demonstrated and documented.
- [ ] At least one prime approach (A or B) yields generated CSS containing the local-style rule + the global-class rule + fonts enqueue, asserted by `s01-assert-css.mjs`.
- [ ] `spec/spikes/S01-...md` records: PASS/FAIL verdict, the working approach, whether `styles/register` fires outside render, caveats, and the `CSS_PRIME_FAILED` conditions for WP-P04.
- [ ] The spike-gate status for S1 is updated so blocked WPs (WP-P04, page.build, replace_tree, convert.html_to_page, WP-Q06) may start.
- [ ] A reusable atomic hero fixture is left for WP-Q01/WP-Q06.

## Tests Required

- The spike IS the test; its artifact is the assertion harness output (PASS/FAIL) + the written note. No product unit tests.
- Leave `s01-assert-css.mjs` reusable so WP-Q06 can adapt it for the standing render-assertion regression.

## Parallelization Notes

- Wave 0 (spike week), HIGHEST priority alongside WP-S03 (gates the most WPs). Parallel-safe with all other spikes (each owns its own `spec/spikes/*` files). Depends only on WP-F01 (wp-env).
- BLOCKS (gate, not file-overlap): WP-P04, and every atomic-CSS write WP. Those WPs declare `depends_on: [WP-S01, WP-P04]` per the universal rule.
