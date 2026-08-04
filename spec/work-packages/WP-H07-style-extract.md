---
id: WP-H07
title: STYLE-EXTRACT stage - Style-Schema-valid style variants + fallback ladder
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-F05
  - WP-P02
  - WP-P03
  - WP-P05
  - WP-H01
  - WP-H02
  - WP-H06
  - WP-S01
files_owned:
  - packages/server/src/convert/style-extract.ts
  - packages/server/src/convert/style-extract.test.ts
  - packages/server/src/convert/declaration-classifier.ts
  - packages/server/src/convert/declaration-classifier.test.ts
contract_refs:
  - spec/contracts/11-authoring-contract.md#52-style-schema-native-props--the-no-native-expression-list-supplement-b3
  - spec/contracts/11-authoring-contract.md#9-fallback-ladder-per-unmapped-declaration--node
  - spec/contracts/schemas/style-variant.schema.json
  - spec/contracts/schemas/atomic-prop-types.schema.json
  - spec/contracts/12-error-taxonomy.md#31-validation--authoring
estimate: L
---

## Summary

The fifth conversion stage: translate each mapped node's computed declaration set into atomic style
VARIANTS (`StyleVariant`/`StyleDefinition`, WP-F03) using ONLY `Style_Schema`-valid prop keys, with
direction-aware physical->logical conversion (WP-H02), per-breakpoint and per-state variants, and a
per-declaration fallback ladder (authoring-contract §9) for anything outside the schema. It classifies
every declaration as native / variable-candidate / global-class-candidate / unmappable and records the
fallback tier. It builds the per-element local-style objects (linked into `settings.classes`,
authoring-contract §5.1) but does NOT yet hoist shared declaration-sets into global classes (WP-H09) or
extract variables (WP-H09) or persist. It is atomic-CSS-affecting, so it depends on the prime-css WP
+ WP-S01 and the PHP dry_run validator (the produced styles MUST round-trip through PHP).

## Interface / Contract

`StyleContext`, `StyleExtractResult`, `StyledNode`, `DeclFallback`, `LiteralRef`, `DeclVerdict`, and the
consumed `MappedNode` are FROZEN and OWNED by WP-H01 (`convert/types.ts`, Contract 15 §4.6.1); this WP
IMPLEMENTS the functions and `import type`s them — it does NOT declare them locally. For reference (the
frozen shapes):

Exports from `packages/server/src/convert/style-extract.ts`:

- `extractStyles(nodes: MappedNode[], ctx: StyleContext): StyleExtractResult` where:
  - `StyleContext = { style_schema: StyleSchema; breakpoints: BreakpointSpec[]; doc_direction:
    'ltr'|'rtl'; target_rtl: boolean; pro_active: boolean }`. `style_schema` is the live
    `schema.styles` map (13-tool-catalog §1.1 / resource `elementor://schema/styles`): a flat
    `css-prop-name -> { $$type, enum?, units? }` table the orchestrator fetched. This stage is
    STYLE-SCHEMA-DRIVEN at runtime (authoring-contract §5.2: "probe the live flat map"), never a
    hardcoded prop list.
  - `StyleExtractResult = { styled_nodes: StyledNode[]; declaration_fallbacks: DeclFallback[];
    proposed_variable_literals: LiteralRef[] }`.
  - `StyledNode` extends `MappedNode` with `local_styles: StyleDefinition[]` (each a
    `{id, type:'class', label:'local', variants: StyleVariant[]}` per style-variant.schema.json) and
    the local-style ids to be mirrored into `settings.classes` (authoring-contract §5.1). It also
    carries `decl_index` (the raw declarations grouped by state/breakpoint) so HOIST (WP-H09) can
    fingerprint and dedupe across nodes.
  - `DeclFallback = { source_path: string; declaration: string; tier:
    'native'|'local_style'|'global_class'|'custom_css'|'html_widget'; reason: string }` — the exact
    `CoverageReport.fallbacks[]` item shape (diff.schema.json).
  - `LiteralRef = { kind:'color'|'font'|'size'; value: string; occurrences: string[] }` — literals seen
    (colors/font-stacks/recurring sizes) flagged for WP-H09 variable extraction (authoring-contract
    §6.3 "Variable extraction"). This stage only FLAGS; WP-H09 decides which become variables.

