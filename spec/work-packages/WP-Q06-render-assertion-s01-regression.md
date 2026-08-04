---
id: WP-Q06
title: QA — render assertion (S01 regression): save atomic tree → prime-css → assert CSS rules
layer: qa
phase: MVP
status: planned
depends_on:
  - WP-F06
  - WP-S01
  - WP-P03
  - WP-P04
  - WP-P05
files_owned:
  - plugin/elementor-ultra-mcp/tests/test-render-assertion.php
  - plugin/elementor-ultra-mcp/tests/class-css-rule-extractor.php
  - packages/server/src/test-harness/render-assertion.contract.ts
  - packages/shared/fixtures/trees/v4/valid/render-assert.hero.json
  - packages/shared/fixtures/trees/v4/valid/render-assert.global-class.json
  - packages/shared/fixtures/trees/INDEX-render.md
contract_refs:
  - spec/contracts/14-fixtures-harness.md §3 step 3 (render assertion / S1 regression — LOCKED), §9 (f)
  - RESEARCH.md §0 (S1), §7.4 (prime-css), §9.3f (render assertion)
  - spec/contracts/12-error-taxonomy.md (CSS_PRIME_FAILED)
  - spec/contracts/13-tool-catalog.md §1.2 (page.dry_run/build), prime-css route
estimate: M
---

## Summary

Implement the render-assertion regression (`14-fixtures-harness.md §3 step 3`, RESEARCH §9.3f, the S1 regression): create a throwaway draft, save an atomic V4 tree, run the prime-css step, fetch the generated per-breakpoint CSS, and assert it contains the expected local-style + global-class selector rules. This is the standing guard for M1 (`build-a-hero-renders-styled`) and proves atomic pages render STYLED. It is BLOCKED until WP-S01 PASS and depends on the prime-css WP (WP-P05) + S01 per the universal atomic-CSS rule (and on the Document_Writer WP-P04 for the save path + validator WP-P03).

## Interface / Contract

- **`test-render-assertion.php`** (PHPUnit/wp-env). For each render-assert fixture (`valid:true`, kind:`tree`): create throwaway draft → `Document::save(['elements','settings'])` (via WP-P04 Document_Writer) → run `CssPrimer` (WP-P05, the S01-confirmed approach) → fetch the generated per-breakpoint CSS → assert it contains the local-style selector rule AND the global-class selector rule declared in the fixture's `tree` → trash the draft in teardown (`§3 step 3 a–d`).
- **`class-css-rule-extractor.php`.** Reads the generated CSS file(s) under `uploads/elementor/css/` for the post + the global-class CSS, and extracts the selector rules to assert against (so the assertion is structural, not a fragile substring).
- **`render-assertion.contract.ts`** (TS mirror). Builds via `page.build`, primes via the prime-css route/tool, fetches the public-URL CSS over HTTP, and asserts the same rules — proving the full TS→PHP path renders styled (M1).
- **Render-assert fixtures** — a hero (local + global style) and a global-class-only case, with the expected selector rules declared so the extractor can assert them. NOTE on the mechanism: the `render-assert.hero.json` (local + document-bound styles) asserts the PER-DOCUMENT atomic CSS rendered via the S01/WP-P05 `Css_Primer` document-prime path; the `render-assert.global-class.json` (global-class-only) asserts the KIT-level global-class CSS rendered via `Cache_Service::flush_design_system()` (kit-CSS regen, WP-P05) — global-class CSS does NOT require the document-prime path because it lives in the kit's global CSS, not a per-post atomic file (see WP-P08 Detailed Req 2.h). The extractor locates the post's per-doc CSS for the hero case and the active kit's global-class CSS for the global-class case accordingly.

## Dependencies & Inputs

- Upstream: WP-F06 (fixture dir + PHPUnit bootstrap + the `§3` round-trip skeleton that carries the step-3 hook as `xfail`/skip until S01 — Q06 owns the STANDALONE render-assertion suite once S01 passes), WP-S01 (the confirmed prime-css approach + the working assertion harness `s01-assert-css.mjs` to adapt), WP-P03 (validator backing the save), WP-P04 (Document_Writer for the transactional save path), WP-P05 (the `CssPrimer` that emits atomic CSS — REQUIRED; this is an atomic-CSS-affecting WP so it depends on the prime-css WP WP-P05 + WP-S01 per the universal rule).
- Contracts: `14-fixtures-harness.md §3 step 3/§9 (f)`; RESEARCH §0/§7.4/§9.3f; `12-error-taxonomy.md` `CSS_PRIME_FAILED`; `13-tool-catalog.md §1.2` + prime-css route.
- Elementor APIs (cited): atomic CSS renders only on `elementor/frontend/after_enqueue_post_styles` + `elementor/atomic-widgets/styles/register` (`atomic-styles-manager.php:47-150`); `Post_CSS::create($id)->update()` does NOT emit atomic CSS; `Document::save()` (`core/base/document.php:795-893`); generated CSS under `uploads/elementor/css/`.

## Detailed Requirements

