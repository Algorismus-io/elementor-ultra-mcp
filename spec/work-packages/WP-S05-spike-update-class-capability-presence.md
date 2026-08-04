---
id: WP-S05
title: Spike — UPDATE_CLASS capability presence for the agent user on a target install
layer: spike
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - spec/spikes/S05-update-class-capability-presence.md
  - spec/spikes/scripts/s05-probe-update-class.php
contract_refs:
  - RESEARCH.md §0 (S5 secondary), §8 (UPDATE_CLASS migration grant, line ~669)
  - spec/contracts/15-engineering-standards.md §6 (S5 gates design.classes.* writes)
  - spec/contracts/12-error-taxonomy.md (CAPABILITY_MISSING)
  - spec/contracts/10-rest-api.md (CAP_UPDATE_CLASS gate; PUT /design/classes)
estimate: S
---

## Summary

Verify whether `UPDATE_CLASS` (`elementor_global_classes_update_class`) is actually present for the agent's admin App-Password user on a representative install, and under which conditions it is MISSING (fresh-activation timing, role-management plugins, custom admin-equivalent roles, multisite role sync). Confirms the necessity of the companion plugin's idempotent activation grant. Gates all design-system class writes.

## Interface / Contract

- **QUESTION (RESEARCH.md §0, S5):** Is `UPDATE_CLASS` present for the agent user on the target install? When is it absent despite admin privileges?
- **METHOD:** In wp-env, probe `current_user_can('elementor_global_classes_update_class')` for the admin user (`s05-probe-update-class.php`) under scenarios: (a) Elementor active, migration run; (b) simulated migration-not-run; (c) a custom admin-equivalent role. Confirm whether `add_cap(UPDATE_CLASS)` on activation fixes the missing cases idempotently.
- **PASS CRITERION:** A definitive report of when the cap is present vs absent, and confirmation that the idempotent activation grant (WP-P01) restores it for `administrator` + a configured agent role.
- **GATES:** Design-system class writes (`design.classes.*`, `design.deploy`). Mitigated by the activation grant (WP-P01) but the `site/capabilities` probe of `can_update_class` is still required (`12-error-taxonomy.md` `CAPABILITY_MISSING`).

## Dependencies & Inputs

- Upstream: WP-F01 (wp-env). No product code dependency.
- Contracts: RESEARCH.md §0 (S5), §8 (line ~669 — migration grants to `administrator` only; absence → 403 on ALL global-class writes); `15-engineering-standards.md §6`; `12-error-taxonomy.md` `CAPABILITY_MISSING`; `10-rest-api.md` (`CAP_UPDATE_CLASS`, `PUT /design/classes` gated on it).
- Elementor APIs (cited): `UPDATE_CLASS` granted by DB migration `add-capabilities.php:14,24` (to `administrator` only); the global-classes REST `permission_callback` `current_user_can(Add_Capabilities::UPDATE_CLASS)` (`global-classes-rest-api.php:154`).

## Detailed Requirements

1. Probe `current_user_can(UPDATE_CLASS)` for the admin user across the scenarios above.
2. Simulate the migration-not-run case (remove the cap) and confirm a global-class write returns 403 → `CAPABILITY_MISSING`.
3. Apply an `add_cap(UPDATE_CLASS)` to `administrator` (and a configured agent role) idempotently; re-probe; confirm restored and that re-running is a no-op.
4. Record in `S05-...md`: present/absent matrix, the 403 reproduction, confirmation the activation grant fixes it idempotently, and the exact `add_cap` call WP-P01 must make (`administrator` + configurable agent role).
5. Confirm `site/capabilities` `can_update_class` reflects the live `current_user_can` (cross-check with WP-F05's capabilities payload).

## Implementation Notes

- Throwaway script; WP-P01 (plugin bootstrap/activation) implements the idempotent grant in `elementor-ultra-mcp.php`/its activation handler informed by this note.
- The grant must be idempotent (re-activation safe) and configurable for an agent role beyond `administrator` (RESEARCH.md §8).

## Acceptance Criteria

- [ ] A present/absent matrix for `UPDATE_CLASS` across the scenarios is recorded.
- [ ] The missing-cap → 403 on global-class write is reproduced and mapped to `CAPABILITY_MISSING`.
- [ ] The idempotent `add_cap(UPDATE_CLASS)` grant is shown to restore the cap and to be re-run-safe.
- [ ] `S05-...md` records the matrix, the 403 repro, the grant confirmation, and the exact `add_cap` target roles for WP-P01.
- [ ] Spike-gate status for S5 updated so design-system class-write WPs can start.

## Tests Required

- The spike IS the probe (matrix + note). The activation-grant idempotency test is specified here and implemented by WP-P01.

## Parallelization Notes

- Wave 0 (spike week), parallel-safe with all other spikes (disjoint `spec/spikes/*` files). Depends only on WP-F01.
- GATES the design-system vertical's class-write WPs (gate dependency). Mitigated by WP-P01's grant + the WP-F05 `can_update_class` probe.
