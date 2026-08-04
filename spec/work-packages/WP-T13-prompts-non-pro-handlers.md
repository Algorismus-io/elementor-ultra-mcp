---
id: WP-T13
title: TS prompt handlers — build-from-brief, html-to-native, design-system-audit (non-pro)
layer: ts
phase: v1
status: planned
depends_on: [WP-F01, WP-F04, WP-T01]
files_owned:
  - packages/server/src/prompts/build-from-brief.ts
  - packages/server/src/prompts/html-to-native.ts
  - packages/server/src/prompts/design-system-audit.ts
  - packages/server/src/prompts/index.ts
  - packages/server/src/prompts/prompts.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md §3 (prompts)
  - spec/00-product-overview.md §2 (use cases), §5 (phasing)
  - spec/01-architecture.md §7 (HTML never auto-commits)
estimate: S
---

## Summary

Implements the HANDLERS for three of the four registered MCP prompts (Contract 13 §3) — the NON-Pro ones: `build-from-brief`, `html-to-native`, `design-system-audit`. (The fourth, `theme-builder-from-spec`, is Pro-oriented and owned by WP-R07 — its handler lives in `packages/server/src/prompts/theme-builder-from-spec.ts`, NOT in this WP.) WP-F04 owns the prompt argument schemas (`catalog/prompts.ts`) for ALL FOUR prompts; this WP owns the handlers that emit the structured plan steering the agent through the correct tool sequence and the LOCKED safety flows for the three non-Pro prompts.

## Interface / Contract

Each prompt handler is a `PromptHandler` (WP-T01 `runtime/`) returning a `GetPromptResult`, attached to the WP-F04 prompt descriptor by name. Argument schemas (STRING args) are owned by WP-F04 (Contract 13 §3):

- `build-from-brief` — args `{brief, post_type?, generation?}`. Plan: `elementor.site.capabilities` → `elementor.schema.widget`/`elementor.schema.styles` → `elementor.page.dry_run` → `elementor.page.build`. Schema-first, no invented props, V4/V3 fallback.
- `html-to-native` — args `{html, css?, coverage_gate?}`. Plan: `elementor.convert.html_to_tree` → review report → `elementor.convert.html_to_page` with explicit `commit:true`+`confirm:true`. NEVER auto-commit (LOCKED).
- `design-system-audit` — args `{scope?}` (`classes|variables|all`). Plan: read `elementor.design.classes.list`/`elementor.design.variables.list`/`elementor.design.globalColors.list`; flag the 1000-item budget + duplicate labels; propose consolidating `elementor.design.classes.upsert`/`elementor.design.variables.batch`.

`prompts/index.ts` (owned by THIS WP) is the NON-Pro prompt barrel: it imports the three non-Pro handler modules so their `registry.attachHandler(name, fn)` side-effects run, and exports `registerNonProPrompts(registry)`. It MUST NOT reference `theme-builder-from-spec` — the Pro prompt attaches itself via its own leaf module (`prompts/theme-builder-from-spec.ts`, WP-R07) which exports `registerThemeBuilderPrompt(registry)` and is collected by the Pro barrel the server core wires (the same disjoint pattern as the Pro tool barrel, R07 §"File split rationale"). All four descriptors (incl. `theme-builder-from-spec`) are declared in WP-F04 `catalog/prompts.ts`; handlers attach to the registry BY NAME, so adding the Pro prompt never requires editing this WP's `prompts/index.ts`.

## Dependencies & Inputs

- WP-T01 (`PromptHandler`; the server wiring that calls `server.registerPrompt` from the catalog + injects handlers). Code.
- WP-F04 (`catalog/prompts.ts` prompt descriptors + argument schemas — authoritative names/args). Code.
- Contract 13 §3 (the four prompts), §1 tool names the plans reference (must use EXACT names). Product overview §2 (use cases), §5 (phasing). Architecture §7 (HTML never auto-commits).

Prompts are pure text-plan generators — NO writes, NO tool calls inside the handler → no WRITE/dry_run/prime-css dependency. They reference tool names by string in the emitted plan.

## Detailed Requirements

