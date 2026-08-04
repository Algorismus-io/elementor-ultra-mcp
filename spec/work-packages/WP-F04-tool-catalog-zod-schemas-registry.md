---
id: WP-F04
title: Realize the tool catalog — zod schema modules + data-driven tool-registry skeleton
layer: foundation
phase: foundation
status: planned
depends_on:
  - WP-F01
  - WP-F03
files_owned:
  - packages/server/src/catalog/tools.ts
  - packages/server/src/catalog/resources.ts
  - packages/server/src/catalog/prompts.ts
  - packages/server/src/catalog/profiles.ts
  - packages/server/src/catalog/registry.ts
  - packages/server/src/catalog/index.ts
  - packages/server/src/catalog/schemas/shared.ts
  - packages/server/src/catalog/schemas/discovery.ts
  - packages/server/src/catalog/schemas/page.ts
  - packages/server/src/catalog/schemas/widget.ts
  - packages/server/src/catalog/schemas/design.ts
  - packages/server/src/catalog/schemas/media.ts
  - packages/server/src/catalog/schemas/nav.ts
  - packages/server/src/catalog/schemas/templates.ts
  - packages/server/src/catalog/schemas/pro.ts
  - packages/server/src/catalog/schemas/convert.ts
  - packages/server/src/catalog/schemas/ops.ts
  - packages/server/src/catalog/schemas/meta.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md (full tool/resource/prompt set, names, ZodRawShape schemas, ★ lean profile, annotations)
  - spec/01-architecture.md §2.1 (Seam A — MCP catalog; names + schemas immutable)
  - spec/contracts/15-engineering-standards.md §2.2 (zod ZodRawShape), §4.5 (TS DoD)
  - spec/contracts/12-error-taxonomy.md (codes referenced in tool error outputs)
estimate: L
---

## Summary

