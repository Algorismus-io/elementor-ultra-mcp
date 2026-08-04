/**
 * WP-F04 — HTML → native conversion tool schemas (flagship, 13-tool-catalog.md §1.9).
 *
 * Covers: `elementor.convert.html_to_tree`, `elementor.convert.html_to_page`,
 * `elementor.convert.fidelity_check`.
 *
 * The `report` shape is transcribed EXACTLY from 13-tool-catalog.md §1.9 `html_to_tree.outputSchema`
 * (its coverage key names — `native_pct`/`class_pct`/`custom_css_pct`/`dropped_pct` — are the §1.9
 * wire names, distinct from WP-F03's `CoverageReport` type key names; per §0.1 the tool wire shape is
 * authoritative for the catalog). `html_to_page.report` reuses this same shape (§1.9: "same shape as
 * html_to_tree.report"). ZodRawShape maps (§0.1); `html_to_page` carries `confirm` for the commit
 * elicitation gate (§0.3) and LOCKED never-auto-commit semantics.
 */

import { z } from 'zod';

import { diffSchema, elementNodeSchema, globalClassObjectSchema } from './shared.js';

/**
 * Contract 16 §6/§7 — one tiered detected behavior (the §1 frozen IR shape; `tier` is REQUIRED in a
 * report: every detected behavior carries one — §8 invariant 1, "never a silent lie").
 */
const detectedBehaviorSchema = z.object({
  kind: z.enum([
    'tabs',
    'accordion',
    'carousel',
    'nav-toggle',
    'form',
    'entrance-animation',
    'hover-effect',
    'marquee',
    'countdown',
    'video-embed',
    'custom-js',
  ]),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.array(z.string()),
  nodeIds: z.array(z.string()),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  reason: z.string().optional(),
});

/**
 * Contract 16 §6 — the ADVISORY `report.behavior` section (mirrors `diff.schema.json
 * $defs/CoverageReport.behavior`): tier counts sum to `detected.length`;
 * `score = (t1 + t2 + 0.5*t3) / total`; never gates commit (`behavior_gate:'advisory'`).
 */
const behaviorCoverageSchema = z.object({
  detected: z.array(detectedBehaviorSchema),
  tiers: z.object({
    native: z.number().int().min(0),
    interactions: z.number().int().min(0),
    passthrough: z.number().int().min(0),
    dropped: z.number().int().min(0),
  }),
  score: z.number(),
  behavior_gate: z.literal('advisory'),
});

/** One census script as it appears in the Tier-3 report (`PageScript` fields, never the body). */
const passthroughScriptEntrySchema = z.object({
  src: z.string().nullable(),
  inline_bytes: z.number().int().min(0),
  external: z.boolean(),
});

/**
 * Contract 16 §5 — the Tier-3 JS-passthrough partition: `bundled ∪ excluded` covers the FULL script
 * census (nothing silent). Surfaced ONLY when the caller engaged `options.include_js` (additive).
 */
const jsPassthroughReportSchema = z.object({
  mode: z.enum(['none', 'bundle']),
  bundled: z.array(passthroughScriptEntrySchema),
  excluded: z.array(passthroughScriptEntrySchema.extend({ reason: z.string() })),
  bundled_bytes: z.number().int().min(0),
  blocked_reason: z.literal('unfiltered_html_missing').optional(),
  double_handling_review: z.boolean().optional(),
});

/**
 * Contract 16 §4/§8.2 — per-element post-save interaction-survival checks (committed path only).
 * Any non-`survived` row has already downgraded its tier-2 behaviors in the report.
 */
const interactionsPostSaveSchema = z.array(
  z.object({
    element_id: z.string(),
    authored: z.number().int().min(0),
    survived: z.number().int().min(0),
    status: z.enum(['survived', 'partial', 'dropped_by_sanitizer', 'element_missing']),
  }),
);

