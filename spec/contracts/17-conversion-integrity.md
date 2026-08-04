# Contract 17 — Conversion integrity (the closed-loop converter)

**Status:** v1 spec 2026-06-11 · **Depends on:** contract 16 (behavior tiers), 11 (authoring), 14 (fixtures).
**Problem this kills:** every conversion defect to date (orphaned/dangling styles, widget
base-defaults painting through, broken mobile widths, silent inline-color drops) was found by a
HUMAN or agent eyeballing screenshots after commit. The converter must verify its own output and
either repair it or report it precisely — field debugging becomes the exception, not the QA path.

## 0. Principle

The converter is not done when it saves — it is done when it has **looked at what it saved**,
compared it to the source, and accounted for every divergence. Same honesty rules as 16:
no silent anything.

## 1. Integrity invariants (pure checks, enforced PRE-save — violations are converter bugs, hard-fail)

- **I1 — Reference closure (both directions).** Every id in any node's `settings.classes`
  resolves to a style definition (node-local or global), AND every minted local style is
  referenced by its node. (Page 1704 broke direction one: 12 dangling refs → zero-size icons +
  deterministic CSS_PRIME_FAILED. The fleet audit found direction two: orphaned styles.)
- **I2 — Base-default safety.** For every mapped widget whose base styles paint
  (e-button: blue fill / padding / radius; e-flexbox: 10px padding, column direction; e-svg:
  50x50), any prop where the source's computed value differs from the widget's base default
  MUST be explicitly emitted. "Skip as no-op" is legal ONLY against a transparent/neutral base.
  (Kills the ghost-buttons-turn-blue class.)
- **I3 — Total accounting.** Every source declaration AND every inline-fold side effect lands
  in exactly one tier including `dropped` — extends 16's rule to losses like accent colors on
  `<em>`/`<span>` folded into html-v3 (currently dropped with no tier entry).
- **I4 — Computed-default noise excluded.** Browser-default computed values (`normal`, `auto`,
  `none`, zero-effect values) are filtered BEFORE tier accounting — coverage numbers must
  reflect real loss only.

## 2. Verification loop (post-save, IN the pipeline — reuses the existing Playwright + pixelmatch infra)

Runs on `html_to_page` commit (and on demand via `convert.fidelity_check` for any page):

- **V1 — Element-matched render diff.** Render source and converted page at EVERY active
  breakpoint. Match elements via the assembler's source-correspondence (nodes already carry
  `source_path`). Diff a fixed prop set (background, color, font-*, padding, border-*, width,
  height, display) per matched element. Output: divergence list
  `{element, source_path, prop, source_value, converted_value, cause}` where `cause ∈
  {dangling_ref, base_default, dropped_declaration, custom_css_unrendered, unknown}` —
  attribution uses the same logic as I1/I2 plus the tier ledger from I3.
- **V2 — Layout audits per breakpoint.** `document.scrollWidth == viewport` (no horizontal
  overflow); no visible element with zero rendered area that had area in the source; page
  height within tolerance of source.
- **V3 — Visual score.** Pixelmatch per breakpoint (exists today; becomes a standard loop
  output, not an optional tool).

## 3. Repair policy (bounded, mechanical-only)

- **R1 — Auto-repairable causes:** `dangling_ref` (re-attach/re-emit the style),
  `base_default` (emit the explicit prop), missing `overflow-x` carry, missing breakpoint
  width reset when the source's own media query defines one. ONE repair round, then re-verify.
  Never more than 2 rounds; repairs go through the normal save path (backup + base_hash).
- **R2 — Everything else** stays in the report as a precise machine-generated divergence list —
  the artifact a fixing agent (or human) starts from. No guessing, no screenshots-first.
- **R3 — Commit gate.** If after repair V2 still fails (overflow/zero-size) or the divergence
  count exceeds threshold, the page is left in `draft` with the report — a bad conversion never
  silently publishes. `commit:true` + passing loop = publish.

## 4. Regression corpus (CI — bugs stay dead)

- Corpus: `test-landing.html` (CloudFlow), `test.html` (wpos.ai), + the fixtures harness pages.
  Converted in the wp-env CI leg; assertions: I1–I4 hold, V2 passes at 1440/390, plus named
  checks pinned to past bugs (ghost buttons stay transparent, SVG wrappers have size, accent
  `<em>` keeps color, scrollWidth at 390).
- **Process rule:** every field-found conversion bug gets a corpus assertion IN THE SAME FIX —
  a bug without a regression check is not fixed.

## 5. Root fixes subsumed (tasks #6–#10 — fixed at root in the same wave, then guarded by the loop)

| Task | Root fix | Loop guard |
|---|---|---|
| #6 dangling SVG wrapper styles | assemble/resolveSvgSrc attaches defs it references | I1 |
| #7 desktop widths baked in | style-extract emits per-breakpoint width/layout overrides (parse already captures the deltas); prefer max-width:100% on content boxes | V2 |
| #8 transparent-skip vs painted bases (+ inline accent color drop) | base-default table per widget; html-v3 fold emits inline `style` color (wp_kses_post allows it) or records the drop | I2, I3 |
| #9 webfont carry-over (2026-06-11 odiff: largest static-pixel loss — ghost-text in every band) | parse captures font stylesheet links/@font-face; commit appends ONE font-enqueue html widget (default on, option-gated `carry_fonts`, reported in coverage) | V1 (font-family diffs attributed `font_not_carried`) |
| #10 pseudo-element synthesis | parse extracts ::before/::after computed (content/size/background/position); normalize synthesizes real IR child nodes for representable ones (sized boxes, dots, dashes); masks/text-content stay custom_css or honest-drop with reason `pseudo_unrepresentable` | I3, V1 |

Plus the fix-wave residual: inline `<a href>` inside text widgets (map.ts `nodeInlineHtml` must serialize run.linkHref/linkTarget; declare both on TextRun) — guarded by a corpus assertion (in-text links carry href).

## 6. Build plan (wave runs AFTER the contract-16 behavior workflow lands — same files)

- **W1 (pure + root fixes):** `convert/integrity.ts` (I1–I4) wired pre-save; fixes #6, #8,
  inline-href residual, overflow-x carry, coverage-noise filter (I4); #9 font capture +
  enqueue stage; #10 pseudo-element synthesis. All unit-testable without a browser except
  the parse-side captures (Chromium-gated like existing parse tests).
- **W2 (the loop):** `convert/verify-loop.ts` — V1 matcher + differ + cause attribution, V2
  audits, R1 repairs; pipeline wiring with the R3 gate. Browser tests Chromium-gated like
  parse/fidelity tests. The standalone odiff harness (`packages/server/_odiff.mjs`) is the
  reference implementation of V1's render-diff (baseline measured 2026-06-11: 9.49% mismatch
  on test.html at 1440 — fonts dominant).
- **W3 (responsive + CI):** #7 width emission; corpus runner + CI job (`test:convert-corpus`);
  acceptance = re-convert `test.html`: ghost buttons transparent, all 17 SVGs visible, em
  emerald, Bricolage/JetBrains Mono actually loaded, 390 scrollWidth = 390, CSS prime green,
  odiff mismatch ≤4% at 1440 (from 9.49% baseline), divergence list empty-or-explained,
  CloudFlow regression unchanged (~63% coverage, styled render).
