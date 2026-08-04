---
id: WP-H12
title: HTML-to-native golden corpus + smoke fixtures (S3-anchored regression data)
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-F06
  - WP-S03
files_owned:
  - packages/shared/fixtures/html/sections/01-hero/input.html
  - packages/shared/fixtures/html/sections/01-hero/input.css
  - packages/shared/fixtures/html/sections/01-hero/expected.coverage.json
  - packages/shared/fixtures/html/sections/01-hero/expected.a11y.json
  - packages/shared/fixtures/html/sections/02-pricing-table/input.html
  - packages/shared/fixtures/html/sections/02-pricing-table/input.css
  - packages/shared/fixtures/html/sections/02-pricing-table/expected.coverage.json
  - packages/shared/fixtures/html/sections/02-pricing-table/expected.a11y.json
  - packages/shared/fixtures/html/sections/03-feature-grid/input.html
  - packages/shared/fixtures/html/sections/03-feature-grid/input.css
  - packages/shared/fixtures/html/sections/03-feature-grid/expected.coverage.json
  - packages/shared/fixtures/html/sections/03-feature-grid/expected.a11y.json
  - packages/shared/fixtures/html/sections/04-cta-banner/input.html
  - packages/shared/fixtures/html/sections/04-cta-banner/input.css
  - packages/shared/fixtures/html/sections/04-cta-banner/expected.coverage.json
  - packages/shared/fixtures/html/sections/04-cta-banner/expected.a11y.json
  - packages/shared/fixtures/html/sections/05-rich-text-card/input.html
  - packages/shared/fixtures/html/sections/05-rich-text-card/input.css
  - packages/shared/fixtures/html/sections/05-rich-text-card/expected.coverage.json
  - packages/shared/fixtures/html/sections/05-rich-text-card/expected.a11y.json
  - packages/shared/fixtures/html/corpus.manifest.json
  - packages/shared/fixtures/envelopes/smoke.elementor.convert.html_to_tree.json
  - packages/shared/fixtures/envelopes/smoke.elementor.convert.html_to_page.json
  - packages/shared/fixtures/envelopes/smoke.elementor.convert.fidelity_check.json
contract_refs:
  - spec/contracts/14-fixtures-harness.md#1-fixture-directory-layout-locked
  - spec/contracts/14-fixtures-harness.md#6-html-native-corpus-regression-locked-researchmd-93d-68
  - spec/contracts/14-fixtures-harness.md#8-mcp-inspector-smoke-suite-locked-researchmd-93c
  - spec/contracts/13-tool-catalog.md#19-html-native-conversion-flagship
estimate: M
---

## Summary

The HTML pipeline's regression DATA: at least five real marketing sections (hero, pricing table,
feature grid, CTA banner, rich-text card) as `input.html` + `input.css`, each with an
`expected.coverage.json` and `expected.a11y.json`, plus the `corpus.manifest.json` that maps every
section to its S3-anchored coverage thresholds + tolerance bands, plus the three convert tool smoke
payloads. These files are the regression baseline the WP-H10 corpus suite and the Inspector smoke suite
read (Contract 14 §6/§8). Per Contract 14 §11, this WP ADDS new files under WP-F06's fixture tree (it
never edits the harness runner). Thresholds are anchored to the S3 spike result — NEVER a hardcoded
85%.

## Interface / Contract

- Each section directory follows Contract 14 §1 EXACTLY: `input.html`, `input.css`,
  `expected.coverage.json`, `expected.a11y.json` under
  `packages/shared/fixtures/html/sections/<NN>-<slug>/`.
- `expected.coverage.json` = the `CoverageReport.coverage` shape (diff.schema.json):
  `{ pct_native, pct_local_or_global_class, pct_custom_css, pct_dropped }` — the EXPECTED (S3-derived)
  values for that section.
- `expected.a11y.json` = an array of expected `CoverageReport.a11y[]` items
  (`{element_id?, rule, severity, message}`); element ids are compared structurally (not by literal
  minted id) since ids are minted at runtime — match on `rule`+`severity`+a stable locator.
- `corpus.manifest.json` = `{ "$version":1, "sections":[ { "id":"01-hero", "path":"sections/01-hero",
  "thresholds":{ "min_pct_native":<n>, "min_pct_covered":<n>, "max_pct_dropped":<n> },
  "tolerance":{ "pct_native":<band>, "pct_covered":<band> }, "requires":{ "experiments":[...],
  "pro":false, "min_elementor":"4.1.1" }, "default_coverage_gate":<n> }, ... ] }` — the S3-anchored
  numbers the WP-H10 gate + corpus regression read. `default_coverage_gate` is the value
  `convert.html_to_page` uses when the caller omits `coverage_gate` (13-tool-catalog §1.9).
- Smoke payloads follow Contract 14 §8 naming `smoke.<full.tool.name>.json` and carry the MINIMAL valid
  input per tool (13-tool-catalog §1.9 input schemas).

