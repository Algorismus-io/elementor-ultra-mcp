/**
 * WP-H10 — COVERAGE report assembly + COMMIT GATE.
 *
 * The honest-reporting + gating stage. This module folds the per-stage fallback / stripped / a11y
 * records the convert pipeline emits into the single FROZEN `CoverageReport`
 * (`diff.schema.json#/$defs/CoverageReport`, mirrored by `convert/types.ts`), computes the four
 * coverage percentages from the deterministic per-DECLARATION classification (WP-H07) merged with the
 * per-NODE whole-node ladder (WP-H06), and evaluates the LOCKED commit gate (RESEARCH.md §6.8).
 *
 * Two HARD rules from the spec / spikes drive this module:
 *   - The coverage percentages are computed from a DETERMINISTIC declaration count (the WP-H07
 *     `DeclFallback` tiers), NEVER from the noisy pixel score — so the corpus regression is
 *     reproducible (WP-H10 Implementation-Notes; `15-engineering-standards.md §4.6`).
 *   - The default `coverage_gate` is the S3-anchored value read from `corpus.manifest.json`
 *     (`default_coverage_gate`, currently 0.6), NEVER a hardcoded 85% (S03; `15-eng-standards §4.6/§6`).
 *
 * `buildCoverageReport` is PURE (no I/O); the gate logic is kept SEPARATE (`evaluateGate`) so the
 * orchestrator (WP-H11) can always PRESENT the report even when the gate refuses commit — declining is
 * a clean non-error result (`12-error-taxonomy.md §5.5`), not a thrown error.
 */

import { NOISE_FILTER_SOURCE_PATH } from './style-extract.js';
import type {
  A11yFinding,
  BehaviorCoverage,
  CoverageReport,
  DeclFallback,
  DetectedBehavior,
  NodeFallback,
  StrippedRecord,
  StyledNode,
} from './types.js';

/* ─────────────────────────── native-declaration counting ─────────────────────────────────────── */

/**
 * Count the natively-mapped declarations across a STYLE-EXTRACT styled-node forest: every typed prop in
 * every local-style variant of every node (recursively). STYLE-EXTRACT places each native declaration as
 * a typed prop in a `StyledNode.local_styles[].variants[].props` map (and records ONLY the NON-native
 * declarations in `declaration_fallbacks`), so this prop count IS the native declaration count the
 * coverage math needs (`CoverageInput.native_count`). The orchestrator (WP-H11) passes the result in.
 */
export function countNativeProps(styledNodes: StyledNode[]): number {
  let count = 0;
  // Children on the styled forest carry `local_styles` too (STYLE-EXTRACT styles every node), but are
  // typed as the broader `MappedNode` on the IR seam — read the field defensively.
  const walk = (node: {
    local_styles?: StyledNode['local_styles'];
    children?: unknown[];
  }): void => {
    for (const def of node.local_styles ?? []) {
      for (const variant of def.variants) {
        count += Object.keys(variant.props).length;
      }
    }
    for (const child of node.children ?? []) {
      walk(child as { local_styles?: StyledNode['local_styles']; children?: unknown[] });
    }
  };
  for (const node of styledNodes) {
    walk(node);
  }
  return count;
}

/* ─────────────────────────── coverage-bucket vocabulary ──────────────────────────────────────── */

/**
 * The four coverage buckets of `CoverageReport.coverage` (`diff.schema.json`). A single declaration's
 * fallback `tier` (WP-H07 `DeclFallback['tier']`) maps to exactly one bucket:
 *   - `native`                      → NATIVE
 *   - `local_style` / `global_class`→ CLASS (placement, NOT a fidelity loss — S03 §3/§5)
 *   - `custom_css`                  → CUSTOM_CSS (mapped, but as raw custom CSS)
 *   - `html_widget`                 → DROPPED (the whole node degraded to a raw html widget — the
 *                                     declaration is not natively represented)
 *
 * NOTE on `pct_local_or_global_class` vs `pct_native`: every native declaration is PLACED into a local
 * or global class, so per the S3 fixtures `pct_local_or_global_class == pct_native` (the local/global
 * split is a placement decision, not a coverage loss). We surface BOTH percentages from the SAME native
 * declaration count to match the frozen fixtures (`expected.coverage.json`); class placement does not
 * subtract from native.
 */
type CoverageBucket = 'native' | 'class' | 'custom_css' | 'dropped';

