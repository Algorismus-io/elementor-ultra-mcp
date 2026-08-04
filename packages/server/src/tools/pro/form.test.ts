/**
 * WP-R09 — Pro Forms handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: mock `ctx.wp` (the WP-F02 bound facade) + a real WP-F04 {@link ToolRegistry}.
 * The tests assert:
 *  - both §1.8 handlers attach by EXACT catalog name; they are NON-★; annotations match the catalog;
 *  - each handler's `structuredContent` validates against the WP-F04 descriptor `outputSchema`;
 *  - the descriptor `inputSchema` accepts a boolean `fields[].required` and an `actions` `.passthrough()`
 *    extra setting, REJECTS a non-boolean `required` and an `actions[].type` outside the 12-action enum,
 *    and REQUIRES `base_hash` (the §1.8 surgical-write contract);
 *  - `build` proxies `POST /pro/form/build`, passes the ergonomic spec through UNTOUCHED (no
 *    `required→"true"` pre-conversion in TS), sends a deterministic `op_id`, synthesizes a frozen `Diff`
 *    (one `added` change for the emitted widget), and surfaces PHP `warnings` in BOTH the text AND the
 *    structured content;
 *  - `list_actions` returns the registered-action set UNCHANGED;
 *  - a `surface:'isError'` {@link WpClientError} (501 `PRO_REQUIRED`, 409 `CONCURRENCY_STALE_HASH`, 422
 *    `VALIDATION_FAILED`) renders an isError taxonomy result (never a -326xx protocol throw); a
 *    `surface:'protocol'` payload THROWS a {@link ProtocolError}; a non-client error rethrows
 *    (12-error-taxonomy.md §5).
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import {
  ErrorCodes,
  makeErrorPayload,
  type BuildFormResponse,
  type ListFormActionsResponse,
} from '@elementor-ultra/shared';

import { createToolRegistry, type ToolRegistry } from '../../catalog/registry.js';
import type { ToolContext } from '../../runtime/context.js';
import { WpClientError } from '../../wp/types.js';
import { ProtocolError } from '../../wp/errors.js';
import { OP_ID_PATTERN } from '../../safety/idempotency.js';

import {
  attachFormHandlers,
  proFormBuildHandler,
  proFormListActionsHandler,
  PRO_FORM_TOOL_NAMES,
  PRO_FORM_BUILD,
  PRO_FORM_LIST_ACTIONS,
} from './form.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** The shape of the partial `ctx.wp` we mock — only the Pro Forms routes the handlers call. */
interface MockWp {
  buildForm: ReturnType<typeof vi.fn>;
  listFormActions: ReturnType<typeof vi.fn>;
}

