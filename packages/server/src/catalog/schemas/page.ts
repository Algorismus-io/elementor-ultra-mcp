/**
 * WP-F04 — page CRUD tool schemas (13-tool-catalog.md §1.2).
 *
 * Covers: `elementor.page.create`, `.build`, `.replace_tree`, `.update_settings`, `.dry_run`,
 * `.duplicate`, `.delete`, `.export_template`.
 *
 * Surgical/replace writes carry `base_hash` (optimistic lock, §0.8); insert/build accept `op_id`
 * (idempotency, §0.8); destructive tools accept `confirm` (elicitation gate, §0.3). Output diffs use
 * `diffSchema` (§0.7). All ZodRawShape maps (§0.1).
 */

import { z } from 'zod';

import {
  diffSchema,
  dryRunErrorSchema,
  elementNodeSchema,
  fieldProjectedItem,
  globalClassObjectSchema,
  pageSettingsSchema,
  pageSettingsInputSchema,
  paginationInputShape,
  paginatedOutput,
} from './shared.js';

/* ───────────────────────────── elementor.page.create ────────────────────────────────────── */

export const pageCreateInput = {
  title: z.string().optional(),
  post_type: z.string().default('page'),
  template: z.string().optional(),
  status: z.enum(['draft', 'publish', 'pending', 'private']).default('draft'),
} as const;

export const pageCreateOutput = {
  id: z.number().int(),
  edit_url: z.string(),
  status: z.string(),
  type: z.string(),
  /** Echoed when a page template (`_wp_page_template`) was applied at creation. */
  template: z.string().nullable().optional(),
} as const;

/* ───────────────────────────── elementor.page.build ─────────────────────────────────────── */

export const pageBuildInput = {
  title: z.string(),
  post_type: z.string().default('page'),
  elements: z.array(elementNodeSchema),
  // §7-AI S1 — the document-settings ALLOWLIST prefilter (custom_css must be a plain string etc.;
  // PHP Validator::validate_settings stays authoritative).
  settings: pageSettingsInputSchema.optional(),
  generation: z.enum(['v4', 'v3']).default('v4'),
  status: z.enum(['draft', 'publish', 'pending', 'private']).default('draft'),
  op_id: z.string().optional(),
  prime_css: z.boolean().default(true),
  /** §7-AI S2 — post-save+prime render verification (permalink probe). Default TRUE for page_build. */
  verify_render: z.boolean().default(true),
} as const;

