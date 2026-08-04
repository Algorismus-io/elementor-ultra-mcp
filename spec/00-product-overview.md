# 00 — Product Overview & Scope: ULTRA Elementor MCP

Status: authoritative scope frame for all work packages.
Source of truth: `RESEARCH.md` (architecture blueprint) and `SUPPLEMENT.md` (deep reference), both at the repo root. This document distills and frames; where it states a behavior of Elementor it cites the `RESEARCH.md` / `SUPPLEMENT.md` section that carries the verified `path:line`. It does not introduce any Elementor API not already verified there.

This file frames every work package. When a work package and this overview disagree on scope or a locked decision, this overview and the frozen contracts under `spec/contracts/` win; raise the conflict rather than silently diverging.

---

## 1. Product vision & the problem

**Vision.** ULTRA Elementor MCP is an agent-operable control surface for Elementor websites. It lets an LLM agent (Claude Desktop/Code, Cursor, or any MCP client) read, build, refactor, and govern real Elementor pages — including the Editor V4 / "Atomic Widgets" generation — over a clean, authenticated, **headless** path, with safety, validation, diffs, and rollback built in. It is built for an Elementor **agency** running many WordPress sites on local/dev environments first.

**The problem it solves.** An Elementor agency's highest-leverage, lowest-joy work is repetitive page production and maintenance: building pages from a brief, applying a design system consistently across dozens of pages, migrating existing HTML/CSS marketing pages into native Elementor widgets, and standing up Pro theme-builder parts (headers, footers, single templates, popups). Today this is hand-driven in the live editor, one element at a time. Elementor's own automation surface does **not** close the gap:

- Elementor ships two "MCP" systems, but the server-side Abilities MCP exposes only **5 read-heavy abilities** (`list-pages`, `get-page-structure`, `update-page-settings` (settings only), `create-page` (blank draft), `get-globals`), is gated behind an external, not-bundled WP Abilities API + MCP Adapter plus a hidden default-off experiment, and has **no element-tree write, no design-system write, no Pro surface, and no HTML conversion** (`RESEARCH.md §2.3`). The browser/editor MCP only works inside an open editor session (`RESEARCH.md §2.3`), so it is unusable for headless agency automation.
- The single missing primitive is **writing the element tree** over an authenticated headless path. The canonical write is `Document::save(['elements'=>…,'settings'=>…])`, reachable cleanly only via admin-ajax with cookie+nonce — not over Application Passwords (`RESEARCH.md §1 bullet 3`, `§8`).

ULTRA closes this gap with a **hybrid** system: a fat external TypeScript/Node MCP server that owns protocol, tool ergonomics, semantic HTML mapping, diffing, and idempotency; plus a focused companion WordPress plugin that wraps the internal Elementor PHP APIs HTTP cannot otherwise reach and acts as the **authoritative validator** (`RESEARCH.md §1`, `§3.1`).

---

## 2. Personas & primary use cases

**P1 — Agency producer (primary).** Builds and edits client pages from briefs all day. Wants to say "build a hero with a headline, subcopy, and a CTA" and get a real, styled, native Elementor page. Cares about speed, that the result renders correctly on the public URL, and that edits are reversible.

**P2 — Design-system owner.** Maintains the agency/client kit: global classes, design tokens (color/font/size variables), V3 global colors/fonts, per-widget defaults. Wants to audit and edit the design system programmatically and deploy it consistently, without corrupting the kit or blowing the 1000-item budget.

**P3 — Migration engineer.** Converts existing HTML/CSS marketing pages and component blocks into native Elementor widgets, hoisting repeated styles to global classes and literals to variables, sideloading media. Cares about honest coverage reporting and never silently shipping a low-fidelity page.

**P4 — Pro/theme-builder specialist.** Authors headers, footers, single/archive templates, 404/search, popups (with triggers + display conditions), forms, and loop items. Cares that display conditions actually apply (not silently dropped) and that Pro context rules are respected.

**Primary use cases (cross-persona).**
1. **Build-from-brief** — declarative tree → created/populated page that renders **styled** (P1). `RESEARCH.md §5.2`, `§9.1 MVP`.
2. **Edit/refactor** — surgical, idempotent element ops on existing pages with diff + dry-run + rollback (P1). `RESEARCH.md §5.3`, `§7`.
3. **Design-system management** — read/audit/upsert global classes, variables, V3 globals, defaults; bulk deploy (P2). `RESEARCH.md §5.4`, `§9.1 v1`.
4. **Pro authoring** — theme-builder parts, popups, forms, loop, dynamic, context-validated Woo (P4). `RESEARCH.md §5.8`, `§4.4`, `§9.1 ULTRA`.
5. **HTML → native conversion** (flagship) — parse → classify → map → style-extract → assemble → validate → persist, with hoisted classes/variables, sideloaded media, a11y lint, coverage report, never auto-committed (P3). `RESEARCH.md §6`, `§5.9`.

