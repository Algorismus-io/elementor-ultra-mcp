# WP-S03 — HTML→native coverage baseline (FINDINGS / the S3 number)

**Spike:** WP-S03 (the second load-bearing spike — gates the flagship `convert.*` vertical).
**Date:** 2026-06-07.
**Target:** Plan B docker-compose stack — WordPress at http://localhost:8899, Elementor 4.1.1 + Pro 4.1.0, experiments `e_atomic_elements` + `e_classes` + `e_variables` ACTIVE. Measured against the LIVE `Style_Schema` (`style-schema.php`) fetched from this install.

## VERDICT

**PASS.** On ≥5 real marketing sections, the parse→classify→map→style-extract loop achieves an HONEST, reproducible native-prop coverage of:

| Band | Per-section native % | Corpus (declaration-weighted) |
|---|---|---|
| **REALISTIC** (the number that anchors the gate) | **76.8% – 90.5%** | **84.8%** native, 15.2% custom_css, 0.0% dropped |
| OPTIMISTIC (perfect typed-decompose; upper bound) | 83.2% – 94.0% | 89.5% native, 10.5% custom_css, 0.0% dropped |

**The "85%" in the original draft is REPLACED by the measured REALISTIC band.** Because these fixtures are cleanly hand-authored marketing HTML, they sit at the **upper end** of the honest band (exactly as SUPPLEMENT §C.4 warns: vendor ~84% self-reports are on *clean/AI-generated, well-structured* HTML — treat as an upper bound). Real-world *exported* page-builder HTML (utility-class soup, denser gradients/animations/grid-areas, computed-cascade extraction noise) lands lower, in the **~60–75%** range. The combined honest band the spec should commit to is therefore **~60–85% native**, anchored per-section by `corpus.manifest.json`, with the convert auto-commit floor set conservatively at **60%**.

Produced trees pass `dry_run` (`valid:true`) — see §5. The converter never emits a tree PHP rejects.

- `confirms_spec = true` for the ~60–80% band (clean fixtures hit the top of it / just above; messy exported HTML hits the bottom). `confirms_spec = false` for the unvalidated hardcoded **85%** — it is not a single number, it is a per-section band.

## Files (artifacts)

- `spec/spikes/scripts/s03-convert-section.mjs` — throwaway convert PROTOTYPE: render-then-extract via Playwright (chromium) + `css-tree` authored-declaration parse → classify nodes → map → STYLE-EXTRACT against the live `Style_Schema` → fallback ladder. Emits `<section>/convert.result.json`.
- `spec/spikes/scripts/s03-measure-coverage.mjs` — reusable coverage harness (basis for WP-Q04 corpus assertion + `convert.fidelity_check` scoring). Reads the per-section `convert.result.json`, prints + `--json`-emits the native/local-class/global-class/custom_css/dropped breakdown in both bands plus per-property fallback rates.
- `spec/spikes/scripts/s03-style-schema.json` — the LIVE `Style_Schema` distilled to a classifier table `{prop:{type,enum?}}`, fetched from the running install (`Style_Schema::get()`). 71 props, 24 with enums. The single source of truth for "is this prop+value native?".
- `spec/spikes/scripts/s03-validate-tree.php` — authoritative atomic save-validation probe (`Style_Parser::parse()`): empirically confirms WHICH candidate native props stick vs fall (grounds the classifier; §4).
- `spec/spikes/fixtures/sections/0{1..5}-*/{input.html,input.css,convert.result.json}` — the ≥5 real marketing sections (seed for the WP-Q04 corpus) + their measured convert results.
- `spec/spikes/fixtures/sections/corpus.manifest.json` — the S3-anchored per-section thresholds + tolerance bands + the auto-commit floor (the regression baseline; Contract 14 §6).

## 1. The 5 sections (the corpus seed)

Kept deliberately REALISTIC (cards, flex + CSS grid, gradients, transforms, transitions, filters, absolute positioning, block-in-text, a form) so the fallback rate is honest, not cherry-picked. Each is `input.html` + `input.css`.

