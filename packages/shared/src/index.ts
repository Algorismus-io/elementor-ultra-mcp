/**
 * @elementor-ultra/shared — public entry.
 *
 * F01 shipped the skeleton; Wave-1 WPs populate the package and re-export their public
 * surface here so consumers can `import { ... } from '@elementor-ultra/shared'`:
 *   - WP-F02 — REST contract types, envelopes, route registry (`./rest`).
 *   - WP-F05 — error taxonomy (`./errors`) + capability probe types (`./capabilities`).
 *   - WP-F03 — authoring JSON Schemas live under `packages/shared/schemas/*` (outside `src`)
 *     and are consumed via their own module + the sync/validate scripts, not this barrel.
 *
 * Re-exporting the sub-barrels here is the integration seam the Wave-1 build agents flagged:
 * the server package resolves `@elementor-ultra/shared` members (ROUTES, ErrorCode,
 * McpErrorPayload, Capabilities, …) through this file.
 */

/** Package identifier — used by the scaffold smoke tests to prove cross-package resolution. */
export const SHARED_PACKAGE_NAME = '@elementor-ultra/shared';

/** Placeholder empty-object type so consumers can prove a type import resolves. */
export type Empty = Record<never, never>;

/* WP-F02 — REST contract (Seam B): envelopes, cross-cutting + per-route types, route registry. */
export * from './rest/index.js';

/* WP-F05 — error taxonomy (Seam E): ErrorCode enum + metadata, McpErrorPayload + constructors. */
export * from './errors/index.js';

/* WP-F05 — capability/experiment probe types (Seam E). */
export * from './capabilities/index.js';
