---
id: WP-P04
title: Core write services — Document_Writer (transactional save), Id_Service, Backup_Service
layer: php
phase: MVP
status: planned
depends_on: [WP-P01, WP-P02, WP-P03]
files_owned:
  - plugin/elementor-ultra-mcp/includes/core/class-document-writer.php
  - plugin/elementor-ultra-mcp/includes/core/class-id-service.php
  - plugin/elementor-ultra-mcp/includes/core/class-backup-service.php
contract_refs:
  - spec/contracts/10-rest-api.md §0.8 (op_id/base_hash/locking), §2.6 (save/replace-tree behaviour), §2.8 (backup/rollback), §10 (ids)
  - spec/contracts/11-authoring-contract.md §8.1 (id handling), §10 (never raw-write _elementor_data)
  - spec/contracts/12-error-taxonomy.md §3.2 (concurrency codes), §3.5 (CSS_PRIME_FAILED, NOT_EDITABLE)
  - spec/contracts/15-engineering-standards.md §3.5, §3.7, §3.8 (transactional writes, never raw-write, revision-independent backup)
estimate: L
---

## Summary

The transactional write core every WRITE route routes through. `Document_Writer` performs the locked sequence: lock/autosave check → optional backup → id mint/dedupe → AUTHORITATIVE validate → single `Document::save(['elements','settings'])` → embed `op_id` → return new base_hash + diff + backup handle. `Id_Service` mints/dedupes/remaps 7-hex element ids and rewrites local-style backrefs. `Backup_Service` takes revision-independent snapshots and restores them. No route logic here — these are the services WP-P06 (documents) and other write controllers call.

## Interface / Contract

- `\Elementor\Ultra\Core\Document_Writer`:
  - `save( int $post_id, array $args ): array|WP_Error` where `$args` = `{ elements?, settings?, base_hash?, op_id?, force?:bool, backup?:bool=true, prime_css?:bool=false }`. Returns the Contract 10 §2.6 `data` payload:
    ```
    { id, diff, base_hash, preview_url, backup_handle, css_primed, prime_required, remapped_ids, idempotent_replay, op_id }
    ```
    or a `WP_Error` (409/422/404/403). `css_primed`/CSS priming is delegated to WP-P05 `Css_Primer` when `prime_css:true` (Document_Writer calls it; if the primer fails it returns `css_primed:false` + a warning, NOT a hard error — Contract 10 §2.7).
  - `replace_tree( int $post_id, array $args ): array|WP_Error` — same, but `elements` and `base_hash` are REQUIRED (Contract 10 §2.6).
  - `apply_settings_merge( int $post_id, array $patch, ?string $base_hash, ?string $op_id ): array|WP_Error` — GET-merge-PUT page settings (Contract 10 §2.5; spike S4 — implemented as deep-merge regardless of `save_settings` merge behavior). Returns `{success, settings}`.
  - `is_editable( int $post_id ): true|WP_Error` — wraps `Document::is_editable_by_current_user()`; `WP_Error('NOT_EDITABLE',...,403)` (Contract 12 §3.5).
  - `lock_status( int $post_id ): array` — `{locked, locked_by, newer_autosave, autosave_ts, autosave_author}` (used by the lock-status route + the pre-write check).
- `\Elementor\Ultra\Core\Id_Service`:
  - `mint(): string` — 7-hex id `substr(strtolower(dechex(wp_rand(0,PHP_INT_MAX))),0,7)` (Contract 11 R3, §8.1; `includes/utils.php:373-375`).
  - `used_ids( int $post_id ): array{ ids, local_style_ids }` — flatten an existing document (Contract 10 §10 `GET /documents/{id}/ids`).
  - `validate_tree( array $elements, int $against_post_id = 0 ): array{ valid, collisions, duplicate_local_styles }` (Contract 10 §10 `POST /ids/validate`).
  - `remap_tree( array $elements, int $against_post_id = 0 ): array{ elements, remapped }` — regenerate colliding ids AND rewrite local-style backrefs in `styles` map keys + `settings.classes.value` + `styles[].id` (mirror `styles-ids-modifier.php`); also used internally by `save` to dedupe before write (Contract 10 §10, §2.6 step 4; Contract 11 §8.1).
  - `dedupe_for_insert( array $elements, array $existing_ids ): array{ elements, remapped }` — replace ALL ids on clone/insert of a library block (Contract 11 §8.1; mirror `document.php:1641-1654`).
