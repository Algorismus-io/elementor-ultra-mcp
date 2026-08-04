/**
 * WP-H11 — the convert PIPELINE orchestrator (the flagship's top layer).
 *
 * Chains every pure stage in order and threads the FROZEN IR (`convert/types.ts`, WP-H01):
 *
 *   parse (H03) → normalize (H04) → classify (H05) → map (H06) → style-extract (H07)
 *     → assemble (H08, media/id ports) → hoist (H09) → variable-extract (H09)
 *     → coverage + a11y (H10) → deterministic placeholder-resolve + wire-normalize
 *                                         … = `htmlToTree` (NO persist; the tree is PERSISTABLE as-is)
 *
 * and (only for `htmlToPage`, only on explicit commit + gate-pass + elicitation confirm):
 *
 *   AUTHORITATIVE dry_run (kit untouched — valid:false writes NOTHING) → variables.batch (mint vars)
 *     → classes diff-PUT (under the tree's DETERMINISTIC `g-*` ids, replay-stable) → swap deterministic
 *     variable ids for the PHP-minted ones → create/replace-tree (save; a failed save COMPENSATES the
 *     kit writes best-effort) → prime-css (mandatory, S01)
 *
 * LOCKED DECISION (15-eng-standards §4.6, 13-tool-catalog §1.9, RESEARCH.md §6.8): convert NEVER
 * auto-commits. `htmlToPage` with `commit:false` (the default) runs the full preview + an authoritative
 * dry_run for an honest diff and persists NOTHING. Even `commit:true` requires the S3-anchored coverage
 * gate to PASS and the user to CONFIRM via elicitation; a gate-deny is a clean refusal (NOT an error),
 * a confirm-decline is a clean non-error result, and a dry_run `valid:false` is an `isError` result with
 * the structured errors (the save is never attempted).
 *
 * This module + `ports.ts` are the ONLY HTML-pipeline code that touch the WP client (via the injected
 * `ConvertPorts`); the pure stages receive ports/values only.
 */

import { parseHtml } from './parse.js';
import { normalizeIr, pseudoPath } from './normalize.js';
import { classifyIr, suggestName } from './classify.js';
import {
  computeTabPairing,
  detectUndetectableClasses,
  type UndetectableClassNote,
} from './classify.js';
import { mapIr } from './map.js';
import { extractStyles } from './style-extract.js';
import { assembleTree } from './assemble.js';
import { hoistClasses } from './hoist.js';
import { extractVariables, isPlaceholderVarId, placeholderVarId } from './variable-extract.js';
import { isPlaceholderClassId } from './hoist.js';
import { lintA11y } from './a11y.js';
import {
  buildBehaviorCoverage,
  buildCoverageReport,
  countNativeProps,
  evaluateGate,
} from './coverage.js';
import { fidelityCheck } from './fidelity.js';
import { collectDetectedBehaviors } from './map.js';
import {
  decodeInteractionItems,
  diagnoseInteractionWiring,
  emitInteractions,
  postSaveAssert,
  type AuthoredInteractions,
  type PostSaveInteractionCheck,
} from './behavior-interactions.js';
import {
  buildCssCarry,
  censusInlineStyles,
  type CssCarryReport,
  type IncludeCss,
  type InlineStyleBlock,
} from './css-carry.js';
import {
  buildJsPassthrough,
  censusScriptsWithContent,
  type IncludeJs,
  type PassthroughReport,
  type PassthroughResult,
  type PassthroughScript,
} from './passthrough.js';
import {
  runIntegrity,
  type AccountingLedger,
  type IntegrityViolation,
  type SourceComputedMap,
} from './integrity.js';
import {
  buildFontCarry,
  extractFamiliesFromFontUrl,
  type FontAssets,
  type FontCarryReport,
} from './fonts.js';
import { NOISE_FILTER_SOURCE_PATH } from './style-extract.js';
import { classifyDeclaration } from './declaration-classifier.js';
import {
  runVerifyLoop,
  evaluateVerifyGate,
  MAX_REPAIR_ROUNDS,
  type CauseStats,
  type ContentAudit,
  type Divergence,
  type ElementCountDelta,
  type InteractionProbeTarget,
  type PixelScoreEntry,
  type RepairPatch,
  type VerifyLoopInput,
  type VerifyLoopResult,
} from './verify-loop.js';
import type {
  BehaviorProbe,
  BreakpointSpec,
  ClassifyResult,
  CoverageReport,
  DeclFallback,
  DetectedBehavior,
  ElementNode,
  FidelityResult,
  GlobalClassObject,
  IrNode,
  MapResult,
  ParseResult,
  ProposedVariable,
  StyleDefinition,
  StyledNode,
  StyleExtractResult,
  StyleSchema,
  VariableDef,
} from './types.js';
import type { SourcePathIdMap } from './coverage.js';
import type { ConvertPorts } from './ports.js';

import { mintOpId, isReplay } from '../safety/idempotency.js';
import type {
  Breakpoint,
  Capabilities,
  DesignVariable,
  PutGlobalClassesRequest,
  RestDiff,
  RestValidationError,
  VariableBatchOp,
} from '@elementor-ultra/shared';
import type { Diff } from '../authoring/contract.js';
import { collectIds } from '../authoring/ids.js';

/* ───────────────────────────── tool-arg / result types (13-tool-catalog §1.9) ──────────────── */

/** `convert.*` options bag (defaults applied by the SDK from the F04 inputSchema). */
export interface ConvertOptions {
  hoist_classes?: boolean;
  extract_variables?: boolean;
  fidelity?: 'high' | 'balanced' | 'fast';
  sideload_media?: boolean;
  /**
   * Opt-in: preserve the source DOM's class names on converted elements (sanitized; system prefixes
   * skipped) so enhancement CSS/JS keys off stable semantic anchors that survive re-converts —
   * the drift-resync contract (see AssembleContext.preserve_source_classes).
   */
  preserve_source_classes?: boolean;
  /**
   * Base URL relative `src`/`srcset`/`href`/`@import` references resolve against (PARSE's Playwright
   * context `baseURL` + NORMALIZE's `resolveUrl`/`resolveMedia`). Without it, external CSS with relative
   * hrefs is unresolvable (`EXTERNAL_CSS_UNRESOLVED`) and relative media URLs cannot sideload.
   */
  base_url?: string;
  /**
   * Tier-3 JS passthrough opt-in (contract 16 §5; default `'none'` — §8.3: the default emits ZERO
   * script bytes). `'bundle'` additionally requires site `unfiltered_html` AND an elicitation
   * confirm (independent of the commit confirm); a decline proceeds WITHOUT JS, reported.
   */
  include_js?: IncludeJs;
  /**
   * WP-H14b — first-party inline-CSS carry opt-in (default `'none'` — zero style bytes). `'inline'`
   * appends ONE html widget carrying the FILTERED subset of the source's inline `<style>` blocks:
   * `@keyframes`, animation-binding rules, and id-selector rules (script-created UI). Never a
   * wholesale stylesheet carry. Pairs with `preserve_source_classes` (the bindings re-match) and
   * `include_js:'bundle'` (the id rules style what the carried scripts create).
   */
  include_css?: IncludeCss;
  /**
   * Contract 17 #9 — webfont carry (default `true`): when PARSE captured font stylesheet links whose
   * families the converted styles actually use, ONE classic `html` widget re-emitting those `<link>`s
   * is prepended to the tree (fonts load before content paints) and the carry is reported
   * (`fonts` on the result). `false` skips the stage entirely (no widget, no report).
   */
  carry_fonts?: boolean;
}

/** `elementor.convert.html_to_tree` args (13-tool-catalog §1.9). */
export interface HtmlToTreeArgs {
  html: string;
  css?: string;
  generation?: 'v4' | 'v3';
  options?: ConvertOptions;
}

/** `elementor.convert.html_to_tree` result — the EXACT `convert.html_to_tree.outputSchema` (§1.9). */
export interface HtmlToTreeResult {
  elements: ElementNode[];
  proposed_classes: GlobalClassObject[];
  proposed_variables: ProposedVariable[];
  report: CoverageReport;
  /**
   * Tier-3 script partition (contract 16 §5 — `bundled ∪ excluded` covers the full census; never
   * silent). ADDITIVE optional: present ONLY when the caller engaged `options.include_js`, so a
   * pre-contract-16 call's result is unchanged (§8 invariant 5).
   */
  js_passthrough?: PassthroughReport;
  /**
   * WP-H14b — the inline-CSS carry partition (carried counts + excluded rule count). ADDITIVE
   * optional: present ONLY when the caller engaged `options.include_css`.
   */
  css_carry?: CssCarryReport;
  /** Behavior-stage honesty notes (Pro-easing degrades, JS-confirm declines). Omitted when empty. */
  warnings?: string[];
  /**
   * Contract 17 #9 — the font-carry partition (`carried ∪ excluded` covers every captured font link).
   * ADDITIVE optional: present only when the page actually had font links to judge, so a zero-font
   * page's result stays byte-identical to pre-contract-17 output.
   */
  fonts?: FontCarryReport;
  /**
   * Contract 17 §1 — integrity violations. EVERY violated invariant (I1–I4) now HARD-FAILS the
   * conversion (a thrown {@link ConvertIntegrityError} carrying the violations — a converter bug
   * never persists), so a returned result always omits this field; it is retained for wire-compat
   * (the tool layer surfaces the thrown violations through the same key on the isError result).
   * The one honest skip: I2 is not judged when the positional source↔element correspondence is
   * unsound (reported via `warnings`; the post-save verify loop re-checks it on the rendered page).
   */
  integrity?: IntegrityViolation[];
  /**
   * Contract 18 §7 detection-honesty extension (16 residual): behavior classes per-node detection
   * CANNOT see (rAF count-ups) still APPEAR — as report-level notes with script-census evidence.
   * ADDITIVE optional: omitted when the census found no evidence, so pre-18 results are unchanged.
   */
  undetectable_classes?: UndetectableClassNote[];
}

/** `elementor.convert.html_to_page` args (13-tool-catalog §1.9). */
export interface HtmlToPageArgs {
  html: string;
  css?: string;
  post_id?: number;
  title?: string;
  /** Publish state for a NEWLY created page (ignored when replacing an existing `post_id`). */
  status?: 'draft' | 'publish' | 'pending' | 'private';
  generation?: 'v4' | 'v3';
  commit?: boolean;
  confirm?: boolean;
  coverage_gate?: number;
  /**
   * Contract 17 §3 R3 — the post-save verify-loop divergence threshold (default
   * {@link DEFAULT_VERIFY_GATE}). When the final loop pass still fails V2 (overflow / zero-size /
   * height) or counts MORE divergences than this, the page is reverted to `draft` (reported).
   */
  verify_gate?: number;
  /**
   * WP page template for the committed page. A full-document source carries its own page chrome
   * (header/footer/body styles), so a NEW page defaults to the blank `elementor_canvas` — rendered
   * in the active theme's content column the layout repaints (field-measured: a 625px column →
   * 400+ bogus `unknown` divergences and an R3 revert on every full-page conversion). Pass
   * `default` to keep the theme template. An EXISTING `post_id`'s template is the operator's
   * choice and is only touched when set explicitly.
   */
  page_template?: 'elementor_canvas' | 'elementor_header_footer' | 'default';
  /** Same options bag as `html_to_tree` (threaded into the shared stage run — incl. `base_url`). */
  options?: ConvertOptions;
}

/** The outcome kind of `htmlToPage` (so the tool handler maps to the right MCP surface). */
export type HtmlToPageStatus =
  | 'preview' // commit:false — preview + authoritative dry_run, nothing saved
  | 'gate_denied' // commit:true but the coverage/a11y gate refused (clean refusal, NOT an error)
  | 'declined' // commit:true + gate-pass but the user declined the elicitation confirm
  | 'invalid' // the authoritative dry_run returned valid:false (→ isError)
  | 'committed'; // saved + (attempted) primed

/** `elementor.convert.html_to_page` result (13-tool-catalog §1.9 + the orchestrator status/errors). */
export interface HtmlToPageResult {
  status: HtmlToPageStatus;
  id?: number;
  diff: Diff;
  preview_url: string;
  report: CoverageReport;
  committed: boolean;
  css_primed: boolean;
  /** Gate-deny reasons (status `gate_denied`) — human-readable, surfaced to the agent. */
  gate_reasons?: string[];
  /** Structured dry_run errors (status `invalid`) — the agent fixes these (NOT auto-retried). */
  errors?: RestValidationError[];
  /** Soft DUPLICATED_LABEL rebinds reconciled during the class diff-PUT (rides the diff/report). */
  duplicated_labels?: Record<string, string>;
  /** True when the save was an idempotent replay (informational; the write already landed). */
  idempotent_replay?: boolean;
  /** Tier-3 script partition (contract 16 §5) — present when `options.include_js` was engaged. */
  js_passthrough?: PassthroughReport;
  /** WP-H14b inline-CSS carry partition — present when `options.include_css` was engaged. */
  css_carry?: CssCarryReport;
  /** Behavior-stage honesty notes (Pro-easing degrades, JS-confirm declines). Omitted when empty. */
  warnings?: string[];
  /**
   * §8 invariant 2: per-element sanitizer-survival checks from the post-save document readback
   * (status `committed` with authored interactions only). Any non-`survived` row has ALREADY been
   * folded into the report (its tier-2 behaviors downgraded to tier 4) — never a silent lie.
   */
  interactions_post_save?: PostSaveInteractionCheck[];
  /** Contract 17 #9 — the font-carry partition (rides every outcome, same as the tree result). */
  fonts?: FontCarryReport;
  /** Contract 17 §1 — wire-compat carrier; I1–I4 all hard-fail before any persist (see tree result). */
  integrity?: IntegrityViolation[];
  /** Contract 18 §7 detection honesty — report-level undetectable-class notes (see tree result). */
  undetectable_classes?: UndetectableClassNote[];
  /**
   * Contract 17 §2–3 — the post-save verification loop output (status `committed` only): the V1
   * divergence list, V3 pixel scores, the R1 repairs applied/skipped, and the R3 gate verdict
   * (including a `reverted_to_draft` action when a bad conversion would otherwise stay published).
   * Absent when the loop itself could not run (reported via `warnings`, never silent).
   */
  verification?: ConvertVerification;
}

/** `elementor.convert.fidelity_check` args (13-tool-catalog §1.9). */
export interface FidelityCheckArgs {
  post_id: number;
  source_html: string;
  css?: string;
  breakpoints?: string[];
}

/** The elicitation confirmer the orchestrator calls before a commit (a clean decline is non-error). */
export type Confirmer = (prompt: string) => Promise<boolean>;

/**
 * The loose REST `ElementNode[]` shape the `wp/routes` request bodies expect. The convert IR / stages
 * produce the STRICT authoring `ElementNode` (a discriminated union); it is structurally a NARROWING of
 * the loose REST shape (which carries an index signature), so this is the single explicit cast at the
 * REST seam (mirrors `design-classes-diff.ts`'s `toRestClass`). No data is transformed.
 */
