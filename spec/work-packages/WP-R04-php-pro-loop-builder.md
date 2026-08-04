---
id: WP-R04
title: PHP Pro Loop Builder — create loop-item + bind-grid query
layer: php
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F02, WP-F05, WP-P01, WP-P02, WP-P03, WP-P04, WP-P05, WP-P06, WP-S01, WP-R01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/pro/class-loop-service.php
  - plugin/elementor-ultra-mcp/includes/pro/class-loop-query-mapper.php
contract_refs:
  - spec/contracts/10-rest-api.md#86-post-proloopitem-post-proloopbind-grid
  - spec/contracts/12-error-taxonomy.md#3
  - spec/contracts/13-tool-catalog.md#18-pro-surface
estimate: M
---

## Summary

Companion-plugin PHP for the Pro Loop Builder: `POST /pro/loop/item` creates a `loop-item` template document; `POST /pro/loop/bind-grid` configures a `loop-grid`/`loop-carousel` widget bound to a loop-item template + query — asserting the `template_id` is a `loop-item` doc, writing query keys with the `{skin}_query_` prefix, and placing `posts_per_page`+`columns` at TOP LEVEL (NOT inside the query group). Owns `Loop_Service` and the pure `Loop_Query_Mapper`.

## Interface / Contract

Implements REST routes (Contract 10 §8.6):

- `POST /pro/loop/item` — CAP_EDIT_POST — create loop-item template.
- `POST /pro/loop/bind-grid` — CAP_EDIT_POST — configure loop-grid/carousel widget.

`Loop_Service`:
- `routes(): array` — descriptors (registered by WP-R01 controller loop).
- `create_item(array $params): array|WP_Error` — create a post with `_elementor_template_type='loop-item'`.
- `bind_grid(array $params): array|WP_Error` — build/insert the loop widget.

`Loop_Query_Mapper` (pure, unit-testable):
- `map(string $skin, array $query, int $posts_per_page, ?string $columns, ?array $pagination): array` — returns the flat widget settings: `_skin`, top-level `posts_per_page`/`columns`, prefixed `{skin}_query_*` keys, `template_id`, pagination keys.
- `query_prefix(string $skin): string` — returns `str_replace('-','_',$skin).'_query_'`.

## Dependencies & Inputs

Upstream WPs:
- WP-R01 — `Pro_Controller` (registers `routes()`), `Pro_Gate`. Consumed.
- WP-F01/F02/F05 — scaffold, REST contract, error taxonomy.
- WP-P04 — `Document_Writer` (granular element insert via WP-P06 Documents controller) (loop-item doc creation + widget insert/persist with backup/lock/base_hash).
- WP-P03 — `Validator::dry_run()` (loop-item `elements` + the loop-grid widget node validated before persist).
- WP-P05 + WP-S01 — `CssPrimer` (loop-item / loop-grid atomic styles → prime required).

Contract sections: Contract 10 §8.6; §0.3 cap map; §0.6 error; §0.8 base_hash/op_id; §0.9 dry-run; §0.10 prime. Error codes Contract 12: `E_LOOP_TEMPLATE_INVALID` (REST taxonomy) / `LOOP_TEMPLATE_INVALID`.

Elementor Pro APIs (cite in code):
- `loop-grid` widget `Loop_Grid extends Base extends Posts` — `plugins/elementor-pro/modules/loop-builder/widgets/loop-grid.php:20-23`; base `base.php:17`. `get_group_name()='loop-builder'`.
- Loop-item doc type `LoopDocument::DOCUMENT_TYPE='loop-item'` — `modules/loop-builder/documents/loop.php:26`; `get_type()` returns it `:47`.
- Template binding `template_id` (`Template_Query::CONTROL_ID`), autocomplete filtered to `_elementor_template_type=='loop-item'` — `loop-grid.php:154-190` / `base.php:118-150`. Pointing at a non-loop-item template renders nothing.
- Skins (`_skin`) `post` (`LOOP_POST_SKIN_ID`) / `post_taxonomy` — `loop-builder/module.php:26-27`; Woo adds `product`/`product_taxonomy` (`woocommerce/module.php:45-46`).
- `posts_per_page` TOP-LEVEL (def 6) + `columns` (responsive def 3) — `loop-grid.php:62-340`; `posts_per_page` control at `loop-grid.php:85` (loop-item default `posts_per_page=>1` at `documents/loop.php:475`).
- Query prefix `get_query_name()=str_replace('-','_',skin_id).'_query'` — `base.php:32-35`; query group `Group_Control_Related` (`Module::QUERY_ID='query'`, EXCLUDES `posts_per_page`) — `skin-loop-base.php:54-63`; group fields (`post_type`, `posts_ids`, `include`/`include_term_ids`, `exclude`/`exclude_ids`, `orderby` def `post_date`, `order` def `desc`, `query_id`) — `query-control/controls/group-control-query.php:34-401`.
- Pagination (`pagination_type`, `pagination_load_type` def `page_reload`) — `base.php:174-343`.
- SUPPLEMENT §A.4 worked CPT loop JSON + §A.7 pro.loop.bind_grid.

## Detailed Requirements

1. **`POST /pro/loop/item`.** `documents->create('loop-item', ['post_title'=>title,'post_status'=>'publish'])` (CPT `elementor_library`). If `elements` present, validate via `dry_run` then persist via writer (atomic → prime). Response `data` per §8.6: `{ template_id, edit_url }`. Record `op_id`.

2. **`POST /pro/loop/bind-grid` — template assertion.** Read `get_post_meta($template_id,'_elementor_template_type',true)`; if it is NOT `'loop-item'` → 422 `E_LOOP_TEMPLATE_INVALID` (`data.meta.{template_id,actual_type}`). This is the load-bearing guard (a non-loop-item template silently renders nothing — `loop-grid.php:154-190`).

