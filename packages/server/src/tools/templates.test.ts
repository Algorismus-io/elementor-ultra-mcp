/**
 * WP-T10 — templates / kits handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + `ctx.elicit` + a real WP-F04
 * {@link ToolRegistry}. The tests assert:
 *  - all eight §1.7 handlers attach by EXACT catalog name; none are ★ (Contract 13 §5.2),
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`,
 *  - `templates.list` paginates (forwards `type`/`limit`/`cursor`) + projects `source`,
 *  - `templates.save` pre-filters (hard reject short-circuits) then persists + maps `edit_url`,
 *  - `templates.insert_into_page` requires exactly one of `template_id`/`content`, mints FRESH ids over
 *    the inserted subtree against a used-id set (no collisions, incl. a double-paste), and synthesizes a
 *    `Diff` from `inserted_ids`,
 *  - `templates.import` maps `imported_ids[0]`⇒`template_id` + surfaces `remapped_ids`; a remap failure
 *    (`IMPORT_REMAP_FAILED` WpClientError) renders an `isError` result,
 *  - `kit.import`/`kit.revert` elicitation-gate (decline ⇒ clean non-error, no REST call); `kit.export`
 *    is read-only and maps `download_url`⇒`file_path`,
 *  - a `surface:'protocol'` payload THROWS a {@link ProtocolError}; a non-client error rethrows
 *    (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type DocumentIdsResponse,
  type GetTemplateResponse,
  type ImportTemplateResponse,
  type InsertTemplateResponse,
  type KitExportResponse,
  type KitImportResponse,
  type KitRevertResponse,
  type ListTemplatesResponse,
  type SaveTemplateResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import type { ElementNode } from '../authoring/contract.js';
import { collectIds } from '../authoring/ids.js';
import { WpClientError } from '../wp/types.js';
import { ProtocolError } from '../wp/errors.js';

import {
  attachTemplatesHandlers,
  templatesListHandler,
  templatesGetHandler,
  templatesSaveHandler,
  templatesImportHandler,
  templatesInsertIntoPageHandler,
  kitExportHandler,
  kitImportHandler,
  kitRevertHandler,
  TEMPLATES_TOOL_NAMES,
  TEMPLATES_LIST,
  TEMPLATES_GET,
  TEMPLATES_SAVE,
  TEMPLATES_IMPORT,
  TEMPLATES_INSERT_INTO_PAGE,
  KIT_EXPORT,
  KIT_IMPORT,
  KIT_REVERT,
} from './templates.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the templates/kits routes the handlers call. */
interface MockWp {
  listTemplates: ReturnType<typeof vi.fn>;
  getTemplate: ReturnType<typeof vi.fn>;
  saveTemplate: ReturnType<typeof vi.fn>;
  importTemplate: ReturnType<typeof vi.fn>;
  insertTemplate: ReturnType<typeof vi.fn>;
  documentIds: ReturnType<typeof vi.fn>;
  kitExport: ReturnType<typeof vi.fn>;
  kitImport: ReturnType<typeof vi.fn>;
  kitRevert: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    listTemplates: vi.fn(),
    getTemplate: vi.fn(),
    saveTemplate: vi.fn(),
    importTemplate: vi.fn(),
    insertTemplate: vi.fn(),
    documentIds: vi.fn(),
    kitExport: vi.fn(),
    kitImport: vi.fn(),
    kitRevert: vi.fn(),
  };
}

/** A confirm/decline elicit mock matching `ElicitFn`'s `{confirmed}` outcome. */
function makeElicit(confirmed: boolean): ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve({ confirmed }));
}

