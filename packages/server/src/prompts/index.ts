/**
 * WP-T13 — the NON-Pro MCP prompt barrel (13-tool-catalog.md §3).
 *
 * Owns the registration of the three NON-Pro prompts — `build-from-brief`, `html-to-native`,
 * `design-system-audit` — whose handlers steer the agent through the correct tool sequence + the LOCKED
 * safety flows. The fourth catalog prompt (the Pro theme-builder one) is Pro-oriented and owned by
 * WP-R07 in its own leaf module; it self-attaches by name via the Pro barrel the server core wires (the
 * same disjoint pattern as the Pro tool barrel). This module MUST NOT import or reference the Pro prompt
 * module — ownership stays disjoint and this barrel is never edited to add it.
 *
 * Pattern (matches the per-leaf `register<X>Prompt(registry)` convention WP-R07 reuses): each non-Pro
 * leaf exports a `register<X>Prompt(registry)` that calls `registry.attachHandler(name, handler)` by
 * the EXACT WP-F04 descriptor name (catalog/prompts.ts §3); `registerNonProPrompts(registry)` invokes
 * all three so their attach side-effects run together. Handlers attach BY NAME, so adding the Pro prompt
 * never requires touching this file. All four descriptors (incl. the Pro one) live in WP-F04
 * `catalog/prompts.ts`; this barrel only wires the three non-Pro HANDLERS.
 *
 * The argument schemas are owned by WP-F04 (STRING args, §3); the handlers here read those strings and
 * the emitted plan instructs the agent to pass PARSED numeric/bool values to tools (the handler never
 * coerces). Prompts are pure text-plan generators — NO writes, NO tool calls inside the handler.
 */

import type { PromptHandler } from '../runtime/index.js';

import { registerBuildFromBriefPrompt, BUILD_FROM_BRIEF_PROMPT_NAME } from './build-from-brief.js';
import { registerHtmlToNativePrompt, HTML_TO_NATIVE_PROMPT_NAME } from './html-to-native.js';
import {
  registerDesignSystemAuditPrompt,
  DESIGN_SYSTEM_AUDIT_PROMPT_NAME,
} from './design-system-audit.js';

/* ───────────────────────────── prompt registry seam ───────────────────────────────────────── */

/**
 * The minimal prompt-handler registry the leaf modules attach to (the prompt analogue of WP-F04's tool
 * `ToolRegistry.attachHandler`). The server core resolves the attached {@link PromptHandler} by the
 * WP-F04 descriptor name at `registerPrompt` time. Kept structural so WP-R07's Pro barrel reuses the
 * exact same shape without a shared concrete class.
 */
export interface PromptRegistry {
  /** Attach a prompt handler by its EXACT WP-F04 descriptor name (catalog/prompts.ts §3). */
  attachHandler(name: string, handler: PromptHandler): void;
}

/** The three NON-Pro prompt names this barrel wires (the EXACT WP-F04 descriptor names, §3). */
export const NON_PRO_PROMPT_NAMES: readonly string[] = [
  BUILD_FROM_BRIEF_PROMPT_NAME,
  HTML_TO_NATIVE_PROMPT_NAME,
  DESIGN_SYSTEM_AUDIT_PROMPT_NAME,
] as const;

/**
 * Attach the three NON-Pro prompt handlers (`build-from-brief`, `html-to-native`,
 * `design-system-audit`) to the registry by their EXACT WP-F04 descriptor names. The Pro theme-builder
 * prompt is NOT attached here — it is owned by WP-R07 and self-attaches via the Pro barrel (disjoint
 * ownership).
 */
export function registerNonProPrompts(registry: PromptRegistry): void {
  registerBuildFromBriefPrompt(registry);
  registerHtmlToNativePrompt(registry);
  registerDesignSystemAuditPrompt(registry);
}

/* Re-export the leaf handlers + names (the server core / tests resolve handlers by these names). */
export {
  BUILD_FROM_BRIEF_PROMPT_NAME,
  buildFromBriefHandler,
  registerBuildFromBriefPrompt,
} from './build-from-brief.js';
export {
  HTML_TO_NATIVE_PROMPT_NAME,
  htmlToNativeHandler,
  registerHtmlToNativePrompt,
} from './html-to-native.js';
export {
  DESIGN_SYSTEM_AUDIT_PROMPT_NAME,
  designSystemAuditHandler,
  registerDesignSystemAuditPrompt,
} from './design-system-audit.js';