---

## 3. In-scope vs non-goals

### In scope (across phases)
- A **fat TypeScript MCP server** (`@modelcontextprotocol/sdk ^1.29`) owning the MCP protocol, namespaced tool/resource/prompt surface, HTML→native pipeline, diff/dry-run/idempotency engine, ID minting, per-site auth. `RESEARCH.md §1`, `§3.2`.
- A **focused companion WordPress plugin** (`plugin/elementor-ultra-mcp`) exposing capability-gated custom REST under `elementor-ultra/v1/*`, owning the **authoritative `dry_run` validator**, transactional save/edit, backup/rollback, atomic **CSS priming**, design-system writes via the repository abstraction, media, nav, templates, Pro, cache, and ops log. `RESEARCH.md §3.1`, `§9.2`.
- **V4 atomic-first authoring** with **V3 classic fallback** when atomic is inactive (probe capabilities). `RESEARCH.md §1 bullet 4`, `§4`.
- **Auth via WordPress Application Passwords (HTTP Basic)**; transports **stdio + Streamable HTTP**. `RESEARCH.md §8`, `§3.2`.
- **Secondary** WP Abilities + our own `create_server()` registration, lit up only when the external Adapter is present (graceful no-op otherwise). `RESEARCH.md §3.2`.

### Non-goals (explicit)
- **No live-editor browser package in v1.** No `$e.run`-driven in-editor JS package, no Angie/`navigator.modelContext` integration as a shipped product surface in MVP/v1. The system is **headless-first**; a browser package is, at most, a later/ULTRA consideration, not a v1 deliverable. `RESEARCH.md §12 Q4`, `§2.3`.
- **WooCommerce build surface is deferred to ULTRA.** Only the **context-validation contract** (which Woo widgets are valid in which document type) is specified now; full Woo authoring is an ULTRA milestone. `RESEARCH.md §5.8 (Woo note)`, `§9.1 ULTRA`.
- **No production/cloud hosting target as primary.** Deployment target is **agency LOCAL/DEV** WordPress, single-site first, multisite-aware. Production needs HTTPS and is out of the primary path. `RESEARCH.md §8`.
- **No dependency on the built-in Elementor MCP / WP Abilities API / MCP Adapter as a load-bearing path.** They are not bundled and are experiment-gated; we use them only opportunistically. `RESEARCH.md §3.2`.
- **No raw `_elementor_data` meta writes** as a product behavior. All writes go through the document pipeline; the only exception requires `wp_slash(wp_json_encode())` plus manual CSS/cache deletion and is avoided. `RESEARCH.md §7.3`.
- **No SDK 2.x.** We do not build against `@modelcontextprotocol/server@2.0.0-alpha`; its API differs (`z.object` vs ZodRawShape, Standard Schema). `RESEARCH.md §3.2`, `§10`.
- **No `posts_per_page=-1` style unbounded reads.** Every list/read tool is paginated. `RESEARCH.md §5 (conventions)`.

---

## 4. Locked decisions (verbatim constraints)

These are LOCKED and bind every work package. They are reproduced verbatim from the mission brief; treat each as a hard constraint, not a recommendation.

1. **Hybrid** = companion WordPress plugin (PHP) at `plugin/elementor-ultra-mcp` + external TypeScript/Node MCP server at `packages/server` using `@modelcontextprotocol/sdk ^1.29` (NOT 2.x alpha; `inputSchema`/`outputSchema` are `ZodRawShape` maps).
2. **Deployment:** agency LOCAL/DEV sites, single-site first, multisite-aware.
3. **New pages default to V4 atomic, fall back to V3 when atomic inactive** (probe capabilities).
4. **HTML conversion NEVER auto-commits** (always dry-run + diff + coverage report + explicit commit, elicitation confirm).
5. **WooCommerce deferred to ULTRA phase** (context-validation contract specified now).
6. **The PHP `dry_run` is the AUTHORITATIVE validator; the TS validator is a pre-filter only.**
7. **V4 atomic CSS does NOT render on a headless save** -> a **prime-css step is MANDATORY** (depends on spike WP-S01).
8. **UPDATE_CLASS is migration-granted (admin-only)** -> the companion plugin grants it idempotently on activation.
9. **Auth = WordPress Application Passwords (HTTP Basic).**
10. **Transport = stdio + Streamable HTTP.**