/** Build a minimal {@link ToolContext} carrying the mock `wp`, an elicit, and a real registry. */
function makeCtx(
  wp: MockWp,
  registry: ToolRegistry,
  elicit: ReturnType<typeof vi.fn> = makeElicit(true),
): ToolContext {
  return {
    wp,
    registry,
    surface: {} as ToolContext['surface'],
    capabilities: {} as ToolContext['capabilities'],
    elicit: elicit as unknown as ToolContext['elicit'],
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

/** A minimal atomic container node carrying a child div (used to exercise fresh-id minting). */
function atomicContainer(id: string, childId: string): ElementNode {
  return {
    id,
    elType: 'e-div-block',
    settings: {},
    elements: [
      {
        id: childId,
        elType: 'e-div-block',
        settings: {},
        elements: [],
      },
    ],
  } as unknown as ElementNode;
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachTemplatesHandlers', () => {
  it('attaches a handler for every §1.7 templates/kits tool', () => {
    const registry = createToolRegistry();
    attachTemplatesHandlers(registry);
    for (const name of TEMPLATES_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      expect(registry.has(name)).toBe(true); // exists in the frozen catalog (exact-name match).
    }
  });

  it('owns exactly the eight §1.7 names', () => {
    expect([...TEMPLATES_TOOL_NAMES].sort()).toEqual(
      [
        TEMPLATES_LIST,
        TEMPLATES_GET,
        TEMPLATES_SAVE,
        TEMPLATES_IMPORT,
        TEMPLATES_INSERT_INTO_PAGE,
        KIT_EXPORT,
        KIT_IMPORT,
        KIT_REVERT,
      ].sort(),
    );
  });

  it('none of the §1.7 tools are ★ (Contract 13 §5.2)', () => {
    const registry = createToolRegistry();
    for (const name of TEMPLATES_TOOL_NAMES) {
      expect(registry.getDescriptor(name).star).toBe(false);
    }
  });

  it('kit.import / kit.revert are destructive; kit.export is read-only', () => {
    const registry = createToolRegistry();
    const ann = (name: string): Record<string, boolean> =>
      registry.getDescriptor(name).annotations as Record<string, boolean>;
    expect(ann(KIT_IMPORT)['destructiveHint']).toBe(true);
    expect(ann(KIT_REVERT)['destructiveHint']).toBe(true);
    expect(ann(KIT_EXPORT)['readOnlyHint']).toBe(true);
  });
});

/* ───────────────────────────── elementor.templates.list (§7 / §0.6) ─────────────────────────── */

describe('templatesListHandler', () => {
  it('forwards type/pagination, projects source, maps the collection', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: ListTemplatesResponse = {
      items: [{ template_id: 900, title: 'Hero', type: 'section' }],
      next_cursor: 'cur-2',
      total: 7,
    };
    wp.listTemplates.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await templatesListHandler({ type: 'section', limit: 25, cursor: 'cur-1' }, ctx);
    const out = structured(result);
    outputValidator(registry, TEMPLATES_LIST).parse(out);

    expect(wp.listTemplates).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'section', limit: 25, cursor: 'cur-1' }),
    );
    expect(out['next_cursor']).toBe('cur-2');
    expect(out['total']).toBe(7);
    const item = (out['items'] as Array<Record<string, unknown>>)[0];
    expect(Object.keys(item ?? {}).sort()).toEqual(['source', 'template_id', 'title', 'type']);
    expect(item?.['source']).toBe('local');
  });

  it('omits optional params + never goes unbounded (limit always sent)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listTemplates.mockResolvedValue({ items: [], next_cursor: null, total: 0 });
    const ctx = makeCtx(wp, registry);

    await templatesListHandler({ limit: 50 }, ctx);

    const arg = wp.listTemplates.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('type' in arg).toBe(false);
    expect('cursor' in arg).toBe(false);
    expect(arg['limit']).toBe(50);
  });
});

/* ───────────────────────────── elementor.templates.get (§7) ─────────────────────────────────── */

describe('templatesGetHandler', () => {
  it('returns content/page_settings/type', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const resp: GetTemplateResponse = {
      template_id: 900,
      title: 'Hero',
      type: 'section',
      content: [],
      page_settings: { background_background: 'classic' },
    };
    wp.getTemplate.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await templatesGetHandler({ template_id: 900 }, ctx);
    const out = structured(result);
    outputValidator(registry, TEMPLATES_GET).parse(out);

    expect(wp.getTemplate).toHaveBeenCalledWith(900);
    expect(Object.keys(out).sort()).toEqual(['content', 'page_settings', 'type']);
    expect(out['type']).toBe('section');
  });
});

/* ───────────────────────────── elementor.templates.save (§7 / §0.9) ─────────────────────────── */

