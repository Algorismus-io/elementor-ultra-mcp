/**
 * WP-T12 — read/list HANDLERS for the frozen `elementor://...` MCP resource catalog (13-tool-catalog.md §2).
 *
 * Resources MIRROR the read tools: each handler is a THIN call to the SAME WP-F02 route the equivalent
 * discovery tool uses (single-sourcing the shape so resources + tools never diverge, §Detailed
 * Requirements 4). Every resource is READ-ONLY and resolved through the shared App-Password REST client
 * exposed as `ctx.wp` (the bound WP-F02 facade, WP-T01 `runtime/context.ts`). This module owns ONLY the
 * read/list callbacks; the `registerResource`/`ResourceTemplate` wiring is WP-T01's (`server.ts`), the
 * URI templates + output schemas are WP-F04's (`catalog/resources.ts`). Ownership stays disjoint.
 *
 * Contract authority:
 *  - spec/contracts/13-tool-catalog.md §2 (the ten resources + backing routes; `list` where collection).
 *  - spec/contracts/10-rest-api.md §2.4 (page structure), §3 (schema), §4 (design classes/variables/
 *    colors/element-defaults), §7 (templates), §12 (site capabilities).
 *  - spec/01-architecture.md §2.1 (Seam A producers — read-only, no WRITE/dry_run/prime-css).
 *
 * Each `read` handler returns the SDK resource-read contents shape: a single `application/json` block
 * whose `text` is the JSON-serialized backing-route `data` (so the body matches the route payload — the
 * same data the equivalent read TOOL returns). `read` handlers conform to the WP-T01 {@link ResourceHandler}
 * signature `(uri, variables, ctx) => Promise<{contents}>`; `list` handlers conform to the local
 * {@link ResourceListHandler} signature (the SDK `ListResourcesCallback` body).
 *
 * Errors: a thrown {@link WpClientError} (e.g. `NOT_FOUND` for an unregistered widget type / missing
 * page) propagates so the SDK surfaces it as a resource-read error; a URI that cannot supply a required
 * `{type}`/`{id}` variable is a protocol-shaped {@link ResourceUriError}.
 */

import type { ToolContext, ResourceHandler } from '../runtime/context.js';

/* ───────────────────────────── result shapes (structural, SDK-compatible) ──────────────────── */

/** A single resource-content block (the SDK `ReadResourceResult.contents[]` element shape). */
export interface ResourceContent {
  /** The resolved resource URI this block answers. */
  uri: string;
  /** MIME type — always `application/json` for the frozen catalog (§2). */
  mimeType?: string;
  /** The JSON-serialized backing-route `data` payload. */
  text?: string;
}

/** The resource-read result (the SDK `ReadResourceResult` shape, structural). */
export interface ResourceReadResult {
  contents: ResourceContent[];
}

/** A single enumerated resource member (the SDK `Resource` shape for a `list` callback). */
export interface ResourceListEntry {
  /** The concrete member URI (e.g. `elementor://templates/42`). */
  uri: string;
  /** A human label for the member. */
  name: string;
  /** Optional MIME type. */
  mimeType?: string;
  /** Optional human description. */
  description?: string;
}

/** The resource-list result (the SDK `ListResourcesResult` shape, structural). */
export interface ResourceListResult {
  resources: ResourceListEntry[];
  /** Opaque cursor for the next page where the backing collection paginates (§0.6). */
  nextCursor?: string;
}

/**
 * The list-handler signature: enumerate a collection resource's members so MCP clients can browse it.
 * Mirrors the SDK `ListResourcesCallback` body (the WP-T01 wiring adapts the SDK `extra` arg + injects
 * `ctx`). Returned `resources[]` are concrete member URIs under the collection.
 */
export type ResourceListHandler = (ctx: ToolContext) => Promise<ResourceListResult>;

/* ───────────────────────────── errors ─────────────────────────────────────────────────────── */

