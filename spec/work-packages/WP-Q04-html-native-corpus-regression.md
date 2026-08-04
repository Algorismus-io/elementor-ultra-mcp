---
id: WP-Q04
title: QA — HTML→native corpus regression (S3-anchored coverage + a11y + stripped-text + dry_run)
layer: qa
phase: v1
status: planned
depends_on:
  - WP-F06
  - WP-S03
  - WP-P03
  - WP-H12
files_owned:
  - packages/server/src/test-harness/html-corpus.contract.ts
contract_refs:
  - spec/contracts/14-fixtures-harness.md §6 (HTML corpus regression — LOCKED), §1 (html layout)
  - spec/contracts/13-tool-catalog.md §1.9 (convert.html_to_tree, coverage report)
  - RESEARCH.md §6 (HTML pipeline), §6.5 (a11y), §6.6 (stripped text), §6.8 (coverage gate)
  - SUPPLEMENT.md §C.4 (honest coverage band), §B.1 (html-v3 inline-only allowlist)
estimate: L
---

## Summary

Build the HTML→native corpus regression RUNNER (`14-fixtures-harness.md §6`). The corpus FIXTURES (the ≥5 real marketing sections under `html/sections/**`, their `expected.coverage.json`/`expected.a11y.json`, and `corpus.manifest.json` with the S3-anchored thresholds) are OWNED by WP-H12 (the HTML pipeline corpus WP); Q04 owns ONLY `html-corpus.contract.ts`, the runner that runs `convert.html_to_tree` over those fixtures, asserts coverage within the per-section tolerance, asserts a11y + stripped-text match, and round-trips the produced tree through PHP `dry_run` (must be `valid:true` — the converter never emits a tree PHP rejects). Coverage thresholds come from the S3 spike (via WP-H12's manifest), NEVER a hardcoded 85%.

## Interface / Contract

- **`html-corpus.contract.ts`.** For each section in WP-H12's `html/sections/**` (`§6`): run `convert.html_to_tree` (Contract 13 §1.9); assert `report.coverage` within tolerance of that section's `expected.coverage.json`; assert `report.a11y` matches `expected.a11y.json`; assert `report.stripped_text` lists the expected stripped block tags (the html-v3 inline-only allowlist `[b,i,em,u,a,del,span,strong,sup,sub,s]`); round-trip the produced `elements` through PHP `dry_run` and assert `valid:true`. The runner reads tolerances from WP-H12's `corpus.manifest.json` (consumed, not owned).
- **Consumed (WP-H12-owned, NOT owned by Q04):** `packages/shared/fixtures/html/sections/**/{input.html,input.css,expected.coverage.json,expected.a11y.json}` + `packages/shared/fixtures/html/corpus.manifest.json`. These are the regression baseline for the S3 number; lowering a threshold requires an explicit PR diff in WP-H12's files.

## Dependencies & Inputs

- Upstream: WP-H12 (OWNS the `html/sections/**` fixtures + `corpus.manifest.json` that this runner asserts against — Q04 consumes them, never edits them), WP-F06 (fixture dir + loader; Q04 ADDS only the corpus runner, never edits F06's runner), WP-S03 (the coverage NUMBERS that WP-H12 encodes in the manifest), WP-P03 (the `dry_run` validator the produced tree round-trips through). The runner calls `convert.html_to_tree`, owned by the HTML pipeline vertical (WP-H11); feature-detect/skip until that exists, then enable.
- Contracts: `14-fixtures-harness.md §6/§1`; `13-tool-catalog.md §1.9`; RESEARCH §6/§6.5/§6.6/§6.8; SUPPLEMENT §C.4/§B.1.
- Elementor APIs (cited): `Style_Schema` enum limits drive the fallback rates the coverage report quantifies (`style-schema.php:135-426`); html-v3 stripping (`html-v3-prop-type.php:91`).

## Detailed Requirements

1. **Consume WP-H12's sections** (`html/sections/<n>/` with `input.html`+`input.css`+`expected.coverage.json`+`expected.a11y.json`) — Q04 does NOT author these; it asserts against them. (WP-H12 derives the section set + numbers from the WP-S03 seed.)
2. **Read thresholds from WP-H12's `corpus.manifest.json`** (per-section thresholds + tolerance bands derived from S3, NEVER hardcoded 85%, `14-fixtures-harness.md §6 step 2`) — consumed, not owned.
3. **Runner assertions** (`§6 steps 1–5`): coverage within tolerance; a11y match; stripped-text match (the inline-only allowlist); produced tree passes `dry_run`.
4. **Honest reporting:** the coverage report's per-property fallback ladder (native → local style → global class → custom_css → dropped) is asserted, not a single global number (M3/M7, `00-product-overview.md §6`).
5. **Lowering a threshold requires a PR diff** — the manifest is the regression gate; the test fails if coverage regresses below tolerance.
6. **a11y expectations** per RESEARCH §6.5 (heading hierarchy, empty interactive names, missing alt).
7. **Convert never emits an invalid tree** — the `dry_run valid:true` assertion is the hard gate (`§6 step 5`).

## Implementation Notes

- The corpus sections + coverage numbers + manifest are WP-H12's; Q04 reads them and asserts. Do not author or edit those files (disjoint — WP-H12 owns `html/**`, Q04 owns `html-corpus.contract.ts`).
- Q04 owns ONLY `html-corpus.contract.ts`; it never edits F06's runner, WP-H12's fixtures, or other QA fixtures.
- The runner needs `convert.html_to_tree` (WP-H11) live; until then, feature-detect/skip with a clear reason so the runner can land in v1 and the assertions light up when the converter ships.
- If the runner needs a threshold change, that change is a WP-H12 manifest edit (its file), surfaced as a PR diff there.

## Acceptance Criteria

- [ ] The runner asserts, per WP-H12 section, coverage within the manifest tolerance, a11y match, stripped-text match (inline-only allowlist), and `dry_run valid:true` for the produced tree.
- [ ] The runner reads thresholds from WP-H12's `corpus.manifest.json` (S3-derived); it never hardcodes 85%.
- [ ] A coverage regression below tolerance fails the test; a threshold change shows as a PR diff in WP-H12's manifest.
- [ ] Free-only/atomic-off installs handled via `requires` skips.
- [ ] `pnpm test:contract` runs the corpus regression in the wp-env stage.
- [ ] Q04 creates NO files under `html/**` (those are WP-H12's); it owns only `html-corpus.contract.ts`.

## Tests Required

- The corpus runner IS the regression test. Self-validate: a section that converts at/above its threshold passes; a deliberately degraded converter output (or a lowered manifest) fails with a readable delta.
- A check that produced trees always pass `dry_run` (the hard gate).

## Parallelization Notes

- Wave 2+, v1 phase (the flagship convert vertical). Parallel-safe with all other QA WPs (Q04 owns ONLY `html-corpus.contract.ts`; disjoint from Q01 `trees/**`, Q02 `schemas/**`, Q03 `envelopes/**`, Q05 `roundtrip/**`, and from WP-H12's `html/**` fixtures). Depends on WP-H12 (fixtures+manifest) + WP-F06 + WP-S03 + WP-P03.
- WP-H12 (HTML corpus fixtures) and WP-H11 (the converter) are the HTML vertical; Q04 is the regression assertion over their output. The `convert.fidelity_check` visual-diff gate (ULTRA, M7) is owned by the HTML vertical (WP-H10) and builds on the same corpus + the S03 measure script.
