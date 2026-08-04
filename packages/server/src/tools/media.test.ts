/**
 * WP-T08 — media / library handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + a real WP-F04
 * {@link ToolRegistry}. The tests assert:
 *  - all three §1.5 handlers attach by EXACT catalog name; `media.sideload_url` is ★ + `idempotentHint`,
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`,
 *  - `sideload_url` passes `deduped` through honestly and projects `sizes` to `{url,width,height}`,
 *  - `upload` sends the base64 JSON body and returns ONLY `{attachment_id,url}`,
 *  - `list` paginates (forwards `query`/`mime`/`limit`/`cursor`) and maps `attachment_id`⇒`id`,
 *  - a `surface:'isError'` {@link WpClientError} (e.g. `MEDIA_TYPE` / `BAD_REQUEST`) renders an
 *    `isError` taxonomy result, a `surface:'protocol'` payload THROWS a {@link ProtocolError}, and a
 *    non-client error rethrows (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type ListMediaResponse,
  type SideloadMediaResponse,
  type UploadMediaResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import { WpClientError } from '../wp/types.js';
import { ProtocolError } from '../wp/errors.js';

import {
  attachMediaHandlers,
  mediaSideloadUrlHandler,
  mediaUploadHandler,
  mediaListHandler,
  MEDIA_TOOL_NAMES,
  MEDIA_SIDELOAD_URL,
  MEDIA_UPLOAD,
  MEDIA_LIST,
} from './media.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the media routes the handlers call. */
interface MockWp {
  sideloadMedia: ReturnType<typeof vi.fn>;
  uploadMedia: ReturnType<typeof vi.fn>;
  listMedia: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    sideloadMedia: vi.fn(),
    uploadMedia: vi.fn(),
    listMedia: vi.fn(),
  };
}

/** Build a minimal {@link ToolContext} carrying the mock `wp` and a real registry. */
function makeCtx(wp: MockWp, registry: ToolRegistry): ToolContext {
  return {
    wp,
    registry,
    surface: {} as ToolContext['surface'],
    capabilities: {} as ToolContext['capabilities'],
    elicit: (() => Promise.resolve(false)) as unknown as ToolContext['elicit'],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolContext;
}

/** The WP-F04 descriptor `outputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function outputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).outputSchema);
}

/** Extract the `structuredContent` from a tool result (assumes a success result). */
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachMediaHandlers', () => {
  it('attaches a handler for every §1.5 media tool', () => {
    const registry = createToolRegistry();
    attachMediaHandlers(registry);

    for (const name of MEDIA_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the three §1.5 media names', () => {
    expect([...MEDIA_TOOL_NAMES].sort()).toEqual(
      [MEDIA_SIDELOAD_URL, MEDIA_UPLOAD, MEDIA_LIST].sort(),
    );
  });

  it('exposes media.sideload_url as ★ with idempotentHint (dedupe is a no-op repeat)', () => {
    const registry = createToolRegistry();
    const descriptor = registry.getDescriptor(MEDIA_SIDELOAD_URL);
    expect(descriptor.star).toBe(true);
    expect((descriptor.annotations as { idempotentHint?: boolean }).idempotentHint).toBe(true);
  });
});

/* ───────────────────────────── elementor.media.sideload_url (§5.2) ──────────────────────────── */

