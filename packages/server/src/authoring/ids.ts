/**
 * WP-F03 — Client-side element-ID minting, dedupe, and local-style id mirroring.
 *
 * Elementor IDs are `dechex(rand())`-style — ~7 hex chars, NOT UUIDs — and Elementor does NO
 * server-side uniqueness check (`includes/utils.php:373-375`, RESEARCH.md §4.6/§8.1). Duplicates
 * collide on `.elementor-element-<id>` selectors and break CSS, so the MCP MUST mint unique ids and
 * dedupe against the live in-document id set (`11-authoring-contract.md §8` R3).
 *
 * Source semantics: `mintId()` mirrors `substr(strtolower(dechex(wp_rand(0,PHP_INT_MAX))),0,7)`
 * (`includes/utils.php:373-375`, RESEARCH.md §8.1 rule 3). Local-style ids follow the convention
 * `e-<elementId>-<7hex>` and MUST be mirrored into the owning element's `settings.classes.value`
 * (`11-authoring-contract.md §5.1`, the LOCAL_STYLE_UNLINKED invariant).
 *
 * AUTHORITY: PHP `ids/validate` / `ids/remap` are authoritative on the live used-id set
 * (`11-authoring-contract.md §8.1`); this module is the client-side mint + cheap dedupe.
 */

import type { ElementNode, AtomicNode, Classes } from './contract.js';
import { isAtomicNode } from './contract.js';

/** Length of a freshly minted element id (7 hex chars, per `includes/utils.php:373-375`). */
export const ELEMENT_ID_LENGTH = 7;

/** Hex chars used by the mint (lowercase, matching PHP `dechex` output). */
const HEX = '0123456789abcdef';

/**
 * A pluggable random source so tests can mint deterministically. Returns a float in [0,1) like
 * `Math.random` (the production default).
 */
export type RandomSource = () => number;

/** Generate one lowercase hex char from a [0,1) sample. */
function hexChar(rand: RandomSource): string {
  return HEX[Math.floor(rand() * HEX.length)] ?? '0';
}

/**
 * Mint one 7-hex element id (`substr(strtolower(dechex(wp_rand(...))),0,7)` semantics,
 * `includes/utils.php:373-375`). NOT a UUID. Pass a `RandomSource` for deterministic tests.
 */
export function mintId(rand: RandomSource = Math.random): string {
  let out = '';
  for (let i = 0; i < ELEMENT_ID_LENGTH; i += 1) {
    out += hexChar(rand);
  }
  return out;
}

/**
 * Mint a 7-hex id guaranteed NOT to be in `used` (collision-repaired). Adds the minted id to `used`
 * so a sequence of calls stays unique. Throws after `maxAttempts` (16-bit-ish exhaustion guard,
 * `DUPLICATE_ELEMENT_ID` territory) so an infinite loop can never occur.
 */
export function mintUniqueId(
  used: Set<string>,
  rand: RandomSource = Math.random,
  maxAttempts = 1000,
): string {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const id = mintId(rand);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error(
    `mintUniqueId: could not mint a unique 7-hex id after ${String(maxAttempts)} attempts`,
  );
}

/** Mint a local-style id for an element: `e-<elementId>-<7hex>` (`11-authoring-contract.md §5.1`). */
export function mintLocalStyleId(elementId: string, rand: RandomSource = Math.random): string {
  return `e-${elementId}-${mintId(rand)}`;
}

/* ───────────────────────────── tree id collection / dedupe ──────────────────────────────── */

/** Walk a tree and collect every node id (DFS, includes nested `elements`). */
export function collectIds(tree: ElementNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      if (typeof node.id === 'string' && node.id.length > 0) {
        ids.add(node.id);
      }
      if (Array.isArray(node.elements) && node.elements.length > 0) {
        walk(node.elements);
      }
    }
  };
  walk(tree);
  return ids;
}

/** The result of a {@link dedupe} pass. */
export interface DedupeResult {
  /** The de-duplicated tree (mutated in place AND returned for convenience). */
  tree: ElementNode[];
  /** `{ oldId: newId }` remaps applied (only the SECOND+ occurrence of a collision is remapped). */
  remapped: Record<string, string>;
}