describe('templatesSaveHandler', () => {
  it('pre-filters then persists, threads op_id, maps edit_url from PHP', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // The live controller emits edit_url even though the frozen type omits it.
    const saveResp: SaveTemplateResponse & { edit_url: string } = {
      template_id: 901,
      type: 'section',
      edit_url: 'http://x/wp-admin/post.php?post=901&action=elementor',
    };
    wp.saveTemplate.mockResolvedValue(saveResp);
    const ctx = makeCtx(wp, registry);

    const content = [atomicContainer('aaa1111', 'bbb2222')];
    const result = await templatesSaveHandler({ title: 'Hero', type: 'section', content }, ctx);
    const out = structured(result);
    outputValidator(registry, TEMPLATES_SAVE).parse(out);

    expect(wp.saveTemplate).toHaveBeenCalledTimes(1);
    const body = wp.saveTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['title']).toBe('Hero');
    expect(body['type']).toBe('section');
    expect(typeof body['op_id']).toBe('string');
    expect(out['template_id']).toBe(901);
    expect(out['edit_url']).toBe('http://x/wp-admin/post.php?post=901&action=elementor');
  });

  it('falls back edit_url to "" when PHP omits it (frozen type shape)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.saveTemplate.mockResolvedValue({
      template_id: 902,
      type: 'page',
    } satisfies SaveTemplateResponse);
    const ctx = makeCtx(wp, registry);

    const result = await templatesSaveHandler(
      { title: 'P', type: 'page', content: [atomicContainer('c1c1c1c', 'd2d2d2d')] },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, TEMPLATES_SAVE).parse(out);
    expect(out['edit_url']).toBe('');
  });

  it('hard pre-filter reject short-circuits WITHOUT a REST call', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    // A node missing its id is an R1 structural reject for the pre-filter (no REST round-trip).
    const bad = [{ elType: 'widget', settings: {} } as unknown as ElementNode];
    const result = await templatesSaveHandler({ title: 'X', type: 'section', content: bad }, ctx);

    expect(result.isError).toBe(true);
    expect(wp.saveTemplate).not.toHaveBeenCalled();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc['code']).toBe(ErrorCodes.VALIDATION_FAILED);
  });
});

/* ───────────────────────────── elementor.templates.import (§7 / §3.5) ───────────────────────── */

describe('templatesImportHandler', () => {
  it('maps imported_ids[0]⇒template_id + surfaces remapped_ids', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const importResp: ImportTemplateResponse & { remapped_ids: Record<string, string> } = {
      imported_ids: [902],
      warnings: [],
      remapped_ids: { abc1234: 'f0e1d2c' },
    };
    wp.importTemplate.mockResolvedValue(importResp);
    const ctx = makeCtx(wp, registry);

    const result = await templatesImportHandler(
      { file_path: '/tmp/hero.json', import_mode: 'match_site' },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, TEMPLATES_IMPORT).parse(out);

    const body = wp.importTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['file_path']).toBe('/tmp/hero.json');
    expect(body['import_mode']).toBe('match_site');
    expect('content' in body).toBe(false);
    expect(out['template_id']).toBe(902);
    expect(out['remapped_ids']).toEqual({ abc1234: 'f0e1d2c' });
  });

  it('defaults remapped_ids to {} when PHP omits it', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.importTemplate.mockResolvedValue({
      imported_ids: [903],
      warnings: ['note'],
    } satisfies ImportTemplateResponse);
    const ctx = makeCtx(wp, registry);

    const result = await templatesImportHandler(
      { content: { type: 'section', content: [] }, import_mode: 'keep_existing' },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, TEMPLATES_IMPORT).parse(out);
    expect(out['remapped_ids']).toEqual({});
    expect(out['template_id']).toBe(903);
  });

  it('renders an isError result on IMPORT_REMAP_FAILED (12-error §3.5)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(
      ErrorCodes.IMPORT_REMAP_FAILED,
      'Could not remap class relations on import',
      { meta: { template_id: 904 } },
    );
    wp.importTemplate.mockRejectedValue(new WpClientError(payload, { httpStatus: 422 }));
    const ctx = makeCtx(wp, registry);

    const result = await templatesImportHandler(
      { file_path: '/tmp/x.zip', import_mode: 'match_site' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc['code']).toBe(ErrorCodes.IMPORT_REMAP_FAILED);
    expect(sc['surface']).toBe('isError');
  });
});

/* ───────────────────────────── elementor.templates.insert_into_page (§7 / §4.6) ─────────────── */

