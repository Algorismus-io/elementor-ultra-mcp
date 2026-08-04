/**
 * WP-R07 — Pro theme-builder handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + a real WP-F04 {@link ToolRegistry}.
 * The tests assert:
 *  - all three §1.8 handlers attach by EXACT catalog name; they are NON-★; annotations match the catalog;
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`;
 *  - the descriptor `inputSchema` rejects `type='single'` and a bad `ConditionTuple` `type`, and accepts
 *    2-, 3-, and 4-element tuples (the §1.8 `ConditionTuple = z.tuple([…]).rest(z.string())` arities);
 *  - `create` proxies `POST /pro/theme` and shapes `{post_id,edit_url,template_type,location,
 *    conditions_stored}`, sends a deterministic `op_id`, and short-circuits a `section`-without-`location`
 *    to a `VALIDATION_FAILED` isError BEFORE any REST call;
 *  - `set_conditions` with `[]` clears, surfaces `conflicts` when `check_conflicts:true`, and is idempotent;
 *  - `get_conditions_config` returns `{tree,locations}` and surfaces `id_bearing` in the text;
 *  - a `surface:'isError'` {@link WpClientError} (501 `PRO_REQUIRED`, 422, 403) renders an isError taxonomy
 *    result (never a -326xx protocol throw); a `surface:'protocol'` payload THROWS a {@link ProtocolError};
 *    a non-client error rethrows (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type CreateThemeDocResponse,
  type SetThemeConditionsResponse,
  type ConditionsConfigResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../../catalog/registry.js';
import type { ToolContext } from '../../runtime/context.js';
import { WpClientError } from '../../wp/types.js';
import { ProtocolError } from '../../wp/errors.js';
import { OP_ID_PATTERN } from '../../safety/idempotency.js';

import {
  attachThemeHandlers,
  proThemeCreateHandler,
  proThemeSetConditionsHandler,
  proThemeGetConditionsConfigHandler,
  PRO_THEME_TOOL_NAMES,
  PRO_THEME_CREATE,
  PRO_THEME_SET_CONDITIONS,
  PRO_THEME_GET_CONDITIONS_CONFIG,
} from './theme.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the Pro theme routes the handlers call. */
interface MockWp {
  createThemeDoc: ReturnType<typeof vi.fn>;
  setThemeConditions: ReturnType<typeof vi.fn>;
  getConditionsConfig: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    createThemeDoc: vi.fn(),
    setThemeConditions: vi.fn(),
    getConditionsConfig: vi.fn(),
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

describe('attachThemeHandlers', () => {
  it('attaches a handler for every §1.8 Pro theme tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachThemeHandlers(registry);

    for (const name of PRO_THEME_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the three §1.8 Pro theme names', () => {
    expect([...PRO_THEME_TOOL_NAMES].sort()).toEqual(
      [PRO_THEME_CREATE, PRO_THEME_SET_CONDITIONS, PRO_THEME_GET_CONDITIONS_CONFIG].sort(),
    );
  });

  it('all three Pro theme tools are NON-★ (Contract 13 §5.2 — registered disabled at boot)', () => {
    const registry = createToolRegistry();
    for (const name of PRO_THEME_TOOL_NAMES) {
      expect(registry.getDescriptor(name).star).toBe(false);
    }
  });

  it('annotations match the frozen catalog (create none; set_conditions idempotent; config readOnly+idempotent)', () => {
    const registry = createToolRegistry();
    expect(registry.getDescriptor(PRO_THEME_CREATE).annotations).toEqual({});
    const setc = registry.getDescriptor(PRO_THEME_SET_CONDITIONS).annotations as Record<
      string,
      boolean
    >;
    expect(setc.idempotentHint).toBe(true);
    const cfg = registry.getDescriptor(PRO_THEME_GET_CONDITIONS_CONFIG).annotations as Record<
      string,
      boolean
    >;
    expect(cfg.readOnlyHint).toBe(true);
    expect(cfg.idempotentHint).toBe(true);
  });
});

/* ───────────────────────────── inputSchema: enum + ConditionTuple arities (§1.8) ────────────── */

describe('elementor.pro.theme.create inputSchema (frozen §1.8)', () => {
  it("rejects type='single' (not in the 8-type enum → -32602 at the SDK layer)", () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_THEME_CREATE).safeParse({
      type: 'single',
      title: 'X',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts each of the 8 valid types', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_THEME_CREATE);
    for (const type of [
      'header',
      'footer',
      'single-post',
      'single-page',
      'archive',
      'search-results',
      'error-404',
      'section',
    ]) {
      expect(v.safeParse({ type, title: 'X' }).success).toBe(true);
    }
  });

  it('accepts ConditionTuple 2-, 3-, and 4-element arities', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_THEME_CREATE);
    expect(
      v.safeParse({
        type: 'archive',
        title: 'X',
        conditions: [
          ['include', 'general'],
          ['exclude', 'singular', 'post'],
          ['include', 'singular', 'post', '42'],
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects a ConditionTuple whose type is outside include|exclude (→ -32602)', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_THEME_CREATE);
    expect(
      v.safeParse({ type: 'archive', title: 'X', conditions: [['maybe', 'general']] }).success,
    ).toBe(false);
  });
});

/* ───────────────────────────── elementor.pro.theme.create (§1.8 / §8.1) ─────────────────────── */

describe('proThemeCreateHandler', () => {
  function createResp(): CreateThemeDocResponse {
    return {
      post_id: 101,
      edit_url: 'http://localhost:8899/wp-admin/post.php?post=101&action=elementor',
      template_type: 'header',
      location: null,
      conditions_stored: ['include/general'],
    };
  }

  it('proxies POST /pro/theme, shapes the §1.8 output, sends a valid op_id, validates against the descriptor', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createThemeDoc.mockResolvedValue(createResp());
    const ctx = makeCtx(wp, registry);

    const result = await proThemeCreateHandler(
      {
        type: 'header',
        title: 'Main Header',
        status: 'publish',
        conditions: [['include', 'general']],
      },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, PRO_THEME_CREATE).parse(out);

    expect(wp.createThemeDoc).toHaveBeenCalledTimes(1);
    const body = wp.createThemeDoc.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.type).toBe('header');
    expect(body.title).toBe('Main Header');
    expect(body.status).toBe('publish');
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);
    expect(body.conditions).toEqual([['include', 'general']]);

    expect(out).toEqual({
      post_id: 101,
      edit_url: createResp().edit_url,
      template_type: 'header',
      location: null,
      conditions_stored: ['include/general'],
    });
  });

  it('short-circuits a section doc WITHOUT location to a VALIDATION_FAILED isError BEFORE any REST call', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await proThemeCreateHandler(
      { type: 'section', title: 'Reusable', status: 'draft' },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(firstText(result)).toContain('location');
    // The cheap guard must NOT hit the REST layer.
    expect(wp.createThemeDoc).not.toHaveBeenCalled();
  });

  it('proxies a section doc WITH a location (passes the location through)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createThemeDoc.mockResolvedValue({
      ...createResp(),
      template_type: 'section',
      location: 'header',
    });
    const ctx = makeCtx(wp, registry);

