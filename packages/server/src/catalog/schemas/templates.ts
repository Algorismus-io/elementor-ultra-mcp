/**
 * WP-F04 — templates / kits tool schemas (13-tool-catalog.md §1.7).
 *
 * Covers: `elementor.templates.list/.get/.save/.import/.insert_into_page`,
 * `elementor.kit.export/.import/.revert`. ZodRawShape maps (§0.1); `templates.list` spreads
 * pagination (§0.6); `insert_into_page` carries `base_hash` and returns a diff (§0.7); destructive kit
 * ops (`import`/`revert`) carry `confirm` (§0.3).
 */

import { z } from 'zod';

import {
  diffSchema,
  elementNodeSchema,
  fieldProjectedItem,
  pageSettingsSchema,
  paginationInputShape,
  paginatedOutput,
} from './shared.js';

/* ───────────────────────────── elementor.templates.list ─────────────────────────────────── */

export const templatesListInput = {
  type: z.string().optional(),
  ...paginationInputShape,
} as const;

export const templatesListOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        template_id: z.number().int(),
        title: z.string(),
        type: z.string(),
        source: z.string(),
      }),
    ),
  ),
} as const;

/* ───────────────────────────── elementor.templates.get ──────────────────────────────────── */

export const templatesGetInput = {
  template_id: z.number().int(),
} as const;

export const templatesGetOutput = {
  content: z.array(elementNodeSchema),
  page_settings: pageSettingsSchema,
  type: z.string(),
} as const;

/* ───────────────────────────── elementor.templates.save ─────────────────────────────────── */

export const templatesSaveInput = {
  title: z.string(),
  type: z.string(),
  content: z.array(elementNodeSchema),
  page_settings: pageSettingsSchema.optional(),
} as const;

export const templatesSaveOutput = {
  template_id: z.number().int(),
  edit_url: z.string(),
} as const;

/* ───────────────────────────── elementor.templates.import ───────────────────────────────── */

export const templatesImportInput = {
  file_path: z.string().optional(),
  content: z.unknown().optional(),
  import_mode: z.enum(['match_site', 'keep_existing']).default('match_site'),
} as const;

export const templatesImportOutput = {
  template_id: z.number().int(),
  remapped_ids: z.record(z.string(), z.string()),
} as const;

/* ───────────────────────────── elementor.templates.insert_into_page ─────────────────────── */

export const templatesInsertIntoPageInput = {
  post_id: z.number().int(),
  template_id: z.number().int().optional(),
  content: z.array(elementNodeSchema).optional(),
  parent_id: z.string().optional(),
  index: z.number().int().optional(),
  base_hash: z.string(),
} as const;

export const templatesInsertIntoPageOutput = {
  diff: diffSchema,
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.kit.export ─────────────────────────────────────── */

export const kitExportInput = {
  include: z.array(z.enum(['content', 'templates', 'settings', 'plugins'])),
  kitInfo: z.record(z.string(), z.unknown()).optional(),
  customization: z.record(z.string(), z.unknown()).optional(),
} as const;

export const kitExportOutput = {
  file_path: z.string(),
  session: z.string(),
} as const;

/* ───────────────────────────── elementor.kit.import ─────────────────────────────────────── */

export const kitImportInput = {
  session: z.string().optional(),
  file: z.string().optional(),
  include: z.array(z.string()),
  customization: z.record(z.string(), z.unknown()).optional(),
  confirm: z.boolean().default(false),
} as const;

export const kitImportOutput = {
  session: z.string(),
  imported: z.record(z.string(), z.unknown()),
} as const;

/* ───────────────────────────── elementor.kit.revert ─────────────────────────────────────── */

export const kitRevertInput = {
  session: z.string(),
  confirm: z.boolean().default(false),
} as const;

export const kitRevertOutput = {
  success: z.boolean(),
} as const;
