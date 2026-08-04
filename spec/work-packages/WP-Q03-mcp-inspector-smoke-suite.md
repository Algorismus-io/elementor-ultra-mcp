---
id: WP-Q03
title: QA — MCP Inspector smoke suite + lean-tool smoke payloads
layer: qa
phase: MVP
status: planned
depends_on:
  - WP-F04
  - WP-F06
  - WP-H12
files_owned:
  - packages/server/src/test-harness/smoke-driver.ts
  - packages/server/src/test-harness/smoke.test.ts
  - packages/shared/fixtures/envelopes/smoke.elementor.tools.search.json
  - packages/shared/fixtures/envelopes/smoke.elementor.site.capabilities.json
  - packages/shared/fixtures/envelopes/smoke.elementor.pages.list.json
  - packages/shared/fixtures/envelopes/smoke.elementor.page.get_structure.json
  - packages/shared/fixtures/envelopes/smoke.elementor.page.create.json
  - packages/shared/fixtures/envelopes/smoke.elementor.page.build.json
  - packages/shared/fixtures/envelopes/smoke.elementor.page.dry_run.json
  - packages/shared/fixtures/envelopes/smoke.elementor.schema.widget.json
  - packages/shared/fixtures/envelopes/smoke.elementor.schema.styles.json
  - packages/shared/fixtures/envelopes/smoke.elementor.breakpoints.get.json
  - packages/shared/fixtures/envelopes/smoke.elementor.widget.insert.json
  - packages/shared/fixtures/envelopes/smoke.elementor.widget.update_settings.json
  - packages/shared/fixtures/envelopes/smoke.elementor.design.classes.list.json
  - packages/shared/fixtures/envelopes/smoke.elementor.design.classes.upsert.json
  - packages/shared/fixtures/envelopes/smoke.elementor.design.variables.list.json
  - packages/shared/fixtures/envelopes/smoke.elementor.media.sideload_url.json
  - packages/shared/fixtures/envelopes/INDEX.md
contract_refs:
  - spec/contracts/14-fixtures-harness.md §8 (Inspector smoke suite — LOCKED), §10 (test:smoke script)
  - spec/contracts/13-tool-catalog.md §5.2 (lean ★ set — 18 tools), §2 (resources), §3 (prompts), §5.4 (env)
  - RESEARCH.md §9.3c (Inspector smoke)
estimate: M
---

## Summary

Implement the MCP Inspector smoke suite (`14-fixtures-harness.md §8`) — a fast end-to-end liveness check over the protocol surface — plus the minimal valid smoke payload per lean ★ tool. Q03 owns 16 of the 18 ★ smoke payloads; the two `convert.*` smoke payloads (`smoke.elementor.convert.html_to_tree.json`, `smoke.elementor.convert.html_to_page.json`) are owned by WP-H12 (the HTML corpus WP) and consumed here. It launches the TS server over stdio against wp-env, asserts `tools/list` exposes + enables the lean set, calls each ★ tool with its payload asserting no `-326xx` protocol error and an `outputSchema`-conformant result, reads each resource, and lists all four prompts.

## Interface / Contract

- **`smoke-driver.ts`.** Launches the server (stdio) with `WP_URL`/`WP_USER`/`WP_APP_PASSWORD` (`13-tool-catalog.md §5.4`) + `ULTRA_TOOLS=lean`; drives `@modelcontextprotocol/inspector` CLI or a thin SDK client. Helpers: `listTools()`, `callTool(name,payload)`, `readResource(uri)`, `listPrompts()`.
- **`smoke.test.ts`.** Asserts (`§8`): (a) `tools/list` contains + enables the lean ★ set (exactly the 18 from Contract 13 §5.2); (b) each ★ tool called with `envelopes/smoke.<tool>.json` returns no protocol `-326xx` and a result matching the tool's `outputSchema`; (c) each resource URI (Contract 13 §2) returns a JSON body; (d) all four prompts (Contract 13 §3) are present.
- **18 smoke payloads total** (Q03 owns 16; WP-H12 owns the 2 `convert.*`) — one minimal valid input per ★ tool, capability-gated by the same `requires` mechanism (`§2`). Read-only smokes run unconditionally; mutating smokes (page.create/build/widget.insert/update_settings/design.classes.upsert/convert.html_to_page) target a DISPOSABLE draft created+trashed in setup/teardown and skip if the tool/capability is unavailable.

## Dependencies & Inputs

