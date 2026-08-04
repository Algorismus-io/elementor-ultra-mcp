---
id: WP-H03
title: PARSE stage - render-then-extract via headless Playwright getComputedStyle
layer: html
phase: v1
status: planned
depends_on:
  - WP-F03
  - WP-H01
  - WP-S03
files_owned:
  - packages/server/src/convert/parse.ts
  - packages/server/src/convert/parse.test.ts
  - packages/server/src/convert/browser-pool.ts
  - packages/server/src/convert/browser-pool.test.ts
contract_refs:
  - spec/contracts/13-tool-catalog.md#19-html-native-conversion-flagship
  - spec/contracts/15-engineering-standards.md#46-html-pipeline-layer-html-wp-h
  - spec/contracts/11-authoring-contract.md#52-style-schema-native-props--the-no-native-expression-list-supplement-b3
estimate: L
---

## Summary

The first and most important conversion stage: load HTML+CSS in a headless Chromium (Playwright),
walk the live DOM in `page.evaluate`, and per node capture the EFFECTIVE styling via
`getComputedStyle` (whitelisted to Style-Schema-reachable props), `getBoundingClientRect`, forced
`:hover`/`:focus` pseudo-states via the Chrome DevTools Protocol, and per-breakpoint captures —
diffing each node's computed values against its parent to drop inherited values. This is the CORRECTED
PARSE per RESEARCH.md §6.1 and SUPPLEMENT §C.3-C.4 (render-then-extract, NOT static
`parse5`/`postcss` cascade computation). It also owns the shared Playwright browser pool reused by the
visual-diff fidelity gate (WP-H10). Output is the pipeline IR tree (`IrNode[]` from WP-H01); this WP
performs NO classification, mapping, or Elementor I/O.

## Interface / Contract

Exports from `packages/server/src/convert/parse.ts`:

- `parseHtml(input: ParseInput): Promise<ParseResult>`. `ParseInput`, `BreakpointSpec`, `ParseWarning`,
  and `ParseResult` are FROZEN and OWNED by WP-H01 (`convert/types.ts`, Contract 15 §4.6.1); this WP
  IMPLEMENTS the function against them and `import type`s them — it does NOT declare them locally. For
  reference (the frozen shapes, verbatim in WP-H01):
  - `ParseInput = { html: string; css?: string; breakpoints: BreakpointSpec[]; base_url?: string;
    fidelity: 'high'|'balanced'|'fast'; capture_states?: boolean; }`.
  - `BreakpointSpec = { key: BreakpointKey; width: number; direction: 'min'|'max' }` (resolved by the
    orchestrator from `breakpoints.get`; this WP does NOT hardcode 768/1024 — RESEARCH.md §6.7).
  - `ParseResult = { ir: IrNode[]; doc_direction: 'ltr'|'rtl'; viewport_used: number;
    warnings: ParseWarning[]; raw_inner_markup: Record<string,string> }` where `ir` is the captured
    tree of `IrNode` (WP-H01 `types.ts`), `raw_inner_markup` maps `source_path` -> the verbatim inner
    HTML of text-bearing nodes (consumed by NORMALIZE/STYLE-EXTRACT to compute the stripped-text
    diff). `IrNode.computed` is filled with the whitelisted `getComputedStyle`; `hoverComputed`/
    `focusComputed` filled when `capture_states:true`; `responsive[bp]` holds the per-breakpoint delta.
- `IrNode`, `STYLE_WHITELIST`, and all of `ParseInput`/`BreakpointSpec`/`ParseWarning`/`ParseResult` are
  imported from WP-H01 (`mapping-table.ts`/`types.ts`); this WP MUST capture exactly `STYLE_WHITELIST`
  props (no more, no less) so the contract surface is stable.

Exports from `packages/server/src/convert/browser-pool.ts`:

- `getBrowser(): Promise<Browser>` — lazily launch + reuse one Chromium instance across PARSE and the
  fidelity gate; `closeBrowser(): Promise<void>` for teardown; `withPage<T>(fn): Promise<T>` — acquire
  a page, run `fn`, always close the page. Concurrency-bounded (default 1 browser, N pages).

## Dependencies & Inputs

- **WP-S03 (HTML->native coverage baseline)** — the spike that validates render-then-extract on real
  marketing sections (RESEARCH.md §0 S3, §6.1). This WP is the production realization of the S3
  technique; it must not lock coverage numbers (that is WP-H10/WP-S03), but it inherits S3's confirmed
  capture approach (which props, forced-state mechanism, per-breakpoint widths).
