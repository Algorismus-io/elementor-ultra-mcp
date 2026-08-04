/**
 * WP-F04 — `ToolRegistry` bookkeeping tests (Acceptance: "Registry exposes attach/get/list/enable/
 * disable hooks; no `McpServer` instance and no handlers").
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ToolRegistry,
  createToolRegistry,
  HandlerNotRegisteredError,
  UnknownToolError,
} from './registry.js';
import { TOOL_COUNT } from './tools.js';
import { LEAN_STAR_TOOLS, META_TOOLS, RETIRED_TOOLS } from './profiles.js';

describe('ToolRegistry — descriptor access', () => {
  it('seeds with the full catalog', () => {
    const r = createToolRegistry();
    expect(r.listDescriptors().length).toBe(TOOL_COUNT);
    expect(r.has('elementor.page.build')).toBe(true);
    expect(r.has('elementor.not.a.tool')).toBe(false);
  });

  it('getDescriptor throws UnknownToolError for an unknown name', () => {
    const r = new ToolRegistry();
    expect(() => r.getDescriptor('elementor.nope')).toThrow(UnknownToolError);
  });

  it('exposes annotations', () => {
    const r = new ToolRegistry();
    expect(r.getAnnotations('elementor.page.dry_run').readOnlyHint).toBe(true);
  });
});

describe('ToolRegistry — handler attachment (no handlers shipped by F04)', () => {
  it('getHandler throws HandlerNotRegisteredError until a vertical attaches', () => {
    const r = new ToolRegistry();
    expect(r.hasHandler('elementor.page.build')).toBe(false);
    expect(() => r.getHandler('elementor.page.build')).toThrow(HandlerNotRegisteredError);
  });

  it('attachHandler then getHandler returns the fn', () => {
    const r = new ToolRegistry();
    const fn = vi.fn();
    r.attachHandler('elementor.page.build', fn);
    expect(r.hasHandler('elementor.page.build')).toBe(true);
    expect(r.getHandler('elementor.page.build')).toBe(fn);
  });

  it('attachHandler throws for an unknown tool', () => {
    const r = new ToolRegistry();
    expect(() => r.attachHandler('elementor.nope', vi.fn())).toThrow(UnknownToolError);
  });
});

describe('ToolRegistry — enable/disable + listChanged (§5.3)', () => {
  it('disable + enable fire onListChanged on transitions only', () => {
    const r = new ToolRegistry();
    const listener = vi.fn();
    r.onListChanged(listener);

    r.disable('elementor.page.delete');
    expect(r.isEnabled('elementor.page.delete')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    // No-op (already disabled) → no extra notification.
    r.disable('elementor.page.delete');
    expect(listener).toHaveBeenCalledTimes(1);

    r.enable('elementor.page.delete');
    expect(r.isEnabled('elementor.page.delete')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('the meta-trio cannot be disabled (always available, §5.2/§6)', () => {
    const r = new ToolRegistry();
    for (const name of META_TOOLS) {
      r.disable(name);
      expect(r.isEnabled(name), name).toBe(true);
    }
  });

  it('unsubscribe stops notifications', () => {
    const r = new ToolRegistry();
    const listener = vi.fn();
    const off = r.onListChanged(listener);
    off();
    r.disable('elementor.page.delete');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ToolRegistry — profile application (§5.2/§5.4)', () => {
  it('applyProfile(lean) enables exactly the ★ set + meta-trio', () => {
    const r = new ToolRegistry();
    r.applyProfile('lean');
    const enabled = new Set(r.listEnabled());
    expect(enabled).toEqual(new Set<string>([...LEAN_STAR_TOOLS, ...META_TOOLS]));
    expect(r.listDisabled().length).toBe(TOOL_COUNT - enabled.size);
  });

  it('applyProfile(full) enables everything except the retired set', () => {
    const r = new ToolRegistry();
    r.applyProfile('lean');
    r.applyProfile('full');
    expect(r.listEnabled().length).toBe(TOOL_COUNT - RETIRED_TOOLS.length);
    expect(r.listDisabled().length).toBe(RETIRED_TOOLS.length);
  });

  it('listForProfile is non-mutating', () => {
    const r = new ToolRegistry();
    const lean = r.listForProfile('lean');
    expect(lean.length).toBe(LEAN_STAR_TOOLS.length + META_TOOLS.length);
    // Registry state untouched (all still enabled from construction).
    expect(r.listEnabled().length).toBe(TOOL_COUNT);
  });

  it('applyProfile fires a single listChanged for the batch', () => {
    const r = new ToolRegistry();
    const listener = vi.fn();
    r.onListChanged(listener);
    r.applyProfile('lean');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
