/**
 * WP-T11 — ops / batch handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + `ctx.elicit` + a real WP-F04
 * {@link ToolRegistry}. The tests assert:
 *  - all three §1.10 handlers attach by EXACT catalog name; `batch.apply` is class `D` + destructiveHint,
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`,
 *  - `ops.log` paginates (forwards `post_id`/`user`/`limit`/`cursor`/`fields`) + projects the RAW row
 *    (`post_id` nullable, `ts` → string), and surfaces a CAP_MANAGE `CAPABILITY_MISSING` cleanly,
 *  - `batch.plan` returns the engine plan + backups and NEVER persists (no apply/backup/rollback calls),
 *  - `batch.apply` elicits when `confirm!=true` (decline ⇒ clean non-error, accept ⇒ applies), shapes
 *    the per-step results with `compensated`, and surfaces IDEMPOTENT_REPLAY in the result text.
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type BatchApplyResponse,
  type OpsLogResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import type { ElicitOutcome } from '../runtime/elicit.js';
import { WpClientError } from '../wp/types.js';

import {
  anyReplay,
  attachOpsHandlers,
  batchApplyHandler,
  batchPlanHandler,
  opsLogHandler,
  OPS_TOOL_NAMES,
  OPS_LOG,
  BATCH_PLAN,
  BATCH_APPLY,
} from './ops.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The partial `ctx.wp` we mock — only the routes the ops/batch handlers (+ engine) touch. */
interface MockWp {
  opsLog: ReturnType<typeof vi.fn>;
  batchPlan: ReturnType<typeof vi.fn>;
  batchApply: ReturnType<typeof vi.fn>;
  backupDocument: ReturnType<typeof vi.fn>;
  rollbackDocument: ReturnType<typeof vi.fn>;
}

function makeWp(): MockWp {
  return {
    opsLog: vi.fn(),
    // The engine prefers the PHP /batch/plan route; default it to "route unavailable" so planBatch
    // falls back to its pure local derivation (advisory) unless a test overrides it.
    batchPlan: vi.fn(() => Promise.reject(new Error('route unavailable'))),
    batchApply: vi.fn(),
    backupDocument: vi.fn(),
    rollbackDocument: vi.fn(),
  };
}

/** Capturing elicit stub: records calls + returns a scripted {@link ElicitOutcome}. */
function makeElicit(outcome: ElicitOutcome): ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve(outcome));
}

/** Build a minimal {@link ToolContext} carrying the mock `wp`, elicit, and a real registry. */
function makeCtx(
  wp: MockWp,
  registry: ToolRegistry,
  elicit: ReturnType<typeof vi.fn> = makeElicit({ confirmed: false }),
): ToolContext {
  return {
    wp,
    registry,
    surface: {} as ToolContext['surface'],
    capabilities: {} as ToolContext['capabilities'],
    elicit: elicit as unknown as ToolContext['elicit'],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolContext;
}

/** The WP-F04 descriptor `outputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function outputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).outputSchema);
}

/** Extract `structuredContent` from a tool result. */
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** Extract the first text content block's text (the SDK content is a union; narrow to text). */
function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type?: string; text?: string }>;
  const first = blocks.find((b) => b.type === 'text');
  return first?.text ?? '';
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachOpsHandlers', () => {
  it('attaches a handler for every §1.10 ops/batch tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachOpsHandlers(registry);
    for (const name of OPS_TOOL_NAMES) {
      expect(registry.has(name)).toBe(true);
      expect(registry.hasHandler(name)).toBe(true);
    }
  });

  it('owns exactly the three §1.10 names', () => {
    expect([...OPS_TOOL_NAMES].sort()).toEqual([OPS_LOG, BATCH_PLAN, BATCH_APPLY].sort());
  });

  it('exposes batch.apply as class D + destructiveHint, batch.plan/ops.log as class R', () => {
    const registry = createToolRegistry();
    const apply = registry.getDescriptor(BATCH_APPLY);
    expect(apply.class).toBe('D');
    expect((apply.annotations as { destructiveHint?: boolean }).destructiveHint).toBe(true);
    expect(registry.getDescriptor(BATCH_PLAN).class).toBe('R');
    expect(
      (registry.getDescriptor(BATCH_PLAN).annotations as { readOnlyHint?: boolean }).readOnlyHint,
    ).toBe(true);
    expect(registry.getDescriptor(OPS_LOG).class).toBe('R');
  });
});