- **WP-F03** — `BreakpointKey`, `Generation` shared types.
- **WP-H01** — `IrNode`, `BoxRect`, `ComputedStyleSet`, `TextRun`, `MediaRef`, `STYLE_WHITELIST`.
- Contract sections: 13-tool-catalog §1.9 (`convert.html_to_tree` is TS-only, Playwright render);
  15-engineering-standards §4.6 ("Render-then-extract via headless Playwright (not static parse);
  reuses the Playwright instance for the visual-diff gate"); 11-authoring-contract §5.2 (the props
  that can hit Style-Schema, i.e. what to whitelist); RESEARCH.md §6.1, §6.7; SUPPLEMENT §C.3
  (Playwright `getComputedStyle`, forced `:hover` via CDP `forcePseudoState`, parent-diff to drop
  inherited), §C.4 (external `<link>`/`@import` inlining, `animations:'disabled'`,
  `waitForLoadState`).
- No Elementor PHP APIs (TS-only stage).

## Detailed Requirements

1. **Render-then-extract (NOT static parse).** Use Playwright Chromium. Load the document via
   `page.setContent(html, {waitUntil:'networkidle'})` (or `goto(base_url)` when a URL is given).
   Inject `css` (if provided) as a `<style>` before capture. **Resolve external stylesheets**: when
   the HTML references `<link rel=stylesheet>` / `@import`, allow the browser to fetch them
   (network-enabled) so the cascade is complete — this is the documented fix for the "dead `<link>` ->
   bulk of layout missing" failure (SUPPLEMENT §C.1/§C.4). When `base_url` is absent and the HTML has
   external refs, surface a `ParseWarning` that linked CSS may be unresolved.
2. **Whitelisted getComputedStyle.** In `page.evaluate`, walk the DOM (depth-first), and for each
   ELEMENT node read `getComputedStyle(el)` and pick exactly the `STYLE_WHITELIST` props (WP-H01).
   Capturing the full computed style is forbidden (context blowup + non-Style-Schema noise). Capture
   `getBoundingClientRect()` into `box` (used by Locofy-style flex inference downstream).
3. **Parent-diff to drop inherited values.** For inheritable props (color, font-*, line-height,
   letter-spacing, text-align, direction, etc.), compare each node's computed value to its parent's
   captured computed value; OMIT the prop from `IrNode.computed` when equal (it is inherited). Keep
   non-inheritable props always. Maintain an explicit `INHERITED_PROPS` set (CSS inheritance rules).
   This yields small clean style sets instead of a per-node explosion (SUPPLEMENT §C.2/§C.3).
4. **Forced pseudo-states via CDP.** When `capture_states:true` (driven by `fidelity` and the presence
   of `:hover`/`:focus` rules detected via `css-tree` selector scan), use the CDP session
   (`page.context().newCDPSession`) `CSS.forcePseudoState` (or `DOM`/`CSS` `forcePseudoStates`) to
   force `:hover` then re-read `getComputedStyle` -> `hoverComputed` (only props that CHANGED vs the
   base); repeat for `:focus`/`:focus-visible` -> `focusComputed`. Plain `getComputedStyle` does NOT
   return hover styles (SUPPLEMENT §C.3) — the CDP force is mandatory. Map these to the atomic style
   `state` values later (WP-H07): `hover`, `active`, `focus`, `focus-visible` (authoring-contract §5.2
   states; `styles/style-states.php:6-12`).
5. **Per-breakpoint capture.** For each `BreakpointSpec`, set the viewport width
   (`page.setViewportSize`), re-capture computed styles, and store ONLY the per-breakpoint DELTA vs the
   widest (or `desktop`) capture into `IrNode.responsive[bp]`. Resolve breakpoint widths from the
   passed-in `BreakpointSpec[]` (orchestrator reads `breakpoints.get`); NEVER hardcode widths
   (RESEARCH.md §6.7). The `direction` (min/max) on each spec mirrors the site's active
   mobile-first/desktop-first ordering.
6. **Text runs + raw markup.** For text-bearing nodes, capture `textRuns` (segment text by inline
   markup spans, recording which inline tags wrap each run) AND store the verbatim inner HTML into
   `raw_inner_markup[source_path]` so NORMALIZE/STYLE-EXTRACT can diff pre/post for the stripped-text
   report (`html-v3` inline-only allowlist, authoring-contract §3.3).
7. **Media refs.** For `<img>` capture `src`/`srcset`/`alt`; for elements with a non-`none`
   `background-image` capture the url; for `<iframe>` YouTube detect the embed id; for `<video>`
   capture source; for `<svg>` capture serialized markup. Emit `IrNode.media` accordingly (so
   ASSEMBLE/WP-H08 can sideload). This WP does NOT sideload — it only records refs.
8. **`doc_direction`.** Read the computed `direction` of the root/body to set `ParseResult.doc_direction`
   (consumed by WP-H02 logical mapping via the orchestrator).
