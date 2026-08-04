/**
 * WP-R07 — Pro Theme Builder tool HANDLERS (Contract 13 §1.8; SUPPLEMENT.md §A.1/§A.7).
 *
 * Implements the three Pro theme-builder tools and attaches each handler to the WP-F04
 * {@link ToolRegistry} by EXACT catalog name (13-tool-catalog.md §1.8). This WP does NOT define schemas
 * (WP-F04 owns the descriptors `catalog/schemas/pro.ts`) — each handler is a {@link ToolHandler}
 * (WP-T01 `runtime/context.ts`) attached via `registry.attachHandler(name, fn)`; the SDK has already
 * validated `args` against the descriptor's `inputSchema` (incl. the `type` enum and the
 * `ConditionTuple` arities) before the handler runs (Contract 13 §0.1) and validates the returned
 * `structuredContent` against `outputSchema` after.
 *
 * Handlers are THIN proxies over the WP-F02 bound facade (`ctx.wp.*`): validate-by-SDK →
 * `ctx.wp.<route>(…)` → map the RAW REST `data` into the descriptor's `outputSchema` shape → return
 * `{ content, structuredContent }`. ALL business logic (conditions slash-joining, conflict computation,
 * cache regenerate, section-location validity) lives in PHP per Contract 15 §4.7 — these handlers add no
 * business logic. The ONLY client-side guard is the cheap `section`-without-`location` check (§Detailed
 * Requirements 3) which short-circuits BEFORE a doomed REST round-trip; the PHP route re-asserts it.
 *
 * Tools handled here (Contract 13 §1.8 — all NON-★, registered disabled at boot, enabled via
 * `tools.search`):
 *  - `elementor.pro.theme.create`               (M, `POST /pro/theme`)              — create a theme doc.
 *  - `elementor.pro.theme.set_conditions`       (M, `PUT /pro/theme/{id}/conditions`) — replace conditions.
 *  - `elementor.pro.theme.get_conditions_config`(R, `GET /pro/theme/conditions-config`) — autocomplete tree.
 *
 * Error mapping (Contract 13 §0.9, Contract 12 §3): a Pro-inactive / experiment-inactive 501, a 422
 * validation failure, a 400, or a 403 arrive as a {@link WpClientError} carrying the taxonomy payload and
 * route through WP-F05's `fromClientError` → protocol-throw vs `isError` result (§5). Tool-arg failures
 * (a `type` outside the enum, a malformed tuple) are `-32602` from the SDK's zod layer before the handler
 * runs — never a protocol error the agent cannot fix.
 *
 * Contract authority: 13-tool-catalog.md §1.8 (per-tool I/O), §0.9 (error semantics); 10-rest-api.md
 * §8.1-§8.3 (REST shapes the client wraps); 12-error-taxonomy.md §3 (codes), §5 (surface rules); 15
 * §4.7 (business logic in PHP).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  makeErrorPayload,
  type ConditionTuple,
  type CreateThemeDocRequest,
  type CreateThemeDocResponse,
  type SetThemeConditionsRequest,
  type SetThemeConditionsResponse,
  type ConditionsConfigResponse,
  type ThemeConditionConflict,
  type ElementNode,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../../runtime/context.js';
import type { ToolRegistry } from '../../catalog/registry.js';
import { WpClientError } from '../../wp/types.js';
import { fromClientError, toToolErrorResult, type ToolResult } from '../../wp/errors.js';
import { mintOpId, isReplay } from '../../safety/idempotency.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.8) ─────────────────────────── */

