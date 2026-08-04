/**
 * WP-H01 — the FROZEN HTML→native pipeline IR (intermediate-representation) contract.
 *
 * This single file is the inter-stage SEAM for the whole HTML→native conversion pipeline
 * (`15-engineering-standards.md §4.6.1`). It declares EVERY inter-stage IR type and per-stage Result
 * envelope the stages produce/consume, so that each downstream stage WP (WP-H03..H11) becomes
 * INDEPENDENTLY buildable and unit-testable against a frozen contract the moment this WP lands.
 *
 * OWNERSHIP RULE (`15-engineering-standards.md §4.6.1`): WP-H01 owns ONLY these TYPE declarations —
 * pure `type`/`interface`, NO runtime logic for stages it does not own. Each stage WP owns the
 * FUNCTION that implements its type (e.g. `parseHtml` is WP-H03, `normalizeIr` is WP-H04). Adding a
 * field to any IR type is a re-freeze of WP-H01, never a unilateral edit by a downstream stage.
 *
 * PRE-ENVELOPE: the IR is pre-typed-envelope. `ElementNode`/`StyleDefinition`/`StyleVariant`/
 * `BreakpointKey`/`Generation` are the FROZEN WP-F03 authoring types and are imported, NEVER
 * redeclared here. Envelope wrapping (`{$$type,value}`) happens only in ASSEMBLE (WP-H08) via WP-F03's
 * `envelopes.ts`; the IR never carries typed envelopes.
 *
 * Pipeline order: PARSE → NORMALIZE → CLASSIFY → MAP → STYLE-EXTRACT → ASSEMBLE → HOIST/VARIABLE-EXTRACT
 * → A11Y/FIDELITY/COVERAGE → orchestrator (WP-H11).
 */

/* ─────────────────────────── Frozen shared / authoring imports (NEVER redeclared) ──────────── */

// WP-F03 frozen authoring types (realized at `packages/server/src/authoring/contract.ts`). The
// pipeline IR is PRE-envelope and refers to the authoring `ElementNode` only at/after ASSEMBLE.
// Only the names referenced in this module's body are imported here; the rest are re-exported
// directly from source via the `export type { ... }` block below (so they stay imported, never
// redeclared, but do not trip `noUnusedLocals`).
import type { ElementNode, StyleDefinition, BreakpointKey } from '../authoring/contract.js';

// WP-F05 frozen normalized site-capabilities probe (`@elementor-ultra/shared`). The MAP stage gates
// targets on this. (The contract refers to it as `SiteCapabilities`; the frozen WP-F05 export is
// `Capabilities` — re-exported here under the contract name so consumers can import either.)
import type { Capabilities } from '@elementor-ultra/shared';

// Re-export the frozen shared/authoring types downstream stage WPs consume through this seam, so a
// stage can `import type { ElementNode, SiteCapabilities, ... } from '../convert/types.js'` and never
// has to know which package froze them.
export type {
  ElementNode,
  StyleDefinition,
  StyleVariant,
  BreakpointKey,
  Generation,
} from '../authoring/contract.js';

/**
 * Normalized site-capabilities probe (WP-F05 frozen `Capabilities`). Aliased to the
 * contract name `SiteCapabilities` used by `MapStageContext` (`13-tool-catalog.md §1.1`).
 */
export type SiteCapabilities = Capabilities;

/**
 * A global class object. The frozen REST/authoring shape is identical to `StyleDefinition`
 * (`id`/`type:'class'`/`label`/`variants[]`), referred to as `GlobalClassObject` by the tool catalog
 * (`13-tool-catalog.md §1.9` NOTE, `globalClassObjectSchema`). Aliased — never structurally redeclared.
 */
export type GlobalClassObject = StyleDefinition;

/**
 * A global variable definition as the HOIST/VARIABLE-EXTRACT stage sees existing site variables
 * (`11-authoring-contract.md §3.1` global-color/font/size-variable; `variables/hooks.php:48-51`).
 * There is no frozen TS `VariableDef` in waves 0-2, so the IR declares the minimal read shape here;
 * if WP-F03 later freezes one, this aliases to it (re-freeze of WP-H01).
 */
export interface VariableDef {
  id: string;
  type: 'global-color-variable' | 'global-font-variable' | 'global-size-variable';
  label: string;
  value: string;
}

/* ─────────────────────────── Core IR node + value types (consumed by ALL stages) ───────────── */

