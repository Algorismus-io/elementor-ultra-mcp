/**
 * WP-T06 — widget / element handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + `ctx.elicit` + a real WP-F04
 * {@link ToolRegistry}. The tests assert (per the ticket §Tests Required + §Acceptance):
 *  - all nine §1.3 handlers attach by EXACT catalog name; `widget.insert`/`widget.update_settings`
 *    are ★ + `idempotentHint`,
 *  - each MUTATING op submits ONE granular `op` of the right kind via `elementOps`, threading
 *    `base_hash` (REQUIRED), `op_id` (idempotency), and `force`,
 *  - every mutate `structuredContent` validates against the WP-F04 descriptor `outputSchema`
 *    (i.e. the synthesized frozen `Diff` with `changes[]` is well-formed),
 *  - `set_local_style` MINTS + returns a style id (and reuses an explicit one),
 *  - `bind_dynamic`/`bind_global` produce the right op + `dynamic_string`,
 *  - `element.delete` ELICITS when `confirm!=true` and a DECLINE makes no REST call (clean non-error),
 *  - a `surface:'isError'` {@link WpClientError} (e.g. `CONCURRENCY_STALE_HASH`/`LOCK_HELD`) renders
 *    an `isError` taxonomy result, a `surface:'protocol'` payload THROWS a {@link ProtocolError}, and
 *    `IDEMPOTENT_REPLAY` is surfaced informationally,
 *  - `element.get` returns `{node,base_hash}` and a missing node → `NOT_FOUND`.
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type ElementOpsResponse,
  type GetDocumentResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import type { ElementNode, StyleVariant } from '../authoring/contract.js';
import { WpClientError } from '../wp/types.js';
import { ProtocolError } from '../wp/errors.js';

import {
  attachWidgetHandlers,
  restDiffToDiff,
  elementGetHandler,
  widgetInsertHandler,
  widgetUpdateSettingsHandler,
  elementMoveHandler,
  elementDeleteHandler,
  elementSetClassesHandler,
  elementSetLocalStyleHandler,
  elementBindDynamicHandler,
  elementBindGlobalHandler,
  WIDGET_TOOL_NAMES,
  ELEMENT_GET,
  WIDGET_INSERT,
  WIDGET_UPDATE_SETTINGS,
  ELEMENT_MOVE,
  ELEMENT_DELETE,
  ELEMENT_SET_CLASSES,
  ELEMENT_SET_LOCAL_STYLE,
  ELEMENT_BIND_DYNAMIC,
  ELEMENT_BIND_GLOBAL,
} from './widget.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the routes the handlers call. */
interface MockWp {
  getDocument: ReturnType<typeof vi.fn>;
  elementOps: ReturnType<typeof vi.fn>;
}

function makeWp(): MockWp {
  return {
    getDocument: vi.fn(),
    elementOps: vi.fn(),
  };
}

/** A configurable mock elicit: defaults to ACCEPT; pass `false` to decline. */
function makeElicit(confirmed = true): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({ confirmed });
}

/** Build a minimal {@link ToolContext} carrying the mock `wp` + elicit + a real registry. */
function makeCtx(
  wp: MockWp,
  registry: ToolRegistry,
  elicit: ReturnType<typeof vi.fn> = makeElicit(),
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

/** Extract `structuredContent` from a tool result (assumes a success result). */
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** First text content block of a tool result (the content union widens to image blocks too). */
function firstText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const block = result.content?.[0];
  return block !== undefined && 'text' in block ? (block.text ?? '') : '';
}

/** A canonical successful element-ops REST response (one changed id). */
function opsResponse(over: Partial<ElementOpsResponse> = {}): ElementOpsResponse {
  return {
    id: 42,
    diff: { changed_ids: ['hd00001'], new_ids: [], removed_ids: [] },
    base_hash: 'newhash00000000000000000000000001',
    css_primed: false,
    remapped_ids: {},
    ...over,
  };
}

