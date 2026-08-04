---
id: WP-P09
title: Design controller — variables (watermark), V3 global colors/fonts, element-defaults, sync-v4-to-v3, deploy
layer: php
phase: v1
status: planned
depends_on: [WP-P02, WP-P03, WP-P05, WP-P08, WP-S05]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-design-variables-controller.php
  - plugin/elementor-ultra-mcp/includes/core/class-variables-service.php
contract_refs:
  - spec/contracts/10-rest-api.md §4.4 (variables+watermark), §4.5 (global colors/fonts), §4.6 (element-defaults), §4.7 (sync), §4.8 (deploy), §0.12 (cache flush)
  - spec/contracts/11-authoring-contract.md §7 (V3 globals binding)
  - spec/contracts/12-error-taxonomy.md §3.3 (BUDGET_EXCEEDED, DUPLICATED_LABEL, WATERMARK_STALE, BATCH_FAILED→via mapping), §3.4
estimate: L
---

## Summary

The variables-and-globals half of the design system: the three FREE variable types with watermark optimistic concurrency (create/update/delete/restore/batch), the V3 kit global colors and typography, per-widget element defaults, the V4→V3 sync flag, and the one-shot `deploy` that applies classes + variables atomically. Variables proxy Elementor's variables service (watermark-aware); every write flushes the full cache. Splits the design surface with WP-P08 so the two controllers build in parallel.

## Interface / Contract

Registers (Contract 10 §4.4–§4.8):

- `GET /design/variables` (CAP_READ) — `{variables,total,watermark}`. (§4.4)
- `POST /design/variables` (CAP_MANAGE) — create `{type,label,value,op_id}` → `{variable,watermark}`.
- `PUT /design/variables/{id}` (CAP_MANAGE) — `{label,value,order?,type?,op_id}` (label+value required) → `{variable,watermark}`.
- `DELETE /design/variables/{id}` (CAP_MANAGE) — soft-delete → `{variable,watermark}`.
- `POST /design/variables/{id}/restore` (CAP_MANAGE) — `{label?,value?,type?}` → `{variable,watermark}`.
- `POST /design/variables/batch` (CAP_MANAGE) — `{watermark,operations[],op_id}` (op types `create|update|delete|restore|reorder`) → `{variables,watermark,total}`; batch error → 422 `E_BATCH_FAILED` with per-id detail.
- `GET/PUT /design/global-colors` (CAP_READ/CAP_MANAGE) — V3 kit `system_colors`/`custom_colors`. (§4.5)
- `GET/PUT /design/global-fonts` (CAP_READ/CAP_MANAGE) — V3 kit `system_typography`/`custom_typography`. (§4.5)
- `GET/PUT /design/element-defaults` (CAP_READ/CAP_MANAGE) — per-widget kit defaults. (§4.6)
- `POST /design/sync-v4-to-v3` (CAP_MANAGE) — `{variable_id,op_id}` → `{success,bridge_var}`. (§4.7)
- `POST /design/deploy` (CAP_UPDATE_CLASS) — `{global_classes:<diff-PUT>, global_variables:<batch>, op_id}` → `{classes,variables}`; all-or-nothing budget pre-flight. (§4.8)

Core service (owned here):
- `\Elementor\Ultra\Core\Variables_Service`:
  - `list(): array{variables,total,watermark}`.
  - `create/update/delete/restore( ... ): array|WP_Error`.
  - `batch( int $watermark, array $operations ): array|WP_Error`.
  - `preflight_budget( array $batch ): true|WP_Error` (≤1000, Contract 12 BUDGET_EXCEEDED).
  - colors/fonts/defaults/sync helpers operate on the active kit.

## Dependencies & Inputs

