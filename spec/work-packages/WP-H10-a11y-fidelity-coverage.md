---
id: WP-H10
title: A11Y lint + FIDELITY visual-diff + CoverageReport assembly + commit gate
layer: html
phase: ULTRA
status: planned
depends_on:
  - WP-F03
  - WP-F05
  - WP-F06
  - WP-P02
  - WP-P03
  - WP-P05
  - WP-H01
  - WP-H03
  - WP-H04
  - WP-H07
  - WP-H08
  - WP-H09
  - WP-S01
  - WP-S03
files_owned:
  - packages/server/src/convert/a11y.ts
  - packages/server/src/convert/a11y.test.ts
  - packages/server/src/convert/fidelity.ts
  - packages/server/src/convert/fidelity.test.ts
  - packages/server/src/convert/coverage.ts
  - packages/server/src/convert/coverage.test.ts
contract_refs:
  - spec/contracts/schemas/diff.schema.json
  - spec/contracts/13-tool-catalog.md#19-html-native-conversion-flagship
  - spec/contracts/14-fixtures-harness.md#6-html-native-corpus-regression-locked-researchmd-93d-68
  - spec/contracts/15-engineering-standards.md#46-html-pipeline-layer-html-wp-h
estimate: L
---

## Summary

The honest-reporting + gating stage: build the `CoverageReport` (diff.schema.json) from the per-node /
per-declaration fallback records, run the accessibility lint (heading hierarchy, empty interactive
names, missing alt — RESEARCH.md §6.5), compute the visual-diff fidelity score by rendering the saved
page vs the source HTML with Playwright + pixelmatch (RESEARCH.md §6.8, the `convert.fidelity_check`
engine), and apply the COMMIT GATE (coverage below threshold or a11y blockers -> refuse commit). It
also owns the HTML->native corpus regression harness wiring per Contract 14 §6. Coverage thresholds are
anchored to the S3 spike result — NEVER a hardcoded 85% (15-eng-standards §4.6). This WP reuses the
WP-H03 browser pool (one Playwright instance) and round-trips produced trees through the PHP dry_run.

## Interface / Contract

The report TS types — `CoverageReport`, `A11yFinding`, `FidelityResult` (and the consumed `DeclFallback`/
`NodeFallback`/`StrippedRecord`/`ProposedVariable`/`GlobalClassObject` inputs) — are FROZEN and OWNED by
WP-H01 (`convert/types.ts`, Contract 15 §4.6.1), mirroring `diff.schema.json` (the canonical field-name
source). This WP IMPLEMENTS the functions and `import type`s the report types; it does NOT redeclare
them. For reference (the frozen shapes, canonical in diff.schema.json):

Exports from `packages/server/src/convert/coverage.ts`:

- `buildCoverageReport(input: CoverageInput): CoverageReport` where `CoverageReport` is exactly the
  diff.schema.json `$defs/CoverageReport`: `{ coverage:{pct_native, pct_local_or_global_class,
  pct_custom_css, pct_dropped}, fallbacks:[{element_id, tier, reason}], a11y:[{element_id, rule,
  severity:'warning'|'blocker', message}], stripped_text:[{element_id, stripped_tags[]}],
  visual_diff_score? }`. `CoverageInput` aggregates the per-declaration `DeclFallback`s (WP-H07), the
  per-node `NodeFallback`s (WP-H06), the NORMALIZE `StrippedRecord`s (WP-H04), the a11y findings
  (this WP), and an optional `visual_diff_score` (this WP). Computes the four coverage percentages from
  the classified declaration counts.
- `evaluateGate(report: CoverageReport, gate: GateConfig): GateResult` where `GateConfig =
  { coverage_gate?: number; require_no_blockers: boolean }` and `GateResult = { allowed: boolean;
  reasons: string[] }`. Allowed=false when `pct_native + pct_local_or_global_class + pct_custom_css <
  coverage_gate` (the native+class+custom_css covered fraction) OR any a11y `severity:'blocker'`
  exists. The `coverage_gate` default is the S3-anchored value from `corpus.manifest.json` (NOT 85%).

