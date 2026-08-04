/**
 * WP-T06 — widget / element op tool HANDLERS (Contract 13 §1.3).
 *
 * Implements the nine surgical single-element op tools and attaches each handler to the WP-F04
 * {@link ToolRegistry} by EXACT catalog name (13-tool-catalog.md §1.3). This WP does NOT define
 * schemas (WP-F04 owns the descriptors `catalog/schemas/widget.ts`) — each handler is a
 * {@link ToolHandler} (WP-T01 `runtime/context.ts`) attached via `registry.attachHandler(name, fn)`;
 * the SDK has already validated `args` against the descriptor's `inputSchema` before the handler runs
 * (Contract 13 §0.1) and validates the returned `structuredContent` against `outputSchema` after.
 *
 * Tools handled here (Contract 13 §1.3):
 *  - `elementor.element.get` (R, `GET /documents/{id}` subtree) — read one node + the base_hash.
 *  - `elementor.widget.insert` ★ (M, op `insert`) — insert a node under a parent at an index.
 *  - `elementor.widget.update_settings` ★ (M, op `update_settings`) — patch one node's settings.
 *  - `elementor.element.move` (M, op `move`) — reorder / reparent a node.
 *  - `elementor.element.delete` (D, op `delete`) — remove a node + subtree (ELICITATION-gated).
 *  - `elementor.element.set_classes` (M, op `set_classes`) — set the BARE-array `classes` prop.
 *  - `elementor.element.set_local_style` (M, op `set_local_style`) — upsert a local style variant
 *    (mints + MIRRORS the style id into `classes` so it never detaches, Contract 11 §2.1 / §5.1).
 *  - `elementor.element.bind_dynamic` (M, op `bind_dynamic`) — bind a dynamic tag to a control.
 *  - `elementor.element.bind_global` (M, op `bind_global`) — bind a V3 global to a control.
 *
 * TRANSACTION MODEL (Contract 10 §14, Contract 13 §1.3 intro): every MUTATING op is submitted as ONE
 * granular operation via `ctx.wp.elementOps(post_id, {base_hash, ops:[{op,...}], force?, op_id?})`. PHP
 * does ONE read-mutate-validate-write `Document::save()` transaction (validate is AUTHORITATIVE,
 * WP-P03; never N partial saves). `base_hash` is REQUIRED on every mutating op (Contract 13 §0.8); a
 * mismatch surfaces as `CONCURRENCY_STALE_HASH` (the agent re-reads via `page.get_structure`), and
 * `force` overrides lock / autosave refusals. insert/style ops also accept `op_id` for idempotency
 * (deterministic mint via WP-T03 when omitted); a replayed write surfaces `IDEMPOTENT_REPLAY`
 * informationally (Contract 12 §5.4) on the diff/result, never as a hard failure.
 *
 * DIFF SHAPE: the REST element-ops route returns the FLAT id-rollup diff
 * `{changed_ids,new_ids,removed_ids}` (Contract 10 §14), but the catalog `outputSchema` requires the
 * frozen rich `Diff` whose only required key is `changes[]` (Contract 11 §1, `diff.schema.json`).
 * {@link restDiffToDiff} bridges the two (one `NodeChange` per rolled-up id), then {@link presentDiff}
 * (WP-T03) validates the synthesized diff against the frozen schema before it reaches the agent.
 *
 * ERROR SURFACE: a {@link WpClientError} (e.g. `CONCURRENCY_STALE_HASH`, `LOCK_HELD`,
 * `AUTOSAVE_CONFLICT`, `LOCAL_STYLE_UNLINKED`, `NOT_FOUND`, `ATOMIC_SETTINGS_INVALID`) routes through
 * WP-F05's `fromClientError` → protocol-throw vs `isError` result (12-error-taxonomy.md §5). Tool-arg
 * failures are `-32602` from the SDK's zod layer before the handler runs.
 *
 * Contract authority: 13-tool-catalog.md §1.3 (per-tool I/O), §0.7 (Diff+base_hash), §0.8
 * (base_hash/op_id/force), §0.9 (error semantics); 10-rest-api.md §2.4 (`GET /documents/{id}`), §14
 * (granular op batch); 11-authoring-contract.md §2.1/§5.1 (local-style mirror), §2.3 / SUPPLEMENT
 * §A.6 (V3 `__dynamic__`/`__globals__`); 12-error-taxonomy.md §3, §5.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  makeErrorPayload,
  type ElementOp,
  type ElementOpsRequest,
  type ElementOpsResponse,
  type GetDocumentRequest,
  type GetDocumentResponse,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import type { ToolRegistry } from '../catalog/registry.js';
import { WpClientError } from '../wp/types.js';
import {
  fromClientError,
  toToolErrorResult,
  declinedResult,
  type ToolResult,
} from '../wp/errors.js';
import { presentDiff, summarizeDiff } from '../safety/diff.js';
import { mintOpId, isReplay } from '../safety/idempotency.js';
import { mintLocalStyleId } from '../authoring/ids.js';
import type { Diff, ElementNode, NodeChange, StyleVariant } from '../authoring/contract.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.3) ────────────────────────── */

