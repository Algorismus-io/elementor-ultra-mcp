---
id: WP-R11
title: TS Pro Dynamic tools (bind / list_tags) + shared tag_to_text encoder
layer: ts
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F03, WP-F04, WP-F05, WP-T01, WP-T04, WP-T05, WP-R05]
files_owned:
  - packages/server/src/tools/pro/dynamic.ts
  - packages/server/src/tools/pro/dynamic.test.ts
  - packages/server/src/authoring/dynamic-encoder.ts
  - packages/server/src/authoring/dynamic-encoder.test.ts
  - packages/shared/fixtures/envelopes/smoke.elementor.pro.dynamic.list_tags.json
contract_refs:
  - spec/contracts/13-tool-catalog.md#18-pro-surface
  - spec/contracts/10-rest-api.md#87-post-prodynamicbind-get-prodynamictags-get-prodynamictagsname
  - spec/contracts/12-error-taxonomy.md#3
estimate: M
---

## Summary

TypeScript MCP tools for Pro Dynamic Tags: `elementor.pro.dynamic.bind` and `elementor.pro.dynamic.list_tags`, plus the shared TS `dynamic-encoder.ts` that reproduces core `Manager::tag_to_text` byte-for-byte (`[elementor-tag id="<id>" name="<tag>" settings="<urlencode(JSON_FORCE_OBJECT)>"]`) for client-side preview/validation. The authoritative write happens server-side (WP-R05); the TS encoder is a pre-filter/preview and MUST agree with the PHP encoder via the shared cross-runtime fixture. NON-star advanced tools.

## Interface / Contract

Registers (Contract 13 §1.8 verbatim):

- `elementor.pro.dynamic.bind` — Class M, Side BOTH (`POST /pro/dynamic/bind`). inputSchema: `post_id: z.number().int()`, `element_id: z.string()`, `control: z.string()`, `tag: z.string()`, `tag_settings?: z.record(z.string(),z.unknown())`, `fallback_value?: z.unknown()`, `base_hash: z.string()`. outputSchema: `dynamic_string: z.string()`, `diff: Diff`, `applied: z.boolean()`, `base_hash: z.string()`. annotations: idempotentHint:true.
- `elementor.pro.dynamic.list_tags` — Class R, readOnlyHint+idempotentHint (`GET /pro/dynamic/tags`). inputSchema: §0.6 pagination (`limit?,cursor?,fields?`). outputSchema: §0.6 with `items: z.array(z.object({ name, title, group, categories: z.array(z.string()), settings_controls: z.array(z.string()), available: z.boolean() }))`, `next_cursor`, `total`.

