/**
 * WP-T05 — page-CRUD handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade), `ctx.capabilities` (the
 * capability probe), and `ctx.elicit`; use a REAL WP-F04 {@link ToolRegistry} to validate each
 * handler's `structuredContent` against the frozen descriptor `outputSchema`. The tests assert
 * (ticket §Acceptance):
 *  - all eight §1.2 handlers attach by EXACT catalog name; ★ membership + names match the catalog,
 *  - `page.build` pipeline ORDERING (capabilities → dedupe → pre-filter → create → save → prime),
 *    id dedupe, v4→v3 fallback when atomic inactive, pre-filter short-circuit (no REST on reject),
 *    honest `css_primed` reporting, idempotent-replay surfacing,
 *  - `page.dry_run` returns a SUCCESS result for an INVALID tree (PHP 422 normalized → `{valid:false}`),
 *  - `replace_tree` / `delete` gate on elicitation when `confirm!=true`; a DECLINE → clean non-error,
 *  - `update_settings` sends the patch; `duplicate`/`export_template` map the REST shapes,
 *  - error mapping: a `surface:'isError'` {@link WpClientError} (e.g. `CONCURRENCY_STALE_HASH`) renders
 *    an `isError` result; a `surface:'protocol'` payload THROWS a {@link ProtocolError}.
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';

import {
  ErrorCodes,
  makeErrorPayload,
  type CreateDocumentResponse,
  type DeleteDocumentResponse,
  type DryRunResponse,
  type DuplicateDocumentResponse,
  type ExportDocumentResponse,
  type RestDiff,
  type RollbackDocumentResponse,
  type SaveDocumentResponse,
  type UpdateDocumentSettingsResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import type { ElementNode } from '../authoring/contract.js';
import { WpClientError } from '../wp/types.js';
import { ProtocolError } from '../wp/errors.js';

import {
  attachPageHandlers,
  pageCreateHandler,
  pageBuildHandler,
  pageReplaceTreeHandler,
  pageUpdateSettingsHandler,
  pageDryRunHandler,
  pageDuplicateHandler,
  pageDeleteHandler,
  pageExportTemplateHandler,
  pageListBackupsHandler,
  pageRollbackHandler,
  pageVerifyRenderHandler,
  PAGE_TOOL_NAMES,
  PAGE_CREATE,
  PAGE_BUILD,
  PAGE_REPLACE_TREE,
  PAGE_UPDATE_SETTINGS,
  PAGE_DRY_RUN,
  PAGE_DUPLICATE,
  PAGE_DELETE,
  PAGE_EXPORT_TEMPLATE,
  PAGE_LIST_BACKUPS,
  PAGE_ROLLBACK,
  PAGE_VERIFY_RENDER,
} from './page.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the document routes the handlers call. */
interface MockWp {
  createDocument: ReturnType<typeof vi.fn>;
  saveDocument: ReturnType<typeof vi.fn>;
  dryRunDocument: ReturnType<typeof vi.fn>;
  updateDocumentSettings: ReturnType<typeof vi.fn>;
  duplicateDocument: ReturnType<typeof vi.fn>;
  deleteDocument: ReturnType<typeof vi.fn>;
  exportDocument: ReturnType<typeof vi.fn>;
  primeCss: ReturnType<typeof vi.fn>;
  listBackups: ReturnType<typeof vi.fn>;
  rollbackDocument: ReturnType<typeof vi.fn>;
  verifyRenderDocument: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    createDocument: vi.fn(),
    saveDocument: vi.fn(),
    dryRunDocument: vi.fn(),
    updateDocumentSettings: vi.fn(),
    duplicateDocument: vi.fn(),
    deleteDocument: vi.fn(),
    exportDocument: vi.fn(),
    primeCss: vi.fn(),
    listBackups: vi.fn(),
    rollbackDocument: vi.fn(),
    verifyRenderDocument: vi.fn(),
  };
}

/** A capabilities cache stub returning a fixed `atomic` flag. */
function makeCaps(atomic: boolean): ToolContext['capabilities'] {
  return {
    get: vi.fn().mockResolvedValue({ atomic }),
  } as unknown as ToolContext['capabilities'];
}

/** Options for building a test context. */
interface CtxOptions {
  atomic?: boolean;
  /** Elicitation outcome (default: declines — `{confirmed:false}`). */
  elicit?: (prompt: string) => Promise<{ confirmed: boolean }>;
}