Corollary build rules derived from the locks (also constraints):
- Every WRITE work package depends on the PHP `dry_run` validator WP. `RESEARCH.md §1 bullet 5`.
- Every atomic-CSS-affecting work package depends on the prime-css WP and WP-S01. `RESEARCH.md §7.4`.
- Destructive tools set `annotations.destructiveHint:true` and gate behind elicitation confirm; elicitation schemas are flat primitives only. `RESEARCH.md §7.5`.

---

## 5. Phasing & milestones

Phasing maps directly to `RESEARCH.md §9.1`. **A spike gate precedes the build:** S1, S2, S3 (and S4/S5/S6/S7 as their features arrive) MUST be run before locking milestone numbers. The previously assumed "85% HTML coverage" is replaced by an **S3-derived number** (`SUPPLEMENT.md §C.4` sets the honest expectation at ~60–80% native-prop coverage on real marketing sections).

### Foundation (pre-MVP)
Repo scaffold + monorepo + tooling; frozen contracts realized as code (REST API contract, authoring JSON contract + JSON Schemas + shared TS types, MCP tool/resource/prompt catalog schemas, error taxonomy + capability/experiment probe); golden-fixtures contract-test harness; CI incl. a schema-drift job. **Done when:** the frozen contracts exist under `spec/contracts/`, shared types/schemas compile, the fixtures harness runs green on a stub, and CI (including the schema-drift job) is wired. Foundation WP IDs: `WP-F01`–`WP-F07`.

### Spike week (week 0) — de-risk before build
Run S1 (headless atomic save + CSS priming), S2 (template-library atomic save), S3 (HTML→native coverage baseline), S5 (`UPDATE_CLASS` presence), S6 (App-Password over HTTP); S4 and S7 as adjacent. **Done when:** S1 passes (or a working prime-css approach is identified) **and** an S3 coverage number exists to anchor the roadmap. `RESEARCH.md §0`, `§9.1`.

### MVP (weeks 1–3) — read + safe write, V4-first, single site
- **Companion plugin routes:** `documents/{id}/save|edit|dry-run|backup|rollback|prime-css`, `schema/widget/{type}` (post-filter, incl. `_cssid`), `site/capabilities`, `ids/validate|remap`, `lock-status`, `autosave-status`, cache regen; activation `UPDATE_CLASS` grant.
- **TS server** (stdio + Streamable HTTP): `pages.list`, `page.get_structure`, `page.create`, `page.build` (V4), `widget.update_settings`, `page.dry_run`, `schema.widget`, `site.capabilities`.
- ID minting + dedupe; **PHP-authoritative validation**; App-Password auth; **post-save atomic CSS priming**.
- **Milestone / definition of done:** build a hero section (`e-div-block` > `e-heading` + `e-paragraph` + `e-button`) from a brief and **confirm it renders STYLED on the public URL**; safely edit an existing page with **diff + rollback**. `RESEARCH.md §9.1 MVP`.

### v1 (weeks 4–8) — design system + templates + media + nav + V3 fallback + HTML→native v1
- **Design-system WRITE:** `classes.upsert/delete/reorder` (**diff PUT**, budget-checked), `variables.*` (watermark, all three types incl. size), V3 `globalColors/Fonts`, `sync_v4_to_v3`, `element_defaults`, `deploy`.
- **Media** (`media.sideload_url/upload/list`); **Nav** (`nav.menus.*`/`bind_widget`); **Templates/kits**.
- **V3 classic authoring** + dynamic/globals binding + `dynamic.get_tag_schema`.
- **HTML→native v1:** `convert.html_to_tree`/`html_to_page` with native-prop + local-style + global-class mapping, direction-aware logical conversion, media sideload, a11y lint, coverage report.
- **Tool-surface management** (namespacing, lean profile, `tools.search`, pagination, dynamic enable); WP Abilities + own `create_server()` when Adapter present.
- **Milestone / definition of done:** convert a real marketing page to the **S3-anchored native-coverage target** with hoisted classes + variables + sideloaded media; perform a full design-system audit/edit. `RESEARCH.md §9.1 v1`.