3. **Query mapping (`Loop_Query_Mapper`).** `widget ∈ {loop-grid,loop-carousel}` (default `loop-grid`); `skin ∈ {post,post_taxonomy,product,product_taxonomy}` (default `post`) → `_skin`. Build the flat settings:
   - `template_id` (string) at top level.
   - `_skin` = skin.
   - `posts_per_page` (top-level, int, def 6) — NEVER `{skin}_query_posts_per_page` (that key is excluded; setting it does nothing — SUPPLEMENT §A.4 gotcha).
   - `columns` (top-level, responsive; also `columns_tablet`/`columns_mobile` when provided).
   - Query group keys prefixed `query_prefix(skin)` (= `post_query_` for `post`, `product_query_` for `product`): `{p}post_type`, `{p}orderby`, `{p}order`, `{p}include` + `{p}include_term_ids`, `{p}exclude` + `{p}exclude_ids`, `{p}posts_ids` (when `post_type='by_id'`), `{p}query_id`.
   - Pagination: `pagination_type`, `pagination_load_type` (from `pagination.{type,load_type}`).

4. **`include`/`exclude` filters.** When `include_term_ids` provided, also set `{p}include` to include `'terms'` (the query group's include is a SELECT2 of `terms|authors`). Mirror SUPPLEMENT §A.4 worked example: `post_query_include:['terms']` + `post_query_include_term_ids:['15','16']`. For `post_type='by_id'`, set `{p}posts_ids`.

5. **Persist vs return-only.** When `post_id`+`container_id` present, validate the widget node via `dry_run`, insert under `container_id`, persist via writer (base_hash/lock/autosave/backup/op_id), set `prime_required` for atomic. Otherwise return `{element}` only. Response `data` per §8.6: `{ element, applied, base_hash? }`.

6. **Skin/Woo coupling.** `skin ∈ {product,product_taxonomy}` requires WooCommerce active (the Woo loop module registers those skins — `woocommerce/module.php:45-46`); if Woo inactive and a product skin requested → 422 (`data.meta.reason='product skin requires WooCommerce'`). `post`/`post_taxonomy` are always available with Pro.

7. **Error mapping (Contract 12).** Pro inactive → 501 `PRO_REQUIRED`; template not loop-item → 422 `E_LOOP_TEMPLATE_INVALID`; template not found → 404 `E_NOT_FOUND`; node validation fail → 422 `ATOMIC_SETTINGS_INVALID`.

## Implementation Notes

- Keep `Loop_Query_Mapper` pure so the prefix logic is unit-tested off-WP. The single most error-prone detail is the `{skin}_query_` prefix derived from the skin id with hyphens replaced by underscores (`base.php:32-35`) — DO NOT hardcode `post_query_`; derive it.
- `posts_per_page` belongs at the widget root, not the query group; the query `Group_Control_Related` explicitly EXCLUDES it (`skin-loop-base.php:54-63`). Putting it in the group is a silent no-op.
- The loop-item doc default `posts_per_page` is 1 (`documents/loop.php:475`) — irrelevant to the grid; the grid's own top-level `posts_per_page` controls the page size.
- Read `_elementor_template_type` directly via `get_post_meta` for the assertion — it equals `get_type()` (SUPPLEMENT §A.1).
- PHPCS clean; `path:line` comments on every Elementor call.

## Acceptance Criteria

- [ ] `POST /pro/loop/item` creates a post with `_elementor_template_type='loop-item'`.
- [ ] `bind-grid` with a non-loop-item `template_id` → 422 `E_LOOP_TEMPLATE_INVALID` with `actual_type` meta.
- [ ] The produced widget settings place `posts_per_page` and `columns` at top level (NOT under any `{skin}_query_` prefix).
- [ ] Query keys are prefixed by the skin (e.g. `post_query_post_type`, `product_query_post_type` for the product skin), derived not hardcoded.
- [ ] SUPPLEMENT §A.4 worked CPT loop reproduces exactly (modulo widget id): `_skin:'post'`, `post_query_post_type:'portfolio'`, `post_query_include:['terms']`, `post_query_include_term_ids:['15','16']`, `posts_per_page:9` top-level.
- [ ] `skin='product'` with Woo inactive → 422 with reason; with Woo active → succeeds.
- [ ] With `post_id`+`container_id`, the widget validates via `dry_run`, is inserted and persisted; without them, only `{element}` returned.
- [ ] Pro inactive → 501 `PRO_REQUIRED`.
- [ ] PHPCS clean; every Elementor call has a `path:line` comment.

## Tests Required

- PHPUnit (pure mapper): assert the SUPPLEMENT §A.4 worked example output, including `{skin}_query_` derivation for `post` and `product` skins, and top-level `posts_per_page`.
- PHPUnit (wp-env, Pro active): create loop-item, bind a grid to it → widget validates via `dry_run`; bind to a non-loop-item template → 422.
- PHPUnit: product skin gating by Woo presence.
- PHPUnit (Pro inactive): both routes 501.
- Fixtures: `packages/shared/fixtures/trees/pro/loop-grid.cpt-query.json` (`requires:{pro:true}`) owned by this WP.

## Parallelization Notes

- Parallel-safe with all other PHP WP-R siblings and all TS WP-R (disjoint files).
- Depends on WP-R01 (`Pro_Controller`/`Pro_Gate`) — consumed.
- Sequencing: merge after WP-R01, WP-P03/P04/P05/P06, WP-S01 PASS.