const BASE_HASH = '9f86d081884c7d659a2feaa0c55ad015';

/** A minimal atomic widget node for insert tests. */
function sampleNode(id = 'newnode'): ElementNode {
  return {
    id,
    elType: 'widget',
    widgetType: 'e-heading',
    settings: { classes: { $$type: 'classes', value: [] } },
  };
}

/** A minimal style variant for set_local_style tests. */
function sampleVariant(): StyleVariant {
  return {
    meta: { breakpoint: 'desktop', state: null },
    props: { 'font-size': { $$type: 'size', value: { unit: 'px', size: 48 } } },
  };
}

/** First arg of the single `elementOps(post_id, body)` call. */
function opsCall(wp: MockWp): {
  postId: number;
  body: { base_hash: string; ops: Array<Record<string, unknown>>; force?: boolean; op_id?: string };
} {
  const call = wp.elementOps.mock.calls[0] as [
    number,
    { base_hash: string; ops: Array<Record<string, unknown>>; force?: boolean; op_id?: string },
  ];
  return { postId: call[0], body: call[1] };
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachWidgetHandlers', () => {
  it('attaches a handler for every §1.3 widget/element tool', () => {
    const registry = createToolRegistry();
    attachWidgetHandlers(registry);
    for (const name of WIDGET_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      expect(registry.has(name)).toBe(true); // exact-name match against the frozen catalog
    }
  });

  it('owns exactly the nine §1.3 names', () => {
    expect([...WIDGET_TOOL_NAMES].sort()).toEqual(
      [
        ELEMENT_GET,
        WIDGET_INSERT,
        WIDGET_UPDATE_SETTINGS,
        ELEMENT_MOVE,
        ELEMENT_DELETE,
        ELEMENT_SET_CLASSES,
        ELEMENT_SET_LOCAL_STYLE,
        ELEMENT_BIND_DYNAMIC,
        ELEMENT_BIND_GLOBAL,
      ].sort(),
    );
  });

  it('exposes widget.insert + widget.update_settings as ★ with idempotentHint (§5.2)', () => {
    const registry = createToolRegistry();
    for (const name of [WIDGET_INSERT, WIDGET_UPDATE_SETTINGS]) {
      const d = registry.getDescriptor(name);
      expect(d.star, name).toBe(true);
      expect((d.annotations as { idempotentHint?: boolean }).idempotentHint, name).toBe(true);
    }
  });

  it('marks element.delete destructive + element.get read-only (§1.3 annotations)', () => {
    const registry = createToolRegistry();
    expect(
      (registry.getDescriptor(ELEMENT_DELETE).annotations as { destructiveHint?: boolean })
        .destructiveHint,
    ).toBe(true);
    expect(
      (registry.getDescriptor(ELEMENT_GET).annotations as { readOnlyHint?: boolean }).readOnlyHint,
    ).toBe(true);
  });
});

/* ───────────────────────────── diff bridge ─────────────────────────────────────────────────── */

describe('restDiffToDiff', () => {
  it('synthesizes one NodeChange per rolled-up id (added/modified/removed) + carries the arrays', () => {
    const diff = restDiffToDiff({
      new_ids: ['n1'],
      changed_ids: ['c1', 'c2'],
      removed_ids: ['r1'],
    });
    expect(diff.changes).toEqual([
      { id: 'n1', op: 'added' },
      { id: 'c1', op: 'modified' },
      { id: 'c2', op: 'modified' },
      { id: 'r1', op: 'removed' },
    ]);
    expect(diff.new_ids).toEqual(['n1']);
    expect(diff.changed_ids).toEqual(['c1', 'c2']);
    expect(diff.removed_ids).toEqual(['r1']);
  });

  it('produces a Diff with an empty changes[] for an empty rollup (still schema-valid)', () => {
    const diff = restDiffToDiff({ new_ids: [], changed_ids: [], removed_ids: [] });
    expect(diff.changes).toEqual([]);
  });
});

