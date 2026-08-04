---
id: WP-R07
title: TS Pro Theme Builder tools (create / set_conditions / get_conditions_config) + theme-builder-from-spec prompt
layer: ts
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F03, WP-F04, WP-F05, WP-T01, WP-T04, WP-T05, WP-R01]
files_owned:
  - packages/server/src/tools/pro/theme.ts
  - packages/server/src/tools/pro/theme.test.ts
  - packages/server/src/prompts/theme-builder-from-spec.ts
  - packages/server/src/prompts/theme-builder-from-spec.test.ts
  - packages/shared/fixtures/envelopes/smoke.elementor.pro.theme.create.json
contract_refs:
  - spec/contracts/13-tool-catalog.md#18-pro-surface
  - spec/contracts/13-tool-catalog.md#3-prompts
  - spec/contracts/10-rest-api.md#81-post-prothemecreate-theme-builder-document
  - spec/contracts/12-error-taxonomy.md#3
estimate: M
---

## Summary

TypeScript MCP tools for the Pro Theme Builder: `elementor.pro.theme.create`, `elementor.pro.theme.set_conditions`, `elementor.pro.theme.get_conditions_config`. Each validates input against its frozen `ZodRawShape` (Contract 13 §1.8), proxies to the `/pro/theme*` REST routes via the typed WP client, shapes the response, and maps REST/business failures to `isError` results with taxonomy codes. These are NON-star advanced tools (disabled at boot, surfaced via `tools.search`). This WP ALSO owns the HANDLER for the fourth MCP prompt, `theme-builder-from-spec` (Contract 13 §3) — the Pro-oriented prompt whose argument schema is declared by WP-F04 (`catalog/prompts.ts`); the non-Pro three prompts are owned by WP-T13.

## Interface / Contract

Registers (Contract 13 §1.8, names/titles/schemas verbatim):

- `elementor.pro.theme.create` — Class M, Side proxied-to-REST (`POST /pro/theme`). inputSchema: `type: z.enum(['header','footer','single-post','single-page','archive','search-results','error-404','section'])`, `title: z.string()`, `status?: z.enum(['publish','draft']).default('publish')`, `location?: z.string()` (required only when `type='section'`), `elements?: z.array(ElementNode)`, `page_settings?: z.record(z.string(),z.unknown())`, `conditions?: z.array(ConditionTuple)`. outputSchema: `post_id`, `edit_url`, `template_type`, `location: z.string().nullable()`, `conditions_stored: z.array(z.string())`. annotations: none.
- `elementor.pro.theme.set_conditions` — Class M, idempotentHint:true (`PUT /pro/theme/{id}/conditions`). inputSchema: `post_id: z.number().int()`, `conditions: z.array(ConditionTuple)`, `check_conflicts?: z.boolean().default(false)`. outputSchema: `saved`, `conditions_stored`, `conflicts?: z.array(z.object({template_id,template_title,edit_url}))`.
- `elementor.pro.theme.get_conditions_config` — Class R, readOnlyHint+idempotentHint (`GET /pro/theme/conditions-config`). inputSchema: `{}`. outputSchema: `tree: z.record(z.string(),z.unknown())`, `locations: z.array(z.string())`.

`ConditionTuple` (shared, Contract 13 §0/§1.8): `z.tuple([z.enum(['include','exclude']), z.string()]).rest(z.string())` — slash-joined server-side. `ElementNode` = the shared `elementNodeSchema` zod object (WP-F03). Reuses the registration pattern from WP-T01 (advanced-tool registry: `disable()` at boot, `enable()` + `sendToolListChanged()` from `tools.search`).

Also registers the fourth MCP prompt HANDLER (Contract 13 §3) in `packages/server/src/prompts/theme-builder-from-spec.ts`:

- `theme-builder-from-spec` — a `PromptHandler` (WP-T01 `runtime/`) returning a `GetPromptResult`. Args (STRINGS, owned by WP-F04 `catalog/prompts.ts`): `{spec, scope?}` where `spec` is the theme-builder brief and `scope?` narrows to `header|footer|single|archive|...`. The emitted plan steers the agent: (a) `elementor.site.capabilities` to confirm `pro` is active (the prompt is Pro-gated); (b) `elementor.pro.theme.get_conditions_config` to learn valid template types/locations/conditions; (c) `elementor.schema.widget`/`elementor.schema.styles` before authoring props (schema-first, never invent props); (d) `elementor.page.dry_run` to validate; (e) `elementor.pro.theme.create` per template part with explicit `conditions`. The module exports `registerThemeBuilderPrompt(registry)` which calls `registry.attachHandler('theme-builder-from-spec', fn)` as a side-effect — attaching BY NAME so it never edits WP-T13's `prompts/index.ts`. It is collected by the Pro barrel the server core wires (same disjoint pattern as the Pro tool barrel, see "File split rationale" below).