/** The widget / element tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.3). */
export const ELEMENT_GET = 'elementor.element.get';
export const WIDGET_INSERT = 'elementor.widget.insert';
export const WIDGET_UPDATE_SETTINGS = 'elementor.widget.update_settings';
export const ELEMENT_MOVE = 'elementor.element.move';
export const ELEMENT_DELETE = 'elementor.element.delete';
export const ELEMENT_SET_CLASSES = 'elementor.element.set_classes';
export const ELEMENT_SET_LOCAL_STYLE = 'elementor.element.set_local_style';
export const ELEMENT_BIND_DYNAMIC = 'elementor.element.bind_dynamic';
export const ELEMENT_BIND_GLOBAL = 'elementor.element.bind_global';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const WIDGET_TOOL_NAMES = [
  ELEMENT_GET,
  WIDGET_INSERT,
  WIDGET_UPDATE_SETTINGS,
  ELEMENT_MOVE,
  ELEMENT_DELETE,
  ELEMENT_SET_CLASSES,
  ELEMENT_SET_LOCAL_STYLE,
  ELEMENT_BIND_DYNAMIC,
  ELEMENT_BIND_GLOBAL,
] as const;

/* ───────────────────────────── result helpers ──────────────────────────────────────────────── */

/** Whether a thrown value is a {@link WpClientError} (carries a taxonomy `payload`). */
function isWpClientError(value: unknown): value is WpClientError {
  return value instanceof WpClientError;
}

/**
 * Build a successful tool result: the structured payload (validated against the descriptor's
 * `outputSchema` by the SDK) plus a compact human-readable `text` line (the SDK requires `content`).
 */
