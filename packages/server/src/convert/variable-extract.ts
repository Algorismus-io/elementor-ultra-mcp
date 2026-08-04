/**
 * WP-H09 — VARIABLE-EXTRACT stage (impl of `extractVariables`, frozen seam `convert/types.ts`, WP-H01).
 *
 * The companion of HOIST (RESEARCH.md §6.3 "Variable extraction", authoring-contract §3.1/§6.3): dedupe
 * literal COLORS → `global-color-variable`, FONT stacks → `global-font-variable`, recurring SIZES →
 * `global-size-variable` — ALL THREE FREE (NEVER Pro-gate or strip size variables; RESEARCH.md §6.3 /
 * authoring-contract §3.1, `variables/hooks.php:48-51`). A literal becomes a variable when it occurs on
 * >= `ctx.min_uses` distinct nodes OR matches an existing kit variable (reuse). Each extracted literal
 * typed value in the tree is REPLACED with a variable-reference envelope
 * (`{$$type:'global-color-variable', value:'<var-id-placeholder>'}`, authoring-contract §3.1 — renders
 * `var(--Label)`); the placeholder resolves to a real `e-gv-*` id at persist (WP-H11).
 *
 * It MUTATES nothing on the site — it only PROPOSES. Persistence (the watermark `variables.batch`, 10-
 * rest-api §Design) is the orchestrator's job (WP-H11) against WP-P09; this stage builds the proposals in
 * the exact shape that body needs and pre-flights the 1000-item VARIABLE budget (error-taxonomy §3.3
 * `BUDGET_EXCEEDED`, SEPARATE from the class budget) WITHOUT throwing.
 *
 * Existing-variable reuse (Detailed Requirement 6, RESEARCH.md §6.3 "Detect & reuse existing kit tokens
 * first"): a literal matching an existing kit variable by (type, normalized value) reuses that variable's
 * id + label — no duplicate proposal, no budget impact.
 *
 * PURE + deterministic given `(elements, literals, ctx)`. No WP-client import (the existing variable set
 * is injected via `ctx`). Does NOT prime CSS. PHP `dry_run` (WP-P03) is authoritative on the rebound tree.
 *
 * `VarContext`/`VarResult`/`ProposedVariable`/`BudgetReport`/`VariableDef`/`LiteralRef` are FROZEN in
 * WP-H01 (`types.ts`); `ElementNode`/`StyleDefinition`/`StyleVariant`/`TypedValue` are FROZEN in WP-F03.
 * None are redeclared here.
 */

import type {
  ElementNode,
  StyleDefinition,
  StyleVariant,
  TypedValue,
} from '../authoring/contract.js';
import type {
  BudgetReport,
  LiteralRef,
  ProposedVariable,
  VarContext,
  VariableDef,
  VarResult,
} from './types.js';

/* ─────────────────────────── placeholder var-id scheme (WP-H11 resolves) ─────────────────────── */

/**
 * The deterministic PLACEHOLDER variable id VARIABLE-EXTRACT emits (Implementation Notes
 * "placeholder var-id / class-id scheme"): `__var:<kind>:<normalized-value>`. WP-H11 resolves each
 * placeholder to the real `e-gv-*` id the `variables.batch` mints, then rewrites the tree references in
 * ONE pass. For a REUSED existing variable the placeholder is the existing id directly (no resolve step).
 */
export function placeholderVarId(kind: LiteralRef['kind'], normValue: string): string {
  return `__var:${kind}:${normValue}`;
}

/** True iff a var ref value is a VARIABLE-EXTRACT placeholder (`__var:*`) the orchestrator resolves. */
export function isPlaceholderVarId(value: string): boolean {
  return value.startsWith('__var:');
}

/* ─────────────────────────── literal kind → variable type mapping ────────────────────────────── */

const KIND_TO_VAR_TYPE: Record<LiteralRef['kind'], ProposedVariable['type']> = {
  color: 'global-color-variable',
  font: 'global-font-variable',
  size: 'global-size-variable',
};

/* ─────────────────────────── value normalization (dedupe key) ────────────────────────────────── */