1. Provide handlers for the three non-Pro prompts; names/args match the WP-F04 descriptors (Contract 13 §3). Args are STRINGS (MCP prompt args are strings) — `generation`/`coverage_gate`/`scope` are `z.string()`; the plan instructs the agent to pass parsed values to tools.
2. `build-from-brief` plan: (a) `elementor.site.capabilities` first to choose V4/V3 + confirm experiments; (b) look up `elementor.schema.widget`/`elementor.schema.styles` BEFORE authoring any prop (never invent props, Contract 15 §2.6); (c) `elementor.page.dry_run` to validate; (d) then `elementor.page.build`. Reflect the V4-default/V3-fallback rule.
3. `html-to-native` plan enforces the LOCKED never-auto-commit flow: `elementor.convert.html_to_tree` → review coverage/a11y/stripped-text report → (if acceptable) `elementor.convert.html_to_page` with explicit `commit:true`+`confirm:true` (Contract 13 §3/§1.9, architecture §7). State the coverage gate honestly (S3-anchored, never a hardcoded 85%, RESEARCH §6.8).
4. `design-system-audit` plan reads classes/variables/V3 globals, flags 1000-item budget proximity + duplicate labels, proposes consolidating `classes.upsert`/`variables.batch` (Contract 13 §3). `scope` narrows.
5. Each handler returns a well-formed `GetPromptResult` (messages); no tool calls in the handler.
6. Do NOT implement `theme-builder-from-spec` (Pro — owned by WP-R07 at `prompts/theme-builder-from-spec.ts`). `prompts/index.ts` imports/attaches ONLY the three non-Pro prompts; the Pro prompt is a separate leaf file owned by WP-R07 that self-attaches by name via the Pro barrel, so this WP's `index.ts` is never edited to add it.
7. No `any`; strict TS.

## Implementation Notes

- Reference EXACT tool names from Contract 13 §1 (a misspelled tool name in a prompt violates Contract 15 §4.1).
- `html-to-native` is the user-facing guardrail for the most dangerous flow — be explicit that the converter NEVER auto-commits and the agent must inspect the report + explicitly confirm.
- Prompt args are strings; the prompt instructs the agent to pass parsed numeric/bool values (e.g. `coverage_gate` 0..1) to the tool — the handler does not coerce.
- `prompts/index.ts` is this WP's NON-Pro barrel; the Pro prompt file (`prompts/theme-builder-from-spec.ts`, WP-R07) attaches itself by name via the Pro barrel the server core wires, keeping ownership disjoint — this WP never imports or references the Pro prompt module.

## Acceptance Criteria

- [ ] Handlers for the three non-Pro prompts attached with the WP-F04 descriptor names; args are strings.
- [ ] `build-from-brief`: capabilities → schema.* → dry_run → build; schema-first, no invented props, V4/V3 fallback.
- [ ] `html-to-native`: enforces never-auto-commit (tree → report → explicit commit+confirm) with an honest (S3-anchored) coverage gate.
- [ ] `design-system-audit`: reads classes/variables/globals, flags budget + duplicate labels, proposes consolidation.
- [ ] All referenced tool names are exact Contract 13 names.
- [ ] `theme-builder-from-spec` NOT implemented here (it is owned by WP-R07); `prompts/index.ts` neither imports nor references it.
- [ ] No `any`; strict `tsc` + lint clean.

## Tests Required

- `prompts/prompts.test.ts` (vitest, no WP): assert each handler attaches with the exact name; assert the emitted plan references the correct exact tool names + encodes never-auto-commit / schema-first / budget-flag rules; assert `theme-builder-from-spec` is absent from this module's `index.ts`. (Prompt presence also smoke-tested by WP-Q03, Contract 14 §8 step d — the fourth, `theme-builder-from-spec`, comes from WP-R07.)

## Parallelization Notes

- Owns `prompts/build-from-brief.ts`, `prompts/html-to-native.ts`, `prompts/design-system-audit.ts`, `prompts/index.ts` + test — disjoint from all other WPs and from the Pro prompt file `prompts/theme-builder-from-spec.ts` (owned by WP-R07, wave 8 — a strictly later wave, so no concurrency overlap and no shared file).
- Phase v1, Wave 2. Depends only on WP-T01 + WP-F04. Parallel-safe with all tool/resource WPs.
