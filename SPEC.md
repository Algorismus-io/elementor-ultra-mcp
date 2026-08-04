# ULTRA Elementor MCP — Product Development Spec

> **What this is.** The complete, parallel-buildable product development specification for the ULTRA
> Elementor MCP: an agent-operable control surface that lets an LLM read, build, refactor, and govern
> real Elementor websites (including Editor V4 "Atomic Widgets") over a clean, authenticated, headless
> path — with validation, diffs, rollback, and an HTML→native conversion pipeline.
>
> **What this is NOT.** This repository's `spec/` tree contains **no product code**. It contains frozen
> contracts, decomposed work packages, and the build-orchestration layer. Product code is produced by
> separate build workflows, each consuming one work package.
>
> **Source of truth.** `RESEARCH.md` (architecture blueprint) and `SUPPLEMENT.md` (deep reference) at
> the repo root, plus the Elementor 4.1.1 / Pro 4.1.0 source under `plugins/elementor` and
> `plugins/elementor-pro`. Every behavior in the spec cites these by section or `path:line`.

---

## 1. How to read this spec

Read top-down; each layer narrows from intent to buildable units.

1. **`spec/00-product-overview.md`** — vision, personas, in-scope vs non-goals, phased scope. Start here.
2. **`spec/01-architecture.md`** — the hybrid component model, module boundaries, dependency model,
   parallelization strategy, canonical repo layout (§5), deployment topology, cross-cutting ownership.
3. **`spec/contracts/`** — the FROZEN contracts. These are the seams every work package builds against;
   they change only by deliberate amendment. See the contract index (§3).
4. **`spec/work-packages/`** — the 75 work-package files (`WP-*.md`). Each is a self-contained build
   spec: YAML frontmatter (id, layer, phase, depends_on, files_owned, contract_refs, estimate) + the
   interface, requirements, acceptance criteria, and tests for one independently buildable unit.
5. **`spec/work-packages.json`** — the machine-readable index the build orchestrator consumes. One
   object per WP with `wave` (DAG depth) and `parallel_group` (file-disjoint concurrency label).
6. **`spec/BUILD-PLAN.md`** — the human-readable build plan: the dependency DAG, the wave table, the
   proven parallel batches, milestone mapping, spike gates, critical path, and the launch protocol.
7. **`spec/spikes/`** — day-0 de-risking spikes (`WP-S01..S07`), each with scripts and a recorded verdict.

**If a work package and a frozen contract disagree, the contract (and `spec/00`) win — raise the
conflict, do not silently diverge.**

---

## 2. Architecture summary

A **hybrid** system across four tiers (`spec/01-architecture.md §1`):

- **Tier 1 — MCP client** (Claude Desktop/Code, Cursor, any MCP client).
- **Tier 2 — Fat external TypeScript/Node MCP server** (`packages/server`, `@modelcontextprotocol/sdk ^1.29`).
  Owns the MCP protocol, the namespaced tool/resource/prompt surface, the HTML→native pipeline,
  diff/dry-run orchestration, idempotency, ID minting + dedupe, **pre-filter** validation, per-site
  auth, pagination, and tool-profile management. Owns no database access; talks only to Tier 3 over
  HTTP/Basic.
- **The seam** — a frozen REST contract over `Authorization: Basic` (WordPress Application Passwords).
- **Tier 3 — Focused companion WordPress plugin** (`plugin/elementor-ultra-mcp`, PHP). Exposes
  capability-gated custom REST under `elementor-ultra/v1/*`. Owns the **AUTHORITATIVE `dry_run`
  validator**, `Document::save()` wrapping, transactional edit (base_hash/locks/autosave), **CSS
  priming** (V4 atomic CSS does not render on a headless save), revision-independent backups, ID
  validate/remap, design-system writes via the repository abstraction, media, nav, templates, Pro,
  cache, and the ops log.
- **Tier 4 — Elementor + WordPress** underneath.

