/**
 * WP-T07 — the diff-PUT body builder for global classes (10-rest-api.md §4.2, NORMATIVE).
 *
 * This is the flagship complexity of the design-system tool group, split into its OWN disjoint module
 * so the body construction is exhaustively unit-testable in isolation (ticket §Implementation Notes).
 * It takes the caller's intent (`added`/`modified`/`deleted`) plus the current collection state
 * (`currentItems` + the FULL `currentOrder`, both GET'd from `GET /design/classes` §4.1 FIRST) and
 * constructs the EXACT `{context, changes, items, order}` body Elementor's repository expects
 * (`modules/global-classes/global-classes-rest-api.php:150-224,306-390`).
 *
 * NORMATIVE invariants this builder GUARANTEES (so the PHP handler never returns 422 for a shape it
 * could have satisfied):
 *  - `items` contains ONLY touched ids (added ∪ modified) — NEVER the full collection (`...:357`).
 *  - `order` (top-level) is the FULL final id list and is CONSISTENT with `final_item_ids`
 *    (= existing − deleted + added), or PHP returns 422 `E_INVALID_ORDER` (`...:366-372`). We compute
 *    it deterministically (preserve current order, drop deletions, append new added ids) so it can
 *    never drift from `final_item_ids`.
 *  - Deletion is EXPLICIT via `changes.deleted` — omitting an id NEVER deletes it (`...:357`). A
 *    delete-by-omission is structurally impossible here: the builder always emits the full `order`.
 *  - `changes.order` is a boolean flag set true iff the final order differs from the current order.
 *
 * It ALSO runs the client-side 1000-item budget pre-flight (`existing − deleted + added ≤ 1000`,
 * `...:331-341`) as a FAST local check before any REST round-trip (PHP also pre-flights — server is
 * authoritative). This module is PURE (no I/O, no ctx) — `design.ts` calls it then proxies the result.
 */

import type { GlobalClass } from '@elementor-ultra/shared';

import type { StyleDefinition } from '../authoring/contract.js';

/** The Elementor global-classes budget ceiling (10-rest-api.md §4.2, `...:331-341`). */
export const MAX_CLASSES = 1000;

/** Inputs to {@link buildClassesDiff}: the caller's intent + the current collection state (§4.1). */
export interface BuildClassesDiffInput {
  /** Classes to ADD (new ids — must NOT already exist in `currentOrder`). */
  added?: StyleDefinition[];
  /** Classes to MODIFY (ids that MUST already exist in `currentOrder`). */
  modified?: StyleDefinition[];
  /** Ids to DELETE explicitly (each MUST already exist in `currentOrder`). */
  deleted?: string[];
  /** The current collection items (from `GET /design/classes` §4.1) — used only for id membership. */
  currentItems?: GlobalClass[];
  /** The FULL current order array (from `GET /design/classes` §4.1) — REQUIRED to build a valid diff. */
  currentOrder: string[];
}

/** The EXACT diff-PUT `changes` block (§4.2). */
export interface ClassesDiffChanges {
  added: string[];
  deleted: string[];
  modified: string[];
  /** Boolean flag: the final order differs from the current order (§4.2). */
  order: boolean;
}

/** The EXACT diff-PUT body (§4.2 — `items` touched-only, `order` full final list). Do not reshape. */
export interface ClassesDiffBody {
  context: 'frontend';
  changes: ClassesDiffChanges;
  /** Touched-only map: added ∪ modified, keyed by id (§4.2). */
  items: Record<string, GlobalClass>;
  /** The FULL final id list (existing − deleted + added), consistent with `final_item_ids` (§4.2). */
  order: string[];
}

/**
 * An invariant the caller violated when building the diff (e.g. modifying/deleting an id that does not
 * exist, adding an id that already exists, or exceeding the 1000-item budget). Carries a structural
 * `kind` so `design.ts` can map it to the right taxonomy code (`INVALID_ORDER` / `BUDGET_EXCEEDED`)
 * BEFORE any REST round-trip — fast feedback (ticket §Detailed Requirements 2).
 */
export class ClassesDiffError extends Error {
  readonly kind: 'invalid_order' | 'budget_exceeded';
  /** For `budget_exceeded`: the would-be final count (`existing − deleted + added`). */
  readonly currentCount?: number;
  /** For `budget_exceeded`: the ceiling ({@link MAX_CLASSES}). */
  readonly maxAllowed?: number;
  /** For `invalid_order`: the offending ids (unknown-on-modify/delete or duplicate-on-add). */
  readonly ids?: string[];

  constructor(
    kind: 'invalid_order' | 'budget_exceeded',
    message: string,
    extra?: { currentCount?: number; maxAllowed?: number; ids?: string[] },
  ) {
    super(message);
    this.name = 'ClassesDiffError';
    this.kind = kind;
    if (extra?.currentCount !== undefined) {
      this.currentCount = extra.currentCount;
    }
    if (extra?.maxAllowed !== undefined) {
      this.maxAllowed = extra.maxAllowed;
    }
    if (extra?.ids !== undefined) {
      this.ids = extra.ids;
    }
  }
}

