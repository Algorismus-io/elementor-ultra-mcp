---
id: WP-T04
title: TS tool handlers — discovery / read (search, pages.list, get_structure, get_settings, schema.*, breakpoints, dynamic)
layer: ts
phase: MVP
status: planned
depends_on: [WP-F01, WP-F02, WP-F04, WP-F05, WP-T01]
files_owned:
  - packages/server/src/tools/discovery.ts
  - packages/server/src/tools/discovery.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §1.1 (discovery/read), §5 (surface ergonomics)
  - spec/contracts/10-rest-api.md §2.1, §2.4, §2.5, §3, §8, §12
  - spec/contracts/12-error-taxonomy.md §5 (TS mapping)
estimate: M
---

## Summary

Implements the HANDLERS for the read-only discovery tools (Contract 13 §1.1) and attaches them to the WP-F04 registry by name: `elementor.tools.search`, `elementor.pages.list`, `elementor.page.get_structure`, `elementor.page.get_settings`, `elementor.schema.widget`, `elementor.schema.styles`, `elementor.breakpoints.get`, `elementor.dynamic.list_tags`, `elementor.dynamic.get_tag_schema`. NOTE: `elementor.site.capabilities` is OWNED by WP-F05 (`tools/discovery-capabilities.ts`) and is NOT implemented here. `tools.search` is the discovery entry point that enables matched disabled tools and triggers `sendToolListChanged()`.

## Interface / Contract

This WP attaches handlers (it does NOT define schemas — WP-F04 owns the descriptors). Each handler is a `ToolHandler` (WP-T01 `runtime/context.ts`) attached via `ctx.registry.attachHandler(name, fn)` at module import. The catalog schemas (Contract 13 §1.1) are the source of I/O shapes:

