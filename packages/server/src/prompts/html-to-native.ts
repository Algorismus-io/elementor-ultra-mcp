/**
 * WP-T13 — `html-to-native` prompt handler (13-tool-catalog.md §3, "Convert HTML to native Elementor").
 *
 * This is the USER-FACING GUARDRAIL for the most dangerous flow. It emits a plan that enforces the
 * LOCKED never-auto-commit sequence (13-tool-catalog.md §1.9 / §3; 01-architecture.md §7 "HTML never
 * auto-commits"; RESEARCH.md §6.8):
 *   1. `elementor.convert.html_to_tree` (preview — produces the tree + coverage/a11y/stripped-text report);
 *   2. REVIEW the report (coverage %, a11y blockers, dropped text);
 *   3. only if acceptable, `elementor.convert.html_to_page` with EXPLICIT `commit:true` + `confirm:true`.
 *
 * The converter NEVER auto-commits: `commit` / `confirm` default false (catalog/schemas/convert.ts), and
 * the tool refuses to commit below the coverage gate or with a11y blockers. The coverage gate is HONEST
 * and S3-anchored — read from `corpus.manifest.json` (auto-commit floor 60% per WP-S03), NEVER a
 * hardcoded 85% (RESEARCH.md §6.8 / spikes/SUMMARY.md WP-S03). Pure text-plan generator — NO writes, NO
 * tool calls inside the handler (§Detailed Requirements 5).
 *
 * Argument schema is owned by WP-F04 (catalog/prompts.ts §3): `{ html, css?, coverage_gate? }` — all
 * STRINGS. The plan instructs the agent to pass the parsed `coverage_gate` (a 0..1 number) to the tool;
 * the handler does NOT coerce.
 */

import type { PromptHandler } from '../runtime/index.js';
import type { PromptRegistry } from './index.js';

/** The frozen prompt name (13-tool-catalog.md §3). Must match the WP-F04 descriptor name exactly. */
export const HTML_TO_NATIVE_PROMPT_NAME = 'html-to-native';

/** Tool names the plan references — EXACT Contract 13 §1.9 identifiers (a misspelling violates §4.1). */
const TOOL_HTML_TO_TREE = 'elementor.convert.html_to_tree';
const TOOL_HTML_TO_PAGE = 'elementor.convert.html_to_page';

/**
 * The `html-to-native` handler. Returns a `GetPromptResult` (one user message) carrying the LOCKED
 * never-auto-commit conversion plan. `html` is required (WP-F04 descriptor); `css` / `coverage_gate` are
 * optional STRING args; the plan threads them through to the tools (the parsed `coverage_gate` 0..1
 * number is passed by the AGENT, not coerced here).
 */
export const htmlToNativeHandler: PromptHandler = (args) => {
  const html = args['html'] ?? '';
  const css = args['css'];
  const coverageGate = args['coverage_gate'];

  const cssLine =
    css !== undefined && css !== ''
      ? `Accompanying CSS was provided — pass it as \`css\` to both \`${TOOL_HTML_TO_TREE}\` and \`${TOOL_HTML_TO_PAGE}\`.`
      : `No separate CSS was provided — inline/embedded styles in the HTML will be used; pass \`css\` only if you have an external stylesheet.`;

  const gateLine =
    coverageGate !== undefined && coverageGate !== ''
      ? `A coverage_gate of \`${coverageGate}\` was requested — PARSE it to a number in [0,1] and pass it as \`coverage_gate\` to \`${TOOL_HTML_TO_PAGE}\` (the handler receives a string; you pass the parsed number).`
      : `No coverage_gate was specified — the tool applies the site's configured auto-commit floor (read from \`corpus.manifest.json\`, the S3-anchored value; do NOT assume a hardcoded percentage). Pass a parsed \`coverage_gate\` number in [0,1] only to override it.`;

  const text = [
    `# Plan: convert HTML to native Elementor (NEVER auto-commits)`,
    ``,
    `## Source HTML`,
    html !== ''
      ? '```html\n' + html + '\n```'
      : '(no HTML was provided — ask the user for the HTML first)',
    ``,
    cssLine,
    gateLine,
    ``,
    `**LOCKED SAFETY RULE: the converter NEVER auto-commits.** You MUST inspect the conversion report and then EXPLICITLY confirm before anything is written to the site. Follow these steps IN ORDER:`,
    ``,
    `1. **Preview (no write)** — call \`${TOOL_HTML_TO_TREE}\` with the HTML (and \`css\` if provided). This returns the proposed \`elements\` tree, \`proposed_classes\`, \`proposed_variables\`, and a \`report\` with:`,
    `   - \`coverage\`: \`native_pct\` / \`class_pct\` / \`custom_css_pct\` / \`dropped_pct\` (how much mapped to native props vs. fell back to custom CSS vs. was dropped);`,
    `   - \`a11y\`: accessibility findings with \`severity\` of \`warn\` or \`block\`;`,
    `   - \`stripped_text\`: text content that was removed;`,
    `   - \`fallbacks\`: per-declaration custom-CSS fallbacks.`,
    `2. **Review the report HONESTLY and report it to the user.** Coverage is a realistic band, not a guarantee — clean marketing sections land roughly 77 to 90 percent native (corpus average ~0.85), messy exported HTML lands ~60 to 75 percent (WP-S03). State the actual numbers. STOP and do NOT commit if:`,
    `   - any \`a11y\` finding has \`severity: "block"\`; or`,
    `   - the coverage is below the gate (your parsed \`coverage_gate\`, or the site's configured floor from \`corpus.manifest.json\` — NOT a hardcoded percentage); or`,
    `   - meaningful \`stripped_text\` would lose content the user wants.`,
    `   Fix the source HTML/CSS or adjust the gate and re-run step 1 as needed.`,
    `3. **Commit only after explicit confirmation** — once the report is acceptable AND the user has confirmed, call \`${TOOL_HTML_TO_PAGE}\` with the same \`html\`/\`css\`, the chosen \`generation\`, your parsed \`coverage_gate\`, and BOTH \`commit: true\` and \`confirm: true\` set EXPLICITLY. Without both flags the tool returns the report and refuses to write (its \`committed\` will be \`false\`). Report the returned \`preview_url\` and \`committed\` status.`,
    ``,
    `Rules: \`${TOOL_HTML_TO_TREE}\` first → review the report → \`${TOOL_HTML_TO_PAGE}\` with explicit \`commit:true\`+\`confirm:true\` ONLY. Never auto-commit; the coverage gate is honest and config-driven (read from \`corpus.manifest.json\`), never a hardcoded percentage.`,
  ].join('\n');

  return Promise.resolve({
    messages: [{ role: 'user', content: { type: 'text', text } }],
  });
};

/**
 * Attach the `html-to-native` handler to the prompt registry by its EXACT WP-F04 descriptor name.
 * Called by the non-Pro barrel (`registerNonProPrompts`).
 */
export function registerHtmlToNativePrompt(registry: PromptRegistry): void {
  registry.attachHandler(HTML_TO_NATIVE_PROMPT_NAME, htmlToNativeHandler);
}
