/**
 * WP-T03 — `batch.plan` / `batch.apply` engine scaffolding (multi-document transactions).
 *
 * The engine for the two batch tools (`13-tool-catalog.md §1.10`, `01-architecture.md §7 M8`):
 *   - {@link planBatch} — dry-plan a multi-step brief: resolve `{step_index,tool,input,target,action}`
 *     per step (plus the per-step `valid`/`errors` verdict) and accumulate the documents/kit that must
 *     be backed up. NEVER persists (`batch.plan` is `readOnlyHint`).
 *   - {@link applyBatch} — execute a plan with UP-FRONT backups (kit + every touched doc), ordered
 *     execution, and REVERSE-ORDER best-effort compensation on partial failure, returning a per-step
 *     result map with a `compensated` flag.
 *
 * TWO COMPENSATION PATHS (Detailed-Requirements #5/#6):
 *   1. PREFERRED — the PHP `/batch/apply` route (`10-rest-api.md §13`) records backups + compensates
 *      server-side in one transaction. Used when the caller supplies a {@link RestExecutor} (the
 *      tool→route translation lives in the calling tool WP, not here).
 *   2. FALLBACK — TS-side step-by-step for pure tool sequences the route does not cover: the engine
 *      backs up each touched doc up front, runs steps in order, and on failure rolls back in reverse
 *      application order to the captured backup handles. Used when the caller supplies a
 *      {@link StepExecutor}.
 *
 * PHP owns the lock + the AUTHORITATIVE per-step validation (`10-rest-api.md §0.9, §13`): every step
 * the engine applies goes through a route/tool that validates. The engine accepts an ALREADY-CONFIRMED
 * `confirm` flag — the destructive elicitation gate lives in the tool (WP-T11), not here.
 *
 * Contract authority: `13-tool-catalog.md §1.10` (batch I/O) + `§5.6` (batch-vs-granular),
 * `10-rest-api.md §13` (batch routes + compensation) + `§0.8` (op_id), `12-error-taxonomy.md §3.2`.
 */

import { makeErrorPayload, type McpErrorPayload } from '@elementor-ultra/shared';

import type { WpRoutes } from '../runtime/context.js';
import type { BatchApplyStep, BatchPlanResponse, BatchStep as RestBatchStep } from '../wp/types.js';

import { mintOpId } from './idempotency.js';

/* ───────────────────────────── public engine types (catalog §1.10 shaped) ─────────────────────── */

/**
 * One step of a batch brief (`13-tool-catalog.md §1.10` inputSchema). `tool` is the MCP tool name
 * (e.g. `elementor.page.build`); `input` is its (un-parsed) tool input. This is the TOOL-shaped step —
 * distinct from the REST-shaped {@link RestBatchStep} (`{route,body}`) the `/batch/*` routes take.
 */
export interface BatchStep {
  tool: string;
  input: Record<string, unknown>;
}

/** A resolved plan row (`13-tool-catalog.md §1.10` `batch.plan` outputSchema). */
export interface PlanRow {
  step_index: number;
  tool: string;
  /**
   * The step's ORIGINAL tool input, carried through the plan→apply round trip so the REST body
   * survives (without it every applied step would reach PHP with an empty body).
   */
  input: Record<string, unknown>;
  /** The write target (e.g. `post_id` / `template_id`), or `null` when the step creates a new target. */
  target: string | null;
  /** A short action verb derived from the tool (`build` / `update_settings` / `save` / …). */
  action: string;
  /**
   * The per-step validation verdict — the AUTHORITATIVE PHP `/batch/plan` value when the route is
   * reachable (`10-rest-api.md §0.9`), else the local translation pre-check. Absent ⇒ not validated.
   */
  valid?: boolean;
  /** Taxonomy error items (`{code,message,meta?}`) for an invalid step. */
  errors?: Array<Record<string, unknown>>;
}

