/**
 * WP-H09 — HOIST stage (impl of `hoistClasses`/`fingerprintVariants`, frozen seam `convert/types.ts`,
 * WP-H01).
 *
 * The SEVENTH HTML→native conversion stage (RESEARCH.md §6.3 "Global-class hoisting", SUPPLEMENT §C.2
 * "Repeated-pattern hoisting", authoring-contract §5/§6.3/§9): fingerprint every node's local style
 * declaration-set and promote sets shared by >= `min_uses` (default 2) DISTINCT nodes into ONE proposed
 * GLOBAL CLASS; single-use sets stay LOCAL. For each hoisted node, the shared local-style id in
 * `settings.classes.value` is replaced with the proposed global-class id (a deterministic PLACEHOLDER —
 * WP-H11 resolves it to the real `g-*` id after the diff-PUT mints it) and the now-redundant local
 * `StyleDefinition` is removed from the node's `styles` map.
 *
 * It MUTATES nothing on the site — it only PROPOSES. Persistence (the diff-PUT `classes.upsert`, 10-rest-
 * api §Design) is the orchestrator's job (WP-H11) against WP-P08; HOIST builds the proposals in the exact
 * shape that body needs (full `GlobalClassObject`s + `class_rebinds` + a consistent projected `order` via
 * {@link projectedOrder}) and pre-flights the 1000-item class budget (error-taxonomy §3.3
 * `BUDGET_EXCEEDED`) WITHOUT throwing.
 *
 * Before proposing a NEW class it fingerprint-matches the EXISTING kit classes (`ctx.existing_classes`,
 * `design.classes.list`) and REUSES an identical set's id — shrinking the diff-PUT + budget impact
 * (RESEARCH.md §6.3 "Detect & reuse existing kit tokens first").
 *
 * Labels obey authoring-contract R7 (2-50 chars, no spaces, no leading digit/`--`/`-digit`, not reserved
 * `container`, charset `/^[a-z][a-z-_0-9]*$/i`), derived from `ctx.name_hints` when valid else `g-<hex>`,
 * and are pre-deduped within the proposal set to minimize the `DUPLICATED_LABEL` soft error the
 * orchestrator reconciles after the PUT.
 *
 * PURE + deterministic given `(elements, ctx)`. No WP-client import (the existing class/order set is
 * injected via `ctx`). Does NOT prime CSS (the hoisted classes render only after the WP-P05 cache flush +
 * prime the orchestrator runs). PHP `dry_run` (WP-P03) remains authoritative on the rebound tree.
 *
 * `HoistContext`/`HoistResult`/`BudgetReport`/`GlobalClassObject` are FROZEN in WP-H01 (`types.ts`);
 * `ElementNode`/`StyleDefinition`/`StyleVariant`/`Classes`/`TypedValue` are FROZEN in WP-F03. None are
 * redeclared here.
 */

import { isClassesValue } from '../authoring/envelopes.js';
import type { Classes, ElementNode, StyleDefinition, StyleVariant } from '../authoring/contract.js';
import type { BudgetReport, GlobalClassObject, HoistContext, HoistResult } from './types.js';

/* ─────────────────────────── placeholder global-class id scheme (WP-H11 resolves) ───────────── */

/**
 * The deterministic PLACEHOLDER global-class id HOIST emits (Implementation Notes "placeholder var-id /
 * class-id scheme"): `__class:<fingerprint>`. The placeholder is an internal handshake token — it is
 * NOT regex-valid (`/^[a-z][a-z-_0-9]*$/i`) and MUST NEVER reach a persist surface. It appears both in
 * the rebound tree's `classes.value[]` AND as the proposed `GlobalClassObject.id`; the orchestrator
 * (WP-H11 `htmlToTree`) resolves BOTH to the same deterministic real `g-*` id in one pass before the
 * tree/proposals are ever returned or persisted.
 */
export function placeholderClassId(fingerprint: string): string {
  return `__class:${fingerprint}`;
}

