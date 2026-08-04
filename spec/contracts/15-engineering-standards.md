# Contract 15 — Engineering Standards & Definition of Done

Status: FROZEN. This is the authoritative set of coding conventions, per-layer definition-of-done, parallel-worktree commit/branch conventions, and the spike-gate rule (which WPs are blocked until which spike passes). Every build WP across all layers conforms to this. The script that assembles parallel worktrees relies on the branch/commit conventions here being followed exactly.

Source of truth: RESEARCH.md §3.2 (SDK pin, ZodRawShape, transports), §1 bullet 5 + §7 (PHP authoritative), §9.2 (repo layout), §9.3 (testing), §0 + §9.1 (spikes + roadmap), §10 (risks). Tool catalog: `spec/contracts/13-tool-catalog.md`. Fixtures harness: `spec/contracts/14-fixtures-harness.md`. Error taxonomy: `spec/contracts/12-error-taxonomy.md`.

---

## 1. Repository & tooling baseline (LOCKED)

- **Monorepo** via pnpm workspaces (`packages/server`, `packages/shared`) + the WordPress plugin at `plugin/elementor-ultra-mcp` (PHP, Composer). Layout is FROZEN in RESEARCH.md §9.2 — do not relocate the canonical paths.
- **Node** ≥ 20 LTS. **pnpm** as the package manager (lockfile committed). **PHP** ≥ 7.4 (matching Elementor 4.1.x minimum) targeting WordPress current.
- **MCP SDK pin (LOCKED):** `@modelcontextprotocol/sdk@^1.29` — NEVER `@modelcontextprotocol/server@2.0.0-alpha` or any 2.x. In 1.x, `inputSchema`/`outputSchema` are ZodRawShape maps; `zod` is a required peer; transports are deep `.js` imports (RESEARCH.md §3.2). Adding a 2.x dependency fails review.
- **Transports (LOCKED):** stdio (`StdioServerTransport`) for local/Claude Desktop + Streamable HTTP (`StreamableHTTPServerTransport`) for hosted use. `packages/server/src/transport/{stdio.ts,http.ts}` (RESEARCH.md §9.2). HTTP transport uses a stateful session Map for editor sessions and `sessionIdGenerator: undefined` for stateless/serverless mode.
- **PHP Composer deps:** the companion plugin uses the Jetpack autoloader and optionally `wordpress/mcp-adapter` (secondary Abilities path) — guarded so its absence is a graceful no-op (RESEARCH.md §3.2, §5 secondary path).

---

## 2. TypeScript conventions (LOCKED — `packages/server`, `packages/shared`)

1. **Strict TS.** `tsconfig` with `strict:true`, `noUncheckedIndexedAccess:true`, `exactOptionalPropertyTypes:true`, `noImplicitOverride:true`. No `any` in committed code (use `unknown` + zod narrowing). No `// @ts-ignore` without an adjacent justification comment + linked issue.
2. **Validation = zod.** Every tool's `inputSchema`/`outputSchema` is a ZodRawShape exactly matching Contract 13. All external data (REST responses, fixtures, env) is parsed through a zod schema at the boundary — never trusted raw. The authoring contract types live in `packages/server/src/authoring/contract.ts` and are derived from / kept in sync with the shared JSON Schemas (`packages/shared/schemas/`).
3. **Lint/format.** ESLint (typescript-eslint, recommended-type-checked) + Prettier. CI runs `pnpm lint` and `pnpm format:check`; both must be clean. No disabled rules inline without justification.
4. **Tests = vitest.** Unit tests colocated as `*.test.ts`; contract/integration suites per Contract 14 §10. Coverage is reported but the gate is "all required suites green," not a coverage percentage.
5. **The TS validator is a PRE-FILTER only (LOCKED).** It may `accept`/`reject`/`defer` but is never authoritative; the pipeline ALWAYS round-trips through PHP `dry_run` before any commit (RESEARCH.md §1 bullet 5, §6.1 step 7). A TS-side hard reject of input that PHP would accept is a bug.
6. **No invented Elementor APIs.** Prop names, `$$type` keys, enum members, control names, REST routes, and Elementor PHP method names must trace to the source tree (`plugins/elementor`, `plugins/elementor-pro`) or the contracts. Cite `path:line` in code comments where behavior depends on a specific Elementor implementation detail.
7. **IDs.** Element + local-style ids are minted in `packages/server/src/authoring/ids.ts` as 7-hex (`substr(strtolower(dechex(rand)),0,7)`) and deduped against a live set (RESEARCH.md §4.3 rule 3, §4.6). Never reuse ids across documents on clone/insert.
8. **Errors.** Map REST/business failures to tool results with `isError:true` + a taxonomy code (`spec/contracts/12-error-taxonomy.md`), never thrown protocol errors when the agent can fix the input (RESEARCH.md §7.5, Contract 13 §0.9).
9. **Pagination.** Every list tool implements `{limit,cursor,fields[]}` → `{items,next_cursor,total}` (Contract 13 §0.6); never fetch unbounded.
10. **bin/distribution.** `packages/server` ships a `bin` with shebang for `npx` distribution (RESEARCH.md §8). Env config (`WP_URL`/`WP_USER`/`WP_APP_PASSWORD`/`ULTRA_TOOLS`) is read once at init in `server.ts`.