### ULTRA (weeks 9–14) — Pro surface + fidelity + observability + polish
- **Pro:** theme builder (header/footer/single/archive/404/search) via `Conditions_Manager::save_conditions()`, popups + triggers, atomic forms, loop builder/grid, dynamic (ACF/post), **context-validated WooCommerce** widgets.
- **HTML→native v2:** variable-extraction tuning, state/breakpoint variants, **fidelity visual-diff** (`convert.fidelity_check`), fallback-ladder reporting.
- **Observability:** `ops.log`, `op_id` tracing, wired `create_server()` observability; `batch.plan/apply` cross-doc transactions.
- **Prompts:** `build-from-brief`, `html-to-native`, `design-system-audit`, `theme-builder-from-spec`. **Multisite fan-out**; paginated resource catalogs.
- **Milestone / definition of done:** end-to-end "agency site from brief" (pages + theme builder + design system + popups) with diffs, previews, rollbacks, and a **cross-doc compensation path**. `RESEARCH.md §9.1 ULTRA`.

---

## 6. Success metrics

These are the testable outcomes that define product success; they map to the testing strategy in `RESEARCH.md §9.3`.

| # | Metric | Target / gate | Evidence | Phase |
|---|---|---|---|---|
| M1 | **Build-a-hero-renders-styled** | A brief-built `e-div-block > e-heading + e-paragraph + e-button` is created, primed, and the **public URL's generated CSS contains the local + global class rules** (not unstyled). | S1 render-assertion regression (`§9.3f`); fetch public URL, assert CSS. | MVP |
| M2 | **Safe-edit-with-rollback** | Any edit produces a structured diff, passes authoritative `dry_run`, is reversible via revision-independent backup; concurrency guarded by `base_hash` + lock + autosave check. | Round-trip identity + diff tests (`§9.3e`); rollback restores prior tree + regenerates/primes CSS. | MVP |
| M3 | **HTML coverage gate** | Conversion reports per-section coverage (`% native / % class / % custom_css / % dropped`), a11y findings, stripped-text findings; **never auto-commits below the S3-derived threshold** (honest band ~60–80% native; `SUPPLEMENT.md §C.4`). | HTML→native corpus regression (`§9.3d`); coverage report present and enforced. | v1 |
| M4 | **Validator fidelity (no drift)** | Every supported atomic widget's golden fixture round-trips through PHP `dry_run`; a CI schema-drift job fails on `get_props_schema()` mismatch vs the TS pre-filter. | Golden fixtures + schema-drift CI (`§9.3a,b`). | Foundation→ongoing |
| M5 | **Design-system safety** | `classes.upsert` uses the **diff PUT** (consistent full `order`, explicit `changes.deleted`), pre-flights the 1000-item budget, and reconciles `DUPLICATED_LABEL` soft errors. | Design-system contract tests; budget pre-flight asserted. | v1 |
| M6 | **Capability-aware operation** | The server probes `site/capabilities` before assuming any route; design-system tools hard-fail with actionable messages when `can_update_class=false` or atomic experiment inactive; falls back to V3 when atomic inactive. | `site/capabilities` probe + V4/V3 fallback tests; `UPDATE_CLASS` activation grant verified (S5). | MVP→v1 |
| M7 | **Visual fidelity (honest, per-section)** | `convert.fidelity_check` renders the saved page and the source HTML headless, compares (pixelmatch on `diffPixels/total`), and reports a per-section score — **never a global promise**. | Visual-diff gate (`§6.8`, `SUPPLEMENT.md §C.4`). | ULTRA |
| M8 | **Cross-doc transaction integrity** | `batch.apply` records backups of the kit + every touched doc up front and best-effort compensates on partial failure. | Batch compensation test; per-step result map. | ULTRA |

---

## 7. Glossary