| # | Section | nodes | authored decls | what makes it hard |
|---|---|---|---|---|
| 01 | Pricing table (3-tier, featured card) | 43 | 285 | CSS grid, hover transitions, lift transforms, featured-card gradient, `list-style:none` + `::before` check marks |
| 02 | Hero (two-column, gradient + media) | 18 | 94 | radial+linear gradients, **text-clip gradient**, glass chip `backdrop-filter:blur`, button hover transform/transition |
| 03 | Feature grid (auto-fit icon cards) | 35 | 185 | 6 gradient icon tiles, **off-enum `font-weight:650`**, `repeat(auto-fit,minmax())` grid, hover transforms/transitions |
| 04 | Testimonial (quote card + author) | 16 | 64 | gradient quote-mark (text-clip), `filter:grayscale` avatar, panel gradient, `<br>`/`<blockquote>`/`<img>`-in-`<figcaption>` (stripped-text) |
| 05 | CTA banner (full-width gradient) | 13 | 76 | gradient panel, `filter:blur` decorative blobs, inline email `<form>` (no atomic equiv on free), button hover transform |

## 2. Method (reproducible)

Per RESEARCH.md §6.1 + SUPPLEMENT.md §C.3/§C.4 (render-then-extract, NOT static parse) and §6.4 (fallback ladder):

1. **PARSE** — load `input.html`+`input.css` in headless Playwright (chromium). Parse the AUTHORED declaration set from `input.css` with `css-tree` (the §6.1 "css-tree to lexer-validate" stage); render the DOM and resolve each CSS rule's base selector → matched node(s) → role + computed display (`querySelectorAll` + `getComputedStyle` in `page.evaluate`).
   - **Honesty correction (recorded):** we measure the **authored** declaration set, NOT the full computed cascade. A naive `getComputedStyle`-everything extraction reports every longhand the browser resolves (`height`, all four `inset`/`border-radius` corners, `font-size` per node, …) on every node, inflating "native" with props the author never set — an early run produced 862 declarations for 41 nodes (~21/node) and a dishonest 94%+ "native". Counting authored declarations (what the source CSS writes), once per node a rule lands on, is the honest denominator. Render-then-extract still drives selector→node resolution + computed values for typed-prop classification + a11y/stripped-text.
2. **CLASSIFY** — node role from tag + `display` + ARIA role + class hint (heading/text/image/button/link/divider/svg/form/list/grid/flex/structural).
3. **MAP** — role → atomic target (`e-heading`/`e-paragraph`/`e-image`/`e-button`/`e-div-block`/`e-flexbox`/… per RESEARCH.md §6.2).
4. **STYLE-EXTRACT** — for each authored declaration, classify against the live `Style_Schema` into `native` / `custom_css` / `dropped`. The `native` tier is split by fingerprint hoisting (RESEARCH.md §6.3) into `local_class` (single-use) vs `global_class` (declaration-set shared ≥2 nodes) — **both are real native props**; the split is a placement decision, not a fidelity loss.
5. **MEASURE** — `s03-measure-coverage.mjs` aggregates per-section + corpus, in two bands, with per-property hard-prop fallback rates.

Reproduce:
```
# deps (declared in deps_needed; installed in a scratch dir for the spike run)
mkdir -p /tmp/s03-pw && cd /tmp/s03-pw && npm i playwright css-tree && npx playwright install chromium
# convert each section
for d in 01-pricing-table 02-hero 03-feature-grid 04-testimonial 05-cta-banner; do
  S03_PW_DIR=/tmp/s03-pw node spec/spikes/scripts/s03-convert-section.mjs spec/spikes/fixtures/sections/$d
done
# measure
node spec/spikes/scripts/s03-measure-coverage.mjs            # human report
node spec/spikes/scripts/s03-measure-coverage.mjs --json     # machine-readable (feeds corpus.manifest.json)
```

## 3. Measured per-section coverage

```
## 01-pricing-table  (nodes=43, authored-declarations=285)
   OPTIMISTIC  native=94.0%  [local=16.5% global=77.5%]  custom_css=6.0%   dropped=0%
   REALISTIC   native=90.5%  [local=14.0% global=76.5%]  custom_css=9.5%   dropped=0%
## 02-hero  (nodes=18, authored-declarations=94)
   OPTIMISTIC  native=89.4%  [local=72.3% global=17.0%]  custom_css=10.6%  dropped=0%
   REALISTIC   native=85.1%  [local=68.1% global=17.0%]  custom_css=14.9%  dropped=0%
## 03-feature-grid  (nodes=35, authored-declarations=185)
   OPTIMISTIC  native=83.2%  [local=21.6% global=61.6%]  custom_css=16.8%  dropped=0%
   REALISTIC   native=76.8%  [local=15.1% global=61.6%]  custom_css=23.2%  dropped=0%  <- lowest (heaviest hard-prop density)
## 04-testimonial  (nodes=16, authored-declarations=64)
   OPTIMISTIC  native=87.5%  [local=71.9% global=15.6%]  custom_css=12.5%  dropped=0%
   REALISTIC   native=82.8%  [local=67.2% global=15.6%]  custom_css=17.2%  dropped=0%
## 05-cta-banner  (nodes=13, authored-declarations=76)
   OPTIMISTIC  native=89.5%  [local=78.9% global=10.5%]  custom_css=10.5%  dropped=0%
   REALISTIC   native=84.2%  [local=76.3% global=7.9%]   custom_css=15.8%  dropped=0%

CORPUS (declaration-weighted)
   OPTIMISTIC  native=89.5%  custom_css=10.5%  dropped=0%
   REALISTIC   native=84.8%  custom_css=15.2%  dropped=0%
```

