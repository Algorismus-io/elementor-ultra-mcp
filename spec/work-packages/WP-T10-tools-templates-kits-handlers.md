---
id: WP-T10
title: TS tool handlers — templates / kits (list, get, save, import, insert_into_page, kit export/import/revert)
layer: ts
phase: v1
status: planned
depends_on: [WP-F01, WP-F02, WP-F03, WP-F04, WP-F05, WP-T01, WP-T03, WP-P03, WP-P05, WP-P12, WP-P13, WP-S01, WP-S02]
files_owned:
  - packages/server/src/tools/templates.ts
  - packages/server/src/tools/templates.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §1.7 (templates/kits)
  - spec/contracts/10-rest-api.md §7 TEMPLATES/KITS, §10 IDS
  - spec/contracts/11-authoring-contract.md §4.6 (id replacement on insert)
  - spec/contracts/12-error-taxonomy.md §3.5 (IMPORT_REMAP_FAILED), §5
estimate: M
---

## Summary

Implements the HANDLERS for the templates/kits tool group (Contract 13 §1.7) and attaches them to the WP-F04 registry: `templates.list/get/save/import/insert_into_page`, `kit.export/import/revert`. `templates.save` validates content through the authoritative validator (PHP) and persists via `Source_Local::save_item` (ids regenerated); `templates.insert_into_page` mints FRESH ids on paste and runs validate+save+prime. Kit import/revert are destructive + elicitation-gated. Atomic-V4 template correctness is spike-gated on S2.

## Interface / Contract

Attaches `ToolHandler`s; schemas owned by WP-F04 (Contract 13 §1.7):

- `templates.list` (R, `GET /templates`) — `{type?,...page}` → `{items[],next_cursor,total}`.
- `templates.get` (R, `GET /templates/{id}`) — `{template_id}` → `{content[],page_settings,type}`.
- `templates.save` (M, `POST /templates`) — `{title,type,content[],page_settings?}` → `{template_id,edit_url}`.
- `templates.import` (M, `POST /templates/import`) — `{file_path?,content?,import_mode?}` → `{template_id,remapped_ids}`.
- `templates.insert_into_page` (M, `POST /templates/{id}/insert`) — `{post_id,template_id?,content?,parent_id?,index?,base_hash}` → `{diff,base_hash}`.
- `kit.export` (R, `POST /kit/export`) — `{include[],kitInfo?,customization?}` → `{file_path,session}`.
- `kit.import` (D, `POST /kit/import`) — `{session?,file?,include[],customization?,confirm?}` → `{session,imported}`. Elicitation.
- `kit.revert` (D, `POST /kit/revert`) — `{session,confirm?}` → `{success}`. Elicitation.

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ToolHandler`; `ctx.elicit`). Code.
- WP-F02 (`WpRoutes`: `listTemplates`,`getTemplate`,`saveTemplate`,`importTemplate`,`insertTemplate`,`kitExport`,`kitImport`,`kitRevert`,`getDocumentIds`). Code via `ctx.wp`.
- WP-F03 (`dedupeTree`/`mintId` for fresh ids on insert; `prefilter`; node types). Code.
- WP-T03 (`presentDiff`/`mintOpId`/`isReplay`). Code.
- WP-F04 (catalog + `attachHandler`), WP-F05 (`toMcpResult`). Code.
- WP-P03 (PHP `dry_run` validator) — MANDATORY WRITE dependency: `templates.save`+`insert_into_page` validate before persisting (Contract 10 §7 / §0.9).
- WP-P05 (CSS_Primer) + WP-S01 — MANDATORY atomic-CSS: `insert_into_page` saves an atomic subtree + primes CSS (Contract 10 §0.10); `css_primed` reported.
- WP-P12 (PHP templates/kits controller) + WP-P13 (PHP cache/IDs controller — for `getDocumentIds`) — runtime counterparts.
- WP-S02 (template-library atomic save spike) — gates `templates.save`/`insert_into_page`/`import` atomic correctness (Contract 15 §6 / Contract 13 §6).
- Contract 13 §1.7, §0.6 (pagination), §0.8 (base_hash on insert). Contract 10 §7 (Source_Local::save_item ids regenerated; import sideload+id-remap+merge globals; insert FRESH ids; kit export/import/revert), §10 (used-id set). Contract 11 §4.6 (replace ALL ids on insert). Contract 12 §3.5.

## Detailed Requirements

1. Attach handlers for all eight §1.7 tools; none are ★ (Contract 13 §5.2).
2. `templates.save`: run cheap `prefilter` on `content` → `POST /templates` (PHP validates authoritatively + `Source_Local::save_item` regenerates ids). Return `{template_id,edit_url}`. Atomic correctness gated on S2.
3. `templates.insert_into_page`: requires `base_hash` (element write). Either `template_id` OR inline `content`. Obtain the live document used-id set via `getDocumentIds` (`/documents/{id}/ids`, Contract 10 §10) → `dedupeTree` to mint FRESH ids over the inserted subtree (replace ALL ids on insert, Contract 11 §4.6) incl. local-style mirrors, so a paste cannot collide. Run validate+save; route primes CSS for atomic subtrees; surface `css_primed`. Return `presentDiff(diff)`+new `base_hash`.
4. `templates.import`: one of `file_path`/`content`; `import_mode` `match_site|keep_existing`; PHP sideloads images + remaps ids + merges global classes/variables (S2-adjacent). Surface `remapped_ids`; remap failure → `IMPORT_REMAP_FAILED` (Contract 12 §3.5).
5. Kit import/revert destructive → elicitation when `confirm!=true`; decline → clean non-error. `kit.export` read-only.
6. `templates.list` paginates with a `type` filter. Errors per Contract 12 §5; arg failures `-32602`. No `any`.

## Implementation Notes

- Fresh-id minting on insert (Contract 11 §4.6) is critical: the same template inserted twice into one page must not duplicate ids. Use the document used-id set + `dedupeTree` so the inserted subtree's ids + local-style mirrors are unique.
- `templates.save` ids regenerate PHP-side; the TS pre-filter still gives fast feedback.
- Kit ops are heavy/PHP-orchestrated; tools are thin proxies + elicitation gating.
- S2 gate: until S2 passes, atomic template save/insert correctness is unverified — the tool ships but its integration test is `xfail`/`skip` (Contract 15 §6); document the gate.

## Acceptance Criteria

- [ ] Handlers attached for all eight §1.7 tools.
- [ ] `templates.save` pre-filters then persists (ids regenerated PHP-side).
- [ ] `insert_into_page` requires base_hash, mints FRESH ids over the subtree (no collisions), validates+saves+primes, returns `{diff,base_hash}`(+css_primed).
- [ ] `import` surfaces `remapped_ids`; remap failure → `IMPORT_REMAP_FAILED`.
- [ ] `kit.import`/`kit.revert` elicitation-gated; `kit.export` read-only.
- [ ] `templates.list` paginates with `type`.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `tools/templates.test.ts` (vitest, no WP): mock `ctx.wp`/elicit; assert I/O shapes; `insert_into_page` fresh-id minting against a used-id set; remap-failure rendering; kit elicitation + decline; pagination.

## Parallelization Notes

- Owns only `tools/templates.ts` + test — disjoint from every other `tools/*`.
- Phase v1, Wave 2+; integration blocked on S2 + S1 + WP-P03/P05/P12/P13. Parallel-safe with all handler WPs.
