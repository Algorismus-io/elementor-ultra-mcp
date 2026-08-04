---
id: WP-P15
title: Cross-document batch handler (POST /batch/plan, POST /batch/apply with compensation)
layer: php
phase: ULTRA
status: planned
depends_on: [WP-P02, WP-P03, WP-P04, WP-P05, WP-S01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-batch-controller.php
  - plugin/elementor-ultra-mcp/includes/core/class-batch-runner.php
contract_refs:
  - spec/contracts/10-rest-api.md §13 (BATCH), §0.9 (dry-run authoritative), §0.8 (op_id)
  - spec/contracts/12-error-taxonomy.md §3.5 (E_COMPENSATION_FAILED→INTERNAL/UPSTREAM), §3.1
estimate: M
---

## Summary

The cross-document transaction surface (ULTRA): `batch/plan` dry-plans a multi-document brief (pages + header + footer + popups + design system) by running each step's validator with NO persist, and `batch/apply` executes the plan with up-front backups and best-effort compensation (roll back created docs + restore the kit snapshot on partial failure). A failed step does not raise an HTTP error — the per-step `results[]` carries the outcome.

## Interface / Contract

Registers (Contract 10 §13):

- `POST /batch/plan` (CAP_EDIT_POST; each step re-checks its own cap) — `{steps:[{route,body}],op_id}` → `{plan:[{step,route,valid,diff}],backups_required:[{post_id}|{kit:true}],valid}`. No persist. (§13)
- `POST /batch/apply` (CAP_EDIT_POST) — `{plan:[...],op_id}` → `{results:[{step,ok,post_id?,error?}],compensated}`. Records kit + every touched-doc backup UP FRONT; on partial failure rolls back created docs + restores the kit snapshot. HTTP 200 unless the request is malformed (400) or compensation failed (500 `E_COMPENSATION_FAILED`). (§13)

Core runner (owned here):
- `\Elementor\Ultra\Core\Batch_Runner`:
  - `plan( array $steps ): array` — per-step validate via the appropriate validator; collect diffs + required backups.
  - `apply( array $plan ): array` — backup-all-up-front, execute steps, compensate on failure.

## Dependencies & Inputs

- WP-P02 (base/perms/error), WP-P03 (`Validator` for per-step planning + the pre-persist validate), WP-P04 (`Document_Writer`/`Backup_Service` for the per-step writes + compensation snapshots), WP-P05 (`Css_Primer` for atomic steps; `Cache_Service`).
- WP-S01 (atomic-CSS steps depend on prime-css + S1, universal rule).
- Routing dependency: the runner dispatches each step's `route` to the SAME handlers the REST controllers use. To avoid editing other controllers' files, the runner calls the underlying CORE SERVICES (`Document_Writer`, `Global_Classes_Service`, `Variables_Service`, Pro builders) directly by route name, NOT by re-invoking HTTP. It contains a small route→service dispatch map. Pro routes are dispatched to WP-R##'s Pro builders behind a `class_exists` guard (graceful skip if Pro WP absent).
- Contract 10 §13 (plan/apply shapes + compensation semantics), §0.9 (dry-run authoritative per step), §0.8 (op_id). Contract 12 (`E_COMPENSATION_FAILED`→ maps to `INTERNAL_ERROR`/`UPSTREAM_ERROR` per taxonomy; the REST `code` is `E_COMPENSATION_FAILED` per §13).

## Detailed Requirements

1. **plan** (§13): for each `{route,body}` step, run the route's VALIDATOR-only path (no persist): document steps → `Validator::dry_run`; design steps → budget/order pre-flight (via WP-P08/P09 services' preflight, contract dep); Pro steps → the Pro builder's validate-only (WP-R##, guarded). Collect `{step,route,valid,diff}` and `backups_required` (each touched `post_id` + `{kit:true}` when design is touched). `valid` is the AND of all steps. CAP_EDIT_POST; each step re-checks its own cap.
2. **apply** (§13): 
   a. Re-validate the plan (a plan may be stale).
   b. **Backup-all-up-front**: snapshot every touched doc (`Backup_Service::snapshot`) AND the kit (if design is touched) BEFORE any write — record handles + which docs are NEW (created in this batch).
   c. Execute steps IN ORDER via the route→service dispatch (single `Document::save` per doc step).
   d. On a step failure: STOP, then COMPENSATE — delete docs CREATED in this batch, restore the kit snapshot, and rollback any modified existing docs to their up-front snapshot. Set `compensated:true`.
   e. Return `{results:[{step,ok,post_id?,error?}],compensated}` at HTTP 200. A failed step's `error` carries a taxonomy code; the request is still 200 (the per-step result is the channel). Only a malformed REQUEST is 400; only a FAILED compensation is 500 `E_COMPENSATION_FAILED`.
