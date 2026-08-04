---
id: WP-T01
title: TS server core runtime — McpServer init, registry wiring, profiles, surface mgmt, tool context
layer: ts
phase: MVP
status: planned
depends_on: [WP-F01, WP-F02, WP-F04, WP-F05]
files_owned:
  - packages/server/src/server.ts
  - packages/server/src/runtime/context.ts
  - packages/server/src/runtime/surface.ts
  - packages/server/src/runtime/capabilities-cache.ts
  - packages/server/src/runtime/elicit.ts
  - packages/server/src/runtime/index.ts
  - packages/server/src/runtime/surface.test.ts
  - packages/server/src/runtime/capabilities-cache.test.ts
  - packages/server/src/runtime/server-wiring.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §5 (large-surface ergonomics), §0.3 (annotations/elicitation)
  - spec/01-architecture.md §1.2 (Server core), §4.3 (data-driven registry), §7 (tool-surface mgmt = TS)
  - spec/contracts/15-engineering-standards.md §1 (SDK pin, transports), §2.10 (env read once)
estimate: M
---

## Summary

Builds the server-core RUNTIME that turns WP-F04's data-only catalog/registry into a live `McpServer`: `server.ts` constructs the `McpServer` (@mcp/sdk ^1.29), reads the WP-F04 `ToolRegistry`, calls `server.registerTool`/`registerResource`/`registerPrompt` for every descriptor, applies the lean/full profile (disable non-★ at boot), and drives `enable()`+`sendToolListChanged()` for dynamic surface management. It also owns the shared `ToolContext` (the runtime injected into every handler), the `SurfaceController`, the memoized `CapabilitiesCache`, and the elicitation helper. It contains NO per-tool handler logic and NO REST URLs — handlers attach via `registry.attachHandler(name, fn)` (WP-F04 §7) and call REST via the WP-F02 client.

## Interface / Contract

This WP defines the runtime seam every tool/resource/prompt handler WP consumes. WP-F04 owns the descriptor/registry DATA; this WP owns the live wiring + context.

Exported from `packages/server/src/runtime/context.ts`:

- `interface ToolContext` — injected into every handler: `{ wp: WpRoutes /* from WP-F02 wp/routes.ts */; capabilities: CapabilitiesCache; surface: SurfaceController; registry: ToolRegistry /* WP-F04 */; elicit: ElicitFn; logger: Logger }`.
- `type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<CallToolResult>` — the signature vertical WPs implement and `attachHandler`.
- `type ResourceHandler` / `type PromptHandler` analogous.
- `buildContext(deps): ToolContext` — composes the context from the WP-F02 `WpRoutes`, the cache, surface, registry, elicit.

Exported from `packages/server/src/runtime/surface.ts`:

- `class SurfaceController` — holds the live `McpServer` + the WP-F04 registry's enable/disable bookkeeping. `enable(names: string[])` flips disabled tools enabled (via the SDK `RegisteredTool.enable()`) and calls `server.sendToolListChanged()` exactly once per batch (only if something changed). `isEnabled(name)`, `enabledNames()`. This is the live driver for the WP-F04 registry's enable hooks (Contract 13 §5.3).

Exported from `packages/server/src/runtime/capabilities-cache.ts`:

- `class CapabilitiesCache` — `get(): Promise<Capabilities>` memoizes a single `wp.siteCapabilities()` call (WP-F02 route / WP-F05 capability types); `refresh()` forces re-fetch; tools gate on `get()` for `can_update_class`, `atomic`, `pro`, `experiments` (Contract 13 M6). `Capabilities` type imported from WP-F05 `packages/shared/src/capabilities`.

Exported from `packages/server/src/runtime/elicit.ts`:

- `type ElicitFn = (prompt: string, schema: FlatPrimitiveShape) => Promise<{ confirmed: boolean; values?: Record<string, string|number|boolean> }>` — wraps the SDK elicitation (`elicitInput`) with a FLAT-PRIMITIVES-ONLY schema (Contract 13 §0.3 / architecture §4 corollary). Destructive tools call this when `confirm!=true`.

