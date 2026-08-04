/**
 * Contract 17 §1 — INTEGRITY INVARIANTS (I1–I4), the PURE pre-save checks of the closed-loop
 * converter (`17-conversion-integrity.md`).
 *
 * Every check in this module is a pure function over the WIRE-READY `ElementNode[]` forest (post
 * ASSEMBLE/HOIST/VARIABLE-EXTRACT, the exact tree handed to dry_run) plus the tier ledger the
 * pipeline accumulated. A violation here is a CONVERTER BUG, not a content problem — the
 * orchestrator (WP-H11) wires `runIntegrity` in front of the authoritative dry_run and HARD-FAILS
 * the conversion on any violation (`17 §1`: "violations are converter bugs, hard-fail").
 *
 *   - **I1 — Reference closure (both directions).** Every id in any node's `settings.classes`
 *     resolves to a style definition (node-local or global), AND every minted local style is
 *     referenced by its OWN node's `classes` (the authoring-contract §5.1 mirror). Page 1704 broke
 *     direction one (12 dangling refs → zero-size icons + deterministic CSS_PRIME_FAILED); the
 *     fleet audit found direction two (orphaned styles).
 *   - **I2 — Base-default safety.** For every mapped widget whose BASE styles paint (`BASE_DEFAULTS`
 *     table), any prop where the source's computed value differs from the widget's base default
 *     MUST be explicitly emitted. "Skip as no-op" is legal ONLY against a transparent/neutral base
 *     (kills the ghost-buttons-turn-blue class). The source computed values are not reachable from
 *     the wire tree, so the integrator supplies a `{nodeId → {prop → sourceValue}}` map (built from
 *     the IR `computed` sets via the assembler's `source_path → element_id` correspondence).
 *   - **I3 — Total accounting.** Every detected source declaration AND every inline-fold side
 *     effect lands in exactly one tier including `dropped` — `count(detected + folds) ==
 *     count(tiered)` where tiered = native typed props + every `DeclFallback` row.
 *   - **I4 — Computed-default noise excluded.** Browser-default computed values (`normal`/`auto`/
 *     `none`/zero-effect) must be filtered BEFORE tier accounting (the filter lives in the
 *     style-extract/classifier seam); `auditI4` asserts NONE remain in the post-filter ledger.
 *
 * No I/O, no WP client, no randomness — unit-testable without a browser (contract 17 §6 W1).
 */

import type { DeclFallback, ElementNode, StyleDefinition, StyleVariant } from './types.js';

/* ─────────────────────────── violation vocabulary ────────────────────────────────────────────── */

/** I1 — a broken reference-closure edge (one per unresolved/unmirrored style id). */
export interface I1Violation {
  invariant: 'I1';
  /** The minted element id the violation sits on. */
  nodeId: string;
  /** The style id that fails closure. */
  styleId: string;
  /**
   * `dangling_ref`   — the id appears in `settings.classes.value` but resolves to NO style
   *                    definition (node-local anywhere in the tree, or global). The page-1704 class.
   * `orphaned_style` — the id is a minted local style in `node.styles` but is absent from that
   *                    SAME node's `settings.classes.value` (§5.1 mirror — the style silently
   *                    detaches). The fleet-audit class.
   */
  direction: 'dangling_ref' | 'orphaned_style';
  detail: string;
}

/** I2 — a painting base default left to paint through (source differed, nothing emitted). */
export interface I2Violation {
  invariant: 'I2';
  nodeId: string;
  /** The widget key the base default belongs to (`e-button`/`e-flexbox`/`e-div-block`/`e-svg`). */
  widget: string;
  /** The SOURCE computed longhand that differs from the base default (`BaseDefaultRule.source_prop`). */
  prop: string;
  source_value: string;
  base_default: string;
  detail: string;
}

/** I3 — the tier ledger does not account for every detected declaration + inline-fold side effect. */
export interface I3Violation {
  invariant: 'I3';
  /** detected declarations + inline-fold side effects. */
  expected: number;
  /** native typed props + DeclFallback rows (every tier incl. dropped). */
  actual: number;
  detail: string;
}

/** I4 — a computed-default-noise entry survived into the post-filter tier ledger. */
export interface I4Violation {
  invariant: 'I4';
  source_path: string;
  declaration: string;
  tier: DeclFallback['tier'];
  detail: string;
}