/* ───────────────────────────── element.get (§1.3 / §2.4) ────────────────────────────────────── */

describe('elementGetHandler', () => {
  it('proxies GET /documents with subtree_id and returns {node,base_hash}', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const node = sampleNode('hd00001');
    const resp: GetDocumentResponse = {
      id: 42,
      elements: [node] as GetDocumentResponse['elements'],
      settings: {},
      base_hash: BASE_HASH,
      generation: 'v4',
      type: 'page',
    };
    wp.getDocument.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await elementGetHandler({ post_id: 42, element_id: 'hd00001' }, ctx);

    expect(wp.getDocument).toHaveBeenCalledWith(42, { subtree_id: 'hd00001' });
    const out = structured(result);
    expect(out['base_hash']).toBe(BASE_HASH);
    expect((out['node'] as ElementNode).id).toBe('hd00001');
    expect(outputValidator(registry, ELEMENT_GET).safeParse(out).success).toBe(true);
    expect(result.isError).toBeFalsy();
  });

  it('finds a nested node deep in the subtree', async () => {
    const wp = makeWp();
    const child = sampleNode('child99');
    const parent = {
      id: 'parent1',
      elType: 'e-div-block',
      settings: { classes: { $$type: 'classes', value: [] } },
      elements: [child],
    } as ElementNode;
    wp.getDocument.mockResolvedValue({
      id: 42,
      elements: [parent],
      settings: {},
      base_hash: BASE_HASH,
      generation: 'v4',
      type: 'page',
    });
    const ctx = makeCtx(wp, createToolRegistry());

    const result = await elementGetHandler({ post_id: 42, element_id: 'child99' }, ctx);
    expect((structured(result)['node'] as ElementNode).id).toBe('child99');
  });

  it('returns NOT_FOUND isError when the node is absent', async () => {
    const wp = makeWp();
    wp.getDocument.mockResolvedValue({
      id: 42,
      elements: [],
      settings: {},
      base_hash: BASE_HASH,
      generation: 'v4',
      type: 'page',
    });
    const ctx = makeCtx(wp, createToolRegistry());

    const result = await elementGetHandler({ post_id: 42, element_id: 'ghost' }, ctx);
    expect(result.isError).toBe(true);
    expect(structured(result)['code'] as string).toBe(ErrorCodes.NOT_FOUND);
  });
});

/* ───────────────────────────── widget.insert (★, §1.3 / §14) ────────────────────────────────── */

