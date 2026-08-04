---
id: WP-Q08
title: QA/release — npx-distributable server packaging + plugin zip packaging + release process
layer: qa
phase: v1
status: planned
depends_on:
  - WP-F01
  - WP-F07
files_owned:
  - scripts/release/pack-server.mjs
  - scripts/release/pack-plugin.mjs
  - scripts/release/verify-package.mjs
  - scripts/release/bump-version.mjs
  - packages/server/.npmignore
  - packages/server/README.md
  - plugin/elementor-ultra-mcp/.distignore
  - RELEASE.md
  - CHANGELOG.md
contract_refs:
  - spec/contracts/15-engineering-standards.md §1 (tooling), §2.10 (bin/npx distribution), §4.8 (QA/release DoD), §7 (SDK guard)
  - spec/01-architecture.md §6.1 (transports; npx distribution), §6.3 (multisite mu-plugin)
  - RESEARCH.md §8 (per-site setup; install/activate; mu-plugin), §9.2 (repo layout)
  - spec/contracts/14-fixtures-harness.md §10 (CI scripts; release gate)
estimate: M
---

## Summary

Build the release packaging: the `npx`-distributable TS MCP server (`bin` + shebang, lean published surface) and the installable WordPress plugin zip (mu-plugin-capable), plus a package-verification step (the published artifacts actually run) and the release process docs (`RELEASE.md`, `CHANGELOG.md`, version bump). The release CI workflow (WP-F07's `release.yml`) calls the `pack:server`/`pack:plugin` scripts owned here; this WP owns the packaging LOGIC + the SDK-guard release gate hook.

## Interface / Contract

- **`scripts/release/pack-server.mjs` → `pnpm pack:server`.** Builds `packages/server`, prunes to the publishable set (`.npmignore` excludes tests/fixtures/sources where appropriate, keeps `dist` + `bin`), verifies the `bin` shebang + `@modelcontextprotocol/sdk@^1.29` pin (no 2.x), and produces an npm tarball runnable via `npx @youragency/elementor-ultra-mcp` (`15-engineering-standards.md §2.10`, `01-architecture.md §6.1`).
- **`scripts/release/pack-plugin.mjs` → `pnpm pack:plugin`.** Builds the PHP plugin (Composer install --no-dev, Jetpack autoloader), prunes via `.distignore` (excludes tests/dev), and produces `elementor-ultra-mcp.zip` installable as a normal plugin OR droppable as a network mu-plugin (`01-architecture.md §6.3`, RESEARCH §8).
- **`scripts/release/verify-package.mjs` → `pnpm verify:package`.** Installs the packed server tarball into a temp dir and runs the bin (asserts clean startup/exit with/without env); validates the plugin zip structure (bootstrap header, `Requires Plugins`, activation hook present). The SDK-2.x guard (WP-F07's `check-sdk-version.mjs`) runs as a release gate.
- **`scripts/release/bump-version.mjs` → `pnpm bump`.** Bumps the server `package.json` version + the plugin header `Version` in lockstep and updates `CHANGELOG.md`.
- **`RELEASE.md`.** The release runbook (tag → `release.yml` builds + verifies → publish step is explicit/manual). **`packages/server/README.md`** = the npx-user-facing setup (env config `WP_URL`/`WP_USER`/`WP_APP_PASSWORD`/`ULTRA_TOOLS`, transports, per-site App-Password setup).

## Dependencies & Inputs

- Upstream: WP-F01 (the `bin` entry + package.json + plugin skeleton + composer setup it packages), WP-F07 (the `release.yml` workflow that invokes `pack:server`/`pack:plugin`/`verify:package` + the SDK guard). The packaged content grows as verticals land; the packaging logic is stable from v1.
- Contracts: `15-engineering-standards.md §1/§2.10/§4.8/§7`; `01-architecture.md §6.1/§6.3`; RESEARCH §8/§9.2; `14-fixtures-harness.md §10`.
- Elementor APIs: none directly — packaging only. The plugin zip's bootstrap guards (`Requires Plugins: elementor`) are validated, not invoked.

## Detailed Requirements

1. **Server tarball:** `pack:server` builds + prunes + verifies the `bin` shebang and SDK pin; the tarball is runnable via `npx` (`15-engineering-standards.md §2.10`). `.npmignore` keeps `dist`+`bin`+README, excludes tests/fixtures.
2. **Plugin zip:** `pack:plugin` runs `composer install --no-dev`, prunes via `.distignore`, and produces an installable zip that ALSO works as a network mu-plugin (one codebase, RESEARCH §8). The zip's `readme.txt` + bootstrap header are included.
3. **Verification:** `verify:package` installs the server tarball in a temp dir + runs the bin (clean startup/exit), and validates the plugin zip structure (header, `Requires Plugins`, activation hook). Fails the release on any defect.
4. **SDK-2.x release gate:** the SDK guard runs as part of release (`15-engineering-standards.md §7`) — no 2.x `@modelcontextprotocol/*` in the published lockfile.
5. **Version lockstep:** `bump:version` keeps the server `package.json` + plugin header `Version` aligned + updates `CHANGELOG.md`.
6. **Release runbook:** `RELEASE.md` documents tag → CI build/verify → explicit publish (the `release.yml` default is dry-run, WP-F07).
7. **npx user docs:** `packages/server/README.md` covers env config, transports (stdio/Streamable HTTP), and the per-site App-Password setup (`01-architecture.md §6.1/§6.2`, RESEARCH §8).
8. **Pro note:** packaging does NOT bundle Elementor or Pro; the plugin zip is the companion only.

## Implementation Notes

- The release workflow (`release.yml`) is owned by WP-F07; Q08 owns the SCRIPTS it calls. Reference them by the `pnpm pack:server`/`pack:plugin`/`verify:package` names (contract dependency) — do not edit `release.yml` (disjoint).
- The `bin` shebang + `^1.29` pin are the two npx traps; `verify:package` must assert both on the PACKED artifact, not just the repo.
- The plugin zip must be mu-plugin-droppable (RESEARCH §8 multisite) — verify the directory layout supports both install paths.
- Keep packaging stable across phases; only the packaged CONTENT changes as verticals add files (no script change needed).

## Acceptance Criteria

- [ ] `pnpm pack:server` produces an npm tarball runnable via `npx` (bin shebang + `^1.29` pin verified on the packed artifact; no 2.x).
- [ ] `pnpm pack:plugin` produces `elementor-ultra-mcp.zip` installable as a plugin AND droppable as a network mu-plugin (Composer --no-dev, `.distignore` pruned).
- [ ] `pnpm verify:package` installs + runs the server tarball (clean startup/exit) and validates the plugin zip structure; fails on defects.
- [ ] The SDK-2.x guard runs as a release gate; a 2.x dep fails the release.
- [ ] `pnpm bump` aligns server + plugin versions and updates `CHANGELOG.md`.
- [ ] `RELEASE.md` documents the tag→build→verify→explicit-publish flow; `packages/server/README.md` documents npx setup + transports + App-Password setup.
- [ ] `release.yml` (WP-F07) successfully invokes the Q08 scripts in a dry-run.

## Tests Required

- `verify:package` IS the packaging test (packed server runs; plugin zip valid). Run it in CI's release dry-run.
- A unit test for `bump:version` (server + plugin versions move in lockstep).
- A check that `.npmignore`/`.distignore` exclude tests/fixtures/dev but keep the runnable artifact.

## Parallelization Notes

- Wave 2+, v1 phase (packaging stabilizes once the bin + plugin skeleton exist; consumed at every release thereafter). Parallel-safe with all other QA WPs (Q08 owns `scripts/release/**` + the ignore/README/RELEASE/CHANGELOG files; disjoint from Q01–Q07 fixtures/runners and from WP-F07's `.github/**`).
- Depends on WP-F01 (artifacts) + WP-F07 (the release workflow that calls these scripts). The packaged content grows with the verticals but the packaging logic does not change.
