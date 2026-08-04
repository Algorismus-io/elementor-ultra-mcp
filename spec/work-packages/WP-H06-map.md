---
id: WP-H06
title: MAP stage - role-to-atomic-element-type compilation + generation/tag selection
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-H01
  - WP-H05
files_owned:
  - packages/server/src/convert/map.ts
  - packages/server/src/convert/map.test.ts
contract_refs:
  - spec/contracts/11-authoring-contract.md#4-atomic-element-types-verified
  - spec/contracts/11-authoring-contract.md#41-per-widget-authorable-settings-props-from-supplement-b2
  - spec/contracts/11-authoring-contract.md#9-fallback-ladder-per-unmapped-declaration--node
  - spec/contracts/13-tool-catalog.md#19-html-native-conversion-flagship
estimate: M
---

## Summary

The fourth conversion stage: turn each classified IR node into a TARGET element-type decision — V4
atomic element type + `tag` enum, or the V3 classic fallback, or the structural/html-widget
last-resort (the whole-node fallback ladder, authoring-contract §9). It calls the WP-H01 mapping table
with the live capability context (`site.capabilities`) and produces a "mapped IR" annotated with the
chosen `elType`/`widgetType`/`tag` and the role-driven (non-style) `settings_seed`. It does NOT wrap
typed envelopes, extract styles, or persist — it decides WHAT each node becomes.

## Interface / Contract

`MapStageContext`, `MapResult`, `MappedNode`, `NodeFallback` are FROZEN and OWNED by WP-H01
(`convert/types.ts`, Contract 15 §4.6.1); this WP IMPLEMENTS the functions and `import type`s them — it
does NOT declare them locally. For reference (the frozen shapes):

Exports from `packages/server/src/convert/map.ts`:

- `mapIr(ir: IrNode[], ctx: MapStageContext): MapResult` where:
  - `MapStageContext = { generation:'v4'|'v3'; capabilities: SiteCapabilities; tab_pairing:
    Record<string,boolean> }` — `SiteCapabilities` is the `site.capabilities` output shape
    (13-tool-catalog §1.1; carries `atomic`, `pro`, `pro_atomic_form`, `experiments`, `breakpoints`).
  - `MapResult = { nodes: MappedNode[]; fallbacks: NodeFallback[]; warnings: string[] }`.
  - `MappedNode` extends the IR node with `{ target: MappingResult; settings_seed:
    Record<string,unknown>; children: MappedNode[] }` where `MappingResult` is from WP-H01.
  - `NodeFallback = { source_path: string; tier: 'native'|'v3_classic'|'structural_block'|
    'html_widget'; reason: string }` — the WHOLE-NODE fallback ladder (authoring-contract §9), distinct
    from the per-DECLARATION fallback ladder owned by STYLE-EXTRACT (WP-H07). The
    `CoverageReport.fallbacks[].tier` enum (`native|local_style|global_class|custom_css|html_widget`,
    diff.schema.json) is the per-declaration one; this WP records the node-level decision and the
    orchestrator (WP-H11) merges both into the report.
- `seedSettingsForRole(node: IrNode, target: MappingResult): Record<string,unknown>` — populate the
  role-driven RAW (un-enveloped) settings: e.g. `e-heading.tag` from the source heading level
  (h1->`h1`), `e-div-block.tag` from `containerTagFor`, `e-button.text` + `link` from the source text +
  href, `e-image` placeholder (real media-src filled in ASSEMBLE after sideload), `e-youtube.source`
  from the embed url. RAW values only — envelope wrapping is WP-H08.

## Dependencies & Inputs

- **WP-H05 (CLASSIFY)** — consumes the classified `ClassifyResult.ir` (roles + flex intent + tab pairing + naming); the `ClassifyResult`/`IrNode` types are frozen in WP-H01, so this WP compiles/unit-tests against them without WP-H05's runtime.
- **WP-H01** — `MAPPING_TABLE`, `mapRole`, `containerTagFor`, `MappingResult`, `NO_ATOMIC_EQUIVALENT`.
- **WP-F03** — shared types; `site.capabilities` output shape.
- Contract sections: 11-authoring-contract §4 (atomic type list), §4.1 (per-widget authorable props,
  for `settings_seed`), §9 (whole-node fallback ladder: atomic -> V3 classic -> generic
  `e-div-block`/`container` + styles -> html widget); 13-tool-catalog §1.1 (`site.capabilities`
  shape), §1.9. RESEARCH.md §6.2 (mapping), §6.4 (fallback ladder).

## Detailed Requirements

1. For each classified node, build the `MapContext` (WP-H01) from `ctx`: `atomic_active =
   capabilities.atomic && generation==='v4'`; `pro_active = capabilities.pro`; experiment flags from
   `capabilities.experiments` (notably `e_pro_atomic_form` for `e-form`); `tab_pairing_ok` from
   `ctx.tab_pairing[source_path]`; `child_count`/`has_youtube` from the node. Call
   `mapRole(role, mapContext)` to get the `MappingResult`.
2. **Generation fallback ladder (authoring-contract §9 whole-node).** When `generation==='v4'` but
   `capabilities.atomic` is false, map the entire tree to V3 classic (probe-driven fallback per the
   LOCKED decision "New pages default to V4 atomic, fall back to V3 when atomic inactive"). When a
   specific role has no atomic equivalent (`NO_ATOMIC_EQUIVALENT`: list, table), choose:
   (a) the structural-block approximation (`e-div-block` + child paragraphs for lists; `e-div-block`
   grid for tables) when feasible, else (b) the V3 classic widget (`icon-list` for lists), else
   (c) the html-widget last resort — record the chosen `tier` in `NodeFallback`.