- **Atomic / V4 ("Atomic Widgets" / Editor V4)** — Elementor's newer element generation (`e-*` types: `e-div-block`, `e-flexbox`, `e-heading`, `e-paragraph`, `e-button`, `e-image`, etc.). Node settings are **typed envelopes** `{"$$type","value","disabled"?}`; the node carries sibling keys `version`, `styles`, `editor_settings`, `interactions`. Styling is via the per-element `styles` map (local classes) + referenced global classes — not control selectors. Atomic saves are **strict and throw** on one bad prop. `RESEARCH.md §2.1`, `§4.1`.
- **V3 / classic** — the legacy generation (`section`/`column`/`container` + classic widgets). `settings` is a flat assoc array; CSS comes from each control's `selectors`; responsive uses suffix keys `_tablet`/`_mobile`; switchers are `"yes"`/`""`. Unknown classic types are **silently dropped** on save. `RESEARCH.md §2.1`, `§4.2`.
- **Kit** — the active Elementor kit, a CPT holding cross-cutting design settings: V3 global colors/fonts (repeaters in kit settings), V4 variables (`_elementor_global_variables` JSON meta), and the cross-class indexes for global classes. Kit/global changes require a **full CSS flush**. `RESEARCH.md §2.2`, `§7.2`.
- **Global class** — a reusable, named style set stored in the `e_global_class` CPT (underscores), indexed on the active kit, referenced by elements via the `classes` prop. Always read/write through `Global_Classes_Repository` (migration-transparent). The REST PUT is **diff-based**, capped at 1000 items. `RESEARCH.md §2.2`, `§5.4`.
- **Variable (design token)** — a V4 design token (`global-color-variable`, `global-font-variable`, `global-size-variable` — **all FREE**) stored in kit meta `_elementor_global_variables`. Referenced by **variable id**; renders as `var(--Label)`. Optimistic concurrency via a `watermark`. Limit 1000. `RESEARCH.md §2.2`.
- **Ability** — a registered WP "ability" (`wp_register_ability`) in the external WP Abilities API model that the external MCP Adapter can expose. Elementor's built-in MCP registers 5 read abilities. We mirror the `Ability_Definition` / `Abstract_Ability` pattern for our **secondary** path only. `RESEARCH.md §2.3`, `§3.2`.
- **dry_run** — the **authoritative validation** step performed PHP-side: instantiate every node + `get_data_for_save()` in try/catch, return structured errors/diff, persist nothing. The TS validator is a cheap **pre-filter only**. Every write round-trips through `dry_run` before commit. `RESEARCH.md §1 bullet 5`, `§4.5`, `§5.2`.
- **prime-css** — the **mandatory** post-save step that triggers a frontend render so atomic styles actually emit per-breakpoint CSS files (`Post_CSS::create()->update()` does NOT emit atomic CSS). Without it, atomic pages render unstyled. Gated by spike WP-S01. `RESEARCH.md §7.4`, `§2.1`.
- **op_id** — a deterministic idempotency token threaded TS→PHP→`Document::save()` (stored in `editor_settings`/a hidden setting). On replay, the operation is detected and no-ops. Used with `base_hash`. `RESEARCH.md §7 (idempotency)`, `§5.10`.
- **base_hash** — an optimistic-concurrency token, `md5(_elementor_data)`, returned on read and required on write; a stale value rejects the write. Note it does not reflect a pending **autosave**, so writes also check `get_newer_autosave()`. `RESEARCH.md §5.3`, `§7 (concurrency)`.

Additional terms used throughout: **typed envelope** (`{"$$type","value"}`), **local style** (element-scoped style id mirrored into the element's `classes` prop), **fallback ladder** (native prop → local style → global class → Pro `custom_css.raw` → html-widget dump), **coverage report** (per-section native/class/custom_css/dropped breakdown + a11y + stripped-text), **capabilities probe** (`site/capabilities`, reporting atomic/global-class/variable/Pro/migration/`can_update_class` state). `RESEARCH.md §4.1`, `§6.4`, `§6.8`, `§5.1`.

---

## 8. How this frames the work packages

- **Canonical paths** for `files_owned` come from `RESEARCH.md §9.2` (`packages/server/src/...`, `plugin/elementor-ultra-mcp/includes/...`, `packages/shared/...`).
- **Frozen contracts** live under `spec/contracts/` (REST API contract, authoring JSON contract + JSON Schemas, MCP catalog schemas, error taxonomy). Work packages depend on these contracts, not on each other's code, wherever possible. `RESEARCH.md §9.3`.
- **WP-ID scheme:** `WP-F##` foundation, `WP-S##` spikes, `WP-P##` PHP plugin, `WP-T##` TS server, `WP-H##` HTML pipeline, `WP-R##` Pro surface, `WP-Q##` QA/CI/release.
- **Universal dependency rules** (from §4 corollaries): every WRITE WP depends on the PHP `dry_run` validator WP; every atomic-CSS-affecting WP depends on the prime-css WP and `WP-S01`; design-system WPs depend on the `UPDATE_CLASS` activation grant + capabilities probe.
