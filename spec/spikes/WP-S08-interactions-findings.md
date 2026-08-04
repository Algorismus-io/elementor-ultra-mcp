# Spike S08 — V4 interactions: headless authoring verdict

**Date:** 2026-06-11 · **Verdict: PASS** — interactions authored headless through the companion
REST save fire on the live frontend (verified by per-frame opacity/transform sampling: fade 0→1
ramp + slide transform on page 1661 probe).

## Frozen shape (Elementor 4.1.1, experiment `e_interactions` — hidden, default-active, requires `e_atomic_elements`)

The `interactions` field on ANY atomic element (`Atomic_Element_Base`) — a **JSON-encoded string**
(PHP also accepts the decoded object; the MCP zod schema must accept both):

```jsonc
{
  "version": 1,
  "items": [                                   // MAX 5 per element (Validation throws above 5)
    { "$$type": "interaction-item", "value": {
      // interaction_id: OMIT — Parser auto-assigns "{postId}-{elementId}-{n}" on save
      "trigger":   { "$$type": "string", "value": "load" },   // free: load, scrollIn · Pro: scrollOut, scrollOn, hover, click
      "animation": { "$$type": "animation-preset-props", "value": {
        "effect":    { "$$type": "string", "value": "fade" }, // free: fade, slide, scale · Pro: custom
        "type":      { "$$type": "string", "value": "in" },   // in | out
        "direction": { "$$type": "string", "value": "" },     // left right top bottom top-left … or "" (REQUIRED, may be empty)
        "timing_config": { "$$type": "timing-config", "value": {
          "duration": { "$$type": "size", "value": { "unit": "ms", "size": 800 } },  // NOTE: $$type "size", NOT "time-size"
          "delay":    { "$$type": "size", "value": { "unit": "ms", "size": 0 } }
        } },
        "config": { "$$type": "config-v2", "value": {          // OPTIONAL · NOTE: key is "config-v2", NOT "animation-config"
          "easing": { "$$type": "string", "value": "easeIn" }  // free: easeIn · Pro: easeOut easeInOut backIn backInOut backOut linear
          // Pro-only: replay(bool), relativeTo, repeat(loop|times|""), times(number), start/end (% size) for scroll
        } }
        // Pro-only: custom_effect (keyframes)
      } }
      // optional: "breakpoints": { "$$type": "interaction-breakpoints", "value": { "excluded": …(excluded-breakpoints) } }
    } }
  ]
}
```

## Pipeline mechanics (verified live)

1. **Save:** any `Document::save()` (our writer) → `elementor/document/save/data` filter →
   `Validation::sanitize` → `Parser::assign_interaction_ids` → persists on the element in
   `_elementor_data`; `after_save` → `Interactions_Postmeta` cache.
2. **⚠️ Silent-drop semantics:** `Validation::sanitize` keeps only items passing
   `is_valid_interaction_item`; invalid items are DROPPED with **no error** (an all-invalid set
   stores `[]`). Wrong `$$type` keys (e.g. `animation-config` instead of `config-v2`,
   `time-size` instead of `size`) vanish silently. **Convert/authoring MUST emit exact shapes and
   verify post-save** (read back the element and assert `interactions` non-empty).
3. **Frontend:** renderer adds `data-interaction-id` attrs; centralized JSON in
   `<script id="elementor-interactions-data">` printed at `wp_footer`; runtime = Motion One
   (`lib/motion/motion.js`) + `interactions-shared-utils` + `interactions(-pro).js`.
   Frontend matching is by `elementId` — element ids must be stable (writer id-stability fix matters).
4. **Editor:** config exposed as `window.ElementorInteractionsConfig` (presets + breakpoints).

## Gotchas for the implementation tasks

- The MCP elementNode zod schema typed `interactions` as `array` — the native wire format is a
  JSON **string** (or `{version,items}` object). Schema fixed to accept all three (see shared.ts).
- `canvas` matters for verification: theme templates inject their own `h1` — probe by
  `[data-interaction-id]`, not by tag.
- Validation caps **5 interactions per element**.
- Pro gating is per-enum-value (`meta('pro', …)`), not per-field: free = load/scrollIn + fade/slide/scale + easeIn.
- Probe page: IXSPIKE (1661) — delete after reference.
