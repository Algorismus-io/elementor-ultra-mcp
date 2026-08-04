---
id: WP-T07
title: TS tool handlers — design system (classes diff-PUT, variables, global colors/fonts, defaults, sync, deploy)
layer: ts
phase: v1
status: planned
depends_on: [WP-F01, WP-F02, WP-F03, WP-F04, WP-F05, WP-T01, WP-T03, WP-P03, WP-P05, WP-P08, WP-P09, WP-S01, WP-S05]
files_owned:
  - packages/server/src/tools/design.ts
  - packages/server/src/tools/design-classes-diff.ts
  - packages/server/src/tools/design.test.ts
  - packages/server/src/tools/design-classes-diff.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §1.4 (design-system ops), §0.7-§0.9
  - spec/contracts/10-rest-api.md §4 DESIGN (diff-PUT §4.2, variables §4.4, globals §4.5, defaults §4.6, sync §4.7, deploy §4.8)
  - spec/contracts/11-authoring-contract.md §1 (GlobalClassObject/StyleDefinition, StyleVariant)
  - spec/contracts/12-error-taxonomy.md §3.3 (budget/dup-label/order/watermark), §3.4 (UPDATE_CLASS)
estimate: L
---

## Summary

Implements the HANDLERS for the design-system tool group (Contract 13 §1.4) and attaches them to the WP-F04 registry: global classes (`design.classes.list/upsert/delete/reorder/usage`), variables (`design.variables.list/create/update/delete/restore/batch`), V3 globals (`design.globalColors.*`/`design.globalFonts.*`), element defaults (`design.element_defaults.get/set`), `design.sync_v4_to_v3`, `design.deploy`. The flagship complexity is the diff-based class PUT: the TS side BUILDS the exact `{changes,items,order}` body, pre-flights the 1000-item budget, and reconciles `DUPLICATED_LABEL` soft remaps. Gated on `UPDATE_CLASS` (probed; granted by WP-P01 activation).

## Interface / Contract

Attaches `ToolHandler`s; schemas owned by WP-F04 (Contract 13 §1.4). Highlights (full set = all §1.4 tools):

- `design.classes.list` ★ (R) — `{context?,...page}` → `{items:GlobalClassObject[],order[],next_cursor,total}`.
- `design.classes.upsert` ★ (M, `PUT /design/classes` diff-PUT) — `{added?,modified?}` → `{ok,order[],modifiedLabels?,total_count}`. Requires UPDATE_CLASS.
- `design.classes.delete` (D, diff-PUT `changes.deleted`) — `{ids[],confirm?}` → `{success,order[]}`. Elicitation.
- `design.classes.reorder` (M) — `{order[]}` → `{success}`.
- `design.classes.usage` (R) — `{id?,...page}` → `{items[],next_cursor,total}`.
- `design.variables.list` ★ (R) — `{...page}` → `{items[],watermark,next_cursor,total}`.
- `design.variables.create` (M) — `{type,label,value}` → `{variable,watermark}`. All 3 types FREE.
- `design.variables.update` (M) — `{id,label?,value?,watermark}` → `{watermark}`.
- `design.variables.delete` (D) — `{id,watermark,confirm?}` → `{watermark}`. Elicitation.
- `design.variables.restore` (M) — `{id,watermark}` → `{watermark}`.
- `design.variables.batch` (M) — `{watermark,operations[]}` → `{watermark,results[]}`.
- `design.globalColors.list/upsert/delete`, `design.globalFonts.list/upsert/delete` (R/M/D).
- `design.element_defaults.get/set` (R/M).
- `design.sync_v4_to_v3` (M) — `{variable_id}` → `{success}`.
- `design.deploy` (D, BOTH) — `{globalClasses?,globalVariables?,confirm?}` → `{success,classes_order[],variables_watermark,modifiedLabels?}`. Requires UPDATE_CLASS. Elicitation.