1. **Fixtures** declaring the expected local-style + global-class selector rules so the extractor can assert structurally.
2. **PHP render assertion** (`§3 step 3`): save (WP-P04) → prime (WP-P05, S01 approach) → fetch generated per-breakpoint CSS → assert local-style + global-class rules present → trash in teardown.
3. **CSS rule extractor** parses the generated CSS file(s) for the post + global-class CSS and yields the selectors/declarations to assert (robust to whitespace/minification).
4. **TS mirror** over the real REST/MCP path: `page.build` → prime-css route → fetch public-URL CSS → assert the same rules (the M1 end-to-end proof).
5. **CSS_PRIME_FAILED handling:** assert the prime step surfaces `CSS_PRIME_FAILED` cleanly when it cannot emit CSS (the residual S01 documented), rather than silently passing.
6. **S01 gate:** the suite runs only when S01 has PASSED; until then it is skipped with a clear reason (`14-fixtures-harness.md §3 step 3c`). Q06 flips it from the F06 `xfail` to the standing suite once S01 passes.
7. **Per-breakpoint coverage:** assert at least the desktop breakpoint CSS; extend to tablet/mobile breakpoints declared in the fixture.

## Implementation Notes

- Adapt the S01 throwaway `s01-assert-css.mjs` into the standing TS mirror; adapt the S01 PHP save/prime into the PHPUnit assertion (but these are Q06's OWN files — do not edit S01's `spec/spikes/scripts/*`).
- The prime step MUST use the S01-confirmed approach as implemented in WP-P05's `class-css-primer.php`; Q06 calls it, does not reimplement it (disjoint — WP-P05 owns the primer).
- Q06 ADDS its render-assert fixtures + its test files; the F06 §3-step-3 hook stays in F06's round-trip runner (Q06 owns the SEPARATE standing suite, not F06's runner). RESOLVE overlap: F06's dry_run runner carries the per-fixture step-3 skipped-until-S01; Q06 owns the dedicated render-assertion suite (PHP + TS mirror) that is the M1 regression. These are separate files (disjoint).
- Generated CSS lives under `uploads/elementor/css/`; the extractor must locate the post's file + the active kit's global-class CSS.

## Acceptance Criteria

- [ ] Render-assert fixtures declare the expected local-style + global-class selector rules.
- [ ] `test-render-assertion.php` saves → primes → fetches generated CSS → asserts both rule sets → trashes the draft.
- [ ] The CSS rule extractor robustly parses generated CSS (whitespace/minification tolerant).
- [ ] The TS mirror proves the full `page.build` → prime-css → public-URL CSS path renders styled (M1).
- [ ] `CSS_PRIME_FAILED` is surfaced cleanly when priming cannot emit CSS.
- [ ] The suite is skipped with a clear reason until S01 PASS, then runs as a standing regression.
- [ ] `composer test:php` (PHP) + `pnpm test:contract` (TS mirror) run the render assertion in the wp-env stage.

## Tests Required

- The render-assertion suite IS the test (M1 regression). Self-validate: a primed page asserts present rules; a deliberately un-primed page (skip prime) fails the assertion (proving the prime step is load-bearing).
- A unit test for the CSS rule extractor (parses a sample generated CSS file).

## Parallelization Notes

- Wave 2+, MVP phase. ATOMIC-CSS-AFFECTING — depends on WP-S01 + WP-P05 (prime-css) per the universal rule, plus WP-P04 (writer) + WP-P03 (validator). Parallel-safe with all other QA WPs (Q06 owns `trees/v4/valid/render-assert.*` + its PHP/TS test files; disjoint from Q01's other tree fixtures, Q02 `schemas/**`, Q03 `envelopes/**`, Q04 `html/**`, Q05 `roundtrip/**`).
- BLOCKED until S01 PASS (spike gate). The hero render-assert fixture should align with WP-Q01's `hero-section.composite.json` so M1 shares one shape.

## Spike-Verified Corrections (Wave 1)

- **[S01]** The M1 render-assertion regression MUST reuse the spike's frozen assets: harness `spec/spikes/scripts/s01-assert-css.mjs` and fixture `spec/spikes/fixtures/s01-atomic-hero.json` (the canonical atomic hero, frozen authoring shape). The suite saves the atomic tree → primes CSS → asserts the generated rules, exactly as the spike's 8/8-PASS harness does (reads on-disk CSS bytes, which are authoritative — HTTP-served `.css` can transiently 304/empty).
- **[S01]** Assertions MUST target the verified per-breakpoint files and selectors: `local-<postId>-frontend-desktop.css` → `.elementor .<localStyleId>{...}` (e.g. `.elementor .e-s01head1-local{font-size:48px;color:rgb(0,128,255);}`); `global-<postId>-frontend-desktop.css` → `.elementor .<globalClassId>{...}` (e.g. `.elementor .s01hero{...background-color:rgb(255,0,128);}`); and `base-desktop.css` non-empty. Self-validate the prime is load-bearing: a deliberately un-primed page MUST fail the assertion.
