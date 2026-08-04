/**
 * WP-T12 — resource read/list handler tests (§Tests Required). No live WP: a stub `ctx.wp` records the
 * route each handler hits and returns a canned `data`. Asserts:
 *  - every §2 resource is attached (read for all ten; `list` for the three collection resources only);
 *  - each read handler resolves to the CORRECT WP-F02 route + serializes the route `data` as the body;
 *  - parametric resources extract `{type}`/`{id}` and reject a missing/invalid variable (ResourceUriError);
 *  - collection `list` callbacks enumerate members + surface the cursor where the route paginates;
 *  - a thrown WpClientError (NOT_FOUND) propagates out of the read handler (the SDK renders it).
 */

import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes, makeErrorPayload } from '@elementor-ultra/shared';

import type { ToolContext } from '../runtime/context.js';
import { WpClientError } from '../wp/types.js';
import { RESOURCE_DESCRIPTORS } from '../catalog/resources.js';

import { ATTACHED_RESOURCES, getAttachedResource, ResourceUriError } from './index.js';

/* ───────────────────────────── test doubles ───────────────────────────────────────────────── */

/** Build a {@link ToolContext} whose `wp` facade is a record of `vi.fn()` route stubs. */
function ctxWith(wp: Record<string, unknown>): ToolContext {
  return { wp } as unknown as ToolContext;
}

/** Parse the single JSON body block out of a read result. */
function bodyOf(result: { contents: Array<{ uri: string; mimeType?: string; text?: string }> }): {
  uri: string;
  mimeType: string | undefined;
  data: unknown;
} {
  const block = result.contents[0];
  expect(block).toBeDefined();
  return {
    uri: block!.uri,
    mimeType: block!.mimeType,
    data: JSON.parse(block!.text ?? 'null') as unknown,
  };
}

/* ───────────────────────────── attachment coverage ────────────────────────────────────────── */

describe('ATTACHED_RESOURCES — frozen §2 coverage', () => {
  it('attaches a read handler for ALL ten §2 resources, in catalog order', () => {
    expect(ATTACHED_RESOURCES).toHaveLength(RESOURCE_DESCRIPTORS.length);
    expect(ATTACHED_RESOURCES.map((r) => r.descriptor.uri)).toEqual(
      RESOURCE_DESCRIPTORS.map((d) => d.uri),
    );
    for (const r of ATTACHED_RESOURCES) {
      expect(typeof r.read).toBe('function');
    }
  });

  it('supplies a `list` callback ONLY for the three enumerable-collection resources', () => {
    const withList = ATTACHED_RESOURCES.filter((r) => r.list !== undefined).map(
      (r) => r.descriptor.uri,
    );
    expect(withList.sort()).toEqual(
      [
        'elementor://kit/global-classes',
        'elementor://kit/variables',
        'elementor://templates',
      ].sort(),
    );
  });

  it('adds NO resources beyond the frozen catalog (getAttachedResource is exhaustive)', () => {
    for (const d of RESOURCE_DESCRIPTORS) {
      expect(getAttachedResource(d.uri)).toBeDefined();
    }
    expect(getAttachedResource('elementor://not/a/resource')).toBeUndefined();
  });
});

/* ───────────────────────────── read handlers → correct route + body ───────────────────────── */

describe('read handlers — route binding + JSON body', () => {
  it('site/capabilities reads the NORMALIZED probe (siteCapabilities), not the raw route', async () => {
    const caps = { v4: true, atomic: true };
    const wp = {
      siteCapabilities: vi.fn(() => Promise.resolve(caps)),
      getSiteCapabilities: vi.fn(() => Promise.resolve({ raw: true })),
    };
    const r = getAttachedResource('elementor://site/capabilities')!;
    const out = await r.read(new URL('elementor://site/capabilities'), {}, ctxWith(wp));

    expect(wp.siteCapabilities).toHaveBeenCalledTimes(1);
    expect(wp.getSiteCapabilities).not.toHaveBeenCalled();
    const body = bodyOf(out);
    expect(body.mimeType).toBe('application/json');
    expect(body.data).toEqual(caps);
  });

  it('each static read handler hits its backing route and serializes the data', async () => {
    const cases: Array<{ uri: string; method: string; data: unknown }> = [
      { uri: 'elementor://breakpoints', method: 'schemaBreakpoints', data: { breakpoints: [] } },
      { uri: 'elementor://schema/styles', method: 'schemaStyles', data: { props: {} } },
      {
        uri: 'elementor://kit/global-classes',
        method: 'listGlobalClasses',
        data: { items: [], order: [], next_cursor: null, total: 0 },
      },
      {
        uri: 'elementor://kit/variables',
        method: 'listVariables',
        data: { variables: {}, total: 0, watermark: 1 },
      },
      {
        uri: 'elementor://kit/global-colors',
        method: 'getGlobalColors',
        data: { system: [], custom: [] },
      },
      {
        uri: 'elementor://kit/element-defaults',
        method: 'getElementDefaults',
        data: { defaults: {} },
      },
      {
        uri: 'elementor://templates',
        method: 'listTemplates',
        data: { items: [], next_cursor: null, total: 0 },
      },
    ];

    for (const c of cases) {
      const fn = vi.fn(() => Promise.resolve(c.data));
      const wp: Record<string, unknown> = { [c.method]: fn };
      const r = getAttachedResource(c.uri)!;
      const out = await r.read(new URL(c.uri), {}, ctxWith(wp));

      expect(fn, `route for ${c.uri}`).toHaveBeenCalledTimes(1);
      const body = bodyOf(out);
      expect(body.uri).toBe(new URL(c.uri).href);
      expect(body.mimeType).toBe('application/json');
      expect(body.data).toEqual(c.data);
    }
  });
});