describe('templatesInsertIntoPageHandler', () => {
  const okInsert: InsertTemplateResponse = {
    success: true,
    inserted_ids: ['xy12345'],
    base_hash: 'a'.repeat(32),
    css_primed: true,
  };

  it('requires exactly ONE of template_id / content (both ⇒ isError, no REST call)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await templatesInsertIntoPageHandler(
      {
        post_id: 42,
        template_id: 900,
        content: [atomicContainer('aaa1111', 'bbb2222')],
        base_hash: 'b'.repeat(32),
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(wp.insertTemplate).not.toHaveBeenCalled();
    expect(wp.documentIds).not.toHaveBeenCalled();
  });

  it('requires at least one of template_id / content (neither ⇒ isError)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);
    const result = await templatesInsertIntoPageHandler(
      { post_id: 42, base_hash: 'b'.repeat(32) },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(wp.insertTemplate).not.toHaveBeenCalled();
  });

  it('template_id paste: no TS id pass; proxies the insert + synthesizes a Diff', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.insertTemplate.mockResolvedValue(okInsert);
    const ctx = makeCtx(wp, registry);

    const result = await templatesInsertIntoPageHandler(
      { post_id: 42, template_id: 900, parent_id: 'p0p0p0p', index: 0, base_hash: 'b'.repeat(32) },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, TEMPLATES_INSERT_INTO_PAGE).parse(out);

    expect(wp.documentIds).not.toHaveBeenCalled();
    expect(wp.insertTemplate).toHaveBeenCalledTimes(1);
    const [routeId, body] = wp.insertTemplate.mock.calls[0] as [number, Record<string, unknown>];
    expect(routeId).toBe(900);
    expect(body['base_hash']).toBe('b'.repeat(32));
    expect('content' in body).toBe(false);
    expect(out['base_hash']).toBe('a'.repeat(32));
    const diff = out['diff'] as { changes: Array<{ id: string; op: string }>; new_ids: string[] };
    expect(diff.new_ids).toEqual(['xy12345']);
    expect(diff.changes[0]).toEqual({ id: 'xy12345', op: 'added' });
  });

  it('inline content: mints FRESH ids over the WHOLE subtree against the used-id set', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const live: DocumentIdsResponse = { ids: ['abc1234'], local_style_ids: [] };
    wp.documentIds.mockResolvedValue(live);
    wp.insertTemplate.mockResolvedValue(okInsert);
    const ctx = makeCtx(wp, registry);

    // The subtree's own ids ('aaa1111','bbb2222') collide with NOTHING live, yet ALL must be re-minted
    // (replace ALL ids on insert, Contract 11 §4.6) so a second paste of the same template cannot clash.
    const content = [atomicContainer('aaa1111', 'bbb2222')];
    const result = await templatesInsertIntoPageHandler(
      { post_id: 42, content, base_hash: 'b'.repeat(32) },
      ctx,
    );
    outputValidator(registry, TEMPLATES_INSERT_INTO_PAGE).parse(structured(result));

    expect(wp.documentIds).toHaveBeenCalledWith(42);
    const body = wp.insertTemplate.mock.calls[0]?.[1] as { content: ElementNode[] };
    const sentIds = collectIds(body.content);
    // EVERY original id must be gone (all re-minted), and none may collide with the live id.
    expect(sentIds.has('aaa1111')).toBe(false);
    expect(sentIds.has('bbb2222')).toBe(false);
    expect(sentIds.has('abc1234')).toBe(false);
    expect(sentIds.size).toBe(2);
  });

  it('two pastes of the SAME template into one page never collide', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.insertTemplate.mockResolvedValue(okInsert);
    const ctx = makeCtx(wp, registry);

    // First paste: empty page.
    wp.documentIds.mockResolvedValueOnce({
      ids: [],
      local_style_ids: [],
    } satisfies DocumentIdsResponse);
    const r1 = await templatesInsertIntoPageHandler(
      { post_id: 42, content: [atomicContainer('aaa1111', 'bbb2222')], base_hash: 'b'.repeat(32) },
      ctx,
    );
    const firstSent = collectIds(
      (wp.insertTemplate.mock.calls[0]?.[1] as { content: ElementNode[] }).content,
    );
    expect(r1.isError).not.toBe(true);

    // Second paste: page now contains the first paste's ids.
    wp.documentIds.mockResolvedValueOnce({
      ids: [...firstSent],
      local_style_ids: [],
    } satisfies DocumentIdsResponse);
    await templatesInsertIntoPageHandler(
      { post_id: 42, content: [atomicContainer('aaa1111', 'bbb2222')], base_hash: 'c'.repeat(32) },
      ctx,
    );
    const secondSent = collectIds(
      (wp.insertTemplate.mock.calls[1]?.[1] as { content: ElementNode[] }).content,
    );
    // No overlap between the two pastes' minted ids.
    for (const id of secondSent) {
      expect(firstSent.has(id)).toBe(false);
    }
  });
});