`dynamic-encoder.ts` (shared TS module, reused by HTML pipeline + element.bind_dynamic):
- `encodeDynamicTag(tagName: string, settings: Record<string,unknown>, id?: string): string` — byte-identical to `tag_to_text`. Empty settings → `settings="%7B%7D"`. Default `id` = a random 7-char alphanumeric (lowercase hex-ish per Elementor's `get_id()`); accepts a fixed `id` for deterministic fixtures.

## Dependencies & Inputs

Upstream WPs:
- WP-F01/F03/F04/F05; WP-T01 (server core), WP-T04 (typed client `routes.pro.dynamicBind`/`dynamicTags`), WP-T01 (advanced registry + `tools.search`).
- WP-R05 (PHP `/pro/dynamic*` routes + the authoritative PHP encoder) — runtime dependency; this WP CONSUMES the read-only cross-runtime fixture `packages/shared/fixtures/trees/pro/dynamic.encodings.json` OWNED/created by WP-R05 to assert the TS encoder matches PHP byte-for-byte.

Contract sections: Contract 13 §0, §1.8; Contract 10 §8.7 (encoding + `__dynamic__` storage); Contract 12 §3 (`E_DYNAMIC_INCOMPATIBLE` → `VALIDATION_FAILED`, `PRO_REQUIRED`). SUPPLEMENT §A.6 (the three worked encoding strings).

## Detailed Requirements

1. **Encoder byte-identity (SUPPLEMENT §A.6).** `encodeDynamicTag` MUST emit `[elementor-tag id="<id>" name="<tag>" settings="<S>"]` where `S = encodeURIComponent_PHPstyle( JSON.stringify(settings_as_object) )`. CRITICAL: match PHP `urlencode(wp_json_encode($s, JSON_FORCE_OBJECT))`:
   - JSON: object form (`{}` for empty, not `[]`); key order preserved as inserted; PHP `wp_json_encode` escapes `/` as `\/` and uses no spaces — replicate (e.g. serialize then ensure forward slashes are escaped to match `wp_json_encode` default flags). Validate against the §A.6 acf-text string which contains a `:` and a `/`-free value, and confirm slash handling against the fixture.
   - URL-encoding: PHP `urlencode` encodes space as `+` and is RFC1738-ish; for JSON payloads (no spaces in compact JSON) the safe set differs from `encodeURIComponent` mainly on `(`, `)`, `!`, `*`, `~`, `'`. Implement a `phpUrlEncode()` that matches PHP `urlencode` output exactly for JSON strings (the cross-runtime fixture is the oracle). The §A.6 examples (`%7B%7D`, `%7B%22fallback%22...`) must reproduce.
2. **Cross-runtime parity test.** Load `dynamic.encodings.json` (owned by WP-R05) and assert `encodeDynamicTag(tag, settings, id) === expected_string` for every row. This is the contract that guarantees TS preview == PHP write.
3. **`bind` tool.** Validate input; the authoritative write is PHP (`POST /pro/dynamic/bind`) which re-encodes server-side and validates `control.dynamic.active`/category intersection. The TS handler MAY locally pre-encode for a preview `dynamic_string` but the RETURNED `dynamic_string` comes from the PHP response (authoritative). `base_hash` required (surgical write). idempotentHint:true.
4. **`list_tags` pagination.** Implement §0.6 `{limit,cursor,fields}` → `{items,next_cursor,total}`. Items carry `available` (license-gating). The agent calls this before binding to learn valid tags + categories.
5. **Error mapping** (Contract 13 §0.9, Contract 12): control not dynamic-capable / category mismatch → `isError` `VALIDATION_FAILED` (carry `E_DYNAMIC_INCOMPATIBLE` meta: control/tag categories); Pro/ACF tag unavailable → `PRO_REQUIRED`; 404 element/tag → `NOT_FOUND`; stale `base_hash` → `CONCURRENCY_STALE_HASH`. Schema failures → `-32602`.
6. **Lean profile.** NON-star; disabled at boot; enabled via `tools.search` match on `elementor.pro.dynamic*`.
7. **Smoke payload.** `smoke.elementor.pro.dynamic.list_tags.json` = `{}` (or `{limit:5}`) with `requires:{pro:true}`.

## Implementation Notes

- The encoder is shared infra (also used by `elementor.element.bind_dynamic`, WP-T## element ops, and the HTML pipeline for dynamic-bound text) — place it in `authoring/`, not in `tools/pro/`, so non-Pro callers can reuse it. It is owned solely by THIS WP.
- The single hardest detail is matching PHP `wp_json_encode` + `urlencode` exactly. Treat the WP-R05 cross-runtime fixture as the oracle; if a row disagrees, the bug is in `phpUrlEncode`/`wpJsonEncode`, not the fixture. Document the PHP flags relied upon (`JSON_FORCE_OBJECT`; default `wp_json_encode` escapes `/`).
- Empty settings MUST be `%7B%7D` — never empty string (the #1 gotcha, SUPPLEMENT §A.6). Add an explicit unit test.
- The random 7-char `id` makes live output non-deterministic; accept an `id` arg for tests/fixtures.
- Exports `registerProDynamicTools(server, registry)` consumed by the `tools/pro/index.ts` barrel (WP-T01).

## Acceptance Criteria

- [ ] `encodeDynamicTag('post-title',{},'a1b2c3d')` === `[elementor-tag id="a1b2c3d" name="post-title" settings="%7B%7D"]`.
- [ ] `encodeDynamicTag` reproduces the other two SUPPLEMENT §A.6 strings (post-featured-image, acf-text) exactly.
- [ ] Cross-runtime parity: every row of `dynamic.encodings.json` (WP-R05) matches the TS encoder output.
- [ ] Empty `tag_settings` → `%7B%7D`, never empty string.
- [ ] `bind` requires `base_hash`; returns the PHP-authoritative `dynamic_string`; idempotentHint:true.
- [ ] `list_tags` paginates per §0.6 and carries `available` per item.
- [ ] Control-not-dynamic / category-mismatch → `isError` `VALIDATION_FAILED` with category meta.
- [ ] NON-star, disabled at boot, enabled via `tools.search`.
- [ ] Smoke payload present with `requires:{pro:true}`.
- [ ] Strict TS, no `any`, lint+format clean.

## Tests Required

- vitest unit (encoder): the 3 §A.6 worked strings; empty-settings `%7B%7D`; slash/special-char handling; the cross-runtime fixture parity loop (consumes WP-R05's `dynamic.encodings.json`).
- vitest unit (tools, mocked client): schema validation; `base_hash` required; `list_tags` pagination; error mapping for dynamic-incompatible / 501 / 409 / 404.
- vitest contract: names/schemas snapshot vs Contract 13 §1.8.
- Inspector smoke: `smoke.elementor.pro.dynamic.list_tags.json` (skipped free-only).

## Parallelization Notes

- Parallel-safe with all other TS WP-R (disjoint files) and all PHP WP-R.
- CONSUMES WP-R05's `dynamic.encodings.json` read-only (no write contention; WP-R05 owns/creates it). This is a contract dependency, not a code dependency.
- Depends on WP-T01 (barrel/registry), WP-T04 (typed routes); consumes via stable interfaces.
- Buildable against frozen contracts before WP-R05 lands, EXCEPT the parity test needs the fixture — sequence the parity test after WP-R05 produces it (or stub the fixture from §A.6 until then).