/** Map a per-declaration ladder tier to its coverage bucket. */
function bucketForDeclTier(tier: DeclFallback['tier']): CoverageBucket {
  switch (tier) {
    case 'native':
      return 'native';
    case 'local_style':
    case 'global_class':
      return 'class';
    case 'custom_css':
      return 'custom_css';
    case 'html_widget':
      return 'dropped';
    default: {
      // exhaustiveness guard — a new DeclFallback tier must be assigned a bucket here.
      const never: never = tier;
      throw new Error(`unhandled DeclFallback tier: ${String(never)}`);
    }
  }
}

/* ─────────────────────────── source_path → element_id resolution ─────────────────────────────── */

/**
 * The upstream per-stage records (`DeclFallback`/`NodeFallback`/`StrippedRecord`) all key on
 * `source_path` (the pre-assembly path), while `CoverageReport` keys on the MINTED `element_id`
 * (`convert/types.ts` note). The orchestrator (WP-H11) knows the `source_path → element_id` map after
 * ASSEMBLE and supplies it via `id_map`. When it is absent (pure unit tests / pre-assembly preview),
 * we fall back to a SANITIZED passthrough so the id still satisfies the `ElementId` charset
 * (`element-node.schema.json` pattern `^[A-Za-z0-9_-]+$`) and the corpus suite — which matches a11y /
 * stripped findings by LOCATOR, not by minted id (`14-fixtures-harness §7`) — still resolves.
 */
export type SourcePathIdMap = Record<string, string>;

/** Sanitize a `source_path` into a charset-valid `ElementId` for the passthrough fallback. */
function sanitizeToElementId(sourcePath: string): string {
  const cleaned = sourcePath.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'src' : cleaned;
}

/** Resolve a `source_path` to its minted `element_id` (or the sanitized passthrough fallback). */
function resolveElementId(sourcePath: string, idMap?: SourcePathIdMap): string {
  const mapped = idMap?.[sourcePath];
  if (mapped !== undefined && mapped !== '') return mapped;
  return sanitizeToElementId(sourcePath);
}

/* ─────────────────────────── buildCoverageReport ─────────────────────────────────────────────── */

/**
 * The aggregate input to `buildCoverageReport`. Mirrors the per-stage record streams the convert
 * pipeline produces:
 *   - `native_count`          (WP-H07 STYLE-EXTRACT) — the number of declarations that mapped to a
 *      NATIVE atomic prop (placed as a typed prop in a `StyledNode.local_styles` variant). STYLE-EXTRACT
 *      records ONLY the NON-native declarations in `declaration_fallbacks` (a "fallback" record is by
 *      definition not native); the native count is the total typed props the styled nodes carry. The
 *      orchestrator (WP-H11) computes it as `sum(styled_nodes[].local_styles[].variants[].props length)`.
 *      Helper: `countNativeProps(styled_nodes)`.
 *   - `declaration_fallbacks` (WP-H07 STYLE-EXTRACT) — the per-declaration NON-native ladder records
 *      (`local_style`/`global_class`/`custom_css`/`html_widget`). Class-tier records are native props
 *      that were merely PLACED in a class — they still count toward the native/covered fraction.
 *   - `node_fallbacks`        (WP-H06 MAP) — whole-node ladder; an `html_widget` node's declarations are
 *      counted as DROPPED even when STYLE-EXTRACT saw them, because the node is not natively represented.
 *   - `stripped`              (WP-H04 NORMALIZE) — html-v3 inline-allowlist strips → `stripped_text[]`.
 *   - `a11y`                  (this WP) — the lint findings (already keyed by minted `element_id`).
 *   - `visual_diff_score`     (this WP, optional) — the pixelmatch score from `fidelityCheck`.
 *   - `id_map`                (WP-H11, optional) — `source_path → element_id` for record folding.
 */
export interface CoverageInput {
  native_count: number;
  declaration_fallbacks: DeclFallback[];
  node_fallbacks?: NodeFallback[];
  stripped?: StrippedRecord[];
  a11y?: A11yFinding[];
  visual_diff_score?: number;
  id_map?: SourcePathIdMap;
  /**
   * Contract 16 §6 — the TIERED detected behaviors (CLASSIFY detected them; MAPPING assigned every
   * one a tier 1-4). Folded into `CoverageReport.behavior` via `buildBehaviorCoverage` (which HARD
   * ERRORS on any untiered behavior — §8 invariant 1). Omitted/empty → NO behavior section, so a
   * zero-behavior report stays byte-identical to pre-contract-16 output (§8 invariant 5).
   */
  behaviors?: DetectedBehavior[];
  /**
   * Contract 18 §7 M-g — whether the target site's Pro LICENSE includes the atomic custom-css
   * feature (`Capabilities.custom_css_licensed`, defaulted to `pro` by the orchestrator when the
   * plugin predates the flag). When `false`, every `custom_css`-tier declaration is counted as
   * DROPPED (portability only: the raw CSS would not render on that site), so the coverage
   * percentages and the commit gate stop over-reporting. Omitted/`true` → unchanged math.
   */
  custom_css_licensed?: boolean;
}