/* ───────────────────────────── elementor.kit.export (§7) ────────────────────────────────────── */

describe('kitExportHandler', () => {
  it('maps download_url⇒file_path, forwards include', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.kitExport.mockResolvedValue({
      download_url: '/tmp/kit.zip',
      session: 'sess-1',
    } satisfies KitExportResponse);
    const ctx = makeCtx(wp, registry);

    const result = await kitExportHandler(
      { include: ['content', 'settings'], kitInfo: { title: 'K' } },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, KIT_EXPORT).parse(out);

    const body = wp.kitExport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['include']).toEqual(['content', 'settings']);
    expect(body['kitInfo']).toEqual({ title: 'K' });
    expect('customization' in body).toBe(false);
    expect(out['file_path']).toBe('/tmp/kit.zip');
    expect(out['session']).toBe('sess-1');
  });
});

/* ───────────────────────────── elementor.kit.import (D, §7 / §5.5) ──────────────────────────── */

describe('kitImportHandler', () => {
  it('elicits when confirm!=true and DECLINE returns a clean non-error (no REST call)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const elicit = makeElicit(false);
    const ctx = makeCtx(wp, registry, elicit);

    const result = await kitImportHandler({ include: ['content'], confirm: false }, ctx);
    expect(elicit).toHaveBeenCalledTimes(1);
    expect(wp.kitImport).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    // M-b (contract 18 §7): the decline carries a schema-valid structured payload — SDK 1.29
    // rejects a structured-content-less result on a tool with an outputSchema (-32602).
    expect(result.structuredContent).toEqual({ session: '', imported: {} });
  });

  it('on confirm proxies POST /kit/import, maps file⇒file_path, returns {session,imported}', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.kitImport.mockResolvedValue({
      session: 'sess-2',
      imported: { templates: 3 },
      warnings: ['w'],
    } satisfies KitImportResponse);
    const ctx = makeCtx(wp, registry);

    const result = await kitImportHandler(
      { file: '/tmp/kit.zip', include: ['content', 'templates'], confirm: true },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, KIT_IMPORT).parse(out);

    const body = wp.kitImport.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['file_path']).toBe('/tmp/kit.zip');
    expect(body['include']).toEqual(['content', 'templates']);
    expect('session' in body).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['imported', 'session']);
    expect(out['session']).toBe('sess-2');
  });

  it('confirm:true skips elicitation', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const elicit = makeElicit(true);
    wp.kitImport.mockResolvedValue({
      session: 's',
      imported: {},
      warnings: [],
    } satisfies KitImportResponse);
    const ctx = makeCtx(wp, registry, elicit);

    await kitImportHandler({ include: ['settings'], confirm: true }, ctx);
    expect(elicit).not.toHaveBeenCalled();
    expect(wp.kitImport).toHaveBeenCalledTimes(1);
  });
});

/* ───────────────────────────── elementor.kit.revert (D, §7 / §5.5) ──────────────────────────── */

describe('kitRevertHandler', () => {
  it('elicits + DECLINE returns clean non-error (no REST call)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const elicit = makeElicit(false);
    const ctx = makeCtx(wp, registry, elicit);

    const result = await kitRevertHandler({ session: 'sess-9', confirm: false }, ctx);
    expect(wp.kitRevert).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
  });

  it('on confirm proxies POST /kit/revert, maps reverted⇒success', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.kitRevert.mockResolvedValue({ reverted: true } satisfies KitRevertResponse);
    const ctx = makeCtx(wp, registry);

    const result = await kitRevertHandler({ session: 'sess-9', confirm: true }, ctx);
    const out = structured(result);
    outputValidator(registry, KIT_REVERT).parse(out);

    expect(wp.kitRevert).toHaveBeenCalledWith({ session: 'sess-9' });
    expect(out['success']).toBe(true);
  });
});

/* ───────────────────────────── error rendering (12-error-taxonomy.md §5) ────────────────────── */

describe('error rendering', () => {
  it('THROWS a ProtocolError for a surface:protocol payload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params');
    wp.listTemplates.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    await expect(templatesListHandler({ limit: 50 }, ctx)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-WpClientError unchanged', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.getTemplate.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(templatesGetHandler({ template_id: 1 }, ctx)).rejects.toThrow('boom');
  });
});
