# Contract 14 — Golden-Fixtures + Contract-Test Harness

Status: FROZEN. This is the authoritative format that proves the TypeScript server and the PHP companion plugin agree on the authoring contract, and that catches Elementor version drift before it reaches a build agent. Build WPs (WP-F06 golden-fixtures harness, WP-F07 CI pipeline, WP-Q## QA) implement this exactly. The fixture directory layout, file naming, and the JSON envelope shape defined here are reused by every layer that asserts against fixtures.

Source of truth: RESEARCH.md §9.3 (testing strategy a–f), §1 bullet 5 (PHP `dry_run` is authoritative; TS is a pre-filter), §2.1 (atomic throws), §4.5 (validation rules), §6.8 (HTML coverage gate), §10 (validator-drift risk). Tool/resource contract: `spec/contracts/13-tool-catalog.md` (Contract 13). Authoring JSON contract: `spec/contracts/11-authoring-contract.md` (WP-F03). REST contract: `spec/contracts/10-rest-api.md` (WP-F02). Error taxonomy: `spec/contracts/12-error-taxonomy.md` (WP-F05). Repo layout: RESEARCH.md §9.2.

---

## 0. Why this harness exists (LOCKED rationale)

The system's top risk is **atomic-save-throws + validator drift**: a single bad atomic prop aborts the whole save (`has-atomic-base.php:88-117`), and a faithful TS reimplementation of `Props_Parser`/`Style_Parser`/`Style_Schema` is too brittle to be authoritative (RESEARCH.md §1 bullet 5). Therefore:

1. The **PHP `dry_run`** endpoint is the SINGLE SOURCE OF TRUTH for validity. Every fixture's "is this valid?" verdict is established by round-tripping through PHP `dry_run`, never by the TS pre-filter alone.
2. The **TS pre-filter** is tested only for being a correct *subset* — it must never accept what PHP rejects on the cases it claims to cover (no false-positives that would let bad input reach a save), but it MAY defer (return "unknown/needs-PHP") rather than decide.
3. A **schema-drift CI job** fetches the live `get_props_schema()` for every supported atomic widget and diffs it against the TS pre-filter's expectations, failing on mismatch so an Elementor version bump is caught at CI, not at a customer save.

---

## 1. Fixture directory layout (LOCKED)

All fixtures live under `packages/shared/fixtures/` (the `packages/shared` package per RESEARCH.md §9.2 holds "JSON schemas + golden-tree fixtures (TS<->PHP)"). Both the TS test runner (vitest) and the PHP test runner (PHPUnit/wp-env) read this single directory, so there is exactly one copy of every golden tree.

```
packages/shared/fixtures/
├─ trees/                       # (a) golden element-tree fixtures (per-widget + composite)
│  ├─ v4/
│  │  ├─ valid/
│  │  │  ├─ e-heading.basic.json
│  │  │  ├─ e-div-block.flex-row.json
│  │  │  ├─ e-button.with-link.json
│  │  │  ├─ e-image.id-only.json
│  │  │  ├─ hero-section.composite.json
│  │  │  └─ ...                 # one+ per atomic widget in SUPPLEMENT §B.2
│  │  └─ invalid/
│  │     ├─ e-heading.bad-tag-enum.json
│  │     ├─ e-div-block.image-src-id-and-url.json     # XOR violation
│  │     ├─ e-button.missing-required-prop.json
│  │     ├─ local-style.id-not-in-classes.json        # detached style
│  │     └─ ...
│  ├─ v3/
│  │  ├─ valid/  (heading.basic.json, container.flex.json, ...)
│  │  └─ invalid/ (unknown-widgettype.json, ...)      # NB legacy unknowns DROP (not throw)
│  └─ design/
│     ├─ global-classes.upsert-diff.json              # diff-PUT body fixtures
│     └─ variables.batch.json
├─ schemas/                     # (b) snapshot of live get_props_schema() per widget (drift baseline)
│  ├─ e-heading.schema.json
│  ├─ e-div-block.schema.json
│  ├─ style-schema.json
│  └─ ...
├─ html/                        # (d) HTML→native corpus
│  ├─ sections/
│  │  ├─ 01-pricing-table/{input.html, input.css, expected.coverage.json, expected.a11y.json}
│  │  ├─ 02-hero/{...}
│  │  └─ ...                    # ≥5 real marketing sections (S3 corpus)
│  └─ corpus.manifest.json      # maps each section to its expected S3-anchored thresholds
├─ roundtrip/                   # (e) round-trip identity fixtures (build→get_structure→normalize)
│  └─ *.json                    # each carries {input_tree, normalized_expected}
└─ envelopes/                   # (c) MCP Inspector smoke payloads (minimal valid input per lean tool)
   └─ smoke.<tool-name>.json    # e.g. smoke.elementor.page.dry_run.json
```

Naming convention (LOCKED): `<elementType-or-scenario>.<variant>.json` for trees; `<widgetType>.schema.json` for schema snapshots; `smoke.<full.tool.name>.json` for Inspector payloads.

---

## 2. Fixture file envelope (LOCKED)

Every tree fixture is a single JSON object with this envelope so the TS and PHP runners interpret it identically:

```jsonc
{
  "$fixture": 1,                       // envelope version
  "id": "e-heading.basic",             // unique fixture id (== filename minus .json)
  "kind": "tree",                      // tree | design | html | roundtrip | smoke
  "generation": "v4",                  // v4 | v3 | mixed
  "title": "Atomic heading, h1, single local style",
  "expect": {
    "valid": true,                     // PHP dry_run verdict (AUTHORITATIVE — see §3)
    "errors": []                       // when valid:false, the expected error codes (NOT messages)
  },
  "requires": {                        // capability gates; runner SKIPS if unmet on the target site
    "experiments": ["e_atomic_elements"],
    "pro": false,
    "min_elementor": "4.1.1"
  },
  "tree": [ /* array of ElementNode (Contract 11 authoring contract) */ ],
  "settings": {},                      // optional document/page settings
  "prefilter": {                       // TS pre-filter contract for THIS fixture
    "verdict": "accept"                // accept | reject | defer  (see §4)
  }
}
```

Rules:
- `expect.errors[]` carries **SCREAMING_SNAKE_CASE error CODES from the taxonomy** (`spec/contracts/12-error-taxonomy.md` §3), e.g. `ATOMIC_SETTINGS_INVALID`, `ATOMIC_STYLES_INVALID`, `IMAGE_SRC_XOR_VIOLATION`, `LOCAL_STYLE_UNLINKED`, `UNKNOWN_WIDGET_TYPE`, `DUPLICATE_ELEMENT_ID`. NEVER raw Elementor throw-message strings — the throw text (`has-atomic-base.php:95-98`) is explicitly not to be matched (RESEARCH.md §2.1, taxonomy §4 "NEVER leaks the raw throw message as a code").
- A fixture whose `requires` are unmet on the target install is SKIPPED (reported as skipped, not failed) so the same corpus runs on free-only and Pro installs.
- `prefilter.verdict` is asserted by the TS unit suite (§4); `expect.valid` is asserted by the PHP round-trip suite (§3).

---

## 3. How a fixture is round-tripped through PHP `dry_run` (LOCKED — RESEARCH.md §9.3a/§9.3f)

The authoritative test. Runs under PHPUnit in wp-env with Elementor + Pro active.

1. Boot wp-env (`.wp-env.json` at repo root, RESEARCH.md §9.2) with Elementor 4.1.1 + Pro 4.1.0 + the companion plugin, and the experiments listed in each fixture's `requires.experiments` activated.
2. For each `kind:"tree"` fixture whose `requires` are met:
   a. Load `tree` + `settings` from the fixture.
   b. Call the companion plugin's authoritative validator (`Validator::dry_run($elements, $settings)` per RESEARCH.md §9.2 `class-validator.php`), which instantiates every node via `create_element_instance()` + `get_data_for_save()` inside a try/catch and maps caught `\Exception` to structured errors (RESEARCH.md §7.1 transactional-edit, §2.1).
   c. Assert `result.valid === fixture.expect.valid`.
   d. When `expect.valid:false`, assert the set of returned `error.code` values equals `fixture.expect.errors` (order-independent set comparison).
3. For each `valid:true` `kind:"tree"` fixture, additionally:
   a. Create a throwaway draft document, `Document::save(['elements','settings'])`.
   b. Run the prime-css step (`CssPrimer`, RESEARCH.md §7.4) — **(f) render assertion / S1 regression**.
   c. Fetch the generated per-breakpoint CSS and assert it contains the expected local-style + global-class selector rules declared in the fixture's `tree` (RESEARCH.md §9.3f). This fixture-level CSS assertion is gated on Spike S1 passing; until then it runs as `xfail`/`skip` with a clear reason string.
   d. Trash the throwaway document in teardown.

The TS contract suite mirrors step 2 by calling the live `page.dry_run` tool (Contract 13 §1.2) against the same wp-env over App-Password REST, asserting the SAME `expect` — proving the TS proxy faithfully surfaces the PHP verdict.

---

## 4. TS pre-filter subset test (LOCKED — RESEARCH.md §1 bullet 5)

The TS pre-filter (`packages/server/src/authoring/prefilter.ts`, RESEARCH.md §9.2) is tested for safe-subset behavior using `fixture.prefilter.verdict`:

- `verdict:"accept"` — pre-filter MUST NOT reject; AND the fixture MUST have `expect.valid:true` (you may never pre-accept something PHP rejects).
- `verdict:"reject"` — pre-filter MUST reject; AND the fixture MUST have `expect.valid:false` (only reject things PHP also rejects — no false rejects on valid input).
- `verdict:"defer"` — pre-filter returns "unknown/needs-PHP" (e.g. conditional `Dependency_Manager` props, Union members, free-string props per SUPPLEMENT §B.3). The test asserts the pre-filter does NOT make a hard accept/reject decision and lets the input through to PHP.

Cross-check invariant (asserted as a meta-test over the whole corpus): for every fixture, `prefilter.verdict=="accept" ⇒ expect.valid==true` and `prefilter.verdict=="reject" ⇒ expect.valid==false`. A fixture that violates this is a corpus bug and fails CI.

---

## 5. The schema-drift CI job (LOCKED — RESEARCH.md §9.3b, §10 validator-drift)

The single most important drift guard. Lives as a CI job (WP-F07) and a vitest test.

Concept:
1. Boot wp-env with the pinned Elementor + Pro versions.
2. For every supported atomic widget (the set in SUPPLEMENT §B.2) and the Style-Schema, call `schema.widget` / `schema.styles` (Contract 13 §1.1) to fetch the LIVE post-filter `get_props_schema()` (incl. `_cssid`, Pro-injected `display-conditions`, runtime-extended background sub-schema).
3. Normalize the live schema (stable key sort; strip volatile fields like labels/descriptions; keep prop names, `$$type` keys, enum members, required flags, units).
4. Diff against the committed baseline in `packages/shared/fixtures/schemas/*.schema.json`.
5. **Fail the job on any diff.** The failure message lists added/removed/changed props per widget so a maintainer either (a) updates the TS pre-filter expectations + regenerates the baseline (an intentional Elementor version bump), or (b) treats it as an unexpected drift to investigate.

Baseline regeneration is an explicit, reviewed action: a script `pnpm fixtures:snapshot-schemas` (owned by WP-F06) rewrites the `schemas/*.schema.json` baseline from the live install; the diff in the PR is the human gate. The drift job NEVER auto-updates the baseline.

The job also asserts the TS pre-filter's hardcoded enum/required expectations match the baseline (so a baseline change that the pre-filter wasn't updated for also fails).