function okResult(structured: Record<string, unknown>, text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/**
 * Run a widget/element handler: invoke `fn` and, on a {@link WpClientError} (e.g.
 * `CONCURRENCY_STALE_HASH` / `LOCK_HELD` / `ATOMIC_SETTINGS_INVALID` from PHP), route it through
 * WP-F05's surface rules (`fromClientError` → protocol-throw or `isError` result,
 * 12-error-taxonomy.md §5). Non-client errors rethrow (the server core surfaces them). The
 * {@link ToolResult} is structurally a {@link CallToolResult}.
 */
async function runOp(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── diff bridge (REST flat → frozen Diff) ────────────────────────── */

/**
 * Bridge the REST element-ops FLAT diff (`{changed_ids,new_ids,removed_ids}`, Contract 10 §14) into
 * the frozen rich {@link Diff} the catalog `outputSchema` requires (`changes[]` mandatory, Contract 11
 * §1 / `diff.schema.json`). We synthesize ONE {@link NodeChange} per rolled-up id (added/modified/
 * removed) — PHP owns the AUTHORITATIVE diff, but the granular route only ships the id rollups, so this
 * faithfully re-expresses those rollups in the frozen shape (it never fabricates a change the rollups
 * did not name). The full id arrays ride alongside so {@link summarizeDiff} stays accurate.
 */
export function restDiffToDiff(rest: ElementOpsResponse['diff']): Diff {
  // The REST diff id rollups are typed `string[]`, but the LIVE element-ops route can hand back a
  // non-string id when a styles map is involved (a styles-map key JSON-deserializes as a number) — the
  // frozen `NodeChange.id` (ElementId) is a string, so `presentDiff` would reject it (#3a). Coerce every
  // rolled-up id to a non-empty string at this boundary so a styles-touching op never trips the schema.
  const newIds = coerceIdList(rest.new_ids);
  const changedIds = coerceIdList(rest.changed_ids);
  const removedIds = coerceIdList(rest.removed_ids);

  const changes: NodeChange[] = [];
  for (const id of newIds) {
    changes.push({ id, op: 'added' });
  }
  for (const id of changedIds) {
    changes.push({ id, op: 'modified' });
  }
  for (const id of removedIds) {
    changes.push({ id, op: 'removed' });
  }
  return {
    changes,
    new_ids: newIds,
    changed_ids: changedIds,
    removed_ids: removedIds,
  };
}

/**
 * Coerce an upstream diff id rollup to a clean `string[]` (#3a). PHP may serialize a styles-map id as a
 * number (or, defensively, hand back a non-array); we string-ify each scalar and drop empties so the
 * frozen `ElementId` (string) constraint in `presentDiff` is always satisfied.
 */
function coerceIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const id of value) {
    if (typeof id === 'string' && id.length > 0) {
      out.push(id);
    } else if (typeof id === 'number' || typeof id === 'bigint') {
      out.push(String(id));
    }
  }
  return out;
}

/** A short human summary of a synthesized {@link Diff} (counts) for the result `text` line. */
function diffText(diff: Diff): string {
  const s = summarizeDiff(diff);
  return `${String(s.added)} added, ${String(s.changed)} changed, ${String(s.removed)} removed`;
}

/* ───────────────────────────── shared mutate submission (Contract 10 §14) ───────────────────── */

/** What {@link submitOp} returns to a mutate handler: the validated diff + new base_hash + replay flag. */
interface SubmitResult {
  diff: Diff;
  base_hash: string;
  replay: boolean;
  remapped_ids: Record<string, string>;
  css_primed: boolean;
  /** The raw REST response (for op-specific echoes like `dynamic_string` PHP may surface). */
  raw: ElementOpsResponse;
}

/**
 * Submit ONE granular element op as a single transaction (Contract 10 §14). Centralizes the
 * base_hash + op_id + force shaping (§Implementation Notes), the REST→frozen diff bridge
 * ({@link restDiffToDiff} + {@link presentDiff} validation), and the replay flag read (WP-T03
 * {@link isReplay}). Every mutating handler funnels through here so the request shape stays uniform.
 *
 * `op_id` is included only when the op kind carries one (insert/local-style accept an idempotency key,
 * Contract 13 §0.8); the caller passes `mintOp:true` and the deterministic parts to derive it.
 */
async function submitOp(
  ctx: ToolContext,
  postId: number,
  op: ElementOp,
  opts: {
    baseHash: string;
    force?: boolean;
    /** When set, thread an `op_id` (explicit, else deterministically minted from `idemParts`). */
    opId?: string;
    idemParts?: readonly unknown[];
  },
): Promise<SubmitResult> {
  const body: ElementOpsRequest = {
    base_hash: opts.baseHash,
    ops: [op],
  };
  if (opts.force === true) {
    body.force = true;
  }
  if (opts.opId !== undefined) {
    body.op_id = opts.opId;
  } else if (opts.idemParts !== undefined) {
    body.op_id = mintOpId(opts.idemParts);
  }

  const data: ElementOpsResponse = await ctx.wp.elementOps(postId, body);
  const diff = presentDiff(restDiffToDiff(data.diff));
  return {
    diff,
    base_hash: data.base_hash,
    replay: isReplay(data as unknown as { idempotent_replay?: boolean }),
    remapped_ids: data.remapped_ids,
    css_primed: data.css_primed,
    raw: data,
  };
}