describe('widgetInsertHandler', () => {
  it('submits ONE insert op with base_hash + a minted op_id, returns inserted_id from new_ids', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(
      opsResponse({ diff: { changed_ids: [], new_ids: ['fresh01'], removed_ids: [] } }),
    );
    const ctx = makeCtx(wp, registry);

    const result = await widgetInsertHandler(
      {
        post_id: 42,
        parent_id: 'parent1',
        index: 0,
        node: sampleNode('authored'),
        base_hash: BASE_HASH,
        force: false,
      },
      ctx,
    );

    expect(wp.elementOps).toHaveBeenCalledTimes(1);
    const { postId, body } = opsCall(wp);
    expect(postId).toBe(42);
    expect(body.base_hash).toBe(BASE_HASH);
    expect(body.ops).toHaveLength(1);
    expect(body.ops[0]?.['op']).toBe('insert');
    expect(body.ops[0]?.['parent_id']).toBe('parent1');
    expect(body.ops[0]?.['index']).toBe(0);
    expect(body.op_id).toMatch(/^op-[A-Za-z0-9_-]+$/);
    expect(body.force).toBeUndefined();

    const out = structured(result);
    expect(out['inserted_id']).toBe('fresh01');
    expect(out['base_hash']).toBe('newhash00000000000000000000000001');
    expect(outputValidator(registry, WIDGET_INSERT).safeParse(out).success).toBe(true);
  });

  it('uses the authored id as inserted_id when PHP accepted it', async () => {
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(
      opsResponse({ diff: { changed_ids: [], new_ids: ['authored'], removed_ids: [] } }),
    );
    const ctx = makeCtx(wp, createToolRegistry());
    const result = await widgetInsertHandler(
      {
        post_id: 42,
        parent_id: 'p',
        node: sampleNode('authored'),
        base_hash: BASE_HASH,
        force: false,
      },
      ctx,
    );
    expect(structured(result)['inserted_id']).toBe('authored');
  });

  it('prefers the remap target when PHP re-IDed the inserted node', async () => {
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(
      opsResponse({
        diff: { changed_ids: [], new_ids: ['remapped'], removed_ids: [] },
        remapped_ids: { authored: 'remapped' },
      }),
    );
    const ctx = makeCtx(wp, createToolRegistry());
    const result = await widgetInsertHandler(
      {
        post_id: 42,
        parent_id: 'p',
        node: sampleNode('authored'),
        base_hash: BASE_HASH,
        force: false,
      },
      ctx,
    );
    expect(structured(result)['inserted_id']).toBe('remapped');
  });

  it('honors an explicit op_id and threads force=true', async () => {
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(
      opsResponse({ diff: { changed_ids: [], new_ids: ['x'], removed_ids: [] } }),
    );
    const ctx = makeCtx(wp, createToolRegistry());
    await widgetInsertHandler(
      {
        post_id: 42,
        parent_id: 'p',
        node: sampleNode(),
        base_hash: BASE_HASH,
        op_id: 'my-explicit-id',
        force: true,
      },
      ctx,
    );
    const { body } = opsCall(wp);
    expect(body.op_id).toBe('my-explicit-id');
    expect(body.force).toBe(true);
  });

  it('mints a DETERMINISTIC op_id (same inputs ⇒ same id)', async () => {
    const wp1 = makeWp();
    const wp2 = makeWp();
    wp1.elementOps.mockResolvedValue(
      opsResponse({ diff: { changed_ids: [], new_ids: ['x'], removed_ids: [] } }),
    );
    wp2.elementOps.mockResolvedValue(
      opsResponse({ diff: { changed_ids: [], new_ids: ['x'], removed_ids: [] } }),
    );
    const args = {
      post_id: 42,
      parent_id: 'p',
      index: 1,
      node: sampleNode('n'),
      base_hash: BASE_HASH,
      force: false,
    } as const;
    await widgetInsertHandler({ ...args }, makeCtx(wp1, createToolRegistry()));
    await widgetInsertHandler({ ...args }, makeCtx(wp2, createToolRegistry()));
    expect(opsCall(wp1).body.op_id).toBe(opsCall(wp2).body.op_id);
  });
});

/* ───────────────────────────── widget.update_settings (★, §1.3) ─────────────────────────────── */

describe('widgetUpdateSettingsHandler', () => {
  it('submits ONE update_settings op carrying the settings patch + base_hash', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(opsResponse());
    const ctx = makeCtx(wp, registry);

    const result = await widgetUpdateSettingsHandler(
      {
        post_id: 42,
        element_id: 'hd00001',
        settings: { title: { $$type: 'string', value: 'Hello' } },
        base_hash: BASE_HASH,
        force: false,
      },
      ctx,
    );

    const { body } = opsCall(wp);
    expect(body.ops[0]?.['op']).toBe('update_settings');
    expect(body.ops[0]?.['element_id']).toBe('hd00001');
    expect(body.ops[0]?.['settings']).toEqual({ title: { $$type: 'string', value: 'Hello' } });
    expect(body.op_id).toMatch(/^op-/);
    expect(
      outputValidator(registry, WIDGET_UPDATE_SETTINGS).safeParse(structured(result)).success,
    ).toBe(true);
  });
});

/* ───────────────────────────── element.move (§1.3) ──────────────────────────────────────────── */