Realize Seam A as code: the complete MCP tool/resource/prompt catalog as zod `ZodRawShape` schema modules (one module per tool group) plus a data-driven registry that the server core (WP-T01) consumes to register tools without editing per-tool files. This freezes the exact tool NAMES, `inputSchema`/`outputSchema` (ZodRawShape maps on `@mcp/sdk ^1.29`), annotations (`readOnlyHint`/`idempotentHint`/`destructiveHint`), and the lean ★ profile membership (`13-tool-catalog.md §5.2`). It contains NO handler logic — handlers are owned by the vertical tool WPs (WP-T##/H##/R##), which attach to registry entries by name.

## Interface / Contract

- **`catalog/tools.ts`.** A typed `ToolDescriptor[]` listing EVERY tool in `13-tool-catalog.md`: name (dot-namespaced under `elementor.`, matching `^[A-Za-z0-9_.-]{1,128}$`), title, description, `inputSchema` + `outputSchema` (ZodRawShape maps), `annotations`, lean-profile flag (★), and the backing REST route id (from WP-F02's registry) where applicable. Includes the combined rows expanded: `.classes.list/.upsert/.delete`, `.set_triggers/.set_timing`, `.globalColors.{list,upsert,delete}`, `.globalFonts.{list,upsert,delete}`, `.element_defaults.{get,set}`, the meta-trio (`tools.list_endpoints`, `.get_schema`, `.invoke`), etc.
- **`catalog/resources.ts`.** All resources `elementor://...`: `site/capabilities`, `breakpoints`, `schema/styles`, `schema/widget/{type}`, `page/{id}/structure`, `kit/global-classes`, `kit/variables`, `kit/global-colors`, `kit/element-defaults`, `templates` — each with URI template + output schema.
- **`catalog/prompts.ts`.** The four prompts: `build-from-brief`, `html-to-native`, `design-system-audit`, `theme-builder-from-spec` — name + argument schema.
- **`catalog/profiles.ts`.** The lean ★ set (18 tools, exactly the list in `13-tool-catalog.md §5.2`): `elementor.tools.search, site.capabilities, pages.list, page.get_structure, page.create, page.build, page.dry_run, schema.widget, schema.styles, breakpoints.get, widget.insert, widget.update_settings, design.classes.list, design.classes.upsert, design.variables.list, media.sideload_url, convert.html_to_tree, convert.html_to_page`. Plus `ULTRA_TOOLS=lean|full` resolution rules.
- **`catalog/registry.ts`.** A `ToolRegistry` that holds descriptors, exposes `getDescriptor(name)`, `attachHandler(name, fn)` (called by vertical WPs), `listForProfile(profile)`, and the enable/disable + `sendToolListChanged` bookkeeping the server core drives. Pure data + bookkeeping — no MCP server instance here (that's WP-T01).
- **Pagination shape** baked into every list tool schema: input `{limit?,cursor?,fields?[]}`, output `{items,next_cursor,total}`.

## Dependencies & Inputs

- Upstream: WP-F01 (scaffold, zod peer), WP-F03 (authoring types — tool I/O schemas reference `ElementNode`/`StyleVariant`/`Diff`/`DryRunResult`/`CoverageReport`/`PageSettings` etc. via zod schemas that mirror those types).
- Contracts: `13-tool-catalog.md` (the authority — names, schemas, ★, annotations, resources, prompts); `01-architecture.md §2.1`; `15-engineering-standards.md §2.2`.
- Elementor APIs: none directly. Tool semantics map to REST routes (WP-F02) and authoring types (WP-F03).

## Detailed Requirements

1. **Every tool in Contract 13 present** with exact name + ZodRawShape `inputSchema`/`outputSchema` + annotations. Group into the schema modules listed in `files_owned` (one per tool family) so vertical WPs import only their group.
2. **ZodRawShape, not z.object (LOCKED).** `inputSchema`/`outputSchema` are `{ field: z.zodType }` maps per `@mcp/sdk ^1.29` (`15-engineering-standards.md §1`). Do not use SDK 2.x `z.object` form.
3. **Annotations correct.** Read tools `readOnlyHint:true`; idempotent writes `idempotentHint:true`; destructive tools (`page.delete`, `element.delete`, `design.classes.delete`, `kit.revert`, etc.) `destructiveHint:true` (gating is enforced by the TS handler WPs via elicitation, `12-error-taxonomy.md §5.5`).
4. **Lean ★ profile = exactly 18 tools** per `13-tool-catalog.md §5.2`. `profiles.ts` must produce that exact set for `lean`; `full` = all enabled. Non-★ advanced tools are `disable()`d at boot and surfaced via `tools.search` → `enable()` + `sendToolListChanged()` (the registry exposes the hooks; WP-T01 wires the live `McpServer`).
5. **Resources + prompts** complete per Contract 13 §2/§3 with URI templates and schemas.
6. **Meta-trio always available** (`tools.list_endpoints`, `.get_schema`, `.invoke`) — flagged in the registry as always-enabled.
7. **No handlers.** The registry stores descriptors and an attachment point; calling an unattached tool yields a clear "handler not registered" error (so the catalog can ship before any vertical). This keeps tool files disjoint: each vertical WP owns `tools/<family>.ts` with handlers and calls `registry.attachHandler(name, fn)`; F04 owns the schemas/registry only.
8. **REST route linkage.** Where a tool 1:1 proxies a REST route, store the route id (from WP-F02 `rest/routes.ts`) on the descriptor so handler WPs and contract tests can cross-check tool↔route coverage.

## Implementation Notes

- The combined catalog rows in Contract 13 (".list/.upsert/.delete", ".set_triggers/.set_timing") EXPAND to multiple named tools — enumerate each as its own descriptor so `tools/list` returns the real names.
- Keep schema modules import-light so a vertical WP pulls only its family (e.g. `tools/design.ts` imports `catalog/schemas/design.ts`).
- The registry's enable/disable + `listChanged` is bookkeeping only; the actual `server.registerTool`/`server.sendToolListChanged` calls are WP-T01's (it reads the registry). Define the interface F04 exposes so WP-T01 can drive it without editing F04 files.
- Output schemas must use the same shapes as WP-F03's types (re-express as zod). Where a tool returns a `DryRunResult`/`Diff`/`CoverageReport`, the zod schema mirrors the JSON Schema — add a test that the zod schema and the JSON Schema agree on required keys.

## Acceptance Criteria

- [ ] Every tool/resource/prompt name in `13-tool-catalog.md` exists in the catalog modules with the exact name and a ZodRawShape schema.
- [ ] `profiles.ts` returns EXACTLY the 18 ★ tools for `lean` (asserted against the Contract 13 §5.2 list).
- [ ] All tools are ZodRawShape maps (no SDK 2.x `z.object` top-level); a lint/test guard fails if a top-level `z.object` is used as `inputSchema`.
- [ ] Annotations match Contract 13 (read/idempotent/destructive hints).
- [ ] Registry exposes attach/get/list/enable/disable hooks; no `McpServer` instance and no handlers.
- [ ] Tool names match `^[A-Za-z0-9_.-]{1,128}$`; resource URIs match `elementor://...`.
- [ ] `pnpm build` + `pnpm lint` clean; no `any`.

## Tests Required

- Unit (vitest): enumerate the catalog and assert name set + ★ set + annotations match Contract 13 fixtures (a committed JSON snapshot of expected names/flags); assert no top-level `z.object` schema; assert each list tool has the pagination shape.
- Contract: tool↔route coverage — every tool with a REST linkage references a real route id in WP-F02's registry; every resource has a URI template.
- Contract: zod output schema vs WP-F03 JSON Schema agreement for `DryRunResult`/`Diff`/`CoverageReport`.
- Fixtures: a `catalog.snapshot.json` of names+flags (committed; drift fails CI) — add under `packages/server/src/catalog/` (owned here), NOT under WP-F06's fixtures tree.

## Parallelization Notes

- Early Wave 1, parallel-safe with WP-F02 (rest), WP-F05 (errors), WP-F06 (harness). Depends on WP-F03 for authoring types referenced in tool schemas. Disjoint files: F04 owns `catalog/*` only.
- All vertical tool WPs (WP-T##, WP-H##, WP-R##) depend on this catalog to know names/schemas and to attach handlers; they own `tools/<family>.ts` (handlers) — disjoint from `catalog/*`.
- WP-T01 (server core) depends on F04's registry to register tools; it owns `server.ts`, not `catalog/*`.
