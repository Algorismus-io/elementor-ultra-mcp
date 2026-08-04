/**
 * WP-R08 — Pro popup handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + a real WP-F04 {@link ToolRegistry}.
 * The tests assert:
 *  - all three §1.8 handlers attach by EXACT catalog name; they are NON-★; annotations match the catalog
 *    (create none; set_triggers/set_timing idempotent);
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`;
 *  - the descriptor `inputSchema` for `create` defaults `status` to `'publish'`, accepts a `display_settings`
 *    `{triggers?,timing?}` of `z.record`, and rejects a non-string `title`; `set_triggers`/`set_timing`
 *    require an int `post_id`;
 *  - `create` proxies `POST /pro/popup`, shapes the frozen `{post_id,edit_url,conditions_stored}` (drops the
 *    raw `display_settings_meta`), sends a deterministic `op_id`, passes `display_settings`/`conditions`
 *    through, and surfaces an idempotent replay informationally;
 *  - `set_triggers` sends ONLY `{triggers}` and `set_timing` sends ONLY `{timing}` to
 *    `PUT /pro/popup/{id}/display`; both shape `{success,display_settings}` (mapping `saved`→`success`);
 *  - a `surface:'isError'` {@link WpClientError} (501 `PRO_REQUIRED`, 422 `VALIDATION_FAILED` carrying
 *    `actual_type`, 404 `NOT_FOUND`) renders an isError taxonomy result (never a -326xx protocol throw); a
 *    `surface:'protocol'` payload THROWS a {@link ProtocolError}; a non-client error rethrows
 *    (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type CreatePopupResponse,
  type SetPopupDisplayResponse,
  type ValidationFailedMeta,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../../catalog/registry.js';
import type { ToolContext } from '../../runtime/context.js';
import { WpClientError } from '../../wp/types.js';
import { ProtocolError } from '../../wp/errors.js';
import { OP_ID_PATTERN } from '../../safety/idempotency.js';

import {
  attachPopupHandlers,
  proPopupCreateHandler,
  proPopupSetTriggersHandler,
  proPopupSetTimingHandler,
  PRO_POPUP_TOOL_NAMES,
  PRO_POPUP_CREATE,
  PRO_POPUP_SET_TRIGGERS,
  PRO_POPUP_SET_TIMING,
} from './popup.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the Pro popup routes the handlers call. */
interface MockWp {
  createPopup: ReturnType<typeof vi.fn>;
  setPopupDisplay: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    createPopup: vi.fn(),
    setPopupDisplay: vi.fn(),
  };
}

/** Build a minimal {@link ToolContext} carrying the mock `wp` + a registry (caps/surface inert here). */
function makeCtx(wp: MockWp, registry: ToolRegistry): ToolContext {
  return {
    wp,
    registry,
    surface: {} as ToolContext['surface'],
    capabilities: {
      get: vi.fn(() => Promise.resolve({})),
    } as unknown as ToolContext['capabilities'],
    elicit: (() => Promise.resolve({ confirmed: false })) as unknown as ToolContext['elicit'],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolContext;
}

/** The WP-F04 descriptor `outputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function outputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).outputSchema);
}

/** The WP-F04 descriptor `inputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function inputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).inputSchema);
}

/** Extract the `structuredContent` from a tool result. */
function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** The first text content block of a tool result (content blocks are a union; narrow to text). */
function firstText(result: { content?: unknown }): string {
  const blocks = result.content as Array<{ type: string; text?: string }> | undefined;
  const block = blocks?.[0];
  return block?.text ?? '';
}

/** Whether a result is an isError tool result (12-error-taxonomy.md §5.2). */
function isErrorResult(result: { isError?: unknown }): boolean {
  return result.isError === true;
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachPopupHandlers', () => {
  it('attaches a handler for every §1.8 Pro popup tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachPopupHandlers(registry);

    for (const name of PRO_POPUP_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the three §1.8 Pro popup names', () => {
    expect([...PRO_POPUP_TOOL_NAMES].sort()).toEqual(
      [PRO_POPUP_CREATE, PRO_POPUP_SET_TRIGGERS, PRO_POPUP_SET_TIMING].sort(),
    );
  });

  it('all three Pro popup tools are NON-★ (Contract 13 §5.2 — registered disabled at boot)', () => {
    const registry = createToolRegistry();
    for (const name of PRO_POPUP_TOOL_NAMES) {
      expect(registry.getDescriptor(name).star).toBe(false);
    }
  });

  it('annotations match the frozen catalog (create none; set_triggers/set_timing idempotent)', () => {
    const registry = createToolRegistry();
    expect(registry.getDescriptor(PRO_POPUP_CREATE).annotations).toEqual({});
    const trig = registry.getDescriptor(PRO_POPUP_SET_TRIGGERS).annotations as Record<
      string,
      boolean
    >;
    expect(trig.idempotentHint).toBe(true);
    const tim = registry.getDescriptor(PRO_POPUP_SET_TIMING).annotations as Record<string, boolean>;
    expect(tim.idempotentHint).toBe(true);
  });
});

