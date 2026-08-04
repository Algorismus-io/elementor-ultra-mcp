/**
 * WP-T01 — public entry for the server-core RUNTIME (the seam vertical WPs consume).
 *
 * Vertical tool / resource / prompt WPs import `ToolContext` / `ToolHandler` / `ResourceHandler` /
 * `PromptHandler` from here and `registry.attachHandler(name, fn)` (from WP-F04). This barrel re-exports
 * the runtime context + the surface controller + the capabilities cache + the elicitation helper. The
 * composition root (`buildServer`) lives in `../server.ts` and is re-exported here for the bin seam.
 */

export * from './context.js';
export * from './surface.js';
export * from './capabilities-cache.js';
export * from './elicit.js';
export { buildServer, main, type BuildServerDeps, type BuiltServer } from '../server.js';