---

## 3. PHP / WordPress conventions (LOCKED — `plugin/elementor-ultra-mcp`)

1. **WordPress Coding Standards** enforced by PHPCS with the `WordPress` + `WordPress-Extra` rulesets (config `phpcs.xml.dist` in the plugin root). CI runs `composer phpcs`; must be clean.
2. **Namespace = `Elementor\Ultra`** (PSR-4 under `includes/`). Class files follow WP file naming (`class-*.php`) as in RESEARCH.md §9.2; the PSR-4 map points the namespace at `includes/`.
3. **Capability boundary.** Every REST route declares a `permission_callback` doing `current_user_can(...)` with the correct capability; this (not a nonce) is the security boundary for App-Password Basic auth (RESEARCH.md §8). Design-system class writes require `UPDATE_CLASS`; the plugin idempotently grants it on activation (RESEARCH.md §8, §1 bullet 10).
4. **PHP `dry_run` is AUTHORITATIVE (LOCKED).** `Validator::dry_run()` instantiates every node (`create_element_instance()` + `get_data_for_save()`) inside try/catch and returns structured errors mapped to taxonomy codes; it NEVER string-matches the Elementor throw message (`has-atomic-base.php:95-98`, RESEARCH.md §2.1). Every WRITE route validates before persisting.
5. **Never raw-write `_elementor_data`.** Go through `Document::save(['elements','settings'])`; if a raw meta write is unavoidable, `wp_slash(wp_json_encode())` AND delete `_elementor_css` + `_elementor_element_cache` (RESEARCH.md §2.1, §7.3).
6. **Repository abstraction for design system.** Global classes go through `Global_Classes_Repository` (migration-transparent), never raw CPT/kit meta (RESEARCH.md §2.2). The class diff-PUT body and 1000-item budget are built/enforced server-side (RESEARCH.md §5.4).
7. **Transactional writes.** Read → mutate in memory → dedupe ids → validate every node → check `base_hash` (`md5(_elementor_data)`) + `wp_check_post_lock` + `get_newer_autosave` → single `Document::save()` (RESEARCH.md §7). Never N partial saves.
8. **Revision-independent backup** before every write (`_emcp_backup_{ts}` meta + `wp_save_post_revision`), because agency sites often disable revisions (RESEARCH.md §7).
9. **Atomic CSS priming.** Every atomic-tree WRITE route exposes / triggers the prime-css step (`CssPrimer`); `Post_CSS::create($id)->update()` does NOT emit atomic CSS (RESEARCH.md §7.4, Spike S1).
10. **Tests = PHPUnit under wp-env.** `composer test:php` runs inside `.wp-env.json` with Elementor + Pro active (Contract 14 §3, §10).
11. **No invented Elementor APIs.** Same rule as TS §2.6 — every Elementor call traces to source with a `path:line` comment.

---

## 4. Definition of Done — per layer (LOCKED)

A WP is DONE only when ALL applicable rows below pass. CI enforces the machine-checkable ones; reviewers enforce the rest.

