---
id: WP-F03
title: Realize the authoring contract — shared TS types, JSON-schema exports, prefilter validators
layer: foundation
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - packages/shared/schemas/atomic-prop-types.schema.json
  - packages/shared/schemas/style-variant.schema.json
  - packages/shared/schemas/element-node.schema.json
  - packages/shared/schemas/page-tree.schema.json
  - packages/shared/schemas/diff.schema.json
  - packages/shared/schemas/index.ts
  - packages/server/src/authoring/contract.ts
  - packages/server/src/authoring/envelopes.ts
  - packages/server/src/authoring/ids.ts
  - packages/server/src/authoring/prefilter.ts
  - scripts/sync-schemas.mjs
contract_refs:
  - spec/contracts/11-authoring-contract.md (V4 atomic / V3 fallback authoring JSON, $$type table, ID rules)
  - spec/contracts/schemas/atomic-prop-types.schema.json
  - spec/contracts/schemas/style-variant.schema.json
  - spec/contracts/schemas/element-node.schema.json
  - spec/contracts/schemas/page-tree.schema.json
  - spec/contracts/schemas/diff.schema.json
  - spec/01-architecture.md §2.4 (Seam D — authoring JSON contract crossing all tiers)
  - spec/01-architecture.md §7 (ID minting = TS; validation authoritative = PHP)
  - spec/contracts/15-engineering-standards.md §2.5 (TS validator is PRE-FILTER only)
estimate: L
---

## Summary

Realize Seam D: the authoring JSON contract as (a) the canonical frozen TS types, (b) JSON Schemas (draft 2020-12) copied into `packages/shared/schemas/` so both TS and PHP fixtures validate against one source, (c) the `$$type` envelope helpers, (d) the 7-hex ID mint+dedupe service, and (e) the CHEAP structural pre-filter. The pre-filter is explicitly a safe subset (accept/reject/defer) and never authoritative — PHP `dry_run` is (`15-engineering-standards.md §2.5`, `11-authoring-contract.md`).

## Interface / Contract

- **Frozen TS type names (`authoring/contract.ts`) — implement EXACTLY these:** `TypedValue`, `Size`, `Dimensions`, `Classes`, `Link`, `ImageSrc`, `Image`, `HtmlV3`, `GlobalVariableRef`, `StyleDefinition`, `StyleVariant`, `StyleMeta`, `BreakpointKey`, `StyleState`, `ElementNode`, `AtomicContainerNode`, `AtomicWidgetNode`, `AtomicNode (=AtomicContainerNode|AtomicWidgetNode)`, `ClassicNode`, `PageTree`, `PageTreeRead`, `PageTreeWrite`, `Generation`, `PageSettings`, `Diff`, `NodeChange`, `DryRunResult`, `ValidationError`, `CoverageReport`. Plus a `normalize(tree)` function (used by round-trip tests, `14-fixtures-harness.md §7`).
- **JSON Schemas (`packages/shared/schemas/*.schema.json`).** The five frozen schemas, copied/derived from `spec/contracts/schemas/` so the shared package owns the runtime copy that fixtures validate against. `schemas/index.ts` exports them + a compiled Ajv validator per schema. `scripts/sync-schemas.mjs` proves the `packages/shared/schemas/*` copies are byte-identical (normalized) to `spec/contracts/schemas/*` and fails CI on divergence (the contract is the source; shared is the runtime mirror).
- **Envelope helpers (`authoring/envelopes.ts`).** Constructors/typeguards for the typed envelope `{ $$type, value, disabled? }` where `$$type == get_key()`; the `classes` value is a BARE string array (never double-wrapped); UNION emits the chosen member's own envelope (never double-wrapped); strict `ImageSrc` id-XOR-url; `html-v3` inline-only allowlist `[b,i,em,u,a,del,span,strong,sup,sub,s]`.
- **ID service (`authoring/ids.ts`).** `mintId()` → 7-hex non-UUID (`substr(strtolower(dechex(rand)),0,7)` style, RESEARCH.md §4.6); `dedupe(tree)` against a live/in-tree set; `mintLocalStyleId(elementId)`; helper that mirrors a local-style id into `settings.classes.value` (the LOCAL_STYLE_UNLINKED invariant).
- **Pre-filter (`authoring/prefilter.ts`).** `prefilter(tree): { verdict: 'accept'|'reject'|'defer'; errors: ValidationError[] }`. Safe-subset: rejects only what PHP also rejects (structural: malformed envelope, image-src XOR violation, local-style not mirrored into classes, duplicate element id, missing required envelope keys); DEFERS conditional/Union/free-string props (`14-fixtures-harness.md §4`). Never makes a hard accept on anything it cannot prove valid.

## Dependencies & Inputs

- Upstream: WP-F01 (scaffold, `packages/shared`, tsconfig). Reads the frozen schemas at `spec/contracts/schemas/*` (authored already) and the contract text `11-authoring-contract.md`.
- Contracts: `11-authoring-contract.md` (node shapes, `$$type` table, invariants, ID rules); the five `spec/contracts/schemas/*.schema.json`; `01-architecture.md §2.4/§7`; `15-engineering-standards.md §2.5`.
- Elementor APIs (cited, NOT called): atomic schema post-filter `get_props_schema()` (`has-atomic-base.php:310-321`) is the truth the pre-filter approximates; atomic throw points `has-atomic-base.php:88-117`; ID style `includes/utils.php:373-375`. The pre-filter NEVER reimplements `Props_Parser`/`Style_Parser`/`Style_Schema` faithfully (RESEARCH.md §1 bullet 5) — it stays a subset.

