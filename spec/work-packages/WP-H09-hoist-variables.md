---
id: WP-H09
title: HOIST/dedup global classes + literal-to-variable extraction
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
  - WP-H07
  - WP-H08
  - WP-S01
files_owned:
  - packages/server/src/convert/hoist.ts
  - packages/server/src/convert/hoist.test.ts
  - packages/server/src/convert/variable-extract.ts
  - packages/server/src/convert/variable-extract.test.ts
contract_refs:
  - spec/contracts/11-authoring-contract.md#51-local-style-id-mirroring-into-classes-hard-rule
  - spec/contracts/11-authoring-contract.md#7-v3-globals-binding
  - spec/contracts/10-rest-api.md#design
  - spec/contracts/12-error-taxonomy.md#33-design-system--budget
  - spec/contracts/schemas/style-variant.schema.json
estimate: L
---

## Summary

The hoisting stage: fingerprint each node's style declaration-set and promote sets shared by >=2 nodes
into proposed GLOBAL CLASSES (single-use stays local), and dedupe literal colors / font-stacks /
recurring sizes into proposed VARIABLES (`global-color/font/size-variable`, all FREE), rebinding nodes
to reference variable ids and global-class ids (authoring-contract §6.3). It produces the
`proposed_classes` / `proposed_variables` arrays that `convert.html_to_tree` returns and pre-flights
the 1000-item budget (error-taxonomy §3.3 `BUDGET_EXCEEDED`). It MUTATES nothing on the site itself —
it only proposes; actual persistence (diff-PUT `classes.upsert`, `variables.batch`) is the
orchestrator's job (WP-H11) against WP-P05. It is atomic-CSS-affecting and design-system-touching, so
it depends on the validator + prime-css + WP-S01 per the universal rules.

## Interface / Contract

`HoistContext`, `HoistResult`, `BudgetReport`, `VarContext`, `VarResult`, `ProposedVariable`, and the
consumed `LiteralRef` are FROZEN and OWNED by WP-H01 (`convert/types.ts`, Contract 15 §4.6.1); this WP
IMPLEMENTS the functions and `import type`s them — it does NOT declare them locally. `ElementNode`/
`StyleDefinition`/`GlobalClassObject`/`VariableDef` are WP-F03/shared types. For reference (the frozen
shapes):

Exports from `packages/server/src/convert/hoist.ts`:

- `hoistClasses(elements: ElementNode[], ctx: HoistContext): HoistResult` where:
  - `HoistContext = { existing_classes: GlobalClassObject[]; existing_order: string[];
    min_uses: number; name_hints: Record<string,string>; budget_max: number }`.
    `existing_classes` is the current kit global-class set (`design.classes.list`, 10-rest-api §Design);
    `name_hints[source_path]` are the `suggestName` candidates from CLASSIFY (WP-H05); `budget_max`
    defaults to 1000 (`MAX_ITEMS`, error-taxonomy §3.3).
  - `HoistResult = { elements: ElementNode[]; proposed_classes: GlobalClassObject[];
    class_rebinds: Record<string,string[]>; budget: BudgetReport; warnings: string[] }`. `elements` is
    the same tree with shared local styles REPLACED by global-class id references in
    `settings.classes.value` (and the now-redundant local-style objects removed from `styles`);
    `proposed_classes` are `GlobalClassObject`s (StyleDefinition-shaped: `{id,label,type:'class',
    variants[]}`, 13-tool-catalog shared types); `class_rebinds` maps each global-class id to the
    element ids that reference it; `BudgetReport = {current_count, would_add, would_delete, projected,
    max_allowed, exceeded:boolean}`.
- `fingerprintVariants(styleDef: StyleDefinition): string` — a stable content hash of a style's variants
  (breakpoint+state+props, order-insensitive) used to detect shared declaration-sets.

Exports from `packages/server/src/convert/variable-extract.ts`:

- `extractVariables(elements: ElementNode[], literals: LiteralRef[], ctx: VarContext): VarResult` where:
  - `VarContext = { existing_variables: VariableDef[]; min_uses: number; budget_max: number }`.
    `existing_variables` from `design.variables.list` (10-rest-api §Design).
  - `VarResult = { elements: ElementNode[]; proposed_variables: ProposedVariable[];
    var_rebinds: Record<string,string[]>; budget: BudgetReport; warnings: string[] }`.
    `ProposedVariable = { type:'global-color-variable'|'global-font-variable'|'global-size-variable';
    label: string; value: string }` (the `convert.html_to_tree.proposed_variables` shape,
    13-tool-catalog §1.9). `elements` is the tree with literal color/font/size typed-values REPLACED by
    `{$$type:'global-color-variable', value:'<var-id-placeholder>'}` references where the literal was
    extracted; the placeholder resolves to a real var id at persist (WP-H11).

## Dependencies & Inputs

