---
id: WP-P13
title: Cache & IDs REST controller (cache regen/flush, ids validate/remap)
layer: php
phase: MVP
status: planned
depends_on: [WP-P02, WP-P04, WP-P05, WP-S07]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-cache-controller.php
contract_refs:
  - spec/contracts/10-rest-api.md §9 (CACHE routes), §10 (IDS routes), §0.3 (CAP_MANAGE/CAP_READ)
  - spec/contracts/11-authoring-contract.md §8.1 (id handling), §9 (mint formula)
  - spec/contracts/12-error-taxonomy.md §3.1 (DUPLICATE_ELEMENT_ID)
estimate: S
---

## Summary

Two small read/manage surfaces in one controller: cache regeneration/flush (per-post, global, multisite-network) wrapping `Cache_Service`, and the pure-computation id routes (`ids/validate`, `ids/remap`) wrapping `Id_Service`. The id routes are CAP_READ because they persist nothing — they help the TS client mint collision-free trees before a write.

## Interface / Contract

Registers (Contract 10 §9, §10):

- `POST /cache/regen` (CAP_MANAGE) — `{post_id?,network?,op_id}` → `{regenerated,scope,post_id?}` (omit `post_id` → global, batches 100/run; `network:true` → multisite, spike S7). (§9)
- `DELETE /cache` (CAP_MANAGE) — `{network?}` → `{flushed}` via full `files_manager->clear_cache()`. (§9)
- `POST /ids/validate` (CAP_READ) — `{elements,against_post_id?}` → `{valid,collisions,duplicate_local_styles}`. (§10)
- `POST /ids/remap` (CAP_READ) — `{elements,against_post_id?}` → `{elements,remapped}`; regenerates colliding ids + rewrites local-style backrefs. (§10)

(Note: `GET /documents/{id}/ids` lives in WP-P06, document-scoped; the two POST id routes live HERE.)

## Dependencies & Inputs

- WP-P02 (base/perms/error), WP-P04 (`Id_Service::validate_tree`/`remap_tree`), WP-P05 (`Cache_Service::regen_post`/`regen_global`/`flush_all`).
- WP-S07 (SPIKE): `wp elementor flush-css --network` reliability on multisite — gates the `network:true` fan-out (Contract 15 §6 S7 row). The route works single-site without S7; `network:true` is gated.
- Elementor APIs (cite `path:line`):
  - `Plugin::$instance->files_manager->clear_cache()` `core/files/manager.php:107-117` (via `Cache_Service`).
  - `Post_CSS::create($id)->update()` (V3 regen, via `Cache_Service`).
  - id mint formula `includes/utils.php:373-375` (`substr(strtolower(dechex(wp_rand())),0,7)`, via `Id_Service`).
- Contract 10 §9 (cache routes), §10 (id routes). Contract 11 §8.1/§9 (id handling). Contract 12 (`DUPLICATE_ELEMENT_ID`).

## Detailed Requirements

1. **cache/regen** (§9): with `post_id` → `Cache_Service::regen_post`; without → `Cache_Service::regen_global` (batches 100/run); `network:true` → `regen_global(network:true)` (S7-gated; degrade to current-site with a `warnings` note if S7 unconfirmed). Return `{regenerated,scope,post_id?}`. CAP_MANAGE.
2. **cache DELETE** (§9): `Cache_Service::flush_all($network)`; return `{flushed:true}`. CAP_MANAGE.
3. **ids/validate** (§10): `Id_Service::validate_tree($elements,$against_post_id)` → `{valid,collisions,duplicate_local_styles}`. Pure computation, no persist. CAP_READ.
4. **ids/remap** (§10): `Id_Service::remap_tree($elements,$against_post_id)` → `{elements,remapped}` (regenerate colliding ids + rewrite local-style backrefs in `styles` map keys, `styles[].id`, and `settings.classes.value`). Pure computation, no persist. CAP_READ.
5. **No persistence on id routes**: assert they write nothing.
6. **op_id + op-log**: cache writes record `op_id` + op-log row (WP-P14, guarded). Id routes are reads (no op-log needed but may log a read).