/**
 * The classifier's role vocabulary (RESEARCH.md §6.1 step 3, §6.2). This is the framework-agnostic
 * semantic label the CLASSIFY stage assigns to each node; MAP resolves it to a concrete Elementor
 * target via `mapping-table.ts`. `unknown` degrades to a generic structural block (never throws).
 */
export type SemanticRole =
  | 'structural-block'
  | 'flex-row'
  | 'flex-col'
  | 'grid'
  | 'heading'
  | 'text'
  | 'image'
  | 'button'
  | 'link'
  | 'divider'
  | 'icon-svg'
  | 'media-embed-youtube'
  | 'media-embed-video'
  | 'tabs'
  | 'tab'
  | 'tab-content'
  | 'form'
  | 'form-field'
  | 'nav-menu'
  | 'list'
  | 'list-item'
  | 'table'
  | 'accordion'
  | 'accordion-item'
  | 'unknown';

/** `getBoundingClientRect()` subset captured by PARSE — used by CLASSIFY for flex-intent inference. */
export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The whitelisted `getComputedStyle` pick (the prop names in `STYLE_WHITELIST`, owned by
 * `mapping-table.ts`). A flat `cssPropName → computedValue` map; STYLE-EXTRACT classifies each entry.
 */
export type ComputedStyleSet = Record<string, string>;

/**
 * An inline-markup span extracted from a text node (`inlineTags` are the wrapping inline elements,
 * OUTER→INNER). Contract 17 §5 re-freeze (all additive — pre-contract-17 runs stay valid):
 * `linkHref`/`linkTarget` carry the nearest wrapping `<a>`'s destination (PARSE `extractTextRuns`
 * sets them; NORMALIZE resolves the href against `base_url`) so MAP's html-v3 fold serializes a
 * LIVE `<a href>` instead of a dead bare `<a>` (`wp_kses` keeps `a[href][target]`). `color` is the
 * run's computed text color when it DIFFERS from the parent text node's color (the #8 accent-color
 * leg) so the fold can carry it as an inline `style` attr — or record the drop (I3).
 */
export interface TextRun {
  text: string;
  inlineTags: string[];
  /** Destination of the nearest wrapping `<a href>`, when the run is inside an in-text link. */
  linkHref?: string;
  /** The wrapping `<a>`'s `target` attr (e.g. `_blank`), only meaningful with `linkHref`. */
  linkTarget?: string;
  /** The run's computed `color` when it differs from the parent text node's color (contract 17 #8). */
  color?: string;
}

/** A media reference discovered on a node (`<img>`, CSS background, `<video>`, `<svg>`, YouTube). */
export interface MediaRef {
  kind: 'img' | 'background' | 'video' | 'svg' | 'youtube';
  url?: string;
  srcset?: string;
  alt?: string;
  embedId?: string;
}

/* ─────────────────────────── Behavior IR (contract 16 §1 — frozen) ──────────────────────────── */

/**
 * A detected page behavior (contract `16-behavior-conversion.md §1` — frozen). Produced by the
 * CLASSIFY stage (§2 signal table over ARIA/classnames/runtime probes) and attached to the pattern
 * ROOT `IrNode` (`IrNode.behaviors`). `tier`/`reason` are assigned downstream by MAPPING (tier 4 =
 * honest drop) — detection itself never assigns a tier. Pure annotation: a page with zero behaviors
 * converts byte-identically to pre-contract-16 output (§8 invariant 5).
 */
export interface DetectedBehavior {
  kind:
    | 'tabs'
    | 'accordion'
    | 'carousel'
    | 'nav-toggle'
    | 'form'
    | 'entrance-animation'
    | 'hover-effect'
    | 'marquee'
    | 'countdown'
    | 'video-embed'
    | 'custom-js';
  confidence: 'high' | 'medium' | 'low';
  /** e.g. `["role=tablist", "classname:swiper", "listener:click"]`. */
  evidence: string[];
  /** IR node ids (`source_path`s, pre-assembly) participating — trigger + panels. */
  nodeIds: string[];
  /** Assigned by mapping; 4 = dropped. Detection leaves it unset. */
  tier?: 1 | 2 | 3 | 4;
  /** Why it landed in that tier (set with `tier`). */
  reason?: string;
}

/** One `<script>` tag recorded by the PARSE script census (contract 16 §1/§2 — Tier 3 / coverage). */
export interface PageScript {
  src: string | null;
  inline_bytes: number;
  external: boolean;
}

