---
id: WP-P08
title: Design controller — global classes (diff-PUT upsert/delete/reorder, usage)
layer: php
phase: v1
status: planned
depends_on: [WP-P02, WP-P03, WP-P05, WP-S05]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-design-classes-controller.php
  - plugin/elementor-ultra-mcp/includes/core/class-global-classes-service.php
contract_refs:
  - spec/contracts/10-rest-api.md §4.1 (list), §4.2 (diff-PUT NORMATIVE), §4.3 (usage), §0.3 (CAP_UPDATE_CLASS), §0.12 (cache flush)
  - spec/contracts/11-authoring-contract.md §5 (style objects), §5.1 (global vs local), §7 (class name rules)
  - spec/contracts/12-error-taxonomy.md §3.3 (BUDGET_EXCEEDED, DUPLICATED_LABEL, INVALID_ORDER), §3.4 (CAPABILITY_MISSING)
estimate: M
---

## Summary

The global-class half of the design system: list classes with the full order array, the NORMATIVE diff-based PUT (added/deleted/modified/order with touched-only items, 1000-item budget pre-flight, duplicate-label soft outcome), and usage lookup. All writes go through the `Global_Classes_Repository` (never raw CPT/kit meta) and trigger a full cache flush. Gated on `CAP_UPDATE_CLASS` (the migration-granted capability that WP-P01 grants idempotently; spike S5 verifies presence).

## Interface / Contract

Registers (Contract 10 §4.1–§4.3):

- `GET /design/classes` (CAP_READ) — `{items,order,next_cursor,total}`; `context?` (`frontend|preview`), pagination. `order` is the FULL current order array (clients need it to build a valid diff-PUT). (§4.1)
- `PUT /design/classes` (CAP_UPDATE_CLASS) — the diff-PUT (§4.2). Request body EXACT shape:
  ```
  { context, changes:{added[],deleted[],modified[],order:bool}, items:{id:GlobalClassObject}, order:[id...], op_id }
  ```
  Response `data`: `{ ok:true, modified_labels:{id:{modified}}, order:[...], total }`. `modified_labels` non-empty ⇒ DUPLICATED_LABEL soft outcome (200, not error).
- `GET /design/classes/usage` (CAP_MANAGE) — `{usage:{id:{total,pages:[{post_id,count}]}}}`. (§4.3)

Core service (owned here, reused by WP-P09 `design/deploy`):
- `\Elementor\Ultra\Core\Global_Classes_Service`:
  - `list( string $context = 'frontend' ): array{ items, order }`.
  - `apply_diff( array $body ): array|WP_Error` — validates + pre-flights budget/order, calls the repository `apply_changes`, returns `{ok,modified_labels,order,total}` or a taxonomy `WP_Error`.
  - `preflight_budget( array $body ): true|WP_Error` — `count(existing) − deleted + added ≤ 1000` else `BUDGET_EXCEEDED`.
  - `usage( string $context ): array`.

## Dependencies & Inputs

- WP-P02 (`Abstract_Controller`, `Permissions::can_update_class`/`can_manage`/`can_read`, `Error`, pagination), WP-P03 (`Validator` — class variants are style objects; validate their `variants[].props` via the style-schema half of the validator before applying, Contract 11 §5/§8 R8), WP-P05 (`Cache_Service::flush_design_system` — EVERY write flushes, Contract 10 §0.12).
- WP-S05 (SPIKE): confirms `UPDATE_CLASS` present for the agent user; mitigated by WP-P01's activation grant but probe required (Contract 15 §6 S5 row). This WP lists S5 because its writes hard-fail 403 without the cap.
- Elementor APIs (cite `path:line`):
  - `modules/global-classes/global-classes-repository.php` — `all()` `:59`, `get_order()` `:73`, `get_by_ids()` `:102`, `apply_changes( $touched_items, $changes, $order )` `:121`, `put()` `:181`. Use `apply_changes` for the diff-PUT (NOT raw meta) — Contract 15 §3.6.
  - `modules/global-classes/global-classes-rest-api.php` — the diff-PUT semantics this mirrors: budget at `:331-341` (`global_classes_limit_exceeded`), order consistency at `:366-372` (`invalid_order`), duplicate-label auto-rename at `:382-387` (`DUPLICATED_LABEL`), `final_item_ids = existing − deleted + added`. Cap at `:154` (`Add_Capabilities::UPDATE_CLASS`).
  - `modules/global-classes/database/migrations/add-capabilities.php:8` — `UPDATE_CLASS` constant.
  - usage source `global-classes-rest-api.php:135`.
