---
id: WP-H01
title: HTML-to-native role and prop mapping-table reference module
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-F04
files_owned:
  - packages/server/src/convert/mapping-table.ts
  - packages/server/src/convert/mapping-table.test.ts
  - packages/server/src/convert/types.ts
contract_refs:
  - spec/contracts/11-authoring-contract.md#4-atomic-element-types-verified
  - spec/contracts/11-authoring-contract.md#41-per-widget-authorable-settings-props-from-supplement-b2
  - spec/contracts/13-tool-catalog.md#19-html-native-conversion-flagship
  - spec/contracts/15-engineering-standards.md#461-pipeline-ir-contract-frozen--the-inter-stage-seam-owned-by-wp-h01-packagesserversrcconverttypests
  - spec/contracts/schemas/element-node.schema.json
estimate: M
---

## Summary

The single source of truth for "HTML role -> Elementor element type" used by every downstream
conversion stage. It encodes RESEARCH.md §6.2's mapping table (plus the SUPPLEMENT §C.4
`<details>/<summary>` -> accordion addition) as pure, side-effect-free data + lookup helpers, and
defines the **complete frozen pipeline IR (intermediate-representation) contract** — EVERY inter-stage
type and per-stage Result envelope (per Contract 15 §4.6.1) that every other `convert/*` stage consumes
and produces. This WP owns NO Elementor I/O, NO Playwright, NO persistence — it is a frozen reference
table and the IR type contract so the parse/normalize/classify/map/style/assemble/hoist stages
(WP-H03..H10) can be built and unit-tested INDEPENDENTLY against the frozen types in `types.ts` as soon
as this WP lands. WP-H01 owns the TYPE DECLARATIONS for these stages; each stage WP owns the FUNCTION
that implements its type (see Contract 15 §4.6.1).

## Interface / Contract

Exports from `packages/server/src/convert/types.ts` (the pipeline IR, consumed by ALL convert WPs):

- `SemanticRole` — string-literal union of the classifier's vocabulary (RESEARCH.md §6.1 step 3):
  `'structural-block' | 'flex-row' | 'flex-col' | 'grid' | 'heading' | 'text' | 'image' |
  'button' | 'link' | 'divider' | 'icon-svg' | 'media-embed-youtube' | 'media-embed-video' |
  'tabs' | 'tab' | 'tab-content' | 'form' | 'form-field' | 'nav-menu' | 'list' | 'list-item' |
  'table' | 'accordion' | 'accordion-item' | 'unknown'`.
- `IrNode` — the framework-agnostic node the AI/deterministic classifier emits (SUPPLEMENT §C.4):
  `{ source_path: string; tag: string; role: SemanticRole; box: BoxRect; computed: ComputedStyleSet;
  hoverComputed?: Partial<ComputedStyleSet>; focusComputed?: Partial<ComputedStyleSet>;
  responsive: Record<BreakpointKey, Partial<ComputedStyleSet>>; attrs: Record<string,string>;
  textRuns: TextRun[]; media?: MediaRef; children: IrNode[]; }`. `BreakpointKey` is imported from
  `packages/shared` (WP-F03 frozen type).
- `BoxRect` = `{ x:number; y:number; width:number; height:number }` (getBoundingClientRect subset).
- `ComputedStyleSet` = `Record<string,string>` — the whitelisted getComputedStyle pick (the WHITELIST
  is owned here as `STYLE_WHITELIST`, see Detailed Requirements 4).
- `TextRun` = `{ text:string; inlineTags:string[] }` (inline markup spans extracted from a text node).
- `MediaRef` = `{ kind:'img'|'background'|'video'|'svg'|'youtube'; url?:string; srcset?:string;
  alt?:string; embedId?:string }`.
- `MappingResult` = `{ generation:'v4'; elType:string; widgetType?:string; tag?:string;
  is_container:boolean; settings_seed:Record<string,unknown>; v3_fallback:{ elType:string;
  widgetType?:string } }`.

**Inter-stage IR + per-stage Result envelopes (FROZEN here per Contract 15 §4.6.1; declarations only — the
implementing FUNCTION is owned by the named stage WP).** These were previously declared locally in each
producing stage; they are now hoisted into `types.ts` so each stage WP imports them and compiles/tests
against a frozen contract:

