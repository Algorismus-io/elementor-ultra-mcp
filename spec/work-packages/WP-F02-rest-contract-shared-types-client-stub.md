---
id: WP-F02
title: Realize the REST contract — shared TS types, OpenAPI types, typed client/route stubs
layer: foundation
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - packages/shared/src/rest/types.ts
  - packages/shared/src/rest/envelopes.ts
  - packages/shared/src/rest/routes.ts
  - packages/shared/src/rest/index.ts
  - packages/server/src/wp/routes.ts
  - packages/server/src/wp/client.ts
  - packages/server/src/wp/types.ts
  - scripts/gen-openapi-types.mjs
contract_refs:
  - spec/contracts/10-rest-api.md (all 74 routes, envelopes, caps, cross-cutting fields)
  - spec/contracts/openapi.yaml (Seam B authority)
  - spec/01-architecture.md §2.2 (Seam B — TS ⇄ companion plugin)
  - spec/01-architecture.md §7 (cross-cutting ownership — TS forwards Basic auth, never trust decisions)
  - spec/contracts/12-error-taxonomy.md §2 (error envelope shape)
estimate: L
---

## Summary

Turn the frozen REST contract (`spec/contracts/openapi.yaml` + `10-rest-api.md`, 74 routes, namespace `elementor-ultra/v1`) into code: shared TS request/response types for every route, the success/error envelope types, a route-name registry, and the single typed HTTP client + `wp/routes.ts` typed wrappers (one function per route, 1:1). This is Seam B realized — the ONLY TS module allowed to know route URLs and payload shapes (`01-architecture.md §2.2`). Tool WPs and PHP controller WPs both target these types; neither reads the other's source.

## Interface / Contract

- **Envelopes (`packages/shared/src/rest/envelopes.ts`).** `RestSuccess<T> = { success: true; data: T }`; `RestError = { code: string; message: string; data: { status: number; op_id?: string; errors?: ValidationError[]; meta?: Record<string, unknown> } }` (verbatim from `10-rest-api.md` and `12-error-taxonomy.md §2`). A `RestResponse<T>` union.
- **Cross-cutting field types (`rest/types.ts`).** `OpId` (branded string `^[A-Za-z0-9_.-]{1,64}$`), `BaseHash` (32-hex md5), `Pagination` request `{ limit?: number<=100; cursor?: string; fields?: string[] }`, `Paginated<T> = { items: T[]; next_cursor: string|null; total: number }`, `ConditionTuple = [type, name, sub_name?, sub_id?]`, `WatermarkToken`. Per-route request/response interfaces for ALL 74 routes grouped by controller (documents, schema, design, media, nav, templates, pro, cache, ids, ops, site, batch).
- **Route registry (`rest/routes.ts`).** A const map of every route → `{ method, path (with `{id}` placeholders), cap }` for all 74 routes, so the client and tests enumerate the surface from one source.
- **`packages/server/src/wp/routes.ts`.** One typed async function per REST route (e.g. `documentsDryRun(id, body): Promise<DryRunResult>`, `designClassesPut(body): Promise<...>`), each delegating to `client.ts`. These are the wrappers tool WPs call.
- **`packages/server/src/wp/client.ts`.** The single HTTP client: Basic-auth header injection (`Authorization: Basic base64(user:app-password)`), JSON encode/decode, envelope unwrap (`{success,data}` → `data`; error envelope → typed `RestError` mapped to taxonomy code), retries-with-backoff ONLY for retryable taxonomy codes (`RATE_LIMITED`, `UPSTREAM_ERROR`, `CSS_PRIME_FAILED`), NEVER for concurrency codes (`12-error-taxonomy.md §5.3`), pagination cursor following helper, and per-site auth resolution from the config map (`01-architecture.md §6.2`).

## Dependencies & Inputs

- Upstream: WP-F01 (scaffold, `packages/server`, `packages/shared`, tsconfig). Code dependency on WP-F05 ONLY for the error-code enum import — to avoid a cycle, this WP defines the envelope SHAPE and references error codes as `string`; the concrete `ErrorCode` enum/type is imported from WP-F05's module. Declare WP-F05 as a soft contract dependency: import the type, do not implement it.
- Contracts: `spec/contracts/openapi.yaml` (the authority — types are generated from / validated against it), `10-rest-api.md` (route table, caps, cross-cutting fields, diff-PUT shape, pagination), `12-error-taxonomy.md §2/§5`.
- Elementor APIs: none directly — this seam is HTTP only. The route semantics trace to `01-architecture.md §2.2` route list.

## Detailed Requirements

