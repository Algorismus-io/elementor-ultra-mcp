---
id: WP-H11
title: convert.* MCP tools (html_to_tree / html_to_page / fidelity_check) + persist orchestrator
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-F04
  - WP-F05
  - WP-T01
  - WP-T02
  - WP-P02
  - WP-P03
  - WP-P05
  - WP-P06
  - WP-H03
  - WP-H04
  - WP-H05
  - WP-H06
  - WP-H07
  - WP-H08
  - WP-H09
  - WP-H10
  - WP-S01
  - WP-S03
files_owned:
  - packages/server/src/convert/pipeline.ts
  - packages/server/src/convert/pipeline.test.ts
  - packages/server/src/convert/ports.ts
  - packages/server/src/tools/convert.ts
  - packages/server/src/tools/convert.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md#19-html-native-conversion-flagship
  - spec/contracts/13-tool-catalog.md#4-side-of-implementation-summary-locked
  - spec/contracts/10-rest-api.md#documents
  - spec/contracts/12-error-taxonomy.md
  - spec/contracts/schemas/diff.schema.json
estimate: L
---

## Summary

The flagship's top layer: the `convert.pipeline` orchestrator that chains every stage
(parse -> normalize -> classify -> map -> style-extract -> assemble -> hoist/variables -> coverage/a11y
-> dry_run -> (commit) save -> prime-css -> fidelity) and the three MCP tools that expose it —
`elementor.convert.html_to_tree` (★, TS-only, no persist), `elementor.convert.html_to_page` (★, BOTH,
commit-gated, NEVER auto-commits, elicitation confirm), and `elementor.convert.fidelity_check` (BOTH).
It defines the PORTS (REST adapters over `wp/routes.ts`) the pure stages consume, threads `op_id`
idempotency, enforces the dry-run + diff + coverage-report + explicit-commit flow (LOCKED), and resolves
class/variable placeholders against the diff-PUT/batch responses. This is the only HTML WP that touches
the WP client and registers tools.

## Interface / Contract

Exports from `packages/server/src/convert/pipeline.ts`:

- `htmlToTree(args: HtmlToTreeArgs, ports: ConvertPorts): Promise<HtmlToTreeResult>` — runs stages 1-9
  (no persist). Returns `{ elements: ElementNode[], proposed_classes: GlobalClassObject[],
  proposed_variables: ProposedVariable[], report: CoverageReport }` — exactly the
  `convert.html_to_tree.outputSchema` (13-tool-catalog §1.9).
- `htmlToPage(args: HtmlToPageArgs, ports: ConvertPorts, confirmer: Confirmer):
  Promise<HtmlToPageResult>` — runs `htmlToTree`, then sideload (in ASSEMBLE), then persists ONLY when
  `commit:true` AND the gate allows AND elicitation confirm returns true: `design.variables.batch` +
  `design.classes.upsert` (diff-PUT) -> resolve placeholders -> `documents/{id}/dry-run` (authoritative)
  -> `page.create`/`documents/{id}/replace-tree` save -> `documents/{id}/prime-css`. Returns
  `{ id?, diff: Diff, preview_url: string, report: CoverageReport, committed: boolean,
  css_primed: boolean }` (13-tool-catalog §1.9).
- `runFidelityCheck(args, ports): Promise<FidelityResult>` — wraps WP-H10 `fidelityCheck` against a
  saved page + source HTML.

Exports from `packages/server/src/convert/ports.ts`:

- `ConvertPorts` — the injected REST adapters: `MediaPort` (sideload/upload), `IdPort` (ids/validate-
  remap + mint), `DesignPort` (classes.list/upsert diff-PUT, variables.list/batch), `DocumentPort`
  (page.create, documents/{id}/dry-run, replace-tree/save, prime-css, get_structure for base_hash),
  `SchemaPort` (schema.styles, schema.widget, breakpoints.get, site.capabilities), `BrowserPort`
  (WP-H03 pool). Each is a thin typed wrapper over `wp/routes.ts` (WP-T02) — the orchestrator builds
  them once from the WP client and passes them to the pure stages so the stages never import the client.
- `buildPorts(client): ConvertPorts`.

Exports from `packages/server/src/tools/convert.ts`:

- `registerConvertTools(registry)` — registers the three tools with the WP-T01 tool registry using the
  EXACT names, input/output Zod shapes, and annotations from 13-tool-catalog §1.9. `html_to_tree` and
  `html_to_page` are ★ (lean profile); `fidelity_check` is non-star (enabled via tools.search).

## Dependencies & Inputs

- **WP-T01 (TS server core / tool registry)** — the data-driven registry + lean/full profiles +
  `sendToolListChanged` (01-architecture §spine). `tools/convert.ts` registers into it; it does NOT
  edit `server.ts` (the registry discovers tool files, 01-architecture §198-199).
