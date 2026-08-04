/**
 * WP-H11 — the `convert.*` MCP tool HANDLERS (the flagship; 13-tool-catalog.md §1.9).
 *
 * Attaches the three HTML→native conversion tools to the WP-F04 {@link ToolRegistry} by EXACT catalog
 * name, wiring each to the `convert/pipeline.ts` orchestrator over the `convert/ports.ts` REST adapters:
 *
 *  - `elementor.convert.html_to_tree` (★, TS-only, `readOnlyHint`) — runs stages 1-9; NO persist.
 *  - `elementor.convert.html_to_page` (★, BOTH, `destructiveHint`) — commit-gated; NEVER auto-commits.
 *    `commit:false` (default) returns a preview + an authoritative dry_run diff (nothing saved). On
 *    `commit:true` it gates on the S3-anchored coverage floor + a11y blockers, then REQUIRES an
 *    elicitation confirm (declining is a clean non-error result), then persists (authoritative dry_run
 *    FIRST, kit untouched on invalid → variables → classes under the tree's deterministic ids →
 *    variable-id swap → save, compensating the kit writes on a save failure → mandatory prime-css).
 *  - `elementor.convert.fidelity_check` (non-★, BOTH, `readOnlyHint`) — renders the saved+primed page
 *    vs the source HTML (reusing the WP-H03 browser pool) and returns `{score, deltas}`.
 *  - `elementor.convert.figma_to_tree` / `figma_to_page` (contract 18 §6; non-★, full profile only) —
 *    the FIGMA front-end onto the SAME pipeline: fetch-to-file (Composio, §7 manifest resume) →
 *    figma-parse → the shared stage run → (page only) the shared persist path; the verify ground
 *    truth is the frame render PNG (F4) and the §6 `figma` block rides the result.
 *
 * Error mapping (12-error-taxonomy.md §1/§5): the SDK validates `args` against the WP-F04 `inputSchema`
 * BEFORE the handler runs (a failure → `-32602` from the SDK's Zod layer / `protocolErrorFromZod`); a
 * thrown {@link WpClientError} routes through `fromClientError` (isError vs protocol-throw); a missing
 * capability throws a {@link ConvertCapabilityError} → a `CAPABILITY_MISSING` isError result; a dry_run
 * `valid:false` → an isError result with the structured `errors[]` (the save is never attempted); a
 * gate-deny / confirm-decline returns a CLEAN non-error result.
 *
 * SEAM: this is the ONLY HTML WP that registers tools + (via `buildPorts`) touches the WP client. The
 * pure stages receive ports/values only.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ErrorCodes,
  makeErrorPayload,
  type ElementNode as RestElementNode,
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

import { buildPorts } from '../convert/ports.js';
import {
  htmlToTree,
  htmlToPage,
  runFidelityCheck,
  ConvertCapabilityError,
  ConvertIntegrityError,
  type HtmlToTreeArgs,
  type HtmlToPageArgs,
  type FidelityCheckArgs,
} from '../convert/pipeline.js';
import {
  figmaToTree,
  figmaToPage,
  FigmaArgsError,
  type FigmaToTreeArgs,
  type FigmaToPageArgs,
  type FigmaTreeBuild,
} from '../convert/figma-pipeline.js';
import { FigmaClientError } from '../convert/figma-client.js';
import type {
  CoverageReport,
  ElementNode,
  GlobalClassObject,
  ProposedVariable,
} from '../convert/types.js';

/* ───────────────────────────── frozen tool names (13-tool-catalog.md §1.9) ──────────────────── */

/** `elementor.convert.html_to_tree` (★, TS-only). */
export const CONVERT_HTML_TO_TREE = 'elementor.convert.html_to_tree';
/** `elementor.convert.html_to_page` (★, BOTH; NEVER auto-commits). */
export const CONVERT_HTML_TO_PAGE = 'elementor.convert.html_to_page';
/** `elementor.convert.fidelity_check` (non-★, BOTH). */
export const CONVERT_FIDELITY_CHECK = 'elementor.convert.fidelity_check';
/** `elementor.convert.figma_to_tree` (contract 18 §6; non-★ — full profile only). */
export const CONVERT_FIGMA_TO_TREE = 'elementor.convert.figma_to_tree';
/** `elementor.convert.figma_to_page` (contract 18 §6; non-★; NEVER auto-commits). */
export const CONVERT_FIGMA_TO_PAGE = 'elementor.convert.figma_to_page';

