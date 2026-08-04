---
id: WP-P16
title: WP Abilities API secondary path — abilities + own create_server() via mcp-adapter (graceful no-op when absent)
layer: php
phase: ULTRA
status: planned
depends_on: [WP-P01, WP-P03, WP-P04, WP-P05, WP-P07, WP-S01]
files_owned:
  - plugin/elementor-ultra-mcp/includes/abilities/class-abstract-ability.php
  - plugin/elementor-ultra-mcp/includes/abilities/class-ability-definition.php
  - plugin/elementor-ultra-mcp/includes/abilities/class-save-elements-ability.php
  - plugin/elementor-ultra-mcp/includes/abilities/class-read-structure-ability.php
  - plugin/elementor-ultra-mcp/includes/abilities/class-dry-run-ability.php
  - plugin/elementor-ultra-mcp/includes/abilities/class-capabilities-ability.php
  - plugin/elementor-ultra-mcp/includes/abilities/class-server-registrar.php
contract_refs:
  - spec/contracts/10-rest-api.md §12 (abilities_adapter_present), §11 (op-log wiring), §0 (auth/caps)
  - spec/contracts/15-engineering-standards.md §1 (optional mcp-adapter, graceful no-op), §5 secondary path
estimate: M
---

## Summary

The OPTIONAL secondary integration path: when the `wordpress/mcp-adapter` is present, register a set of WP Abilities (read structure, dry-run, save elements, capabilities) and our OWN `create_server()` so an in-WordPress MCP endpoint (`/wp-json/elementor-ultra/mcp`) is available alongside the external TS server. When the adapter is absent (the common case), this whole layer is a graceful no-op. The abilities are thin wrappers over the SAME core services the REST controllers use, so there is one implementation of truth.

## Interface / Contract

