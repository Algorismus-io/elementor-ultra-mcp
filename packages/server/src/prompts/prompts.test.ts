/**
 * WP-T13 — non-Pro prompt-handler tests (§Tests Required).
 *
 * Asserts (with a stub prompt registry — no live `McpServer`, no network):
 *  - each non-Pro handler attaches under the EXACT WP-F04 descriptor name (catalog/prompts.ts §3);
 *  - the emitted plan references the EXACT Contract 13 tool names (a misspelling violates §4.1);
 *  - the plans encode the LOCKED rules: never-auto-commit (html-to-native), schema-first /
 *    capabilities-first (build-from-brief), and budget + duplicate-label flagging (design-system-audit);
 *  - the html-to-native coverage gate is HONEST / S3-anchored (never a hardcoded 85%);
 *  - `theme-builder-from-spec` (the Pro prompt, WP-R07) is NOT referenced by this module's index.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { PromptHandler } from '../runtime/index.js';
import { PROMPT_DESCRIPTORS, PROMPT_NAMES } from '../catalog/prompts.js';

import {
  registerNonProPrompts,
  NON_PRO_PROMPT_NAMES,
  buildFromBriefHandler,
  htmlToNativeHandler,
  designSystemAuditHandler,
  type PromptRegistry,
} from './index.js';

/* ───────────────────────────── a capturing stub prompt registry ───────────────────────────── */

class StubPromptRegistry implements PromptRegistry {
  public readonly attached = new Map<string, PromptHandler>();
  attachHandler(name: string, handler: PromptHandler): void {
    this.attached.set(name, handler);
  }
}

/** Render a handler's single-message plan text (handlers are pure — no ctx is needed). */
async function renderPlan(handler: PromptHandler, args: Record<string, string>): Promise<string> {
  // The handlers never touch `ctx`; pass an empty object cast to the runtime ctx type.
  const result = await handler(args, {} as Parameters<PromptHandler>[1]);
  return result.messages.map((m) => m.content.text).join('\n');
}

/* ───────────────────────────── attachment by exact name ───────────────────────────────────── */

describe('registerNonProPrompts — attachment', () => {
  it('attaches exactly the three non-Pro handlers by their WP-F04 descriptor names', () => {
    const registry = new StubPromptRegistry();
    registerNonProPrompts(registry);

    expect([...registry.attached.keys()].sort()).toEqual(
      ['build-from-brief', 'design-system-audit', 'html-to-native'].sort(),
    );
    expect(registry.attached.size).toBe(3);
  });

  it('the attached names are all real WP-F04 prompt descriptors', () => {
    for (const name of NON_PRO_PROMPT_NAMES) {
      expect(PROMPT_NAMES).toContain(name);
      expect(PROMPT_DESCRIPTORS.some((d) => d.name === name)).toBe(true);
    }
  });

  it('does NOT attach the Pro theme-builder-from-spec prompt (owned by WP-R07)', () => {
    const registry = new StubPromptRegistry();
    registerNonProPrompts(registry);
    expect(registry.attached.has('theme-builder-from-spec')).toBe(false);
    expect(NON_PRO_PROMPT_NAMES).not.toContain('theme-builder-from-spec');
  });
});

/* ───────────────────────────── build-from-brief: capabilities + schema-first ───────────────── */

describe('build-from-brief plan', () => {
  it('references the exact tool sequence: capabilities → schema.* → dry_run → build', async () => {
    const text = await renderPlan(buildFromBriefHandler, { brief: 'A SaaS landing page' });
    expect(text).toContain('elementor.site.capabilities');
    expect(text).toContain('elementor.schema.widget');
    expect(text).toContain('elementor.schema.styles');
    expect(text).toContain('elementor.page.dry_run');
    expect(text).toContain('elementor.page.build');

    // Ordering: capabilities before schema before dry_run before build.
    const iCaps = text.indexOf('elementor.site.capabilities');
    const iWidget = text.indexOf('elementor.schema.widget');
    const iDry = text.indexOf('elementor.page.dry_run');
    const iBuild = text.indexOf('elementor.page.build');
    expect(iCaps).toBeLessThan(iWidget);
    expect(iWidget).toBeLessThan(iDry);
    expect(iDry).toBeLessThan(iBuild);
  });

  it('encodes schema-first (never invent props) + V4-default/V3-fallback', async () => {
    const text = (await renderPlan(buildFromBriefHandler, { brief: 'x' })).toLowerCase();
    expect(text).toContain('never invent');
    expect(text).toMatch(/v4.*default|default.*v4/);
    expect(text).toContain('v3');
    expect(text).toContain('fall back');
  });

  it('threads the optional post_type + generation string args into the plan', async () => {
    const text = await renderPlan(buildFromBriefHandler, {
      brief: 'x',
      post_type: 'landing_page',
      generation: 'v4',
    });
    expect(text).toContain('landing_page');
  });

  it('includes the brief text verbatim', async () => {
    const text = await renderPlan(buildFromBriefHandler, { brief: 'UNIQUE-BRIEF-MARKER-123' });
    expect(text).toContain('UNIQUE-BRIEF-MARKER-123');
  });
});