### 4.1 All layers (universal DoD)
- [ ] Implements exactly the contract slice named in the WP frontmatter (no scope creep into another WP's `files_owned`).
- [ ] Touches only paths in its `files_owned`; no edits to another WP's owned files.
- [ ] Every external Elementor behavior cited with `path:line` in code or PR description.
- [ ] No invented tool names / routes / props / `$$type` keys — all trace to Contract 13 (tools) / Contract 10 (REST) / Contract 11 (authoring) or source.
- [ ] Lint + format clean for its language(s); CI green.
- [ ] New identifiers match the frozen contracts byte-for-byte (tool names, route paths, error codes, type names).

### 4.2 Foundation (`layer: foundation`, WP-F##)
- [ ] Contracts realized as code (shared types / JSON Schemas / OpenAPI) compile and are imported by both TS and (where relevant) PHP.
- [ ] `pnpm fixtures:validate` and the schema-validation step pass.
- [ ] CI pipeline (WP-F07) runs the job order in Contract 14 §10; the schema-drift job is wired as a required check.

### 4.3 Spike (`layer: spike`, WP-S##)
- [ ] Produces a written PASS/FAIL verdict against the spike's pass criterion (RESEARCH.md §0 table).
- [ ] If PASS, records the working approach (e.g. which prime-css approach for S1) as a short note consumed by the gated feature WPs.
- [ ] Leaves a reusable artifact where applicable (a fixture, a probe script) under the owning package.
- [ ] Updates the spike-gate status (§6) so blocked WPs can start.

### 4.4 PHP companion (`layer: php`, WP-P##)
- [ ] Every route has a `permission_callback`; capability matches the operation.
- [ ] WRITE routes: transactional, base_hash/lock/autosave-checked, backup-before-write, validated via authoritative `dry_run`.
- [ ] Atomic-tree WRITE routes trigger prime-css and pass the Contract 14 §3-step-3 render assertion (S1-gated).
- [ ] PHPCS clean; PHPUnit (wp-env) green for the route's fixtures (Contract 14 §3).
- [ ] Errors mapped to taxonomy codes (Contract 12); throw-message never string-matched.

### 4.5 TypeScript core (`layer: ts`, WP-T##)
- [ ] Tool(s) registered with the exact Contract 13 name/title/inputSchema/outputSchema/annotations.
- [ ] Pre-filter (where applicable) is a safe subset (Contract 14 §4); pipeline round-trips through PHP `dry_run` before commit.
- [ ] Lean-profile membership (★) matches Contract 13 §5.2; advanced tools `disable()`d at boot + `listChanged` on enable.
- [ ] Pagination implemented on all list tools.
- [ ] vitest unit + the relevant contract suites green; Inspector smoke payload (`fixtures/envelopes/smoke.<tool>.json`) added for any new lean tool.

### 4.6 HTML pipeline (`layer: html`, WP-H##)
- [ ] Render-then-extract via headless Playwright (not static parse); reuses the Playwright instance for the visual-diff gate (RESEARCH.md §6.1, SUPPLEMENT §C.3-C.4).
- [ ] AI/classification strictly UPSTREAM of typed-envelope emission; envelope compile is deterministic; PHP `dry_run` authoritative (SUPPLEMENT §C.4 step 3).
- [ ] NEVER auto-commits — always dry-run + diff + coverage report + explicit `commit` + elicitation confirm (LOCKED, RESEARCH.md §6.8, Contract 13 §1.9).
- [ ] Honest reporting: per-property fallback ladder, a11y findings, stripped-text diff; coverage anchored to the S3 number, never a hardcoded 85%.
- [ ] HTML corpus regression green (Contract 14 §6); produced trees pass PHP `dry_run`.

#### 4.6.1 Pipeline-IR contract (FROZEN — the inter-stage seam, owned by WP-H01 `packages/server/src/convert/types.ts`)

The HTML→native pipeline is a chain of stages (PARSE→NORMALIZE→CLASSIFY→MAP→STYLE-EXTRACT→ASSEMBLE→HOIST→A11Y/FIDELITY/COVERAGE→orchestrator). Each stage consumes the prior stage's typed output. To make every stage WP **independently buildable and unit-testable against a frozen contract** (the parallelism principle), ALL inter-stage intermediate-representation (IR) types and per-stage Result envelopes are FROZEN here and **owned by WP-H01** in `packages/server/src/convert/types.ts`. Downstream stage WPs (WP-H03..H11) MUST `import type` these from WP-H01 and MUST NOT redeclare them in their own module. The full TS shapes (field names, optionality, union members) are specified verbatim in WP-H01's "Interface / Contract"; this table fixes the canonical name, producer, and consumers:

| IR type / envelope | Producer WP (file) | Primary consumers |
| --- | --- | --- |
| `SemanticRole`, `IrNode`, `BoxRect`, `ComputedStyleSet`, `TextRun`, `MediaRef`, `MappingResult`, `MapContext`, `STYLE_WHITELIST` | WP-H01 `types.ts` / `mapping-table.ts` | ALL convert stages |
| `ParseInput`, `BreakpointSpec`, `ParseWarning`, `ParseResult` (incl. `raw_inner_markup`) | type frozen in WP-H01 `types.ts`; implemented by WP-H03 `parse.ts` | H04, H07, H10, H11 |
| `NormalizeContext`, `NormalizeResult`, `StrippedRecord`, `PromotionRecord` | type frozen in WP-H01 `types.ts`; implemented by WP-H04 `normalize.ts` | H05, H10, H11 |
| `ClassifyOptions`, `AiRoleHint`, `ClassifyResult`, `RoleOverride`, `FlexIntent` | type frozen in WP-H01 `types.ts`; implemented by WP-H05 `classify.ts`/`flex-inference.ts` | H06, H11 |
| `MapStageContext`, `MapResult`, `MappedNode`, `NodeFallback` | type frozen in WP-H01 `types.ts`; implemented by WP-H06 `map.ts` | H07, H08, H11 |
| `StyleContext`, `StyleExtractResult`, `StyledNode`, `DeclFallback`, `LiteralRef`, `DeclVerdict` | type frozen in WP-H01 `types.ts`; implemented by WP-H07 `style-extract.ts`/`declaration-classifier.ts` | H08, H09, H11 |
| `AssembleContext`, `AssembleResult`, `SideloadError`, `MediaPort`, `IdPort` | type frozen in WP-H01 `types.ts`; implemented by WP-H08 `assemble.ts` | H09, H10, H11 |
| `HoistContext`, `HoistResult`, `BudgetReport`, `VarContext`, `VarResult`, `ProposedVariable` | type frozen in WP-H01 `types.ts`; implemented by WP-H09 `hoist.ts`/`variable-extract.ts` | H10, H11 |
| `CoverageReport`, `A11yFinding`, `FidelityResult` (final report shapes — also mirrored in `diff.schema.json`) | type frozen in WP-H01 `types.ts`; implemented by WP-H10 | H11 |

Rules:
- **WP-H01 owns the TYPE declarations only** (pure `type`/`interface`, no runtime logic for stages it doesn't own). Each stage WP owns the FUNCTION that produces/consumes the frozen type. This keeps `types.ts` a single-file seam with no cross-WP ownership of runtime code.
- A stage WP is therefore buildable + unit-testable the moment WP-H01 lands: it codes its function against the frozen input/output types and tests with hand-authored fixtures of those types. It does NOT need the upstream stage's runtime merged to compile or unit-test (it needs it only for end-to-end corpus tests, which are owned by WP-H10/Q04).
- Adding a field to any IR type is a change to WP-H01 (re-freeze), not a unilateral edit by a downstream stage. `ElementNode`/envelope shapes remain WP-F03's (`element-node.schema.json`); the IR is pre-envelope and never duplicates F03 types.

### 4.7 Pro surface (`layer: pro`, WP-R##)
- [ ] Conditions written via `Conditions_Manager::save_conditions()` (slash strings) + `cache->regenerate()` — never raw structured meta (RESEARCH.md §4.4, SUPPLEMENT §A.1).
- [ ] Popup display settings via `save_display_settings_data()` → `_elementor_popup_display_settings` (SUPPLEMENT §A.2).
- [ ] Form `required`→string `"true"`, `id`→`custom_id`, action registration validated via `actions_registrar->get()` (SUPPLEMENT §A.3).
- [ ] Loop `posts_per_page` top-level; query keys prefixed `{skin}_query_`; `template_id` asserted as a `loop-item` doc (SUPPLEMENT §A.4).
- [ ] Woo widgets context-validated by `get_categories()` (SUPPLEMENT §A.5).
- [ ] Gated behind `pro` / `e_pro_atomic_form` capability probe; graceful failure with a taxonomy code when absent.

### 4.8 QA / CI / release (`layer: qa`, WP-Q##)
- [ ] The Contract 14 suite it owns runs in CI in the §10 order.
- [ ] Schema-drift job required on PRs touching schema baselines or the pre-filter.
- [ ] Release packaging produces the `npx`-distributable server + the installable plugin zip.

---

## 5. Commit / branch conventions for parallel worktree builds (LOCKED)

The assembler runs many build WPs concurrently in separate git worktrees. To make merges deterministic and non-conflicting:

1. **One branch per WP**, named `wp/<ID>-<kebab-slug>` (e.g. `wp/wp-t03-page-build`). The slug matches the WP file's slug.
2. **One worktree per branch**, branched from the integration base (`main` or the current wave's integration branch). A WP only edits files in its `files_owned`; because the assembler proves `files_owned` are disjoint within a wave, two same-wave branches never touch the same file and merge cleanly.
3. **Conventional Commits** with the WP id as a scope: `feat(wp-t03): ...`, `fix(wp-p02): ...`, `test(wp-q01): ...`, `chore(wp-f01): ...`. The WP id MUST appear in every commit so the assembler can attribute changes.
4. **No edits to shared/owned-elsewhere files.** If a WP needs a change in a file owned by another WP, it declares a dependency on that WP (frontmatter `depends_on`) and consumes the frozen interface — it does not edit the file. If two features must edit the same file, they are merged into one WP or the file is split so ownership is disjoint (the parallelism principle).
5. **Contracts are append-only within a wave.** Frozen contract docs (`spec/contracts/*`) and shared types/schemas (`packages/shared/*`) are not edited by feature WPs; a contract change is its own foundation WP and re-freezes before dependents build.
6. **Every commit message** ends with the co-author trailer required by the environment:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
7. **PR body** ends with the required generation trailer:
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
8. Commit/push only when explicitly requested; if on the default branch, branch first (per environment rules).

---

## 6. Spike-gate rule (LOCKED — which WPs are blocked until which spike passes)

A WP listing a spike in its `depends_on` MUST NOT be merged until that spike's PASS verdict (and recorded approach) exists. Spike pass criteria are in RESEARCH.md §0.

| Spike | Question (RESEARCH.md §0) | Gates these WPs / capabilities |
|---|---|---|
| **S1** (WP-S01) | Headless atomic save + CSS priming — does a headless `Document::save` of an atomic tree produce visible front-end CSS, and which prime-css approach works? | ALL atomic-CSS-affecting writes: the prime-css PHP WP, `page.build`, `page.replace_tree`, `convert.html_to_page`, and the Contract 14 §3-step-3 render assertion. These are BLOCKED until S1 PASS. |
| **S2** (WP-S02) | Template-library save of atomic V4 (Source_Local::save_item) | `templates.save`, `templates.insert_into_page`, `templates.import` atomic correctness; reusable-block reuse. |
| **S3** (WP-S03) | HTML→native coverage baseline on real sections | Establishes the coverage numbers in `corpus.manifest.json`; `convert.*` coverage GATES (Contract 14 §6). No `convert.*` WP locks a coverage threshold before S3. |
| **S4** (WP-S04) | `Document::save_settings()` merge-vs-replace | `page.update_settings` merge behavior; until PASS, the PHP route does GET-merge-PUT (RESEARCH.md §5.2). |
| **S5** (WP-S05) | `UPDATE_CLASS` present for the agent user | Design-system class writes (`design.classes.*`, `design.deploy`); mitigated by the activation grant but probe required. |
| **S6** (WP-S06) | App-Password over plain HTTP on LocalWP/wp-env | The whole REST auth path on local/dev installs (foundation for every proxied tool); flags whether the local-environment filter is needed. |
| **S7** (WP-S07) | `wp elementor flush-css --network` reliability on multisite | Multisite cache-flush behavior for design-system writes; gates the multisite fan-out polish. |

Universal rule (LOCKED, from the mission): **every WRITE work package lists the PHP `dry_run` validator WP as a dependency; every atomic-CSS-affecting WP depends on the prime-css WP and WP-S01.**

---

## 7. Versioning & SDK trap guards (LOCKED)

- Pin `@modelcontextprotocol/sdk@^1.29` in `packages/server/package.json`; a CI check fails if a `2.x` `@modelcontextprotocol/*` package appears in the lockfile.
- Elementor + Pro versions are pinned in `.wp-env.json` (4.1.1 / 4.1.0); the schema-drift job (Contract 14 §5) is the guard against drift when these are bumped.
- The plugin's `Requires Plugins`/version guards refuse to bootstrap on incompatible Elementor majors and report via `site.capabilities` rather than fatally erroring.