- Contract 10 §4.2 NORMATIVE rules (items=touched-only; order=full final list consistent with `final_item_ids`; explicit deletion via `changes.deleted`; budget ≤1000; duplicate-label soft). §0.12 (full cache flush on write).
- Contract 11 §5.1 (global class data lives in the `e_global_class` CPT written via the repository — never raw meta), §7 (class-name/label rules: label 2–50 chars, no spaces, no leading digit/`--`/`-digit`, not reserved `container`).

## Detailed Requirements

1. **list** (§4.1): `Global_Classes_Service::list` returns repository `all()` items + `get_order()` as the FULL order array; apply pagination over items but ALWAYS return the complete `order` (a paged list still needs the full order to build a diff-PUT). `context` selects frontend vs preview variant data.
2. **diff-PUT** (§4.2 NORMATIVE): the controller validates the EXACT request shape, then:
   a. **Budget pre-flight** (`preflight_budget`): `count(existing) − count(deleted) + count(added) ≤ 1000`, else 422 `BUDGET_EXCEEDED` with `meta.{current_count,max_allowed,kind:"classes"}` — applies NOTHING.
   b. **Order consistency**: `order` (top-level) must equal `final_item_ids` (= existing − deleted + added) as a set, else 422 `INVALID_ORDER` with `meta.{expected_ids,received_ids}`.
   c. **Items = touched only**: `items` keys must be a subset of `added ∪ modified`; reject extras with 400.
   d. **Variant validation**: each item's `variants[].props` validated via WP-P03's style-schema validation (Contract 11 §8 R8) → 422 `ATOMIC_STYLES_INVALID`/`STYLE_INVALID` on failure.
   e. **Label rules** (Contract 11 §7): enforce label 2–50 chars, no spaces, not `container`; Elementor auto-renames duplicate labels — capture the rename and surface it.
   f. Call repository `apply_changes($touched_items, $changes, $order)`.
   g. **Duplicate-label soft outcome**: if Elementor renamed labels, return them in `modified_labels` (200, NOT error) so the agent rebinds elements (Contract 10 §4.2, Contract 12 §3.3 DUPLICATED_LABEL).
   h. **Cache flush**: `Cache_Service::flush_design_system()` AFTER apply (Contract 10 §0.12). Do not require a separate `cache/regen` call. **Global-class atomic CSS rendering:** a newly-created/updated global class renders front-end via the kit-level CSS regeneration that `Cache_Service::flush_design_system()` triggers (kit CSS file regen) — it does NOT require the per-document `Css_Primer` headless-save prime path (WP-S01/WP-P05 document prime), because global-class styles live in the kit's global CSS, not in a per-post atomic CSS file. This is why WP-P08 depends on WP-P05 ONLY for `flush_design_system` (the kit-CSS regen) and NOT on WP-S01: there is no document to headless-prime. (The WP-Q06 `render-assert.global-class.json` case asserts the global-class selector rules render via exactly this kit-CSS-regen mechanism, not the document prime.)
3. **Capability gate** (§0.3, Contract 12 §3.4): `CAP_UPDATE_CLASS`; 403 `CAPABILITY_MISSING` with `meta.capability='elementor_global_classes_update_class'` and an actionable message ("Run plugin activation to grant UPDATE_CLASS or assign the agent user an administrator role"). WP-P01 grants it idempotently; this route still hard-fails cleanly if absent.
4. **usage** (§4.3): return where each class is used (`{id:{total,pages:[{post_id,count}]}}`); CAP_MANAGE.
5. **`op_id` + op-log**: PUT records `op_id` and an op-log row (WP-P14 store, guarded).
6. **No raw meta** (Contract 15 §3.6, Contract 11 §5.1): all reads/writes go through `Global_Classes_Repository`; never touch `e_global_class` post meta or kit class indexes directly.
7. **Service reuse**: `Global_Classes_Service` is the single place the diff/budget/order logic lives so WP-P09's `design/deploy` (which applies classes + variables together) can call `apply_diff`/`preflight_budget` without duplicating it.

## Implementation Notes