/**
 * Raw CSS-animation capture for an element whose computed `animation-name != none` (contract 16 §2
 * runtime probes). PARSE extracts the matching `@keyframes` rule via CSSOM and records the
 * opacity/transform deltas + computed duration/delay/easing; CLASSIFY turns this into an
 * `entrance-animation` `DetectedBehavior`. Optional probe carrier — absent on zero-behavior pages.
 */
export interface AnimationProbe {
  /** The first computed `animation-name` (the one whose keyframes were extracted). */
  name: string;
  duration: string;
  delay: string;
  easing: string;
  /** The distinct property names animated by the keyframes (e.g. `['opacity','transform']`). */
  keyframeProps: string[];
  /** First→last keyframe opacity delta, when the keyframes animate opacity. */
  opacity?: { from: number; to: number };
  /** First→last keyframe transform delta, when the keyframes animate transform. */
  transform?: { from: string; to: string };
}

/**
 * Raw CSS-transition capture (contract 16 §2: `transition` on hover-changed props → hover-effect).
 * Recorded by PARSE for elements with a non-zero-duration transition; CLASSIFY pairs it with
 * `hoverComputed` to emit a `hover-effect` behavior. Optional probe carrier.
 */
export interface TransitionProbe {
  /** Computed `transition-property` (e.g. `all` or `background-color, transform`). */
  property: string;
  duration: string;
  easing: string;
}

/**
 * The framework-agnostic node the AI/deterministic classifier emits (SUPPLEMENT §C.4 step 3). Pure
 * data: geometry + whitelisted computed styles (+ optional hover/focus/responsive overrides) + attrs
 * + text runs + media + children. Carries NO typed envelopes (those are added at ASSEMBLE).
 *
 * Contract 16 additions (ALL optional — pure annotation, §8 invariant 5): `behaviors` (CLASSIFY, on
 * the pattern ROOT node only) plus the PARSE runtime-probe carriers `animationProbe`/
 * `transitionProbe`/`listeners` CLASSIFY reads its §2 signals from.
 */
export interface IrNode {
  source_path: string;
  tag: string;
  role: SemanticRole;
  box: BoxRect;
  computed: ComputedStyleSet;
  hoverComputed?: Partial<ComputedStyleSet>;
  focusComputed?: Partial<ComputedStyleSet>;
  responsive: Record<BreakpointKey & string, Partial<ComputedStyleSet>>;
  attrs: Record<string, string>;
  textRuns: TextRun[];
  media?: MediaRef;
  children: IrNode[];
  /** Detected behaviors (contract 16 §1) — present ONLY on a pattern ROOT node, never empty. */
  behaviors?: DetectedBehavior[];
  /** PARSE probe: CSS animation capture when computed `animation-name != none` (contract 16 §2). */
  animationProbe?: AnimationProbe;
  /** PARSE probe: non-zero-duration CSS transition capture (contract 16 §2). */
  transitionProbe?: TransitionProbe;
  /** PARSE probe: click/touch listener event types from CDP `getEventListeners` (non-anchor only). */
  listeners?: string[];
}

/**
 * The resolved Elementor target for a role (`mapRole` output). `elType`/`widgetType` are the V4
 * atomic target; `v3_fallback` is the classic fallback when atomic/Pro/experiment is unavailable.
 * `settings_seed` carries ONLY role-driven, non-style RAW settings (e.g. `tag`), never typed envelopes.
 */
export interface MappingResult {
  generation: 'v4';
  elType: string;
  widgetType?: string;
  tag?: string;
  is_container: boolean;
  settings_seed: Record<string, unknown>;
  v3_fallback: {
    elType: string;
    widgetType?: string;
  };
}

/* ─────────────────────────── PARSE — impl WP-H03 (`parse.ts`) ───────────────────────────────── */

/** One breakpoint the PARSE stage re-renders at (RESEARCH.md §6.7; `direction` ∈ `min|max`). */
export interface BreakpointSpec {
  key: BreakpointKey;
  width: number;
  direction: 'min' | 'max';
}

/** PARSE input: raw HTML/CSS + the breakpoint set + fidelity tier + state-capture toggle. */
export interface ParseInput {
  html: string;
  css?: string;
  breakpoints: BreakpointSpec[];
  base_url?: string;
  fidelity: 'high' | 'balanced' | 'fast';
  capture_states?: boolean;
}