/** Round a percentage to one decimal place (matches the S3 fixture precision). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Build the FROZEN `CoverageReport` from the per-stage records.
 *
 * Coverage math (`diff.schema.json`, WP-H10 §1): tally declarations by bucket across ALL nodes.
 *   - A declaration on a node that MAP degraded to the whole-node `html_widget` tier counts as DROPPED
 *     regardless of its per-declaration tier (the node is not natively represented).
 *   - `pct_native`  = native / total
 *   - `pct_local_or_global_class` = native / total (every native decl is placed in a local/global class;
 *     placement is not a coverage loss — see `CoverageBucket` doc + the S3 fixtures).
 *   - `pct_custom_css` = custom_css / total
 *   - `pct_dropped` = dropped / total
 * The four reported percentages (native + custom_css + dropped) sum to ~100 (allowing rounding); the
 * class percentage is the placement view of the native fraction and is reported alongside.
 */
export function buildCoverageReport(input: CoverageInput): CoverageReport {
  const idMap = input.id_map;

  // Source paths whose whole node landed on the `html_widget` last-resort tier (WP-H06). Their
  // declarations are forced to the DROPPED bucket — the node carries raw html, not native props.
  const htmlWidgetNodes = new Set<string>();
  for (const nf of input.node_fallbacks ?? []) {
    if (nf.tier === 'html_widget') {
      htmlWidgetNodes.add(nf.source_path);
    }
  }

  // Per-declaration tally → buckets (the DETERMINISTIC coverage basis). STYLE-EXTRACT records ONLY the
  // NON-native declarations here; the natively-mapped declarations are counted via `native_count`
  // (the typed props placed in the styled nodes — see `CoverageInput.native_count`).
  const counts: Record<CoverageBucket, number> = {
    native: Math.max(0, input.native_count),
    class: 0,
    custom_css: 0,
    dropped: 0,
  };
  // M-g (contract 18 §7): custom_css coverage is LICENSE-gated — on a site whose Pro license lacks
  // the atomic custom-css feature, a custom_css-tier declaration would not render, so it counts as
  // DROPPED rather than covered. Default (absent flag) keeps the historical math.
  const customCssCovered = input.custom_css_licensed !== false;
  for (const decl of input.declaration_fallbacks) {
    // Contract 17 I4 — the noise-filter SUMMARY record (computed-default no-ops excluded by
    // STYLE-EXTRACT) is kept OUT of the tier tally entirely: noise is neither covered nor lost,
    // and counting it anywhere would re-inflate the percentages I4 exists to clean. It still
    // surfaces in the fallbacks rollup below (the count is reported, never silent).
    if (decl.source_path === NOISE_FILTER_SOURCE_PATH) {
      continue;
    }
    let bucket = htmlWidgetNodes.has(decl.source_path) ? 'dropped' : bucketForDeclTier(decl.tier);
    if (bucket === 'custom_css' && !customCssCovered) {
      bucket = 'dropped';
    }
    counts[bucket] += 1;
  }

  // The NATIVE/covered fraction includes both natively-mapped props AND class-placed declarations (a
  // class placement is the placement view of a native declaration, not a coverage loss — S03 §3/§5,
  // and the S3 fixtures set `pct_local_or_global_class == pct_native`). So the native count subsumes the
  // class bucket for the percentage view.
  const nativeAndClass = counts.native + counts.class;
  const total = nativeAndClass + counts.custom_css + counts.dropped;

  // Empty input → all-zero coverage (a degenerate but valid report).
  const pctNative = total === 0 ? 0 : (nativeAndClass / total) * 100;
  const pctCustomCss = total === 0 ? 0 : (counts.custom_css / total) * 100;
  const pctDropped = total === 0 ? 0 : (counts.dropped / total) * 100;

  // Per-node fallback rollup (the `CoverageReport.fallbacks[]` — keyed by element_id, ladder tier).
  // We surface the per-DECLARATION fallbacks (which carry the §9 ladder tier the declaration landed on)
  // for non-native declarations, since those are the actionable fallback records (custom_css / dropped /
  // class placements). Per-node `html_widget` degradations are folded in via the dropped declarations.
  const fallbacks: CoverageReport['fallbacks'] = [];
  for (const decl of input.declaration_fallbacks) {
    // The I4 noise-filter summary IS surfaced (tier `native` = zero loss; the reason carries the
    // filtered count) even though native-tier records are otherwise not fallbacks.
    if (decl.source_path === NOISE_FILTER_SOURCE_PATH) {
      fallbacks.push({
        element_id: resolveElementId(decl.source_path, idMap),
        tier: decl.tier,
        reason: decl.reason,
      });
      continue;
    }
    if (decl.tier === 'native') continue; // native declarations are not "fallbacks"
    fallbacks.push({
      element_id: resolveElementId(decl.source_path, idMap),
      tier: htmlWidgetNodes.has(decl.source_path) ? 'html_widget' : decl.tier,
      reason: decl.reason,
    });
  }
  // Whole-node ladder records that have NO per-declaration row (e.g. a structurally-empty node mapped to
  // a classic fallback) still deserve a fallback entry so the report is honest about every degradation.
  const declaredPaths = new Set(input.declaration_fallbacks.map((d) => d.source_path));
  for (const nf of input.node_fallbacks ?? []) {
    if (nf.tier === 'native') continue;
    if (declaredPaths.has(nf.source_path)) continue; // already covered by its declaration rows
    fallbacks.push({
      element_id: resolveElementId(nf.source_path, idMap),
      tier: nodeFallbackToDeclTier(nf.tier),
      reason: nf.reason,
    });
  }

  // Stripped-text rollup (WP-H04 → `CoverageReport.stripped_text[]`, per element id).
  const strippedText: CoverageReport['stripped_text'] = (input.stripped ?? [])
    .filter((s) => s.stripped_tags.length > 0)
    .map((s) => ({
      element_id: resolveElementId(s.source_path, idMap),
      stripped_tags: [...s.stripped_tags],
    }));

  const report: CoverageReport = {
    coverage: {
      pct_native: round1(pctNative),
      pct_local_or_global_class: round1(pctNative),
      pct_custom_css: round1(pctCustomCss),
      pct_dropped: round1(pctDropped),
    },
    fallbacks,
    a11y: [...(input.a11y ?? [])],
    stripped_text: strippedText,
  };

  if (input.visual_diff_score !== undefined) {
    report.visual_diff_score = input.visual_diff_score;
  }

  // Behavior coverage (contract 16 §6) — ADVISORY section, attached ONLY when behaviors were
  // detected (zero behaviors → byte-identical pre-contract-16 report, §8 invariant 5).
  if (input.behaviors !== undefined && input.behaviors.length > 0) {
    report.behavior = buildBehaviorCoverage(input.behaviors);
  }

  return report;
}

