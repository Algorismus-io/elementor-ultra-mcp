/**
 * WP-R07 — `theme-builder-from-spec` prompt handler (the FOURTH, Pro-oriented MCP prompt,
 * 13-tool-catalog.md §3, "Build a theme-builder template from a spec").
 *
 * Emits a structured plan that steers the agent from a theme-builder brief to VALIDATED
 * `elementor.pro.theme.create` calls (one per template part) with explicit display `conditions`. The plan
 * is Pro-gated and schema-first:
 *  (a) probe `elementor.site.capabilities` FIRST and gate on `pro` active (the prompt requires Elementor
 *      Pro; if Pro is inactive, STOP and tell the user);
 *  (b) call `elementor.pro.theme.get_conditions_config` to enumerate the valid template types, locations,
 *      and condition keys/sub-conditions BEFORE authoring (never invent a condition `name`/`sub_name`);
 *  (c) author props schema-first via `elementor.schema.widget` / `elementor.schema.styles` (NEVER invent
 *      Elementor props, Contract 15 §2.6);
 *  (d) validate the element tree via `elementor.page.dry_run` (the AUTHORITATIVE validator); and
 *  (e) create each template part via `elementor.pro.theme.create` with explicit `conditions` (the
 *      `ConditionTuple` form `[type,name,sub_name?,sub_id?]`; conditions write slash-joined strings +
 *      regenerate cache server-side, SUPPLEMENT.md §A.1).
 *
 * Pure text-plan generator — NO writes, NO tool calls inside the handler (it never touches `ctx`). The
 * argument schema is owned by WP-F04 (catalog/prompts.ts §3): `{ spec, theme_type? }` — all STRINGS (MCP
 * prompt args are strings). The handler reads the strings; the emitted plan instructs the agent to pass
 * the values to the tools. References EXACT Contract 13 tool names (a misspelling violates §4.1).
 *
 * Ownership (§Implementation Notes "File split rationale"): this module exports
 * `registerThemeBuilderPrompt(registry)` which attaches the handler BY NAME via
 * `registry.attachHandler('theme-builder-from-spec', fn)` — so WP-T13's non-Pro `prompts/index.ts` barrel
 * is NEVER edited. It is collected by the Pro barrel the server core wires (the same disjoint pattern as
 * the Pro tool barrel).
 */

import type { PromptHandler } from '../runtime/index.js';
import type { PromptRegistry } from './index.js';

/** The frozen prompt name (13-tool-catalog.md §3). MUST match the WP-F04 descriptor name exactly. */
export const THEME_BUILDER_FROM_SPEC_PROMPT_NAME = 'theme-builder-from-spec';

/** Tool names the plan references — EXACT Contract 13 §1 identifiers (a misspelling violates §4.1). */
const TOOL_SITE_CAPABILITIES = 'elementor.site.capabilities';
const TOOL_GET_CONDITIONS_CONFIG = 'elementor.pro.theme.get_conditions_config';
const TOOL_SCHEMA_WIDGET = 'elementor.schema.widget';
const TOOL_SCHEMA_STYLES = 'elementor.schema.styles';
const TOOL_PAGE_DRY_RUN = 'elementor.page.dry_run';
const TOOL_THEME_CREATE = 'elementor.pro.theme.create';
const TOOL_THEME_SET_CONDITIONS = 'elementor.pro.theme.set_conditions';

/**
 * The `theme-builder-from-spec` handler. Returns a `GetPromptResult` (one user message) carrying the
 * Pro-gated, schema-first theme-builder plan. `spec` is required (WP-F04 descriptor); `theme_type` is an
 * optional STRING hint the plan threads through (narrows the parts to author). Pure — no `ctx` is used.
 */
