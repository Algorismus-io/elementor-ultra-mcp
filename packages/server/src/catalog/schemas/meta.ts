/**
 * WP-F04 — meta-tool trio schemas (long-tail access, 13-tool-catalog.md §1.11).
 *
 * Covers: `elementor.tools.list_endpoints`, `elementor.tools.get_schema`, `elementor.tools.invoke`.
 * These three are ALWAYS available regardless of profile (§5.2 / §6) — see `profiles.ts`. ZodRawShape
 * maps (§0.1); `list_endpoints` spreads pagination (§0.6).
 */

import { z } from 'zod';

import { fieldProjectedItem, paginationInputShape, paginatedOutput } from './shared.js';

/* ───────────────────────────── elementor.tools.list_endpoints ───────────────────────────── */

export const toolsListEndpointsInput = {
  prefix: z.string().optional(),
  ...paginationInputShape,
} as const;

export const toolsListEndpointsOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        name: z.string(),
        title: z.string(),
        class: z.enum(['R', 'M', 'D']),
        enabled: z.boolean(),
        star: z.boolean(),
      }),
    ),
  ),
} as const;

/* ───────────────────────────── elementor.tools.get_schema ───────────────────────────────── */

export const toolsGetSchemaInput = {
  name: z.string(),
} as const;

export const toolsGetSchemaOutput = {
  name: z.string(),
  inputSchema: z.unknown(),
  outputSchema: z.unknown(),
  annotations: z.unknown(),
} as const;

/* ───────────────────────────── elementor.tools.invoke ───────────────────────────────────── */

export const toolsInvokeInput = {
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
} as const;

export const toolsInvokeOutput = {
  result: z.unknown(),
  isError: z.boolean(),
} as const;