/** Narrow an authoring {@link StyleDefinition} to the loose REST {@link GlobalClass} at the HTTP edge. */
function toRestClass(def: StyleDefinition): GlobalClass {
  // `StyleDefinition.variants` (strict StyleVariant[]) is structurally a narrowing of the loose REST
  // `GlobalClass.variants` (Record<string,unknown>[]); the named types differ, so this is the single
  // explicit cast at the seam. No data is transformed.
  return def as unknown as GlobalClass;
}

/**
 * Build the EXACT §4.2 diff-PUT body from the caller's intent + the current collection state. PURE:
 * validates the caller's intent against the current ids, computes the full consistent final `order`,
 * pre-flights the 1000-item budget, and emits the touched-only `items` map. Throws a
 * {@link ClassesDiffError} on a violation the caller can fix locally (never reaches REST).
 *
 * @throws {ClassesDiffError} `invalid_order` — a modified/deleted id is unknown, or an added id already
 *   exists, or the inputs contain duplicate ids; `budget_exceeded` — the final count > {@link MAX_CLASSES}.
 */
export function buildClassesDiff(input: BuildClassesDiffInput): ClassesDiffBody {
  const added = input.added ?? [];
  const modified = input.modified ?? [];
  const deleted = input.deleted ?? [];
  const currentOrder = input.currentOrder;

  const currentIds = new Set<string>(currentOrder);
  const deletedSet = new Set<string>(deleted);

  const addedIds = added.map((c) => c.id);
  const modifiedIds = modified.map((c) => c.id);

  // (1) Validate intent against current ids (fail fast with INVALID_ORDER before REST).
  const unknownModified = modifiedIds.filter((id) => !currentIds.has(id));
  if (unknownModified.length > 0) {
    throw new ClassesDiffError(
      'invalid_order',
      `Cannot modify global class(es) that do not exist: ${unknownModified.join(', ')}. GET /design/classes first to learn current ids.`,
      { ids: unknownModified },
    );
  }
  const unknownDeleted = deleted.filter((id) => !currentIds.has(id));
  if (unknownDeleted.length > 0) {
    throw new ClassesDiffError(
      'invalid_order',
      `Cannot delete global class(es) that do not exist: ${unknownDeleted.join(', ')}.`,
      { ids: unknownDeleted },
    );
  }
  const collidingAdded = addedIds.filter((id) => currentIds.has(id));
  if (collidingAdded.length > 0) {
    throw new ClassesDiffError(
      'invalid_order',
      `Cannot add global class(es) with ids that already exist: ${collidingAdded.join(', ')}. Use modified to change an existing class.`,
      { ids: collidingAdded },
    );
  }
  const dupAdded = duplicates(addedIds);
  if (dupAdded.length > 0) {
    throw new ClassesDiffError(
      'invalid_order',
      `Duplicate id(s) in added: ${dupAdded.join(', ')}.`,
      { ids: dupAdded },
    );
  }

  // (2) Budget pre-flight (existing − deleted + added ≤ MAX_CLASSES; PHP also pre-flights — §4.2).
  const finalCount = currentIds.size - deletedSet.size + addedIds.length;
  if (finalCount > MAX_CLASSES) {
    throw new ClassesDiffError(
      'budget_exceeded',
      `Applying this change would result in ${finalCount} global classes, exceeding the limit of ${MAX_CLASSES}.`,
      { currentCount: finalCount, maxAllowed: MAX_CLASSES },
    );
  }

  // (3) Compute the FULL final order: preserve current order, drop deletions, append new added ids.
  // This is deterministic so `order` can NEVER drift from `final_item_ids` (avoids E_INVALID_ORDER).
  const finalOrder: string[] = currentOrder.filter((id) => !deletedSet.has(id)).concat(addedIds);

  // (4) Touched-only items map (added ∪ modified) — NEVER the full collection (§4.2 `...:357`).
  const items: Record<string, GlobalClass> = {};
  for (const def of added) {
    items[def.id] = toRestClass(def);
  }
  for (const def of modified) {
    items[def.id] = toRestClass(def);
  }

  // (5) `changes.order` is true iff the final order differs from the current order.
  const orderChanged = !sameOrder(currentOrder, finalOrder);

  return {
    context: 'frontend',
    changes: {
      added: addedIds,
      deleted,
      modified: modifiedIds,
      order: orderChanged,
    },
    items,
    order: finalOrder,
  };
}

/** Return the duplicate values in `ids` (each reported once). */
function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      dups.add(id);
    }
    seen.add(id);
  }
  return [...dups];
}

/** Whether two id arrays are identical in length AND element order. */
function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