/** The §1.9 conversion coverage report shape (transcribed from `html_to_tree.outputSchema`). */
export const conversionReportSchema = z.object({
  coverage: z.object({
    native_pct: z.number(),
    class_pct: z.number(),
    custom_css_pct: z.number(),
    dropped_pct: z.number(),
  }),
  fallbacks: z.array(
    z.object({
      node_id: z.string(),
      declaration: z.string(),
      tier: z.string(),
    }),
  ),
  a11y: z.array(
    z.object({
      node_id: z.string(),
      rule: z.string(),
      severity: z.enum(['warn', 'block']),
      message: z.string(),
    }),
  ),
  stripped_text: z.array(
    z.object({
      node_id: z.string(),
      tags: z.array(z.string()),
    }),
  ),
  // Contract 16 §7 — ADDITIVE optional behavior section; OMITTED when zero behaviors were detected
  // (§8 invariant 5: a zero-behavior report stays byte-identical to pre-contract-16 output).
  behavior: behaviorCoverageSchema.optional(),
});

const proposedVariableSchema = z.object({
  type: z.string(),
  label: z.string(),
  value: z.string(),
});

/* ───────────────────────────── contract 17 additive carriers ────────────────────────────── */

/** Contract 17 #9 — one captured font link (`families` attributed from the URL; `[]` = opaque). */
const fontLinkEntrySchema = z.object({
  href: z.string(),
  families: z.array(z.string()),
});

/**
 * Contract 17 #9 — the font-carry partition: `carried ∪ excluded` covers every captured font link
 * (never silent). Present only when the page had font links to judge (zero-font results unchanged).
 */
const fontCarryReportSchema = z.object({
  carried: z.array(fontLinkEntrySchema),
  excluded: z.array(fontLinkEntrySchema.extend({ reason: z.string() })),
  families_used: z.array(z.string()),
  families_uncarried: z.array(z.string()),
});

/**
 * Contract 17 §1 — one SOFT integrity violation (I2 base-default / I4 noise-audit) surfaced on the
 * result. I1/I3 violations never reach the wire: they hard-fail the conversion (an isError result).
 * `passthrough` keeps the per-invariant discriminated fields (nodeId/prop/source_value/…).
 */
const integrityViolationSchema = z
  .object({
    invariant: z.enum(['I1', 'I2', 'I3', 'I4']),
    detail: z.string(),
  })
  .passthrough();

/**
 * Contract 18 §7 detection honesty — one report-level note for a behavior class per-node detection
 * cannot express (today: rAF-driven text mutation / count-ups), with script-census evidence rows
 * and best-effort suspect node paths. Silence is the only forbidden outcome.
 */
const undetectableClassNoteSchema = z.object({
  class: z.string(),
  evidence: z.array(z.string()),
  nodeIds: z.array(z.string()),
});

/** Contract 17 §2 V1 — one element-matched render divergence (the frozen row shape + breakpoint). */
const divergenceSchema = z.object({
  element: z.string(),
  source_path: z.string(),
  prop: z.string(),
  source_value: z.string(),
  converted_value: z.string(),
  cause: z.enum([
    'dangling_ref',
    'base_default',
    'dropped_declaration',
    'font_not_carried',
    'custom_css_unrendered',
    'pseudo_unrepresentable',
    'unknown',
  ]),
  breakpoint: z.string(),
});

/** Contract 17 §3 R1 — one mechanical repair patch (applied via the normal save path, or skipped). */
const repairPatchSchema = z.object({
  nodeId: z.string(),
  prop: z.string(),
  value: z.string(),
  cause: z.enum(['dangling_ref', 'base_default', 'missing_overflow_x']),
});

/**
 * Contract 17 §2–3 — the post-save verification carrier (`html_to_page`, status `committed` only):
 * V1 divergences, V3 pixel scores, the R1 repair record, and the R3 gate verdict (incl. the
 * `reverted_to_draft` action — a bad conversion never silently publishes — and the LOUD
 * `revert_failed` action when the fail-closed status write itself failed after a retry).
 */
