/**
 * WP-F04 — design-system tool schemas (13-tool-catalog.md §1.4).
 *
 * Covers the global-classes family (`design.classes.list/.upsert/.delete/.reorder/.usage`), the
 * variables family (`design.variables.list/.create/.update/.delete/.restore/.batch`), the V3 kit
 * repeaters expanded per-op (`design.globalColors.{list,upsert,delete}`,
 * `design.globalFonts.{list,upsert,delete}`), `design.sync_v4_to_v3`, the per-widget defaults pair
 * (`design.element_defaults.{get,set}`), and `design.deploy`.
 *
 * The combined catalog rows (".list/.upsert/.delete", ".{get,set}") are EXPANDED to one schema set per
 * named tool (WP-F04 implementation note). ZodRawShape maps (§0.1); list tools spread pagination
 * (§0.6); destructive tools carry `confirm` (§0.3).
 */

import { z } from 'zod';

import {
  fieldProjectedItem,
  globalClassObjectSchema,
  paginationInputShape,
  paginatedOutput,
} from './shared.js';

/* ───────────────────────────── elementor.design.classes.list ────────────────────────────── */

export const designClassesListInput = {
  context: z.enum(['frontend', 'preview']).default('frontend'),
  ...paginationInputShape,
} as const;

export const designClassesListOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`. The
  // STRICT `globalClassObjectSchema` stays authoritative for upsert INPUT.
  ...paginatedOutput(fieldProjectedItem(globalClassObjectSchema)),
  order: z.array(z.string()),
} as const;

/* ───────────────────────────── elementor.design.classes.upsert ──────────────────────────── */

export const designClassesUpsertInput = {
  added: z.array(globalClassObjectSchema).optional(),
  modified: z.array(globalClassObjectSchema).optional(),
} as const;

export const designClassesUpsertOutput = {
  ok: z.boolean(),
  order: z.array(z.string()),
  modifiedLabels: z.record(z.string(), z.object({ modified: z.string() })).optional(),
  total_count: z.number().int(),
} as const;

/* ───────────────────────────── elementor.design.classes.delete ──────────────────────────── */

export const designClassesDeleteInput = {
  ids: z.array(z.string()),
  confirm: z.boolean().default(false),
} as const;

export const designClassesDeleteOutput = {
  success: z.boolean(),
  order: z.array(z.string()),
} as const;

/* ───────────────────────────── elementor.design.classes.reorder ─────────────────────────── */

export const designClassesReorderInput = {
  order: z.array(z.string()),
} as const;

export const designClassesReorderOutput = {
  success: z.boolean(),
} as const;

/* ───────────────────────────── elementor.design.classes.usage ───────────────────────────── */

export const designClassesUsageInput = {
  id: z.string().optional(),
  ...paginationInputShape,
} as const;

export const designClassesUsageOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        id: z.string(),
        post_id: z.number().int(),
        element_ids: z.array(z.string()),
      }),
    ),
  ),
} as const;

/* ───────────────────────────── elementor.design.variables.list ──────────────────────────── */

const variableTypeEnum = z.enum([
  'global-color-variable',
  'global-font-variable',
  'global-size-variable',
]);

export const designVariablesListInput = {
  ...paginationInputShape,
} as const;

export const designVariablesListOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        id: z.string(),
        type: variableTypeEnum,
        label: z.string(),
        value: z.string(),
        order: z.number().int(),
      }),
    ),
  ),
  watermark: z.number().int(),
} as const;

/* ───────────────────────────── elementor.design.variables.create ────────────────────────── */

export const designVariablesCreateInput = {
  type: variableTypeEnum,
  label: z.string(),
  value: z.string(),
} as const;

export const designVariablesCreateOutput = {
  variable: z.object({
    id: z.string(),
    type: variableTypeEnum,
    label: z.string(),
    value: z.string(),
  }),
  watermark: z.number().int(),
} as const;

/* ───────────────────────────── elementor.design.variables.update ────────────────────────── */

export const designVariablesUpdateInput = {
  id: z.string(),
  label: z.string().optional(),
  value: z.string().optional(),
  watermark: z.number().int(),
} as const;

export const designVariablesUpdateOutput = {
  watermark: z.number().int(),
} as const;

/* ───────────────────────────── elementor.design.variables.delete ────────────────────────── */

export const designVariablesDeleteInput = {
  id: z.string(),
  watermark: z.number().int(),
  confirm: z.boolean().default(false),
} as const;

export const designVariablesDeleteOutput = {
  watermark: z.number().int(),
} as const;

/* ───────────────────────────── elementor.design.variables.restore ───────────────────────── */

export const designVariablesRestoreInput = {
  id: z.string(),
  watermark: z.number().int(),
} as const;

export const designVariablesRestoreOutput = {
  watermark: z.number().int(),
} as const;

/* ───────────────────────────── elementor.design.variables.batch ─────────────────────────── */

export const designVariablesBatchInput = {
  watermark: z.number().int(),
  operations: z.array(
    z.object({
      op: z.enum(['create', 'update', 'delete', 'restore']),
      id: z.string().optional(),
      type: z.string().optional(),
      label: z.string().optional(),
      value: z.string().optional(),
    }),
  ),
} as const;

export const designVariablesBatchOutput = {
  watermark: z.number().int(),
  results: z.array(
    z.object({
      op: z.string(),
      id: z.string(),
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
} as const;

/* ───────────────────────────── elementor.design.globalColors.* ──────────────────────────── */

const globalColorItem = z.object({
  _id: z.string(),
  title: z.string(),
  color: z.string(),
});

export const designGlobalColorsListInput = {} as const;

export const designGlobalColorsListOutput = {
  system: z.array(globalColorItem),
  custom: z.array(globalColorItem),
} as const;

export const designGlobalColorsUpsertInput = {
  colors: z.array(
    z.object({
      _id: z.string().optional(),
      title: z.string(),
      color: z.string(),
    }),
  ),
  bucket: z.enum(['system', 'custom']).default('custom'),
} as const;

export const designGlobalColorsUpsertOutput = {
  success: z.boolean(),
  colors: z.array(globalColorItem),
} as const;

export const designGlobalColorsDeleteInput = {
  ids: z.array(z.string()),
} as const;

export const designGlobalColorsDeleteOutput = {
  success: z.boolean(),
} as const;

/* ───────────────────────────── elementor.design.globalFonts.* ───────────────────────────── */

const globalFontItem = z.object({
  _id: z.string(),
  title: z.string(),
  typography: z.record(z.string(), z.unknown()),
});

export const designGlobalFontsListInput = {} as const;

export const designGlobalFontsListOutput = {
  system: z.array(globalFontItem),
  custom: z.array(globalFontItem),
} as const;

export const designGlobalFontsUpsertInput = {
  colors: z.array(
    z.object({
      _id: z.string().optional(),
      title: z.string(),
      typography: z.record(z.string(), z.unknown()),
    }),
  ),
  bucket: z.enum(['system', 'custom']).default('custom'),
} as const;

export const designGlobalFontsUpsertOutput = {
  success: z.boolean(),
  colors: z.array(globalFontItem),
} as const;

export const designGlobalFontsDeleteInput = {
  ids: z.array(z.string()),
} as const;

export const designGlobalFontsDeleteOutput = {
  success: z.boolean(),
} as const;

/* ───────────────────────────── elementor.design.fonts.install ───────────────────────────── */

export const designFontsInstallInput = {
  source: z
    .string()
    .min(1)
    .describe(
      'The font bytes: an http(s) URL, a data: URI, or raw base64 (woff2/woff/ttf/otf — the real format is sniffed from magic bytes).',
    ),
  family: z
    .string()
    .min(1)
    .describe(
      'The font-family name to register (the exact string atomic font-family props should use).',
    ),
  weight: z
    .union([z.string(), z.number().int()])
    .optional()
    .describe('Numeric weight 1-1000 (or normal/bold). One static face per call.'),
  style: z.enum(['normal', 'italic', 'oblique']).optional(),
} as const;

export const designFontsInstallOutput = {
  family: z.string(),
  weight: z.string(),
  style: z.string(),
  format: z.string(),
  attachment_id: z.number().int(),
  url: z.string(),
  registered_via: z.enum(['pro_custom_fonts', 'kit_custom_css']),
  font_face: z.string(),
  warnings: z.array(z.string()),
} as const;

/* ─────────────────────────── elementor.design.fonts.upload_zip ─────────────────────────── */

export const designFontsUploadZipInput = {
  file_path: z
    .string()
    .optional()
    .describe(
      'Local filesystem path to a ZIP file containing OTF/TTF/WOFF/WOFF2 font files. Family names and weights are read from each file\'s name table automatically. Provide either file_path OR zip_data.',
    ),
  zip_data: z
    .string()
    .optional()
    .describe(
      'Base64-encoded ZIP file content. Provide either file_path OR zip_data.',
    ),
} as const;

const installedFaceShape = z.object({
  family: z.string(),
  weight: z.string(),
  style: z.string(),
  format: z.string(),
  attachment_id: z.number().int(),
  url: z.string(),
  registered_via: z.enum(['pro_custom_fonts', 'kit_custom_css']),
  font_face: z.string(),
  warnings: z.array(z.string()),
});

export const designFontsUploadZipOutput = {
  installed: z.array(installedFaceShape),
  skipped: z.array(z.string()),
} as const;

/* ───────────────────────────── elementor.design.sync_v4_to_v3 ───────────────────────────── */

export const designSyncV4ToV3Input = {
  variable_id: z.string(),
} as const;

export const designSyncV4ToV3Output = {
  success: z.boolean(),
} as const;

/* ───────────────────────────── elementor.design.element_defaults.* ──────────────────────── */

export const designElementDefaultsGetInput = {
  type: z.string(),
} as const;

export const designElementDefaultsGetOutput = {
  settings: z.record(z.string(), z.unknown()),
} as const;

export const designElementDefaultsSetInput = {
  type: z.string(),
  settings: z.record(z.string(), z.unknown()),
} as const;

export const designElementDefaultsSetOutput = {
  success: z.boolean(),
} as const;

/* ───────────────────────────── elementor.design.deploy ──────────────────────────────────── */

export const designDeployInput = {
  globalClasses: z.array(globalClassObjectSchema).optional(),
  globalVariables: z
    .array(
      z.object({
        type: z.string(),
        label: z.string(),
        value: z.string(),
      }),
    )
    .optional(),
  confirm: z.boolean().default(false),
} as const;

export const designDeployOutput = {
  success: z.boolean(),
  classes_order: z.array(z.string()),
  variables_watermark: z.number().int(),
  modifiedLabels: z.record(z.string(), z.unknown()).optional(),
} as const;