type RestElementNode = import('@elementor-ultra/shared').ElementNode;
function toRestElements(elements: ElementNode[]): RestElementNode[] {
  return elements.map(normalizeNodeForWire) as unknown as RestElementNode[];
}

/**
 * Normalize one authoring node for the REST/validator WIRE. The IR uses `meta.breakpoint:null` for the
 * base/desktop variant (per the FROZEN authoring contract — `null` = base/desktop), but the PHP atomic
 * validator (`styles/style-variant.php`) rejects a `null` base breakpoint with
 * `meta.breakpoint:missing_or_invalid_value` — it requires the literal active base key `'desktop'` (the
 * proven validating shape from WP-S01/S03). This is the single explicit IR→wire normalization at the REST
 * seam: it deep-copies the node and rewrites every style variant's `meta.breakpoint:null → 'desktop'`,
 * leaving the IR (which hoist/coverage key on `null`) untouched. Pure; structure-only.
 */
/**
 * Rewrite a style definition's variants for the REST/validator wire: `meta.breakpoint:null|undefined →
 * 'desktop'` (the active base key). The PHP atomic Style_Parser — used by BOTH the document validator
 * (local element styles) AND the global-classes service (hoisted classes) — rejects a `null` base
 * breakpoint with `meta.breakpoint:missing_or_invalid_value`. The IR keeps `null` for the base (hoist /
 * coverage key on it); this is the single IR→wire fix, applied to local styles (`normalizeNodeForWire`)
 * AND proposed global classes (htmlToTree step 10, before they are ever returned). Pure; structure-only.
 */
function normalizeVariantsForWire<T extends { meta?: { breakpoint?: unknown } }>(
  variants: T[] | undefined,
): T[] | undefined {
  if (!Array.isArray(variants)) {
    return variants;
  }
  return variants.map((v) =>
    v?.meta !== undefined && (v.meta.breakpoint === null || v.meta.breakpoint === undefined)
      ? { ...v, meta: { ...v.meta, breakpoint: 'desktop' } }
      : v,
  );
}

function normalizeNodeForWire(node: ElementNode): ElementNode {
  const loose = node as {
    styles?: Record<string, { variants?: Array<{ meta?: { breakpoint?: unknown } }> }>;
    elements?: ElementNode[];
  };
  const styles = loose.styles;
  const nextStyles =
    styles === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(styles).map(([sid, def]) => {
            const variants = normalizeVariantsForWire(def.variants);
            return [sid, { ...def, variants }];
          }),
        );
  const children = Array.isArray(loose.elements)
    ? loose.elements.map(normalizeNodeForWire)
    : loose.elements;
  return {
    ...node,
    ...(nextStyles !== undefined ? { styles: nextStyles } : {}),
    ...(children !== undefined ? { elements: children } : {}),
  } as ElementNode;
}
/** Narrow a loose REST node (from `RestDiff.before/after`) to the authoring node for `nodeMeta`. */
function fromRestNode(node: RestElementNode | undefined): ElementNode | undefined {
  return node as unknown as ElementNode | undefined;
}

/* ───────────────────────────── shared stage plumbing ──────────────────────────────────────── */

/** The S3-anchored default coverage gate (mirrors `corpus.manifest.json#default_coverage_gate`). */
export const DEFAULT_COVERAGE_GATE = 0.6;

/** Map the live REST breakpoints to the PARSE/STYLE-EXTRACT `BreakpointSpec[]` (RESEARCH.md §6.7). */
function toBreakpointSpecs(items: Breakpoint[], activeDirection: 'min' | 'max'): BreakpointSpec[] {
  const specs: BreakpointSpec[] = items.map((bp) => ({
    key: bp.key,
    width: bp.value,
    direction: bp.direction ?? activeDirection,
  }));
  // Ensure a desktop anchor is present so PARSE always has a base viewport.
  if (!specs.some((s) => s.key === 'desktop')) {
    specs.unshift({ key: 'desktop', width: 1280, direction: 'min' });
  }
  return specs;
}

/**
 * Build the flat `StyleSchema` (`prop → {$$type, enum?, units?}`) STYLE-EXTRACT classifies against,
 * from the live `GET /schema/styles` payload. The REST `props` map is loosely typed; we read `$$type`
 * (the atomic prop-type id) and any `enum`/`units` constraints defensively (a malformed entry degrades
 * to a bare `$$type:'string'` so STYLE-EXTRACT can still decide native-vs-fallback without throwing).
 */
function buildStyleSchema(
  props: Record<string, unknown>,
  units: Record<string, string[]>,
): StyleSchema {
  const schema: StyleSchema = {};
  for (const [prop, raw] of Object.entries(props)) {
    // The live `GET /schema/styles` entry shape is `{kind, key, units?, members?, enum?}` (e.g. width →
    // `{kind:'object', key:'size', units:[…]}`, color → `{kind:'string', key:'color'}`, padding →
    // `{kind:'union', key:'union', members:['dimensions','size'], units:[…]}`). The atomic prop-TYPE id
    // is `key` (NOT `$$type`/`type` — those are absent on the wire). For a `union`, prefer the size-like
    // member so length values classify natively (the box-shaped members are handled by LOGICAL_BOX_PROPS
    // upstream of the generic schema check). We also accept the legacy `$$type`/`type` keys defensively.
    const entry = (raw ?? {}) as {
      $$type?: unknown;
      type?: unknown;
      kind?: unknown;
      key?: unknown;
      members?: unknown;
      enum?: unknown;
      units?: unknown;
    };
    let dollarType =
      typeof entry.$$type === 'string'
        ? entry.$$type
        : typeof entry.type === 'string'
          ? entry.type
          : typeof entry.key === 'string'
            ? entry.key
            : 'string';
    // A `union` resolves to a size-like member when one is present (so e.g. width's union → 'size').
    if (dollarType === 'union' && Array.isArray(entry.members)) {
      const members = entry.members.filter((m): m is string => typeof m === 'string');
      dollarType = members.find((m) => m === 'size') ?? members[0] ?? 'string';
    }
    const enumVals = Array.isArray(entry.enum)
      ? entry.enum.filter((v): v is string => typeof v === 'string')
      : undefined;
    // Units may live on the prop entry (the live shape) OR in the separate top-level `units` map.
    const entryUnits = Array.isArray(entry.units)
      ? entry.units.filter((u): u is string => typeof u === 'string')
      : undefined;
    const unitVals = entryUnits ?? units[prop];
    schema[prop] = {
      $$type: dollarType,
      ...(enumVals !== undefined && enumVals.length > 0 ? { enum: enumVals } : {}),
      ...(unitVals !== undefined && unitVals.length > 0 ? { units: unitVals } : {}),
    };
  }
  return schema;
}

/** Build the `source_path → suggested-name` hints HOIST uses to label proposed classes meaningfully. */
function buildNameHints(ir: IrNode[]): Record<string, string> {
  const hints: Record<string, string> = {};
  const walk = (nodes: IrNode[]): void => {
    for (const node of nodes) {
      hints[node.source_path] = suggestName(node);
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  };
  walk(ir);
  return hints;
}

/** Map the normalized `VariableDef[]` HOIST/VARIABLE-EXTRACT reuse-index from the live variables map. */
function toVariableDefs(variables: Record<string, DesignVariable>): VariableDef[] {
  return Object.entries(variables).map(([id, v]) => ({
    id,
    type: v.type,
    label: v.label,
    value: v.value,
  }));
}

/** Normalize a literal value the SAME way VARIABLE-EXTRACT does (placeholder → minted-id matching). */
function normalizeLiteralForMatch(kind: ProposedVariable['type'], value: string): string {
  const trimmed = value.trim();
  if (kind === 'global-color-variable') {
    return trimmed.toLowerCase().replace(/\s+/g, '');
  }
  if (kind === 'global-font-variable') {
    return trimmed
      .toLowerCase()
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+/g, ' ');
  }
  return trimmed.toLowerCase().replace(/\s+/g, '');
}

/** The literal `kind` segment a `__var:<kind>:<norm>` placeholder uses, derived from the var type. */
function kindForVarType(type: ProposedVariable['type']): 'color' | 'font' | 'size' {
  if (type === 'global-color-variable') return 'color';
  if (type === 'global-font-variable') return 'font';
  return 'size';
}

/* ───────────────────────────── the stage-9 PREVIEW pipeline (htmlToTree) ────────────────────── */

/** Everything `htmlToTree` produces (the public result + the internal records `htmlToPage` reuses). */
export interface TreeBuild {
  result: HtmlToTreeResult;
  /** The class-rebind map (`class-id → element-ids`) the diff-PUT order is built from. */
  classRebinds: Record<string, string[]>;
  /** The existing class order (for `projectedOrder` on commit). */
  existingClassOrder: string[];
  /** The live variables watermark (REQUIRED by `variables.batch` on commit). */
  variablesWatermark: number;
  /**
   * `__var:<kind>:<norm>` placeholder token → the DETERMINISTIC `e-gv-*` id the returned tree carries.
   * On commit, `commitVariables` composes this with the PHP-minted ids so the deterministic ids in the
   * tree are swapped for the real ones in one pass.
   */
  variableIdMap: Record<string, string>;
  /** The resolved generation (v4 / v3) the dry_run + save use. */
  generation: 'v4' | 'v3';
  /** The fully-TIERED detected behaviors (contract 16 — empty on a zero-behavior page). */
  behaviors: DetectedBehavior[];
  /** Elements the tier-2 stage authored interactions onto (drives the §8.2 post-save assert). */
  interactionsAuthored: AuthoredInteractions[];
  /** `source_path → minted element_id` (behavior nodeIds → element folding on the commit path). */
  sourcePathIdMap: SourcePathIdMap;
  /** The live breakpoint specs probed for PARSE — the verify loop renders at every one (§2 V1). */
  breakpoints: BreakpointSpec[];
  /** The live flat Style-Schema — the R1 repair applier classifies patch values against it. */
  styleSchema: StyleSchema;
  /**
   * The I3 tier ledger rows (style-extract fallbacks sans the I4 noise summary + the inline-fold
   * drop rows) — drives the verify loop's cause attribution (§2 V1).
   */
  declarationLedger: DeclFallback[];
  /**
   * Honest-drop TEXT strings (today: unrepresentable pseudo `content` strings) — the §7 P1-e
   * content-presence audit counts a source string found here as `dropped` (accounted), never
   * `missing`. Text the converter keeps (P1-a mixed-children runs) is NEVER listed here.
   */
  droppedTexts: string[];
}

/**
 * Run stages 1-9 (parse..coverage), then resolve placeholders + wire-normalize (step 10) so the
 * returned tree is PERSISTABLE AS-IS. NO persist. Probes breakpoints + style-schema + capabilities
 * FIRST (read-only), then composes the pure stages in order, threading the frozen IR. The `options`
 * toggles map onto HOIST/VARIABLE-EXTRACT/ASSEMBLE (+ `base_url` onto PARSE/NORMALIZE).
 */
export async function htmlToTree(
  args: HtmlToTreeArgs,
  ports: ConvertPorts,
  confirm?: Confirmer,
): Promise<TreeBuild> {
  const options = args.options ?? {};
  const fidelity = options.fidelity ?? 'balanced';

  // ── (read-only probes) breakpoints + style-schema + capabilities ────────────────────────────────
  const probes = await probeStageInputs(ports, args.generation);

  // ── (1) PARSE — render-then-extract the IR forest ───────────────────────────────────────────────
  const parsed = await parseHtml({
    html: args.html,
    ...(args.css !== undefined ? { css: args.css } : {}),
    ...(options.base_url !== undefined ? { base_url: options.base_url } : {}),
    breakpoints: probes.breakpoints,
    fidelity,
  });

  // ── (2..12) the SHARED stage run — the contract-18 §1 IR seam: `figma-pipeline.ts` feeds the
  // SAME helper with figma-parse's ParseResult-compatible envelope, so everything downstream of
  // parse is ONE code path for both front-ends (never a fork).
  return buildTreeFromParsed(
    parsed,
    censusScriptsWithContent(args.html),
    { options, probes },
    ports,
    confirm,
    censusInlineStyles(args.html),
  );
}

/* ───────────────────────────── the shared stage run (contract 18 §1 IR seam) ────────────────── */

/** The read-only stage probes EVERY front-end needs before its parse stage runs. */
export interface StageProbes {
  breakpoints: BreakpointSpec[];
  styleSchema: StyleSchema;
  capabilities: Capabilities;
  /** The resolved generation: the explicit arg, else v4 when atomic is active, else v3 (LOCKED). */
  generation: 'v4' | 'v3';
}

/** Probe breakpoints + style-schema + capabilities (read-only) and resolve the generation. */
export async function probeStageInputs(
  ports: ConvertPorts,
  generationArg?: 'v4' | 'v3',
): Promise<StageProbes> {
  const [bpResp, stylesResp, capabilities] = await Promise.all([
    ports.schema.breakpoints(),
    ports.schema.styles(),
    ports.schema.capabilities(),
  ]);
  return {
    breakpoints: toBreakpointSpecs(bpResp.items, bpResp.active_direction),
    styleSchema: buildStyleSchema(stylesResp.props, stylesResp.units),
    capabilities,
    generation: generationArg ?? (capabilities.atomic ? 'v4' : 'v3'),
  };
}

/**
 * The parse-stage envelope the shared run consumes — `ParseResult` (the frozen WP-H01 seam) plus
 * the optional contract-17 #9 font-asset capture. `parseHtml` returns a superset; contract 18's
 * figma-parse emits exactly this shape (`{ir, doc_direction, viewport_used, raw_inner_markup: {}}`).
 */
export type ParsedSource = ParseResult & { fontAssets?: FontAssets };

/**
 * Run stages 2-12 (normalize..integrity + placeholder-resolve/wire-normalize) over an
 * already-parsed source envelope. This is the SINGLE downstream path for every conversion
 * front-end (HTML parse / contract-18 figma-parse) — the §1 architecture invariant: front-ends
 * feed the IR seam; everything downstream reuses UNCHANGED.
 */