Exports from `packages/server/src/convert/a11y.ts`:

- `lintA11y(elements: ElementNode[]): A11yFinding[]` returning `{element_id, rule, severity, message}`
  items (the `CoverageReport.a11y[]` shape). Rules: heading hierarchy (single h1, no skipped levels),
  empty interactive names (empty `e-button`/link text), missing image alt.

Exports from `packages/server/src/convert/fidelity.ts`:

- `fidelityCheck(input: FidelityInput): Promise<FidelityResult>` where `FidelityInput =
  { rendered_url: string; source_html: string; source_css?: string; breakpoints: BreakpointSpec[];
  browser: BrowserPort }` and `FidelityResult = { score: number; deltas:[{breakpoint,
  diff_ratio:number, region:string|null}] }` — the exact `convert.fidelity_check` output
  (13-tool-catalog §1.9). `score` and `diff_ratio` are `diffPixels/totalPixels` (lower is better);
  `BrowserPort` is the WP-H03 browser-pool interface (reused, one Playwright instance).

## Dependencies & Inputs

- **WP-P03 (PHP dry_run validator)** — REQUIRED (universal write rule): the corpus regression
  round-trips produced trees through dry_run and asserts `valid:true` (Contract 14 §6 step 5).
- **prime-css WP (WP-P05 `Css_Primer`) + WP-S01** — REQUIRED (universal atomic-CSS rule): the fidelity
  check renders the SAVED page, which only shows atomic styles after priming (via the WP-P05 service);
  the rendered_url must be a primed page. The orchestrator (WP-H11) performs the prime before this WP's
  fidelity render.
- **WP-S03 (HTML coverage baseline)** — establishes the coverage numbers in `corpus.manifest.json`; this
  WP's gate thresholds anchor to S3 (15-eng-standards §6 spike-gate, Contract 14 §6). No coverage
  threshold is locked before S3.
- **WP-F06 (golden-fixtures harness)** — owns `packages/shared/fixtures/` and the corpus manifest +
  runner; this WP ADDS the corpus regression test logic that READS `fixtures/html/sections/**` and
  `corpus.manifest.json` (read-only) and asserts via the harness. It does NOT edit WP-F06's runner.
- **WP-H03** — reuses `browser-pool.ts` (one Playwright instance for parse + screenshot).
- **WP-H04/H06/H07/H08/H09** — consumes their fallback/stripped/a11y inputs and assembled tree.
- **WP-F03** — `CoverageReport`, `ElementNode`, `BreakpointSpec`, shared types.
- **WP-F05** — `HTML_V3_STRIPPED` (soft), severity vocabulary.
- Contract sections: diff.schema.json `CoverageReport`; 13-tool-catalog §1.9 (`fidelity_check`, report
  shape, gate behavior); 14-fixtures-harness §6 (corpus regression: coverage tolerance, a11y match,
  stripped match, dry_run valid); 15-eng-standards §4.6 (honest reporting, S3-anchored), §6 (S1/S3
  gates). RESEARCH.md §6.5 (a11y), §6.6 (fidelity limits), §6.8 (fidelity evaluation + gate),
  SUPPLEMENT §C.3-C.4 (pixelmatch, `animations:'disabled'`, `waitForLoadState`, realistic 60-80%).

## Detailed Requirements

1. **Coverage computation (diff.schema.json).** Tally declarations by tier across all nodes:
   `pct_native` = native / total; `pct_local_or_global_class` = (local_style + global_class) / total;
   `pct_custom_css` = custom_css / total; `pct_dropped` = (unmappable-and-not-custom_css) / total.
   Percentages sum to ~100 (allow rounding). Merge per-declaration tiers (WP-H07) and per-node tiers
   (WP-H06) consistently — a node mapped to an html-widget last resort counts its declarations under
   the appropriate bucket.