- WP-P02 (`Abstract_Controller`, `Permissions::can_manage`/`can_read`/`can_update_class`, `Error`, pagination), WP-P03 (validate color/typography/default values before applying), WP-P05 (`Cache_Service::flush_design_system` — EVERY design write flushes, Contract 10 §0.12; sync/colors/fonts also flush the kit cache `kit.php:105`).
- WP-P08 (`Global_Classes_Service`) — `design/deploy` reuses `apply_diff`/`preflight_budget` from WP-P08's service (contract dependency; this WP does not edit WP-P08's files). This is why WP-P09 depends on WP-P08.
- WP-S05 (SPIKE): `deploy` writes classes → needs `UPDATE_CLASS` (Contract 15 §6 S5 row).
- Elementor APIs (cite `path:line`):
  - `modules/variables/classes/rest-api.php` — `class Rest_Api` `:23`; `register_routes` `:49`; watermark validate `:170-173`; create `:286`, update `:328`, delete `:349`; batch `:507` (op types), batch error mapping `:544-616` (`batch_duplicated_label`/`batch_variables_limit_reached`/`batch_variables_not_found`); limits id≤64,label≤50,value≤512,≤1000 vars `:31-33`.
  - Variable types (all FREE): `global-color-variable`, `global-font-variable`, `global-size-variable` (`variables/hooks.php:48-51`).
  - V3 kit colors/fonts via `Document::save_settings()` on the active kit (`Plugin::$instance->kits_manager->get_active_kit()`); repeaters `system_colors`/`custom_colors`, `system_typography`/`custom_typography`; kit cache flush `kit.php:105`.
- Contract 10 §4.4 (variables shapes + watermark + limits), §4.5 (colors/fonts), §4.6 (defaults), §4.7 (sync bridge var `--e-global-color-v4-<Label>`), §4.8 (deploy all-or-nothing). §0.12 (full flush). Contract 12 §3.3 (`WATERMARK_STALE`, `BUDGET_EXCEEDED`, `DUPLICATED_LABEL`), §4 (batch error slug mapping).

## Detailed Requirements

1. **variables list/create/update/delete/restore** (§4.4): proxy the Elementor variables service; return `watermark` on every response (optimistic-concurrency token). Enforce limits (id≤64,label≤50,value≤512) → 422 with the right code. Create at the 1000 limit → 422 `BUDGET_EXCEEDED`. Duplicate label → 422 `DUPLICATED_LABEL`. Type mismatch on update/restore → 422 `TYPE_MISMATCH`. Validate `type` ∈ the three FREE variable types.
2. **batch** (§4.4): REQUIRE `watermark`; a stale watermark fails the whole batch → 409 `WATERMARK_STALE` with `meta.{expected_watermark,actual_watermark}`. Map Elementor's per-id batch errors (`batch_duplicated_label`/`batch_variables_limit_reached`/`batch_variables_not_found`) to taxonomy codes and return the §4.4 batch-error shape (`{success:false,code:'E_BATCH_FAILED',data:{<id>:{status,message}}}`). On success return `{variables,watermark,total}`.
3. **global-colors / global-fonts** (§4.5): GET reads the active kit's repeaters; PUT writes via `Document::save_settings()` on the kit (deep-merge by `_id` so partial updates don't wipe other entries) and flushes the kit cache. Colors items `{_id,title,color}`; fonts items `{_id,title,typography_typography:'custom',typography_font_family,...}`.
4. **element-defaults** (§4.6): GET returns per-widget kit defaults; PUT writes `{type,settings}` into the kit's per-widget defaults store and flushes.
5. **sync-v4-to-v3** (§4.7): flag a V4 variable `sync_to_v3` and regenerate the bridge stylesheet; return `{success,bridge_var:"--e-global-color-v4-<Label>"}`.
6. **deploy** (§4.8): the all-or-nothing combined apply. Pre-flight BOTH budgets (classes via WP-P08 `Global_Classes_Service::preflight_budget`, variables via `Variables_Service::preflight_budget`) BEFORE applying either; if either would exceed 1000 → 422 `BUDGET_EXCEEDED`, apply NEITHER. Then apply classes (WP-P08 `apply_diff`) then variables (`batch`); return `{classes:{ok,modified_labels},variables:{watermark}}`. CAP_UPDATE_CLASS (because it writes classes).
7. **Cache flush** (§0.12): every write (variables, colors, fonts, defaults, sync, deploy) calls `Cache_Service::flush_design_system()`; sync/colors/fonts additionally ensure kit cache is cleared.
8. **op_id + op-log**: all writes record `op_id` + an op-log row (WP-P14, guarded).
9. **No raw kit meta where a service exists**: variables go through the Elementor variables service; colors/fonts/defaults go through `Document::save_settings()` on the kit (the supported path), never raw `_elementor_page_settings` writes on the kit.

