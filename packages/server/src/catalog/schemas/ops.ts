/**
 * WP-F04 — ops / observability tool schemas (13-tool-catalog.md §1.10).
 *
 * Covers: `elementor.ops.log`, `elementor.batch.plan`, `elementor.batch.apply`. ZodRawShape maps
 * (§0.1); `ops.log` spreads pagination (§0.6); `batch.apply` carries `confirm` (§0.3) + `op_id`
 * (§0.8).
 */

import { z } from 'zod';

import { fieldProjectedItem, paginationInputShape, paginatedOutput } from './shared.js';

/* ───────────────────────────── elementor.ops.log ────────────────────────────────────────── */

export const opsLogInput = {
  post_id: z.number().int().optional(),
  user: z.string().optional(),
  ...paginationInputShape,
} as const;

export const opsLogOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        // The PHP op-log table allows NULL op_id (`op_id varchar(64) DEFAULT NULL`) and writes
        // recorded without a caller-supplied op_id keep it null on the wire — the steady state on
        // real sites — so the item value is string-or-null (#0).
        op_id: z.string().nullable(),
        post_id: z.number().int().nullable(),
        user: z.string(),
        tool: z.string(),
        before_hash: z.string(),
        after_hash: z.string(),
        result: z.string(),
        ts: z.string(),
      }),
    ),
  ),
} as const;

/* ───────────────────────────── elementor.batch.plan ─────────────────────────────────────── */

export const batchPlanInput = {
  steps: z.array(
    z.object({
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
    }),
  ),
} as const;

export const batchPlanOutput = {
  plan: z.array(
    z.object({
      step_index: z.number().int(),
      tool: z.string(),
      // The step's ORIGINAL tool input, carried through the plan→apply round trip so apply can
      // rebuild each REST body. MUST be declared here: the SDK derives `additionalProperties:false`
      // JSON Schema from this shape and conforming clients validate structuredContent against it.
      input: z.record(z.string(), z.unknown()),
      target: z.string().nullable(),
      action: z.string(),
      // Per-step validity verdict — the AUTHORITATIVE PHP /batch/plan value when the route is
      // reachable, else the local translation pre-check. Absent ⇒ not validated.
      valid: z.boolean().optional(),
      // Taxonomy error items ({code,message,meta?}) for an invalid step.
      errors: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
  ),
  backups_required: z.array(z.string()),
  // Aggregate validity (AND of every step) — the PHP /batch/plan verdict when reachable.
  valid: z.boolean(),
} as const;

/* ───────────────────────────── elementor.batch.apply ────────────────────────────────────── */

export const batchApplyInput = {
  plan: z.array(z.unknown()),
  op_id: z.string().optional(),
  confirm: z.boolean().default(false),
} as const;

export const batchApplyOutput = {
  results: z.array(
    z.object({
      step_index: z.number().int(),
      ok: z.boolean(),
      output: z.unknown().nullable(),
      error: z.string().nullable(),
      compensated: z.boolean(),
    }),
  ),
} as const;