    const result = await proThemeCreateHandler(
      { type: 'section', title: 'Reusable', status: 'draft', location: 'header' },
      ctx,
    );
    outputValidator(registry, PRO_THEME_CREATE).parse(structured(result));
    expect(wp.createThemeDoc).toHaveBeenCalledTimes(1);
    expect((wp.createThemeDoc.mock.calls[0]?.[0] as Record<string, unknown>).location).toBe(
      'header',
    );
  });

  it('surfaces an idempotent replay informationally in the text', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createThemeDoc.mockResolvedValue({ ...createResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry);

    const result = await proThemeCreateHandler(
      { type: 'header', title: 'H', status: 'publish' },
      ctx,
    );
    expect(firstText(result).toLowerCase()).toContain('replay');
  });

  it('maps a 501 PRO_REQUIRED WpClientError to an isError result (never a -326xx)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.', {
      meta: { feature: 'theme-builder' },
    });
    wp.createThemeDoc.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proThemeCreateHandler(
      { type: 'header', title: 'H', status: 'publish' },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });

  it('maps a 422 VALIDATION_FAILED WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.VALIDATION_FAILED, 'Invalid section location.', {
      meta: {
        errors: [
          {
            code: ErrorCodes.VALIDATION_FAILED,
            message: 'unknown location',
            prop: 'location',
          },
        ],
      },
    });
    wp.createThemeDoc.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proThemeCreateHandler(
      { type: 'section', title: 'S', status: 'draft', location: 'nope' },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.VALIDATION_FAILED);
  });

  it('THROWS a ProtocolError for a surface:protocol payload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params');
    wp.createThemeDoc.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    await expect(
      proThemeCreateHandler({ type: 'header', title: 'H', status: 'publish' }, ctx),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('rethrows a non-WpClientError (server core surfaces it)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.createThemeDoc.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(
      proThemeCreateHandler({ type: 'header', title: 'H', status: 'publish' }, ctx),
    ).rejects.toThrow('boom');
  });
});

/* ───────────────────────────── elementor.pro.theme.set_conditions (§1.8 / §8.2) ─────────────── */