/** True iff a class name is a HOIST placeholder (`__class:*`) the orchestrator must still resolve. */
export function isPlaceholderClassId(name: string): boolean {
  return name.startsWith('__class:');
}

/* ─────────────────────────── label rules (authoring-contract R7) ─────────────────────────────── */

/** The reserved class label that R7 forbids. */
const RESERVED_LABEL = 'container';

/** R7 charset for a class name/label. */
const LABEL_CHARSET = /^[a-z][a-z\-_0-9]*$/i;

/**
 * True iff `label` is a VALID global-class label per authoring-contract R7: 2-50 chars, no spaces, no
 * leading digit, no leading `--` or `-<digit>`, charset `/^[a-z][a-z-_0-9]*$/i`, not reserved
 * `container`. (PHP / the diff-PUT is authoritative; this is the pre-check that minimizes
 * `DUPLICATED_LABEL`/rename reconciliation.)
 */
export function isValidClassLabel(label: string): boolean {
  if (label.length < 2 || label.length > 50) {
    return false;
  }
  if (/\s/.test(label)) {
    return false;
  }
  if (label.startsWith('--')) {
    return false;
  }
  if (/^-\d/.test(label)) {
    return false;
  }
  if (/^\d/.test(label)) {
    return false;
  }
  if (label.toLowerCase() === RESERVED_LABEL) {
    return false;
  }
  return LABEL_CHARSET.test(label);
}

/**
 * Best-effort SANITIZE a candidate label toward R7 (strip leading junk, replace illegal chars with `-`,
 * clamp length). Returns `null` if nothing valid remains (caller falls back to `g-<hex>`).
 */
function sanitizeLabel(candidate: string): string | null {
  let s = candidate.trim().replace(/\s+/g, '-');
  // Replace any char outside the charset with `-`.
  s = s.replace(/[^a-zA-Z0-9\-_]/g, '-');
  // Strip leading non-letter run (R7 requires a leading letter).
  s = s.replace(/^[^a-zA-Z]+/, '');
  // Collapse repeated dashes (cosmetic; not required, keeps labels readable).
  s = s.replace(/-{2,}/g, '-');
  if (s.length > 50) {
    s = s.slice(0, 50);
  }
  // Trim a trailing dash/underscore introduced by the clamp.
  s = s.replace(/[-_]+$/, '');
  if (isValidClassLabel(s)) {
    return s;
  }
  return null;
}

/** A short stable hex token (8 hex chars) derived from a fingerprint, for the `g-<hex>` fallback label. */
function shortHex(seed: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 8);
}

/* ─────────────────────────── fingerprinting (order-insensitive) ─────────────────────────────── */

/**
 * Stable, order-insensitive JSON for a TypedValue tree: object keys sorted recursively so two
 * structurally-identical envelopes with differently-ordered keys hash equal (Detailed Requirement 1 +
 * Implementation Notes "sort keys"). Arrays preserve order (a `dimensions`/`background-overlay` array
 * is positional).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Canonical, order-insensitive serialization of a single variant (meta + sorted props). */
function fingerprintVariant(variant: StyleVariant): string {
  // Canonicalize the BASE breakpoint: the IR uses `null` for base/desktop, but every PERSISTED kit
  // class stores the literal `'desktop'` (the PHP Style_Parser rejects a null base breakpoint, so the
  // orchestrator's wire normalization rewrites `null → 'desktop'` before the diff-PUT). Fingerprinting
  // both forms to ONE token keeps existing-kit reuse (RESEARCH.md §6.3 reuse-first) alive against live
  // classes — without it candidates key `null|…` while kit classes key `desktop|…` and NEVER match.
  const breakpoint = variant.meta.breakpoint ?? 'desktop';
  const meta = `${String(breakpoint)}|${String(variant.meta.state)}`;
  const propEntries = Object.entries(variant.props)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([prop, tv]) => `${prop}=${stableStringify(tv)}`);
  const customCss =
    variant.custom_css === undefined || variant.custom_css === null
      ? ''
      : `custom_css=${stableStringify(variant.custom_css)}`;
  return `${meta}::${propEntries.join(';')}${customCss === '' ? '' : `::${customCss}`}`;
}