- **WP-P03 (PHP dry_run validator)** — REQUIRED (universal write rule): rebinding to global-class/
  variable ids must still produce a tree PHP accepts; the orchestrator round-trips it.
- **Design routes (WP-P08 classes-controller + WP-P09 variables-controller)** — `design.classes.list/
  upsert` (diff-PUT, WP-P08) + `design.variables.list/batch` (watermark, WP-P09) per 10-rest-api §Design.
  HOIST READS the existing sets via injected ports; the orchestrator (WP-H11) PERSISTS proposals via the
  diff-PUT/batch routes. This WP builds the PROPOSALS in the exact shape those routes consume but does
  not call them directly (so it is a contract-level, not file, dependency on P08/P09 via WP-H11).
- **prime-css WP (WP-P05 `Css_Primer`/`Cache_Service`) + WP-S01** — REQUIRED (universal atomic-CSS rule):
  hoisted global classes render only after a kit cache flush (`Cache_Service::flush_design_system`) +
  prime; the orchestrator (WP-H11) handles it via the WP-P05 service.
- **WP-H08 (ASSEMBLE)** — consumes the assembled `ElementNode[]` (with local styles + mirrored classes).
- **WP-H07 (STYLE-EXTRACT)** — consumes `LiteralRef[]` (`proposed_variable_literals`).
- **WP-H01** — IR/type imports.
- **WP-F03** — `StyleDefinition`/`GlobalClassObject`/`ElementNode`/`Classes` types; envelope helpers.
- **WP-F05** — `BUDGET_EXCEEDED`, `DUPLICATED_LABEL`, `INVALID_ORDER` codes (the diff-PUT soft errors
  the orchestrator must reconcile).
- Contract sections: 11-authoring-contract §5.1 (class mirroring), §6.3 (CSS->classes/variables
  strategy), §7 (V3 globals — out of scope for proposals but referenced for naming), R7 (class-label
  rules); 10-rest-api §Design (diff-PUT body shape, watermark); 12-error-taxonomy §3.3 (budget,
  duplicate-label, invalid-order, watermark-stale); style-variant.schema.json. RESEARCH.md §6.3, §5.4,
  §7 (design-system partial failures).

## Detailed Requirements

1. **Declaration-set fingerprinting + hoisting (authoring-contract §6.3).** Compute
   `fingerprintVariants` for every node's local style. Sets that appear on >= `min_uses` (default 2)
   distinct nodes become ONE proposed global class; single-use sets stay local. Replace the shared
   local-style id in each node's `settings.classes.value` with the proposed global-class id and remove
   the duplicated local `StyleDefinition` from each node's `styles` map. Record `class_rebinds`.
2. **Meaningful labels (authoring-contract R7, SUPPLEMENT §C.2).** Label each proposed global class from
   `name_hints` (the source class name / role-derived `suggestName`) when valid, else `g-<hex>`. Enforce
   the label rules: 2-50 chars, no spaces, no leading digit/`--`/`-digit`, not reserved `container`,
   matches `/^[a-z][a-z-_0-9]*$/i`. Deduplicate labels within the proposal set (the diff-PUT will
   auto-rename collisions and return `DUPLICATED_LABEL` — error-taxonomy §3.3; pre-dedupe to minimize
   reconciliation, but the orchestrator still handles the soft error).
3. **Existing-class reuse.** Before proposing a new class, fingerprint-match against
   `existing_classes` — if an identical declaration-set already exists, REUSE its id instead of
   creating a duplicate (RESEARCH.md §6.3 "Detect & reuse existing kit tokens first"). This shrinks the
   diff-PUT and the budget impact.
4. **Diff-PUT-ready proposal shape (10-rest-api §Design).** `proposed_classes` carry full
   `GlobalClassObject`s. The orchestrator builds the diff-PUT body
   (`changes:{added,modified,deleted,order}`, `items` touched-only, `order` full final list); HOIST
   provides everything that body needs: the new/modified class objects, the rebinds, and the projected
   full order (existing order + appended new ids). Provide a helper `projectedOrder(existing_order,
   added_ids): string[]` so the orchestrator's `order` array is the full, consistent final list
   (else `INVALID_ORDER`, error-taxonomy §3.3).
5. **Variable extraction (authoring-contract §6.3).** From `LiteralRef[]` + a scan of the tree's typed
   values, dedupe literal COLORS -> `global-color-variable`, FONT stacks -> `global-font-variable`,
   recurring SIZES -> `global-size-variable` (all FREE — never Pro-gate or strip size variables,
   RESEARCH.md §6.3 / authoring-contract §3.1). A literal becomes a variable when it occurs on >=
   `min_uses` nodes OR matches an existing kit variable (reuse). Replace the literal typed value with a
   variable-reference envelope (`{$$type:'global-color-variable', value:'<var-id-placeholder>'}`,
   authoring-contract §3.1: renders `var(--Label)`). Record `var_rebinds`.
