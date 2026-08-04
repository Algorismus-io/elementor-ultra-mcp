---
id: WP-F05
title: Error taxonomy (TS classes + PHP WP_Error map) + capability/experiment probe (both sides)
layer: foundation
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - packages/shared/src/errors/codes.ts
  - packages/shared/src/errors/payload.ts
  - packages/shared/src/errors/index.ts
  - packages/shared/src/capabilities/types.ts
  - packages/shared/src/capabilities/index.ts
  - packages/shared/schemas/error-payload.schema.json
  - packages/shared/schemas/capabilities.schema.json
  - packages/server/src/wp/errors.ts
  - plugin/elementor-ultra-mcp/includes/core/class-error-codes.php
  - plugin/elementor-ultra-mcp/includes/core/class-wp-error-map.php
  - plugin/elementor-ultra-mcp/includes/core/class-capabilities.php
  - packages/server/src/tools/discovery-capabilities.ts
contract_refs:
  - spec/contracts/12-error-taxonomy.md (full code list, two-axis mapping, WP_Error map, TS rules)
  - spec/01-architecture.md §2.5 (Seam E — error taxonomy + capability probe)
  - spec/01-architecture.md §7 (capability/experiment gating owned by PHP)
  - spec/contracts/10-rest-api.md (GET /site/capabilities; HTTP status mapping)
  - spec/contracts/13-tool-catalog.md (elementor.site.capabilities tool; capabilities resource)
estimate: M
---

## Summary

Implement Seam E on both sides of the wire: the frozen error taxonomy as a TS `ErrorCode` enum + `McpErrorPayload` type + JSON Schema AND as PHP constants + a `WP_Error`→code map, plus the capability/experiment probe — the PHP capabilities BUILDER (`class-capabilities.php`) that produces the `/site/capabilities` payload, its TS-side consumer, and the `elementor.site.capabilities` tool/resource backing. The `GET /site/capabilities` ROUTE registration lives in WP-P07's `class-schema-controller.php` (it consumes F05's `class-capabilities.php`) — F05 does NOT own that controller (disjoint-files rule). Error codes and capability field names are immutable identifiers every other WP reuses verbatim. This is the one foundation WP that owns matching code on BOTH the TS and PHP sides (its files are disjoint per-language, so still parallel-safe).

## Interface / Contract

- **`packages/shared/src/errors/codes.ts`.** The frozen `ErrorCode` union/enum (SCREAMING_SNAKE_CASE), ALL 29 codes from `12-error-taxonomy.md §6`: `VALIDATION_FAILED, SCHEMA_INVALID_PARAMS, ATOMIC_SETTINGS_INVALID, ATOMIC_STYLES_INVALID, UNKNOWN_WIDGET_TYPE, DUPLICATE_ELEMENT_ID, LOCAL_STYLE_UNLINKED, IMAGE_SRC_XOR_VIOLATION, HTML_V3_STRIPPED, LOCK_HELD, AUTOSAVE_CONFLICT, CONCURRENCY_STALE_HASH, IDEMPOTENT_REPLAY, BUDGET_EXCEEDED, DUPLICATED_LABEL, INVALID_ORDER, WATERMARK_STALE, CAPABILITY_MISSING, EXPERIMENT_INACTIVE, AUTH_FAILED, PRO_REQUIRED, WOO_CONTEXT_INVALID, NOT_FOUND, NOT_EDITABLE, CSS_PRIME_FAILED, IMPORT_REMAP_FAILED, RATE_LIMITED, UPSTREAM_ERROR, INTERNAL_ERROR`. Each code carries its frozen metadata: `http_status`, `retryable`, default `surface` ('protocol'|'isError'), `rpc_code` (when protocol).
- **`packages/shared/src/errors/payload.ts`.** The frozen `McpErrorPayload` type `{ code, message, http_status, retryable, surface, rpc_code, meta }` (`12-error-taxonomy.md §2`) + constructors + a per-code meta-key type table.
- **`error-payload.schema.json`.** JSON Schema for the payload (aligns with `diff.schema.json#/$defs/ValidationError`).
- **`packages/server/src/wp/errors.ts`.** TS mapping rules (`12-error-taxonomy.md §5`): Zod arg failure → `-32602` (`SCHEMA_INVALID_PARAMS`); `surface:isError` codes → tool result `{isError:true, content:[text]}` + structured payload; retry policy (retryable transient codes only; never concurrency); soft codes ride the diff/report unless they change semantics; destructive decline → clean non-error.
- **`includes/core/class-error-codes.php`.** PHP constants = the same 29 codes (`Elementor\Ultra\Error_Codes::ATOMIC_SETTINGS_INVALID` …).
- **`includes/core/class-wp-error-map.php`.** `to_wp_error(code, message, meta)` building a `WP_Error` with the taxonomy code slug + `add_data(['status'=>http])`, AND the inverse map from Elementor's own slugs (`global_classes_limit_exceeded→BUDGET_EXCEEDED`, `invalid_order→INVALID_ORDER`, `DUPLICATED_LABEL→DUPLICATED_LABEL`, caught `\Exception` "Settings validation failed."→`ATOMIC_SETTINGS_INVALID`, "Styles validation failed…"→`ATOMIC_STYLES_INVALID`) per `12-error-taxonomy.md §4`. NEVER leaks the raw throw message as a code; puts parser errors in `meta.parser_errors`.
- **`includes/core/class-capabilities.php`.** Builds the capabilities payload (the truth) `{v4, atomic, global_classes, variables, pro, pro_atomic_form, breakpoints[], experiments{}, can_update_class, classes_migrated}`.
- **`GET /site/capabilities` route — owned by WP-P07.** F05 does NOT register the route or own `class-schema-controller.php`. F05 provides `class-capabilities.php` (the payload builder); WP-P07's schema controller registers `GET /site/capabilities` (cap READ) and returns `Capabilities::build()` via the success envelope. F05 declares this as a consumer relationship, not an ownership.
- **`packages/server/src/tools/discovery-capabilities.ts`.** The `elementor.site.capabilities` tool handler + `elementor://site/capabilities` resource backing, calling `wp/routes.ts` `siteCapabilities()` and probing before features assume routes (`01-architecture.md §7`).

