/**
 * WP-T12 — aggregate the `elementor://...` resource read/list handlers + ATTACH them to the WP-F04
 * resource descriptors (13-tool-catalog.md §2). This module is the public seam WP-T01's server wiring
 * discovers (specifier `./resources/index.js`): it pairs each FROZEN descriptor (`catalog/resources.ts`)
 * with its read callback (and a `list` callback for the enumerable-collection resources), so WP-T01 can
 * `registerResource`/`ResourceTemplate` + supply our callbacks without WP-T12 owning `server.ts`.
 *
 * Resources mirror read tools: every handler is a thin call to the SAME WP-F02 route the equivalent
 * discovery tool uses (`resources/handlers.ts`). This module adds NO resources beyond the frozen §2 set
 * (it is built BY iterating `RESOURCE_DESCRIPTORS`, so it can never drift past the catalog), and supplies
 * NO business logic of its own.
 *
 * Contract authority: spec/contracts/13-tool-catalog.md §2; spec/01-architecture.md §2.1.
 */

import { RESOURCE_DESCRIPTORS, type ResourceDescriptor } from '../catalog/resources.js';
import type { ResourceHandler } from '../runtime/context.js';

import {
  readSiteCapabilities,
  readBreakpoints,
  readSchemaStyles,
  readSchemaWidget,
  readPageStructure,
  readGlobalClasses,
  readVariables,
  readGlobalColors,
  readElementDefaults,
  readTemplates,
  listTemplates,
  listGlobalClasses,
  listVariables,
  type ResourceListHandler,
} from './handlers.js';

export type {
  ResourceContent,
  ResourceReadResult,
  ResourceListEntry,
  ResourceListResult,
  ResourceListHandler,
} from './handlers.js';
export { ResourceUriError } from './handlers.js';

/* ───────────────────────────── attached descriptor type ───────────────────────────────────── */

/**
 * A frozen WP-F04 {@link ResourceDescriptor} paired with the WP-T12 callbacks that resolve it. WP-T01's
 * wiring reads this array and registers each entry against the live `McpServer` (static via
 * `registerResource`, parametric via `ResourceTemplate`), wiring `read` (and `list` where present) into
 * the SDK callback shape with the shared {@link import('../runtime/context.js').ToolContext} injected.
 */
export interface AttachedResource {
  /** The frozen catalog descriptor (URI template, name, MIME, backing route, outputSchema, template?). */
  readonly descriptor: ResourceDescriptor;
  /** The read callback: resolves the URI to the backing WP-F02 route `data` (§2). */
  readonly read: ResourceHandler;
  /** Optional `list` callback — present ONLY for enumerable-collection resources (§2). */
  readonly list?: ResourceListHandler;
}

/* ───────────────────────────── URI → handler maps (keyed by frozen URI template) ──────────── */

/** The read handler for every §2 resource, keyed by its frozen URI template. */
const READ_HANDLERS: Readonly<Record<string, ResourceHandler>> = {
  'elementor://site/capabilities': readSiteCapabilities,
  'elementor://breakpoints': readBreakpoints,
  'elementor://schema/styles': readSchemaStyles,
  'elementor://schema/widget/{type}': readSchemaWidget,
  'elementor://page/{id}/structure': readPageStructure,
  'elementor://kit/global-classes': readGlobalClasses,
  'elementor://kit/variables': readVariables,
  'elementor://kit/global-colors': readGlobalColors,
  'elementor://kit/element-defaults': readElementDefaults,
  'elementor://templates': readTemplates,
};

/**
 * The `list` callback for the enumerable-collection resources only (§2: `templates`, `kit/global-classes`,
 * `kit/variables`). Static singleton + parametric resources have no `list`.
 */
const LIST_HANDLERS: Readonly<Record<string, ResourceListHandler>> = {
  'elementor://templates': listTemplates,
  'elementor://kit/global-classes': listGlobalClasses,
  'elementor://kit/variables': listVariables,
};

/* ───────────────────────────── attachment (frozen catalog → callbacks) ─────────────────────── */

/**
 * Pair EVERY frozen §2 descriptor with its WP-T12 read/list callbacks. Built by iterating
 * {@link RESOURCE_DESCRIPTORS} so the set can never drift past the frozen catalog; throws at module load
 * if a descriptor lacks a read handler (a programmer error — every §2 resource must be covered).
 */
export const ATTACHED_RESOURCES: readonly AttachedResource[] = RESOURCE_DESCRIPTORS.map(
  (descriptor): AttachedResource => {
    const read = READ_HANDLERS[descriptor.uri];
    if (read === undefined) {
      throw new Error(`No resource read handler attached for "${descriptor.uri}" (WP-T12).`);
    }
    const list = LIST_HANDLERS[descriptor.uri];
    return list !== undefined ? { descriptor, read, list } : { descriptor, read };
  },
);

/** Look up the attached entry for a resource URI template (or `undefined` if not a §2 resource). */
export function getAttachedResource(uri: string): AttachedResource | undefined {
  return ATTACHED_RESOURCES.find((r) => r.descriptor.uri === uri);
}