- **WP-T02 (`wp/routes.ts` typed REST wrapper)** — the 1:1 typed wrappers over `elementor-ultra/v1/*`
  the ports wrap (10-rest-api). The orchestrator builds `ConvertPorts` from this.
- **WP-P02 (documents controller / writer / css-primer)** — `documents/{id}/dry-run`,
  `save`/`replace-tree`, `prime-css`, `page.create` (10-rest-api §Documents §2.x). REQUIRED (universal
  write rule: dry_run validator; universal atomic-CSS rule: prime-css + WP-S01).
- **WP-P03 (validator)** — the authoritative `dry_run` the orchestrator round-trips before commit
  (universal write rule).
- **WP-P05 (design controller)** — `design.classes.upsert` (diff-PUT) + `design.variables.batch`
  (watermark) for hoisted classes/variables (10-rest-api §Design).
- **WP-P06 (media controller)** — `media.sideload_url` for ASSEMBLE.
- **WP-H03..WP-H10** — the pure pipeline stages, composed here in order.
- **WP-F03/F04/F05** — types, MCP catalog (tool names/schemas), error taxonomy (map PHP `WP_Error`/
  dry_run errors to `isError` / `-32602` per error-taxonomy §1/§5).
- **WP-S01 (prime-css spike)** + **WP-S03 (coverage baseline spike)** — gate the persist+render path
  and the coverage thresholds (15-eng-standards §6).