## Implementation Notes

- The variables service is Elementor-owned; the companion proxies it and re-wraps responses in our envelope, adding `op_id`/op-log/cache-flush. Reuse Elementor's watermark validation rather than reimplementing it.
- Batch error mapping: read `rest-api.php:544-616` for the per-id error structure and translate each Elementor slug to a taxonomy code via WP-P02's `Error::ELEMENTOR_SLUG_MAP` (extend the map if a variables-specific slug is missing — but the map itself is owned by WP-P02; add variables slugs there only if WP-P02 reserved space; otherwise translate inline in this service and note it).
- `deploy` ordering: classes first then variables is fine because the budget pre-flight already guaranteed both fit; but capture the classes' `modified_labels` so the response carries the soft rename even though variables also applied.
- Kit colors/fonts deep-merge: match repeater items by `_id` and overwrite-or-append; never replace the whole repeater (that would wipe unrelated colors).
- The V3 globals binding string format (`globals/colors?id=<_id>`, `globals/typography?id=<_id>`) is consumed by the element `bind_global` op (WP-P06 §14) — this controller does NOT write element bindings, only the kit color/font definitions; keep the two concerns separate (Contract 11 §7).

## Acceptance Criteria

- [ ] All variables routes return `watermark`; create/update/delete/restore enforce id/label/value limits and the 1000 cap.
- [ ] `batch` with a stale `watermark` returns 409 `WATERMARK_STALE`; a per-id failure returns the §4.4 batch-error shape with taxonomy codes.
- [ ] `PUT /design/global-colors` updates one color by `_id` without wiping others and flushes the kit cache.
- [ ] `PUT /design/global-fonts` and `PUT /design/element-defaults` persist via kit `save_settings` and flush.
- [ ] `sync-v4-to-v3` returns `{success,bridge_var:"--e-global-color-v4-<Label>"}`.
- [ ] `deploy` pre-flights BOTH budgets and applies NEITHER on overflow; on success applies classes then variables and returns both results; requires `UPDATE_CLASS`.
- [ ] Every design write flushes the full cache (Contract 10 §0.12).
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_variables_crud_with_watermark`; `test_variable_limits_and_budget`; `test_batch_stale_watermark_409`; `test_batch_per_id_error_mapping`; `test_global_colors_partial_update`; `test_global_fonts_and_defaults`; `test_sync_v4_to_v3_bridge_var`; `test_deploy_all_or_nothing_budget`; `test_deploy_requires_update_class`; `test_design_write_flushes_cache`.
- Consumes `trees/v4/design/variables.batch.json` (Contract 14 §1).

## Parallelization Notes

- Wave-2 vertical. Owns `class-design-variables-controller.php` + `class-variables-service.php` — DISJOINT from WP-P08's class controller/service files.
- Depends on WP-P08 ONLY at the contract level (reuses `Global_Classes_Service` for `deploy`); it does not edit WP-P08's files. If parallel build order matters, WP-P08's `Global_Classes_Service` interface is the frozen contract this WP codes against.
- Lists WP-P03/P05 per WRITE/cache rules and WP-S05 (UPDATE_CLASS for deploy). Parallel-safe with all other controllers.

## Spike-Verified Corrections (Wave 1)

- **[S07/C6/R2]** After any variables/globals write that affects CSS, the controller MUST flush in-process via `\Elementor\Plugin::$instance->files_manager->clear_cache()` (or the reused `DELETE elementor/v1/cache` route), running as the web-server uid (33/Apache) that owns `uploads/elementor/css/*`. It MUST then assert `glob(uploads/elementor/css/*)` is empty — `clear_cache()` does NOT check `unlink()` return and reports success even when deletion fails (`wp-content/plugins/elementor/core/files/manager.php:111-113`), so NEVER trust the success string. Do NOT flush from a differently-imaged CLI sidecar (uid mismatch silently leaves stale files yet prints Success).
