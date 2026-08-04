---
id: WP-T12
title: TS resource handlers — elementor:// read-only resource read/list callbacks
layer: ts
phase: v1
status: planned
depends_on: [WP-F01, WP-F02, WP-F04, WP-F05, WP-T01]
files_owned:
  - packages/server/src/resources/index.ts
  - packages/server/src/resources/handlers.ts
  - packages/server/src/resources/index.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §2 (resources)
  - spec/contracts/10-rest-api.md §2.4, §3, §4, §7, §12
  - spec/01-architecture.md §2.1 (Seam A producers)
estimate: S
---

## Summary

Implements the read/list HANDLERS for the MCP resource catalog (Contract 13 §2) and attaches them to the WP-F04 resource descriptors: the `elementor://...` URIs (`site/capabilities`, `breakpoints`, `schema/styles`, `schema/widget/{type}`, `page/{id}/structure`, `kit/global-classes`, `kit/variables`, `kit/global-colors`, `kit/element-defaults`, `templates`). WP-F04 owns the URI templates + output schemas (`catalog/resources.ts`); this WP owns the handlers that resolve each via the WP-F02 REST client.

## Interface / Contract

`resources/handlers.ts` exports a `read`/`list` handler per Contract 13 §2 resource, attached to the WP-F04 resource descriptors (by URI/name). `resources/index.ts` aggregates + registers them via the WP-T01 wiring (the server calls `registerResource`/`ResourceTemplate` from the catalog; this module supplies the callbacks). The ten resources + backing routes (Contract 13 §2):

| URI | Backing route (WP-F02) |
|---|---|
| `elementor://site/capabilities` | `siteCapabilities` |
| `elementor://breakpoints` | `schemaBreakpoints` |
| `elementor://schema/styles` | `schemaStyles` |
| `elementor://schema/widget/{type}` | `schemaWidget(type)` |
| `elementor://page/{id}/structure` | `getDocument(id)` |
| `elementor://kit/global-classes` | `listClasses` |
| `elementor://kit/variables` | `listVariables` |
| `elementor://kit/global-colors` | `getGlobalColors` |
| `elementor://kit/element-defaults` | `getElementDefaults` |
| `elementor://templates` | `listTemplates` |

Each handler returns a JSON body (`mimeType: application/json`) matching the backing route `data`. Collection-backing resources (`templates`, `kit/global-classes`, `kit/variables`) supply a `list` callback (cursor-paginated where the route is).

## Dependencies & Inputs

- WP-T01 (`ToolContext`/`ResourceHandler` from `runtime/`; the server-wiring that registers resources from the catalog + injects the handlers). Code.
- WP-F02 (`WpRoutes` read methods above). Code via `ctx.wp`.
- WP-F04 (`catalog/resources.ts` URI templates + output schemas + the registry resource descriptors the handlers attach to). Code.
- WP-F05 (`toMcpResult`/error rendering). Code.
- Contract 13 §2. Contract 10 §2.4/§3/§4/§7/§12. Architecture §2.1 (Seam A producers).

All READ-ONLY → no WRITE/dry_run/prime-css dependency.

## Detailed Requirements

1. Provide a `read` handler for each §2 resource resolving to the backing WP-F02 method through the shared App-Password client (Contract 13 §2 "resolved through the same App-Password REST client").
2. Parametric resources (`schema/widget/{type}`, `page/{id}/structure`) extract `{type}`/`{id}` from the resolved URI (via `ResourceTemplate`, registered by WP-T01 from the catalog) and call the route.
3. Collection-backing resources declare a `list` callback enumerating members (e.g. `templates` lists ids/titles; `kit/global-classes` lists class ids) so MCP clients can browse; paginate via cursor where the backing route paginates (Contract 13 §2 / §0.6).
4. Each resource body matches the backing route `data` payload (the same shape the equivalent read TOOL returns) — reuse the WP-F02 response types so resources + tools never diverge.
5. Errors: a thrown `WpApiError` (`NOT_FOUND` for an unregistered widget type / missing page) surfaces as a resource read error; URI mismatch is a protocol error.
6. Do NOT add resources beyond Contract 13 §2 (frozen). No `any`; strict TS; responses validated via WP-F02.

## Implementation Notes

- Resources mirror read tools — keep handlers as thin calls to the same WP-F02 methods the discovery tools use (single-source the shapes). `site/capabilities` resource maps to `siteCapabilities` (same data as the WP-F05 tool).
- `ResourceTemplate` registration (the actual `registerResource`/`ResourceTemplate` calls) is WP-T01's wiring; this WP supplies the read/list callbacks the catalog descriptors reference. Coordinate the attachment shape with WP-F04's resource descriptor + WP-T01's resource registration.
- The resources module is discovered by WP-T01's server wiring (specifier `./resources/index.js`); ownership stays disjoint.

## Acceptance Criteria

- [ ] read handlers provided for all ten §2 resources resolving to the correct WP-F02 routes; bodies match the route `data`.
- [ ] parametric resources extract `{type}`/`{id}`; collection resources supply `list` callbacks (paginated where applicable).
- [ ] No resources beyond Contract 13 §2; read errors surface cleanly.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `resources/index.test.ts` (vitest, no WP): mock `ctx.wp`; assert each resource resolves to the correct route + expected JSON shape; parametric variable extraction; `list` callbacks for collection resources; error rendering. (Resource reads also smoke-tested by WP-Q03, Contract 14 §8 step c.)

## Parallelization Notes

- Owns only `resources/index.ts`, `resources/handlers.ts` + test — disjoint from all `tools/*`, `prompts/*`, and the foundation files.
- Phase v1, Wave 2. Depends on WP-T01 (resource wiring) + WP-F02/F04/F05. Parallel-safe with all tool/prompt WPs.