- PARSE (impl WP-H03): `ParseInput = { html:string; css?:string; breakpoints: BreakpointSpec[];
  base_url?:string; fidelity:'high'|'balanced'|'fast'; capture_states?:boolean }`;
  `BreakpointSpec = { key: BreakpointKey; width:number; direction:'min'|'max' }`;
  `ParseWarning = { source_path?:string; code:string; message:string }`;
  `ParseResult = { ir: IrNode[]; doc_direction:'ltr'|'rtl'; viewport_used:number;
  warnings: ParseWarning[]; raw_inner_markup: Record<string,string> }`.
- NORMALIZE (impl WP-H04): `NormalizeContext = { base_url?:string;
  raw_inner_markup: Record<string,string>; unwrap_redundant:boolean }`;
  `StrippedRecord = { source_path:string; stripped_tags:string[] }`;
  `PromotionRecord = { from_source_path:string; promoted_to:string[]; reason:string }`;
  `NormalizeResult = { ir: IrNode[]; stripped: StrippedRecord[]; promotions: PromotionRecord[];
  warnings:string[] }`.
- CLASSIFY (impl WP-H05): `AiRoleHint = { source_path:string; role?: SemanticRole;
  suggested_name?:string; confidence?:number }`;
  `ClassifyOptions = { ai_hints?: AiRoleHint[]; infer_flex:boolean }`;
  `RoleOverride = { source_path:string; from: SemanticRole; to: SemanticRole;
  source:'ai'|'deterministic'; accepted:boolean }`;
  `ClassifyResult = { ir: IrNode[]; role_overrides: RoleOverride[]; warnings:string[] }`;
  `FlexIntent = { direction:'row'|'column'; wrap:boolean; justify?:string; align?:string;
  gap?:string; fill_children:string[]; absolute_children:string[] }`.
- MAP (impl WP-H06): `MapStageContext = { generation:'v4'|'v3'; capabilities: SiteCapabilities;
  tab_pairing: Record<string,boolean> }` (`SiteCapabilities` imported from `packages/shared`, WP-F05);
  `MappedNode = IrNode & { target: MappingResult; settings_seed: Record<string,unknown>;
  children: MappedNode[] }`;
  `NodeFallback = { source_path:string; tier:'native'|'v3_classic'|'structural_block'|'html_widget';
  reason:string }`;
  `MapResult = { nodes: MappedNode[]; fallbacks: NodeFallback[]; warnings:string[] }`.
- STYLE-EXTRACT (impl WP-H07): `StyleContext = { style_schema: StyleSchema; breakpoints: BreakpointSpec[];
  doc_direction:'ltr'|'rtl'; target_rtl:boolean; pro_active:boolean }` (`StyleSchema` =
  `Record<string,{ $$type:string; enum?:string[]; units?:string[] }>`, the live `schema.styles` map);
  `StyledNode = MappedNode & { local_styles: StyleDefinition[]; decl_index: DeclIndex }` where
  `StyleDefinition`/`StyleVariant` are the style-variant.schema.json shapes (imported from
  `packages/shared`, WP-F03) and `DeclIndex = Record<string /*state|bp key*/, Array<{prop:string;
  value:string}>>`;
  `DeclFallback = { source_path:string; declaration:string;
  tier:'native'|'local_style'|'global_class'|'custom_css'|'html_widget'; reason:string }`;
  `LiteralRef = { kind:'color'|'font'|'size'; value:string; occurrences:string[] }`;
  `StyleExtractResult = { styled_nodes: StyledNode[]; declaration_fallbacks: DeclFallback[];
  proposed_variable_literals: LiteralRef[] }`;
  `DeclVerdict = { kind:'native'|'variable-candidate'|'global-class-candidate'|'unmappable';
  atomic_prop?:string; typed_value?:unknown; fallback_tier?: DeclFallback['tier']; reason:string }`.
