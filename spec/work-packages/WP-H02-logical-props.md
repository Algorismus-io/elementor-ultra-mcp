---
id: WP-H02
title: Direction-aware physical-to-logical CSS property reference module
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-H01
files_owned:
  - packages/server/src/convert/logical-props.ts
  - packages/server/src/convert/logical-props.test.ts
contract_refs:
  - spec/contracts/11-authoring-contract.md#52-style-schema-native-props--the-no-native-expression-list-supplement-b3
  - spec/contracts/schemas/atomic-prop-types.schema.json
  - spec/contracts/schemas/style-variant.schema.json
estimate: M
---

## Summary

A pure reference module that converts physical CSS box properties (`padding-left`, `margin-top`,
`border-top-left-radius`, `top/left/right/bottom`, `text-align: left`) into Elementor's logical atomic
prop shapes (`dimensions.inline-start`, `border-radius.start-start`, `inset-inline-start`,
`text-align: start`) in a **direction-aware** way (RESEARCH.md §6.3 "physical->logical conversion is
DIRECTION-AWARE (corrected)"). It is the load-bearing correctness module that prevents LTR/RTL
mistakes: `padding-left` -> `inline-start` is correct only for LTR; for RTL it is `inline-END`. STYLE-
EXTRACT (WP-H07) calls this module; it owns NO Style-Schema validation (that is WP-H07) and NO I/O.

## Interface / Contract

Exports from `packages/server/src/convert/logical-props.ts`:

- `Direction = 'ltr' | 'rtl'`.
- `resolveDimensions(physical: PhysicalBox, dir: Direction): LogicalDimensions` — collapse
  `{ top, right, bottom, left }` (px/unit values) into atomic `dimensions`
  `{ 'block-start','inline-end','block-end','inline-start' }` honoring `dir`
  (LTR: left->inline-start, right->inline-end; RTL: left->inline-end, right->inline-start).
  The OUTPUT uses the atomic `dimensions` field names from atomic-prop-types.schema.json
  (`dimensions`: `block-start/inline-end/block-end/inline-start`, each a `size`).
- `resolveBorderRadius(physical: PhysicalCorners, dir: Direction): LogicalCorners` — map
  `{ 'top-left','top-right','bottom-right','bottom-left' }` to atomic `border-radius`
  `{ 'start-start','start-end','end-start','end-end' }` honoring `dir` (atomic-prop-types §`border-radius`).
- `resolveBorderWidth(physical, dir): LogicalEdges` — map physical edge widths to atomic
  `border-width` `{ 'block-start','block-end','inline-start','inline-end' }`.
- `resolveInset(physical: {top?,right?,bottom?,left?}, dir): { 'inset-block-start'?, 'inset-inline-end'?,
  'inset-block-end'?, 'inset-inline-start'? }` — the four `position` inset CSS props
  (authoring-contract §5.2 POSITION group; each a `size`, `[dep position!=static]`).
- `resolveLogicalKeyword(prop: 'text-align'|'justify-content'|'align-items'|..., value: string,
  dir: Direction): string` — translate physical keyword values (`left`/`right`) to the Style-Schema
  enum members. For `text-align` the schema enum is `start|center|end|justify`
  (authoring-contract §5.2 TYPOGRAPHY) so `left`->`start` (LTR) / `end` (RTL), `right`->`end` (LTR) /
  `start` (RTL). For `justify-content` the enum includes BOTH physical `left|right` AND logical
  `flex-start|flex-end|start|end` (authoring-contract §5.2 ALIGNMENT) — prefer preserving the source's
  visual intent (do NOT force a translation that changes appearance).
- `canCollapseToLogical(physical: PhysicalBox): boolean` — true when all four edges are present (or a
  clean shorthand) so a logical collapse is unambiguous; false when the source mixes physical edges
  such that a logical collapse would lose intent (RESEARCH.md §6.3: "collapse to logical only when
  unambiguous, otherwise keep physical or emit both").

Types `PhysicalBox = { top?:LenStr; right?:LenStr; bottom?:LenStr; left?:LenStr }`,
`LenStr = string` (a CSS length like `'16px'`, parsed into `{size:number, unit:string}` by WP-H07).
Output value placeholders are raw `{size,unit}` objects (NOT typed envelopes — WP-H08 wraps them).

## Dependencies & Inputs

- **WP-F03** — atomic prop-type field-name set (`dimensions`, `border-radius`, `border-width`,
  inset props) from `atomic-prop-types.schema.json` / `style-variant.schema.json`. This module's
  output field names MUST match those schemas exactly.
- **WP-H01** — imports `ComputedStyleSet` and (optionally) shares `Direction` if defined there; uses
  the IR's physical computed values as input. (No file overlap; WP-H01 owns the IR types.)
- Contract sections: 11-authoring-contract §5.2 (Style-Schema native props, the SIZE/POSITION/
  TYPOGRAPHY/SPACING/BORDER/ALIGNMENT groups), §3.1 (prop-type catalog: `dimensions`,
  `border-radius`, `border-width`, `size`); atomic-prop-types.schema.json (`dimensions`,
  `border-radius`, `border-width` object field names).
- RESEARCH.md §6.3 (direction-aware logical conversion), SUPPLEMENT §B.3 (Style-Schema groups,
  size-unit presets).

## Detailed Requirements

1. Implement the LTR and RTL mapping tables for the four boxes:
   - `dimensions` (padding/margin/gap-as-dimensions): physical top/right/bottom/left ->
     atomic block-start / (LTR inline-end | RTL inline-start) / block-end /
     (LTR inline-start | RTL inline-end).
   - `border-radius`: physical corners -> atomic start-start/start-end/end-start/end-end honoring
     `dir` (in LTR top-left=start-start, top-right=start-end, bottom-right=end-end,
     bottom-left=end-start; mirror inline axis for RTL).
   - `border-width`: physical edges -> atomic block-start/block-end/inline-start/inline-end honoring
     `dir`.
   - inset (`top/right/bottom/left`) -> `inset-block-start`/`inset-inline-(end|start)`/
     `inset-block-end`/`inset-inline-(start|end)` honoring `dir`.
2. Keyword translation (`resolveLogicalKeyword`):
   - `text-align: left|right` -> Style-Schema `start|end` honoring `dir` (the schema has NO
     `left`/`right` for text-align — authoring-contract §5.2 TYPOGRAPHY: `start|center|end|justify`).
     Therefore translation is MANDATORY for `text-align` (a `left`/`right` value would be DROPPED by
     `Style_Schema`).
   - `justify-content`/`align-*`: the schema enum DOES include `left|right` and `flex-start|flex-end`
     (authoring-contract §5.2 ALIGNMENT), so pass through the physical value when it is in the enum;
     only translate when the source value is not a valid enum member. Preserve visual intent.
3. `canCollapseToLogical` returns false when only one or two physical edges are set in a way that a
   logical collapse would be ambiguous (e.g. only `padding-left` set on a node whose direction is
   unknown). In that case STYLE-EXTRACT (WP-H07) decides whether to keep the physical value via a
   single-edge atomic dimension (block-start/inline-start with the other edges as `0`/absent) or route
   to fallback. This module only reports collapsibility; it never throws.
4. Detect source direction is OUT OF SCOPE here — `dir` is an INPUT. PARSE (WP-H03) determines the
   element's effective `direction` (computed `direction` prop) and the target site direction is read
   from `site.capabilities`/`breakpoints` by the orchestrator; the orchestrator passes the resolved
   `dir` in. Document the rule: "default to mapping that preserves the source's VISUAL intent"
   (RESEARCH.md §6.3) — i.e. when source `dir` and target `is_rtl()` differ, the orchestrator may
   choose to keep physical; this module faithfully maps whatever `dir` it is given.
5. Pure module: deterministic, no I/O, no Playwright, no WP client. Outputs raw value objects
   (`{size,unit}` or enum strings); envelope wrapping is WP-H08's job.
6. Round-trip soundness: `resolveDimensions(resolveDimensions(x, 'ltr')-inverted, 'ltr')` need not be
   tested, but `resolveDimensions(x,'ltr')` and `resolveDimensions(mirror(x),'rtl')` MUST be visually
   equivalent — provide a test that asserts the RTL inline-axis is the mirror of LTR.

## Implementation Notes

- The atomic `dimensions` field names are `block-start`, `inline-end`, `block-end`, `inline-start`
  (atomic-prop-types.schema.json `#/$defs/Dimensions`). `border-radius` is `start-start`,
  `start-end`, `end-start`, `end-end`. `border-width` is `block-start`, `block-end`, `inline-start`,
  `inline-end`. Inset props are full CSS names `inset-block-start` etc. (authoring-contract §5.2
  POSITION). Get these EXACT — a wrong field name is silently dropped by `Style_Parser` (PHP dry_run
  rejects).
- Keep a single `MIRROR_INLINE` constant table so LTR/RTL only differ in the inline axis; never
  mirror the block axis.
- This module does NOT validate units or enum membership — that is WP-H07 (against
  `schema.styles`). It only relocates physical names to logical positions and translates the
  text-align keyword.
- Common gotcha: `margin: 0 auto` -> the `auto` inline values must survive as `auto` sizes
  (atomic `size` with `size:null` for `auto`, per authoring-contract §3.1 "auto => size null"); do
  not coerce `auto` to a number. Pass `auto` through as a sentinel for WP-H07 to wrap.

## Acceptance Criteria

- [ ] `resolveDimensions({top:'8px',right:'4px',bottom:'8px',left:'12px'}, 'ltr')` yields
      `block-start=8, inline-end=4, block-end=8, inline-start=12` (px); the same input with `'rtl'`
      yields `inline-end=12, inline-start=4` (inline axis mirrored, block axis unchanged).
- [ ] `resolveBorderRadius` and `resolveBorderWidth` mirror only the inline axis for RTL.
- [ ] `resolveInset` maps top/bottom to block axis (never mirrored) and left/right to inline axis
      (mirrored by `dir`).
- [ ] `resolveLogicalKeyword('text-align','left','ltr')==='start'` and `(...,'left','rtl')==='end'`;
      `'right'` is the inverse.
- [ ] `resolveLogicalKeyword('justify-content','left','ltr')==='left'` (passes through — `left` is a
      valid Style-Schema enum member for alignment).
- [ ] `canCollapseToLogical` returns false for a single-edge-only physical box, true for a full box.
- [ ] `auto` length values survive as an `auto` sentinel (not coerced to a number).
- [ ] All output field names exactly match `atomic-prop-types.schema.json` `dimensions`/
      `border-radius`/`border-width` defs (snapshot test against the schema).
- [ ] Module is pure (no I/O imports; lint/test asserts).

## Tests Required

- Unit (`logical-props.test.ts`): LTR vs RTL mirror tests for dimensions/border-radius/border-width/
  inset; text-align keyword translation both directions; alignment pass-through; `canCollapseToLogical`
  cases; `auto` survival; field-name snapshot vs the frozen schema.
- Contract: assert output object keys are a subset of the corresponding `atomic-prop-types.schema.json`
  `$defs` required/property names (load the schema JSON in the test).

## Parallelization Notes

- Parallel-safe with all WPs: owns only `logical-props.ts` + its test.
- Code dependency for WP-H07 (STYLE-EXTRACT) only. Depends on WP-H01 for IR types and WP-F03 for
  schema field names. Build immediately after WP-H01.
