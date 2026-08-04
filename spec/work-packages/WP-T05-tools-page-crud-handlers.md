---
id: WP-T05
title: TS tool handlers — page CRUD (create, build, replace_tree, update_settings, dry_run, duplicate, delete, export)
layer: ts
phase: MVP
status: planned
depends_on: [WP-F01, WP-F02, WP-F03, WP-F04, WP-T01, WP-T03, WP-P03, WP-P05, WP-S01]
files_owned:
  - packages/server/src/tools/page.ts
  - packages/server/src/tools/page.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §1.2 (page CRUD), §0.7-§0.9
  - spec/contracts/10-rest-api.md §2.2-§2.9 (documents), §0.9 (dry-run-before-commit), §0.10 (prime-css)
  - spec/contracts/11-authoring-contract.md §1-§4 (authoring + envelopes)
  - spec/contracts/12-error-taxonomy.md §3, §5
estimate: L
---

## Summary

Implements the HANDLERS for the page-CRUD tool group (Contract 13 §1.2) and attaches them to the WP-F04 registry: `page.create`, `page.build`, `page.replace_tree`, `page.update_settings`, `page.dry_run`, `page.duplicate`, `page.delete`, `page.export_template`. `page.build` is the flagship greenfield path (mint+dedupe ids → pre-filter → create→save→prime-css, PHP `dry_run` authoritative). `page.dry_run` surfaces the authoritative validator verdict. Destructive tools gate behind elicitation confirm.

## Interface / Contract

Attaches handlers (`ToolHandler`) via `ctx.registry.attachHandler(name, fn)`; schemas owned by WP-F04 (Contract 13 §1.2):