export const pageBuildOutput = {
  id: z.number().int(),
  edit_url: z.string(),
  preview_url: z.string(),
  diff: diffSchema,
  base_hash: z.string(),
  css_primed: z.boolean(),
  /** §7-AI S2 — whether the post-save permalink probe verified the page renders (no fatal). */
  render_verified: z.boolean().optional(),
  report: z.object({ warnings: z.array(z.string()) }).optional(),
  /** Authored id → live id (local dedupe + PHP-side remaps); present only when ids were remapped. */
  remapped_ids: z.record(z.string(), z.string()).optional(),
  /** Drop manifest: submitted elements that did not survive the save (present only when non-empty). */
  dropped_elements: z
    .array(
      z.object({
        id: z.string(),
        elType: z.string(),
        widgetType: z.string().nullable(),
        parent_id: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .optional(),
} as const;

/* ───────────────────────────── elementor.page.replace_tree ──────────────────────────────── */

export const pageReplaceTreeInput = {
  post_id: z.number().int(),
  elements: z.array(elementNodeSchema),
  // §7-AI S1 — the document-settings ALLOWLIST prefilter (PHP stays authoritative).
  settings: pageSettingsInputSchema.optional(),
  base_hash: z.string(),
  confirm: z.boolean().default(false),
  force: z.boolean().default(false),
  prime_css: z.boolean().default(true),
  /** §7-AI S2 — optional post-save+prime render verification (default false for replace_tree). */
  verify_render: z.boolean().default(false),
} as const;

export const pageReplaceTreeOutput = {
  diff: diffSchema,
  preview_url: z.string(),
  base_hash: z.string(),
  css_primed: z.boolean(),
  /** §7-AI S2 — present when `verify_render` ran: whether the permalink probe passed. */
  render_verified: z.boolean().optional(),
  /** Authored id → live id (local dedupe + PHP-side remaps); present only when ids were remapped. */
  remapped_ids: z.record(z.string(), z.string()).optional(),
  /** Drop manifest: submitted elements that did not survive the save (present only when non-empty). */
  dropped_elements: z
    .array(
      z.object({
        id: z.string(),
        elType: z.string(),
        widgetType: z.string().nullable(),
        parent_id: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .optional(),
} as const;

/* ───────────────────────────── elementor.page.update_settings ───────────────────────────── */

export const pageUpdateSettingsInput = {
  post_id: z.number().int(),
  // §7-AI S1 — the document-settings ALLOWLIST prefilter (PHP stays authoritative).
  settings: pageSettingsInputSchema,
  base_hash: z.string().optional(),
} as const;

export const pageUpdateSettingsOutput = {
  success: z.boolean(),
  settings: pageSettingsSchema,
  /** Echoed when a page template (canvas/full-width/default → `_wp_page_template`) was applied. */
  template: z.string().optional(),
} as const;

/* ───────────────────────────── elementor.page.dry_run ───────────────────────────────────── */

export const pageDryRunInput = {
  post_id: z.number().int().optional(),
  elements: z.array(elementNodeSchema),
  // §7-AI S1 — dry_run deliberately keeps the PERMISSIVE settings schema: an allowlist violation
  // must reach PHP and come back as a SUCCESS `{valid:false, errors:[SETTINGS_INVALID]}` result
  // (acceptance A1), never a -32602 input reject that would mask the structured verdict.
  settings: pageSettingsSchema.optional(),
  generation: z.enum(['v4', 'v3']).default('v4'),
} as const;

export const pageDryRunOutput = {
  valid: z.boolean(),
  errors: z.array(dryRunErrorSchema),
  diff: diffSchema.optional(),
  preview_url: z.string().optional(),
} as const;

/* ───────────────────────────── elementor.page.duplicate ─────────────────────────────────── */

export const pageDuplicateInput = {
  post_id: z.number().int(),
  title: z.string().optional(),
} as const;

export const pageDuplicateOutput = {
  post_id: z.number().int(),
  edit_url: z.string(),
} as const;

/* ───────────────────────────── elementor.page.delete ────────────────────────────────────── */

export const pageDeleteInput = {
  post_id: z.number().int(),
  confirm: z.boolean().default(false),
  force_delete: z.boolean().default(false),
} as const;

export const pageDeleteOutput = {
  success: z.boolean(),
  trashed: z.boolean(),
} as const;

/* ───────────────────────────── elementor.page.list_backups ──────────────────────────────── */

/**
 * `elementor.page.list_backups` input (13-tool-catalog.md §1.2; 10-rest-api.md §2.8). Lists the
 * pre-write backup snapshots for a document (paginated) so an agent can pick a `meta_key` to roll
 * back to.
 */
export const pageListBackupsInput = {
  post_id: z.number().int(),
  ...paginationInputShape,
} as const;

/** One backup snapshot list-item (`BackupListItem`, 10-rest-api.md §2.8). */
export const backupListItemSchema = z.object({
  meta_key: z.string(),
  ts: z.number().int(),
  label: z.string(),
  base_hash: z.string(),
});

export const pageListBackupsOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(fieldProjectedItem(backupListItemSchema)),
} as const;

/* ───────────────────────────── elementor.page.rollback ──────────────────────────────────── */

/**
 * `elementor.page.rollback` input (13-tool-catalog.md §1.2; 10-rest-api.md §2.8). Restores a document
 * to a prior backup snapshot. `backup` is the snapshot `meta_key` from `page.list_backups`, or the
 * literal `"latest"` to roll back to the most recent snapshot. Destructive: `confirm` gates the
 * elicitation (a decline is a clean no-op). `prime_css` re-primes atomic CSS after the restore.
 */
export const pageRollbackInput = {
  post_id: z.number().int(),
  backup: z.string().default('latest'),
  confirm: z.boolean().default(false),
  prime_css: z.boolean().default(true),
} as const;

export const pageRollbackOutput = {
  id: z.number().int(),
  restored_from: z.string(),
  base_hash: z.string(),
  css_primed: z.boolean(),
} as const;

/* ───────────────────────────── elementor.page.verify_render ─────────────────────────────── */

/**
 * `elementor.page.verify_render` input (contract 18 §7-AI S2). Exposes the standalone post-save
 * render-verification probe for ANY document: the plugin fetches its own permalink unauthenticated
 * (in-process loopback; direct front-controller dispatch fallback is MANDATORY), asserts HTTP 200 +
 * no fatal marker, and op-logs the outcome. A failed probe is a SUCCESS result with
 * `render_verified:false` (taxonomy `RENDER_FAILED` rides the payload) — the document is unchanged.
 */
export const pageVerifyRenderInput = {
  post_id: z.number().int(),
} as const;

export const pageVerifyRenderOutput = {
  id: z.number().int(),
  render_verified: z.boolean(),
  /** Which probe ran: HTTP loopback of the permalink, or in-process front-controller dispatch. */
  method: z.enum(['loopback', 'dispatch']),
  http_status: z.number().int().nullable(),
  /** The fatal marker / thrown message detected when verification failed, else null. */
  fatal: z.string().nullable(),
  checked_url: z.string().nullable(),
} as const;

/* ───────────────────────────── elementor.page.export_template ───────────────────────────── */

export const pageExportTemplateInput = {
  post_id: z.number().int(),
} as const;

export const pageExportTemplateOutput = {
  content: z.array(elementNodeSchema),
  page_settings: pageSettingsSchema,
  type: z.string(),
  version: z.string(),
  global_classes: z.array(globalClassObjectSchema).optional(),
  global_variables: z.record(z.string(), z.unknown()).optional(),
} as const;
