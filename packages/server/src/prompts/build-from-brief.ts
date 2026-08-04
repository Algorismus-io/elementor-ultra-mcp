/**
 * WP-T13 — `build-from-brief` prompt handler (13-tool-catalog.md §3, "Build a page from a brief").
 *
 * Emits a structured plan that steers the agent from a natural-language brief to a VALIDATED
 * `elementor.page.build` call. The plan is schema-first (look up `elementor.schema.widget` /
 * `elementor.schema.styles` BEFORE authoring any prop — NEVER invent Elementor props, Contract 15
 * §2.6), probes capabilities to choose V4-default / V3-fallback (RESEARCH.md §8 fallback ladder), and
 * validates via `elementor.page.dry_run` (the authoritative validator, 01-architecture.md §7) before the
 * write. Pure text-plan generator — NO writes, NO tool calls inside the handler (§Detailed
 * Requirements 5).
 *
 * Argument schema is owned by WP-F04 (catalog/prompts.ts §3): `{ brief, post_type?, generation? }` —
 * all STRINGS (MCP prompt args are strings). The handler reads the strings and the plan instructs the
 * agent to pass the parsed values to the tools; the handler itself does NOT coerce.
 */

import type { PromptHandler } from '../runtime/index.js';
import type { PromptRegistry } from './index.js';

/** The frozen prompt name (13-tool-catalog.md §3). Must match the WP-F04 descriptor name exactly. */
export const BUILD_FROM_BRIEF_PROMPT_NAME = 'build-from-brief';

/** Tool names the plan references — EXACT Contract 13 §1 identifiers (a misspelling violates §4.1). */
const TOOL_SITE_CAPABILITIES = 'elementor.site.capabilities';
const TOOL_SCHEMA_WIDGET = 'elementor.schema.widget';
const TOOL_SCHEMA_STYLES = 'elementor.schema.styles';
const TOOL_PAGE_DRY_RUN = 'elementor.page.dry_run';
const TOOL_PAGE_BUILD = 'elementor.page.build';

/**
 * The `build-from-brief` handler. Returns a `GetPromptResult` (one user message) carrying the schema-
 * first build plan. `brief` is required (WP-F04 descriptor); `post_type` / `generation` are optional
 * STRING args the plan threads through to the tools.
 */
export const buildFromBriefHandler: PromptHandler = (args) => {
  const brief = args['brief'] ?? '';
  const postType = args['post_type'];
  const generation = args['generation'];

  const postTypeLine =
    postType !== undefined && postType !== ''
      ? `Target post type: \`${postType}\` (pass it as the \`post_type\` arg on the final build call).`
      : `No post type specified — default to a \`page\` unless the brief implies otherwise; pass it as the \`post_type\` arg on the final build call.`;

  const generationLine =
    generation !== undefined && generation !== ''
      ? `Requested generation hint: \`${generation}\`. Still confirm it is supported via step 1 before using it; if unsupported, fall back per the ladder below.`
      : `No generation specified — choose V4 by default and fall back to V3 only when step 1 says V4/atomic is unavailable.`;

  const text = [
    `# Plan: build an Elementor page from a brief`,
    ``,
    `## Brief`,
    brief !== '' ? brief : '(no brief text was provided — ask the user for the page brief first)',
    ``,
    postTypeLine,
    generationLine,
    ``,
    `Follow these steps IN ORDER. Do NOT skip the schema lookups and the dry-run — they are how we avoid inventing props and shipping an invalid tree.`,
    ``,
    `1. **Probe capabilities** — call \`${TOOL_SITE_CAPABILITIES}\` FIRST. Read \`v4\`, \`atomic\`, \`global_classes\`, \`variables\`, the active \`experiments\`, and \`registered_types\`. This decides the generation:`,
    `   - **V4 by default**: if \`v4\` (and \`atomic\` for atomic widgets) is true, author V4/atomic elements.`,
    `   - **V3 fallback**: if V4/atomic is NOT available on this site, fall back to classic V3 widgets. Never assume a route or element type exists — capabilities is the source of truth.`,
    `2. **Look up the schema BEFORE authoring any prop** (NEVER invent Elementor props):`,
    `   - For every widget/element you plan to use, call \`${TOOL_SCHEMA_WIDGET}\` to get its exact prop names, types, and required fields for the chosen generation.`,
    `   - For styling, call \`${TOOL_SCHEMA_STYLES}\` to get the atomic style-prop catalog (the only valid style keys). Author styles from this catalog only.`,
    `   - If a prop you want is not in the schema, it does not exist — pick a supported alternative; do not guess a key name.`,
    `3. **Dry-run to validate** — assemble the element tree, then call \`${TOOL_PAGE_DRY_RUN}\` with the proposed tree. This is the AUTHORITATIVE validator (PHP instantiates + validates). Read the returned \`ValidationError[]\` and the structured diff; fix every error and re-run until it is clean. Do NOT build until the dry-run passes.`,
    `4. **Build** — once the dry-run is clean, call \`${TOOL_PAGE_BUILD}\` with the validated tree, the chosen \`generation\`, and \`${postType !== undefined && postType !== '' ? postType : 'the resolved'}\` post type. Report the returned \`base_hash\` and \`preview_url\` to the user.`,
    ``,
    `Rules: schema-first (props come from \`${TOOL_SCHEMA_WIDGET}\` / \`${TOOL_SCHEMA_STYLES}\`, never invented); V4-default with V3-fallback driven by \`${TOOL_SITE_CAPABILITIES}\`; always \`${TOOL_PAGE_DRY_RUN}\` before \`${TOOL_PAGE_BUILD}\`.`,
  ].join('\n');

  return Promise.resolve({
    messages: [{ role: 'user', content: { type: 'text', text } }],
  });
};

/**
 * Attach the `build-from-brief` handler to the prompt registry by its EXACT WP-F04 descriptor name.
 * Called by the non-Pro barrel (`registerNonProPrompts`).
 */
export function registerBuildFromBriefPrompt(registry: PromptRegistry): void {
  registry.attachHandler(BUILD_FROM_BRIEF_PROMPT_NAME, buildFromBriefHandler);
}
