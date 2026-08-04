---
id: WP-R09
title: TS Pro Form tools (build / list_actions)
layer: ts
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F03, WP-F04, WP-F05, WP-T01, WP-T04, WP-T05, WP-R03]
files_owned:
  - packages/server/src/tools/pro/form.ts
  - packages/server/src/tools/pro/form.test.ts
  - packages/shared/fixtures/envelopes/smoke.elementor.pro.form.build.json
contract_refs:
  - spec/contracts/13-tool-catalog.md#18-pro-surface
  - spec/contracts/10-rest-api.md#85-post-proformbuild-get-proformactions
  - spec/contracts/12-error-taxonomy.md#3
estimate: M
---

## Summary

TypeScript MCP tools for Pro Forms: `elementor.pro.form.build` (maps an ergonomic field/action spec; the PHP side performs the authoritative widget mapping + action-registration validation) and `elementor.pro.form.list_actions`. The TS handler validates the rich field/action input against the frozen `ZodRawShape`, proxies to `POST /pro/form/build` / `GET /pro/form/actions`, and surfaces warnings (e.g. unregistered actions). Side is BOTH (TS shapes the spec → request; PHP validates against `actions_registrar->get()` + the field-type filter). NON-star advanced tools.

## Interface / Contract

Registers (Contract 13 §1.8 verbatim):

- `elementor.pro.form.build` — Class M, Side BOTH (`POST /pro/form/build`). inputSchema: `container_id: z.string()`, `post_id: z.number().int()`, `form_name?: z.string()`, `button_text?: z.string()`, `fields: z.array(z.object({ type: z.string(), id: z.string(), label: z.string().optional(), placeholder: z.string().optional(), required: z.boolean().optional(), options: z.array(z.object({ label, value })).optional(), rows: z.number().int().optional(), width: z.string().optional(), default_value: z.string().optional(), html: z.string().optional() }))`, `actions: z.array(z.object({ type: z.enum(['email','email2','redirect','webhook','mailchimp','drip','activecampaign','getresponse','convertkit','mailerlite','slack','discord']) }).passthrough())`, `base_hash: z.string()`. outputSchema: `element: ElementNode`, `diff: Diff`, `warnings: z.array(z.string())`, `base_hash: z.string()`. annotations: none.
- `elementor.pro.form.list_actions` — Class R, readOnlyHint+idempotentHint (`GET /pro/form/actions`). inputSchema: `{}`. outputSchema: `actions: z.array(z.object({ name, label, settings_controls: z.array(z.string()) }))`.

## Dependencies & Inputs

Upstream WPs:
- WP-F01/F03/F04/F05; WP-T01 (server core), WP-T04 (typed client `routes.pro.formBuild`/`formActions`), WP-T01 (advanced registry + `tools.search`).
- WP-R03 (PHP `/pro/form*` routes — the authoritative mapper) — runtime dependency; buildable against frozen REST contract (Contract 10 §8.5) without it merged.

Contract sections: Contract 13 §0, §1.8; Contract 10 §8.5 (the field/action mapping the PHP performs); Contract 12 §3 (`PRO_REQUIRED`, `EXPERIMENT_INACTIVE`, validation). SUPPLEMENT §A.3 (the agent-facing field/action spec semantics surfaced in the description).

## Detailed Requirements

1. **Schemas verbatim** per Contract 13 §1.8. `fields[].required` is a BOOLEAN in the tool input (the agent thinks in booleans); the PHP layer converts to the string `"true"` (SUPPLEMENT §A.3). DO NOT pre-convert in TS. `actions[].type` is the enum; extra action settings ride via `.passthrough()`.

2. **`base_hash` required.** `build` writes a single widget into an existing document → it is a surgical write requiring `base_hash` (Contract 13 §0.8). Read it from `page.get_structure` (the agent supplies it). `force?` is not in this tool's schema (per §1.8); PHP handles lock/autosave with the request defaults.

