/**
 * WP-T08 — media / library tool HANDLERS (Contract 13 §1.5).
 *
 * Implements the media tool group and attaches each handler to the WP-F04 {@link ToolRegistry} by
 * EXACT catalog name (13-tool-catalog.md §1.5). This WP does NOT define schemas (WP-F04 owns the
 * descriptors `schemas/media.ts`) — each handler is a {@link ToolHandler} (WP-T01 `runtime/context.ts`)
 * attached via `registry.attachHandler(name, fn)`; the SDK has already validated `args` against the
 * descriptor's `inputSchema` before the handler runs (Contract 13 §0.1) and validates the returned
 * `structuredContent` against `outputSchema` after.
 *
 * Handlers are THIN proxies (§Implementation Notes): validate-by-SDK → `ctx.wp.<route>(…)` (WP-F02
 * bound facade) → map the RAW REST `data` into the descriptor's `outputSchema` shape → return
 * `{ content, structuredContent }`. The SECURITY boundary lives in PHP (WP-P10): `CAP_UPLOAD` + mime
 * validation. Disallowed mime → `E_MEDIA_TYPE`; bad/unreachable url → `E_BAD_REQUEST` (Contract 10
 * §5.2/§5.3, Contract 12 §3). Those arrive here as a {@link WpClientError} and route through WP-F05's
 * `fromClientError` → protocol-throw vs `isError` result (12-error-taxonomy.md §5); tool-arg failures
 * are `-32602` from the SDK's zod layer before the handler runs.
 *
 * Tools handled here (Contract 13 §1.5):
 *  - `elementor.media.sideload_url` ★ (M, `POST /media/sideload`) — the lean ★ tool the HTML pipeline
 *    (WP-H##) depends on: sideload external images into the library, deduped by source hash, so
 *    `convert.*` can emit `image-src` ID-only (10-rest-api.md §5.2 NORMATIVE; Contract 11 §3.2).
 *  - `elementor.media.upload` (M, `POST /media/upload`) — base64 JSON upload.
 *  - `elementor.media.list` (R, `GET /media`) — paginated search/list.
 *
 * These are media-library writes, NOT element-tree / kit writes → NOT subject to the LOCKED dry_run
 * rule (Contract 10 §0.9 scopes it to authoring writes), and no prime-css / S01 dependency.
 *
 * Contract authority: 13-tool-catalog.md §1.5 (per-tool I/O), §0.6 (pagination); 10-rest-api.md §5.1
 * (list), §5.2 (sideload dedupe + `image-src` id-only), §5.3 (upload base64/multipart); 12-error-
 * taxonomy.md §3 (`E_MEDIA_TYPE`), §5 (surface rules).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type {
  ListMediaRequest,
  ListMediaResponse,
  MediaItem,
  SideloadMediaRequest,
  UploadMediaRequest,
} from '@elementor-ultra/shared';

import type { ToolContext, ToolHandler } from '../runtime/context.js';
import type { ToolRegistry } from '../catalog/registry.js';
import { WpClientError } from '../wp/types.js';
import { fromClientError, type ToolResult } from '../wp/errors.js';

/* ───────────────────────────── frozen tool names (Contract 13 §1.5) ────────────────────────── */

/** The media tool names this WP attaches (EXACT catalog names — 13-tool-catalog.md §1.5). */
export const MEDIA_SIDELOAD_URL = 'elementor.media.sideload_url';
export const MEDIA_UPLOAD = 'elementor.media.upload';
export const MEDIA_LIST = 'elementor.media.list';

/** Every tool name this WP owns a handler for (used by attach + tests). */
export const MEDIA_TOOL_NAMES = [MEDIA_SIDELOAD_URL, MEDIA_UPLOAD, MEDIA_LIST] as const;

/* ───────────────────────────── result helpers ──────────────────────────────────────────────── */

/** Whether a thrown value is a {@link WpClientError} (carries a taxonomy `payload`). */
function isWpClientError(value: unknown): value is WpClientError {
  return value instanceof WpClientError;
}

/**
 * Build a successful tool result: the structured payload (validated against the descriptor's
 * `outputSchema` by the SDK) plus a compact human-readable `text` line (the SDK requires `content`).
 */
function okResult(structured: Record<string, unknown>, text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/**
 * Run a thin media handler: invoke `fn` and, on a {@link WpClientError} (e.g. `E_MEDIA_TYPE` /
 * `E_BAD_REQUEST` from PHP), route it through WP-F05's surface rules (`fromClientError` →
 * protocol-throw or `isError` result, 12-error-taxonomy.md §5). Non-client errors rethrow (the server
 * core surfaces them). The {@link ToolResult} is structurally a {@link CallToolResult}.
 */
async function runMedia(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return (await fn()) as CallToolResult;
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error) as CallToolResult;
    }
    throw error;
  }
}