export async function buildTreeFromParsed(
  parsed: ParsedSource,
  scriptsCensus: PassthroughScript[],
  run: { options: ConvertOptions; probes: StageProbes },
  ports: ConvertPorts,
  confirm?: Confirmer,
  stylesCensus?: InlineStyleBlock[],
): Promise<TreeBuild> {
  const { options, probes } = run;
  const { breakpoints, styleSchema, capabilities, generation } = probes;
  const hoist = options.hoist_classes ?? true;
  const extractVars = options.extract_variables ?? true;
  const sideloadMedia = options.sideload_media ?? true;

  // ── (2) NORMALIZE — clean the IR (strip inline tags, promote block-in-text, unwrap wrappers) ────
  const normalized = normalizeIr(parsed.ir, {
    ...(options.base_url !== undefined ? { base_url: options.base_url } : {}),
    raw_inner_markup: parsed.raw_inner_markup,
    unwrap_redundant: true,
  });

  // ── (3) CLASSIFY — assign semantic roles + flex intent ──────────────────────────────────────────
  const classified: ClassifyResult = classifyIr(normalized.ir, { infer_flex: true });

  // ── (4) MAP — resolve roles → Elementor targets (capability-gated) ─────────────────────────────
  const tabPairing = computeTabPairing(classified.ir);
  const mapped: MapResult = mapIr(classified.ir, {
    generation,
    capabilities,
    tab_pairing: tabPairing,
  });

  // ── (5) STYLE-EXTRACT — typed local styles + per-declaration fallback report ────────────────────
  const styled: StyleExtractResult = extractStyles(mapped.nodes, {
    style_schema: styleSchema,
    breakpoints,
    doc_direction: parsed.doc_direction,
    target_rtl: parsed.doc_direction === 'rtl',
    pro_active: capabilities.pro,
  });

  // ── (6) ASSEMBLE — IR → authoring ElementNode[], sideload media id-only, mint ids ───────────────
  const assembled = await assembleTree(styled.styled_nodes, {
    generation,
    existing_ids: new Set<string>(),
    sideload_media: sideloadMedia,
    media: ports.media,
    ids: ports.ids,
    ...(options.preserve_source_classes === true ? { preserve_source_classes: true } : {}),
  });

  // ── (7) HOIST — promote shared declaration-sets to proposed global classes (reuse-first) ────────
  let elements = assembled.elements;
  let proposedClasses: GlobalClassObject[] = [];
  let classRebinds: Record<string, string[]> = {};
  let existingClassOrder: string[] = [];
  const existingClassDefs: Record<string, StyleDefinition> = {};
  if (hoist) {
    const existingClasses = await ports.design.listClasses();
    existingClassOrder = existingClasses.order;
    for (const item of existingClasses.items as unknown as GlobalClassObject[]) {
      existingClassDefs[item.id] = item;
    }
    const hoisted = hoistClasses(elements, {
      existing_classes: existingClasses.items as unknown as GlobalClassObject[],
      existing_order: existingClasses.order,
      min_uses: 2,
      name_hints: buildNameHints(parsed.ir),
      budget_max: 1000,
    });
    elements = hoisted.elements;
    proposedClasses = hoisted.proposed_classes;
    classRebinds = hoisted.class_rebinds;
  }

  // ── (8) VARIABLE-EXTRACT — promote repeated literals to proposed variables ──────────────────────
  let proposedVariables: ProposedVariable[] = [];
  let variablesWatermark = 0;
  const existingVariableIds = new Set<string>();
  if (extractVars) {
    const existingVars = await ports.design.listVariables();
    variablesWatermark = existingVars.watermark;
    for (const id of Object.keys(existingVars.variables)) {
      existingVariableIds.add(id);
    }
    const varResult = extractVariables(elements, styled.proposed_variable_literals, {
      existing_variables: toVariableDefs(existingVars.variables),
      min_uses: 2,
      budget_max: 1000,
    });
    elements = varResult.elements;
    proposedVariables = varResult.proposed_variables;
  }

  // ── (8b) PAGE BACKGROUND — wrap in a full-bleed root carrying the document (body/<html>) background ─
  // A full-page conversion otherwise loses the document background (we only walk body's CHILDREN),
  // leaving a white page behind the content — which also makes light-on-dark text invisible. When PARSE
  // captured a non-transparent page background, wrap the top-level elements in one root e-flexbox that
  // paints it full-bleed (min-height:100vh, width:100%, column).
  if (parsed.page_background !== undefined && parsed.page_background !== '') {
    elements = wrapInPageRoot(elements, parsed.page_background, generation);
  }

  // ── (8c) TIER-2 NATIVE INTERACTIONS (contract 16 §4) — entrance/hover behaviors → S08 items ────
  // MAP already tiered the tier-1/4 behavior kinds on the mapped forest (`collectDetectedBehaviors`);
  // the tier-2 kinds pass through UNTIERED and are resolved here by `emitInteractions` (which attaches
  // the S08 JSON blobs to the assembled elements). Zero behaviors → the stage is skipped entirely, so
  // a zero-behavior page's tree/report stays byte-identical to pre-contract-16 output (§8 inv. 5).
  const { map: idMap, sound: idMapSound } = buildSourcePathIdMap(mapped, assembled.minted_ids);
  const behaviorWarnings: string[] = [];
  let behaviors = collectDetectedBehaviors(mapped.nodes);
  let interactionsAuthored: AuthoredInteractions[] = [];
  if (behaviors.some((b) => b.kind === 'entrance-animation' || b.kind === 'hover-effect')) {
    const ix = emitInteractions(elements, classified.ir, {
      capabilities,
      id_map: idMap,
    });
    elements = ix.elements;
    interactionsAuthored = ix.authored;
    behaviorWarnings.push(...ix.warnings);
    behaviors = mergeInteractionTiers(behaviors, ix.report);
  }

  // ── (9) A11Y — linted BEFORE the (script-only) tier-3 widget is appended, so the commit gate's
  // a11y surface is exactly the pre-contract-16 one (behavior conversion never changes the gate, §6).
  const a11y = lintA11y(elements);

  // ── (9b) TIER-3 JS PASSTHROUGH (contract 16 §5, opt-in) — census → confirm → ONE html widget ───
  // `include_js` defaults to 'none' (zero script bytes, §8.3). 'bundle' requires site
  // `unfiltered_html` (stage-enforced) AND an elicitation confirm (here — independent of the commit
  // confirm, §0.4); a decline (or no elicitation channel) proceeds WITHOUT JS, reported. The script
  // partition (`bundled ∪ excluded` = full census) is surfaced ONLY when the caller engaged
  // `include_js`, keeping pre-contract results unchanged.
  // The inline-content script census serves BOTH the Tier-3 passthrough (9b) and the contract-18
  // §7 detection-honesty census (undetectable_classes — needs inline bodies, which the frozen
  // PARSE PageScript census records as byte counts only). It arrives as a parameter: the HTML
  // front-end censuses its source document; the figma front-end has no scripts (an empty census).
  let jsPassthrough: PassthroughReport | undefined;
  {
    const includeJs = options.include_js;
    let mode: IncludeJs = includeJs ?? 'none';
    let declined = false;
    const scripts = scriptsCensus;
    if (mode === 'bundle' && scripts.length > 0 && capabilities.unfiltered_html) {
      const confirmed =
        confirm !== undefined &&
        (await confirm(
          `Bundle ${String(scripts.length)} page script(s) into ONE JS-passthrough html widget ` +
            `appended to the converted tree (include_js:'bundle', Tier 3 — the scripts run ` +
            `verbatim on the page; analytics/tracking scripts are excluded by denylist)?`,
        ));
      if (!confirmed) {
        declined = true;
        mode = 'none';
        behaviorWarnings.push(
          confirm === undefined
            ? "include_js:'bundle' requires an elicitation confirm and no elicitation channel is available — proceeding WITHOUT JS (Tier-3 scripts dropped, reported)"
            : 'JS passthrough declined at the elicitation confirm — proceeding WITHOUT JS (Tier-3 scripts dropped, reported)',
        );
      }
    }
    const pass = buildJsPassthrough(scripts, mode, capabilities, {
      ...(options.base_url !== undefined ? { base_url: options.base_url } : {}),
      behaviors,
      usedIds: collectIds(elements),
    });
    if (pass.widgetNode !== null) {
      // Appended LAST (§5); a classic `html` widget is a valid member of both v4 and v3 trees.
      elements = [...elements, pass.widgetNode];
    }
    if (includeJs !== undefined) {
      jsPassthrough = pass.report;
    }
    behaviors = tierCustomJsBehaviors(behaviors, pass, includeJs, declined);
  }

  // ── (9b-css) FIRST-PARTY INLINE-CSS CARRY (opt-in `include_css:'inline'`) — the styles sibling
  // of 9b: `@keyframes` + animation-binding rules + id-selector rules from the source's inline
  // `<style>` blocks, in ONE appended html widget (WP-H14b — never a wholesale stylesheet carry;
  // the filter keeps only additive rule families so carried CSS cannot fight the local styles).
  // Non-executable, so no elicitation confirm; `unfiltered_html` still gates (kses strips <style>).
  let cssCarry: CssCarryReport | undefined;
  {
    const includeCss = options.include_css;
    const carry = buildCssCarry(stylesCensus, includeCss, capabilities, {
      usedIds: collectIds(elements),
    });
    if (carry.widgetNode !== null) {
      elements = [...elements, carry.widgetNode];
    }
    if (includeCss !== undefined) {
      cssCarry = carry.report;
    }
  }

  // ── (9c) FONT CARRY (contract 17 #9) — re-emit the captured webfont links in ONE html widget ────
  // PARSE captured the page's font stylesheet links + @font-face families; the carry keeps only the
  // links providing a family the converted styles actually USE, prepends ONE classic `html` widget
  // re-emitting them (FIRST, so fonts load before content paints — the 2026-06-11 odiff baseline's
  // largest static-pixel loss was ghost-text from uncarried webfonts), and reports the full
  // carried ∪ excluded partition. Option-gated `carry_fonts` (default ON); a zero-font page emits
  // neither widget nor report (pre-contract-17 results unchanged).
  // Contract 18 §7 "Font system strategy": on an atomic (v4) site the native font pipeline —
  // root-caused + fixed PHP-side (`Fonts_Service::normalize_collected_fonts`, invoked by the
  // mandatory CSS prime) — enqueues every Google-catalog family the converted styles use. The
  // carry therefore DEMOTES to a fallback for non-catalog faces only: families a captured
  // fonts.googleapis.com link declares are by construction catalog families and are passed as
  // `nativeFamilies` (their links exclude with reason `native_path`). Bunny/Typekit/self-hosted
  // links are NOT demoted (their catalog membership is unprovable from the URL — fail open).
  let fontReport: FontCarryReport | undefined;
  if (options.carry_fonts ?? true) {
    const nativeFontFamilies =
      generation === 'v4' && capabilities.atomic
        ? googleCatalogFamilies(parsed.fontAssets?.links ?? [])
        : [];
    const carry = buildFontCarry(parsed.fontAssets, collectUsedFontFamilies(styled.styled_nodes), {
      usedIds: collectIds(elements),
      ...(nativeFontFamilies.length > 0 ? { nativeFamilies: nativeFontFamilies } : {}),
    });
    if (carry.widgetNode !== null) {
      elements = [carry.widgetNode, ...elements];
    }
    if (
      carry.report.carried.length > 0 ||
      carry.report.excluded.length > 0 ||
      carry.report.families_uncarried.length > 0
    ) {
      fontReport = carry.report;
    }
  }

  // ── (9d) COVERAGE — the honest per-section report (gates the commit; behavior section ADVISORY) ─
  // Contract 17 I3: the inline-fold side effects MAP recorded (`MapResult.inline_drops` — e.g. accent
  // colors lost folding `<em>`/`<span>` into html-v3) AND the unrepresentable pseudo-elements
  // NORMALIZE honestly dropped (#10, reason `pseudo_unrepresentable`) are folded into the
  // declaration ledger as dropped-bucket rows (`html_widget` is the frozen DeclFallback dropped
  // tier), so every loss lands in a tier, the coverage percentages reflect it, and the verify
  // loop's `pseudo_unrepresentable` cause attribution has real rows to match (§2 V1).
  const nativeCount = countNativeProps(styled.styled_nodes);
  const inlineFoldRows: DeclFallback[] = (mapped.inline_drops ?? []).map((drop) => ({
    source_path: drop.source_path,
    declaration: drop.declaration,
    tier: 'html_widget',
    reason: drop.reason,
  }));
  const pseudoDropRows: DeclFallback[] = normalized.pseudo_drops.map((drop) => ({
    // The SAME synthetic path a synthesized pseudo would carry (`…::pseudo-before`) — the verify
    // loop's pseudo-CHILD prefix match attributes the parent's divergence to this row (#10).
    source_path: pseudoPath(drop.source_path, drop.pseudo),
    declaration: `content: ${drop.content}`,
    tier: 'html_widget',
    reason: `${drop.reason}: ::${drop.pseudo} dropped — ${drop.detail}`,
  }));
  for (const drop of normalized.pseudo_drops) {
    behaviorWarnings.push(
      `::${drop.pseudo} pseudo-element on ${drop.source_path} dropped ` +
        `(pseudo_unrepresentable: ${drop.detail}; content: ${drop.content}) — recorded in the ` +
        'dropped tier (contract 17 #10/I3)',
    );
  }
  const report = buildCoverageReport({
    native_count: nativeCount,
    declaration_fallbacks: [...styled.declaration_fallbacks, ...inlineFoldRows, ...pseudoDropRows],
    node_fallbacks: mapped.fallbacks,
    stripped: normalized.stripped,
    a11y,
    id_map: idMap,
    behaviors,
    // M-g (contract 18 §7): custom_css coverage is LICENSE-gated. Older companion plugins do not
    // report the flag — default to `pro` so pre-M-g behavior is unchanged on those sites.
    custom_css_licensed: capabilities.custom_css_licensed ?? capabilities.pro,
  });

  // ── (10) RESOLVE PLACEHOLDERS + WIRE-NORMALIZE — the returned tree is PERSISTABLE AS-IS ─────────
  // HOIST/VARIABLE-EXTRACT leave internal `__class:`/`__var:` handshake tokens in the tree, and the IR
  // keeps `meta.breakpoint:null` for base variants — BOTH are rejected by the authoritative PHP
  // validators (Classes_Prop_Type's name regex strips `__class:*` entries; Style_Parser rejects a null
  // base breakpoint), so a tree returned with them silently breaks on EVERY persist surface
  // (page_build / replace_tree / raw documents/save — the documented split-commit recipe included).
  // Resolve every placeholder to a DETERMINISTIC real id (classes `g-<hash>`, collision-checked against
  // the live kit; variables `e-gv-<hash>`), rewrite `proposed_classes[].id` + `class_rebinds`
  // consistently, and normalize all base breakpoints to 'desktop'. Deterministic = replay-stable: the
  // same conversion always yields the same ids, so a retried commit collapses onto the same kit entries
  // instead of minting a duplicate set. On commit, `htmlToPage` persists the classes under these EXACT
  // ids and swaps the deterministic variable ids for the PHP-minted ones.
  const classIdMap: Record<string, string> = {};
  const usedClassIds = new Set<string>(existingClassOrder);
  for (const cls of proposedClasses) {
    if (!isPlaceholderClassId(cls.id)) {
      continue;
    }
    let candidate = `g-${shortHash(cls.id)}`;
    for (let n = 2; usedClassIds.has(candidate); n++) {
      candidate = `g-${shortHash(`${cls.id}#${String(n)}`)}`;
    }
    usedClassIds.add(candidate);
    classIdMap[cls.id] = candidate;
  }
  const variableIdMap: Record<string, string> = {};
  collectVarPlaceholders(elements, (token) => {
    if (variableIdMap[token] === undefined) {
      let candidate = `e-gv-${shortHash(token)}`;
      for (let n = 2; existingVariableIds.has(candidate); n++) {
        candidate = `e-gv-${shortHash(`${token}#${String(n)}`)}`;
      }
      existingVariableIds.add(candidate);
      variableIdMap[token] = candidate;
    }
  });
  elements = resolvePlaceholders(elements, variableIdMap, classIdMap).map(normalizeNodeForWire);
  proposedClasses = proposedClasses.map((cls) => ({
    ...cls,
    id: classIdMap[cls.id] ?? cls.id,
    variants: normalizeVariantsForWire(cls.variants) ?? cls.variants,
  }));
  classRebinds = Object.fromEntries(
    Object.entries(classRebinds).map(([id, nodeIds]) => [classIdMap[id] ?? id, nodeIds]),
  );

  // ── (11) INTEGRITY INVARIANTS (contract 17 §1) — pure pre-save checks on the FINAL wire tree ────
  // Runs AFTER placeholder resolution so I1 judges the exact ids a persist would save. EVERY
  // violated invariant (I1 reference closure, I2 base-default safety, I3 total accounting, I4
  // noise-audit) is a CONVERTER BUG and HARD-FAILS the conversion (§1: "violations are converter
  // bugs, hard-fail") — thrown; the tree is never returned, the page path never saves. The single
  // honest exception: the I2 source correspondence rides the POSITIONAL source_path→id map, so when
  // that pairing is UNSOUND (mapped node count != minted id count — pairs past the divergence point
  // would be WRONG, not merely incomplete) I2 is SKIPPED with a warning instead of judging garbage;
  // the verify loop re-checks base-default bleed-through against the RENDERED page on commit.
  const ledgerTierRows = styled.declaration_fallbacks.filter(
    (f) => f.source_path !== NOISE_FILTER_SOURCE_PATH,
  );
  const declarationLedger: DeclFallback[] = [...ledgerTierRows, ...inlineFoldRows, ...pseudoDropRows];
  const ledger: AccountingLedger = {
    // Every `expected`-side count comes from its PRODUCER's own seam tally (style-extract's
    // emission counter, MAP's inline-drop records, NORMALIZE's pseudo-drop records) — never
    // re-derived from the `actual`-side arrays below, so I3 genuinely guards the INTEGRATOR's
    // merge (a loss stream never folded into the ledger breaks the balance — the §5/#10 bug class).
    detected_declarations: styled.detected_declarations,
    inline_fold_effects: (mapped.inline_drops ?? []).length,
    pseudo_drop_effects: normalized.pseudo_drops.length,
    native_count: nativeCount,
    declaration_fallbacks: declarationLedger,
  };
  if (!idMapSound) {
    behaviorWarnings.push(
      'I2 base-default check SKIPPED: the positional source↔element correspondence degraded ' +
        '(mapped node count != minted id count) — base-default bleed-through is re-checked by the ' +
        'post-save verify loop on commit (contract 17 §2)',
    );
  }
  const integrity = runIntegrity({
    elements,
    global_class_ids: [...existingClassOrder, ...proposedClasses.map((c) => c.id)],
    global_classes: { ...existingClassDefs, ...Object.fromEntries(proposedClasses.map((c) => [c.id, c])) },
    ...(idMapSound ? { source_computed: buildSourceComputedMap(classified.ir, idMap) } : {}),
    ledger,
  });
  if (integrity.hardFail) {
    throw new ConvertIntegrityError(integrity.violations);
  }

  // ── (12) DETECTION HONESTY (contract 18 §7, 16 residual) — behavior classes per-node detection
  // cannot see (rAF text mutation / count-ups) still APPEAR, as report-level notes with
  // script-census evidence. Silence is the only forbidden outcome; an empty census is an honest
  // negative and the field is omitted (pre-18 results unchanged).
  const undetectable = detectUndetectableClasses(scriptsCensus, classified.ir);

  return {
    result: {
      elements,
      proposed_classes: proposedClasses,
      proposed_variables: proposedVariables,
      report,
      ...(jsPassthrough !== undefined ? { js_passthrough: jsPassthrough } : {}),
      ...(cssCarry !== undefined ? { css_carry: cssCarry } : {}),
      ...(behaviorWarnings.length > 0 ? { warnings: behaviorWarnings } : {}),
      ...(fontReport !== undefined ? { fonts: fontReport } : {}),
      ...(undetectable.length > 0 ? { undetectable_classes: undetectable } : {}),
    },
    classRebinds,
    existingClassOrder,
    variablesWatermark,
    variableIdMap,
    generation,
    behaviors,
    interactionsAuthored,
    sourcePathIdMap: idMap,
    breakpoints,
    styleSchema,
    declarationLedger,
    droppedTexts: normalized.pseudo_drops
      .map((drop) => stripCssContentQuotes(drop.content))
      .filter((text) => text !== ''),
  };
}