describe('elementMoveHandler', () => {
  it('submits ONE move op with new_parent_id + index, NO op_id (no idempotency hint)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(opsResponse());
    const ctx = makeCtx(wp, registry);

    const result = await elementMoveHandler(
      {
        post_id: 42,
        element_id: 'hd00001',
        new_parent_id: 'def5678',
        index: 1,
        base_hash: BASE_HASH,
        force: false,
      },
      ctx,
    );
    const { body } = opsCall(wp);
    expect(body.ops[0]).toMatchObject({
      op: 'move',
      element_id: 'hd00001',
      new_parent_id: 'def5678',
      index: 1,
    });
    expect(body.op_id).toBeUndefined();
    expect(outputValidator(registry, ELEMENT_MOVE).safeParse(structured(result)).success).toBe(
      true,
    );
  });
});

/* ───────────────────────────── element.delete (D, §1.3) ─────────────────────────────────────── */

describe('elementDeleteHandler', () => {
  it('ELICITS when confirm!=true and DECLINE makes no REST call (clean non-error)', async () => {
    const wp = makeWp();
    const elicit = makeElicit(false); // user declines
    const ctx = makeCtx(wp, createToolRegistry(), elicit);

    const result = await elementDeleteHandler(
      { post_id: 42, element_id: 'xy99999', base_hash: BASE_HASH, confirm: false, force: false },
      ctx,
    );

    expect(elicit).toHaveBeenCalledTimes(1);
    expect(wp.elementOps).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toMatch(/cancelled/i);
  });

  it('submits the delete op after an elicitation ACCEPT', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(
      opsResponse({ diff: { changed_ids: [], new_ids: [], removed_ids: ['xy99999'] } }),
    );
    const elicit = makeElicit(true);
    const ctx = makeCtx(wp, registry, elicit);

    const result = await elementDeleteHandler(
      { post_id: 42, element_id: 'xy99999', base_hash: BASE_HASH, confirm: false, force: false },
      ctx,
    );

    expect(elicit).toHaveBeenCalledTimes(1);
    expect(opsCall(wp).body.ops[0]).toMatchObject({ op: 'delete', element_id: 'xy99999' });
    expect(outputValidator(registry, ELEMENT_DELETE).safeParse(structured(result)).success).toBe(
      true,
    );
  });

  it('SKIPS elicitation when confirm=true', async () => {
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(
      opsResponse({ diff: { changed_ids: [], new_ids: [], removed_ids: ['xy99999'] } }),
    );
    const elicit = makeElicit(true);
    const ctx = makeCtx(wp, createToolRegistry(), elicit);

    await elementDeleteHandler(
      { post_id: 42, element_id: 'xy99999', base_hash: BASE_HASH, confirm: true, force: false },
      ctx,
    );
    expect(elicit).not.toHaveBeenCalled();
    expect(wp.elementOps).toHaveBeenCalledTimes(1);
  });
});

/* ───────────────────────────── element.set_classes (§1.3) ───────────────────────────────────── */

describe('elementSetClassesHandler', () => {
  it('submits ONE set_classes op with the BARE class_ids array + minted op_id', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(opsResponse());
    const ctx = makeCtx(wp, registry);

    const result = await elementSetClassesHandler(
      {
        post_id: 42,
        element_id: 'abc1234',
        class_ids: ['g-card', 'e-abc1234-7f3a'],
        base_hash: BASE_HASH,
      },
      ctx,
    );
    const { body } = opsCall(wp);
    expect(body.ops[0]).toMatchObject({
      op: 'set_classes',
      element_id: 'abc1234',
      class_ids: ['g-card', 'e-abc1234-7f3a'],
    });
    expect(body.op_id).toMatch(/^op-/);
    expect(
      outputValidator(registry, ELEMENT_SET_CLASSES).safeParse(structured(result)).success,
    ).toBe(true);
  });
});

/* ───────────────────────────── element.set_local_style (§1.3 / §5.1) ────────────────────────── */