## Dependencies & Inputs

- Upstream: WP-F01 (scaffold). Soft contract link to WP-F02 (`wp/routes.ts` `siteCapabilities()` wrapper) and WP-F04 (the `site.capabilities` tool descriptor) — this WP attaches the handler to F04's registry entry and calls F02's wrapper. Sequence F02/F04 alongside; the capabilities tool handler can stub its route call until F02 lands.
- Contracts: `12-error-taxonomy.md` (full); `01-architecture.md §2.5/§7`; `10-rest-api.md` (`/site/capabilities`, HTTP mapping); `13-tool-catalog.md` (tool + resource).
- Elementor APIs (cited): `UPDATE_CLASS` cap `elementor_global_classes_update_class` granted in `add-capabilities.php:14,24`; experiment slugs `e_atomic_elements` (BETA/default-inactive, `atomic-widgets/module.php:193-195`), `e_classes`/`e_variables` (`global-classes/module.php:21,38-52`, `variables/hooks.php:48-51`), `e_opt_in_v4_page` (`atomic-opt-in/module.php:11`), `e_pro_atomic_form`, `e_wp_abilities_api`. Read via `\Elementor\Plugin::$instance->experiments->is_feature_active($slug)`; `current_user_can(...)` for cap flags; `classes_migrated` via the migration state.

## Detailed Requirements