/** Empty mock `wp` (each test wires only the routes it needs). */
function makeWp(): MockWp {
  return {
    buildForm: vi.fn(),
    listFormActions: vi.fn(),
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

/** A 32-char lowercase-hex base_hash (the frozen Diff watermark constraint). */
const HASH_BEFORE = 'a'.repeat(32);
const HASH_AFTER = 'b'.repeat(32);

/** A minimal valid `build` arg set (one text field + one email action + a base_hash). */
function buildArgs(): Record<string, unknown> {
  return {
    container_id: 'cont123',
    post_id: 42,
    form_name: 'Contact Us',
    button_text: 'Send',
    fields: [{ type: 'text', id: 'name', label: 'Name', required: true, width: '100' }],
    actions: [{ type: 'email', email_to: 'owner@example.com' }],
    base_hash: HASH_BEFORE,
  };
}

/** A `build` REST response that persisted a `form` widget (`applied:true`). */
function buildResp(overrides?: Partial<BuildFormResponse>): BuildFormResponse {
  return {
    element: { id: 'wgt001', elType: 'widget', widgetType: 'form', settings: {} },
    applied: true,
    base_hash: HASH_AFTER,
    warnings: [],
    ...overrides,
  };
}

/* ───────────────────────────── attachment (Acceptance) ─────────────────────────────────────── */

describe('attachFormHandlers', () => {
  it('attaches a handler for every §1.8 Pro Forms tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachFormHandlers(registry);

    for (const name of PRO_FORM_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      // Every name we attach must exist in the frozen catalog (exact-name match).
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the two §1.8 Pro Forms names', () => {
    expect([...PRO_FORM_TOOL_NAMES].sort()).toEqual([PRO_FORM_BUILD, PRO_FORM_LIST_ACTIONS].sort());
  });

  it('both Pro Forms tools are NON-★ (registered disabled at boot, enabled via tools.search)', () => {
    const registry = createToolRegistry();
    for (const name of PRO_FORM_TOOL_NAMES) {
      expect(registry.getDescriptor(name).star).toBe(false);
    }
  });

  it('annotations match the frozen catalog (build none; list_actions readOnly+idempotent)', () => {
    const registry = createToolRegistry();
    expect(registry.getDescriptor(PRO_FORM_BUILD).annotations).toEqual({});
    const la = registry.getDescriptor(PRO_FORM_LIST_ACTIONS).annotations as Record<string, boolean>;
    expect(la.readOnlyHint).toBe(true);
    expect(la.idempotentHint).toBe(true);
  });
});

/* ───────────────────────────── inputSchema: boolean required, enum, passthrough, base_hash ──── */

describe('elementor.pro.form.build inputSchema (frozen §1.8)', () => {
  it('accepts a boolean fields[].required (NOT a string)', () => {
    const registry = createToolRegistry();
    const parsed = inputValidator(registry, PRO_FORM_BUILD).safeParse(buildArgs());
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-boolean fields[].required (→ -32602 at the SDK layer)', () => {
    const registry = createToolRegistry();
    const args = buildArgs();
    (args.fields as Array<Record<string, unknown>>)[0]!.required = 'true';
    const parsed = inputValidator(registry, PRO_FORM_BUILD).safeParse(args);
    expect(parsed.success).toBe(false);
  });

  it('accepts each of the 12 registered action types', () => {
    const registry = createToolRegistry();
    const v = inputValidator(registry, PRO_FORM_BUILD);
    for (const type of [
      'email',
      'email2',
      'redirect',
      'webhook',
      'mailchimp',
      'drip',
      'activecampaign',
      'getresponse',
      'convertkit',
      'mailerlite',
      'slack',
      'discord',
    ]) {
      const args = { ...buildArgs(), actions: [{ type }] };
      expect(v.safeParse(args).success).toBe(true);
    }
  });

  it('rejects an actions[].type outside the enum (→ -32602)', () => {
    const registry = createToolRegistry();
    const args = { ...buildArgs(), actions: [{ type: 'carrier-pigeon' }] };
    expect(inputValidator(registry, PRO_FORM_BUILD).safeParse(args).success).toBe(false);
  });

  it('passes through action-specific settings via .passthrough()', () => {
    const registry = createToolRegistry();
    const args = {
      ...buildArgs(),
      actions: [{ type: 'redirect', redirect_to: 'https://example.com/thanks' }],
    };
    const parsed = inputValidator(registry, PRO_FORM_BUILD).safeParse(args);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const action = (parsed.data.actions as Array<Record<string, unknown>>)[0];
      expect(action?.redirect_to).toBe('https://example.com/thanks');
    }
  });

  it('REQUIRES base_hash (the surgical-write contract §0.8)', () => {
    const registry = createToolRegistry();
    const args = buildArgs();
    delete args.base_hash;
    expect(inputValidator(registry, PRO_FORM_BUILD).safeParse(args).success).toBe(false);
  });
});

/* ───────────────────────────── elementor.pro.form.build (§1.8 / §8.5) ───────────────────────── */

describe('proFormBuildHandler', () => {
  it('proxies POST /pro/form/build, shapes the §1.8 output, sends a valid op_id, validates against the descriptor', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.buildForm.mockResolvedValue(buildResp());
    const ctx = makeCtx(wp, registry);

    const result = await proFormBuildHandler(buildArgs() as never, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_FORM_BUILD).parse(out);

    expect(wp.buildForm).toHaveBeenCalledTimes(1);
    const body = wp.buildForm.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.container_id).toBe('cont123');
    expect(body.post_id).toBe(42);
    expect(body.base_hash).toBe(HASH_BEFORE);
    expect(OP_ID_PATTERN.test(body.op_id as string)).toBe(true);

    // Output shape: {element, diff, warnings, base_hash}.
    expect(out.element).toEqual(buildResp().element);
    expect(out.base_hash).toBe(HASH_AFTER);
    expect(out.warnings).toEqual([]);
    // Diff synthesized: ONE `added` change for the emitted widget.
    const diff = out.diff as { changes: Array<{ id: string; op: string }> };
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ id: 'wgt001', op: 'added' });
  });

  it('passes the ergonomic field/action spec through UNTOUCHED (no required→"true" in TS)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.buildForm.mockResolvedValue(buildResp());
    const ctx = makeCtx(wp, registry);

    await proFormBuildHandler(buildArgs() as never, ctx);
    const body = wp.buildForm.mock.calls[0]?.[0] as Record<string, unknown>;
    const fields = body.fields as Array<Record<string, unknown>>;
    // `required` is the BOOLEAN the agent supplied — NOT pre-converted to the string "true".
    expect(fields[0]?.required).toBe(true);
    expect(fields[0]?.id).toBe('name'); // not pre-mapped to custom_id.
    const actions = body.actions as Array<Record<string, unknown>>;
    expect(actions[0]?.email_to).toBe('owner@example.com'); // passthrough setting preserved.
  });

  it('surfaces PHP warnings (unregistered action / atomic fallback) in BOTH the text AND structured content', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.buildForm.mockResolvedValue(
      buildResp({
        warnings: [
          "action 'mailchimp' not registered (license)",
          'atomic e-form unavailable; built classic form widget',
        ],
      }),
    );
    const ctx = makeCtx(wp, registry);

    const result = await proFormBuildHandler(
      {
        ...buildArgs(),
        actions: [{ type: 'email' }, { type: 'mailchimp' }],
      } as never,
      ctx,
    );
    outputValidator(registry, PRO_FORM_BUILD).parse(structured(result));

    const warnings = structured(result).warnings as string[];
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('mailchimp');
    // Warnings also echoed in the human-readable text.
    expect(firstText(result)).toContain('mailchimp');
    expect(firstText(result)).toContain('classic form widget');
  });

  it('emits an empty diff when the route did not persist (applied:false)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // The route returned just {element} (no persist) — no base_hash, no diff.
    wp.buildForm.mockResolvedValue({
      element: buildResp().element,
      applied: false,
      warnings: [],
    });
    const ctx = makeCtx(wp, registry);

    const result = await proFormBuildHandler(buildArgs() as never, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_FORM_BUILD).parse(out);
    const diff = out.diff as { changes: unknown[] };
    expect(diff.changes).toHaveLength(0);
    // base_hash echoes the request hash when the route did not return a new one.
    expect(out.base_hash).toBe(HASH_BEFORE);
  });

  it('surfaces an idempotent replay informationally in the text', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.buildForm.mockResolvedValue({ ...buildResp(), idempotent_replay: true });
    const ctx = makeCtx(wp, registry);

    const result = await proFormBuildHandler(buildArgs() as never, ctx);
    expect(firstText(result).toLowerCase()).toContain('replay');
  });

  it('maps a 501 PRO_REQUIRED WpClientError to an isError result (never a -326xx)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.', {
      meta: { feature: 'forms' },
    });
    wp.buildForm.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proFormBuildHandler(buildArgs() as never, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });

  it('maps a 409 CONCURRENCY_STALE_HASH WpClientError to a retryable isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.CONCURRENCY_STALE_HASH, 'base_hash is stale.', {
      meta: { post_id: 42, expected_hash: HASH_BEFORE, actual_hash: HASH_AFTER },
    });
    wp.buildForm.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proFormBuildHandler(buildArgs() as never, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.CONCURRENCY_STALE_HASH);
    expect(structured(result).retryable).toBe(true);
  });

  it('maps a 422 VALIDATION_FAILED WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.VALIDATION_FAILED, 'Invalid field type.', {
      meta: {
        errors: [
          { code: ErrorCodes.VALIDATION_FAILED, message: 'unknown field type', prop: 'fields' },
        ],
      },
    });
    wp.buildForm.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proFormBuildHandler(buildArgs() as never, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.VALIDATION_FAILED);
  });

  it('THROWS a ProtocolError for a surface:protocol payload', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.SCHEMA_INVALID_PARAMS, 'bad params');
    wp.buildForm.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    await expect(proFormBuildHandler(buildArgs() as never, ctx)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it('rethrows a non-WpClientError (server core surfaces it)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.buildForm.mockRejectedValue(new Error('boom'));
    const ctx = makeCtx(wp, registry);

    await expect(proFormBuildHandler(buildArgs() as never, ctx)).rejects.toThrow('boom');
  });
});