/** The discriminated union `runIntegrity` aggregates (discriminate on `invariant`). */
export type IntegrityViolation = I1Violation | I2Violation | I3Violation | I4Violation;

/* ─────────────────────────── wire-tree readers (defensive, classic-tolerant) ─────────────────── */

/**
 * Read a node's `classes` ids leniently: `{$$type:'classes', value: string[]}` → the string members;
 * anything else (classic V3 flat settings, absent key, malformed envelope) → `null` (the node simply
 * does not participate in atomic class closure — classic nodes carry no atomic styles).
 */
function classIdsOf(node: ElementNode): string[] | null {
  const raw = (node.settings as Record<string, unknown> | undefined)?.['classes'];
  if (raw === null || typeof raw !== 'object') return null;
  const envelope = raw as { $$type?: unknown; value?: unknown };
  if (envelope.$$type !== 'classes' || !Array.isArray(envelope.value)) return null;
  return envelope.value.filter((v): v is string => typeof v === 'string');
}

/** Read a node's local styles map (classic nodes have none — empty map). */
function localStylesOf(node: ElementNode): Record<string, StyleDefinition> {
  const styles = (node as { styles?: Record<string, StyleDefinition> }).styles;
  return styles ?? {};
}

/** Depth-first, document-order walk over a wire forest. */
function walkNodes(elements: ElementNode[], visit: (node: ElementNode) => void): void {
  for (const node of elements) {
    visit(node);
    if (Array.isArray(node.elements) && node.elements.length > 0) {
      walkNodes(node.elements, visit);
    }
  }
}

/**
 * Resolve the widget key `BASE_DEFAULTS` is indexed by: atomic widgets serialize
 * `elType:'widget' + widgetType:'e-*'`; atomic containers carry the type on `elType` directly.
 * Classic nodes → `null` (no atomic base styles).
 */
function widgetKeyOf(node: ElementNode): string | null {
  if (node.elType === 'widget') {
    const widgetType = (node as { widgetType?: string }).widgetType;
    return widgetType !== undefined && widgetType.startsWith('e-') ? widgetType : null;
  }
  return node.elType.startsWith('e-') ? node.elType : null;
}

/* ─────────────────────────── I1 — reference closure (both directions) ────────────────────────── */

/**
 * I1 — reference closure, BOTH directions (contract 17 §1).
 *
 * Direction one (`dangling_ref`): every id in any node's `settings.classes.value` must resolve to a
 * style definition — a local style on SOME node in the forest, or a global class id. (The contract
 * says "node-local or global"; a cross-node local ref still renders — atomic CSS collects every
 * styles-map entry document-wide — so resolution is checked against the whole forest, while the
 * same-node mirror is direction two's job.)
 *
 * Direction two (`orphaned_style`): every minted local style in `node.styles` must be referenced by
 * its OWN node's `classes` (authoring-contract §5.1 — an unmirrored style silently detaches).
 *
 * Pure; classic nodes (no typed `classes` envelope, no styles map) are skipped.
 */
export function checkI1(elements: ElementNode[], globalClassIds: Iterable<string>): I1Violation[] {
  const globals = new Set(globalClassIds);

  // Pass 1 — every local style id defined anywhere in the forest (direction-one resolution set).
  const allLocalStyleIds = new Set<string>();
  walkNodes(elements, (node) => {
    for (const styleId of Object.keys(localStylesOf(node))) {
      allLocalStyleIds.add(styleId);
    }
  });

  // Pass 2 — both directions per node.
  const violations: I1Violation[] = [];
  walkNodes(elements, (node) => {
    const classIds = classIdsOf(node);
    const styles = localStylesOf(node);

    if (classIds !== null) {
      for (const styleId of classIds) {
        // Preserved SOURCE classes (`preserve_source_classes`) are plain semantic tokens, never
        // style refs — only SYSTEM-shaped ids (assemble-minted `e-…` locals / kit `g-…` globals)
        // must resolve. The assemble sanitizer skips every e-/g-/elementor-prefixed source token,
        // so the prefix is the airtight discriminator at this seam.
        if (!styleId.startsWith('e-') && !styleId.startsWith('g-')) continue;
        if (globals.has(styleId) || allLocalStyleIds.has(styleId)) continue;
        violations.push({
          invariant: 'I1',
          nodeId: node.id,
          styleId,
          direction: 'dangling_ref',
          detail:
            `settings.classes id "${styleId}" on element "${node.id}" resolves to no local style ` +
            'or global class — the rendered element silently loses these styles (page-1704 class).',
        });
      }
    }

    const mirrored = new Set(classIds ?? []);
    for (const styleId of Object.keys(styles)) {
      if (mirrored.has(styleId)) continue;
      violations.push({
        invariant: 'I1',
        nodeId: node.id,
        styleId,
        direction: 'orphaned_style',
        detail:
          `local style "${styleId}" on element "${node.id}" is in the styles map but absent from ` +
          'settings.classes.value — it silently detaches (authoring-contract §5.1 mirror).',
      });
    }
  });

  return violations;
}