/** A non-fatal PARSE warning (e.g. dead `<link>`, un-inlinable `@import`). */
export interface ParseWarning {
  source_path?: string;
  code: string;
  message: string;
}

/**
 * PARSE output: the IR forest + document direction + the viewport width used + warnings + the raw
 * inner markup per node (`raw_inner_markup`, keyed by `source_path`) NORMALIZE needs to promote
 * block-in-text content before html-v3 emission.
 */
export interface ParseResult {
  ir: IrNode[];
  doc_direction: 'ltr' | 'rtl';
  viewport_used: number;
  warnings: ParseWarning[];
  raw_inner_markup: Record<string, string>;
  /** The page-level (body/<html>) background color, when non-transparent — the pipeline wraps the tree
   *  in a full-bleed root container carrying it so a full-page conversion keeps its document background. */
  page_background?: string;
  /** Script census (contract 16 §1/§2): EVERY `<script>` tag in the source, for Tier 3 / coverage.
   *  Always populated by `parseHtml`; optional in the type only so pre-contract-16 hand-built
   *  fixtures stay valid (additive re-freeze). */
  pageScripts?: PageScript[];
}

/* ─────────────────────────── NORMALIZE — impl WP-H04 (`normalize.ts`) ───────────────────────── */

/** NORMALIZE context: base url + the per-node raw inner markup + redundant-wrapper unwrap toggle. */
export interface NormalizeContext {
  base_url?: string;
  raw_inner_markup: Record<string, string>;
  unwrap_redundant: boolean;
}

/** A record of inline tags stripped from a node's text (drives `CoverageReport.stripped_text`). */
export interface StrippedRecord {
  source_path: string;
  stripped_tags: string[];
}

/** A record of block content promoted out of a text node into sibling element nodes. */
export interface PromotionRecord {
  from_source_path: string;
  promoted_to: string[];
  reason: string;
}

/** NORMALIZE output: the cleaned IR + strip/promotion records + warnings. */
export interface NormalizeResult {
  ir: IrNode[];
  stripped: StrippedRecord[];
  promotions: PromotionRecord[];
  warnings: string[];
}

/* ─────────────────────────── CLASSIFY — impl WP-H05 (`classify.ts`/`flex-inference.ts`) ─────── */

/** An AI-produced role/name hint for a node (CLASSIFY merges these with deterministic inference). */
export interface AiRoleHint {
  source_path: string;
  role?: SemanticRole;
  suggested_name?: string;
  confidence?: number;
}

/** CLASSIFY options: optional AI hints + whether to infer flex intent from box geometry (§C.2). */
export interface ClassifyOptions {
  ai_hints?: AiRoleHint[];
  infer_flex: boolean;
}

/** An applied (or rejected) role change with provenance (audit trail for the coverage report). */
export interface RoleOverride {
  source_path: string;
  from: SemanticRole;
  to: SemanticRole;
  source: 'ai' | 'deterministic';
  accepted: boolean;
}

/** CLASSIFY output: the role-assigned IR + the override audit trail + warnings. */
export interface ClassifyResult {
  ir: IrNode[];
  role_overrides: RoleOverride[];
  warnings: string[];
}

/**
 * Inferred flex layout for a flex container (Locofy-style geometry heuristics, SUPPLEMENT §C.2).
 * `fill_children`/`absolute_children` are `source_path`s of children that become flex:1 / absolute.
 */
export interface FlexIntent {
  direction: 'row' | 'column';
  wrap: boolean;
  justify?: string;
  align?: string;
  gap?: string;
  fill_children: string[];
  absolute_children: string[];
}

/* ─────────────────────────── MAP — impl WP-H06 (`map.ts`) ───────────────────────────────────── */

/**
 * MAP context: generation + the live capabilities probe (gates Pro/experiment targets) + a per-source
 * tab-pairing map (`source_path → menu/content counts match`) so MAP can emit `e-tabs` only when paired.
 */
export interface MapStageContext {
  generation: 'v4' | 'v3';
  capabilities: SiteCapabilities;
  tab_pairing: Record<string, boolean>;
}

