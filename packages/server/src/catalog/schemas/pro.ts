/**
 * WP-F04 — Pro surface tool schemas (13-tool-catalog.md §1.8; SUPPLEMENT.md §A.7).
 *
 * Covers: `elementor.pro.theme.create/.set_conditions/.get_conditions_config`,
 * `elementor.pro.popup.create/.set_triggers/.set_timing`,
 * `elementor.pro.form.build/.list_actions`, `elementor.pro.loop.create_item/.bind_grid`,
 * `elementor.pro.dynamic.bind/.list_tags`, `elementor.pro.woo.add_widget`.
 *
 * The combined popup rows (".set_triggers/.set_timing") are EXPANDED to separate schema sets.
 * `ConditionTuple` is the shared display-condition tuple (`schemas/shared.ts`). ZodRawShape maps
 * (§0.1); BOTH-side tools that touch a document carry `base_hash` and return a diff (§0.7).
 */

import { z } from 'zod';

import {
  conditionTupleSchema,
  diffSchema,
  elementNodeSchema,
  fieldProjectedItem,
  pageSettingsSchema,
  paginationInputShape,
  paginatedOutput,
} from './shared.js';

/* ───────────────────────────── elementor.pro.theme.create ───────────────────────────────── */

export const proThemeCreateInput = {
  type: z.enum([
    'header',
    'footer',
    'single-post',
    'single-page',
    'archive',
    'search-results',
    'error-404',
    'section',
  ]),
  title: z.string(),
  status: z.enum(['publish', 'draft']).default('publish'),
  location: z.string().optional(),
  elements: z.array(elementNodeSchema).optional(),
  page_settings: pageSettingsSchema.optional(),
  conditions: z.array(conditionTupleSchema).optional(),
} as const;

export const proThemeCreateOutput = {
  post_id: z.number().int(),
  edit_url: z.string(),
  template_type: z.string(),
  location: z.string().nullable(),
  conditions_stored: z.array(z.string()),
} as const;

/* ───────────────────────────── elementor.pro.theme.set_conditions ───────────────────────── */

export const proThemeSetConditionsInput = {
  post_id: z.number().int(),
  conditions: z.array(conditionTupleSchema),
  check_conflicts: z.boolean().default(false),
} as const;

export const proThemeSetConditionsOutput = {
  saved: z.boolean(),
  conditions_stored: z.array(z.string()),
  conflicts: z
    .array(
      z.object({
        template_id: z.number().int(),
        template_title: z.string(),
        edit_url: z.string(),
      }),
    )
    .optional(),
} as const;

/* ───────────────────────────── elementor.pro.theme.get_conditions_config ────────────────── */

export const proThemeGetConditionsConfigInput = {} as const;

export const proThemeGetConditionsConfigOutput = {
  tree: z.record(z.string(), z.unknown()),
  locations: z.array(z.string()),
} as const;

/* ───────────────────────────── elementor.pro.popup.create ───────────────────────────────── */

