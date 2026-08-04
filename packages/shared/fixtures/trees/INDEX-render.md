# Render-assertion fixtures (WP-Q06 — the S01 / M1 regression)

The standing guard that a SAVED + PRIMED atomic V4 page renders **STYLED**
(`spec/contracts/14-fixtures-harness.md §3 step 3`, RESEARCH §9.3f). These
`kind:tree` fixtures back WP-Q06's dedicated render-assertion suite — the
PHPUnit `plugin/elementor-ultra-mcp/tests/test-render-assertion.php` (authoritative,
reads on-disk CSS bytes) and its TS mirror
`packages/server/src/test-harness/render-assertion.contract.ts` (the M1
end-to-end `page.build → prime-css → public-URL CSS` proof).

They reuse the **[S01] frozen atomic-hero shape**
(`spec/spikes/fixtures/s01-atomic-hero.json`) and the **frozen harness**
(`spec/spikes/scripts/s01-assert-css.mjs`, adapted — Q06 owns its OWN files, it
does NOT edit the spike scripts). They follow the LOCKED envelope (`§2`); the
expected selector rules are declared in each fixture's `_comment` and are
**derived structurally** by the CSS rule extractor from the saved tree, so the
assertion is robust to whitespace / minification / declaration order.

## Fixtures

| file (in `v4/valid/`)             | scenario                                                        | local style | global class | asserts                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------- | ----------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render-assert.hero.json`         | `e-div-block > (e-heading[1 local] + e-button[global s01hero])` | yes (1)     | `s01hero`    | `.elementor .<savedLocalId>` in `local-<id>-frontend-desktop.css` + `.elementor .s01hero` in `global-<id>-frontend-desktop.css` + non-empty `base-desktop.css` |
| `render-assert.global-class.json` | `e-div-block` referencing ONLY the kit global class `s01hero`   | no          | `s01hero`    | `.elementor .s01hero` in the per-doc `global-<id>-frontend-desktop.css` (kit-CSS regen via `Cache_Service::flush_design_system()` additionally exercised)      |

## The render-assertion flow (per fixture, `§3 step 3 a–d`)

1. **Register** the referenced global class (`s01hero`) into the active kit via
   `Global_Classes_Repository::apply_changes` — the EXACT [S01] path; props read
   from the frozen `s01-atomic-hero.json` definition (with an inline fallback).
2. **Create** a throwaway page + **save** the atomic tree via WP-P04
   `Document_Writer::save()` (mint/dedupe ids → AUTHORITATIVE validator → backup
   → single `Document::save`).
3. **Prime** via WP-P05 `Css_Primer::prime()` — the **S01-confirmed in-process
   `do_action` approach** (Q06 CALLS it; WP-P05 OWNS it). Runs as the web-server
   uid inside wp-env so the CSS files are actually written ([S01] C1.3 / R2).
4. **Assert** the per-breakpoint CSS off DISK (authoritative bytes, [S01]):
   `local-<postId>-frontend-desktop.css` contains `.elementor .<localId>{…}`,
   `global-<postId>-frontend-desktop.css` contains `.elementor .s01hero{…}`, and
   `base-desktop.css` is non-empty. Desktop coverage is mandatory; non-desktop
   breakpoints declared in a fixture/global-class variant are asserted too.
5. **Trash** the throwaway document in teardown (`§3 step 3d`).

## Key invariants honored

- **[R5] local-style ids are NOT stable across save.** The extractor re-reads the
  ACTUAL local-style ids out of the saved `_elementor_data` (the keys of each
  node's `styles` map) — it NEVER asserts the authored id (`e-rahead-local`). The
  GLOBAL class id (`s01hero`) IS stable (it lives in the kit), so it is asserted
  verbatim. This mirrors `Css_Primer::collect_expected_style_ids`.
- **[S01] on-disk bytes are authoritative.** HTTP-served `.css` can transiently
  304/empty; the PHP suite reads the filesystem (as `s01-assert-css.mjs` does).
  The TS mirror reads the HTTP path for the end-to-end proof and falls back to the
  prime response's `css_primed:true` when the HTTP body is transiently empty.
- **prime-css is LOAD-BEARING.** A deliberately UN-PRIMED page (save-only) MUST
  FAIL the selector assertion — its per-breakpoint CSS files are absent/empty
  ([S01]: a headless save emits ZERO atomic CSS). Both suites assert this.
- **`CSS_PRIME_FAILED` is surfaced cleanly** (12-error-taxonomy.md §3.5). Priming
  a missing document returns a clean `CSS_PRIME_FAILED` `WP_Error` (never a throw
  or silent pass); a non-atomic document is a 200-with-warning success (nothing to
  prime), not a false styled-render claim.
- **S01 gate** (`§3 step 3c`, AC #6). The suite RUNS only when S01 has PASSED —
  gated on the WP-P04 + WP-P05 services being present (they encode the S01-confirmed
  save + prime), unless `ELEMENTOR_ULTRA_S01_PASSED` is explicitly disabled. Until
  then every test is `markTestSkipped()` with a clear reason. Q06 flips it from
  WP-F06's `xfail`/skip to this standing suite once S01 passes.
- **[R8] strictly-typed envelopes.** Every atomic prop value is a `{$$type,value}`
  envelope verified against the live Elementor 4.1.1 validator; `classes` value is
  a bare string array.

## How the verdicts were established

`expect.valid:true` for both trees is the PHP `Validator::dry_run()` verdict
(`§3` — the single source of truth), the same gate WP-F06's round-trip suite
applies. The render assertion itself is the M1 regression: a primed page asserts
the present rules; an un-primed page fails — proving the prime step is the guard.
