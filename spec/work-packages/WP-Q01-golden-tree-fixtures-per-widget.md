---
id: WP-Q01
title: QA — golden-tree fixtures per atomic widget (+ V3 + design) with dry_run verdicts
layer: qa
phase: MVP
status: planned
depends_on:
  - WP-F03
  - WP-F05
  - WP-F06
  - WP-P03
files_owned:
  - packages/shared/fixtures/trees/v4/valid/e-heading.basic.json
  - packages/shared/fixtures/trees/v4/valid/e-paragraph.basic.json
  - packages/shared/fixtures/trees/v4/valid/e-button.with-link.json
  - packages/shared/fixtures/trees/v4/valid/e-image.id-only.json
  - packages/shared/fixtures/trees/v4/valid/e-div-block.flex-row.json
  - packages/shared/fixtures/trees/v4/valid/e-flexbox.column.json
  - packages/shared/fixtures/trees/v4/valid/hero-section.composite.json
  - packages/shared/fixtures/trees/v4/valid/styles.states-breakpoints.json
  - packages/shared/fixtures/trees/v4/invalid/e-heading.bad-tag-enum.json
  - packages/shared/fixtures/trees/v4/invalid/e-div-block.image-src-id-and-url.json
  - packages/shared/fixtures/trees/v4/invalid/e-button.missing-required-prop.json
  - packages/shared/fixtures/trees/v4/invalid/local-style.id-not-in-classes.json
  - packages/shared/fixtures/trees/v4/invalid/duplicate-element-id.json
  - packages/shared/fixtures/trees/v4/invalid/unknown-widget-type.json
  - packages/shared/fixtures/trees/v3/valid/heading.basic.json
  - packages/shared/fixtures/trees/v3/valid/container.flex.json
  - packages/shared/fixtures/trees/v3/invalid/unknown-widgettype.json
  - packages/shared/fixtures/trees/design/global-classes.upsert-diff.json
  - packages/shared/fixtures/trees/design/variables.batch.json
  - packages/shared/fixtures/trees/INDEX.md
contract_refs:
  - spec/contracts/14-fixtures-harness.md §1 (tree layout), §2 (envelope), §3 (dry_run round-trip), §4 (pre-filter verdict)
  - spec/contracts/11-authoring-contract.md (ElementNode shapes, invariants)
  - spec/contracts/12-error-taxonomy.md §3 (error codes for expect.errors[])
  - SUPPLEMENT.md §B.2 (per-widget prop tables — one+ fixture per atomic widget), §B (Style-Schema)
  - spec/contracts/10-rest-api.md (design diff-PUT body, variables batch shapes)
estimate: L
---

## Summary

Author the golden-tree fixture corpus: at least one VALID fixture per supported atomic widget (SUPPLEMENT §B.2), composite trees (the hero), state/breakpoint style variants, the canonical INVALID fixtures (one per failure-mode error code), V3 valid/invalid, and the design diff-PUT + variables-batch fixtures. Each fixture's `expect.valid` + `expect.errors[]` is PHP-`dry_run`-authoritative and each carries a `prefilter.verdict`. These fixtures back WP-F06's round-trip + pre-filter suites and the schema-drift / render-assertion suites.

## Interface / Contract

- Every file follows the LOCKED envelope (`14-fixtures-harness.md §2`): `$fixture, id, kind:"tree", generation, title, expect{valid,errors[]}, requires{experiments,pro,min_elementor}, tree[], settings, prefilter{verdict}`.
- `expect.errors[]` use SCREAMING_SNAKE_CASE taxonomy codes ONLY (`12-error-taxonomy.md §6`): e.g. `ATOMIC_SETTINGS_INVALID`, `ATOMIC_STYLES_INVALID`, `IMAGE_SRC_XOR_VIOLATION`, `LOCAL_STYLE_UNLINKED`, `DUPLICATE_ELEMENT_ID`, `UNKNOWN_WIDGET_TYPE`. NEVER raw Elementor throw strings (`14-fixtures-harness.md §2`).
- Each fixture's `expect.valid` is the PHP `dry_run` verdict (`14-fixtures-harness.md §3`); `prefilter.verdict` satisfies the meta-invariant (`accept⇒valid`, `reject⇒invalid`, else `defer`, `§4`).
- The hero composite is `e-div-block > e-heading + e-paragraph + e-button` with ≥1 local style + ≥1 global class (the M1 build-a-hero shape).

## Dependencies & Inputs

