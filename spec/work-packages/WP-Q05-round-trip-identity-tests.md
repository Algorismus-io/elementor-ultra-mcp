---
id: WP-Q05
title: QA — round-trip identity tests (build → get_structure → normalize → equal)
layer: qa
phase: MVP
status: planned
depends_on:
  - WP-F03
  - WP-F06
  - WP-P03
files_owned:
  - packages/server/src/test-harness/roundtrip-identity.test.ts
  - packages/server/src/authoring/contract.normalize.test.ts
  - packages/shared/fixtures/roundtrip/e-heading.basic.roundtrip.json
  - packages/shared/fixtures/roundtrip/hero-section.roundtrip.json
  - packages/shared/fixtures/roundtrip/e-image.id-only.roundtrip.json
  - packages/shared/fixtures/roundtrip/styles.local-and-global.roundtrip.json
  - packages/shared/fixtures/roundtrip/v3.container.roundtrip.json
  - packages/shared/fixtures/roundtrip/INDEX.md
contract_refs:
  - spec/contracts/14-fixtures-harness.md §7 (round-trip identity — LOCKED), §1 (roundtrip layout)
  - spec/contracts/11-authoring-contract.md (normalizer accounts for _cssid, html-v3, id minting)
  - spec/contracts/13-tool-catalog.md §1.1 (page.build, page.get_structure)
  - RESEARCH.md §9.3e (round-trip identity), §4.1 (_cssid injection), §2.1/§6.6 (content-sanitizer)
estimate: M
---

## Summary

Implement the round-trip identity test (`14-fixtures-harness.md §7`): for each fixture, `page.build` with `input_tree`, `page.get_structure`, normalize BOTH with the shared normalizer (accounting for content-sanitizer title rewrite, html-v3 normalization, `_cssid` injection, ID minting — compare structurally not by literal id), and assert the normalized fetched tree equals `normalized_expected`. This proves `build → read → normalize → equal` so production diffs don't show spurious changes (M2 safe-edit). Also exercises the WP-F03 normalizer directly — the unit test `contract.normalize.test.ts` lives next to the module it tests (`packages/server/src/authoring/contract.ts`, which exports `normalize()`); it imports `{ normalize }` from `./contract.js` and creates no new module.

## Interface / Contract

- **Fixtures** `roundtrip/*.json` (`14-fixtures-harness.md §1`), each carrying `{ input_tree, normalized_expected }` (kind:`roundtrip`).
- **`roundtrip-identity.test.ts`.** Per fixture (`§7`): `page.build(input_tree)` → `page.get_structure` → `normalize(input)` + `normalize(fetched)` → assert equal. Run as ADMIN so the content-sanitizer is exempt (it rewrites `title` for non-admins, RESEARCH §2.1/§6.6). Tolerate `_cssid` injection (RESEARCH §4.1), html-v3 normalization, and compare ids structurally (positionally), not literally (RESEARCH §4.3/§4.6).
- **`authoring/contract.normalize.test.ts`.** Unit tests for the WP-F03 `normalize()` function exported by `packages/server/src/authoring/contract.ts` (NO new `normalize.ts` module is created — F03 owns `contract.ts`/`envelopes.ts`/`ids.ts`/`prefilter.ts`; the test imports `{ normalize }` from `./contract.js`): idempotence (`normalize(normalize(x))==normalize(x)`), `_cssid` tolerance, html-v3 normalization, structural id comparison helper.

## Dependencies & Inputs