## Dependencies & Inputs

- **WP-F06 (golden-fixtures harness)** — owns `packages/shared/fixtures/` + the runner +
  `pnpm fixtures:validate`. This WP adds NEW files only (Contract 14 §11 disjoint-files guarantee); it
  must NOT edit the harness runner or any other WP's fixtures.
- **WP-S03 (HTML coverage baseline spike)** — provides the actual measured coverage numbers per section
  type; this WP encodes those numbers into `corpus.manifest.json` + `expected.coverage.json`. Until S3
  produces numbers, the manifest carries the S3 placeholders flagged as provisional (15-eng-standards
  §6: no convert WP locks a threshold before S3).
- **WP-F03** — the `CoverageReport`/`ElementNode` shapes the expected JSON conforms to.
- Contract sections: 14-fixtures-harness §1 (directory layout/naming), §2 (envelope rules — smoke
  payloads minimal + capability-gated), §6 (corpus regression: coverage tolerance, a11y match, stripped
  match, dry_run-valid), §8 (Inspector smoke), §11 (disjoint files); 13-tool-catalog §1.9 (convert tool
  input schemas for smoke payloads). RESEARCH.md §6.6/§6.8 (honest, per-section coverage; realistic
  60-80% native, <5-10% custom_css/dropped tail), §9.3d (HTML corpus). SUPPLEMENT §C.4 (realistic
  fidelity expectation — upper-bound ~84% native on CLEAN HTML; real marketing 60-80%).

## Detailed Requirements

1. **Five+ realistic sections (Contract 14 §1, RESEARCH.md §9.3d).** Provide REAL marketing-section
   HTML+CSS (not toy snippets) exercising the pipeline's hard cases so the corpus is a meaningful
   regression. Recommended coverage of features across the five sections:
   - `01-hero`: flex layout, an `<h1>` + `<p>` + CTA `<a class=button>`, a background image, a hover
     state on the button (exercises parse hover-forcing, image sideload, button mapping, a11y h1).
   - `02-pricing-table`: a repeated card pattern (exercises HOIST -> shared global class), a 2-3 column
     layout (flex vs grid decision), price text with inline markup (`<strong>`/`<span>`), a `<ul>`
     feature list (NO atomic list -> structural fallback).
   - `03-feature-grid`: a true 2D grid (exercises grid limits -> fallback ladder), repeated svg/icon +
     heading + text cells, per-breakpoint column changes (exercises responsive variants).
   - `04-cta-banner`: a gradient/complex background (exercises typed-object decomposition vs custom_css
     fallback), centered text-align (logical conversion), an absolutely-positioned badge (exercises
     position:absolute inference).
   - `05-rich-text-card`: a `<p>` containing block children + non-allowlisted inline tags (`<mark>`,
     `<code>`, `<br>`, nested `<div>`) to exercise NORMALIZE block-promotion + the `html-v3` stripped-
     text report.
2. **Expected coverage (S3-anchored).** Each `expected.coverage.json` carries the section's measured
   native/class/custom_css/dropped percentages from S3 (or provisional S3 placeholders). NEVER use a
   hardcoded 85% (15-eng-standards §4.6, §6). Reflect the honest 60-80% native expectation for real
   marketing input (RESEARCH.md §6.6, SUPPLEMENT §C.4) with a small custom_css/dropped tail.
3. **Expected a11y.** Each `expected.a11y.json` lists the a11y findings the converter SHOULD report for
   that section (e.g. `01-hero` should be clean if it has one h1 + alt text; a section deliberately
   missing alt or with a skipped heading level encodes the expected warning). Make at least one section
   exercise each a11y rule (heading hierarchy, empty interactive name, missing alt).
4. **Stripped-text expectations.** `05-rich-text-card` must encode the expected stripped tags (`mark`,
   `code`, `br`, etc.) so the WP-H10 corpus suite's stripped-text assertion (Contract 14 §6 step 4) has
   a target. Put the expected stripped tags either in `expected.coverage.json` (under a
   `stripped_text` key matching the report) or a sibling `expected.stripped.json` — choose the shape the
   WP-H10 suite reads and document it; align with `CoverageReport.stripped_text` (diff.schema.json).
5. **`corpus.manifest.json` (Contract 14 §6).** Map every section to its path, thresholds, tolerance
   bands, `requires` (experiments/pro/min_elementor for capability-gated skipping, Contract 14 §2), and
   `default_coverage_gate`. The thresholds are the regression baseline; lowering one requires an
   explicit PR diff (Contract 14 §6). Keep numbers consistent with each section's
   `expected.coverage.json`.
