---
id: WP-T03
title: TS safety utilities — diff shaping, idempotency/op_id, batch plan/apply engine
layer: ts
phase: MVP
status: planned
depends_on: [WP-F01, WP-F02, WP-F03, WP-P03]
files_owned:
  - packages/server/src/safety/diff.ts
  - packages/server/src/safety/idempotency.ts
  - packages/server/src/safety/batch.ts
  - packages/server/src/safety/diff.test.ts
  - packages/server/src/safety/idempotency.test.ts
  - packages/server/src/safety/batch.test.ts
contract_refs:
  - spec/contracts/11-authoring-contract.md §1 (Diff, NodeChange, DryRunResult)
  - spec/contracts/13-tool-catalog.md §0.7-§0.8 (mutating/diff/concurrency), §1.10 (batch), §5.6
  - spec/contracts/10-rest-api.md §0.8 (op_id/base_hash), §13 (batch routes)
  - spec/contracts/12-error-taxonomy.md §3.2 (IDEMPOTENT_REPLAY)
estimate: M
---

## Summary

Cross-cutting TS safety helpers used by the mutating tool WPs and the batch tools: `diff.ts` (shape/present the PHP-authored `Diff`), `idempotency.ts` (deterministic `op_id` mint + replay detection), and `batch.ts` (the `batch.plan`/`batch.apply` engine with up-front backups + best-effort compensation). PHP OWNS the authoritative diff (produced in `dry_run`); TS SHAPES/presents it (architecture §7). PHP owns the lock; TS mints idempotency keys only (architecture §7).

## Interface / Contract

Exported from `packages/server/src/safety/diff.ts`:

- `presentDiff(diff: Diff): Diff` — validate/normalize a PHP-authored `Diff` (against WP-F03 `schemas/diff.schema.json`); never fabricate changes.
- `summarizeDiff(diff: Diff): { changed; added; removed; touched_ids: string[] }` — compact summary for result text + elicitation prompts.
- `localDiff(before: ElementNode[], after: ElementNode[]): Diff & { _advisory: true }` — TS-side structural diff for `batch.plan` estimation / client previews ONLY (never a commit source of truth; PHP `dry_run` is). Built on WP-F03's `normalize`.

Exported from `packages/server/src/safety/idempotency.ts`:

- `mintOpId(parts?: string[]): string` — deterministic when `parts` given (stable hash → reused on retry so PHP no-ops the replay), random otherwise; always matches `^[A-Za-z0-9_.-]{1,64}$` (Contract 10 §0.8).
- `payloadHash(input: unknown): string` — stable hash of a normalized payload.
- `isReplay(resp: { idempotent_replay?: boolean }): boolean` — detects PHP `data.idempotent_replay` (Contract 12 `IDEMPOTENT_REPLAY`).

Exported from `packages/server/src/safety/batch.ts`:

- `planBatch(steps: BatchStep[], wp: WpRoutes): Promise<BatchPlan>` — `batch.plan` engine (no persist; calls `wp.batchPlan` and/or per-step `wp.dryRun`), computes `backups_required[]`.
- `applyBatch(plan: BatchPlan, wp: WpRoutes, opts: { op_id?; confirm }): Promise<BatchResults>` — `batch.apply` engine: up-front backups of kit + touched docs, ordered execution, reverse-order best-effort compensation on partial failure, per-step `{step_index,ok,output,error,compensated}` (Contract 13 §1.10, M8).
- `type BatchStep = { tool: string; input: Record<string, unknown> }`; `type BatchPlan = { plan: PlanRow[]; backups_required: string[] }`; `type BatchResults = { results: StepResult[] }`.

## Dependencies & Inputs

- WP-F02 (`WpRoutes` typed wrappers: `batchPlan`/`batchApply`/`backupDocument`/`rollbackDocument`/`dryRun`). Code.
- WP-F03 (`Diff`/`NodeChange`/`DryRunResult`/`ElementNode` types + `normalize` + `schemas/diff.schema.json`). Code.
- WP-F01 (scaffold, zod, node `crypto`).
- WP-P03 (PHP `dry_run` AUTHORITATIVE validator) — MANDATORY: `applyBatch` persists element trees via per-step tools/routes that each validate; the `/batch/apply` route validates each step (Contract 10 §0.9, §13). Declared per the LOCKED write rule.
- Contract 13 §0.7 (edit tools return `Diff`; write tools return `base_hash`+`preview_url`), §0.8 (surgical tools require `base_hash`; insert/build accept `op_id`; `force` overrides), §1.10 (batch I/O), §5.6 (batch-vs-granular).
- Contract 10 §0.8 (`op_id` regex, replay no-op), §13 (batch routes + compensation), Contract 12 §3.2 (`IDEMPOTENT_REPLAY`).
- Architecture §7 (M8: backups up front, best-effort compensation, per-step result map; diff = PHP authors, TS shapes).

