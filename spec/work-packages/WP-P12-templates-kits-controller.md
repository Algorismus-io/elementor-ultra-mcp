---
id: WP-P12
title: Templates & Kits REST controller (library list/get/save, import, insert-into-page, kit export/import/revert)
layer: php
phase: v1
status: planned
depends_on: [WP-P02, WP-P03, WP-P04, WP-P05, WP-P10, WP-S01, WP-S02]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-templates-controller.php
contract_refs:
  - spec/contracts/10-rest-api.md §7 (TEMPLATES/KITS routes), §0.9 (validate-before-save), §0.10 (priming), §0.11 (pagination)
  - spec/contracts/11-authoring-contract.md §8.1 (replace-all-ids on insert)
  - spec/contracts/12-error-taxonomy.md §3.1 (ATOMIC_*), §3.5 (IMPORT_REMAP_FAILED, NOT_FOUND)
estimate: L
---

## Summary

The reusable-template and kit surface: list/get/save library templates, import .json/.zip (sideload images + remap ids + merge global classes/variables), insert a block into a page with FRESH ids, and full-site kit export/import/revert. Template saves and inserts go through the AUTHORITATIVE validator + the writer + prime-css; atomic-V4 template correctness is spike-gated on WP-S02 (and S1 for priming inserted atomic content).

## Interface / Contract

Registers (Contract 10 §7):

- `GET /templates` (CAP_READ) — `{items:[{template_id,title,type}],next_cursor,total}`; `type?`, pagination. (§7)
- `GET /templates/{id}` (CAP_READ) — `{template_id,title,type,content,page_settings}`. (§7)
- `POST /templates` (CAP_EDIT_POST) — `{title,type,content,page_settings,op_id}` → `{template_id,type}`; validates content first. (§7)
- `POST /templates/import` (CAP_MANAGE) — `{file_path|content,import_mode,op_id}` → `{imported_ids,warnings}`; sideload + id remap + class/variable merge. (§7)
- `POST /templates/{id}/insert` (CAP_EDIT_POST) — `{post_id,parent_id,index,base_hash,op_id}` OR `{post_id,content,parent_id,index}` → `{success,inserted_ids,base_hash,css_primed}`; FRESH ids. (§7)
- `POST /kit/export` (CAP_MANAGE) — `{include,kitInfo,customization}` → `{download_url,session}`. (§7)
- `POST /kit/import` (CAP_MANAGE) — `{session,file_path,include,customization}` → `{session,imported,warnings}`. (§7)
- `POST /kit/revert` (CAP_MANAGE) — `{session}` → `{reverted}`. (§7)

## Dependencies & Inputs

- WP-P02 (base/perms/pagination/error), WP-P03 (validate content before save/insert — Contract 10 §0.9), WP-P04 (`Id_Service::dedupe_for_insert` for FRESH ids on insert; `Document_Writer` for the page write on insert; `Backup_Service`), WP-P05 (`Css_Primer` for atomic content inserted into a page; `Cache_Service`), WP-P10 (`media/sideload` reused during import to bring images into the library).
- WP-S01 (prime-css for inserted atomic content) + WP-S02 (template-library atomic save correctness via `Source_Local::save_item`; id-remap/merge semantics) — Contract 15 §6 S1/S2 rows.
- Elementor APIs (cite `path:line`):
  - `Source_Local::save_item()` (the library save path that regenerates ids) — `modules/library/.../sources/local.php` (save_item / replace_elements_ids). Atomic correctness here is what S2 verifies.
  - `Plugin::$instance->templates_manager` for list/get/import/export.
  - id replacement on insert/clone reference `core/base/document.php:1641-1654`.
  - kit export/import via the kit-library/import-export module (`modules/import-export`).
- Contract 10 §7 (route shapes), §0.9 (validate-before-save), §0.10 (priming), §0.11 (pagination). Contract 11 §8.1 (replace ALL ids on insert to avoid cross-document collision). Contract 12 (`ATOMIC_*`, `IMPORT_REMAP_FAILED`).

## Detailed Requirements

1. **list/get** (§7): list library templates via `templates_manager`; `type` filter; paginate. `get` returns content + page_settings. CAP_READ.
2. **save** (§7): validate `content` via WP-P03 first (422 `ATOMIC_*` on failure, write nothing — Contract 10 §0.9); save via `Source_Local::save_item` which regenerates ids (S2-gated for atomic). Return `{template_id,type}`. CAP_EDIT_POST.
3. **import** (§7): accept `file_path` or inline `content`; sideload every image (reuse WP-P10 `media/sideload`, dedupe) BEFORE remap; remap ids; merge referenced global classes/variables into the site's design system (via WP-P08/P09 services where present, else the repository) honoring `import_mode` (`match_site`); on a remap/relation failure → 422 `IMPORT_REMAP_FAILED` (Contract 12 §3.5). Return `{imported_ids,warnings}`. CAP_MANAGE. (S2-adjacent.)
4. **insert** (§7): paste a template/block into a page with FRESH ids (replace ALL ids via `Id_Service::dedupe_for_insert`, Contract 11 §8.1) at `parent_id`/`index`; validate; route through `Document_Writer` (single save, base_hash/lock/backup); if the inserted content is atomic, prime CSS (`css_primed` flag, S1). Accept either `{id path}` (insert an existing template) or inline `content`. Return `{success,inserted_ids,base_hash,css_primed}`. CAP_EDIT_POST.
5. **kit export/import/revert** (§7): export builds a kit zip (`include` selects content/templates/settings/global-classes/variables); import uploads + imports with `customization`, returning a `session` handle; revert undoes a prior import session. CAP_MANAGE. Lean MVP may implement export/import as thin wrappers over the import-export module and defer deep customization to ULTRA — but the routes + envelopes must exist and round-trip a simple kit.
6. **op_id + op-log** on every write.