/* ───────────────────────────── elementor.ops.log (§1.10 / §11) ────────────────────────────── */

describe('opsLogHandler', () => {
  it('proxies GET /ops/log, forwards filters + pagination, projects the RAW row', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: OpsLogResponse = {
      items: [
        {
          op_id: 'op-1',
          post_id: 42,
          user: 'mcp-agent',
          tool: 'documents/save',
          before_hash: 'aaa',
          after_hash: 'bbb',
          result: 'ok',
          ts: 1700000000,
        },
      ],
      next_cursor: 'next-50',
      total: 210,
    };
    wp.opsLog.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await opsLogHandler(
      { post_id: 42, user: 'mcp-agent', limit: 50, cursor: 'c0', fields: ['op_id', 'ts'] },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, OPS_LOG).parse(out);

    expect(wp.opsLog).toHaveBeenCalledWith({
      post_id: 42,
      user: 'mcp-agent',
      limit: 50,
      cursor: 'c0',
      fields: ['op_id', 'ts'],
    });
    const items = out['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    // `ts` projected to STRING (schema), `post_id` carried through (positive ⇒ kept).
    expect(items[0]?.['ts']).toBe('1700000000');
    expect(items[0]?.['post_id']).toBe(42);
    expect(out['next_cursor']).toBe('next-50');
    expect(out['total']).toBe(210);
  });

  it('maps a global/kit op (post_id 0) to a null post_id and falls back total → items.length', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: OpsLogResponse = {
      items: [
        {
          op_id: 'op-kit',
          post_id: 0,
          user: 'mcp-agent',
          tool: 'design/classes',
          before_hash: 'h0',
          after_hash: 'h1',
          result: 'ok',
          ts: 1700000999,
        },
      ],
      next_cursor: null,
      total: null,
    };
    wp.opsLog.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await opsLogHandler({ limit: 50 }, ctx);
    const out = structured(result);
    outputValidator(registry, OPS_LOG).parse(out);

    const items = out['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['post_id']).toBeNull();
    expect(out['total']).toBe(1);
    // Only the supplied `limit` is forwarded (no undefined keys spilled into the query).
    expect(wp.opsLog).toHaveBeenCalledWith({ limit: 50 });
  });

  it('surfaces a CAP_MANAGE CAPABILITY_MISSING cleanly as an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.opsLog.mockRejectedValue(
      new WpClientError(makeErrorPayload(ErrorCodes.CAPABILITY_MISSING, 'manage_options required')),
    );
    const ctx = makeCtx(wp, registry);

    const result = await opsLogHandler({ limit: 50 }, ctx);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code?: string }).code).toBe(
      ErrorCodes.CAPABILITY_MISSING,
    );
  });
});

/* ───────────────────────────── elementor.batch.plan (§1.10 / §13) ─────────────────────────── */