const verificationSchema = z.object({
  divergences: z.array(divergenceSchema),
  pixel_scores: z.array(
    z.object({
      breakpoint: z.string(),
      ratio: z.number(),
      error: z.string().optional(),
    }),
  ),
  // Contract 18 §7 P1-d/P1-e — the HARDENED-loop carriers (ADDITIVE optional so pre-17.1 results
  // stay valid): the content-presence audit (P1-a guard), rendered-element-count deltas,
  // behavioral probes for the authored interactions (P1-c ramp guard), and the V1 cause-attribution
  // summary (≥0.8 attributed target — report-only).
  content_audit: z
    .object({
      breakpoint: z.string(),
      total: z.number().int().min(0),
      present: z.number().int().min(0),
      dropped: z.number().int().min(0),
      missing: z.array(z.object({ source_path: z.string(), text: z.string() })),
      pass: z.boolean(),
    })
    .optional(),
  element_counts: z
    .array(
      z.object({
        breakpoint: z.string(),
        source_count: z.number().int().min(0),
        converted_count: z.number().int().min(0),
        delta: z.number().int(),
      }),
    )
    .optional(),
  behavior_probes: z
    .array(
      z.object({
        kind: z.string(),
        nodeId: z.string(),
        pass: z.boolean(),
        detail: z.string(),
      }),
    )
    .optional(),
  cause_stats: z
    .object({
      total: z.number().int().min(0),
      attributed: z.number().int().min(0),
      unknown: z.number().int().min(0),
      attributed_ratio: z.number(),
    })
    .optional(),
  repairs: z.object({
    applied: z.array(repairPatchSchema),
    skipped: z.array(repairPatchSchema),
    rounds: z.number().int().min(0),
  }),
  gate: z.object({
    pass: z.boolean(),
    v2_pass: z.boolean(),
    divergence_count: z.number().int().min(0),
    threshold: z.number(),
    action: z.enum(['none', 'reverted_to_draft', 'revert_failed']),
    reasons: z.array(z.string()),
  }),
});

/**
 * The shared `convert.*` options bag (§1.9) — one schema for BOTH `html_to_tree` and `html_to_page`
 * (pipeline `HtmlToPageArgs.options` is "the same options bag as html_to_tree"). The SDK validates
 * args against this shape and Zod STRIPS unknown keys, so every pipeline-consumed option MUST be
 * declared here or MCP-wire callers silently lose it. `base_url` resolves relative URLs + external
 * stylesheet hrefs during PARSE/NORMALIZE (without it, `<link rel=stylesheet>` →
 * `EXTERNAL_CSS_UNRESOLVED` and relative media cannot sideload).
 */
const convertOptionsSchema = z
  .object({
    hoist_classes: z.boolean().default(true),
    extract_variables: z.boolean().default(true),
    fidelity: z.enum(['high', 'balanced', 'fast']).default('balanced'),
    sideload_media: z.boolean().default(true),
    // Opt-in: preserve the source DOM's class names on converted elements (sanitized; `e-`/`g-`/
    // `elementor*` prefixes skipped) so enhancement CSS/JS keys off stable semantic anchors
    // (`.rk-band`, `.hh-hero`) that survive re-converts — the drift-resync pipeline's contract.
    preserve_source_classes: z.boolean().default(false),
    base_url: z.string().optional(),
    // Contract 16 §5/§7 — Tier-3 JS passthrough opt-in (ADDITIVE; the pipeline defaults the absent
    // key to 'none', §8.3: the default emits ZERO script bytes). Deliberately NO zod default: an
    // ABSENT key is the pre-contract-16 surface (no js_passthrough report), an explicit 'none' or
    // 'bundle' engages the §5 census/partition report. 'bundle' additionally requires site
    // `unfiltered_html` AND an elicitation confirm (decline → proceeds without JS, reported).
    include_js: z.enum(['none', 'bundle']).optional(),
    // WP-H14b — first-party inline-CSS carry opt-in. 'inline' appends ONE html widget carrying the
    // FILTERED subset of the source's inline <style> blocks (@keyframes + animation bindings +
    // id-selector rules) — never a wholesale stylesheet carry. No zod default: an ABSENT key is the
    // pre-H14b surface (no css_carry report); an explicit value engages the carried∪excluded report.
    include_css: z.enum(['none', 'inline']).optional(),
    // Contract 17 #9 — webfont carry (ADDITIVE; the pipeline defaults the absent key to TRUE): the
    // captured font stylesheet links whose families the converted styles actually use are re-emitted
    // in ONE html widget prepended to the tree, reported under the additive `fonts` output field.
    // `false` skips the stage entirely (no widget, no report).
    carry_fonts: z.boolean().optional(),
  })
  .optional();