- Upstream: WP-F03 (authoring types/schemas the fixtures must validate against), WP-F05 (taxonomy codes + capabilities `requires`), WP-F06 (fixture dir + envelope schema + loaders + runners — Q01 ADDS files into F06's tree, never edits the runner, `14-fixtures-harness.md §11`), WP-P03 (the AUTHORITATIVE `dry_run` validator that establishes each `expect.valid` — REQUIRED so verdicts are real, not guessed).
- Contracts: `14-fixtures-harness.md §1–4`; `11-authoring-contract.md`; `12-error-taxonomy.md §3`; SUPPLEMENT §B.2/§B; `10-rest-api.md` (diff-PUT + batch shapes).
- Elementor APIs (cited via the validator): atomic instantiation/validation `has-atomic-base.php:88-117`; `get_props_schema()` post-filter `:310-321`; image-src XOR `image-src-prop-type.php:36-44`; html-v3 `html-v3-prop-type.php:91`.

## Detailed Requirements

1. **One+ VALID fixture per atomic widget** in SUPPLEMENT §B.2 (heading, paragraph, button, image, div-block, flexbox, and any others enumerated there). Use real typed envelopes + correct `$$type` per the per-widget prop tables.
2. **Composite hero** (`hero-section.composite.json`) — the M1 shape; reuse/align with the WP-S01 hero fixture if produced.
3. **State/breakpoint variants** (`styles.states-breakpoints.json`) exercising `StyleState` `[null,hover,active,focus,focus-visible,checked,e--selected]` + `BreakpointKey` variants.
4. **Invalid fixtures — one per failure mode:** bad tag enum → `ATOMIC_SETTINGS_INVALID`; image-src id-and-url → `IMAGE_SRC_XOR_VIOLATION`; missing required prop → `ATOMIC_SETTINGS_INVALID`; local-style id not in classes → `LOCAL_STYLE_UNLINKED`; duplicate element id → `DUPLICATE_ELEMENT_ID`; unknown widget type → `UNKNOWN_WIDGET_TYPE`. Each with the correct `prefilter.verdict:reject` (or `defer` where the pre-filter cannot decide).
5. **V3** valid (heading, container.flex) + invalid (unknown widgettype — NB legacy unknowns DROP, not throw; encode the expected behavior per `14-fixtures-harness.md §1`).
6. **Design fixtures:** `global-classes.upsert-diff.json` (the diff-PUT body shape `{context,changes:{added,deleted,modified,order},items,order}` per `10-rest-api.md`) and `variables.batch.json` (the batch op shape with watermark).
7. **Establish each verdict via PHP `dry_run`** (WP-P03) — do not guess; run each fixture through the validator and record the true `expect.valid` + error-code set.
8. **`requires` gates** set correctly (`e_atomic_elements` for v4, `pro:true` where Pro-only, `min_elementor`) so the corpus skips appropriately on free-only/atomic-off installs.
9. **`INDEX.md`** cataloging each fixture → widget/scenario → expected verdict, for maintainers.

## Implementation Notes

- Q01 ADDS files only into F06's `fixtures/trees/**` tree; it never edits F06's runner or other QA WPs' fixtures (disjoint by widget/scenario slice, `14-fixtures-harness.md §11`).
- Authoring shapes MUST come from `11-authoring-contract.md` + SUPPLEMENT §B.2 prop tables — never invent props/`$$type` keys (`15-engineering-standards.md §2.6`).
- For invalid fixtures, the `expect.errors[]` set must equal what WP-P03's validator actually returns (set comparison, order-independent, `14-fixtures-harness.md §3.2.d`).
- Keep the hero composite aligned with the render-assertion fixture (WP-Q06) so M1 (`build-a-hero-renders-styled`) tests share it.

## Acceptance Criteria

- [ ] ≥1 valid fixture per atomic widget in SUPPLEMENT §B.2; the composite hero present.
- [ ] State/breakpoint variant fixture exercises the full `StyleState` set + breakpoints.
- [ ] One invalid fixture per failure-mode error code, each with the correct taxonomy code(s) and `prefilter.verdict`.
- [ ] V3 valid + invalid + design diff-PUT + variables-batch fixtures present.
- [ ] Every fixture validates against the envelope (`pnpm fixtures:validate`) AND its `tree[]` against WP-F03's authoring schemas.
- [ ] Every `expect.valid`/`expect.errors[]` matches WP-P03's `dry_run` (round-trip green in `pnpm test:contract` / `composer test:php`).
- [ ] The pre-filter subset meta-invariant holds across the corpus (`pnpm test:unit` pre-filter suite green).
- [ ] `requires` gates make the corpus green on free-only + atomic-off installs (unmet → skipped).

## Tests Required

- These fixtures are consumed by WP-F06's existing runners (round-trip dry_run, pre-filter subset, round-trip identity). Q01 adds NO new runner — it adds fixtures + `INDEX.md`.
- A `fixtures:validate` pass over the new files; a `test:contract` + `composer test:php` pass establishing verdicts.

## Parallelization Notes

- Wave 2+, MVP phase. Parallel-safe with all other QA WPs (each owns disjoint fixture files): Q01 owns `trees/**`, Q03 owns `envelopes/**`, Q04 owns `html/**`, Q05 owns `roundtrip/**`, Q02 owns `schemas/**` baseline + drift runner. Depends on WP-P03 (validator) for real verdicts.
- Pro-only widget fixtures (if any) coordinate with the Pro vertical via `requires.pro` — no file overlap.

## Spike-Verified Corrections (Wave 1)

- **[S02]** The fixture suite MUST include a template round-trip assertion (reuse `spec/spikes/scripts/s02-assert-roundtrip.mjs` + fixture `spec/spikes/fixtures/s02-atomic-block.json`): save a V4 atomic block as a template, read it back, and insert it, asserting structure + atomic local `styles` + class refs survive with REMAPPED element ids and REMAPPED local-style ids and the global-class relation merging without orphan or duplicate. The insert step MUST exercise the two-step `get_data` → `process_global_styles({content, global_classes, import_mode})` path (not `save_item` alone).
- **[S02/R5]** Fixtures and assertions MUST NOT assume stable local-style ids — Elementor regenerates element ids AND dependent local-style ids (`e-<newElementId>-<rand>`) on every save. Assert by selector/structure and by the returned id_map, never by a hardcoded id expected to survive a round-trip.
- **[R8]** Golden fixtures MUST use strictly-typed atomic prop envelopes (`$$type` equal to the prop `get_key()`); bare strings fail the authoritative validator (`tag: invalid_value`, `title: invalid_value`, local-style `label: class_name_too_short`). Heading `tag` = `{"$$type":"string","value":"h1"}`; title/text = the `html-v3` envelope; `classes` = `{"$$type":"classes","value":[...]}`. Freeze these so fixtures pass the live validator.
