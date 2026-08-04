/**
 * WP-T03 — Diff shaping / presentation safety helpers.
 *
 * PHP OWNS the authoritative diff: it is produced inside the `dry_run` endpoint (WP-P03) and on every
 * mutating write (`13-tool-catalog.md §0.7`). TS only SHAPES / PRESENTS it (`01-architecture.md §7`).
 * This module never decides validity and never fabricates a change — it validates a PHP-authored
 * {@link Diff} against the FROZEN `diff.schema.json#/$defs/Diff` and returns it, summarizes it for
 * result text / elicitation prompts, and offers a clearly-fenced ADVISORY-ONLY structural diff for
 * `batch.plan` estimation and client previews.
 *
 * Contract authority:
 *   - `spec/contracts/11-authoring-contract.md §1` (Diff, NodeChange, DryRunResult).
 *   - `spec/contracts/schemas/diff.schema.json#/$defs/Diff` (the frozen shape `presentDiff` enforces).
 *   - `spec/contracts/13-tool-catalog.md §0.7` (edit tools return `Diff`).
 *
 * AUTHORITY FENCE: {@link localDiff} is ADVISORY ONLY (it carries an `_advisory:true` marker). It is a
 * cheap TS-side structural estimate for previews/planning. It is NEVER a commit-time source of truth —
 * the PHP `dry_run` is the single authority (`14-fixtures-harness.md §0`, locked decision). No commit
 * path may treat a {@link AdvisoryDiff} as a validated diff.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import type { Diff, ElementNode, NodeChange } from '../authoring/contract.js';
import { normalize } from '../authoring/contract.js';

/* ───────────────────────────── schema validation (mirror of the frozen diff schema) ──────────── */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the runtime mirror of the five frozen authoring schemas (`packages/shared/schemas`).
 * Read from disk (rather than via the shared barrel) because the schema registry lives OUTSIDE the
 * shared package's `.` export — exactly as `test-harness/fixture-loader.ts` does.
 */
const SCHEMAS_DIR = resolve(HERE, '..', '..', '..', 'shared', 'schemas');

/** The five frozen authoring schema filenames (they cross-`$ref` each other by bare filename). */
const AUTHORING_SCHEMA_FILES = [
  'atomic-prop-types.schema.json',
  'style-variant.schema.json',
  'element-node.schema.json',
  'page-tree.schema.json',
  'diff.schema.json',
] as const;

/** The `$id` + `$def` of the frozen `Diff` shape `presentDiff` validates against. */
const DIFF_REF = 'https://elementor-ultra-mcp/spec/contracts/schemas/diff.schema.json#/$defs/Diff';

/** The Ajv 2020 instance type (avoids using the default-import binding directly as a type). */
type AjvInstance = InstanceType<typeof Ajv2020>;

let ajvInstance: AjvInstance | undefined;
let diffValidate: ValidateFunction | undefined;

/**
 * Build an Ajv (draft 2020-12) with the five authoring schemas registered by `$id` so cross-`$ref`
 * resolution works. `strict:false` because the frozen schemas use `examples`/`$comment`/conditional
 * shapes Ajv strict mode flags — the schemas are the contract, not Ajv's opinion of them.
 */
function buildAjv(): AjvInstance {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const file of AUTHORING_SCHEMA_FILES) {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8')) as AnySchemaObject;
    ajv.addSchema(schema);
  }
  return ajv;
}

function getDiffValidator(): ValidateFunction {
  if (ajvInstance === undefined) {
    ajvInstance = buildAjv();
  }
  if (diffValidate === undefined) {
    const existing = ajvInstance.getSchema(DIFF_REF) as ValidateFunction | undefined;
    diffValidate = existing ?? ajvInstance.compile({ $ref: DIFF_REF });
  }
  return diffValidate;
}

/** Thrown when a PHP-authored {@link Diff} does not match the frozen `diff.schema.json#/$defs/Diff`. */
export class DiffShapeError extends Error {
  /** Ajv error pointers (compact `instancePath: message` lines) for diagnostics. */
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`PHP-authored Diff failed schema validation:\n${issues.join('\n')}`);
    this.name = 'DiffShapeError';
    this.issues = issues;
  }
}

/* ───────────────────────────── presentDiff ─────────────────────────────────────────────────── */

/**
 * Validate + normalize a PHP-authored {@link Diff} against `diff.schema.json#/$defs/Diff` and return
 * the SAME diff unchanged (`13-tool-catalog.md §0.7`, ticket Detailed-Requirements #1). This NEVER
 * fabricates a change — it is a pass-through guard so a malformed upstream diff surfaces loudly
 * ({@link DiffShapeError}) instead of being silently presented to the agent.
 */
export function presentDiff(diff: Diff): Diff {
  const validate = getDiffValidator();
  if (!validate(diff)) {
    const issues = (validate.errors ?? []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
    );
    throw new DiffShapeError(issues.length > 0 ? issues : ['unknown schema validation failure']);
  }
  return diff;
}

/* ───────────────────────────── summarizeDiff ───────────────────────────────────────────────── */

/** Compact summary of a {@link Diff} for result text + elicitation prompts (ticket §Interface). */
export interface DiffSummary {
  /** Count of `modified` changes (content edited in place). */
  changed: number;
  /** Count of `added` changes (freshly minted nodes). */
  added: number;
  /** Count of `removed` changes (deleted nodes). */
  removed: number;
  /** Count of `moved` changes (re-parented / re-ordered nodes). */
  moved: number;
  /** Every distinct id the diff touches, in first-seen order (changes + the id roll-ups). */
  touched_ids: string[];
}