- ASSEMBLE (impl WP-H08): `MediaPort = { sideloadUrl(url:string, alt?:string): Promise<{id:number;
  url:string}>; upload(bytes:Uint8Array, filename:string): Promise<{id:number; url:string}> }`;
  `IdPort = { mint(existing: Set<string>): string; validate(ids:string[]): Promise<string[]> }`;
  `AssembleContext = { generation:'v4'|'v3'; existing_ids: Set<string>; sideload_media:boolean;
  media: MediaPort; ids: IdPort }`;
  `SideloadError = { source_path:string; url:string; reason:string }`;
  `AssembleResult = { elements: ElementNode[]; media_map: Record<string,number>;
  sideload_errors: SideloadError[]; minted_ids:string[]; local_style_ids:string[] }`
  (`ElementNode` imported from `packages/shared`, WP-F03 — the IR never redefines it).
- HOIST/VARIABLE-EXTRACT (impl WP-H09): `BudgetReport = { current_count:number; would_add:number;
  would_delete:number; projected:number; max_allowed:number; exceeded:boolean }`;
  `HoistContext = { existing_classes: GlobalClassObject[]; existing_order:string[]; min_uses:number;
  name_hints: Record<string,string>; budget_max:number }`;
  `HoistResult = { elements: ElementNode[]; proposed_classes: GlobalClassObject[];
  class_rebinds: Record<string,string[]>; budget: BudgetReport; warnings:string[] }`
  (`GlobalClassObject` is StyleDefinition-shaped, imported from `packages/shared`/WP-F03 shared types);
  `VarContext = { existing_variables: VariableDef[]; min_uses:number; budget_max:number }`;
  `ProposedVariable = { type:'global-color-variable'|'global-font-variable'|'global-size-variable';
  label:string; value:string }`;
  `VarResult = { elements: ElementNode[]; proposed_variables: ProposedVariable[];
  var_rebinds: Record<string,string[]>; budget: BudgetReport; warnings:string[] }`.
- A11Y/FIDELITY/COVERAGE (impl WP-H10): these mirror `diff.schema.json` `$defs` — the JSON schema is the
  CANONICAL field-name source; the TS types here are its mirror (H10/H11 assemble them).
  `A11yFinding = { element_id:string; rule:string; severity:'warning'|'blocker'; message:string }`;
  `FidelityResult = { score:number; deltas: Array<{breakpoint:string; diff_ratio:number;
  region:string|null}> }`;
  `CoverageReport = { coverage:{pct_native:number; pct_local_or_global_class:number;
  pct_custom_css:number; pct_dropped:number}; fallbacks: Array<{element_id:string;
  tier: DeclFallback['tier']; reason:string}>; a11y: A11yFinding[];
  stripped_text: Array<{element_id:string; stripped_tags:string[]}>; visual_diff_score?:number }`.
  (`element_id` here is the minted Elementor id from ASSEMBLE, distinct from the pre-assembly
  `source_path` used in the upstream IR records; H10 maps `source_path` -> `element_id` when folding.)

`BreakpointKey`, `Generation`, `ElementNode`, `StyleDefinition`, `StyleVariant`, `GlobalClassObject`,
`VariableDef`, `SiteCapabilities` are imported from `packages/shared` (WP-F03/WP-F05 frozen types) and
NEVER redefined here. The IR types above are PRE-envelope; envelope wrapping is WP-H08 via WP-F03's
`envelopes.ts`.

Exports from `packages/server/src/convert/mapping-table.ts`:

- `MAPPING_TABLE: ReadonlyArray<MappingRule>` — the ordered rule list (RESEARCH.md §6.2).
- `mapRole(role: SemanticRole, ctx: MapContext): MappingResult` — resolve a role + context to a target.
- `containerTagFor(role: SemanticRole, sourceTag: string): string` — pick the `e-div-block`/`e-flexbox`
  `tag` enum value (one of `div|header|section|article|aside|footer|a|button`,
  `div-block.php:52`, authoring-contract §4.1).
- `NO_ATOMIC_EQUIVALENT: ReadonlySet<SemanticRole>` — roles with no V4 atomic widget (`list`, `table`)
  whose mapping falls to a structural-block approximation or V3 fallback (authoring-contract §9
  whole-node ladder).
- `STYLE_WHITELIST: ReadonlyArray<string>` — the Style-Schema-reachable computed-prop names (see req 4).

`MapContext` = `{ pro_active:boolean; atomic_active:boolean; child_count:number;
  has_youtube:boolean; tab_pairing_ok:boolean }`. Where the target requires Pro/experiments that the
context lacks, `mapRole` returns the V3 fallback or a structural-block approximation (never throws).

