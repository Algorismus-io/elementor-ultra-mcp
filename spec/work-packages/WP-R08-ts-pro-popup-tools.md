---
id: WP-R08
title: TS Pro Popup tools (create / set_triggers / set_timing)
layer: ts
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F03, WP-F04, WP-F05, WP-T01, WP-T04, WP-T05, WP-R02]
files_owned:
  - packages/server/src/tools/pro/popup.ts
  - packages/server/src/tools/pro/popup.test.ts
  - packages/shared/fixtures/envelopes/smoke.elementor.pro.popup.create.json
contract_refs:
  - spec/contracts/13-tool-catalog.md#18-pro-surface
  - spec/contracts/10-rest-api.md#84-post-propopup-put-propopupiddisplay
  - spec/contracts/12-error-taxonomy.md#3
estimate: M
---

## Summary

TypeScript MCP tools for Pro Popups: `elementor.pro.popup.create`, `elementor.pro.popup.set_triggers`, `elementor.pro.popup.set_timing`. Each validates against its frozen `ZodRawShape` (Contract 13 §1.8), proxies to `POST /pro/popup` / `PUT /pro/popup/{id}/display`, and maps failures to taxonomy-coded `isError` results. NON-star advanced tools.

## Interface / Contract

Registers (Contract 13 §1.8 verbatim):

- `elementor.pro.popup.create` — Class M, Side proxied-to-REST (`POST /pro/popup`). inputSchema: `title: z.string()`, `status?: z.enum(['publish','draft']).default('publish')`, `elements?: z.array(ElementNode)`, `layout_settings?: z.record(z.string(),z.unknown())`, `display_settings?: z.object({ triggers: z.record(z.string(),z.unknown()).optional(), timing: z.record(z.string(),z.unknown()).optional() })`, `conditions?: z.array(ConditionTuple)`. outputSchema: `post_id`, `edit_url`, `conditions_stored: z.array(z.string())`. annotations: none.
- `elementor.pro.popup.set_triggers` — Class M, idempotentHint:true (`PUT /pro/popup/{id}/display`). inputSchema: `post_id: z.number().int()`, `triggers: z.record(z.string(),z.unknown())`. outputSchema: `success`, `display_settings: z.record(z.string(),z.unknown())`.
- `elementor.pro.popup.set_timing` — Class M, idempotentHint:true (`PUT /pro/popup/{id}/display`). inputSchema: `post_id: z.number().int()`, `timing: z.record(z.string(),z.unknown())`. outputSchema: `success`, `display_settings`.

Both `set_triggers`/`set_timing` map to the SAME REST route (`PUT /pro/popup/{id}/display`) with the respective sub-object; the merge happens server-side (WP-R02 `Display_Settings_Helper::merge()`).

## Dependencies & Inputs

Upstream WPs:
- WP-F01/F03/F04/F05; WP-T01 (server core), WP-T04 (typed client `routes.pro.popupCreate`/`popupDisplay`), WP-T01 (advanced registry + `tools.search`).
- WP-R02 (PHP `/pro/popup*` routes) — runtime dependency; buildable against the frozen REST contract (Contract 10 §8.4) without it merged.

Contract sections: Contract 13 §0, §1.8; Contract 10 §8.4 (display-settings buckets, merge semantics); Contract 12 §3. SUPPLEMENT §A.2 (the triggers/timing object shape the agent fills `display_settings` with — surfaced to the agent via the tool description + a schema hint, but the field type is `z.record` since shape is open/Pro-versioned).

## Detailed Requirements

1. **Schemas verbatim** per Contract 13 §1.8. `display_settings` is `{triggers?,timing?}` of `z.record(...)`. Do NOT over-constrain the inner keys (they are SUPPLEMENT §A.2 names, but Pro may add more; PHP validates softly per WP-R02).