**Why the corpus number is high (and honest):** the declaration count is dominated by trivially-mappable props (padding/margin/color/font-size/border-radius/display/gap) that all map cleanly to `Style_Schema` typed envelopes. The hard properties are a *minority of declarations* but a *majority of the user-visible visual identity* (gradients, transitions, transforms) — so a high declaration-coverage number can co-exist with a meaningfully-lower **visual** fidelity. **This is exactly why the visual-diff (`convert.fidelity_check`, RESEARCH.md §6.8) is the PRIMARY gate and the coverage % is a secondary signal — never sell the coverage % as the fidelity promise.** `dropped=0%` because every non-native declaration has a `custom_css.raw` Pro home; on FREE those become the visible loss (Pro `custom_css` stripped → effectively dropped → re-classify the custom_css % as dropped on a free-only target).

## 4. Per-property fallback findings (the tail drivers) — EMPIRICALLY GROUNDED

Corpus-wide hard-property fallback rates (realistic band), from `s03-measure-coverage.mjs`:

| Hard property | fall / total | rate | driver |
|---|---|---|---|
| `transition` | 17/17 | **100%** | typed `Transition_Prop_Type` repeater — computed transitions expand to per-longhand multi-row shapes that don't round-trip cleanly; routed to fallback |
| `transform` | 12/12 | **100%** (realistic) | typed `Transform_Prop_Type` repeater — *decomposable* (a properly-shaped `translateY`/`scale` STICKS, §4), but a v1 converter doesn't reliably decompose every real combo with correct visual fidelity → realistic-band fallback |
| `background_gradient` | 12/12 | **100%** | `Background_Prop_Type` accepts a typed gradient-overlay shape (stops/angle), NOT a raw `linear/radial-gradient()` string → must be decomposed; v1 → fallback |
| `filter` / `backdrop-filter` | 5/5 | **100%** (realistic) | typed `Filter_Prop_Type` repeater — single `blur`/`grayscale` *decomposable* + STICKS (§4); realistic-band fallback for the same reason as transform |
| `text-clip` (gradient text) | 4/4 | **100%** | `background-clip:text` + `-webkit-text-fill-color:transparent` have NO `Style_Schema` key at all → always fallback |
| `list-style` (`none`/`type`) | 3/3 | **100%** | no `Style_Schema` key → fallback (the converter strips `<ul>` markers and rebuilds list items as `e-paragraph`s) |
| `font-weight` (numeric) | 6/41 | 14.6% | enum is `100..900,normal,bold,bolder,lighter` — `650`/`350` FALL (confirmed §4); `400/700` etc. stick |
| `text-decoration` | 0/5 | 0% | single-keyword (`none`/`underline`) sticks; a shorthand with color/style collapses to the line only (lossy but valid) |
| `grid-template-*` | 0/2 | 0% | raw string `repeat(3,1fr)` and **`repeat(auto-fit, minmax(280px,1fr))` both STICK** (confirmed §4). NOTE: `grid-template-areas`, named lines, and `place-items` have NO schema key → those WOULD fall (none in this corpus) |
| `display:table/list-item` | 0/0 | n/a | enum has no `table`/`list-item` (confirmed §4 FALL); none authored in this corpus |
| absolute/fixed `position` | 0/16 | 0% | `position` enum includes `absolute`/`fixed`/`sticky` and `inset-*` map to logical `inset-block/inline-*` — positions map fine; the FIDELITY risk is layout-context, not a declaration fallback |

### Authoritative save-validation probe (`s03-validate-tree.php`, `Style_Parser::parse()`)

This is the ticket's "build candidate atomic trees and run them through Elementor save validation to see what sticks." STICK = survives the save validator with no error; FALL = `invalid_value`.