Exported from `packages/server/src/server.ts`:

- `buildServer(deps): { server: McpServer; surface: SurfaceController; ctx: ToolContext }` — the composition root: constructs the `McpServer`, reads the WP-F04 registry, registers every tool/resource/prompt from the catalog, applies the profile, and returns the wired server. Called by WP-F01's `index.ts` (which constructs the WP-F02 client + creds and the transport from WP-T02).

## Dependencies & Inputs

- WP-F01 (scaffold; owns `index.ts` which CALLS `buildServer` + `startTransport`). This WP does NOT own `index.ts`.
- WP-F02 (`wp/routes.ts` `WpRoutes` typed wrappers + `wp/client.ts`) — the `ToolContext.wp` and the capabilities fetch. Code dependency on the typed routes.
- WP-F04 (`catalog/registry.ts` `ToolRegistry` + `catalog/profiles.ts` lean ★ set + `catalog/index.ts`) — the descriptor source. This WP READS the registry and drives its enable/disable + `sendToolListChanged` hooks; it does NOT edit F04 files (architecture §4.3, WP-F04 §7 "the actual server.registerTool/sendToolListChanged calls are WP-T01's").
- WP-F05 (`packages/shared/src/capabilities` `Capabilities` type + `wp/errors.ts` `toMcpResult`/`McpErrorPayload`) — the cache type + uniform error rendering. NOTE: WP-F05 also owns `tools/discovery-capabilities.ts` (the `site.capabilities` handler) — this WP does NOT own that; it wires it like any other handler.
- Contract 13 §5 (lean/full profiles, `tools.search`→enable→listChanged, env fallback `ULTRA_TOOLS`, meta-trio always-on), §0.3 (annotations + elicitation flat-primitives).
- Architecture §1.2 (Server core "Touch WP directly: NO" — it only constructs context), §4.3 (data-driven registry; tool files do not edit `server.ts`), §7 (tool-surface management is TS-owned; destructive-op elicitation gating is TS-owned).
- Contract 15 §1 (SDK pin ^1.29; `RegisteredTool.enable()`/`disable()`; `server.sendToolListChanged()`), §2.10 (env read once at init — `index.ts` does the read; this WP receives parsed config in `deps`).

This is NOT a WRITE WP (it issues no element-tree writes; handlers do). No prime-css/S01 dependency.

## Detailed Requirements

1. `buildServer`:
   a. Construct `McpServer` with name/version + capabilities `{ tools: { listChanged: true }, resources: {}, prompts: {} }`.
   b. Read the WP-F04 registry; for EVERY tool descriptor call `server.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, wrappedHandler)` where `wrappedHandler` resolves the attached handler (`registry.getDescriptor(name)` + its attached fn) and injects `ctx`. If a tool has NO attached handler, the wrapped handler returns a clear "handler not registered" `isError` result (WP-F04 §7 contract) so the server can boot before every vertical lands.
   c. Register resources via `registerResource`/`ResourceTemplate` and prompts via `registerPrompt` from the catalog descriptors, resolving their attached handlers the same way.
   d. Apply the profile: from `catalog/profiles.ts` `listForProfile(resolveProfile(env))`, `disable()` every tool NOT in the enabled set. The meta-trio is ALWAYS enabled (WP-F04 flags them always-on; this WP must not disable them).