2. **A11y lint (RESEARCH.md §6.5).** Heading hierarchy: exactly one `e-heading` with `tag:h1`; no
   skipped levels (h2 then h4 -> warning); emit `severity:'blocker'` for multiple h1s in a single page
   conversion (configurable), `'warning'` for skipped levels. Empty interactive names: `e-button` /
   link with empty text -> `'warning'` (or `'blocker'` per config). Missing alt: `e-image` whose
   sideloaded media has no alt -> `'warning'`. Atomic heading enforces only the h1-h6 ENUM, not
   hierarchy (`atomic-heading.php`), so hierarchy lint is OUR responsibility.
3. **Stripped-text rollup.** Fold the NORMALIZE `StrippedRecord`s (WP-H04) into
   `CoverageReport.stripped_text[]` (per element id), and surface the `HTML_V3_STRIPPED` soft signal
   (error-taxonomy §3.1) when present — non-fatal, reported.
4. **Visual diff (RESEARCH.md §6.8, SUPPLEMENT §C.3-C.4).** Render the SAVED+PRIMED page
   (`rendered_url` = `get_wp_preview_url()`/public URL from the persist step) in Playwright, render the
   SOURCE HTML+CSS in a second page, screenshot both at each breakpoint width with
   `animations:'disabled'`, `reducedMotion:'reduce'`, and `waitForLoadState('networkidle')` + fonts
   ready (or the score is noisy). Compare with pixelmatch; `diff_ratio = diffPixels/totalPixels` per
   breakpoint; `score` = the worst (or weighted-mean) ratio. Reuse the WP-H03 browser pool. Honest
   expectation: real marketing input lands well below 95% pixel fidelity initially — report the number,
   never promise (RESEARCH.md §6.6, SUPPLEMENT §C.4).
5. **Commit gate (LOCKED, RESEARCH.md §6.8).** `evaluateGate` returns `allowed:false` with reasons when
   covered fraction < `coverage_gate` OR any a11y blocker exists. The orchestrator (WP-H11) uses this
   to REFUSE commit and return the report. The default `coverage_gate` is read from
   `corpus.manifest.json` (S3-anchored); callers may override via the tool's `coverage_gate` arg
   (13-tool-catalog §1.9). The pipeline NEVER auto-commits regardless (that is WP-H11's elicitation
   gate); this WP only computes the report + gate verdict.
6. **Corpus regression (Contract 14 §6).** Provide the test logic that, for each
   `fixtures/html/sections/<n>/`: runs the full convert (parse->...->hoist) on `input.html`(+`input.css`),
   asserts `report.coverage` within the per-section tolerance in `corpus.manifest.json` (NOT a hardcoded
   85%), asserts `report.a11y` matches `expected.a11y.json`, asserts `report.stripped_text` matches the
   expected stripped tags, and round-trips the produced `elements` through PHP dry_run asserting
   `valid:true`. Read fixtures/manifest read-only (owned by WP-F06); add only `*.test.ts` here.
7. Reuse one Playwright instance (WP-H03 pool) — do NOT launch a second browser. Bound screenshot
   concurrency. Always close pages.
8. `lintA11y` and `buildCoverageReport` are pure; `fidelityCheck` is async (browser I/O via the
   injected `BrowserPort`).

## Implementation Notes

- pixelmatch `threshold` is per-pixel tolerance, NOT the proportion changed — gate on
  `diffPixels/total` (SUPPLEMENT §C.4). Set the per-pixel threshold modestly (e.g. 0.1) and report the
  ratio.
- The fidelity check requires the SAVED page to be PRIMED (atomic CSS does not render otherwise,
  authoring-contract §10) — assert/await priming via the orchestrator before screenshotting, else the
  diff is meaningless (page renders unstyled). Surface `CSS_PRIME_FAILED` upstream if priming failed.
