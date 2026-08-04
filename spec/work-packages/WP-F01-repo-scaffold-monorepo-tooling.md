---
id: WP-F01
title: Repo scaffold — pnpm/turbo monorepo, TS packages, base tooling, wp-env (plugin bootstrap is WP-P01)
layer: foundation
phase: foundation
status: planned
depends_on: []
files_owned:
  - package.json
  - pnpm-workspace.yaml
  - turbo.json
  - .gitignore
  - .npmrc
  - .nvmrc
  - .editorconfig
  - tsconfig.base.json
  - .prettierrc.json
  - .prettierignore
  - eslint.config.mjs
  - .wp-env.json
  - README.md
  - packages/server/package.json
  - packages/server/tsconfig.json
  - packages/server/src/index.ts
  - packages/shared/package.json
  - packages/shared/tsconfig.json
  - packages/shared/src/index.ts
contract_refs:
  - spec/01-architecture.md §5 (canonical repo layout — files_owned authority)
  - spec/contracts/15-engineering-standards.md §1 (repo & tooling baseline)
  - spec/contracts/15-engineering-standards.md §2 (TS conventions)
  - spec/contracts/15-engineering-standards.md §3 (PHP/WordPress conventions)
  - spec/contracts/15-engineering-standards.md §7 (SDK pin + version guards)
estimate: M
---

## Summary

Stand up the monorepo skeleton that every other work package builds inside: a pnpm-workspace + turbo root, the `packages/server` TS package (with the `@modelcontextprotocol/sdk ^1.29` pin and `bin` entry), the `packages/shared` package, the base TS tooling (strict tsconfig, ESLint, Prettier), and a pinned `.wp-env.json` (Elementor 4.1.1 + Pro 4.1.0) that MOUNTS the `plugin/elementor-ultra-mcp` directory. It does NOT implement any feature logic and does NOT own the PHP plugin bootstrap files — the companion plugin bootstrap (`elementor-ultra-mcp.php`, `composer.json`, `phpcs.xml.dist`, `readme.txt`, `class-plugin.php`) is owned by WP-P01 (disjoint-files rule). F01 produces a green, empty TS scaffold that compiles, lints, and boots a no-tool MCP server; PHPCS config + the plugin live with WP-P01.

## Interface / Contract

Realizes the canonical repo layout in `spec/01-architecture.md §5` verbatim. The "spine" files this WP owns (and ONLY this WP edits per the disjoint-files rule, `01-architecture.md §4.3`) are: workspace/turbo config, the two TS `tsconfig`/`package.json` pairs, the lint/format config, `.wp-env.json`, and `packages/server/src/index.ts`. The PHP plugin spine (`elementor-ultra-mcp.php`, `composer.json`, `phpcs.xml.dist`, `readme.txt`, `class-plugin.php`) is owned by WP-P01, NOT this WP. Every downstream WP slots NEW files into the directories created here and never edits these spine files.