The single load-bearing fact: the missing primitive is **writing the element tree over a clean,
authenticated, headless path**. The canonical write `Document::save(['elements'=>…,'settings'=>…])`
is reachable cleanly only via admin-ajax (cookie+nonce), which Basic auth does not reach — so the
companion PHP plugin exposes it over an App-Password REST route, and (because atomic saves throw on a
single bad prop) is also the authoritative validator. Everything else follows from that.

---

## 3. Contract index (`spec/contracts/`)

| Contract | File | Freezes |
| --- | --- | --- |
| 10 — REST API | `spec/contracts/10-rest-api.md` (+ `openapi.yaml`) | The companion-plugin REST surface `elementor-ultra/v1/*`: routes, payloads, envelopes, pagination, dry-run-before-commit. The Tier-2↔Tier-3 seam. |
| 11 — Authoring contract | `spec/contracts/11-authoring-contract.md` | The typed element-authoring envelope: atomic prop-types, style variants, element nodes, page trees, diffs, and validation rules R1-R9. |
| 12 — Error taxonomy | `spec/contracts/12-error-taxonomy.md` | Stable error codes (no string-matching), the TS error classes ↔ PHP `WP_Error` map, and the error payload shape. |
| 13 — Tool catalog | `spec/contracts/13-tool-catalog.md` | The frozen MCP tool / resource / prompt catalog, namespacing, lean-vs-full surface, profiles, annotations/elicitation, and the side-of-implementation table. |
| 14 — Fixtures harness | `spec/contracts/14-fixtures-harness.md` | The golden-fixtures format, the contract-test runners, the PHP dry_run round-trip, and the Inspector smoke harness. |
| 15 — Engineering standards | `spec/contracts/15-engineering-standards.md` | Repo/tooling baseline, TS + PHP/WordPress conventions, the SDK ^1.29 pin + version guards, Definition of Done. |
| 16 — Behavior conversion | `spec/contracts/16-behavior-conversion.md` | Behavior tiers for the HTML converter: what converts natively, what flattens, what drops — always honestly accounted. |
| 17 — Conversion integrity | `spec/contracts/17-conversion-integrity.md` | The closed-loop converter: integrity invariants I1-I4, the post-save verification loop, CI corpus, odiff acceptance. |
| 18 — Figma front-end | `spec/contracts/18-figma-frontend.md` | Figma→IR front-end feeding the conversion pipeline at the IR seam; never degrades below the HTML path. |
| 19 — Authoring integrity | `spec/contracts/19-authoring-integrity.md` | Settings-bag validation, post-save render verification, iterate-in-place (file-based replace/deploy), fonts.install, capture/audit tooling. From the R4 "Five Pathways" field run. |
| JSON schemas | `spec/contracts/schemas/*.json` | `atomic-prop-types`, `style-variant`, `element-node`, `page-tree`, `diff` — the machine-readable authoring schemas. |

---

## 4. Build-plan summary

The full plan is in **`spec/BUILD-PLAN.md`**; the machine index is **`spec/work-packages.json`**.

- **75 work packages**, organized into **13 waves** (wave 0 .. wave 12). `wave = 1 + max(wave of deps)`;
  root WPs are wave 0. Each wave is a single **file-disjoint parallel batch** — verified: no dependency
  cycles, no undefined dependencies, no same-wave file conflicts.
- **Critical path (13 WPs):**
  `WP-F01 → WP-F03 → WP-F04 → WP-H01 → WP-H03 → WP-H04 → WP-H05 → WP-H06 → WP-H07 → WP-H08 → WP-H09 → WP-H10 → WP-H11`
  — the HTML→native conversion pipeline plus its three frozen-contract ancestors. It is the schedule
  bottleneck; dedicate a continuous worker to it from wave 3 on.

### Counts

| Layer | WPs | | Phase | WPs | Frontier wave |
| --- | --- | --- | --- | --- | --- |
| foundation | 7 | | foundation | 17 | 3 |
| spike | 7 | | MVP | 17 | 6 |
| php | 22 | | v1 | 24 | 12 |
| ts | 19 | | ULTRA | 17 | 11 |
| html | 12 | | | | |
| qa | 8 | | | | |