describe('mediaSideloadUrlHandler', () => {
  it('proxies POST /media/sideload, passes deduped through, projects sizes', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: SideloadMediaResponse = {
      attachment_id: 124,
      url: 'http://x/wp-content/uploads/img.jpg',
      sizes: {
        full: { url: 'http://x/img.jpg', width: 1000, height: 800 },
        thumbnail: { url: 'http://x/img-150.jpg', width: 150, height: 150 },
      },
      deduped: false,
    };
    wp.sideloadMedia.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await mediaSideloadUrlHandler(
      { url: 'http://src/img.jpg', alt: 'an image', title: 'Img' },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, MEDIA_SIDELOAD_URL).parse(out);

    // Body forwarded with alt/title.
    expect(wp.sideloadMedia).toHaveBeenCalledWith({
      url: 'http://src/img.jpg',
      alt: 'an image',
      title: 'Img',
    });
    expect(out['attachment_id']).toBe(124);
    expect(out['url']).toBe('http://x/wp-content/uploads/img.jpg');
    expect(out['deduped']).toBe(false);
    const sizes = out['sizes'] as Record<string, { url: string; width: number; height: number }>;
    expect(Object.keys(sizes).sort()).toEqual(['full', 'thumbnail']);
    expect(sizes['full']).toEqual({ url: 'http://x/img.jpg', width: 1000, height: 800 });
  });

  it('reflects deduped:true honestly on a repeat sideload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: SideloadMediaResponse = {
      attachment_id: 55,
      url: 'http://x/existing.png',
      sizes: { full: { url: 'http://x/existing.png', width: 10, height: 10 } },
      deduped: true,
    };
    wp.sideloadMedia.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await mediaSideloadUrlHandler({ url: 'http://src/existing.png' }, ctx);
    const out = structured(result);
    outputValidator(registry, MEDIA_SIDELOAD_URL).parse(out);

    expect(out['deduped']).toBe(true);
    // No alt/title forwarded when omitted.
    expect(wp.sideloadMedia).toHaveBeenCalledWith({ url: 'http://src/existing.png' });
  });

  it('drops malformed size entries so the output still validates', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: SideloadMediaResponse = {
      attachment_id: 9,
      url: 'http://x/i.jpg',
      sizes: {
        full: { url: 'http://x/i.jpg', width: 5, height: 5 },
        // Malformed entries (WP occasionally emits partial metadata) — must be dropped, not crash.
        // `sizes` is typed `Record<string, unknown>`, so these need no cast.
        broken: { width: 1 },
        nullish: null,
      },
      deduped: false,
    };
    wp.sideloadMedia.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await mediaSideloadUrlHandler({ url: 'http://src/i.jpg' }, ctx);
    const out = structured(result);
    // Must validate (malformed sizes stripped).
    outputValidator(registry, MEDIA_SIDELOAD_URL).parse(out);
    expect(Object.keys(out['sizes'] as Record<string, unknown>)).toEqual(['full']);
  });
});

/* ───────────────────────────── elementor.media.upload (§5.3) ────────────────────────────────── */

describe('mediaUploadHandler', () => {
  it('sends the base64 JSON body and returns only {attachment_id,url}', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: UploadMediaResponse = {
      attachment_id: 125,
      url: 'http://x/up.png',
      sizes: { full: { url: 'http://x/up.png', width: 1, height: 1 } },
    };
    wp.uploadMedia.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await mediaUploadHandler(
      { data: 'AAAA', filename: 'up.png', alt: 'uploaded' },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, MEDIA_UPLOAD).parse(out);

    expect(wp.uploadMedia).toHaveBeenCalledWith({
      data: 'AAAA',
      filename: 'up.png',
      alt: 'uploaded',
    });
    // Catalog output is ONLY {attachment_id,url} — `sizes` from the route is not surfaced.
    expect(Object.keys(out).sort()).toEqual(['attachment_id', 'url']);
    expect(out['attachment_id']).toBe(125);
    expect(out['url']).toBe('http://x/up.png');
  });

  it('omits alt when not provided', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.uploadMedia.mockResolvedValue({
      attachment_id: 1,
      url: 'http://x/y.png',
      sizes: {},
    } satisfies UploadMediaResponse);
    const ctx = makeCtx(wp, registry);

    await mediaUploadHandler({ data: 'BBBB', filename: 'y.png' }, ctx);

    const arg = wp.uploadMedia.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('alt' in arg).toBe(false);
    expect(arg['data']).toBe('BBBB');
    expect(arg['filename']).toBe('y.png');
  });
});

/* ───────────────────────────── elementor.media.list (§0.6 pagination) ──────────────────────── */

