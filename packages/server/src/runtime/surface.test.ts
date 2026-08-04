/**
 * WP-T01 — SurfaceController tests (§Tests Required): `enable([...])` flips state + emits exactly one
 * `sendToolListChanged` per batch, and ZERO on a no-op (13-tool-catalog.md §5.3).
 */

import { describe, expect, it, vi } from 'vitest';

import { SurfaceController, type SurfaceToolHandle } from './surface.js';
import { createToolRegistry } from '../catalog/registry.js';

/** A fake SDK tool handle tracking enabled state (the controller flips `enabled` directly). */
function fakeHandle(enabled: boolean): SurfaceToolHandle {
  return { enabled };
}

/** A fake server capturing `sendToolListChanged` calls. */
function fakeServer(): { sendToolListChanged: () => void; calls: () => number } {
  const fn = vi.fn();
  return { sendToolListChanged: fn, calls: () => fn.mock.calls.length };
}

describe('SurfaceController.enable', () => {
  it('flips disabled tools enabled and emits exactly one sendToolListChanged per batch', () => {
    const registry = createToolRegistry();
    const server = fakeServer();
    const handles = new Map<string, SurfaceToolHandle>([
      ['elementor.page.delete', fakeHandle(false)],
      ['elementor.element.move', fakeHandle(false)],
      ['elementor.templates.list', fakeHandle(false)],
    ]);
    // Mirror the disabled state into the registry bookkeeping (boot disables them).
    for (const name of handles.keys()) {
      registry.disable(name);
    }
    const surface = new SurfaceController(server, registry, handles);

    const changed = surface.enable(['elementor.page.delete', 'elementor.element.move']);

    expect(changed.sort()).toEqual(['elementor.element.move', 'elementor.page.delete']);
    expect(surface.isEnabled('elementor.page.delete')).toBe(true);
    expect(surface.isEnabled('elementor.element.move')).toBe(true);
    expect(surface.isEnabled('elementor.templates.list')).toBe(false);
    expect(registry.isEnabled('elementor.page.delete')).toBe(true);
    expect(server.calls()).toBe(1); // exactly one per batch.
  });

  it('emits ZERO sendToolListChanged on a no-op (all already enabled / unknown names)', () => {
    const registry = createToolRegistry();
    const server = fakeServer();
    const handles = new Map<string, SurfaceToolHandle>([
      ['elementor.page.delete', fakeHandle(true)], // already enabled
    ]);
    const surface = new SurfaceController(server, registry, handles);

    const changed = surface.enable(['elementor.page.delete', 'elementor.does.not.exist']);

    expect(changed).toEqual([]);
    expect(server.calls()).toBe(0);
  });

  it('dedupes repeated names within a batch and emits once', () => {
    const registry = createToolRegistry();
    const server = fakeServer();
    const handles = new Map<string, SurfaceToolHandle>([
      ['elementor.page.delete', fakeHandle(false)],
    ]);
    registry.disable('elementor.page.delete');
    const surface = new SurfaceController(server, registry, handles);

    const changed = surface.enable([
      'elementor.page.delete',
      'elementor.page.delete',
      'elementor.page.delete',
    ]);

    expect(changed).toEqual(['elementor.page.delete']);
    expect(server.calls()).toBe(1);
  });
});

describe('SurfaceController.disable', () => {
  it('flips enabled tools disabled and emits one per batch, but never disables the meta-trio', () => {
    const registry = createToolRegistry();
    const server = fakeServer();
    const handles = new Map<string, SurfaceToolHandle>([
      ['elementor.page.delete', fakeHandle(true)],
      ['elementor.tools.invoke', fakeHandle(true)], // meta-trio — exempt
    ]);
    const surface = new SurfaceController(server, registry, handles);

    const changed = surface.disable(['elementor.page.delete', 'elementor.tools.invoke']);

    expect(changed).toEqual(['elementor.page.delete']);
    expect(surface.isEnabled('elementor.page.delete')).toBe(false);
    expect(surface.isEnabled('elementor.tools.invoke')).toBe(true); // meta stays enabled.
    expect(server.calls()).toBe(1);
  });
});
