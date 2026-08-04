/**
 * WP-F04 — the data-driven `ToolRegistry` skeleton (Seam A, 13-tool-catalog.md §1, §5.2-§5.4).
 *
 * Holds the frozen tool descriptors + per-tool bookkeeping (enabled flag, attached handler) and the
 * `listChanged` notification hook the server core (WP-T01) drives. Pure data + bookkeeping — there is
 * NO `McpServer` instance here and NO handler logic (§Detailed Requirements 7; §Implementation Notes:
 * "the actual `server.registerTool`/`server.sendToolListChanged` calls are WP-T01's"). Vertical tool
 * WPs (WP-T##/H##/R##) `attachHandler(name, fn)` by name; WP-T01 reads the registry to register tools,
 * disables the non-★ set at boot, and wires `onListChanged` to `server.sendToolListChanged()`.
 *
 * Calling a tool whose handler is not attached yields a clear "handler not registered" error so the
 * catalog can ship before any vertical (§Detailed Requirements 7).
 */

import {
  TOOL_DESCRIPTORS,
  TOOL_NAMES,
  type ToolAnnotations,
  type ToolDescriptor,
} from './tools.js';
import {
  DEFAULT_PROFILE,
  META_TOOLS,
  disabledToolNamesForProfile,
  enabledToolNamesForProfile,
  type UltraToolsProfile,
} from './profiles.js';

/**
 * A tool handler signature. Handlers are owned by the vertical WPs and attached by name; F04 only
 * stores the reference. The arg/return are intentionally loose here (each vertical narrows via its
 * zod `inputSchema` at call time) — the registry never invokes business logic itself. The return is
 * `unknown` (a handler may be sync or async; `unknown` already subsumes `Promise<unknown>`).
 */
export type ToolHandler = (args: Record<string, unknown>) => unknown;

/** Listener invoked whenever the enabled set changes (WP-T01 wires this to `sendToolListChanged`). */
export type ListChangedListener = () => void;

/** The mutable per-tool bookkeeping the registry tracks (not part of the frozen descriptor). */
interface ToolEntry {
  readonly descriptor: ToolDescriptor;
  enabled: boolean;
  handler?: ToolHandler;
}

/** Thrown when a tool is invoked / its handler requested but none has been attached yet. */
export class HandlerNotRegisteredError extends Error {
  public readonly toolName: string;
  constructor(toolName: string) {
    super(`Handler not registered for tool "${toolName}"`);
    this.name = 'HandlerNotRegisteredError';
    this.toolName = toolName;
  }
}

/** Thrown when a tool name is not present in the frozen catalog. */
export class UnknownToolError extends Error {
  public readonly toolName: string;
  constructor(toolName: string) {
    super(`Unknown tool "${toolName}" (not in the frozen catalog)`);
    this.name = 'UnknownToolError';
    this.toolName = toolName;
  }
}

/**
 * The data-driven tool registry. Constructed with the frozen {@link TOOL_DESCRIPTORS}; WP-T01 then
 * resolves the `ULTRA_TOOLS` profile, disables the non-enabled set, attaches handlers (via the
 * verticals), and registers each enabled tool against its `McpServer`.
 */
export class ToolRegistry {
  private readonly entries: Map<string, ToolEntry>;
  private readonly order: readonly string[];
  private readonly listeners: Set<ListChangedListener> = new Set();

  /**
   * @param descriptors The frozen catalog (defaults to {@link TOOL_DESCRIPTORS}). All tools start
   *   ENABLED; WP-T01 applies the profile via {@link applyProfile} (or per-tool {@link disable}).
   */
  constructor(descriptors: readonly ToolDescriptor[] = TOOL_DESCRIPTORS) {
    this.entries = new Map<string, ToolEntry>();
    for (const descriptor of descriptors) {
      this.entries.set(descriptor.name, { descriptor, enabled: true });
    }
    this.order = descriptors.map((d) => d.name);
  }

  /* ───────────────────────────── descriptor access ─────────────────────────────────────── */