/* ───────────────────────────── elementor.convert.html_to_tree ───────────────────────────── */

export const convertHtmlToTreeInput = {
  html: z.string(),
  css: z.string().optional(),
  generation: z.enum(['v4', 'v3']).default('v4'),
  options: convertOptionsSchema,
} as const;

export const convertHtmlToTreeOutput = {
  elements: z.array(elementNodeSchema),
  proposed_classes: z.array(globalClassObjectSchema),
  proposed_variables: z.array(proposedVariableSchema),
  report: conversionReportSchema,
  // Contract 16 additive optional carriers (§7): the Tier-3 script partition (present only when
  // `options.include_js` was engaged) and behavior-stage honesty notes (present only when non-empty).
  js_passthrough: jsPassthroughReportSchema.optional(),
  warnings: z.array(z.string()).optional(),
  // Contract 17 additive optional carriers: the #9 font-carry partition (present only when the page
  // had font links) and the §1 SOFT integrity violations (I2/I4; I1/I3 hard-fail — never on a
  // success result). Both omitted when clean, so pre-contract-17 results stay byte-identical.
  fonts: fontCarryReportSchema.optional(),
  integrity: z.array(integrityViolationSchema).optional(),
  // Contract 18 §7 detection-honesty extension (16 residual): behavior classes per-node detection
  // cannot see (rAF count-ups) appear as report-level notes with script-census evidence. ADDITIVE
  // optional: omitted when the census found no evidence.
  undetectable_classes: z.array(undetectableClassNoteSchema).optional(),
} as const;

/* ───────────────────────────── elementor.convert.html_to_page ───────────────────────────── */

export const convertHtmlToPageInput = {
  html: z.string(),
  css: z.string().optional(),
  post_id: z.number().int().optional(),
  title: z.string().optional(),
  // Publish state for a NEWLY created page (ignored when replacing an existing `post_id`). Defaults
  // to `draft` (safe — a converted page is reviewed before it goes live); pass `publish` to make the
  // committed page immediately viewable at its public URL.
  status: z.enum(['draft', 'publish', 'pending', 'private']).optional(),
  generation: z.enum(['v4', 'v3']).default('v4'),
  commit: z.boolean().default(false),
  confirm: z.boolean().default(false),
  coverage_gate: z.number().min(0).max(1).optional(),
  // Contract 17 §3 R3 — the post-save verify-loop divergence threshold (pipeline default 25): when
  // the final loop pass still fails V2 or counts more divergences than this, the committed page is
  // reverted to draft (reported under `verification.gate`).
  verify_gate: z.number().int().min(0).optional(),
  // WP page template for the committed page. A full-document source carries its own page chrome,
  // so a NEW page defaults to the blank `elementor_canvas` (the theme's content column otherwise
  // repaints the layout AND fails the §2 verify loop); pass `default` to keep the theme template.
  // An EXISTING `post_id`'s template is the operator's choice — only touched when set explicitly.
  page_template: z.enum(['elementor_canvas', 'elementor_header_footer', 'default']).optional(),
  // Same options bag as `html_to_tree` — threaded by the handler into the shared stage run
  // (incl. `base_url`; see `convertOptionsSchema`).
  options: convertOptionsSchema,
} as const;

