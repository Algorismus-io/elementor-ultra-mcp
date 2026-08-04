---
id: WP-T11
title: TS tool handlers — ops/observability + batch + meta-trio
layer: ts
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F02, WP-F04, WP-F05, WP-T01, WP-T03, WP-P03, WP-P14]
files_owned:
  - packages/server/src/tools/ops.ts
  - packages/server/src/tools/meta.ts
  - packages/server/src/tools/ops.test.ts
  - packages/server/src/tools/meta.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §1.10 (ops/batch), §1.11 (meta-trio), §5 (surface ergonomics)
  - spec/contracts/10-rest-api.md §11 OPS, §13 BATCH
  - spec/contracts/12-error-taxonomy.md §3.2 (IDEMPOTENT_REPLAY), §5
estimate: M
---

## Summary

Implements two related handler groups attached to the WP-F04 registry: (1) ops/observability + cross-doc batch (`ops.log`, `batch.plan`, `batch.apply`) backed by the WP-T03 safety batch engine; and (2) the always-available meta-trio (`tools.list_endpoints`, `tools.get_schema`, `tools.invoke`) which provides invoke-by-name access to disabled long-tail tools without enabling them all (Contract 13 §1.11, §5.3). The meta-trio is the long-tail escape hatch for the large surface.

## Interface / Contract

`tools/ops.ts` attaches (Contract 13 §1.10):

- `ops.log` (R, `GET /ops/log`) — `{post_id?,user?,...page}` → `{items[],next_cursor,total}`.
- `batch.plan` (R, BOTH; uses WP-T03 `planBatch`) — `{steps[]}` → `{plan[],backups_required[]}`.
- `batch.apply` (D, BOTH; uses WP-T03 `applyBatch`) — `{plan[],op_id?,confirm?}` → `{results[]}`. Elicitation.

`tools/meta.ts` attaches (Contract 13 §1.11) — ALWAYS enabled regardless of profile:

