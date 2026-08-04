/**
 * WP-T01 — the {@link SurfaceController}: the LIVE driver for dynamic tool-surface management
 * (13-tool-catalog.md §5.3; 01-architecture.md §7 "tool-surface management is TS-owned").
 *
 * The WP-F04 `ToolRegistry` owns the enabled/disabled BOOKKEEPING; this controller owns the LIVE SDK
 * side: it holds the per-tool `RegisteredTool` handles returned by `server.registerTool(...)` and the
 * `McpServer`, flips SDK tool state, mirrors that into the registry bookkeeping, and emits
 * `server.sendToolListChanged()` EXACTLY ONCE per batch — and only when at least one tool actually
 * changed (never on a no-op). `tools.search` (WP-T04) calls {@link enable} on a match to surface
 * advanced tools on demand.
 *
 * IMPORTANT (batch emit discipline): the SDK's `RegisteredTool.enable()/.disable()` each emit
 * `sendToolListChanged()` internally (via `update`), which would defeat the "exactly one per batch"
 * rule. This controller therefore sets the handle's `enabled` flag DIRECTLY (the SDK's `tools/list` +
 * `callTool` handlers read `tool.enabled`) and emits ONCE for the whole batch itself.
 *
 * Discipline (§5.3 / §Implementation Notes "sendToolListChanged discipline"):
 *  - batch enables → emit once;
 *  - zero emits when nothing transitioned;
 *  - the always-available meta-trio (`registry.disable` is a no-op for it) is never disabled here.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolRegistry } from '../catalog/registry.js';

/**
 * A handle the controller flips by SETTING `enabled` directly (the SDK's `RegisteredTool` exposes a
 * mutable `enabled` field that `tools/list` + `callTool` read). Setting the flag directly — rather than
 * calling the SDK's `enable()/disable()` — avoids the SDK's per-tool `sendToolListChanged` so this
 * controller can emit exactly once per batch.
 */
export interface SurfaceToolHandle {
  enabled: boolean;
}

/**
 * Live driver for the tool surface. Constructed by {@link buildServer} with the `McpServer`, the
 * WP-F04 registry, and the map of registered SDK tool handles.
 */
export class SurfaceController {
  private readonly server: Pick<McpServer, 'sendToolListChanged'>;
  private readonly registry: ToolRegistry;
  private readonly handles: Map<string, SurfaceToolHandle>;

  /**
   * @param server   The live `McpServer` (only `sendToolListChanged` is used here).
   * @param registry The WP-F04 registry (the enabled/disabled bookkeeping + meta-trio rules).
   * @param handles  name → SDK `RegisteredTool` handle (created by `server.registerTool`).
   */
  constructor(
    server: Pick<McpServer, 'sendToolListChanged'>,
    registry: ToolRegistry,
    handles: Map<string, SurfaceToolHandle>,
  ) {
    this.server = server;
    this.registry = registry;
    this.handles = handles;
  }

  /**
   * Enable the named tools (§5.3 — `tools.search` enables matched advanced tools). Dedupes
   * already-enabled names + unknown names, flips the live SDK handle AND the registry bookkeeping, and
   * emits `sendToolListChanged()` ONCE for the whole batch — only if at least one tool transitioned.
   *
   * @returns the names that actually transitioned to enabled (empty ⇒ no notification emitted).
   */
  enable(names: readonly string[]): string[] {
    const changed: string[] = [];
    for (const name of new Set(names)) {
      const handle = this.handles.get(name);
      if (handle === undefined || handle.enabled) {
        continue; // unknown tool or already enabled — no-op.
      }
      handle.enabled = true; // set directly to avoid the SDK's per-tool auto-emit (see header).
      this.registry.enable(name);
      changed.push(name);
    }
    if (changed.length > 0) {
      this.server.sendToolListChanged();
    }
    return changed;
  }

  /**
   * Disable the named tools (the inverse of {@link enable}). The always-available meta-trio is exempt
   * (the registry refuses to disable it, and we skip its live handle too). Emits one
   * `sendToolListChanged()` per batch, only on an actual transition.
   *
   * @returns the names that actually transitioned to disabled.
   */
  disable(names: readonly string[]): string[] {
    const changed: string[] = [];
    for (const name of new Set(names)) {
      const handle = this.handles.get(name);
      if (handle === undefined || !handle.enabled) {
        continue;
      }
      const descriptor = this.registry.has(name) ? this.registry.getDescriptor(name) : undefined;
      if (descriptor?.meta === true) {
        continue; // meta-trio is always available (§5.2/§6).
      }
      handle.enabled = false; // set directly to avoid the SDK's per-tool auto-emit (see header).
      this.registry.disable(name);
      changed.push(name);
    }
    if (changed.length > 0) {
      this.server.sendToolListChanged();
    }
    return changed;
  }

  /** Whether a tool's LIVE SDK handle is currently enabled. */
  isEnabled(name: string): boolean {
    return this.handles.get(name)?.enabled ?? false;
  }

  /** The names of all currently-enabled tools (live SDK state), in registration order. */
  enabledNames(): string[] {
    const names: string[] = [];
    for (const [name, handle] of this.handles) {
      if (handle.enabled) {
        names.push(name);
      }
    }
    return names;
  }
}
