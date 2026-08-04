---
id: WP-S06
title: Spike — Application Passwords over plain HTTP on LocalWP/wp-env (the local auth path)
layer: spike
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - spec/spikes/S06-app-password-over-http.md
  - spec/spikes/scripts/s06-probe-app-password.mjs
  - spec/spikes/scripts/s06-enable-local-filter.php
contract_refs:
  - RESEARCH.md §0 (S6 secondary), §8 (App-Password local/dev caveat, line ~679)
  - spec/contracts/15-engineering-standards.md §6 (S6 gates the whole REST auth path on local/dev)
  - spec/contracts/12-error-taxonomy.md (AUTH_FAILED)
  - spec/contracts/10-rest-api.md (Auth = App Passwords / HTTP Basic, no nonce)
estimate: S
---

## Summary

Verify whether WordPress Application Passwords work over plain HTTP on LocalWP/wp-env (the agency local/dev target), and whether the local-environment filter is needed when `wp_is_application_passwords_available()` returns false. This is the foundation of the ENTIRE REST auth path on local installs — every proxied tool depends on Basic auth reaching the custom routes.

## Interface / Contract

- **QUESTION (RESEARCH.md §0, S6):** Does `wp_is_application_passwords_available()` return true on LocalWP/wp-env over plain HTTP without a filter? If false, does the `is_local` / local-environment filter enable it?
- **METHOD:** In wp-env over plain HTTP: (1) check `wp_is_application_passwords_available()` (`s06-probe-app-password.mjs` drives a probe route or WP-CLI eval); (2) generate an App Password; (3) call a custom `elementor-ultra/v1` READ route + a `wp/v2` route with `Authorization: Basic`; (4) if unavailable, apply the local-environment filter (`s06-enable-local-filter.php`) and retry.
- **PASS CRITERION:** Either App Passwords work out-of-the-box over local HTTP, OR the exact filter that enables them is identified and confirmed working; a definitive setup note for local/dev.
- **GATES:** The whole REST auth path on local/dev installs (foundation for every proxied tool). Flags whether the local-environment filter must ship with the plugin (or be a documented setup step). `AUTH_FAILED` conditions recorded.

## Dependencies & Inputs

- Upstream: WP-F01 (wp-env, `.wp-env.json`). No product code dependency.
- Contracts: RESEARCH.md §0 (S6), §8 (line ~679 — App Passwords normally require HTTPS but WP permits on `is_local`; if false over HTTP, set the filter; production needs HTTPS); `15-engineering-standards.md §6`; `12-error-taxonomy.md` `AUTH_FAILED`; `10-rest-api.md` (App-Password Basic, no nonce).
- Elementor APIs (cited): Elementor's own MCP documents App-Password + Basic (`module.php:31`). WordPress `wp_is_application_passwords_available()`, `wp_is_application_passwords_available_for_user()`, and the `wp_is_application_passwords_available` / `is_local` environment filters.

## Detailed Requirements

1. Probe `wp_is_application_passwords_available()` over plain HTTP on wp-env (and document LocalWP if available).
2. Generate an App Password; call both a custom `elementor-ultra/v1` READ route and a `wp/v2` route with `Authorization: Basic base64(user:app-password)`; confirm 200 (reaches custom routes via `current_user_can`, no nonce).
3. If unavailable, apply the local-environment filter and confirm the calls then succeed; record the EXACT filter + how to ship it (plugin filter vs documented step).
4. Confirm Basic auth does NOT reach admin-ajax `save_builder` (the reason the custom save route exists) — sanity check, RESEARCH.md §8.
5. Record in `S06-...md`: availability verdict, the filter (if needed) + ship recommendation, the `AUTH_FAILED` conditions, and the per-site setup steps (install plugin → admin user with `unfiltered_html` → generate App Password → verify via `site/capabilities`).

## Implementation Notes

- Throwaway scripts; if a filter is needed, WP-P01 (plugin bootstrap) may ship it guarded behind `wp_get_environment_type()==='local'` (its own file). Production needs HTTPS — never enable the filter in non-local environments.
- The probe should hit a real READ route (e.g. `GET /site/capabilities` once WP-F05 exists, or a `wp/v2` route in the interim).

## Acceptance Criteria

- [ ] App-Password availability over plain HTTP on wp-env is determined.
- [ ] A Basic-auth call to a custom `elementor-ultra/v1` route + a `wp/v2` route succeeds (directly or after the filter).
- [ ] If a filter is required, the exact filter + a `is_local`-guarded ship recommendation is recorded.
- [ ] `S06-...md` records the verdict, the filter (if any), `AUTH_FAILED` conditions, and the per-site setup steps.
- [ ] Spike-gate status for S6 updated so the auth/dev-env path is unblocked.

## Tests Required

- The spike IS the probe (verdict + note). The local-filter ship (if any) is implemented + tested by WP-P01.

## Parallelization Notes

- Wave 0 (spike week), HIGH priority (auth underpins every proxied tool). Parallel-safe with all other spikes (disjoint `spec/spikes/*` files). Depends only on WP-F01.
- GATES the auth/dev-env path and, transitively, every proxied tool's live integration (gate dependency, not file overlap).