3. **Proxy + warnings.** Validate, call `routes.pro.formBuild(...)`. The PHP layer drops unregistered actions and returns `warnings[]` — surface them verbatim in the result text AND structured content (e.g. "action 'mailchimp' not registered (license)"). The result is a normal (non-error) result with `diff`, `element`, `base_hash`, `warnings`.

4. **`list_actions`.** Pure read of `GET /pro/form/actions` — only registered/licensed actions. The agent calls this BEFORE `build` to learn which actions exist (the description should say so).

5. **Description hints (SUPPLEMENT §A.3).** Tool description enumerates the base field types (`text,email,textarea,url,tel,radio,select,checkbox,acceptance,number,date,time,upload,password,html,hidden`) and notes: `id` becomes the field's `custom_id` (unique, `[A-Za-z0-9_]`), `options` is a list of `{label,value}`, `placeholder` only applies to placeholder-eligible types. Keep this in the description, not as additional zod constraints (the field-type set is filter-extensible server-side).

6. **Generation.** The tool does not expose `generation`; the PHP route picks classic vs atomic `e-form` per `e_pro_atomic_form` probe and reports any fallback in `warnings[]`. Surface that warning.

7. **Error mapping** (Contract 13 §0.9, Contract 12): 501 → `PRO_REQUIRED`; atomic-form gate off when v4 forced → `EXPERIMENT_INACTIVE` (but default is classic fallback with a warning); 422 invalid field/action → `VALIDATION_FAILED`/`ATOMIC_SETTINGS_INVALID`; 409 `base_hash` stale → `CONCURRENCY_STALE_HASH` (retryable). Schema failures → `-32602`.

8. **Lean profile.** NON-star; disabled at boot; enabled via `tools.search` match on `elementor.pro.form*`.

9. **Smoke payload.** `smoke.elementor.pro.form.build.json` = a minimal valid spec (one text field + one email action + a placeholder `base_hash`) with `requires:{pro:true}`.

## Implementation Notes

- Import shared `ElementNode`/`Diff` schemas (WP-F03); do not redefine.
- Do NOT do the field→`custom_id` / `required→"true"` / `options→string` mapping in TS — that is the PHP `Form_Mapper`'s authoritative job (WP-R03). The TS tool passes the ergonomic spec through; this avoids two divergent mappers.
- `actions` `.passthrough()` lets the agent supply action-specific settings (e.g. `email_to`, `redirect_to`) inline; the PHP layer routes them. Keep the TS schema permissive here per Contract 13 §1.8.
- Exports `registerProFormTools(server, registry)` consumed by the `tools/pro/index.ts` barrel (WP-T01).

## Acceptance Criteria

- [ ] Two tools registered with exact Contract 13 §1.8 names/titles/schemas/annotations.
- [ ] `fields[].required` is boolean in input (NOT pre-converted to string in TS).
- [ ] `build` requires `base_hash`; proxies `POST /pro/form/build`; returns `{element,diff,warnings,base_hash}`.
- [ ] Warnings from PHP (unregistered action / atomic fallback) surface in the result text + structured content.
- [ ] `list_actions` returns only registered actions.
- [ ] 501 → `isError` `PRO_REQUIRED`; stale `base_hash` → `isError` `CONCURRENCY_STALE_HASH` (retryable).
- [ ] `actions[].type` outside the enum → `-32602`.
- [ ] NON-star, disabled at boot, enabled via `tools.search`.
- [ ] Smoke payload present with `requires:{pro:true}`.
- [ ] Strict TS, no `any`, lint+format clean.

## Tests Required

- vitest unit (mocked client): schema validation (boolean `required`, action enum, passthrough); `base_hash` required; warning surfacing; error mapping for 501/409/422.
- vitest contract: names/schemas snapshot vs Contract 13 §1.8.
- Inspector smoke: `smoke.elementor.pro.form.build.json` (skipped free-only).

## Parallelization Notes

- Parallel-safe with all other TS WP-R (disjoint files) and all PHP WP-R.
- Depends on WP-T01 (barrel/registry), WP-T04 (typed routes); consumes via stable interfaces.
- Buildable against frozen contracts before WP-R03 lands; integration needs WP-R03 + Pro wp-env.