/* ─────────────────────────── behavior coverage (contract 16 §6 — ADVISORY) ───────────────────── */

/** Round a behavior score to three decimal places (deterministic report bytes, no float noise). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Fold the TIERED `DetectedBehavior[]` into the `CoverageReport.behavior` section (contract 16 §6).
 *
 *   - `tiers` are per-tier COUNTS: 1 → `native` (behavior widget), 2 → `interactions` (native
 *     interaction), 3 → `passthrough` (opt-in JS bundle), 4 → `dropped` (honest drop).
 *   - `score = (t1 + t2 + 0.5*t3) / detected_total` — tier 4 contributes 0. ADVISORY in v1: the
 *     score is reported, the VISUAL commit gate (`evaluateGate`) is UNCHANGED and never reads it,
 *     hence the literal `behavior_gate:'advisory'`.
 *   - **§8 invariant 1 (hard error):** every detected behavior MUST carry a tier —
 *     `count(detected) == count(tiered)`. An untiered behavior here means a pipeline stage silently
 *     skipped tier assignment (a silent drop, which §0.2 makes a BUG), so the report assembler
 *     refuses to fabricate a section around it.
 *
 * Pure (no I/O). The degenerate empty input returns a zeroed section with `score: 1` (nothing was
 * detected, nothing was lost) — but `buildCoverageReport` omits the section entirely for empty
 * input (§8 invariant 5), so the degenerate shape only surfaces on direct calls.
 */
export function buildBehaviorCoverage(detected: DetectedBehavior[]): BehaviorCoverage {
  const tiers = { native: 0, interactions: 0, passthrough: 0, dropped: 0 };

  for (const behavior of detected) {
    switch (behavior.tier) {
      case 1:
        tiers.native += 1;
        break;
      case 2:
        tiers.interactions += 1;
        break;
      case 3:
        tiers.passthrough += 1;
        break;
      case 4:
        tiers.dropped += 1;
        break;
      default:
        // §8 invariant 1 — count(detected) MUST equal count(tiered). HARD error, not a warning:
        // an untiered behavior is a silent drop in the making (§0.2 "never a silent lie").
        throw new Error(
          `behavior coverage invariant 1 violated: detected '${behavior.kind}' behavior ` +
            `(nodes: ${behavior.nodeIds.join(', ') || '<none>'}) has no tier assigned — ` +
            'every detected behavior must be tiered (1-4) before the report is assembled.',
        );
    }
  }

  const total = detected.length;
  const weighted = tiers.native + tiers.interactions + 0.5 * tiers.passthrough;
  return {
    detected: detected.map((b) => ({ ...b })),
    tiers,
    score: total === 0 ? 1 : round3(weighted / total),
    behavior_gate: 'advisory',
  };
}

