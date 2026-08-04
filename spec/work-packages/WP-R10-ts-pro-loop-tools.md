---
id: WP-R10
title: TS Pro Loop tools (create_item / bind_grid)
layer: ts
phase: ULTRA
status: planned
depends_on: [WP-F01, WP-F03, WP-F04, WP-F05, WP-T01, WP-T04, WP-T05, WP-R04]
files_owned:
  - packages/server/src/tools/pro/loop.ts
  - packages/server/src/tools/pro/loop.test.ts
  - packages/shared/fixtures/envelopes/smoke.elementor.pro.loop.create_item.json
contract_refs:
  - spec/contracts/13-tool-catalog.md#18-pro-surface
  - spec/contracts/10-rest-api.md#86-post-proloopitem-post-proloopbind-grid
  - spec/contracts/12-error-taxonomy.md#3
estimate: M
---

## Summary

TypeScript MCP tools for the Pro Loop Builder: `elementor.pro.loop.create_item` and `elementor.pro.loop.bind_grid`. Validates the rich query object against the frozen `ZodRawShape` (Contract 13 §1.8), proxies to `POST /pro/loop/item` / `POST /pro/loop/bind-grid` (the PHP layer performs the `{skin}_query_` prefixing, top-level `posts_per_page`, and the loop-item template assertion). NON-star advanced tools.

## Interface / Contract

Registers (Contract 13 §1.8 verbatim):

- `elementor.pro.loop.create_item` — Class M, Side proxied-to-REST (`POST /pro/loop/item`). inputSchema: `title: z.string()`, `elements?: z.array(ElementNode)`. outputSchema: `template_id: z.number().int()`, `edit_url: z.string()`. annotations: none.
- `elementor.pro.loop.bind_grid` — Class M, Side BOTH (`POST /pro/loop/bind-grid`). inputSchema: `container_id: z.string()`, `post_id: z.number().int()`, `widget?: z.enum(['loop-grid','loop-carousel']).default('loop-grid')`, `template_id: z.number().int()`, `skin?: z.enum(['post','post_taxonomy','product','product_taxonomy']).default('post')`, `columns?: z.number().int()`, `posts_per_page?: z.number().int().default(6)`, `query: z.object({ post_type: z.string(), orderby: z.string().optional(), order: z.enum(['asc','desc']).optional(), include_term_ids: z.array(z.string()).optional(), exclude_ids: z.array(z.string()).optional(), posts_ids: z.array(z.string()).optional(), query_id: z.string().optional() })`, `pagination?: z.object({ type: z.string(), load_type: z.string() })`, `base_hash: z.string()`. outputSchema: `element: ElementNode`, `diff: Diff`, `base_hash: z.string()`. annotations: none.

## Dependencies & Inputs

Upstream WPs:
- WP-F01/F03/F04/F05; WP-T01 (server core), WP-T04 (typed client `routes.pro.loopItem`/`loopBindGrid`), WP-T01 (advanced registry + `tools.search`).
- WP-R04 (PHP `/pro/loop*` routes — the authoritative query mapper + template assertion) — runtime dependency; buildable against frozen REST contract (Contract 10 §8.6) without it merged.

Contract sections: Contract 13 §0, §1.8; Contract 10 §8.6 (`{skin}_query_` prefix, top-level `posts_per_page`, loop-item assertion); Contract 12 §3 (`PRO_REQUIRED`, `E_LOOP_TEMPLATE_INVALID`). SUPPLEMENT §A.4 (the query semantics surfaced in the description).

## Detailed Requirements

1. **Schemas verbatim** per Contract 13 §1.8. The `query` object keys are the ERGONOMIC names (`post_type`, `orderby`, `include_term_ids`, ...); the PHP layer prefixes them with `{skin}_query_` and places `posts_per_page`/`columns` at top level. DO NOT prefix in TS.

2. **`base_hash` required** on `bind_grid` (surgical widget write). `create_item` is a doc create (no base_hash).

3. **Proxy.** `create_item` → `POST /pro/loop/item`, shape `{template_id,edit_url}`. `bind_grid` → `POST /pro/loop/bind-grid`, shape `{element,diff,base_hash}`. `elements` pass through `ElementNode` schema.

4. **Description hints (SUPPLEMENT §A.4).** Describe: `template_id` MUST be a loop-item template (created via `create_item`); `posts_per_page` is the page size; query keys are ergonomic (server prefixes them by skin); `skin='product'`/`product_taxonomy` requires WooCommerce. Steer the agent to call `create_item` first, then `bind_grid` with the returned `template_id`.

5. **Error mapping** (Contract 13 §0.9, Contract 12): template not loop-item → `isError` `VALIDATION_FAILED` carrying the PHP `E_LOOP_TEMPLATE_INVALID`/`actual_type` meta with actionable text ("template_id must be a loop-item; use elementor.pro.loop.create_item"); product skin without Woo → `VALIDATION_FAILED`; 501 → `PRO_REQUIRED`; stale `base_hash` → `CONCURRENCY_STALE_HASH`; 404 → `NOT_FOUND`. Schema failures → `-32602`.

6. **Lean profile.** NON-star; disabled at boot; enabled via `tools.search` match on `elementor.pro.loop*`.

7. **Smoke payload.** `smoke.elementor.pro.loop.create_item.json` = `{title:'Card'}` with `requires:{pro:true}`.

## Implementation Notes

- Import shared `ElementNode`/`Diff` schemas (WP-F03); do not redefine.
- Do NOT compute the `{skin}_query_` prefix or move `posts_per_page` in TS — that is the PHP `Loop_Query_Mapper`'s authoritative job (WP-R04). The TS tool sends the ergonomic `{skin,query,posts_per_page,columns}` shape. This keeps a single source of truth for the prefix derivation (`base.php:32-35`).
- Exports `registerProLoopTools(server, registry)` consumed by the `tools/pro/index.ts` barrel (WP-T01).

## Acceptance Criteria

- [ ] Two tools registered with exact Contract 13 §1.8 names/titles/schemas/annotations.
- [ ] `bind_grid` requires `base_hash`; `create_item` does not.
- [ ] Query keys are sent ergonomically (NOT pre-prefixed); `posts_per_page` sent top-level in the request body.
- [ ] `create_item` shapes `{template_id,edit_url}`; `bind_grid` shapes `{element,diff,base_hash}`.
- [ ] Non-loop-item `template_id` → `isError` `VALIDATION_FAILED` with actionable text steering to `create_item`.
- [ ] `skin` outside the 4-enum → `-32602`.
- [ ] 501 → `isError` `PRO_REQUIRED`; stale `base_hash` → `CONCURRENCY_STALE_HASH`.
- [ ] NON-star, disabled at boot, enabled via `tools.search`.
- [ ] Smoke payload present with `requires:{pro:true}`.
- [ ] Strict TS, no `any`, lint+format clean.

## Tests Required

- vitest unit (mocked client): schema validation (skin/widget enums, query shape); `base_hash` required on `bind_grid`; response shaping; error mapping for loop-template-invalid / 501 / 409 / 404.
- vitest contract: names/schemas snapshot vs Contract 13 §1.8.
- Inspector smoke: `smoke.elementor.pro.loop.create_item.json` (skipped free-only).

## Parallelization Notes

- Parallel-safe with all other TS WP-R (disjoint files) and all PHP WP-R.
- Depends on WP-T01 (barrel/registry), WP-T04 (typed routes); consumes via stable interfaces.
- Buildable against frozen contracts before WP-R04 lands; integration needs WP-R04 + Pro wp-env.