- The repository's `apply_changes` is the migration-transparent path; it handles the CPT writes. Do not call `put()` for partial updates — `put()` replaces the whole collection. Use `apply_changes` for the diff semantics (Contract 10 §4.2).
- `final_item_ids` computation must mirror Elementor's `global-classes-rest-api.php` exactly: start from current ids, remove `changes.deleted`, add `changes.added`. Validate `order` against this set (order is the full final list).
- The companion route MAY alternatively proxy `elementor/v1/global-classes` PUT with identical body (Contract 10 §4.2 "may call the repository apply_changes directly") — prefer the direct repository call for testability and to attach our envelope/cache-flush.
- Duplicate-label rename is a 200 with `modified_labels` — do NOT treat it as an error; the agent must reconcile bindings (Contract 12 §5.4 soft-code rule).
- GlobalClassObject is StyleDefinition-shaped (`{id,label,type:'class',variants[]}`) per Contract 13 shared types and Contract 11 §5.

## Acceptance Criteria

- [ ] `GET /design/classes` returns `{items,order,...}` with the FULL order array even when items are paged.
- [ ] `PUT /design/classes` applies an upsert+delete+reorder diff via the repository and flushes the design-system cache.
- [ ] A PUT that would exceed 1000 classes returns 422 `BUDGET_EXCEEDED` and applies nothing.
- [ ] A PUT whose `order` is not the consistent full final list returns 422 `INVALID_ORDER`.
- [ ] A PUT with `items` keys outside `added∪modified` returns 400.
- [ ] A PUT that triggers a duplicate-label rename returns 200 with non-empty `modified_labels`.
- [ ] Without `UPDATE_CLASS`, the PUT returns 403 `CAPABILITY_MISSING` with an actionable message; after activation grant it succeeds.
- [ ] `usage` returns the §4.3 shape.
- [ ] No raw `e_global_class` meta or kit class-index writes (grep + test); all via the repository.
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_list_returns_full_order`; `test_diff_put_upsert_delete_reorder`; `test_budget_exceeded_applies_nothing`; `test_invalid_order_rejected`; `test_items_must_be_touched_only`; `test_duplicate_label_soft_200`; `test_update_class_gate_403_then_grant`; `test_write_flushes_cache`; `test_usage_shape`; `test_no_raw_meta`.
- Consumes `trees/v4/design/global-classes.upsert-diff.json` (Contract 14 §1) for the diff-PUT body.

## Parallelization Notes

- Wave-2 vertical. Owns `class-design-classes-controller.php` + `class-global-classes-service.php` — DISJOINT from WP-P09 (which owns `class-design-variables-controller.php` + variables service). The design surface is intentionally split across two WPs so they build in parallel without touching the same file.
- Lists WP-P03 (validate variant props) + WP-P05 (cache flush) per the WRITE-WP / cache rules. Lists WP-S05 (UPDATE_CLASS presence gate).
- WP-P09's `design/deploy` consumes `Global_Classes_Service` (contract dependency, no file edit).

## Spike-Verified Corrections (Wave 1)

- **[S05]** The capability gate for global-class writes MUST be the literal cap string `elementor_global_classes_update_class` (Elementor's own PUT uses `current_user_can(Add_Capabilities::UPDATE_CLASS)` at `wp-content/plugins/elementor/modules/global-classes/global-classes-rest-api.php:154`). The cap class is `Elementor\Modules\GlobalClasses\Database\Migrations\Add_Capabilities` (`modules/global-classes/database/migrations/add-capabilities.php`) — NOT `Utils\Add_Capabilities` (does not exist; would fatal). There is a SINGLE PUT route for add/delete/modify/order — there are no `create_class`/`delete_class` caps; only `UPDATE_CLASS` gates all writes. A missing cap returns `403 rest_forbidden` → map to `CAPABILITY_MISSING`. GET reads (`is_user_logged_in()`) stay available.
- **[S07/C6/R2]** After ANY class write the controller MUST flush CSS in-process via `\Elementor\Plugin::$instance->files_manager->clear_cache()` (or the reused `DELETE elementor/v1/cache` route), running as the web-server uid. It MUST assert `glob(uploads/elementor/css/*)` is empty afterward — `clear_cache()` reports success even when `unlink()` fails (`core/files/manager.php:111-113`), so NEVER trust the success string. Do not flush from a differently-imaged CLI sidecar (uid mismatch silently fails).
- **[S02/R6]** Deleting a kit global class fires `Global_Classes_Cleanup::unapply_deleted_classes` (`wp-content/plugins/elementor/modules/global-classes/global-classes-cleanup.php:40`, hooked on `elementor/global_classes/update` with `deleted`) which rewrites EVERY document's `_elementor_data` (including saved templates) to strip the deleted id. The controller MUST treat a class delete as a GLOBAL mutation: trigger a full CSS flush AND re-prime all dependent documents, not just the edited kit.