  /** Whether the catalog contains a tool by this name. */
  public has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Look up a descriptor by name (throws {@link UnknownToolError} if absent). */
  public getDescriptor(name: string): ToolDescriptor {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new UnknownToolError(name);
    }
    return entry.descriptor;
  }

  /** Every descriptor, in catalog order. */
  public listDescriptors(): ToolDescriptor[] {
    return this.order.map((name) => this.requireEntry(name).descriptor);
  }

  /** The annotations for a named tool (convenience for the meta-trio + WP-T01). */
  public getAnnotations(name: string): ToolAnnotations {
    return this.getDescriptor(name).annotations;
  }

  /* ───────────────────────────── handler attachment (verticals) ─────────────────────────── */

  /**
   * Attach a handler to a tool by name (called by the vertical tool WPs). Replaces any prior handler.
   * Throws {@link UnknownToolError} if the name is not in the frozen catalog.
   */
  public attachHandler(name: string, handler: ToolHandler): void {
    this.requireEntry(name).handler = handler;
  }

  /** Whether a handler has been attached for a tool. */
  public hasHandler(name: string): boolean {
    return this.entries.get(name)?.handler !== undefined;
  }

  /**
   * Get the attached handler (throws {@link UnknownToolError} for an unknown name,
   * {@link HandlerNotRegisteredError} when no handler is attached so the catalog can ship pre-vertical).
   */
  public getHandler(name: string): ToolHandler {
    const entry = this.requireEntry(name);
    if (entry.handler === undefined) {
      throw new HandlerNotRegisteredError(name);
    }
    return entry.handler;
  }

  /* ───────────────────────────── enable / disable bookkeeping (§5.3) ────────────────────── */

  /** Whether a tool is currently enabled. */
  public isEnabled(name: string): boolean {
    return this.requireEntry(name).enabled;
  }

  /**
   * Enable a tool (§5.3 — `tools.search` enables matched advanced tools). Fires `onListChanged` only on
   * an actual transition. The meta-trio is always enabled and cannot be disabled (§5.2/§6).
   */
  public enable(name: string): void {
    this.setEnabled(name, true);
  }

  /**
   * Disable a tool (§5.3 — advanced tools `disable()`d at boot). Fires `onListChanged` only on an
   * actual transition. The always-available meta-trio is exempt and silently stays enabled (§5.2/§6).
   */
  public disable(name: string): void {
    const entry = this.requireEntry(name);
    if (entry.descriptor.meta === true) {
      return; // meta-trio is always available (§5.2/§6) — never disabled.
    }
    this.setEnabled(name, false);
  }

  /** The names of all currently-enabled tools, in catalog order. */
  public listEnabled(): string[] {
    return this.order.filter((name) => this.requireEntry(name).enabled);
  }

  /** The names of all currently-disabled tools, in catalog order. */
  public listDisabled(): string[] {
    return this.order.filter((name) => !this.requireEntry(name).enabled);
  }

  /* ───────────────────────────── profile application (§5.2 / §5.4) ──────────────────────── */

  /**
   * The descriptors enabled at boot for a profile (§5.2/§5.4) — does NOT mutate the registry; WP-T01
   * uses this to decide which tools to register-enabled. `lean` ⇒ ★ set + meta-trio; `full` ⇒ all.
   */
  public listForProfile(profile: UltraToolsProfile = DEFAULT_PROFILE): ToolDescriptor[] {
    const enabled = enabledToolNamesForProfile(profile);
    return this.listDescriptors().filter((d) => enabled.has(d.name));
  }

  /**
   * Apply a profile to the registry's enabled state (§5.2/§5.4): enable the profile's boot set, disable
   * the rest (the meta-trio is exempt). Suppresses per-tool notifications and fires a single
   * `onListChanged` at the end. WP-T01 calls this once at init after reading `ULTRA_TOOLS`.
   */
  public applyProfile(profile: UltraToolsProfile = DEFAULT_PROFILE): void {
    const enabled = enabledToolNamesForProfile(profile);
    const toDisable = new Set(disabledToolNamesForProfile(profile));
    let changed = false;
    for (const name of this.order) {
      const entry = this.requireEntry(name);
      const shouldEnable = enabled.has(name) || entry.descriptor.meta === true;
      const target = shouldEnable && !toDisable.has(name);
      if (entry.enabled !== target) {
        entry.enabled = target;
        changed = true;
      }
    }
    if (changed) {
      this.emitListChanged();
    }
  }

  /* ───────────────────────────── listChanged hook (§5.3) ────────────────────────────────── */

  /**
   * Subscribe to enabled-set changes (WP-T01 wires this to `server.sendToolListChanged()`). Returns an
   * unsubscribe function.
   */
  public onListChanged(listener: ListChangedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ───────────────────────────── internals ─────────────────────────────────────────────── */

  private setEnabled(name: string, value: boolean): void {
    const entry = this.requireEntry(name);
    if (entry.enabled === value) {
      return;
    }
    entry.enabled = value;
    this.emitListChanged();
  }

  private emitListChanged(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private requireEntry(name: string): ToolEntry {
    const entry = this.entries.get(name);
    if (entry === undefined) {
      throw new UnknownToolError(name);
    }
    return entry;
  }
}

/** A registry seeded with the full frozen catalog — the default singleton WP-T01 consumes. */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry(TOOL_DESCRIPTORS);
}

/** Re-export for convenience: the catalog tool names + the always-available meta-trio. */
export { TOOL_NAMES, META_TOOLS };