- `elementor.tools.search` ★ (R, TS) — `{query?,prefix?,limit?}` → `{tools[],total}`. Queries `ctx.registry`/`ctx.surface`; on match enables matched disabled tools (`ctx.surface.enable([...])` → one `sendToolListChanged()`).
- `elementor.pages.list` ★ (R, proxied `GET /documents`) — `{status?,post_type?,...page}` → `{items[],next_cursor,total}`.
- `elementor.page.get_structure` ★ (R, `GET /documents/{id}`) — `{post_id,depth?,subtree_id?,projection?}` → `{elements[],base_hash,generation}`.
- `elementor.page.get_settings` (R, `GET /documents/{id}/settings`) — `{post_id}` → `{settings}`.
- `elementor.schema.widget` ★ (R, `GET /schema/widget/{type}`) — `{type}` → `{kind,schema,dynamic_props,version}`.
- `elementor.schema.styles` ★ (R, `GET /schema/styles`) — `{}` → `{props,units,states}`.
- `elementor.breakpoints.get` ★ (R, `GET /schema/breakpoints`) — `{}` → `{breakpoints[],default_direction}`.
- `elementor.dynamic.list_tags` (R, `GET /pro/dynamic/tags`) — `{categories?,...page}` → `{items[],next_cursor,total}`.
- `elementor.dynamic.get_tag_schema` (R, `GET /pro/dynamic/tags/{name}`) — `{tag_name}` → `{controls,categories,group}`.

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ToolHandler` from `runtime/`; `ctx.registry` introspection + `ctx.surface.enable`). Code.
- WP-F02 (`WpRoutes`: `listDocuments`,`getDocument`,`getDocumentSettings`,`schemaWidget`,`schemaStyles`,`schemaBreakpoints`,`listDynamicTags`,`getDynamicTag`). Code (via `ctx.wp`).
- WP-F04 (the catalog descriptors + `registry.attachHandler`). The handlers attach by EXACT name. Code.
- WP-F05 (`wp/errors.ts` `toMcpResult` for uniform error rendering; owns `site.capabilities` handler separately). Code.
- Contract 13 §1.1 (per-tool I/O), §0.6 (pagination), §5.2 (★ membership), §5.3 (search→enable→listChanged).
- Contract 10 §2.1/§2.4/§2.5/§3/§8/§12.

All READ-ONLY → not WRITE WPs → no `dry_run`/prime-css/S01 dependency.

## Detailed Requirements

1. Attach a handler for each §1.1 tool listed above (NOT `site.capabilities`). ★ members handled here: `tools.search`, `pages.list`, `page.get_structure`, `schema.widget`, `schema.styles`, `breakpoints.get` (Contract 13 §5.2). Each handler reads the WP-F04 descriptor's `inputSchema` is already validated by the SDK before the handler runs.
2. `tools.search`: call `ctx.registry`/`ctx.surface` find(query,prefix,limit); for matched disabled tools call `ctx.surface.enable([...])` (enables + one `sendToolListChanged()`, Contract 13 §5.3). Return `{tools:[{name,title,description,enabled,inputSchema,annotations}],total}`; `limit`-only (no cursor; bounded registry).
3. `page.get_structure` passes `depth`/`subtree_id`/`projection` to `GET /documents/{id}` (Contract 10 §2.4); `projection='summary'`→`{id,elType,widgetType}` per node; returns `base_hash` (required by surgical writes).
4. `pages.list`/`dynamic.list_tags` paginate `{limit,cursor,fields}`→`{items,next_cursor,total}` via WP-F02 paginated methods; never unbounded (Contract 13 §0.6).
5. `schema.widget` returns the POST-filter schema unchanged (Contract 10 §3.1; PHP injects `_cssid` + dynamic flags); `dynamic_props` from per-prop `dynamic.active`.
6. Errors: thrown `WpApiError` (e.g. `NOT_FOUND`, `AUTH_FAILED`) → `toMcpResult` `isError`; arg failures → `-32602` (SDK from zod).
7. `dynamic.*` route to Pro dynamic routes (Contract 10 §8) which include free tags; Pro-inactive 501 → render `PRO_REQUIRED`/`EXPERIMENT_INACTIVE` informationally.
8. Do NOT hardcode breakpoints (768/1024) — `breakpoints.get` reads the route (Contract 10 §3.4). No `any`; strict TS.

## Implementation Notes

- Handlers are thin: validate-by-SDK → `ctx.wp.<method>` → return `{ structuredContent }`. Types come from WP-F02.
- `tools.search` is the only handler with side effects (enabling tools); rely on `SurfaceController` (WP-T01) to dedupe + emit one `listChanged`.
- Do NOT re-implement `site.capabilities` — it is WP-F05's `tools/discovery-capabilities.ts`. The `CapabilitiesCache` (WP-T01) memoizes the same route; this WP's tools may read `ctx.capabilities` for gating but most are unconditional reads.
- Cite Contract 13 §1.1 + Contract 10 §ref per handler.

## Acceptance Criteria

- [ ] Handlers attached for all §1.1 tools EXCEPT `site.capabilities` (WP-F05); names match the catalog exactly.
- [ ] `tools.search` enables matched disabled tools + emits exactly one `sendToolListChanged()`.
- [ ] `page.get_structure` supports `depth`/`subtree_id`/`projection=summary`, returns `base_hash`+`generation`.
- [ ] `pages.list`/`dynamic.list_tags` paginate.
- [ ] REST errors → `isError` taxonomy results; arg errors → `-32602`.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `tools/discovery.test.ts` (vitest, no WP): mock `ctx.wp`/registry/surface; assert each handler's output matches the WP-F04 schema; assert `tools.search` enable+listChanged; assert pagination passthrough; assert error rendering. (Inspector smoke payloads added by WP-Q03.)

## Parallelization Notes

- Owns only `tools/discovery.ts` + test — disjoint from every other `tools/*` (and from WP-F05's `tools/discovery-capabilities.ts`).
- Wave 2: depends on WP-T01 (runtime) + WP-F02/F04/F05. Parallel-safe with all other handler WPs.