/** A required `{type}`/`{id}` template variable was absent/un-coercible from the resolved URI (protocol). */
export class ResourceUriError extends Error {
  /** The resource URI template that failed to resolve a variable. */
  readonly uri: string;
  constructor(uri: string, detail: string) {
    super(`Cannot resolve resource "${uri}": ${detail}`);
    this.name = 'ResourceUriError';
    this.uri = uri;
  }
}

/* ───────────────────────────── helpers ────────────────────────────────────────────────────── */

/** Wrap a JSON-able backing-route `data` payload into the single-block resource-read result (§2). */
function jsonResource(uri: URL, data: unknown): ResourceReadResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(data),
      },
    ],
  };
}

/** Read the first value for a template variable (the SDK passes `string | string[]`). */
function firstVar(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Extract a required string template variable (`{type}`/`{name}`). Throws {@link ResourceUriError}
 * (protocol-shaped) when the URI did not supply it.
 */
function requireStringVar(
  uri: URL,
  variables: Record<string, string | string[]>,
  key: string,
): string {
  const raw = firstVar(variables[key]);
  if (raw === undefined || raw === '') {
    throw new ResourceUriError(uri.href, `missing required URI variable "{${key}}"`);
  }
  return raw;
}

/**
 * Extract a required positive-integer template variable (`{id}`). Throws {@link ResourceUriError}
 * (protocol-shaped) when absent or not a finite non-negative integer.
 */
function requireIntVar(
  uri: URL,
  variables: Record<string, string | string[]>,
  key: string,
): number {
  const raw = requireStringVar(uri, variables, key);
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 0) {
    throw new ResourceUriError(
      uri.href,
      `URI variable "{${key}}" must be a non-negative integer (got "${raw}")`,
    );
  }
  return id;
}

/* ───────────────────────────── read handlers (one per §2 resource) ─────────────────────────── */

/**
 * `elementor://site/capabilities` → the NORMALIZED capability probe (same data as the WP-F05
 * `elementor.site.capabilities` tool, §1.1 / §12). Uses the facade's normalized `siteCapabilities()`.
 */
export const readSiteCapabilities: ResourceHandler = async (uri, _variables, ctx) => {
  const data = await ctx.wp.siteCapabilities();
  return jsonResource(uri, data);
};

/** `elementor://breakpoints` → `GET .../breakpoints` (§3, route `schemaBreakpoints`). */
export const readBreakpoints: ResourceHandler = async (uri, _variables, ctx) => {
  const data = await ctx.wp.schemaBreakpoints();
  return jsonResource(uri, data);
};

/** `elementor://schema/styles` → `GET .../schema/styles` (§3, route `schemaStyles`). */
export const readSchemaStyles: ResourceHandler = async (uri, _variables, ctx) => {
  const data = await ctx.wp.schemaStyles();
  return jsonResource(uri, data);
};

/**
 * `elementor://schema/widget/{type}` → `GET .../schema/widget/{type}` (§3, route `schemaWidget`).
 * Extracts the `{type}` template variable; a NOT_FOUND for an unregistered type propagates as a read error.
 */
export const readSchemaWidget: ResourceHandler = async (uri, variables, ctx) => {
  const type = requireStringVar(uri, variables, 'type');
  const data = await ctx.wp.schemaWidget(type);
  return jsonResource(uri, data);
};

/**
 * `elementor://page/{id}/structure` → `GET .../documents/{id}` (§2.4, route `getDocument`). Extracts the
 * `{id}` template variable; a NOT_FOUND for a missing page propagates as a read error. The body is the
 * full document `data` (`elements` + `base_hash` + `generation`, §2.4).
 */
export const readPageStructure: ResourceHandler = async (uri, variables, ctx) => {
  const id = requireIntVar(uri, variables, 'id');
  const data = await ctx.wp.getDocument(id);
  return jsonResource(uri, data);
};