## Dependencies & Inputs

- **WP-F03** — frozen authoring TS types (`BreakpointKey`, `Generation`, `ElementNode`) and JSON
  schemas under `spec/contracts/schemas/`. This WP imports `BreakpointKey`/`Generation` from
  `packages/shared` and never redefines them.
- **WP-F04** — frozen MCP catalog; this WP's IR/mapping output must be expressible as
  `ElementNode` (element-node.schema.json) downstream.
- Elementor source (read-only, for grounding the table):
  - Atomic element type list — `modules/atomic-widgets/elements/` (authoring-contract §4).
  - `e-div-block` tag enum — `modules/atomic-widgets/elements/div-block/div-block.php:52`.
  - `e-flexbox` tag enum — `modules/atomic-widgets/elements/flexbox/flexbox.php:54`.
  - Per-widget authorable props — authoring-contract §4.1 (SUPPLEMENT §B.2).
- Contract sections: 11-authoring-contract §4, §4.1, §9; 13-tool-catalog §1.9; RESEARCH.md §6.2,
  SUPPLEMENT §C.2/§C.4.

## Detailed Requirements

1. Encode the full RESEARCH.md §6.2 mapping table as `MAPPING_TABLE` rules. Each `MappingRule` =
   `{ role: SemanticRole; v4:{elType,widgetType?,is_container,tagFrom?:'source'|'fixed',
   fixedTag?:string}; v3:{elType,widgetType?}; requires?:{pro?:boolean, experiment?:string};
   notes:string }`. Cover EVERY row of §6.2:
   - `div/section/header/footer/article/aside` -> `e-div-block` (tag from source) / V3 `container`.
   - flex row/col wrapper -> `e-flexbox` (or `e-div-block`+grid) / V3 `container`.
   - `h1`-`h6` -> `e-heading` / V3 `heading`.
   - `p`, inline text block -> `e-paragraph` / V3 `text-editor`.
   - `img` -> `e-image` / V3 `image`.
   - `a.button` / `button` -> `e-button` / V3 `button`.
   - `hr` -> `e-divider` / V3 `divider`.
   - `svg` / icon font -> `e-svg` / V3 `icon`.
   - YouTube iframe -> `e-youtube` / V3 `video`.
   - `video` self-hosted -> `e-self-hosted-video` / V3 `video`.
   - tab UI -> `e-tabs` > (`e-tabs-menu`>`e-tab`*) + (`e-tabs-content-area`>`e-tab-content`*) /
     V3 `tabs`/`nested-tabs` (note: tab & content counts MUST match).
   - `nav`/menu -> Pro nav-menu widget bound to a WP menu term, OR `e-div-block`+`e-button` list /
     Pro `nav-menu` (`requires.pro:true` for the bound-widget path).
   - `form`+fields -> `e-form`+`e-form-*` (`requires.experiment:'e_pro_atomic_form'`) / Pro `form`.
   - `ul`/`ol` list -> `e-div-block`+`e-paragraph` items / V3 `icon-list` (mark `NO_ATOMIC_EQUIVALENT`).
   - `table` -> `e-div-block` grid approximation / html widget last resort (mark `NO_ATOMIC_EQUIVALENT`).
2. Add the SUPPLEMENT §C.4 row: `<details>/<summary>` -> accordion. Because Elementor 4.1.x has NO
   atomic accordion widget, map role `accordion` to a styled-`e-div-block` approximation (clickable
   `e-div-block` header + `e-div-block` content) in V4, and V3 `accordion`/`nested-accordion` in
   fallback. Record this as a documented limitation (note string) so STYLE-EXTRACT/ASSEMBLE know it is
   a structural approximation, not a 1:1 widget.