2. **`create` proxy.** Validate, call `routes.pro.popupCreate(...)`, shape `{post_id,edit_url,conditions_stored}`. `elements` pass through `ElementNode` schema. `conditions` default to none here (PHP defaults to `include/general` per WP-R02) — but DOCUMENT in the tool description that omitting conditions makes the popup site-wide.

3. **`set_triggers`/`set_timing`.** Each sends only its sub-object to `PUT /pro/popup/{id}/display`. The server merges; the response `display_settings` is the merged `{triggers,timing}`. Idempotent merge.

4. **Description hints (SUPPLEMENT §A.2).** The tool descriptions reference the key catalog so the agent knows valid group toggles (`page_load`, `scrolling`, `click`, `inactivity`, `exit_intent`, `adblock_detection` for triggers; `page_views`, `sessions`, `times`, `url`, `sources`, `logged_in`, `devices`, `browsers`, `schedule` for timing) and that toggles are `"yes"`/`""` with `{group}_{control}` sub-keys. Keep this in the `description`/an MCP resource, NOT as a hard zod constraint.

5. **Error mapping** (Contract 13 §0.9, Contract 12): 501 → `PRO_REQUIRED`; target not a popup → `VALIDATION_FAILED` (surface the PHP `actual_type` meta); 404 → `NOT_FOUND`; 422 → `ATOMIC_SETTINGS_INVALID`/`VALIDATION_FAILED`. Schema-shape failures → SDK `-32602`.

6. **Lean profile.** NON-star; registered disabled; enabled via `tools.search` match on `elementor.pro.popup*`.

7. **Smoke payload.** `smoke.elementor.pro.popup.create.json` = `{title:'Newsletter',display_settings:{triggers:{page_load:'yes',page_load_delay:2}}}` with `requires:{pro:true}`.

## Implementation Notes

- Import shared `ElementNode`/`ConditionTuple` schemas (WP-F03); do not redefine.
- `set_triggers` and `set_timing` are two tool names mapping to one REST route — keep a shared private `putDisplay(post_id, patch)` helper inside `popup.ts`.
- The popup display object is intentionally `z.record` (open) — the typed shape lives in SUPPLEMENT §A.2 and is validated softly server-side (WP-R02). Surfacing it as a resource/description keeps the agent informed without brittle schema drift.
- Exports `registerProPopupTools(server, registry)` consumed by the `tools/pro/index.ts` barrel (owned by WP-T01).

## Acceptance Criteria

- [ ] Three tools registered with exact Contract 13 §1.8 names/titles/schemas/annotations.
- [ ] `create` proxies `POST /pro/popup`; shapes `{post_id,edit_url,conditions_stored}`.
- [ ] `set_triggers` sends `{triggers}` only; `set_timing` sends `{timing}` only; both hit `PUT /pro/popup/{id}/display`; response is the merged `display_settings`.
- [ ] Tool descriptions enumerate the §A.2 group toggles + the `"yes"`/`""` + `{group}_{control}` convention.
- [ ] 501 → `isError` `PRO_REQUIRED`; target-not-popup → `isError` `VALIDATION_FAILED` with `actual_type`.
- [ ] NON-star, disabled at boot, enabled via `tools.search`.
- [ ] Smoke payload present with `requires:{pro:true}`.
- [ ] Strict TS, no `any`, lint+format clean.

## Tests Required

- vitest unit (mocked client): schema validation; `set_triggers`/`set_timing` route mapping; response shaping; error mapping for 501/404/422.
- vitest contract: names/schemas snapshot vs Contract 13 §1.8.
- Inspector smoke: `smoke.elementor.pro.popup.create.json` no `-326xx`, output matches schema (skipped free-only).

## Parallelization Notes

- Parallel-safe with all other TS WP-R (disjoint `tools/pro/<domain>.ts` files) and all PHP WP-R.
- Depends on WP-T01 (barrel/registry), WP-T04 (typed routes); consumes via stable interfaces.
- Buildable against frozen contracts before WP-R02 lands; integration needs WP-R02 + Pro wp-env.
