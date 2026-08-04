/**
 * WP-F04 — discovery / read tool schemas (13-tool-catalog.md §1.1).
 *
 * Covers: `elementor.tools.search`, `elementor.site.capabilities`, `elementor.pages.list`,
 * `elementor.page.get_structure`, `elementor.page.get_settings`, `elementor.schema.widget`,
 * `elementor.schema.styles`, `elementor.breakpoints.get`, `elementor.dynamic.list_tags`,
 * `elementor.dynamic.get_tag_schema`.
 *
 * All schemas are ZodRawShape maps (13-tool-catalog.md §0.1), NOT `z.object(...)`. Pagination tools
 * spread `paginationInputShape` / `paginatedOutput(...)` (§0.6). The `site.capabilities` output set
 * is the frozen probe shape (§1.1) — kept byte-identical to WP-F05's `siteCapabilitiesOutputSchema`.
 */

import { z } from 'zod';

import {
  elementNodeSchema,
  fieldProjectedItem,
  pageSettingsSchema,
  paginationInputShape,
  paginatedOutput,
} from './shared.js';

/* ───────────────────────────── elementor.tools.search ───────────────────────────────────── */

export const toolsSearchInput = {
  query: z.string().optional(),
  prefix: z.string().optional(),
  limit: z.number().int().default(30),
} as const;

export const toolsSearchOutput = {
  tools: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      inputSchema: z.unknown(),
      annotations: z.unknown(),
    }),
  ),
  total: z.number().int(),
} as const;

/* ───────────────────────────── elementor.site.capabilities ──────────────────────────────── */

export const siteCapabilitiesInput = {} as const;

export const siteCapabilitiesOutput = {
  v4: z.boolean(),
  atomic: z.boolean(),
  global_classes: z.boolean(),
  variables: z.boolean(),
  pro: z.boolean(),
  pro_atomic_form: z.boolean(),
  breakpoints: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      direction: z.enum(['min', 'max']),
      value: z.number(),
    }),
  ),
  experiments: z.record(z.string(), z.boolean()),
  can_update_class: z.boolean(),
  classes_migrated: z.boolean(),
  registered_types: z.object({
    atomic: z.array(z.string()),
    classic: z.array(z.string()),
  }),
  versions: z.object({
    elementor: z.string(),
    pro: z.string().nullable(),
    plugin: z.string(),
  }),
  unfiltered_html: z.boolean(),
} as const;

/* ───────────────────────────── elementor.pages.list ─────────────────────────────────────── */

export const pagesListInput = {
  status: z.enum(['any', 'publish', 'draft', 'pending', 'private', 'trash']).default('any'),
  post_type: z.string().optional(),
  ...paginationInputShape,
} as const;

export const pagesListOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        id: z.number().int(),
        title: z.string(),
        status: z.string(),
        url: z.string(),
        type: z.string(),
      }),
    ),
  ),
} as const;

/* ───────────────────────────── elementor.page.get_structure ─────────────────────────────── */

export const pageGetStructureInput = {
  post_id: z.number().int(),
  depth: z.number().int().min(0).optional(),
  subtree_id: z.string().optional(),
  projection: z.enum(['full', 'summary']).default('full'),
} as const;

export const pageGetStructureOutput = {
  elements: z.array(elementNodeSchema),
  base_hash: z.string(),
  generation: z.enum(['v4', 'v3', 'mixed']),
} as const;

/* ───────────────────────────── elementor.page.get_settings ──────────────────────────────── */

export const pageGetSettingsInput = {
  post_id: z.number().int(),
} as const;

export const pageGetSettingsOutput = {
  // PHP serializes an empty settings bag as `[]` — `pageSettingsSchema` normalizes it (#3b).
  settings: pageSettingsSchema,
} as const;

/* ───────────────────────────── elementor.schema.widget ──────────────────────────────────── */

export const schemaWidgetInput = {
  type: z.string(),
} as const;

export const schemaWidgetOutput = {
  kind: z.enum(['atomic', 'classic']),
  schema: z.record(z.string(), z.unknown()),
  dynamic_props: z.array(z.string()),
  version: z.string(),
} as const;

/* ───────────────────────────── elementor.schema.styles ──────────────────────────────────── */

export const schemaStylesInput = {} as const;

export const schemaStylesOutput = {
  props: z.record(z.string(), z.unknown()),
  units: z.record(z.string(), z.array(z.string())),
  states: z.array(z.string()),
} as const;

/* ───────────────────────────── elementor.breakpoints.get ────────────────────────────────── */

export const breakpointsGetInput = {} as const;

export const breakpointsGetOutput = {
  breakpoints: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      direction: z.enum(['min', 'max']),
      value: z.number().int(),
    }),
  ),
  default_direction: z.enum(['mobile_first', 'desktop_first']),
} as const;

/* ───────────────────────────── elementor.dynamic.list_tags ──────────────────────────────── */

export const dynamicListTagsInput = {
  categories: z.array(z.string()).optional(),
  ...paginationInputShape,
} as const;

export const dynamicListTagsOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        name: z.string(),
        label: z.string(),
        group: z.string(),
        categories: z.array(z.string()),
      }),
    ),
  ),
} as const;

/* ───────────────────────────── elementor.dynamic.get_tag_schema ─────────────────────────── */

export const dynamicGetTagSchemaInput = {
  tag_name: z.string(),
} as const;

export const dynamicGetTagSchemaOutput = {
  controls: z.record(z.string(), z.unknown()),
  categories: z.array(z.string()),
  group: z.string(),
} as const;