/* ───────────────────────────── parametric variable extraction ──────────────────────────────── */

describe('parametric resources — {type}/{id} extraction', () => {
  it('schema/widget/{type} extracts {type} and calls schemaWidget(type)', async () => {
    const data = { kind: 'atomic', schema: {}, dynamic_props: [], version: '1' };
    const schemaWidget = vi.fn(() => Promise.resolve(data));
    const r = getAttachedResource('elementor://schema/widget/{type}')!;
    const out = await r.read(
      new URL('elementor://schema/widget/e-heading'),
      { type: 'e-heading' },
      ctxWith({ schemaWidget }),
    );

    expect(schemaWidget).toHaveBeenCalledWith('e-heading');
    expect(bodyOf(out).data).toEqual(data);
  });

  it('page/{id}/structure coerces {id} to a number and calls getDocument(id)', async () => {
    const data = { elements: [], base_hash: 'abc', generation: 'v4' };
    const getDocument = vi.fn(() => Promise.resolve(data));
    const r = getAttachedResource('elementor://page/{id}/structure')!;
    const out = await r.read(
      new URL('elementor://page/42/structure'),
      { id: '42' },
      ctxWith({ getDocument }),
    );

    expect(getDocument).toHaveBeenCalledWith(42);
    expect(bodyOf(out).data).toEqual(data);
  });

  it('throws ResourceUriError when a required {type} variable is absent', async () => {
    const r = getAttachedResource('elementor://schema/widget/{type}')!;
    await expect(
      r.read(new URL('elementor://schema/widget/'), {}, ctxWith({ schemaWidget: vi.fn() })),
    ).rejects.toBeInstanceOf(ResourceUriError);
  });

  it('throws ResourceUriError when {id} is not a non-negative integer', async () => {
    const r = getAttachedResource('elementor://page/{id}/structure')!;
    await expect(
      r.read(
        new URL('elementor://page/abc/structure'),
        { id: 'abc' },
        ctxWith({ getDocument: vi.fn() }),
      ),
    ).rejects.toBeInstanceOf(ResourceUriError);
  });

  it('accepts the first value when the SDK supplies a string[] variable', async () => {
    const schemaWidget = vi.fn(() => Promise.resolve({ kind: 'classic' }));
    const r = getAttachedResource('elementor://schema/widget/{type}')!;
    await r.read(
      new URL('elementor://schema/widget/e-button'),
      { type: ['e-button', 'ignored'] },
      ctxWith({ schemaWidget }),
    );
    expect(schemaWidget).toHaveBeenCalledWith('e-button');
  });
});

/* ───────────────────────────── list callbacks (collection resources) ──────────────────────── */

describe('list callbacks — enumerate members + cursor', () => {
  it('templates list enumerates member URIs from template ids', async () => {
    const listTemplates = vi.fn(() =>
      Promise.resolve({
        items: [
          { template_id: 7, title: 'Hero', type: 'section' },
          { template_id: 9, title: 'Footer', type: 'section' },
        ],
        next_cursor: null,
        total: 2,
      }),
    );
    const r = getAttachedResource('elementor://templates')!;
    const out = await r.list!(ctxWith({ listTemplates }));

    expect(out.resources.map((m) => m.uri)).toEqual([
      'elementor://templates/7',
      'elementor://templates/9',
    ]);
    expect(out.resources[0]!.name).toBe('Hero');
    expect(out.nextCursor).toBeUndefined();
  });

  it('global-classes list surfaces the next_cursor when the route paginates', async () => {
    const listGlobalClasses = vi.fn(() =>
      Promise.resolve({
        items: [{ id: 'g-1', label: 'card', type: 'class', variants: [] }],
        order: ['g-1'],
        next_cursor: 'CURSOR2',
        total: 50,
      }),
    );
    const r = getAttachedResource('elementor://kit/global-classes')!;
    const out = await r.list!(ctxWith({ listGlobalClasses }));

    expect(out.resources).toEqual([
      {
        uri: 'elementor://kit/global-classes/g-1',
        name: 'card',
        mimeType: 'application/json',
        description: 'Global class "card" (g-1)',
      },
    ]);
    expect(out.nextCursor).toBe('CURSOR2');
  });

  it('variables list enumerates members from the variables map (no cursor)', async () => {
    const listVariables = vi.fn(() =>
      Promise.resolve({
        variables: {
          'e-gv-1': { type: 'global-color-variable', label: 'brand', value: '#375EFB', order: 0 },
        },
        total: 1,
        watermark: 7,
      }),
    );
    const r = getAttachedResource('elementor://kit/variables')!;
    const out = await r.list!(ctxWith({ listVariables }));

    expect(out.resources).toEqual([
      {
        uri: 'elementor://kit/variables/e-gv-1',
        name: 'brand',
        mimeType: 'application/json',
        description: 'global-color-variable "brand" (e-gv-1)',
      },
    ]);
    expect(out.nextCursor).toBeUndefined();
  });
});

/* ───────────────────────────── error propagation ──────────────────────────────────────────── */

describe('read errors propagate to the SDK', () => {
  it('a NOT_FOUND WpClientError from the route rejects the read (surfaced as a read error)', async () => {
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'No such page');
    const getDocument = vi.fn(() =>
      Promise.reject(new WpClientError(payload, { httpStatus: 404 })),
    );
    const r = getAttachedResource('elementor://page/{id}/structure')!;

    await expect(
      r.read(new URL('elementor://page/999/structure'), { id: '999' }, ctxWith({ getDocument })),
    ).rejects.toBeInstanceOf(WpClientError);
  });
});