/** Strip the CSS `content` string quotes (`'"→"'` → `→`) for the content-audit drop entries. */
function stripCssContentQuotes(content: string): string {
  return content
    .trim()
    .replace(/^["']/, '')
    .replace(/["']$/, '')
    .trim();
}

/**
 * Families declared by captured `fonts.googleapis.com` link URLs — by construction Google-catalog
 * families, which Elementor's NATIVE atomic font pipeline auto-enqueues on a primed v4 page
 * (contract 18 §7 "Font system strategy"; the PHP-side fix normalizes the collected option values).
 */
function googleCatalogFamilies(links: string[]): string[] {
  const out: string[] = [];
  for (const href of links) {
    let host = '';
    try {
      host = new URL(href, 'https://base.invalid/').hostname;
    } catch {
      continue;
    }
    if (host === 'fonts.googleapis.com') {
      out.push(...extractFamiliesFromFontUrl(href));
    }
  }
  return out;
}

/** Collect every raw `font-family` declaration value the styled nodes considered (carry input). */
function collectUsedFontFamilies(nodes: StyledNode[]): string[] {
  const values: string[] = [];
  const walk = (list: StyledNode[]): void => {
    for (const node of list) {
      for (const decls of Object.values(node.decl_index)) {
        for (const { prop, value } of decls) {
          if (prop.toLowerCase() === 'font-family') {
            values.push(value);
          }
        }
      }
      walk(node.children as StyledNode[]);
    }
  };
  walk(nodes);
  return values;
}

/**
 * Build the I2 source correspondence: minted element id → the source node's parse-captured computed
 * delta (`IrNode.computed` — whitelisted longhands that DIFFER from the parent, so absent props are
 * honestly unjudgeable and skipped by `checkI2`). Paired via the positional `source_path → id` map.
 */
function buildSourceComputedMap(ir: IrNode[], idMap: SourcePathIdMap): SourceComputedMap {
  const map: SourceComputedMap = {};
  const walk = (nodes: IrNode[]): void => {
    for (const node of nodes) {
      const id = idMap[node.source_path];
      if (id !== undefined && Object.keys(node.computed).length > 0) {
        map[id] = node.computed;
      }
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  };
  walk(ir);
  return map;
}

/**
 * Best-effort `source_path → minted element_id` map for the coverage report's id folding. The minted ids
 * are positional (ASSEMBLE mints in document order); we pair them against the mapped nodes' source paths
 * in the same pre-order. A mismatch just leaves the sanitized-passthrough fallback (coverage.ts), so this
 * is honest even when the counts differ — but `sound:false` then tells the integrator the pairing past
 * the divergence point is unreliable (the I2 hard gate is skipped on an unsound correspondence).
 */
function buildSourcePathIdMap(
  mapped: MapResult,
  mintedIds: string[],
): { map: SourcePathIdMap; sound: boolean } {
  const paths: string[] = [];
  const collect = (nodes: MapResult['nodes']): void => {
    for (const n of nodes) {
      paths.push(n.source_path);
      if (n.children.length > 0) {
        collect(n.children);
      }
    }
  };
  collect(mapped.nodes);
  const map: SourcePathIdMap = {};
  const limit = Math.min(paths.length, mintedIds.length);
  for (let i = 0; i < limit; i++) {
    const p = paths[i];
    const id = mintedIds[i];
    if (p !== undefined && id !== undefined) {
      map[p] = id;
    }
  }
  return { map, sound: paths.length === mintedIds.length };
}

/* ───────────────────────────── the FULL pipeline (htmlToPage, commit-gated) ─────────────────── */

/**
 * Run `htmlToTree`, then EITHER (commit:false / default) build an authoritative dry_run-derived diff and
 * return a preview (NOTHING saved), OR (commit:true) gate → confirm → persist. The LOCKED never-auto-
 * commit flow is enforced HERE.
 */
export async function htmlToPage(
  args: HtmlToPageArgs,
  ports: ConvertPorts,
  confirm: Confirmer,
): Promise<HtmlToPageResult> {
  const treeBuild = await htmlToTree(
    {
      html: args.html,
      ...(args.css !== undefined ? { css: args.css } : {}),
      ...(args.generation !== undefined ? { generation: args.generation } : {}),
      ...(args.options !== undefined ? { options: args.options } : {}),
    },
    ports,
    // The SAME elicitation channel serves the (independent) Tier-3 JS confirm (§0.4): the JS
    // confirm fires during the tree build, the commit confirm fires below — two round-trips.
    confirm,
  );
  return persistTreeBuild(
    treeBuild,
    {
      ...(args.post_id !== undefined ? { post_id: args.post_id } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.commit !== undefined ? { commit: args.commit } : {}),
      ...(args.coverage_gate !== undefined ? { coverage_gate: args.coverage_gate } : {}),
      ...(args.verify_gate !== undefined ? { verify_gate: args.verify_gate } : {}),
      ...(args.page_template !== undefined ? { page_template: args.page_template } : {}),
      preview_op_seed: ['convert.dry_run.preview', args.html, args.css ?? ''],
      // Replay identity covers EVERY arg that changes the persisted result: the same html
      // committed with a different title/status/options (e.g. include_js:'bundle' appends the
      // Tier-3 widget) is a DIFFERENT commit, not a replay — deriving from html/css/post_id alone
      // silently replayed the FIRST page (no new page, no JS widget) and the post-save
      // interaction check saw element_missing.
      commit_op_seed: [
        'convert.commit',
        args.html,
        args.css ?? '',
        args.post_id ?? 'new',
        args.title ?? '',
        args.status ?? '',
        treeBuild.generation,
        args.options ?? {},
      ],
      verify_source: composeSourceDoc(args.html, args.css),
      source_label: 'Convert HTML',
    },
    ports,
    confirm,
  );
}

/* ───────────────────────────── the shared persist path (gate → confirm → save → verify) ─────── */

/**
 * The persist-path args shared by every conversion front-end. The SOURCE-specific parts arrive
 * pre-composed: the op_id replay seeds (the HTML path seeds with html/css; the figma path with
 * file_key/node_id/fetched_at) and the verify-loop source (`composeSourceDoc(html, css)` for HTML;
 * the F4 frame-render document for figma).
 */
export interface PersistArgs {
  post_id?: number;
  title?: string;
  /** Publish state for a NEWLY created page (ignored when replacing an existing `post_id`). */
  status?: 'draft' | 'publish' | 'pending' | 'private';
  commit?: boolean;
  coverage_gate?: number;
  /** Contract 17 §3 R3 — the verify-loop divergence threshold (default {@link DEFAULT_VERIFY_GATE}). */
  verify_gate?: number;
  page_template?: 'elementor_canvas' | 'elementor_header_footer' | 'default';
  /**
   * Contract 18 §5 — the a11y gate runs in ADVISORY mode for Figma input (heading levels are
   * INFERRED from type scale + layer names, so blockers like multi-h1 are advisory until the
   * inference precision is measured). Findings still ride the report; they just never gate.
   */
  a11y_advisory?: boolean;
  /** The full `mintOpId` seed for the commit:false preview dry_run. */
  preview_op_seed: unknown[];
  /** The full `mintOpId` seed for the commit (replay identity covers every result-changing arg). */
  commit_op_seed: unknown[];
  /** The verify-loop SOURCE: a raw HTML document string or a URL (`http(s)://`, `file://`). */
  verify_source: string;
  /** The human label opening the commit confirm prompt (`'Convert HTML'` / `'Convert Figma frame …'`). */
  source_label: string;
}

/**
 * Run the LOCKED commit path over a finished {@link TreeBuild} (the shared back half of
 * `htmlToPage` / `figmaToPage`): commit:false preview dry_run → coverage/a11y GATE → elicitation
 * CONFIRM → capability gate → AUTHORITATIVE dry_run (kit untouched on invalid) → variables.batch →
 * classes diff-PUT → deterministic-id swap → create/replace-tree (compensating kit writes on a save
 * failure) → page template → mandatory prime-css → post-save interaction readback → the contract-17
 * §2–3 verify loop with the R3 draft-gate. NEVER auto-commits.
 */
export async function persistTreeBuild(
  treeBuild: TreeBuild,
  persist: PersistArgs,
  ports: ConvertPorts,
  confirm: Confirmer,
): Promise<HtmlToPageResult> {
  const { result, generation } = treeBuild;
  const report = result.report;
  const commit = persist.commit ?? false;
  // The additive contract-16/17 carriers every outcome's result includes (honesty travels with the
  // tree): the Tier-3 script partition, stage warnings, and the font-carry partition (#9). The §1
  // integrity invariants (I1–I4) already hard-failed inside `htmlToTree` if violated.
  const behaviorExtras = {
    ...(result.js_passthrough !== undefined ? { js_passthrough: result.js_passthrough } : {}),
    ...(result.css_carry !== undefined ? { css_carry: result.css_carry } : {}),
    ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
    ...(result.fonts !== undefined ? { fonts: result.fonts } : {}),
    ...(result.integrity !== undefined ? { integrity: result.integrity } : {}),
    ...(result.undetectable_classes !== undefined
      ? { undetectable_classes: result.undetectable_classes }
      : {}),
  };

  // ── commit:false (DEFAULT) — preview + an AUTHORITATIVE dry_run for an honest diff; persist NONE ──
  // `htmlToTree` already resolved every placeholder to a deterministic real id and wire-normalized the
  // tree, so the dry_run sees the EXACT tree a commit would save (modulo the PHP-minted variable ids).
  if (!commit) {
    const dry = await ports.document.dryRun(persist.post_id ?? 0, {
      elements: toRestElements(result.elements),
      generation,
      want_preview: false,
      op_id: mintOpId(persist.preview_op_seed),
    });
    return {
      status: 'preview',
      ...(persist.post_id !== undefined ? { id: persist.post_id } : {}),
      diff: shapeDiff(dry.diff),
      preview_url: dry.preview_url ?? '',
      report,
      committed: false,
      css_primed: false,
      ...behaviorExtras,
    };
  }

  // ── commit:true — (1) GATE (coverage / a11y blockers). A deny is a clean REFUSAL, not an error ───
  const gate = evaluateGate(report, {
    coverage_gate: persist.coverage_gate ?? DEFAULT_COVERAGE_GATE,
    require_no_blockers: !(persist.a11y_advisory ?? false),
  });
  if (!gate.allowed) {
    return {
      status: 'gate_denied',
      ...(persist.post_id !== undefined ? { id: persist.post_id } : {}),
      diff: emptyDiff(),
      preview_url: '',
      report,
      committed: false,
      css_primed: false,
      gate_reasons: gate.reasons,
      ...behaviorExtras,
    };
  }

  // ── (2) elicitation CONFIRM (required when committing). A decline → a clean non-error result ─────
  const confirmed = await confirm(
    `${persist.source_label} and ${persist.post_id !== undefined ? `REPLACE page ${String(persist.post_id)}` : 'CREATE a new page'} ` +
      `(coverage ${report.coverage.pct_native.toFixed(1)}% native, ` +
      `${result.proposed_classes.length} new class(es), ${result.proposed_variables.length} new variable(s))?`,
  );
  if (!confirmed) {
    return {
      status: 'declined',
      ...(persist.post_id !== undefined ? { id: persist.post_id } : {}),
      diff: emptyDiff(),
      preview_url: '',
      report,
      committed: false,
      css_primed: false,
      ...behaviorExtras,
    };
  }

  // ── (3) capability gate for the class diff-PUT (probe BEFORE attempting it) ──────────────────────
  if (result.proposed_classes.length > 0) {
    const caps = await ports.schema.capabilities();
    if (!caps.can_update_class) {
      throw new ConvertCapabilityError(
        'Cannot create the proposed global classes: the connected user lacks the ' +
          'elementor_global_classes_update_class capability. The companion plugin grants UPDATE_CLASS ' +
          'on activation (run the migrate-to-posts migration / re-activate); re-probe site.capabilities.',
      );
    }
  }

  // ── (4) AUTHORITATIVE dry_run BEFORE any kit write. valid:false → isError, kit UNTOUCHED ────────
  // The tree already carries its FINAL deterministic class ids + deterministic variable ids
  // (htmlToTree step 10), so the dry_run validates the exact tree the save persists (modulo the
  // PHP-minted variable ids). Running it before `variables.batch`/the classes diff-PUT means an
  // invalid conversion writes NOTHING — no orphaned classes/variables to clean up, and the 'invalid'
  // message ("nothing was saved") is honest about the kit too.
  // Replay identity covers EVERY arg that changes the persisted result (the caller composed the
  // full seed — see the `PersistArgs.commit_op_seed` doc and the htmlToPage composition).
  const opId = mintOpId(persist.commit_op_seed);
  const dry = await ports.document.dryRun(persist.post_id ?? 0, {
    elements: toRestElements(result.elements),
    generation,
    want_preview: false,
    op_id: opId,
  });
  if (!dry.valid) {
    return {
      status: 'invalid',
      ...(persist.post_id !== undefined ? { id: persist.post_id } : {}),
      diff: shapeDiff(dry.diff),
      preview_url: '',
      report,
      committed: false,
      css_primed: false,
      errors: dry.errors,
      ...behaviorExtras,
    };
  }

  // ── (5) create proposed VARIABLES (batch + watermark) → PHP-minted ids ──────────────────────────
  const varCommit = await commitVariables(treeBuild, ports);

  // ── (6) create proposed CLASSES (diff-PUT) under their DETERMINISTIC ids (replay-stable) ────────
  const classCommit = await commitClasses(treeBuild, ports);

  // ── (7) swap the deterministic `e-gv-*` variable ids for the PHP-minted ones IN ONE PASS ────────
  const resolvedTree =
    Object.keys(varCommit.idMap).length > 0
      ? resolvePlaceholders(result.elements, varCommit.idMap, {})
      : result.elements;

  // ── (8) PERSIST: page.create (new) OR replace-tree (existing, fresh base_hash). A save failure ──
  // AFTER the kit writes landed triggers a best-effort COMPENSATION (delete the just-added classes +
  // variables) so a failed/timed-out commit doesn't orphan kit entries; the save error then rethrows.
  let pageId: number;
  let saveDiff: RestDiff;
  let previewUrl: string;
  let cssPrimedFromSave: boolean;
  let replay = false;
  let remappedIds: Record<string, string> = {};
  // The status the page is meant to HOLD after a successful, gate-passing commit. New page: the
  // requested status (default draft). Existing page: its current status when readable from the
  // document settings, else 'publish' — the FAIL-CLOSED assumption (if it was actually a draft,
  // an R3 revert-to-draft is a no-op; assuming draft on a live page would skip the revert).
  let finalStatus: string = persist.post_id === undefined ? (persist.status ?? 'draft') : 'publish';
  try {
    if (persist.post_id === undefined) {
      // NEW page: create a blank doc, then save the tree into it.
      const created = await ports.document.create({
        ...(persist.title !== undefined ? { title: persist.title } : {}),
        ...(persist.status !== undefined ? { status: persist.status } : {}),
        op_id: mintOpId(['convert.create', opId]),
      });
      pageId = created.id;
      const saved = await ports.document.save(pageId, {
        elements: toRestElements(resolvedTree),
        op_id: opId,
        prime_css: false, // we run the mandatory prime explicitly below (S01 sequence)
      });
      saveDiff = saved.diff;
      previewUrl = saved.preview_url;
      cssPrimedFromSave = saved.css_primed;
      replay = isReplay(saved);
      remappedIds = saved.remapped_ids ?? {};
    } else {
      // EXISTING page: read a FRESH base_hash right before the optimistic-lock replace-tree.
      const structure = await ports.document.getStructure(persist.post_id);
      const currentStatus = structure.settings['post_status'];
      if (typeof currentStatus === 'string' && currentStatus !== '') {
        finalStatus = currentStatus;
      }
      const replaced = await ports.document.replaceTree(persist.post_id, {
        elements: toRestElements(resolvedTree),
        base_hash: structure.base_hash,
        op_id: opId,
        prime_css: false,
      });
      pageId = replaced.id;
      saveDiff = replaced.diff;
      previewUrl = replaced.preview_url;
      cssPrimedFromSave = replaced.css_primed;
      replay = isReplay(replaced);
      remappedIds = replaced.remapped_ids ?? {};
    }
  } catch (error: unknown) {
    await compensateKitWrites(ports, classCommit, varCommit);
    throw error;
  }

  // ── (8b) PAGE TEMPLATE — the source is a full document with its own page chrome, so a NEW page
  // renders on the blank canvas template (the theme's content column otherwise repaints the layout
  // and the §2 verify loop measures the THEME, not the conversion). Explicit `page_template` always
  // wins (incl. on an existing post_id); `'default'` (the WP default-template slug) opts back into
  // the theme template, so nothing is written. A failed write is a WARNING, never a silent skip —
  // the verify loop below still judges whatever actually renders.
  const templateWarnings: string[] = [];
  const wantedTemplate =
    persist.page_template ?? (persist.post_id === undefined ? 'elementor_canvas' : undefined);
  if (wantedTemplate !== undefined && wantedTemplate !== 'default') {
    try {
      await ports.document.updateSettings(pageId, { settings: { template: wantedTemplate } });
    } catch (error: unknown) {
      templateWarnings.push(
        `page template "${wantedTemplate}" could not be set (${(error as Error).message}) — the ` +
          'page renders on the theme template; the verification below judges that render',
      );
    }
  }

  // ── (9) PRIME CSS (mandatory, S01). Always attempt; report `css_primed` HONESTLY. ───────────────
  let cssPrimed = cssPrimedFromSave;
  try {
    const primed = await ports.document.primeCss(pageId, {
      op_id: mintOpId(['convert.prime', opId]),
    });
    cssPrimed = primed.css_primed;
  } catch {
    // CSS_PRIME_FAILED is retryable; the save already landed, so we report committed:true honestly with
    // css_primed:false rather than failing the whole convert (the caller can re-prime).
    cssPrimed = false;
  }

  // ── (10) POST-SAVE INTERACTIONS READBACK (contract 16 §4 / §8 invariant 2). PHP sanitizes the ────
  // authored interactions with SILENT drop semantics (S08), so tier 2 is PROVISIONAL until the saved
  // document is read back: any element whose authored items did not fully survive downgrades its
  // tier-2 behaviors to tier 4 in the report (never fake success). Authored element ids are translated
  // through the save's `remapped_ids` first (the writer may remap ids on save).
  let finalReport = report;
  let postSaveChecks: PostSaveInteractionCheck[] | undefined;
  const interactionWarnings: string[] = [];
  if (treeBuild.interactionsAuthored.length > 0) {
    const authoredOriginalIds = treeBuild.interactionsAuthored.map((a) => a.element_id);
    const authoredRemapped = treeBuild.interactionsAuthored.map((a) => ({
      ...a,
      element_id: remappedIds[a.element_id] ?? a.element_id,
    }));
    let statusByOriginalId: Map<string, PostSaveInteractionCheck['status']>;
    try {
      const readBack = await ports.document.getStructure(pageId);
      postSaveChecks = postSaveAssert(
        authoredRemapped,
        readBack.elements as unknown as ElementNode[],
      );
      // P1-c (contract 18 §7): audit the FULL frontend wiring chain on the saved tree — blob
      // `elementId` ↔ stamped `data-interaction-id` correspondence AND that every item will
      // actually animate (no silent runtime no-op). A broken leg is PINNED here with its exact
      // problem rows instead of being re-debugged live; the verify loop's behavioral probe
      // (below) then asserts the rendered truth.
      const wiring = diagnoseInteractionWiring(
        authoredRemapped,
        readBack.elements as unknown as ElementNode[],
      );
      if (!wiring.ok) {
        interactionWarnings.push(
          `P1-c interaction wiring diagnosis FAILED (contract 18 §7): ${wiring.summary}`,
          ...wiring.findings
            .filter((f) => f.status !== 'wired')
            .flatMap((f) => f.problems.map((p) => `interaction wiring [${f.element_id}]: ${p}`)),
        );
      }
      statusByOriginalId = new Map(
        postSaveChecks.map((check, i) => [authoredOriginalIds[i] ?? check.element_id, check.status]),
      );
    } catch {
      // The readback failed (transient) — survival is UNVERIFIED, so tier 2 cannot be claimed
      // (§8 invariant 2). Downgrade conservatively; the checks list is omitted (nothing was read).
      statusByOriginalId = new Map(authoredOriginalIds.map((id) => [id, 'element_missing']));
    }
    const downgraded = downgradeUnsurvivedInteractions(
      treeBuild.behaviors,
      treeBuild.sourcePathIdMap,
      statusByOriginalId,
    );
    if (downgraded !== null) {
      finalReport = { ...report, behavior: buildBehaviorCoverage(downgraded) };
    }
  }

  // ── (11) VERIFY LOOP (contract 17 §2–3) — look at what was saved, repair (R1), gate (R3) ────────
  // The converter is not done when it saves: render source vs the saved+primed page at every active
  // breakpoint, diff matched elements with cause attribution (V1), audit layout (V2), pixel-score
  // (V3); apply the bounded MECHANICAL repairs through the normal save path (backup + base_hash,
  // ≤ MAX_REPAIR_ROUNDS), then enforce the R3 gate: a V2 failure or a divergence count over
  // `verify_gate` reverts the page to draft — a bad conversion never silently publishes. EVERY
  // commit gets the loop: a non-publish page (the default draft commit) is TEMPORARILY published
  // for the render and restored afterwards. The gate FAILS CLOSED — when the loop itself cannot
  // run (browser fault / no preview URL) `verifyAndRepair` secures the page to draft before
  // rethrowing, so a publish commit never stays live unverified; the fault is REPORTED via
  // warnings, never silently skipped.
  const verifyWarnings: string[] = [];
  let verification: ConvertVerification | undefined;
  try {
    verification = await verifyAndRepair(ports, treeBuild, {
      pageId,
      pageUrl: publicPageUrl(previewUrl, pageId),
      source: persist.verify_source,
      threshold: persist.verify_gate ?? DEFAULT_VERIFY_GATE,
      opId,
      finalStatus,
      remappedIds,
      // §7 P1-e — the hardened-loop inputs: honest-drop text entries for the content-presence
      // audit, and one behavioral probe target per element the Tier-2 stage authored onto
      // (translated through the save's id remap; scrollIn targets get the strict ramp assert).
      droppedTexts: treeBuild.droppedTexts,
      interactionTargets: buildInteractionProbeTargets(
        treeBuild.result.elements,
        treeBuild.interactionsAuthored,
        remappedIds,
      ),
    });
    if (verification.gate.action === 'revert_failed') {
      verifyWarnings.push(
        'R3 gate FAIL-CLOSED FAILURE: the verification gate failed AND the page status could not ' +
          'be reverted — the page is PUBLICLY VISIBLE and unverified; set it to draft manually ' +
          '(contract 17 §3)',
      );
    }
  } catch (error: unknown) {
    verifyWarnings.push(
      `post-save verification loop did NOT run (${(error as Error).message}) — the conversion is ` +
        'saved but UNVERIFIED; verify the page manually (contract 17 §2)',
    );
  }
  const allWarnings = [
    ...(result.warnings ?? []),
    ...templateWarnings,
    ...interactionWarnings,
    ...verifyWarnings,
  ];

  return {
    status: 'committed',
    id: pageId,
    diff: shapeDiff(saveDiff),
    preview_url: previewUrl,
    report: finalReport,
    committed: true,
    css_primed: cssPrimed,
    ...behaviorExtras,
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    ...(verification !== undefined ? { verification } : {}),
    ...(postSaveChecks !== undefined ? { interactions_post_save: postSaveChecks } : {}),
    ...(classCommit.duplicatedLabels !== undefined &&
    Object.keys(classCommit.duplicatedLabels).length > 0
      ? { duplicated_labels: classCommit.duplicatedLabels }
      : {}),
    ...(replay ? { idempotent_replay: true } : {}),
  };
}

/* ───────────────────────────── behavior tiering glue (contract 16 §4/§5/§8) ─────────────────── */

/**
 * The frozen tier-3/4 reason strings the ORCHESTRATOR owns for `custom-js` behaviors (the §5
 * passthrough decision is pipeline-level — MAP and the interactions stage never see it). Exported so
 * tests pin the exact wording ("never a silent lie", §0.2).
 */
export const JS_PASSTHROUGH_TIER_REASONS = {
  bundled:
    'page scripts bundled verbatim into the JS-passthrough html widget (include_js:bundle) — scripts are opaque, behavior assumed to ride the bundle',
  not_requested:
    "JS passthrough not requested (include_js:'none', the default) — script-driven behavior dropped",
  declined:
    'JS passthrough declined at the elicitation confirm — script-driven behavior dropped (reported, §5)',
  blocked:
    'JS passthrough blocked: the site lacks unfiltered_html (WP strips <script>) — script-driven behavior dropped',
  nothing_bundled:
    'JS passthrough requested but no script was bundleable (denylist/unresolvable/empty census) — script-driven behavior dropped',
} as const;

/** The §8.2 downgrade reason template (post-save sanitizer drop / readback failure). */
function postSaveDowngradeReason(status: PostSaveInteractionCheck['status']): string {
  return (
    `authored native interaction did NOT survive the post-save readback (${status}) — PHP ` +
    `Validation::sanitize drops invalid items silently (S08); downgraded per contract 16 §8 invariant 2`
  );
}

/** Stable lookup key for matching a MAP-collected behavior to its interactions-stage report clone. */
function behaviorMergeKey(b: DetectedBehavior): string {
  return `${b.kind}|${b.nodeIds.join('>')}`;
}

/**
 * Merge the tier-2 stage's TIERED report entries (`emitInteractions().report`) into the MAP-collected
 * behavior list: every UNTIERED `entrance-animation`/`hover-effect` entry is replaced by its tiered
 * clone (matched by kind + nodeIds; duplicates consumed in document order). Behaviors MAP already
 * tiered (tier-1 conversions, tier-4 orphans on replaced hosts) are kept verbatim — the interactions
 * stage saw the PRE-map IR, so its entries for replaced-subtree nodes are superseded by MAP's. A
 * lookup miss falls to an honest tier 4 (a silent untiered behavior would HARD-fail coverage, §8.1).
 */
function mergeInteractionTiers(
  base: DetectedBehavior[],
  tiered: DetectedBehavior[],
): DetectedBehavior[] {
  const byKey = new Map<string, DetectedBehavior[]>();
  for (const b of tiered) {
    const key = behaviorMergeKey(b);
    const list = byKey.get(key) ?? [];
    list.push(b);
    byKey.set(key, list);
  }
  return base.map((b) => {
    if (b.tier !== undefined || (b.kind !== 'entrance-animation' && b.kind !== 'hover-effect')) {
      return b;
    }
    const match = byKey.get(behaviorMergeKey(b))?.shift();
    return (
      match ?? {
        ...b,
        tier: 4 as const,
        reason:
          'no tier-2 outcome recorded for this behavior (interactions-stage candidate miss) — dropped',
      }
    );
  });
}

/**
 * Tier every still-untiered `custom-js` behavior from the §5 passthrough outcome: tier 3 when the
 * bundle widget was actually emitted (scripts are opaque — the behavior is assumed to ride it),
 * else tier 4 with the honest decision reason. Never touches behaviors other stages tiered.
 */
function tierCustomJsBehaviors(
  behaviors: DetectedBehavior[],
  pass: PassthroughResult,
  includeJs: IncludeJs | undefined,
  declined: boolean,
): DetectedBehavior[] {
  if (!behaviors.some((b) => b.kind === 'custom-js' && b.tier === undefined)) {
    return behaviors;
  }
  let tier: 3 | 4;
  let reason: string;
  if (pass.widgetNode !== null) {
    tier = 3;
    reason = JS_PASSTHROUGH_TIER_REASONS.bundled;
  } else {
    tier = 4;
    reason = declined
      ? JS_PASSTHROUGH_TIER_REASONS.declined
      : includeJs !== 'bundle'
        ? JS_PASSTHROUGH_TIER_REASONS.not_requested
        : pass.report.blocked_reason !== undefined
          ? JS_PASSTHROUGH_TIER_REASONS.blocked
          : JS_PASSTHROUGH_TIER_REASONS.nothing_bundled;
  }
  return behaviors.map((b) =>
    b.kind === 'custom-js' && b.tier === undefined ? { ...b, tier, reason } : b,
  );
}

/**
 * §8 invariant 2: downgrade every tier-2 behavior hosted on an element whose authored interactions
 * did not fully survive the post-save readback (status != 'survived'). Behaviors are folded to
 * elements via `sourcePathIdMap` (behavior `nodeIds` are pre-assembly source paths; the status map is
 * keyed by the PRE-remap element ids the tree authored). Returns the downgraded list, or `null` when
 * nothing changed (the original report stands).
 */
function downgradeUnsurvivedInteractions(
  behaviors: DetectedBehavior[],
  sourcePathIdMap: SourcePathIdMap,
  statusByOriginalId: Map<string, PostSaveInteractionCheck['status']>,
): DetectedBehavior[] | null {
  let changed = false;
  const out = behaviors.map((b) => {
    if (b.tier !== 2) {
      return b;
    }
    const failedStatus = b.nodeIds
      .map((path) => statusByOriginalId.get(sourcePathIdMap[path] ?? ''))
      .find((s) => s !== undefined && s !== 'survived');
    if (failedStatus === undefined) {
      return b;
    }
    changed = true;
    return { ...b, tier: 4 as const, reason: postSaveDowngradeReason(failedStatus) };
  });
  return changed ? out : null;
}

/* ───────────────────────────── post-save verify loop + R1 repairs + R3 gate (contract 17 §2–3) ─ */

/** The R3 default divergence threshold (`verify_gate`): more than this many V1 rows fails the gate. */
export const DEFAULT_VERIFY_GATE = 25;

/** One applied/skipped R1 repair (the loop's `RepairPatch`, unchanged — `cause` stays mechanical). */
export type ConvertRepairPatch = RepairPatch;

/** The `verification` carrier on a committed `HtmlToPageResult` (contract 17 §2–3, additive). */
export interface ConvertVerification {
  /** The FINAL loop pass's V1 divergence rows (post-repair — R2: a fixing agent starts here). */
  divergences: Divergence[];
  /** V3 pixelmatch scores per breakpoint (a failed diff is an honest `{ratio:1, error}` row). */
  pixel_scores: PixelScoreEntry[];
  /** §7 P1-e/P1-a — the content-presence audit (gates: a silently-missing source string fails). */
  content_audit: ContentAudit;
  /** §7 P1-e — the source-vs-converted rendered-element-count deltas (report-only, never gates alone). */
  element_counts: ElementCountDelta[];
  /**
   * §7 P1-e/P1-c — behavioral probes for the authored interactions (per-frame opacity sampling;
   * a scrollIn element that shows no `<1 → 1` ramp FAILS its probe and the gate). Empty when the
   * conversion authored no interactions.
   */
  behavior_probes: BehaviorProbe[];
  /** §7 P1-d — the cause-attribution summary over `divergences` (target ratio ≥0.8, report-only). */
  cause_stats: CauseStats;
  /** The R1 repair record: what was applied through the normal save path, what was NOT mechanical. */
  repairs: {
    applied: ConvertRepairPatch[];
    /** Patches the loop suggested but the applier could not land mechanically (node missing /
     *  classic node / value not natively classifiable) — left for the report, never guessed at. */
    skipped: ConvertRepairPatch[];
    rounds: number;
  };
  /**
   * The R3 gate verdict. `action:'reverted_to_draft'` = a failing PUBLISH commit was set back to
   * draft; `action:'revert_failed'` = the gate failed AND the status write failed (after a retry)
   * — the page is publicly visible and unverified, surfaced as a machine-readable verdict plus a
   * top-level warning (never just a reason string).
   */
  gate: {
    pass: boolean;
    v2_pass: boolean;
    divergence_count: number;
    threshold: number;
    action: 'none' | 'reverted_to_draft' | 'revert_failed';
    reasons: string[];
  };
}

/** The per-commit inputs `verifyAndRepair` needs beyond the tree build. */
interface VerifyRunArgs {
  pageId: number;
  pageUrl: string;
  /** The verify-loop SOURCE (already composed: an HTML doc string or a `http(s)://`/`file://` URL). */
  source: string;
  threshold: number;
  opId: string;
  /**
   * The status the page must HOLD after a gate-PASSING commit ('publish' for publish commits /
   * live replaced pages; 'draft'/'pending'/'private' otherwise). A non-publish page is TEMPORARILY
   * published for the loop render and restored; a gate FAILURE always ends at 'draft' (§3 R3).
   */
  finalStatus: string;
  /** The save's id remap (the writer may regenerate ids) — translates the V1 source-id matcher. */
  remappedIds: Record<string, string>;
  /** §7 P1-e — honest-drop text entries for the loop's content-presence audit. */
  droppedTexts: string[];
  /** §7 P1-e/P1-c — the authored-interaction probe targets (SAVED ids, post-remap). */
  interactionTargets: InteractionProbeTarget[];
}

/**
 * The UNAUTHENTICATED page URL the loop renders. The save's `preview_url`
 * (`?page_id=N&preview=true`) is auth-gated for non-published pages (an anonymous Playwright
 * context gets the theme 404 — live-verified on the dev stack), so the loop targets the plain
 * `?page_id=N` form (universal regardless of permalink structure; renders iff the page is
 * publicly visible). A page that is NOT publicly visible renders zero Elementor elements and the
 * loop reports that honestly (see the root-element check in {@link verifyAndRepair}).
 */
function publicPageUrl(previewUrl: string, pageId: number): string {
  if (previewUrl === '') {
    return '';
  }
  try {
    return `${new URL(previewUrl).origin}/?page_id=${String(pageId)}`;
  } catch {
    return previewUrl;
  }
}

/** Inline the caller-supplied CSS into the source document (the loop renders ONE source string). */
function composeSourceDoc(html: string, css?: string): string {
  if (css === undefined || css === '') {
    return html;
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `<style>${css}</style></head>`);
  }
  return `<style>${css}</style>\n${html}`;
}

/**
 * Set the page's `post_status` through the settings route, retrying once — the R3 fail-closed
 * write. Returns whether the status landed (a `false` is surfaced LOUDLY by the caller).
 */
async function trySetStatus(
  ports: ConvertPorts,
  pageId: number,
  status: string,
  attempts = 2,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await ports.document.updateSettings(pageId, { settings: { post_status: status } });
      return true;
    } catch {
      // retry once; persistent failure is the caller's loud-report case
    }
  }
  return false;
}

/**
 * The id of the first ATOMIC node in the converted tree — the page-root wrapper the
 * `missing_overflow_x` repair targets. Classic html widgets (the PREPENDED #9 font carry, the
 * appended Tier-3 JS bundle) are skipped: they cannot carry an atomic local style, so targeting
 * them silently voids every overflow repair (`applyRepairPatches` rejects non-atomic nodes).
 */
function findRepairRootId(elements: ElementNode[]): string | undefined {
  for (const node of elements) {
    if (isAtomicStyledNode(node)) {
      return node.id;
    }
  }
  return undefined;
}

/**
 * Run the contract-17 §2 verification loop against the SAVED + PRIMED page, apply the bounded R1
 * repairs through the NORMAL save path (fresh `base_hash` + op_id + mandatory re-prime), re-verify
 * (at most {@link MAX_REPAIR_ROUNDS} rounds), then enforce the §3 R3 commit gate. A NON-publish
 * page (the default draft commit) is TEMPORARILY published so the loop can render it anonymously,
 * and ends back at `finalStatus` (gate pass) or `draft` (gate fail — for a publish commit that is
 * the revert; §3: "commit:true + passing loop = publish"). FAIL-CLOSED throughout: when the loop
 * itself faults mid-flight the page is secured to a non-public status BEFORE the error propagates
 * (the caller reports it as a warning, never a silent skip), and a status write that still fails
 * after a retry is a machine-readable `action:'revert_failed'` verdict, never just a reason string.
 */
async function verifyAndRepair(
  ports: ConvertPorts,
  treeBuild: TreeBuild,
  run: VerifyRunArgs,
): Promise<ConvertVerification> {
  const wantsLive = run.finalStatus === 'publish';
  let temporarilyPublished = false;
  let loop: VerifyLoopResult;
  const applied: RepairPatch[] = [];
  const skipped: RepairPatch[] = [];
  let rounds = 0;
  try {
    if (run.pageUrl === '') {
      throw new Error('the save returned no preview URL to verify against');
    }
    // A non-published page is not anonymously renderable (the theme 404) — publish it for the
    // duration of the loop; the gate below ALWAYS restores a non-public end status.
    if (!wantsLive) {
      await ports.document.updateSettings(run.pageId, {
        settings: { post_status: 'publish' },
      });
      temporarilyPublished = true;
    }
    // V1 matches on the rendered `data-id`s — translate the pre-save minted ids through the save's
    // id remap so the source correspondence survives a writer-side id regeneration.
    const idMap: SourcePathIdMap = Object.fromEntries(
      Object.entries(treeBuild.sourcePathIdMap).map(([path, id]) => [
        path,
        run.remappedIds[id] ?? id,
      ]),
    );
    // The overflow-repair target is the REAL page root from the tree (the first ATOMIC node —
    // never the prepended font-carry html widget, which the repair applier cannot patch).
    const treeRootId = findRepairRootId(treeBuild.result.elements);
    const rootNodeId =
      treeRootId !== undefined ? (run.remappedIds[treeRootId] ?? treeRootId) : undefined;
    const input: VerifyLoopInput = {
      sourceUrlOrHtml: run.source,
      pageUrl: run.pageUrl,
      breakpoints: treeBuild.breakpoints,
      idMap,
      ledger: treeBuild.declarationLedger,
      ...(rootNodeId !== undefined ? { rootNodeId } : {}),
      // §7 P1-e — the hardened-loop blind-spot inputs (content audit + behavioral probes).
      droppedTexts: run.droppedTexts,
      ...(run.interactionTargets.length > 0 ? { interactions: run.interactionTargets } : {}),
    };

    loop = await runVerifyLoop({ browser: ports.browser }, input);
    // A page that renders ZERO Elementor elements (every audit's root `data-id` empty) cannot be
    // verified — garbage-in; fail the loop honestly instead (the caller reports the warning).
    if (loop.layoutAudits.length > 0 && loop.layoutAudits.every((a) => a.root_element === '')) {
      throw new Error(
        `the converted page rendered no Elementor elements at ${run.pageUrl} — the page is not ` +
          'publicly visible (or the render failed); verify via convert.fidelity_check',
      );
    }
    while (loop.repairs.length > 0 && rounds < MAX_REPAIR_ROUNDS) {
      rounds += 1;
      const outcome = await applyRepairPatches(
        ports,
        run.pageId,
        loop.repairs,
        treeBuild.styleSchema,
        run.opId,
        rounds,
      );
      skipped.push(...outcome.skipped);
      if (outcome.applied.length === 0) {
        break; // nothing landed — re-verifying would loop on the same patches
      }
      applied.push(...outcome.applied);
      loop = await runVerifyLoop({ browser: ports.browser }, input);
    }
  } catch (error: unknown) {
    // FAIL CLOSED (contract 17 §3): a page that could not be verified never stays publicly
    // visible. Secure it to a non-public status before the error propagates.
    const target = wantsLive ? 'draft' : run.finalStatus;
    const mustSecure = wantsLive || temporarilyPublished;
    const secured = !mustSecure || (await trySetStatus(ports, run.pageId, target));
    throw new Error(
      `${(error as Error).message}${
        secured
          ? mustSecure
            ? ` — the page was secured to "${target}" (fail-closed: an unverified conversion never stays published, contract 17 §3)`
            : ''
          : ' — AND the fail-closed status revert FAILED: the page is PUBLICLY VISIBLE and UNVERIFIED; set it to draft manually'
      }`,
    );
  }

  // §6 F6 — the gate consumes the HARDENED verify loop: the v17.0 inputs (V2 layout audits +
  // the V1 divergence threshold) PLUS the §7 P1-e blind-spot audits (content presence, behavioral
  // probes). A verdict from the pre-17.1 loop is not valid; `evaluateVerifyGate` is the single
  // composition point (verify-loop.ts) so the corpus and the pipeline judge identically.
  const verdict = evaluateVerifyGate(loop, { divergenceThreshold: run.threshold });
  const v2Pass = loop.layoutAudits.every((a) => a.pass);
  const reasons: string[] = [...verdict.reasons];
  const pass = verdict.pass;
  // The status the page must END at: a passing loop earns `finalStatus`; a failing one ends at
  // draft (R3 — never silently published). The page is CURRENTLY published (either the commit
  // itself or the temporary publish above), so any non-publish end status needs a write.
  const endStatus = pass ? run.finalStatus : 'draft';
  let action: ConvertVerification['gate']['action'] = 'none';
  if (endStatus !== 'publish') {
    const ok = await trySetStatus(ports, run.pageId, endStatus);
    if (!ok) {
      action = 'revert_failed';
      reasons.push(
        `R3 gate: FAILED to set the page back to "${endStatus}" (after a retry) — the page is ` +
          'PUBLICLY VISIBLE; set it to draft manually',
      );
    } else if (!pass && wantsLive) {
      action = 'reverted_to_draft';
      reasons.push(
        'R3 gate: the page was reverted to DRAFT — a bad conversion never silently publishes ' +
          '(contract 17 §3); fix the divergences and publish explicitly',
      );
    } else if (!pass) {
      reasons.push(
        `R3 gate: the page STAYS "${endStatus}" (it was published only temporarily for the ` +
          'verification render) until the divergences are fixed',
      );
    } else {
      reasons.push(
        `verification passed — the page was temporarily published for the loop render and ` +
          `restored to "${endStatus}"`,
      );
    }
  } else if (!pass) {
    // Unreachable by construction (a failing gate ends at 'draft'); kept as a defensive report.
    reasons.push('R3 gate: the page stays draft until the divergences are fixed');
  }

  return {
    divergences: loop.divergences,
    pixel_scores: loop.pixelScore,
    content_audit: loop.contentAudit,
    element_counts: loop.elementCounts,
    behavior_probes: loop.behaviorProbes,
    cause_stats: loop.causeStats,
    repairs: { applied, skipped, rounds },
    gate: {
      pass,
      v2_pass: v2Pass,
      divergence_count: loop.divergences.length,
      threshold: run.threshold,
      action,
      reasons,
    },
  };
}

/* ───────────────────────────── P1-e/P1-c — interaction probe targets ────────────────────────── */

/**
 * Build one behavioral probe target per element the Tier-2 stage authored interactions onto
 * (contract 18 §7 P1-e): the SAVED element id (translated through the writer's `remapped_ids`,
 * exactly like `postSaveAssert`) + the authored trigger decoded from the tree's own S08 blob.
 * `scrollIn` wins when any item carries it — the strict `<1 → 1` opacity-ramp assertion is the
 * P1-c corpus guard. Pure; an undecodable blob degrades to a `'load'` probe (end-state visible).
 */
export function buildInteractionProbeTargets(
  elements: ElementNode[],
  authored: AuthoredInteractions[],
  remappedIds: Record<string, string>,
): InteractionProbeTarget[] {
  const byId = new Map<string, ElementNode>();
  const walk = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      byId.set(node.id, node);
      const children = (node as { elements?: ElementNode[] }).elements;
      if (Array.isArray(children) && children.length > 0) {
        walk(children);
      }
    }
  };
  walk(elements);
  return authored.map((a) => {
    const el = byId.get(a.element_id);
    const items =
      el === undefined
        ? []
        : (decodeInteractionItems((el as { interactions?: unknown }).interactions) ?? []);
    const triggers = items
      .map(decodeItemTrigger)
      .filter((t): t is string => t !== null && t !== '');
    const trigger = triggers.includes('scrollIn') ? 'scrollIn' : (triggers[0] ?? 'load');
    return { element_id: remappedIds[a.element_id] ?? a.element_id, trigger };
  });
}