3. `mapRole` MUST be context-aware and never throw:
   - If `atomic_active:false`, return the V3 fallback for every role.
   - If a rule has `requires.pro:true` but `ctx.pro_active:false`, return the documented
     fallback (e.g. nav-menu -> `e-div-block`+`e-button` list, not the Pro nav-menu widget).
   - If a rule has `requires.experiment` not satisfied, return the structural/V3 fallback.
   - tabs: only map to `e-tabs` when `ctx.tab_pairing_ok:true` (menu count == content count); else
     fall back to a structural `e-div-block`. (authoring-contract §4 note: "tab & content counts MUST
     match".)
4. Own `STYLE_WHITELIST` — the exact getComputedStyle property names the PARSE stage captures and that
   can reach `Style_Schema` (SUPPLEMENT §C.3 WHITELIST, authoring-contract §5.2). Include at minimum:
   `display, flex-direction, flex-wrap, flex-grow, flex-shrink, flex-basis, gap, row-gap, column-gap,
   justify-content, align-items, align-self, align-content, justify-items, order,
   grid-template-columns, grid-template-rows, grid-auto-flow, grid-column, grid-row,
   width, height, min-width, max-width, min-height, max-height, aspect-ratio, object-fit,
   object-position, overflow, position, top, right, bottom, left, z-index,
   margin-top, margin-right, margin-bottom, margin-left,
   padding-top, padding-right, padding-bottom, padding-left,
   font-family, font-size, font-weight, font-style, line-height, letter-spacing, word-spacing,
   color, text-align, text-decoration, text-transform, direction,
   background-color, background-image, background-size, background-position, background-repeat,
   background-attachment, background-clip,
   border-top-width, border-right-width, border-bottom-width, border-left-width,
   border-top-style, border-color, border-top-left-radius, border-top-right-radius,
   border-bottom-right-radius, border-bottom-left-radius,
   box-shadow, opacity, mix-blend-mode, filter, backdrop-filter, transform, transition,
   outline-width, outline-style, outline-color, cursor`.
   The whitelist is the contract surface PARSE (WP-H03) reads — keep it stable; additions require a
   versioned note. (Direction-awareness of physical<->logical mapping is owned by WP-H02, not here.)
5. Pure module: no `import` of Playwright, `fs`, the WP client, or any tool runtime. Deterministic
   given inputs. This guarantees the table is testable in isolation and reusable by both
   `convert.html_to_tree` (TS-only) and the corpus harness.
6. Provide `containerTagFor` so MAP picks a semantic HTML tag for containers (header/section/footer/
   article/aside/nav-as-div) from the source tag, clamped to the `e-div-block`/`e-flexbox` enum
   `div|header|section|article|aside|footer|a|button` (div-block.php:52); unknown -> `div`.
7. **Own the COMPLETE pipeline-IR contract** in `types.ts` — declare EVERY inter-stage IR type and
   per-stage Result envelope listed in the Interface section above and frozen in Contract 15 §4.6.1
   (`ParseResult`/`NormalizeResult`/`ClassifyResult`/`MapResult`/`StyledNode`/`StyleExtractResult`/
   `AssembleResult`/`HoistResult`/`VarResult`/`CoverageReport`, plus their context/record/port types).
   These are pure `type`/`interface` declarations — NO runtime logic for stages this WP does not own.
   The implementing FUNCTION for each (e.g. `parseHtml`, `normalizeIr`) is owned by the respective stage
   WP (H03..H10), which `import type`s from here. This single-file seam is what makes the HTML stages
   independently buildable. Re-import shared types from `packages/shared` (WP-F03/F05); never redeclare
   `ElementNode`/`StyleDefinition`/`BreakpointKey`/`SiteCapabilities`/`VariableDef`/`GlobalClassObject`.

## Implementation Notes

- Keep `MAPPING_TABLE` as plain data (an array of `MappingRule` literals) so it reads like the §6.2
  table; resolution logic lives only in `mapRole`/`containerTagFor`.
- The IR types in `types.ts` are the parallelization seam: every other `convert/*` WP imports from
  here, so freeze the field names early. Do NOT put Elementor envelope shapes here — those are
  WP-F03's `ElementNode`; the IR is pre-envelope.
- `role: 'unknown'` MUST resolve (via `mapRole`) to a generic `e-div-block` (structural-block) so the
  pipeline degrades rather than throwing — aligns with authoring-contract §9 whole-node ladder.
- Atomic types verified present in 4.1.x (authoring-contract §4): containers `e-div-block, e-flexbox,
  e-tabs, e-tabs-menu, e-tab, e-tabs-content-area, e-tab-content`; widgets `e-heading, e-paragraph,
  e-image, e-button, e-svg, e-youtube, e-divider, e-self-hosted-video`. Do NOT invent atomic types
  not in this list (e.g. there is NO `e-accordion`, NO `e-list`, NO `e-table`, NO `e-icon-list`).
- `settings_seed` carries only the role-driven, non-style settings (e.g. `e-heading.tag` from the
  source `h*` level; `e-div-block.tag` from source) as RAW values — NOT typed envelopes. Envelope
  wrapping happens in ASSEMBLE (WP-H08) via WP-F03's `envelopes.ts`. Keep this WP envelope-free.

## Acceptance Criteria

- [ ] `MAPPING_TABLE` contains a rule for every row in RESEARCH.md §6.2 plus the
      `<details>/<summary>`->accordion row (SUPPLEMENT §C.4); a test asserts the rule count and that
      each `SemanticRole` (except `unknown`-internal) has at least one rule.
- [ ] `mapRole('heading', ctx)` returns `{elType:'widget', widgetType:'e-heading'}` when
      `atomic_active:true`, and `{elType:'widget', widgetType:'heading'}` when `atomic_active:false`.
- [ ] `mapRole('nav-menu', {pro_active:false,...})` returns the `e-div-block`+`e-button` list
      fallback, NOT the Pro nav-menu widget.
- [ ] `mapRole('form', {experiment e_pro_atomic_form unsatisfied})` returns the V3 `form` (or
      structural) fallback, never an `e-form` tree.
- [ ] `mapRole('tabs', {tab_pairing_ok:false})` returns a structural `e-div-block`, not `e-tabs`.
- [ ] `containerTagFor` clamps any source tag to the `div-block.php:52` enum; unknown -> `div`.
- [ ] No target references an atomic type outside the authoring-contract §4 list (test scans every
      rule's `v4.widgetType`/`v4.elType` against the frozen list).
- [ ] Module has zero runtime imports of Playwright/fs/WP client (test or lint asserts purity).
- [ ] `STYLE_WHITELIST` includes every property in Detailed Requirement 4 (snapshot test).
- [ ] `types.ts` declares EVERY inter-stage IR type / Result envelope in the Interface section (the
      Contract 15 §4.6.1 table): a type-level test (`tsd`/`expectTypeOf` or a compile-only fixture)
      asserts `ParseResult`, `NormalizeResult`, `ClassifyResult`, `MapResult`, `StyledNode`,
      `StyleExtractResult`, `AssembleResult`, `HoistResult`, `VarResult`, `CoverageReport` and their
      member types are exported and shaped as specified, and that NONE of `ElementNode`/`StyleDefinition`/
      `BreakpointKey`/`SiteCapabilities` is locally redeclared (they import from `packages/shared`).

## Tests Required

- Unit (`mapping-table.test.ts`): rule-count + role-coverage assertions; `mapRole` matrix across
  `atomic_active`/`pro_active`/experiment/tab-pairing contexts; `containerTagFor` enum clamping;
  `NO_ATOMIC_EQUIVALENT` membership; purity assertion; `STYLE_WHITELIST` snapshot.
- Contract: a test asserting every `MappingResult.v4` type is in the authoring-contract §4 list and
  every `v3` widgetType is a known classic type (heading/text-editor/image/button/divider/icon/video/
  tabs/nested-tabs/form/icon-list/container/nav-menu/accordion). No fixtures needed (pure data).

## Parallelization Notes

- Parallel-safe with ALL other WPs: owns only `mapping-table.ts`, `mapping-table.test.ts`, `types.ts`.
- MUST land before (code-dependency for) every other HTML stage WP — WP-H03 (PARSE), WP-H04 (NORMALIZE),
  WP-H05 (CLASSIFY), WP-H06 (MAP), WP-H07 (STYLE-EXTRACT), WP-H08 (ASSEMBLE), WP-H09 (HOIST), WP-H10
  (A11Y/FIDELITY/COVERAGE), WP-H11 (orchestrator) — because it now owns the COMPLETE frozen IR contract
  (`types.ts`) they all import. Once H01 lands, those stage WPs become independently buildable and
  unit-testable against the frozen types (they need an upstream stage's RUNTIME only for end-to-end
  corpus tests, owned by WP-H10/Q04 — not to compile or unit-test). It is the IR/type seam, the first
  HTML WP to build. No file overlap with any sibling.
