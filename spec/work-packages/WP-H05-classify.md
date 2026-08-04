---
id: WP-H05
title: CLASSIFY stage - semantic role assignment (deterministic + AI-IR seam)
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-H01
  - WP-H03
  - WP-H04
files_owned:
  - packages/server/src/convert/classify.ts
  - packages/server/src/convert/classify.test.ts
  - packages/server/src/convert/flex-inference.ts
  - packages/server/src/convert/flex-inference.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md#19-html-native-conversion-flagship
  - spec/contracts/15-engineering-standards.md#46-html-pipeline-layer-html-wp-h
  - spec/contracts/11-authoring-contract.md#4-atomic-element-types-verified
estimate: L
---

## Summary

The third conversion stage: assign a `SemanticRole` (WP-H01) to every normalized IR node from tag +
computed `display` + ARIA role + class-name hints + child composition + box geometry. This is the
deterministic half of the Builder.io-style AI/deterministic split (SUPPLEMENT §C.2/§C.4): the
classifier produces the framework-agnostic IR roles; an OPTIONAL upstream AI hook may PRE-annotate
roles/hierarchy/naming, but the AI is strictly upstream of envelope emission and its output is
re-validated by this deterministic classifier. It also owns Locofy-style flex layout inference
(box-geometry -> flex direction/justify/align) for dirty marketing HTML. NO Elementor I/O, NO mapping
to element types (that is WP-H06), NO style envelopes.

## Interface / Contract

`ClassifyOptions`, `AiRoleHint`, `ClassifyResult`, `RoleOverride`, and `FlexIntent` are FROZEN and OWNED
by WP-H01 (`convert/types.ts`, Contract 15 §4.6.1); this WP IMPLEMENTS the functions and `import type`s
them — it does NOT declare them locally. For reference (the frozen shapes):

Exports from `packages/server/src/convert/classify.ts`:

- `classifyIr(ir: IrNode[], opts: ClassifyOptions): ClassifyResult` where:
  - `ClassifyOptions = { ai_hints?: AiRoleHint[]; infer_flex: boolean }`.
  - `AiRoleHint = { source_path: string; role?: SemanticRole; suggested_name?: string;
    confidence?: number }` — the AI/deterministic seam. When present, a hint is a SUGGESTION the
    deterministic classifier may adopt ONLY if it is consistent with the node's tag/display/children
    (the classifier overrides an implausible AI hint and records it in `warnings`). The AI itself is
    NOT implemented in this WP — this WP only defines and consumes the hint shape.
  - `ClassifyResult = { ir: IrNode[]; role_overrides: RoleOverride[]; warnings: string[] }` — `ir` is
    the same tree with `IrNode.role` populated/refined; `role_overrides` records where an AI hint was
    accepted or rejected (for observability and the corpus tests).
- `classifyNode(node: IrNode, parent?: IrNode): SemanticRole` — the per-node deterministic classifier.
- `suggestName(node: IrNode): string` — a human-meaningful name candidate from source class names /
  role / text (Anima/Locofy smart-naming, SUPPLEMENT §C.2), used downstream by HOIST (WP-H09) to label
  global classes meaningfully instead of `g-<hex>`.

Exports from `packages/server/src/convert/flex-inference.ts`:

- `inferFlex(node: IrNode): FlexIntent | null` — Locofy-style geometry/CSS heuristics returning
  `{ direction:'row'|'column'; wrap:boolean; justify?:string; align?:string; gap?:string;
  fill_children:string[]; absolute_children:string[] }` or `null` when the node is not a layout
  container. Used by CLASSIFY to distinguish `flex-row`/`flex-col`/`grid`/`structural-block`.

## Dependencies & Inputs

- **WP-H03 (PARSE)** + **WP-H04 (NORMALIZE)** — consumes the normalized IR (`IrNode[]` with `computed`,
  `box`, `attrs`, `children`).