export const themeBuilderFromSpecHandler: PromptHandler = (args) => {
  const spec = args['spec'] ?? '';
  const themeType = args['theme_type'];

  const themeTypeLine =
    themeType !== undefined && themeType !== ''
      ? `Requested template scope: \`${themeType}\`. Still confirm it is a valid \`type\` via step 2 (\`${TOOL_GET_CONDITIONS_CONFIG}\` + the 8 valid \`${TOOL_THEME_CREATE}\` types: header, footer, single-post, single-page, archive, search-results, error-404, section) before authoring; \`single\` is NOT a valid type.`
      : `No template scope specified — infer the needed parts (e.g. header, footer, single-post, archive) from the spec; confirm each is a valid \`type\` in step 2 before authoring.`;

  const text = [
    `# Plan: build a theme-builder template from a spec`,
    ``,
    `## Spec`,
    spec !== ''
      ? spec
      : '(no spec text was provided — ask the user for the theme-builder brief first)',
    ``,
    themeTypeLine,
    ``,
    `This prompt requires **Elementor Pro**. Follow these steps IN ORDER. Do NOT skip the Pro gate, the conditions-config lookup, the schema lookups, or the dry-run — they are how we stay Pro-gated, never invent conditions/props, and never ship an invalid tree.`,
    ``,
    `1. **Probe capabilities + GATE on Pro** — call \`${TOOL_SITE_CAPABILITIES}\` FIRST and read \`pro\`. If \`pro\` is NOT true, STOP: this prompt requires Elementor Pro to be installed and active — tell the user and do not proceed. Also read \`v4\`/\`atomic\` to choose the generation for the parts you author (V4 by default; fall back to V3 only when V4/atomic is unavailable — never assume a route or element type exists).`,
    `2. **Enumerate valid conditions BEFORE authoring** — call \`${TOOL_GET_CONDITIONS_CONFIG}\`. Read the returned \`tree\` (valid condition \`name\`/\`sub_name\` keys) and \`locations\`. Use these to validate/autocomplete every condition and to learn which sub-conditions take an id. NEVER invent a condition \`name\`/\`sub_name\` — if it is not in the tree, it is not valid. For a \`section\` template you MUST pass a \`location\` drawn from \`locations\`.`,
    `3. **Look up the schema BEFORE authoring any prop** (NEVER invent Elementor props, Contract 15 §2.6):`,
    `   - For every widget/element in each template part, call \`${TOOL_SCHEMA_WIDGET}\` to get its exact prop names, types, and required fields for the chosen generation.`,
    `   - For styling, call \`${TOOL_SCHEMA_STYLES}\` to get the atomic style-prop catalog (the only valid style keys). Author styles from this catalog only.`,
    `   - If a prop you want is not in the schema, it does not exist — pick a supported alternative; do not guess a key name.`,
    `4. **Dry-run to validate each part** — assemble the element tree for a template part, then call \`${TOOL_PAGE_DRY_RUN}\` with the proposed tree. This is the AUTHORITATIVE validator (PHP instantiates + validates). Read the returned \`ValidationError[]\` and fix every error; re-run until clean. Do NOT create the doc until the dry-run passes.`,
    `5. **Create each template part with explicit conditions** — once a part's dry-run is clean, call \`${TOOL_THEME_CREATE}\` with its \`type\`, \`title\`, validated \`elements\`, and an explicit \`conditions\` array. Each condition is a \`ConditionTuple\`: \`[type, name]\`, \`[type, name, sub_name]\`, or \`[type, name, sub_name, sub_id]\` where \`type\` is \`"include"\` or \`"exclude"\` and \`name\`/\`sub_name\` come from the step-2 tree. For a \`section\` doc also pass the \`location\`. Conditions are written as slash-joined strings and regenerate the conditions cache server-side — you do not slash-join them yourself.`,
    `6. **Adjust conditions later if needed** — to REPLACE the display conditions on an existing theme doc (e.g. after review), call \`${TOOL_THEME_SET_CONDITIONS}\` with the \`post_id\` and the full new \`conditions\` array (\`[]\` clears all). Pass \`check_conflicts: true\` to surface any conflicting templates before committing on single-instance locations (header/footer/single).`,
    ``,
    `Rules: Pro-gated (\`${TOOL_SITE_CAPABILITIES}\`.pro must be true); conditions come from \`${TOOL_GET_CONDITIONS_CONFIG}\` (never invented) in \`ConditionTuple\` form; props come from \`${TOOL_SCHEMA_WIDGET}\`/\`${TOOL_SCHEMA_STYLES}\` (never invented); always \`${TOOL_PAGE_DRY_RUN}\` before \`${TOOL_THEME_CREATE}\`; conditions write slash strings + regenerate the cache server-side.`,
  ].join('\n');

  return Promise.resolve({
    messages: [{ role: 'user', content: { type: 'text', text } }],
  });
};

/**
 * Attach the `theme-builder-from-spec` handler to the prompt registry by its EXACT WP-F04 descriptor
 * name. Attaches BY NAME so WP-T13's non-Pro `prompts/index.ts` barrel is never touched; the Pro barrel
 * the server core wires invokes this (the disjoint Pro-ownership pattern).
 */
export function registerThemeBuilderPrompt(registry: PromptRegistry): void {
  registry.attachHandler(THEME_BUILDER_FROM_SPEC_PROMPT_NAME, themeBuilderFromSpecHandler);
}