---

## 6. HTML→native corpus regression (LOCKED — RESEARCH.md §9.3d, §6.8)

For each section under `fixtures/html/sections/<n>/`:
1. Run `convert.html_to_tree` (Contract 13 §1.9) on `input.html` (+ `input.css`).
2. Assert `report.coverage` is within tolerance of `expected.coverage.json` (the S3-anchored numbers — never a hardcoded 85%; RESEARCH.md §6.8, SUPPLEMENT §C.4). Tolerance band stored per-section in `corpus.manifest.json`.
3. Assert `report.a11y` matches `expected.a11y.json` (heading hierarchy, empty interactive names, missing alt — RESEARCH.md §6.5).
4. Assert `report.stripped_text` lists the expected stripped block tags (the `html-v3` inline-only allowlist `[b,i,em,u,a,del,span,strong,sup,sub,s]`; RESEARCH.md §6.6, SUPPLEMENT §B.1).
5. Round-trip the produced `elements` through PHP `dry_run` (§3) and assert `valid:true` — the converter must never emit a tree PHP rejects.

The corpus thresholds in `corpus.manifest.json` are the regression baseline for the S3 number; lowering one requires an explicit PR diff.

---

## 7. Round-trip identity test (LOCKED — RESEARCH.md §9.3e)

For each `fixtures/roundtrip/*.json`:
1. `page.build` with `input_tree`.
2. `page.get_structure` (Contract 13 §1.1).
3. Normalize both the input and the fetched tree with the shared normalizer (`packages/server/src/authoring/contract.ts` normalizer), accounting for: content-sanitizer rewriting `title` for non-admins (run the test as admin so it is exempt, RESEARCH.md §2.1/§6.6), `html-v3` normalization, `_cssid` injection (tolerate on round-trip, RESEARCH.md §4.1), and ID minting (compare structurally, not by literal id).
4. Assert the normalized fetched tree equals `normalized_expected`.