/* ───────────────────────────── typed validated args (post-SDK) ─────────────────────────────── */
/*
 * The SDK has already parsed `args` against the WP-F04 `inputSchema` ZodRawShape before a handler runs
 * (§Detailed Requirements 7), so the shapes below describe the POST-validation input. They are
 * narrowing views over the loose `unknown` the runtime {@link ToolHandler} declares — NOT
 * re-validation.
 */

interface MediaSideloadUrlArgs {
  url: string;
  alt?: string;
  title?: string;
}

interface MediaUploadArgs {
  data?: string;
  file_path?: string;
  filename?: string;
  alt?: string;
}

interface MediaListArgs {
  query?: string;
  mime?: string;
  limit: number;
  cursor?: string;
  fields?: string[];
}

/* ───────────────────────────── sizes projection (Contract 13 §1.5) ─────────────────────────── */

/** One image-size entry in the catalog `sizes` map (13-tool-catalog.md §1.5). */
interface SizeEntry {
  url: string;
  width: number;
  height: number;
}

/**
 * Project the RAW REST `sizes` map (`Record<string,unknown>`) to the catalog `{url,width,height}`
 * shape (13-tool-catalog.md §1.5). WP-P10 already returns this exact per-size shape (it shapes
 * `wp_get_attachment_metadata` into `{url,width,height}`), so this is a defensive narrowing: any entry
 * missing the trio (or malformed) is dropped so the SDK `outputSchema` validation never rejects an
 * otherwise-valid sideload. The contract is `sizes`, not a media-tree write — dropping a stray size
 * never loses authoring data.
 */
function projectSizes(raw: Record<string, unknown>): Record<string, SizeEntry> {
  const out: Record<string, SizeEntry> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const { url, width, height } = value as { url?: unknown; width?: unknown; height?: unknown };
    if (typeof url === 'string' && typeof width === 'number' && typeof height === 'number') {
      out[name] = { url, width, height };
    }
  }
  return out;
}

/* ───────────────────────────── elementor.media.sideload_url (§1.5 / §5.2) ──────────────────── */

/**
 * `elementor.media.sideload_url` handler (★, 13-tool-catalog.md §1.5; 10-rest-api.md §5.2). Proxies
 * `POST /media/sideload`: PHP wraps `media_handle_sideload`, DEDUPES by `_elementor_source_image_hash`
 * (a repeat returns the existing attachment with `deduped:true`, hence the descriptor's
 * `idempotentHint:true`), and returns `{attachment_id,url,sizes,deduped}`. We reflect `deduped`
 * HONESTLY (§Implementation Notes) and pass `sizes` through (projected to the catalog shape). This is
 * the NORMATIVE path the HTML pipeline (WP-H##) uses to import every `<img>`/`background-image` FIRST
 * so it can emit `image-src` ID-only (id-XOR-url, Contract 11 §3.2) — this WP exposes it; convert
 * orchestrates. `alt`/`title` are forwarded only when provided.
 */