/**
 * Map a whole-node ladder tier (WP-H06 `NodeFallback['tier']`) to the `CoverageReport.fallbacks[].tier`
 * enum (`diff.schema.json`: native | local_style | global_class | custom_css | html_widget). A node that
 * fell to the classic V3 fallback or a generic structural block is reported as a `custom_css`-tier
 * fallback (its styles are carried as custom CSS, not native typed props); the html-widget last resort
 * maps directly.
 */
function nodeFallbackToDeclTier(
  tier: NodeFallback['tier'],
): CoverageReport['fallbacks'][number]['tier'] {
  switch (tier) {
    case 'native':
      return 'native';
    case 'html_widget':
      return 'html_widget';
    case 'v3_classic':
    case 'structural_block':
      return 'custom_css';
    default: {
      const never: never = tier;
      throw new Error(`unhandled NodeFallback tier: ${String(never)}`);
    }
  }
}

/* ─────────────────────────── COMMIT GATE (LOCKED, RESEARCH.md §6.8) ──────────────────────────── */

/** Gate configuration. `coverage_gate` is a FRACTION (0..1) matching the tool's `coverage_gate` arg. */
export interface GateConfig {
  /** Minimum covered fraction (native + class + custom_css) / 1. Default: S3-anchored (corpus manifest). */
  coverage_gate?: number;
  /** When true, ANY a11y `severity:'blocker'` finding refuses commit. */
  require_no_blockers: boolean;
}

/** Gate verdict. `allowed:false` carries human-readable reasons the orchestrator surfaces. */
export interface GateResult {
  allowed: boolean;
  reasons: string[];
}

/**
 * The S3-anchored default coverage gate, the LAST-RESORT fallback used ONLY when no manifest value is
 * supplied. This mirrors `corpus.manifest.json#default_coverage_gate` (currently 0.6, the WP-S03 floor)
 * — callers SHOULD pass the manifest value explicitly via `gate.coverage_gate` (the orchestrator reads
 * it from the manifest). It is deliberately NOT 0.85 (`15-engineering-standards §4.6/§6`, S03).
 */
export const S3_DEFAULT_COVERAGE_GATE = 0.6;

/**
 * Evaluate the commit gate against a built report. `allowed:false` when the COVERED fraction
 * (`pct_native + pct_local_or_global_class` would double-count, so we use native + custom_css; class is
 * the placement view of native and must NOT be added on top — see below) is below `coverage_gate`, OR
 * when a11y blockers exist and `require_no_blockers` is set.
 *
 * COVERED FRACTION (WP-H10 §5 / Interface): "the native+class+custom_css covered fraction". Because
 * `pct_local_or_global_class` is the PLACEMENT view of the SAME native declarations (not an additional
 * bucket — see `buildCoverageReport`), the covered fraction is `(pct_native + pct_custom_css) / 100`;
 * adding the class percentage again would double-count native. Equivalently: `1 - pct_dropped/100`.
 *
 * Contract 16 §6: the gate NEVER reads `report.behavior` — the behavior score is ADVISORY in v1
 * (`behavior_gate:'advisory'`); the visual commit gate is UNCHANGED.
 */
export function evaluateGate(report: CoverageReport, gate: GateConfig): GateResult {
  const reasons: string[] = [];
  const threshold = gate.coverage_gate ?? S3_DEFAULT_COVERAGE_GATE;

  const coveredFraction = (report.coverage.pct_native + report.coverage.pct_custom_css) / 100;

  if (coveredFraction < threshold) {
    reasons.push(
      `coverage ${(coveredFraction * 100).toFixed(1)}% (native+custom_css) is below the ` +
        `${(threshold * 100).toFixed(1)}% commit gate (S3-anchored; never 85%).`,
    );
  }

  if (gate.require_no_blockers) {
    const blockers = report.a11y.filter((f) => f.severity === 'blocker');
    for (const b of blockers) {
      reasons.push(`a11y blocker (${b.rule}) on ${b.element_id}: ${b.message}`);
    }
  }

  return { allowed: reasons.length === 0, reasons };
}