/* ───────────────────────────── html-to-native: LOCKED never-auto-commit ────────────────────── */

describe('html-to-native plan', () => {
  it('references the exact tools tree → page in order', async () => {
    const text = await renderPlan(htmlToNativeHandler, { html: '<div>hi</div>' });
    expect(text).toContain('elementor.convert.html_to_tree');
    expect(text).toContain('elementor.convert.html_to_page');
    expect(text.indexOf('elementor.convert.html_to_tree')).toBeLessThan(
      text.indexOf('elementor.convert.html_to_page'),
    );
  });

  it('enforces never-auto-commit with explicit commit:true + confirm:true', async () => {
    const text = await renderPlan(htmlToNativeHandler, { html: '<div>hi</div>' });
    expect(text.toLowerCase()).toContain('never auto-commit');
    expect(text).toContain('commit: true');
    expect(text).toContain('confirm: true');
    // The plan must require reviewing the report before committing.
    expect(text.toLowerCase()).toContain('report');
    expect(text.toLowerCase()).toMatch(/a11y|accessibility/);
  });

  it('states an HONEST, S3-anchored coverage gate (never a hardcoded 85%)', async () => {
    const text = await renderPlan(htmlToNativeHandler, { html: '<div>hi</div>' });
    expect(text).not.toContain('85%');
    expect(text).toContain('corpus.manifest.json');
    expect(text.toLowerCase()).toContain('coverage');
  });

  it('does not coerce coverage_gate — instructs the agent to pass the parsed number', async () => {
    const text = await renderPlan(htmlToNativeHandler, {
      html: '<div>hi</div>',
      coverage_gate: '0.7',
    });
    expect(text).toContain('0.7');
    expect(text.toLowerCase()).toContain('parse');
  });
});

/* ───────────────────────────── design-system-audit: budget + duplicate labels ──────────────── */

describe('design-system-audit plan', () => {
  it('references the exact read + consolidate tools', async () => {
    const text = await renderPlan(designSystemAuditHandler, {});
    expect(text).toContain('elementor.design.classes.list');
    expect(text).toContain('elementor.design.variables.list');
    expect(text).toContain('elementor.design.globalColors.list');
    expect(text).toContain('elementor.design.classes.upsert');
    expect(text).toContain('elementor.design.variables.batch');
  });

  it('flags the 1000-item budget + duplicate labels', async () => {
    const text = await renderPlan(designSystemAuditHandler, {});
    expect(text).toContain('1000');
    expect(text.toLowerCase()).toContain('duplicate label');
    expect(text.toLowerCase()).toContain('budget');
  });

  it('narrows by scope=variables (no classes.list, includes variables.list)', async () => {
    const text = await renderPlan(designSystemAuditHandler, { scope: 'variables' });
    expect(text).toContain('elementor.design.variables.list');
    expect(text).not.toContain('elementor.design.classes.list');
  });

  it('narrows by scope=classes (classes.list present, no variables.list)', async () => {
    const text = await renderPlan(designSystemAuditHandler, { scope: 'classes' });
    expect(text).toContain('elementor.design.classes.list');
    expect(text).not.toContain('elementor.design.variables.list');
  });
});

/* ───────────────────────────── no Pro reference in this module's source ────────────────────── */

describe('index.ts ownership (disjoint from the Pro prompt)', () => {
  it("this WP's index.ts does not import or reference theme-builder-from-spec", () => {
    const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));
    const src = readFileSync(indexPath, 'utf8');
    expect(src).not.toContain('theme-builder-from-spec');
    expect(src).not.toContain('theme-builder-from-spec.js');
    expect(src.toLowerCase()).not.toContain('registerthemebuilderprompt');
  });
});