- `\Elementor\Ultra\Core\Backup_Service`:
  - `snapshot( int $post_id, ?string $label = null, ?string $op_id = null ): array{ meta_key, revision_id, ts, label, base_hash }` (Contract 10 §2.8).
  - `list_backups( int $post_id ): array` — paginated items `{meta_key, ts, label, base_hash}`.
  - `rollback( int $post_id, string $meta_key, bool $prime_css = false ): array|WP_Error` — restore `_elementor_data` + `_elementor_page_settings`, delete CSS/cache, regen (Contract 10 §2.8). Returns `{id, restored_from, base_hash, css_primed}`.

## Dependencies & Inputs

- WP-P01 (`Guards`), WP-P02 (`Abstract_Controller::current_base_hash`/`assert_base_hash` helpers and `Error` factory — Document_Writer reuses these for concurrency checks), WP-P03 (`Validator::validate_only` — called before every persist; this is the universal "every WRITE WP depends on the dry_run validator WP" rule).
- WP-P05 (`Css_Primer`) is a SOFT dependency: `save(prime_css:true)` and `rollback(prime_css:true)` call `Css_Primer::prime()` behind a `class_exists` guard. The writer must build and pass tests with priming stubbed (returns `css_primed:false` + `prime_required:true`) so it does not hard-block on WP-P05.
- Elementor APIs (cite `path:line`):
  - `\Elementor\Plugin::$instance->documents->get( $post_id )->save( ['elements'=>..., 'settings'=>...] )` — `core/base/document.php:795-893` (the ONLY persist path; deletes `_elementor_css` + cache at `:867,872`).
  - `Document::is_editable_by_current_user()` `:666`; `Document::get_newer_autosave()` `:556`.
  - `wp_check_post_lock( $post_id )` (WP core) for the edit-lock holder.
  - `wp_save_post_revision( $post_id )` for the revision half of the backup.
  - id mint regex source: `core/utils.php`/`includes/utils.php:373-375` (`substr(strtolower(dechex(...)),0,7)`).
  - export id replacement reference: `core/base/document.php:1641-1654`.
- Contract 10 §0.8 (op_id/base_hash/locking semantics — the writer implements them), §2.6 (the exact step sequence + response payload), §2.5 (settings merge), §2.8 (backup/rollback), §10 (id routes back this service).
- Contract 11 §10 (NEVER raw-write `_elementor_data`; always via `Document::save`), §8.1 (id handling).

## Detailed Requirements

1. **Locked write sequence** (Contract 10 §2.6, Contract 15 §3.7) — for `save`/`replace_tree`:
   1. `is_editable($post_id)` → 403 `NOT_EDITABLE` if not.
   2. Lock/autosave check unless `force:true`: `wp_check_post_lock` → 409 `LOCK_HELD` (`meta.locked_by`); `get_newer_autosave` → 409 `AUTOSAVE_CONFLICT` (`meta.autosave_ts/autosave_author`). The plugin NEVER acquires the editor lock on a programmatic save (Contract 10 §0.8).
   3. `base_hash` check (when supplied) via WP-P02 `assert_base_hash` → 409 `CONCURRENCY_STALE_HASH`. REQUIRED for `replace_tree`, optional for `save`.
   4. **Idempotency** (Contract 10 §0.8): if `op_id` supplied AND the document's `editor_settings._emcp_op_id` already equals it AND state already reflects it, return the prior result with `idempotent_replay:true` and DO NOT re-apply.
   5. If `backup:true` (default), `Backup_Service::snapshot()` BEFORE write.
   6. `Id_Service::remap_tree()` to mint/dedupe ids (collisions within tree + against existing doc) → record `remapped_ids`.
   7. `Validator::validate_only($elements,$settings)` (AUTHORITATIVE) → on failure return 422 with `errors[]`, WRITE NOTHING (Contract 10 §0.9).
   8. Embed `op_id` into the settings payload as `editor_settings._emcp_op_id` (so it threads into `Document::save`).
   9. SINGLE `Document::save(['elements'=>..., 'settings'=>...])`. Never two partial saves (Contract 15 §3.7).
   10. Compute new `base_hash`; build `diff` (reuse WP-P03 `Diff_Builder`); if `prime_css:true` call `Css_Primer::prime()` (else `css_primed:false`, `prime_required:true`).
   11. Write an op-log row via WP-P14's store (behind `class_exists` guard).