- Upstream: WP-F04 (catalog — the lean ★ set + tool names + output schemas the smoke asserts against), WP-F06 (the `envelopes/` dir + the `test:smoke` script reservation + wp-env bootstrap; Q03 ADDS payloads + the driver, never edits F06's runner). The live smoke needs the actual tool handlers (WP-T## etc.) + the server core (WP-T01); feature-detect/skip tools that are not yet registered so the suite grows green as verticals land.
- Contracts: `14-fixtures-harness.md §8/§10`; `13-tool-catalog.md §5.2/§2/§3/§5.4`; RESEARCH §9.3c.
- Elementor APIs: none directly — the smoke is protocol-surface only; tools proxy to the PHP routes underneath.

## Detailed Requirements

1. **Lean set assertion** = exactly the 18 ★ tools in `13-tool-catalog.md §5.2`, present AND enabled at boot under `ULTRA_TOOLS=lean`.
2. **Per-tool smoke** with the minimal valid payload; assert no `-326xx` (protocol) and an `outputSchema`-conformant result.
3. **Resource reads** for every `elementor://...` resource (Contract 13 §2) → JSON body.
4. **Prompt list** = the four prompts (`build-from-brief`, `html-to-native`, `design-system-audit` from WP-T13; `theme-builder-from-spec` from WP-R07). All four DESCRIPTORS are always declared (WP-F04 `catalog/prompts.ts`), so `prompts/list` exposes all four names regardless of Pro; the assertion checks all four are present by name. (The `theme-builder-from-spec` HANDLER comes from WP-R07; feature-detect/skip its presence until WP-R07 lands, consistent with the suite's grow-green policy.)
5. **Mutating-smoke isolation:** a disposable draft created in setup, trashed in teardown; mutating payloads target it; skip when `ULTRA_TOOLS`/capabilities make a tool unavailable.
6. **Capability gating:** Pro/atomic-off installs skip the relevant smokes via `requires` so the suite is green on free-only (`§8`).
7. **Feature-detect growth:** if a ★ tool's handler is not yet registered, report SKIP (the suite is green from MVP and gains coverage as verticals land); the final DoD requires all 18 live.
8. **`INDEX.md`** mapping each ★ tool → its smoke payload + read-only/mutating classification.

## Implementation Notes

- Use the lean profile so non-★ tools are `disable()`d; the suite must confirm `tools.search` is present (it is the ★ enabler).
- Mutating smokes must NEVER touch a real page — always the disposable draft; teardown must trash it even on failure.
- Q03 ADDS files only (driver + payloads); it never edits F06's `inspector-smoke.ts` harness skeleton — instead it provides the payloads F06's smoke runner loads. RESOLVE overlap: F06 owns the smoke RUNNER skeleton (`inspector-smoke.ts`), Q03 owns the smoke TEST (`smoke.test.ts`) + driver + payloads; the test imports the skeleton's helpers. Keep these as separate files (disjoint) — Q03 does not edit `inspector-smoke.ts`.
- Output-schema conformance uses the zod `outputSchema` from WP-F04's catalog.

## Acceptance Criteria

- [ ] One `smoke.<tool>.json` exists for each of the 18 ★ tools, minimal + valid, capability-gated (Q03 provides 16; the 2 `convert.*` come from WP-H12).
- [ ] `smoke.test.ts` asserts the lean set is present + enabled; each ★ tool returns no `-326xx` + `outputSchema`-conformant result; resources read JSON; four prompts listed.
- [ ] Mutating smokes use a disposable draft (created/trashed in setup/teardown) and skip when unavailable.
- [ ] The suite is green on a free-only / atomic-off install (Pro/atomic smokes skipped).
- [ ] `pnpm test:smoke` runs the suite via the F06-reserved script; WP-F07 invokes it in the wp-env stage.
- [ ] Each smoke payload validates against its tool's `inputSchema` (`fixtures:validate`-adjacent check).

## Tests Required

- The smoke suite IS the test. Self-validate the driver against a stub server (lean set present, a read tool callable).
- A check that every smoke payload conforms to its tool's `inputSchema` (catalog-driven).

## Parallelization Notes

- Wave 2+, MVP phase. Parallel-safe with all other QA WPs (Q03 owns `envelopes/**` + `smoke-driver.ts` + `smoke.test.ts`; disjoint from Q01 `trees/**`, Q02 `schemas/**`, Q04 `html/**`, Q05 `roundtrip/**`). Depends on WP-F04 + WP-F06.
- Coverage grows as tool verticals (WP-T##/H##/R##) land; feature-detect/skip keeps it green meanwhile. Final DoD (all 18 live) gates with the MVP+v1 tool set.
