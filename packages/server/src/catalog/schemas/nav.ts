/**
 * WP-F04 — navigation / menu tool schemas (13-tool-catalog.md §1.6).
 *
 * Covers: `elementor.nav.menus.list`, `elementor.nav.menus.create`, `elementor.nav.bind_widget`.
 * ZodRawShape maps (§0.1); `nav.menus.list` spreads pagination (§0.6); `nav.bind_widget` carries the
 * optimistic-lock `base_hash` and returns the diff (§0.7).
 */

import { z } from 'zod';

import { diffSchema, fieldProjectedItem, paginationInputShape, paginatedOutput } from './shared.js';

/* ───────────────────────────── elementor.nav.menus.list ─────────────────────────────────── */

export const navMenusListInput = {
  ...paginationInputShape,
} as const;

export const navMenusListOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        term_id: z.number().int(),
        name: z.string(),
        slug: z.string(),
        count: z.number().int(),
      }),
    ),
  ),
} as const;

/* ───────────────────────────── elementor.nav.menus.create ───────────────────────────────── */

export const navMenusCreateInput = {
  name: z.string(),
  items: z.array(
    z.object({
      title: z.string(),
      url: z.string().optional(),
      object_id: z.number().int().optional(),
      type: z.string().optional(),
      parent_index: z.number().int().optional(),
    }),
  ),
} as const;

export const navMenusCreateOutput = {
  term_id: z.number().int(),
  item_ids: z.array(z.number().int()),
} as const;

/* ───────────────────────────── elementor.nav.bind_widget ────────────────────────────────── */

export const navBindWidgetInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  term_id: z.number().int(),
  base_hash: z.string(),
} as const;

export const navBindWidgetOutput = {
  diff: diffSchema,
  base_hash: z.string(),
} as const;
