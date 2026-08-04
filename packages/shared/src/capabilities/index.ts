/**
 * WP-F05 — Capability probe public barrel.
 *
 * Re-exports the normalized {@link Capabilities} shape + experiment slug constants (Seam E,
 * `12-error-taxonomy.md §3.4`, `13-tool-catalog.md §1.1`). The shared package root entry
 * (`src/index.ts`) re-exports from here so consumers can
 * `import { Capabilities } from '@elementor-ultra/shared'`.
 */

export {
  EXPERIMENT_SLUGS,
  type ExperimentSlug,
  type Capabilities,
  type CapabilityBreakpoint,
  type RegisteredTypes,
  type CapabilityVersions,
} from './types.js';
