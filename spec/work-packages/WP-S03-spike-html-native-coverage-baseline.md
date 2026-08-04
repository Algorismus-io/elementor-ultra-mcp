---
id: WP-S03
title: Spike — HTML→native coverage baseline on real marketing sections (set the S3 number)
layer: spike
phase: foundation
status: planned
depends_on:
  - WP-F01
  - WP-F03
files_owned:
  - spec/spikes/S03-html-native-coverage-baseline.md
  - spec/spikes/scripts/s03-convert-section.mjs
  - spec/spikes/scripts/s03-measure-coverage.mjs
  - spec/spikes/fixtures/sections/01-pricing-table/input.html
  - spec/spikes/fixtures/sections/01-pricing-table/input.css
  - spec/spikes/fixtures/sections/02-hero/input.html
  - spec/spikes/fixtures/sections/02-hero/input.css
  - spec/spikes/fixtures/sections/03-feature-grid/input.html
  - spec/spikes/fixtures/sections/03-feature-grid/input.css
  - spec/spikes/fixtures/sections/04-testimonial/input.html
  - spec/spikes/fixtures/sections/04-testimonial/input.css
  - spec/spikes/fixtures/sections/05-cta-banner/input.html
  - spec/spikes/fixtures/sections/05-cta-banner/input.css
contract_refs:
  - RESEARCH.md §0 (S3 row), §6 (HTML pipeline), §6.8 (coverage gate), line ~609 (Style_Schema enum limits)
  - SUPPLEMENT.md §C.4 (honest ~60–80% native coverage band; recommended node stack)
  - spec/contracts/14-fixtures-harness.md §6 (HTML corpus regression; corpus.manifest.json thresholds)
  - spec/contracts/15-engineering-standards.md §6 (S3 gates convert.* coverage thresholds)
estimate: L
---

## Summary

Measure the ACTUAL native-prop coverage of the parse→classify→map→style-extract→`dry_run` loop on ≥5 REAL marketing sections, against the `Style_Schema`. The result REPLACES the unvalidated "85%" with a spike-derived number that anchors `corpus.manifest.json` and every `convert.*` coverage gate. No `convert.*` WP may lock a coverage threshold before S3.

## Interface / Contract