export const proPopupCreateInput = {
  title: z.string(),
  status: z.enum(['publish', 'draft']).default('publish'),
  elements: z.array(elementNodeSchema).optional(),
  layout_settings: z.record(z.string(), z.unknown()).optional(),
  display_settings: z
    .object({
      triggers: z.record(z.string(), z.unknown()).optional(),
      timing: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  conditions: z.array(conditionTupleSchema).optional(),
} as const;

export const proPopupCreateOutput = {
  post_id: z.number().int(),
  edit_url: z.string(),
  conditions_stored: z.array(z.string()),
} as const;

/* ───────────────────────────── elementor.pro.popup.set_triggers ─────────────────────────── */

export const proPopupSetTriggersInput = {
  post_id: z.number().int(),
  triggers: z.record(z.string(), z.unknown()),
} as const;

export const proPopupSetTriggersOutput = {
  success: z.boolean(),
  display_settings: z.record(z.string(), z.unknown()),
} as const;

/* ───────────────────────────── elementor.pro.popup.set_timing ───────────────────────────── */

export const proPopupSetTimingInput = {
  post_id: z.number().int(),
  timing: z.record(z.string(), z.unknown()),
} as const;

export const proPopupSetTimingOutput = {
  success: z.boolean(),
  display_settings: z.record(z.string(), z.unknown()),
} as const;

/* ───────────────────────────── elementor.pro.form.build ─────────────────────────────────── */

export const proFormBuildInput = {
  container_id: z.string(),
  post_id: z.number().int(),
  form_name: z.string().optional(),
  button_text: z.string().optional(),
  fields: z.array(
    z.object({
      type: z.string(),
      id: z.string(),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      required: z.boolean().optional(),
      options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
      rows: z.number().int().optional(),
      width: z.string().optional(),
      default_value: z.string().optional(),
      html: z.string().optional(),
    }),
  ),
  actions: z.array(
    z
      .object({
        type: z.enum([
          'email',
          'email2',
          'redirect',
          'webhook',
          'mailchimp',
          'drip',
          'activecampaign',
          'getresponse',
          'convertkit',
          'mailerlite',
          'slack',
          'discord',
        ]),
      })
      .passthrough(),
  ),
  base_hash: z.string(),
} as const;

export const proFormBuildOutput = {
  element: elementNodeSchema,
  diff: diffSchema,
  warnings: z.array(z.string()),
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.pro.form.list_actions ──────────────────────────── */

export const proFormListActionsInput = {} as const;

export const proFormListActionsOutput = {
  actions: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      settings_controls: z.array(z.string()),
    }),
  ),
} as const;

/* ───────────────────────────── elementor.pro.loop.create_item ───────────────────────────── */

export const proLoopCreateItemInput = {
  title: z.string(),
  elements: z.array(elementNodeSchema).optional(),
} as const;

export const proLoopCreateItemOutput = {
  template_id: z.number().int(),
  edit_url: z.string(),
} as const;

/* ───────────────────────────── elementor.pro.loop.bind_grid ─────────────────────────────── */

export const proLoopBindGridInput = {
  container_id: z.string(),
  post_id: z.number().int(),
  widget: z.enum(['loop-grid', 'loop-carousel']).default('loop-grid'),
  template_id: z.number().int(),
  skin: z.enum(['post', 'post_taxonomy', 'product', 'product_taxonomy']).default('post'),
  columns: z.number().int().optional(),
  posts_per_page: z.number().int().default(6),
  query: z.object({
    post_type: z.string(),
    orderby: z.string().optional(),
    order: z.enum(['asc', 'desc']).optional(),
    include_term_ids: z.array(z.string()).optional(),
    exclude_ids: z.array(z.string()).optional(),
    posts_ids: z.array(z.string()).optional(),
    query_id: z.string().optional(),
  }),
  pagination: z
    .object({
      type: z.string(),
      load_type: z.string(),
    })
    .optional(),
  base_hash: z.string(),
} as const;

export const proLoopBindGridOutput = {
  element: elementNodeSchema,
  diff: diffSchema,
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.pro.dynamic.bind ───────────────────────────────── */

export const proDynamicBindInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  control: z.string(),
  tag: z.string(),
  tag_settings: z.record(z.string(), z.unknown()).optional(),
  fallback_value: z.unknown().optional(),
  base_hash: z.string(),
} as const;

export const proDynamicBindOutput = {
  dynamic_string: z.string(),
  diff: diffSchema,
  applied: z.boolean(),
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.pro.dynamic.list_tags ──────────────────────────── */

export const proDynamicListTagsInput = {
  ...paginationInputShape,
} as const;

export const proDynamicListTagsOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        name: z.string(),
        title: z.string(),
        group: z.string(),
        categories: z.array(z.string()),
        settings_controls: z.array(z.string()),
        available: z.boolean(),
      }),
    ),
  ),
} as const;

/* ───────────────────────────── elementor.pro.woo.add_widget ─────────────────────────────── */

export const proWooAddWidgetInput = {
  post_id: z.number().int(),
  container_id: z.string(),
  widget: z.string(),
  product_id: z.number().int().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  base_hash: z.string(),
} as const;

export const proWooAddWidgetOutput = {
  element: elementNodeSchema,
  diff: diffSchema,
  context_ok: z.boolean(),
  context_warning: z.string().optional(),
  base_hash: z.string(),
} as const;
