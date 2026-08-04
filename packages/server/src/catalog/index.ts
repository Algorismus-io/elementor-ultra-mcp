/**
 * WP-F04 — public entry for the FROZEN MCP catalog (Seam A, 13-tool-catalog.md).
 *
 * Re-exports the tool/resource/prompt descriptors, the per-family zod schema modules, the lean ★
 * profile + `ULTRA_TOOLS` resolution, and the data-driven `ToolRegistry`. The server core (WP-T01)
 * imports the registry + profiles to register tools without editing per-tool files; vertical tool WPs
 * import only their family's schema module + `attachHandler` from the registry (§Implementation Notes:
 * "Keep schema modules import-light so a vertical WP pulls only its family").
 */

/* Tool / resource / prompt descriptors. */
export * from './tools.js';
export * from './resources.js';
export * from './prompts.js';

/* Lean ★ profile + ULTRA_TOOLS resolution. */
export * from './profiles.js';

/* The data-driven registry skeleton (enable/disable + listChanged bookkeeping; no handlers). */
export * from './registry.js';

/* Shared zod building blocks (pagination shape, authoring-type mirrors). */
export * as schemas from './schemas/shared.js';
