---
id: WP-F07
title: CI pipeline including the schema-drift required check + SDK-2.x guard + wp-env matrix
layer: foundation
phase: foundation
status: planned
depends_on:
  - WP-F01
  - WP-F06
files_owned:
  - .github/workflows/ci.yml
  - .github/workflows/drift.yml
  - .github/workflows/release.yml
  - .github/workflows/_setup-node.yml
  - .github/workflows/_setup-wp-env.yml
  - scripts/ci/check-sdk-version.mjs
  - scripts/ci/check-co-author-trailer.mjs
  - scripts/ci/wp-env-up.sh
  - .github/CODEOWNERS
contract_refs:
  - spec/contracts/14-fixtures-harness.md §10 (CI wiring, job order, required drift check, script names)
  - spec/contracts/15-engineering-standards.md §1 (tooling), §4 (per-layer DoD), §5 (branch/commit), §7 (SDK pin guard, Elementor pin)
  - spec/01-architecture.md §4.4 (integration gates at wave boundaries)
estimate: M
---

## Summary

Wire the CI pipeline that enforces every contract gate: the fast no-WordPress jobs (`fixtures:validate`, `test:unit`, lint, format, PHPCS, build, SDK-2.x guard), then the wp-env jobs (`composer test:php`, `test:contract`, `test:drift`, `test:smoke`) in the LOCKED order from `14-fixtures-harness.md §10`. The schema-drift job is configured as a REQUIRED check on PRs touching `packages/shared/schemas/` or the pre-filter. Also wires the SDK-version trap guard, the commit-trailer check, and the release workflow skeleton (consumed by WP-Q08). It owns only CI config + CI helper scripts — it never edits product code or test runners (those are WP-F06/Q##).

## Interface / Contract

- **`.github/workflows/ci.yml`.** Triggered on push + PR. Job order (`14-fixtures-harness.md §10`): Stage 1 (every push, no WordPress) = `pnpm install --frozen-lockfile` → `pnpm lint` + `pnpm format:check` + `pnpm build` + `composer phpcs` + `pnpm fixtures:validate` + `pnpm test:unit` + the SDK-2.x guard. Stage 2 (PR + main) = spin up wp-env → `composer test:php` + `pnpm test:contract` + `pnpm test:smoke`. The drift job (`pnpm test:drift`) is a separate workflow (below) wired as a required check.
- **`.github/workflows/drift.yml`.** The schema-drift job (`14-fixtures-harness.md §5`, owned-as-test by WP-Q02; this WP wires it into CI). Boots wp-env with pinned Elementor + Pro, runs `pnpm test:drift`, fails on any diff. Configured as a REQUIRED status check on PRs that change paths `packages/shared/schemas/**` or `packages/server/src/authoring/prefilter.ts` (path filter + branch-protection note in CODEOWNERS/README).
- **`.github/workflows/release.yml`.** Skeleton release pipeline (tag-triggered): build the npx-distributable server tarball + the plugin zip (the actual packaging logic is WP-Q08; this workflow calls WP-Q08's scripts). Includes the SDK-2.x guard as a release gate.
- **`scripts/ci/check-sdk-version.mjs`.** Fails if any `@modelcontextprotocol/*` `2.x` appears in `pnpm-lock.yaml`, or if `@modelcontextprotocol/sdk` is not `^1.29` (`15-engineering-standards.md §7`).
- **`scripts/ci/check-co-author-trailer.mjs`.** Asserts each commit on the PR branch carries the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer and a Conventional-Commit `wp-<id>` scope (`15-engineering-standards.md §5`). (Advisory by default; required can be toggled.)
- **`scripts/ci/wp-env-up.sh`.** Boots `.wp-env.json`, activates the required experiments for the contract/drift/smoke suites, waits for readiness; reused by all wp-env jobs.
- **Reusable workflows** `_setup-node.yml` (Node 20 + pnpm + cache) and `_setup-wp-env.yml` (Docker + wp-env + Composer) to keep jobs DRY.
- **`.github/CODEOWNERS`** marking `spec/contracts/**` + `packages/shared/schemas/**` as protected (contract changes need review; append-only within a wave, `15-engineering-standards.md §5.5`).

## Dependencies & Inputs

- Upstream: WP-F01 (scaffold, scripts `lint`/`build`/`test:unit`, lockfile, `.wp-env.json`), WP-F06 (the `fixtures:validate`/`test:contract`/`test:drift`/`test:smoke`/`composer test:php` scripts + runners CI invokes).
- Contracts: `14-fixtures-harness.md §10` (job order, required drift check, script names); `15-engineering-standards.md §1/§4/§5/§7`; `01-architecture.md §4.4`.
- Elementor APIs: none directly — CI boots wp-env with pinned Elementor 4.1.1 + Pro 4.1.0 (`15-engineering-standards.md §7`); Pro is provided via a CI secret/artifact (documented placeholder).

## Detailed Requirements

1. **Job order LOCKED** per `14-fixtures-harness.md §10`: no-WordPress fast jobs first (every push), then wp-env jobs (PR + main). Fail-fast on the fast jobs.
2. **Drift as required check.** `drift.yml` runs `pnpm test:drift`; configured (via path filter + documented branch protection) as REQUIRED on PRs changing schema baselines or the pre-filter (`§10` last line). The drift job NEVER regenerates the baseline (that's the manual `fixtures:snapshot-schemas`, WP-F06).
3. **SDK-2.x guard.** `check-sdk-version.mjs` parses the lockfile and fails on any 2.x `@modelcontextprotocol/*`; runs in Stage 1 and in release.
4. **PHPCS + lint + format + build** all gate Stage 1.
5. **wp-env provisioning.** `wp-env-up.sh` activates `e_atomic_elements`, `e_classes`, `e_variables` (and Pro experiments where a Pro matrix leg runs) so the contract/drift/smoke suites have the capabilities their fixtures `require`; free-only leg leaves Pro inactive so `requires.pro` fixtures skip (proving the corpus is green on free installs, `14-fixtures-harness.md §2`).
6. **Matrix (optional but specified):** a free-only leg and a Pro leg so Pro-gated fixtures/smoke run only where Pro is present and skip elsewhere.
7. **Release skeleton.** `release.yml` (tag `v*`) builds artifacts by calling WP-Q08's `pack:server` + `pack:plugin` scripts; includes the SDK guard; does NOT publish without an explicit input (dry-run by default).
8. **Commit/trailer hygiene.** `check-co-author-trailer.mjs` enforces the trailers from `15-engineering-standards.md §5.6` (advisory unless toggled required).
9. **Caching.** Cache pnpm store + Composer + the wp-env Docker layers for speed.

## Implementation Notes

- The drift job is the single most important guard against Elementor version drift (`14-fixtures-harness.md §0/§5`); make its failure message surface the per-widget added/removed/changed props (the test owned by WP-Q02 produces this; CI just reports it).
- Pro is not redistributable — document a CI secret/manual-artifact path for the Pro zip in `_setup-wp-env.yml`; the free-only leg must be fully green without Pro.
- Keep CI config disjoint from runners: F07 calls scripts by their contract names (`14-fixtures-harness.md §10`) and never edits the runner `.ts`/`.php` files (owned by F06/Q##).
- Use reusable workflows to avoid duplicating Node/wp-env setup across `ci.yml`/`drift.yml`/`release.yml`.
- Branch-protection (required-check) configuration is partly a GitHub-settings action; document it and, where possible, encode via the workflow `concurrency`/path filters + a CODEOWNERS-backed review gate.

## Acceptance Criteria

- [ ] `ci.yml` runs the LOCKED job order (`§10`): fast no-WP jobs → wp-env jobs.
- [ ] `drift.yml` runs `pnpm test:drift` and is documented/configured as a REQUIRED check on PRs touching `packages/shared/schemas/**` or the pre-filter.
- [ ] `check-sdk-version.mjs` fails the build if any `@modelcontextprotocol/*` 2.x is in the lockfile or the SDK isn't `^1.29`.
- [ ] Stage 1 gates lint + format + build + PHPCS + `fixtures:validate` + `test:unit` + SDK guard.
- [ ] wp-env boots with Elementor 4.1.1 + Pro 4.1.0; required experiments activated; the free-only leg is green with Pro fixtures skipped.
- [ ] `release.yml` builds the server tarball + plugin zip (via WP-Q08 scripts) and gates on the SDK guard; default dry-run.
- [ ] The drift baseline is never auto-updated by CI.
- [ ] Commit-trailer check present (advisory) and CODEOWNERS protects contract/schema paths.

## Tests Required

- CI self-validation: a dry-run of each workflow (e.g. `act` locally or a throwaway PR) proving job order + gating.
- A unit test for `check-sdk-version.mjs` (fixture lockfiles: a clean one passes, a 2.x one fails).
- A test that the drift workflow's path filter matches `packages/shared/schemas/**` + the pre-filter path.
- (The drift/contract/smoke/php suites themselves are owned by WP-F06/Q##; F07 only proves it INVOKES them in order.)

## Parallelization Notes

- Wave 1, after WP-F06 (needs the script names + runners to call). Parallel-safe with WP-F02/F03/F04/F05 (disjoint: F07 owns `.github/**` + `scripts/ci/**` only).
- Every later WP relies on CI being present to gate its DoD (`15-engineering-standards.md §4`); F07 itself does not block their development, only their merge.
- WP-Q02 (drift test) and WP-Q08 (packaging) own the runner/packaging logic F07 invokes; F07 references them by script name (contract dependency), not by editing their files.