This proves `build → read → normalize → equal` so diffs in production don't show spurious changes.

---

## 8. MCP Inspector smoke suite (LOCKED — RESEARCH.md §9.3c)

A fast end-to-end liveness check over the protocol surface:
1. Launch the TS server (stdio transport) pointed at the wp-env site via App-Password env (`WP_URL`/`WP_USER`/`WP_APP_PASSWORD`, Contract 13 §5.4).
2. Drive the MCP Inspector (`@modelcontextprotocol/inspector`) in CLI mode (or a thin SDK client) to:
   a. `tools/list` and assert the lean ★ set (Contract 13 §5.2) is present and enabled.
   b. For each lean ★ tool, call it with the minimal valid payload from `fixtures/envelopes/smoke.<tool-name>.json` and assert no protocol error (`-326xx`) and a well-formed result matching the tool's `outputSchema`.
   c. Read each resource URI (Contract 13 §2) and assert a JSON body.
   d. List prompts (Contract 13 §3) and assert all four are present.
3. Read-only smoke payloads run unconditionally; mutating smoke payloads target a disposable draft document created + trashed in fixture setup/teardown, and are skipped if `ULTRA_TOOLS`/capabilities make a tool unavailable.

Smoke payloads are minimal and capability-gated by the same `requires` mechanism (§2) so the suite is green on a free-only install (Pro smoke payloads skipped).

