# Contract 18 — Figma front-end & authoring integrity (SHIPPED 2026-06-11; figma one-shot RETIRED same day)

> **Post-ship product decision (2026-06-11):** the `figma_to_tree`/`figma_to_page` tool surface is
> RETIRED — unregistered via `catalog/profiles.ts RETIRED_TOOLS` (dev re-enable: `ULTRA_FIGMA=1`).
> Field scores: agentic 0.20–0.94% vs one-shot 7.63–20.13%; the agentic path (skill recipe +
> deploy/diff/replace, powered by this contract's §7-AI verbs) is the only supported Figma path.
> The figma-parse stage + tests remain in the tree, dormant. §7 fix tables and the 18.1 punch list
> (task #17) are parked unless the decision reverses.

**Status:** DRAFT 2026-06-11 · **Depends on:** 16 (behavior tiers), 17 (integrity + verify loop), 11 (authoring),
12 (error taxonomy), 13 (tool catalog), 15 (engineering standards).
**Absorbs:** draft contract 19 (authoring integrity) — merged here in full as §7-AI; the 19 file is retired.
**Finalization inputs (all landed — see §8):** R1 "WPOS Figma v2", R2 "E2M Solutions", R3 "Driftwell Baseline",
R4 "Five Pathways" (full-site bespoke rebuild; source of the §7-AI findings).

## 0. Principle

Figma input is RICHER than HTML input — auto-layout, tokens, and variants carry designer intent that the
HTML path must infer. The Figma front-end therefore feeds the EXISTING pipeline at the IR seam and never
degrades below what the HTML path achieves. Same honesty rules as 16/17: every node, token, and interaction
is converted, flattened, or honestly dropped with a reason — never silently lost.

Second principle (absorbed from 19): **a write is not done when it persists — it is done when the
document RENDERS.** The validator's promise ("if it passes, it renders") must cover the settings bag
and the actual front-end render path, not elements only. Everything the writer accepts is validated
against what the render path will do with it; the one check that cannot be done statically (the render
itself) gets a cheap dynamic probe.

## 1. Architecture (locked by the capability assessment + 0.97% field proof)

One new stage: **figma-parse** (Figma node JSON → IrNode forest + ParseResult-compatible envelope
`{ir, doc_direction, viewport_used: frameWidth, raw_inner_markup: {}}`). Everything downstream —
normalize → classify → map → style-extract → assemble → hoist → variable-extract → gates → 17's
integrity invariants and verify loop — reuses UNCHANGED (the types.ts IR seam is pre-envelope, DOM-free).

**Rejected:** Figma→HTML→converter (lossy double conversion; destroys explicit auto-layout/token/variant intent).

Fidelity ground truth: `FIGMA_RENDER_IMAGES_OF_FILE_NODES` PNG of the source frame replaces the source-page
screenshot in V1/V3 of the 17 loop. Playwright is not needed at parse time (only for post-save verification).

## 2. Mappings (field-proven or capability-assessed)

| Figma | Pipeline | Status |
|---|---|---|
| auto-layout (layoutMode/itemSpacing/padding/axis align/grow/hug-fill) | flex/grid SemanticRoles + ComputedStyleSet — REPLACES flex-inference heuristics | proven (page 2037) |
| fills / strokes / effects / cornerRadius | background / border / box-shadow / border-radius | proven |
| TEXT style + characterStyleOverrides (+ hyperlink) | TextRun[] incl. linkHref | proven |
| image fills (GET_IMAGE_FILLS) | MediaRef → MediaPort.sideloadUrl — **sideload during convert; URLs expire 14/30d** | proven |
| vectors / composite icons | Figma-rendered SVG/PNG → media (contents_only:false for overlapping-sibling icons) | proven |
| design tokens (EXTRACT or local mining) | global variables (color/font/size) + named styles → proposed_classes, designer-authored names | proven |
| prototype ON_CLICK NAVIGATE / OPEN_OVERLAY | link / Pro popup (tier 1) | assessed |
| ON_HOVER variant swap (dominant in real files) | hover-effect tier 2 via variant prop diff → hoverComputed | assessed |
| SMART_ANIMATE/DISSOLVE on appear | entrance-animation tier 2 approximation | assessed |
| drag / smart-animate morphs / multi-screen flows | honest-drop with reason | locked non-goal |

## 3. The flatten policy (the 0.97% lesson — normative)

Complex visuals — blur/backdrop effects, layered photo clusters, device mockups, any subtree whose
faithful CSS reproduction is uncertain — are FLATTENED: rendered by Figma as a single PNG and placed as
one e-image. Flattening decisions are recorded in the report (`flattened[] {nodeId, reason}`).
Native building is for what natively builds: boxes, text, simple gradients, grids/stacks, simple shadows.
The flatten/native boundary is tunable via option `flatten: 'aggressive'|'balanced'|'minimal'` (default balanced).

## 4. Extraction protocol (Composio specifics — field-verified)

- Native MCP tools (`mcp__figma-composio__*`); the 13 write-tool slugs are HARD-DENIED for conversion agents.
- `GET_FILE_JSON` with explicit ids (DISCOVER returned 0 nodes on a real file). Fetch BOTH simplified
  (structure; ~70% smaller; `$fillN` dedup table carries gradient/image refs) AND raw (simplified strips
  text typography). Budget ~1.5MB+ per frame; save once, mine locally.
- Token extraction: EXTRACT_DESIGN_TOKENS when scopes allow; LOCAL MINING from the node tree as fallback
  (proven equivalent). Connection scope asymmetry is real — per-tool fallback across connected accounts.
- Enterprise-gated (mode-aware variables, library analytics): non-goals; degrade to style-based extraction.

## 5. Open design problems (scoped as convention + honest fallback, not full solutions)

- **Responsive (the gap):** Figma has no media queries. v1 supports a frame-naming convention —
  sibling frames `<Name>/Desktop|Tablet|Mobile` (or width-recognizable duplicates) diffed by node
  correspondence into per-breakpoint variant overrides. ABSENT a mobile frame: heuristic adaptation
  (grids stack, type scales, nav→hamburger) is applied and REPORTED as `responsive: 'synthesized'`.
- **Semantics:** heading levels from type scale + layer names; buttons/links from prototype actions +
  shape+text composition; forms are NOT inferred in v1 (pictures of forms stay pictures — reported).
  A11y gate runs in advisory mode for Figma input until precision is measured.

## 6. Surface & invariants

- Tool: `convert.figma_to_page {figma_url | file_key+node_id, title, commit, confirm, options}` +
  `convert.figma_to_tree` (preview). Options: flatten, carry_fonts (17), include_js n/a, verify_gate (17).
- Report: same envelope as 17 (coverage + behavior + verification) + `figma: {frame, tokens, flattened[], responsive}`.
- Invariants: (F1) every Figma node lands in exactly one of {native, flattened, dropped+reason};
  (F2) every token referenced by converted styles exists as a minted variable or inline value — no dangling refs
  (17-I1 applies unchanged); (F3) asset URLs never persist — attachment ids only; (F4) the 17 verify loop runs
  against the Figma frame render; R3 draft-gate applies; (F5) content-presence audit — every TEXT node's
  characters from the source frame appear in the converted output (or in a dropped+reason entry); (F6) the
  gate consumes the HARDENED verify loop (§7 P1-d/P1-e) — a gate verdict from the pre-17.1 loop is not valid.
- CI corpus gains one Figma fixture (node JSON snapshot + frame PNG committed, so CI needs no Figma access).

## 7. Prerequisites — the 17.1 fix wave (NORMATIVE; blocks this contract's wave)

Every item below is field-verified (Driftwell baseline page 2658 + WPOS v2 page 2631 + WPOS Fresh 1892 +
Figma builds 1973/2037). Each carries its fix site and a corpus guard — per contract 17 §4, a fix without
a regression assertion is not fixed.

### P1 — correctness (silent loss / broken output / lying gate)

| # | Symptom | Root cause / fix site | Corpus guard |
|---|---|---|---|
| P1-a | Mixed-children text loss: div with bare text node + element child drops the bare text (`$0<small>/forever</small>` → "$0" gone); `stripped_text` stays empty | parse `extractTextRuns` mixed-children handling; any stripped text MUST land in `stripped_text` | every source text string ≥3 chars present in converted DOM (content-presence audit) |
| P1-b | Mobile overflow on grid-only media queries: 743px scrollWidth @390 (test.html-style queries fixed; grid-template-columns-only queries not) | style-extract per-breakpoint emission: cover ALL layout-prop media deltas (grid-template-columns, flex-direction, display) not just width resets | corpus page with grid-only @media → scrollWidth==390 |
| P1-c | Tier-2 interactions dead on frontend: blob present (1.7KB), 128 nodes stamped, scripts enqueued, but no initial hide — opacity constant 1.0 (fired fine pre-17 on page 1892) | 17 changed id stamping/emission; verify blob `elementId` ↔ stamped `data-interaction-id` correspondence + initial-state application | behavioral probe: per-frame opacity sample must show <1 → 1 ramp on a scrollIn element |
| P1-d | Verify gate lies: gate+v2 PASS with 743/390 mobile, 100% divergence causes `unknown`, notation diffs counted as divergences | verify-loop V2 must measure `document.scrollWidth` inside each breakpoint viewport for real; wire cause attribution (dangling_ref/base_default/font_not_carried/...); normalize value notation before diffing | corpus asserts gate FAILS on a deliberately-overflowing fixture; ≥80% of divergences carry a non-unknown cause |
| P1-e | Verify loop blind spots (meta): content presence, removed elements, off-canvas overflow, runtime behavior all invisible to computed-style diffing | add to verify-loop: content-presence audit (P1-a guard), source-vs-converted element-count delta report, behavioral probes for authored interactions (16's fidelity probes wired into the loop) | the Driftwell fixture (committed) must FAIL the v17.0 gate and PASS the v17.1 gate |

### P2 — visual/structural defects

| # | Symptom | Root cause / fix site | Corpus guard |
|---|---|---|---|
| P2-a | Stray top-level nodes: synthesized/promoted nodes (pseudo synthesis and/or block promotion) emit AFTER the root wrapper (probe: 69px + 68px siblings, one holding a paragraph) → +20px page height + global vertical ghosting = dominant odiff inflation | normalize/pseudo-synthesis placement: synthesized nodes attach INSIDE their host's subtree at the correct index, never at top level (font-carry widget verified innocent, h=0) | converted top-level element count == 1 root (+ font widget); height delta vs source ≤4px |
| P2-b | Inline pseudo placement: eyebrow ::before dash renders at section top-left instead of inline-flex position | pseudo synthesis for inline/inline-flex hosts: insert as first child of the host, not promoted sibling | eyebrow fixture renders dash within 4px of source position |
| P2-c | @keyframes-driven elements vanish silently (pulse dot: element + animation gone, no report entry) | classify/keyframe detection: computed `animation-name != none` must yield a DetectedBehavior (tier 2 if mappable, honest-drop otherwise); the ELEMENT must never be dropped | pulse fixture: dot element present; behavior entry exists (any tier) |
| P2-d | Anchor ids dropped → all in-page nav dead (hrefs carried, targets gone) | carry source `id` attrs onto converted nodes (CSS-id setting or wrapper anchor; attributes transformer is a no-op) | every source [id] referenced by an in-page href exists on the converted page |
| P2-e | In-text link underline dropped | inline fold: carry text-decoration on folded `<a>` runs | in-text link computed text-decoration == source |
| P2-f | Font-carry misses families: JetBrains Mono not carried on WPOS v2 (Bricolage was) | buildFontCarry usedFamilies matching must normalize quoted/fallback-list family strings | corpus: ALL source families pass the measured-width load test |

### P3 — reporting noise (erodes trust in the numbers)

| # | Symptom | Fix site | Guard |
|---|---|---|---|
| P3-a | ~140 phantom `transition` custom_css entries on nodes declaring no transition — survives I4 | declaration-classifier: drop computed transition values not declared in source CSS (or extend I4 noise predicate) | Driftwell custom_css_pct ≤3% |
| P3-b | Gradient color-stop notation (`0%`/`100%` vs none) counted as divergence | verify-loop value normalization before compare | zero notation-only divergences on corpus |
| P3-c | CLI exits 0 with css_primed:false; interaction-id stamped on ALL nodes (128) not just animated (3) | cli.mjs exit 2 on unprimed; emitter stamps only interaction-bearing nodes | stamped count == authored count |

### §7-AI — Authoring integrity (absorbed contract 19; field source: R4 "Five Pathways")

R4 rebuilt fivepathways.com (Nuxt + canvas-animated illustrations) as a 289-node V4 page through the
full kit/MCP path. dry_run passed first try; build #1 (page 2789) saved with `css_primed=true` — and
served a **PHP fatal to every visitor**. Build #2 (page 2801) shipped a high-fidelity clone. Every tool
that was supposed to succeed succeeded; the one failure was a write the system should have refused.

**Findings (AF-numbered to avoid clashing with §6's F-invariants):**

| # | Finding |
|---|---|
| AF1 (CRITICAL) | Page-settings `custom_css` as object (`{raw: base64}` — the CORRECT shape for atomic style variants per contract 11) passes `page_build` unvalidated (`pageSettingsSchema` = free-form record; PHP `apply_settings_merge()` deep-merges blindly) → Pro's custom-css module calls `trim()` on the array → **sitewide PHP fatal** (`elementor-pro/modules/custom-css/module.php:101`) while `css_primed=true` reports green. Inverse-trap pair: style custom_css REQUIRES the object; page-settings custom_css REQUIRES a plain string. Recovery: `update_settings {custom_css: ""}`. |
| AF2 | No render verification exists on ANY write path — a fully green build (valid+saved+primed+op-logged) shipped a dead page. 17's verify loop covers the convert path only. |
| AF3 | No iterate-in-place for generated pages: only `cli.mjs build` (always a NEW page); polish forced new-page → re-canvas → re-bind → trash-old. |
| AF4 | Nav binding is a 3-call epilogue: nav-menu widget accepts `menu:'slug'` at build but never resolves it; needs get_structure (for base_hash) + nav_bind_widget after every build. |
| AF5 | Fonts have no first-class path: woff2 required docker-cp + html-widget `<style>` @font-face. |
| AF6 | Canvas-drawn art capture is institutional knowledge: scroll-animated `<canvas>` illustrations appear as NO img/css-bg/network asset; working recipe = full slow scroll (animations complete) → `canvas.toDataURL('image/png')`. Nothing in parse or the skill captures this class. |
| AF7 | Audit recipes re-trip their own documented traps (lazy-load naturalWidth, fonts.check() lying) because every run re-implements them; width-probe is ALSO inconclusive for metrically-compatible faces — `[...document.fonts]` STATUS enumeration is the reliable check; PIL not sips for slicing. |
| AF8 | Kit ergonomics: no `M()` margin helper (AUTO sides hand-built 3×); no `_t` tablet variant (only `_m`). |

**Fixes (normative):**

- **S1 — Settings validation (kills AF1).** The authoritative validator gains a document-settings
  schema pass on `dry_run`/`page_build`/`page_update_settings`: typed allowlist of known keys —
  `custom_css` (string; REJECT object/array → `SETTINGS_INVALID`), `template` (enum incl.
  `elementor_canvas`), `hide_title` (bool), `post_status` (enum). Unknown keys pass through; known
  keys with render-fatal shapes are hard errors. `packages/shared` mirrors the schema (same
  sync/drift discipline); TS `pageSettingsSchema` applies the allowlist as a prefilter (PHP stays
  authoritative). Contract 11 + skill prop-shapes.md document the AF1 inverse-trap pair.
- **S2 — Render verification (kills AF2).** `page_build`/`replace_tree` gain `verify_render`
  (default TRUE for `page_build`): after save+prime, the plugin fetches its own permalink
  unauthenticated (in-process loopback; **direct front-controller dispatch fallback is MANDATORY** —
  wp-env/Docker containers often cannot resolve their own siteurl), asserts HTTP 200 + no fatal
  marker, returns `render_verified` next to `css_primed`; failure = taxonomy `RENDER_FAILED`,
  op-logged. Standalone `elementor.page.verify_render {post_id}` exposes the probe for any document.
- **S3 — Iterate-in-place (kills AF3, AF4).** `cli.mjs replace <post_id> <spec.json>` (file-based
  replace-tree; fetches base_hash itself). Spec manifest: `emit()` accepts and `cli.mjs deploy`
  honors `{title, elements, settings, template, nav_bindings:[{element_id|widget_index, menu_slug}]}`
  — build-or-replace → template → binds, one command, one op-log chain. PER R1 MINING: replace/deploy
  re-prime AND verify the page references the fresh CSS hash (stale CSS cost R1 ~10 calls; flush
  route is DELETE /cache). PHP writer resolves nav-menu `menu` slugs to term ids at save (or flags
  slug-only as `UNBOUND_MENU`).
- **S4 — Fonts as design assets (kills AF5).** Scope: Elementor V4 already collects atomic
  `font-family` props and enqueues ~1600 Google-catalog families natively (see "Font system
  strategy" below — 17.1 fixes why that path doesn't fire). New tool
  `elementor.design.fonts.install {source: url|base64, family, weight, style}` is for NON-catalog
  faces only: stores woff2 under uploads, registers @font-face (Pro Custom Fonts CPT when available,
  else kit custom CSS), returns the resolved family string. CAP_MANAGE; font mimes allowed on this
  path only. Skill drops the docker-cp recipe once it lands.
- **S5 — Capture & audit tooling (kills AF6, AF7).** `convert.capture_site {url}` returns an asset
  manifest: img/CSS-bg assets, **canvas extractions** (AF6 recipe), inline SVGs, @font-face inventory,
  body/heading tokens, per-section computed samples — feeds converter runs AND bespoke rebuilds.
  `cli.mjs audit <url>`: the canonical verify.md checks as one deterministic command — force-eager +
  full scroll BEFORE broken-image detection, `document.fonts` STATUS enumeration (never check()),
  overflow/h1/landmarks/dead-links/missing-alts, pass-fail table, exit code. Audits use LIBRARY
  Playwright, never the MCP singleton.
- **S6 — Kit ergonomics (kills AF8).** `M(t,r,b,l)` margin helper accepting AUTO; `_t` tablet
  variant alongside `_m`; verify.md names PIL for slicing.

### Infrastructure (task #14 — expanded from R1/R2 transcript mining)

> **Ownership:** the authoring-side verbs below implement §7-AI S3/S5 (below); this section is their
> field-evidence record. Converter-only items (manifest convention, figma fetch-to-file, `diff` verb,
> SVG upload, kit helpers) are 17.1 scope proper.

Every item below was hand-rolled by MULTIPLE independent agents — the definition of a structural gap:

- **`cli.mjs update <post_id> <spec.json>`** — replace-tree (+force) + auto re-bind nav + re-canvas +
  re-prime. E2M iterated via 5 hand-built raw-REST calls because no update path exists and the
  replace_tree MCP tool is broken (returns no structuredContent → -32602; fix the handler).
- **`cli.mjs audit <url>`** — verify.md checklist as code (h1, overflow at both widths, broken images
  with lazy-load handling, console, dead links, measured-width font test, hamburger click-test).
  Hand-written 4+ times (e2m-audit.mjs, bl-verify-src.mjs, NASA/Allbirds equivalents).
- **`cli.mjs capture <url>`** — target capture: UA spoof (CloudFront 403s real sites), modal dismissal,
  full-page PNG + computed-token JSON + banded crops. Hand-written per clone job.
- **`cli.mjs crops <png> [band]`** — banded slices for studying tall screenshots (sips/PIL re-rolled in
  both R1 and R2).
- **`cli.mjs font-install <file> <family>`** — formalize the cf-fonts mu-plugin flow. Design fonts off
  Google Fonts are the NORM for Figma input (R1 hunted Armin Soft across the web; Novaletra came from a
  repo zip). figma-parse must report per-family availability {google|local|missing}.
- **Figma payloads never through context** — MCP results are huge and harness-persisted; figma-parse
  fetches to file natively. Interim: ship a reference node-tree miner in the skill (R1 hand-rolled
  mine.mjs and invoked it 16×).
- **Extraction MANIFEST (normative for resume)** — figma-parse persists `manifest.json`
  {file_key, node_id, frame_name, frame_size, asset_map} alongside artifacts. The R1-resume agent
  burned 8 calls grepping memories/transcripts/old runs to recover the file_key its predecessor
  never wrote down.
- **`cli.mjs diff <url> <ref.png>`** — shoot + pixelmatch + band table + top-offender crops in one
  command. R1's convergence loop (8 iterations) re-rolled ESM pixelmatch boilerplate ~15× — the
  iterate loop is THE workflow and today costs ~6 commands/round; target 2 (`diff` + `update`).
- **`cli.mjs fonts`** — list registered families (kit globals + mu-plugin @font-face + Google-catalog
  match). R1 spent 7 calls (incl. docker exec) confirming one family existed on the site.
- **CSS freshness in `update`** — after replace-tree, stale primed CSS cost R1 ~10 calls (version-hash
  grepping, nocache busting, discovering the flush route is DELETE /cache not POST /cache/flush).
  `update` re-primes AND verifies the page references the fresh CSS hash.
- **Library Playwright for verification, never the MCP singleton** — browser-already-in-use/target-closed
  errors under concurrent agents (4 in R1); document in verify.md.
- SVG sanitizer ported into `/media/upload`; `cli.mjs upload-from-path` (kills the :8080 dance).
- Kit: RADT/RADB per-corner radius, `css(node, decls)` helper, `fontLoader(family, weights)`,
  hamburgerNav `_m` deep-merge, document html-v3 strips inline style attrs (accent recipe = nested
  custom_css, NOT style attrs).

### MCP surface debt (agents hit these every run — fix in 17.1)

| # | Symptom | Fix site | Guard |
|---|---|---|---|
| M-a | `replace_tree` MCP tool: -32602 'no structured content' on success paths (REST works) — forced E2M + R1 to raw REST for every iteration | tools/page.ts replace_tree handler: always return structuredContent | live smoke: replace via MCP tool succeeds |
| M-b | Destructive-tool decline paths return content-only results (~11 call sites, original-audit residual #10) | route through shared declinedResult with schema-valid structured payloads | decline each destructive tool once in smoke; no -32602 |
| M-c | `pages_list` `fields` param is a silent no-op (discovery.ts never forwards it) | forward fields to REST | projected response contains ONLY requested fields |
| M-d | `design_classes_list` fields=['id','label'] returns only {label} (PHP projection drops id) | PHP fields projection keymap | id survives projection |
| M-e | Duplicate same-route batch steps collide on derived op_id (2nd step silently no-ops as replay) | salt derived op_id with step index | batch with 2 identical-route steps applies both |
| M-f | HTTP transport: new session evicts the previous one | per-session server map eviction policy | two concurrent sessions both serve tools/list |
| M-g | `custom_css` coverage not license-feature-gated (counts as covered on sites whose Pro license lacks atomic-custom-css — portability only) | capabilities expose the license feature; coverage counts custom_css as dropped when absent | capability-gated corpus assertion (skipped on licensed dev stack) |

### Font system strategy (supersedes the carry-link-only approach)

Source dive (2026-06-11) found Elementor V4's NATIVE font pipeline: atomic-styles-manager collects every
`font-family` prop into `elementor_atomic_styles_fonts-<style_key>` options during CSS transform and
enqueues them on render via the Google-Fonts catalog (~1600 families incl. Bricolage AND JetBrains Mono).
Converted pages SHOULD have loaded these natively — they didn't. 17.1 must root-cause why (hypotheses:
headless prime doesn't fire the prop-transform collection; multi-family fallback strings fail
`Fonts::get_font_type` matching; canvas template skips enqueue) and FIX the native path. The carry-link
widget then demotes to fallback for non-catalog fonts only. `cli.mjs fonts` (below) + `font-install`
complete the story for design fonts (Armin Soft / Novaletra class). Guard: corpus families load via the
NATIVE path with carry_fonts:false.

### Detection honesty extension (16 residual)

JS-driven text mutations (rAF count-ups) and computed `animation-name` keyframes that classify cannot map
must still APPEAR — as `detected, tier 4, reason` or as a report-level `undetectable_classes[]` note
(script census evidence). Silence is the only forbidden outcome. Guard: WPOS fixture's count-up + pulse
both appear somewhere in the report.

### Acceptance for the 17.1 wave itself

Re-convert the two committed fixtures (test.html + bl-landing.html): all P1 guards green, odiff ≤4% at 1440
on both (Driftwell baseline was 6.48% with P2-a inflation; removing the +20px ghosting alone should clear it),
scrollWidth exact at 390 on both, interactions fire (behavioral probe), WINS regression-guarded (90.4%
native coverage ±2, fonts load — via the NATIVE path, ghost buttons transparent, em accent, li::before
honest drops). PLUS: all M-row guards green in live smoke; every new CLI verb (update/audit/capture/
crops/diff/fonts/font-install/upload-from-path) exercised once end-to-end; the R1 convergence loop
re-runnable at ≤2 commands per iteration (diff + update).

Authoring-integrity acceptance (absorbed from 19):
- A1: replaying the R4 build-#1 spec (object `custom_css` in settings) FAILS dry_run with `SETTINGS_INVALID`.
- A2: a build whose render fatals returns `render_verified:false` + `RENDER_FAILED` (op-logged); a healthy
  build returns `render_verified:true`.
- A3: the R4 polish iteration replays as `cli.mjs replace 2801 spec.json` — no new page id, canvas template
  and nav binding survive.
- A4: a fresh agent reproduces the Five Pathways font setup with one `fonts.install` call per face.
- A5: `cli.mjs audit` on page 2801 matches the R4 manual audit, zero false positives at scroll-top.

## 8. To be finalized from runs R1–R3

- R1 ✅ LANDED (WPOS Figma v2, page 2778): **2.22% pixel diff on a 1440×6225 frame, height exact** —
  effectively at the ≤2% target on a complex design (pinstripe bands, 325/800px corner curves, overhanging
  badge). Native MCP figma tools worked; large payloads were harness-persisted and mined from disk
  (validating fetch-to-file). The run survived TWO mid-run agent deaths via the /tmp artifact convention —
  the resumed agent rebuilt from the predecessor's raw.json + section dumps with ZERO re-extraction.
  NORMATIVE consequences: (a) figma-parse persists every extraction artifact to disk as it goes (raw JSON,
  per-section summaries, reference render) so any interruption resumes without re-fetching; (b) per-section
  mining is an in-stage pattern (solo miner sufficed; the 8-agent fan-out is an optimization, not a
  requirement); (c) realistic automated pixel target: ≤2.5% complex frames / ≤1% simple frames, flatten
  policy assumed. Final verification (completed inline after the finish-line death): 1 h1, zero overflow
  at 1440 AND 390, 0/20 broken images, 0 console errors, hamburger opens 5 items.
- R2 ✅ LANDED (E2M Solutions, page 2693): control-group verdict — the custom path's edge is (a) REAL
  link destinations verified from the live site, (b) brand tokens captured from the rendered site, (c)
  iterative refinement via replace-tree. figma-parse must preserve (c): the wave's tool surface needs a
  re-convert/update path onto an EXISTING page (cli `update` subcommand + fixed replace_tree MCP tool —
  see §7 infra; the MCP tool currently errors 'no structured content' while REST works). Also field-set
  for §7: html-v3 strips inline style attrs (accent carry MUST use the nested-custom_css form — verify
  map.ts emits that, not style attrs), hamburgerNav _m deep-merge, fontLoader helper. Quality bar
  confirmed: 3 dry-runs all valid-first-try, full verification green at both widths.
- R3 ✅ LANDED (Driftwell, page 2658): baseline on fresh content = 90.4% native coverage (I4 filter working),
  6.48% odiff at 1440 (mostly cumulative vertical drift), fonts carried (both families), ghost buttons +
  inline accents survive, 3/3 reveals detected→tier2→post-save survival. THRESHOLD IMPLICATIONS for 18:
  acceptance pixel target for figma_to_page stays ≤2% (flatten policy makes Figma EASIER than HTML);
  coverage threshold ≥85% native post-noise-filter. CAVEATS FOLDED INTO §6: the 17 verify loop has
  measured blind spots (content presence, off-canvas overflow, runtime behavior, cause attribution) —
  18's F-invariants must NOT rely on the verify gate alone; F1 node accounting + a content-presence
  audit (source text strings present in converted output) are mandatory. See task 'Wave 17.1 punch list'
  — P1 fixes (mixed-text-node content loss, mobile width regression on grid-only media queries,
  non-firing tier-2 interactions, V2 scrollWidth audit) are PREREQUISITES for 18's wave.
- R4 ✅ LANDED (Five Pathways, page 2801 — parallel session): full-site bespoke rebuild, 289 nodes,
  47 sideloads/0 failures, dry_run first-try valid, high-fidelity clone (~8% height delta), hamburger +
  fonts verified. Its build #1 (page 2789) is the AF1 fatal record — the entire §7-AI block above is
  this run's findings, absorbed from draft contract 19.
