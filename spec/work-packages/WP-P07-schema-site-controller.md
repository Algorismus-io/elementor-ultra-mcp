---
id: WP-P07
title: Schema + Site controller (widget/styles/registered-types/breakpoints + site/capabilities probe)
layer: php
phase: MVP
status: planned
depends_on: [WP-P01, WP-P02]
files_owned:
  - plugin/elementor-ultra-mcp/includes/rest/class-schema-controller.php
contract_refs:
  - spec/contracts/10-rest-api.md §3 (SCHEMA routes), §12 (SITE capabilities)
  - spec/contracts/11-authoring-contract.md §4 (atomic types), §5.2 (Style-Schema), §2.2 note (_cssid)
  - spec/contracts/15-engineering-standards.md §7 (version guards report via capabilities)
estimate: M
---

## Summary

The read-only schema and capability surface. It exposes the POST-FILTER per-widget prop schema (incl auto-injected `_cssid` and Pro-injected props), the flat atomic Style-Schema with units/states/enums, the site's registered elTypes/widgetTypes, the active breakpoints, and the single most-called probe `site/capabilities` (experiments, Pro, atomic availability, UPDATE_CLASS, migrations, breakpoints, health). Everything here is cacheable and CAP_READ. The validator (WP-P03) and the whole TS server gate behavior on this controller's output.

## Interface / Contract

Registers (Contract 10 §3, §12), all CAP_READ:

- `GET /schema/widget/{type}` (§3.1) — POST-FILTER `get_props_schema()` for an atomic widget/container; `get_controls()` for classic. `data`: `{type,generation,is_container,props_schema,dynamic_props,version}` (atomic) or `{type,generation:"v3",controls}` (classic).
- `GET /schema/styles` (§3.2) — flat `Style_Schema::get_style_schema()` (post `elementor/atomic-widgets/styles/schema` filter, runtime-extended background) + unit presets + states. `data`: `{props,units,states}`.
- `GET /schema/registered-types` (§3.3) — `{elements,widgets,atomic_available,pro_active}`.
- `GET /schema/breakpoints` (§3.4) — `{items:[{key,label,direction,value}],active_direction,desktop_first}`.
- `GET /site/capabilities` (§12) — the full probe payload (see Detailed Requirements #5).

Also exposes a reusable internal helper consumed by WP-P03/P05 (read-only, no new file):
- `Schema_Controller::registered_types(): array{elements,widgets}` and `Schema_Controller::breakpoints(): array` — but since cross-WP code reuse must not edit another WP's file, these are exposed as static methods on THIS controller class that other WPs MAY call (they depend on this WP) OR recompute themselves. The canonical source is this controller.

## Dependencies & Inputs

- WP-P01 (`Guards` — `is_pro_active`, `atomic_available`, `experiments_map`, `can_update_class`, version getters), WP-P02 (`Abstract_Controller`, `Permissions::can_read`, pagination not needed here).
- Elementor APIs (cite `path:line`):
  - `get_props_schema()` on an atomic widget instance (post-filter, incl auto-injected `_cssid` per Contract 11 §2.2 note / `has-atomic-base.php:310-321`, and Pro `display-conditions` injected via `elementor/atomic-widgets/props-schema`). Instantiate via `widgets_manager->get_widget_types($type)` or `elements_manager`.
  - `modules/atomic-widgets/styles/style-schema.php` `Style_Schema::get_style_schema()` (post `elementor/atomic-widgets/styles/schema` filter).
  - `core/breakpoints/manager.php:17-23` for breakpoint keys; `Breakpoints_Manager::get_active_breakpoints()` for direction/value.
  - `widgets_manager->get_widget_types()` + `elements_manager->get_element_types()` for registered types.
  - `Size_Constants` unit presets (SUPPLEMENT §B.3) for `schema/styles.units`.
  - `Style_States` (`styles/style-states.php:6-12`) for `states`: `[hover,active,focus,focus-visible,checked,e--selected]` (plus `null` normal).
  - `wp_is_application_passwords_available()` for `app_passwords_available`.
  - `is_multisite()` for `multisite`.
- Contract 10 §3 (schema route payloads), §12 (capabilities payload — field names are frozen). Contract 11 §4 (atomic element types), §5.2 (Style-Schema + states), §2.2 note (`_cssid` tolerated). Contract 15 §7 (refuse incompatible majors but report via capabilities; never fatal).

## Detailed Requirements

1. **schema/widget** (§3.1): for an atomic type, instantiate and return the POST-FILTER `get_props_schema()` normalized to `{prop_name -> {kind,key,default,settings:{enum?,units?,required?},dynamic?:{active,categories}}}`. Include `_cssid` if Elementor injects it (do not strip — Contract 11 §2.2 note). `dynamic_props` lists props flagged dynamic-capable. For classic types return `get_controls()` under `controls`. 404 `NOT_FOUND` for an unregistered type.
2. **schema/styles** (§3.2): return the flat css-prop→Prop_Type map, normalized to `{prop -> {kind,key,enum?,members?(union),units?}}`; include `units` presets (`standard`/`typography`/etc) and `states`. This is what the TS pre-filter and validator consult for native-prop validity (Contract 11 §5.2, §8 R8).
3. **schema/registered-types** (§3.3): `{elements,widgets,atomic_available,pro_active}` — used by validation R2 (Contract 11 §8). `atomic_available`=`Guards::atomic_available()`, `pro_active`=`Guards::is_pro_active()`.
4. **schema/breakpoints** (§3.4): read live breakpoints — NEVER hardcode 767/1024 (Contract 10 §3.4). `direction` ∈ `min|max`; include `active_direction` and `desktop_first`.
5. **site/capabilities** (§12): assemble the FULL payload with EXACTLY these keys (frozen): `elementor_version, pro_version, pro_active, atomic_available, v4_default, experiments{e_atomic_elements,e_classes,e_variables,e_opt_in_v4_page,e_pro_atomic_form,e_wp_abilities_api}, global_classes, variables, classes_migrated, can_update_class, unfiltered_html, breakpoints[], registered_types{elements,widgets}, multisite, is_local, app_passwords_available, abilities_adapter_present, plugin_version, health`. Values:
   - `experiments` values ∈ `active|inactive|default` (via `Guards::experiment_state`).
   - `can_update_class` = `Guards::can_update_class()`.
   - `classes_migrated` = whether the `migrate-to-posts` migration ran (RESEARCH.md §2.2) — probe the migration state; default `true` if the `e_global_class` CPT is registered and queryable.
   - `unfiltered_html` = `current_user_can('unfiltered_html')`.
   - `is_local` = heuristic (host is `.local`/`localhost`/`127.0.0.1` OR `WP_ENVIRONMENT_TYPE` in `local|development`).
   - `abilities_adapter_present` = `class_exists` for the mcp-adapter (the WP-P16 secondary path).
   - `health` = `ok` normally, `degraded` when Elementor is below `MIN_ELEMENTOR` or atomic is unavailable but expected (Contract 15 §7).
6. **No fatal on incompatible Elementor** (Contract 15 §7): `site/capabilities` MUST still respond (with `health:degraded`) even when controllers that need Elementor are not booted — it is the diagnostic of last resort.
7. **Caching**: schema responses are expensive; cache `schema/widget`/`schema/styles`/`registered-types` in a transient keyed by Elementor+Pro version (so the schema-drift job and a version bump invalidate them). `site/capabilities` is NOT cached (it reflects per-user caps like `can_update_class`).

## Implementation Notes

- The POST-FILTER schema is the authoritative one (Contract 11 §4.1: "`get_props_schema()` (post-filter) is authoritative"). Do NOT return the static free schema — instantiate the real widget so Pro's `display-conditions` and runtime background sub-schema appear. This is also what the schema-drift baseline snapshots (Contract 14 §5).
- Normalize away volatile fields (labels/descriptions) is the DRIFT job's concern, not this controller's — return the full schema; the snapshot script normalizes. But DO produce a stable, deterministic key order to make the drift diff readable.
- `site/capabilities` is the most-called route (Contract 10 §12) — keep it fast; the experiment/version lookups are cheap. Per-user fields (`can_update_class`,`unfiltered_html`) mean no cross-user caching.
- Experiment slugs come from RESEARCH.md §8 / Contract 10 §12 — if a slug is unregistered on this Elementor version, report `default` (Guards handles this).
- `registered_types` and `breakpoints` static helpers: other WPs (WP-P03 validator, WP-P05 primer) MAY call them, but to keep file ownership disjoint they call them via this class (depending on WP-P07) OR recompute. Prefer recompute in WP-P03 for build independence; this controller remains the canonical REST surface.

## Acceptance Criteria

- [ ] `schema/widget/e-heading` returns a post-filter `props_schema` including `_cssid` and (when Pro active) `display-conditions`; an unregistered type returns 404.
- [ ] `schema/styles` returns the flat css-prop map + `units` + `states` (`[hover,active,focus,focus-visible,checked,e--selected]`).
- [ ] `schema/registered-types` lists real atomic + classic types with correct `atomic_available`/`pro_active`.
- [ ] `schema/breakpoints` returns live breakpoints with `direction`/`value` (no hardcoded 768/1024).
- [ ] `site/capabilities` returns ALL frozen keys from Contract 10 §12 with `experiments` values in `{active,inactive,default}` and `can_update_class` reflecting the current user.
- [ ] `site/capabilities` responds even when Elementor is below MIN (with `health:degraded`).
- [ ] Schema responses are transient-cached keyed by Elementor+Pro version; `site/capabilities` is not cached.
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_schema_widget_postfilter_includes_cssid`; `test_schema_widget_unknown_type_404`; `test_schema_styles_shape`; `test_registered_types`; `test_breakpoints_live`; `test_capabilities_full_shape`; `test_capabilities_can_update_class_per_user`; `test_capabilities_responds_when_elementor_degraded`.
- Contract: the schema-drift baseline (Contract 14 §5) snapshots `schema/widget`/`schema/styles` from this controller — assert the snapshot script can fetch them.
- The TS smoke suite hits `site.capabilities`, `schema.widget`, `schema.styles`, `breakpoints.get` (lean ★ tools).

## Parallelization Notes

- Wave-2 vertical. Owns ONLY `class-schema-controller.php` — disjoint from all other controllers.
- Read-only: no WRITE-WP dependency on the validator/writer (it persists nothing). Depends only on WP-P01/P02.
- Parallel-safe with WP-P06 and WP-P08..P16. WP-P03 (validator) may consume its registered-types/breakpoints helpers (contract dependency only, no file edit).