- Coverage percentages must be reproducible for the corpus regression — base them on a deterministic
  declaration count (the WP-H07 classification), not on the noisy pixel score.
- Keep the gate logic separate from the report build so the orchestrator can present the report even
  when the gate fails (it always returns the report; refusing commit is not an error — error-taxonomy
  §5.5 "declining -> clean non-error result").
- Markdown round-trip is a coarse text check only (RESEARCH.md §6.8); do NOT use it as the fidelity
  gate — visual diff is the gate.

## Acceptance Criteria

- [ ] `buildCoverageReport` produces a `CoverageReport` validating against diff.schema.json with four
      percentages summing to ~100 and per-node fallback + stripped-text + a11y arrays populated.
- [ ] `lintA11y` flags multiple-h1 (blocker), skipped heading level (warning), empty button (warning),
      missing alt (warning) with correct `element_id`s.
- [ ] `fidelityCheck` returns a `score` and per-breakpoint `deltas` computed as diffPixels/total via
      pixelmatch, reusing the WP-H03 browser pool (no second browser launched).
- [ ] `evaluateGate` returns `allowed:false` with reasons when covered fraction < `coverage_gate` or an
      a11y blocker exists; `allowed:true` otherwise.
- [ ] The default `coverage_gate` is read from `corpus.manifest.json` (S3-anchored), never a literal 85.
- [ ] Corpus regression: each section's coverage is within `corpus.manifest.json` tolerance, a11y +
      stripped-text match the expected JSON, and produced trees round-trip `valid:true` through PHP
      dry_run.
- [ ] `fidelityCheck` screenshots use `animations:'disabled'` + `networkidle`/fonts-ready.

## Tests Required

- Unit (`coverage.test.ts`): percentage math; merge of per-declaration + per-node + stripped + a11y;
  `evaluateGate` allow/deny matrix; S3-anchored default loaded from a stub manifest.
- Unit (`a11y.test.ts`): each rule on crafted `ElementNode[]`.
- Integration (`fidelity.test.ts`, real Chromium via the pool): identical-page -> score ~0; clearly
  different page -> high score; per-breakpoint deltas. Skip with a clear message if Chromium absent.
- Contract (corpus, Contract 14 §6): `fixtures/html/sections/**` coverage/a11y/stripped + dry_run-valid
  assertions, reading `corpus.manifest.json` read-only.

## Parallelization Notes

- Parallel-safe with all sibling HTML WPs: owns only `a11y.ts`, `fidelity.ts`, `coverage.ts`, and tests.
- Type/code dependencies: WP-H01 (frozen `CoverageReport`/`A11yFinding`/`FidelityResult` report types +
  the `DeclFallback`/`NodeFallback`/`StrippedRecord`/`ProposedVariable` inputs, Contract 15 §4.6.1),
  WP-H03 (browser pool), WP-H04/H06/H07/H08/H09 (report inputs), WP-F03/F05 (shared types/codes),
  WP-F06 (fixtures harness, read-only). Atomic-CSS deps WP-P05 (prime-css `Css_Primer`, so the fidelity
  render hits a primed page) + WP-S01 (prime approach) per the universal rule — the orchestrator
  (WP-H11) performs the prime before this WP's fidelity render; this WP imports no PHP source. Spike dep
  WP-S03 (coverage thresholds). Buildable + unit-testable (coverage/a11y pure, fidelity stubs the
  `BrowserPort`) as soon as WP-H01 lands; the DAG sequences it after WP-H09 to keep the corpus chain
  linear. Phase ULTRA (fidelity visual-diff + fallback-ladder reporting per RESEARCH.md §9.1 ULTRA),
  but coverage/a11y can land in v1 if WP-H11 needs the gate earlier — keep the gate + report v1-ready
  and the visual-diff ULTRA.
