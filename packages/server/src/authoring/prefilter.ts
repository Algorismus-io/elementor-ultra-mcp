/**
 * WP-F03 — The CHEAP structural pre-filter (safe subset; NEVER authoritative).
 *
 * The pre-filter rejects ONLY what PHP `dry_run` would also reject for STRUCTURAL reasons, and
 * DEFERS everything whose validity depends on the live atomic/style schema, conditional
 * `Dependency_Manager` props, Union members, or free-string props (`14-fixtures-harness.md §4`,
 * `15-engineering-standards.md §2.5`, `11-authoring-contract.md §8`). A hard accept is returned ONLY
 * when nothing defer-worthy was seen and no structural error fired; otherwise the verdict is `defer`
 * so the write pipeline always round-trips through PHP `dry_run` (the single source of truth).
 *
 * Checks performed (the structural subset of `11-authoring-contract.md §8`):
 *   - R1  every node has a non-empty string `id` and an `elType`.
 *   - R3  element ids are UNIQUE across the whole tree (`DUPLICATE_ELEMENT_ID`).
 *   - R4  every local-style id is mirrored into the owning element's `classes` (`LOCAL_STYLE_UNLINKED`).
 *   - R7  `classes` names match `/^[A-Za-z][A-Za-z0-9_-]*$/` and the `classes` envelope is a BARE
 *         string array (malformed → `VALIDATION_FAILED`).
 *   - R9  `image-src` honors id-XOR-url (`IMAGE_SRC_XOR_VIOLATION`).
 *   - envelope well-formedness: a BARE SCALAR on an atomic `settings` key is the spike-verified
 *     [R8] failure class (PHP throws `invalid_value`) and is a structural reject
 *     (`VALIDATION_FAILED`); `null` and non-envelope objects/arrays are DEFERRED — PHP accepts
 *     `null` for every non-required prop and silently drops unknown keys (`Props_Parser` iterates
 *     only schema keys), so TS cannot prove them invalid.
 *
 * Defers (never hard-rejects) on: any prop the structural pass cannot prove, conditional/Union/
 * free-string props, `null` / non-envelope object values, html-v3 over-tagging (a SOFT report,
 * not a reject).
 */

import type { ElementNode, AtomicNode, ValidationError, Classes } from './contract.js';
import { isAtomicNode, isAtomicContainerNode, isAtomicWidgetNode } from './contract.js';
import {
  CLASS_NAME_PATTERN,
  isTypedValue,
  isValidImageSrc,
  strippedHtmlV3Tags,
} from './envelopes.js';

/** The three-way pre-filter verdict (`14-fixtures-harness.md §4`). */
export type PrefilterVerdict = 'accept' | 'reject' | 'defer';

/** The pre-filter result: a verdict plus structured (taxonomy-coded) errors. */
export interface PrefilterResult {
  verdict: PrefilterVerdict;
  errors: ValidationError[];
}

/** Internal accumulator threaded through the recursive walk. */
interface Accumulator {
  errors: ValidationError[];
  /** True when some prop/shape could not be proven and must be deferred to PHP `dry_run`. */
  deferred: boolean;
  seenIds: Set<string>;
}

/** Build a structural reject error (taxonomy code from `12-error-taxonomy.md`). */
function err(
  code: string,
  message: string,
  extra: {
    element_id?: string | undefined;
    style_id?: string | undefined;
    prop?: string | undefined;
  } = {},
): ValidationError {
  const out: ValidationError = { code, message, retryable: false };
  if (extra.element_id !== undefined) {
    out.element_id = extra.element_id;
  }
  if (extra.style_id !== undefined) {
    out.style_id = extra.style_id;
  }
  if (extra.prop !== undefined) {
    out.prop = extra.prop;
  }
  return out;
}

/* ───────────────────────────── per-node structural checks ───────────────────────────────── */

/** R1: every node has a non-empty string id + an elType. */
function checkR1(node: ElementNode, acc: Accumulator): boolean {
  let ok = true;
  if (typeof node.id !== 'string' || node.id.length === 0) {
    acc.errors.push(err('VALIDATION_FAILED', 'Node is missing a non-empty string "id" (R1).'));
    ok = false;
  }
  if (typeof node.elType !== 'string' || node.elType.length === 0) {
    acc.errors.push(
      err('VALIDATION_FAILED', 'Node is missing "elType" (R1).', {
        element_id: typeof node.id === 'string' ? node.id : undefined,
      }),
    );
    ok = false;
  }
  return ok;
}

