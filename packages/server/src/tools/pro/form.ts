/**
 * WP-R09 — Pro Form tool HANDLERS (Contract 13 §1.8; SUPPLEMENT.md §A.3/§A.7).
 *
 * Implements the two Pro Forms tools and attaches each handler to the WP-F04 {@link ToolRegistry} by
 * EXACT catalog name (13-tool-catalog.md §1.8). This WP does NOT define schemas (WP-F04 owns the
 * descriptors `catalog/schemas/pro.ts`) — each handler is a {@link ToolHandler} (WP-T01
 * `runtime/context.ts`) attached via `registry.attachHandler(name, fn)`; the SDK has already validated
 * `args` against the descriptor's `inputSchema` (incl. the `actions[].type` enum and the boolean
 * `fields[].required`) before the handler runs (Contract 13 §0.1) and validates the returned
 * `structuredContent` against `outputSchema` after.
 *
 * Handlers are THIN proxies over the WP-F02 bound facade (`ctx.wp.*`): validate-by-SDK →
 * `ctx.wp.<route>(…)` → map the RAW REST `data` into the descriptor's `outputSchema` shape → return
 * `{ content, structuredContent }`. The AUTHORITATIVE field/action mapping (`type→field_type`,
 * `id→custom_id`, `required→"true"` the STRING, `options→"Label|value\n…"`, repeater `_id` mint,
 * `submit_actions`, action-setting expansion) is the PHP `Form_Mapper`'s job (WP-R03) — this WP passes
 * the ergonomic spec through UNTOUCHED so there are never two divergent mappers (§Implementation Notes).
 * The PHP route also validates each action against `actions_registrar->get()` (license-gated) + the
 * `elementor_pro/forms/field_types` filter, DROPS unregistered actions, and reports them in `warnings[]`.
 *
 * Tools handled here (Contract 13 §1.8 — both NON-★, registered disabled at boot, enabled via
 * `tools.search` on `elementor.pro.form*`):
 *  - `elementor.pro.form.build`        (M, BOTH, `POST /pro/form/build`)  — build a form widget element.
 *  - `elementor.pro.form.list_actions` (R, `GET /pro/form/actions`)       — registered/licensed actions.
 *
 * DIFF SHAPE: `POST /pro/form/build` returns `{element, applied, base_hash, warnings}` (10-rest-api.md
 * §8.5) — it has NO structured tree diff, since the route emits a SINGLE form widget element. The tool
 * `outputSchema` requires a frozen `Diff` (`diff.schema.json` — only `changes[]` mandatory), so this WP
 * faithfully synthesizes ONE `added` {@link NodeChange} for that emitted widget (id = the element's id),
 * then {@link presentDiff} (WP-T03) validates the synthesized diff against the frozen schema before it
 * reaches the agent. It never fabricates a change the route did not perform (one widget in → one
 * `added` change out); when `applied:false` (no `post_id`/`container_id` → no persist) the diff is empty.
 *
 * Error mapping (Contract 13 §0.9, Contract 12 §3): a Pro-inactive 501 (`PRO_REQUIRED`), an atomic-form
 * gate-off 501 (`EXPERIMENT_INACTIVE` — default is a CLASSIC fallback with a warning, not an error), a
 * 422 invalid field/action (`VALIDATION_FAILED` / `ATOMIC_SETTINGS_INVALID`), or a 409 stale `base_hash`
 * (`CONCURRENCY_STALE_HASH`, retryable) arrive as a {@link WpClientError} carrying the taxonomy payload
 * and route through WP-F05's `fromClientError` → protocol-throw vs `isError` result (§5). Tool-arg
 * failures (an `actions[].type` outside the enum, a non-boolean `required`) are `-32602` from the SDK's
 * zod layer before the handler runs — never a protocol error the agent cannot fix.
 *
 * Contract authority: 13-tool-catalog.md §1.8 (per-tool I/O), §0.7 (Diff), §0.8 (base_hash + op_id),
 * §0.9 (error semantics); 10-rest-api.md §8.5 (REST shapes the client wraps); 12-error-taxonomy.md §3
 * (codes), §5 (surface rules); SUPPLEMENT.md §A.3/§A.7 (field/action spec semantics surfaced in the
 * description).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type {
  BuildFormRequest,
  BuildFormResponse,
  ListFormActionsResponse,
  FormFieldInput,
  FormActionInput,
} from '@elementor-ultra/shared';

import type { Diff, NodeChange } from '../../authoring/contract.js';
import { presentDiff, summarizeDiff } from '../../safety/diff.js';
import type { ToolContext, ToolHandler } from '../../runtime/context.js';
import type { ToolRegistry } from '../../catalog/registry.js';
import { WpClientError } from '../../wp/types.js';
import { fromClientError, type ToolResult } from '../../wp/errors.js';
import { mintOpId, isReplay } from '../../safety/idempotency.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.8) ─────────────────────────── */

