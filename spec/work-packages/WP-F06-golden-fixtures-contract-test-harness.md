---
id: WP-F06
title: Golden-fixtures + contract-test harness (fixtures dir, runners, PHP dry_run round-trip, Inspector smoke)
layer: foundation
phase: foundation
status: planned
depends_on:
  - WP-F01
  - WP-F03
  - WP-F05
files_owned:
  - packages/shared/fixtures/README.md
  - packages/shared/fixtures/envelope.schema.json
  - packages/shared/fixtures/corpus.manifest.json
  - packages/shared/fixtures/trees/v4/valid/.gitkeep
  - packages/shared/fixtures/trees/v4/invalid/.gitkeep
  - packages/shared/fixtures/trees/v3/valid/.gitkeep
  - packages/shared/fixtures/trees/v3/invalid/.gitkeep
  - packages/shared/fixtures/trees/design/.gitkeep
  - packages/shared/fixtures/schemas/.gitkeep
  - packages/shared/fixtures/html/.gitkeep
  - packages/shared/fixtures/roundtrip/.gitkeep
  - packages/shared/fixtures/envelopes/.gitkeep
  - packages/server/src/test-harness/fixture-loader.ts
  - packages/server/src/test-harness/prefilter-subset.test.ts
  - packages/server/src/test-harness/dry-run-roundtrip.contract.ts
  - packages/server/src/test-harness/roundtrip-identity.contract.ts
  - packages/server/src/test-harness/inspector-smoke.ts
  - packages/server/src/test-harness/index.ts
  - scripts/fixtures-validate.mjs
  - scripts/fixtures-snapshot-schemas.mjs
  - plugin/elementor-ultra-mcp/tests/bootstrap.php
  - plugin/elementor-ultra-mcp/tests/class-fixture-loader.php
  - plugin/elementor-ultra-mcp/tests/test-dry-run-fixtures.php
  - plugin/elementor-ultra-mcp/phpunit.xml.dist
contract_refs:
  - spec/contracts/14-fixtures-harness.md (FULL — directory layout, envelope, dry_run round-trip, pre-filter subset, drift, corpus, round-trip identity, Inspector smoke, scripts)
  - spec/contracts/11-authoring-contract.md (ElementNode shapes that fixtures embed)
  - spec/contracts/12-error-taxonomy.md (expect.errors[] are taxonomy codes)
  - spec/contracts/13-tool-catalog.md §5.2 (lean ★ set smoked), §1/§2/§3 (tools/resources/prompts)
  - spec/01-architecture.md §4.4 (integration gates at wave boundaries)
estimate: L
---

## Summary

Build the golden-fixtures + contract-test harness exactly as `14-fixtures-harness.md` specifies: the single fixture directory tree under `packages/shared/fixtures/`, the fixture envelope schema, the fixture loaders (TS + PHP) that read ONE copy of every golden tree, and the runner skeletons for the five suite families (dry_run round-trip, pre-filter subset, round-trip identity, HTML corpus hook, Inspector smoke) plus the `fixtures:validate` and `fixtures:snapshot-schemas` scripts. It seeds a MINIMAL bootstrap fixture set so the harness runs green on a stub; the per-widget/per-section corpus is filled in by the QA WPs (WP-Q01..Q05), which ADD fixture files only.

## Interface / Contract

- **Fixture directory** `packages/shared/fixtures/` with the LOCKED layout (`14-fixtures-harness.md §1`): `trees/{v4,v3,design}`, `schemas/`, `html/sections/`, `roundtrip/`, `envelopes/`, `corpus.manifest.json`. This WP OWNS the directory + runner; other WPs add fixtures via NEW files only (`14-fixtures-harness.md §11`).
- **`envelope.schema.json`.** The fixture envelope (`14-fixtures-harness.md §2`): `$fixture, id, kind(tree|design|html|roundtrip|smoke), generation(v4|v3|mixed), title, expect{valid,errors[]}, requires{experiments[],pro,min_elementor}, tree[], settings{}, prefilter{verdict:accept|reject|defer}`. `expect.errors[]` are SCREAMING_SNAKE_CASE taxonomy codes (never raw throw strings).
- **TS fixture loader (`fixture-loader.ts`).** Reads/validates fixtures against the envelope + the five authoring JSON Schemas (WP-F03); filters by `requires` capability gates (skips unmet).
- **PHP fixture loader (`tests/class-fixture-loader.php`).** Reads the SAME `packages/shared/fixtures/` tree from wp-env so there is exactly one copy.
- **Runners:**
  - `dry-run-roundtrip.contract.ts` + `tests/test-dry-run-fixtures.php` — the AUTHORITATIVE round-trip (`14-fixtures-harness.md §3`): PHP `Validator::dry_run()` verdict == `expect.valid`; on invalid, `error.code` set == `expect.errors` (set comparison); the TS mirror calls live `page.dry_run` over REST and asserts the same. Render-assertion (S1 step-3) is included but `xfail`/`skip` with a reason until WP-S01 PASS.
  - `prefilter-subset.test.ts` — pre-filter accept/reject/defer subset invariant (`§4`) + the corpus meta-invariant (`accept⇒valid`, `reject⇒invalid`).
  - `roundtrip-identity.contract.ts` — build→get_structure→normalize equality (`§7`).
  - `inspector-smoke.ts` — drive `@modelcontextprotocol/inspector` (CLI or thin SDK client) over stdio: `tools/list` has the lean ★ set; each ★ tool called with `envelopes/smoke.<tool>.json`; each resource read; all four prompts listed (`§8`).