## Dependencies & Inputs

Upstream WPs:
- WP-F01 (scaffold), WP-F03 (`ElementNode`/`ConditionTuple` zod schemas + TS types), WP-F04 (MCP catalog schemas), WP-F05 (error taxonomy → `mapRestError` helper).
- WP-T01 (server core: `registerTool`, annotations, the `Server` instance).
- WP-T04 (typed WP REST client `wp/routes.ts` — the 1:1 wrapper; this WP calls `routes.pro.themeCreate(...)` etc.).
- WP-T01 (advanced-tool registry + `tools.search` enable/disable + lean-profile gating — these Pro tools are NON-star, registered disabled).
- WP-R01 (PHP `/pro/theme*` routes) — the runtime dependency the proxy hits; this WP is buildable against the FROZEN REST contract (Contract 10 §8.1-§8.3) without WP-R01 merged, but integration tests need it.

Contract sections: Contract 13 §0 (conventions, error semantics §0.9), §1.8 (Pro tool defs); Contract 10 §8.1-§8.3 (REST shapes the client wraps); Contract 12 §3 (error codes). Engineering standards Contract 15 §2 (strict TS, zod, no `any`).

## Detailed Requirements

1. **Schemas verbatim.** Transcribe the Contract 13 §1.8 field maps into `ZodRawShape` exactly — field names, optionality, defaults, enums identical. `ConditionTuple` MUST be the `z.tuple(...).rest(z.string())` form so `[type,name]`, `[type,name,sub]`, `[type,name,sub,id]` all validate. Reject `type='single'` at the schema? NO — `single` is not in the enum, so it is rejected by the schema as a `-32602`; the PHP layer also rejects it. (The enum has exactly the 8 valid types.)

2. **Proxy.** Each handler validates input, calls the corresponding `wp/routes.ts` method (typed), and shapes the unwrapped `data` into the `outputSchema`. `create` passes `elements` through the shared `ElementNode` schema (already validated by zod). The TS pre-filter (WP-T03/authoring) MAY structurally pre-check `elements` but is NOT authoritative — PHP `dry_run` (invoked inside the PHP `/pro/theme` route) decides validity.

3. **`location` rule.** When `type='section'` and `location` absent, return an `isError` result (`VALIDATION_FAILED`, actionable: "section theme docs require a `location`; call get_conditions_config / site capabilities for valid locations") BEFORE proxying — a cheap client-side guard. PHP still enforces it.

4. **`set_conditions` semantics.** `conditions:[]` clears all (pass through). When `check_conflicts:true`, surface the returned `conflicts[]` in the result text AND structured content so the agent can react. Idempotent (replace semantics) — set `idempotentHint:true`.

5. **`get_conditions_config`.** Pure read; cache-friendly. Return the live `tree` + `locations` unchanged. The agent uses this to validate/autocomplete `name`/`sub_name` and learn which subs take an id (the `id_bearing` list the PHP route may include — surface it if present).

6. **Error mapping (Contract 13 §0.9, Contract 12).** 501 `E_FEATURE_UNAVAILABLE` → `isError` with `PRO_REQUIRED`/`EXPERIMENT_INACTIVE`; 422 validation → `isError` `ATOMIC_SETTINGS_INVALID`/`VALIDATION_FAILED` with the structured `errors[]`; 400 → `isError` `VALIDATION_FAILED`; 403 → `CAPABILITY_MISSING`. NEVER a protocol error when the agent can fix the input. Schema-shape failures are the SDK's `-32602`.

7. **Lean profile.** All three are NON-star (not in the 18 ★ tools). Register them via WP-T01's advanced registry in a `disable()`d state at boot; they become enabled when `tools.search` matches `elementor.pro.theme*`.

8. **Smoke payload.** Provide `fixtures/envelopes/smoke.elementor.pro.theme.create.json` — a minimal valid input (`{type:'header',title:'Header'}`) with `requires:{pro:true}` so the Inspector smoke suite (Contract 14 §8) skips it on free-only installs.

9. **`theme-builder-from-spec` prompt handler.** Implement the handler in `prompts/theme-builder-from-spec.ts` matching the WP-F04 descriptor name/args (STRING args; Contract 13 §3). The emitted `GetPromptResult` plan MUST: (a) start with `elementor.site.capabilities` and gate on `pro` active (if not Pro, the plan tells the agent the prompt requires Elementor Pro); (b) call `elementor.pro.theme.get_conditions_config` to enumerate valid template types/locations/conditions before authoring; (c) instruct schema-first authoring via `elementor.schema.widget`/`elementor.schema.styles` (never invent props, Contract 15 §2.6); (d) validate via `elementor.page.dry_run`; (e) create each template part via `elementor.pro.theme.create` with explicit `conditions`. No tool calls inside the handler (pure text-plan generator — no writes, no dry_run/prime-css dependency). Export `registerThemeBuilderPrompt(registry)` that attaches BY NAME via `registry.attachHandler('theme-builder-from-spec', fn)`; do NOT edit WP-T13's `prompts/index.ts`. Reference EXACT Contract 13 tool names (a misspelled name violates Contract 15 §4.1).