/** The `batch.plan` result (`13-tool-catalog.md §1.10` outputSchema). */
export interface BatchPlan {
  plan: PlanRow[];
  /** Stable string handles of everything to back up up front — `doc:<id>` and/or `kit`. */
  backups_required: string[];
  /** Aggregate validity (AND of every step) — the PHP `/batch/plan` verdict when reachable. */
  valid: boolean;
}

/** One step's apply outcome (`13-tool-catalog.md §1.10` `batch.apply` outputSchema). */
export interface StepResult {
  step_index: number;
  ok: boolean;
  /** The step's raw output when it succeeded, else `null` (`13-tool-catalog.md §1.10`). */
  output: unknown;
  /** A human error string when it failed, else `null`. */
  error: string | null;
  /** True ⇒ this step's write was rolled back during compensation. */
  compensated: boolean;
}

/** The `batch.apply` result (`13-tool-catalog.md §1.10` outputSchema). */
export interface BatchResults {
  results: StepResult[];
}

/* ───────────────────────────── executor seams (injected by the calling tool WP) ─────────────────── */

/**
 * The PREFERRED apply path: translate the engine's tool-shaped plan into the REST `/batch/apply`
 * contract and let PHP record backups + compensate in one transaction (`10-rest-api.md §13`). The
 * caller (WP-T11) supplies this — normally the engine's own {@link toolToRestStep} translation.
 */
export interface RestExecutor {
  /** Translate one tool-shaped step to the REST `{route,body}` step shape. */
  toRestStep(step: BatchStep): RestBatchStep;
}

/**
 * The FALLBACK apply path: run one tool-shaped step and return its raw output (the engine handles
 * ordering + compensation around it). Supplied by the calling tool WP for sequences the `/batch/apply`
 * route does not cover. MUST throw on failure (the engine catches + compensates).
 */
export type StepExecutor = (step: BatchStep, opId: string) => Promise<unknown>;

/** Options for {@link applyBatch} (`13-tool-catalog.md §1.10` inputSchema). */
export interface ApplyBatchOptions {
  /** Idempotency key threaded to every step (`10-rest-api.md §0.8`); minted if omitted. */
  op_id?: string;
  /**
   * The destructive-op confirmation flag (`13-tool-catalog.md §1.10`, Detailed-Requirements #5). The
   * elicitation gate lives in the TOOL (WP-T11); this engine only enforces it is set.
   */
  confirm: boolean;
  /** PREFERRED: PHP server-side batch route + compensation. */
  rest?: RestExecutor;
  /** FALLBACK: TS-side step-by-step executor for sequences the route does not cover. */
  step?: StepExecutor;
}

/* ───────────────────────────── plan-row derivation (no persist) ─────────────────────────────── */

/**
 * Derive `{target, action}` for a plan row from a tool-shaped step. Pure + side-effect free (used by
 * {@link planBatch}, which MUST NOT persist). `target` reads the common write-target keys; `action` is
 * the trailing segment of the dotted tool name (`elementor.page.update_settings` → `update_settings`).
 */
export function derivePlanRow(stepIndex: number, step: BatchStep): PlanRow {
  const segments = step.tool.split('.');
  const action = segments.length > 0 ? (segments[segments.length - 1] ?? step.tool) : step.tool;

  const targetRaw =
    step.input['post_id'] ?? step.input['template_id'] ?? step.input['id'] ?? step.input['term_id'];
  const target =
    typeof targetRaw === 'number'
      ? String(targetRaw)
      : typeof targetRaw === 'string' && targetRaw.length > 0
        ? targetRaw
        : null;

  return { step_index: stepIndex, tool: step.tool, input: step.input, target, action };
}

/* ───────────────────────────── tool → REST route translation (10 §13) ─────────────────────────── */