/** Append the informational `IDEMPOTENT_REPLAY` note to a result text when PHP no-oped a replay. */
function withReplayNote(text: string, replay: boolean): string {
  return replay ? `${text} (idempotent replay — already applied; stop retrying)` : text;
}

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (Contract 13 §0.1), so the shapes below describe the POST-validation input — narrowing views over the
 * loose `unknown` the runtime {@link ToolHandler} declares, NOT re-validation. `force`/`confirm` have a
 * `.default(false)` in the descriptor, so they arrive as concrete booleans.
 */

interface ElementGetArgs {
  post_id: number;
  element_id: string;
}

interface WidgetInsertArgs {
  post_id: number;
  parent_id: string;
  index?: number;
  node: ElementNode;
  base_hash: string;
  op_id?: string;
  force: boolean;
}

interface WidgetUpdateSettingsArgs {
  post_id: number;
  element_id: string;
  settings: Record<string, unknown>;
  base_hash: string;
  force: boolean;
}

interface ElementMoveArgs {
  post_id: number;
  element_id: string;
  new_parent_id: string;
  index: number;
  base_hash: string;
  force: boolean;
}

interface ElementDeleteArgs {
  post_id: number;
  element_id: string;
  base_hash: string;
  confirm: boolean;
  force: boolean;
}

interface ElementSetClassesArgs {
  post_id: number;
  element_id: string;
  class_ids: string[];
  base_hash: string;
}

interface ElementSetLocalStyleArgs {
  post_id: number;
  element_id: string;
  style_id?: string;
  variant: StyleVariant;
  base_hash: string;
}

interface ElementBindDynamicArgs {
  post_id: number;
  element_id: string;
  control: string;
  tag_name: string;
  tag_settings?: Record<string, unknown>;
  fallback_value?: unknown;
  base_hash: string;
}

interface ElementBindGlobalArgs {
  post_id: number;
  element_id: string;
  control: string;
  global_ref: string;
  base_hash: string;
}

/* ───────────────────────────── elementor.element.get (§1.3 / §2.4) ──────────────────────────── */

/** Recursively find a node by id in an element tree (DFS). */
function findNode(tree: ElementNode[], id: string): ElementNode | undefined {
  for (const node of tree) {
    if (node.id === id) {
      return node;
    }
    if (Array.isArray(node.elements) && node.elements.length > 0) {
      const found = findNode(node.elements, id);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * `elementor.element.get` handler (13-tool-catalog.md §1.3; 10-rest-api.md §2.4). READ — proxies
 * `GET /documents/{id}` with `subtree_id` to fetch only the requested node's subtree, then walks the
 * returned tree to extract the exact node. Returns `{node, base_hash}` (the base_hash is the
 * optimistic-lock token the agent then threads into any subsequent mutating op). A missing node →
 * `NOT_FOUND` `isError` result (the agent can re-read structure). REST `NOT_FOUND` (bad post id)
 * arrives as a {@link WpClientError} and routes through the surface rules.
 */
export async function elementGetHandler(
  args: ElementGetArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    const query: GetDocumentRequest = { subtree_id: args.element_id };
    const data: GetDocumentResponse = await ctx.wp.getDocument(args.post_id, query);
    const node = findNode(data.elements as ElementNode[], args.element_id);
    if (node === undefined) {
      return toToolErrorResult(
        makeErrorPayload(
          ErrorCodes.NOT_FOUND,
          `Element "${args.element_id}" was not found in document ${String(args.post_id)}.`,
          { meta: { resource: 'element', id: args.element_id } },
        ),
      );
    }
    return okResult(
      { node, base_hash: data.base_hash },
      `Read element ${args.element_id} from document ${String(args.post_id)}.`,
    );
  });
}

/* ───────────────────────────── elementor.widget.insert (★, §1.3 / §14) ──────────────────────── */

/**
 * `elementor.widget.insert` handler (★, 13-tool-catalog.md §1.3; 10-rest-api.md §14). Submits ONE
 * `insert` op (`{op,parent_id,index?,node}`) as a single transaction. `op_id` is threaded for
 * idempotency: an explicit `op_id` is used as-is, else a DETERMINISTIC id is minted (WP-T03
 * {@link mintOpId}) from the (post,parent,index,node,base_hash) parts so a retried insert is recognized
 * as a replay by PHP and NO-OPed (Contract 13 §0.8). Returns `{diff, inserted_id, base_hash}` — the
 * inserted id is read from the diff's `new_ids` (PHP mints fresh ids; the node's authored id may be
 * remapped on collision, so we prefer the authoritative `new_ids`/`remapped_ids` over the request id).
 */
export async function widgetInsertHandler(
  args: WidgetInsertArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    const op: ElementOp = {
      op: 'insert',
      parent_id: args.parent_id,
      node: args.node,
    };
    if (args.index !== undefined) {
      op['index'] = args.index;
    }
    const result = await submitOp(ctx, args.post_id, op, {
      baseHash: args.base_hash,
      force: args.force,
      ...(args.op_id !== undefined
        ? { opId: args.op_id }
        : {
            idemParts: [
              'insert',
              args.post_id,
              args.parent_id,
              args.index ?? null,
              args.node,
              args.base_hash,
            ],
          }),
    });
    const insertedId = resolveInsertedId(result, args.node);
    return okResult(
      {
        diff: result.diff,
        inserted_id: insertedId,
        base_hash: result.base_hash,
      },
      withReplayNote(
        `Inserted ${describeNode(args.node)} into ${args.parent_id} (${diffText(result.diff)}).`,
        result.replay,
      ),
    );
  });
}