## Implementation Notes

- This controller is a thin REST facade over `Cache_Service` (WP-P05) and `Id_Service` (WP-P04). Keep ALL logic in those services; the controller only parses args + shapes envelopes.
- `network:true`: until S7 confirms reliability, the safe behavior is current-site flush + a `warnings:["network flush not verified on this multisite; flushed current site only"]` note rather than a silent partial. Gate the true fan-out on the S7 PASS artifact.
- The id POST routes are READ-cap because they are pure functions of their input (RESEARCH.md §4.6 / Contract 10 §10) — they help the client avoid `DUPLICATE_ELEMENT_ID` before a save.

## Acceptance Criteria

- [ ] `POST /cache/regen` with a `post_id` regenerates that post's CSS; without, runs a global regen batched at 100.
- [ ] `DELETE /cache` flushes all Elementor CSS.
- [ ] `network:true` either fans out (S7 confirmed) or degrades with a documented warning.
- [ ] `POST /ids/validate` reports collisions + duplicate local styles without persisting.
- [ ] `POST /ids/remap` returns a collision-free tree with consistent local-style backrefs and a `remapped` map, without persisting.
- [ ] Both cache routes gate on `manage_options`; both id routes on `edit_posts`.
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_cache_regen_post`; `test_cache_regen_global_batches`; `test_cache_delete_flushes`; `test_network_flush_gated`; `test_ids_validate_reports_collisions`; `test_ids_remap_consistent_backrefs_no_persist`.

## Parallelization Notes

- Wave-2 vertical. Owns ONLY `class-cache-controller.php` — disjoint from all other controllers.
- Lists WP-P04 (Id_Service) + WP-P05 (Cache_Service) — but the id routes persist nothing, so this WP is not a tree-WRITE WP in the validator sense (the cache writes are not tree writes either). Lists WP-S07 for the multisite gate.
- **WP-P03 (dry_run validator) is intentionally NOT a dependency** even though this WP lists the writer-family service WP-P04: `ids/validate` and `ids/remap` are pure read-cap computations that PERSIST NOTHING (they validate/remap id sets and return them), and `cache/regen`/`cache/flush` are cache regeneration/eviction, NOT element-tree writes. The universal "every WRITE WP depends on the dry_run validator" rule therefore does not apply here. This is a deliberate, audited exception — recorded so the omission is not mistaken for a gap.
- Parallel-safe with every other WP-P##.

## Spike-Verified Corrections (Wave 1)

- **[S07/C6]** The cache flush MUST run in-process via `\Elementor\Plugin::$instance->files_manager->clear_cache()` (optionally `->generate_css()` to eagerly rebuild the kit), or via the reused `DELETE elementor/v1/cache` route (`permission_callback: current_user_can('manage_options')`, registered at `wp-content/plugins/elementor/core/files/manager.php:197`, handler at `manager.php:266-278`). Run as the web-server uid (33/Apache) that owns `uploads/elementor/css/*`. Do NOT shell out to `wp elementor flush-css` from a differently-imaged CLI sidecar (uid 82) — it clears DB meta only, FAILS to unlink Apache-owned files, and STILL prints `Success`.
- **[S07/R2]** After flush the controller MUST assert the filesystem directly — `glob(uploads/elementor/css/*)` empty (or the targeted post's `_elementor_css` meta gone). NEVER trust the success string: `clear_cache()` does not check `unlink()`'s return and reports success even on failed deletion (`core/files/manager.php:111-113`). `--regenerate` only eagerly rebuilds global/kit CSS (`post-<kitId>.css`); per-page `local-*`/`global-*` CSS returns lazily on visit.
- **[S07/R10]** Multisite `--network` flush is UNVERIFIED (no multisite in the live target). It is out of MVP scope; if reached, do per-subsite in-process `clear_cache()` under `switch_to_blog()` with a per-site files-empty assertion — it inherits the same uid-ownership and silent-success caveats per subsite.
- **[S06]** In tests, hit cache routes via `?rest_route=/elementor/v1/cache` (plain permalinks make `/wp-json/...` return the HTML homepage at HTTP 200).