/* ─────────────────────────── I2 — base-default safety ────────────────────────────────────────── */

/** One base-default rule: a source computed longhand, the widget's base value, and what satisfies it. */
export interface BaseDefaultRule {
  /** The SOURCE computed longhand looked up in the integrator-supplied source map. */
  source_prop: string;
  /** The widget base-style computed value for that longhand (normalized comparison). */
  base_default: string;
  /**
   * Style-prop keys whose presence in any BASE variant (state null, breakpoint null/desktop) of the
   * node's local styles — or of a referenced global class — satisfies the explicit-emission rule.
   */
  satisfied_by: string[];
}

/** Per-widget base-default rules (`BASE_DEFAULTS` table shape). */
export type BaseDefaultsTable = Record<string, BaseDefaultRule[]>;

/** Build the four padding-side rules for a widget whose base padding paints `value` on every side. */
function paddingRules(value: string): BaseDefaultRule[] {
  return (['top', 'right', 'bottom', 'left'] as const).map((side) => ({
    source_prop: `padding-${side}`,
    base_default: value,
    satisfied_by: ['padding', `padding-${side}`],
  }));
}

/**
 * The PAINTING base defaults per mapped atomic widget (contract 17 §1 I2). Values are the widget
 * base-style COMPUTED values verified on the live registry:
 *   - `e-button`: blue fill `rgb(55, 94, 251)`, `12px/24px` padding, `2px` radius, centered text;
 *   - `e-flexbox`: `10px` padding on every side, `column` direction;
 *   - `e-div-block`: `10px` padding on every side;
 *   - `e-svg`: `50px × 50px`.
 * A source computed value that differs from any of these MUST be explicitly emitted — skipping it
 * as a "no-op" lets the base paint through (ghost buttons turn blue, icons balloon to 50px).
 */
export const BASE_DEFAULTS: BaseDefaultsTable = {
  'e-button': [
    {
      source_prop: 'background-color',
      base_default: 'rgb(55, 94, 251)',
      satisfied_by: ['background', 'background-color'],
    },
    ...paddingRules('12px').map((rule) =>
      rule.source_prop === 'padding-left' || rule.source_prop === 'padding-right'
        ? { ...rule, base_default: '24px' }
        : rule,
    ),
    ...(
      [
        'border-top-left-radius',
        'border-top-right-radius',
        'border-bottom-right-radius',
        'border-bottom-left-radius',
      ] as const
    ).map((corner) => ({
      source_prop: corner,
      base_default: '2px',
      satisfied_by: ['border-radius', corner],
    })),
    { source_prop: 'text-align', base_default: 'center', satisfied_by: ['text-align'] },
  ],
  'e-flexbox': [
    ...paddingRules('10px'),
    { source_prop: 'flex-direction', base_default: 'column', satisfied_by: ['flex-direction'] },
  ],
  'e-div-block': [...paddingRules('10px')],
  'e-svg': [
    { source_prop: 'width', base_default: '50px', satisfied_by: ['width', 'size'] },
    { source_prop: 'height', base_default: '50px', satisfied_by: ['height', 'size'] },
  ],
};

/**
 * The integrator-supplied source-computed correspondence: minted element id → the source node's
 * computed longhands (from the IR `computed` set, paired via the assembler's `source_path →
 * element_id` map). I2 can only judge what the integrator surfaces; absent nodes/props are skipped.
 */
