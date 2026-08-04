/**
 * WP-T11 — Ops / observability + cross-doc batch HANDLERS (Contract 13 §1.10).
 *
 * Implements three tools attached to the WP-F04 {@link ToolRegistry} by EXACT catalog name; the
 * meta-trio lives in the sibling `tools/meta.ts`. None of these is ★.
 *  - `elementor.ops.log` (R, `GET /ops/log`) — paginated audit trail of writes (op_id, before/after
 *    hashes, result). PHP-owned op-log (architecture §7), read-only. CAP_MANAGE (Contract 10 §11) — a
 *    non-admin agent user may get `CAPABILITY_MISSING`, surfaced cleanly via the WP-F05 client path.
 *  - `elementor.batch.plan` (R, BOTH) — dry-plan a multi-document brief via the WP-T03 {@link planBatch}
 *    engine; NEVER persists (`readOnlyHint`).
 *  - `elementor.batch.apply` (D, BOTH) — execute a plan with UP-FRONT backups + reverse-order
 *    compensation via the WP-T03 {@link applyBatch} engine. DESTRUCTIVE: elicits a confirm round-trip
 *    when `confirm!=true`; a decline ⇒ a clean non-error {@link declinedResult}. Surfaces
 *    `IDEMPOTENT_REPLAY` on a replayed op (WP-T03 {@link isReplay}, Contract 12 §3.2).
 *
 * Handlers are THIN: validate-by-SDK → engine/route call → map into the descriptor's `outputSchema`
 * shape → return `{ content, structuredContent }`. A thrown {@link WpClientError} routes through WP-F05's
 * `fromClientError` (surface rules, 12-error-taxonomy.md §5); arg failures are `-32602` from the SDK
 * before the handler runs.
 *
 * Contract authority: 13-tool-catalog.md §1.10 (per-tool I/O), §0.6 (pagination), §5.6 (batch-vs-
 * granular); 10-rest-api.md §11 (ops/log) / §13 (batch routes + compensation) / §0.8 (op_id);
 * 12-error-taxonomy.md §3.2 (IDEMPOTENT_REPLAY) / §5 (surface rules).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { OpLogEntry, OpsLogRequest } from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import type { ToolRegistry } from '../catalog/registry.js';
import { confirmSchema } from '../runtime/elicit.js';
import {
  applyBatch,
  derivePlanRow,
  planBatch,
  toolToRestStep,
  type BatchPlan,
  type BatchStep,
  type PlanRow,
  type StepResult,
} from '../safety/batch.js';
import { isReplay } from '../safety/idempotency.js';
import { WpClientError } from '../wp/types.js';
import { declinedResult, fromClientError, type ToolResult } from '../wp/errors.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.10) ──────────────────────── */

/** The ops/batch tool names this module attaches (EXACT catalog names — 13-tool-catalog.md §1.10). */
export const OPS_LOG = 'elementor.ops.log';
export const BATCH_PLAN = 'elementor.batch.plan';
export const BATCH_APPLY = 'elementor.batch.apply';

/** Every ops/batch tool name this module owns a handler for (used by attach + tests). */
export const OPS_TOOL_NAMES = [OPS_LOG, BATCH_PLAN, BATCH_APPLY] as const;

/* ───────────────────────────── result helpers ─────────────────────────────────────────────── */

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
 * Run a thin handler: invoke `fn` and, on a {@link WpClientError}, route it through WP-F05's surface
 * rules (`fromClientError` → protocol-throw or `isError` result). Non-client errors rethrow (the server
 * core surfaces them). The {@link ToolResult} is structurally a {@link CallToolResult}.
 */