9. **fidelity tiers.** `fast` = single desktop capture, no states; `balanced` = desktop + named
   breakpoints, states only when `:hover`/`:focus` rules exist; `high` = all breakpoints + all states +
   tighter wait (`waitForLoadState('networkidle')` + fonts ready). Set `animations:'disabled'` /
   `reducedMotion:'reduce'` so captures and the later screenshot are stable (SUPPLEMENT §C.4).
10. **Browser pool.** `browser-pool.ts` owns one shared Chromium launch reused by PARSE and the
    fidelity gate (WP-H10) — ONE Playwright dependency serving both stages (SUPPLEMENT §C.3,
    15-eng-standards §4.6). Bound page concurrency; ensure pages are always closed (try/finally);
    expose `closeBrowser()` for process shutdown so the MCP server exits cleanly.

## Implementation Notes

- Use `css-tree` ONLY for a cheap selector/`@media` pre-scan to decide whether to capture states /
  which breakpoints have overrides — NOT for cascade computation (no Node lib computes the cascade;
  SUPPLEMENT §C.3). `parse5`/`linkedom` may be used for a structural pre-pass but the AUTHORITATIVE
  style source is the browser.
- `source_path` is a stable structural path (e.g. `body>div:nth-child(2)>h1`) so downstream stages and
  the corpus tests can refer to a node deterministically without minting Elementor ids (ids are minted
  in ASSEMBLE/WP-F03 `ids.ts`).
- Keep `page.evaluate` payload small: serialize only the whitelisted props as a flat object per node;
  do the parent-diff inside the page context where parent computed values are cheap, OR carry parent
  values out and diff in Node — pick one and document; prefer in-page diff to shrink transfer.
- Chromium must be installed in CI (Playwright `install chromium`); document this in the package's
  postinstall/test setup note so WP-Q/WP-F07 wire it. The browser pool must NOT auto-download at
  import time.
- Do not throw on malformed HTML — Chromium is lenient; surface parse anomalies as `ParseWarning`s.
- This stage NEVER touches the WP client, never persists, never calls dry_run. It is read-only/TS-only
  (13-tool-catalog §4: `convert.html_to_tree` is TS-only).

## Acceptance Criteria

- [ ] `parseHtml` returns an `IrNode[]` whose `computed` maps contain ONLY `STYLE_WHITELIST` keys.
- [ ] Inherited props (e.g. a child `<span>` with no own color rule under a colored parent) are OMITTED
      from the child's `computed` (parent-diff works).
- [ ] When a `:hover` rule changes `background-color`, `hoverComputed` for that node contains the
      changed prop and only the changed prop (forced via CDP).
- [ ] Per-breakpoint capture at the passed widths records deltas in `responsive[bp]`; no width is
      hardcoded (test passes custom widths and asserts they are used).
- [ ] External `<link rel=stylesheet>` referenced styles are reflected in `computed` when reachable;
      an unreachable link yields a `ParseWarning`, not a crash.
- [ ] `<img>`/background-image/youtube-iframe/`<video>`/`<svg>` produce correct `IrNode.media` refs.
- [ ] `raw_inner_markup` captures verbatim inner HTML for text nodes (for the later stripped-text diff).
- [ ] `doc_direction` reflects the computed root direction (rtl test fixture -> `'rtl'`).
- [ ] The browser pool launches at most one Chromium and always closes pages; `closeBrowser()` makes
      the process exit cleanly (no hanging handles in the test).
- [ ] `fidelity:'fast'` does a single capture with no state forcing; `'high'` captures all breakpoints
      + states.

## Tests Required

- Unit/integration (`parse.test.ts`, run under vitest with a real Chromium): small fixture HTML with
  (a) inherited color on a child, (b) a `:hover` rule, (c) a `@media` override, (d) an `<img>` + a
  background-image, (e) an RTL `dir=rtl` block. Assert the IR shape per the acceptance criteria. Mark
  the suite as requiring Chromium (skip with a clear message if unavailable, mirroring fixtures-harness
  capability skips).
- Unit (`browser-pool.test.ts`): single-instance reuse, page always-closed (finally), clean shutdown.
- Corpus tie-in: PARSE is exercised end-to-end by WP-H10's corpus regression (Contract 14 §6); no
  duplicate corpus fixtures owned here.

## Parallelization Notes

- Parallel-safe with all sibling HTML WPs: owns only `parse.ts`, `browser-pool.ts`, and their tests.
- Code dependency on WP-H01 (IR types + `STYLE_WHITELIST`). Spike dependency on WP-S03 (confirms the
  technique). The browser pool it exports is consumed by WP-H10 (fidelity gate) — that is a one-way
  code dependency, not a file overlap.
- Build after WP-H01; can proceed concurrently with WP-H02/H04/H05/H06/H07 since they only consume the
  IR type, not PARSE's runtime.
