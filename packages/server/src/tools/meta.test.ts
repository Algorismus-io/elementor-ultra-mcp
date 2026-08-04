/**
 * WP-T11 — meta-trio handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress: a real WP-F04 {@link ToolRegistry} + a stub `ctx` (no `wp` needed for the
 * TS-only meta-trio). The tests assert:
 *  - all three §1.11 handlers attach by EXACT catalog name + are flagged `meta:true` (always-on),
 *  - `list_endpoints` enumerates EVERY tool INCLUDING disabled ones, reports live `enabled`, filters by
 *    `prefix`, and paginates (§0.6); its `structuredContent` validates against the descriptor schema,
 *  - `get_schema` returns the TARGET tool's `{name,inputSchema,outputSchema,annotations}`; unknown ⇒
 *    a clean isError,
 *  - `invoke` dispatches a DISABLED tool ONE-SHOT WITHOUT enabling it (no `surface.enable`), validates
 *    `arguments` against the TARGET `inputSchema` (→ `-32602` on mismatch), mirrors a destructive
 *    target's confirm gating (the target's own elicitation fires), and wraps the result as
 *    `{result,isError}`.
 */

import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext, ToolHandler } from '../runtime/context.js';
import { ProtocolError } from '../wp/errors.js';

import {
  attachMetaHandlers,
  getSchemaHandler,
  invokeHandler,
  listEndpointsHandler,
  META_TOOL_NAMES,
  TOOLS_LIST_ENDPOINTS,
  TOOLS_GET_SCHEMA,
  TOOLS_INVOKE,
} from './meta.js';

/* ───────────────────────────── shared test helpers ─────────────────────────────────────────── */

/** A spying surface stub — `enable` MUST NOT be called by the one-shot `tools.invoke` path (§5.3). */
interface MockSurface {
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
  isEnabled: ReturnType<typeof vi.fn>;
}

function makeSurface(): MockSurface {
  return { enable: vi.fn(), disable: vi.fn(), isEnabled: vi.fn(() => false) };
}

/** Build a minimal {@link ToolContext} carrying the real registry, a spying surface, + scripted elicit. */
function makeCtx(
  registry: ToolRegistry,
  surface: MockSurface,
  elicit: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve({ confirmed: false })),
): ToolContext {
  return {
    wp: {} as ToolContext['wp'],
    registry,
    surface: surface as unknown as ToolContext['surface'],
    capabilities: {} as ToolContext['capabilities'],
    elicit: elicit,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

/** The descriptor `outputSchema` (ZodRawShape) for a tool, wrapped as a `z.object` validator. */
function outputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).outputSchema);
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** Pick a non-meta tool that is DISABLED in the lean profile (an advanced long-tail tool). */
function aDisabledTool(registry: ToolRegistry): string {
  registry.applyProfile('lean');
  const disabled = registry.listDisabled().find((n) => !registry.getDescriptor(n).meta);
  if (disabled === undefined) {
    throw new Error('expected at least one disabled non-meta tool in the lean profile');
  }
  return disabled;
}

/**
 * Pick a DISABLED non-meta tool whose `inputSchema` accepts an empty `{}` payload, so an invoke with
 * `arguments:{}` passes the target's schema validation and reaches the (fake) handler. Used by the
 * one-shot / error-wrap invoke tests which care about DISPATCH, not arg shaping.
 */
function aDisabledToolAcceptingEmptyArgs(registry: ToolRegistry): string {
  registry.applyProfile('lean');
  const match = registry
    .listDisabled()
    .filter((n) => !registry.getDescriptor(n).meta)
    .find((n) => z.object(registry.getDescriptor(n).inputSchema).safeParse({}).success);
  if (match === undefined) {
    throw new Error('expected a disabled non-meta tool whose schema accepts empty args');
  }
  return match;
}

/* ───────────────────────────── attachment + always-on (Acceptance) ─────────────────────────── */