/**
 * A stable content hash of a style's variants (breakpoint + state + props, ORDER-INSENSITIVE over both
 * variants and props) used to detect shared declaration-sets. Two styles with the same declarations in
 * different source order hoist together. The style `label`/`id` are NOT part of the fingerprint (only
 * the DECLARATIONS matter for sharing).
 */
export function fingerprintVariants(styleDef: StyleDefinition): string {
  const variantPrints = styleDef.variants.map(fingerprintVariant).sort();
  return variantPrints.join('||');
}

/* ─────────────────────────── settings.classes access helpers ─────────────────────────────────── */

/** Read a node's `settings.classes` envelope (atomic nodes only carry it; classic nodes do not). */
function getClassesEnvelope(node: ElementNode): Classes | undefined {
  const settings = (node as { settings?: Record<string, unknown> }).settings;
  if (settings === undefined) {
    return undefined;
  }
  const env = settings['classes'];
  if (isClassesValue(env)) {
    return env;
  }
  return undefined;
}

/** Read a node's local `styles` map (atomic nodes only; undefined elsewhere). */
function getStylesMap(node: ElementNode): Record<string, StyleDefinition> | undefined {
  const styles = (node as { styles?: Record<string, StyleDefinition> }).styles;
  if (styles !== undefined && typeof styles === 'object') {
    return styles;
  }
  return undefined;
}

/* ─────────────────────────── tree walk (in document order) ──────────────────────────────────── */

/** Flatten an `ElementNode[]` forest into a document-order list (parents before children). */
function walkAll(nodes: ElementNode[], out: ElementNode[]): void {
  for (const node of nodes) {
    out.push(node);
    const children = (node as { elements?: ElementNode[] }).elements;
    if (Array.isArray(children) && children.length > 0) {
      walkAll(children, out);
    }
  }
}

/* ─────────────────────────── projected order (diff-PUT consistency) ─────────────────────────── */

/**
 * The FULL, consistent final `order` list for the diff-PUT (10-rest-api §Design / RESEARCH.md §2.2):
 * the existing order with the newly-added ids APPENDED (dedup-safe). HOIST never proposes deletions, so
 * the projected order is simply existing + new (existing ids preserved in place). The orchestrator
 * passes this as the diff-PUT top-level `order` (else `INVALID_ORDER`, error-taxonomy §3.3).
 */