export const convertHtmlToPageOutput = {
  id: z.number().int().optional(),
  diff: diffSchema,
  preview_url: z.string(),
  report: z.unknown(),
  committed: z.boolean(),
  css_primed: z.boolean(),
  // Contract 16 additive optional carriers (§7): the Tier-3 script partition (§5), behavior-stage
  // honesty notes, and the §8.2 post-save interaction-survival checks (committed path only — any
  // non-`survived` row has already downgraded its tier-2 behaviors in `report.behavior`).
  js_passthrough: jsPassthroughReportSchema.optional(),
  warnings: z.array(z.string()).optional(),
  interactions_post_save: interactionsPostSaveSchema.optional(),
  // Contract 17 additive optional carriers: #9 font carry, §1 soft integrity violations, and the
  // §2–3 post-save verification (committed path only; absent = the loop could not run, reported
  // via `warnings` — never a silent skip).
  fonts: fontCarryReportSchema.optional(),
  integrity: z.array(integrityViolationSchema).optional(),
  verification: verificationSchema.optional(),
  // Contract 18 §7 detection honesty (same carrier as `html_to_tree`).
  undetectable_classes: z.array(undetectableClassNoteSchema).optional(),
} as const;

/* ───────────────────────────── elementor.convert.fidelity_check ─────────────────────────── */

export const convertFidelityCheckInput = {
  post_id: z.number().int(),
  source_html: z.string(),
  // Optional source CSS injected into the SOURCE render when it is not inlined in `source_html`
  // (the handler / `runFidelityCheck` reads it as `args.css` → `fidelityCheck.source_css`, §1.9
  // "Playwright screenshot vs. rendered preview URL"). The §1.9 OUTPUT shape is unchanged (frozen).
  css: z.string().optional(),
  breakpoints: z.array(z.string()).optional(),
} as const;

export const convertFidelityCheckOutput = {
  score: z.number(),
  deltas: z.array(
    z.object({
      breakpoint: z.string(),
      diff_ratio: z.number(),
      region: z.string().nullable(),
    }),
  ),
} as const;

/* ───────────────────── contract 18 §6 — Figma front-end (figma_to_tree / figma_to_page) ─────── */

/**
 * Contract 18 §3/§6 — the `convert.figma_to_*` options bag. Deliberately NOT the HTML
 * `convertOptionsSchema`: `include_js` is N/A for Figma input (§6 — a design file carries no page
 * scripts) so the key does not exist here, and the §3 NORMATIVE `flatten` policy knob is added
 * (complex visuals render as ONE Figma PNG placed as one e-image; the boundary is tunable).
 */
const figmaConvertOptionsSchema = z
  .object({
    /** §3 flatten policy — the native/flatten boundary (default `balanced`). */
    flatten: z.enum(['aggressive', 'balanced', 'minimal']).default('balanced'),
    hoist_classes: z.boolean().default(true),
    extract_variables: z.boolean().default(true),
    sideload_media: z.boolean().default(true),
    /** Contract 17 #9 carry — for Figma input the carry covers NON-catalog faces only (§7 fonts). */
    carry_fonts: z.boolean().optional(),
    /**
     * The §7 fetch-to-file work dir holding `manifest.json` + the extraction artifacts. Default:
     * a deterministic per-frame dir under the OS tmpdir. Re-running with the same dir RESUMES from
     * the manifest (zero upstream re-fetches); point it at a fresh dir to force a re-fetch.
     */
    work_dir: z.string().optional(),
    /** Render scale for the frame-render ground truth PNG (F4; default 1 = frame-exact pixels). */
    render_scale: z.number().min(0.5).max(4).optional(),
  })
  .optional();

/** §6 — one §3 flatten decision (`flattened[] {nodeId, reason}` — recorded, never silent). */
const figmaFlattenEntrySchema = z.object({
  nodeId: z.string(),
  reason: z.string(),
});

/** §2 — one mined design token (variables/styles); tolerant `.passthrough()` for per-mode extras. */
const figmaTokenSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    value: z.string(),
  })
  .passthrough();

/**
 * Contract 18 §6 — the `figma:{frame, tokens, flattened, responsive}` report extension riding next
 * to the contract-17 report envelope. `responsive` is a free string by design (`'frames'` when
 * sibling breakpoint frames were diffed, `'synthesized'` for the §5 heuristic adaptation, plus
 * honest future modes) — the wire stays tolerant so a new mode is never a -32602. The additive
 * `text_presence` block is the F5 invariant record (every source TEXT node's characters present in
 * the converted output or accounted as dropped+reason).
 */