export type SourceComputedMap = Record<string, Record<string, string>>;

/**
 * Normalize a CSS value for comparison: lowercase, collapse whitespace (incl. inside `rgb(…)`),
 * canonicalize bare `0` tokens to `0px`. Computed-value comparison only — no shorthand expansion.
 */
function normalizeCssValue(value: string): string {
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1');
  return collapsed
    .split(' ')
    .map((token) => (/^[+-]?0(\.0+)?$/.test(token) ? '0px' : token))
    .join(' ');
}

/** A BASE variant paints the desktop/normal state: state null + breakpoint null/desktop. */
function isBaseVariant(variant: StyleVariant): boolean {
  const { breakpoint, state } = variant.meta;
  return (
    (state === null || state === undefined) && (breakpoint === null || breakpoint === 'desktop')
  );
}

/**
 * Collect what the node explicitly emits at BASE: the prop keys of every base variant of its local
 * styles and referenced global classes, plus a custom-css haystack (base64-decoded `custom_css.raw`
 * + the raw itself) so a custom_css-tier emission still satisfies I2.
 */
function collectBaseEmissions(
  node: ElementNode,
  globalClasses: Record<string, StyleDefinition> | undefined,
): { props: Set<string>; customCss: string } {
  const props = new Set<string>();
  let customCss = '';

  const fold = (def: StyleDefinition): void => {
    for (const variant of def.variants) {
      if (!isBaseVariant(variant)) continue;
      for (const key of Object.keys(variant.props)) {
        props.add(key);
      }
      const raw = variant.custom_css?.raw;
      if (typeof raw === 'string' && raw !== '') {
        customCss += ` ${raw} ${Buffer.from(raw, 'base64').toString('utf8')}`;
      }
    }
  };

  for (const def of Object.values(localStylesOf(node))) {
    fold(def);
  }
  if (globalClasses !== undefined) {
    for (const classId of classIdsOf(node) ?? []) {
      const def = globalClasses[classId];
      if (def !== undefined) fold(def);
    }
  }

  return { props, customCss: customCss.toLowerCase() };
}

/**
 * I2 — base-default safety (contract 17 §1).
 *
 * For every mapped widget present in `baseDefaults` whose base styles paint, compare the SOURCE
 * computed value (the integrator-supplied `sourceComputed` map) against the widget's base default:
 * when they differ, an explicit prop MUST be emitted in a base variant (local style, referenced
 * global class, or custom_css). Equal-to-base sources need nothing (the base legitimately paints);
 * nodes/props absent from `sourceComputed` are skipped (nothing to judge — the integrator owns the
 * correspondence).
 */
export function checkI2(
  elements: ElementNode[],
  sourceComputed: SourceComputedMap,
  baseDefaults: BaseDefaultsTable = BASE_DEFAULTS,
  globalClasses?: Record<string, StyleDefinition>,
): I2Violation[] {
  const violations: I2Violation[] = [];

  walkNodes(elements, (node) => {
    const widget = widgetKeyOf(node);
    if (widget === null) return;
    const rules = baseDefaults[widget];
    const source = sourceComputed[node.id];
    if (rules === undefined || source === undefined) return;

    const emitted = collectBaseEmissions(node, globalClasses);

    for (const rule of rules) {
      const sourceValue = source[rule.source_prop];
      if (sourceValue === undefined) continue;
      if (normalizeCssValue(sourceValue) === normalizeCssValue(rule.base_default)) continue;

      const satisfied =
        rule.satisfied_by.some((key) => emitted.props.has(key)) ||
        (emitted.customCss !== '' &&
          [rule.source_prop, ...rule.satisfied_by].some((key) => emitted.customCss.includes(key)));
      if (satisfied) continue;

      violations.push({
        invariant: 'I2',
        nodeId: node.id,
        widget,
        prop: rule.source_prop,
        source_value: sourceValue,
        base_default: rule.base_default,
        detail:
          `${widget} "${node.id}": source ${rule.source_prop} is "${sourceValue}" but the widget ` +
          `base default "${rule.base_default}" paints and no explicit ` +
          `${rule.satisfied_by.join('/')} prop was emitted in a base variant — the base bleeds ` +
          'through (ghost-button class).',
      });
    }
  });

  return violations;
}