describe('batchPlanHandler', () => {
  it('returns the engine plan + backups and NEVER persists (no apply/backup/rollback)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await batchPlanHandler(
      {
        steps: [
          { tool: 'elementor.page.build', input: { post_id: 42 } },
          { tool: 'elementor.design.classes.upsert', input: {} },
        ],
      },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, BATCH_PLAN).parse(out);

    const plan = out['plan'] as Array<Record<string, unknown>>;
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      step_index: 0,
      tool: 'elementor.page.build',
      target: '42',
      action: 'build',
    });
    // doc:42 + kit (design.* touches the kit) required as backups.
    expect(out['backups_required']).toEqual(expect.arrayContaining(['doc:42', 'kit']));

    // No-persist guarantee.
    expect(wp.batchApply).not.toHaveBeenCalled();
    expect(wp.backupDocument).not.toHaveBeenCalled();
    expect(wp.rollbackDocument).not.toHaveBeenCalled();
  });

  it('carries each step input on its plan row and surfaces the validity verdict', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await batchPlanHandler(
      {
        steps: [
          { tool: 'elementor.page.update_settings', input: { post_id: 42, settings: { x: 1 } } },
          // No §13 batch-route translation exists for widget.insert → invalid up front.
          { tool: 'elementor.widget.insert', input: { post_id: 42 } },
        ],
      },
      ctx,
    );
    const out = structured(result);
    // input/valid/errors + top-level valid are DECLARED in batchPlanOutput (Contract 13 §1.10).
    outputValidator(registry, BATCH_PLAN).parse(out);

    const plan = out['plan'] as Array<Record<string, unknown>>;
    // The plan→apply round trip carries the original input (apply rebuilds the REST bodies from it).
    expect(plan[0]?.['input']).toEqual({ post_id: 42, settings: { x: 1 } });
    expect(plan[1]).toMatchObject({ valid: false });
    expect(out['valid']).toBe(false);
    expect(textOf(result)).toMatch(/1 step\(s\) INVALID/);
  });

  it('pre-marks the broken Pro create routes invalid even when PHP /batch/plan accepts them', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // pro_validate finds no validate() method on the Pro create builders and wrongly accepts the
    // step, but apply_pro passes a plain array to a WP_REST_Request consumer → guaranteed apply
    // failure. The handler must NOT surface that misleading VALID verdict.
    wp.batchPlan.mockResolvedValue({
      plan: [{ step: 0, route: 'pro/theme', valid: true }],
      valid: true,
      backups_required: [],
    });
    const ctx = makeCtx(wp, registry);

    const result = await batchPlanHandler(
      { steps: [{ tool: 'elementor.pro.theme.create', input: { type: 'header' } }] },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, BATCH_PLAN).parse(out);

    const plan = out['plan'] as Array<Record<string, unknown>>;
    expect(plan[0]).toMatchObject({ valid: false });
    expect(out['valid']).toBe(false);
    expect(textOf(result)).toMatch(/1 step\(s\) INVALID/);
  });
});

/* ───────────────────────────── elementor.batch.apply (§1.10 / §13) ────────────────────────── */