---

## 9. Test inventory mapping (LOCKED — which RESEARCH.md §9.3 item each suite covers)

| RESEARCH.md §9.3 | Suite | Runner | Fixture source | Pass gate |
|---|---|---|---|---|
| (a) golden trees | §3 round-trip through dry_run | PHPUnit (wp-env) + vitest (REST) | `trees/**` | `valid` + error-code set match |
| (b) schema-drift | §5 drift job | vitest + wp-env fetch | `schemas/*.schema.json` | zero diff vs baseline |
| (c) Inspector smoke | §8 | Inspector CLI / SDK client | `envelopes/smoke.*.json` | no `-326xx`, output matches schema |
| (d) HTML corpus | §6 | vitest | `html/sections/**` | coverage within tolerance + a11y/stripped match + dry_run valid |
| (e) round-trip identity | §7 | vitest (REST) | `roundtrip/*.json` | normalized equality |
| (f) render assertion (S1) | §3 step 3 | PHPUnit (wp-env) | `trees/v4/valid/**` | primed CSS contains expected rules (S1-gated) |
| (subset) TS pre-filter | §4 | vitest | `trees/**` + `prefilter.verdict` | safe-subset invariant holds |

---

## 10. CI wiring (LOCKED — feeds WP-F07)

The harness exposes these package scripts (names are part of the contract so WP-F07's CI YAML can call them):

- `pnpm fixtures:validate` — schema-validate every fixture file against the envelope (§2) + the JSON Schemas under `packages/shared/schemas/` (WP-F03). Pure, no WordPress.
- `pnpm test:unit` — vitest unit suites incl. the pre-filter subset test (§4). No WordPress.
- `pnpm test:contract` — vitest contract suites that hit a running wp-env over REST (§3 mirror, §6, §7). Requires wp-env.
- `pnpm test:drift` — the schema-drift job (§5). Requires wp-env.
- `pnpm test:smoke` — the Inspector smoke suite (§8). Requires wp-env + a built server.
- `composer test:php` — the PHPUnit authoritative suite (§3, §3 step 3). Runs inside wp-env.
- `pnpm fixtures:snapshot-schemas` — regenerate the §5 drift baseline (manual, reviewed).

CI job order (WP-F07): `fixtures:validate` + `test:unit` (no-WP, fast, every push) → spin up wp-env → `composer test:php` + `test:contract` + `test:drift` + `test:smoke` (PR + main). The drift job is a REQUIRED check on PRs that touch `packages/shared/schemas/` or the pre-filter.

---

## 11. Parallel-build guarantees (LOCKED)

- The fixture directory (`packages/shared/fixtures/`) is OWNED by WP-F06; other WPs ADD fixtures via new files only (disjoint paths) and never edit WP-F06's harness runner. A WP that needs a new fixture creates `packages/shared/fixtures/<area>/<new>.json`; two same-wave WPs adding fixtures touch different files by construction (each owns its widget/section slice).
- The schema baselines (`schemas/*.schema.json`) are generated artifacts owned by WP-F06; build WPs reference them read-only.
- Every WRITE-tree fixture's `expect.valid` is established by the PHP dry_run (§3), so a TS-layer WP and a PHP-layer WP that both consume the same fixture cannot disagree about the verdict — the fixture encodes the single PHP-derived truth.