const figmaReportSchema = z.object({
  frame: z.object({
    file_key: z.string(),
    node_id: z.string(),
    name: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  tokens: z.array(figmaTokenSchema),
  flattened: z.array(figmaFlattenEntrySchema),
  responsive: z.string(),
  /** Per-family availability for every family the frame's text uses (§5/§7 font strategy). */
  fonts: z.record(z.enum(['google', 'local', 'missing'])).optional(),
  /** F1 honest drops (`node_id` + reason — never silent). */
  dropped: z.array(z.object({ node_id: z.string(), reason: z.string() })).optional(),
  /** §2 prototype interactions the front-end could not map (honest drops). */
  interaction_drops: z
    .array(
      z.object({
        node_id: z.string(),
        trigger: z.string(),
        action: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  /** The matched §5 breakpoint variant frames (`responsive:'frames'` only). */
  responsive_frames: z.record(z.string()).optional(),
  /** F5 — the source-TEXT presence audit over the converted tree (additive optional). */
  text_presence: z
    .object({
      total: z.number().int().min(0),
      present: z.number().int().min(0),
      dropped: z.number().int().min(0),
      missing: z.array(z.object({ node_id: z.string(), text: z.string() })),
      pass: z.boolean(),
    })
    .optional(),
  /** The §7 fetch-to-file work dir (manifest + artifacts) this conversion used. */
  work_dir: z.string().optional(),
  /** True when the extraction RESUMED from an existing manifest (zero upstream fetches). */
  resumed: z.boolean().optional(),
});

/* ───────────────────────────── elementor.convert.figma_to_tree ──────────────────────────── */

export const convertFigmaToTreeInput = {
  /** A figma.com/design (or legacy /file) URL — `node-id` query param accepted in hyphen form. */
  figma_url: z.string().optional(),
  /** Explicit file key (alternative to `figma_url`). */
  file_key: z.string().optional(),
  /** Explicit node id (`400:7508`; the hyphen form is normalized). REQUIRED with `file_key`. */
  node_id: z.string().optional(),
  generation: z.enum(['v4', 'v3']).default('v4'),
  options: figmaConvertOptionsSchema,
} as const;

export const convertFigmaToTreeOutput = {
  // The §6 invariant: same envelope as the HTML path (everything downstream of the IR seam is the
  // SAME pipeline) + the figma report extension.
  ...convertHtmlToTreeOutput,
  figma: figmaReportSchema,
} as const;

/* ───────────────────────────── elementor.convert.figma_to_page ──────────────────────────── */

export const convertFigmaToPageInput = {
  figma_url: z.string().optional(),
  file_key: z.string().optional(),
  node_id: z.string().optional(),
  /** Replace an EXISTING page's tree instead of creating a new page (the R2 iterate-in-place path). */
  post_id: z.number().int().optional(),
  title: z.string().optional(),
  /** Publish state for a NEWLY created page (R3 draft-gate: defaults to `draft`). */
  status: z.enum(['draft', 'publish', 'pending', 'private']).optional(),
  generation: z.enum(['v4', 'v3']).default('v4'),
  commit: z.boolean().default(false),
  confirm: z.boolean().default(false),
  coverage_gate: z.number().min(0).max(1).optional(),
  /** Contract 17 §3 R3 — the post-save verify-loop divergence threshold (pipeline default 25). */
  verify_gate: z.number().int().min(0).optional(),
  /** A Figma frame is a full-bleed design — a NEW page defaults to `elementor_canvas` (§6/17 §3). */
  page_template: z.enum(['elementor_canvas', 'elementor_header_footer', 'default']).optional(),
  options: figmaConvertOptionsSchema,
} as const;

export const convertFigmaToPageOutput = {
  // Same §6 envelope rule as `figma_to_tree`: the HTML `html_to_page` output + the figma extension.
  // `figma` is OPTIONAL here: decline/invalid results are built before/without a full figma block.
  ...convertHtmlToPageOutput,
  figma: figmaReportSchema.optional(),
} as const;