Exports from `packages/server/src/convert/declaration-classifier.ts`:

- `classifyDeclaration(prop: string, value: string, schema: StyleSchema): DeclVerdict` where
  `DeclVerdict = { kind:'native'|'variable-candidate'|'global-class-candidate'|'unmappable';
  atomic_prop?: string; typed_value?: RawTypedValue; fallback_tier?: DeclFallback['tier'];
  reason: string }`. The single decision point for "does this CSS declaration have a native atomic
  expression?" against the LIVE schema.

## Dependencies & Inputs

- **WP-P03 (PHP dry_run validator)** — REQUIRED per the universal write rule: produced styles MUST be
  validated by the authoritative PHP `dry_run` (`class-validator.php`) before commit. This stage emits
  styles; the orchestrator (WP-H11) round-trips them. The TS prefilter (`authoring/prefilter.ts`,
  WP-F03) is a pre-filter only (authoring-contract §8 R5/R8).
- **prime-css WP (WP-P05 `includes/core/class-css-primer.php`) + WP-S01** — REQUIRED per the universal
  atomic-CSS rule (15-engineering-standards §6, authoring-contract §10): any WP that authors atomic
  styles depends on the prime-css WP (WP-P05, which owns `Css_Primer`) + WP-S01. The styles this stage
  emits do not render until primed; the orchestrator (WP-H11) primes after save via the WP-P05 service.
- **WP-H02 (logical-props)** — direction-aware physical->logical conversion for dimensions/radius/
  border-width/inset and the `text-align` keyword.
- **WP-H06 (MAP)** — consumes `MappedNode[]`.
- **WP-H01** — IR types, `STYLE_WHITELIST`.
- **WP-F03** — `StyleDefinition`, `StyleVariant`, `StyleMeta`, `Size`, `Dimensions`, `TypedValue`,
  `BreakpointKey`, `StyleState`, plus `envelopes.ts` for wrapping (used here to build typed values).
- **WP-F05** — error codes (`STYLE_INVALID`/`ATOMIC_STYLES_INVALID` are PHP-side; this stage records
  fallbacks rather than failing, but flags `LOCAL_STYLE_UNLINKED` risk if a local-style id is not
  mirrored — enforced in WP-H08).
- Contract sections: 11-authoring-contract §5 (styles vs settings), §5.1 (local-style mirroring HARD
  rule), §5.2 (Style-Schema native props + the no-native-expression list + valid states), §9 (fallback
  ladder); style-variant.schema.json (`StyleDefinition`/`StyleVariant`/`StyleMeta` shape);
  atomic-prop-types.schema.json (typed value shapes: `size`, `dimensions`, `color`, `background`,
  `box-shadow`, `transform`, `transition`, `filter`, `border-radius`, `border-width`). RESEARCH.md §6.3,
  §6.4, §6.6, SUPPLEMENT §B.3.

## Detailed Requirements

1. **Schema-driven native check.** For every captured declaration on a node (from `IrNode.computed`,
   `hoverComputed`, `focusComputed`, and per-breakpoint deltas), call `classifyDeclaration` against the
   LIVE `style_schema`. A declaration is `native` only if its CSS prop is a key in `style_schema` AND
   its value satisfies that prop's `$$type`/enum/units. Anything else routes down the fallback ladder.
2. **Enum snapping / rejection (authoring-contract §5.2).** For enum props, if the source value is a
   member, keep it; if it is a near-miss (e.g. `font-weight:350` -> nearest 100-step; `display:table` ->
   no native value), either snap to the nearest valid enum (recording a `DeclFallback` reason "snapped")
   or route to fallback. NEVER emit a non-enum value (PHP `Style_Parser` drops it -> silent loss).
   Known cases to handle explicitly: `font-weight` numeric != 100-steps; `display` table/list-item;
   `justify-content`/`align-items`/`justify-items`/`align-self`/`align-content` `inherit`/`safe center`;
   `text-transform`; `mix-blend-mode`; `border-style`; `cursor` (only `pointer`).