/* ───────────────────────────── inputSchema (frozen §1.8) ───────────────────────────────────── */

describe('elementor.pro.popup.create inputSchema (frozen §1.8)', () => {
  it("defaults status to 'publish' and accepts a minimal {title}", () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_POPUP_CREATE).safeParse({ title: 'Newsletter' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { status: string }).status).toBe('publish');
    }
  });

  it('accepts a display_settings {triggers?,timing?} of open records', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_POPUP_CREATE).safeParse({
      title: 'Newsletter',
      display_settings: {
        triggers: { page_load: 'yes', page_load_delay: 2 },
        timing: { times: 'yes', times_times: 3, times_period: 'week' },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-string title (→ -32602 at the SDK layer)', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_POPUP_CREATE).safeParse({ title: 42 });
    expect(parsed.success).toBe(false);
  });

  it('rejects a status outside publish|draft (→ -32602)', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_POPUP_CREATE).safeParse({
      title: 'X',
      status: 'pending',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('elementor.pro.popup.set_triggers/set_timing inputSchema (frozen §1.8)', () => {
  it('set_triggers requires an int post_id + a triggers record', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_POPUP_SET_TRIGGERS);
    expect(v.safeParse({ post_id: 12, triggers: { page_load: 'yes' } }).success).toBe(true);
    expect(v.safeParse({ post_id: 1.5, triggers: {} }).success).toBe(false);
    expect(v.safeParse({ post_id: 12 }).success).toBe(false);
  });

  it('set_timing requires an int post_id + a timing record', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_POPUP_SET_TIMING);
    expect(v.safeParse({ post_id: 12, timing: { page_views: 'yes' } }).success).toBe(true);
    expect(v.safeParse({ post_id: '12', timing: {} }).success).toBe(false);
    expect(v.safeParse({ post_id: 12 }).success).toBe(false);
  });
});

/* ───────────────────────────── elementor.pro.popup.create (§1.8 / §8.4) ─────────────────────── */

describe('proPopupCreateHandler', () => {
  function createResp(): CreatePopupResponse {
    return {
      post_id: 202,
      edit_url: 'http://localhost:8899/wp-admin/post.php?post=202&action=elementor',
      display_settings_meta: '_elementor_popup_display_settings',
      conditions_stored: ['include/general'],
    };
  }

  it('proxies POST /pro/popup, shapes the §1.8 output (drops display_settings_meta), sends a valid op_id', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createPopup.mockResolvedValue(createResp());
    const ctx = makeCtx(wp, registry);

    const result = await proPopupCreateHandler(
      {
        title: 'Newsletter',
        status: 'publish',
        display_settings: { triggers: { page_load: 'yes', page_load_delay: 2 } },
      },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PRO_POPUP_CREATE).parse(out);

    expect(wp.createPopup).toHaveBeenCalledTimes(1);
    const body = wp.createPopup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.title).toBe('Newsletter');
    expect(body.status).toBe('publish');
    expect(body.display_settings).toEqual({ triggers: { page_load: 'yes', page_load_delay: 2 } });
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);

    // The frozen outputSchema is {post_id, edit_url, conditions_stored} — display_settings_meta dropped.
    expect(out).toEqual({
      post_id: 202,
      edit_url: createResp().edit_url,
      conditions_stored: ['include/general'],
    });
  });

  it('passes conditions through when provided', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createPopup.mockResolvedValue({
      ...createResp(),
      conditions_stored: ['include/singular/post'],
    });
    const ctx = makeCtx(wp, registry);

    const result = await proPopupCreateHandler(
      {
        title: 'Targeted',
        status: 'draft',
        conditions: [['include', 'singular', 'post']],
      },
      ctx,
    );
    outputValidator(registry, PRO_POPUP_CREATE).parse(structured(result));
    const body = wp.createPopup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.conditions).toEqual([['include', 'singular', 'post']]);
  });

  it('omits display_settings/conditions from the body when not provided (PHP defaults site-wide)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createPopup.mockResolvedValue(createResp());
    const ctx = makeCtx(wp, registry);

    await proPopupCreateHandler({ title: 'Bare', status: 'publish' }, ctx);
    const body = wp.createPopup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('display_settings' in body).toBe(false);
    expect('conditions' in body).toBe(false);
  });

  it('surfaces an idempotent replay informationally in the text', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createPopup.mockResolvedValue({ ...createResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry);

    const result = await proPopupCreateHandler({ title: 'N', status: 'publish' }, ctx);
    expect(firstText(result).toLowerCase()).toContain('replay');
  });

  it('maps a 501 PRO_REQUIRED WpClientError to an isError result (never a -326xx)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.', {
      meta: { feature: 'popup' },
    });
    wp.createPopup.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proPopupCreateHandler({ title: 'N', status: 'publish' }, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });

  it('THROWS a ProtocolError for a surface:protocol payload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params');
    wp.createPopup.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    await expect(
      proPopupCreateHandler({ title: 'N', status: 'publish' }, ctx),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-WpClientError (server core surfaces it)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createPopup.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(proPopupCreateHandler({ title: 'N', status: 'publish' }, ctx)).rejects.toThrow(
      'boom',
    );
  });
});