/** Decode one S08 interaction item's trigger (typed-envelope or bare string — runtime parity). */
function decodeItemTrigger(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const wrapped = item as { $$type?: unknown; value?: unknown };
  const payload =
    wrapped.$$type === 'interaction-item' &&
    typeof wrapped.value === 'object' &&
    wrapped.value !== null
      ? (wrapped.value as Record<string, unknown>)
      : (item as Record<string, unknown>);
  const trigger = payload['trigger'];
  if (typeof trigger === 'string') {
    return trigger;
  }
  if (typeof trigger === 'object' && trigger !== null) {
    const inner = (trigger as { value?: unknown }).value;
    return typeof inner === 'string' ? inner : null;
  }
  return null;
}

/** One repair round's outcome (what landed natively vs what was not mechanically applicable). */
interface RepairApplication {
  applied: RepairPatch[];
  skipped: RepairPatch[];
}

/**
 * Apply one round of R1 patches via the NORMAL save path: read the live tree + `base_hash`, emit
 * each patch's CSS value as a TYPED prop into the target node's base variant (classified against
 * the live Style-Schema — a value that does not classify natively is SKIPPED, not guessed), then
 * `replace-tree` (backup + optimistic lock) and re-prime the CSS. Pure-mechanical only (§3 R1).
 */