2. `resolveProfile` reads `ULTRA_TOOLS` (default `lean`) — but the env is read ONCE in `index.ts` (WP-F01) and passed in `deps`; this WP consumes the parsed value (Contract 15 §2.10). If F04's `profiles.ts` exposes the resolution, reuse it rather than re-implementing.
3. `SurfaceController.enable([...])` flips the named tools to enabled (SDK `RegisteredTool.enable()`), dedupes already-enabled names, and calls `server.sendToolListChanged()` once per batch only if at least one tool changed (Contract 13 §5.3). `tools.search` (WP-T04 discovery) calls this on a match.
4. `CapabilitiesCache.get()` memoizes one `wp.siteCapabilities()` result; `refresh()` invalidates. Tools call `ctx.capabilities.get()` to gate (e.g. design tools check `can_update_class`; page.build checks `atomic` for v4→v3 fallback).
5. `ElicitFn` wraps SDK elicitation with a flat-primitives schema (no nested objects/arrays, Contract 13 §0.3). Returns `{confirmed}`; a decline → handlers return a clean non-error result (Contract 12 §5 rule 5).
6. `ToolContext` is the SINGLE object every handler receives; it exposes `wp` (REST), `capabilities`, `surface`, `registry`, `elicit`, `logger`. The logger writes to stderr only (stdout reserved for stdio transport).
7. Boot assertions (dev): every registered tool name matches `^[A-Za-z0-9_.-]{1,128}$`; the enabled-at-boot set for `lean` equals the WP-F04 ★ set; the meta-trio is enabled.
8. No `any`; strict TS; external/env data parsed via zod at the boundary.

## Implementation Notes

- This WP is the GLUE between F04 (data) and the live SDK. Keep it free of per-tool logic; the only tool-specific knowledge is "look up the attached handler and call it with ctx."
- The wrapped-handler indirection lets vertical WPs `registry.attachHandler(name, fn)` at module import time; `server.ts` resolves the attachment lazily at call time, so registration order does not matter and a missing handler degrades gracefully.
- `sendToolListChanged` discipline: batch enables in `tools.search`; emit once. Never emit on no-op enables.
- Elicitation schema MUST be flat primitives (Contract 13 §0.3). Provide a tiny `confirmSchema = { confirm: z.boolean() }` default plus a way to add scalar fields.
- The `index.ts` (WP-F01) is expected to: parse env once → construct WP-F02 client + `WpRoutes` → `buildServer(deps)` → `startTransport(server, transportConfig)` (WP-T02). Document this call sequence so WP-F01's stub matches.
- Cite Contract 13 §5 + architecture §4.3/§7 in comments.

## Acceptance Criteria

- [ ] `buildServer` registers every WP-F04 tool/resource/prompt against the live `McpServer` and applies the lean profile (disable non-★ at boot); `full` enables all.
- [ ] An unattached tool returns a clear "handler not registered" isError (server boots before verticals land).
- [ ] `SurfaceController.enable([...])` flips disabled tools enabled and emits exactly one `sendToolListChanged()` per batch; zero on no-op.
- [ ] `CapabilitiesCache.get()` memoizes one `siteCapabilities()` call; `refresh()` re-fetches.
- [ ] `ElicitFn` enforces flat-primitive schemas and returns `{confirmed}`.
- [ ] Boot assertions: name format, lean=★ set, meta-trio always enabled.
- [ ] No tool/resource/prompt file edits `server.ts` to register (data-driven via the F04 registry).
- [ ] No `any`; strict `tsc` + lint clean; stderr-only logging.

## Tests Required

- `runtime/server-wiring.test.ts` (vitest, no WP): with a stub WP-F04 registry (synthetic descriptors incl. ★/non-★/meta), assert `buildServer` registers all, disables non-★ for lean, enables all for full, keeps meta-trio enabled, and returns a "handler not registered" result for an unattached tool.
- `runtime/surface.test.ts`: assert `enable([...])` flips state + one `sendToolListChanged` per batch, zero on no-op.
- `runtime/capabilities-cache.test.ts`: assert memoization (one fetch) + `refresh()` re-fetch.

## Parallelization Notes

- Owns only `server.ts` + `runtime/*` — disjoint from WP-F01's `index.ts`, WP-F02's `wp/*`, WP-F04's `catalog/*`, WP-F05's `wp/errors.ts`/`tools/discovery-capabilities.ts`, and every `tools/*`/`resources/*`/`prompts/*` handler WP.
- Wave 1 (after the foundation WPs F02/F04/F05 freeze their interfaces). It is the upstream code dependency for every handler WP (they import `ToolContext`/`ToolHandler` from `runtime/`).
- Integrates with WP-T02 (transport) via the `McpServer` returned by `buildServer`; both build concurrently against the SDK + the `buildServer` signature.