describe('proThemeSetConditionsHandler', () => {
  function setResp(overrides?: Partial<SetThemeConditionsResponse>): SetThemeConditionsResponse {
    return {
      saved: true,
      conditions_stored: ['include/general'],
      conflicts: [],
      ...overrides,
    };
  }

  it('proxies PUT /pro/theme/{id}/conditions, shapes the output, sends a valid op_id', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.setThemeConditions.mockResolvedValue(setResp());
    const ctx = makeCtx(wp, registry);

    const result = await proThemeSetConditionsHandler(
      { post_id: 101, conditions: [['include', 'general']], check_conflicts: false },
      ctx,
    );
    outputValidator(registry, PRO_THEME_SET_CONDITIONS).parse(structured(result));

    expect(wp.setThemeConditions).toHaveBeenCalledTimes(1);
    expect(wp.setThemeConditions.mock.calls[0]?.[0]).toBe(101);
    const body = wp.setThemeConditions.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.conditions).toEqual([['include', 'general']]);
    expect(body.check_conflicts).toBe(false);
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);
    // No conflicts → `conflicts` omitted from structured content.
    expect(structured(result).conflicts).toBeUndefined();
  });

  it('clears all conditions when passed [] (passes [] straight through)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.setThemeConditions.mockResolvedValue(setResp({ conditions_stored: [] }));
    const ctx = makeCtx(wp, registry);

    const result = await proThemeSetConditionsHandler(
      { post_id: 101, conditions: [], check_conflicts: false },
      ctx,
    );
    outputValidator(registry, PRO_THEME_SET_CONDITIONS).parse(structured(result));
    expect(
      (wp.setThemeConditions.mock.calls[0]?.[1] as Record<string, unknown>).conditions,
    ).toEqual([]);
    expect(firstText(result).toLowerCase()).toContain('cleared');
  });

  it('surfaces conflicts in BOTH the text and structured content when check_conflicts:true', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.setThemeConditions.mockResolvedValue(
      setResp({
        saved: false,
        conflicts: [
          {
            template_id: 7,
            template_title: 'Existing Header',
            edit_url: 'http://localhost:8899/edit/7',
          },
        ],
      }),
    );
    const ctx = makeCtx(wp, registry);

    const result = await proThemeSetConditionsHandler(
      { post_id: 101, conditions: [['include', 'general']], check_conflicts: true },
      ctx,
    );
    outputValidator(registry, PRO_THEME_SET_CONDITIONS).parse(structured(result));

    const conflicts = structured(result).conflicts as Array<Record<string, unknown>>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.template_id).toBe(7);
    expect(firstText(result)).toContain('Existing Header');
  });

  it('maps a 403 CAPABILITY_MISSING WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.CAPABILITY_MISSING, 'Missing capability.');
    wp.setThemeConditions.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proThemeSetConditionsHandler(
      { post_id: 101, conditions: [], check_conflicts: false },
      ctx,
    );
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.CAPABILITY_MISSING);
  });
});

/* ───────────────────────────── elementor.pro.theme.get_conditions_config (§1.8 / §8.3) ──────── */

describe('proThemeGetConditionsConfigHandler', () => {
  it('returns {tree,locations} unchanged and surfaces id_bearing in the text', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // The live R01 route returns {tree,id_bearing,locations}; the shared type narrows to {tree,id_bearing}.
    const resp = {
      tree: { general: { label: 'Entire site', sub_conditions: ['archive', 'singular'] } },
      id_bearing: ['post', 'taxonomy', 'author'],
      locations: ['header', 'footer', 'single', 'archive'],
    } as unknown as ConditionsConfigResponse;
    wp.getConditionsConfig.mockResolvedValue(resp);
    const ctx = makeCtx(wp, registry);

    const result = await proThemeGetConditionsConfigHandler({}, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_THEME_GET_CONDITIONS_CONFIG).parse(out);

    expect(out.tree).toEqual({
      general: { label: 'Entire site', sub_conditions: ['archive', 'singular'] },
    });
    expect(out.locations).toEqual(['header', 'footer', 'single', 'archive']);
    // id_bearing is surfaced in the text (not part of the frozen outputSchema).
    expect(firstText(result)).toContain('post');
    expect(firstText(result)).toContain('taxonomy');
  });

  it('tolerates a response without locations (defaults to []) — outputSchema still validates', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const noLocations: ConditionsConfigResponse = { tree: {}, id_bearing: [] };
    wp.getConditionsConfig.mockResolvedValue(noLocations);
    const ctx = makeCtx(wp, registry);

    const result = await proThemeGetConditionsConfigHandler({}, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_THEME_GET_CONDITIONS_CONFIG).parse(out);
    expect(out.locations).toEqual([]);
  });

  it('maps a 501 EXPERIMENT_INACTIVE WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.EXPERIMENT_INACTIVE, 'Experiment inactive.');
    wp.getConditionsConfig.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proThemeGetConditionsConfigHandler({}, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.EXPERIMENT_INACTIVE);
  });
});