describe('mediaListHandler', () => {
  const item: ListMediaResponse['items'][number] = {
    attachment_id: 56,
    url: 'http://x/p.png',
    title: 'P',
    alt: 'alt p',
    mime: 'image/png',
    sizes: { full: { url: 'http://x/p.png', width: 1, height: 1 } },
  };

  it('forwards query/mime/pagination and maps attachment_id⇒id', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: ListMediaResponse = { items: [item], next_cursor: 'cur-2', total: 48 };
    wp.listMedia.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await mediaListHandler(
      { query: 'logo', mime: 'image/png', limit: 25, cursor: 'cur-1', fields: ['id'] },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, MEDIA_LIST).parse(out);

    expect(wp.listMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'logo',
        mime: 'image/png',
        limit: 25,
        cursor: 'cur-1',
      }),
    );
    expect(out['next_cursor']).toBe('cur-2');
    expect(out['total']).toBe(48);
    const got = (out['items'] as Array<Record<string, unknown>>)[0];
    // Item projected to exactly the 5 catalog keys, attachment_id renamed to id.
    expect(Object.keys(got ?? {}).sort()).toEqual(['alt', 'id', 'mime', 'title', 'url']);
    expect(got?.['id']).toBe(56);
  });

  it('omits optional query params when not provided and never goes unbounded (limit always sent)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listMedia.mockResolvedValue({ items: [], next_cursor: null, total: 0 });
    const ctx = makeCtx(wp, registry);

    await mediaListHandler({ limit: 50 }, ctx);

    const arg = wp.listMedia.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('query' in arg).toBe(false);
    expect('mime' in arg).toBe(false);
    expect('cursor' in arg).toBe(false);
    expect('fields' in arg).toBe(false);
    expect(arg['limit']).toBe(50);
  });

  it('falls back total to item count when the route omits it', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // `total` deliberately omitted to exercise the `?? items.length` fallback.
    wp.listMedia.mockResolvedValue({
      items: [item],
      next_cursor: null,
    });
    const ctx = makeCtx(wp, registry);

    const result = await mediaListHandler({ limit: 50 }, ctx);
    const out = structured(result);
    outputValidator(registry, MEDIA_LIST).parse(out);
    expect(out['total']).toBe(1);
  });
});

/* ───────────────────────────── error rendering (12-error-taxonomy.md §5) ───────────────────── */

describe('error rendering', () => {
  // PHP's `E_MEDIA_TYPE` (disallowed mime, 422) maps to taxonomy `VALIDATION_FAILED` in `wp/client.ts`
  // (surface:'isError') — the handler routes whatever the WpClientError carries.
  it('renders an isError taxonomy result for a disallowed mime (E_MEDIA_TYPE ⇒ VALIDATION_FAILED)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.VALIDATION_FAILED, 'Disallowed mime type', {
      http_status: 422,
    });
    wp.uploadMedia.mockRejectedValue(new WpClientError(payload, { httpStatus: 422 }));
    const ctx = makeCtx(wp, registry);

    const result = await mediaUploadHandler({ data: 'XX', filename: 'evil.svg' }, ctx);

    expect(result.isError).toBe(true);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc['code']).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(sc['surface']).toBe('isError');
  });

  // PHP's `E_BAD_REQUEST` (bad/unreachable url, 400) maps to taxonomy `VALIDATION_FAILED`.
  it('renders an isError taxonomy result for a bad/unreachable url (E_BAD_REQUEST ⇒ VALIDATION_FAILED)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.VALIDATION_FAILED, 'Could not download the URL', {
      http_status: 400,
    });
    wp.sideloadMedia.mockRejectedValue(new WpClientError(payload, { httpStatus: 400 }));
    const ctx = makeCtx(wp, registry);

    const result = await mediaSideloadUrlHandler({ url: 'http://nope/missing.jpg' }, ctx);

    expect(result.isError).toBe(true);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc['code']).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(sc['surface']).toBe('isError');
  });

  it('THROWS a ProtocolError for a surface:protocol payload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params');
    wp.listMedia.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    await expect(mediaListHandler({ limit: 50 }, ctx)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-WpClientError unchanged', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.sideloadMedia.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(mediaSideloadUrlHandler({ url: 'http://x/y.jpg' }, ctx)).rejects.toThrow('boom');
  });
});