describe('attachMetaHandlers', () => {
  it('attaches a handler for every §1.11 meta tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachMetaHandlers(registry);
    for (const name of META_TOOL_NAMES) {
      expect(registry.has(name)).toBe(true);
      expect(registry.hasHandler(name)).toBe(true);
    }
  });

  it('owns exactly the three §1.11 names', () => {
    expect([...META_TOOL_NAMES].sort()).toEqual(
      [TOOLS_LIST_ENDPOINTS, TOOLS_GET_SCHEMA, TOOLS_INVOKE].sort(),
    );
  });

  it('the meta-trio is flagged meta:true and stays enabled under the lean profile (§5.2/§6)', () => {
    const registry = createToolRegistry();
    registry.applyProfile('lean');
    for (const name of META_TOOL_NAMES) {
      expect(registry.getDescriptor(name).meta).toBe(true);
      expect(registry.isEnabled(name)).toBe(true);
    }
  });

  it('attaching never disables a tool (only attaches handlers)', () => {
    const registry = createToolRegistry();
    registry.applyProfile('lean');
    const disabledBefore = registry.listDisabled().length;
    attachMetaHandlers(registry);
    expect(registry.listDisabled().length).toBe(disabledBefore);
  });
});

/* ───────────────────────────── elementor.tools.list_endpoints (§1.11) ─────────────────────── */

describe('listEndpointsHandler', () => {
  it('enumerates EVERY tool incl. disabled, reports live enabled, validates against the schema', async () => {
    const registry = createToolRegistry();
    registry.applyProfile('lean'); // most tools disabled, ★ + meta enabled.
    const surface = makeSurface();
    const ctx = makeCtx(registry, surface);

    const result = await listEndpointsHandler({ limit: 200 }, ctx);
    const out = structured(result);
    outputValidator(registry, TOOLS_LIST_ENDPOINTS).parse(out);

    const items = out['items'] as Array<{ name: string; enabled: boolean }>;
    const names = items.map((i) => i.name);
    // A disabled long-tail tool IS present, marked enabled:false.
    const disabled = aDisabledTool(registry);
    const row = items.find((i) => i.name === disabled);
    expect(row).toBeDefined();
    expect(row?.enabled).toBe(false);
    // The always-on meta-trio is present + enabled.
    expect(names).toContain(TOOLS_INVOKE);
    expect(items.find((i) => i.name === TOOLS_INVOKE)?.enabled).toBe(true);
    // total covers the WHOLE catalog (incl. disabled).
    expect(out['total']).toBe(registry.listDescriptors().length);
  });

  it('filters by prefix and paginates via {limit,cursor}', async () => {
    const registry = createToolRegistry();
    const surface = makeSurface();
    const ctx = makeCtx(registry, surface);

    const page1 = await listEndpointsHandler({ prefix: 'elementor.tools.', limit: 2 }, ctx);
    const out1 = structured(page1);
    outputValidator(registry, TOOLS_LIST_ENDPOINTS).parse(out1);
    const items1 = out1['items'] as Array<{ name: string }>;
    expect(items1.every((i) => i.name.startsWith('elementor.tools.'))).toBe(true);
    expect(items1.length).toBeLessThanOrEqual(2);

    if (out1['next_cursor'] !== null) {
      const page2 = await listEndpointsHandler(
        { prefix: 'elementor.tools.', limit: 2, cursor: out1['next_cursor'] as string },
        ctx,
      );
      const items2 = (structured(page2)['items'] as Array<{ name: string }>).map((i) => i.name);
      // No overlap between page 1 and page 2.
      expect(items2.some((n) => items1.map((i) => i.name).includes(n))).toBe(false);
    }
  });
});

/* ───────────────────────────── elementor.tools.get_schema (§1.11) ─────────────────────────── */

describe('getSchemaHandler', () => {
  it("returns the TARGET tool's input/output schema + annotations", async () => {
    const registry = createToolRegistry();
    const surface = makeSurface();
    const ctx = makeCtx(registry, surface);

    const target = 'elementor.batch.apply';
    const result = await getSchemaHandler({ name: target }, ctx);
    const out = structured(result);
    outputValidator(registry, TOOLS_GET_SCHEMA).parse(out);

    expect(out['name']).toBe(target);
    expect(out['inputSchema']).toBe(registry.getDescriptor(target).inputSchema);
    expect(out['outputSchema']).toBe(registry.getDescriptor(target).outputSchema);
    expect(out['annotations']).toBe(registry.getDescriptor(target).annotations);
  });

  it('returns a clean isError result for an unknown tool name', async () => {
    const registry = createToolRegistry();
    const ctx = makeCtx(registry, makeSurface());

    const result = await getSchemaHandler({ name: 'elementor.does.not.exist' }, ctx);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code?: string }).code).toBe('VALIDATION_FAILED');
  });
});