/**
 * A contract-17 #8 inline accent MAP could fold structurally but not colorize inline: Elementor's
 * `Html_Prop_Type` sanitizes html-v3 content with a CUSTOM `wp_kses` allowlist that strips EVERY
 * attribute except `a[href|target]` (live-verified: a saved `<em style="color:…">` came back bare),
 * so the color must ride the node's LOCAL STYLE as a nested custom_css rule (`& em{color:…}`) —
 * STYLE-EXTRACT materializes these.
 */
export interface AccentRule {
  /** The innermost surviving inline tag of the recolored run (the nested-rule selector). */
  tag: string;
  /** The run's computed color (differs from the parent text color by construction). */
  color: string;
}

/** An IR node decorated with its resolved target + role-driven settings seed (children are MappedNode). */
export type MappedNode = IrNode & {
  target: MappingResult;
  settings_seed: Record<string, unknown>;
  children: MappedNode[];
  /** Contract 17 #8 — inline accents STYLE-EXTRACT must carry as nested custom_css rules. */
  accent_rules?: AccentRule[];
};

/** A whole-node fallback record (the §9 whole-node ladder tier the node landed on). */
export interface NodeFallback {
  source_path: string;
  tier: 'native' | 'v3_classic' | 'structural_block' | 'html_widget';
  reason: string;
}

/**
 * An inline-fold side effect MAP could not carry into the folded html-v3 content (contract 17 I3 —
 * total accounting: every inline-fold loss lands in a tier, never silently). Today the only producer
 * is the #8 accent-color leg: a run whose `color` differs from its parent but has no `wp_kses`-kept
 * inline tag to host a `style` attr. Always `tier:'dropped'`; `declaration` is `prop: value` form
 * (e.g. `color: #0C6B4A`) so the coverage stage can bucket it like a `DeclFallback`.
 */
export interface InlineFoldDrop {
  source_path: string;
  declaration: string;
  tier: 'dropped';
  reason: string;
}

/**
 * MAP output: the mapped node forest + whole-node fallbacks + inline-fold drops + warnings.
 * `inline_drops` is ALWAYS populated by `mapIr` (possibly empty); optional in the type only so
 * pre-contract-17 hand-built fixtures stay valid (additive re-freeze).
 */
export interface MapResult {
  nodes: MappedNode[];
  fallbacks: NodeFallback[];
  warnings: string[];
  inline_drops?: InlineFoldDrop[];
}

/* ─────────────────────────── STYLE-EXTRACT — impl WP-H07 ────────────────────────────────────── */

/**
 * The live, flat `css-prop-name → Prop_Type` Style-Schema map (`elementor.schema.styles`,
 * `11-authoring-contract.md §5.2`). Each entry exposes its `$$type` and any enum/units constraints so
 * STYLE-EXTRACT can decide native vs. fallback per declaration.
 */
export type StyleSchema = Record<
  string,
  {
    $$type: string;
    enum?: string[];
    units?: string[];
  }
>;

/** STYLE-EXTRACT context: the live Style-Schema + breakpoints + direction info + Pro flag. */
export interface StyleContext {
  style_schema: StyleSchema;
  breakpoints: BreakpointSpec[];
  doc_direction: 'ltr' | 'rtl';
  target_rtl: boolean;
  pro_active: boolean;
}

/**
 * Per-state/breakpoint index of the raw declarations STYLE-EXTRACT considered, keyed by a
 * `state|breakpoint` key (e.g. `'desktop'`, `'hover'`). Drives the per-property fallback report.
 */
export type DeclIndex = Record<string, Array<{ prop: string; value: string }>>;

/** A mapped node decorated with its extracted local style variants + the declaration index. */
export type StyledNode = MappedNode & {
  local_styles: StyleDefinition[];
  decl_index: DeclIndex;
};

/** A per-declaration fallback record (which ladder tier a single CSS declaration landed on, §9). */
export interface DeclFallback {
  source_path: string;
  declaration: string;
  tier: 'native' | 'local_style' | 'global_class' | 'custom_css' | 'html_widget';
  reason: string;
}

/** A repeated literal (color/font/size) STYLE-EXTRACT proposes as a variable candidate (§C.2). */
export interface LiteralRef {
  kind: 'color' | 'font' | 'size';
  value: string;
  occurrences: string[];
}