/** Build a minimal {@link ToolContext} carrying the mock `wp`, caps, and elicit. */
function makeCtx(wp: MockWp, opts: CtxOptions = {}): ToolContext {
  const elicit = vi.fn(
    opts.elicit ?? ((): Promise<{ confirmed: boolean }> => Promise.resolve({ confirmed: false })),
  );
  return {
    wp,
    registry: createToolRegistry(),
    surface: {} as ToolContext['surface'],
    capabilities: makeCaps(opts.atomic ?? true),
    elicit: elicit as unknown as ToolContext['elicit'],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolContext;
}

/** The WP-F04 descriptor `outputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function outputValidator(name: string): z.ZodObject<ZodRawShape> {
  return z.object(createToolRegistry().getDescriptor(name).outputSchema);
}

/**
 * The ADVERTISED wire validator for a tool's `structuredContent`. The SDK 1.29 server converts the
 * catalog ZodRawShape with `toJsonSchemaCompat(z.object(shape))` for `tools/list` — which emits
 * `additionalProperties: false` — and the SDK 1.29 client compiles THAT JSON schema (Ajv, cached
 * after `listTools()`) and rejects any extra `structuredContent` key with an InvalidParams
 * `McpError`. The zod `safeParse` checks via {@link outputValidator} run in strip mode and silently
 * pass extras, so every key a SUCCESS result carries must ALSO survive this advertised-schema
 * validator or spec-conformant clients hard-fail on the wire.
 */
function advertisedWireValidator(name: string): JsonSchemaValidator<unknown> {
  const advertised = toJsonSchemaCompat(
    z.object(createToolRegistry().getDescriptor(name).outputSchema),
    { strictUnions: true, pipeStrategy: 'output' },
  ) as JsonSchemaType;
  return new AjvJsonSchemaValidator().getValidator(advertised);
}

/** Extract `structuredContent` from a tool result (assumes a success result). */
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** Extract the first text block's `text` from a tool result (the SDK content union is widened). */
function firstText(result: { content: Array<{ type: string }> }): string {
  const block = result.content[0] as { type: string; text?: string };
  return block.text ?? '';
}

/** An empty (no-change) REST diff. */
function emptyRestDiff(): RestDiff {
  return { changed_ids: [], new_ids: [], removed_ids: [], before: {}, after: {} };
}

/** A minimal valid atomic element node (passes the WP-F03 pre-filter). */
function atomicNode(id: string): ElementNode {
  return {
    id,
    elType: 'e-div-block',
    settings: {},
  } as unknown as ElementNode;
}

/** A standard save response (no replay, primed). */
function saveResponse(over: Partial<SaveDocumentResponse> = {}): SaveDocumentResponse {
  return {
    id: 42,
    diff: emptyRestDiff(),
    base_hash: 'a'.repeat(32),
    preview_url: 'http://x/?p=42&preview=true',
    backup_handle: { meta_key: 'bk', revision_id: 1 },
    css_primed: true,
    prime_required: true,
    remapped_ids: {},
    idempotent_replay: false,
    op_id: 'op-x',
    ...over,
  };
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachPageHandlers', () => {
  it('attaches a handler for every §1.2 page tool', () => {
    const registry = createToolRegistry();
    attachPageHandlers(registry);
    for (const name of PAGE_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the eleven page names (§1.2 + the §7-AI S2 verify_render probe)', () => {
    expect([...PAGE_TOOL_NAMES].sort()).toEqual(
      [
        PAGE_CREATE,
        PAGE_BUILD,
        PAGE_REPLACE_TREE,
        PAGE_UPDATE_SETTINGS,
        PAGE_DRY_RUN,
        PAGE_DUPLICATE,
        PAGE_DELETE,
        PAGE_EXPORT_TEMPLATE,
        PAGE_LIST_BACKUPS,
        PAGE_ROLLBACK,
        PAGE_VERIFY_RENDER,
      ].sort(),
    );
  });

  it('marks page.create / page.build / page.dry_run as ★ (Contract 13 §5.2)', () => {
    const registry = createToolRegistry();
    for (const name of [PAGE_CREATE, PAGE_BUILD, PAGE_DRY_RUN]) {
      expect(registry.getDescriptor(name).star).toBe(true);
    }
  });

  it('ADVERTISES `remapped_ids` on build/replace_tree output (Contract 13 §1.2) — wire-conformant', () => {
    // The advertised tools/list JSON schema carries additionalProperties:false; `remapped_ids`
    // must be DECLARED there or SDK 1.29 clients reject every remapping success on the wire.
    for (const name of [PAGE_BUILD, PAGE_REPLACE_TREE]) {
      const advertised = toJsonSchemaCompat(
        z.object(createToolRegistry().getDescriptor(name).outputSchema),
        { strictUnions: true, pipeStrategy: 'output' },
      ) as { properties?: Record<string, unknown>; additionalProperties?: unknown };
      expect(advertised.additionalProperties).toBe(false);
      expect(advertised.properties).toHaveProperty('remapped_ids');
    }
  });
});

/* ───────────────────────────── elementor.page.create (§2.2) ─────────────────────────────────── */

describe('pageCreateHandler', () => {
  it('proxies POST /documents and maps the catalog `template` → REST `template_type`', async () => {
    const wp = makeWp();
    const resp: CreateDocumentResponse = {
      id: 7,
      edit_url: 'http://x/edit/7',
      status: 'draft',
      type: 'page',
    };
    wp.createDocument.mockResolvedValue(resp);

    const result = await pageCreateHandler(
      { title: 'Home', post_type: 'page', template: 'landing', status: 'draft' },
      makeCtx(wp),
    );

    expect(wp.createDocument).toHaveBeenCalledWith({
      title: 'Home',
      post_type: 'page',
      template_type: 'landing',
      status: 'draft',
    });
    const out = structured(result);
    expect(out).toEqual({ id: 7, edit_url: 'http://x/edit/7', status: 'draft', type: 'page' });
    expect(outputValidator(PAGE_CREATE).safeParse(out).success).toBe(true);
  });

  it('omits title/template_type when not provided', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 8,
      edit_url: 'u',
      status: 'publish',
      type: 'page',
    } satisfies CreateDocumentResponse);
    await pageCreateHandler({ post_type: 'page', status: 'publish' }, makeCtx(wp));
    expect(wp.createDocument).toHaveBeenCalledWith({ post_type: 'page', status: 'publish' });
  });
});

/* ───────────────────────────── elementor.page.build (§0.9 / §0.10) ──────────────────────────── */