/** R3: collect + flag duplicate ids across the tree. */
function checkR3(node: ElementNode, acc: Accumulator): void {
  if (typeof node.id !== 'string' || node.id.length === 0) {
    return; // R1 already flagged
  }
  if (acc.seenIds.has(node.id)) {
    acc.errors.push(
      err('DUPLICATE_ELEMENT_ID', `Duplicate element id "${node.id}" (R3).`, {
        element_id: node.id,
      }),
    );
  } else {
    acc.seenIds.add(node.id);
  }
}

/** R7 + bare-array shape: validate the `classes` envelope on an atomic node. */
function checkClasses(node: AtomicNode, acc: Accumulator): Set<string> {
  const present = new Set<string>();
  const classesEnvelope = node.settings['classes'] as Classes | undefined;
  if (classesEnvelope === undefined) {
    return present; // classes default-absent is fine structurally; PHP injects []
  }
  if (!isTypedValue(classesEnvelope) || classesEnvelope.$$type !== 'classes') {
    acc.errors.push(
      err('VALIDATION_FAILED', 'classes prop is not a {$$type:"classes",value:[...]} envelope.', {
        element_id: node.id,
        prop: 'classes',
      }),
    );
    return present;
  }
  const value: unknown = classesEnvelope.value;
  if (!Array.isArray(value)) {
    acc.errors.push(
      err('VALIDATION_FAILED', 'classes value must be a BARE string array (R7, §3).', {
        element_id: node.id,
        prop: 'classes',
      }),
    );
    return present;
  }
  for (const name of value) {
    if (typeof name !== 'string') {
      acc.errors.push(
        err('VALIDATION_FAILED', 'classes value must contain only strings (BARE array, §3).', {
          element_id: node.id,
          prop: 'classes',
        }),
      );
      continue;
    }
    if (!CLASS_NAME_PATTERN.test(name)) {
      acc.errors.push(
        err('VALIDATION_FAILED', `Invalid class name "${name}" (R7).`, {
          element_id: node.id,
          prop: 'classes',
        }),
      );
      continue;
    }
    present.add(name);
  }
  return present;
}

/** R4: every local-style id (the `styles` map keys) must be mirrored into `classes`. */
function checkR4(node: AtomicNode, classesPresent: Set<string>, acc: Accumulator): void {
  const styles = node.styles;
  if (styles === undefined) {
    return;
  }
  for (const styleId of Object.keys(styles)) {
    if (!classesPresent.has(styleId)) {
      acc.errors.push(
        err(
          'LOCAL_STYLE_UNLINKED',
          `Local style "${styleId}" is not mirrored into the element's classes (R4, §5.1).`,
          { element_id: node.id, style_id: styleId },
        ),
      );
    }
  }
}

/**
 * R9 + envelope well-formedness across a node's `settings`. Structural rejects fire for bare-scalar
 * props ([R8]) and image-src XOR violations; everything else is DEFERRED (the value may be a Union
 * member, a conditional prop, or a free-string the pre-filter cannot prove — PHP `dry_run` decides).
 */