3. **Typed-object decomposition (authoring-contract §5.2 "typed-object props").** `transform`,
   `transition`, `filter`/`backdrop-filter`, `box-shadow`, `background` (gradients/multi-layer),
   `border-radius`/`border-width` per-corner MUST be decomposed into the EXACT nested envelope shape
   (atomic-prop-types.schema.json). A raw shorthand string is rejected by PHP. When decomposition is
   feasible (simple box-shadow, single transform), emit the nested typed value; when not (complex
   multi-stop gradient, multi-function transform), route to the fallback ladder (custom_css if Pro,
   else drop with a recorded reason).
4. **Direction-aware logical conversion (WP-H02).** For `padding`/`margin` -> atomic `dimensions`,
   `border-radius`/`border-width` -> logical corners/edges, `top/right/bottom/left` -> inset props, and
   `text-align` keyword -> `start|end`, call WP-H02 with the resolved direction (use `doc_direction`
   vs `target_rtl` to preserve VISUAL intent, RESEARCH.md §6.3). Respect `canCollapseToLogical`: when
   false, keep physical via single-axis dimensions or route to fallback.
5. **Variants by state + breakpoint (authoring-contract §5.2).** Build one `StyleVariant` per
   (breakpoint, state) pair that has declarations: base = `{breakpoint:<key>, state:null}`; hover from
   `hoverComputed` -> `state:'hover'`; focus -> `state:'focus'`/`'focus-visible'`; per-breakpoint deltas
   -> `{breakpoint:<bpKey>, state:null}`. Valid states are EXACTLY
   `null|hover|active|focus|focus-visible|checked|e--selected` (style-states.php:6-12); never put state
   on a prop. Resolve breakpoint keys from `ctx.breakpoints` (never hardcoded, RESEARCH.md §6.7).
6. **Local-style objects.** For each node's surviving native declarations, build a `StyleDefinition`
   with a unique local-style id (convention `e-<elementId>-<7hex>` — the element id is assigned in
   WP-H08, so emit a PLACEHOLDER id token that WP-H08 finalizes, OR accept the element id via
   `MappedNode` if WP-H08 mints earlier; document the chosen ordering). The id MUST be mirrored into
   `settings.classes` — record the requirement so WP-H08 enforces it (authoring-contract §5.1;
   `LOCAL_STYLE_UNLINKED` if missed, error-taxonomy §3.1).
7. **Per-declaration fallback ladder (authoring-contract §9).** For each unmappable/decomposition-failed
   declaration, record a `DeclFallback` with tier in priority order: native -> local_style -> global_class
   (HOIST decides) -> custom_css (Pro only; `atomic-widget-styles.php:94-114` strips on free) ->
   html_widget. Set `tier:'custom_css'` only when `ctx.pro_active`; else mark dropped with reason. The
   whole-CSS-features-absent list (authoring-contract §5.2: grid-template-areas, place-*, text-shadow,
   writing-mode, white-space, word-break, overflow-x/-y, list-style, float, visibility, etc.) always
   routes to fallback.
8. **Free-string props (authoring-contract §5.2).** `aspect-ratio`, `font-family`, `text-decoration`,
   `grid-template-columns/-rows`, `content`, `clip-path` are `is_string`-only — emit as native
   string-typed values but mark them as DEFER for the TS pre-filter (only PHP/visual-diff can confirm).
9. **Literal flagging.** Record every literal color, font stack, and recurring size into
   `proposed_variable_literals` with occurrence counts so WP-H09 can extract variables. This stage does
   NOT create variables.
10. Pure transform: deterministic given (nodes, ctx); no I/O, no Playwright, no WP client. (The live
    `style_schema` is passed IN by the orchestrator; this stage does not fetch it.)

## Implementation Notes

- Use `css-tree`'s lexer to value-validate a candidate before emitting a typed envelope (SUPPLEMENT
  §C.3) as a cheap pre-check, but the schema `$$type`/enum is the real gate; PHP dry_run is final.
- The `props` map in a variant is keyed by Style-Schema CSS prop NAMES (e.g. `display`, `padding`,
  `color`) with typed-value VALUES (atomic-prop-types.schema.json). Get the prop names exactly — a
  non-schema key is dropped.