2. **`replace_tree`** requires `elements` + `base_hash`; otherwise identical sequence (Contract 10 §2.6).
3. **Settings merge** (Contract 10 §2.5, spike S4): `apply_settings_merge` reads full `_elementor_page_settings`, deep-merges the patch (patch wins per key; arrays replaced wholesale unless they are keyed repeaters — keep it simple: scalar/object deep-merge, top-level array replace), and writes via `Document::save(['settings'=>$merged])`. Guarantees partial updates never wipe unrelated keys regardless of `Document::save_settings()` merge-vs-replace behavior.
4. **Id_Service.mint/remap** (Contract 11 §8.1, §10): mint with the exact 7-hex formula; dedupe against a live set; `remap_tree` regenerates ONLY colliding ids and rewrites all local-style backrefs — the `styles` map is keyed by style id, and that id ALSO appears in `settings.classes.value` and as `styles[id].id`; all three must be rewritten consistently (mirror `styles-ids-modifier.php`). `dedupe_for_insert` regenerates ALL ids (cross-document insert safety).
5. **Backup_Service** (Contract 10 §2.8, Contract 15 §3.8): snapshot copies `_elementor_data` + `_elementor_page_settings` into a single meta `_emcp_backup_{ts}` (store as `{data, settings, ts, label, base_hash, op_id}` JSON) AND calls `wp_save_post_revision`. Both because agency sites often set `WP_POST_REVISIONS=false`. `list_backups` enumerates `_emcp_backup_*` meta keys (newest first). `rollback` writes the snapshot back via `Document::save(['elements'=>$data,'settings'=>$settings])` (NOT raw meta — Contract 11 §10), deletes CSS/cache (delegated to WP-P05 `Cache_Service` behind a guard, else `Post_CSS::create($id)->delete()`), and regenerates (V3 `Post_CSS::create($id)->update()`; V4 `Css_Primer::prime` when `prime_css:true`). Returns the new base_hash.
6. **Never raw-write `_elementor_data`** (Contract 11 §10, Contract 15 §3.5): the only persist path is `Document::save`. Snapshots may READ raw meta but restores go through `Document::save`.
7. **Trash-doc safety for backups**: `_emcp_backup_*` meta persists across writes; provide a `prune( int $post_id, int $keep = 20 )` to cap backup count (avoid meta bloat). Called by `snapshot` after creating a new one.
8. **`prime_required` flag**: when the saved tree contains any atomic node and priming was not done in-request, set `prime_required:true`, `css_primed:false` (Contract 10 §0.10). For an all-V3 tree, `prime_required:false`.

## Implementation Notes

- `editor_settings._emcp_op_id`: `editor_settings` is part of the document settings bucket; embedding the op_id there persists it with the save so a replay can detect prior application. Verify the key survives `Document::save_settings`; if it gets stripped, fall back to a dedicated post meta `_emcp_last_op_id` (still set inside the same save transaction is not possible — set it immediately after the successful save).
- The lock check is advisory: core `Document::save` ignores `wp_check_post_lock` (Contract 10 §0.8), so the writer must enforce it itself BEFORE saving, and honor `force` to override.
- Deep-merge for settings: use a recursive array merge where scalar keys overwrite and nested assoc arrays merge; do NOT array_merge_recursive (it duplicates scalars). Repeater arrays (numeric-indexed) should be replaced wholesale by the patch when present.
- `Css_Primer` and `Cache_Service` and the op-log store are all SOFT (guarded) deps so this WP builds independently; the contract dependency is one-directional (the writer USES the primer). WP-P05 lists no dependency back on this WP.
- Keep `save` re-entrant-safe: do not register WP hooks that recurse into save.

## Acceptance Criteria