- **Scripts (names are contract, `14-fixtures-harness.md §10`):** `pnpm fixtures:validate` (`scripts/fixtures-validate.mjs`), `pnpm fixtures:snapshot-schemas` (`scripts/fixtures-snapshot-schemas.mjs`). This WP wires these package scripts. The HTML corpus runner (`§6`) and schema-drift job (`§5`) consume this harness but are owned by WP-Q04 / WP-Q02 respectively (they add their runner files); F06 provides the loader + manifest they read.

## Dependencies & Inputs

- Upstream: WP-F01 (scaffold, wp-env, vitest, PHPUnit deps), WP-F03 (authoring types + JSON Schemas + normalizer that fixtures validate against), WP-F05 (taxonomy codes for `expect.errors[]` + capabilities `requires` gating + capability fixtures).
- Code dependency on the PHP `Validator::dry_run()` (WP-P03) and the live `page.dry_run` tool (WP-T) for the AUTHORITATIVE round-trip and the smoke suite. To let F06 land in Wave 1 before those exist, the runners are SKELETONS with a feature-detect: if the validator/tool is absent they report SKIP (not fail), and a follow-up enablement (in WP-P03/WP-T's DoD) flips them on. Declare WP-P03 as a downstream consumer, not an upstream blocker, of the harness skeleton.
- Contracts: `14-fixtures-harness.md` (full); `11`, `12`, `13 §5.2/§1/§2/§3`; `01-architecture.md §4.4`.
- Elementor APIs (cited): the round-trip exercises `Validator::dry_run` → `create_element_instance()` + `get_data_for_save()` try/catch (`has-atomic-base.php:88-117`); render assertion exercises prime-css (`atomic-styles-manager.php:47-150`).

## Detailed Requirements

1. **Single fixture tree.** Create the exact directory layout (`§1`) with `.gitkeep`s; both runners read `packages/shared/fixtures/` so there is one copy of every golden tree (`§1` rationale).
2. **Envelope schema + validation.** `envelope.schema.json` per `§2`; `fixtures:validate` schema-validates EVERY fixture file against the envelope AND the embedded `tree[]` against WP-F03's authoring schemas (pure, no WordPress, `§10`).
3. **Seed minimal bootstrap fixtures** so the harness is green on a stub: at least one `trees/v4/valid` (e.g. `e-heading.basic.json`), one `trees/v4/invalid` (e.g. `e-heading.bad-tag-enum.json` → `expect.errors:[ATOMIC_SETTINGS_INVALID]`, `prefilter.verdict:reject`), one `roundtrip/*.json`, one `envelopes/smoke.elementor.page.dry_run.json`. (The FULL per-widget/per-section corpus is WP-Q01/Q04 — they add files.)
4. **Authoritative round-trip** (`§3`): PHP verdict == `expect.valid`; invalid → error-code set match (order-independent). TS mirror asserts the same over REST. Render assertion = S1 step-3, gated `xfail`/`skip` until S01 PASS with a clear reason string.
5. **Pre-filter subset** (`§4`): assert `prefilter.verdict` per fixture; assert corpus meta-invariant (`accept⇒valid`, `reject⇒invalid`). A violating fixture fails CI.
6. **Round-trip identity** (`§7`): normalize input + fetched tree (tolerate `_cssid`, html-v3 normalization, structural id compare); assert equality; run as admin (content-sanitizer exempt).
7. **Inspector smoke** (`§8`): lean ★ set present + enabled; minimal payload per ★ tool; resources readable; four prompts listed; mutating smokes target a disposable draft created/trashed in setup/teardown; capability-gated skips.
8. **Snapshot script** (`§5` support): `fixtures:snapshot-schemas` regenerates `packages/shared/fixtures/schemas/*.schema.json` from a live wp-env install (manual, reviewed; NEVER auto-updates in the drift job). The DRIFT JOB itself is WP-Q02.
9. **PHPUnit bootstrap** (`tests/bootstrap.php`, `phpunit.xml.dist`) wired to run inside wp-env with Elementor + Pro active and the experiments from each fixture's `requires` activatable (`§3 step 1`).
10. **Parallel-build guarantees** (`§11`): F06 owns the runner + directory; the schema baselines are generated artifacts referenced read-only by others; every WRITE-tree fixture's `expect.valid` is PHP-derived (single truth).

## Implementation Notes

- The render assertion (S1 regression) MUST emit a clear skip reason ("blocked on WP-S01 PASS") so the gate is visible; WP-Q06 owns the standalone render-assertion suite once S01 passes — F06 only carries the per-fixture step-3 in the dry_run suite (`§3 step 3`).
- Keep the loader the single point that interprets the envelope so TS and PHP agree byte-for-byte; the PHP loader mirrors the TS loader's `requires`-skip logic.
- The Inspector smoke uses the lean profile (`ULTRA_TOOLS=lean`); pointer env `WP_URL/WP_USER/WP_APP_PASSWORD` per `13-tool-catalog.md §5.4`.
- Do NOT put the schema-drift job logic here (WP-Q02) or the HTML corpus assertions (WP-Q04); F06 provides the loader + `corpus.manifest.json` shape they consume. `corpus.manifest.json` here is the empty/sample manifest; sections are added by WP-Q04.
- Fixtures dir is OWNED here; downstream WPs add `*.json` files in disjoint paths (each owns its widget/section slice) — this is the §11 invariant the assembler relies on.

## Acceptance Criteria

- [ ] `packages/shared/fixtures/` matches the LOCKED layout (`§1`); both TS and PHP loaders read this single directory.
- [ ] `envelope.schema.json` matches `§2`; `pnpm fixtures:validate` schema-validates every fixture against the envelope + authoring schemas and is green on the seeded fixtures.
- [ ] Seeded bootstrap fixtures exist (≥1 valid, ≥1 invalid with taxonomy error codes, ≥1 roundtrip, ≥1 smoke); harness runs green on them.
- [ ] dry_run round-trip runner asserts verdict + error-code set; TS mirror asserts the same over REST; render assertion present but skipped with reason until S01.
- [ ] pre-filter subset runner asserts per-fixture verdict + the corpus meta-invariant.
- [ ] round-trip identity runner normalizes + asserts structural equality.
- [ ] Inspector smoke lists the lean ★ set, calls each with its smoke payload, reads resources, lists 4 prompts.
- [ ] `pnpm fixtures:snapshot-schemas` regenerates the schema baseline from a live install and never runs in the drift job.
- [ ] PHPUnit bootstrap runs under wp-env; `composer test:php` discovers `test-dry-run-fixtures.php`.
- [ ] All harness package scripts (`fixtures:validate`, `fixtures:snapshot-schemas`) are runnable; PHPCS/lint clean.

## Tests Required

- The harness IS the test infrastructure; its self-tests: `fixtures:validate` on the seeded set; a meta-test that a deliberately malformed fixture (bad envelope, raw-throw-string in `expect.errors`) is REJECTED by `fixtures:validate`.
- A test that the TS loader and PHP loader skip the same fixtures given the same capability payload.
- Inspector smoke self-check against a stub server (lean set present).

## Parallelization Notes

- Wave 1, parallel-safe with WP-F02/F04 (disjoint files; F06 owns `fixtures/*` + `test-harness/*` + `tests/*` + the two fixture scripts). Depends on WP-F03 (schemas/types/normalizer) and WP-F05 (codes/capabilities) — sequence after those.
- WP-F07 (CI) calls F06's scripts. WP-Q01 (golden trees) / WP-Q03 (smoke corpus) / WP-Q04 (HTML corpus) / WP-Q05 (round-trip) / WP-Q02 (drift) all ADD fixture files + their own runner files and consume F06's loader — disjoint from F06's runner files by construction (`§11`).
- The AUTHORITATIVE dry_run round-trip is fully live only after WP-P03 (validator) + the TS `page.dry_run` tool exist; the skeleton skips gracefully until then.

## Spike-Verified Corrections (Wave 1)

- **[S04/C3/R3]** The harness MUST include a settings-merge regression test for `page.update_settings` / `PUT /documents/{id}/settings`: (1) seed a page with ≥3 settings of different types including one nested map (e.g. `background_color`, `background_background`, nested `padding`); (2) PUT a patch updating exactly ONE top-level key and ONE nested sub-key, omitting the rest; (3) assert omitted top-level key AND omitted nested sibling (e.g. `padding.left`) survive unchanged and the patched keys updated — this fails if the controller used a bare `save()` (REPLACE) instead of `update_settings()` (deep merge). The test MUST `wp_set_current_user(<admin id>)` first or `save()`/`update_settings()` no-op via `is_editable_by_current_user()`. Recommended: a repeater-specific assertion (seed a 2-row repeater, patch an unrelated key, assert both rows survive) documenting the `array_replace_recursive` shorter-list caveat.
- **[R8]** Fixtures MUST use strictly-typed atomic prop envelopes — the authoritative Elementor validator rejects bare strings. Verified failures to encode in golden fixtures: a bare `"h1"` tag → `tag: invalid_value` (a tag MUST be `{"$$type":"string","value":"h1"}`); a bare title/text string → `title: invalid_value` (MUST be the `html-v3` envelope); a too-short local-style label (e.g. `"l"`) → `label: class_name_too_short` (min length applies). Envelope `$$type` MUST equal the prop's `get_key()` (`has-transformable-validation.php`). Freeze these typed envelopes in fixtures so they pass the live validator.