async function applyRepairPatches(
  ports: ConvertPorts,
  pageId: number,
  repairs: RepairPatch[],
  schema: StyleSchema,
  opId: string,
  round: number,
): Promise<RepairApplication> {
  const applied: RepairPatch[] = [];
  const skipped: RepairPatch[] = [];
  const structure = await ports.document.getStructure(pageId);
  const elements = JSON.parse(JSON.stringify(structure.elements)) as ElementNode[];

  // Index nodes by id (saved pages render bare-hex `data-id`s; minted tree ids may carry `e-`).
  const byId = new Map<string, ElementNode>();
  const index = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      byId.set(node.id, node);
      if (Array.isArray(node.elements) && node.elements.length > 0) {
        index(node.elements);
      }
    }
  };
  index(elements);

  for (const patch of repairs) {
    const node =
      byId.get(patch.nodeId) ??
      byId.get(patch.nodeId.replace(/^e-/, '')) ??
      byId.get(`e-${patch.nodeId}`);
    if (node === undefined || !isAtomicStyledNode(node)) {
      skipped.push(patch);
      continue;
    }
    // `native` and the `*-candidate` kinds are all natively PLACEABLE (a candidate is a native
    // verdict that could ALSO become a variable/class — the repair just emits the literal).
    const verdict = classifyDeclaration(patch.prop, patch.value, schema);
    if (
      verdict.kind === 'unmappable' ||
      verdict.atomic_prop === undefined ||
      verdict.typed_value === undefined
    ) {
      skipped.push(patch);
      continue;
    }
    emitRepairProp(node, verdict.atomic_prop, verdict.typed_value);
    applied.push(patch);
  }

  if (applied.length > 0) {
    await ports.document.replaceTree(pageId, {
      elements: toRestElements(elements),
      base_hash: structure.base_hash,
      op_id: mintOpId([
        'convert.repair',
        opId,
        round,
        applied.map((p) => `${p.nodeId}|${p.prop}|${p.value}`),
      ]),
      prime_css: false,
    });
    try {
      await ports.document.primeCss(pageId, {
        op_id: mintOpId(['convert.repair.prime', opId, round]),
      });
    } catch {
      // Best-effort: the re-verify renders the truth either way; the page already primed once.
    }
  }
  return { applied, skipped };
}