## Implementation Notes

- Import `ElementNode`/`ConditionTuple` zod schemas from `packages/shared` (WP-F03) — do NOT redefine them locally (drift risk; Contract 15 §2.2).
- The typed route wrappers `wp/routes.ts` (WP-T04) unwrap the `{success,data}` envelope; this WP works with `data` directly.
- Do not duplicate the conditions-config tree shape in TS — it is `z.record(z.string(),z.unknown())` (opaque, validated server-side).
- Keep these handlers thin; no business logic that belongs in PHP (conditions slash-joining, conflict computation all happen server-side per Contract 15 §4.7).
- File split rationale: the catalog names `packages/server/src/tools/pro.ts`, but to keep 6 TS Pro WPs disjoint, each owns `tools/pro/<domain>.ts`. A tiny `tools/pro/index.ts` barrel that registers all domains is owned by WP-T01 (the registry), NOT by any WP-R, so no contention. Each WP-R TS file exports `registerProThemeTools(server, registry)` consumed by that barrel. The Pro PROMPT follows the SAME disjoint pattern: `prompts/theme-builder-from-spec.ts` exports `registerThemeBuilderPrompt(registry)` and is collected by the Pro barrel the server core wires — it attaches by name, so WP-T13's `prompts/index.ts` (non-Pro barrel) is never touched. The handler's text-plan generation reuses no PHP/business logic; it only references tool names by string.

## Acceptance Criteria

- [ ] Three tools registered with exact Contract 13 §1.8 names/titles/inputSchema/outputSchema/annotations.
- [ ] `ConditionTuple` validates 2-, 3-, and 4-element tuples; `type` outside `include|exclude` → `-32602`.
- [ ] `type='single'` → `-32602` (not in enum).
- [ ] `type='section'` without `location` → `isError` `VALIDATION_FAILED` before proxy.
- [ ] `create` proxies `POST /pro/theme` and shapes `{post_id,edit_url,template_type,location,conditions_stored}`.
- [ ] `set_conditions` with `[]` clears; `check_conflicts:true` surfaces `conflicts`.
- [ ] 501 from PHP → `isError` with `PRO_REQUIRED`/`EXPERIMENT_INACTIVE`, never a protocol error.
- [ ] Tools are NON-star, registered disabled, enabled via `tools.search`.
- [ ] Smoke payload present with `requires:{pro:true}`.
- [ ] `theme-builder-from-spec` prompt handler attaches with the exact WP-F04 descriptor name; its plan gates on `pro`, calls `get_conditions_config`, enforces schema-first + `dry_run` before `pro.theme.create`, and references only exact Contract 13 tool names; it attaches by name and does NOT edit `prompts/index.ts`.
- [ ] Strict TS, no `any`, lint+format clean.

## Tests Required

- vitest unit (mocked `wp/routes.ts`): schema validation (tuple arities, enum rejects); `section`-without-location guard; response shaping; error mapping for 501/422/403.
- vitest contract: tool name/schema match the Contract 13 §1.8 definitions (snapshot against the frozen catalog).
- Inspector smoke (Contract 14 §8): `smoke.elementor.pro.theme.create.json` yields no `-326xx` and matches `outputSchema` (skipped on free-only).
- `prompts/theme-builder-from-spec.test.ts` (vitest, no WP): assert the handler attaches with the exact `theme-builder-from-spec` name; assert the emitted plan references the correct exact tool names (`site.capabilities`, `pro.theme.get_conditions_config`, `schema.widget`/`schema.styles`, `page.dry_run`, `pro.theme.create`) and encodes the Pro-gate + schema-first + dry_run-before-create rules; assert no tool call happens inside the handler.

## Parallelization Notes

- Parallel-safe with ALL other TS WP-R (each owns `tools/pro/<domain>.ts` + its test + its smoke envelope — disjoint) and all PHP WP-R. The Pro prompt files (`prompts/theme-builder-from-spec.ts` + test) are disjoint from WP-T13's non-Pro `prompts/*` (different filenames) and WP-T13 is in an earlier wave (wave 4 vs this WP's wave 8), so there is no shared file and no concurrency overlap.
- Depends on WP-T01 for the registry barrel and WP-T04 for the typed routes; consumes both via stable interfaces.
- Buildable against the frozen REST + tool contracts before WP-R01 lands; only integration tests require WP-R01 + a Pro wp-env.