1. **Generate-or-author types from OpenAPI.** `scripts/gen-openapi-types.mjs` reads `spec/contracts/openapi.yaml` and emits/validates `packages/shared/src/rest/types.ts`. If full codegen is impractical, author the types by hand AND have the script assert that every `operationId`/path in the YAML has a matching exported type (a drift check), failing CI on mismatch. Either way the YAML is the source of truth.
2. **All 74 routes typed.** Cover every route in `10-rest-api.md`: documents (17), schema (4), design (15), media (3), nav (3), templates/kits (8), pro (13, all `EDIT_POST`/`READ`), cache (2), ids (2), ops (1), site (1), batch (2). Group by controller file so a controller WP and a tool WP can both reference the same group.
3. **Diff-PUT type.** `design/classes` PUT body type per `10-rest-api.md`: `{ context; changes: { added; deleted; modified; order }; items (touched-only); order (full) }`. Reuse the frozen `Diff`/`NodeChange` shapes from WP-F03 where they overlap (import, do not redefine).
4. **Pagination contract.** `Pagination` + `Paginated<T>` used by every list route type. Client provides a cursor-follow helper but never auto-fetches all pages (no unbounded reads, `15-engineering-standards.md §2.9`).
5. **Auth + per-site map.** `client.ts` accepts a `SiteConfig { url; basicToken; capabilities? }` and injects Basic auth on every call to both `wp/v2/*` and `elementor-ultra/v1/*`. It makes NO trust decisions (`01-architecture.md §7` — AuthN/Z is PHP's).
6. **Error mapping.** On a `RestError` envelope, map `code` → taxonomy `ErrorCode`; surface as a typed `WpClientError` carrying the full `McpErrorPayload`-compatible shape (so tool WPs can convert to `isError` results). Implement the retry policy from `12-error-taxonomy.md §5.3`.
7. **op_id / base_hash threading.** Wrappers for write routes accept and forward `op_id` and `base_hash`; the client never invents them (TS minting is WP-T's idempotency module, PHP stores them).
8. **No business logic.** `routes.ts` wrappers are thin; they shape I/O and call the client. No validation truth, no tool-shaped logic (`01-architecture.md §1.2` "WP client MUST NOT embed tool-shaped logic").

## Implementation Notes

- The namespace constant is `elementor-ultra/v1` (PHP `Plugin::REST_NAMESPACE`); base path `${siteUrl}/wp-json/elementor-ultra/v1`. Also support `wp/v2/*` calls (media list/upload may use core routes) per `01-architecture.md §6.2`.
- 401 maps to `AUTH_FAILED`, 403 to `CAPABILITY_MISSING`/`NOT_EDITABLE`, 409 to the concurrency codes, 422 to the semantic codes, 501 to `EXPERIMENT_INACTIVE`/`PRO_REQUIRED` per the HTTP mapping table in `10-rest-api.md`.
- Keep `wp/routes.ts` ownership disjoint from any tool file: it exposes named functions; tool WPs import them. Adding a new route wrapper would edit this file, so if a later-wave route needs a wrapper, that route's controller WP must coordinate via a contract dependency — to avoid this, ALL 74 wrappers are authored here up front (even for routes whose controllers/tools land later), returning typed results that simply hit the (eventually-implemented) route.
- Use `fetch` (Node 20 global) — no axios. Add exponential backoff with jitter for retryable codes only.

## Acceptance Criteria

- [ ] Every one of the 74 routes in `10-rest-api.md` has: a registry entry in `rest/routes.ts`, a request+response type, and a typed wrapper in `wp/routes.ts`.
- [ ] `scripts/gen-openapi-types.mjs` passes: every `path`+`method` in `openapi.yaml` maps to an exported type; a missing/extra type fails the script.
- [ ] `client.ts` injects Basic auth, unwraps the success envelope, maps the error envelope to a typed error with a taxonomy code, and applies the retry policy (retryable codes retried, concurrency codes never).
- [ ] Pagination helper follows `next_cursor` only when explicitly asked; no unbounded fetch path exists.
- [ ] `pnpm build` + `pnpm lint` clean; no `any`.
- [ ] Types compile against and do not contradict `openapi.yaml` (drift script green).

## Tests Required

- Unit (vitest): client envelope unwrap (success + error), Basic-auth header construction, retry policy (retryable vs concurrency), pagination cursor follow. Mock `fetch`.
- Contract: a test that enumerates `rest/routes.ts` and asserts it equals the route set parsed from `openapi.yaml` (74 routes, methods, caps).
- Fixtures: error-envelope fixtures (one per HTTP status class: 400/401/403/404/409/422/501/500) asserted to map to the right taxonomy code. (Place under `packages/shared/fixtures/envelopes/` only by ADDING files; the fixtures dir/runner is WP-F06 — coordinate via contract, do not edit F06's runner.)

## Parallelization Notes

- Wave 0/early-Wave-1, parallel-safe with WP-F03, WP-F04, WP-F05, WP-F06 (disjoint files: F02 owns `rest/*` + `wp/*`; F03 owns `authoring/*` + `schemas/*`; F04 owns `mcp-catalog` schema modules; F05 owns `errors/*`/`capabilities/*`). Soft import of WP-F05's `ErrorCode` type means F05 should land first or expose the enum early; if F05 is not ready, F02 temporarily types codes as `string` and a follow-up swaps the import (declare the dependency so the assembler sequences F05 ≤ F02 where possible).
- All TS tool WPs (WP-T##) and the PHP controller WPs (WP-P##) depend on this WP's frozen types but are parallel to each other.

## Spike-Verified Corrections (Wave 1)

- **[S06]** The REST client stub MUST validate the response `Content-Type` is `application/json` before treating any 2xx as success. On plain-permalink sites `/wp-json/...` 301s to the homepage and returns HTTP 200 `text/html` — a silent false positive that the client MUST reject as a transport failure.
- **[S06]** The client MUST use the `?rest_route=/<route>` query-string form (or require/enable pretty permalinks), preferring the site-reported `rest_url()` over a hardcoded `/wp-json/` base. Verified: `?rest_route=/elementor/v1/global-classes` returns 200 JSON under App-Password Basic auth; the pretty path returns the homepage.
- **[S06]** Retry policy: the client MUST NOT retry on concurrency/conflict errors (those are deterministic business failures, not transient transport errors). Retries are only for genuine transport-level failures.