/**
 * The PHP `/batch/*` route ids the `Batch_Runner` dispatches (`10-rest-api.md §13` route grammar;
 * mirrors `class-batch-runner.php` `DOC_WRITE_ROUTES`/`DOC_CREATE_ROUTES`/`DESIGN_ROUTES`). `pro/*`
 * is prefix-dispatched there, so it is handled separately in {@link hasRouteTranslation}.
 */
const BATCH_ROUTE_IDS: ReadonlySet<string> = new Set([
  'documents/save',
  'documents/replace-tree',
  'documents/settings',
  'documents',
  'documents/create',
  'design/classes',
  'design/deploy',
]);

/**
 * MCP tool name → PHP batch route id (`10-rest-api.md §13`). Document-route bodies pass through with
 * ONE normalization — {@link toolToRestStep} injects `prime_css:true` on the `documents/create` path
 * (CSS-prime invariant, see there) — and their input keys are a subset of what `doc_args` /
 * `apply_create` consume; extra TS-only keys (`generation`, `confirm`) are ignored server-side. The
 * Pro mappings are NOT all usable: only `pro/form/build` takes an array body — the three Pro CREATE
 * routes are dispatched by the runner but broken server-side ({@link BROKEN_PRO_BATCH_ROUTES}), so
 * {@link planBatch} hard-marks them invalid. Tools NOT in this table (e.g. `design.classes.upsert`,
 * whose diff-PUT body needs a live read) have no batch translation — use the granular tool
 * (Contract 13 §5.6) or a REST-shaped step (`tool` = a §13 route id, `input` = its body).
 */
const TOOL_ROUTE_MAP: Readonly<Record<string, string>> = {
  'elementor.page.create': 'documents/create',
  'elementor.page.build': 'documents/create',
  'elementor.page.replace_tree': 'documents/replace-tree',
  'elementor.page.update_settings': 'documents/settings',
  'elementor.pro.theme.create': 'pro/theme',
  'elementor.pro.popup.create': 'pro/popup',
  'elementor.pro.loop.create_item': 'pro/loop/item',
  'elementor.pro.form.build': 'pro/form/build',
};

/**
 * §13 Pro batch routes the PHP runner dispatches but that CANNOT currently apply:
 * `Batch_Runner::apply_pro()` invokes the builder with the plain array step body, while
 * `Theme_Builder_Service::create()`, `Popup_Service::create()` and `Loop_Service::create_item()` are
 * `WP_REST_Request` consumers (`$request->get_param()`), so every such step ALWAYS fails at apply
 * time with `UPSTREAM_ERROR` ("Call to a member function get_param() on array") and compensates the
 * whole batch. Worse, the PHP `/batch/plan` pre-check ACCEPTS them (`pro_validate` finds no
 * `validate()` method and defaults to valid), so the route's verdict is misleadingly VALID —
 * {@link planBatch} pre-marks these steps invalid and does NOT let the route verdict overwrite that
 * local mark. Only `pro/form/build` (`Form_Builder_Service::build(array $params)`) genuinely accepts
 * the array body. DELETE this set once the runner wraps the body in a `WP_REST_Request`.
 */
export const BROKEN_PRO_BATCH_ROUTES: ReadonlySet<string> = new Set([
  'pro/theme',
  'pro/popup',
  'pro/loop/item',
]);

/** Whether a step's `tool` maps onto a PHP `/batch/*` route (mapped tool name OR a literal route id). */
export function hasRouteTranslation(tool: string): boolean {
  return tool in TOOL_ROUTE_MAP || BATCH_ROUTE_IDS.has(tool) || tool.startsWith('pro/');
}

/**
 * Translate a tool-shaped step into the REST `{route,body}` shape the PHP `/batch/*` routes take
 * (`10-rest-api.md §13`). Mapped MCP tool names get their route id; an already-route-shaped step
 * (`tool` IS a §13 route id) passes through. An unknown tool is forwarded VERBATIM so the PHP runner
 * rejects it authoritatively ("Unsupported batch route") — {@link planBatch} surfaces that verdict up
 * front so the agent never discovers it at apply time.
 */
