---
id: WP-Q07
title: QA — end-to-end "agency site from brief" (pages + theme builder + design system + popups + rollback + compensation)
layer: qa
phase: ULTRA
status: planned
depends_on:
  - WP-F06
  - WP-S01
  - WP-P03
  - WP-P04
  - WP-P05
  - WP-Q06
files_owned:
  - packages/server/src/test-harness/e2e-agency-site.contract.ts
  - packages/server/src/test-harness/e2e-scenario.ts
  - packages/shared/fixtures/e2e/brief.agency-site.json
  - packages/shared/fixtures/e2e/expected.outcomes.json
  - packages/shared/fixtures/e2e/INDEX.md
contract_refs:
  - spec/00-product-overview.md §6 (M1–M8 success metrics), §5 (ULTRA milestone DoD)
  - RESEARCH.md §9.1 (ULTRA milestone — end-to-end agency site from brief), §9.3 (testing)
  - spec/contracts/13-tool-catalog.md (page/widget/design/pro/convert/batch tools)
  - spec/contracts/14-fixtures-harness.md §3/§6/§7 (round-trip, corpus, identity reused)
  - spec/contracts/12-error-taxonomy.md (E_COMPENSATION_FAILED / compensation path)
estimate: L
---

## Summary

Build the end-to-end acceptance scenario that proves the ULTRA milestone (RESEARCH §9.1): an "agency site from brief" — create pages, build trees that render styled, apply a design system (global classes + variables), stand up theme-builder parts + popups, with diffs, previews, rollbacks, and a cross-doc compensation path. It exercises the full tool surface against wp-env and asserts the M1–M8 success metrics (`00-product-overview.md §6`) hold together as a system, not just per-unit.

## Interface / Contract

- **`brief.agency-site.json`.** A declarative agency brief: a set of pages (incl. the hero), a design system (global classes + size/color/font variables), a theme header/footer, and a popup. Drives the scenario.
- **`e2e-scenario.ts`.** Orchestrates the run over MCP tools: `page.create`/`page.build` (styled, primed), `design.classes.upsert` (diff-PUT, budget-checked) + `design.variables.batch` (watermark), `pro.theme.create`+`set_conditions`, `pro.popup.create`+`set_triggers`, `batch.plan`/`batch.apply` (cross-doc), then a `rollback` + a forced partial-failure to exercise compensation.
- **`e2e-agency-site.contract.ts`.** Asserts the M-metric outcomes against `expected.outcomes.json`: M1 (hero renders styled — reuse WP-Q06 render assertion), M2 (safe-edit diff + rollback restores prior tree + re-primes CSS), M5 (class diff-PUT budget pre-flight + `DUPLICATED_LABEL` reconcile), M6 (capability-aware: skips/falls back on atomic-off / no-Pro), M8 (batch records backups up front + best-effort compensates on partial failure, surfacing `E_COMPENSATION_FAILED` when compensation itself fails).
- **`expected.outcomes.json`.** The expected end-state assertions (pages exist + render styled, kit has the classes/variables, theme conditions saved, popup display settings saved, rollback restored, compensation map per step).

## Dependencies & Inputs