/** Can this node carry an atomic local style (atomic container or `e-*` widget)? */
function isAtomicStyledNode(node: ElementNode): boolean {
  if (node.elType === 'widget') {
    const widgetType = (node as { widgetType?: string }).widgetType;
    return widgetType !== undefined && widgetType.startsWith('e-');
  }
  return node.elType.startsWith('e-');
}

/**
 * Emit one typed prop into the node's base (desktop/normal) variant, creating the local style + the
 * §5.1 `classes` mirror when the node has none (the `dangling_ref` repair shape). Mutates `node`
 * (already a deep clone of the live tree).
 */
function emitRepairProp(node: ElementNode, atomicProp: string, typedValue: unknown): void {
  const loose = node as {
    id: string;
    settings?: Record<string, unknown>;
    styles?: Record<
      string,
      {
        id: string;
        type: string;
        label: string;
        variants: Array<{
          meta: { breakpoint?: unknown; state?: unknown };
          props: Record<string, unknown>;
        }>;
      }
    >;
  };
  loose.styles ??= {};
  let def = Object.values(loose.styles)[0];
  if (def === undefined) {
    const styleId = `e-${loose.id}-${shortHash(`repair:${loose.id}`).slice(0, 7)}`;
    def = { id: styleId, type: 'class', label: 'local', variants: [] };
    loose.styles[styleId] = def;
    const settings = (loose.settings ??= {});
    const classes = settings['classes'] as { $$type?: unknown; value?: unknown } | undefined;
    if (classes !== undefined && classes.$$type === 'classes' && Array.isArray(classes.value)) {
      (classes.value as unknown[]).push(styleId);
    } else {
      settings['classes'] = { $$type: 'classes', value: [styleId] };
    }
  }
  let base = def.variants.find(
    (v) =>
      (v.meta.state === null || v.meta.state === undefined) &&
      (v.meta.breakpoint === null || v.meta.breakpoint === undefined || v.meta.breakpoint === 'desktop'),
  );
  if (base === undefined) {
    base = { meta: { breakpoint: 'desktop', state: null }, props: {} };
    def.variants.push(base);
  }
  base.props[atomicProp] = typedValue;
}

/* ───────────────────────────── variable commit (batch → minted ids) ─────────────────────────── */

/** What `commitVariables` returns: the deterministic→minted id map + the records compensation needs. */
interface VariableCommit {
  /** Deterministic `e-gv-*` id (as carried by the tree) → the PHP-minted real id. */
  idMap: Record<string, string>;
  /** The PHP-minted variable ids this commit created (compensation deletes these on a failed save). */
  createdIds: string[];
  /** The post-batch watermark (a compensating batch requires the CURRENT watermark). */
  watermark: number;
}

/**
 * Create the proposed variables via `POST /design/variables/batch` (watermark REQUIRED) and return the
 * `deterministic-id → minted-id` map. Each proposal becomes a `create` op; the response returns the
 * minted-id → DesignVariable map, which we match back to the proposal by `(type, normalized value)`,
 * then through `treeBuild.variableIdMap` to the DETERMINISTIC `e-gv-*` id the tree carries.
 */
async function commitVariables(treeBuild: TreeBuild, ports: ConvertPorts): Promise<VariableCommit> {
  const proposed = treeBuild.result.proposed_variables;
  if (proposed.length === 0) {
    return { idMap: {}, createdIds: [], watermark: treeBuild.variablesWatermark };
  }
  const operations: VariableBatchOp[] = proposed.map((v) => ({
    type: 'create',
    payload: { type: v.type, label: v.label, value: v.value },
  }));
  const resp = await ports.design.batchVariables({
    watermark: treeBuild.variablesWatermark,
    operations,
    op_id: mintOpId(['convert.variables.batch', operations]),
  });

  // Build a `(type|normValue) → minted-id` index from the response, then map each proposal's
  // placeholder token through `variableIdMap` to the deterministic id the tree references.
  const mintedByKey = new Map<string, string>();
  for (const [id, v] of Object.entries(resp.variables)) {
    mintedByKey.set(`${v.type}|${normalizeLiteralForMatch(v.type, v.value)}`, id);
  }
  const map: Record<string, string> = {};
  const createdIds: string[] = [];
  for (const v of proposed) {
    const key = `${v.type}|${normalizeLiteralForMatch(v.type, v.value)}`;
    const minted = mintedByKey.get(key);
    if (minted !== undefined) {
      createdIds.push(minted);
      const placeholder = placeholderVarId(
        kindForVarType(v.type),
        normalizeLiteralForMatch(v.type, v.value),
      );
      const deterministic = treeBuild.variableIdMap[placeholder];
      if (deterministic !== undefined) {
        map[deterministic] = minted;
      }
    }
  }
  return { idMap: map, createdIds, watermark: resp.watermark };
}

/* ───────────────────────────── class commit (diff-PUT under the deterministic ids) ──────────── */

/** What `commitClasses` returns: the added ids + order (compensation) + soft DUPLICATED_LABEL renames. */
interface ClassCommit {
  /** The `g-*` ids this commit added (compensation deletes these on a failed save). */
  addedIds: string[];
  /** The full order the diff-PUT established (compensation rebuilds it minus `addedIds`). */
  orderAfterPut: string[];
  duplicatedLabels?: Record<string, string>;
}

/**
 * Create the proposed classes via the `PUT /design/classes` diff-PUT. The proposals already carry their
 * FINAL deterministic `g-*` ids and wire-normalized ('desktop'-base) variants (htmlToTree step 10 —
 * PHP persists the id we send), so the PUT persists EXACTLY the ids the tree references: no random
 * minting, no post-PUT tree resolution, and a retried conversion replays onto the same ids/op_id
 * instead of minting a duplicate set. Reconciles any soft DUPLICATED_LABEL rename (the id is unchanged
 * — only the label renamed) for the report.
 */
async function commitClasses(treeBuild: TreeBuild, ports: ConvertPorts): Promise<ClassCommit> {
  const proposed = treeBuild.result.proposed_classes;
  if (proposed.length === 0) {
    return { addedIds: [], orderAfterPut: treeBuild.existingClassOrder };
  }

  const addedItems: Record<
    string,
    { id: string; type: 'class'; label: string; variants: unknown[] }
  > = {};
  const addedIds: string[] = [];
  for (const cls of proposed) {
    addedItems[cls.id] = {
      id: cls.id,
      type: 'class',
      label: cls.label,
      variants: cls.variants,
    };
    addedIds.push(cls.id);
  }

  const finalOrder = [...treeBuild.existingClassOrder, ...addedIds];
  const body: PutGlobalClassesRequest = {
    context: 'frontend',
    changes: { added: addedIds, deleted: [], modified: [], order: true },
    items: addedItems as unknown as PutGlobalClassesRequest['items'],
    order: finalOrder,
    op_id: mintOpId(['convert.classes.upsert', addedIds, addedItems, finalOrder]),
  };
  const resp = await ports.design.upsertClasses(body);

  // Reconcile soft DUPLICATED_LABEL: the id is unchanged (only the label was auto-renamed), so the
  // tree's references already point at the right id; we surface the renames for the report.
  const duplicatedLabels: Record<string, string> = {};
  for (const [id, info] of Object.entries(resp.modified_labels ?? {})) {
    if (info?.modified !== undefined) {
      duplicatedLabels[id] = info.modified;
    }
  }

  return {
    addedIds,
    orderAfterPut: resp.order.length > 0 ? resp.order : finalOrder,
    ...(Object.keys(duplicatedLabels).length > 0 ? { duplicatedLabels } : {}),
  };
}