export function toolToRestStep(step: BatchStep): RestBatchStep {
  const mapped = TOOL_ROUTE_MAP[step.tool];
  // CSS-prime invariant (CLAUDE.md #3 / Contract 10 §0.10): the direct page tools default
  // `prime_css:true` in their catalog schemas (`pageBuildInput`), but batch step inputs are
  // `z.record(z.unknown())` so that zod default never applies here, and the PHP CREATE path defaults
  // prime_css FALSE (`Batch_Runner::apply_create` → `doc_args($body, false)`; save/replace-tree
  // default true) — an atomic `page.build` step omitting `prime_css` would save WITHOUT priming and
  // render unstyled. Mirror the tool's own default by injecting it; an explicit value always wins.
  if (mapped === 'documents/create' && !('prime_css' in step.input)) {
    return { route: mapped, body: { ...step.input, prime_css: true } };
  }
  return { route: mapped ?? step.tool, body: step.input };
}

/**
 * Whether a tool-shaped step mutates the global KIT (global classes / variables / colors / fonts /
 * element defaults / design deploy). Such steps require a kit backup up front (`10-rest-api.md §13`,
 * [R6] kit-class deletion rewrites all docs). Heuristic on the tool name — the PHP `/batch/plan` route
 * is authoritative when used.
 */
function touchesKit(tool: string): boolean {
  return (
    tool.includes('global_classes') ||
    tool.includes('global.classes') ||
    tool.includes('design.') ||
    tool.includes('variables') ||
    tool.includes('global_colors') ||
    tool.includes('global_fonts') ||
    tool.includes('element_defaults') ||
    tool.includes('.kit.')
  );
}

/**
 * Plan a batch brief WITHOUT persisting (`13-tool-catalog.md §1.10`, Detailed-Requirements #4). The
 * engine prefers the PHP `/batch/plan` route (`wp.batchPlan`) for the authoritative per-step validation
 * + backup requirements, then SHAPES the result into the tool-facing {@link BatchPlan}. If the route is
 * unavailable/unsupported it falls back to a pure local derivation (advisory only).
 *
 * Either path is read-only: `batch.plan` is `readOnlyHint:true`.
 */
export async function planBatch(steps: BatchStep[], wp: WpRoutes): Promise<BatchPlan> {
  const plan: PlanRow[] = steps.map((step, i) => derivePlanRow(i, step));

  // Local backup-requirement derivation (used as the fallback + merged with the route's view).
  const backups = new Set<string>();
  for (const row of plan) {
    if (row.target !== null) {
      backups.add(`doc:${row.target}`);
    }
    if (touchesKit(row.tool)) {
      backups.add('kit');
    }
  }

  // Local pre-check: a step whose tool has no §13 route translation can NEVER apply via /batch/apply,
  // and a step landing on a KNOWN-BROKEN Pro route ({@link BROKEN_PRO_BATCH_ROUTES}) always fails at
  // apply even though the PHP /batch/plan pre-check accepts it. Mark both invalid up front so the
  // agent learns at plan time, not at apply time; broken-route marks are HARD (never overwritten by
  // the route's misleading verdict).
  let valid = true;
  const hardInvalid = new Set<number>();
  for (const row of plan) {
    const route = TOOL_ROUTE_MAP[row.tool] ?? row.tool;
    if (BROKEN_PRO_BATCH_ROUTES.has(route)) {
      valid = false;
      hardInvalid.add(row.step_index);
      row.valid = false;
      row.errors = [
        {
          code: 'VALIDATION_FAILED',
          message: `Batch route "${route}" cannot apply: the PHP Batch_Runner passes the step body as a plain array, but this Pro builder requires a WP_REST_Request — the step always fails at apply time and compensates the whole batch. Use the granular elementor.pro.* tool instead (Contract 13 §5.6).`,
        },
      ];
    } else if (!hasRouteTranslation(row.tool)) {
      valid = false;
      row.valid = false;
      row.errors = [
        {
          code: 'VALIDATION_FAILED',
          message: `No /batch route translation for tool "${row.tool}" — batch steps must map onto the 10-rest-api.md §13 routes (documents/*, design/*, pro/*). Use the granular tool instead (Contract 13 §5.6).`,
        },
      ];
    }
  }

  // PREFERRED: ask the PHP /batch/plan route for the AUTHORITATIVE per-step verdict +
  // backups_required (it runs each step's validator, no persist, §0.9). Steps are translated via
  // {@link toolToRestStep}; an untranslatable tool is forwarded verbatim so PHP rejects it itself.
  try {
    const restSteps: RestBatchStep[] = steps.map((s) => toolToRestStep(s));
    const planResp: BatchPlanResponse = await wp.batchPlan({ steps: restSteps });
    mergeRouteBackups(planResp, backups);
    valid = mergeRouteVerdict(planResp, plan, hardInvalid);
  } catch {
    // Route not available (early-wave): keep the local plan + translation pre-check verdict.
    // batch.plan is advisory there; the real validation happens at apply time per step (§0.9).
  }

  return { plan, backups_required: [...backups], valid };
}

