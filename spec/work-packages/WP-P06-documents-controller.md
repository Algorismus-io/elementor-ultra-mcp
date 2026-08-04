---
id: WP-P06
title: Documents REST controller (CRUD, dry-run, save, replace-tree, granular elements, prime-css, backup/rollback, duplicate, export, lock-status)
layer: php
phase: MVP
status: planned
depends_on: [WP-P02, WP-P03, WP-P04, WP-P05, WP-S01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-documents-controller.php
contract_refs:
  - spec/contracts/10-rest-api.md §2 (all DOCUMENTS routes), §14 (element-op batch), §0.8/§0.9/§0.10 (locking/dry-run/prime)
  - spec/contracts/11-authoring-contract.md §8 (validation), §10 (priming/never-raw-write)
  - spec/contracts/12-error-taxonomy.md §3.1/§3.2/§3.5
estimate: L
---

## Summary

The flagship controller exposing the whole DOCUMENTS surface (Contract 10 §2 + §14): list/create/get, the AUTHORITATIVE `dry-run`, `save`/`replace-tree`, the granular `elements` op batch, `prime-css`, `backup`/`backups`/`rollback`, `duplicate`, `delete`, `export`, `lock-status`, and `ids`. It is thin glue: it parses/validates request args, calls the core services (`Validator`, `Document_Writer`, `Css_Primer`, `Backup_Service`, `Id_Service`), and shapes the §0.5/§0.6 envelopes. No business logic that belongs in a core service is duplicated here.

## Interface / Contract

Registers these routes under `elementor-ultra/v1` (Contract 10 §2, §14, §10 ids):

- `GET /documents` (CAP_READ) — list, paginated; `status?`, `post_type?` (§2.1).
- `POST /documents` (CAP_EDIT_POST) — create blank doc; `{title,post_type,template_type,status,op_id}` (§2.2).
- `GET /documents/{id}` (CAP_READ) — tree + `base_hash`; `depth?`,`subtree_id?`,`projection?` (§2.4).
- `GET /documents/{id}/settings` (CAP_READ); `PUT /documents/{id}/settings` (CAP_EDIT_POST) — GET-merge-PUT (§2.5).
- `POST /documents/{id}/dry-run` (CAP_EDIT_POST) — AUTHORITATIVE; `{id}` may be `0` (§2.3).
- `POST /documents/{id}/save` (CAP_EDIT_POST) (§2.6).
- `POST /documents/{id}/replace-tree` (CAP_EDIT_POST) — `elements`+`base_hash` required (§2.6).
- `POST /documents/{id}/elements` (CAP_EDIT_POST) — granular op batch (§14).
- `POST /documents/{id}/prime-css` (CAP_EDIT_POST) (§2.7).
- `POST /documents/{id}/backup` (CAP_EDIT_POST); `GET /documents/{id}/backups` (CAP_READ); `POST /documents/{id}/rollback` (CAP_EDIT_POST) (§2.8).
- `POST /documents/{id}/duplicate` (CAP_EDIT_POST); `DELETE /documents/{id}` (CAP_EDIT_POST); `POST /documents/{id}/export` (CAP_READ) (§2.9).
- `GET /documents/{id}/lock-status` (CAP_READ) (§2.10).
- `GET /documents/{id}/ids` (CAP_READ) (§10) — used-id set for a document.

Each handler returns `Abstract_Controller::ok($data)` with the exact `data` payload defined per route in Contract 10 §2/§14/§10, or a `WP_Error` from a core service.

## Dependencies & Inputs

- WP-P02 (`Abstract_Controller`, `Permissions`, `Pagination`, `Error`, `read_op_id`, `current_base_hash`).
- WP-P03 (`Validator::dry_run` for the dry-run route; `validate_only` is invoked inside the writer for save paths).
- WP-P04 (`Document_Writer::save`/`replace_tree`/`apply_settings_merge`/`lock_status`; `Id_Service`; `Backup_Service`). This is the universal "every WRITE WP depends on the dry_run validator + writer" rule.
- WP-P05 (`Css_Primer::prime` for the prime-css route and `prime_css:true` chaining; `Cache_Service` for delete-on-rollback).
- WP-S01 (atomic-CSS-affecting routes save/replace-tree/elements/prime-css/rollback depend on the prime-css WP + S1 per the universal rule).
- Elementor APIs (cite `path:line`):
  - `Plugin::$instance->documents->create($type,$post_data,$meta_data)` (create).
  - `Plugin::$instance->documents->get($id)` then `->get_elements_data()` / `->get_settings()` for reads.
  - `get_post_meta($id,'_elementor_data',true)` for `base_hash`/`ids` (READ ONLY).
  - `Document::get_export_data()` / library export for `/export` (incl referenced global classes/variables, §2.9).
  - `wp_trash_post`/`wp_delete_post` for DELETE (§2.9).
  - duplicate id-replacement reference `core/base/document.php:1641-1654`.
- Contract 10 §0.8 (op_id/base_hash/lock), §0.9 (dry-run authoritative), §0.10 (priming), §0.11 (pagination).

## Detailed Requirements

1. **Route registration**: register via the `elementor_ultra/rest/register` action (WP-P02) — do NOT edit the registrar. Each route declares its `permission_callback` from `Permissions` and an `args` schema (types, enums, defaults) so malformed args yield 400 `SCHEMA_INVALID_PARAMS` before the handler runs.
2. **list** (§2.1): query `_elementor_edit_mode='builder'` posts; map `type=_elementor_template_type`; apply pagination + `fields` projection; `status`/`post_type` filters; 400 on bad `status` enum.
3. **create** (§2.2): `documents->create`; derive `template_type` from `post_type` when omitted; return `{id,edit_url,status,type}`. Record op-log + `op_id`.
4. **get** (§2.4): support `depth` (truncate tree), `subtree_id` (return only that subtree), `projection=summary` (`{id,elType,widgetType}` per node only). Always include `base_hash`, `generation`, `type`. This is the primary read used before every edit (clients read `base_hash` here).
5. **settings GET/PUT** (§2.5): GET returns `_elementor_page_settings`; PUT calls `Document_Writer::apply_settings_merge` (GET-merge-PUT, spike S4) and returns the merged settings. Honor `base_hash` on PUT.
6. **dry-run** (§2.3, §0.9): call `Validator::dry_run($elements,$settings,$id,$generation)`. `{id}=0` validates a brand-new tree. On `valid:false` return 422 with the error envelope `errors[]` (the controller converts the validator's `DryRunResult` into the §0.6 envelope). On `valid:true` return the §2.3 success `data` (`valid,errors,diff,preview_url,id_collisions,generation_detected`). When `want_preview:true` and valid, write a per-user autosave + return `preview_url` with the `post_preview_{id}` nonce (the controller owns this; the validator returns `preview_url:null`). Never persist the published tree.
7. **save / replace-tree** (§2.6): delegate to `Document_Writer::save`/`replace_tree`; pass through `prime_css`/`force`/`backup`/`op_id`/`base_hash`. Return the §2.6 `data` payload verbatim (incl `css_primed`,`prime_required`,`remapped_ids`,`idempotent_replay`). The writer validates AUTHORITATIVELY before persisting and writes nothing on failure (§0.9).
8. **elements (granular op batch)** (§14): parse `ops[]` (enum `insert|update_settings|move|delete|set_classes|set_local_style|bind_dynamic|bind_global`); REQUIRE `base_hash`. Read the current tree, apply all ops IN ORDER in memory (a pure transform; the controller may use a small in-file `Element_Ops` applier or call into `Id_Service` for inserts needing fresh ids), then route the resulting whole tree through `Document_Writer::replace_tree`-equivalent (single validate + single save). `set_local_style` upserts the style in the element's `styles` map AND ensures its id is in `settings.classes.value` (Contract 11 §5.1, R4). `bind_dynamic`/`bind_global` write the V3 `__dynamic__`/`__globals__` encodings (Contract 11 §6/§7) — for ATOMIC dynamic the shape is spike-discovered; for MVP the controller may return `E_DYNAMIC_INCOMPATIBLE`/defer atomic dynamic to WP-R## and handle V3 here. Any op failing validation → 422, nothing persisted. Return §14 `data`.
9. **prime-css** (§2.7): delegate to `Css_Primer::prime($id,$approach,$breakpoints)`; return its payload. 200-with-warning when unconfirmed (not an error).
10. **backup/backups/rollback** (§2.8): delegate to `Backup_Service`. `rollback` honors `prime_css`.
11. **duplicate/delete/export** (§2.9): duplicate deep-copies `_elementor_*` meta with FRESH ids via `Id_Service::dedupe_for_insert`; delete trashes (or force-deletes); export emits library-format JSON INCLUDING referenced global classes/variables (read via the design repository helpers — call them read-only; if the design WP's helper is not present, inline a minimal collector).
12. **lock-status** (§2.10) and **ids** (§10): thin wrappers over `Document_Writer::lock_status` and `Id_Service::used_ids`/`validate_tree`. (Note: `POST /ids/validate` and `POST /ids/remap` live in WP-P13's cache/ids controller; `GET /documents/{id}/ids` lives HERE because it is document-scoped.)
13. **op_id / op-log**: every WRITE route reads+validates `op_id` (WP-P02 helper) and records an op-log row (WP-P14 store, guarded).

## Implementation Notes

- The granular `elements` applier is the trickiest part: keep it a pure in-memory tree transform, then hand the FULL resulting tree to the writer so there is exactly ONE `Document::save` (Contract 10 §14 "one Document::save, never N partial saves"). Do not save per-op.
- `want_preview` autosave: use `Plugin::$instance->documents->get($id)->save([... 'settings'=>['post_status'=>'autosave']])` or the WP autosave API; build the preview URL with `get_preview_post_link` + `post_preview_{id}` nonce. Never touch the published `_elementor_data`.
- `export` must include referenced global classes/variables so the block is portable (§2.9). Prefer calling the design controller's repository-backed collectors read-only; if unavailable at build time, read the `e_global_class` posts referenced by the tree's `classes` values directly (read-only) — but note the canonical write/read path is the repository (Contract 15 §3.6).
- For `{id}=0` dry-run, skip `is_editable`/lock checks (there is no post) and pass `post_id=0` to the validator.
- Keep handlers small: parse → service call → envelope. Push any reusable logic into the core services (do not grow this controller into a second writer).

## Acceptance Criteria

- [ ] All 16 document routes (incl `GET /documents/{id}/ids`) are registered under `elementor-ultra/v1` with the correct caps from Contract 10 §15.
- [ ] `dry-run` returns the §2.3 success shape on valid input and a 422 §0.6 envelope with `errors[]` on invalid; `{id}=0` works for new trees.
- [ ] `save` returns the §2.6 payload with correct `css_primed`/`prime_required`/`idempotent_replay`/`remapped_ids`; a failed validation returns 422 and persists nothing.
- [ ] `replace-tree` rejects a request missing `elements` or `base_hash` with 400.
- [ ] `elements` applies an `insert+update_settings+set_local_style` batch in ONE save; `set_local_style` mirrors the style id into `classes`; a bad op yields 422 with nothing persisted.
- [ ] `prime-css` returns the §2.7 payload (200-with-warning when unconfirmed).
- [ ] `backup`→`backups`→`rollback` round-trips and restores the tree.
- [ ] `duplicate` produces a new post with FRESH ids; `delete` trashes by default and force-deletes with `force=true`; `export` includes referenced global classes/variables.
- [ ] `lock-status` and `GET /documents/{id}/ids` return the §2.10/§10 shapes.
- [ ] Contract 14 §3 TS-mirror: the TS `page.dry_run` over REST returns the SAME `expect` as PHP for `trees/**`.
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): one happy-path + one error-path per route group (dry-run valid/invalid, save valid/invalid/stale-hash, replace-tree missing-args, elements batch single-save, prime-css, backup/rollback, duplicate fresh-ids, delete trash/force, export-includes-classes, settings GET-merge-PUT, get subtree/projection, ids).
- Contract suite (mirrored in WP-Q): drive each route over App-Password REST and assert the §0.5/§0.6 envelope shapes.
- Render assertion for save+prime atomic tree (S1-gated, Contract 14 §3 step 3).
- Consumes `trees/**` fixtures.

## Parallelization Notes

- Wave-2 vertical. Owns ONLY `class-documents-controller.php` — disjoint from every other controller and core service.
- Depends on the frozen interfaces of WP-P02/P03/P04/P05; does not edit their files. Lists WP-P03 (validator) + WP-P04 (writer) + WP-P05 (primer) + WP-S01 per the universal WRITE/atomic-CSS rules.
- Parallel-safe with WP-P07..P16 (each owns a different controller file).

## Spike-Verified Corrections (Wave 1)

- **[S04]** The `PUT /documents/{id}/settings` (page.update_settings) handler MUST call `$doc->update_settings($patch)` (which deep-merges via `array_replace_recursive` — see `wp-content/plugins/elementor/core/base/document.php` `update_settings()` ~line 905). It MUST NOT call a bare `$doc->save(['settings'=>$patch])` / `save_settings($patch)` — those REPLACE `_elementor_page_settings` WHOLESALE at top level AND nested (via `update_metadata` in `wp-content/plugins/elementor/core/settings/page/manager.php` `save_settings_to_db()` line 204), silently wiping every unrelated setting. If the controller must build the payload itself it MUST do an explicit GET-merge-PUT mirroring `update_settings()`.
- **[S04]** The handler MUST NOT pass an empty patch through to the save path: an empty (post-strip) settings array causes `delete_metadata` to DELETE the meta entirely (`page/manager.php:204` else-branch). A PUT `{}` must NOT be treated as a no-op; "clear all settings" must be an explicit, separate operation.
- **[S04]** Note that `array_replace_recursive` does NOT element-merge numerically-indexed repeaters — a patch sending a SHORTER repeater list leaves stale trailing rows from the base. Callers wanting to replace a repeater wholesale MUST send the full intended list; document this in the route. Also: special settings (`template`, `post_status`, `post_title`) are stripped before the `_elementor_page_settings` write and round-trip differently — handle them as a distinct concern.
- **[S04]** Any regression/unit test that exercises `save()`/`update_settings()` directly MUST `wp_set_current_user(<admin id>)` first; otherwise `is_editable_by_current_user()` makes the save a silent no-op and the test masks the real semantics.