6. **Smoke payloads (Contract 14 §8).** Minimal valid inputs:
   - `smoke.elementor.convert.html_to_tree.json`: `{ "html":"<section><h1>Hi</h1><p>Body</p></section>" }`
     (read-only, runs unconditionally).
   - `smoke.elementor.convert.html_to_page.json`: `{ "html":"...", "title":"Smoke", "commit":false }`
     (commit:false so it never persists; the smoke suite runs it against a disposable draft only if it
     would write — here it does not). Capability-gated `requires` if it needs atomic.
   - `smoke.elementor.convert.fidelity_check.json`: minimal `{ "post_id":<placeholder>, "source_html":
     "<section><h1>Hi</h1></section>" }` — the smoke runner substitutes the disposable draft id
     (Contract 14 §8 step 3). Document the placeholder convention.
7. **All files validate.** Every fixture must pass `pnpm fixtures:validate` (Contract 14 §10): the
   expected-coverage shape against `CoverageReport.coverage`, the manifest against its own shape, the
   smoke payloads against the tool input schemas. Produced trees from these inputs must round-trip
   `valid:true` through PHP dry_run (asserted by WP-H10's suite, Contract 14 §6 step 5) — author the
   HTML so a faithful conversion yields a dry_run-valid tree (don't include content that forces an
   invalid tree).

## Implementation Notes

- These are DATA files (HTML/CSS/JSON), no executable code — but they are load-bearing: the WP-H10
  corpus suite and the Inspector smoke suite assert against them. Keep them realistic but deterministic
  (no remote assets that could 404 at test time — inline CSS in `input.css`, use small local-ish image
  refs the sideload can resolve or that ASSEMBLE degrades gracefully on).
- The S3 numbers are the source of truth for thresholds; if S3 has not run when this WP is built, encode
  conservative provisional numbers and mark them `"provisional": true` in the manifest so the gate is
  not falsely tightened (15-eng-standards §6). The corpus suite uses tolerance bands so provisional
  numbers don't cause flapping.
- element ids in `expected.a11y.json` cannot be literal (minted at runtime) — match findings by
  `rule`+`severity`+a stable structural locator (e.g. the source path or a CSS-ish selector), per the
  Contract 14 §7 "compare structurally, not by literal id" principle.
- Disjoint-files invariant (Contract 14 §11): this WP owns ONLY the listed files. Other fixture-adding
  WPs (e.g. per-widget tree fixtures) own different paths by construction. Do NOT add anything under
  `fixtures/trees/`, `fixtures/schemas/`, or `fixtures/roundtrip/` (those are other WPs' slices).

## Acceptance Criteria

- [ ] At least five section directories exist under `fixtures/html/sections/`, each with `input.html`,
      `input.css`, `expected.coverage.json`, `expected.a11y.json`, following Contract 14 §1 naming.
- [ ] The five sections collectively exercise: hover-state, image sideload, repeated-card hoisting,
      list (no-atomic) fallback, true 2D grid fallback, gradient typed-object/custom_css fallback,
      absolute-positioning, per-breakpoint variants, and `html-v3` block-promotion + stripped tags.
- [ ] No `expected.coverage.json` uses a hardcoded 85%; values reflect S3 (or flagged-provisional)
      numbers consistent with the manifest.
- [ ] At least one section each exercises the heading-hierarchy, empty-interactive-name, and missing-alt
      a11y rules.
- [ ] `05-rich-text-card` encodes expected stripped tags for the stripped-text assertion.
- [ ] `corpus.manifest.json` maps every section to path/thresholds/tolerance/requires/
      default_coverage_gate and validates against its shape.
- [ ] The three smoke payloads are minimal valid inputs matching 13-tool-catalog §1.9 schemas;
      `html_to_page` smoke is `commit:false`; `fidelity_check` uses the documented post_id placeholder.
- [ ] `pnpm fixtures:validate` passes for every file; produced trees round-trip `valid:true` through PHP
      dry_run (verified by the WP-H10 corpus suite).

## Tests Required

- No new test runner (WP-F06 owns the harness; WP-H10 owns the corpus suite). This WP's "tests" are the
  fixtures themselves passing `pnpm fixtures:validate` (Contract 14 §10) and being consumed green by the
  WP-H10 corpus regression (Contract 14 §6) and the Inspector smoke suite (Contract 14 §8).
- A trivial JSON-shape self-check is acceptable but the authoritative gate is `fixtures:validate` + the
  WP-H10 suite.

## Parallelization Notes

- Parallel-safe with ALL WPs: owns only NEW files under `packages/shared/fixtures/html/**` +
  `fixtures/envelopes/smoke.elementor.convert.*.json` (Contract 14 §11 — fixture additions are new files
  only). No file overlap with WP-F06 (runner) or any sibling fixture WP (different slices).
- Depends on WP-F06 (the fixture tree + envelope shape) and WP-S03 (the coverage numbers). Can be built
  in parallel with the pure stage WPs; the numbers are finalized once S3 lands. WP-H10 consumes these
  read-only.