## Detailed Requirements

1. `presentDiff` validates against `schemas/diff.schema.json` and returns the same `Diff`; `summarizeDiff` counts + `touched_ids`.
2. `localDiff` is ADVISORY ONLY (`_advisory:true` marker + file-header warning) — never importable as a commit-time validator (PHP `dry_run` is, locked decision).
3. `mintOpId` always matches `^[A-Za-z0-9_.-]{1,64}$`; deterministic mode hashes the normalized payload so identical retries reuse the id (PHP replay no-op, Contract 10 §0.8). `isReplay` reads `idempotent_replay`; tools surface `IDEMPOTENT_REPLAY` informationally (Contract 12 §5 rule 4).
4. `planBatch`: resolve `{step_index,tool,target,action}` per step + accumulate `backups_required`; MUST NOT persist (`batch.plan` is `readOnlyHint`). May call `wp.dryRun` per step + `wp.batchPlan`.
5. `applyBatch`: record up-front backups (kit + every touched doc) via `wp.backupDocument` / the PHP `/batch/apply` contract; execute steps in order; on failure compensate in REVERSE application order (`wp.rollbackDocument` to captured backup handles), set `compensated`. If compensation itself fails, mark the step + surface a compensation-failure message (map to the closest Contract 12 code `INTERNAL_ERROR` with `meta.phase='compensation'`, since `COMPENSATION_FAILED` is not in the Contract 12 §6 enum). Destructive → the TOOL (WP-T11) gates elicitation; this engine accepts an already-confirmed flag.
6. Prefer the PHP `/batch/apply` route's own compensation where available (Contract 10 §13); do TS-side step-by-step only for pure tool sequences the route does not cover. Document which path is used.
7. No `any`; strict TS; all REST results via WP-F02 typed methods.

## Implementation Notes

- Fence `localDiff` from commit paths with the `_advisory` marker + comment so no tool treats it as authoritative.
- Deterministic `op_id`: `crypto.createHash('sha256')` over a stable JSON stringify (sort keys via WP-F03 `normalize`), base64url-slice to ≤64 chars matching the regex.
- Compensation: capture each step's pre-write `base_hash`/backup handle as it runs so rollback targets the right snapshot; roll back in reverse.
- Note Contract 10's REST digest references `E_COMPENSATION_FAILED`; the TS-side Contract 12 §6 enum does not include `COMPENSATION_FAILED`, so map to `INTERNAL_ERROR` + `meta.phase`. Flag this mismatch to the contract owner if it recurs.

## Acceptance Criteria

- [ ] `presentDiff` validates a `Diff` against the schema and returns it unchanged; `summarizeDiff` counts correctly.
- [ ] `localDiff` is advisory-only and not importable as a commit validator.
- [ ] `mintOpId` always matches the regex; deterministic-stable vs payload; `isReplay` detects the flag.
- [ ] `planBatch` produces `{plan,backups_required}` without persisting.
- [ ] `applyBatch` records up-front backups, executes in order, compensates in reverse on failure, returns per-step results with `compensated`.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `safety/diff.test.ts`: `presentDiff` schema validation; `summarizeDiff` counts; `localDiff` on normalized trees.
- `safety/idempotency.test.ts`: op_id regex + determinism vs payload; `isReplay` detection.
- `safety/batch.test.ts`: mocked `WpRoutes`; `planBatch` no-persist + `backups_required`; `applyBatch` happy path, reverse-order compensation, compensation-failure reporting.

## Parallelization Notes

- Owns only `safety/*` — disjoint from all other WPs.
- Wave 1/early-Wave-2: depends on WP-F02 (routes) + WP-F03 (authoring) code; batch persistence path targets the frozen `/batch/*` + `/documents/*` routes, integrating with PHP (WP-P02/P03) at the wave boundary.
- Consumed by mutating tool WPs (WP-T05/T06/T07/T10/T11) for `op_id`/diff and by WP-T11 for batch.