export function projectedOrder(existingOrder: string[], addedIds: string[]): string[] {
  const seen = new Set(existingOrder);
  const out = [...existingOrder];
  for (const id of addedIds) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/* ─────────────────────────── budget pre-flight (error-taxonomy §3.3) ─────────────────────────── */

/** Build a `BudgetReport`: `projected = current - would_delete + would_add`; `exceeded` past `max`. */
function buildBudget(current: number, wouldAdd: number, max: number): BudgetReport {
  const projected = current + wouldAdd; // HOIST never deletes (would_delete = 0).
  return {
    current_count: current,
    would_add: wouldAdd,
    would_delete: 0,
    projected,
    max_allowed: max,
    exceeded: projected > max,
  };
}

/* ─────────────────────────── existing-class reuse index ──────────────────────────────────────── */

/** Build a `fingerprint → existing-class-id` index for reuse (RESEARCH.md §6.3 reuse-first). */
function indexExistingClasses(existing: GlobalClassObject[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const cls of existing) {
    const fp = fingerprintVariants(cls);
    // First-wins (existing order is authoritative; a later duplicate is ignored for reuse).
    if (!idx.has(fp)) {
      idx.set(fp, cls.id);
    }
  }
  return idx;
}

/* ─────────────────────────── per-fingerprint hoist candidate ─────────────────────────────────── */

/** One shared declaration-set candidate: its fingerprint, the representative style, and its nodes. */
interface Candidate {
  fingerprint: string;
  /** The first-seen `StyleDefinition` carrying this fingerprint (its variants seed the proposal). */
  representative: StyleDefinition;
  /** The (node, local-style-id) pairs that carry this fingerprint, in document order. */
  occurrences: Array<{ node: ElementNode; localStyleId: string }>;
}

/* ─────────────────────────── the stage entry point ──────────────────────────────────────────── */

/**
 * HOIST: fingerprint every node's local styles, promote sets shared by >= `ctx.min_uses` distinct nodes
 * to ONE proposed global class (reusing an identical EXISTING kit class when present), rebind those nodes
 * to the class id (placeholder) + drop their duplicated local styles, and pre-flight the 1000-item class
 * budget. Single-use sets stay local. Returns the rebound tree + proposals + rebinds + budget + warnings.
 *
 * The tree is DEEP-CLONED before mutation so the input forest is never modified in place (idempotent +
 * pure-ish, Detailed Requirement 8).
 */
export function hoistClasses(elements: ElementNode[], ctx: HoistContext): HoistResult {
  const warnings: string[] = [];
  const minUses = ctx.min_uses > 0 ? ctx.min_uses : 2;
  const budgetMax = ctx.budget_max > 0 ? ctx.budget_max : 1000;

  // Deep clone so we never mutate the caller's tree (the IR is JSON-safe).
  const cloned = JSON.parse(JSON.stringify(elements)) as ElementNode[];

  const all: ElementNode[] = [];
  walkAll(cloned, all);

  // ── Gather candidates by fingerprint across all nodes' local styles ────────────────────────────
  const candidates = new Map<string, Candidate>();
  for (const node of all) {
    const stylesMap = getStylesMap(node);
    if (stylesMap === undefined) {
      continue;
    }
    for (const [styleId, def] of Object.entries(stylesMap)) {
      if (def.variants.length === 0) {
        continue; // nothing to share
      }
      const fp = fingerprintVariants(def);
      const existing = candidates.get(fp);
      if (existing === undefined) {
        candidates.set(fp, {
          fingerprint: fp,
          representative: def,
          occurrences: [{ node, localStyleId: styleId }],
        });
      } else {
        existing.occurrences.push({ node, localStyleId: styleId });
      }
    }
  }

  // ── Reuse index for existing kit classes ──────────────────────────────────────────────────────
  const existingByFp = indexExistingClasses(ctx.existing_classes);

  // ── Decide which candidates hoist (>= minUses DISTINCT nodes, OR existing-class match) ──────────
  const proposedClasses: GlobalClassObject[] = [];
  const classRebinds: Record<string, string[]> = {};
  const usedLabels = new Set<string>(ctx.existing_classes.map((c) => c.label.toLowerCase()));
  const addedIds: string[] = [];

  for (const candidate of candidates.values()) {
    const distinctNodes = new Set(candidate.occurrences.map((o) => o.node));
    const reuseId = existingByFp.get(candidate.fingerprint);
    const shared = distinctNodes.size >= minUses;

    // Hoist when shared on >= minUses nodes OR when an existing kit class already holds this set
    // (reuse collapses even a single-use node onto a kit token, RESEARCH.md §6.3 reuse-first).
    if (!shared && reuseId === undefined) {
      continue; // single-use, no existing match → stays a local style
    }

    let classId: string;
    if (reuseId !== undefined) {
      // REUSE an existing kit class — no new proposal, no budget impact.
      classId = reuseId;
    } else {
      // Propose a NEW global class. Label from a valid name hint, else g-<hex>.
      const label = chooseLabel(candidate, ctx.name_hints, usedLabels);
      usedLabels.add(label.toLowerCase());
      classId = placeholderClassId(candidate.fingerprint);
      const proposed: GlobalClassObject = {
        id: classId,
        type: 'class',
        label,
        variants: candidate.representative.variants.map((v) => ({ ...v })),
      };
      proposedClasses.push(proposed);
      addedIds.push(classId);
    }

    // Rebind every occurrence: swap the local-style id for the class id in classes.value + drop the
    // local style from the styles map.
    const rebound = new Set<string>();
    for (const occ of candidate.occurrences) {
      rebindNodeToClass(occ.node, occ.localStyleId, classId);
      const nodeId = (occ.node as { id?: string }).id;
      if (typeof nodeId === 'string') {
        rebound.add(nodeId);
      }
    }
    classRebinds[classId] = [...rebound];
  }

  // ── Budget pre-flight (classes; variables are VARIABLE-EXTRACT's separate budget) ──────────────
  const budget = buildBudget(ctx.existing_classes.length, addedIds.length, budgetMax);
  if (budget.exceeded) {
    warnings.push(
      `BUDGET_EXCEEDED: projected global-class count ${String(budget.projected)} exceeds the ` +
        `${String(budgetMax)} limit (current ${String(budget.current_count)} + ${String(
          budget.would_add,
        )} new). Consolidate by raising min_uses (more aggressive fingerprint merging) or reusing ` +
        `more existing kit classes; the orchestrator MUST NOT attempt the diff-PUT while exceeded.`,
    );
  }

  return {
    elements: cloned,
    proposed_classes: proposedClasses,
    class_rebinds: classRebinds,
    budget,
    warnings,
  };
}

/* ─────────────────────────── label selection (R7 + dedupe) ───────────────────────────────────── */

/**
 * Choose a meaningful, R7-valid, set-unique label for a proposed class: prefer a `name_hints` entry for
 * any occurrence's source_path (the CLASSIFY `suggestName` / source class name); sanitize it toward R7;
 * fall back to `g-<hex>`. Dedupe against `usedLabels` (existing + already-proposed) with a numeric suffix.
 */
function chooseLabel(
  candidate: Candidate,
  nameHints: Record<string, string>,
  usedLabels: Set<string>,
): string {
  // Try each occurrence's source_path hint (document order — first valid wins).
  let base: string | null = null;
  for (const occ of candidate.occurrences) {
    const sourcePath = (occ.node as { source_path?: string }).source_path;
    const hint = typeof sourcePath === 'string' ? nameHints[sourcePath] : undefined;
    if (typeof hint === 'string' && hint.length > 0) {
      const sanitized = isValidClassLabel(hint) ? hint : sanitizeLabel(hint);
      if (sanitized !== null) {
        base = sanitized;
        break;
      }
    }
  }
  if (base === null) {
    base = `g-${shortHex(candidate.fingerprint)}`;
  }
  return dedupeLabel(base, usedLabels);
}

/** Append a `-2`/`-3`/... suffix until the (lower-cased) label is unused, staying within 50 chars. */
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
  // Practically unreachable; deterministic last resort.
  return `g-${shortHex(`${base}:${String(usedLabels.size)}`)}`;
}