- Contract sections: 13-tool-catalog §1.9 (the three tools' exact schemas/behavior + "never
  auto-commits"), §4 (side-of-implementation: html_to_tree TS-only; html_to_page/fidelity_check BOTH);
  10-rest-api §Documents (save/dry-run/prime-css flags `css_primed`/`prime_required`), §Design,
  §Media; 12-error-taxonomy (full mapping); diff.schema.json (`Diff`/`DryRunResult`/`CoverageReport`).
  RESEARCH.md §5.9, §6.8, §7.4, §7.5.

## Detailed Requirements

1. **Tool registration (13-tool-catalog §1.9, EXACT).** Register:
   - `elementor.convert.html_to_tree` (★): input `{html, css?, generation?='v4',
     options?:{hoist_classes=true, extract_variables=true, fidelity='balanced', sideload_media=true}}`;
     output `{elements, proposed_classes, proposed_variables, report}`; `readOnlyHint:true`; TS-only.
   - `elementor.convert.html_to_page` (★): input `{html, css?, post_id?, title?, generation?='v4',
     commit?=false, confirm?=false, coverage_gate?}`; output `{id?, diff, preview_url, report,
     committed, css_primed}`; `destructiveHint:true` when committing against an existing `post_id`;
     BOTH. Elicitation confirm REQUIRED when committing.
   - `elementor.convert.fidelity_check`: input `{post_id, source_html, breakpoints?}`; output
     `{score, deltas}`; `readOnlyHint:true`; BOTH.
   Names/shapes must match the catalog verbatim (WP-F04). inputSchema/outputSchema are ZodRawShape maps
   (SDK ^1.29, 13-tool-catalog).
2. **Pipeline composition (RESEARCH.md §6.1, §5.9).** `htmlToTree` runs, in order:
   parse (WP-H03, fetch breakpoints via `SchemaPort.breakpoints` first, fetch `schema.styles` +
   `site.capabilities`) -> normalize (WP-H04) -> classify (WP-H05) -> map (WP-H06, with capabilities)
   -> style-extract (WP-H07, with live `style_schema` + direction) -> assemble (WP-H08, with media/id
   ports) -> hoist+variables (WP-H09, with existing classes/vars from `DesignPort`) ->
   coverage+a11y (WP-H10). Returns the tree + proposals + report. NO persist.
3. **Persist orchestration (html_to_page, LOCKED never-auto-commit).** When `commit:false` (default):
   run `htmlToTree`, ALSO run `documents/{id}/dry-run` (authoritative) on the assembled tree to surface
   real validity, build the `Diff`, and return `{committed:false, css_primed:false}` + the report +
   preview (do NOT save). When `commit:true`: FIRST check `evaluateGate` (WP-H10) — if the gate denies
   (coverage < `coverage_gate` or a11y blocker), return the report and REFUSE (committed:false) with
   reasons (NOT an error — a gate decision). THEN require elicitation confirm via `confirmer` — if
   declined, return a clean non-error result (error-taxonomy §5.5). ONLY on allow+confirm:
   a. `design.variables.batch` (watermark) to create proposed variables; capture minted var ids.
   b. `design.classes.upsert` diff-PUT (build `changes/items/order` from WP-H09 proposals +
      `projectedOrder`); handle `DUPLICATED_LABEL` soft error by rebinding to the renamed id
      (error-taxonomy §3.3); capture minted class ids.
   c. Resolve the WP-H09 placeholders (`__var:...`/`__class:...`) in the tree to the real ids in one
      pass.
   d. `documents/{id}/dry-run` (AUTHORITATIVE) on the resolved tree; on `valid:false` map errors to an
      `isError` result with the structured `errors[]` (do NOT proceed to save).
   e. `page.create` (new) or `documents/{id}/replace-tree` (existing, with `base_hash` from
      `get_structure`) to persist; thread `op_id` (idempotency, RESEARCH.md §7).
   f. `documents/{id}/prime-css` (mandatory, WP-S01) — set `css_primed` from the response; on failure
      surface `CSS_PRIME_FAILED` (retryable) but report `committed:true, css_primed:false` honestly.
   g. Return `{id, diff, preview_url, report, committed:true, css_primed}`.
4. **fidelity_check (RESEARCH.md §6.8).** Render the SAVED+PRIMED page (`get_wp_preview_url`/public URL
   from `DocumentPort`) vs the source HTML at the requested breakpoints via WP-H10 `fidelityCheck`
   (reusing the WP-H03 browser pool). Return `{score, deltas}`.
5. **Ports (`ports.ts`).** Build `ConvertPorts` from the WP client / `wp/routes.ts` (WP-T02). The PURE
   stages (WP-H03..H10) receive ports/values, never the raw client — this keeps every stage unit-
   testable and the only client-coupled code in this WP. `BrowserPort` is the WP-H03 pool.
6. **Error mapping (error-taxonomy §1/§5).** Tool-arg Zod failures -> `-32602`
   (`SCHEMA_INVALID_PARAMS`). dry_run/business failures (`ATOMIC_SETTINGS_INVALID`,
   `ATOMIC_STYLES_INVALID`, `IMAGE_SRC_XOR_VIOLATION`, `LOCAL_STYLE_UNLINKED`, `BUDGET_EXCEEDED`,
   `WATERMARK_STALE`, `CONCURRENCY_STALE_HASH`, `CAPABILITY_MISSING`, `CSS_PRIME_FAILED`) ->
   `isError` results with actionable text + structured payload. Concurrency codes are NOT auto-retried.
   Soft codes (`DUPLICATED_LABEL`, `HTML_V3_STRIPPED`) ride in the diff/report.
7. **Capability awareness.** Before converting, probe `site.capabilities`; choose `generation` (v4 if
   atomic active, else v3 fallback — LOCKED decision); when global-class writes are needed but
   `can_update_class` is false, fail with `CAPABILITY_MISSING` (actionable: the plugin grants
   UPDATE_CLASS on activation; probe required) BEFORE attempting the diff-PUT.
8. **Idempotency.** Thread `op_id` (generate if absent) into the save call; on `IDEMPOTENT_REPLAY`
   surface it informationally (no error, stop retrying).
9. The pipeline orchestrator is the ONLY HTML WP that imports the WP client / registers tools. Keep
   stage composition declarative and the persist sequence in one place.

## Implementation Notes

- The LOCKED rule "convert.* NEVER auto-commits" is enforced HERE (RESEARCH.md §6.8, 13-tool-catalog
  §1.9, 15-eng-standards §4.6). Default `commit:false`; even `commit:true` requires gate-pass +
  elicitation. Declining is a clean non-error result.
- The placeholder-resolution handshake with WP-H09 is load-bearing: the diff-PUT/batch responses carry
  the real minted ids; resolve `__class:`/`__var:` tokens in one tree pass before the authoritative
  dry_run + save. Document the token format shared with WP-H09.
- `replace-tree` needs a fresh `base_hash` (optimistic lock) from `get_structure` right before save;
  on `CONCURRENCY_STALE_HASH` return an actionable isError (re-read), never auto-retry (error-taxonomy
  §5.3).
- Prime-css is mandatory and S1-gated; until S1 confirms an approach, the persist path may report
  `css_primed:false, prime_required:true` (10-rest-api §0.10) and the corpus render assertion runs as
  xfail (Contract 14 §3 step 3) — but the orchestrator must ALWAYS attempt prime after an atomic save.
- Build the `Diff` from the dry_run result (PHP authoritative diff) shaped to diff.schema.json; the TS
  side presents it (01-architecture: PHP produces the authoritative diff, TS shapes it).
- `html_to_tree` is TS-only EXCEPT it reads `schema.styles`/`breakpoints`/`site.capabilities`/existing
  classes+variables (read-only proxied) to drive style classification and hoisting — these reads are via
  `SchemaPort`/`DesignPort` and do not make it a write tool (still `readOnlyHint:true`).

## Acceptance Criteria

- [ ] The three tools register with the EXACT names, Zod input/output shapes, and annotations from
      13-tool-catalog §1.9; ★ flags correct; verified by the Inspector smoke suite (Contract 14 §8).
- [ ] `html_to_tree` returns `{elements, proposed_classes, proposed_variables, report}` and persists
      nothing; output validates against the catalog outputSchema + diff.schema.json `CoverageReport`.
- [ ] `html_to_page` with `commit:false` returns `committed:false, css_primed:false` + report + an
      authoritative dry_run-derived diff; nothing is saved.
- [ ] `html_to_page` with `commit:true` but gate-denied returns the report + `committed:false` + reasons
      (NOT an error).
- [ ] `html_to_page` with `commit:true` + gate-pass + confirm: creates variables (batch) + classes
      (diff-PUT), resolves placeholders, runs authoritative dry_run, saves, primes CSS, returns
      `committed:true` with honest `css_primed`.
- [ ] Declining the elicitation confirm yields a clean non-error result (no save).
- [ ] `DUPLICATED_LABEL` from the diff-PUT is reconciled (rebind to renamed id) and surfaced in the diff.
- [ ] dry_run `valid:false` maps to an `isError` result with structured `errors[]`; the save is NOT
      attempted.
- [ ] `fidelity_check` returns `{score, deltas}` against a primed saved page reusing the WP-H03 pool.
- [ ] Pure stages receive ports/values only; the WP client is imported ONLY in `ports.ts`/`pipeline.ts`.
- [ ] `op_id` threads to the save; `IDEMPOTENT_REPLAY` is surfaced informationally.

## Tests Required

- Unit (`pipeline.test.ts`, stubbed `ConvertPorts`): full `htmlToTree` composition order; `htmlToPage`
  commit:false no-persist; gate-deny path; confirm-decline path; commit happy-path sequence
  (variables -> classes diff-PUT -> placeholder resolve -> authoritative dry_run -> save -> prime);
  `DUPLICATED_LABEL` reconciliation; dry_run-invalid -> isError; `op_id` threading.
- Unit (`tools/convert.test.ts`): tool registration shape vs 13-tool-catalog §1.9 (names, ★, Zod
  shapes, annotations); arg-Zod failure -> `-32602`.
- Integration (`test:smoke`/`test:contract`, wp-env): smoke payloads `smoke.elementor.convert.html_to_tree.json`
  etc.; an end-to-end convert-commit against a disposable draft asserting saved tree + primed CSS +
  fidelity score (Contract 14 §6/§8). Reuse WP-F06 fixtures (read-only).

## Parallelization Notes

- Owns `convert/pipeline.ts`, `convert/ports.ts`, `tools/convert.ts`, and their tests — disjoint from
  every other WP. It is the INTEGRATION top of the HTML stack: it depends on every pure stage WP
  (WP-H03..H10) and the TS core (WP-T01/T02) and PHP foundation (WP-P02/P03/P05/P06). It is the LAST
  HTML WP to build (Wave 2+ after foundation services + the pure stages).
- It must NOT edit `server.ts` or `wp/routes.ts` (spine files owned by WP-T01/WP-T02) — it registers via
  the registry and wraps routes via ports, preserving the disjoint-files invariant.

## Spike-Verified Corrections (Wave 1)

- **[S01]** The convert persist path (headless save of the derived atomic tree) emits ZERO front-end atomic CSS on its own. The orchestrator MUST invoke the corrected CSS prime sequence (WP-P05) after the save, executed in-process as the authenticated web-server user: `wp_set_current_user` → `do_action('elementor/atomic-widgets/styles/clear', ['local'])`/`['global']`/`['base']` → `do_action('elementor/post/render', $post_id)` → `do_action('elementor/frontend/after_enqueue_post_styles')` → re-read `local-<id>-frontend-desktop.css`/`global-<id>-frontend-desktop.css`/`base-desktop.css` and assert non-empty + selector present, else `CSS_PRIME_FAILED`. The `styles/clear` invalidation BEFORE dispatch is mandatory or the prime is a silent no-op (valid-cache-but-missing-file trap).
- **[S01/R5]** Element ids and local-style ids are regenerated on save; the orchestrator MUST NOT cache or return ids captured before the save — re-read after persisting.
- **[S02]** If the orchestrator inserts derived blocks as TEMPLATES, it MUST replicate the two-step `get_data()` → `process_global_styles({content, global_classes, import_mode=match_site})` → `Document::save` (carrying the `global_classes` snapshot). `save_item` alone does NOT merge global classes into the target kit; failures surface as `IMPORT_REMAP_FAILED`.