1. **All 29 codes** present on BOTH sides with identical spelling. The TS enum and PHP constants must be asserted equal by a cross-language test (WP-F06/F07) — expose the list machine-readably (e.g. a generated `codes.json` both sides read, owned here under `packages/shared`).
2. **Two-axis metadata** per code (`http_status`, `retryable`, `surface`, `rpc_code`) matches `12-error-taxonomy.md §3` tables exactly.
3. **TS mapping rules** (`§5`) implemented in `wp/errors.ts`: arg/schema → `-32602`; isError codes → result; retry policy (retryable transient retried, concurrency never); soft-code handling; destructive decline → clean result.
4. **PHP WP_Error map** (`§4`) implemented: forward map (code→WP_Error+status) and reverse map (Elementor slug / caught exception → taxonomy code), with parser errors in `meta`. The validator (WP-P03) imports this map.
5. **Capabilities payload** built by `class-capabilities.php` with EXACT field names: `v4, atomic, global_classes, variables, pro, pro_atomic_form, breakpoints[], experiments{}, can_update_class, classes_migrated`. `can_update_class = current_user_can('elementor_global_classes_update_class')`. `classes_migrated` reflects the migration that grants UPDATE_CLASS. Document each field's Elementor source.
6. **`/site/capabilities` route** is registered by WP-P07 (not F05) and returns `Capabilities::build()` (F05's builder) via `{success:true,data:<payload>}` (READ cap, no nonce, App-Password Basic). F05 ensures `class-capabilities.php` exposes a stable `build()` returning the exact field set so P07 can call it.
7. **TS probe** — `elementor.site.capabilities` tool + resource return the payload; provide a `probeCapabilities(site)` helper other tool WPs call before assuming a route (`v4` fallback ladder, `EXPERIMENT_INACTIVE`/`PRO_REQUIRED` gating).
8. **`capabilities.schema.json`** + `error-payload.schema.json` authored (draft 2020-12, meta-valid) so fixtures validate capability/error shapes.

## Implementation Notes

- This is the ONE foundation WP touching both languages. Files are split by language and disjoint, so it stays parallel-safe. F05 does NOT own any REST controller — the `/site/capabilities` route is registered by WP-P07's `class-schema-controller.php`, which `require`s F05's `Capabilities::build()`. The seam is purely a function call (`Capabilities::build()` → array payload); P07 owns the route + envelope, F05 owns the payload builder + the field set. Keep `class-capabilities.php`'s `build()` signature stable so P07 (and any caller) depends only on the contract, not the implementation.
- Do NOT string-match the atomic throw text; the PHP map catches the `\Exception` type and classifies by the controller path that threw (`12-error-taxonomy.md §4`).
- Capabilities probing is mandatory before any feature assumes a route exists (`01-architecture.md §7`, `15-engineering-standards.md`).
- `experiments{}` should map each known slug → active boolean so callers can gate precisely.

## Acceptance Criteria

- [ ] TS `ErrorCode` and PHP `Error_Codes` contain identical 29 codes; a machine-readable `codes.json` is the single source both read; cross-language equality is testable.
- [ ] Each code's `http_status`/`retryable`/`surface`/`rpc_code` matches `12-error-taxonomy.md §3`.
- [ ] `wp/errors.ts` maps arg failures to `-32602`, isError codes to results, applies the retry policy, and never auto-retries concurrency codes.
- [ ] PHP `to_wp_error()` builds correct status; the reverse map covers all `§4` Elementor slugs + caught exceptions; raw throw text never becomes a code.
- [ ] `Capabilities::build()` returns the exact field set; `can_update_class` reflects `current_user_can(UPDATE_CLASS)`; experiment flags reflect `is_feature_active` (the `GET /site/capabilities` route that returns it is wired by WP-P07 and asserted there).
- [ ] `elementor.site.capabilities` tool + `elementor://site/capabilities` resource return the payload; `probeCapabilities()` helper available.
- [ ] Both JSON schemas meta-valid; `pnpm build` + `pnpm lint` + `composer phpcs` clean.

## Tests Required

- Unit (vitest): error mapping (arg→-32602, isError, retry policy, soft codes, destructive decline); capabilities probe parse.
- Unit (PHPUnit/wp-env): `to_wp_error` status + slug; reverse map for each Elementor slug + a simulated caught exception; capabilities payload field set + `can_update_class`/experiment reflection.
- Contract: cross-language code-set equality (TS enum == PHP constants == `codes.json`).
- Contract: capabilities payload validates against `capabilities.schema.json`; error payloads validate against `error-payload.schema.json`.
- Fixtures: capability payloads for free-only vs Pro vs atomic-off installs (consumed by the `requires` skip mechanism, `14-fixtures-harness.md §2`).

## Parallelization Notes

- Wave 0/Wave 1, parallel-safe with WP-F02/F03/F04/F06 (disjoint files). It is the soonest dependency for: WP-F02 (imports `ErrorCode`), every TS tool WP (uses `wp/errors.ts` + `probeCapabilities`), and every PHP write WP (uses `class-wp-error-map.php` + `class-capabilities.php`). Land it early in Wave 1.
- Does NOT own any REST controller (disjoint from WP-P07 which owns `class-schema-controller.php` + the `/site/capabilities` route). WP-P07 consumes F05's `Capabilities::build()`; WP-P03 (validator) imports F05's `class-wp-error-map.php`. All consumer relationships, not file overlaps.

## Spike-Verified Corrections (Wave 1)

- **[S05]** The `CAPABILITY_MISSING` error and the capability probe MUST use the literal cap string `elementor_global_classes_update_class`. The correct FQCN (for reference, not for import at activation) is `Elementor\Modules\GlobalClasses\Database\Migrations\Add_Capabilities` at `wp-content/plugins/elementor/modules/global-classes/database/migrations/add-capabilities.php` — NOT `Utils\Add_Capabilities` (does not exist; would fatal). There are no `create_class`/`delete_class` caps; `UPDATE_CLASS` is the single admin-only cap gating all global-class writes.
- **[S05]** The `site/capabilities` probe MUST compute `can_update_class` as exactly `current_user_can('elementor_global_classes_update_class')` for the authenticated user — this is the same predicate Elementor's PUT gate uses (`wp-content/plugins/elementor/modules/global-classes/global-classes-rest-api.php:154`) and the spike confirmed it tracks live state across processes (cap removed → PUT 403; re-granted → PUT non-403).
- **[S05]** A false `can_update_class`, and any `403 rest_forbidden` ("Sorry, you are not allowed to do that.", `{"data":{"status":403}}`) on `PUT /elementor/v1/global-classes`, MUST map to `CAPABILITY_MISSING`. GET routes use `is_user_logged_in()` and are NOT gated by this cap.