- Upstream: WP-F03 (the `normalize()` function + authoring types), WP-F06 (fixture dir + loader; Q05 ADDS `roundtrip/**` + the test, never edits F06's runner), WP-P03 (the validator backing `page.build`/`page.dry_run`). The test calls `page.build`/`page.get_structure` (Pages vertical, WP-T##) — feature-detect/skip until those exist, then enable.
- Contracts: `14-fixtures-harness.md §7/§1`; `11-authoring-contract.md` (normalizer rules); `13-tool-catalog.md §1.1`; RESEARCH §9.3e/§4.1/§2.1/§6.6.
- Elementor APIs (cited): `get_elements_data()` autosave/draft merge (`document.php:1124-1152`) — `get_structure` reads through this; `_cssid` injection (`has-atomic-base.php:310-321`); content-sanitizer title rewrite (RESEARCH §2.1/§6.6).

## Detailed Requirements

1. **Fixtures** covering: a basic atomic widget, the composite hero, an image (id-only), local+global styles, and a V3 container — each with `input_tree` + `normalized_expected`.
2. **Build→read→normalize→equal** per `§7`; run as admin (content-sanitizer exempt).
3. **Normalizer tolerances:** `_cssid` injection tolerated; html-v3 normalized; ids compared structurally (positional mapping), not by literal value.
4. **Normalizer unit tests:** idempotence, tolerance behaviors, structural-id helper.
5. **No spurious diffs:** a successful round-trip MUST produce zero structural delta — this is the M2 guarantee that production edits don't show phantom changes (`00-product-overview.md §6`).
6. **Disposable docs:** each round-trip creates a draft, builds into it, reads, then trashes in teardown.
7. **`requires` gates** so atomic-off/free-only installs skip appropriately.
8. **`INDEX.md`** cataloging fixtures.

## Implementation Notes

- The normalizer is owned by WP-F03 (`authoring/contract.ts`, which exports `normalize()`); Q05's `authoring/contract.normalize.test.ts` tests it (importing `{ normalize }` from `./contract.js`) but does NOT modify it and does NOT create any `authoring/normalize.ts` module (disjoint — Q05 owns the test file, F03 owns the implementation). If the normalizer needs a behavior change, that is a WP-F03 change, not Q05.
- Compare ids structurally: build a positional id-map between input and fetched, then assert equality under that mapping (RESEARCH §4.6 — ids are minted, not preserved literally on build).
- Q05 ADDS `roundtrip/**` + its test files only; never edits F06's runner or other QA fixtures (disjoint).
- Run as admin (the corpus assumes admin so the content-sanitizer is exempt, `14-fixtures-harness.md §7 step 3`).

## Acceptance Criteria

- [ ] ≥5 round-trip fixtures (`input_tree` + `normalized_expected`) covering atomic widget, composite, image, local+global styles, V3.
- [ ] `roundtrip-identity.test.ts` builds → reads → normalizes → asserts structural equality, as admin, tolerating `_cssid`/html-v3/minted-ids.
- [ ] `authoring/contract.normalize.test.ts` asserts normalizer idempotence + tolerances + structural-id helper, importing `normalize()` from `contract.ts` (no orphan `normalize.ts` module created).
- [ ] A successful round-trip shows zero structural delta (no spurious diffs).
- [ ] Disposable docs created/trashed per test; free-only/atomic-off skips honored.
- [ ] `pnpm test:contract` runs the round-trip identity suite in the wp-env stage.

## Tests Required

- The round-trip suite IS the test. Self-validate: a faithful build/read round-trips equal; an injected mutation (e.g. dropped prop) produces a non-equal delta.
- Normalizer unit tests (idempotence, tolerances).

## Parallelization Notes

- Wave 2+, MVP phase. Parallel-safe with all other QA WPs (Q05 owns the 5 explicit `roundtrip/*.roundtrip.json` fixtures + `roundtrip/INDEX.md` + `roundtrip-identity.test.ts` + `authoring/contract.normalize.test.ts`; disjoint from Q01 `trees/**`, Q02 `schemas/**`, Q03 `envelopes/**`, Q04 `html/**`, and from WP-F03's `authoring/contract.ts` implementation). Depends on WP-F03 + WP-F06 + WP-P03.
- Needs `page.build`/`page.get_structure` (Pages vertical) live; feature-detect/skip until then. Backs the M2 safe-edit guarantee.