/* ───────────────────────────── elementor.tools.invoke (§1.11 / §5.3) ──────────────────────── */

describe('invokeHandler', () => {
  it('dispatches a DISABLED tool one-shot WITHOUT enabling it (no surface.enable)', async () => {
    const registry = createToolRegistry();
    const disabled = aDisabledToolAcceptingEmptyArgs(registry); // lean profile; target disabled.
    expect(registry.isEnabled(disabled)).toBe(false);

    // Attach a fake handler to the disabled tool that ACCEPTS any args (loose schema tools allow this).
    const targetHandler = vi.fn<ToolHandler>(() =>
      Promise.resolve({
        content: [{ type: 'text', text: 'ran' }],
        structuredContent: { ok: true },
      }),
    );
    registry.attachHandler(
      disabled,
      targetHandler as unknown as (a: Record<string, unknown>) => unknown,
    );

    const surface = makeSurface();
    const ctx = makeCtx(registry, surface);

    const result = await invokeHandler({ name: disabled, arguments: {} }, ctx);
    const out = structured(result);
    z.object(registry.getDescriptor(TOOLS_INVOKE).outputSchema).parse(out);

    // The target handler ran with the SAME ctx, but the tool was NOT persistently enabled.
    expect(targetHandler).toHaveBeenCalledTimes(1);
    expect(targetHandler.mock.calls[0]?.[1]).toBe(ctx);
    expect(surface.enable).not.toHaveBeenCalled();
    expect(registry.isEnabled(disabled)).toBe(false); // still disabled after a one-shot invoke (§5.3).
    expect(out['isError']).toBe(false);
  });

  it('validates `arguments` against the TARGET inputSchema → throws -32602 on mismatch', async () => {
    const registry = createToolRegistry();
    const ctx = makeCtx(registry, makeSurface());
    // get_schema requires `name: z.string()`; passing a number violates the target schema.
    await expect(
      invokeHandler({ name: TOOLS_GET_SCHEMA, arguments: { name: 123 } }, ctx),
    ).rejects.toBeInstanceOf(ProtocolError);
    try {
      await invokeHandler({ name: TOOLS_GET_SCHEMA, arguments: { name: 123 } }, ctx);
    } catch (error) {
      expect((error as ProtocolError).code).toBe(-32602);
    }
  });

  it('mirrors a DESTRUCTIVE target: the target handler performs its own confirm gating', async () => {
    const registry = createToolRegistry();
    // batch.apply is class D: when its `confirm` arg is false it elicits via ctx.elicit; a decline ⇒ a
    // clean non-error. Attaching the REAL handler proves invoke inherits the target's confirm gating.
    const { attachOpsHandlers } = await import('./ops.js');
    attachOpsHandlers(registry);
    const elicit = vi.fn(() => Promise.resolve({ confirmed: false }));
    const ctx = makeCtx(registry, makeSurface(), elicit);

    const result = await invokeHandler(
      { name: 'elementor.batch.apply', arguments: { plan: [], confirm: false } },
      ctx,
    );
    // The destructive target elicited (parity), the user declined, and invoke wrapped a non-error.
    expect(elicit).toHaveBeenCalledTimes(1);
    expect(structured(result)['isError']).toBe(false);
    const inner = structured(result)['result'] as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(inner.isError).toBeFalsy();
    expect(inner.content?.[0]?.text).toMatch(/cancelled/i);
  });

  it('returns a clean isError result for an unknown target tool name', async () => {
    const registry = createToolRegistry();
    const ctx = makeCtx(registry, makeSurface());
    const result = await invokeHandler({ name: 'elementor.nope', arguments: {} }, ctx);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code?: string }).code).toBe('VALIDATION_FAILED');
  });

  it('wraps a target error result as {result, isError:true} without throwing', async () => {
    const registry = createToolRegistry();
    const disabled = aDisabledToolAcceptingEmptyArgs(registry);
    registry.attachHandler(disabled, () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'boom' }],
        structuredContent: { code: 'INTERNAL_ERROR' },
        isError: true,
      }),
    );
    const ctx = makeCtx(registry, makeSurface());

    const result = await invokeHandler({ name: disabled, arguments: {} }, ctx);
    const out = structured(result);
    expect(out['isError']).toBe(true);
    expect((out['result'] as { isError?: boolean }).isError).toBe(true);
  });
});