- [ ] `save` of a valid tree on an unlocked post persists via a SINGLE `Document::save`, returns a fresh `base_hash`, `diff`, `backup_handle`, and `idempotent_replay:false`.
- [ ] A `save` whose tree fails `Validator::validate_only` returns 422 and `_elementor_data` is UNCHANGED (write-nothing-on-invalid).
- [ ] A `save`/`replace_tree` with a stale `base_hash` returns 409 `CONCURRENCY_STALE_HASH`; with `force:true` it proceeds.
- [ ] A locked post returns 409 `LOCK_HELD`; a newer autosave returns 409 `AUTOSAVE_CONFLICT`; both overridable by `force`.
- [ ] Re-running `save` with the same `op_id` returns `idempotent_replay:true` and does NOT double-apply.
- [ ] `Id_Service::remap_tree` resolves intra-tree and against-document id collisions AND keeps `styles` map keys, `styles[].id`, and `settings.classes.value` consistent after remap.
- [ ] `Backup_Service::snapshot` creates both an `_emcp_backup_{ts}` meta and a WP revision; `rollback` restores both `_elementor_data` and `_elementor_page_settings` via `Document::save` (not raw meta) and yields a new base_hash.
- [ ] `apply_settings_merge` patches one key without wiping unrelated page-settings keys.
- [ ] An all-V3 save reports `prime_required:false`; an atomic save with `prime_css:false` reports `prime_required:true`,`css_primed:false`.
- [ ] No code path writes `_elementor_data` except via `Document::save` (grep + test).
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_save_single_transaction_and_base_hash`; `test_save_invalid_writes_nothing`; `test_stale_base_hash_409`; `test_force_overrides_lock`; `test_idempotent_replay`; `test_remap_keeps_local_style_backrefs`; `test_snapshot_meta_and_revision`; `test_rollback_restores_via_document_save`; `test_settings_merge_preserves_unrelated_keys`; `test_prime_required_flag_for_atomic_vs_v3`.
- Consumes `trees/v4/valid/**` fixtures for the happy-path save+round-read.

## Parallelization Notes

- Wave-1 core service. Parallel-safe with WP-P03 (validator) and WP-P05 (css/cache) — disjoint files. Lists WP-P03 as a hard dependency (validator-before-persist, universal rule). WP-P05 is a soft/guarded dependency so this WP need not wait on it to build.
- Every WRITE controller (WP-P06 documents, WP-P08/P09 design, WP-P11 nav, WP-P12 templates, WP-P15 batch) and the Pro WPs (WP-R##) call `Document_Writer`/`Id_Service`/`Backup_Service`; they depend on this WP's frozen interface and do not edit its files.
- Owns the three core write-service files exclusively; disjoint from all controllers and from WP-P05's primer/cache files.

## Spike-Verified Corrections (Wave 1)

- **[S01]** Headless `Document::save(['elements'=>$tree,'settings'=>...])` writes `_elementor_data` (local style id + global class ref) and auto-populates the global-class relations meta (`_elementor_used_global_class[_preview]` via `elementor/document/after_save`), but emits ZERO front-end atomic CSS. The writer MUST therefore trigger an explicit CSS prime after a save of an atomic document — never rely on the save alone to produce styled output. (Prime mechanics live in WP-P05; this WP must invoke them.)
- **[S01]** `Document::save()` first guards on `is_editable_by_current_user()` and silently returns FALSE writing nothing when there is no capable current user. The writer MUST run as the authenticated App-Password user (the REST handler already does); any CLI/test path MUST `wp_set_current_user(<admin/capable id>)` first or the save no-ops.
- **[S01/R5]** Local-style ids are NOT stable across save — Elementor regenerates element ids AND their dependent local-style ids (`e-<newElementId>-<rand>`) on every save (the atomic `replace_id` listener keeps the `settings.classes.value` mirror in sync). The writer MUST NOT cache, return, or assume any local-style id survives a save; it MUST re-read ids from the saved document after the write.
- **[R9]** The unstyled "residual" only affects consumers that read/serve the page WITHOUT triggering a front-end render (headless save-then-read, snapshot/export, CDN edge capture). A normal first front-end GET BOTH writes and links the CSS in the same response, so this is hard to reproduce manually — the writer must rely on the explicit prime step, not on first-visit rendering, and document the residual.