- **QUESTION (RESEARCH.md §0, S3):** What native-prop coverage does the convert loop achieve on real marketing sections? What is the per-property fallback rate given `Style_Schema` enum limits?
- **METHOD:** Assemble ≥5 real-world sections (pricing table, hero, feature grid, testimonial, CTA banner) as `input.html`+`input.css`. Run a prototype convert (`s03-convert-section.mjs` — render-then-extract via headless Playwright per SUPPLEMENT §C.3/C.4, classify, map to typed envelopes, route unmappable declarations to fallback). Measure with `s03-measure-coverage.mjs`: `% declarations mapped natively / % to local-style class / % to global class / % custom_css fallback / % dropped`, plus per-property fallback rates for the known-hard properties.
- **PASS CRITERION (RESEARCH.md §0):** Produce an honest, reproducible coverage number per section (the band is ~60–80% native per SUPPLEMENT §C.4 — NOT a hardcoded 85%). The number is the deliverable.
- **GATES:** Establishes the coverage numbers in `corpus.manifest.json`; `convert.*` coverage GATES (`14-fixtures-harness.md §6`). The HTML pipeline vertical (WP-H##) and WP-Q04 (HTML corpus regression) consume the S3 numbers.

## Dependencies & Inputs

- Upstream: WP-F01 (scaffold), WP-F03 (authoring types + JSON Schemas the prototype emits + the `dry_run` shape it targets). The prototype routes through PHP `dry_run` if available; if WP-P03 not yet built, the spike may approximate validity with WP-F03's pre-filter + a manual `Style_Schema` enum check and FLAG the residual.
- Contracts: RESEARCH.md §0 (S3), §6/§6.8, the `Style_Schema` enum-limit notes (line ~609); SUPPLEMENT §C.4 (band + node stack); `14-fixtures-harness.md §6`; `15-engineering-standards.md §6`.
- Elementor APIs (cited): `Style_Schema` enum limits (`style-schema.php:135-426`) — `justify-content`/`align-items` fixed enums, `font-weight` enum, `text-decoration` single string, no `display:table/list-item`, `grid` raw-string subset, `transform`/`transition`/`filter`/`background` are typed prop objects. These are the fallback drivers. The client-side `container-converter` is NOT prior art (RESEARCH.md line ~539) — do not cite it.

## Detailed Requirements

1. Curate ≥5 REAL marketing sections (anonymized/representative) as `input.html`+`input.css` under `spec/spikes/fixtures/sections/`. These become the seed for the WP-Q04 corpus.
2. Prototype the convert loop (throwaway): render-then-extract via Playwright (SUPPLEMENT §C.3/C.4) — NOT static parse; classify each node to an atomic widget/container; map computed declarations to typed envelopes; route unmappable declarations down the fallback ladder (native → local style → global class → custom_css → drop).
3. Measure coverage per section: native %, class %, custom_css %, dropped %; AND per-property fallback rates for the hard properties (grid, transform/transition/filter/background, text-decoration, font-weight numeric, display table/list-item).
4. Route the produced tree through `dry_run` (or approximate + flag) and confirm it would be `valid:true` (the converter must never emit a tree PHP rejects, `14-fixtures-harness.md §6 step 5`).
5. Record in `S03-...md`: the per-section coverage numbers, the recommended `corpus.manifest.json` thresholds + tolerance bands, the per-property fallback findings, and the recommended `convert.*` auto-commit threshold (RESEARCH.md §12 OQ#3).
6. Decide the honest coverage band (anchored, ~60–80%) and the auto-commit gate threshold.

## Implementation Notes

- Throwaway scripts; the real pipeline (WP-H##) reimplements in `packages/server/src/convert/*`. The spike's value is the NUMBER + the fallback findings + the seed corpus.
- Use the SUPPLEMENT §C.3 recommended Node stack (Playwright for render-then-extract; CSS parser). Reuse the Playwright instance (it will back the visual-diff gate later, `15-engineering-standards.md §4.6`).
- Keep the section fixtures realistic (cards, flex/grid, gradients, transitions) so the fallback rate is honest, not cherry-picked.
- The seed sections should be MOVABLE into `packages/shared/fixtures/html/sections/` by WP-Q04 with their `expected.coverage.json`/`expected.a11y.json` derived from this spike's measurements.

## Acceptance Criteria

- [ ] ≥5 real marketing sections exist as `input.html`+`input.css`.
- [ ] The prototype produces a reproducible per-section coverage breakdown (native/class/custom_css/dropped) + per-property fallback rates.
- [ ] Produced trees would pass `dry_run` (or are flagged with the residual when PHP validator is unavailable).
- [ ] `S03-...md` records the S3 coverage numbers, recommended `corpus.manifest.json` thresholds + tolerances, per-property fallback findings, and the recommended auto-commit threshold.
- [ ] Spike-gate status for S3 updated so `convert.*` WPs can lock thresholds.
- [ ] The section fixtures are left reusable for WP-Q04's HTML corpus.

## Tests Required

- The spike IS the measurement; its artifact is the coverage report + written note. No product unit tests.
- Leave `s03-measure-coverage.mjs` reusable as the basis for WP-Q04's corpus assertion + the `convert.fidelity_check` scoring.

## Parallelization Notes

- Wave 0 (spike week), HIGH priority (with S01 — gates the flagship convert vertical). Parallel-safe with all other spikes (disjoint `spec/spikes/*` files). Depends on WP-F01 + WP-F03.
- GATES the HTML pipeline vertical (WP-H##) coverage thresholds + WP-Q04 (gate dependency, not file overlap). The convert WPs must NOT hardcode 85% — they read the S3 number from `corpus.manifest.json`.