/**
 * Normalize a literal value to a stable dedupe key. Colors lower-cased + whitespace-stripped; fonts
 * lower-cased + inner-whitespace collapsed; sizes whitespace-stripped + lower-cased. (Authoritative
 * color equality is PHP's job; this is the conservative TS dedupe.)
 */
function normalizeLiteral(kind: LiteralRef['kind'], value: string): string {
  const trimmed = value.trim();
  if (kind === 'color') {
    return trimmed.toLowerCase().replace(/\s+/g, '');
  }
  if (kind === 'font') {
    return trimmed
      .toLowerCase()
      .replace(/\s*,\s*/g, ',')
      .replace(/\s+/g, ' ');
  }
  // size
  return trimmed.toLowerCase().replace(/\s+/g, '');
}

/* ─────────────────────────── meaningful variable labels ──────────────────────────────────────── */

/** A short stable hex token from a string seed, for fallback labels. */
function shortHex(seed: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 8);
}

/**
 * Build a human-meaningful variable label (SUPPLEMENT §C.2 "generate human-meaningful names"): a
 * type-prefixed, value-derived, charset-safe name. Colors → `color-<hex-or-token>`; fonts → the primary
 * family name; sizes → `size-<digits><unit>`. Deduped against `usedLabels`.
 */
function chooseVarLabel(
  kind: LiteralRef['kind'],
  rawValue: string,
  normValue: string,
  usedLabels: Set<string>,
): string {
  let base: string;
  if (kind === 'color') {
    const hex = /^#([0-9a-f]{3,8})$/i.exec(normValue);
    base = hex !== null ? `color-${hex[1] as string}` : `color-${shortHex(normValue)}`;
  } else if (kind === 'font') {
    // Primary family (first stack entry), stripped of quotes.
    const primary = rawValue.split(',')[0]?.trim().replace(/['"]/g, '') ?? rawValue;
    const slug = primary.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    base = slug.length > 0 ? `font-${slug}` : `font-${shortHex(normValue)}`;
  } else {
    // size: `size-16px` / `size-1-5rem`
    const slug = normValue.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    base = slug.length > 0 ? `size-${slug}` : `size-${shortHex(normValue)}`;
  }
  // Clamp + lower-case-friendly dedupe.
  if (base.length > 50) {
    base = base.slice(0, 50);
  }
  return dedupeLabel(base, usedLabels);
}

/** Append a `-2`/`-3`/... suffix until the (lower-cased) label is unused. */
function dedupeLabel(base: string, usedLabels: Set<string>): string {
  if (!usedLabels.has(base.toLowerCase())) {
    return base;
  }
  for (let n = 2; n < 10000; n++) {
    const suffix = `-${String(n)}`;
    const trimmed = base.length + suffix.length > 50 ? base.slice(0, 50 - suffix.length) : base;
    const candidate = `${trimmed}${suffix}`;
    if (!usedLabels.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${base.slice(0, 40)}-${shortHex(`${base}:${String(usedLabels.size)}`)}`;
}

/* ─────────────────────────── existing-variable reuse index ───────────────────────────────────── */

/** Build a `(type|normValue) → existing VariableDef` index for reuse (Detailed Requirement 6). */
function indexExistingVariables(existing: VariableDef[]): Map<string, VariableDef> {
  const idx = new Map<string, VariableDef>();
  for (const v of existing) {
    const kind = varTypeToKind(v.type);
    if (kind === null) {
      continue;
    }
    const key = `${v.type}|${normalizeLiteral(kind, v.value)}`;
    if (!idx.has(key)) {
      idx.set(key, v);
    }
  }
  return idx;
}

/** Map a variable `$$type` back to a `LiteralRef.kind` (`null` if unrecognized). */
function varTypeToKind(type: VariableDef['type']): LiteralRef['kind'] | null {
  if (type === 'global-color-variable') {
    return 'color';
  }
  if (type === 'global-font-variable') {
    return 'font';
  }
  if (type === 'global-size-variable') {
    return 'size';
  }
  return null;
}

/* ─────────────────────────── typed-value literal classification ──────────────────────────────── */

/** A literal a typed value carries (for matching against the chosen variable set). */
interface ValueLiteral {
  kind: LiteralRef['kind'];
  /** The RAW literal string (as authored in the envelope). */
  raw: string;
}

/**
 * Read the literal a leaf typed value carries (color / font / size), or `null` if it is not a literal
 * VARIABLE-EXTRACT extracts (e.g. an already-bound variable ref, an object/array envelope handled by
 * recursion). Used both to decide replacement AND to feed the literal index from a tree scan.
 */
function readLeafLiteral(tv: TypedValue, propName: string | null): ValueLiteral | null {
  const type = tv.$$type;
  if (type === 'color' && typeof tv.value === 'string') {
    return { kind: 'color', raw: tv.value };
  }
  if (type === 'size') {
    const v = tv.value as { unit?: string; size?: number | string | null } | undefined;
    if (v !== undefined && v.size !== undefined && v.size !== null) {
      const unit = typeof v.unit === 'string' ? v.unit : '';
      // Sentinel units (auto) are not size LITERALS.
      if (unit !== 'auto' && unit !== 'custom') {
        return { kind: 'size', raw: `${String(v.size)}${unit}` };
      }
    }
    return null;
  }
  // font-family is a `string` envelope; only treat it as a font literal when the prop is font-family.
  if (type === 'string' && propName === 'font-family' && typeof tv.value === 'string') {
    return { kind: 'font', raw: tv.value };
  }
  return null;
}

/* ─────────────────────────── chosen-variable lookup table ────────────────────────────────────── */

/** The resolved variable a literal binds to: its (placeholder or existing) id + the var record. */
interface ChosenVar {
  id: string;
  /** True for a NEW proposal (counts toward the budget); false for an existing-kit reuse. */
  isNew: boolean;
}

/* ─────────────────────────── budget pre-flight (error-taxonomy §3.3) ─────────────────────────── */

/** Build a `BudgetReport`: `projected = current + would_add` (extraction never deletes). */
function buildBudget(current: number, wouldAdd: number, max: number): BudgetReport {
  const projected = current + wouldAdd;
  return {
    current_count: current,
    would_add: wouldAdd,
    would_delete: 0,
    projected,
    max_allowed: max,
    exceeded: projected > max,
  };
}

/* ─────────────────────────── tree rebind walk ────────────────────────────────────────────────── */

/** Mutable rebind state threaded through the tree walk. */
interface RebindState {
  /** `(kind|normValue) → ChosenVar` for the literals selected for extraction. */
  chosen: Map<string, ChosenVar>;
  /** `var-id → element-ids` rebind audit (the frozen `var_rebinds`). */
  rebinds: Record<string, string[]>;
}

/** The chosen-var key for a literal. */
function chosenKey(kind: LiteralRef['kind'], normValue: string): string {
  return `${kind}|${normValue}`;
}

/**
 * Recursively rewrite a typed value, replacing any extractable LEAF literal that was chosen for
 * extraction with the variable-reference envelope. Returns the (possibly new) typed value and records
 * the rebind under the owning element id. Recurses into ARRAY (`value:[]`) and OBJECT (`value:{}`)
 * envelopes so nested literals (e.g. a `box-shadow` color, a `background-overlay` color) are caught.
 */
function rewriteTypedValue(
  tv: TypedValue,
  propName: string | null,
  elementId: string | undefined,
  state: RebindState,
): TypedValue {
  // Leaf literal? Try to bind it.
  const leaf = readLeafLiteral(tv, propName);
  if (leaf !== null) {
    const norm = normalizeLiteral(leaf.kind, leaf.raw);
    const chosen = state.chosen.get(chosenKey(leaf.kind, norm));
    if (chosen !== undefined) {
      recordRebind(state, chosen.id, elementId);
      return { $$type: KIND_TO_VAR_TYPE[leaf.kind], value: chosen.id };
    }
    return tv;
  }

  // Recurse into ARRAY envelopes (`value` is an array of wrapped items).
  if (Array.isArray(tv.value)) {
    const items = tv.value as unknown[];
    const next: unknown[] = items.map((item) =>
      isTypedValue(item) ? rewriteTypedValue(item, null, elementId, state) : item,
    );
    return { ...tv, value: next };
  }

  // Recurse into OBJECT envelopes (`value` is an assoc map of wrapped fields).
  if (typeof tv.value === 'object' && tv.value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tv.value as Record<string, unknown>)) {
      out[k] = isTypedValue(v) ? rewriteTypedValue(v, k, elementId, state) : v;
    }
    return { ...tv, value: out };
  }

  return tv;
}

/** Cheap structural TypedValue guard (mirrors `envelopes.isTypedValue` without the import cycle). */
function isTypedValue(value: unknown): value is TypedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { $$type?: unknown }).$$type === 'string' &&
    'value' in value
  );
}

/** Record a `var-id → element-id` rebind (dedup-safe). */
function recordRebind(state: RebindState, varId: string, elementId: string | undefined): void {
  if (elementId === undefined) {
    return;
  }
  const list = state.rebinds[varId] ?? [];
  if (!list.includes(elementId)) {
    list.push(elementId);
  }
  state.rebinds[varId] = list;
}

/** Rewrite every variant's props in a `StyleDefinition` in place against the chosen-var set. */
function rewriteStyleDef(
  def: StyleDefinition,
  elementId: string | undefined,
  state: RebindState,
): void {
  for (const variant of def.variants) {
    rewriteVariantProps(variant, elementId, state);
  }
}

/** Rewrite one variant's props map (each value a TypedValue). */
function rewriteVariantProps(
  variant: StyleVariant,
  elementId: string | undefined,
  state: RebindState,
): void {
  for (const [prop, tv] of Object.entries(variant.props)) {
    variant.props[prop] = rewriteTypedValue(tv, prop, elementId, state);
  }
}

/** Walk a node subtree, rewriting local-style props (and settings) against the chosen-var set. */
function rewriteNode(node: ElementNode, state: RebindState): void {
  const elementId = (node as { id?: string }).id;

  // Local styles (atomic nodes).
  const stylesMap = (node as { styles?: Record<string, StyleDefinition> }).styles;
  if (stylesMap !== undefined && typeof stylesMap === 'object') {
    for (const def of Object.values(stylesMap)) {
      rewriteStyleDef(def, elementId, state);
    }
  }

  // Atomic settings typed values (a color/size/font literal could live in a setting too, e.g. a
  // divider color). `classes` is a BARE string array (not a leaf literal) — recursion skips it since
  // its array items are strings, not TypedValues.
  const settings = (node as { settings?: Record<string, unknown> }).settings;
  if (settings !== undefined && typeof settings === 'object') {
    for (const [prop, value] of Object.entries(settings)) {
      if (isTypedValue(value)) {
        settings[prop] = rewriteTypedValue(value, prop, elementId, state);
      }
    }
  }

  const children = (node as { elements?: ElementNode[] }).elements;
  if (Array.isArray(children)) {
    for (const child of children) {
      rewriteNode(child, state);
    }
  }
}

/* ─────────────────────────── font-family quoting ────────────────────────────────────────────── */

/**
 * Quote each family name in a comma-separated font-family stack so it survives CSS var() substitution.
 * `font-family: var(--x)` substitutes the raw variable text; if the text contains ` - ` the hyphen is
 * a CSS delimiter token, not part of an identifier, and the declaration is silently dropped.
 * Wrapping each family in single quotes is valid CSS and matches the @font-face family name.
 * Single-word names (Inter, serif, etc.) are left unquoted — they parse correctly without quotes.
 */
function quoteFontFamilyStack(stack: string): string {
  return stack
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      // Already quoted or a single-word CSS identifier (letters/digits/hyphens only) → leave as-is.
      if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
      if (/^[\w-]+$/.test(trimmed)) return trimmed;
      return `'${trimmed}'`;
    })
    .join(', ');
}

/* ─────────────────────────── the stage entry point ──────────────────────────────────────────── */

/**
 * VARIABLE-EXTRACT: dedupe literal colors/fonts/sizes into proposed variables (reusing existing kit
 * variables by value), rebind the tree's literal typed values to variable-reference envelopes, and
 * pre-flight the 1000-item VARIABLE budget. A literal extracts when it occurs on >= `ctx.min_uses`
 * distinct nodes OR matches an existing kit variable. Returns the rebound tree + proposals + rebinds +
 * budget + warnings.
 *
 * The `literals` input is STYLE-EXTRACT's `proposed_variable_literals` (`LiteralRef[]`, WP-H07) — the
 * primary occurrence source. The tree is ALSO scanned so a literal that appears in a setting (not just a
 * style) is still counted/rebound. The tree is DEEP-CLONED before mutation (idempotent + pure-ish).
 */
export function extractVariables(
  elements: ElementNode[],
  literals: LiteralRef[],
  ctx: VarContext,
): VarResult {
  const warnings: string[] = [];
  const minUses = ctx.min_uses > 0 ? ctx.min_uses : 2;
  const budgetMax = ctx.budget_max > 0 ? ctx.budget_max : 1000;

  // Deep clone so we never mutate the caller's tree.
  const cloned = JSON.parse(JSON.stringify(elements)) as ElementNode[];

  // ── Aggregate literal occurrences: STYLE-EXTRACT literals + a full tree scan ────────────────────
  // key = `kind|normValue` → { kind, rawValue, distinctNodes:Set }
  interface Agg {
    kind: LiteralRef['kind'];
    raw: string;
    norm: string;
    nodes: Set<string>;
  }
  const agg = new Map<string, Agg>();

  const bump = (kind: LiteralRef['kind'], raw: string, nodeKey: string): void => {
    const norm = normalizeLiteral(kind, raw);
    const key = chosenKey(kind, norm);
    let a = agg.get(key);
    if (a === undefined) {
      a = { kind, raw, norm, nodes: new Set() };
      agg.set(key, a);
    }
    a.nodes.add(nodeKey);
  };

  // The POST-ASSEMBLY tree is the AUTHORITATIVE occurrence source (its element ids are the real
  // distinct nodes that get rebound). Count distinct nodes from a full tree scan first.
  scanTreeLiterals(cloned, bump);

  // STYLE-EXTRACT's pre-assembly `LiteralRef[]` (keyed by source_path) is a SEED: it ensures a literal
  // is still CONSIDERED even if the tree scan can't reach it (e.g. it survived only in a setting shape
  // the scan does not model). It must NOT double-count a literal the tree scan already counted, so we
  // only fold its occurrences in for literals ABSENT from the scan (disjoint source_path keyspace).
  for (const lit of literals) {
    const key = chosenKey(lit.kind, normalizeLiteral(lit.kind, lit.value));
    if (agg.has(key)) {
      continue; // already counted by the (authoritative) tree scan
    }
    for (const occ of lit.occurrences) {
      bump(lit.kind, lit.value, `sp:${occ}`);
    }
  }

  // ── Existing-variable reuse index ───────────────────────────────────────────────────────────────
  const existingIdx = indexExistingVariables(ctx.existing_variables);

  // ── Decide which literals extract; build proposals + chosen-var table ────────────────────────────
  const proposed: ProposedVariable[] = [];
  const chosen = new Map<string, ChosenVar>();
  const usedLabels = new Set<string>(ctx.existing_variables.map((v) => v.label.toLowerCase()));
  let wouldAdd = 0;

  // Deterministic iteration order (by key) so output is stable.
  const keys = [...agg.keys()].sort();
  for (const key of keys) {
    const a = agg.get(key);
    if (a === undefined) {
      continue;
    }
    const varType = KIND_TO_VAR_TYPE[a.kind];
    const existing = existingIdx.get(`${varType}|${a.norm}`);
    // Fonts always extract even when single-use: Elementor Styles_Renderer writes font-family
    // values as unquoted literal CSS, which breaks for names containing ' - ' (delimiter token).
    // Extracting to a variable lets quoteFontFamilyStack ensure the value is correctly quoted.
    const shared = a.nodes.size >= minUses || a.kind === 'font';

    if (existing !== undefined) {
      // REUSE — bind to the existing id/label, no proposal, no budget impact.
      chosen.set(key, { id: existing.id, isNew: false });
      continue;
    }
    if (!shared) {
      continue; // single-use, no existing match → stays a literal
    }

    // Propose a NEW variable.
    const label = chooseVarLabel(a.kind, a.raw, a.norm, usedLabels);
    usedLabels.add(label.toLowerCase());
    const placeholderId = placeholderVarId(a.kind, a.norm);
    proposed.push({ type: varType, label, value: a.kind === 'font' ? quoteFontFamilyStack(a.raw.trim()) : a.raw.trim() });
    chosen.set(key, { id: placeholderId, isNew: true });
    wouldAdd++;
  }

  // ── Rebind the tree against the chosen-var table ────────────────────────────────────────────────
  const state: RebindState = { chosen, rebinds: {} };
  for (const node of cloned) {
    rewriteNode(node, state);
  }

  // ── Budget pre-flight (variables; SEPARATE from the class budget) ───────────────────────────────
  const budget = buildBudget(ctx.existing_variables.length, wouldAdd, budgetMax);
  if (budget.exceeded) {
    warnings.push(
      `BUDGET_EXCEEDED: projected variable count ${String(budget.projected)} exceeds the ` +
        `${String(budgetMax)} limit (current ${String(budget.current_count)} + ${String(
          budget.would_add,
        )} new). Consolidate by raising min_uses or reusing more existing kit variables; the ` +
        `orchestrator MUST NOT attempt the variables.batch while exceeded.`,
    );
  }

  return {
    elements: cloned,
    proposed_variables: proposed,
    var_rebinds: state.rebinds,
    budget,
    warnings,
  };
}

/* ─────────────────────────── tree literal scan (occurrence counting) ─────────────────────────── */

/** Scan the tree's typed values for extractable leaf literals, bumping the occurrence aggregator. */
function scanTreeLiterals(
  nodes: ElementNode[],
  bump: (kind: LiteralRef['kind'], raw: string, nodeKey: string) => void,
): void {
  const visit = (node: ElementNode): void => {
    const elementId = (node as { id?: string }).id;
    const nodeKey = typeof elementId === 'string' ? `id:${elementId}` : `id:?`;

    const stylesMap = (node as { styles?: Record<string, StyleDefinition> }).styles;
    if (stylesMap !== undefined && typeof stylesMap === 'object') {
      for (const def of Object.values(stylesMap)) {
        for (const variant of def.variants) {
          for (const [prop, tv] of Object.entries(variant.props)) {
            scanTypedValue(tv, prop, nodeKey, bump);
          }
        }
      }
    }

    const settings = (node as { settings?: Record<string, unknown> }).settings;
    if (settings !== undefined && typeof settings === 'object') {
      for (const [prop, value] of Object.entries(settings)) {
        if (isTypedValue(value)) {
          scanTypedValue(value, prop, nodeKey, bump);
        }
      }
    }

    const children = (node as { elements?: ElementNode[] }).elements;
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child);
      }
    }
  };
  for (const node of nodes) {
    visit(node);
  }
}

/** Recursively count extractable leaf literals inside a typed value. */
function scanTypedValue(
  tv: TypedValue,
  propName: string | null,
  nodeKey: string,
  bump: (kind: LiteralRef['kind'], raw: string, nodeKey: string) => void,
): void {
  const leaf = readLeafLiteral(tv, propName);
  if (leaf !== null) {
    bump(leaf.kind, leaf.raw, nodeKey);
    return;
  }
  if (Array.isArray(tv.value)) {
    for (const item of tv.value) {
      if (isTypedValue(item)) {
        scanTypedValue(item, null, nodeKey, bump);
      }
    }
    return;
  }
  if (typeof tv.value === 'object' && tv.value !== null) {
    for (const [k, v] of Object.entries(tv.value as Record<string, unknown>)) {
      if (isTypedValue(v)) {
        scanTypedValue(v, k, nodeKey, bump);
      }
    }
  }
}