- `size` values: `{size:number, unit:string}`; `auto` -> `{size:null, unit:'auto'}` per
  authoring-contract §3.1; clamp units to the prop's allowed unit-preset from `style_schema`
  (SUPPLEMENT §B.3 size-unit presets) — a disallowed unit is rejected.
- Decomposition helpers (box-shadow/transform/transition/background) are non-trivial; keep them in
  this file but well-factored. When in doubt, FALLBACK + report rather than emit a guess (honest
  coverage, 15-eng-standards §4.6).
- Atomic-CSS dependency: the styles emitted here only render after prime-css (WP-P05 `Css_Primer` /
  WP-S01); the orchestrator (WP-H11) is responsible for priming. This WP must NOT claim CSS rendered.

## Acceptance Criteria

- [ ] A node with `display:flex; padding:8px 4px 8px 12px; color:#111` produces a base variant whose
      `props` has `display`, a logical `padding` dimensions object (inline axis per direction), and
      `color`, all as valid typed values.
- [ ] `font-weight:350` is snapped to the nearest 100-step (or fallback) with a recorded reason; a raw
      `font-weight:350` value is NEVER emitted.
- [ ] `display:table` / `grid-template-areas` / `text-shadow` / `white-space` route to fallback (no
      native prop emitted), each with a `DeclFallback`.
- [ ] A simple `box-shadow` decomposes to the nested `shadow` envelope; a multi-stop gradient
      `background` routes to custom_css (Pro) or drop (free) with a reason.
- [ ] `:hover` declarations become a `state:'hover'` variant; per-breakpoint deltas become per-breakpoint
      variants with resolved (non-hardcoded) keys.
- [ ] Each native declaration set yields a `StyleDefinition` whose id is flagged for mirroring into
      `settings.classes` (WP-H08 enforces).
- [ ] `text-align:left` becomes `start` (LTR) / `end` (RTL) via WP-H02.
- [ ] Literal colors/fonts/sizes are flagged in `proposed_variable_literals` with occurrence counts.
- [ ] Free-string props (`aspect-ratio`, `font-family`, etc.) are emitted as string values but marked
      DEFER for the pre-filter.
- [ ] Every produced `StyleDefinition`/`StyleVariant` validates against `style-variant.schema.json`
      (structural), and a representative styled node round-trips `valid:true` through PHP dry_run in the
      corpus test (WP-H10/Contract 14 §6 step 5).
- [ ] Module is pure (no I/O imports).

## Tests Required

- Unit (`style-extract.test.ts`): native vs fallback per declaration; enum snapping/rejection; typed-
  object decomposition (box-shadow success, gradient fallback); state + breakpoint variants; logical
  conversion via WP-H02; literal flagging; local-style id mirroring requirement; structural validation
  against `style-variant.schema.json`.
- Unit (`declaration-classifier.test.ts`): `classifyDeclaration` verdicts driven by a stub
  `style_schema` for native/variable-candidate/global-class-candidate/unmappable; free-string DEFER.
- Contract: produced styles validate against `style-variant.schema.json` + `atomic-prop-types.schema.json`
  (load schemas in the test); a fixture styled node is asserted `valid:true` via the PHP dry_run path
  in the corpus suite (WP-H10).

## Parallelization Notes

- Parallel-safe with all sibling HTML WPs: owns only `style-extract.ts`, `declaration-classifier.ts`,
  and tests.
- Code/type dependencies: WP-H01 (frozen `StyleContext`/`StyleExtractResult`/`StyledNode`/`DeclFallback`/
  `LiteralRef`/`DeclVerdict`/`MappedNode` types, Contract 15 §4.6.1), WP-H02 (logical props), WP-H06
  (mapped IR), WP-F03 (envelopes/shared types). Write dependencies (contract-level, not file): WP-P03
  (validator), WP-P05 prime-css (`Css_Primer`), WP-S01 — these are consumed by the orchestrator (WP-H11)
  at persist time, not imported here, but are declared per the universal atomic-CSS rule. Buildable +
  unit-testable as soon as WP-H01/H02 land (against the frozen `MappedNode[]` input); the DAG sequences
  it after WP-H06 to keep the corpus chain linear.