6. **Existing-variable reuse.** Match literals against `existing_variables` by value; reuse the existing
   var id (and its label) instead of proposing a duplicate.
7. **Budget pre-flight (error-taxonomy §3.3, RESEARCH.md §5.4).** Compute `BudgetReport` for classes AND
   variables: `projected = current_count - would_delete + would_add`; set `exceeded:true` and a clear
   `warnings` entry when `projected > budget_max` (1000). When exceeded, the orchestrator must NOT
   attempt the write; HOIST should suggest consolidation (fewer classes via more aggressive
   fingerprint merging) in `warnings`. Do NOT throw — report.
8. **Idempotent + pure-ish.** Reads come via injected ports / passed-in existing sets; the transform
   itself is deterministic. No direct WP-client import (ports injected by the orchestrator). Persisting
   is NOT done here.
9. Do NOT write V3 globals (authoring-contract §7) — proposals target V4 global classes + variables
   only. (V3 globals binding is a separate design-system WP.)

## Implementation Notes

- Fingerprint must be order-insensitive over variants and props (sort keys) so two nodes with the same
  declarations in different source order hoist together.
- The placeholder var-id / class-id scheme: emit a deterministic placeholder (e.g.
  `__var:color:#375efb` / `__class:card`) so the orchestrator can resolve placeholders to real
  ids after the diff-PUT/batch returns the minted ids, then rewrite the tree references in one pass.
  Document this resolution handshake clearly (WP-H11 implements the resolve).
- The diff-PUT is DIFF-BASED (RESEARCH.md §2.2): deletion is explicit (`changes.deleted`), `order` must
  be the FULL final list, touched `items` are added+modified only. HOIST never proposes deletions
  (conversion only adds/reuses); it must still produce a consistent full `order` via `projectedOrder`.
- `DUPLICATED_LABEL` is a SOFT error the agent reconciles (rebind to the renamed id, error-taxonomy
  §3.3 / RESEARCH.md §5.4) — HOIST minimizes it by pre-deduping labels, but the orchestrator owns the
  reconciliation after the PUT response.
- Variables and classes share the 1000 cap independently (each has its own `MAX_ITEMS`); compute
  budgets separately.

## Acceptance Criteria

- [ ] A declaration-set on 3 nodes is hoisted to ONE proposed global class; the 3 nodes reference its
      id in `settings.classes.value` and their duplicated local styles are removed; `class_rebinds`
      lists the 3 element ids.
- [ ] A single-use declaration-set stays a local style (not hoisted).
- [ ] An identical declaration-set already in `existing_classes` is REUSED (no duplicate proposed).
- [ ] Proposed class labels obey R7 (2-50 chars, valid charset, not `container`); collisions are
      pre-deduped; `g-<hex>` is the only fallback.
- [ ] `projectedOrder` returns the full existing-order + new ids (consistent final list).
- [ ] A color literal on >=2 nodes becomes a `global-color-variable` proposal; nodes are rebound to a
      variable reference envelope; size variables are extracted (not Pro-gated).
- [ ] An existing kit variable matching a literal is REUSED.
- [ ] `BudgetReport.exceeded` is true (with a consolidation suggestion) when projected class or variable
      count > 1000; HOIST does not throw.
- [ ] Rebound tree still validates against `element-node.schema.json` and round-trips `valid:true`
      through PHP dry_run in the corpus test (Contract 14 §6).
- [ ] No direct WP-client import (ports injected); transform deterministic.

## Tests Required

- Unit (`hoist.test.ts`): fingerprint order-insensitivity; >=2-use hoisting + rebind + local removal;
  single-use stays local; existing-class reuse; label-rule enforcement + dedupe; `projectedOrder`
  consistency; budget pre-flight (under/over 1000).
- Unit (`variable-extract.test.ts`): color/font/size literal extraction + rebind; existing-variable
  reuse; size variables NOT gated; budget pre-flight.
- Contract: rebound trees validate against `element-node.schema.json` and `style-variant.schema.json`;
  proposed classes match the diff-PUT `items` shape (10-rest-api §Design); corpus dry_run `valid:true`.

## Parallelization Notes

- Parallel-safe with all sibling HTML WPs: owns only `hoist.ts`, `variable-extract.ts`, and tests.
- Type/code dependencies: WP-H01 (frozen `HoistContext`/`HoistResult`/`BudgetReport`/`VarContext`/
  `VarResult`/`ProposedVariable`/`LiteralRef` types, Contract 15 §4.6.1), WP-H07 (literals), WP-H08
  (assembled `ElementNode[]`), WP-F03 (shared types). Contract/code deps on WP-P03 (validator), WP-P08/
  WP-P09 (design routes, via WP-H11), WP-P05 prime-css (`Css_Primer`/`Cache_Service`), WP-S01 satisfied
  via injected ports + the orchestrator. Buildable + unit-testable as soon as WP-H01 lands; the DAG
  sequences it after WP-H08 to keep the corpus chain linear.