- `tools.list_endpoints` (R, TS) — `{prefix?,...page}` → `{items:[{name,title,class,enabled,star}],next_cursor,total}`. Queries `ctx.registry`.
- `tools.get_schema` (R, TS) — `{name}` → `{name,inputSchema,outputSchema,annotations}`.
- `tools.invoke` (TS dispatch) — `{name,arguments}` → `{result,isError}`. Inherits the target's effective annotations + confirm gating; class inherits target.

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ToolHandler`; the WP-F04 `ToolRegistry` introspection exposed via `ctx.registry`: `getDescriptor`/`listForProfile`/attach map; the live dispatch helper). The meta-trio is the primary consumer of registry introspection. Code.
- WP-F02 (`WpRoutes.opsLog`/`batchPlan`/`batchApply`/`backupDocument`/`rollbackDocument`/`dryRun`). Code via `ctx.wp`.
- WP-T03 (`planBatch`/`applyBatch`/`mintOpId`/`isReplay`). Code.
- WP-F04 (catalog + `attachHandler`; meta-trio flagged always-on), WP-F05 (`toMcpResult`). Code.
- WP-P03 (PHP `dry_run` validator) — MANDATORY WRITE dependency: `batch.apply` persists element trees via per-step tools/routes that each validate; `/batch/apply` validates each step (Contract 10 §0.9, §13).
- WP-P14 (PHP ops-log controller) — runtime counterpart for `ops.log` (contract dependency).
- Contract 13 §1.10/§1.11, §5.3 (invoke disabled tools without persistently enabling), §5.6, §0.6 (pagination). Contract 10 §11/§13. Contract 12 §3.2.

## Detailed Requirements

1. Attach handlers for `ops.log`, `batch.plan`, `batch.apply` (§1.10) + the meta-trio (§1.11). None are ★, BUT the meta-trio is ALWAYS enabled regardless of `ULTRA_TOOLS` (Contract 13 §5.2 final para / §1.11) — WP-F04 flags them always-on and WP-T01 keeps them enabled; this WP MUST NOT register them in a way that disables them.
2. `ops.log`: paginate `{limit,cursor,fields}`→`{items,next_cursor,total}`; filters `post_id`/`user` (Contract 10 §11). Op-log is PHP-owned (architecture §7); read only.
3. `batch.plan`: call WP-T03 `planBatch(steps,ctx.wp)` (no-persist, `readOnlyHint`); return `{plan,backups_required}`.
4. `batch.apply`: destructive → `ctx.elicit` when `confirm!=true`. Call WP-T03 `applyBatch(plan,ctx.wp,{op_id,confirm})` (up-front backups + reverse-order compensation, M8). Return per-step `{ok,output,error,compensated}`. `idempotentHint` with `op_id`; surface `IDEMPOTENT_REPLAY` (WP-T03 `isReplay`).
5. Meta-trio:
   - `tools.list_endpoints`: enumerate EVERY tool incl. disabled via `ctx.registry`; `{name,title,class,enabled,star}`; paginate; `prefix` filter.
   - `tools.get_schema`: return the named tool's input/output schema + annotations from the registry.
   - `tools.invoke`: dispatch a named tool's handler INCLUDING disabled tools WITHOUT persistently enabling it (Contract 13 §5.3 one-shot). MUST mirror the target's safety class + confirm gating (destructive target → same elicitation). Return `{result,isError}`. This is the long-tail access path for Pro/Woo tools (WP-R##) disabled by default.
6. `tools.invoke` arg validation: validate `arguments` against the TARGET tool's `inputSchema` (from the registry) before dispatch; mismatch → `-32602` against the target schema (Contract 13 §0.9). Pass the same `ctx`.
7. Errors per Contract 12 §5; arg failures `-32602`. No `any`.

## Implementation Notes

- The meta-trio leans ENTIRELY on the WP-F04 registry introspection (exposed via `ctx.registry`) + a dispatch helper; keep these handlers thin. `tools.invoke` dispatches the attached handler directly — it MUST NOT call `ctx.surface.enable()` (that would persistently enable; Contract 13 §5.3 distinguishes `tools.search`→enable vs `tools.invoke`→one-shot).
- `batch.apply` compensation lives in WP-T03; this handler drives elicitation + presents results. Prefer the PHP `/batch/apply` compensation where the engine routes to it (Contract 10 §13).
- `ops.log` is `CAP_MANAGE` (Contract 10 §11) — a non-admin agent user may get `CAPABILITY_MISSING`; surface cleanly.

## Acceptance Criteria

- [ ] Handlers attached for `ops.log`/`batch.plan`/`batch.apply` + the meta-trio with exact Contract 13 names/schemas/annotations.
- [ ] The meta-trio is enabled regardless of `ULTRA_TOOLS`.
- [ ] `batch.plan` no-persist; `batch.apply` elicitation-gated, up-front backups, reverse-order compensation, per-step results with `compensated`.
- [ ] `tools.list_endpoints` includes disabled tools; `tools.get_schema` returns target schemas; `tools.invoke` dispatches a disabled tool one-shot WITHOUT enabling it, mirroring safety/confirm gating.
- [ ] `tools.invoke` validates `arguments` against the target `inputSchema` (→ `-32602` on mismatch).
- [ ] `IDEMPOTENT_REPLAY` surfaced on batch replay; `ops.log` paginates.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `tools/ops.test.ts` (vitest, no WP): mock `ctx.wp`/WP-T03 engine/elicit; assert `ops.log` pagination, `batch.plan` no-persist, `batch.apply` elicitation + compensation result shape + IDEMPOTENT_REPLAY.
- `tools/meta.test.ts`: stub registry; assert `list_endpoints` includes disabled tools, `get_schema` returns target schema, `invoke` dispatches a disabled tool without enabling it + enforces destructive-confirm parity.

## Parallelization Notes

- Owns `tools/ops.ts` + `tools/meta.ts` + tests — disjoint from every other `tools/*`.
- Phase ULTRA (ops/batch per RESEARCH §9.1), but the meta-trio is foundational to the lean profile (always-on) — it can land early; the ops/batch handlers complete in the ULTRA wave.
- Depends on WP-T01 (registry introspection) + WP-F02 + WP-T03; `batch.apply` integration depends on WP-P03 + the PHP batch route; `ops.log` on WP-P14. Parallel-safe with all handler WPs.