/* ─────────────────────────── I3 — total accounting ───────────────────────────────────────────── */

/**
 * The accounting ledger the integrator assembles for I3/I4 (contract 17 §1):
 *   - `detected_declarations`  — source declarations STYLE-EXTRACT considered, AFTER the I4
 *      computed-default-noise filter (real declarations only). MUST come from the PRODUCER's own
 *      seam tally (`StyleExtractResult.detected_declarations`) — never re-derived from the same
 *      post-tier arrays compared below, or I3 collapses into a tautology;
 *   - `inline_fold_effects`    — inline-fold side effects (styling lost when inline children were
 *      folded into html-v3, e.g. accent colors on `<em>`/`<span>`) — each must carry a tier row;
 *   - `pseudo_drop_effects`    — unrepresentable `::before`/`::after` pseudo-elements NORMALIZE
 *      honestly dropped (#10, reason `pseudo_unrepresentable`) — each must carry a tier row
 *      (optional for ledger-builders predating #10; absent = 0);
 *   - `native_count`           — natively-mapped declarations (typed props placed in styled-node
 *      variants; `countNativeProps`), i.e. the implicit `native`-tier entries;
 *   - `declaration_fallbacks`  — every NON-native tier row incl. dropped (`html_widget`) — the
 *      explicit ledger entries (style-extract rows + the inline-fold rows + the pseudo-drop rows).
 */
export interface AccountingLedger {
  detected_declarations: number;
  inline_fold_effects: number;
  pseudo_drop_effects?: number;
  native_count: number;
  declaration_fallbacks: DeclFallback[];
}

/**
 * I3 — total accounting (contract 17 §1): every detected declaration, every inline-fold side
 * effect AND every pseudo-element drop lands in EXACTLY one tier (including dropped) —
 * `detected + folds + pseudo drops == native + fallbacks`. A mismatch in either direction is a
 * violation: short means silent loss (entries never tiered), long means fabricated entries
 * (double counting).
 */
export function checkI3(ledger: AccountingLedger): I3Violation[] {
  const pseudoDrops = ledger.pseudo_drop_effects ?? 0;
  const expected = ledger.detected_declarations + ledger.inline_fold_effects + pseudoDrops;
  const actual = ledger.native_count + ledger.declaration_fallbacks.length;
  if (expected === actual) return [];
  return [
    {
      invariant: 'I3',
      expected,
      actual,
      detail:
        `tier ledger does not balance: ${String(ledger.detected_declarations)} detected ` +
        `declarations + ${String(ledger.inline_fold_effects)} inline-fold side effects + ` +
        `${String(pseudoDrops)} pseudo-element drops = ` +
        `${String(expected)} expected entries, but ${String(ledger.native_count)} native props + ` +
        `${String(ledger.declaration_fallbacks.length)} fallback rows = ${String(actual)} tiered — ` +
        (actual < expected
          ? 'declarations were silently lost without a tier entry.'
          : 'tier entries were fabricated / double-counted.'),
    },
  ];
}

/* ─────────────────────────── I4 — computed-default noise audit ───────────────────────────────── */

/**
 * Is `prop: value` browser-default computed-value NOISE (contract 17 §1 I4 vocabulary:
 * `normal`/`auto`/`none`/zero-effect)? Exported as the shared predicate so the pre-accounting
 * FILTER (style-extract seam) and this post-filter audit cannot drift.
 *
 * Deliberate carve-outs (documented judgment calls):
 *   - `none` on `display`/`text-decoration`/`text-decoration-line` is MEANINGFUL (hides the
 *     element / strips the UA anchor underline), never noise;
 *   - `opacity: 0` is fully-hidden, not zero-EFFECT — excluded from the zero rule;
 *   - `transparent` is NOT noise here: transparent-vs-painted-base is I2's judgment (legal only
 *     against a neutral base), so the noise filter must not eat it.
 */
export function isComputedDefaultNoise(prop: string, value: string): boolean {
  const p = prop.trim().toLowerCase();
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ');

  if (v === 'normal' || v === 'auto') return true;
  if (v === 'none') {
    return !MEANINGFUL_NONE_PROPS.has(p);
  }

  if (p === 'opacity') return false;
  const tokens = v.split(' ');
  return tokens.length > 0 && tokens.every((token) => ZERO_EFFECT_TOKEN.test(token));
}

