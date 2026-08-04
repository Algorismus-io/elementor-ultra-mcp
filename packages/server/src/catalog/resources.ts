/**
 * WP-F04 — the FROZEN MCP resource catalog (`elementor://...`, 13-tool-catalog.md §2).
 *
 * Every resource is read-only and resolved through the App-Password REST client. Parametric URIs
 * (`{type}`/`{id}`) register via `ResourceTemplate` (declared by `template:true` here); static URIs via
 * `registerResource`. Each descriptor carries the URI template, a human name, the MIME type, the
 * backing REST `operationId` (WP-F02 `ROUTES`), and an `outputSchema` ZodRawShape mirroring the
 * payload (§2). This module is pure data — the live `McpServer` resource registration is WP-T01's.
 */

import { z } from 'zod';

import type { RouteName } from '@elementor-ultra/shared';

import { elementNodeSchema, globalClassObjectSchema } from './schemas/shared.js';
import { siteCapabilitiesOutput, breakpointsGetOutput } from './schemas/discovery.js';

/* ───────────────────────────── descriptor type ─────────────────────────────────────────── */

/** The `elementor://...` URI scheme prefix (13-tool-catalog.md §2). */
export const RESOURCE_URI_SCHEME = 'elementor://';

/** Pattern every resource URI (template) must satisfy. */
export const RESOURCE_URI_PATTERN = /^elementor:\/\/.+/;

/** A single frozen resource descriptor (13-tool-catalog.md §2). */
export interface ResourceDescriptor {
  /** URI template; parametric ones carry `{type}` / `{id}` placeholders. */
  uri: string;
  /** Human resource name (the §2 table "Name" column). */
  name: string;
  /** MIME type (all `application/json` in the frozen contract). */
  mimeType: string;
  /** Backing REST `operationId` (WP-F02 `ROUTES`). */
  route: RouteName;
  /** True when the URI is a `ResourceTemplate` (parametric) — else a static `registerResource`. */
  template: boolean;
  /** The payload shape as a ZodRawShape map (mirrors §2 "Returns"). */
  outputSchema: z.ZodRawShape;
}

/* ───────────────────────────── the resource catalog (§2) ────────────────────────────────── */

/** EVERY resource in 13-tool-catalog.md §2, in table order. */
export const RESOURCE_DESCRIPTORS: readonly ResourceDescriptor[] = [
  {
    uri: 'elementor://site/capabilities',
    name: 'Site capabilities',
    mimeType: 'application/json',
    route: 'getSiteCapabilities',
    template: false,
    // Same shape as the `site.capabilities` tool output (§2).
    outputSchema: { ...siteCapabilitiesOutput },
  },
  {
    uri: 'elementor://breakpoints',
    name: 'Breakpoints',
    mimeType: 'application/json',
    route: 'schemaBreakpoints',
    template: false,
    outputSchema: { ...breakpointsGetOutput },
  },
  {
    uri: 'elementor://schema/styles',
    name: 'Style-Schema',
    mimeType: 'application/json',
    route: 'schemaStyles',
    template: false,
    outputSchema: {
      props: z.record(z.string(), z.unknown()),
      units: z.record(z.string(), z.array(z.string())),
      states: z.array(z.string()),
    },
  },
  {
    uri: 'elementor://schema/widget/{type}',
    name: 'Widget schema',
    mimeType: 'application/json',
    route: 'schemaWidget',
    template: true,
    outputSchema: {
      kind: z.enum(['atomic', 'classic']),
      schema: z.record(z.string(), z.unknown()),
      dynamic_props: z.array(z.string()),
      version: z.string(),
    },
  },
  {
    uri: 'elementor://page/{id}/structure',
    name: 'Page structure',
    mimeType: 'application/json',
    route: 'getDocument',
    template: true,
    outputSchema: {
      elements: z.array(elementNodeSchema),
      base_hash: z.string(),
      generation: z.enum(['v4', 'v3', 'mixed']),
    },
  },
  {
    uri: 'elementor://kit/global-classes',
    name: 'Global classes',
    mimeType: 'application/json',
    route: 'listGlobalClasses',
    template: false,
    outputSchema: {
      items: z.array(globalClassObjectSchema),
      order: z.array(z.string()),
    },
  },
  {
    uri: 'elementor://kit/variables',
    name: 'Variables',
    mimeType: 'application/json',
    route: 'listVariables',
    template: false,
    outputSchema: {
      items: z.array(
        z.object({
          id: z.string(),
          type: z.enum(['global-color-variable', 'global-font-variable', 'global-size-variable']),
          label: z.string(),
          value: z.string(),
          order: z.number().int(),
        }),
      ),
      watermark: z.number().int(),
    },
  },
  {
    uri: 'elementor://kit/global-colors',
    name: 'V3 global colors',
    mimeType: 'application/json',
    route: 'getGlobalColors',
    template: false,
    outputSchema: {
      system: z.array(z.object({ _id: z.string(), title: z.string(), color: z.string() })),
      custom: z.array(z.object({ _id: z.string(), title: z.string(), color: z.string() })),
    },
  },
  {
    uri: 'elementor://kit/element-defaults',
    name: 'Element defaults',
    mimeType: 'application/json',
    route: 'getElementDefaults',
    template: false,
    outputSchema: {
      defaults: z.record(z.string(), z.record(z.string(), z.unknown())),
    },
  },
  {
    uri: 'elementor://templates',
    name: 'Template library',
    mimeType: 'application/json',
    route: 'listTemplates',
    template: false,
    outputSchema: {
      items: z.array(
        z.object({
          template_id: z.number().int(),
          title: z.string(),
          type: z.string(),
          source: z.string(),
        }),
      ),
    },
  },
] as const;

/** Frozen list of all resource URIs (templates). */
export const RESOURCE_URIS: readonly string[] = RESOURCE_DESCRIPTORS.map((r) => r.uri);

/** Total resource count in the frozen catalog. */
export const RESOURCE_COUNT: number = RESOURCE_DESCRIPTORS.length;