export async function mediaSideloadUrlHandler(
  args: MediaSideloadUrlArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runMedia(async () => {
    const body: SideloadMediaRequest = {
      url: args.url,
      ...(args.alt !== undefined ? { alt: args.alt } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
    };
    const data = await ctx.wp.sideloadMedia(body);
    const structured = {
      attachment_id: data.attachment_id,
      url: data.url,
      sizes: projectSizes(data.sizes),
      deduped: data.deduped,
    };
    return okResult(
      structured,
      `Sideloaded image → attachment ${data.attachment_id}${data.deduped ? ' (deduped — already in library)' : ''}.`,
    );
  });
}

/* ───────────────────────────── elementor.media.upload (§1.5 / §5.3) ────────────────────────── */

/**
 * `elementor.media.upload` handler (13-tool-catalog.md §1.5; 10-rest-api.md §5.3). Proxies `POST
 * /media/upload` with a base64 JSON body `{data,filename,alt?}` (the route ALSO accepts
 * `multipart/form-data`, but the tool surface is base64 JSON — §Detailed Requirements 3). PHP enforces
 * `CAP_UPLOAD` + mime (`E_MEDIA_TYPE`). Returns ONLY `{attachment_id,url}` (the catalog `outputSchema`
 * — the route's `sizes` is intentionally not surfaced here). Large bodies rely on PHP/host limits; a
 * 413/429 surfaces as `RATE_LIMITED`/`UPSTREAM_ERROR` via the client error path (§Implementation
 * Notes). `alt` is forwarded only when provided.
 */
export async function mediaUploadHandler(
  args: MediaUploadArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runMedia(async () => {
    // file-first path: the server reads + base64-encodes the local file ITSELF, so the
    // bytes never round-trip through the conversation/tool params (mirrors
    // `elementor.design.fonts.upload_zip`). Falls back to inline base64 `data`.
    let uploadData: string;
    let filename: string;
    if (args.file_path) {
      const { readFile } = await import('node:fs/promises');
      const nodePath = await import('node:path');
      const buf = await readFile(args.file_path);
      uploadData = buf.toString('base64');
      filename = args.filename ?? nodePath.basename(args.file_path);
    } else if (args.data) {
      if (!args.filename) {
        throw Object.assign(new Error('filename is required when uploading base64 data.'), {
          code: 'VALIDATION_FAILED',
        });
      }
      uploadData = args.data;
      filename = args.filename;
    } else {
      throw Object.assign(new Error('Provide either file_path or data.'), {
        code: 'VALIDATION_FAILED',
      });
    }
    const body: UploadMediaRequest = {
      data: uploadData,
      filename,
      ...(args.alt !== undefined ? { alt: args.alt } : {}),
    };
    const data = await ctx.wp.uploadMedia(body);
    const structured = {
      attachment_id: data.attachment_id,
      url: data.url,
    };
    return okResult(structured, `Uploaded ${filename} → attachment ${data.attachment_id}.`);
  });
}

/* ───────────────────────────── elementor.media.list (§1.5 / §0.6) ──────────────────────────── */

/**
 * `elementor.media.list` handler (13-tool-catalog.md §1.5; 10-rest-api.md §5.1). Proxies `GET /media`
 * with `{query,mime}` + §0.6 pagination (`limit`/`cursor`/`fields`), then projects each RAW
 * {@link MediaItem} (`{attachment_id,url,title,alt,mime,sizes}`) to the catalog item
 * `{id,url,mime,alt,title}` (`attachment_id`⇒`id`; the heavy `sizes` is dropped for the list view).
 * NEVER unbounded — the SDK supplies the default `limit` (§0.6) and PHP returns the opaque
 * `next_cursor` (§0.11). `query`/`mime`/`cursor`/`fields` are forwarded only when provided.
 */
export async function mediaListHandler(
  args: MediaListArgs,
  ctx: ToolContext,
): Promise<CallToolResult> {
  return runMedia(async () => {
    const query: ListMediaRequest = {
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.mime !== undefined ? { mime: args.mime } : {}),
      limit: args.limit,
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(args.fields !== undefined ? { fields: args.fields } : {}),
    };
    const data: ListMediaResponse = await ctx.wp.listMedia(query);
    const items = data.items.map((item: MediaItem) => ({
      id: item.attachment_id,
      url: item.url,
      mime: item.mime,
      alt: item.alt,
      title: item.title,
    }));
    const structured = {
      items,
      next_cursor: data.next_cursor,
      total: data.total ?? items.length,
    };
    return okResult(
      structured,
      `Listed ${items.length} media item(s)${data.next_cursor !== null ? ' (more available)' : ''}.`,
    );
  });
}

/* ───────────────────────────── attachment (Seam A — registry.attachHandler) ────────────────── */

/**
 * Attach every media handler to the WP-F04 {@link ToolRegistry} by EXACT catalog name (§Detailed
 * Requirements 1; §Acceptance). The registry stores handlers under its loose `(args) => unknown` type;
 * the runtime invokes them as `(args, ctx)` (server core casts to the WP-T01 {@link ToolHandler}
 * signature), so each handler is registered through that signature here.
 */
export function attachMediaHandlers(registry: ToolRegistry): void {
  const handlers: Record<string, ToolHandler> = {
    [MEDIA_SIDELOAD_URL]: (args, ctx) => mediaSideloadUrlHandler(args as MediaSideloadUrlArgs, ctx),
    [MEDIA_UPLOAD]: (args, ctx) => mediaUploadHandler(args as MediaUploadArgs, ctx),
    [MEDIA_LIST]: (args, ctx) => mediaListHandler(args as MediaListArgs, ctx),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    // The registry's ToolHandler is the loose `(args) => unknown`; the runtime signature carries `ctx`.
    registry.attachHandler(name, handler as unknown as (args: Record<string, unknown>) => unknown);
  }
}