- **WP-H01** — `SemanticRole` vocabulary + `IrNode` types.
- **WP-F03** — shared types.
- Contract sections: 13-tool-catalog §1.9 (TS-only convert); 15-engineering-standards §4.6 ("AI strictly
  upstream producing an IR, deterministic IR->envelope compile"); 11-authoring-contract §4 (the atomic
  type vocabulary roles must ultimately map to). RESEARCH.md §6.1 step 3 (CLASSIFY role list),
  SUPPLEMENT §C.2 (AI/deterministic split, layout-reconstruction heuristics), §C.4 (AI strictly upstream).

## Detailed Requirements

1. **Deterministic role assignment** for every node, using the RESEARCH.md §6.1 step-3 vocabulary
   (mapped to `SemanticRole` in WP-H01): structural-block, flex-row, flex-col, grid, heading, text,
   image, button, link, divider, icon-svg, media-embed-youtube, media-embed-video, tabs/tab/tab-content,
   form/form-field, nav-menu, list/list-item, table, accordion/accordion-item. Signals:
   - tag (`h1`-`h6`->heading; `p`->text; `img`->image; `button`/`a.button`/`role=button`->button;
     `a`->link; `hr`->divider; `svg`/icon-font->icon-svg; `iframe[src*=youtube]`->media-embed-youtube;
     `video`->media-embed-video; `ul`/`ol`->list; `li`->list-item; `table`->table; `nav`->nav-menu;
     `form`->form; `input`/`textarea`/`select`->form-field; `details`->accordion; `summary`->
     accordion header).
   - computed `display` (`flex`/`inline-flex` + geometry -> flex-row/flex-col; `grid`/`inline-grid` ->
     grid; `block` + multiple block children -> structural-block).
   - ARIA `role`/`aria-*` attrs (e.g. `role=tablist`/`role=tab`/`role=tabpanel` -> tabs family;
     `role=button`).
   - class-name hints (`.btn`/`.button`/`.cta` -> button; `.card`/`.row`/`.col` -> structural/flex).
   - child composition (a tablist + tabpanels sibling structure -> tabs; a repeated card pattern ->
     structural list).
2. **Flex inference (Locofy heuristics, SUPPLEMENT §C.2/§C.4).** In `flex-inference.ts`:
   `display:flex` horizontal -> `direction:row`, vertical -> `column`; `flex-wrap:wrap` -> `wrap`;
   alignment from `justify-content`/`align-items`; spacing from `gap`; a child with `flex:1`/Fill ->
   `fill_children`; a child with `width:fit-content`/Hug semantics noted; absolutely-positioned
   children removed from flow -> `absolute_children` (their layout becomes `position:absolute` variants
   downstream). When source CSS is dirty/absolute (marketing HTML without explicit flex), INFER flex
   intent from box geometry (children laid out in a horizontal/vertical band) rather than refusing
   (Visual Copilot "without explicit breakpoints", SUPPLEMENT §C.2). Prefer flex by default; classify
   `grid` ONLY for a true 2D track grid (multiple rows AND columns of aligned children) because
   Style-Schema grid support is limited (authoring-contract §5.2 LAYOUT, §9 fallback).
3. **AI/deterministic seam.** Accept `ai_hints` and, per node, adopt the hint's `role`/`suggested_name`
   ONLY when consistent with the deterministic signals; otherwise reject and record. The AI is NEVER
   allowed to emit Elementor envelopes or final types — it only proposes IR roles/names/hierarchy
   (SUPPLEMENT §C.4). This WP defines the hint contract so a future AI WP can plug in without touching
   the deterministic compiler. With no hints, classification is fully deterministic.
4. **Tabs/accordion pairing.** When classifying a tabs structure, compute whether menu (tab) count ==
   content (tabpanel) count and stash the result so MAP (WP-H06) can decide `tab_pairing_ok`
   (authoring-contract §4 note: "tab & content counts MUST match"). For `details/summary` accordion,
   pair each summary with its following content.