/** STYLE-EXTRACT output: styled nodes + per-declaration fallbacks + proposed variable literals. */
export interface StyleExtractResult {
  styled_nodes: StyledNode[];
  declaration_fallbacks: DeclFallback[];
  proposed_variable_literals: LiteralRef[];
  /**
   * Contract 17 §1 I3 — the PRODUCER-side accounting-unit count: every declaration this stage
   * resolved to a fate (a typed prop emitted into a variant, or a fallback row recorded), counted at
   * the extraction seam itself (post I4 noise filter, EXCLUDING the noise summary record). The
   * integrator (WP-H11) uses this as `AccountingLedger.detected_declarations` so I3 compares the
   * producer's own count against the post-merge ledger — a pipeline-side merge bug (a loss stream
   * never folded into the ledger, a row filtered away, a drifted native counter) breaks the balance
   * instead of being re-derived into a tautology.
   */
  detected_declarations: number;
}

/** The per-declaration verdict the declaration-classifier emits (native vs. candidate vs. unmappable). */
export interface DeclVerdict {
  kind: 'native' | 'variable-candidate' | 'global-class-candidate' | 'unmappable';
  atomic_prop?: string;
  typed_value?: unknown;
  fallback_tier?: DeclFallback['tier'];
  reason: string;
}

/* ─────────────────────────── ASSEMBLE — impl WP-H08 (`assemble.ts`) ─────────────────────────── */

/** Media side-channel ASSEMBLE uses to sideload/upload media (impl injected by the orchestrator). */
export interface MediaPort {
  sideloadUrl(url: string, alt?: string): Promise<{ id: number; url: string }>;
  upload(bytes: Uint8Array, filename: string): Promise<{ id: number; url: string }>;
}

/** Id side-channel ASSEMBLE uses to mint unique ids + validate against the live document set. */
export interface IdPort {
  mint(existing: Set<string>): string;
  validate(ids: string[]): Promise<string[]>;
}

/** ASSEMBLE context: generation + existing-id set + sideload toggle + the media/id ports. */
export interface AssembleContext {
  generation: 'v4' | 'v3';
  existing_ids: Set<string>;
  sideload_media: boolean;
  media: MediaPort;
  ids: IdPort;
  /**
   * Opt-in: carry the SOURCE DOM's class names (`rk-band`, `hh-hero-liquid`, …) into each element's
   * `classes` array so they render as literal class attributes. Enhancement CSS/JS can then key off
   * stable semantic classes instead of welding to minted element ids — and survives a re-convert
   * unchanged. Sanitized (valid CSS tokens only); system prefixes (`e-`/`g-`/`elementor…`) skipped.
   * The authoritative validator accepts unknown class strings (verified on a live dry_run).
   */
  preserve_source_classes?: boolean;
}

/** A media sideload failure (surfaced in the report; never aborts the assemble). */
export interface SideloadError {
  source_path: string;
  url: string;
  reason: string;
}

/**
 * ASSEMBLE output: the final `ElementNode[]` (WP-F03 authoring shape — the first place the IR becomes
 * authoring nodes), the `source-url → attachment-id` media map, sideload errors, and the minted
 * element + local-style id sets.
 */
export interface AssembleResult {
  elements: ElementNode[];
  media_map: Record<string, number>;
  sideload_errors: SideloadError[];
  minted_ids: string[];
  local_style_ids: string[];
}

/* ─────────────────────────── HOIST / VARIABLE-EXTRACT — impl WP-H09 ─────────────────────────── */

/** Budget projection for a class/variable diff against the 1000-item budget (RESEARCH.md §5.4). */
export interface BudgetReport {
  current_count: number;
  would_add: number;
  would_delete: number;
  projected: number;
  max_allowed: number;
  exceeded: boolean;
}

/** HOIST context: existing classes + order + min-use threshold + name hints + the budget ceiling. */
export interface HoistContext {
  existing_classes: GlobalClassObject[];
  existing_order: string[];
  min_uses: number;
  name_hints: Record<string, string>;
  budget_max: number;
}

/**
 * HOIST output: the rebound `ElementNode[]` + proposed global classes + per-class rebind map
 * (`g-class-id → element-ids`) + the budget projection + warnings.
 */
export interface HoistResult {
  elements: ElementNode[];
  proposed_classes: GlobalClassObject[];
  class_rebinds: Record<string, string[]>;
  budget: BudgetReport;
  warnings: string[];
}

/** VARIABLE-EXTRACT context: existing variables + min-use threshold + the budget ceiling. */
export interface VarContext {
  existing_variables: VariableDef[];
  min_uses: number;
  budget_max: number;
}

