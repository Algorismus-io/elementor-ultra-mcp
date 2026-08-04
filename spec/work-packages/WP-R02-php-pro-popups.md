---
id: WP-R02
title: PHP Pro Popups — create + display-settings + conditions
layer: php
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F02, WP-F05, WP-P01, WP-P02, WP-P03, WP-P04, WP-P05, WP-P06, WP-S01, WP-R01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/pro/class-popup-service.php
  - plugin/elementor-ultra-mcp/includes/pro/class-display-settings-helper.php
contract_refs:
  - spec/contracts/10-rest-api.md#84-post-propopup-put-propopupiddisplay
  - spec/contracts/12-error-taxonomy.md#3
  - spec/contracts/13-tool-catalog.md#18-pro-surface
estimate: M
---

## Summary

Companion-plugin PHP for the Pro Popup surface: create a popup document with its three separate storage buckets — layout settings → `_elementor_page_settings`, display settings (triggers + timing) → `_elementor_popup_display_settings` via `save_display_settings_data()`, and conditions → `_elementor_conditions` (location `popup`) via the shared `Conditions_Helper` — plus a merge route for triggers/timing. Owns the `Popup_Service` (registered through `Pro_Controller::routes()` from WP-R01) and a `Display_Settings_Helper` that validates the full triggers/timing object shape.

## Interface / Contract

Implements REST routes (Contract 10 §8.4):

- `POST /pro/popup` — CAP_EDIT_POST — create popup doc + display settings + conditions.
- `PUT  /pro/popup/{id}/display` — CAP_EDIT_POST — MERGE triggers/timing into existing display settings.