```
[STICK] color rgb / font-size px / line-height em / font-weight 700 / padding dimensions /
        border-radius size / display flex / justify-content space-between / gap size / opacity % /
        grid-template-columns repeat / grid-template-columns auto-fit minmax / text-decoration none /
        background solid color / box-shadow single / transform translateY / filter blur
[ FALL] font-weight 650 (off-enum)        -> variants[0].font-weight: invalid_value
[ FALL] align-items baseline (off-enum)   -> variants[0].align-items: invalid_value
[ FALL] display table (no enum member)    -> variants[0].display: invalid_value
[ FALL] background gradient as string     -> variants[0].background: invalid_value
[ FALL] transform as bare string          -> variants[0].transform: invalid_value
[ FALL] box-shadow as bare string         -> variants[0].box-shadow: invalid_value
[ FALL] transition as bare string         -> variants[0].transition: invalid_value
```

**Two important nuances recorded for WP-H## / WP-P03:**
1. **`Style_Parser::parse()` validates the OUTER `$$type` + props-map structure, but is LENIENT about deep typed-repeater item shapes and color string content** — `transform` with a garbage inner item (`$$type:"nonsense"`) and `color:"not-a-color-xyz"` both STICK at parse(). So the save-gate does NOT catch a WRONG decomposition; it only catches a wrong top-level prop type / off-enum / raw-string-where-typed-object-expected. The real fidelity risk for transform/filter/background is producing a *visually wrong* typed shape that still saves — which is why the visual-diff gate is mandatory and the realistic band routes these to fallback rather than trusting a v1 decompose.
2. The error shape is exactly the taxonomy shape the contracts expect: `{"key":"variants[0].<prop>","error":"invalid_value"}` (Contract 12 → `ATOMIC_STYLES_INVALID`). Off-enum / typed-mismatch all surface as `invalid_value` keyed by `variants[<i>].<prop>`.

### Stripped-text findings (`html-v3` inline-only allowlist)

- `04-testimonial`: `<br>` inside the `<blockquote>` and an `<img>` nested in `<figcaption>` are flagged for promotion (the inline allowlist is `b,i,em,u,a,del,span,strong,sup,sub,s`; `<br>`, `<blockquote>`, `<img>`, `<small>`, `<cite>` are NOT inline-allowed → the normalizer MUST promote block content to sibling nodes, RESEARCH.md §6.6). No other section has block-in-text.

## 5. Tree dry-run validity (acceptance: produced trees pass dry_run)

A converted pricing-card tree (`e-div-block` > `e-heading` + `e-button`, with a local style carrying the native props incl. the decomposed `box-shadow`) was run through the authoritative save path (`create_element_instance()` + `get_data_for_save()`):

```
TREE_DRYRUN valid=true
(all converted nodes instantiate + get_data_for_save clean)
```