/**
 * Best-effort COMPENSATION for a save that failed AFTER the kit writes landed: delete the classes this
 * convert just added (a compensating diff-PUT) and the variables it created (a compensating batch), so
 * a failed/timed-out commit doesn't orphan kit entries no page references. Compensation errors are
 * swallowed — the ORIGINAL save error is the one the agent must see; worst case the deterministic ids
 * make a retry collapse onto the same entries instead of duplicating them, and the op-log records the
 * writes for manual cleanup.
 */
async function compensateKitWrites(
  ports: ConvertPorts,
  classCommit: ClassCommit,
  varCommit: VariableCommit,
): Promise<void> {
  if (classCommit.addedIds.length > 0) {
    try {
      const added = new Set(classCommit.addedIds);
      await ports.design.upsertClasses({
        context: 'frontend',
        changes: { added: [], deleted: classCommit.addedIds, modified: [], order: true },
        items: {},
        order: classCommit.orderAfterPut.filter((id) => !added.has(id)),
        op_id: mintOpId(['convert.classes.compensate', classCommit.addedIds]),
      });
    } catch {
      // Swallowed: the save error rethrows; the diff-PUT op-log row records what needs manual cleanup.
    }
  }
  if (varCommit.createdIds.length > 0) {
    try {
      const operations: VariableBatchOp[] = varCommit.createdIds.map((id) => ({
        type: 'delete',
        id,
      }));
      await ports.design.batchVariables({
        watermark: varCommit.watermark,
        operations,
        op_id: mintOpId(['convert.variables.compensate', varCommit.createdIds]),
      });
    } catch {
      // Swallowed (same rationale as above).
    }
  }
}

function randHex(n: number): string {
  let s = '';
  while (s.length < n) {
    s += Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  }
  return s.slice(0, n);
}

/**
 * Wrap the converted top-level elements in ONE full-bleed root container that paints the document
 * (body/<html>) background — recovering the page background a full-page conversion would otherwise lose
 * (the walk only covers body's children). The root is an `e-flexbox` column at `width:100%` /
 * `min-height:100vh` with a local style carrying the background; children keep their own widths/centering.
 * Idempotent-id: the minted root id is checked against the existing tree ids.
 */
function wrapInPageRoot(
  elements: ElementNode[],
  background: string,
  generation: 'v4' | 'v3',
): ElementNode[] {
  if (generation !== 'v4') {
    return elements; // V3 classic page background is a page-setting concern; v1 wraps only atomic.
  }
  const used = collectIds(elements);
  let rootId = randHex(7);
  while (used.has(rootId)) {
    rootId = randHex(7);
  }
  const styleId = `e-${rootId}-page`;
  const root: ElementNode = {
    id: rootId,
    elType: 'e-flexbox',
    version: '0.0',
    settings: {
      tag: { $$type: 'string', value: 'div' },
      classes: { $$type: 'classes', value: [styleId] },
    },
    styles: {
      [styleId]: {
        id: styleId,
        type: 'class',
        label: 'page',
        variants: [
          {
            meta: { breakpoint: 'desktop', state: null },
            props: {
              display: { $$type: 'string', value: 'flex' },
              'flex-direction': { $$type: 'string', value: 'column' },
              width: { $$type: 'size', value: { unit: '%', size: 100 } },
              'min-height': { $$type: 'size', value: { unit: 'vh', size: 100 } },
              // I2 — e-flexbox's base PAINTS 10px padding; the synthesized root mirrors <body>
              // (zero padding in any reset page), so it must be explicit or the whole page gets a
              // 10px inset the source never had (page 2584: every band shifted 10px).
              padding: {
                $$type: 'dimensions',
                value: {
                  'block-start': { $$type: 'size', value: { unit: 'px', size: 0 } },
                  'inline-end': { $$type: 'size', value: { unit: 'px', size: 0 } },
                  'block-end': { $$type: 'size', value: { unit: 'px', size: 0 } },
                  'inline-start': { $$type: 'size', value: { unit: 'px', size: 0 } },
                },
              },
              background: {
                $$type: 'background',
                value: { color: { $$type: 'color', value: background } },
              },
            },
          },
        ],
      },
    },
    editor_settings: [],
    interactions: [],
    elements,
  } as unknown as ElementNode;
  return [root];
}

/* ───────────────────────────── placeholder resolution (one-pass tree rewrite) ───────────────── */

/**
 * Resolve every `__var:`/`__class:` placeholder — or already-deterministic id present in the maps — in
 * the tree IN ONE PASS:
 *  - a `classes.value[]` entry matching a `classIdMap` key (e.g. a `__class:*` placeholder) → the
 *    mapped `g-*` id;
 *  - a TypedValue `{$$type:'global-*-variable', value}` whose value matches a `varIdMap` key (a
 *    `__var:*` placeholder OR a deterministic `e-gv-*` id being swapped for the PHP-minted one) → the
 *    mapped id.
 * Deep-clones the input (never mutates the caller's tree). A placeholder with no mapping is LEFT as-is
 * (the authoritative dry_run will surface it — better than silently dropping a reference).
 */
export function resolvePlaceholders(
  elements: ElementNode[],
  varIdMap: Record<string, string>,
  classIdMap: Record<string, string>,
): ElementNode[] {
  const cloned = JSON.parse(JSON.stringify(elements)) as ElementNode[];
  for (const node of cloned) {
    resolveNode(node, varIdMap, classIdMap);
  }
  return cloned;
}

/** Walk the tree, invoking `onToken` for each `__var:*` placeholder found in a variable TypedValue. */
function collectVarPlaceholders(elements: ElementNode[], onToken: (token: string) => void): void {
  const visitValue = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visitValue(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      const tv = value as { $$type?: unknown; value?: unknown };
      if (
        typeof tv.$$type === 'string' &&
        typeof tv.value === 'string' &&
        isPlaceholderVarId(tv.value)
      ) {
        onToken(tv.value);
      }
      for (const v of Object.values(value as Record<string, unknown>)) {
        visitValue(v);
      }
    }
  };
  const walk = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      const settings = (node as { settings?: Record<string, unknown> }).settings;
      if (settings !== undefined) visitValue(settings);
      const styles = (node as { styles?: Record<string, unknown> }).styles;
      if (styles !== undefined) visitValue(styles);
      const children = (node as { elements?: ElementNode[] }).elements;
      if (Array.isArray(children) && children.length > 0) walk(children);
    }
  };
  walk(elements);
}

/** Resolve a single node's placeholders (recurses into children). Mutates `node` (already a clone). */
function resolveNode(
  node: ElementNode,
  varIdMap: Record<string, string>,
  classIdMap: Record<string, string>,
): void {
  // (a) classes.value[] — swap any `__class:*` placeholder for the real id.
  const settings = (node as { settings?: Record<string, unknown> }).settings;
  if (settings !== undefined) {
    const classesEnv = settings['classes'] as { $$type?: string; value?: unknown } | undefined;
    if (classesEnv !== undefined && Array.isArray(classesEnv.value)) {
      classesEnv.value = (classesEnv.value as unknown[]).map((name) =>
        typeof name === 'string' && classIdMap[name] !== undefined ? classIdMap[name] : name,
      );
    }
    rewriteVarTokens(settings, varIdMap);
  }
  // (b) variable TypedValues anywhere in styles — swap `__var:*` for the minted id.
  const styles = (node as { styles?: Record<string, unknown> }).styles;
  if (styles !== undefined) {
    rewriteVarTokens(styles, varIdMap);
  }
  const children = (node as { elements?: ElementNode[] }).elements;
  if (Array.isArray(children)) {
    for (const child of children) {
      resolveNode(child, varIdMap, classIdMap);
    }
  }
}

/**
 * Recursively rewrite variable-ref values to their mapped ids (in place): a `__var:*` placeholder on
 * ANY envelope, or — for `{$$type:'global-*-variable'}` envelopes only — a deterministic `e-gv-*` id
 * being swapped for the PHP-minted one at commit.
 */
function rewriteVarTokens(value: unknown, varIdMap: Record<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteVarTokens(item, varIdMap);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const tv = value as { $$type?: unknown; value?: unknown };
    if (
      typeof tv.$$type === 'string' &&
      typeof tv.value === 'string' &&
      varIdMap[tv.value] !== undefined &&
      (isPlaceholderVarId(tv.value) || tv.$$type.endsWith('-variable'))
    ) {
      tv.value = varIdMap[tv.value];
      return; // a variable ref leaf has no deeper structure to rewrite
    }
    for (const v of Object.values(value as Record<string, unknown>)) {
      rewriteVarTokens(v, varIdMap);
    }
  }
}

/** A short stable hex token from a seed (deterministic `g-*`/`e-gv-*` id minting; not crypto). */
function shortHash(seed: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 8);
}

/* ───────────────────────────── fidelity_check (RESEARCH.md §6.8) ─────────────────────────────── */

/**
 * Render the SAVED + PRIMED page (public preview URL) vs the source HTML at the requested breakpoints
 * and return `{score, deltas}` (`convert.fidelity_check`). Reuses the WP-H03 browser pool (the SAME
 * Playwright instance PARSE uses). Resolves the page URL + the active breakpoints from the ports.
 */
export async function runFidelityCheck(
  args: FidelityCheckArgs,
  ports: ConvertPorts,
): Promise<FidelityResult> {
  // Resolve the public/preview URL of the saved page (preview_url is regenerated from get_structure's
  // diff round-trip; we re-derive it from a no-op dry_run with want_preview so the gate gets a real URL).
  const structure = await ports.document.getStructure(args.post_id);
  const dry = await ports.document.dryRun(args.post_id, {
    elements: structure.elements,
    generation: structure.generation,
    want_preview: true,
    op_id: mintOpId(['convert.fidelity.preview', args.post_id]),
  });
  const renderedUrl = dry.preview_url ?? '';

  // Resolve breakpoint specs: honor the requested keys against the live set, else the full active set.
  const bpResp = await ports.schema.breakpoints();
  const allSpecs = toBreakpointSpecs(bpResp.items, bpResp.active_direction);
  const requested = args.breakpoints;
  const specs =
    requested !== undefined && requested.length > 0
      ? allSpecs.filter((s) => s.key !== null && requested.includes(s.key))
      : allSpecs;

  return fidelityCheck({
    rendered_url: renderedUrl,
    source_html: args.source_html,
    ...(args.css !== undefined ? { source_css: args.css } : {}),
    breakpoints: specs.length > 0 ? specs : allSpecs,
    browser: ports.browser,
  });
}

/* ───────────────────────────── diff shaping (PHP authoritative → F03 Diff) ───────────────────── */

/**
 * Shape the REST flat diff (`RestDiff` from dry_run/save) into the WP-F03 `Diff` the tool presents
 * (01-architecture: PHP produces the authoritative diff; TS shapes it). Maps the flat
 * `changed/new/removed_ids` into `NodeChange[]` + carries the id arrays.
 */
export function shapeDiff(rest: RestDiff): Diff {
  // PHP keys the diff id arrays off the saved element ids. Although `RestDiff` declares them as
  // `string[]`, JSON-decoded numeric-looking element ids (e.g. the converted <img> nodes) arrive as
  // NUMBERS. The frozen F03 `Diff.changes[].id`/`new_ids` are strings (diff.schema.json), so coerce
  // at this shaping seam — `String(id)` is a faithful representation of the same id, and the
  // before/after maps are looked up with the ORIGINAL key (numeric keys index fine via [] coercion).
  const asStr = (id: unknown): string => String(id);
  const newIds = (rest.new_ids ?? []) as Array<string | number>;
  const removedIds = (rest.removed_ids ?? []) as Array<string | number>;
  const changedIds = (rest.changed_ids ?? []) as Array<string | number>;
  const changes: Diff['changes'] = [];
  for (const id of newIds) {
    changes.push({ id: asStr(id), op: 'added', ...nodeMeta(fromRestNode(rest.after?.[id])) });
  }
  for (const id of removedIds) {
    changes.push({ id: asStr(id), op: 'removed', ...nodeMeta(fromRestNode(rest.before?.[id])) });
  }
  for (const id of changedIds) {
    changes.push({ id: asStr(id), op: 'modified', ...nodeMeta(fromRestNode(rest.after?.[id])) });
  }
  return {
    changes,
    new_ids: newIds.map(asStr),
    changed_ids: changedIds.map(asStr),
    removed_ids: removedIds.map(asStr),
  };
}

/** Project an element node's elType/widgetType for a NodeChange (best-effort; both optional). */
function nodeMeta(node: ElementNode | undefined): { elType?: string; widgetType?: string } {
  if (node === undefined) return {};
  const n = node as { elType?: unknown; widgetType?: unknown };
  const out: { elType?: string; widgetType?: string } = {};
  if (typeof n.elType === 'string') out.elType = n.elType;
  if (typeof n.widgetType === 'string') out.widgetType = n.widgetType;
  return out;
}

/** An empty `Diff` (gate-deny / decline paths — nothing changed). */
function emptyDiff(): Diff {
  return { changes: [], new_ids: [], changed_ids: [], removed_ids: [] };
}

/* Keep the coverage `SourcePathIdMap` type imported as the id-folding seam (used by buildSourcePathIdMap). */
export type CoverageIdMapSeam = SourcePathIdMap;

/* ───────────────────────────── errors ─────────────────────────────────────────────────────── */

/**
 * Thrown when a required capability (e.g. `can_update_class`) is absent BEFORE attempting the write.
 * The tool handler maps it to a `CAPABILITY_MISSING` `isError` result (12-error-taxonomy §3 / §5).
 */
export class ConvertCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvertCapabilityError';
  }
}

/**
 * Thrown when a HARD integrity invariant (contract 17 §1 — I1 reference closure / I3 total
 * accounting) is violated on the final wire tree: a CONVERTER BUG, never a content problem. The
 * conversion fails with the precise violation list BEFORE any dry_run/kit write/save — a broken
 * tree never persists. The tool handler maps this to a `VALIDATION_FAILED` isError result carrying
 * the structured violations.
 */
export class ConvertIntegrityError extends Error {
  readonly violations: IntegrityViolation[];
  constructor(violations: IntegrityViolation[]) {
    super(
      `conversion integrity check failed (contract 17 §1): ${String(violations.length)} ` +
        `violation(s) — ${violations.map((v) => `[${v.invariant}] ${v.detail}`).join(' | ')}`,
    );
    this.name = 'ConvertIntegrityError';
    this.violations = violations;
  }
}