## Detailed Requirements

1. **Implement every frozen type name** above, matching `11-authoring-contract.md`. `ElementNode = AtomicNode | ClassicNode`. `PageTreeRead` vs `PageTreeWrite` differ per the contract (read tolerates `_cssid`/normalized fields; write is the authored shape).
2. **Typed-envelope invariants enforced by envelopes.ts + prefilter:** `$$type == get_key()`; `classes.value` BARE string array; UNION single-wrap; `ImageSrc` strict id-XOR-url (maps to `IMAGE_SRC_XOR_VIOLATION`); `html-v3` inline-only allowlist (over-tag → `HTML_V3_STRIPPED` soft report).
3. **Style variant states.** `StyleState` enum = `[null, hover, active, focus, focus-visible, checked, e--selected]`; `BreakpointKey` per the breakpoints contract. `StyleVariant`/`StyleDefinition` match `style-variant.schema.json`.
4. **Local-style mirroring.** `ids.ts` provides the helper that, when a local style is added, mirrors its id into `settings.classes.value`; `prefilter` rejects (`LOCAL_STYLE_UNLINKED`) any `styles` map id not present in the owning element's `classes`.
5. **7-hex ID minting + dedupe.** Non-UUID, client-side, collision-repaired against a provided set (`DUPLICATE_ELEMENT_ID` on unresolved collision). Never reuse ids across documents.
6. **Schema mirror + sync guard.** Copy the five schemas into `packages/shared/schemas/`; `scripts/sync-schemas.mjs` normalizes (stable key sort) and asserts byte-equality with `spec/contracts/schemas/*`. Compile each with Ajv (draft 2020-12, `$ref` resolution across the five) and expose validators.
7. **Pre-filter subset behavior.** Implement `accept/reject/defer` per `14-fixtures-harness.md §4`. The meta-invariant must hold on the corpus: `accept ⇒ PHP valid`, `reject ⇒ PHP invalid` (asserted by WP-Q01/F06 against fixtures).
8. **Normalizer.** `normalize(tree)` used by round-trip identity tests — tolerate `_cssid` injection, html-v3 normalization, and structural (not literal-id) comparison (`14-fixtures-harness.md §7`).
9. **Diff types.** `Diff`/`NodeChange`/`ValidationError`/`DryRunResult`/`CoverageReport` match `diff.schema.json` and are reused by WP-F02 (REST), WP-T (safety/diff), WP-H (coverage). Export from one place.

## Implementation Notes

- The five JSON Schemas already exist at `spec/contracts/schemas/`; this WP MIRRORS them into `packages/shared/schemas/` (the runtime location fixtures use, `14-fixtures-harness.md §10` `fixtures:validate`). Do not edit the `spec/contracts/schemas/*` originals (contracts are append-only within a wave, `15-engineering-standards.md §5.5`).
- Derive TS types from the schemas where feasible (e.g. `json-schema-to-typescript`) but the hand-frozen type NAMES above are mandatory — alias generated types to those exact names.
- The pre-filter must DEFER (not reject) on: conditional `Dependency_Manager` props, Union members, free-string props (SUPPLEMENT §B.3). A hard reject of valid input is a bug (`15-engineering-standards.md §2.5`).
- ID mint uses `dechex(rand)` semantics, lowercased, first 7 chars; document the source (`includes/utils.php:373-375`) in a code comment per the no-invented-APIs rule.

## Acceptance Criteria

- [ ] All frozen type names exist and compile; `ElementNode`/`AtomicNode` unions match the contract.
- [ ] `packages/shared/schemas/*` are byte-identical (normalized) to `spec/contracts/schemas/*`; `scripts/sync-schemas.mjs` enforces it and fails on drift.
- [ ] All five schemas are meta-valid (draft 2020-12) and all cross-`$ref`s resolve when compiled with Ajv.
- [ ] `envelopes.ts` typeguards enforce `$$type==get_key`, bare `classes` array, union single-wrap, image-src XOR, html-v3 allowlist.
- [ ] `ids.ts` mints 7-hex non-UUID ids, dedupes, and mirrors local-style ids into `classes`.
- [ ] `prefilter` returns accept/reject/defer; on the WP-F06 corpus the subset meta-invariant holds (no accept of a PHP-invalid fixture, no reject of a PHP-valid fixture).
- [ ] `pnpm build` + `pnpm lint` clean; no `any`.

## Tests Required

- Unit (vitest): envelope constructors/guards (all invariants incl XOR + allowlist); ID mint determinism/dedupe/local-style mirror; pre-filter verdict per the table in `14-fixtures-harness.md §4`; normalizer idempotence.
- Contract: Ajv meta-validation of all five schemas; `$ref` resolution; sync-guard byte-equality.
- Fixtures: a handful of inline accept/reject/defer trees colocated as test data (the shared golden corpus is WP-F06; do not edit F06's runner). The corpus-wide subset invariant is asserted by WP-Q01/F06.

## Parallelization Notes

- Wave 0/early-Wave-1, parallel-safe with WP-F02 (rest), WP-F04 (mcp-catalog), WP-F05 (errors/capabilities), WP-F06 (harness) — all own disjoint files. F03 owns `authoring/*` + `schemas/*`.
- This is the most-depended-upon foundation WP for write/convert verticals (every WP that emits or validates a tree imports these types). Land it early. The PHP authoritative validator (WP-P03) consumes the SAME schemas/fixtures but lives in PHP — no shared TS file, so parallel-safe.