describe('elementSetLocalStyleHandler', () => {
  it('MINTS a style id when absent (e-<element_id>-<7hex>) and returns it', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(opsResponse());
    const ctx = makeCtx(wp, registry);

    const result = await elementSetLocalStyleHandler(
      { post_id: 42, element_id: 'abc1234', variant: sampleVariant(), base_hash: BASE_HASH },
      ctx,
    );

    const out = structured(result);
    const styleId = out['style_id'] as string;
    expect(styleId).toMatch(/^e-abc1234-[0-9a-f]{7}$/);
    const { body } = opsCall(wp);
    expect(body.ops[0]).toMatchObject({
      op: 'set_local_style',
      element_id: 'abc1234',
      style_id: styleId,
    });
    expect(body.ops[0]?.['variant']).toEqual(sampleVariant());
    expect(outputValidator(registry, ELEMENT_SET_LOCAL_STYLE).safeParse(out).success).toBe(true);
  });

  it('REUSES an explicit style_id (re-upsert) and keys the op_id on it', async () => {
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(opsResponse());
    const ctx = makeCtx(wp, createToolRegistry());
    const result = await elementSetLocalStyleHandler(
      {
        post_id: 42,
        element_id: 'abc1234',
        style_id: 'e-abc1234-deadbee',
        variant: sampleVariant(),
        base_hash: BASE_HASH,
      },
      ctx,
    );
    expect(structured(result)['style_id']).toBe('e-abc1234-deadbee');
    expect(opsCall(wp).body.ops[0]?.['style_id']).toBe('e-abc1234-deadbee');
  });
});

/* ───────────────────────────── element.bind_dynamic (§1.3 / §A.6) ───────────────────────────── */

describe('elementBindDynamicHandler', () => {
  it('submits ONE bind_dynamic op and returns the PHP-echoed dynamic_string when present', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // PHP echoes the canonical dynamic_string on the response.
    wp.elementOps.mockResolvedValue({
      ...opsResponse(),
      dynamic_string: '[elementor-tag id="abc" name="post-title" settings="%7B%7D"]',
    });
    const ctx = makeCtx(wp, registry);

    const result = await elementBindDynamicHandler(
      {
        post_id: 42,
        element_id: 'hd00001',
        control: 'title',
        tag_name: 'post-title',
        base_hash: BASE_HASH,
      },
      ctx,
    );
    const { body } = opsCall(wp);
    expect(body.ops[0]).toMatchObject({
      op: 'bind_dynamic',
      element_id: 'hd00001',
      control: 'title',
      tag_name: 'post-title',
    });
    const out = structured(result);
    expect(out['dynamic_string']).toBe(
      '[elementor-tag id="abc" name="post-title" settings="%7B%7D"]',
    );
    expect(outputValidator(registry, ELEMENT_BIND_DYNAMIC).safeParse(out).success).toBe(true);
  });

  it('falls back to a V3-encoded dynamic_string (settings url-encoded, %7B%7D for empty) when PHP omits it', async () => {
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(opsResponse());
    const ctx = makeCtx(wp, createToolRegistry());
    const result = await elementBindDynamicHandler(
      {
        post_id: 42,
        element_id: 'hd00001',
        control: 'title',
        tag_name: 'post-title',
        base_hash: BASE_HASH,
      },
      ctx,
    );
    expect(structured(result)['dynamic_string']).toBe(
      '[elementor-tag name="post-title" settings="%7B%7D"]',
    );
  });

  it('passes tag_settings + fallback_value through into the op', async () => {
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(opsResponse());
    const ctx = makeCtx(wp, createToolRegistry());
    await elementBindDynamicHandler(
      {
        post_id: 42,
        element_id: 'hd00001',
        control: 'title',
        tag_name: 'acf',
        tag_settings: { key: 'field_1' },
        fallback_value: 'Static',
        base_hash: BASE_HASH,
      },
      ctx,
    );
    expect(opsCall(wp).body.ops[0]).toMatchObject({
      tag_settings: { key: 'field_1' },
      fallback_value: 'Static',
    });
  });
});