/** A proposed new global variable (type + human-meaningful label + literal value). */
export interface ProposedVariable {
  type: 'global-color-variable' | 'global-font-variable' | 'global-size-variable';
  label: string;
  value: string;
}

/**
 * VARIABLE-EXTRACT output: the rebound `ElementNode[]` + proposed variables + per-variable rebind map
 * + the budget projection + warnings.
 */
export interface VarResult {
  elements: ElementNode[];
  proposed_variables: ProposedVariable[];
  var_rebinds: Record<string, string[]>;
  budget: BudgetReport;
  warnings: string[];
}

/* ─────────────────────────── A11Y / FIDELITY / COVERAGE — impl WP-H10 ───────────────────────── */

/*
 * These mirror `diff.schema.json#/$defs/CoverageReport` — the JSON Schema is the CANONICAL field-name
 * source; the TS shapes here are its mirror (H10/H11 assemble them). `element_id` is the MINTED
 * Elementor id from ASSEMBLE (distinct from the pre-assembly `source_path` used upstream; H10 maps
 * `source_path → element_id` when folding the per-stage records into the final report).
 */

/** An accessibility lint finding (`CoverageReport.a11y[]`). */
export interface A11yFinding {
  element_id: string;
  rule: string;
  severity: 'warning' | 'blocker';
  message: string;
}

/** Visual-diff result from `convert.fidelity_check` (`13-tool-catalog.md §1.9`; lower diff is better). */
export interface FidelityResult {
  score: number;
  deltas: Array<{
    breakpoint: string;
    diff_ratio: number;
    region: string | null;
  }>;
}

/**
 * One behavioral-fidelity probe outcome (contract `16-behavior-conversion.md §6`). `kind` names the
 * probe (`tabs` = click-tab-N active-panel assertion; `interactions` = footer blob +
 * `data-interaction-id` carrier assertion); `nodeId` is the behavior's root node id (pre-assembly
 * `source_path`, same keying as `DetectedBehavior.nodeIds`). A failed probe is an HONEST
 * `pass:false` row, never a throw — only Chromium-unavailable propagates (mirrors `fidelityCheck`).
 */
export interface BehaviorProbe {
  kind: 'tabs' | 'interactions';
  nodeId: string;
  pass: boolean;
  detail: string;
}

/** Behavioral-fidelity result (`16-behavior-conversion.md §6` frozen shape: `{probes:[…]}`). */
export interface BehavioralFidelityResult {
  probes: BehaviorProbe[];
}

/**
 * The `CoverageReport.behavior` section (contract `16-behavior-conversion.md §6`). ADVISORY in v1:
 * the behavior score is REPORTED but never gates commit — the visual coverage gate is unchanged,
 * hence the literal `behavior_gate:'advisory'` flag. `tiers` are COUNTS per assigned tier
 * (1=native widget, 2=native interaction, 3=JS passthrough, 4=honest drop) and MUST sum to
 * `detected.length` (§8 invariant 1 — enforced with a hard error by `buildBehaviorCoverage`).
 * `score = (t1 + t2 + 0.5*t3) / detected_total` (t4 contributes 0).
 */
export interface BehaviorCoverage {
  detected: DetectedBehavior[];
  tiers: {
    native: number;
    interactions: number;
    passthrough: number;
    dropped: number;
  };
  score: number;
  behavior_gate: 'advisory';
}

/**
 * The HTML→native coverage report (`diff.schema.json#/$defs/CoverageReport`, RESEARCH.md §6.6/§6.8).
 * Honest, per-section coverage; gates auto-commit (coverage anchored to the S3 corpus number, never a
 * hardcoded 85% — `15-engineering-standards.md §4.6`).
 */
export interface CoverageReport {
  coverage: {
    pct_native: number;
    pct_local_or_global_class: number;
    pct_custom_css: number;
    pct_dropped: number;
  };
  fallbacks: Array<{
    element_id: string;
    tier: DeclFallback['tier'];
    reason: string;
  }>;
  a11y: A11yFinding[];
  stripped_text: Array<{
    element_id: string;
    stripped_tags: string[];
  }>;
  visual_diff_score?: number;
  /**
   * Behavior-conversion coverage (contract 16 §6) — ADVISORY only, never gates commit. OMITTED
   * entirely when zero behaviors were detected so a zero-behavior page's report is byte-identical
   * to pre-contract-16 output (§8 invariant 5).
   */
  behavior?: BehaviorCoverage;
}
