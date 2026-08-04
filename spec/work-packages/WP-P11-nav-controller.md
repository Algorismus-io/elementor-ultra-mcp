---
id: WP-P11
title: Nav/Menus REST controller (list, create+populate, bind Pro nav widget to a menu term)
layer: php
phase: v1
status: planned
depends_on: [WP-P02, WP-P03, WP-P04]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-nav-controller.php
contract_refs:
  - spec/contracts/10-rest-api.md §6 (NAV routes), §0.3 (caps), §0.8 (base_hash)
  - spec/contracts/12-error-taxonomy.md §3.5 (NOT_FOUND)
estimate: S
---

## Summary

The WordPress navigation surface: list nav menus, create + populate a menu in one call, and bind a Pro nav-menu/mega-menu widget on a page to a menu term (a document write that goes through the writer/validator). Small but it is a genuine tree-WRITE for `bind-widget`, so it depends on the validator + writer.

## Interface / Contract

Registers (Contract 10 §6):

- `GET /nav/menus` (CAP_READ) — `{items:[{term_id,name,slug,count}]}` via `wp_get_nav_menus`. (§6)
- `POST /nav/menus` (CAP_MANAGE) — `{name,items:[{title,url,parent,object_id,type}],op_id}` → `{term_id,item_ids}` via `wp_create_nav_menu` + `wp_update_nav_menu_item`. (§6)
- `POST /nav/bind-widget` (CAP_EDIT_POST) — `{post_id,element_id,term_id,base_hash,op_id}` → `{success,base_hash}`; sets the Pro nav widget's `settings.menu` to the derived `menu_id`. (§6)

## Dependencies & Inputs

- WP-P02 (`Abstract_Controller`, `Permissions::can_read`/`can_manage`/`can_edit_post`, `Error`, `read_op_id`, `current_base_hash`).
- WP-P03 (validate the resulting tree on `bind-widget`), WP-P04 (`Document_Writer` for the `bind-widget` single-element write; `base_hash`/lock/backup). This is the universal WRITE-WP rule (`bind-widget` mutates a document).
- WP / Elementor APIs (cite `path:line`):
  - `wp_get_nav_menus()`, `wp_create_nav_menu()`, `wp_update_nav_menu_item()` (WP core nav-menu API).
  - Pro nav widget `settings.menu` derives the menu id: `elementor-pro .../modules/nav-menu/widgets/nav-menu.php:69` (control) and the menu options at `:1464-1485`. The bound value is the menu's `term_id` (or a derived `menu_id` string) used by the widget's `menu` control.
- Contract 10 §6 (route shapes), §0.8 (base_hash on bind-widget).

## Detailed Requirements

1. **list** (§6): `wp_get_nav_menus()` → map `{term_id,name,slug,count}`. CAP_READ.
2. **create** (§6): `wp_create_nav_menu($name)`; for each item `wp_update_nav_menu_item($term_id, 0, [...])` honoring `parent`/`object_id`/`type`/`url`/`title`; return the new `term_id` + ordered `item_ids`. CAP_MANAGE.
3. **bind-widget** (§6): read the document tree (`post_id`), locate `element_id`; assert it is a Pro nav-menu/mega-menu widget (widgetType `nav-menu`/`mega-menu`) — else 422; set its `settings.menu` to the value the widget's `menu` control expects for `term_id` (derive from the term per `nav-menu.php:69,1464-1485`); route the modified tree through `Document_Writer` (single validate + single save, `base_hash`/lock/backup). Return new `base_hash`. 404 `NOT_FOUND` if post/element/term missing.
4. **Pro gate**: `bind-widget` requires the Pro nav widget to be registered; if Pro inactive or the widget type absent → 422/501 with a clear message (the widget can't exist without Pro). Use `Guards::is_pro_active()`.
5. **op_id + op-log** on the two writes.

## Implementation Notes

- `bind-widget` is a surgical single-element update — reuse the WP-P06 granular `elements` op path conceptually (read-mutate-validate-save) but keep it self-contained in this controller (it owns its file); call `Document_Writer` for the actual transactional save rather than reimplementing locking.
- The exact `settings.menu` value format: the Pro `menu` control stores the selected menu's identifier; verify whether it expects the raw `term_id` or a string at `nav-menu.php:1464-1485` and set accordingly. Cite the line in a code comment.
- `create` items: WP nav-menu items are posts of type `nav_menu_item`; `wp_update_nav_menu_item` with `menu-item-title`/`menu-item-url`/`menu-item-parent-id`/`menu-item-object-id`/`menu-item-type` etc. Map the request fields to those keys.

## Acceptance Criteria

- [ ] `GET /nav/menus` returns existing menus with counts.
- [ ] `POST /nav/menus` creates a menu and populates items with correct parent nesting; returns `term_id`+`item_ids`.
- [ ] `POST /nav/bind-widget` sets the Pro nav widget's `menu` setting for the given term and returns a fresh `base_hash`; a missing post/element/term returns 404; a non-nav widget returns 422.
- [ ] `bind-widget` goes through the writer (validated, base_hash-checked, backed up) — never a raw meta write.
- [ ] With Pro inactive, `bind-widget` fails cleanly with a Pro-required message.
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_list_menus`; `test_create_menu_with_nested_items`; `test_bind_widget_sets_menu_setting` (Pro-gated; skipped on free); `test_bind_widget_404_missing`; `test_bind_widget_goes_through_writer`.

## Parallelization Notes

- Wave-2 vertical. Owns ONLY `class-nav-controller.php` — disjoint from all other controllers.
- Lists WP-P03 + WP-P04 because `bind-widget` is a document WRITE (universal rule). `bind-widget` is NOT atomic-CSS-affecting (it changes a setting, not styles) so it does NOT depend on WP-P05/S01.
- Parallel-safe with every other WP-P##.