/** The Pro Forms tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.8). */
export const PRO_FORM_BUILD = 'elementor.pro.form.build';
export const PRO_FORM_LIST_ACTIONS = 'elementor.pro.form.list_actions';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const PRO_FORM_TOOL_NAMES = [PRO_FORM_BUILD, PRO_FORM_LIST_ACTIONS] as const;

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
 * Run a thin Pro Forms handler: invoke `fn` and, on a {@link WpClientError} (a 501 `PRO_REQUIRED` /
 * `EXPERIMENT_INACTIVE`, a 422 validation, a 409 stale `base_hash`, a 403 `CAPABILITY_MISSING`), route
 * it through WP-F05's surface rules (`fromClientError` → protocol-throw or `isError` result,
 * 12-error-taxonomy.md §5). Non-client errors rethrow (the server core surfaces them). The
 * {@link ToolResult} is structurally a {@link CallToolResult}.
 */
async function runProForm(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (the `actions[].type` enum, the boolean `fields[].required`, the `actions` `.passthrough()` extra
 * settings, the required `base_hash`), so the shapes below describe the POST-validation input. They are
 * narrowing views over the loose `unknown` the runtime {@link ToolHandler} declares — NOT re-validation.
 */

/** An ergonomic field spec item (Contract 13 §1.8). `required` is a BOOLEAN here — the PHP layer
 * converts it to the string `"true"`; DO NOT pre-convert in TS (§Detailed Requirements 1). */
interface ProFormField {
  type: string;
  id: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  rows?: number;
  width?: string;
  default_value?: string;
  html?: string;
}

/** An ergonomic action spec item (Contract 13 §1.8). `type` is the registered-action enum; extra
 * action-specific settings (e.g. `email_to`, `redirect_to`) ride via `.passthrough()`. */
interface ProFormAction {
  type:
    | 'email'
    | 'email2'
    | 'redirect'
    | 'webhook'
    | 'mailchimp'
    | 'drip'
    | 'activecampaign'
    | 'getresponse'
    | 'convertkit'
    | 'mailerlite'
    | 'slack'
    | 'discord';
  [key: string]: unknown;
}

/** `elementor.pro.form.build` validated input (Contract 13 §1.8). */
interface ProFormBuildArgs {
  container_id: string;
  post_id: number;
  form_name?: string;
  button_text?: string;
  fields: ProFormField[];
  actions: ProFormAction[];
  base_hash: string;
}

/** `elementor.pro.form.list_actions` validated input — empty (Contract 13 §1.8). */
type ProFormListActionsArgs = Record<string, never>;

/* ───────────────────────────── diff synthesis (REST {element,applied} → frozen Diff) ─────────── */

/**
 * Synthesize the frozen {@link Diff} the `outputSchema` requires from the form/build REST response
 * (10-rest-api.md §8.5: `{element, applied, base_hash, warnings}` — NO structured diff, since the route
 * emits a SINGLE form widget). When the route PERSISTED the widget (`applied:true`), this emits exactly
 * ONE `added` {@link NodeChange} for that widget (id = `element.id`) with the after-snapshot, plus the
 * `new_ids` rollup and the `base_hash_before/after` watermarks (§0.7). When `applied:false` (no
 * `post_id`/`container_id` → the route returned just `{element}` for the caller to place), no node was
 * written, so the diff is empty (`changes:[]`). It never fabricates a change the route did not perform.
 */
function buildFormDiff(data: BuildFormResponse, baseHashBefore: string): Diff {
  const elementId = data.element.id;
  const changes: NodeChange[] = [];
  const newIds: string[] = [];
  if (data.applied && typeof elementId === 'string' && elementId.length > 0) {
    changes.push({
      id: elementId,
      op: 'added',
      ...(typeof data.element.elType === 'string' ? { elType: data.element.elType } : {}),
      ...(typeof data.element.widgetType === 'string'
        ? { widgetType: data.element.widgetType }
        : {}),
      after: data.element,
    });
    newIds.push(elementId);
  }
  const diff: Diff = {
    changes,
    new_ids: newIds,
    changed_ids: [],
    removed_ids: [],
  };
  // Surface the hash watermarks only when both are well-formed 32-hex (the frozen Diff schema constrains
  // them to `^[a-f0-9]{32}$`); a placeholder/empty hash is omitted so the schema never rejects the diff.
  if (isHash32(baseHashBefore)) {
    diff.base_hash_before = baseHashBefore;
  }
  const after = data.base_hash;
  if (typeof after === 'string' && isHash32(after)) {
    diff.base_hash_after = after;
  }
  return diff;
}

/** Whether a string is a 32-char lowercase-hex base_hash (the frozen Diff watermark constraint). */
function isHash32(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}

/* ───────────────────────────── elementor.pro.form.build (§1.8 / §8.5) ───────────────────────── */

/**
 * `elementor.pro.form.build` handler (M, BOTH, 13-tool-catalog.md §1.8; 10-rest-api.md §8.5). Proxies
 * `POST /pro/form/build`: the PHP `Form_Mapper` performs the AUTHORITATIVE widget mapping (V3 classic
 * `form`, or atomic `e-form` when the `e_pro_atomic_form` probe is active; falls back to classic with a
 * warning otherwise — §Detailed Requirements 6), validates each action against `actions_registrar->get()`
 * + the field-type filter, drops unregistered actions, and returns `warnings[]`. This handler passes the
 * ergonomic field/action spec through UNTOUCHED (no `required→"true"` / `id→custom_id` / `options→string`
 * mapping in TS — that is the PHP mapper's single source of truth, §Implementation Notes).
 *
 * `base_hash` is REQUIRED (the build is a surgical write into an existing document — §0.8 / §Detailed
 * Requirements 2); the agent reads it from `page.get_structure`. A deterministic `op_id` makes a retried
 * build a safe no-op (§0.8); a replay is surfaced INFORMATIONALLY in the text. PHP-reported `warnings`
 * (unregistered action / atomic→classic fallback) surface in BOTH the result text AND `structuredContent`
 * (§Detailed Requirements 3/6). Returns the frozen `{element, diff, warnings, base_hash}`.
 */
export async function proFormBuildHandler(
  args: ProFormBuildArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProForm(async () => {
    // Pass the ergonomic spec straight through — the PHP Form_Mapper owns the authoritative mapping.
    // The ergonomic `ProFormField` (optional `label`, `{label,value}` options) differs structurally
    // from the loose REST `FormFieldInput` (PHP maps it), so it crosses via `unknown`; the action spec
    // (enum `type` + passthrough settings) is already assignable to the loose `FormActionInput`.
    const fields: FormFieldInput[] = args.fields as unknown as FormFieldInput[];
    const actions: FormActionInput[] = args.actions;

    const body: BuildFormRequest = {
      container_id: args.container_id,
      post_id: args.post_id,
      ...(args.form_name !== undefined ? { form_name: args.form_name } : {}),
      ...(args.button_text !== undefined ? { button_text: args.button_text } : {}),
      fields,
      actions,
      base_hash: args.base_hash,
      op_id: mintOpId([
        'pro.form.build',
        args.post_id,
        args.container_id,
        args.fields,
        args.actions,
        args.form_name ?? null,
        args.button_text ?? null,
        args.base_hash,
      ]),
    };
    const data: BuildFormResponse = await ctx.wp.buildForm(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    // Synthesize + validate the frozen Diff from the {element,applied} REST shape (no upstream diff).
    const diff = presentDiff(buildFormDiff(data, args.base_hash));
    const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
    // The new base_hash (post-persist); echo the request hash back when the route didn't persist.
    const nextHash = typeof data.base_hash === 'string' ? data.base_hash : args.base_hash;

    const structured = {
      element: data.element,
      diff,
      warnings,
      base_hash: nextHash,
    };

    const summary = summarizeDiff(diff);
    const fieldCount = args.fields.length;
    const actionTypes = args.actions.map((a) => a.type).join(', ');
    const label = args.form_name ?? data.element.id;
    const base =
      `Built form widget "${label}" ` +
      `(${String(fieldCount)} field(s), action(s): ${actionTypes || 'none'}) ` +
      `under container ${args.container_id}: ${String(summary.added)} added`;
    const warnNote = warnings.length > 0 ? ` — WARNING(s): ${warnings.join('; ')}` : '';
    return okResult(
      structured,
      `${base}${warnNote}${replayed ? ' (idempotent replay — already applied; stop retrying)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.pro.form.list_actions (§1.8 / §8.5) ────────────────── */

/**
 * `elementor.pro.form.list_actions` handler (R, readOnly+idempotent, 13-tool-catalog.md §1.8;
 * 10-rest-api.md §8.5). Pure read of `GET /pro/form/actions` — only the REGISTERED/licensed actions
 * (PHP `actions_registrar->get()` filtered by `API::filter_active_features`). The agent calls this BEFORE
 * `build` to learn which action types exist on THIS install (§Detailed Requirements 4) and their
 * `settings_controls` (the keys it may supply inline via the `actions` `.passthrough()`). Returns the
 * `{actions:[{name,label,settings_controls}]}` shape UNCHANGED (no transform).
 */
export async function proFormListActionsHandler(
  _args: ProFormListActionsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProForm(async () => {
    const data: ListFormActionsResponse = await ctx.wp.listFormActions();
    const actions = Array.isArray(data.actions) ? data.actions : [];

    const structured = { actions };
    const names = actions.map((a) => a.name).join(', ');
    return okResult(
      structured,
      `${String(actions.length)} registered form action(s)${names ? `: ${names}` : ''}.`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach every Pro Forms handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Detailed
 * Requirements 1; §Acceptance). These tools are NON-★ (registered disabled at boot, enabled via
 * `tools.search` match on `elementor.pro.form*` — driven by the descriptor `star:false` flag, no
 * per-tool work here). The registry stores handlers under its loose `(args) => unknown` type; the
 * runtime invokes them as `(args, ctx)` (server core casts to the WP-T01 {@link ToolHandler} signature),
 * so each handler is registered through that signature here.
 */
export function attachFormHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [PRO_FORM_BUILD]: (args, ctx) => proFormBuildHandler(args as ProFormBuildArgs, ctx),
    [PRO_FORM_LIST_ACTIONS]: (args, ctx) =>
      proFormListActionsHandler(args as ProFormListActionsArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