/* ─────────────────────────── node rebind (drop local style, add class id) ────────────────────── */

/**
 * Rebind ONE node from a local-style id to a global-class id: remove the local `StyleDefinition` from
 * `styles`, and in `settings.classes.value` replace the local id with the class id (dedup-safe). The
 * class id may be a placeholder (`__class:*`) WP-H11 later resolves. Preserves any OTHER class ids
 * (other local styles / already-hoisted globals) on the node.
 */
function rebindNodeToClass(node: ElementNode, localStyleId: string, classId: string): void {
  const stylesMap = getStylesMap(node);
  if (stylesMap !== undefined && localStyleId in stylesMap) {
    delete stylesMap[localStyleId];
    // If the styles map is now empty, leave it as `{}` — the authoring normalizer drops empty maps.
  }
  const env = getClassesEnvelope(node);
  if (env === undefined) {
    return;
  }
  const next: string[] = [];
  const seen = new Set<string>();
  for (const name of env.value) {
    const replaced = name === localStyleId ? classId : name;
    if (!seen.has(replaced)) {
      next.push(replaced);
      seen.add(replaced);
    }
  }
  // If the local id was not present (defensive), still ensure the class id is referenced.
  if (!seen.has(classId)) {
    next.push(classId);
  }
  (env as { value: string[] }).value = next;
}