Frozen tooling identifiers other WPs rely on:
- Node ≥ 20 LTS; pnpm workspace package manager; lockfile committed (`15-engineering-standards.md §1`).
- `@modelcontextprotocol/sdk` pinned to `^1.29` in `packages/server/package.json`; `zod` as a required peer; NO `@modelcontextprotocol/*` 2.x (`§1`, `§7`).
- TS strict flags: `strict:true`, `noUncheckedIndexedAccess:true`, `exactOptionalPropertyTypes:true`, `noImplicitOverride:true` (`§2.1`).
- (PHP namespace root `Elementor\Ultra` + PHPCS rulesets are established by WP-P01, not F01.)
- `.wp-env.json` pins Elementor 4.1.1 + Pro 4.1.0 and mounts the companion plugin directory `./plugin/elementor-ultra-mcp` (whose contents WP-P01 creates) (`§7`, `14-fixtures-harness.md §3.1`).
- Package scripts that downstream WPs (WP-F06/F07/Q##) call MUST be reservable here as workspace-runnable names: `lint`, `format:check`, `build`, `test:unit` (others added by their owning WPs).

## Dependencies & Inputs

- Upstream WP IDs: none (this is the root of Wave 0).
- Contracts: `01-architecture.md §5` (paths), `§4.3` (disjoint-files/spine ownership); `15-engineering-standards.md §1,§2,§3,§7`.
- Elementor APIs: NONE called by F01. The plugin bootstrap + its Elementor-presence guard (`Requires Plugins: elementor`, `class_exists('\Elementor\Plugin')`) are WP-P01's responsibility. F01 only ensures `.wp-env.json` mounts the plugin directory so WP-P01's plugin can be activated.

## Detailed Requirements

1. **Workspace root.** `pnpm-workspace.yaml` declaring `packages/*`. Root `package.json` with `"private": true`, `"packageManager": "pnpm@<pinned>"`, an `engines.node: ">=20"`, and root scripts that delegate to turbo (`build`, `lint`, `format:check`, `test:unit`). `turbo.json` with a `build`/`lint`/`test:unit` pipeline (cacheable). `.npmrc` with `engine-strict=true` and `auto-install-peers=false` (zod is an explicit peer). `.nvmrc` = `20`.
2. **Root TS config.** `tsconfig.base.json` carrying the strict flags from `15-engineering-standards.md §2.1` plus `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `declaration: true`, `composite: true`. Each package `tsconfig.json` extends it and sets `rootDir: src`, `outDir: dist`.
3. **Lint/format.** `eslint.config.mjs` (flat config) using `typescript-eslint` `recommendedTypeChecked`, pointing `parserOptions.project` at both package tsconfigs; ban `any` (rule on), require justification comments for disables. `.prettierrc.json` + `.prettierignore`. `.editorconfig` (LF, 2-space TS, tabs PHP per WP coding standards).
4. **`packages/server`.** `package.json` with: `"type": "module"`, `"bin": { "elementor-ultra-mcp": "./dist/index.js" }`, dependency `@modelcontextprotocol/sdk@^1.29`, peer `zod`, dev deps (typescript, vitest, eslint, prettier). `src/index.ts` = a minimal bin entry with a shebang (`#!/usr/bin/env node`) that imports the SDK, constructs an empty `McpServer`, selects transport from env (stdio default), and exits cleanly when env is missing (no business logic — server-core wiring is WP-T01). `tsconfig.json` extends base.
5. **`packages/shared`.** `package.json` (`"type": "module"`), `tsconfig.json`, `src/index.ts` (empty re-export stub). This package will hold shared types (WP-F02/F03) + JSON schemas + fixtures (WP-F03/F06); only the skeleton is created here.
6. **PHP plugin bootstrap — NOT owned here.** The companion plugin files (`elementor-ultra-mcp.php`, `composer.json`, `phpcs.xml.dist`, `readme.txt`, `class-plugin.php`) are created by WP-P01. F01 must NOT create them. F01 only ensures the `plugin/elementor-ultra-mcp/` directory is mounted by `.wp-env.json`. (`.gitignore` should not exclude that path.)
7. **`.wp-env.json`** at repo root pinning Elementor 4.1.1 and Elementor Pro 4.1.0 (Pro via local zip/path placeholder documented in README), mapping `./plugin/elementor-ultra-mcp` as a plugin (its contents created by WP-P01), and setting WP/PHP versions matching `15-engineering-standards.md §1`.
8. **README.md** documenting: prerequisites (Node 20, pnpm, Docker for wp-env, Composer), `pnpm install`, `pnpm build`, `pnpm lint`, how to run wp-env, and where Pro must be placed. Note that the plugin's own Composer/PHPCS setup is provided by WP-P01.
9. **SDK trap guard groundwork.** The lockfile + `package.json` must make the `2.x` guard test (WP-F07) possible: pin exactly `^1.29`. Do not add any `@modelcontextprotocol/server` package.

## Implementation Notes

- The bin entry MUST have a shebang and be the file referenced by `"bin"`; `npx` distribution depends on it (`15-engineering-standards.md §2.10`, RESEARCH.md §8). Keep it minimal so WP-T01 can own the real transport-select logic without editing F01's file — F01's `index.ts` should `import` from a `server.ts`/transport module that WP-T01 creates, OR be a thin placeholder that WP-T01 replaces by ADDING those modules and F01's index just calls a named export. To keep ownership disjoint, `index.ts` here calls `await main()` from `./server.js` and F01 ships a TEMPORARY no-op `server.ts`? — NO: `server.ts` is owned by WP-T01. Resolve by: F01's `index.ts` lazily `import()`s `./server.js` and prints a clear "server core not yet wired" message if the export is missing, so F01 compiles standalone and WP-T01 adds `server.ts` without editing `index.ts`. Document this seam in code comments.
- Do NOT create or call any PHP plugin code here — the plugin bootstrap, Composer/PHPCS config, `Requires Plugins` guard, and PSR-4 autoloader are all WP-P01's. F01's only plugin touchpoint is the `.wp-env.json` mount.
- Keep `.gitignore` from excluding `plugin/elementor-ultra-mcp/` so WP-P01 can land its files there.

## Acceptance Criteria

- [ ] `pnpm install` succeeds with a committed `pnpm-lock.yaml`; the lockfile contains `@modelcontextprotocol/sdk@1.29.x` and NO `@modelcontextprotocol/*` 2.x.
- [ ] `pnpm build` compiles both packages with the strict tsconfig and zero TS errors.
- [ ] `pnpm lint` and `pnpm format:check` pass on the empty scaffold.
- [ ] Running `node packages/server/dist/index.js` (or `npx` from the built package) starts and exits cleanly with a clear message when env (`WP_URL`/`WP_USER`/`WP_APP_PASSWORD`) is absent.
- [ ] `npx @wordpress/env start` boots WordPress with Elementor 4.1.1 + Pro 4.1.0 (with Pro placed per README); the `plugin/elementor-ultra-mcp` directory is mounted and activatable once WP-P01 lands its files.
- [ ] Every path in `files_owned` exists; no file outside `files_owned` is created (in particular, NO `plugin/elementor-ultra-mcp/*` files — those are WP-P01's).

## Tests Required

- Unit: a trivial vitest test per package proving the test runner + tsconfig resolve (e.g. `packages/shared` exports a constant). (These live under the package and are owned here as part of the scaffold; richer suites are WP-F06/Q##.)
- Smoke: a shell/CI step (consumed by WP-F07) that builds and boots the bin entry, asserting clean startup/exit.
- PHP: none here — the plugin (and its PHPCS/PHPUnit setup) is WP-P01 + WP-F06.
- Fixtures: none (fixtures dir is owned by WP-F06).

## Parallelization Notes

- Wave 0, runs FIRST and alone — every other WP (foundation, spike, php, ts, html, pro, qa) depends on this scaffold existing. It owns all spine config files, so no sibling can be parallel-safe with it inside Wave 0; sequence it ahead of WP-F02..F07 and all spikes.
- After F01 merges, WP-F02..F07, WP-P01, and the spikes proceed in parallel. WP-T01 (server core) adds `server.ts`/`transport/*` without editing `index.ts` (seam documented above). WP-P01 creates the entire PHP plugin bootstrap (`elementor-ultra-mcp.php`, `composer.json`, `phpcs.xml.dist`, `readme.txt`, `class-plugin.php`) into the directory F01's `.wp-env.json` mounts — disjoint from F01's files.