- `page.create` ★ (M, `POST /documents`) — `{title?,post_type?,template?,status?}` → `{id,edit_url,status,type}`.
- `page.build` ★ (M, BOTH) — `{title,post_type?,elements[],settings?,generation?,status?,op_id?,prime_css?}` → `{id,edit_url,preview_url,diff,base_hash,css_primed,report?}`. TS mints/dedupes ids + pre-filters; proxies create→save→prime-css.
- `page.replace_tree` (D, `POST /documents/{id}/replace-tree`) — `{post_id,elements[],settings?,base_hash,confirm?,force?,prime_css?}` → `{diff,preview_url,base_hash,css_primed}`. Elicitation confirm.
- `page.update_settings` (M, `PUT /documents/{id}/settings`) — `{post_id,settings,base_hash?}` → `{success,settings}`. GET-merge-PUT (S4).
- `page.dry_run` ★ (R, BOTH) — `{post_id?,elements[],settings?,generation?}` → `{valid,errors[],diff?,preview_url?}`. TS pre-filter then PHP authoritative.
- `page.duplicate` (M, `POST /documents/{id}/duplicate`) — `{post_id,title?}` → `{post_id,edit_url}`.
- `page.delete` (D, `DELETE /documents/{id}`) — `{post_id,confirm?,force_delete?}` → `{success,trashed}`. Elicitation confirm.
- `page.export_template` (R, `GET /documents/{id}/export`) — `{post_id}` → `{content[],page_settings,type,version,global_classes?,global_variables?}`.

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ToolHandler`; `ctx.elicit`; `ctx.capabilities` for v4→v3 fallback). Code.
- WP-F02 (`WpRoutes`: `createDocument`,`saveDocument`,`replaceTree`,`dryRun`,`putDocumentSettings`,`duplicateDocument`,`deleteDocument`,`exportDocument`,`primeCss`). Code via `ctx.wp`.
- WP-F03 (`mintId`/`dedupeTree`/`prefilter`/`normalize`/`detectGeneration`/node types). Code.
- WP-T03 (`mintOpId`/`isReplay`/`presentDiff`/`summarizeDiff`). Code.
- WP-F04 (catalog descriptors + `attachHandler`). Code.
- WP-P03 (PHP `dry_run` AUTHORITATIVE validator) — MANDATORY WRITE dependency. `page.build`/`replace_tree`/`dry_run` route through it (Contract 10 §0.9).
- WP-P05 (PHP CSS_Primer) + WP-S01 (headless atomic save + CSS prime spike) — MANDATORY atomic-CSS dependency (`page.build`/`replace_tree` set `prime_css`, report `css_primed`, Contract 10 §0.10; locked rule). NOTE: prime-css is WP-P05 (`class-css-primer.php`), not WP-P04.
- Contract 13 §1.2, §0.7 (diff/base_hash/preview_url), §0.8 (base_hash required on replace_tree; op_id on build; force), §0.9 (input/business error split). Contract 10 §2.2/§2.3/§2.5/§2.6/§2.7/§2.9. Contract 11 (authoring). Contract 12 §3/§5.

## Detailed Requirements

1. Attach handlers for all eight §1.2 tools; ★ members: `page.create`, `page.build`, `page.dry_run` (Contract 13 §5.2).
2. `page.build` pipeline (Contract 13 §1.2 + Contract 10 §0.9):
   a. Probe `ctx.capabilities.get()`; if `generation` defaulted `v4` but `atomic` inactive, FALL BACK to `v3` (locked decision 3) + record a `report.warnings` entry.
   b. `dedupeTree`/`mintId` over `elements` (fresh set); `mintOpId` deterministic if absent.
   c. Cheap `prefilter` (WP-F03); a hard `reject` returns `isError` with structural codes WITHOUT REST (fast feedback); `defer`/`accept` proceed (PHP authoritative).
   d. `createDocument` → `saveDocument({elements,settings,op_id,prime_css,backup})`. PHP runs the AUTHORITATIVE validator internally; writes nothing on 422 → render `ATOMIC_SETTINGS_INVALID`/`ATOMIC_STYLES_INVALID` with parser errors.
   e. If `prime_css` (default true) the save chains prime; else call `primeCss`. Report `css_primed`.
   f. Return `{id,edit_url,preview_url,diff:presentDiff,base_hash,css_primed,report}`; surface `IDEMPOTENT_REPLAY` (WP-T03 `isReplay`).
3. `page.dry_run`: TS `prefilter` first (cheap), then ALWAYS PHP `dryRun` (authoritative) → return `{valid,errors,diff?,preview_url?}`. The WP-F02 `dryRun()` normalizes a 422 invalid into `{valid:false,errors}` — an invalid tree is a SUCCESS result, not `isError` (Contract 13 §1.2). `{id}=0`/no `post_id` validates a new tree (Contract 10 §2.3).
4. `replace_tree` requires `base_hash`; destructive → `ctx.elicit` when `confirm!=true` (flat-primitive schema); decline → clean non-error result. `base_hash` stale → `CONCURRENCY_STALE_HASH`; `force` overrides lock/autosave.
5. `delete` destructive → elicitation; `force_delete` trash-vs-permanent (Contract 10 §2.9).
6. `update_settings` sends the patch; PHP GET-merge-PUT (Contract 10 §2.5, S4) so partial patches never wipe keys.
7. Atomic-CSS writes report `css_primed`; failed prime → `CSS_PRIME_FAILED` (retryable) but NOT a save failure (Contract 10 §2.7).
8. Errors per Contract 12 §5; arg errors `-32602`. No `any`.

## Implementation Notes

- `page.build` is the M1 path (build-a-hero-renders-styled). Prime-css is MANDATORY for V4 (locked decision 7) unless `prime_css:false`.
- V4→V3 fallback only when `atomic` inactive (probe), not as preference. The caller authors per the chosen generation; `page.build` passes `generation`+the tree through.
- The dry_run 422-vs-success nuance lives in WP-F02's `dryRun()`; this handler returns the normalized result.
- Elicitation schema flat primitives only (Contract 13 §0.3); summarize via `summarizeDiff`.

## Acceptance Criteria

- [ ] Handlers attached for all eight §1.2 tools; names + ★ match the catalog/§5.2.
- [ ] `page.build` mints/dedupes ids, pre-filters, v4→v3 fallback when atomic inactive, saves via PHP authoritative validation, primes CSS, returns the full output.
- [ ] `page.dry_run` returns a SUCCESS result for an invalid tree.
- [ ] `replace_tree`/`delete` gate on elicitation when `confirm!=true`; decline → clean non-error.
- [ ] base_hash/lock/autosave → correct taxonomy codes; `force` overrides.
- [ ] Failed prime → `CSS_PRIME_FAILED` without failing the save.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `tools/page.test.ts` (vitest, no WP): mock `ctx.wp`/capabilities/elicit; assert build pipeline ordering + id dedupe + v4→v3 fallback + pre-filter short-circuit; assert dry_run invalid→success; assert elicitation gating + decline; assert error mapping. Round-trip (Contract 14 §7) + render assertion (Contract 14 §3 step 3) are WP-Q suites.

## Parallelization Notes

- Owns only `tools/page.ts` + test — disjoint from every other `tools/*`.
- Wave 2; integration blocked on S1 + WP-P03/WP-P05 (write + atomic-CSS rules). TS builds against frozen routes. Parallel-safe with all other handler WPs.