async function run(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── typed validated args (post-SDK) ────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (Contract 13 §0.9), so the shapes below describe the POST-validation input — narrowing views over the
 * loose `unknown` the runtime `ToolHandler` declares, NOT re-validation.
 */

interface OpsLogArgs {
  post_id?: number;
  user?: string;
  limit: number;
  cursor?: string;
  fields?: string[];
}

interface BatchPlanArgs {
  steps: BatchStep[];
}

interface BatchApplyArgs {
  /** The plan rows produced by `batch.plan` (`z.array(z.unknown())` at the SDK boundary). */
  plan: unknown[];
  op_id?: string;
  confirm: boolean;
}

/* ───────────────────────────── elementor.ops.log (§1.10 / §11) ────────────────────────────── */

/**
 * Map a RAW REST {@link OpLogEntry} to the catalog item shape (13-tool-catalog.md §1.10 outputSchema):
 * `post_id` becomes nullable (a global/kit op has no post) and `ts` becomes a STRING (the schema types
 * `ts: z.string()` while the REST row carries a numeric unix `ts`).
 */
function projectOpLogEntry(entry: OpLogEntry): {
  op_id: string;
  post_id: number | null;
  user: string;
  tool: string;
  before_hash: string;
  after_hash: string;
  result: string;
  ts: string;
} {
  return {
    op_id: entry.op_id,
    // A global/kit-only op (e.g. design-system write) has no document target ⇒ null.
    post_id: typeof entry.post_id === 'number' && entry.post_id > 0 ? entry.post_id : null,
    user: entry.user,
    tool: entry.tool,
    // The tool outputSchema types the hashes as `z.string()`; a create/insert op may have no
    // before/after hash live (PHP emits null), so coerce a missing hash to '' to stay schema-valid.
    before_hash: typeof entry.before_hash === 'string' ? entry.before_hash : '',
    after_hash: typeof entry.after_hash === 'string' ? entry.after_hash : '',
    result: entry.result,
    ts: String(entry.ts),
  };
}

/**
 * `elementor.ops.log` handler (13-tool-catalog.md §1.10; 10-rest-api.md §11). Proxies `GET /ops/log`
 * with `{post_id, user}` filters + §0.6 pagination (`limit`/`cursor`/`fields`) and projects each RAW
 * {@link OpLogEntry} into the catalog item shape. READ-ONLY (the op-log is PHP-owned, architecture §7).
 * CAP_MANAGE: a non-admin agent user gets a clean `CAPABILITY_MISSING` via the client error path.
 */
export async function opsLogHandler(args: OpsLogArgs, ctx: ToolContext): Promise<CallToolResult> {
  return run(async () => {
    const query: OpsLogRequest = {
      ...(args.post_id !== undefined ? { post_id: args.post_id } : {}),
      ...(args.user !== undefined ? { user: args.user } : {}),
      limit: args.limit,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.fields !== undefined ? { fields: args.fields } : {}),
    };
    const data = await ctx.wp.opsLog(query);
    const items = data.items.map(projectOpLogEntry);
    const structured = {
      items,
      next_cursor: data.next_cursor,
      total: data.total ?? items.length,
    };
    return okResult(
      structured,
      `Listed ${items.length} op-log entr${items.length === 1 ? 'y' : 'ies'}${
        data.next_cursor !== null ? ' (more available)' : ''
      }.`,
    );
  });
}

/* ───────────────────────────── elementor.batch.plan (§1.10 / §13) ─────────────────────────── */

/**
 * `elementor.batch.plan` handler (13-tool-catalog.md §1.10; 10-rest-api.md §13). Delegates to the
 * WP-T03 {@link planBatch} engine, which derives the `{step_index,tool,input,target,action}` plan rows
 * (each carrying its step's original input so apply can rebuild the REST bodies) and accumulates the
 * required backups + the per-step validity verdict (preferring the PHP `/batch/plan` validator when
 * reachable, else a local derivation). NEVER persists — `batch.plan` is `readOnlyHint:true`.
 */
export async function batchPlanHandler(
  args: BatchPlanArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return run(async () => {
    const plan: BatchPlan = await planBatch(args.steps, ctx.wp);
    // The §1.10 outputSchema rows are {step_index,tool,input,target,action,valid?,errors?} plus the
    // top-level aggregate `valid` — all DECLARED in the catalog `batchPlanOutput` (and Contract 13
    // §1.10), so conforming clients can validate structuredContent against the derived JSON Schema.
    const structured = {
      plan: plan.plan,
      backups_required: plan.backups_required,
      valid: plan.valid,
    };
    const invalidCount = plan.plan.filter((row) => row.valid === false).length;
    return okResult(
      structured,
      `Planned ${plan.plan.length} step(s); ${plan.backups_required.length} backup target(s) required` +
        (invalidCount > 0
          ? `; ${invalidCount} step(s) INVALID — apply will fail until they are fixed`
          : '') +
        '.',
    );
  });
}

/* ───────────────────────────── elementor.batch.apply (§1.10 / §13) ────────────────────────── */

/**
 * Reconstruct a {@link BatchPlan} from the `plan` rows the SDK delivered as `z.array(z.unknown())`. The
 * rows are the `batch.plan` output shape (`{step_index,tool,input,target,action}` — `input` carries
 * each step's body through the round trip); a REST-shaped `{route,body}` row is also tolerated.
 * `backups_required` is re-derived from the rows' targets so the engine has the up-front backup set
 * even when the caller forwarded only the plan (the engine merges the PHP route's authoritative
 * requirements on apply).
 */
function reconstructPlan(rows: unknown[]): BatchPlan {
  const plan: PlanRow[] = [];
  const backups = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i];
    const row = isPlanRow(raw) ? raw : null;
    if (row === null) {
      // A non-conforming row still occupies its step slot; keep the index stable so per-step results
      // line up with the caller's plan ordering.
      plan.push({ step_index: i, tool: '', input: {}, target: null, action: '' });
      continue;
    }
    const stepIndex = typeof row.step_index === 'number' ? row.step_index : i;
    const tool = typeof row.tool === 'string' && row.tool !== '' ? row.tool : (row.route ?? '');
    const input = isRecord(row.input) ? row.input : isRecord(row.body) ? row.body : {};
    // Re-derive target/action from {tool,input} when the row omits them (e.g. a REST-shaped row).
    const derived = derivePlanRow(stepIndex, { tool, input });
    const normalized: PlanRow = {
      step_index: stepIndex,
      tool,
      input,
      target: row.target === null || typeof row.target === 'string' ? row.target : derived.target,
      action: typeof row.action === 'string' && row.action !== '' ? row.action : derived.action,
    };
    plan.push(normalized);
    if (normalized.target !== null) {
      backups.add(`doc:${normalized.target}`);
    }
  }
  // Validity is re-established server-side: PHP /batch/apply re-validates every step (§0.9).
  return { plan, backups_required: [...backups], valid: true };
}