/** Every convert tool name this WP owns a handler for (used by attach + tests). */
export const CONVERT_TOOL_NAMES = [
  CONVERT_HTML_TO_TREE,
  CONVERT_HTML_TO_PAGE,
  CONVERT_FIDELITY_CHECK,
  CONVERT_FIGMA_TO_TREE,
  CONVERT_FIGMA_TO_PAGE,
] as const;

/* ───────────────────────────── result helpers ──────────────────────────────────────────────── */

/** Whether a thrown value is a {@link WpClientError} (carries a taxonomy `payload`). */
function isWpClientError(value: unknown): value is WpClientError {
  return value instanceof WpClientError;
}

/** Build a successful tool result: the structured payload + a compact human-readable text line. */
function okResult(structured: Record<string, unknown>, text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/**
 * Run a convert handler, centralizing the §5 error surface:
 *  - a {@link ConvertCapabilityError} → a `CAPABILITY_MISSING` isError result (probe required);
 *  - a {@link ConvertIntegrityError} → a `VALIDATION_FAILED` isError result carrying the contract-17
 *    §1 hard violations (I1/I3 — a converter bug; NOTHING was validated or saved);
 *  - a {@link FigmaArgsError} → a `VALIDATION_FAILED` isError result (bad `figma_to_*` target args);
 *  - a {@link FigmaClientError} → taxonomy-mapped isError: `config` (no `COMPOSIO_API_KEY`) →
 *    `CAPABILITY_MISSING`; `denied` (a write/non-allowlisted slug reached the client — a converter
 *    BUG, the §4 hard-deny) → `INTERNAL_ERROR`; transport/upstream failures → `UPSTREAM_ERROR`;
 *  - a {@link WpClientError} → `fromClientError` (isError vs protocol-throw);
 *  - any other error rethrows (the server core surfaces it).
 */
async function runConvert(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (error instanceof FigmaArgsError) {
      return toToolErrorResult(
        makeErrorPayload(ErrorCodes.VALIDATION_FAILED, error.message),
      ) as CallToolResult;
    }
    if (error instanceof FigmaClientError) {
      if (error.code === 'config') {
        return toToolErrorResult(
          makeErrorPayload(ErrorCodes.CAPABILITY_MISSING, error.message, {
            meta: { capability: 'COMPOSIO_API_KEY' },
          }),
        ) as CallToolResult;
      }
      if (error.code === 'denied') {
        // A write/non-allowlisted slug reached the client — a converter BUG (§4 hard-deny).
        return toToolErrorResult(
          makeErrorPayload(ErrorCodes.INTERNAL_ERROR, error.message),
        ) as CallToolResult;
      }
      return toToolErrorResult(
        makeErrorPayload(ErrorCodes.UPSTREAM_ERROR, `Composio/Figma upstream: ${error.message}`, {
          meta: { body_excerpt: error.message.slice(0, 300) },
        }),
      ) as CallToolResult;
    }
    if (error instanceof ConvertCapabilityError) {
      return toToolErrorResult(
        makeErrorPayload(ErrorCodes.CAPABILITY_MISSING, error.message, {
          meta: { capability: 'elementor_global_classes_update_class' },
        }),
      ) as CallToolResult;
    }
    if (error instanceof ConvertIntegrityError) {
      const payload = makeErrorPayload(
        ErrorCodes.VALIDATION_FAILED,
        `Conversion failed the contract-17 §1 integrity invariants (a CONVERTER bug, not a content ` +
          `problem) — NOTHING was saved (no dry_run, no kit write, no page). ` +
          `${String(error.violations.length)} violation(s).`,
        {
          meta: {
            errors: error.violations.map((v) => ({
              code: ErrorCodes.VALIDATION_FAILED,
              message: `[${v.invariant}] ${v.detail}`,
            })),
          },
        },
      );
      const result = toToolErrorResult(payload);
      // The full discriminated violations ride the structured payload for a fixing agent.
      result.structuredContent = {
        ...(result.structuredContent ?? {}),
        integrity: error.violations,
      };
      return result as CallToolResult;
    }
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── coverage-report wire mapping (§1.9) ──────────────────────────── */

/**
 * Map the internal {@link CoverageReport} (WP-F03 key names `pct_native`/`element_id`/`severity:'warning'
 * |'blocker'`) to the §1.9 tool WIRE shape (`native_pct`/`node_id`/`severity:'warn'|'block'`). The §1.9
 * tool report shape is authoritative for the catalog (catalog/schemas/convert.ts §0.1).
 */
function toWireReport(report: CoverageReport): Record<string, unknown> {
  return {
    coverage: {
      native_pct: report.coverage.pct_native,
      class_pct: report.coverage.pct_local_or_global_class,
      custom_css_pct: report.coverage.pct_custom_css,
      dropped_pct: report.coverage.pct_dropped,
    },
    fallbacks: report.fallbacks.map((f) => ({
      node_id: f.element_id,
      declaration: f.reason,
      tier: f.tier,
    })),
    a11y: report.a11y.map((a) => ({
      node_id: a.element_id,
      rule: a.rule,
      severity: a.severity === 'blocker' ? 'block' : 'warn',
      message: a.message,
    })),
    stripped_text: report.stripped_text.map((s) => ({
      node_id: s.element_id,
      tags: s.stripped_tags,
    })),
    // Behavior-conversion coverage (contract 16 §6/§7) — ADDITIVE optional, the contract-16 frozen
    // shape IS the wire shape (no §1.9 key renames apply). Omitted when zero behaviors were detected
    // (§8 invariant 5: zero-behavior reports stay byte-identical to pre-contract-16 output).
    ...(report.behavior !== undefined ? { behavior: report.behavior } : {}),
  };
}

/** Cast the authoring `ElementNode[]` to the loose REST shape the catalog `elements` outputSchema uses. */
function toWireElements(elements: ElementNode[]): RestElementNode[] {
  return elements as unknown as RestElementNode[];
}

/** Map proposed variables to the §1.9 wire shape (`{type,label,value}` — identical, defensive copy). */
function toWireVariables(vars: ProposedVariable[]): Array<Record<string, unknown>> {
  return vars.map((v) => ({ type: v.type, label: v.label, value: v.value }));
}

/** Map proposed classes to the §1.9 wire `globalClassObjectSchema` shape (id/type/label/variants). */
function toWireClasses(classes: GlobalClassObject[]): Array<Record<string, unknown>> {
  return classes.map((c) => ({ id: c.id, type: c.type, label: c.label, variants: c.variants }));
}

/* ───────────────────────────── elementor.convert.html_to_tree (§1.9) ────────────────────────── */

/**
 * `elementor.convert.html_to_tree` handler (★, `readOnlyHint`). Runs the pipeline stages 1-9 (parse..
 * coverage) and returns `{elements, proposed_classes, proposed_variables, report}`. Persists NOTHING —
 * the only REST it makes are READ-only proxied probes (breakpoints/styles/capabilities + existing
 * classes/variables) to drive style classification + hoisting (still `readOnlyHint:true`, §Impl Notes).
 */
export async function convertHtmlToTreeHandler(
  args: HtmlToTreeArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runConvert(async () => {
    const ports = buildPorts(ctx);
    // The Tier-3 JS confirm (contract 16 §0.4/§5): `include_js:'bundle'` requires an elicitation
    // confirm even on this read-only tool (the returned tree is persistable as-is, so bundled
    // script bytes would otherwise land in a page unconfirmed). A decline proceeds WITHOUT JS.
    const jsConfirmer = async (prompt: string): Promise<boolean> => {
      const outcome = await ctx.elicit(prompt);
      return outcome.confirmed;
    };
    const build = await htmlToTree(args, ports, jsConfirmer);
    const { result } = build;
    const structured = {
      elements: toWireElements(result.elements),
      proposed_classes: toWireClasses(result.proposed_classes),
      proposed_variables: toWireVariables(result.proposed_variables),
      report: toWireReport(result.report),
      ...(result.js_passthrough !== undefined ? { js_passthrough: result.js_passthrough } : {}),
      ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
      // Contract 17 additive carriers: the #9 font-carry partition + the §1 soft (I2/I4) integrity
      // violations (I1/I3 hard-fail in runConvert — never on a success result).
      ...(result.fonts !== undefined ? { fonts: result.fonts } : {}),
      ...(result.integrity !== undefined ? { integrity: result.integrity } : {}),
      // Contract 18 §7 detection honesty: report-level undetectable-class notes (rAF count-ups).
      ...(result.undetectable_classes !== undefined
        ? { undetectable_classes: result.undetectable_classes }
        : {}),
    };
    return okResult(
      structured,
      `Converted HTML → ${result.elements.length} top-level element(s); ` +
        `${result.proposed_classes.length} proposed class(es), ${result.proposed_variables.length} ` +
        `proposed variable(s); ${result.report.coverage.pct_native.toFixed(1)}% native coverage. ` +
        `NOTHING was saved (preview only). The tree is persistable as-is (placeholders resolved to ` +
        `real ids, base breakpoints normalized to 'desktop'); if you save it yourself, first create ` +
        `each proposed_classes entry via the design classes upsert under its EXACT id (the tree ` +
        `references those ids) and create proposed_variables, or those references will not style.`,
    );
  });
}

/* ───────────────────────────── elementor.convert.html_to_page (§1.9) ────────────────────────── */

/**
 * `elementor.convert.html_to_page` handler (★, `destructiveHint`; NEVER auto-commits). Builds the
 * confirmer over `ctx.elicit` (a destructive-op confirm round-trip; a non-elicitation client safely
 * declines), runs the commit-gated orchestrator, and maps the outcome to the MCP surface:
 *  - `preview`     → success result (`committed:false`, authoritative dry_run diff);
 *  - `gate_denied` → success result (`committed:false`) carrying the gate reasons (NOT an error);
 *  - `declined`    → a CLEAN non-error result (`declinedResult`, §5.5);
 *  - `invalid`     → an isError result with the structured dry_run `errors[]` (§5.2; save NOT attempted);
 *  - `committed`   → success result (`committed:true`, honest `css_primed`).
 *
 * `confirm:true` in the args is a documented escape so an automated caller can pre-confirm; we still run
 * the elicitation when `confirm` is not pre-set so an interactive client always sees the gate.
 */
export async function convertHtmlToPageHandler(
  args: HtmlToPageArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runConvert(async () => {
    const ports = buildPorts(ctx);

    // The confirmer: if the args already carry `confirm:true`, honor it (pre-confirmed automation);
    // otherwise run the MCP elicitation round-trip (a decline → a clean non-error result downstream).
    const confirmer = async (prompt: string): Promise<boolean> => {
      if (args.confirm === true) {
        return true;
      }
      const outcome = await ctx.elicit(prompt);
      return outcome.confirmed;
    };

    const result = await htmlToPage(args, ports, confirmer);

    // Decline → a clean non-error result WITH a schema-valid structured payload (M-b; SDK 1.29
    // -32602s a structured-content-less result on a tool with an outputSchema).
    if (result.status === 'declined') {
      return declinedResult(
        'Conversion cancelled at the commit confirmation; no page was created/replaced and no ' +
          'classes/variables/media were written.',
        {
          ...(result.id !== undefined ? { id: result.id } : {}),
          diff: result.diff,
          preview_url: result.preview_url,
          report: toWireReport(result.report),
          committed: false,
          css_primed: false,
        },
      );
    }

    // dry_run invalid → isError with the structured errors (the save was NOT attempted).
    if (result.status === 'invalid') {
      // Map the loose REST validation errors (PHP `code:string` + `path`) into the typed
      // VALIDATION_FAILED meta error shape (12-error-taxonomy.md §3.1). The PHP codes are taxonomy
      // codes at the wire; the cast at this single seam keeps the structured payload faithful.
      const metaErrors = (result.errors ?? []).map((e) => ({
        code: e.code as unknown as (typeof ErrorCodes)[keyof typeof ErrorCodes],
        message: e.message,
        ...(e.path !== undefined ? { prop: e.path } : {}),
      }));
      const payload = makeErrorPayload(
        ErrorCodes.VALIDATION_FAILED,
        `The converted tree failed authoritative validation; NOTHING was written — no page save, ` +
          `and no classes/variables were created (the dry_run runs before any kit write). ` +
          `${result.errors?.length ?? 0} error(s).`,
        { meta: { errors: metaErrors } },
      );
      const errResult = toToolErrorResult(payload);
      // Carry the report + diff alongside the error so the agent can act without a second call.
      errResult.structuredContent = {
        ...(errResult.structuredContent ?? {}),
        committed: false,
        css_primed: false,
        report: toWireReport(result.report),
      };
      return errResult;
    }

    // Build the success structured payload (preview / gate_denied / committed all share the shape).
    const structured: Record<string, unknown> = {
      ...(result.id !== undefined ? { id: result.id } : {}),
      diff: result.diff,
      preview_url: result.preview_url,
      report: toWireReport(result.report),
      committed: result.committed,
      css_primed: result.css_primed,
      ...(result.gate_reasons !== undefined ? { gate_reasons: result.gate_reasons } : {}),
      ...(result.duplicated_labels !== undefined
        ? { duplicated_labels: result.duplicated_labels }
        : {}),
      ...(result.idempotent_replay === true ? { idempotent_replay: true } : {}),
      // Contract 16 additive carriers: the Tier-3 script partition (§5), behavior-stage honesty
      // notes, and the §8.2 post-save interaction-survival checks (committed path only).
      ...(result.js_passthrough !== undefined ? { js_passthrough: result.js_passthrough } : {}),
      ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
      ...(result.interactions_post_save !== undefined
        ? { interactions_post_save: result.interactions_post_save }
        : {}),
      // Contract 17 additive carriers: #9 font carry, §1 soft integrity violations, and the §2–3
      // post-save verification (committed path; absent = the loop could not run, see warnings).
      ...(result.fonts !== undefined ? { fonts: result.fonts } : {}),
      ...(result.integrity !== undefined ? { integrity: result.integrity } : {}),
      ...(result.verification !== undefined ? { verification: result.verification } : {}),
      // Contract 18 §7 detection honesty: report-level undetectable-class notes (rAF count-ups).
      ...(result.undetectable_classes !== undefined
        ? { undetectable_classes: result.undetectable_classes }
        : {}),
    };

    // GATE LOCK (contract 17 §3): mark the page quarantined when the verify gate FAILED so the
    // WP-side publish lock refuses to make it live from ANY source (core REST, wp-admin, MCP);
    // clear it on a passing conversion. Best-effort — a marker failure must not fail the convert.
    if (result.status === 'committed' && result.id !== undefined) {
      const v = result.verification;
      const failed =
        v !== undefined &&
        (v.gate.pass === false ||
          v.gate.action === 'reverted_to_draft' ||
          v.gate.action === 'revert_failed');
      try {
        await ctx.wp.client.setQuarantine(
          result.id,
          failed,
          failed ? (v?.gate.reasons ?? ['verify gate failed']).join('; ').slice(0, 200) : undefined,
        );
      } catch {
        /* best-effort marker; the conversion result is unaffected */
      }
    }

    // Trim the two heavy arrays so the result FITS INLINE. A real conversion's full divergence
    // list (1327 entries) + diff changes bloated the result to ~337KB → the SDK offloaded it to a
    // file → the agent burned ~35 turns jq-ing it and never read the gate/pixel scores sitting in
    // it. A sample is enough to act on; the TRUE total survives in verification.cause_stats.total.
    const DIVERGENCE_SAMPLE = 20;
    const CHANGE_SAMPLE = 30;
    const v0 = result.verification as { divergences?: unknown[] } | undefined;
    if (v0 && Array.isArray(v0.divergences) && v0.divergences.length > DIVERGENCE_SAMPLE) {
      structured['verification'] = {
        ...(structured['verification'] as Record<string, unknown>),
        divergences: v0.divergences.slice(0, DIVERGENCE_SAMPLE),
      };
    }
    const d0 = result.diff as { changes?: unknown[] } | undefined;
    if (d0 && Array.isArray(d0.changes) && d0.changes.length > CHANGE_SAMPLE) {
      structured['diff'] = { ...(structured['diff'] as Record<string, unknown>), changes: d0.changes.slice(0, CHANGE_SAMPLE) };
    }

    return okResult(structured, summarizeHtmlToPage(result));
  });
}

/**
 * Per-breakpoint pixel-fidelity line, stated so the agent CANNOT misread it (a prior run relabeled
 * the diff ratio as "match", inverted which breakpoint failed, and called the page "excellent" off
 * the single best breakpoint). `ratio` is a DIFFERENCE (lower=better); we report `match% = 1−ratio`
 * for every breakpoint AND name the WORST one explicitly so it can never be omitted.
 */
function pixelFidelityText(
  v: import('../convert/pipeline.js').ConvertVerification,
): string {
  const scored = (v.pixel_scores ?? []).filter(
    (p): p is { breakpoint: string; ratio: number } => typeof p.ratio === 'number',
  );
  if (scored.length === 0) return '';
  const parts = scored.map(
    (p) => `${p.breakpoint} ${((1 - p.ratio) * 100).toFixed(1)}% match (diff ${(p.ratio * 100).toFixed(1)}%)`,
  );
  const worst = scored.reduce((a, b) => (b.ratio > a.ratio ? b : a), scored[0]!);
  return (
    ` Pixel fidelity [diff% = lower is better]: ${parts.join(', ')}. ` +
    `WORST breakpoint = ${worst.breakpoint} (${((1 - worst.ratio) * 100).toFixed(1)}% match) — report this one, not just desktop.`
  );
}

/** A compact human-readable summary line for the `html_to_page` outcome. */
function summarizeHtmlToPage(result: {
  status: string;
  committed: boolean;
  css_primed: boolean;
  id?: number;
  preview_url?: string;
  gate_reasons?: string[];
  report: CoverageReport;
  verification?: import('../convert/pipeline.js').ConvertVerification;
}): string {
  if (result.status === 'gate_denied') {
    return (
      `Refused to commit: the conversion did not pass the commit gate. ` +
      `${(result.gate_reasons ?? []).join(' ')} Coverage ${result.report.coverage.pct_native.toFixed(1)}% native. ` +
      `Nothing was saved — review the report and lower coverage_gate explicitly or fix the source.`
    );
  }
  if (result.status === 'committed') {
    const v = result.verification;
    const verifyLine =
      v === undefined
        ? ' Post-save verification did NOT run (see warnings) — verify the page manually.'
        : v.gate.pass
          ? ` Verified (contract 17): ${String(v.gate.divergence_count)} divergence(s), ` +
            `${String(v.repairs.applied.length)} repair(s) applied, gate PASS.` +
            pixelFidelityText(v)
          : ` VERIFICATION GATE FAILED (${String(v.gate.divergence_count)} divergences vs threshold ` +
            `${String(v.gate.threshold)}): ${v.gate.reasons.join(' ')}` +
            pixelFidelityText(v) +
            (v.gate.action === 'reverted_to_draft'
              ? ' The page was reverted to DRAFT and is QUARANTINED — it cannot be published until a ' +
                'conversion passes the gate (do NOT try to force it live).'
              : v.gate.action === 'revert_failed'
                ? ' AND THE DRAFT REVERT FAILED — the page is PUBLICLY VISIBLE; set it to draft manually.'
                : '');
    return (
      `Committed conversion → page ${String(result.id)}. ` +
      `${result.css_primed ? 'Atomic CSS primed.' : 'WARNING: CSS prime did NOT confirm — re-run prime-css (CSS may be missing on the front end).'}` +
      verifyLine +
      (result.preview_url ? ` Preview: ${result.preview_url}` : '')
    );
  }
  // preview
  return (
    `Preview only (commit:false) — NOTHING saved. Coverage ${result.report.coverage.pct_native.toFixed(1)}% native. ` +
    `Re-run with commit:true (and confirm) to persist.`
  );
}

/* ───────────────────────────── elementor.convert.fidelity_check (§1.9) ──────────────────────── */

/**
 * `elementor.convert.fidelity_check` handler (non-★, `readOnlyHint`). Renders the SAVED+PRIMED page vs
 * the source HTML at the requested (or all active) breakpoints via the WP-H10 visual diff (reusing the
 * WP-H03 browser pool) and returns `{score, deltas}`. A Chromium-unavailable throw rethrows so the
 * server core surfaces it (the gate cannot run without a browser).
 */
export async function convertFidelityCheckHandler(
  args: FidelityCheckArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runConvert(async () => {
    const ports = buildPorts(ctx);
    const result = await runFidelityCheck(args, ports);
    return okResult(
      { score: result.score, deltas: result.deltas },
      `Fidelity score ${(result.score * 100).toFixed(1)}% pixel diff (lower is better) across ` +
        `${result.deltas.length} breakpoint(s).`,
    );
  });
}

/* ───────────────────────────── elementor.convert.figma_to_tree (contract 18 §6) ─────────────── */

/** Build the wire structured payload shared by the figma handlers (tree shape + the figma block). */
function figmaTreeStructured(build: FigmaTreeBuild): Record<string, unknown> {
  const { result } = build;
  return {
    elements: toWireElements(result.elements),
    proposed_classes: toWireClasses(result.proposed_classes),
    proposed_variables: toWireVariables(result.proposed_variables),
    report: toWireReport(result.report),
    ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
    ...(result.fonts !== undefined ? { fonts: result.fonts } : {}),
    ...(result.integrity !== undefined ? { integrity: result.integrity } : {}),
    ...(result.undetectable_classes !== undefined
      ? { undetectable_classes: result.undetectable_classes }
      : {}),
    figma: build.figma,
  };
}

/**
 * `elementor.convert.figma_to_tree` handler (non-★, `readOnlyHint` — same documented exception as
 * `html_to_tree`: media sideloads during convert are the only writes, F3). Fetches the frame to the
 * §7 work dir (or RESUMES from its manifest), runs figma-parse + the SHARED stage run, and returns
 * the §1.9-shaped tree payload + the §6 `figma` block. NO page persistence.
 */
export async function convertFigmaToTreeHandler(
  args: FigmaToTreeArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runConvert(async () => {
    const ports = buildPorts(ctx);
    const build = await figmaToTree(args, ports);
    const f = build.figma;
    return okResult(
      figmaTreeStructured(build),
      `Converted Figma frame "${f.frame.name}" (${String(f.frame.width)}×${String(f.frame.height)}, ` +
        `${f.resumed === true ? 'RESUMED from' : 'fetched to'} ${f.work_dir ?? 'work dir'}) → ` +
        `${build.result.elements.length} top-level element(s); ${f.flattened.length} subtree(s) ` +
        `flattened (§3), responsive: ${f.responsive}; ` +
        `${build.result.report.coverage.pct_native.toFixed(1)}% native coverage. NOTHING was saved ` +
        `(preview only). The tree is persistable as-is; create each proposed class/variable under ` +
        `its EXACT id first (same rule as html_to_tree).`,
    );
  });
}

/* ───────────────────────────── elementor.convert.figma_to_page (contract 18 §6) ─────────────── */

/**
 * `elementor.convert.figma_to_page` handler (non-★, `destructiveHint`; NEVER auto-commits —
 * `commit:false` default, the gate + elicitation confirm + the contract-17 verify loop with the R3
 * draft-gate all apply through the SHARED persist path). The verify ground truth is the Figma frame
 * render PNG (F4); the §6 `figma` block rides every outcome that has a tree build.
 */
export async function convertFigmaToPageHandler(
  args: FigmaToPageArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runConvert(async () => {
    const ports = buildPorts(ctx);
    const confirmer = async (prompt: string): Promise<boolean> => {
      if (args.confirm === true) {
        return true;
      }
      const outcome = await ctx.elicit(prompt);
      return outcome.confirmed;
    };

    const result = await figmaToPage(args, ports, confirmer);
    const figmaExtra = result.figma !== undefined ? { figma: result.figma } : {};

    if (result.status === 'declined') {
      return declinedResult(
        'Conversion cancelled at the commit confirmation; no page was created/replaced and no ' +
          'classes/variables/media were written.',
        {
          ...(result.id !== undefined ? { id: result.id } : {}),
          diff: result.diff,
          preview_url: result.preview_url,
          report: toWireReport(result.report),
          committed: false,
          css_primed: false,
          ...figmaExtra,
        },
      );
    }

    if (result.status === 'invalid') {
      const metaErrors = (result.errors ?? []).map((e) => ({
        code: e.code as unknown as (typeof ErrorCodes)[keyof typeof ErrorCodes],
        message: e.message,
        ...(e.path !== undefined ? { prop: e.path } : {}),
      }));
      const payload = makeErrorPayload(
        ErrorCodes.VALIDATION_FAILED,
        `The converted tree failed authoritative validation; NOTHING was written — no page save, ` +
          `and no classes/variables were created (the dry_run runs before any kit write). ` +
          `${result.errors?.length ?? 0} error(s).`,
        { meta: { errors: metaErrors } },
      );
      const errResult = toToolErrorResult(payload);
      errResult.structuredContent = {
        ...(errResult.structuredContent ?? {}),
        committed: false,
        css_primed: false,
        report: toWireReport(result.report),
        ...figmaExtra,
      };
      return errResult;
    }

    const structured: Record<string, unknown> = {
      ...(result.id !== undefined ? { id: result.id } : {}),
      diff: result.diff,
      preview_url: result.preview_url,
      report: toWireReport(result.report),
      committed: result.committed,
      css_primed: result.css_primed,
      ...(result.gate_reasons !== undefined ? { gate_reasons: result.gate_reasons } : {}),
      ...(result.duplicated_labels !== undefined
        ? { duplicated_labels: result.duplicated_labels }
        : {}),
      ...(result.idempotent_replay === true ? { idempotent_replay: true } : {}),
      ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
      ...(result.interactions_post_save !== undefined
        ? { interactions_post_save: result.interactions_post_save }
        : {}),
      ...(result.fonts !== undefined ? { fonts: result.fonts } : {}),
      ...(result.integrity !== undefined ? { integrity: result.integrity } : {}),
      ...(result.verification !== undefined ? { verification: result.verification } : {}),
      ...(result.undetectable_classes !== undefined
        ? { undetectable_classes: result.undetectable_classes }
        : {}),
      ...figmaExtra,
    };

    return okResult(structured, summarizeHtmlToPage(result));
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ─────────────────── */

/**
 * Attach every convert handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Acceptance).
 * The spine (`server.ts` a0) invokes this. The registry stores handlers under its loose
 * `(args) => unknown` type; the runtime invokes them as `(args, ctx)`.
 */
export function attachConvertHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [CONVERT_HTML_TO_TREE]: (args, ctx) => convertHtmlToTreeHandler(args as HtmlToTreeArgs, ctx),
    [CONVERT_HTML_TO_PAGE]: (args, ctx) => convertHtmlToPageHandler(args as HtmlToPageArgs, ctx),
    [CONVERT_FIDELITY_CHECK]: (args, ctx) =>
      convertFidelityCheckHandler(args as FidelityCheckArgs, ctx),
    [CONVERT_FIGMA_TO_TREE]: (args, ctx) => convertFigmaToTreeHandler(args as FigmaToTreeArgs, ctx),
    [CONVERT_FIGMA_TO_PAGE]: (args, ctx) => convertFigmaToPageHandler(args as FigmaToPageArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