/**
 * Merge the AUTHORITATIVE PHP `/batch/plan` per-step verdict onto the engine's plan rows (§0.9): each
 * route entry's `valid` (and `errors`, when carried) overwrites the local pre-check — EXCEPT the
 * `hardInvalid` rows ({@link BROKEN_PRO_BATCH_ROUTES}), where the route's `pro_validate` wrongly
 * accepts a step that is guaranteed to fail at apply, so the local mark wins. Returns the route's
 * aggregate `valid` ANDed with the hard-invalid pre-check.
 */
function mergeRouteVerdict(
  resp: BatchPlanResponse,
  plan: PlanRow[],
  hardInvalid: ReadonlySet<number>,
): boolean {
  for (const entry of resp.plan) {
    if (hardInvalid.has(entry.step)) {
      continue; // local KNOWN-BROKEN verdict wins over the route's misleading 'valid'.
    }
    const row = plan.find((r) => r.step_index === entry.step);
    if (row === undefined) {
      continue;
    }
    row.valid = entry.valid;
    // The wire type omits `errors`, but the PHP plan_step embeds `{code,message,meta?}` items on an
    // invalid entry — surface them; clear any stale local pre-check error on a valid entry.
    const errors = (entry as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      row.errors = errors as Array<Record<string, unknown>>;
    } else if (entry.valid) {
      delete row.errors;
    }
  }
  return resp.valid && hardInvalid.size === 0;
}

/** Merge the PHP `/batch/plan` `backups_required[]` into the engine's string-handle set. */
function mergeRouteBackups(resp: BatchPlanResponse, into: Set<string>): void {
  for (const req of resp.backups_required) {
    if (req.kit === true) {
      into.add('kit');
    }
    if (typeof req.post_id === 'number') {
      into.add(`doc:${req.post_id}`);
    }
  }
}

/* ───────────────────────────── apply (up-front backups + reverse compensation) ─────────────────── */

/**
 * Parse a `doc:<id>` backup handle into a numeric post id (`null` for non-doc handles like `kit`). */