/**
 * Summarize a {@link Diff} into compact counts + the distinct touched ids (ticket §Interface). Counts
 * are taken from `changes[].op`; `touched_ids` unions the per-change ids with the diff's
 * `new_ids`/`changed_ids`/`removed_ids` roll-ups, deduped, preserving first-seen order. Pure read —
 * it does not mutate the diff and does not fabricate any change.
 */
export function summarizeDiff(diff: Diff): DiffSummary {
  let changed = 0;
  let added = 0;
  let removed = 0;
  let moved = 0;

  const seen = new Set<string>();
  const touched_ids: string[] = [];
  const remember = (id: string | undefined): void => {
    if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      touched_ids.push(id);
    }
  };

  for (const change of diff.changes) {
    switch (change.op) {
      case 'modified':
        changed += 1;
        break;
      case 'added':
        added += 1;
        break;
      case 'removed':
        removed += 1;
        break;
      case 'moved':
        moved += 1;
        break;
      default:
        break;
    }
    remember(change.id);
  }

  for (const id of diff.new_ids ?? []) {
    remember(id);
  }
  for (const id of diff.changed_ids ?? []) {
    remember(id);
  }
  for (const id of diff.removed_ids ?? []) {
    remember(id);
  }

  return { changed, added, removed, moved, touched_ids };
}

/* ───────────────────────────── localDiff (ADVISORY ONLY) ───────────────────────────────────── */

/**
 * An ADVISORY structural diff: the {@link Diff} shape plus the `_advisory:true` discriminator that
 * FENCES it from every commit path. A value carrying `_advisory:true` is a TS-side estimate ONLY and
 * MUST NOT be treated as an authoritative diff (the PHP `dry_run` is — locked decision). No tool may
 * pass an {@link AdvisoryDiff} where a committed {@link Diff} is required.
 */
export type AdvisoryDiff = Diff & { _advisory: true };

/** Flatten a node tree to `id -> node` (last write wins on duplicate ids — PHP catches real dupes). */
function indexById(tree: ElementNode[]): Map<string, ElementNode> {
  const index = new Map<string, ElementNode>();
  const walk = (nodes: ElementNode[]): void => {
    for (const node of nodes) {
      index.set(node.id, node);
      if (Array.isArray(node.elements) && node.elements.length > 0) {
        walk(node.elements);
      }
    }
  };
  walk(tree);
  return index;
}

/**
 * Structural equality on two normalized nodes via stable JSON comparison (children compared separately
 * by the caller's recursion). We compare the node WITHOUT its `elements` so a parent is "modified" only
 * for its own settings/styles, not because a descendant changed.
 */
function nodeBodyEqual(a: ElementNode, b: ElementNode): boolean {
  const stripChildren = (n: ElementNode): unknown => {
    const { elements: _elements, ...rest } = n;
    void _elements;
    return rest;
  };
  return JSON.stringify(stripChildren(a)) === JSON.stringify(stripChildren(b));
}

/**
 * TS-side ADVISORY structural diff for `batch.plan` estimation / client previews ONLY
 * (ticket §Interface, Detailed-Requirements #2). Built on WP-F03's {@link normalize} so round-trip
 * noise (`_cssid`, empty sibling keys) never registers as a change.
 *
 * NOT A COMMIT SOURCE OF TRUTH. The return value carries `_advisory:true` so no caller can mistake it
 * for a validated PHP diff. For the authoritative diff, call the `dry_run` route (WP-P03) and pass its
 * diff through {@link presentDiff}.
 */
export function localDiff(before: ElementNode[], after: ElementNode[]): AdvisoryDiff {
  const beforeNorm = normalize(before);
  const afterNorm = normalize(after);
  const beforeIdx = indexById(beforeNorm);
  const afterIdx = indexById(afterNorm);

  const changes: NodeChange[] = [];
  const new_ids: string[] = [];
  const changed_ids: string[] = [];
  const removed_ids: string[] = [];

  // added + modified
  for (const [id, afterNode] of afterIdx) {
    const beforeNode = beforeIdx.get(id);
    if (beforeNode === undefined) {
      new_ids.push(id);
      const change: NodeChange = { id, op: 'added', elType: afterNode.elType, after: afterNode };
      const widgetType = (afterNode as { widgetType?: string }).widgetType;
      if (widgetType !== undefined) {
        change.widgetType = widgetType;
      }
      changes.push(change);
    } else if (!nodeBodyEqual(beforeNode, afterNode)) {
      changed_ids.push(id);
      changes.push({
        id,
        op: 'modified',
        elType: afterNode.elType,
        before: beforeNode,
        after: afterNode,
      });
    }
  }

  // removed
  for (const [id, beforeNode] of beforeIdx) {
    if (!afterIdx.has(id)) {
      removed_ids.push(id);
      changes.push({ id, op: 'removed', elType: beforeNode.elType, before: beforeNode });
    }
  }

  return {
    _advisory: true,
    changes,
    new_ids,
    changed_ids,
    removed_ids,
  };
}

/** Type guard fencing the advisory marker: `true` ⇒ this diff is NOT an authoritative commit diff. */
export function isAdvisoryDiff(diff: Diff): diff is AdvisoryDiff {
  return (diff as { _advisory?: unknown })._advisory === true;
}
