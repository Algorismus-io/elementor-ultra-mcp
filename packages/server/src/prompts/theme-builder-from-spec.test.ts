/**
 * WP-R07 — `theme-builder-from-spec` prompt-handler tests (§Tests Required).
 *
 * Asserts (with a stub prompt registry — no live `McpServer`, no network, no `ctx`):
 *  - the handler attaches under the EXACT WP-F04 descriptor name `theme-builder-from-spec`
 *    (catalog/prompts.ts §3);
 *  - the emitted plan references the EXACT Contract 13 tool names (`site.capabilities`,
 *    `pro.theme.get_conditions_config`, `schema.widget`/`schema.styles`, `page.dry_run`,
 *    `pro.theme.create`) — a misspelling violates §4.1;
 *  - the plan encodes the LOCKED rules: Pro-gate FIRST, conditions-config BEFORE authoring, schema-first,
 *    and `dry_run` BEFORE `pro.theme.create` (ordering enforced);
 *  - NO tool call happens inside the handler (pure text-plan generator — the stub `ctx` is never touched).
 */

import { describe, expect, it } from 'vitest';

import type { PromptHandler } from '../runtime/index.js';
import { PROMPT_DESCRIPTORS, PROMPT_NAMES } from '../catalog/prompts.js';

import type { PromptRegistry } from './index.js';
import {
  registerThemeBuilderPrompt,
  themeBuilderFromSpecHandler,
  THEME_BUILDER_FROM_SPEC_PROMPT_NAME,
} from './theme-builder-from-spec.js';

/* ───────────────────────────── a capturing stub prompt registry ───────────────────────────── */

class StubPromptRegistry implements PromptRegistry {
  public readonly attached = new Map<string, PromptHandler>();
  attachHandler(name: string, handler: PromptHandler): void {
    this.attached.set(name, handler);
  }
}

/**
 * Render a handler's single-message plan text. The handler is PURE (never touches `ctx`); we pass a
 * throwing Proxy as `ctx` so any property access inside the handler would explode the test — proving no
 * tool call / ctx use happens inside the handler.
 */
async function renderPlan(handler: PromptHandler, args: Record<string, string>): Promise<string> {
  const explodingCtx = new Proxy(
    {},
    {
      get() {
        throw new Error('the prompt handler must NOT touch ctx (no tool calls inside the handler)');
      },
    },
  ) as Parameters<PromptHandler>[1];
  const result = await handler(args, explodingCtx);
  return result.messages.map((m) => m.content.text).join('\n');
}

/* ───────────────────────────── attachment by exact name ───────────────────────────────────── */

describe('registerThemeBuilderPrompt — attachment', () => {
  it('attaches the handler under the EXACT WP-F04 descriptor name', () => {
    const registry = new StubPromptRegistry();
    registerThemeBuilderPrompt(registry);

    expect(registry.attached.size).toBe(1);
    expect(registry.attached.has('theme-builder-from-spec')).toBe(true);
    expect(THEME_BUILDER_FROM_SPEC_PROMPT_NAME).toBe('theme-builder-from-spec');
  });

  it('the attached name is a real WP-F04 prompt descriptor', () => {
    expect(PROMPT_NAMES).toContain(THEME_BUILDER_FROM_SPEC_PROMPT_NAME);
    expect(PROMPT_DESCRIPTORS.some((d) => d.name === THEME_BUILDER_FROM_SPEC_PROMPT_NAME)).toBe(
      true,
    );
  });

  it('the WP-F04 descriptor declares the {spec, theme_type?} string args (§3)', () => {
    const descriptor = PROMPT_DESCRIPTORS.find(
      (d) => d.name === THEME_BUILDER_FROM_SPEC_PROMPT_NAME,
    );
    expect(descriptor).toBeDefined();
    const keys = Object.keys(descriptor!.argsSchema).sort();
    expect(keys).toEqual(['spec', 'theme_type'].sort());
  });
});

/* ───────────────────────────── plan: exact tool names + ordering ───────────────────────────── */

describe('theme-builder-from-spec plan', () => {
  it('references the exact Pro-gated tool sequence (capabilities → conditions-config → schema.* → dry_run → create)', async () => {
    const text = await renderPlan(themeBuilderFromSpecHandler, {
      spec: 'A site header with logo + nav, and a single-post template.',
    });
    expect(text).toContain('elementor.site.capabilities');
    expect(text).toContain('elementor.pro.theme.get_conditions_config');
    expect(text).toContain('elementor.schema.widget');
    expect(text).toContain('elementor.schema.styles');
    expect(text).toContain('elementor.page.dry_run');
    expect(text).toContain('elementor.pro.theme.create');

    // Ordering: capabilities → conditions-config → schema → dry_run → create.
    const iCaps = text.indexOf('elementor.site.capabilities');
    const iCfg = text.indexOf('elementor.pro.theme.get_conditions_config');
    const iWidget = text.indexOf('elementor.schema.widget');
    const iDry = text.indexOf('elementor.page.dry_run');
    const iCreate = text.indexOf('elementor.pro.theme.create');
    expect(iCaps).toBeLessThan(iCfg);
    expect(iCfg).toBeLessThan(iWidget);
    expect(iWidget).toBeLessThan(iDry);
    expect(iDry).toBeLessThan(iCreate);
  });

  it('gates on Pro active (the prompt requires Elementor Pro)', async () => {
    const text = await renderPlan(themeBuilderFromSpecHandler, { spec: 'X' });
    expect(text).toMatch(/Elementor Pro/i);
    // The gate reads `pro` from capabilities and tells the agent to STOP when not Pro.
    expect(text).toMatch(/\bpro\b/);
    expect(text).toMatch(/STOP/i);
  });

  it('enforces schema-first (never invent props) and conditions-config-first (never invent conditions)', async () => {
    const text = await renderPlan(themeBuilderFromSpecHandler, { spec: 'X' });
    expect(text).toMatch(/never invent/i);
    expect(text).toContain('ConditionTuple');
  });

  it('reminds that conditions write slash strings + regenerate the cache server-side', async () => {
    const text = await renderPlan(themeBuilderFromSpecHandler, { spec: 'X' });
    expect(text).toMatch(/slash/i);
    expect(text).toMatch(/cache/i);
  });

  it("notes that 'single' is NOT a valid type when a theme_type hint is given", async () => {
    const text = await renderPlan(themeBuilderFromSpecHandler, {
      spec: 'X',
      theme_type: 'single',
    });
    expect(text).toContain('single');
    expect(text).toMatch(/NOT a valid type/i);
  });

  it('threads an empty spec into an explicit "ask the user first" instruction', async () => {
    const text = await renderPlan(themeBuilderFromSpecHandler, { spec: '' });
    expect(text).toMatch(/ask the user/i);
  });

  it('does NOT call any tool inside the handler (pure text-plan generator)', async () => {
    // renderPlan passes an exploding Proxy as ctx; a clean render proves the handler never touched it.
    await expect(renderPlan(themeBuilderFromSpecHandler, { spec: 'X' })).resolves.toBeTypeOf(
      'string',
    );
  });
});