describe('batchApplyHandler', () => {
  const plan = [
    { step_index: 0, tool: 'documents/save', target: '42', action: 'save' },
    { step_index: 1, tool: 'pro/theme', target: '7', action: 'theme' },
  ];

  it('elicits when confirm!=true and a DECLINE returns a clean non-error result (no apply)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const elicit = makeElicit({ confirmed: false });
    const ctx = makeCtx(wp, registry, elicit);

    const result = await batchApplyHandler({ plan, confirm: false }, ctx);

    expect(elicit).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    expect(wp.batchApply).not.toHaveBeenCalled();
    expect(textOf(result)).toMatch(/cancelled/i);
  });

  it('on ACCEPT applies via the PHP /batch/apply route and shapes per-step results', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: BatchApplyResponse = {
      results: [
        { step: 0, ok: true, post_id: 42 },
        { step: 1, ok: false, error: { code: 'E_ATOMIC_VALIDATION', message: 'bad prop' } },
      ],
      compensated: true,
    };
    wp.batchApply.mockResolvedValue(resp);
    const elicit = makeElicit({ confirmed: true, values: { confirm: true } });
    const ctx = makeCtx(wp, registry, elicit);

    const result = await batchApplyHandler({ plan, confirm: false }, ctx);
    const out = structured(result);
    outputValidator(registry, BATCH_APPLY).parse(out);

    expect(elicit).toHaveBeenCalledTimes(1);
    expect(wp.batchApply).toHaveBeenCalledTimes(1);
    const results = out['results'] as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ step_index: 0, ok: true });
    expect(results[1]).toMatchObject({ step_index: 1, ok: false, compensated: true });
    expect(results[1]?.['error']).toMatch(/bad prop/);
  });

  it('skips elicitation when confirm:true is supplied up front', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.batchApply.mockResolvedValue({
      results: [
        { step: 0, ok: true, post_id: 42 },
        { step: 1, ok: true, post_id: 7 },
      ],
      compensated: false,
    } satisfies BatchApplyResponse);
    const elicit = makeElicit({ confirmed: false });
    const ctx = makeCtx(wp, registry, elicit);

    const result = await batchApplyHandler({ plan, confirm: true }, ctx);
    outputValidator(registry, BATCH_APPLY).parse(structured(result));

    expect(elicit).not.toHaveBeenCalled();
    expect(wp.batchApply).toHaveBeenCalledTimes(1);
  });

  it('translates tool names to §13 route ids and forwards each carried input as the body', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.batchApply.mockResolvedValue({
      results: [
        { step: 0, ok: true, post_id: 5 },
        { step: 1, ok: true, post_id: 9 },
        { step: 2, ok: true, post_id: 11 },
      ],
      compensated: false,
    } satisfies BatchApplyResponse);
    const ctx = makeCtx(wp, registry, makeElicit({ confirmed: true, values: { confirm: true } }));

    await batchApplyHandler(
      {
        plan: [
          {
            step_index: 0,
            tool: 'elementor.page.update_settings',
            input: { post_id: 5, settings: { hello: 1 } },
            target: '5',
            action: 'update_settings',
          },
          // A REST-shaped {route,body} row is tolerated too.
          { route: 'documents/save', body: { post_id: 9, elements: [] } },
          // The create path injects prime_css:true (CSS-prime invariant — the PHP create path
          // defaults it FALSE while the page tools default TRUE).
          {
            step_index: 2,
            tool: 'elementor.page.build',
            input: { title: 'Home', elements: [] },
            target: null,
            action: 'build',
          },
        ],
        confirm: true,
      },
      ctx,
    );

    expect(wp.batchApply).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: [
          { route: 'documents/settings', body: { post_id: 5, settings: { hello: 1 } } },
          { route: 'documents/save', body: { post_id: 9, elements: [] } },
          { route: 'documents/create', body: { title: 'Home', elements: [], prime_css: true } },
        ],
      }),
    );
  });

  it('threads op_id through to the PHP /batch/apply route body (idempotent retry, §0.8)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.batchApply.mockResolvedValue({
      results: [{ step: 0, ok: true, post_id: 42 }],
      compensated: false,
    } satisfies BatchApplyResponse);
    const ctx = makeCtx(wp, registry, makeElicit({ confirmed: true, values: { confirm: true } }));

    await batchApplyHandler(
      {
        plan: [{ step_index: 0, tool: 'documents/save', target: '42', action: 'save' }],
        op_id: 'op-fixed',
        confirm: true,
      },
      ctx,
    );
    // The engine threads op_id through to the route body so a retried apply is recognized as a replay.
    expect(wp.batchApply).toHaveBeenCalledWith(expect.objectContaining({ op_id: 'op-fixed' }));
  });

  it('does NOT claim a replay on a normal (non-replayed) apply', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.batchApply.mockResolvedValue({
      results: [{ step: 0, ok: true, post_id: 42 }],
      compensated: false,
    } satisfies BatchApplyResponse);
    const ctx = makeCtx(wp, registry, makeElicit({ confirmed: true, values: { confirm: true } }));

    const result = await batchApplyHandler(
      {
        plan: [{ step_index: 0, tool: 'documents/save', target: '42', action: 'save' }],
        confirm: true,
      },
      ctx,
    );
    expect(textOf(result)).toMatch(/Applied 1\/1/);
    expect(textOf(result)).not.toMatch(/IDEMPOTENT_REPLAY/);
  });
});

/* ───────────────────────────── anyReplay (IDEMPOTENT_REPLAY surfacing, §3.2) ───────────────── */

describe('anyReplay', () => {
  it('is true iff some step output carries the PHP idempotent_replay flag', () => {
    expect(
      anyReplay([
        {
          step_index: 0,
          ok: true,
          output: { idempotent_replay: true },
          error: null,
          compensated: false,
        },
      ]),
    ).toBe(true);
    // A post_id output (the REST path) or a plain output ⇒ not a replay.
    expect(
      anyReplay([{ step_index: 0, ok: true, output: 42, error: null, compensated: false }]),
    ).toBe(false);
    expect(anyReplay([])).toBe(false);
  });
});