- Upstream: WP-F06 (harness/loader/bootstrap; Q07 ADDS `e2e/**` + its runner, never edits F06's runner), WP-S01 (atomic CSS prime confirmed), WP-P03 (validator), WP-P04 (Document_Writer — save path), WP-P05 (CssPrimer — prime-css, atomic-CSS rule), WP-Q06 (the render assertion it reuses for M1). It also exercises the page/widget/design/pro/convert/batch verticals (WP-T##/H##/R##) — feature-detect/skip portions that are not yet built so the scenario grows toward the full ULTRA DoD.
- Contracts: `00-product-overview.md §6/§5`; RESEARCH §9.1/§9.3; `13-tool-catalog.md` (the tool families); `14-fixtures-harness.md §3/§6/§7`; `12-error-taxonomy.md` (compensation/`E_COMPENSATION_FAILED`).
- Elementor APIs (cited via the verticals): `Conditions_Manager::save_conditions()` (`conditions-manager.php:300-326`) for theme conditions; popup display settings `_elementor_popup_display_settings`; design diff-PUT `apply_changes()` (`global-classes-rest-api.php:165-224`); backup/rollback (`revisions-manager.php:219-240`).

## Detailed Requirements

1. **Brief-driven build:** create pages + build the hero (styled, primed) — assert M1 via the WP-Q06 render assertion.
2. **Design system:** `design.classes.upsert` (diff-PUT, full `order`, explicit `deleted`, budget pre-flight) + `design.variables.batch` (watermark); assert M5 (budget pre-flight + `DUPLICATED_LABEL` reconcile) and the 1000-item budget guard.
3. **Pro surface:** `pro.theme.create`+`set_conditions` (conditions saved via `Conditions_Manager`) + `pro.popup.create`+`set_triggers` (display settings saved); assert the conditions/display settings persisted. Gate behind Pro capability; skip cleanly on free-only (M6).
4. **Safe-edit + rollback (M2):** make an edit (diff + dry_run), then rollback; assert the prior tree restored AND CSS re-primed.
5. **Capability-aware (M6):** run against an atomic-off / no-Pro install variant; assert graceful fallback (V3) / skip with actionable messages, never a crash.
6. **Cross-doc transaction (M8):** `batch.apply` records backups of the kit + every touched doc up front; force a partial failure; assert best-effort compensation + a per-step result map; assert `E_COMPENSATION_FAILED` is surfaced if compensation itself fails.
7. **Diffs/previews:** every mutating step produces a structured diff and (where applicable) a preview before commit; HTML conversion (if exercised) never auto-commits.
8. **`expected.outcomes.json`** encodes the end-state assertions; the scenario is idempotent (re-runnable) and trashes its artifacts in teardown.

## Implementation Notes

- This is the integration capstone; it composes the per-unit suites (Q01/Q04/Q05/Q06) rather than duplicating them — reuse their assertions/fixtures where possible (e.g. the hero render assertion from Q06).
- Q07 ADDS `e2e/**` + its runner only; it never edits other WPs' files (disjoint). It calls tools through the live MCP server like a real client.
- Run as admin on a fresh wp-env site (or a network subsite for the multisite fan-out variant). Trash all created posts/templates/popups + revert kit changes in teardown.
- Feature-detect/skip portions whose verticals are not yet built so the scenario lands incrementally and reaches full coverage at the ULTRA milestone.
- Compensation: assert backups are recorded BEFORE any mutation and that a forced mid-batch failure triggers best-effort restore (M8).

## Acceptance Criteria

- [ ] `brief.agency-site.json` drives a multi-page + design-system + Pro + popup build end-to-end against wp-env.
- [ ] M1 (hero renders styled) asserted via the Q06 render assertion.
- [ ] M2 (diff + rollback restores prior tree + re-primes CSS) asserted.
- [ ] M5 (class diff-PUT budget pre-flight + `DUPLICATED_LABEL` reconcile) asserted.
- [ ] M6 (capability-aware: V3 fallback / Pro skip with actionable messages) asserted on an atomic-off / no-Pro variant.
- [ ] M8 (batch records backups up front + best-effort compensates; `E_COMPENSATION_FAILED` on compensation failure) asserted via a forced partial failure.
- [ ] The scenario is idempotent and trashes all artifacts in teardown.
- [ ] `pnpm test:contract` runs the e2e scenario in the wp-env stage (long-running leg; may be a nightly/PR-on-label gate).

## Tests Required

- The e2e scenario IS the acceptance test for the ULTRA milestone. Self-validate by asserting the end-state in `expected.outcomes.json`.
- A forced-partial-failure variant proving compensation + `E_COMPENSATION_FAILED`.
- A capability-degraded variant (atomic-off / no-Pro) proving M6.

## Parallelization Notes

- Wave 3+, ULTRA phase (the last gate). Parallel-safe with all other QA WPs (Q07 owns `e2e/**` + `e2e-agency-site.contract.ts` + `e2e-scenario.ts`; disjoint from Q01–Q06 fixtures/runners). Depends on WP-F06 + WP-S01 + WP-P03 + WP-P04 + WP-P05 + WP-Q06.
- Exercises every vertical; it is the integration capstone, scheduled after the MVP/v1/ULTRA verticals land. Feature-detect/skip lets it grow incrementally from MVP onward.