/* ───────────────────────────── element.bind_global (§1.3) ───────────────────────────────────── */

describe('elementBindGlobalHandler', () => {
  it('submits ONE bind_global op with the global_ref', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.elementOps.mockResolvedValue(opsResponse());
    const ctx = makeCtx(wp, registry);

    const result = await elementBindGlobalHandler(
      {
        post_id: 42,
        element_id: 'hd00001',
        control: 'title_color',
        global_ref: 'globals/colors?id=primary',
        base_hash: BASE_HASH,
      },
      ctx,
    );
    expect(opsCall(wp).body.ops[0]).toMatchObject({
      op: 'bind_global',
      element_id: 'hd00001',
      control: 'title_color',
      global_ref: 'globals/colors?id=primary',
    });
    expect(
      outputValidator(registry, ELEMENT_BIND_GLOBAL).safeParse(structured(result)).success,
    ).toBe(true);
  });
});

/* ───────────────────────────── concurrency / lock / replay error mapping (§0.8 / §5) ────────── */

describe('error + replay mapping', () => {
  it('maps a CONCURRENCY_STALE_HASH WpClientError to an isError result (§3 / §5.2)', async () => {
    const wp = makeWp();
    wp.elementOps.mockRejectedValue(
      new WpClientError(
        makeErrorPayload(ErrorCodes.CONCURRENCY_STALE_HASH, 'base_hash is stale', {
          meta: { actual_hash: 'live' },
        }),
        { httpStatus: 409 },
      ),
    );
    const ctx = makeCtx(wp, createToolRegistry());
    const result = await widgetUpdateSettingsHandler(
      { post_id: 42, element_id: 'hd00001', settings: {}, base_hash: BASE_HASH, force: false },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(structured(result)['code'] as string).toBe(ErrorCodes.CONCURRENCY_STALE_HASH);
  });

  it('maps a LOCK_HELD WpClientError to an isError result', async () => {
    const wp = makeWp();
    wp.elementOps.mockRejectedValue(
      new WpClientError(makeErrorPayload(ErrorCodes.LOCK_HELD, 'post locked'), { httpStatus: 409 }),
    );
    const ctx = makeCtx(wp, createToolRegistry());
    const result = await elementMoveHandler(
      {
        post_id: 42,
        element_id: 'a',
        new_parent_id: 'b',
        index: 0,
        base_hash: BASE_HASH,
        force: false,
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(structured(result)['code'] as string).toBe(ErrorCodes.LOCK_HELD);
  });

  it('THROWS a ProtocolError for a surface:protocol payload (§5.1)', async () => {
    const wp = makeWp();
    wp.elementOps.mockRejectedValue(
      new WpClientError(
        makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params', { surface: 'protocol' }),
      ),
    );
    const ctx = makeCtx(wp, createToolRegistry());
    await expect(
      widgetInsertHandler(
        { post_id: 42, parent_id: 'p', node: sampleNode(), base_hash: BASE_HASH, force: false },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-client error', async () => {
    const wp = makeWp();
    wp.elementOps.mockRejectedValue(new Error('socket hang up'));
    const ctx = makeCtx(wp, createToolRegistry());
    await expect(
      elementSetClassesHandler(
        { post_id: 42, element_id: 'a', class_ids: [], base_hash: BASE_HASH },
        ctx,
      ),
    ).rejects.toThrow('socket hang up');
  });

  it('surfaces IDEMPOTENT_REPLAY informationally on the result text (§5.4)', async () => {
    const wp = makeWp();
    wp.elementOps.mockResolvedValue({ ...opsResponse(), idempotent_replay: true });
    const ctx = makeCtx(wp, createToolRegistry());
    const result = await widgetInsertHandler(
      { post_id: 42, parent_id: 'p', node: sampleNode(), base_hash: BASE_HASH, force: false },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toMatch(/idempotent replay/i);
  });
});
