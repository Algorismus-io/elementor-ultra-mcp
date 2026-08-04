# Contract 16 — Behavior conversion (HTML+CSS+JS → Elementor)

**Status:** v1 frozen 2026-06-11 · **Depends on:** spike `WP-S08-interactions-findings.md`,
contracts 10/11/13. Extends the convert pipeline (`packages/server/src/convert/`) from
static-visual conversion to behavior conversion via a four-tier model.

## 0. Principles (inherited from the CSS tier model — non-negotiable)

1. **Most-native tier wins.** Every detected behavior lands in the highest tier that renders:
   native behavior widget → native interaction → (opt-in) JS passthrough → honest drop.
2. **Never a silent lie.** Every detected-but-unconverted behavior appears in the coverage
   report with its tier and reason. Silent drops are bugs.
3. **PHP/Elementor remains authoritative.** Interactions are sanitized server-side with
   SILENT drop semantics (S08) — the pipeline MUST read back after save and assert survival;
   a dropped interaction downgrades the report, never fakes success.
4. **Nothing auto-commits.** Tier 3 (JS passthrough) additionally requires explicit opt-in
   (`include_js`) AND elicitation confirm, independent of the commit confirm.

## 1. Behavior IR (extends `convert/types.ts` — frozen)

```ts
interface DetectedBehavior {
  kind: 'tabs' | 'accordion' | 'carousel' | 'nav-toggle' | 'form' | 'entrance-animation'
      | 'hover-effect' | 'marquee' | 'countdown' | 'video-embed' | 'custom-js';
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];          // e.g. ["role=tablist", "classname:swiper", "listener:click"]
  nodeIds: string[];           // IR node ids participating (trigger + panels)
  tier?: 1 | 2 | 3 | 4;        // assigned by mapping; 4 = dropped
  reason?: string;             // why it landed in that tier
}
// IrNode gains: behaviors?: DetectedBehavior[] (on the pattern ROOT node)
// ParseResult gains: pageScripts: { src: string | null, inline_bytes: number, external: boolean }[]
```

## 2. Detection (parse + classify)

Signals, in priority order (multiple signals raise confidence):
- **ARIA/semantics:** `role=tablist/tab/tabpanel` → tabs; `aria-expanded` + sibling panel /
  `<details><summary>` → accordion; `role=navigation` + toggle button → nav-toggle;
  `<form>` → form.
- **Classname heuristics:** `swiper|slick|splide|carousel|glide` → carousel;
  `accordion|collapse` → accordion; `tabs|tab-` → tabs; `navbar-toggler|hamburger|menu-toggle`
  → nav-toggle; `aos|animate__|wow|fade-in|reveal` → entrance-animation; `marquee|ticker` → marquee.
- **Runtime probes (CDP, during the existing Playwright parse):** elements with click/touch
  listeners (`getEventListeners`) that are not anchors/buttons-with-href → candidate triggers;
  computed `animation-name != none` + `@keyframes` extraction from CSSOM → entrance-animation
  (capture keyframe property set: opacity/transform deltas); `transition` on hover-changed props
  (the parse already forces `:hover`) → hover-effect.
- **Script census:** every `<script>` (src or inline) recorded into `pageScripts` for Tier 3 / coverage.

## 3. Tier 1 — native behavior widgets (map + assemble)