/** Whether a value is a plain string-keyed record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural guard for a `batch.plan` output row (or REST `{route,body}` step) carried into apply. */
function isPlanRow(value: unknown): value is {
  step_index?: number;
  tool?: string;
  route?: string;
  input?: unknown;
  body?: unknown;
  target?: string | null;
  action?: string;
} {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (typeof value['tool'] === 'string' && value['tool'] !== '') ||
    (typeof value['route'] === 'string' && value['route'] !== '')
  );
}

/**
 * Whether any step result reflects a PHP idempotent-replay no-op (Contract 12 §3.2). A step's raw
 * `output` (preserved on the FALLBACK TS step path) may carry the plugin's `idempotent_replay` flag;
 * {@link isReplay} reads it. The tool surfaces this INFORMATIONALLY in the result text — the write
 * already landed, so the agent should stop retrying (§5 rule 4). Exported for direct unit testing.
 */
export function anyReplay(results: StepResult[]): boolean {
  return results.some((r) => isReplay(r.output as Parameters<typeof isReplay>[0]));
}

/**
 * `elementor.batch.apply` handler (13-tool-catalog.md §1.10; 10-rest-api.md §13). DESTRUCTIVE (class
 * `D`): when `confirm!=true`, elicits a confirm round-trip via `ctx.elicit`; a decline ⇒ a clean
 * non-error {@link declinedResult} (Contract 12 §5 rule 5). On confirm, drives the WP-T03
 * {@link applyBatch} engine (up-front backups + reverse-order compensation) over the reconstructed plan
 * and returns the per-step `{step_index,ok,output,error,compensated}` results. `op_id` makes the apply
 * SAFELY RETRYABLE; a replayed op surfaces `IDEMPOTENT_REPLAY` informationally in the result text.
 *
 * The engine requires a `RestExecutor` (PREFERRED — PHP `/batch/apply`) or a `StepExecutor` (FALLBACK).
 * This handler supplies the REST executor: it forwards the plan to the PHP route (Contract 10 §13), the
 * one path that records kit + per-doc backups and compensates server-side in a single transaction. Each
 * plan row is translated tool name → §13 route id (engine `toolToRestStep`) with its carried `input` as
 * the step body (the route stays authoritative).
 */
export async function batchApplyHandler(
  args: BatchApplyArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  // 1) Destructive gate (Contract 13 §1.10 "Elicitation confirm required"; §0.3). When `confirm` is
  //    already true the caller pre-confirmed; otherwise round-trip the user. A decline is NOT an error.
  let confirmed = args.confirm;
  if (!confirmed) {
    const outcome = await ctx.elicit(
      `Apply this ${args.plan.length}-step batch? Documents are backed up up front and rolled back on partial failure.`,
      confirmSchema,
    );
    if (!outcome.confirmed || outcome.values?.['confirm'] === false) {
      // M-b: decline carries a schema-valid structured payload (no steps ran).
      return declinedResult('Batch apply cancelled by the user; no changes were made.', {
        results: [],
      }) as CallToolResult;
    }
    confirmed = true;
  }

  return run(async () => {
    const plan = reconstructPlan(args.plan);
    const results = await applyBatch(plan, ctx.wp, {
      confirm: confirmed,
      ...(args.op_id !== undefined ? { op_id: args.op_id } : {}),
      // PREFERRED path: PHP /batch/apply does backups + compensation server-side in one transaction.
      // Each plan row is translated tool→§13 route id with its carried input as the body (the PHP
      // route stays authoritative — an untranslatable tool is rejected server-side per step).
      rest: { toRestStep: (step: BatchStep) => toolToRestStep(step) },
    });

    const okCount = results.results.filter((r) => r.ok).length;
    const compensatedCount = results.results.filter((r) => r.compensated).length;
    const replayed = anyReplay(results.results);
    const structured = { results: results.results };
    const text =
      `Applied ${okCount}/${results.results.length} step(s)` +
      (compensatedCount > 0 ? `; ${compensatedCount} rolled back (compensated)` : '') +
      (replayed ? '; IDEMPOTENT_REPLAY (the op already landed — stop retrying)' : '') +
      '.';
    return okResult(structured, text);
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ───────────────── */

/**
 * Attach every ops/batch handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Detailed
 * Requirements 1; §Acceptance). The registry stores handlers under its loose `(args) => unknown` type;
 * the runtime invokes them as `(args, ctx)` (server core casts to the WP-T01 {@link ToolHandler}
 * signature), so each handler is registered through that signature here.
 */
export function attachOpsHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [OPS_LOG]: (args, ctx) => opsLogHandler(args as OpsLogArgs, ctx),
    [BATCH_PLAN]: (args, ctx) => batchPlanHandler(args as BatchPlanArgs, ctx),
    [BATCH_APPLY]: (args, ctx) => batchApplyHandler(args as BatchApplyArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
