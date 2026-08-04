/**
 * WP-T07 — design-system handler tests (contract 18 §7-AI S4 — `design.fonts.install`).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + a real WP-F04
 * {@link ToolRegistry}. The suite covers the contract-18 cluster-F surface this WP added:
 *  - EVERY design tool name attaches by EXACT catalog name (incl. the new `fonts.install`),
 *  - `fonts.install` proxies `POST /design/fonts/install` (body pass-through + minted `op_id`),
 *    and its `structuredContent` validates against the WP-F04 descriptor `outputSchema`,
 *  - an `isError`-surfaced {@link WpClientError} (e.g. `VALIDATION_FAILED` from the PHP magic-byte
 *    sniff) renders a clean taxonomy `isError` result (12-error-taxonomy.md §5).
 *
 * The classes/variables handler behavior is covered by `design-classes-diff.test.ts` (diff-PUT) +
 * the contract smoke; this file owns the §7-AI S4 acceptance seam (A4: the NAMED tool exists and
 * round-trips, not just the REST fallback).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import { ErrorCodes, makeErrorPayload, type InstallFontResponse } from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import { WpClientError } from '../wp/types.js';

import {
  attachDesignHandlers,
  fontsInstallHandler,
  DESIGN_TOOL_NAMES,
  DESIGN_FONTS_INSTALL,
} from './design.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the route the fonts handler calls. */
interface MockWp {
  installFont: ReturnType<typeof vi.fn>;
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

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachDesignHandlers', () => {
  it('attaches a handler for every §1.4 design tool name (incl. contract-18 fonts.install)', () => {
    const registry = createToolRegistry();
    attachDesignHandlers(registry);

    for (const name of DESIGN_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
    expect([...DESIGN_TOOL_NAMES]).toContain(DESIGN_FONTS_INSTALL);
  });

  it('fonts.install is catalogued M / non-★ / proxied to the installFont route', () => {
    const registry = createToolRegistry();
    const descriptor = registry.getDescriptor(DESIGN_FONTS_INSTALL);
    expect(descriptor.class).toBe('M');
    expect(descriptor.star).toBe(false);
    expect(descriptor.side).toBe('proxied-to-REST');
    expect(descriptor.route).toBe('installFont');
  });
});

/* ───────────────────────────── elementor.design.fonts.install (18 §7-AI S4) ─────────────────── */

describe('fontsInstallHandler', () => {
  const RESPONSE: InstallFontResponse = {
    family: 'Novaletra Serif CF',
    weight: '400',
    style: 'normal',
    format: 'woff2',
    attachment_id: 321,
    url: 'http://x/wp-content/uploads/fonts/novaletra.woff2',
    registered_via: 'kit_custom_css',
    font_face:
      "@font-face{font-family:'Novaletra Serif CF';src:url(http://x/novaletra.woff2) format('woff2')}",
    warnings: [],
  };

  it('proxies POST /design/fonts/install and returns the schema-valid resolved face', async () => {
    const registry = createToolRegistry();
    const wp: MockWp = { installFont: vi.fn().mockResolvedValue(RESPONSE) };
    const ctx = makeCtx(wp, registry);

    const result = await fontsInstallHandler(
      { source: 'aGVsbG8=', family: 'Novaletra Serif CF', weight: '400', style: 'normal' },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    const out = result.structuredContent as Record<string, unknown>;
    outputValidator(registry, DESIGN_FONTS_INSTALL).parse(out);
    expect(out['family']).toBe('Novaletra Serif CF');
    expect(out['registered_via']).toBe('kit_custom_css');
    expect(out['attachment_id']).toBe(321);

    // Body pass-through + a minted op_id (§0.8 — the client never omits it on writes).
    expect(wp.installFont).toHaveBeenCalledTimes(1);
    const body = wp.installFont.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['source']).toBe('aGVsbG8=');
    expect(body['family']).toBe('Novaletra Serif CF');
    expect(body['weight']).toBe('400');
    expect(body['style']).toBe('normal');
    expect(typeof body['op_id']).toBe('string');
    expect((body['op_id'] as string).length).toBeGreaterThan(0);
  });

  it('omits weight/style from the body when the caller leaves them to the PHP defaults', async () => {
    const registry = createToolRegistry();
    const wp: MockWp = { installFont: vi.fn().mockResolvedValue(RESPONSE) };
    const ctx = makeCtx(wp, registry);

    await fontsInstallHandler({ source: 'https://fonts.example/x.woff2', family: 'X' }, ctx);

    const body = wp.installFont.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('weight' in body).toBe(false);
    expect('style' in body).toBe(false);
  });

  it('surfaces a PHP VALIDATION_FAILED (bad magic bytes) as a clean isError taxonomy result', async () => {
    const registry = createToolRegistry();
    const wp: MockWp = {
      installFont: vi
        .fn()
        .mockRejectedValue(
          new WpClientError(
            makeErrorPayload(
              ErrorCodes.VALIDATION_FAILED,
              'The supplied bytes are not a woff2/woff/ttf/otf face.',
              { http_status: 422 },
            ),
            { httpStatus: 422 },
          ),
        ),
    };
    const ctx = makeCtx(wp, registry);

    const result = await fontsInstallHandler({ source: 'bm90LWEtZm9udA==', family: 'X' }, ctx);
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc['code']).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(sc['surface']).toBe('isError');
  });
});
