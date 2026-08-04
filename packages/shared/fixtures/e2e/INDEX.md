# e2e — ULTRA milestone "agency site from brief"

The end-to-end acceptance corpus for the **ULTRA milestone** (RESEARCH §9.1,
[`00-product-overview.md §5/§6`](../../../../spec/00-product-overview.md)). Owned by **WP-Q07**.

This directory is the integration capstone: a single declarative **brief** drives a multi-page +
design-system + Pro theme-builder + popup build over the live MCP/REST surface, then exercises a safe
edit + rollback and a cross-doc batch with a forced partial failure — asserting the **M1–M8** success
metrics hold together as a system, not just per unit.

> These files are a **custom e2e shape (`$e2e: 1`)**, NOT the LOCKED §2 fixture envelope
> (`tree`/`design`/`html`/`roundtrip`/`smoke`). `fixtures/e2e/**` is deliberately **not** in the
> generic loader's `FIXTURE_SUBDIRS`, so `fixtures:validate` and the dry-run/round-trip suites never
> pick them up. They are read **directly** by the Q07 runner
> ([`packages/server/src/test-harness/e2e-scenario.ts`](../../../server/src/test-harness/e2e-scenario.ts)).
> Q07 **adds** `e2e/**` + its runner only; it never edits WP-F06's loader/runners (§11 parallel-build
> guarantee).

## Files

| File                                                 | Role                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`brief.agency-site.json`](./brief.agency-site.json) | The declarative brief: pages (incl. the hero), the design system (diff-PUT classes + watermarked variables batch), Pro header/footer + popup, edit-patch, batch. |
| [`expected.outcomes.json`](./expected.outcomes.json) | The expected end-state, keyed by `metrics.M1…M8` — the contract suite asserts against this.                                                                      |
| `INDEX.md`                                           | This file.                                                                                                                                                       |

## Runners (`packages/server/src/test-harness/`)

| Suite                  | Runner                        | When                                            |
| ---------------------- | ----------------------------- | ----------------------------------------------- |
| e2e orchestration      | `e2e-scenario.ts`             | imported by the contract suite (library module) |
| M1–M8 contract asserts | `e2e-agency-site.contract.ts` | `pnpm test:contract` (needs wp-env; long leg)   |

The contract suite **feature-detects** each vertical's REST route and **skips with a clear, actionable
message** when the route is not registered yet (the verticals land incrementally — WP-P##/T##/H##), so
the scenario grows toward the full ULTRA DoD without ever failing on a not-yet-built leg. It runs as
admin on a fresh wp-env site and **trashes all created posts/templates/popups + reverts kit changes in
teardown** (idempotent / re-runnable).

## The M-metric map (`00-product-overview.md §6`)

| M   | What                            | Q07 step                                                                                                                                                  |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Build-a-hero-renders-styled     | create the hero page → `page.build` (prime_css) → public CSS has the local + global class rules.                                                          |
| M2  | Safe-edit-with-rollback         | `widget.update_settings` (diff + dry_run) → `page.rollback` restores the prior tree + re-primes CSS.                                                      |
| M5  | Design-system safety            | `design.classes.upsert` (diff-PUT, budget pre-flight, `DUPLICATED_LABEL` reconcile) + `variables.batch`.                                                  |
| M6  | Capability-aware operation      | probe `site.capabilities` first; V3 fallback on atomic-off; clean Pro-skip with actionable messages.                                                      |
| M8  | Cross-doc transaction integrity | `batch.plan`/`batch.apply` records backups up front; forced partial failure → compensation + result map; `E_COMPENSATION_FAILED` on compensation failure. |

M3 (HTML coverage), M4 (validator drift), M7 (visual fidelity) are proven by their own QA suites — see
`expected.outcomes.json#out_of_scope`.

## Pro / conditions reminder (SUPPLEMENT §A.1/§A.2)

Theme/popup conditions in the brief are `ConditionTuple` arrays `[type, name, sub_name?, sub_id?]`. The
companion writes them via `Conditions_Manager::save_conditions()`, which **flattens to slash-joined
strings** into `_elementor_conditions` **and** regenerates the cache — the brief NEVER writes the meta
raw. Popup display settings (triggers + timing) persist into `_elementor_popup_display_settings` via
`save_display_settings_data()`. The contract suite asserts the returned `conditions_stored` slash
strings + the persisted display settings.