/** The Pro theme-builder tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.8). */
export const PRO_THEME_CREATE = 'elementor.pro.theme.create';
export const PRO_THEME_SET_CONDITIONS = 'elementor.pro.theme.set_conditions';
export const PRO_THEME_GET_CONDITIONS_CONFIG = 'elementor.pro.theme.get_conditions_config';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const PRO_THEME_TOOL_NAMES = [
  PRO_THEME_CREATE,
  PRO_THEME_SET_CONDITIONS,
  PRO_THEME_GET_CONDITIONS_CONFIG,
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
 * Run a thin Pro theme handler: invoke `fn` and, on a {@link WpClientError} (a 501 `PRO_REQUIRED` /
 * `EXPERIMENT_INACTIVE`, a 422 validation, a 400, a 403 `CAPABILITY_MISSING`), route it through WP-F05's
 * surface rules (`fromClientError` → protocol-throw or `isError` result, 12-error-taxonomy.md §5).
 * Non-client errors rethrow (the server core surfaces them). The {@link ToolResult} is structurally a
 * {@link CallToolResult}.
 */
async function runProTheme(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
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
 * (the `type` enum, the `ConditionTuple` tuple-with-rest, the defaults), so the shapes below describe the
 * POST-validation input. They are narrowing views over the loose `unknown` the runtime
 * {@link ToolHandler} declares — NOT re-validation.
 */

/** `elementor.pro.theme.create` validated input (Contract 13 §1.8). */
interface ProThemeCreateArgs {
  type:
    | 'header'
    | 'footer'
    | 'single-post'
    | 'single-page'
    | 'archive'
    | 'search-results'
    | 'error-404'
    | 'section';
  title: string;
  /** SDK-applied default `'publish'` (descriptor `.default('publish')`). */
  status: 'publish' | 'draft';
  location?: string;
  elements?: ElementNode[];
  page_settings?: Record<string, unknown>;
  conditions?: ConditionTuple[];
}

/** `elementor.pro.theme.set_conditions` validated input (Contract 13 §1.8). */
interface ProThemeSetConditionsArgs {
  post_id: number;
  conditions: ConditionTuple[];
  /** SDK-applied default `false` (descriptor `.default(false)`). */
  check_conflicts: boolean;
}

/** `elementor.pro.theme.get_conditions_config` validated input — empty (Contract 13 §1.8). */
type ProThemeGetConditionsConfigArgs = Record<string, never>;

/* ───────────────────────────── elementor.pro.theme.create (§1.8 / §8.1) ─────────────────────── */

/**
 * Build the `VALIDATION_FAILED` `isError` result for a `section` theme doc created WITHOUT a `location`
 * (12-error-taxonomy.md §3; §Detailed Requirements 3). This is the CHEAP client-side guard — it
 * short-circuits before a doomed `POST /pro/theme` round-trip and hands the agent an actionable next
 * step (call `get_conditions_config` / `site.capabilities` for the valid location keys). The PHP route
 * is the final authority and re-asserts the same rule against `locations_manager->get_locations()`.
 */
function sectionLocationRequiredResult(): ToolResult {
  const message =
    'section theme docs require a `location`; call `elementor.pro.theme.get_conditions_config` (or `elementor.site.capabilities`) for the valid section location keys, then pass one as `location`.';
  const payload = makeErrorPayload(ErrorCodes.VALIDATION_FAILED, message, {
    meta: {
      errors: [{ code: ErrorCodes.VALIDATION_FAILED, message, prop: 'location' }],
    },
  });
  return toToolErrorResult(payload);
}

/**
 * `elementor.pro.theme.create` handler (M, 13-tool-catalog.md §1.8; 10-rest-api.md §8.1). Proxies
 * `POST /pro/theme`: PHP wraps `documents->create(type,…)` + `Document::save({settings,elements})` +
 * (when `conditions` present) `Conditions_Manager::save_conditions()` (SUPPLEMENT.md §A.1). The `type`
 * enum (8 valid types; `single` is intentionally absent) and the `ConditionTuple` arities are validated
 * by the SDK before this runs.
 *
 * The ONLY client-side business guard (§Detailed Requirements 3): a `section` doc REQUIRES a `location`,
 * so `type==='section'` without `location` short-circuits to {@link sectionLocationRequiredResult} (no
 * doomed REST call); PHP re-asserts the rule (and validates the location exists). A deterministic `op_id`
 * makes a retried create a safe no-op (§0.8); an idempotent replay is surfaced INFORMATIONALLY in the
 * text. Returns the frozen `{post_id,edit_url,template_type,location,conditions_stored}`.
 */
export async function proThemeCreateHandler(
  args: ProThemeCreateArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProTheme(async () => {
    // Cheap client-side guard (§Detailed Requirements 3): a section theme doc requires a location.
    if (args.type === 'section' && (args.location === undefined || args.location === '')) {
      return sectionLocationRequiredResult();
    }

    const body: CreateThemeDocRequest = {
      type: args.type,
      title: args.title,
      status: args.status,
      ...(args.location !== undefined ? { location: args.location } : {}),
      ...(args.elements !== undefined ? { elements: args.elements } : {}),
      ...(args.page_settings !== undefined ? { page_settings: args.page_settings } : {}),
      ...(args.conditions !== undefined ? { conditions: args.conditions } : {}),
      op_id: mintOpId([
        'pro.theme.create',
        args.type,
        args.title,
        args.status,
        args.location ?? null,
        args.conditions ?? null,
      ]),
    };
    const data: CreateThemeDocResponse = await ctx.wp.createThemeDoc(body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    const structured = {
      post_id: data.post_id,
      edit_url: data.edit_url,
      template_type: data.template_type,
      location: data.location,
      conditions_stored: data.conditions_stored,
    };
    const conditionCount = data.conditions_stored.length;
    return okResult(
      structured,
      `Created ${data.template_type} theme doc "${args.title}" (post ${data.post_id})` +
        `${data.location !== null ? ` at location "${data.location}"` : ''}` +
        ` with ${conditionCount} display condition(s)` +
        `${replayed ? ' (idempotent replay — already created)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.pro.theme.set_conditions (§1.8 / §8.2) ─────────────── */

/** Compact one-line summary of a single condition conflict (for the result text). */
function describeConflict(c: ThemeConditionConflict): string {
  return `"${c.template_title}" (template ${c.template_id})`;
}

/**
 * `elementor.pro.theme.set_conditions` handler (M, idempotentHint, 13-tool-catalog.md §1.8;
 * 10-rest-api.md §8.2). Proxies `PUT /pro/theme/{id}/conditions`: PHP REPLACES all conditions via
 * `Conditions_Manager::save_conditions()` (writes the slash-joined strings + `cache->regenerate()`,
 * SUPPLEMENT.md §A.1). REPLACE semantics make this idempotent (`idempotentHint:true`); `conditions:[]`
 * clears all (passed straight through).
 *
 * When `check_conflicts:true`, PHP computes overlapping single-instance-location conflicts and returns
 * them in `conflicts[]`; this handler surfaces them in BOTH the result text AND `structuredContent` so
 * the agent can react (§Detailed Requirements 4). A deterministic `op_id` makes a retried replace a safe
 * no-op (§0.8); a replay is surfaced INFORMATIONALLY. Returns `{saved,conditions_stored,conflicts?}`.
 */
export async function proThemeSetConditionsHandler(
  args: ProThemeSetConditionsArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProTheme(async () => {
    const body: SetThemeConditionsRequest = {
      conditions: args.conditions,
      check_conflicts: args.check_conflicts,
      op_id: mintOpId([
        'pro.theme.set_conditions',
        args.post_id,
        args.conditions,
        args.check_conflicts,
      ]),
    };
    const data: SetThemeConditionsResponse = await ctx.wp.setThemeConditions(args.post_id, body);
    const replayed = isReplay(data as unknown as { idempotent_replay?: boolean });

    // PHP always returns `conflicts` (possibly empty); surface it only when non-empty per §1.8
    // (`conflicts?` is optional in the outputSchema). An empty array is omitted so a no-conflict replace
    // validates cleanly without an empty `conflicts: []` riding the structured content.
    const conflicts: ThemeConditionConflict[] = Array.isArray(data.conflicts) ? data.conflicts : [];
    const hasConflicts = conflicts.length > 0;

    const structured: Record<string, unknown> = {
      saved: data.saved,
      conditions_stored: data.conditions_stored,
      ...(hasConflicts ? { conflicts } : {}),
    };

    const conditionCount = data.conditions_stored.length;
    const base =
      conditionCount === 0
        ? `Cleared all display conditions on theme doc ${args.post_id}`
        : `Set ${conditionCount} display condition(s) on theme doc ${args.post_id}`;
    const conflictNote = hasConflicts
      ? ` — WARNING: ${conflicts.length} conflicting template(s): ${conflicts.map(describeConflict).join(', ')}`
      : args.check_conflicts
        ? ' (no conflicts detected)'
        : '';
    return okResult(
      structured,
      `${base}${conflictNote}${replayed ? ' (idempotent replay — already saved)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.pro.theme.get_conditions_config (§1.8 / §8.3) ──────── */

/**
 * The RAW `GET /pro/theme/conditions-config` response also carries `locations` (the live R01 route
 * returns `{tree,id_bearing,locations}`); the frozen shared type narrows to `{tree,id_bearing}`, so this
 * widened view lets the handler read `locations` (required by the tool `outputSchema`) and surface
 * `id_bearing` when present (§Detailed Requirements 5) without redefining the shared type.
 */
interface ConditionsConfigData extends ConditionsConfigResponse {
  locations?: string[];
}

/**
 * `elementor.pro.theme.get_conditions_config` handler (R, readOnly+idempotent, 13-tool-catalog.md §1.8;
 * 10-rest-api.md §8.3). Pure read of the live `Conditions_Manager::get_conditions_config()` autocomplete
 * tree — the agent uses it to validate/autocomplete `name`/`sub_name` and learn which sub-conditions take
 * an id (`id_bearing`). Returns the `tree` + `locations` UNCHANGED (no transform — the tree is opaque,
 * validated server-side); `id_bearing` is surfaced in the text when present (§Detailed Requirements 5).
 * The `outputSchema` is `{tree, locations}` exactly.
 */
export async function proThemeGetConditionsConfigHandler(
  _args: ProThemeGetConditionsConfigArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runProTheme(async () => {
    const data = (await ctx.wp.getConditionsConfig()) as ConditionsConfigData;
    const locations = Array.isArray(data.locations) ? data.locations : [];
    const idBearing = Array.isArray(data.id_bearing) ? data.id_bearing : [];

    const structured = {
      tree: data.tree,
      locations,
    };
    const topKeys = Object.keys(data.tree ?? {});
    const idBearingNote =
      idBearing.length > 0 ? `; id-bearing sub-conditions: ${idBearing.join(', ')}` : '';
    return okResult(
      structured,
      `Conditions config: ${topKeys.length} top-level condition key(s), ${locations.length} location(s)${idBearingNote}.`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach every Pro theme-builder handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name
 * (§Detailed Requirements 1; §Acceptance). These tools are NON-★ (registered disabled at boot, enabled
 * via `tools.search` — driven by the descriptor `star:false` flag, no per-tool work here). The registry
 * stores handlers under its loose `(args) => unknown` type; the runtime invokes them as `(args, ctx)`
 * (server core casts to the WP-T01 {@link ToolHandler} signature), so each handler is registered through
 * that signature here.
 */
export function attachThemeHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [PRO_THEME_CREATE]: (args, ctx) => proThemeCreateHandler(args as ProThemeCreateArgs, ctx),
    [PRO_THEME_SET_CONDITIONS]: (args, ctx) =>
      proThemeSetConditionsHandler(args as ProThemeSetConditionsArgs, ctx),
    [PRO_THEME_GET_CONDITIONS_CONFIG]: (args, ctx) =>
      proThemeGetConditionsConfigHandler(args as ProThemeGetConditionsConfigArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
