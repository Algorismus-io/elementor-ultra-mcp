---
id: WP-S02
title: Spike — template-library save/import of atomic V4 (Source_Local::save_item correctness)
layer: spike
phase: foundation
status: planned
depends_on:
  - WP-F01
files_owned:
  - spec/spikes/S02-template-library-atomic-save.md
  - spec/spikes/scripts/s02-save-template.php
  - spec/spikes/scripts/s02-import-template.php
  - spec/spikes/scripts/s02-assert-roundtrip.mjs
  - spec/spikes/fixtures/s02-atomic-block.json
contract_refs:
  - RESEARCH.md §0 (S2 row), §5 (templates note line ~486), §10 OQ#3/#8 (import remap unverified)
  - spec/contracts/15-engineering-standards.md §6 (S2 gates atomic template WPs)
  - spec/contracts/12-error-taxonomy.md (IMPORT_REMAP_FAILED)
estimate: M
---

## Summary

Determine whether the template library (`POST template-library/templates` / `Source_Local::save_item`) processes atomic V4 elements AND registers global-class relations the same way an editor save does — including id remap, atomic `styles`/local-class id handling, and global-class merge on import. Gates `templates.save`, `templates.insert_into_page`, `templates.import` atomic correctness and reusable-block reuse.

## Interface / Contract

- **QUESTION (RESEARCH.md §0, S2):** Does `POST template-library/templates` / `Source_Local::save_item` process atomic elements and register global-class relations identically to editor save? Do atomic `styles`/local-class ids remap and global-class relations merge correctly on import?
- **METHOD:** (1) Build an atomic block (fixture `s02-atomic-block.json`) with local styles + a referenced global class; (2) save it as a template (`s02-save-template.php`); (3) re-import into another document (`s02-import-template.php`); (4) `s02-assert-roundtrip.mjs` asserts structure + atomic styles + class refs survive with REMAPPED element ids + remapped local-style ids + correct global-class relation (no orphaned/duplicated classes).
- **PASS CRITERION (RESEARCH.md §0):** Saved-then-reimported block preserves structure + styles + class refs with remapped ids; global-class relations merge without orphan/dup; no `IMPORT_REMAP_FAILED` condition.
- **GATES:** `templates.save`, `templates.insert_into_page`, `templates.import` atomic-correctness WPs (the Templates/kits vertical). Until S02 PASS those WPs treat atomic id-remap/global-class-merge on import as unverified and must implement defensively.

## Dependencies & Inputs

- Upstream: WP-F01 (wp-env). No product code dependency.
- Contracts: RESEARCH.md §0 (S2), §5 templates note (`Source_Local::save_item` regenerates ids; `import` adds image sideload + `on_import` remap; atomic styles/local-class id remap + global-class merge "unverified — needs spike"), §10 OQ#3/#8; `15-engineering-standards.md §6`; `12-error-taxonomy.md` `IMPORT_REMAP_FAILED`.
- Elementor APIs (cited, to trace during spike): `Source_Local::save_item`, `atomic-widgets/import-export`, `global-classes/import-export-utils`, `on_import` remap path. Document exact `path:line` of the remap entry points discovered.

## Detailed Requirements

1. Author `s02-atomic-block.json` per the FROZEN authoring shape with ≥2 local styles + ≥1 global class so remap + relation handling are exercised.
2. Save as template via the real document pipeline; capture the template id + its stored `_elementor_data`.
3. Import into a fresh draft doc; capture remapped element ids, remapped local-style ids, and the global-class relation state on the target kit.
4. Assert (a) structural equality (modulo ids), (b) atomic `styles` maps preserved + local-style ids mirrored into `classes`, (c) global-class reference resolves (merged, not duplicated/orphaned), (d) any image attachment sideloaded/remapped.
5. Record in `S02-...md`: PASS/FAIL, the discovered remap `path:line`, the merge semantics, and the `IMPORT_REMAP_FAILED` conditions the Templates vertical must handle.
6. Note any divergence from editor save (e.g. if `Source_Local::save_item` drops atomic styles) — this is the load-bearing finding.

## Implementation Notes

- Throwaway scripts under `spec/spikes/scripts/`; not product code. The Templates vertical WP implements its own controller/tool informed by this note.
- Trace the atomic import path during the spike and record `path:line` (the contract says it is unverified — the spike's job is to verify it).
- Reuse the S01 prime-css approach to confirm the imported block also renders styled (cross-check, optional but valuable).

## Acceptance Criteria

- [ ] An atomic block is saved as a template and re-imported into another doc, reproducibly.
- [ ] `s02-assert-roundtrip.mjs` asserts structure + atomic styles + class refs survive with remapped ids and a correctly merged global-class relation.
- [ ] `S02-...md` records PASS/FAIL, the discovered remap `path:line`, merge semantics, and `IMPORT_REMAP_FAILED` conditions.
- [ ] Spike-gate status for S2 updated so atomic template WPs can start.
- [ ] A reusable atomic-block fixture is left for the Templates vertical / WP-Q01.

## Tests Required

- The spike IS the test (round-trip assertion output + written note). No product unit tests.
- Leave the round-trip assertion reusable for the Templates vertical's contract tests.

## Parallelization Notes

- Wave 0 (spike week), parallel-safe with all other spikes (disjoint `spec/spikes/*` files). Depends only on WP-F01.
- GATES the Templates/kits vertical's atomic-correctness WPs (gate dependency, not file overlap).