3. **Tabs.** Map a paired tabs structure to the `e-tabs` family
   (`e-tabs` > `e-tabs-menu`>`e-tab`* + `e-tabs-content-area`>`e-tab-content`*, authoring-contract §4)
   ONLY when `tab_pairing_ok`; otherwise map to a structural `e-div-block` and record a fallback.
   Ensure the produced child structure has matching tab/content counts.
4. **Forms.** Map `form`/`form-field` to `e-form`/`e-form-*` ONLY when `capabilities.atomic` AND
   `capabilities.pro_atomic_form` (`e_pro_atomic_form` experiment, authoring-contract §4). Otherwise
   fall back to the Pro `form` classic widget (if Pro) or a structural approximation, with a
   `NodeFallback` + `warnings` note (the agent may need `e_pro_atomic_form` enabled). Carry the field
   spec forward as `settings_seed` so the Pro-surface form builder (WP-R##) shape is reachable, but do
   NOT implement Pro form-action expansion here (that is the Pro layer).
5. **Nav.** Map `nav-menu` to the Pro nav-menu bound-widget path ONLY when `capabilities.pro`; else map
   to an `e-div-block` + `e-button` list (authoring-contract §4 note). The actual menu-term binding is
   a persist-time concern (WP-H08/WP-H11 orchestrator may call `nav.bind_widget`); MAP only chooses the
   element type.
6. **settings_seed.** Populate role-driven RAW settings via `seedSettingsForRole` per authoring-contract
   §4.1: heading `tag` (h1-h6, clamp to enum), paragraph `tag` (p/span), button `text`+`link`, div-block
   `tag` (clamped enum), youtube `source`, etc. For `e-image` emit a placeholder src marker
   (`{__media_pending: <MediaRef>}`) so ASSEMBLE knows to sideload and fill the id-only `image-src`
   (authoring-contract §3.2). NEVER emit a final typed envelope here.
7. Pure transform: deterministic given (ir, ctx); no I/O, no Playwright, no WP client.
8. Do NOT extract or attach styles — styles flow separately through WP-H07. Do NOT mint ids (WP-H08).

## Implementation Notes

- `settings_seed` keys are the AUTHORABLE prop NAMES from authoring-contract §4.1 (e.g. `tag`, `title`,
  `text`, `link`, `image`, `source`) with RAW values; WP-H08 wraps them with `envelopes.ts` (WP-F03).
  Get the prop names right (a wrong name is dropped by PHP dry_run) — reconcile against
  authoring-contract §4.1 and, at runtime, the orchestrator may fetch `schema.widget` to confirm.
- The atomic type vocabulary is CLOSED (authoring-contract §4) — never emit a target outside it. There
  is no atomic accordion/list/table widget; those map to structural approximations or V3.
- Keep the whole-node fallback ladder (this WP) distinct from the per-declaration ladder (WP-H07). The
  report merges them; do not conflate the two `tier` enums.
- For `link`, the source `<a>` href + target become the `link` prop seed
  (`{destination:url, isTargetBlank, tag:'a'}`, authoring-contract §3.1 `link`); WP-H08 wraps it.

## Acceptance Criteria

- [ ] `mapIr` with `generation:'v4'` + atomic-active produces atomic targets; with atomic INACTIVE
      maps the whole tree to V3 classic.
- [ ] A list role maps to a structural `e-div-block`+paragraphs (v4) or `icon-list` (v3), recorded as a
      `NodeFallback` (not `native`).
- [ ] A table role maps to structural grid or html-widget last resort with a recorded tier.
- [ ] Paired tabs map to the full `e-tabs` family with matching tab/content counts; unpaired tabs fall
      back to a structural block.
- [ ] `form` maps to `e-form` only when `pro_atomic_form` is enabled; otherwise a recorded fallback.
- [ ] `nav-menu` maps to the Pro bound widget only when `pro`; else an `e-div-block`+`e-button` list.
- [ ] `seedSettingsForRole` sets heading `tag` from the source level, button `text`+`link`, div-block
      `tag` (clamped enum), and emits a media-pending marker for images.
- [ ] No target is outside the authoring-contract §4 atomic list (test scans every `MappedNode.target`).
- [ ] Module is pure (no I/O imports).

## Tests Required

- Unit (`map.test.ts`): v4-vs-v3 generation fallback; `NO_ATOMIC_EQUIVALENT` handling (list/table);
  tabs paired/unpaired; form with/without `e_pro_atomic_form`; nav with/without Pro; `settings_seed`
  per role; closed-vocabulary scan. Use `MapStageContext` fixtures with varied capability shapes.
- Contract: assert every produced `target` is in the authoring-contract §4 atomic list (shared with
  WP-H01's scan) and every `settings_seed` key is an authorable prop name from §4.1.

## Parallelization Notes

- Parallel-safe with all sibling HTML WPs: owns only `map.ts` + test.
- Type dependency on WP-H01 (mapping table + the frozen `MapStageContext`/`MapResult`/`MappedNode`/
  `NodeFallback`/`ClassifyResult` types, Contract 15 §4.6.1) — buildable + unit-testable as soon as
  WP-H01 lands, against the frozen classified-IR input; needs WP-H05 runtime only for corpus tests.
  Feeds WP-H07 (STYLE-EXTRACT) and WP-H08 (ASSEMBLE) via the frozen `MappedNode[]`. (The DAG sequences
  it after WP-H05 to keep the corpus chain linear.)