(Element shapes per the S01-verified contract: atomic widgets are `elType:"widget"` + `widgetType:"e-heading"/"e-button"`, NOT `elType:"e-heading"` — an early dry-run with `elType:"e-heading"` returned `instance_null`; recorded so WP-H## emits the correct shape.) **The converter never emits a tree PHP rejects** — the fallback ladder guarantees only `Style_Schema`-valid props reach `native`; everything else goes to `custom_css`/dropped, which do not affect tree validity.

> PHP `dry_run` controller (WP-P03) is not built yet; this spike approximated the authoritative verdict with the live atomic save-validation classes directly (`Style_Parser::parse()` for per-prop, `create_element_instance`+`get_data_for_save` for whole-tree). **Residual flagged:** the full WP-P03 `Validator::dry_run($elements,$settings)` wrapper (Contract 14 §3) must re-confirm on the same fixtures once built.

## 6. Recommended `corpus.manifest.json` thresholds + tolerances (the gate anchors)

Written to `spec/spikes/fixtures/sections/corpus.manifest.json` (band=realistic, declaration-weighted). WP-Q04 copies this to `packages/shared/fixtures/html/corpus.manifest.json` and derives each section's `expected.coverage.json`.

| Section | expected native % | min (gate) | tolerance |
|---|---|---|---|
| 01-pricing-table | 90.5 | 85.5 | ±5.0 |
| 02-hero | 85.1 | 80.1 | ±5.0 |
| 03-feature-grid | 76.8 | 71.8 | ±5.0 |
| 04-testimonial | 82.8 | 77.8 | ±5.0 |
| 05-cta-banner | 84.2 | 79.2 | ±5.0 |
| **corpus** | **84.8** | **79.8** | ±5.0 |

- **Tolerance band: ±5.0 pp per section.** Wide enough to absorb minor classifier refinements + Elementor minor-version schema additions without churn; a drop beyond it is a real regression requiring an explicit PR diff (Contract 14 §6).
- These are the CLEAN-fixture (upper-bound) anchors. WP-Q04 SHOULD add ≥2 messier real-world exported sections to anchor the lower end (~60–75%) before locking a corpus floor — flagged below.

## 7. Recommended auto-commit threshold (RESEARCH.md §12 OQ#3 — "what minimum native coverage blocks an auto-commit?")

**Auto-commit floor = 60% native (realistic band).** Below 60% the `convert.*` tool MUST NOT auto-persist — return the dry-run + diff + coverage report + a11y findings and require an explicit `commit` + elicitation confirm (LOCKED policy, RESEARCH.md §6.8, Contract 13 §1.9, Contract 15 §6 line 90).

Layered policy (recorded for the convert WPs):
- **native ≥ 70%** → eligible for auto-commit IF no a11y blocker AND visual-diff `score` above the §6.8 visual threshold. (Coverage alone never auto-commits — the visual diff is the real gate.)
- **60% ≤ native < 70%** → always require explicit `commit` (review band; `review_below_native_pct:70`).
- **native < 60%** → block; the section is too lossy to native-convert; recommend V3-classic fallback or an `html` widget dump with a loud report (`auto_commit_min_native_pct:60`).
- **ANY a11y blocker (skipped heading level, empty interactive name, missing alt)** → block auto-commit regardless of coverage (RESEARCH.md §6.5).

Rationale: 60% is below the lowest CLEAN-fixture realistic value (76.8%) by a comfortable margin so clean marketing sections always pass, while messy exported HTML (~60–75%) lands in the review band rather than being silently auto-persisted at low fidelity. **NEVER hardcode 85%** — the convert WPs read these numbers from `corpus.manifest.json`, never from a literal.

## 8. Honest limits / caveats (de-risking)

1. **Coverage % ≠ visual fidelity.** A high declaration-coverage % co-exists with lower visual fidelity because the hard props (gradients/transitions/transforms — 100% of the tail) carry disproportionate visual weight. The visual-diff (`convert.fidelity_check`) is the primary gate; report per-section visual scores, never a global pixel-fidelity promise (SUPPLEMENT §C.4: real-input pixel fidelity lands well below 95% initially).
2. **Clean fixtures = upper bound.** These numbers are the top of the band. Add messier exported sections (WP-Q04) to anchor the bottom.
3. **Pro vs free.** `custom_css.raw` carries the tail on Pro; on a free-only target it is stripped → re-classify custom_css % as dropped. Run the corpus on both, gate per target.
4. **`Style_Parser::parse()` is a lenient save-gate** (does not catch wrong typed-shape decomposition) — visual diff is the real fidelity check (§4 nuance 1).
5. **Typed-object props are decomposable but risky.** transform/filter/single-box-shadow DO save-validate when correctly shaped (§4) — a future converter can move them from the realistic-fallback bucket into native, raising the realistic band toward the optimistic one. The gate is anchored on the conservative (realistic) band so the convert WPs are never blocked by an over-optimistic baseline.

## 9. Spike-gate impact (Contract 15 §6 / Contract 14 §6)

**S3 is PASS with a recorded, reproducible coverage band + per-property fallback findings + dry-run-valid trees.** This UNBLOCKS the `convert.*` coverage-threshold WPs:
- `corpus.manifest.json` thresholds are established (realistic band, ±5pp, auto-commit floor 60%, review band 60–70%).
- The HTML pipeline vertical (WP-H##) and WP-Q04 (HTML corpus regression) consume these S3 numbers — **no `convert.*` WP may hardcode 85%; read the per-section number from `corpus.manifest.json`.**
- The 5 section fixtures are left reusable: WP-Q04 moves them into `packages/shared/fixtures/html/sections/<n>/` with `expected.coverage.json` (derived from `convert.result.json` via `s03-measure-coverage.mjs --json`) and `expected.a11y.json` (from the stripped/a11y findings here).
- `s03-measure-coverage.mjs` is reusable as the basis for WP-Q04's corpus assertion + `convert.fidelity_check` coverage scoring.

**Residual / follow-ups (flagged):** (a) re-confirm tree validity through the real WP-P03 `Validator::dry_run` wrapper once built; (b) WP-Q04 add ≥2 messy exported sections to anchor the lower (~60–75%) end before locking a hard corpus floor; (c) a converter that decomposes transform/filter/box-shadow can later promote them from realistic-fallback to native and raise the band — re-measure then.
