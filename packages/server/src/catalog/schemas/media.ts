/**
 * WP-F04 — media / library tool schemas (13-tool-catalog.md §1.5).
 *
 * Covers: `elementor.media.sideload_url`, `elementor.media.upload`, `elementor.media.list`.
 * ZodRawShape maps (§0.1); `media.list` spreads pagination (§0.6).
 */

import { z } from 'zod';

import { fieldProjectedItem, paginationInputShape, paginatedOutput } from './shared.js';

/* ───────────────────────────── elementor.media.sideload_url ─────────────────────────────── */

export const mediaSideloadUrlInput = {
  url: z.string(),
  alt: z.string().optional(),
  title: z.string().optional(),
} as const;

export const mediaSideloadUrlOutput = {
  attachment_id: z.number().int(),
  url: z.string(),
  sizes: z.record(
    z.string(),
    z.object({
      url: z.string(),
      width: z.number().int(),
      height: z.number().int(),
    }),
  ),
  deduped: z.boolean(),
} as const;

/* ───────────────────────────── elementor.media.upload ───────────────────────────────────── */

export const mediaUploadInput = {
  file_path: z
    .string()
    .optional()
    .describe(
      'Local filesystem path to an image/file. The server reads + base64-encodes it itself, so the bytes NEVER travel through the conversation/tool params (the fast, context-free path — prefer this for local assets). filename defaults to the path basename. Provide either file_path OR data.',
    ),
  data: z
    .string()
    .optional()
    .describe('Base64-encoded file content. Requires filename. Provide either data OR file_path.'),
  filename: z
    .string()
    .optional()
    .describe('Destination filename. Required with data; defaults to the file_path basename when omitted.'),
  alt: z.string().optional(),
} as const;

export const mediaUploadOutput = {
  attachment_id: z.number().int(),
  url: z.string(),
} as const;

/* ───────────────────────────── elementor.media.list ─────────────────────────────────────── */

export const mediaListInput = {
  query: z.string().optional(),
  mime: z.string().optional(),
  ...paginationInputShape,
} as const;

export const mediaListOutput = {
  // `fields`-projectable items (§0.6) — every property optional; see `fieldProjectedItem`.
  ...paginatedOutput(
    fieldProjectedItem(
      z.object({
        id: z.number().int(),
        url: z.string(),
        mime: z.string(),
        alt: z.string(),
        title: z.string(),
      }),
    ),
  ),
} as const;