function parseDocHandle(handle: string): number | null {
  const m = /^doc:(\d+)$/.exec(handle);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

/** A captured backup we can roll back to during compensation (FALLBACK path). */
interface CapturedBackup {
  postId: number;
  metaKey: string;
}

/**
 * Build the `INTERNAL_ERROR` payload used when COMPENSATION ITSELF fails. `COMPENSATION_FAILED` is NOT
 * in the frozen `12-error-taxonomy.md §6` enum, so per Detailed-Requirements #5 + Implementation-Notes
 * we map to `INTERNAL_ERROR` with `meta.phase='compensation'` (the REST digest's `E_COMPENSATION_FAILED`
 * has no TS-side code — flag to the contract owner if this recurs).
 */
export function compensationFailurePayload(message: string, postId?: number): McpErrorPayload {
  const payload = makeErrorPayload('INTERNAL_ERROR', message);
  // `meta.phase` is an additive key the open wire `ErrorMeta` (Record<string,unknown>) accepts; the
  // typed `InternalErrorMeta` (trace_id only) does not declare it, so set it on the open wire meta.
  payload.meta = {
    phase: 'compensation',
    ...(postId !== undefined ? { post_id: postId } : {}),
  };
  return payload;
}

/**
 * Apply a planned batch (`13-tool-catalog.md §1.10`, Detailed-Requirements #5/#6, M8). Records UP-FRONT
 * backups of the kit + every touched document, executes steps IN ORDER, and on the first failure
 * compensates in REVERSE application order, marking each rolled-back step `compensated:true`. If
 * compensation itself fails the step's `error` carries a `compensation`-phase message
 * ({@link compensationFailurePayload}).
 *
 * Supply EITHER `opts.rest` (PREFERRED — PHP `/batch/apply` does backups + compensation server-side) OR
 * `opts.step` (FALLBACK — engine does TS-side ordering + reverse compensation). When neither is given
 * the engine cannot apply and throws (a programming error in the calling tool WP).
 */
export async function applyBatch(
  plan: BatchPlan,
  wp: WpRoutes,
  opts: ApplyBatchOptions,
): Promise<BatchResults> {
  if (!opts.confirm) {
    // The tool (WP-T11) must elicit + confirm before calling the engine; declining returns a clean
    // non-error result there (12-error-taxonomy.md §5 rule 5). Reaching here unconfirmed is a bug.
    throw new Error('applyBatch requires opts.confirm === true (the tool gates elicitation)');
  }
  const opId = opts.op_id ?? mintOpId();

  if (opts.rest !== undefined) {
    return applyViaRestRoute(plan, wp, opts.rest, opId);
  }
  if (opts.step !== undefined) {
    return applyViaSteps(plan, wp, opts.step, opId);
  }
  throw new Error('applyBatch requires either opts.rest (PHP route) or opts.step (TS executor)');
}

/**
 * PREFERRED path: forward the whole plan to the PHP `/batch/apply` route, which records backups + runs
 * compensation server-side in one transaction (`10-rest-api.md §13`). We SHAPE its per-step results
 * into the tool-facing {@link StepResult} list (the route never raises on a failed step — it carries
 * the outcome in `results[]`).
 */
async function applyViaRestRoute(
  plan: BatchPlan,
  wp: WpRoutes,
  rest: RestExecutor,
  opId: string,
): Promise<BatchResults> {
  const restPlan: BatchApplyStep[] = plan.plan.map((row) => {
    const restStep = rest.toRestStep(toBatchStep(row));
    return { route: restStep.route, body: restStep.body };
  });

  const resp = await wp.batchApply({ plan: restPlan, op_id: opId });

  const results: StepResult[] = resp.results.map((r) => ({
    step_index: r.step,
    ok: r.ok,
    output: r.ok ? (r.post_id ?? null) : null,
    error: r.ok ? null : (r.error?.message ?? r.error?.code ?? 'step failed'),
    // The PHP route compensates the whole batch; reflect its top-level flag onto failed steps.
    compensated: !r.ok && resp.compensated,
  }));

  return { results };
}

/** Reconstruct a tool-shaped step from a plan row (the row carries the tool name AND its input). */
function toBatchStep(row: PlanRow): BatchStep {
  return { tool: row.tool, input: row.input };
}

/**
 * FALLBACK path: TS-side step-by-step with reverse-order best-effort compensation (M8). Backs up each
 * touched doc UP FRONT (so a rollback targets the right pre-batch snapshot), runs steps in order, and
 * on failure rolls back the SUCCEEDED steps in reverse application order via `wp.rollbackDocument`.
 */
async function applyViaSteps(
  plan: BatchPlan,
  wp: WpRoutes,
  step: StepExecutor,
  opId: string,
): Promise<BatchResults> {
  // 1) UP-FRONT backups of every required doc handle (kit handles are server-side; doc handles are
  //    captured here so compensation has a concrete rollback target). Capture order = handle order.
  const captured = new Map<number, CapturedBackup>();
  for (const handle of plan.backups_required) {
    const postId = parseDocHandle(handle);
    if (postId === null) {
      continue; // 'kit' + other non-doc handles are handled by the route path, not TS rollback.
    }
    const backup = await wp.backupDocument(postId, { op_id: mintOpId([opId, 'backup', postId]) });
    captured.set(postId, { postId, metaKey: backup.backup_handle.meta_key });
  }

  const results: StepResult[] = [];
  const applied: PlanRow[] = [];
  let failed = false;

  // 2) Ordered execution. Stop at the first failure, then compensate.
  for (const row of plan.plan) {
    if (failed) {
      results.push({
        step_index: row.step_index,
        ok: false,
        output: null,
        error: 'skipped (a prior step failed)',
        compensated: false,
      });
      continue;
    }
    try {
      const output = await step(toBatchStep(row), mintOpId([opId, row.step_index]));
      results.push({
        step_index: row.step_index,
        ok: true,
        output: output ?? null,
        error: null,
        compensated: false,
      });
      applied.push(row);
    } catch (err) {
      failed = true;
      results.push({
        step_index: row.step_index,
        ok: false,
        output: null,
        error: errorMessage(err),
        compensated: false,
      });
    }
  }

  // 3) REVERSE-ORDER compensation of the steps that DID land.
  if (failed) {
    await compensate(applied, captured, wp, opId, results);
  }

  return { results };
}

/**
 * Roll back the applied steps in REVERSE application order to their captured pre-batch backups
 * (Detailed-Requirements #5). Best-effort: a rollback failure does NOT abort the rest — it is recorded
 * on the offending step as a `compensation`-phase {@link compensationFailurePayload}.
 */
async function compensate(
  applied: PlanRow[],
  captured: Map<number, CapturedBackup>,
  wp: WpRoutes,
  opId: string,
  results: StepResult[],
): Promise<void> {
  const compensatedDocs = new Set<number>();
  for (let i = applied.length - 1; i >= 0; i -= 1) {
    const row = applied[i];
    if (row === undefined) {
      continue;
    }
    const postId = row.target !== null ? Number(row.target) : NaN;
    const result = results.find((r) => r.step_index === row.step_index);
    const backup = Number.isNaN(postId) ? undefined : captured.get(postId);

    if (backup === undefined) {
      // No captured snapshot for this target (e.g. a create step) — nothing to roll back to. Mark it
      // compensated:false (we did not undo it) but do not treat that as a compensation failure.
      continue;
    }
    if (compensatedDocs.has(postId)) {
      // Already restored this doc to its pre-batch snapshot via a later-in-order step.
      if (result !== undefined) {
        result.compensated = true;
      }
      continue;
    }
    try {
      await wp.rollbackDocument(postId, {
        meta_key: backup.metaKey,
        op_id: mintOpId([opId, 'rollback', postId]),
      });
      compensatedDocs.add(postId);
      if (result !== undefined) {
        result.compensated = true;
      }
    } catch (err) {
      // Compensation itself failed — surface via INTERNAL_ERROR + meta.phase='compensation'.
      const payload = compensationFailurePayload(
        `Rollback of post ${postId} failed: ${errorMessage(err)}`,
        postId,
      );
      if (result !== undefined) {
        result.error = payload.message;
        result.compensated = false;
      }
    }
  }
}

/** Coerce a thrown value into a human message without leaking a stack. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  return 'unknown error';
}