/** `elementor://kit/global-classes` → `GET .../design/classes` (§4.1, route `listGlobalClasses`). */
export const readGlobalClasses: ResourceHandler = async (uri, _variables, ctx) => {
  const data = await ctx.wp.listGlobalClasses();
  return jsonResource(uri, data);
};

/** `elementor://kit/variables` → `GET .../design/variables` (§4.4, route `listVariables`). */
export const readVariables: ResourceHandler = async (uri, _variables, ctx) => {
  const data = await ctx.wp.listVariables();
  return jsonResource(uri, data);
};

/** `elementor://kit/global-colors` → `GET .../design/global-colors` (§4.5, route `getGlobalColors`). */
export const readGlobalColors: ResourceHandler = async (uri, _variables, ctx) => {
  const data = await ctx.wp.getGlobalColors();
  return jsonResource(uri, data);
};

/** `elementor://kit/element-defaults` → `GET .../design/element-defaults` (§4, route `getElementDefaults`). */
export const readElementDefaults: ResourceHandler = async (uri, _variables, ctx) => {
  const data = await ctx.wp.getElementDefaults();
  return jsonResource(uri, data);
};

/** `elementor://templates` → `GET .../templates` (§7, route `listTemplates`). */
export const readTemplates: ResourceHandler = async (uri, _variables, ctx) => {
  const data = await ctx.wp.listTemplates();
  return jsonResource(uri, data);
};

/* ───────────────────────────── list handlers (collection resources, §2) ────────────────────── */

/** Coerce the REST `Paginated.next_cursor` (`string | null`) to the optional MCP `nextCursor` (§0.6). */
function toNextCursor(next: string | null): string | undefined {
  return next !== null && next !== '' ? next : undefined;
}

/**
 * `list` for `elementor://templates` — enumerate template ids/titles as concrete member URIs (§2: "Each
 * resource declares a `list` callback where it backs an enumerable collection"). Paginated via cursor
 * where the backing route paginates (§7 / §0.11 `next_cursor`).
 */
export const listTemplates: ResourceListHandler = async (ctx) => {
  const data = await ctx.wp.listTemplates();
  const resources = data.items.map((item) => ({
    uri: `elementor://templates/${item.template_id}`,
    name: item.title,
    mimeType: 'application/json',
    description: `${item.type} template (#${item.template_id})`,
  }));
  const nextCursor = toNextCursor(data.next_cursor);
  return nextCursor !== undefined ? { resources, nextCursor } : { resources };
};

/**
 * `list` for `elementor://kit/global-classes` — enumerate class ids/labels as concrete member URIs (§2).
 * Paginated via cursor where the backing route paginates (§4.1 / §0.11 `next_cursor`).
 */
export const listGlobalClasses: ResourceListHandler = async (ctx) => {
  const data = await ctx.wp.listGlobalClasses();
  const resources = data.items.map((item) => ({
    uri: `elementor://kit/global-classes/${item.id}`,
    name: item.label,
    mimeType: 'application/json',
    description: `Global class "${item.label}" (${item.id})`,
  }));
  const nextCursor = toNextCursor(data.next_cursor);
  return nextCursor !== undefined ? { resources, nextCursor } : { resources };
};

/**
 * `list` for `elementor://kit/variables` — enumerate variable ids/labels as concrete member URIs (§2).
 * The backing `GET .../design/variables` returns a `{ variables: { id: {...} } }` map (§4.4), not a
 * paginated list, so no cursor is surfaced.
 */
export const listVariables: ResourceListHandler = async (ctx) => {
  const data = await ctx.wp.listVariables();
  const resources = Object.entries(data.variables).map(([id, variable]) => ({
    uri: `elementor://kit/variables/${id}`,
    name: variable.label,
    mimeType: 'application/json',
    description: `${variable.type} "${variable.label}" (${id})`,
  }));
  return { resources };
};