/**
 * Dedupe element ids across `tree` against a live/seen set. The FIRST occurrence of an id keeps it;
 * any later occurrence (in-tree duplicate or a collision with `liveIds`) is re-minted to a unique id.
 * When a remapped node carries local styles, their `e-<oldId>-...` ids and the matching
 * `settings.classes.value` entries are rewritten so the mirroring invariant (§5.1) is preserved.
 *
 * Returns the applied `{old:new}` map. Authoritative collision resolution is PHP `ids/remap`; this is
 * the cheap client pre-pass (`11-authoring-contract.md §8.1`).
 */
export function dedupe(tree: ElementNode[], liveIds: Set<string> = new Set()): DedupeResult {
  const seen = new Set<string>(liveIds);
  const remapped: Record<string, string> = {};

  const walk = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      const original = node.id;
      if (typeof original === 'string' && seen.has(original)) {
        const fresh = mintUniqueId(seen);
        node.id = fresh;
        remapped[original] = fresh;
        if (isAtomicNode(node)) {
          rewriteLocalStyleOwnerId(node, original, fresh);
        }
      } else if (typeof original === 'string') {
        seen.add(original);
      }
      if (Array.isArray(node.elements) && node.elements.length > 0) {
        walk(node.elements);
      }
    }
  };
  walk(tree);
  return { tree, remapped };
}

/**
 * Rewrite an atomic node's local-style ids (`e-<oldId>-*` → `e-<newId>-*`) in BOTH its `styles` map
 * keys/`id` fields and its `settings.classes.value`, keeping the §5.1 mirror intact after a node id
 * remap.
 */
function rewriteLocalStyleOwnerId(node: AtomicNode, oldId: string, newId: string): void {
  const styles = node.styles;
  if (styles === undefined) {
    return;
  }
  const oldPrefix = `e-${oldId}-`;
  const newPrefix = `e-${newId}-`;
  const renames: Record<string, string> = {};
  const nextStyles: Record<string, (typeof styles)[string]> = {};
  for (const [styleId, def] of Object.entries(styles)) {
    if (styleId.startsWith(oldPrefix)) {
      const renamed = newPrefix + styleId.slice(oldPrefix.length);
      renames[styleId] = renamed;
      nextStyles[renamed] = { ...def, id: renamed };
    } else {
      nextStyles[styleId] = def;
    }
  }
  node.styles = nextStyles;

  const classesEnvelope = node.settings['classes'] as Classes | undefined;
  if (classesEnvelope !== undefined && Array.isArray(classesEnvelope.value)) {
    classesEnvelope.value = classesEnvelope.value.map((name) => renames[name] ?? name);
  }
}

/* ───────────────────────────── local-style mirroring (§5.1) ─────────────────────────────── */

/**
 * Ensure a local-style id is present in the owning element's `settings.classes.value` (the §5.1
 * LOCAL_STYLE_UNLINKED invariant: a styles-map id absent from `classes` silently detaches). Mutates
 * the node's `classes` envelope (creating it if absent) and returns it. Idempotent.
 */
export function mirrorLocalStyleIntoClasses(node: AtomicNode, styleId: string): Classes {
  let classesEnvelope = node.settings['classes'] as Classes | undefined;
  if (classesEnvelope === undefined || classesEnvelope.$$type !== 'classes') {
    classesEnvelope = { $$type: 'classes', value: [] };
    node.settings['classes'] = classesEnvelope;
  }
  if (!Array.isArray(classesEnvelope.value)) {
    classesEnvelope.value = [];
  }
  if (!classesEnvelope.value.includes(styleId)) {
    classesEnvelope.value.push(styleId);
  }
  return classesEnvelope;
}

/**
 * Add a fully-formed local {@link import('./contract.js').StyleDefinition} to an atomic node: insert
 * it into the node's `styles` map AND mirror its id into `settings.classes.value` (§5.1). Returns the
 * style id. Mints the id if `styleDef.id` is empty.
 */
export function addLocalStyle(
  node: AtomicNode,
  styleDef: import('./contract.js').StyleDefinition,
  rand: RandomSource = Math.random,
): string {
  const id = styleDef.id.length > 0 ? styleDef.id : mintLocalStyleId(node.id, rand);
  const def = { ...styleDef, id };
  const styles = node.styles ?? {};
  styles[id] = def;
  node.styles = styles;
  mirrorLocalStyleIntoClasses(node, id);
  return id;
}