| Detected | Target (this site's registry) | Notes |
|---|---|---|
| tabs | **atomic `e-tabs` family** (`e-tabs > e-tabs-menu > e-tab*` + `e-tabs-content-area > e-tab-content*`) | fetch the live props schema via `GET /schema/widget/e-tabs`; tab labels from trigger text, panels from tabpanel subtrees (recursively converted) |
| accordion | tabs-degrade OR classic `nested-accordion` | classic-in-v4 is UNVERIFIED — emit only behind a per-run capability probe + post-save render check; else degrade to stacked sections (tier 4 with reason) |
| form | Pro atomic `e-form` family (e_pro_atomic_form) | map input types; actions NOT converted (report) |
| carousel | NOT converted in v1 | tier 4 with reason "no atomic carousel"; panels emit as a grid fallback |
| nav-toggle | NOT converted in v1 | header links already convert; toggle reported tier 4 |
| video-embed | `e-youtube` / `e-self-hosted-video` | already partially handled; route through behavior report |

Rule: a Tier-1 conversion REPLACES the static subtree (no duplicate static copy). The pattern's
child content still goes through the normal node conversion (text/style fidelity preserved).

## 4. Tier 2 — native interactions (new stage `convert/behavior-interactions.ts`)

- Input: `entrance-animation` + `hover-effect` behaviors with extractable intent.
- Mapping: opacity-only keyframes → `fade`; translate keyframes → `slide` + direction (dominant
  axis/sign); scale keyframes → `scale`; duration/delay/easing from computed values
  (clamp ≥100ms, default 600ms). Scroll-triggered (IntersectionObserver/AOS classnames) →
  trigger `scrollIn`; else `load`. Hover/click triggers and easings beyond `easeIn` are
  Pro-gated per S08 — gate on `capabilities.pro`.
- Emit EXACTLY the S08 frozen shape (`config-v2`, `size` envelopes, ≤5 per element, omit
  `interaction_id`). Anything non-expressible → tier 3/4 with reason.
- **Post-save assertion:** read back the document; an element whose authored interactions
  came back empty is reported `dropped_by_sanitizer` (downgrades behavior coverage).

## 5. Tier 3 — JS passthrough (opt-in)

- New convert option `include_js: 'none' | 'bundle'` (default `'none'`).
- `'bundle'`: external `<script src>` (same-origin or CDN) + inline scripts are bundled into ONE
  `html` widget appended last (`elType:widget, widgetType:html`), wrapped in an IIFE with a
  `data-emcp-passthrough` marker. Requires site `unfiltered_html` AND elicitation confirm
  (decline → proceed without JS, reported). Analytics/tracking scripts (gtag, gtm, fbq,
  hotjar…) are EXCLUDED by default (denylist) and reported as excluded.
- Never duplicates behaviors already converted at tier 1/2: if a script's only detected effect
  was converted, it is still included verbatim when bundling (scripts are opaque) — the report
  flags potential double-handling for human review.

## 6. Behavior coverage + behavioral fidelity (coverage.ts / fidelity.ts)

- `CoverageReport.behavior = { detected: DetectedBehavior[], tiers: {native, interactions,
  passthrough, dropped}, score }` where `score = (t1 + t2 + 0.5*t3) / detected_total` (t4 = 0).
  Advisory in v1: behavior score is REPORTED but does not block the commit gate (the visual
  coverage gate is unchanged). Flag `behavior_gate: 'advisory'` in the report.
- Behavioral fidelity (post-commit, opt-in like visual fidelity): for each tier-1 tabs
  conversion, Playwright clicks tab N on the converted page and asserts the active panel
  changes (`aria-selected`/visibility). For tier-2: assert the interaction blob exists and the
  element carries `data-interaction-id`. Result shape: `{probes: [{kind, nodeId, pass, detail}]}`.

## 7. Tool surface

No new MCP tools. `convert.html_to_tree` / `convert.html_to_page` gain `include_js` (input)
and `behavior` (output report section). Catalog schema change = additive optional fields.

## 8. Honesty invariants (testable)

1. Every `DetectedBehavior` appears in the report with a tier — count(detected) ==
   count(tiered).
2. No interaction is reported tier-2 unless it survived post-save readback.
3. `include_js:'none'` (default) emits zero script bytes into the page.
4. A tier-1 widget replaces its static subtree — node count audit: no pattern subtree appears
   twice.
5. Behavior detection NEVER degrades visual conversion: a page with zero behaviors converts
   byte-identically to pre-contract-16 output (regression-fixture-guarded).