## Implementation Notes

- `Source_Local::save_item` already replaces ids on save; for INSERT you additionally dedupe against the TARGET document's used-id set (Contract 11 §8.1) — `dedupe_for_insert` regenerates all ids, then the writer dedupes against the live doc. Do both: fresh ids first, then the writer's collision check.
- S2 is the gate for atomic-template correctness: until S2 PASS, atomic template save/insert tests run as `xfail`/`skip` with a reason string; V3 template save/insert can be validated immediately.
- Import image sideload MUST precede id remap so the emitted `image-src` can be id-only for internal media (Contract 11 §3.2) — reuse WP-P10's dedupe so re-imports don't duplicate.
- Global-class/variable merge during import: prefer WP-P08 `Global_Classes_Service::apply_diff` + WP-P09 `Variables_Service::batch` (contract deps) so the merge respects budgets/labels; if those services are unavailable at build time, use the repository directly and note it. Do NOT raw-write the `e_global_class` CPT.
- Kit export `download_url` + `session`: use the import-export module's session mechanism; the file should be served via an authenticated URL or a one-time token (no public exposure).

## Acceptance Criteria

- [ ] `GET /templates` lists/paginates; `GET /templates/{id}` returns content+page_settings; missing id → 404.
- [ ] `POST /templates` validates content (422 on invalid, nothing saved) and saves via `Source_Local::save_item` with regenerated ids.
- [ ] `POST /templates/import` sideloads images (deduped), remaps ids, merges classes/variables, and returns `imported_ids`; a remap failure → 422 `IMPORT_REMAP_FAILED`.
- [ ] `POST /templates/{id}/insert` inserts with FRESH ids at the right parent/index via the writer, returns a fresh `base_hash`, and primes CSS for atomic content (S1-gated).
- [ ] `POST /kit/export` → `{download_url,session}`; `POST /kit/import` round-trips a simple kit; `POST /kit/revert` reverts the session.
- [ ] Atomic template save/insert pass once S2 PASS (xfail/skip with reason until then); V3 passes immediately.
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_templates_list_get`; `test_template_save_validates`; `test_template_save_regenerates_ids`; `test_import_sideloads_and_remaps`; `test_import_remap_failure_422`; `test_insert_fresh_ids_and_base_hash`; `test_insert_atomic_primes_css` (S1-gated); `test_kit_export_import_revert_roundtrip`.
- S2-gated atomic template fixtures (xfail/skip until S2 PASS).

## Parallelization Notes

- Wave-2/3 vertical. Owns ONLY `class-templates-controller.php` — disjoint from all other controllers.
- Lists WP-P03/P04/P05 (WRITE + atomic-CSS rules), WP-P10 (sideload reuse), WP-S01 + WP-S02 (spike gates). Consumes WP-P08/P09 design services at the contract level for import merge (no file edits).
- Parallel-safe with every other WP-P##; the only cross-WP code reuse (sideload, design services) is via frozen interfaces.

## Spike-Verified Corrections (Wave 1)

- **[S02]** `templates.insert_into_page` / `templates.import` MUST replicate the editor's TWO-step insert: `Source_Local::get_data($template_id)` (`wp-content/plugins/elementor/includes/template-library/sources/local.php:703` — re-IDs content again AND attaches the `global_classes` snapshot) → `Templates_Manager::process_global_styles({content, global_classes, import_mode})` (`includes/template-library/manager.php:693`, default `import_mode = match_site`) → `Document::save` the processed content. The controller MUST carry the `global_classes` snapshot alongside `content` — calling `save_item` alone will NOT merge classes into the target kit.
- **[S02]** `save_item` (`POST /elementor/v1/template-library/templates`, `includes/template-library/sources/local.php:482`, save at lines 520-525) ONLY re-IDs elements + dependent local-style ids and registers relations — it does NOT merge global classes and does NOT run `on_import`. Image sideload runs ONLY on the FILE-import path (`prepare_import_template_data` → `process_export_import_content('on_import')`, `includes/template-library/sources/base.php:478`). `templates.save` via POST keeps image src as-is; do NOT expect sideloading on save.
- **[S02/R5]** Local-style ids are regenerated on EVERY save (to `e-<newElementId>-<rand>`, mirror in `settings.classes.value` kept in sync). The controller MUST NOT assume any local-style id is stable across save or round-trip; re-read after each save. Failures (bad atomic envelopes, missing snapshot on insert, MAX_ITEMS(1000) overflow → silent flatten reported as `flattened_classes_count`, orphan-ref pruning by `get_data`) MUST surface as `IMPORT_REMAP_FAILED`.
- **[R5]** Merge semantics on insert: `match_site` reuses an existing kit class by LABEL (no duplicate); `keep_create` mints a `g-`-prefixed id and remaps refs via the returned id_map. Use the id_map for global-class id remaps; never reuse incoming ids blindly.