/**
 * Resolve the inserted node's authoritative id: prefer the AUTHORED id when PHP accepted it (it appears
 * in `new_ids`), else its remap target (`remapped_ids[authoredId]`), else the first freshly-minted id
 * (`new_ids[0]`), else the authored id as a last resort. PHP re-IDs on collision (Contract 10 §10 /
 * Spike R5 — local-style ids are not stable across save), so this never blindly trusts the request id.
 */
function resolveInsertedId(result: SubmitResult, node: ElementNode): string {
  const authored = node.id;
  if (typeof authored === 'string' && result.diff.new_ids?.includes(authored) === true) {
    return authored;
  }
  if (typeof authored === 'string' && result.remapped_ids[authored] !== undefined) {
    return result.remapped_ids[authored];
  }
  const firstNew = result.diff.new_ids?.[0];
  if (typeof firstNew === 'string') {
    return firstNew;
  }
  return typeof authored === 'string' ? authored : '';
}

/** A compact node label for result text (`widgetType` for widgets, else `elType`). */
function describeNode(node: ElementNode): string {
  const widgetType = (node as { widgetType?: string }).widgetType;
  return typeof widgetType === 'string' && widgetType.length > 0 ? widgetType : node.elType;
}

/* ───────────────────────────── elementor.widget.update_settings (★, §1.3) ───────────────────── */

/**
 * `elementor.widget.update_settings` handler (★, 13-tool-catalog.md §1.3; 10-rest-api.md §14). Submits
 * ONE `update_settings` op (`{op,element_id,settings}`) — PHP deep-merges the settings PATCH into the
 * node and validates AUTHORITATIVELY before the single save. `idempotentHint:true`: the same patch
 * applied twice yields the same node, so we mint a deterministic `op_id` so a retry collapses to a
 * replay. Returns `{diff, base_hash}`.
 */
export async function widgetUpdateSettingsHandler(
  args: WidgetUpdateSettingsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    const op: ElementOp = {
      op: 'update_settings',
      element_id: args.element_id,
      settings: args.settings,
    };
    const result = await submitOp(ctx, args.post_id, op, {
      baseHash: args.base_hash,
      force: args.force,
      idemParts: ['update_settings', args.post_id, args.element_id, args.settings, args.base_hash],
    });
    return okResult(
      { diff: result.diff, base_hash: result.base_hash },
      withReplayNote(
        `Updated settings on ${args.element_id} (${diffText(result.diff)}).`,
        result.replay,
      ),
    );
  });
}

/* ───────────────────────────── elementor.element.move (§1.3) ────────────────────────────────── */