/* ───────────────────────────── elementor.pro.form.list_actions (§1.8 / §8.5) ────────────────── */

describe('proFormListActionsHandler', () => {
  function actionsResp(): ListFormActionsResponse {
    return {
      actions: [
        { name: 'email', label: 'Email', settings_controls: ['email_to', 'email_subject'] },
        { name: 'redirect', label: 'Redirect', settings_controls: ['redirect_to'] },
      ],
    };
  }

  it('returns the registered-action set UNCHANGED and validates against the descriptor', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listFormActions.mockResolvedValue(actionsResp());
    const ctx = makeCtx(wp, registry);

    const result = await proFormListActionsHandler({}, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_FORM_LIST_ACTIONS).parse(out);

    expect(wp.listFormActions).toHaveBeenCalledTimes(1);
    expect(out.actions).toEqual(actionsResp().actions);
    expect(firstText(result)).toContain('email');
    expect(firstText(result)).toContain('redirect');
  });

  it('tolerates an empty action set (free/unlicensed install) — outputSchema still validates', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp.listFormActions.mockResolvedValue({ actions: [] });
    const ctx = makeCtx(wp, registry);

    const result = await proFormListActionsHandler({}, ctx);
    const out = structured(result);
    outputValidator(registry, PRO_FORM_LIST_ACTIONS).parse(out);
    expect(out.actions).toEqual([]);
  });

  it('maps a 501 PRO_REQUIRED WpClientError to an isError result', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const payload = makeErrorPayload(ErrorCodes.PRO_REQUIRED, 'Elementor Pro is not active.');
    wp.listFormActions.mockRejectedValue(new WpClientError(payload));
    const ctx = makeCtx(wp, registry);

    const result = await proFormListActionsHandler({}, ctx);
    expect(isErrorResult(result)).toBe(true);
    expect(structured(result).code).toBe(ErrorCodes.PRO_REQUIRED);
  });
});