5. **Naming.** `suggestName` derives a meaningful slug from (in priority order) a valid source class
   name (matching `/^[a-z][a-z-_0-9]*$/i`, authoring-contract R7), then the role, then leading text;
   it NEVER returns `g-<hex>` (that is HOIST's last resort). Output is a CANDIDATE; HOIST validates
   against global-class label rules (2-50 chars, no leading digit/`--`, not reserved `container`,
   authoring-contract R7).
6. Pure transform: deterministic given (ir, opts.ai_hints); no I/O, no Playwright, no WP client.
7. Do NOT map to Elementor element types here — emit only `SemanticRole`. Mapping is WP-H06.

## Implementation Notes

- Keep the deterministic classifier as a prioritized rule cascade (most specific signal wins) so it is
  auditable and testable. Document the precedence (ARIA role > tag > class hint > display > geometry).
- Flex inference must be conservative about `grid`: a single-row flex misread as grid produces an
  unmappable `grid-template-areas` downstream and forces a fallback (authoring-contract §5.2). Default
  ambiguous 1D layouts to flex.
- `absolute_children` are real: marketing hero sections layer badges/images absolutely. Record them so
  STYLE-EXTRACT emits `position:absolute` + inset variants (authoring-contract §5.2 POSITION) instead
  of trying to flex them.
- The AI hint shape is a CONTRACT for a later ULTRA AI WP; ship it now so the deterministic compiler is
  the stable seam. Do not call any LLM here.

## Acceptance Criteria

- [ ] Every node in the output IR has a non-`unknown` role when its signals are decisive; ambiguous
      nodes get `structural-block` (never crash).
- [ ] `h1`->heading, `p`->text, `img`->image, `button`/`a.btn`->button, `a`->link, `hr`->divider,
      `iframe[youtube]`->media-embed-youtube, `ul`->list, `table`->table, `nav`->nav-menu,
      `details`->accordion are all asserted.
- [ ] A flex container with horizontally-laid children classifies as `flex-row` with inferred
      `direction:row`; a 2D aligned grid classifies as `grid`; an ambiguous 1D layout defaults to flex.
- [ ] `inferFlex` returns `fill_children` for a `flex:1` child and `absolute_children` for an
      absolutely-positioned child.
- [ ] An `ai_hints` entry inconsistent with the node's tag/display is REJECTED and recorded in
      `role_overrides`/`warnings`; a consistent hint is adopted.
- [ ] tabs pairing count is computed and exposed for MAP.
- [ ] `suggestName` returns a valid class-name slug from a source class, never `g-<hex>`, and respects
      the label rules.
- [ ] Classifier is deterministic (same input -> same output) and pure (no I/O imports).

## Tests Required

- Unit (`classify.test.ts`): role assignment matrix for each tag/display/ARIA/class-hint case; tabs &
  accordion pairing; AI-hint accept/reject; `suggestName` slug derivation + label-rule compliance;
  determinism.
- Unit (`flex-inference.test.ts`): row vs column inference; wrap; justify/align extraction; fill vs
  absolute children; conservative grid classification (1D -> flex, true 2D -> grid).

## Parallelization Notes

- Parallel-safe with all sibling HTML WPs: owns only `classify.ts`, `flex-inference.ts`, and tests.
- Type dependency on WP-H01 ONLY: `IrNode`/`SemanticRole` plus `ClassifyOptions`/`AiRoleHint`/
  `ClassifyResult`/`RoleOverride`/`FlexIntent` are all frozen in WP-H01 `types.ts` (Contract 15 §4.6.1).
  This WP is buildable and unit-testable as soon as WP-H01 lands — it codes `classifyIr`/`inferFlex`
  against the frozen IR and tests with hand-authored IR fixtures; it needs WP-H03/H04 RUNTIME only for
  end-to-end corpus tests (WP-H10/Q04), not to compile or unit-test. Feeds WP-H06 (MAP) and WP-H07
  (STYLE-EXTRACT). (The DAG sequences it after WP-H04 to keep the corpus chain linear.)