/**
 * `elementor.element.move` handler (13-tool-catalog.md §1.3; 10-rest-api.md §14). Submits ONE `move`
 * op (`{op,element_id,new_parent_id,index}`) reordering / reparenting the node. Returns `{diff,
 * base_hash}`. No `op_id` (the descriptor declares no idempotency hint — a move is positional, not a
 * pure-set, so a deterministic key is not threaded).
 */
export async function elementMoveHandler(
  args: ElementMoveArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    const op: ElementOp = {
      op: 'move',
      element_id: args.element_id,
      new_parent_id: args.new_parent_id,
      index: args.index,
    };
    const result = await submitOp(ctx, args.post_id, op, {
      baseHash: args.base_hash,
      force: args.force,
    });
    return okResult(
      { diff: result.diff, base_hash: result.base_hash },
      `Moved ${args.element_id} into ${args.new_parent_id} at index ${String(args.index)} (${diffText(result.diff)}).`,
    );
  });
}

/* ───────────────────────────── elementor.element.delete (D, §1.3) ───────────────────────────── */

/**
 * `elementor.element.delete` handler (13-tool-catalog.md §1.3; 10-rest-api.md §14). DESTRUCTIVE — when
 * `confirm!=true` it ELICITS a confirm round-trip (Contract 13 §0.3); a DECLINE returns a CLEAN
 * non-error result (Contract 12 §5.5), no REST call made. On confirm it submits ONE `delete` op
 * (`{op,element_id}`) removing the node + its subtree. Returns `{diff, base_hash}`.
 */
export async function elementDeleteHandler(
  args: ElementDeleteArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    if (args.confirm !== true) {
      const outcome = await ctx.elicit(
        `Delete element ${args.element_id} (and its entire subtree) from document ${String(args.post_id)}? This cannot be undone without a rollback.`,
      );
      if (!outcome.confirmed) {
        // M-b: decline carries a schema-valid structured payload (an empty diff, unchanged hash).
        return declinedResult(
          `Deletion of element ${args.element_id} cancelled; no changes were made.`,
          {
            diff: { changes: [], new_ids: [], changed_ids: [], removed_ids: [] },
            base_hash: args.base_hash,
          },
        );
      }
    }
    const op: ElementOp = { op: 'delete', element_id: args.element_id };
    const result = await submitOp(ctx, args.post_id, op, {
      baseHash: args.base_hash,
      force: args.force,
    });
    return okResult(
      { diff: result.diff, base_hash: result.base_hash },
      `Deleted ${args.element_id} (${diffText(result.diff)}).`,
    );
  });
}

/* ───────────────────────────── elementor.element.set_classes (§1.3) ─────────────────────────── */

/**
 * `elementor.element.set_classes` handler (13-tool-catalog.md §1.3; 10-rest-api.md §14; Contract 11
 * §3). Submits ONE `set_classes` op (`{op,element_id,class_ids}`). `class_ids` are BARE ids — global
 * (`g-*`) + local (`e-*`) — set as the BARE-array `classes` value (PHP writes
 * `settings.classes.value`); the catalog `inputSchema` already validated them. Returns `{diff,
 * base_hash}`. `idempotentHint:true` (pure set) — a deterministic `op_id` collapses a retry.
 */
export async function elementSetClassesHandler(
  args: ElementSetClassesArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    const op: ElementOp = {
      op: 'set_classes',
      element_id: args.element_id,
      class_ids: args.class_ids,
    };
    const result = await submitOp(ctx, args.post_id, op, {
      baseHash: args.base_hash,
      idemParts: ['set_classes', args.post_id, args.element_id, args.class_ids, args.base_hash],
    });
    return okResult(
      { diff: result.diff, base_hash: result.base_hash },
      withReplayNote(
        `Set ${String(args.class_ids.length)} class(es) on ${args.element_id} (${diffText(result.diff)}).`,
        result.replay,
      ),
    );
  });
}

/* ───────────────────────────── elementor.element.set_local_style (§1.3) ─────────────────────── */