- `\Elementor\Ultra\Abilities\Server_Registrar` — hooks `mcp_adapter_init` (the adapter's bootstrap action). If the adapter is present, calls `create_server()` registering the abilities and exposing `/wp-json/elementor-ultra/mcp`. If absent, does nothing (no errors, no notices beyond `site/capabilities.abilities_adapter_present:false`).
- `\Elementor\Ultra\Abilities\Abstract_Ability` (abstract) — base each ability extends: declares name, description, input/output schema, capability gate, and `execute( array $input )` that delegates to a core service.
- `\Elementor\Ultra\Abilities\Ability_Definition` — value object describing an ability for registration (name, schemas, permission callback).
- Concrete abilities (MVP-minimal set, expandable):
  - `Read_Structure_Ability` → `Documents` read (delegates to the same read path as `GET /documents/{id}`). CAP_READ.
  - `Dry_Run_Ability` → `Validator::dry_run` (AUTHORITATIVE). CAP_EDIT_POST.
  - `Save_Elements_Ability` → `Document_Writer::save` (+ prime-css). CAP_EDIT_POST.
  - `Capabilities_Ability` → the `site/capabilities` payload (WP-P07 helper). CAP_READ.

## Dependencies & Inputs

- WP-P01 (`Guards`, `abilities_adapter_present` detection; the optional `wordpress/mcp-adapter` Composer dep is declared in WP-P01's `composer.json` as optional), WP-P03 (`Validator`), WP-P04 (`Document_Writer`), WP-P05 (`Css_Primer`), WP-P07 (the `site/capabilities` assembler / registered-types helper).
- WP-S01 (Save_Elements_Ability primes atomic CSS → atomic-CSS rule).
- APIs (cite where verifiable):
  - The `wordpress/mcp-adapter` package's `create_server()` + ability registration (`wp_register_ability` / the adapter's API). Guard ALL adapter symbols with `class_exists`/`function_exists` — the adapter is optional (Contract 15 §1, §5 secondary path).
  - Reuses the SAME core services as the REST controllers (no duplicate logic).
- Contract 10 §12 (`abilities_adapter_present` flag), §11 (op-log wired to the same store — abilities call `Op_Log::record`). Contract 15 §1 (optional adapter, graceful no-op), §5 (secondary path).

## Detailed Requirements

1. **Graceful absence** (Contract 15 §1): `Server_Registrar` checks for the adapter (`class_exists` of the adapter's server/ability class). If absent → return immediately; the plugin's primary REST path (WP-P02..P15) is fully functional without it. NO fatal, NO admin notice (just the capabilities flag).
2. **create_server() (secondary path)** (RESEARCH §5 secondary path, Contract 15 §5): when present, on `mcp_adapter_init` register an MCP server exposing the abilities at `/wp-json/elementor-ultra/mcp`. Auth + capability gating reuse the SAME App-Password/`current_user_can` boundary as REST (Contract 10 §0.2/§0.3).
3. **Abilities delegate to core services** (single source of truth): each ability's `execute()` calls the corresponding core service (`Validator`/`Document_Writer`/read path/`site/capabilities`). NO business logic is duplicated; the ability is a schema + permission + delegation shell. Dry-run remains AUTHORITATIVE (Contract 10 §0.9). Save primes atomic CSS (Contract 10 §0.10, S1).
4. **Schemas**: each ability declares input/output schemas consistent with the corresponding REST route payloads (Contract 10 §2/§12) so an MCP client of the secondary path sees the same shapes.
5. **Op-log wiring** (Contract 10 §11): ability writes call `Op_Log::record` (WP-P14, guarded) — the same store as REST, so the audit trail is unified.
6. **Capability flag** (Contract 10 §12): WP-P07's `site/capabilities` reports `abilities_adapter_present` via `Guards` — this WP ensures the detection is accurate (it owns the registrar that knows whether the adapter loaded).
7. **Minimal but real**: implement the four abilities above as a working secondary path; additional abilities can be added later as new files (disjoint). The point is to prove the secondary path works when the adapter is installed, not to mirror all 74 routes.

## Implementation Notes

- The `wordpress/mcp-adapter` API surface is version-sensitive; pin behind `class_exists`/`function_exists` and degrade silently. Cite the adapter's bootstrap action name (`mcp_adapter_init`) in a comment; verify against the installed adapter version at build time.
- Because abilities delegate to core services, they automatically inherit validation, locking, backup, and priming — do not reimplement any of it.
- This is ULTRA-phase and OPTIONAL; it must never affect the primary REST path's correctness or performance when the adapter is absent.
- Keep the registrar's hook registration cheap; only construct ability objects when the adapter is actually present.

## Acceptance Criteria

- [ ] With the mcp-adapter ABSENT, the plugin loads and serves all REST routes normally; no fatal/notice; `site/capabilities.abilities_adapter_present:false`.
- [ ] With the mcp-adapter PRESENT, `/wp-json/elementor-ultra/mcp` exposes the four abilities; `site/capabilities.abilities_adapter_present:true`.
- [ ] `Dry_Run_Ability` returns the SAME `DryRunResult` as the REST `dry-run` (same validator).
- [ ] `Save_Elements_Ability` goes through `Document_Writer` (validated, locked, backed up) and primes atomic CSS (S1-gated).
- [ ] Ability writes appear in the same op-log as REST writes.
- [ ] Ability auth/cap gating matches the REST boundary (App-Password + `current_user_can`).
- [ ] PHPCS clean.

## Tests Required

- PHPUnit (wp-env): `test_no_adapter_is_noop`; `test_capabilities_flag_reflects_adapter`. The adapter-present tests run only when the adapter is installed in wp-env (skipped otherwise): `test_create_server_registers_abilities`; `test_dry_run_ability_matches_rest`; `test_save_ability_goes_through_writer`; `test_ability_writes_op_log`.

## Parallelization Notes

- Wave-3 (ULTRA) vertical. Owns the entire `includes/abilities/` tree — disjoint from all REST controllers and core services.
- Delegates to core services (WP-P03/P04/P05/P07) via their frozen interfaces; consumes WP-P14 `Op_Log` behind a guard. Wired into `Plugin::init()` by WP-P01 via FQN behind a `class_exists` guard (WP-P01 does not edit this file).
- Parallel-safe with every other WP-P##; entirely additive and optional.