/** Props where computed `none` is an ACTIVE override, not browser-default noise. */
const MEANINGFUL_NONE_PROPS: ReadonlySet<string> = new Set([
  'display',
  'text-decoration',
  'text-decoration-line',
]);

/** A single zero-effect value token (`0`, `0px`, `0s`, `0%`, `0deg`, …). */
const ZERO_EFFECT_TOKEN = /^[+-]?0(\.0+)?(px|em|rem|%|s|ms|deg|vh|vw|fr)?$/;

/**
 * I4 — audit the POST-FILTER tier ledger for computed-default noise (contract 17 §1). The actual
 * filter runs upstream (before tier accounting); this audit asserts it worked — any surviving
 * `normal`/`auto`/`none`/zero-effect entry means the coverage numbers are diluted by non-loss and
 * the filter has a hole. Ledger rows whose `declaration` is not `prop: value`-shaped are ignored
 * (nothing to judge).
 */
export function auditI4(fallbacks: DeclFallback[]): I4Violation[] {
  const violations: I4Violation[] = [];
  for (const fallback of fallbacks) {
    const match = /^([a-z-]+)\s*:\s*(.+)$/i.exec(fallback.declaration);
    if (match === null) continue;
    const [, prop = '', value = ''] = match;
    if (!isComputedDefaultNoise(prop, value)) continue;
    violations.push({
      invariant: 'I4',
      source_path: fallback.source_path,
      declaration: fallback.declaration,
      tier: fallback.tier,
      detail:
        `computed-default noise "${fallback.declaration}" survived into the ${fallback.tier} tier ` +
        `ledger at "${fallback.source_path}" — the I4 filter must drop browser-default values ` +
        'BEFORE tier accounting so coverage reflects real loss only.',
    });
  }
  return violations;
}

/* ─────────────────────────── runIntegrity — the pre-save aggregate ───────────────────────────── */

/** Aggregate input for `runIntegrity` — the integrator (WP-H11) wires every field. */
export interface IntegrityInput {
  /** The wire-ready forest (post assemble/hoist/variable-extract — the tree handed to dry_run). */
  elements: ElementNode[];
  /** Every global class id resolvable on the site (existing + about-to-be-committed proposals). */
  global_class_ids: Iterable<string>;
  /** Optional global class DEFINITIONS, so I2 sees props satisfied via hoisted classes. */
  global_classes?: Record<string, StyleDefinition>;
  /** I2 source correspondence (`element_id → {prop → source computed value}`); omitted → I2 skipped. */
  source_computed?: SourceComputedMap;
  /** Override the I2 base-default table (defaults to `BASE_DEFAULTS`). */
  base_defaults?: BaseDefaultsTable;
  /** I3/I4 accounting ledger; omitted → I3/I4 skipped. */
  ledger?: AccountingLedger;
}

/** `runIntegrity` verdict: the full violation list + the contract-17 §1 hard-fail flag. */
export interface IntegrityRunResult {
  violations: IntegrityViolation[];
  /** True when ANY invariant is violated — contract 17 §1: violations are converter bugs, hard-fail. */
  hardFail: boolean;
}

/**
 * Run every integrity invariant the supplied inputs allow (contract 17 §1, wired PRE-save by the
 * orchestrator): I1 always; I2 when `source_computed` is supplied; I3 + I4 when `ledger` is
 * supplied. Pure; returns the aggregated violation list and `hardFail` (any violation — a
 * violated invariant is a converter BUG, and a bad conversion never silently persists).
 */
export function runIntegrity(input: IntegrityInput): IntegrityRunResult {
  const violations: IntegrityViolation[] = [...checkI1(input.elements, input.global_class_ids)];

  if (input.source_computed !== undefined) {
    violations.push(
      ...checkI2(
        input.elements,
        input.source_computed,
        input.base_defaults ?? BASE_DEFAULTS,
        input.global_classes,
      ),
    );
  }

  if (input.ledger !== undefined) {
    violations.push(...checkI3(input.ledger));
    violations.push(...auditI4(input.ledger.declaration_fallbacks));
  }

  return { violations, hardFail: violations.length > 0 };
}