function checkSettingsEnvelopes(node: AtomicNode, acc: Accumulator): void {
  for (const [propName, value] of Object.entries(node.settings)) {
    if (propName === 'classes') {
      continue; // handled by checkClasses
    }
    if (!isTypedValue(value)) {
      // `null` is PHP-VALID for every non-required prop (Plain/Object_Prop_Type return
      // `!is_required()` on null) and unknown keys are silently dropped by `Props_Parser`
      // (it iterates only schema keys) — but a REQUIRED schema prop rejects null, so the
      // structural pass cannot decide either way: DEFER to PHP `dry_run`.
      if (value === null || value === undefined) {
        acc.deferred = true;
        continue;
      }
      // A non-envelope object/array may be an unknown-key crumb (silently dropped = VALID in
      // PHP) or a partially-typed structure only the live schema can judge — DEFER, never
      // reject (meta-invariant: reject ⇒ PHP invalid).
      if (typeof value === 'object') {
        acc.deferred = true;
        continue;
      }
      // Bare scalars are the spike-verified [R8] failure class: the authoritative validator
      // throws `invalid_value` for a bare string/number/boolean on a schema key (frozen by the
      // e-heading.bare-string-props golden fixture) — structural reject.
      acc.errors.push(
        err('VALIDATION_FAILED', `Atomic prop "${propName}" is not a typed envelope (§3).`, {
          element_id: node.id,
          prop: propName,
        }),
      );
      continue;
    }
    // R9: image-src id-XOR-url.
    if (value.$$type === 'image-src' && !isValidImageSrc(value)) {
      acc.errors.push(
        err(
          'IMAGE_SRC_XOR_VIOLATION',
          `image-src on "${propName}" violates id-XOR-url (R9, §3.2).`,
          {
            element_id: node.id,
            prop: propName,
          },
        ),
      );
      continue;
    }
    // image wrapper: its src must also honor XOR.
    if (value.$$type === 'image' && isRecord(value.value) && 'src' in value.value) {
      const src = value.value['src'];
      if (isTypedValue(src) && src.$$type === 'image-src' && !isValidImageSrc(src)) {
        acc.errors.push(
          err(
            'IMAGE_SRC_XOR_VIOLATION',
            `image.src on "${propName}" violates id-XOR-url (R9, §3.2).`,
            {
              element_id: node.id,
              prop: propName,
            },
          ),
        );
        continue;
      }
    }
    // html-v3 over-tagging is a SOFT report, NOT a reject — but it means the value is non-trivial,
    // so the structural pass cannot prove it; defer to PHP.
    if (value.$$type === 'html-v3' && isRecord(value.value)) {
      const content = value.value['content'];
      if (isTypedValue(content) && typeof content.value === 'string') {
        if (strippedHtmlV3Tags(content.value).length > 0) {
          acc.deferred = true; // PHP/kses will strip; not a structural error
        }
      }
    }
    // Any other well-formed envelope whose deep validity we cannot prove → defer.
    if (!isProvenTrivial(value.$$type)) {
      acc.deferred = true;
    }
  }
}

/** True when a record (non-null, non-array object). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The small set of `$$type`s whose well-formedness alone is sufficient for the structural pass to
 * consider proven (scalars). Anything else (size/dimensions/link/image/union/dynamic/free-string CSS
 * props, etc.) is DEFERRED to PHP `dry_run` (`11-authoring-contract.md §8` R5/R8,
 * `14-fixtures-harness.md §4`).
 */
const TRIVIALLY_PROVEN: ReadonlySet<string> = new Set<string>([
  'string',
  'number',
  'boolean',
  'color',
  'global-color-variable',
  'global-font-variable',
  'global-size-variable',
]);

function isProvenTrivial($$type: string): boolean {
  return TRIVIALLY_PROVEN.has($$type);
}

/* ───────────────────────────── recursive walk ───────────────────────────────────────────── */

function walk(nodes: ElementNode[], acc: Accumulator): void {
  for (const node of nodes) {
    const r1ok = checkR1(node, acc);
    if (r1ok) {
      checkR3(node, acc);
    }
    if (isAtomicNode(node)) {
      const classesPresent = checkClasses(node, acc);
      checkR4(node, classesPresent, acc);
      checkSettingsEnvelopes(node, acc);
    } else {
      // Classic (V3) nodes have a flat settings map the structural pass cannot prove — defer.
      acc.deferred = true;
    }
    if (Array.isArray(node.elements) && node.elements.length > 0) {
      walk(node.elements, acc);
    }
  }
}

/**
 * Structurally pre-filter an authoring tree. Returns `reject` with taxonomy-coded errors on a proven
 * structural violation; `defer` when nothing rejected but some value could not be proven (the common
 * case — PHP `dry_run` is authoritative); `accept` ONLY when every value was trivially proven and no
 * error fired. The meta-invariant (`14-fixtures-harness.md §4`) holds: `accept ⇒ PHP valid`,
 * `reject ⇒ PHP invalid`.
 */
export function prefilter(tree: ElementNode[]): PrefilterResult {
  const acc: Accumulator = { errors: [], deferred: false, seenIds: new Set<string>() };
  walk(tree, acc);

  if (acc.errors.length > 0) {
    return { verdict: 'reject', errors: acc.errors };
  }
  if (acc.deferred) {
    return { verdict: 'defer', errors: [] };
  }
  return { verdict: 'accept', errors: [] };
}

/* Re-export the discriminators used alongside the pre-filter for caller convenience. */
export { isAtomicNode, isAtomicContainerNode, isAtomicWidgetNode };
