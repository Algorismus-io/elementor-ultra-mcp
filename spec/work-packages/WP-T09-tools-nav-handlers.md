---
id: WP-T09
title: TS tool handlers — navigation / menus (menus.list, menus.create, bind_widget)
layer: ts
phase: v1
status: planned
depends_on: [WP-F01, WP-F02, WP-F04, WP-F05, WP-T01, WP-T03, WP-P03, WP-P11]
files_owned:
  - packages/server/src/tools/nav.ts
  - packages/server/src/tools/nav.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §1.6 (nav/menus)
  - spec/contracts/10-rest-api.md §6 NAV
  - spec/contracts/12-error-taxonomy.md §3.5 (NOT_FOUND, PRO_REQUIRED), §5
estimate: S
---

## Summary

Implements the HANDLERS for the navigation tool group (Contract 13 §1.6) and attaches them to the WP-F04 registry: `nav.menus.list`, `nav.menus.create`, `nav.bind_widget`. These manage WordPress nav menus and bind a Pro nav-menu/mega-menu widget to a menu term. `bind_widget` is an element-tree write (sets `settings.menu` on a node) and goes through the transactional save path with `base_hash`.

## Interface / Contract

Attaches `ToolHandler`s; schemas owned by WP-F04 (Contract 13 §1.6):

- `nav.menus.list` (R, `GET /nav/menus`) — `{...page}` → `{items:[{term_id,name,slug,count}],next_cursor,total}`.
- `nav.menus.create` (M, `POST /nav/menus`) — `{name,items:[{title,url?,object_id?,type?,parent_index?}]}` → `{term_id,item_ids[]}`.
- `nav.bind_widget` (M, `PUT /documents/{id}/elements/{element_id}/nav-bind`) — `{post_id,element_id,term_id,base_hash}` → `{diff,base_hash}`. `idempotentHint`.

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ToolHandler`; `ctx.capabilities` for Pro probe). Code.
- WP-F02 (`WpRoutes.listMenus`/`createMenu`/`bindNavWidget`). Code via `ctx.wp`.
- WP-T03 (`presentDiff`/`isReplay`). Code.
- WP-F04 (catalog + `attachHandler`), WP-F05 (`toMcpResult`). Code.
- WP-P03 (PHP `dry_run` validator) — MANDATORY WRITE dependency: `bind_widget` mutates an element tree + persists transactionally (Contract 10 §6 / §0.9).
- WP-P11 (PHP nav controller) — runtime counterpart (contract dependency).
- Contract 13 §1.6, §0.6 (pagination), §0.8 (base_hash on the element write). Contract 10 §6 (`wp_create_nav_menu`+`wp_update_nav_menu_item`; bind sets `settings.menu`→derived `menu_id`, `elementor-pro .../nav-menu.php:69,1464-1485`). Contract 12 §3.5.

`bind_widget` is an element-tree WRITE → depends on WP-P03. It changes `settings.menu` (not styles) → NOT atomic-CSS-affecting → no prime-css/S01 gate. `menus.*` are WP-core menu primitives → no dry_run dependency.

## Detailed Requirements

1. Attach handlers for all three §1.6 tools; none are ★ (Contract 13 §5.2).
2. `nav.menus.list` paginates `{limit,cursor,fields}`→`{items,next_cursor,total}`.
3. `nav.menus.create` builds menu + items; `parent_index` references a sibling item index for hierarchy (PHP resolves `parent`); return `{term_id,item_ids[]}`. `type` defaults `custom`; `object_id`/`type` for page/category links (WP core menu semantics, Contract 10 §6).
4. `nav.bind_widget`: requires `base_hash` (element write); proxy the granular nav-bind route; PHP sets `settings.menu`→derived `menu_id` and persists via the transactional save (validate before write). Return `presentDiff(diff)`+new `base_hash`; surface `IDEMPOTENT_REPLAY`.
5. Pro gating: `bind_widget` targets a Pro nav-menu/mega-menu widget. Probe `ctx.capabilities.get().pro`; Pro-inactive → route 501 → render `PRO_REQUIRED` isError. `menus.*` work without Pro.
6. `NOT_FOUND` (post/element/term) → isError. Arg failures `-32602`. No `any`.

## Implementation Notes

- Thin handlers over WP-F02. The Pro binding mechanics (`settings.menu` from a `nav_menu` term) are PHP-side; the tool passes `term_id` + surfaces the diff.
- `menus.create` item shape mirrors Contract 13 §1.6; document `type` default + non-custom item fields.

## Acceptance Criteria

- [ ] Handlers attached for all three §1.6 tools.
- [ ] `menus.list` paginates; `menus.create` returns `{term_id,item_ids}` with hierarchy from `parent_index`.
- [ ] `bind_widget` requires base_hash, returns `{diff,base_hash}`, gates on Pro (`PRO_REQUIRED` when absent).
- [ ] `NOT_FOUND` → isError; arg errors `-32602`.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `tools/nav.test.ts` (vitest, no WP): mock `ctx.wp`/capabilities; assert I/O vs Contract 13; `bind_widget` base_hash+diff; Pro-inactive → `PRO_REQUIRED`; pagination + NOT_FOUND rendering.

## Parallelization Notes

- Owns only `tools/nav.ts` + test — disjoint from every other `tools/*`.
- Phase v1, Wave 2. `bind_widget` depends on WP-P03 for integration; no atomic-CSS gate. Parallel-safe with all handler WPs.