`design-classes-diff.ts` exports `buildClassesDiff({added,modified,deleted,currentItems,currentOrder}): {context,changes,items,order}` — constructs the EXACT Contract 10 §4.2 body.

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ToolHandler`; `ctx.elicit`; `ctx.capabilities` for `can_update_class`). Code.
- WP-F02 (`WpRoutes`: `listClasses`,`putClasses`,`classesUsage`,`listVariables`,`createVariable`,`updateVariable`,`deleteVariable`,`restoreVariable`,`batchVariables`,`getGlobalColors`/`putGlobalColors`,`getGlobalFonts`/`putGlobalFonts`,`getElementDefaults`/`putElementDefaults`,`syncV4ToV3`,`deployDesign`). Code via `ctx.wp`.
- WP-F03 (`GlobalClassObject`/`StyleDefinition`/`StyleVariant` + envelope builders). Code.
- WP-T03 (`mintOpId`/`isReplay`/`summarizeDiff`). Code.
- WP-F04 (catalog + `attachHandler`), WP-F05 (`toMcpResult`; `Capabilities` for `can_update_class`). Code.
- WP-P03 (PHP `dry_run` validator) — MANDATORY WRITE dependency (class variants validated as styles; `E_STYLE_INVALID`, Contract 10 §4.2).
- WP-P08 (PHP design CLASSES controller) + WP-P09 (PHP design VARIABLES/globals controller) — runtime counterparts (contract dependency).
- WP-P05 (CSS_Primer) + WP-S01 — MANDATORY atomic-CSS: design writes auto-flush cache PHP-side (Contract 10 §0.12) and class variant changes affect atomic CSS rendering (locked: design-system WPs are atomic-CSS-affecting).
- WP-S05 (UPDATE_CLASS presence spike) — gates `design.classes.*`/`design.deploy`; cap granted by WP-P01 but MUST be probed (Contract 15 §6).
- Contract 13 §1.4, §0.6 (pagination), §0.8. Contract 10 §4.1 (list+full order), §4.2 (NORMATIVE diff-PUT), §4.4 (variables FREE+watermark+limits), §4.5 (V3 globals), §4.6 (defaults), §4.7 (sync), §4.8 (deploy all-or-nothing). Contract 12 §3.3/§3.4.

## Detailed Requirements

1. Attach handlers for all §1.4 tools; ★ members: `design.classes.list`,`design.classes.upsert`,`design.variables.list` (Contract 13 §5.2).
2. `design.classes.upsert`: GET current ids+full `order` (`listClasses`) FIRST (Contract 10 §4.1 required before PUT) → `buildClassesDiff` → exact §4.2 body (`items` touched-only, `order` full+consistent, deletion never by omission). Client-side budget pre-flight (`existing−deleted+added ≤ 1000`) → fast `BUDGET_EXCEEDED`; PHP also pre-flights. Surface `modifiedLabels` (DUPLICATED_LABEL soft remap) so the agent rebinds (Contract 12 §3.3).
3. Gate `design.classes.*`/`design.deploy` on `ctx.capabilities.get().can_update_class`; false → `CAPABILITY_MISSING` isError with actionable message BEFORE REST (Contract 13 M6). Probe required despite the activation grant (S5).
4. `classes.delete`: diff body with `changes.deleted` + consistent `order`; destructive → elicitation. `classes.reorder`: full final `order` only.
5. Variables: ALL THREE types FREE — `design.variables.create` must NOT Pro-gate `global-size-variable` (Contract 10 §4.4 / `variables/hooks.php:48-51`). Enforce client limits (id≤64,label≤50,value≤512) as fast pre-checks. Watermark-guarded; stale → `WATERMARK_STALE` (retryable; re-read, no auto-retry). `variables.batch` ops `create|update|delete|restore|reorder` atomic on one watermark.
6. V3 globals: `globalColors.*`/`globalFonts.*` on kit repeaters; delete destructive. `element_defaults.get/set` per-widget kit defaults.
7. `design.deploy` (BOTH): `buildClassesDiff` → `deployDesign` (classes + variables in one transaction, all-or-nothing budget pre-flight, Contract 10 §4.8); destructive → elicitation; requires UPDATE_CLASS.
8. Every design write auto-flushes cache PHP-side (Contract 10 §0.12) — no separate cache call; document atomic-CSS-affecting nature. Pagination on list tools. Errors per Contract 12 §5; arg errors `-32602`. No `any`.

## Implementation Notes

- `design-classes-diff.ts` is split into its own (disjoint) file so the body builder is exhaustively unit-testable; it NEVER deletes by omission and ALWAYS emits a full consistent `order` (Contract 10 §4.2 / `global-classes-rest-api.php:357,366-372`).
- `GlobalClassObject` = `StyleDefinition`-shaped `{id,label,type:'class',variants[]}`; reuse WP-F03 types + `StyleVariant` builders.
- Budget pre-flight is BOTH client (fast) + server (authoritative).
- `DUPLICATED_LABEL` is a 200 soft outcome — surface `modifiedLabels` informationally + instruct rebinding.
- Watermark: read from `variables.list`, pass on every write; `WATERMARK_STALE` → re-read, agent retries (no auto-retry, Contract 12 §5 rule 3).

## Acceptance Criteria

- [ ] Handlers attached for all §1.4 tools; ★ match §5.2.
- [ ] `design.classes.upsert` GETs order first, builds the exact §4.2 diff (items touched-only, order full+consistent, no delete-by-omission), pre-flights budget, surfaces `modifiedLabels`.
- [ ] `design.classes.*`/`design.deploy` gate on `can_update_class` with `CAPABILITY_MISSING` when absent.
- [ ] `design.variables.create` does NOT Pro-gate size; client limits enforced; watermark-guarded with `WATERMARK_STALE`.
- [ ] `design.deploy` all-or-nothing budget pre-flighted + elicitation-gated.
- [ ] List tools paginate; design writes documented cache-auto-flushing + atomic-CSS-affecting.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `tools/design-classes-diff.test.ts`: exhaustive `buildClassesDiff` (add/modify/delete/reorder permutations); items touched-only, order full+consistent, budget pre-flight, INVALID_ORDER guard.
- `tools/design.test.ts` (vitest, no WP): mock `ctx.wp`/capabilities/elicit; assert UPDATE_CLASS gating; FREE size variable; watermark threading + `WATERMARK_STALE` no-auto-retry; `DUPLICATED_LABEL` soft; deploy elicitation + all-or-nothing.

## Parallelization Notes

- Owns `tools/design.ts` + `tools/design-classes-diff.ts` + tests — disjoint from every other `tools/*`.
- Phase v1, Wave 2+; integration blocked on S1 + S5 + WP-P03/P05/P08/P09. Parallel-safe with all other handler WPs.