/**
 * `elementor.element.set_local_style` handler (13-tool-catalog.md §1.3; 10-rest-api.md §14; Contract 11
 * §2.1 / §5.1). Upserts ONE local style variant on a node:
 *
 *  1. Resolve / MINT the style id: an explicit `style_id` is reused (re-upsert into an existing local
 *     style); when absent, mint `e-<element_id>-<7hex>` via WP-F03 {@link mintLocalStyleId}. The
 *     resolved id is returned so the agent can target the same style again.
 *  2. Submit ONE `set_local_style` op (`{op,element_id,style_id,variant}`). PHP upserts the variant
 *     into the element's `styles` map AND MIRRORS the style id into `settings.classes.value` (the §5.1
 *     LOCAL_STYLE_UNLINKED invariant — the highest-risk local-style rule; a styles-map id absent from
 *     `classes` silently detaches). PHP is authoritative; a detached result would surface as
 *     `LOCAL_STYLE_UNLINKED`.
 *
 * Returns `{diff, style_id, base_hash}`. `idempotentHint:true`: a deterministic `op_id` keyed on the
 * RESOLVED style id collapses a retry into a replay.
 */
export async function elementSetLocalStyleHandler(
  args: ElementSetLocalStyleArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    const styleId =
      args.style_id !== undefined && args.style_id.length > 0
        ? args.style_id
        : mintLocalStyleId(args.element_id);
    const op: ElementOp = {
      op: 'set_local_style',
      element_id: args.element_id,
      style_id: styleId,
      variant: args.variant,
    };
    const result = await submitOp(ctx, args.post_id, op, {
      baseHash: args.base_hash,
      idemParts: [
        'set_local_style',
        args.post_id,
        args.element_id,
        styleId,
        args.variant,
        args.base_hash,
      ],
    });
    return okResult(
      { diff: result.diff, style_id: styleId, base_hash: result.base_hash },
      withReplayNote(
        `Upserted local style ${styleId} on ${args.element_id} (${diffText(result.diff)}).`,
        result.replay,
      ),
    );
  });
}

/* ───────────────────────────── elementor.element.bind_dynamic (§1.3) ────────────────────────── */

/**
 * `elementor.element.bind_dynamic` handler (13-tool-catalog.md §1.3; 10-rest-api.md §14; Contract 11
 * §2.3 / SUPPLEMENT §A.6). Submits ONE `bind_dynamic` op (`{op,element_id,control,tag_name,
 * tag_settings?,fallback_value?}`). The FREE tool builds the request; PHP produces the CANONICAL
 * `dynamic_string` (V3 `[elementor-tag id=".." name="tag_name" settings="<urlencoded
 * JSON_FORCE_OBJECT>"]` written to `settings.__dynamic__[control]`; V4 atomic dynamic discovered via
 * `schema.widget`). We do NOT byte-reproduce Pro `tag_to_text` here (that is WP-R##'s
 * `pro.dynamic.bind`). Returns `{diff, dynamic_string, base_hash}` — `dynamic_string` is read back from
 * the op's per-op result (PHP echoes the canonical string). `idempotentHint:true`.
 */
export async function elementBindDynamicHandler(
  args: ElementBindDynamicArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    const op: ElementOp = {
      op: 'bind_dynamic',
      element_id: args.element_id,
      control: args.control,
      tag_name: args.tag_name,
    };
    if (args.tag_settings !== undefined) {
      op['tag_settings'] = args.tag_settings;
    }
    if (args.fallback_value !== undefined) {
      op['fallback_value'] = args.fallback_value;
    }
    const result = await submitOp(ctx, args.post_id, op, {
      baseHash: args.base_hash,
      idemParts: [
        'bind_dynamic',
        args.post_id,
        args.element_id,
        args.control,
        args.tag_name,
        args.tag_settings ?? null,
        args.fallback_value ?? null,
        args.base_hash,
      ],
    });
    const dynamicString = readDynamicString(result, args.tag_name, args.tag_settings);
    return okResult(
      { diff: result.diff, dynamic_string: dynamicString, base_hash: result.base_hash },
      withReplayNote(
        `Bound dynamic tag ${args.tag_name} → ${args.element_id}.${args.control} (${diffText(result.diff)}).`,
        result.replay,
      ),
    );
  });
}