`Popup_Service`:
- `routes(): array` — descriptors for both routes (registered by WP-R01's controller loop).
- `create(array $params): array|WP_Error`.
- `set_display(int $post_id, array $params): array|WP_Error`.

`Display_Settings_Helper`:
- `validate(array $display): WP_Error|true` — group toggles ∈ `{"yes",""}`; sub-keys prefixed `{group}_{control}`; enforces the SUPPLEMENT §A.2 object shape (known group + sub-control names) as a soft allowlist (unknown keys passed through with a warning, never a hard fail, so future Pro controls don't break us).
- `merge(array $existing, array $patch): array` — deep merge a `{triggers?,timing?}` patch into the existing `_elementor_popup_display_settings`.
- `flatten(array $display): array` — flatten the `{triggers:{...},timing:{...}}` request shape into the flat assoc the popup document stores (triggers + timing live in ONE flat array under the display-settings meta, not nested).

## Dependencies & Inputs

Upstream WPs:
- WP-R01 — `Pro_Controller` (registers this service's `routes()`), `Pro_Gate` (Pro-active gate), `Conditions_Helper` (popup conditions). Consumed, never edited.
- WP-F01/F02/F05 — scaffold, REST contract, error taxonomy.
- WP-P04 — `Document_Writer` (granular element insert via WP-P06 Documents controller) (popup layout settings + elements persist through the same `Document::save()` path with backup/lock/base_hash).
- WP-P03 — `Validator::dry_run()` (validate `elements` before persist).
- WP-P05 + WP-S01 — `CssPrimer` for popup atomic trees.

Contract sections: Contract 10 §8 intro, §8.4; §0.3 cap map; §0.6 error envelope; §0.9 dry-run; §0.10 prime; §0.12 cache.

Elementor Pro APIs (cite in code):
- `Modules\Popup\Document` — `plugins/elementor-pro/modules/popup/document.php:20`; `get_type()='popup'` `:29`.
- `DISPLAY_SETTINGS_META_KEY = '_elementor_popup_display_settings'` — `document.php:22`.
- `save_display_settings_data($data)` → `update_main_meta(DISPLAY_SETTINGS_META_KEY,$data)` — `document.php:115-116`; getter `:112`.
- Frontend triggers only emit when the popup matches its `popup`-location conditions — `document.php:119-132` (a popup with display settings but no condition never auto-opens).
- Popup location `popup` is `multiple=true` — `popup/module.php:208-212` (no conflict; do NOT run single-instance conflict detection).
- AJAX reference `pro_popup_save_display_settings` → `save_display_settings()` → `$document->save_display_settings_data($data['settings'])` — `popup/module.php:226,236`.
- Full triggers/timing/layout object — SUPPLEMENT §A.2 (`popup/display-settings/triggers.php` class `Triggers` `get_name()='popup_triggers'`; `popup/display-settings/timing.php` class `Timing` `get_name()='popup_timing'`; layout settings `popup/document.php:156-855`).

## Detailed Requirements

1. **`POST /pro/popup`** behaviour order (SUPPLEMENT §A.7 pro.popup.create): (a) `Pro_Gate::require_pro()`; (b) `documents->create('popup', ['post_title'=>title,'post_status'=>status])`; (c) if `elements` present, `Validator::dry_run()` — fail → 422 + delete the orphan draft; (d) persist `layout_settings` → `_elementor_page_settings` and `elements` via `Document_Writer` (`Document::save(['settings'=>layout_settings,'elements'])`); (e) if `display_settings` present, `Display_Settings_Helper::flatten()` then `$doc->save_display_settings_data($flat)`; (f) `Conditions_Helper::save($id, $conditions ?? [['include','general']])` — note: default to `[["include","general"]]` per SUPPLEMENT §A.7 so the popup can actually auto-trigger; (g) op-log row. Response `data` per §8.4: `{ post_id, edit_url, display_settings_meta:'_elementor_popup_display_settings', conditions_stored }`.

2. **`PUT /pro/popup/{id}/display`** MERGES (§8.4): read existing `_elementor_popup_display_settings`, `Display_Settings_Helper::merge()` the `{triggers?,timing?}` patch, then `save_display_settings_data()`. Response: `{ saved:true, display_settings:{triggers,timing} }`. Asserts the target post is a popup (`$doc->get_type()==='popup'`) else 422 (or 404 if not a doc).

3. **Display-settings shape (SUPPLEMENT §A.2).** The helper recognizes group toggles: triggers `page_load, scrolling, click, inactivity, exit_intent, adblock_detection`; timing `page_views, sessions, times, url, sources, logged_in, devices, browsers, schedule`. Toggle value MUST be `"yes"` or `""`. Sub-controls prefixed `{group}_{control}` (e.g. `page_load_delay`, `times_times`, `times_period`, `times_count`, `scrolling_direction`, `scrolling_offset`, `sources_sources`, `logged_in_users`, `logged_in_roles`, `devices_devices`, `browsers_browsers`, `browsers_browsers_options`, `schedule_timezone`, `schedule_start_date`, `schedule_end_date`). Validate enum-bearing sub-controls where SUPPLEMENT §A.2 lists them (e.g. `scrolling_direction ∈ {down,up}`, `times_period ∈ {'',session,day,week,month}`, `times_count ∈ {'',close}`, `url_action ∈ {show,hide,regex}`, `logged_in_users ∈ {all,custom}`). Unknown keys → pass through + add to `data.meta.unverified_keys[]`.

4. **Flatten semantics.** The REST request groups display settings as `{triggers:{...},timing:{...}}` for ergonomics, but `_elementor_popup_display_settings` stores ONE flat assoc array. `flatten()` merges `triggers` and `timing` maps into a single flat array (keys already prefixed by group, per §A.2, so no collision). `merge()` operates on the flat stored form and the (flattened) patch.

5. **Layout settings.** `layout_settings` (SUPPLEMENT §A.2 layout block: `width, height_type, height, content_position, horizontal_position, vertical_position, overlay, close_button, entrance_animation, exit_animation, ...`) are normal page settings — persist via the writer's settings path; do NOT route them through `save_display_settings_data()`.

6. **No conflict detection for popups.** Popup location is `multiple=true`; the create/display routes never compute condition conflicts (unlike WP-R01 theme docs). Conditions are still written via `Conditions_Helper::save()` with location implicitly `popup` (the doc's location).

7. **Gotchas (enforced):** `exit_intent` is toggle-only (no sub-control); `scrolling_offset` only meaningful when `scrolling_direction='down'` (warn, don't fail, if offset present without direction=down); the `times` group has THREE sub-keys (`times_times`, `times_period`, `times_count`). `schedule_server_datetime` is auto-filled/hidden — strip it from input if supplied.

8. **Error mapping (Contract 12).** Pro inactive → 501 `E_FEATURE_UNAVAILABLE`; post not found → 404 `E_NOT_FOUND`; target not a popup → 422 (`data.meta.actual_type`); validation fail → 422 `E_ATOMIC_VALIDATION`; not editable → 403 `NOT_EDITABLE`.

9. **Op-log + idempotency.** Both routes accept `op_id`; record one op-log row each. `set_display` is idempotent-merge; `create` is non-idempotent.

## Implementation Notes

- Reuse `Conditions_Helper` from WP-R01 for conditions; do NOT reimplement slash storage. The popup default condition is `include/general` so the popup matches the whole site (otherwise it never opens, `document.php:119-132`).
- `save_display_settings_data()` does a plain `update_main_meta` (`document.php:115-116`) — it does NOT run conditions/cache regen. The CSS regen for a popup happens via the normal `Document::save()` path (the writer) + the conditions save (`cache->regenerate()`). Ensure at least one of those ran.
- Persist `elements`/`layout_settings` through WP-P04's `Document_Writer` so backup-before-write, base_hash, lock/autosave, and prime-css are consistent with every other doc write. A popup with an atomic `elements` tree sets `prime_required:true` and accepts `prime_css:true`.
- Cast all toggle values to string; numeric sub-controls (`page_load_delay`, `times_times`, etc.) keep their numeric type — Elementor reads them as-is.
- PHPCS WordPress + WordPress-Extra clean; `path:line` comments on every Elementor call.

## Acceptance Criteria

- [ ] `POST /pro/popup` creates a `popup` doc (`get_type()==='popup'`), writes `layout_settings` to `_elementor_page_settings`, `display_settings` to `_elementor_popup_display_settings`, and conditions to `_elementor_conditions`.
- [ ] When `conditions` omitted, the popup defaults to `include/general` (verified in `_elementor_conditions`).
- [ ] `display_settings` round-trips: a `{triggers:{page_load:'yes',page_load_delay:2},timing:{times:'yes',times_times:3,times_period:'week',times_count:'close'}}` request is stored as the flat assoc and reads back identically.
- [ ] `PUT /pro/popup/{id}/display` merges (existing keys preserved, patched keys overwritten); returns the merged `{triggers,timing}`.
- [ ] Invalid toggle value (e.g. `page_load:'true'`) is normalized/flagged; unknown keys land in `unverified_keys[]` and are passed through, not rejected.
- [ ] Targeting a non-popup post with the display route → 422 with `actual_type`.
- [ ] Pro inactive → 501 `E_FEATURE_UNAVAILABLE` on both routes.
- [ ] `schedule_server_datetime` in input is stripped before storage.
- [ ] PHPCS clean; every Elementor call has a `path:line` comment.

## Tests Required

- PHPUnit (wp-env, Pro active): create popup; assert `_elementor_popup_display_settings` flat content == flattened request; assert `_elementor_page_settings` holds `layout_settings`; assert `_elementor_conditions` == `["include/general"]` by default.
- PHPUnit: display merge — seed `{page_load:'yes',page_load_delay:2}`, PUT `{triggers:{page_load_delay:5}}`, assert result has `page_load:'yes'` AND `page_load_delay:5`.
- PHPUnit: enum validation for `times_period`, `scrolling_direction`; `exit_intent` toggle-only.
- PHPUnit (Pro inactive): both routes 501.
- Fixtures: `packages/shared/fixtures/trees/pro/popup.create-page-load.json` and `popup.display-merge.json` with `requires:{pro:true}` (owned by this WP).

## Parallelization Notes

- Parallel-safe with all other PHP WP-R siblings (each owns disjoint service/helper files) and all TS WP-R.
- Depends on WP-R01 for `Pro_Controller`/`Pro_Gate`/`Conditions_Helper` — consumed via stable interface, no shared file edits.
- Sequencing: merge after WP-R01, WP-P03/P04/P05/P06, WP-S01 PASS.