/* ───────────────────────────── set_triggers / set_timing (§1.8 / §8.4) ──────────────────────── */

describe('proPopupSetTriggersHandler', () => {
  function displayResp(overrides?: Partial<SetPopupDisplayResponse>): SetPopupDisplayResponse {
    return {
      saved: true,
      display_settings: {
        triggers: { page_load: 'yes', page_load_delay: 2 },
        timing: { times: 'yes', times_times: 3 },
      },
      ...overrides,
    };
  }

  it('sends ONLY {triggers} to PUT /pro/popup/{id}/display and shapes {success,display_settings}', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.setPopupDisplay.mockResolvedValue(displayResp());
    const ctx = makeCtx(wp, registry);

    const result = await proPopupSetTriggersHandler(
      { post_id: 202, triggers: { page_load: 'yes', page_load_delay: 2 } },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PRO_POPUP_SET_TRIGGERS).parse(out);

    expect(wp.setPopupDisplay).toHaveBeenCalledTimes(1);
    expect(wp.setPopupDisplay.mock.calls[0]?.[0]).toBe(202);
    const body = wp.setPopupDisplay.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.triggers).toEqual({ page_load: 'yes', page_load_delay: 2 });
    // set_triggers must NOT send a timing sub-object.
    expect('timing' in body).toBe(false);
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);

    // saved → success; merged display_settings passes through.
    expect(out.success).toBe(true);
    expect(out.display_settings).toEqual(displayResp().display_settings);
  });

  it('maps a 422 VALIDATION_FAILED (target not a popup) to an isError carrying actual_type', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // The PHP route surfaces an open `actual_type` meta field for a target-not-a-popup (WP-R02). The
    // typed `ValidationFailedMeta` does not enumerate it, but `meta` is open at runtime (ErrorMeta), so
    // we cast the extra field on (the handler/`fromClientError` pass the whole meta through unchanged).
    const payload = makeErrorPayload(ErrorCodes.VALIDATION_FAILED, 'Target is not a popup.', {
      meta: {
        errors: [{ code: ErrorCodes.VALIDATION_FAILED, message: 'not a popup', prop: 'post_id' }],
        actual_type: 'page',
      } as ValidationFailedMeta,
    });
    wp.setPopupDisplay.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proPopupSetTriggersHandler({ post_id: 9, triggers: {} }, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.VALIDATION_FAILED);
    const meta = structured(result).meta as Record<string, unknown>;
    expect(meta.actual_type).toBe('page');
  });

  it('maps a 404 NOT_FOUND to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.NOT_FOUND, 'Popup not found.');
    wp.setPopupDisplay.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proPopupSetTriggersHandler({ post_id: 9999, triggers: {} }, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.NOT_FOUND);
  });
});

describe('proPopupSetTimingHandler', () => {
  function displayResp(): SetPopupDisplayResponse {
    return {
      saved: true,
      display_settings: {
        triggers: { page_load: 'yes' },
        timing: { page_views: 'yes', page_views_views: 3 },
      },
    };
  }

  it('sends ONLY {timing} to PUT /pro/popup/{id}/display and shapes {success,display_settings}', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.setPopupDisplay.mockResolvedValue(displayResp());
    const ctx = makeCtx(wp, registry);

    const result = await proPopupSetTimingHandler(
      { post_id: 202, timing: { page_views: 'yes', page_views_views: 3 } },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PRO_POPUP_SET_TIMING).parse(out);

    expect(wp.setPopupDisplay).toHaveBeenCalledTimes(1);
    expect(wp.setPopupDisplay.mock.calls[0]?.[0]).toBe(202);
    const body = wp.setPopupDisplay.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.timing).toEqual({ page_views: 'yes', page_views_views: 3 });
    // set_timing must NOT send a triggers sub-object.
    expect('triggers' in body).toBe(false);
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);

    expect(out.success).toBe(true);
    expect(out.display_settings).toEqual(displayResp().display_settings);
  });

  it('is idempotent — surfaces a replay informationally', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.setPopupDisplay.mockResolvedValue({ ...displayResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry);

    const result = await proPopupSetTimingHandler({ post_id: 202, timing: {} }, ctx);
    expect(firstText(result).toLowerCase()).toContain('replay');
  });

  it('maps a 501 PRO_REQUIRED to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Pro inactive.');
    wp.setPopupDisplay.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proPopupSetTimingHandler({ post_id: 202, timing: {} }, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });
});