/**
 * Read the PHP-canonicalized `dynamic_string` from the element-ops response. The granular route's
 * per-op echo (when PHP surfaces it) lives on `data.ops[0].dynamic_string`; when the route does not
 * echo it (older shape), we fall back to the V3 canonical encoding so the agent still receives a
 * usable string (SUPPLEMENT §A.6: empty settings encode as `%7B%7D`, NOT empty). PHP remains
 * authoritative for what was persisted.
 */
function readDynamicString(
  result: SubmitResult,
  tagName: string,
  tagSettings: Record<string, unknown> | undefined,
): string {
  const echoed = (result.raw as unknown as { dynamic_string?: unknown }).dynamic_string;
  if (typeof echoed === 'string' && echoed.length > 0) {
    return echoed;
  }
  const settingsJson = JSON.stringify(tagSettings ?? {});
  const encoded = encodeURIComponent(settingsJson);
  return `[elementor-tag name="${tagName}" settings="${encoded}"]`;
}

/* ───────────────────────────── elementor.element.bind_global (§1.3) ─────────────────────────── */

/**
 * `elementor.element.bind_global` handler (13-tool-catalog.md §1.3; 10-rest-api.md §14; Contract 11
 * §7). Submits ONE `bind_global` op (`{op,element_id,control,global_ref}`) — PHP writes the V3
 * `settings.__globals__[control]=global_ref` (e.g. `globals/colors?id=primary`). Returns `{diff,
 * base_hash}`. `idempotentHint:true` (pure set) — a deterministic `op_id` collapses a retry.
 */
export async function elementBindGlobalHandler(
  args: ElementBindGlobalArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runOp(async () => {
    const op: ElementOp = {
      op: 'bind_global',
      element_id: args.element_id,
      control: args.control,
      global_ref: args.global_ref,
    };
    const result = await submitOp(ctx, args.post_id, op, {
      baseHash: args.base_hash,
      idemParts: [
        'bind_global',
        args.post_id,
        args.element_id,
        args.control,
        args.global_ref,
        args.base_hash,
      ],
    });
    return okResult(
      { diff: result.diff, base_hash: result.base_hash },
      withReplayNote(
        `Bound global ${args.global_ref} → ${args.element_id}.${args.control} (${diffText(result.diff)}).`,
        result.replay,
      ),
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ─────────────────── */

/**
 * Attach every widget / element handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name
 * (§Detailed Requirements 1; §Acceptance). The registry stores handlers under its loose
 * `(args) => unknown` type; the runtime invokes them as `(args, ctx)` (server core casts to the WP-T01
 * {@link ToolHandler} signature), so each handler is registered through that signature here.
 */
export function attachWidgetHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [ELEMENT_GET]: (args, ctx) => elementGetHandler(args as ElementGetArgs, ctx),
    [WIDGET_INSERT]: (args, ctx) => widgetInsertHandler(args as WidgetInsertArgs, ctx),
    [WIDGET_UPDATE_SETTINGS]: (args, ctx) =>
      widgetUpdateSettingsHandler(args as WidgetUpdateSettingsArgs, ctx),
    [ELEMENT_MOVE]: (args, ctx) => elementMoveHandler(args as ElementMoveArgs, ctx),
    [ELEMENT_DELETE]: (args, ctx) => elementDeleteHandler(args as ElementDeleteArgs, ctx),
    [ELEMENT_SET_CLASSES]: (args, ctx) =>
      elementSetClassesHandler(args as ElementSetClassesArgs, ctx),
    [ELEMENT_SET_LOCAL_STYLE]: (args, ctx) =>
      elementSetLocalStyleHandler(args as ElementSetLocalStyleArgs, ctx),
    [ELEMENT_BIND_DYNAMIC]: (args, ctx) =>
      elementBindDynamicHandler(args as ElementBindDynamicArgs, ctx),
    [ELEMENT_BIND_GLOBAL]: (args, ctx) =>
      elementBindGlobalHandler(args as ElementBindGlobalArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