3. **op_id** (§0.8): the batch `op_id` plus per-step op_ids thread through; idempotent replay of an already-applied batch returns the prior results.
4. **No partial persisted state on failure**: after a failed apply + successful compensation, the site is back to its pre-batch state (created docs gone, kit restored, modified docs rolled back). Assert this.
5. **Atomic priming** (§0.10): atomic doc steps prime CSS after their save (S1).

## Implementation Notes

- The route→service dispatch is the key design choice: do NOT make HTTP sub-requests (slow, auth-fragile). Map each supported `route` string to a direct core-service call (`documents/save`→`Document_Writer::save`, `pro/theme`→`Pro_Theme_Builder::create` (WP-R##, guarded), `design/deploy`→`Global_Classes_Service::apply_diff`+`Variables_Service::batch`, etc.). Unsupported routes in a batch → that step fails with `E_BAD_REQUEST`.
- Compensation order is the reverse of application; deleting a newly-created doc is `wp_delete_post($id, true)`; restoring an existing doc is `Backup_Service::rollback`; restoring the kit is a kit-settings rollback (snapshot the kit's `_elementor_page_settings` + global-classes order/labels up front).
- Compensation can itself fail (e.g. a doc was externally modified mid-batch) → return 500 `E_COMPENSATION_FAILED` with `meta` listing what could not be undone, so a human can intervene.
- Keep `Batch_Runner` independent of the HTTP layer so it is unit-testable; the controller is a thin wrapper.
- This is ULTRA-phase; gate behind the same capability probes its steps require. Pro steps are skipped/failed gracefully if Pro is inactive.

## Acceptance Criteria

- [ ] `batch/plan` validates a multi-step brief with NO persist and returns per-step `{valid,diff}` + `backups_required`.
- [ ] `batch/apply` backs up every touched doc + the kit BEFORE writing.
- [ ] A successful `batch/apply` returns `results[]` all `ok:true` at HTTP 200.
- [ ] A `batch/apply` with a failing step returns HTTP 200 with that step `ok:false` + a taxonomy `error.code`, `compensated:true`, and the site restored to pre-batch state (created docs deleted, kit restored, modified docs rolled back).
- [ ] A failed compensation returns 500 `E_COMPENSATION_FAILED` with diagnostic `meta`.
- [ ] Atomic doc steps prime CSS (S1-gated).
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_plan_no_persist`; `test_apply_backs_up_before_write`; `test_apply_success_all_ok`; `test_apply_partial_failure_compensates_and_restores`; `test_compensation_failure_500`; `test_idempotent_batch_replay`.

## Parallelization Notes

- Wave-3 (ULTRA) vertical. Owns `class-batch-controller.php` + `class-batch-runner.php` — disjoint from all other controllers.
- Lists WP-P03/P04/P05/S01 (WRITE + atomic-CSS rules). Consumes WP-P08/P09 design services and WP-R## Pro builders at the CONTRACT level via a route→service dispatch behind `class_exists` guards (no file edits). It builds even if the Pro WPs are absent (those steps degrade).
- Parallel-safe with every other WP-P##; the dispatch map references other services' frozen interfaces only.
