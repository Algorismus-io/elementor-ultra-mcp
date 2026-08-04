/**
 * WP-F04 — widget / element op tool schemas (13-tool-catalog.md §1.3).
 *
 * Covers: `elementor.element.get`, `elementor.widget.insert`, `elementor.widget.update_settings`,
 * `elementor.element.move`, `elementor.element.delete`, `elementor.element.set_classes`,
 * `elementor.element.set_local_style`, `elementor.element.bind_dynamic`,
 * `elementor.element.bind_global`.
 *
 * Every single-element op is a transactional PHP read-mutate-validate-write (§1.3 intro). Surgical
 * writes REQUIRE `base_hash` (§0.8). Outputs return `diff` + the new `base_hash` (§0.7). ZodRawShape
 * maps (§0.1).
 */

import { z } from 'zod';

import { diffSchema, elementNodeSchema, styleVariantSchema } from './shared.js';

/* ───────────────────────────── elementor.element.get ────────────────────────────────────── */

export const elementGetInput = {
  post_id: z.number().int(),
  element_id: z.string(),
} as const;

export const elementGetOutput = {
  node: elementNodeSchema,
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.widget.insert ──────────────────────────────────── */

export const widgetInsertInput = {
  post_id: z.number().int(),
  parent_id: z.string(),
  index: z.number().int().optional(),
  node: elementNodeSchema,
  base_hash: z.string(),
  op_id: z.string().optional(),
  force: z.boolean().default(false),
} as const;

export const widgetInsertOutput = {
  diff: diffSchema,
  inserted_id: z.string(),
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.widget.update_settings ─────────────────────────── */

export const widgetUpdateSettingsInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  settings: z.record(z.string(), z.unknown()),
  base_hash: z.string(),
  force: z.boolean().default(false),
} as const;

export const widgetUpdateSettingsOutput = {
  diff: diffSchema,
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.element.move ───────────────────────────────────── */

export const elementMoveInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  new_parent_id: z.string(),
  index: z.number().int(),
  base_hash: z.string(),
  force: z.boolean().default(false),
} as const;

export const elementMoveOutput = {
  diff: diffSchema,
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.element.delete ─────────────────────────────────── */

export const elementDeleteInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  base_hash: z.string(),
  confirm: z.boolean().default(false),
  force: z.boolean().default(false),
} as const;

export const elementDeleteOutput = {
  diff: diffSchema,
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.element.set_classes ────────────────────────────── */

export const elementSetClassesInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  class_ids: z.array(z.string()),
  base_hash: z.string(),
} as const;

export const elementSetClassesOutput = {
  diff: diffSchema,
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.element.set_local_style ────────────────────────── */

export const elementSetLocalStyleInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  style_id: z.string().optional(),
  variant: styleVariantSchema,
  base_hash: z.string(),
} as const;

export const elementSetLocalStyleOutput = {
  diff: diffSchema,
  style_id: z.string(),
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.element.bind_dynamic ───────────────────────────── */

export const elementBindDynamicInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  control: z.string(),
  tag_name: z.string(),
  tag_settings: z.record(z.string(), z.unknown()).optional(),
  fallback_value: z.unknown().optional(),
  base_hash: z.string(),
} as const;

export const elementBindDynamicOutput = {
  diff: diffSchema,
  dynamic_string: z.string(),
  base_hash: z.string(),
} as const;

/* ───────────────────────────── elementor.element.bind_global ────────────────────────────── */

export const elementBindGlobalInput = {
  post_id: z.number().int(),
  element_id: z.string(),
  control: z.string(),
  global_ref: z.string(),
  base_hash: z.string(),
} as const;

export const elementBindGlobalOutput = {
  diff: diffSchema,
  base_hash: z.string(),
} as const;