### Wave 0 (the root)
`WP-F01` — pnpm/turbo monorepo scaffold, TS packages, base tooling, wp-env. Everything depends on it.

### Wave 1 (10 WPs, launch together)
`WP-F02` (REST contract→types), `WP-F03` (authoring contract→types/schemas), `WP-F05` (error taxonomy
+ capability probe), and all seven spikes `WP-S01..S07`, plus `WP-T02` (transport). Freezing F02/F03/F05
and landing the spike verdicts unblocks the tool catalog, fixtures harness, plugin bootstrap, and the
entire PHP/TS/HTML fan-out.

---

## 5. Locked decisions

These are fixed for the whole build; a work package may not relitigate them.

- **Hybrid topology.** Companion WordPress plugin (PHP) at `plugin/elementor-ultra-mcp` **+** external
  TypeScript/Node MCP server at `packages/server` on `@modelcontextprotocol/sdk ^1.29` — **NOT** 2.x
  alpha (`inputSchema`/`outputSchema` are ZodRawShape maps, not `z.object`). A CI guard forbids SDK 2.x.
- **Deployment.** Agency **LOCAL/DEV** WordPress; **single-site first, multisite-aware**. Production/HTTPS
  is out of the primary path.
- **V4 atomic-first, V3 fallback.** New pages default to V4 atomic; fall back to V3 classic when atomic
  is inactive (probe capabilities first).
- **HTML conversion never auto-commits.** Always dry-run + diff + coverage report + explicit `commit`
  with elicitation confirm.
- **WooCommerce deferred to ULTRA.** Only the context-validation contract (which Woo widgets are valid
  in which document type) is specified now; full Woo authoring is an ULTRA milestone.
- **The PHP `dry_run` is the AUTHORITATIVE validator.** The TS validator is a pre-filter only. Every
  WRITE work package depends on the PHP `dry_run` validator (`WP-P03`).
- **Prime-css is MANDATORY.** V4 atomic CSS does not render on a headless save → a prime-css step is
  required, gated on spike `WP-S01`. Every atomic-CSS-affecting WP depends on the prime-css service
  (`WP-P05`) and `WP-S01`.
- **`UPDATE_CLASS` is migration-granted (admin-only).** The companion plugin grants it idempotently on
  activation; spike `WP-S05` confirms the grant reaches the agent user.
- **Auth = WordPress Application Passwords (HTTP Basic).** Transport = **stdio + Streamable HTTP**.
- **No raw `_elementor_data` meta writes**, no built-in Elementor MCP / WP Abilities API as a
  load-bearing path (abilities are a secondary, graceful-no-op path), no unbounded reads (all
  list/read tools are paginated).

---

## 6. Repository map

```
RESEARCH.md, SUPPLEMENT.md          source of truth (blueprint + deep reference)
plugins/elementor, elementor-pro    Elementor 4.1.1 / Pro 4.1.0 source (cite path:line)
SPEC.md                             this file — top-level entry point
spec/
  00-product-overview.md            vision, scope, phases
  01-architecture.md                hybrid model, boundaries, repo layout, parallelization
  contracts/                        FROZEN seams (10 REST, 11 authoring, 12 errors,
                                    13 catalog, 14 fixtures, 15 standards, openapi.yaml, schemas/)
  work-packages/                    75 WP build specs (WP-F/S/P/T/H/R/Q*.md)
  work-packages.json                machine-readable WP index (wave + parallel_group)
  BUILD-PLAN.md                     DAG, wave table, parallel batches, spike gates, launch protocol
  spikes/                           day-0 spike scripts + verdicts (produced by WP-S01..S07)
```

Product code targets (produced by build workflows, owned per-WP): `packages/server/src/...`,
`packages/shared/...`, `plugin/elementor-ultra-mcp/includes/...`.
