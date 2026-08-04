/**
 * WP-T03 — batch plan/apply engine tests.
 *
 * Covers acceptance criteria:
 *   - `planBatch` derives `{step_index,tool,target,action}` per step + `backups_required[]` and NEVER
 *     persists (no save/apply/backup/rollback calls).
 *   - `applyBatch` (REST path) shapes the PHP `/batch/apply` per-step results.
 *   - `applyBatch` (TS path) records UP-FRONT backups, executes in order, and on partial failure
 *     compensates in REVERSE application order, marking `compensated`.
 *   - compensation-failure is reported on the offending step (INTERNAL_ERROR + meta.phase).
 *
 * `WpRoutes` is mocked: only the routes the engine touches are implemented; the rest are stubbed.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WpRoutes } from '../runtime/context.js';
import type {
  BackupDocumentResponse,
  BatchApplyResponse,
  BatchPlanResponse,
  RollbackDocumentResponse,
} from '../wp/types.js';

import {
  applyBatch,
  compensationFailurePayload,
  derivePlanRow,
  hasRouteTranslation,
  planBatch,
  toolToRestStep,
  type BatchPlan,
  type BatchStep,
  type RestExecutor,
  type StepExecutor,
} from './batch.js';
import { OP_ID_PATTERN } from './idempotency.js';

/* ─────────────────────────── mock WpRoutes builder ──────────────────────────────────────────── */

interface MockOverrides {
  batchPlan?: (body: unknown) => Promise<BatchPlanResponse>;
  batchApply?: (body: unknown) => Promise<BatchApplyResponse>;
  backupDocument?: (id: number, body?: unknown) => Promise<BackupDocumentResponse>;
  rollbackDocument?: (id: number, body: unknown) => Promise<RollbackDocumentResponse>;
}