describe('pageBuildHandler', () => {
  it('runs the pipeline in order: capabilities → create → save (with the deduped tree + op_id)', async () => {
    const wp = makeWp();
    const order: string[] = [];
    const caps = makeCaps(true);
    (caps.get as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('caps');
      return Promise.resolve({ atomic: true });
    });
    wp.createDocument.mockImplementation(() => {
      order.push('create');
      return Promise.resolve({
        id: 42,
        edit_url: 'http://x/edit/42',
        status: 'draft',
        type: 'page',
      } satisfies CreateDocumentResponse);
    });
    wp.saveDocument.mockImplementation(() => {
      order.push('save');
      return Promise.resolve(saveResponse());
    });

    const ctx = { ...makeCtx(wp), capabilities: caps } as ToolContext;
    const result = await pageBuildHandler(
      {
        title: 'Hero',
        post_type: 'page',
        elements: [atomicNode('aaaaaaa')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      ctx,
    );

    expect(order).toEqual(['caps', 'create', 'save']);
    // save targets the created document with prime_css + an op_id.
    const [savedId, savedBody] = wp.saveDocument.mock.calls[0] as [number, Record<string, unknown>];
    expect(savedId).toBe(42);
    expect(savedBody['prime_css']).toBe(true);
    expect(typeof savedBody['op_id']).toBe('string');

    const out = structured(result);
    expect(out['id']).toBe(42);
    expect(out['css_primed']).toBe(true);
    expect(out['base_hash']).toBe('a'.repeat(32));
    expect(outputValidator(PAGE_BUILD).safeParse(out).success).toBe(true);
    // SUCCESS results must also pass the ADVERTISED JSON schema (additionalProperties:false on
    // the wire) — the zod safeParse above strips extras and misses undeclared-key drift.
    expect(advertisedWireValidator(PAGE_BUILD)(out).valid).toBe(true);
  });

  it('dedupes colliding element ids before building (and reports it in warnings)', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(saveResponse());

    // Two top-level nodes share an id → the second must be re-minted.
    const result = await pageBuildHandler(
      {
        title: 'Dup',
        post_type: 'page',
        elements: [atomicNode('dupdupd'), atomicNode('dupdupd')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );

    const [, savedBody] = wp.saveDocument.mock.calls[0] as [number, { elements: ElementNode[] }];
    const ids = savedBody.elements.map((n) => n.id);
    expect(new Set(ids).size).toBe(2); // no duplicate id reached the save
    const report = structured(result)['report'] as { warnings: string[] };
    expect(report.warnings.some((w) => /[Dd]e-duplicated/.test(w))).toBe(true);
  });

  it('falls back v4 → v3 when atomic is INACTIVE and records a warning', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(saveResponse());

    const result = await pageBuildHandler(
      {
        title: 'NoAtomic',
        post_type: 'page',
        elements: [atomicNode('bbbbbbb')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: false }),
    );

    const report = structured(result)['report'] as { warnings: string[] };
    expect(report.warnings.some((w) => /fell back to "v3"/.test(w))).toBe(true);
  });

  it('does NOT fall back when generation is v4 and atomic is active', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(saveResponse());

    const result = await pageBuildHandler(
      {
        title: 'Atomic',
        post_type: 'page',
        elements: [atomicNode('ccccccc')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    const out = structured(result);
    // No fallback warning ⇒ either no report at all, or a report without the fallback line.
    const report = out['report'] as { warnings: string[] } | undefined;
    expect(report?.warnings.some((w) => /fell back/.test(w)) ?? false).toBe(false);
  });

  it('short-circuits on a pre-filter REJECT WITHOUT calling create/save', async () => {
    const wp = makeWp();
    // A node missing `elType` / id is a hard structural reject.
    const broken = { id: '', elType: '' } as unknown as ElementNode;

    const result = await pageBuildHandler(
      {
        title: 'Broken',
        post_type: 'page',
        elements: [broken],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );

    expect(wp.createDocument).not.toHaveBeenCalled();
    expect(wp.saveDocument).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(structured(result)['code']).toBe(ErrorCodes.VALIDATION_FAILED);
  });

  it('reports css_primed=false honestly and warns (prime failed but save landed)', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(saveResponse({ css_primed: false }));

    const result = await pageBuildHandler(
      {
        title: 'NoPrime',
        post_type: 'page',
        elements: [atomicNode('ddddddd')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    expect(structured(result)['css_primed']).toBe(false);
    const report = structured(result)['report'] as { warnings: string[] };
    expect(report.warnings.some((w) => /not primed/i.test(w))).toBe(true);
  });

  it('surfaces an idempotent replay informationally (write already landed)', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(saveResponse({ idempotent_replay: true }));

    const result = await pageBuildHandler(
      {
        title: 'Replay',
        post_type: 'page',
        elements: [atomicNode('eeeeeee')],
        generation: 'v4',
        status: 'draft',
        op_id: 'op-fixed',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    // The caller-supplied op_id is threaded to BOTH create and save.
    expect((wp.createDocument.mock.calls[0]?.[0] as { op_id?: string }).op_id).toBe('op-fixed');
    expect((wp.saveDocument.mock.calls[0]?.[1] as { op_id?: string }).op_id).toBe('op-fixed');
    const report = structured(result)['report'] as { warnings: string[] };
    expect(report.warnings.some((w) => /replay/i.test(w))).toBe(true);
  });

  it('renders an isError for an ATOMIC_SETTINGS_INVALID save (PHP authoritative 422)', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockRejectedValue(
      new WpClientError(makeErrorPayload(ErrorCodes.ATOMIC_SETTINGS_INVALID, 'bad prop'), {
        httpStatus: 422,
      }),
    );

    const result = await pageBuildHandler(
      {
        title: 'BadSave',
        post_type: 'page',
        elements: [atomicNode('fffffff')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(structured(result)['code']).toBe(ErrorCodes.ATOMIC_SETTINGS_INVALID);
  });

  it('compensates a failed save: a definite validation 422 deletes the just-created orphan and surfaces its id', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockRejectedValue(
      new WpClientError(
        makeErrorPayload(
          ErrorCodes.VALIDATION_FAILED,
          'Element-tree validation failed (2 errors); nothing was written.',
        ),
        { httpStatus: 422 },
      ),
    );
    wp.deleteDocument.mockResolvedValue({ id: 42, deleted: true, trashed: false });

    const result = await pageBuildHandler(
      {
        title: 'Orphan',
        post_type: 'page',
        elements: [atomicNode('aaaaaa1')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    // The blank orphan is cleaned up (permanent — a blank create has nothing to recover).
    expect(wp.deleteDocument).toHaveBeenCalledWith(42, { force: true });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const out = structured(result);
    expect(out['code']).toBe(ErrorCodes.VALIDATION_FAILED);
    const meta = out['meta'] as Record<string, unknown>;
    expect(meta['created_post_id']).toBe(42);
    expect(meta['orphan_cleanup']).toBe('deleted');
    expect(out['message']).toMatch(/document 42 .* deleted/i);
  });

  it('keeps the created document on an AMBIGUOUS save failure (may have landed) but surfaces created_post_id', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 43,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockRejectedValue(
      new WpClientError(makeErrorPayload(ErrorCodes.UPSTREAM_ERROR, 'transport blip'), {
        httpStatus: 502,
      }),
    );

    const result = await pageBuildHandler(
      {
        title: 'Ambiguous',
        post_type: 'page',
        elements: [atomicNode('aaaaaa2')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    expect(wp.deleteDocument).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
    const meta = structured(result)['meta'] as Record<string, unknown>;
    expect(meta['created_post_id']).toBe(43);
    expect(meta['orphan_cleanup']).toBe('kept');
  });

  it('reports orphan_cleanup:"delete_failed" when the compensating delete itself fails', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 44,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockRejectedValue(
      new WpClientError(makeErrorPayload(ErrorCodes.ATOMIC_STYLES_INVALID, 'bad style'), {
        httpStatus: 422,
      }),
    );
    wp.deleteDocument.mockRejectedValue(new Error('delete boom'));

    const result = await pageBuildHandler(
      {
        title: 'NoCleanup',
        post_type: 'page',
        elements: [atomicNode('aaaaaa3')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    const meta = structured(result)['meta'] as Record<string, unknown>;
    expect(meta['created_post_id']).toBe(44);
    expect(meta['orphan_cleanup']).toBe('delete_failed');
  });

  it('surfaces an idempotent CREATE replay (PHP reused an existing post for this op_id) as a warning', async () => {
    const wp = makeWp();
    // The frozen CreateDocumentResponse predates the create replay guard; the flag is read defensively.
    wp.createDocument.mockResolvedValue({
      id: 45,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
      idempotent_replay: true,
    });
    wp.saveDocument.mockResolvedValue(saveResponse({ id: 45 }));

    const result = await pageBuildHandler(
      {
        title: 'CreateReplay',
        post_type: 'page',
        elements: [atomicNode('aaaaaa4')],
        generation: 'v4',
        status: 'draft',
        op_id: 'op-fixed',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    const report = structured(result)['report'] as { warnings: string[] };
    expect(report.warnings.some((w) => /create replay/i.test(w))).toBe(true);
  });

  it('never deletes a replay-REUSED post when the save then fails (this call did not mint it)', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 46,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
      idempotent_replay: true,
    });
    wp.saveDocument.mockRejectedValue(
      new WpClientError(makeErrorPayload(ErrorCodes.VALIDATION_FAILED, 'invalid tree'), {
        httpStatus: 422,
      }),
    );

    const result = await pageBuildHandler(
      {
        title: 'ReplayKept',
        post_type: 'page',
        elements: [atomicNode('aaaaaa5')],
        generation: 'v4',
        status: 'draft',
        op_id: 'op-fixed',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    expect(wp.deleteDocument).not.toHaveBeenCalled();
    const meta = structured(result)['meta'] as Record<string, unknown>;
    expect(meta['orphan_cleanup']).toBe('kept');
    expect(meta['created_post_id']).toBe(46);
  });

  it('surfaces PHP-side remapped_ids from the save response (warning + structured map)', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(saveResponse({ remapped_ids: { abc1234: 'def5678' } }));

    const result = await pageBuildHandler(
      {
        title: 'Remap',
        post_type: 'page',
        elements: [atomicNode('abc1234')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    const out = structured(result);
    expect(out['remapped_ids']).toEqual({ abc1234: 'def5678' });
    const report = out['report'] as { warnings: string[] };
    expect(report.warnings.some((w) => /remapped/.test(w) && /abc1234→def5678/.test(w))).toBe(true);
    // `remapped_ids` is a DECLARED catalog key: it must pass the zod shape AND the advertised
    // JSON schema (`additionalProperties:false` on the wire — see advertisedWireValidator).
    expect(outputValidator(PAGE_BUILD).safeParse(out).success).toBe(true);
    expect(advertisedWireValidator(PAGE_BUILD)(out).valid).toBe(true);
  });

  it('passes through an authoring-shaped diff (the LIVE P06 controller emits {changes[]})', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    // The live controller returns the authoring Diff shape (changes[]) rather than before/after maps.
    const liveDiff = {
      changes: [{ id: 'aaaaaaa', op: 'added', elType: 'e-div-block', to_index: 0 }],
      new_ids: ['aaaaaaa'],
      changed_ids: [],
      removed_ids: [],
    } as unknown as RestDiff;
    wp.saveDocument.mockResolvedValue(saveResponse({ diff: liveDiff }));

    const result = await pageBuildHandler(
      {
        title: 'LiveDiff',
        post_type: 'page',
        elements: [atomicNode('aaaaaaa')],
        generation: 'v4',
        status: 'draft',
        prime_css: true,
      },
      makeCtx(wp, { atomic: true }),
    );
    const out = structured(result);
    const diff = out['diff'] as { changes: Array<{ id: string; op: string }> };
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ id: 'aaaaaaa', op: 'added' });
    expect(outputValidator(PAGE_BUILD).safeParse(out).success).toBe(true);
  });
});

/* ───────────────────────────── elementor.page.dry_run (§0.9 / §2.3) ─────────────────────────── */

describe('pageDryRunHandler', () => {
  it('returns a SUCCESS result with the PHP verdict for a VALID tree', async () => {
    const wp = makeWp();
    const resp: DryRunResponse = {
      valid: true,
      errors: [],
      diff: emptyRestDiff(),
      preview_url: null,
      id_collisions: [],
      generation_detected: 'v4',
    };
    wp.dryRunDocument.mockResolvedValue(resp);

    const result = await pageDryRunHandler(
      { post_id: 5, elements: [atomicNode('ggggggg')], generation: 'v4' },
      makeCtx(wp, { atomic: true }),
    );
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    const out = structured(result);
    expect(out['valid']).toBe(true);
    expect(out['errors']).toEqual([]);
    expect(outputValidator(PAGE_DRY_RUN).safeParse(out).success).toBe(true);
    // No post_id passed defaults to a NEW-tree dry-run (id 0).
    expect(wp.dryRunDocument.mock.calls[0]?.[0]).toBe(5);
  });

  it('normalizes a PHP 422 INVALID tree into a SUCCESS result {valid:false,errors}', async () => {
    const wp = makeWp();
    wp.dryRunDocument.mockRejectedValue(
      new WpClientError(
        makeErrorPayload(ErrorCodes.VALIDATION_FAILED, 'Element-tree validation failed (1 error).'),
        {
          httpStatus: 422,
          fieldErrors: [
            { path: 'elements[0].settings.tag', code: 'E_PROP_INVALID', message: 'bad tag' },
          ],
        },
      ),
    );

    const result = await pageDryRunHandler(
      { elements: [atomicNode('hhhhhhh')], generation: 'v4' },
      makeCtx(wp, { atomic: true }),
    );
    // INVALID tree is a SUCCESS result — NOT an isError (Contract 13 §1.2).
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    const out = structured(result);
    expect(out['valid']).toBe(false);
    const errors = out['errors'] as Array<{ code: string; message: string; element_id: null }>;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('E_PROP_INVALID');
    expect(errors[0]?.element_id).toBeNull();
    expect(errors[0]?.message).toMatch(/at elements\[0\]\.settings\.tag/);
    expect(outputValidator(PAGE_DRY_RUN).safeParse(out).success).toBe(true);
    // No post_id ⇒ validates a NEW tree at id 0.
    expect(wp.dryRunDocument.mock.calls[0]?.[0]).toBe(0);
  });

  it('routes a NON-validation client error (e.g. AUTH_FAILED) through the standard isError path', async () => {
    const wp = makeWp();
    wp.dryRunDocument.mockRejectedValue(
      new WpClientError(makeErrorPayload(ErrorCodes.AUTH_FAILED, 'no auth'), { httpStatus: 401 }),
    );
    const result = await pageDryRunHandler(
      { post_id: 1, elements: [atomicNode('iiiiiii')], generation: 'v4' },
      makeCtx(wp, { atomic: true }),
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(structured(result)['code']).toBe(ErrorCodes.AUTH_FAILED);
  });
});

/* ───────────────────────────── elementor.page.replace_tree (§2.6) ───────────────────────────── */

describe('pageReplaceTreeHandler', () => {
  it('gates on elicitation when confirm!=true and proceeds on accept', async () => {
    const wp = makeWp();
    wp.saveDocument.mockResolvedValue(saveResponse());
    const ctx = makeCtx(wp, { elicit: () => Promise.resolve({ confirmed: true }) });

    const result = await pageReplaceTreeHandler(
      {
        post_id: 42,
        elements: [atomicNode('jjjjjjj')],
        base_hash: 'b'.repeat(32),
        confirm: false,
        force: false,
        prime_css: true,
      },
      ctx,
    );
    expect(ctx.elicit).toHaveBeenCalledTimes(1);
    expect(wp.saveDocument).toHaveBeenCalledTimes(1);
    const [, body] = wp.saveDocument.mock.calls[0] as [number, Record<string, unknown>];
    expect(body['base_hash']).toBe('b'.repeat(32));
    const out = structured(result);
    expect(outputValidator(PAGE_REPLACE_TREE).safeParse(out).success).toBe(true);
    // SUCCESS results must also pass the ADVERTISED JSON schema (additionalProperties:false on
    // the wire) — the zod safeParse above strips extras and misses undeclared-key drift.
    expect(advertisedWireValidator(PAGE_REPLACE_TREE)(out).valid).toBe(true);
  });

  it('returns a CLEAN non-error result on DECLINE without calling save', async () => {
    const wp = makeWp();
    const ctx = makeCtx(wp, { elicit: () => Promise.resolve({ confirmed: false }) });
    const result = await pageReplaceTreeHandler(
      {
        post_id: 42,
        elements: [atomicNode('kkkkkkk')],
        base_hash: 'c'.repeat(32),
        confirm: false,
        force: false,
        prime_css: true,
      },
      ctx,
    );
    expect(wp.saveDocument).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(firstText(result)).toMatch(/cancelled/i);
    // M-a/M-b (contract 18 §7): the decline carries a SCHEMA-VALID structuredContent — SDK 1.29
    // -32602s a structured-content-less result on a tool with an outputSchema.
    const out = structured(result);
    expect(outputValidator(PAGE_REPLACE_TREE).safeParse(out).success).toBe(true);
    expect(out['css_primed']).toBe(false);
    expect(out['base_hash']).toBe('c'.repeat(32));
  });

  it('skips elicitation when confirm:true and forwards force', async () => {
    const wp = makeWp();
    wp.saveDocument.mockResolvedValue(saveResponse());
    const ctx = makeCtx(wp);
    await pageReplaceTreeHandler(
      {
        post_id: 42,
        elements: [atomicNode('lllllll')],
        base_hash: 'd'.repeat(32),
        confirm: true,
        force: true,
        prime_css: false,
      },
      ctx,
    );
    expect(ctx.elicit).not.toHaveBeenCalled();
    const [, body] = wp.saveDocument.mock.calls[0] as [number, Record<string, unknown>];
    expect(body['force']).toBe(true);
    expect(body['prime_css']).toBe(false);
  });

  it('surfaces remapped_ids (local dedupe + PHP save-response remaps) instead of dropping them', async () => {
    const wp = makeWp();
    wp.saveDocument.mockResolvedValue(saveResponse({ remapped_ids: { aaa1111: 'bbb2222' } }));

    // Two top-level nodes share an id → the local dedupe remaps the second occurrence.
    const result = await pageReplaceTreeHandler(
      {
        post_id: 42,
        elements: [atomicNode('rrrrrr1'), atomicNode('rrrrrr1')],
        base_hash: 'a'.repeat(32),
        confirm: true,
        force: false,
        prime_css: true,
      },
      makeCtx(wp),
    );
    const out = structured(result);
    const remappedIds = out['remapped_ids'] as Record<string, string>;
    // The PHP-side remap is carried through verbatim…
    expect(remappedIds['aaa1111']).toBe('bbb2222');
    // …and the local dedupe remap (authored id → fresh id) is merged in.
    expect(remappedIds['rrrrrr1']).toBeDefined();
    expect(Object.keys(remappedIds)).toHaveLength(2);
    expect(firstText(result)).toMatch(/remapped/);
    // `remapped_ids` is a DECLARED catalog key: it must pass the zod shape AND the advertised
    // JSON schema (`additionalProperties:false` on the wire — see advertisedWireValidator).
    expect(outputValidator(PAGE_REPLACE_TREE).safeParse(out).success).toBe(true);
    expect(advertisedWireValidator(PAGE_REPLACE_TREE)(out).valid).toBe(true);
  });

  it('omits remapped_ids when nothing was remapped', async () => {
    const wp = makeWp();
    wp.saveDocument.mockResolvedValue(saveResponse());
    const result = await pageReplaceTreeHandler(
      {
        post_id: 42,
        elements: [atomicNode('rrrrrr2')],
        base_hash: 'a'.repeat(32),
        confirm: true,
        force: false,
        prime_css: true,
      },
      makeCtx(wp),
    );
    expect('remapped_ids' in structured(result)).toBe(false);
  });

  it('maps a stale base_hash to CONCURRENCY_STALE_HASH isError', async () => {
    const wp = makeWp();
    wp.saveDocument.mockRejectedValue(
      new WpClientError(makeErrorPayload(ErrorCodes.CONCURRENCY_STALE_HASH, 'stale'), {
        httpStatus: 409,
      }),
    );
    const result = await pageReplaceTreeHandler(
      {
        post_id: 42,
        elements: [atomicNode('mmmmmmm')],
        base_hash: 'e'.repeat(32),
        confirm: true,
        force: false,
        prime_css: true,
      },
      makeCtx(wp),
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(structured(result)['code']).toBe(ErrorCodes.CONCURRENCY_STALE_HASH);
  });
});

/* ───────────────────────────── elementor.page.update_settings (§2.5) ────────────────────────── */

describe('pageUpdateSettingsHandler', () => {
  it('sends the patch + base_hash and returns the merged settings', async () => {
    const wp = makeWp();
    const resp: UpdateDocumentSettingsResponse = {
      success: true,
      settings: { background_color: '#fff', existing: 'kept' },
    };
    wp.updateDocumentSettings.mockResolvedValue(resp);

    const result = await pageUpdateSettingsHandler(
      { post_id: 9, settings: { background_color: '#fff' }, base_hash: 'f'.repeat(32) },
      makeCtx(wp),
    );
    expect(wp.updateDocumentSettings).toHaveBeenCalledWith(9, {
      settings: { background_color: '#fff' },
      base_hash: 'f'.repeat(32),
    });
    const out = structured(result);
    expect(out['success']).toBe(true);
    expect((out['settings'] as Record<string, unknown>)['existing']).toBe('kept');
    expect(outputValidator(PAGE_UPDATE_SETTINGS).safeParse(out).success).toBe(true);
  });

  it('omits base_hash when not provided', async () => {
    const wp = makeWp();
    wp.updateDocumentSettings.mockResolvedValue({
      success: true,
      settings: {},
    } satisfies UpdateDocumentSettingsResponse);
    await pageUpdateSettingsHandler({ post_id: 9, settings: { a: 1 } }, makeCtx(wp));
    expect(wp.updateDocumentSettings).toHaveBeenCalledWith(9, { settings: { a: 1 } });
  });

  it('GATE LOCK: refuses a post_status flip to publish without touching the REST', async () => {
    const wp = makeWp();
    const result = await pageUpdateSettingsHandler(
      { post_id: 9, settings: { post_status: 'publish' } },
      makeCtx(wp),
    );
    expect(wp.updateDocumentSettings).not.toHaveBeenCalled();
    const out = structured(result);
    expect(out['refused']).toBe(true);
    expect(out['reason']).toBe('publish_bypasses_verify_gate');
    expect(out['attempted_status']).toBe('publish');
  });

  it('GATE LOCK: also refuses private/future, but lets draft + other settings through', async () => {
    const wp = makeWp();
    const denied = await pageUpdateSettingsHandler(
      { post_id: 9, settings: { post_status: 'private' } },
      makeCtx(wp),
    );
    expect(structured(denied)['refused']).toBe(true);
    expect(wp.updateDocumentSettings).not.toHaveBeenCalled();

    wp.updateDocumentSettings.mockResolvedValue({
      success: true,
      settings: {},
    } satisfies UpdateDocumentSettingsResponse);
    await pageUpdateSettingsHandler(
      { post_id: 9, settings: { post_status: 'draft', background_color: '#000' } },
      makeCtx(wp),
    );
    expect(wp.updateDocumentSettings).toHaveBeenCalledWith(9, {
      settings: { post_status: 'draft', background_color: '#000' },
    });
  });
});

/* ───────────────────────────── elementor.page.duplicate (§2.9) ──────────────────────────────── */

describe('pageDuplicateHandler', () => {
  it('proxies duplicate and maps REST id ⇒ post_id', async () => {
    const wp = makeWp();
    wp.duplicateDocument.mockResolvedValue({
      id: 99,
      edit_url: 'http://x/edit/99',
    } satisfies DuplicateDocumentResponse);
    const result = await pageDuplicateHandler({ post_id: 9, title: 'Copy' }, makeCtx(wp));
    expect(wp.duplicateDocument).toHaveBeenCalledWith(9, { title: 'Copy' });
    const out = structured(result);
    expect(out).toEqual({ post_id: 99, edit_url: 'http://x/edit/99' });
    expect(outputValidator(PAGE_DUPLICATE).safeParse(out).success).toBe(true);
  });
});

/* ───────────────────────────── elementor.page.delete (§2.9) ─────────────────────────────────── */

describe('pageDeleteHandler', () => {
  it('gates on elicitation when confirm!=true and trashes on accept', async () => {
    const wp = makeWp();
    wp.deleteDocument.mockResolvedValue({
      id: 9,
      deleted: true,
      trashed: true,
    } satisfies DeleteDocumentResponse);
    const ctx = makeCtx(wp, { elicit: () => Promise.resolve({ confirmed: true }) });

    const result = await pageDeleteHandler(
      { post_id: 9, confirm: false, force_delete: false },
      ctx,
    );
    expect(ctx.elicit).toHaveBeenCalledTimes(1);
    expect(wp.deleteDocument).toHaveBeenCalledWith(9, { force: false });
    const out = structured(result);
    expect(out).toEqual({ success: true, trashed: true });
    expect(outputValidator(PAGE_DELETE).safeParse(out).success).toBe(true);
  });

  it('returns a CLEAN non-error result on DECLINE without calling delete', async () => {
    const wp = makeWp();
    const ctx = makeCtx(wp, { elicit: () => Promise.resolve({ confirmed: false }) });
    const result = await pageDeleteHandler(
      { post_id: 9, confirm: false, force_delete: false },
      ctx,
    );
    expect(wp.deleteDocument).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(firstText(result)).toMatch(/cancelled/i);
    // M-b (contract 18 §7): schema-valid structured decline payload.
    expect(structured(result)).toEqual({ success: false, trashed: false });
    expect(outputValidator(PAGE_DELETE).safeParse(structured(result)).success).toBe(true);
  });

  it('force_delete maps to the REST `force` query (permanent delete)', async () => {
    const wp = makeWp();
    wp.deleteDocument.mockResolvedValue({
      id: 9,
      deleted: true,
      trashed: false,
    } satisfies DeleteDocumentResponse);
    await pageDeleteHandler({ post_id: 9, confirm: true, force_delete: true }, makeCtx(wp));
    expect(wp.deleteDocument).toHaveBeenCalledWith(9, { force: true });
  });
});

/* ───────────────────────────── elementor.page.export_template (§2.9) ────────────────────────── */

describe('pageExportTemplateHandler', () => {
  it('exports library-format JSON and projects global_classes map ⇒ array', async () => {
    const wp = makeWp();
    const resp: ExportDocumentResponse = {
      content: [atomicNode('nnnnnnn') as unknown as ExportDocumentResponse['content'][number]],
      page_settings: { title: 'T' },
      type: 'page',
      version: '0.4',
      global_classes: {
        'g-1': { id: 'g-1', type: 'class', label: 'Hero', variants: [] },
      },
      global_variables: { '--brand': '#f00' },
    };
    wp.exportDocument.mockResolvedValue(resp);

    const result = await pageExportTemplateHandler({ post_id: 9 }, makeCtx(wp));
    expect(wp.exportDocument).toHaveBeenCalledWith(9);
    const out = structured(result);
    expect(out['type']).toBe('page');
    expect(Array.isArray(out['global_classes'])).toBe(true);
    expect((out['global_classes'] as unknown[]).length).toBe(1);
    expect(out['global_variables']).toEqual({ '--brand': '#f00' });
    expect(outputValidator(PAGE_EXPORT_TEMPLATE).safeParse(out).success).toBe(true);
  });

  it('omits empty global_classes / global_variables', async () => {
    const wp = makeWp();
    wp.exportDocument.mockResolvedValue({
      content: [],
      page_settings: {},
      type: 'page',
      version: '0.4',
      global_classes: {},
      global_variables: {},
    } satisfies ExportDocumentResponse);
    const result = await pageExportTemplateHandler({ post_id: 9 }, makeCtx(wp));
    const out = structured(result);
    expect('global_classes' in out).toBe(false);
    expect('global_variables' in out).toBe(false);
  });
});

/* ───────────────────────────── elementor.page.list_backups (§2.8) ───────────────────────────── */

describe('pageListBackupsHandler', () => {
  it('lists backup snapshots and returns the paginated collection', async () => {
    const wp = makeWp();
    wp.listBackups.mockResolvedValue({
      items: [
        { meta_key: '_emcp_backup_2', ts: 200, label: 'edit', base_hash: 'b'.repeat(32) },
        { meta_key: '_emcp_backup_1', ts: 100, label: 'build', base_hash: 'a'.repeat(32) },
      ],
      next_cursor: null,
      total: 2,
    });

    const result = await pageListBackupsHandler({ post_id: 9, limit: 50 }, makeCtx(wp));
    expect(wp.listBackups).toHaveBeenCalledWith(9, { limit: 50 });
    const out = structured(result);
    expect((out['items'] as unknown[]).length).toBe(2);
    expect(out['total']).toBe(2);
    expect(outputValidator(PAGE_LIST_BACKUPS).safeParse(out).success).toBe(true);
  });
});

/* ───────────────────────────── elementor.page.rollback (§2.8) ────────────────────────────────── */

describe('pageRollbackHandler', () => {
  it('resolves "latest" to the newest snapshot by ts and rolls back on confirm', async () => {
    const wp = makeWp();
    wp.listBackups.mockResolvedValue({
      items: [
        { meta_key: '_emcp_backup_1', ts: 100, label: 'build', base_hash: 'a'.repeat(32) },
        { meta_key: '_emcp_backup_2', ts: 200, label: 'edit', base_hash: 'b'.repeat(32) },
      ],
      next_cursor: null,
      total: 2,
    });
    wp.rollbackDocument.mockResolvedValue({
      id: 9,
      restored_from: '_emcp_backup_2',
      base_hash: 'b'.repeat(32),
      css_primed: true,
    } satisfies RollbackDocumentResponse);
    const ctx = makeCtx(wp, { elicit: () => Promise.resolve({ confirmed: true }) });

    const result = await pageRollbackHandler(
      { post_id: 9, backup: 'latest', confirm: false, prime_css: true },
      ctx,
    );
    expect(ctx.elicit).toHaveBeenCalledTimes(1);
    expect(wp.rollbackDocument).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ meta_key: '_emcp_backup_2', prime_css: true }),
    );
    const out = structured(result);
    expect(out['restored_from']).toBe('_emcp_backup_2');
    expect(out['css_primed']).toBe(true);
    expect(outputValidator(PAGE_ROLLBACK).safeParse(out).success).toBe(true);
  });

  it('rolls back to an explicit meta_key without listing backups', async () => {
    const wp = makeWp();
    wp.rollbackDocument.mockResolvedValue({
      id: 9,
      restored_from: '_emcp_backup_1',
      base_hash: 'a'.repeat(32),
      css_primed: true,
    } satisfies RollbackDocumentResponse);
    await pageRollbackHandler(
      { post_id: 9, backup: '_emcp_backup_1', confirm: true, prime_css: true },
      makeCtx(wp),
    );
    expect(wp.listBackups).not.toHaveBeenCalled();
    expect(wp.rollbackDocument).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ meta_key: '_emcp_backup_1' }),
    );
  });

  it('returns a CLEAN non-error result on DECLINE without rolling back', async () => {
    const wp = makeWp();
    const ctx = makeCtx(wp, { elicit: () => Promise.resolve({ confirmed: false }) });
    const result = await pageRollbackHandler(
      { post_id: 9, backup: '_emcp_backup_1', confirm: false, prime_css: true },
      ctx,
    );
    expect(wp.rollbackDocument).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(firstText(result)).toMatch(/cancelled/i);
    // M-b (contract 18 §7): schema-valid structured decline payload.
    expect(outputValidator(PAGE_ROLLBACK).safeParse(structured(result)).success).toBe(true);
    expect(structured(result)['css_primed']).toBe(false);
  });

  it('returns an isError NOT_FOUND when "latest" has no snapshots', async () => {
    const wp = makeWp();
    wp.listBackups.mockResolvedValue({ items: [], next_cursor: null, total: 0 });
    const result = await pageRollbackHandler(
      { post_id: 9, backup: 'latest', confirm: true, prime_css: true },
      makeCtx(wp),
    );
    expect(wp.rollbackDocument).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

/* ───────────────────────────── error surface split (Contract 12 §5) ─────────────────────────── */

describe('error surface split', () => {
  it('THROWS a ProtocolError for a surface:protocol payload (e.g. SCHEMA_INVALID_PARAMS)', async () => {
    const wp = makeWp();
    wp.createDocument.mockRejectedValue(
      new WpClientError(
        makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad args', { surface: 'protocol' }),
      ),
    );
    await expect(
      pageCreateHandler({ post_type: 'page', status: 'draft' }, makeCtx(wp)),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-WpClientError (server core surfaces it)', async () => {
    const wp = makeWp();
    wp.duplicateDocument.mockRejectedValue(new Error('boom'));
    await expect(pageDuplicateHandler({ post_id: 1 }, makeCtx(wp))).rejects.toThrow('boom');
  });
});

/* ───────────────────────────── handlers route through attach (smoke) ────────────────────────── */

describe('attached handlers are invokable', () => {
  it('invokes page.create through the registry-attached handler', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 1,
      edit_url: 'u',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    const registry = createToolRegistry();
    attachPageHandlers(registry);
    const handler = registry.getHandler(PAGE_CREATE) as unknown as (
      a: Record<string, unknown>,
      c: ToolContext,
    ) => Promise<{ structuredContent?: unknown }>;
    const result = await handler({ post_type: 'page', status: 'draft' }, makeCtx(wp));
    expect((result.structuredContent as { id: number }).id).toBe(1);
  });
});

/* ───────────────────────────── §7-AI S2 render verification (contract 18) ───────────────────── */

describe('pageVerifyRenderHandler (§7-AI S2)', () => {
  it('returns the probe payload and validates against the outputSchema (verified)', async () => {
    const wp = makeWp();
    wp.verifyRenderDocument.mockResolvedValue({
      id: 42,
      render_verified: true,
      method: 'loopback',
      http_status: 200,
      fatal: null,
      checked_url: 'http://x/?p=42',
    });
    const result = await pageVerifyRenderHandler({ post_id: 42 }, makeCtx(wp));
    expect(wp.verifyRenderDocument).toHaveBeenCalledWith(42);
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    const out = structured(result);
    expect(outputValidator(PAGE_VERIFY_RENDER).safeParse(out).success).toBe(true);
    expect(advertisedWireValidator(PAGE_VERIFY_RENDER)(out).valid).toBe(true);
    expect(out['render_verified']).toBe(true);
  });

  it('a FAILED probe is a SUCCESS result with render_verified:false (soft RENDER_FAILED)', async () => {
    const wp = makeWp();
    wp.verifyRenderDocument.mockResolvedValue({
      id: 42,
      render_verified: false,
      method: 'dispatch',
      http_status: null,
      fatal: 'TypeError: trim(): Argument #1 ($string) must be of type string, array given',
      checked_url: null,
    });
    const result = await pageVerifyRenderHandler({ post_id: 42 }, makeCtx(wp));
    // The probe outcome is data, not an error — the document is unchanged (A2).
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    const out = structured(result);
    expect(outputValidator(PAGE_VERIFY_RENDER).safeParse(out).success).toBe(true);
    expect(out['render_verified']).toBe(false);
    expect(firstText(result)).toMatch(/RENDER_FAILED/);
  });
});

describe('verify_render threading on build/replace (§7-AI S2)', () => {
  function buildArgs() {
    return {
      title: 'Hero',
      post_type: 'page',
      elements: [atomicNode('vvvvvvv')],
      generation: 'v4' as const,
      status: 'draft' as const,
      prime_css: true,
    };
  }

  it('page.build defaults verify_render:true into the save body and surfaces render_verified', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'http://x/edit/42',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(saveResponse({ render_verified: true }));

    const result = await pageBuildHandler(buildArgs(), makeCtx(wp));
    const [, savedBody] = wp.saveDocument.mock.calls[0] as [number, Record<string, unknown>];
    expect(savedBody['verify_render']).toBe(true);
    const out = structured(result);
    expect(out['render_verified']).toBe(true);
    expect(outputValidator(PAGE_BUILD).safeParse(out).success).toBe(true);
    expect(advertisedWireValidator(PAGE_BUILD)(out).valid).toBe(true);
  });

  it('a render_verified:false save adds a [RENDER_FAILED] warning (A2: green save, dead page)', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'http://x/edit/42',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(
      saveResponse({
        render_verified: false,
        render_probe: {
          render_verified: false,
          method: 'dispatch',
          http_status: null,
          fatal: 'TypeError: trim()',
          checked_url: null,
        },
      }),
    );

    const result = await pageBuildHandler(buildArgs(), makeCtx(wp));
    const out = structured(result);
    expect(out['render_verified']).toBe(false);
    const warnings = (out['report'] as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('RENDER_FAILED'))).toBe(true);
  });

  it('§7-AI S3: PHP writer warnings (UNBOUND_MENU) fold into report.warnings', async () => {
    const wp = makeWp();
    wp.createDocument.mockResolvedValue({
      id: 42,
      edit_url: 'http://x/edit/42',
      status: 'draft',
      type: 'page',
    } satisfies CreateDocumentResponse);
    wp.saveDocument.mockResolvedValue(
      saveResponse({
        render_verified: true,
        warnings: [
          {
            code: 'UNBOUND_MENU',
            element_id: 'nav1234',
            message: 'No nav_menu term matches "main".',
          },
        ],
      }),
    );

    const result = await pageBuildHandler(buildArgs(), makeCtx(wp));
    const out = structured(result);
    const warnings = (out['report'] as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('UNBOUND_MENU') && w.includes('nav1234'))).toBe(true);
  });

  it('replace_tree forwards verify_render:false by default and true when requested', async () => {
    const wp = makeWp();
    wp.saveDocument.mockResolvedValue(saveResponse());
    await pageReplaceTreeHandler(
      {
        post_id: 42,
        elements: [atomicNode('wwwwwww')],
        base_hash: 'c'.repeat(32),
        confirm: true,
        force: false,
        prime_css: true,
      },
      makeCtx(wp),
    );
    let [, body] = wp.saveDocument.mock.calls[0] as [number, Record<string, unknown>];
    expect(body['verify_render']).toBe(false);

    wp.saveDocument.mockClear();
    wp.saveDocument.mockResolvedValue(saveResponse({ render_verified: true }));
    const result = await pageReplaceTreeHandler(
      {
        post_id: 42,
        elements: [atomicNode('xxxxxxx')],
        base_hash: 'c'.repeat(32),
        confirm: true,
        force: false,
        prime_css: true,
        verify_render: true,
      },
      makeCtx(wp),
    );
    [, body] = wp.saveDocument.mock.calls[0] as [number, Record<string, unknown>];
    expect(body['verify_render']).toBe(true);
    expect(structured(result)['render_verified']).toBe(true);
  });
});
