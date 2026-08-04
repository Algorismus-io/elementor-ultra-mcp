/**
 * WP-T13 — `design-system-audit` prompt handler (13-tool-catalog.md §3, "Audit the design system").
 *
 * Emits a plan that READS the design system — global classes, V4 variables, and V3 global colors — then
 * flags the 1000-item global-classes budget proximity + duplicate labels, and proposes CONSOLIDATING
 * via `elementor.design.classes.upsert` (diff-PUT, budget-aware) / `elementor.design.variables.batch`
 * (13-tool-catalog.md §3, §1 design tools; the 1000-item budget is enforced by PHP, RESEARCH.md §2.2).
 * Pure text-plan generator — NO writes, NO tool calls inside the handler (§Detailed Requirements 5).
 *
 * Argument schema is owned by WP-F04 (catalog/prompts.ts §3): `{ scope? }` — a STRING `classes |
 * variables | all`. `scope` narrows which lists to read; the handler reads the string and the plan
 * adapts (the handler does not coerce).
 */

import type { PromptHandler } from '../runtime/index.js';
import type { PromptRegistry } from './index.js';

/** The frozen prompt name (13-tool-catalog.md §3). Must match the WP-F04 descriptor name exactly. */
export const DESIGN_SYSTEM_AUDIT_PROMPT_NAME = 'design-system-audit';

/** Tool names the plan references — EXACT Contract 13 §1 design identifiers (a misspelling violates §4.1). */
const TOOL_CLASSES_LIST = 'elementor.design.classes.list';
const TOOL_VARIABLES_LIST = 'elementor.design.variables.list';
const TOOL_GLOBAL_COLORS_LIST = 'elementor.design.globalColors.list';
const TOOL_CLASSES_UPSERT = 'elementor.design.classes.upsert';
const TOOL_VARIABLES_BATCH = 'elementor.design.variables.batch';

/** The global-classes budget ceiling PHP enforces (RESEARCH.md §2.2 / §5.4; flagged on proximity). */
const GLOBAL_CLASSES_BUDGET = 1000;

/** Whether the requested scope includes classes (`classes` or `all` / unset). */
function includesClasses(scope: string | undefined): boolean {
  return scope === undefined || scope === '' || scope === 'all' || scope === 'classes';
}

/** Whether the requested scope includes variables + V3 globals (`variables` or `all` / unset). */
function includesVariables(scope: string | undefined): boolean {
  return scope === undefined || scope === '' || scope === 'all' || scope === 'variables';
}

/**
 * The `design-system-audit` handler. Returns a `GetPromptResult` (one user message) carrying the audit
 * plan. `scope` is an optional STRING (`classes | variables | all`) that narrows which lists to read.
 */
export const designSystemAuditHandler: PromptHandler = (args) => {
  const scope = args['scope'];
  const doClasses = includesClasses(scope);
  const doVariables = includesVariables(scope);

  const scopeLine =
    scope !== undefined && scope !== ''
      ? `Requested scope: \`${scope}\` — audit ${doClasses ? 'global classes' : ''}${doClasses && doVariables ? ' and ' : ''}${doVariables ? 'variables + V3 global colors' : ''}.`
      : `No scope specified — audit EVERYTHING (global classes, V4 variables, and V3 global colors).`;

  const steps: string[] = [];
  let step = 1;
  if (doClasses) {
    steps.push(
      `${step}. **Read global classes** — page through \`${TOOL_CLASSES_LIST}\` (use \`limit\`/\`cursor\` until \`next_cursor\` is null) to get every class \`id\` + \`label\`. Note the returned \`total\`.`,
    );
    step += 1;
  }
  if (doVariables) {
    steps.push(
      `${step}. **Read V4 variables** — page through \`${TOOL_VARIABLES_LIST}\` for every variable's \`label\`/\`type\`/\`value\`.`,
    );
    step += 1;
    steps.push(
      `${step}. **Read V3 global colors** — call \`${TOOL_GLOBAL_COLORS_LIST}\` for the classic global color palette (legacy globals coexist with V4 variables).`,
    );
    step += 1;
  }

  const flagsAndProposal = [
    `${step}. **Flag the problems:**`,
    doClasses
      ? `   - **Budget proximity** — global classes are capped at ${GLOBAL_CLASSES_BUDGET} per site (PHP pre-flights this budget on \`${TOOL_CLASSES_UPSERT}\`). Report the current count and how close it is to ${GLOBAL_CLASSES_BUDGET}; warn loudly as it approaches the ceiling, because further upserts will be rejected with \`BUDGET_EXCEEDED\`.`
      : '',
    `   - **Duplicate labels** — group classes (and variables/global colors) by \`label\`; list every label used more than once. Duplicates are the main source of bloat and ambiguity.`,
    doVariables
      ? `   - **Redundant values** — flag variables / global colors with identical values under different labels (consolidation candidates).`
      : '',
    `${step + 1}. **Propose consolidation (do NOT auto-apply):**`,
    doClasses
      ? `   - For duplicate/near-duplicate classes, propose a single \`${TOOL_CLASSES_UPSERT}\` diff-PUT that merges them (it is budget- + duplicate-label-aware; it builds the \`{changes, items, order}\` body). Present the merge plan to the user before applying.`
      : '',
    doVariables
      ? `   - For redundant variables, propose a single \`${TOOL_VARIABLES_BATCH}\` operation that consolidates them.`
      : '',
    `   - Summarize the proposed reduction (item count before → after) so the user can approve.`,
  ].filter((line) => line !== '');

  // Scope-respecting tool lists for the footer rule (so a narrowed scope never names out-of-scope tools).
  const readTools = [
    doClasses ? `\`${TOOL_CLASSES_LIST}\`` : '',
    doVariables ? `\`${TOOL_VARIABLES_LIST}\`` : '',
    doVariables ? `\`${TOOL_GLOBAL_COLORS_LIST}\`` : '',
  ]
    .filter((t) => t !== '')
    .join(' / ');
  const consolidateTools = [
    doClasses ? `\`${TOOL_CLASSES_UPSERT}\`` : '',
    doVariables ? `\`${TOOL_VARIABLES_BATCH}\`` : '',
  ]
    .filter((t) => t !== '')
    .join(' / ');

  const text = [
    `# Plan: audit the design system`,
    ``,
    scopeLine,
    ``,
    `This is a READ-then-PROPOSE audit. Read the current state, flag duplication + budget proximity, then PROPOSE consolidation — do not write anything until the user approves.`,
    ``,
    ...steps,
    ...flagsAndProposal,
    ``,
    `Rules: read via ${readTools}; flag the ${GLOBAL_CLASSES_BUDGET}-item budget + duplicate labels; propose consolidating with ${consolidateTools} (never auto-apply).`,
  ].join('\n');

  return Promise.resolve({
    messages: [{ role: 'user', content: { type: 'text', text } }],
  });
};

/**
 * Attach the `design-system-audit` handler to the prompt registry by its EXACT WP-F04 descriptor name.
 * Called by the non-Pro barrel (`registerNonProPrompts`).
 */
export function registerDesignSystemAuditPrompt(registry: PromptRegistry): void {
  registry.attachHandler(DESIGN_SYSTEM_AUDIT_PROMPT_NAME, designSystemAuditHandler);
}