function mockWp(overrides: MockOverrides = {}): {
  wp: WpRoutes;
  spies: {
    batchPlan: ReturnType<typeof vi.fn>;
    batchApply: ReturnType<typeof vi.fn>;
    backupDocument: ReturnType<typeof vi.fn>;
    rollbackDocument: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
} {
  const save = vi.fn();
  const batchPlan = vi.fn(
    overrides.batchPlan ??
      ((): Promise<BatchPlanResponse> => Promise.reject(new Error('route unavailable'))),
  );
  const batchApply = vi.fn(
    overrides.batchApply ??
      ((): Promise<BatchApplyResponse> => Promise.reject(new Error('route unavailable'))),
  );
  let backupSeq = 1000;
  const backupDocument = vi.fn(
    overrides.backupDocument ??
      ((id: number): Promise<BackupDocumentResponse> =>
        Promise.resolve({
          backup_handle: {
            meta_key: `_emcp_bak_${id}_${backupSeq++}`,
            revision_id: backupSeq,
            ts: 1700000000,
            label: 'pre-batch',
          },
        })),
  );
  const rollbackDocument = vi.fn(
    overrides.rollbackDocument ??
      ((id: number): Promise<RollbackDocumentResponse> =>
        Promise.resolve({
          id,
          restored_from: 'meta',
          base_hash: 'x'.repeat(32),
          css_primed: true,
        })),
  );

  // Build a target that throws for any route the engine should NOT touch, except the implemented ones.
  const wp = {
    batchPlan,
    batchApply,
    backupDocument,
    rollbackDocument,
    saveDocument: save,
  } as unknown as WpRoutes;

  return { wp, spies: { batchPlan, batchApply, backupDocument, rollbackDocument, save } };
}

/* ─────────────────────────── derivePlanRow ──────────────────────────────────────────────────── */

describe('derivePlanRow', () => {
  it('derives action from the trailing tool-name segment and target from post_id', () => {
    const row = derivePlanRow(0, {
      tool: 'elementor.page.update_settings',
      input: { post_id: 42 },
    });
    expect(row).toEqual({
      step_index: 0,
      tool: 'elementor.page.update_settings',
      input: { post_id: 42 },
      target: '42',
      action: 'update_settings',
    });
  });

  it('target is null for a create step (no id key)', () => {
    const row = derivePlanRow(1, { tool: 'elementor.documents.create', input: { title: 'New' } });
    expect(row.target).toBeNull();
    expect(row.action).toBe('create');
  });

  it('reads template_id / term_id targets', () => {
    expect(derivePlanRow(0, { tool: 't', input: { template_id: 7 } }).target).toBe('7');
    expect(derivePlanRow(0, { tool: 't', input: { term_id: 9 } }).target).toBe('9');
  });
});

/* ─────────────────────────── toolToRestStep (tool → §13 route translation) ──────────────────── */

describe('toolToRestStep', () => {
  it('translates MCP tool names to the PHP /batch route ids with the input as the body', () => {
    expect(
      toolToRestStep({ tool: 'elementor.page.build', input: { title: 'Home', elements: [] } }),
    ).toEqual({
      route: 'documents/create',
      body: { title: 'Home', elements: [], prime_css: true },
    });
    expect(
      toolToRestStep({ tool: 'elementor.page.replace_tree', input: { post_id: 42, elements: [] } }),
    ).toEqual({ route: 'documents/replace-tree', body: { post_id: 42, elements: [] } });
    expect(
      toolToRestStep({ tool: 'elementor.page.update_settings', input: { post_id: 42 } }),
    ).toEqual({ route: 'documents/settings', body: { post_id: 42 } });
    expect(
      toolToRestStep({ tool: 'elementor.pro.theme.create', input: { type: 'header' } }),
    ).toEqual({ route: 'pro/theme', body: { type: 'header' } });
    expect(toolToRestStep({ tool: 'elementor.pro.loop.create_item', input: {} }).route).toBe(
      'pro/loop/item',
    );
  });

  it('passes an already REST-shaped step (tool IS a §13 route id) through verbatim', () => {
    expect(toolToRestStep({ tool: 'documents/save', input: { post_id: 7 } })).toEqual({
      route: 'documents/save',
      body: { post_id: 7 },
    });
    expect(toolToRestStep({ tool: 'design/classes', input: { changes: {} } }).route).toBe(
      'design/classes',
    );
  });

  it('forwards an unknown tool verbatim (PHP rejects it authoritatively)', () => {
    expect(toolToRestStep({ tool: 'elementor.widget.insert', input: {} }).route).toBe(
      'elementor.widget.insert',
    );
  });

  it('injects prime_css:true on the documents/create path ONLY when the body omits it (invariant 3)', () => {
    // The PHP create path defaults prime_css FALSE (doc_args($body,false)) while the page tools
    // default TRUE — the translation mirrors the tool default so a batch page.build never lands
    // unprimed (unstyled render).
    expect(toolToRestStep({ tool: 'elementor.page.create', input: { title: 'T' } }).body).toEqual({
      title: 'T',
      prime_css: true,
    });
    // An explicit caller value always wins.
    expect(
      toolToRestStep({ tool: 'elementor.page.build', input: { title: 'T', prime_css: false } })
        .body,
    ).toEqual({ title: 'T', prime_css: false });
    // Non-create document routes default prime_css TRUE server-side — no injection there.
    expect(
      toolToRestStep({ tool: 'elementor.page.replace_tree', input: { post_id: 1 } }).body,
    ).toEqual({ post_id: 1 });
    // A literal REST-shaped documents/create step keeps the §13 REST contract semantics verbatim.
    expect(toolToRestStep({ tool: 'documents/create', input: { title: 'T' } }).body).toEqual({
      title: 'T',
    });
  });

  it('hasRouteTranslation accepts mapped tools, route ids and pro/* — rejects the rest', () => {
    expect(hasRouteTranslation('elementor.page.build')).toBe(true);
    expect(hasRouteTranslation('documents/replace-tree')).toBe(true);
    expect(hasRouteTranslation('pro/form/build')).toBe(true);
    expect(hasRouteTranslation('elementor.widget.insert')).toBe(false);
    expect(hasRouteTranslation('elementor.design.classes.upsert')).toBe(false);
  });
});

/* ─────────────────────────── planBatch (NO persist) ─────────────────────────────────────────── */

describe('planBatch', () => {
  const steps: BatchStep[] = [
    { tool: 'elementor.page.build', input: { post_id: 42 } },
    { tool: 'elementor.design.classes.put', input: {} },
    { tool: 'elementor.documents.create', input: { title: 'About' } },
  ];

  it('produces a plan row per step in order', async () => {
    const { wp } = mockWp();
    const plan = await planBatch(steps, wp);
    expect(plan.plan.map((r) => r.step_index)).toEqual([0, 1, 2]);
    expect(plan.plan.map((r) => r.tool)).toEqual(steps.map((s) => s.tool));
  });

  it('accumulates doc + kit backup requirements locally when the route is unavailable', async () => {
    const { wp, spies } = mockWp(); // batchPlan rejects (route unavailable)
    const plan = await planBatch(steps, wp);
    expect(plan.backups_required).toContain('doc:42');
    expect(plan.backups_required).toContain('kit'); // design.classes step touches the kit
    expect(spies.batchPlan).toHaveBeenCalledTimes(1); // it TRIED the route
  });

  it('NEVER persists (no save / apply / backup / rollback)', async () => {
    const { wp, spies } = mockWp();
    await planBatch(steps, wp);
    expect(spies.batchApply).not.toHaveBeenCalled();
    expect(spies.backupDocument).not.toHaveBeenCalled();
    expect(spies.rollbackDocument).not.toHaveBeenCalled();
    expect(spies.save).not.toHaveBeenCalled();
  });

  it('merges the PHP /batch/plan backups_required when the route IS available', async () => {
    const { wp } = mockWp({
      batchPlan: (): Promise<BatchPlanResponse> =>
        Promise.resolve({
          plan: [],
          valid: true,
          backups_required: [{ post_id: 99 }, { kit: true }],
        }),
    });
    const plan = await planBatch([{ tool: 'x.y', input: { post_id: 1 } }], wp);
    expect(plan.backups_required).toContain('doc:1'); // local
    expect(plan.backups_required).toContain('doc:99'); // route
    expect(plan.backups_required).toContain('kit'); // route
  });

  it('sends the PHP /batch/plan route TRANSLATED {route,body} steps (not MCP tool names)', async () => {
    const { wp, spies } = mockWp({
      batchPlan: (): Promise<BatchPlanResponse> =>
        Promise.resolve({ plan: [], valid: true, backups_required: [] }),
    });
    await planBatch([{ tool: 'elementor.page.build', input: { title: 'Home', elements: [] } }], wp);
    expect(spies.batchPlan).toHaveBeenCalledWith({
      steps: [
        // prime_css:true injected on the create path (CSS-prime invariant, tool default mirrored).
        { route: 'documents/create', body: { title: 'Home', elements: [], prime_css: true } },
      ],
    });
  });

  it('carries each step input on its plan row (the apply round trip needs the bodies)', async () => {
    const { wp } = mockWp();
    const plan = await planBatch(
      [{ tool: 'elementor.page.update_settings', input: { post_id: 42, settings: { a: 1 } } }],
      wp,
    );
    expect(plan.plan[0]?.input).toEqual({ post_id: 42, settings: { a: 1 } });
  });

  it('surfaces the AUTHORITATIVE PHP per-step verdict + aggregate valid', async () => {
    const { wp } = mockWp({
      batchPlan: (): Promise<BatchPlanResponse> =>
        Promise.resolve({
          plan: [
            { step: 0, route: 'documents/save', valid: true },
            {
              step: 1,
              route: 'documents/save',
              valid: false,
              errors: [{ code: 'VALIDATION_FAILED', message: 'bad tree' }],
            } as BatchPlanResponse['plan'][number],
          ],
          valid: false,
          backups_required: [],
        }),
    });
    const plan = await planBatch(
      [
        { tool: 'documents/save', input: { post_id: 1 } },
        { tool: 'documents/save', input: { post_id: 2 } },
      ],
      wp,
    );
    expect(plan.valid).toBe(false);
    expect(plan.plan[0]?.valid).toBe(true);
    expect(plan.plan[1]?.valid).toBe(false);
    expect(plan.plan[1]?.errors?.[0]).toMatchObject({ message: 'bad tree' });
  });

  it('marks untranslatable tools invalid up front when the route is unreachable', async () => {
    const { wp } = mockWp(); // batchPlan rejects (route unavailable)
    const plan = await planBatch(
      [
        { tool: 'elementor.page.build', input: { title: 'Home' } },
        { tool: 'elementor.widget.insert', input: { post_id: 1 } },
      ],
      wp,
    );
    expect(plan.valid).toBe(false);
    expect(plan.plan[0]?.valid).toBeUndefined(); // translatable, just not validated
    expect(plan.plan[1]?.valid).toBe(false);
    expect(String(plan.plan[1]?.errors?.[0]?.['message'])).toMatch(/No \/batch route translation/);
  });

  it('hard-marks the broken Pro create routes invalid even when PHP /batch/plan accepts them', async () => {
    // The PHP pre-check (pro_validate) finds no validate() method and returns VALID for pro/theme /
    // pro/popup / pro/loop/item, but apply_pro passes a plain array to a WP_REST_Request consumer and
    // the step ALWAYS fails at apply — the local broken-route mark must survive the route merge.
    const { wp } = mockWp({
      batchPlan: (): Promise<BatchPlanResponse> =>
        Promise.resolve({
          plan: [
            { step: 0, route: 'pro/theme', valid: true },
            { step: 1, route: 'pro/popup', valid: true },
          ],
          valid: true,
          backups_required: [],
        }),
    });
    const plan = await planBatch(
      [
        { tool: 'elementor.pro.theme.create', input: { type: 'header' } },
        // A REST-shaped step naming the broken route directly is caught too.
        { tool: 'pro/popup', input: { title: 'Promo' } },
      ],
      wp,
    );
    expect(plan.valid).toBe(false);
    expect(plan.plan[0]?.valid).toBe(false);
    expect(plan.plan[1]?.valid).toBe(false);
    expect(String(plan.plan[0]?.errors?.[0]?.['message'])).toMatch(/WP_REST_Request/);
    expect(String(plan.plan[1]?.errors?.[0]?.['message'])).toMatch(/granular elementor\.pro\./);
  });

  it('pro/form/build is NOT broken (array-body builder) — no hard-invalid mark', async () => {
    const { wp } = mockWp(); // route unavailable → local verdict only
    const plan = await planBatch(
      [{ tool: 'elementor.pro.form.build', input: { post_id: 1, fields: [] } }],
      wp,
    );
    expect(plan.valid).toBe(true);
    expect(plan.plan[0]?.valid).toBeUndefined(); // translatable, just not validated
  });
});

/* ─────────────────────────── applyBatch — guards ────────────────────────────────────────────── */

describe('applyBatch guards', () => {
  const plan: BatchPlan = {
    plan: [derivePlanRow(0, { tool: 't', input: {} })],
    backups_required: [],
    valid: true,
  };

  it('throws if confirm is false (tool gates elicitation)', async () => {
    const { wp } = mockWp();
    await expect(
      applyBatch(plan, wp, { confirm: false, step: () => Promise.resolve(1) }),
    ).rejects.toThrow(/confirm/);
  });

  it('throws if neither rest nor step executor is supplied', async () => {
    const { wp } = mockWp();
    await expect(applyBatch(plan, wp, { confirm: true })).rejects.toThrow(/rest.*step|step.*rest/);
  });
});

/* ─────────────────────────── applyBatch — PHP route path ────────────────────────────────────── */

describe('applyBatch via REST route', () => {
  const restExec: RestExecutor = { toRestStep: (s) => ({ route: s.tool, body: s.input }) };

  it('forwards the plan and shapes per-step results', async () => {
    const { wp, spies } = mockWp({
      batchApply: (): Promise<BatchApplyResponse> =>
        Promise.resolve({
          compensated: false,
          results: [
            { step: 0, ok: true, post_id: 42 },
            { step: 1, ok: true, post_id: 43 },
          ],
        }),
    });
    const plan: BatchPlan = {
      plan: [
        derivePlanRow(0, { tool: 'a', input: { post_id: 42 } }),
        derivePlanRow(1, { tool: 'b', input: { post_id: 43 } }),
      ],
      backups_required: ['doc:42', 'doc:43'],
      valid: true,
    };
    const out = await applyBatch(plan, wp, { confirm: true, rest: restExec, op_id: 'op-fixed' });
    expect(spies.batchApply).toHaveBeenCalledTimes(1);
    // Each plan row's carried input arrives as the REST step body (NOT an empty object).
    expect(spies.batchApply).toHaveBeenCalledWith({
      plan: [
        { route: 'a', body: { post_id: 42 } },
        { route: 'b', body: { post_id: 43 } },
      ],
      op_id: 'op-fixed',
    });
    expect(out.results).toEqual([
      { step_index: 0, ok: true, output: 42, error: null, compensated: false },
      { step_index: 1, ok: true, output: 43, error: null, compensated: false },
    ]);
    // Engine does NOT also do TS-side backups when delegating to the route.
    expect(spies.backupDocument).not.toHaveBeenCalled();
  });

  it('reflects route compensation onto failed steps', async () => {
    const { wp } = mockWp({
      batchApply: (): Promise<BatchApplyResponse> =>
        Promise.resolve({
          compensated: true,
          results: [
            { step: 0, ok: true, post_id: 42 },
            { step: 1, ok: false, error: { code: 'E_ATOMIC_VALIDATION', message: 'bad tree' } },
          ],
        }),
    });
    const plan: BatchPlan = {
      plan: [
        derivePlanRow(0, { tool: 'a', input: { post_id: 42 } }),
        derivePlanRow(1, { tool: 'b', input: { post_id: 43 } }),
      ],
      backups_required: [],
      valid: true,
    };
    const out = await applyBatch(plan, wp, { confirm: true, rest: restExec });
    expect(out.results[1]).toEqual({
      step_index: 1,
      ok: false,
      output: null,
      error: 'bad tree',
      compensated: true,
    });
    expect(out.results[0]?.compensated).toBe(false); // succeeded step not marked
  });
});

/* ─────────────────────────── applyBatch — TS step path ──────────────────────────────────────── */

describe('applyBatch via TS step executor', () => {
  const plan: BatchPlan = {
    plan: [
      derivePlanRow(0, { tool: 'a', input: { post_id: 10 } }),
      derivePlanRow(1, { tool: 'b', input: { post_id: 20 } }),
    ],
    backups_required: ['doc:10', 'doc:20'],
    valid: true,
  };

  it('records up-front backups, executes in order, all ok', async () => {
    const { wp, spies } = mockWp();
    const order: number[] = [];
    const step: StepExecutor = (s, opId) => {
      expect(OP_ID_PATTERN.test(opId)).toBe(true);
      order.push(Number(s.input['post_id'] ?? -1));
      return Promise.resolve({ saved: s.tool });
    };
    const out = await applyBatch(plan, wp, { confirm: true, step, op_id: 'op-base' });

    // backups taken UP FRONT, before any step ran (both docs).
    expect(spies.backupDocument).toHaveBeenCalledTimes(2);
    expect(spies.rollbackDocument).not.toHaveBeenCalled();
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.results.map((r) => r.compensated)).toEqual([false, false]);
  });

  it('on a mid-batch failure, compensates the succeeded steps in REVERSE order', async () => {
    const rollbackOrder: number[] = [];
    const { wp, spies } = mockWp({
      rollbackDocument: (id: number): Promise<RollbackDocumentResponse> => {
        rollbackOrder.push(id);
        return Promise.resolve({
          id,
          restored_from: 'm',
          base_hash: 'a'.repeat(32),
          css_primed: true,
        });
      },
    });
    const plan3: BatchPlan = {
      plan: [
        derivePlanRow(0, { tool: 'a', input: { post_id: 10 } }),
        derivePlanRow(1, { tool: 'b', input: { post_id: 20 } }),
        derivePlanRow(2, { tool: 'c', input: { post_id: 30 } }),
      ],
      backups_required: ['doc:10', 'doc:20', 'doc:30'],
      valid: true,
    };
    const step: StepExecutor = (s) =>
      s.tool === 'c'
        ? Promise.reject(new Error('step c failed validation'))
        : Promise.resolve(s.tool);
    const out = await applyBatch(plan3, wp, { confirm: true, step });

    expect(out.results[0]).toMatchObject({ step_index: 0, ok: true });
    expect(out.results[1]).toMatchObject({ step_index: 1, ok: true });
    expect(out.results[2]).toMatchObject({ step_index: 2, ok: false });
    expect(out.results[2]?.error).toContain('step c failed');

    // Succeeded steps (10, 20) rolled back in reverse application order: 20 then 10.
    expect(rollbackOrder).toEqual([20, 10]);
    expect(out.results[0]?.compensated).toBe(true);
    expect(out.results[1]?.compensated).toBe(true);
    // The FAILED step itself never landed → not compensated.
    expect(out.results[2]?.compensated).toBe(false);
    expect(spies.backupDocument).toHaveBeenCalledTimes(3);
  });

  it('skips steps after the first failure', async () => {
    const { wp } = mockWp();
    const ran: string[] = [];
    const step: StepExecutor = (s) => {
      ran.push(s.tool);
      return s.tool === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve(s.tool);
    };
    const out = await applyBatch(plan, wp, { confirm: true, step });
    expect(ran).toEqual(['a']); // 'b' never executed
    expect(out.results[1]?.error).toMatch(/skipped/);
  });

  it('reports a compensation FAILURE on the offending step (rollback throws)', async () => {
    const { wp } = mockWp({
      rollbackDocument: (): Promise<RollbackDocumentResponse> =>
        Promise.reject(new Error('disk full')),
    });
    const step: StepExecutor = (s) =>
      s.tool === 'b' ? Promise.reject(new Error('b failed')) : Promise.resolve(s.tool);
    const out = await applyBatch(plan, wp, { confirm: true, step });
    // step 0 (post 10) succeeded; compensation of it fails → recorded on step 0.
    const step0 = out.results[0];
    expect(step0?.compensated).toBe(false);
    expect(step0?.error).toMatch(/Rollback of post 10 failed: disk full/);
  });
});

/* ─────────────────────────── compensationFailurePayload ─────────────────────────────────────── */

describe('compensationFailurePayload', () => {
  it('maps to INTERNAL_ERROR with meta.phase=compensation (COMPENSATION_FAILED not in §6 enum)', () => {
    const p = compensationFailurePayload('rollback failed', 42);
    expect(p.code).toBe('INTERNAL_ERROR');
    expect(p.meta['phase']).toBe('compensation');
    expect(p.meta['post_id']).toBe(42);
  });
});
