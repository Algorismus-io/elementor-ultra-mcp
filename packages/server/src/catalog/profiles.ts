/**
 * WP-F04 — lean ★ profile + `ULTRA_TOOLS` resolution (13-tool-catalog.md §5.2, §5.4).
 *
 * The lean profile is EXACTLY the 18 ★ tools listed in §5.2 (the catalog test asserts this against the
 * `star:true` descriptors). The meta-tool trio (`tools.list_endpoints`/`tools.get_schema`/
 * `tools.invoke`) is ALWAYS available regardless of profile (§5.2/§6). `ULTRA_TOOLS` resolution
 * (§5.4): `lean` (default) ⇒ only the ★ set + meta-trio enabled at boot; `full` ⇒ ALL tools enabled.
 *
 * This module is pure data + the resolver — the live `enable()`/`disable()` + `sendToolListChanged()`
 * wiring against the `McpServer` is WP-T01's; the bookkeeping hooks live in `registry.ts`.
 */

import { TOOL_DESCRIPTORS } from './tools.js';

/** The static-profile env value (13-tool-catalog.md §5.4). */
export type UltraToolsProfile = 'lean' | 'full';

/** The default profile when `ULTRA_TOOLS` is unset/invalid (§5.4). */
export const DEFAULT_PROFILE: UltraToolsProfile = 'lean';

/**
 * The lean ★ default set — EXACTLY the 18 tool names in 13-tool-catalog.md §5.2, in §5.2 order. This
 * literal is the frozen authority the catalog test cross-checks against the `star:true` descriptors.
 */
export const LEAN_STAR_TOOLS: readonly string[] = [
  'elementor.tools.search',
  'elementor.site.capabilities',
  'elementor.pages.list',
  'elementor.page.get_structure',
  'elementor.page.create',
  'elementor.page.build',
  'elementor.page.dry_run',
  'elementor.schema.widget',
  'elementor.schema.styles',
  'elementor.breakpoints.get',
  'elementor.widget.insert',
  'elementor.widget.update_settings',
  'elementor.design.classes.list',
  'elementor.design.classes.upsert',
  'elementor.design.variables.list',
  'elementor.media.sideload_url',
  'elementor.convert.html_to_tree',
  'elementor.convert.html_to_page',
] as const;

/** The exact ★ count (13-tool-catalog.md §5.2: "18 star tools"). */
export const LEAN_STAR_COUNT = 18;

/**
 * The always-available meta-trio (13-tool-catalog.md §5.2/§6) — enabled in BOTH profiles regardless of
 * the ★ set. Derived from the descriptors flagged `meta:true`.
 */
export const META_TOOLS: readonly string[] = TOOL_DESCRIPTORS.filter((t) => t.meta === true).map(
  (t) => t.name,
);

/**
 * Resolve the `ULTRA_TOOLS` env value to a profile (13-tool-catalog.md §5.4). Unset / unknown ⇒
 * {@link DEFAULT_PROFILE} (`lean`). Case-insensitive.
 *
 * @param raw The raw `process.env.ULTRA_TOOLS` value (or undefined).
 */
export function resolveProfile(raw: string | undefined): UltraToolsProfile {
  const normalized = (raw ?? '').trim().toLowerCase();
  return normalized === 'full' ? 'full' : 'lean';
}

/**
 * The set of tool names ENABLED at boot for a profile (13-tool-catalog.md §5.2/§5.4):
 *  - `lean` ⇒ the ★ set + the always-available meta-trio.
 *  - `full` ⇒ every tool in the catalog.
 *
 * The remaining (non-enabled) tools are registered then `disable()`d by WP-T01 and surfaced via
 * `tools.search` / `tools.list_endpoints` (§5.3). Returns a `Set` for O(1) membership.
 *
 * @param profile The resolved profile.
 */
export function enabledToolNamesForProfile(profile: UltraToolsProfile): Set<string> {
  const enabled =
    profile === 'full'
      ? new Set(TOOL_DESCRIPTORS.map((t) => t.name))
      : new Set<string>([...LEAN_STAR_TOOLS, ...META_TOOLS]);
  for (const name of retiredToolNames()) {
    enabled.delete(name);
  }
  return enabled;
}

/**
 * RETIRED tools — descriptors stay in the frozen catalog but the tools are NOT registered at boot and
 * never appear in any profile or in `tools.search` (product decision 2026-06-11: the one-shot Figma
 * converter is retired in favor of the agentic path — see the elementor-ultra skill's Figma recipe;
 * field scores: agentic 0.20-0.94% vs one-shot 7.63-20.13%). Re-enable for development only with
 * `ULTRA_FIGMA=1`.
 */
export const RETIRED_TOOLS: readonly string[] = [
  'elementor.convert.figma_to_tree',
  'elementor.convert.figma_to_page',
] as const;

/** The retired set effective under `env` (empty when `ULTRA_FIGMA=1` opts back in). */
export function retiredToolNames(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return env['ULTRA_FIGMA'] === '1' ? [] : RETIRED_TOOLS;
}

/**
 * The list of tools that should be `disable()`d at boot for a profile (the complement of
 * {@link enabledToolNamesForProfile}). WP-T01 calls `registry.disable(name)` for each (§5.3). `full`
 * ⇒ empty.
 *
 * @param profile The resolved profile.
 */
export function disabledToolNamesForProfile(profile: UltraToolsProfile): string[] {
  const enabled = enabledToolNamesForProfile(profile);
  return TOOL_DESCRIPTORS.filter((t) => !enabled.has(t.name)).map((t) => t.name);
}
