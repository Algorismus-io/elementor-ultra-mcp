/**
 * WP-Q03 — MCP Inspector smoke DRIVER (`14-fixtures-harness.md §8`, `13-tool-catalog.md §5.2`).
 *
 * The thin SDK-client driver the smoke TEST (`smoke.test.ts`) drives. It launches the BUILT TypeScript
 * server over stdio (the same transport `@modelcontextprotocol/inspector` uses; we use the SDK `Client`
 * so the suite has no runtime dependency on the Inspector CLI, which stays the manual/dev tool) with the
 * App-Password env (`WP_URL`/`WP_USER`/`WP_APP_PASSWORD`, `13-tool-catalog.md §5.4`) + `ULTRA_TOOLS=lean`,
 * and exposes the §Interface helpers `listTools()`, `callTool(name, payload)`, `readResource(uri)`,
 * `listPrompts()`.
 *
 * RESPONSIBILITIES OWNED HERE (Q03 only):
 *  - connect/teardown the stdio client;
 *  - load the §8 smoke ENVELOPES (`fixtures/envelopes/smoke.*.json`, `kind:"smoke"`) via the F06
 *    fixture-loader (Q03 ADDS payloads + this driver; it never edits F06's `inspector-smoke.ts`);
 *  - manage the DISPOSABLE DRAFT (created in setup, trashed in teardown — even on failure) the mutating
 *    smokes target, and the placeholder TOKEN substitution that injects its live ids/base_hash;
 *  - capability + grow-green GATING: skip a smoke whose `requires` are unmet, whose tool is not enabled
 *    in the profile, or whose handler is not yet attached (the catalog boots before every vertical lands
 *    — `§Detailed Requirements 7`);
 *  - the catalog-driven INPUT-SCHEMA self-check (`§Tests Required` / DoD: each smoke payload validates
 *    against its tool's `inputSchema`).
 *
 * NOTE: this module is import-light and side-effect free at module scope so it can be a library the test
 * imports; the actual vitest assertions live in `smoke.test.ts`.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import {
  LEAN_STAR_TOOLS as F04_LEAN_STAR_TOOLS,
  META_TOOLS as F04_META_TOOLS,
} from '../catalog/profiles.js';
import { RESOURCE_DESCRIPTORS } from '../catalog/resources.js';
import { PROMPT_NAMES as F04_PROMPT_NAMES } from '../catalog/prompts.js';
import {
  loadFixturesByKind,
  isFixtureRunnable,
  type LoadedFixture,
  type CapabilitySnapshot,
} from './fixture-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the built server bin (`packages/server/dist/index.js`). */
export const SERVER_BIN = resolve(HERE, '..', '..', 'dist', 'index.js');

/* ───────────────────────────── frozen protocol-surface expectations (from F04 catalog) ─────────
 *
 * Sourced from the WP-F04 catalog modules (the authoritative, SIDE-EFFECT-FREE surface) rather than
 * F06's `inspector-smoke.ts` — importing that module would execute its top-level `describe(...)` block
 * inside this driver's importer (the smoke TEST), double-registering F06's suite. The values are
 * IDENTICAL to F06's frozen constants by construction (both derive from Contract 13 §5.2/§2/§3).
 */

/** The lean ★ default set (Contract 13 §5.2) — the 18 tools enabled at boot under `ULTRA_TOOLS=lean`. */
export const LEAN_STAR_TOOLS: readonly string[] = F04_LEAN_STAR_TOOLS;

/** The always-available meta-trio (Contract 13 §5.2/§6). */
export const META_TOOLS: readonly string[] = F04_META_TOOLS;

/** All four prompt names (Contract 13 §3), from the F04 prompt catalog. */
export const PROMPT_NAMES: readonly string[] = F04_PROMPT_NAMES;

/**
 * The STATIC (non-parametric) `elementor://...` resource URIs (Contract 13 §2) — the subset readable
 * with no `{type}`/`{id}` argument, so the §8(c) check reads them unconditionally. Parametric resources
 * (`schema/widget/{type}`, `page/{id}/structure`) require a live type/draft id and are exercised via
 * their backing tools (`schema.widget`, `page.get_structure`) in §8(b).
 */
export const RESOURCE_URIS: readonly string[] = RESOURCE_DESCRIPTORS.filter(
  (r) => !r.uri.includes('{'),
).map((r) => r.uri);

/* ───────────────────────────── placeholder tokens (disposable-draft injection) ────────────── */

/**
 * Tokens a smoke payload uses for fields that can only be known at RUN time (the live disposable
 * draft's id, its root container id, an existing widget id, the fresh optimistic-lock base_hash). The
 * driver substitutes these from the live draft before a mutating smoke call. For the OFFLINE
 * input-schema self-check (no server), {@link substituteForSchemaCheck} substitutes them with
 * type-correct stand-ins so the payload validates against the tool's `inputSchema`.
 */
export const TOKENS = {
  postId: '{{DRAFT_POST_ID}}',
  parentId: '{{DRAFT_PARENT_ID}}',
  elementId: '{{DRAFT_ELEMENT_ID}}',
  baseHash: '{{DRAFT_BASE_HASH}}',
} as const;

/** Type-correct stand-ins for the offline input-schema self-check (`§Tests Required`). */
const TOKEN_SCHEMA_STANDINS: Record<string, unknown> = {
  [TOKENS.postId]: 1,
  [TOKENS.parentId]: 'root',
  [TOKENS.elementId]: 'abc1234',
  [TOKENS.baseHash]: '0123456789abcdef0123456789abcdef',
};

/** The live values the driver injects into a mutating smoke payload at call time. */
export interface DraftHandles {
  postId: number;
  parentId: string;
  elementId: string;
  baseHash: string;
}

/** Recursively replace every token string in `value` using the supplied `map` (token → replacement). */
function substituteTokens(value: unknown, map: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    return map.has(value) ? map.get(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteTokens(v, map));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteTokens(v, map);
    }
    return out;
  }
  return value;
}

/** Substitute draft tokens in a payload with the LIVE draft handles (for the real call). */
export function substituteForCall(
  args: Record<string, unknown>,
  draft: DraftHandles,
): Record<string, unknown> {
  const map = new Map<string, unknown>([
    [TOKENS.postId, draft.postId],
    [TOKENS.parentId, draft.parentId],
    [TOKENS.elementId, draft.elementId],
    [TOKENS.baseHash, draft.baseHash],
  ]);
  return substituteTokens(args, map) as Record<string, unknown>;
}

/** Substitute draft tokens with type-correct stand-ins (for the offline input-schema self-check). */
export function substituteForSchemaCheck(args: Record<string, unknown>): Record<string, unknown> {
  const map = new Map<string, unknown>(Object.entries(TOKEN_SCHEMA_STANDINS));
  return substituteTokens(args, map) as Record<string, unknown>;
}

/** Whether a payload references ANY disposable-draft token (⇒ it is a draft-targeting mutating smoke). */
export function usesDraftTokens(args: Record<string, unknown>): boolean {
  const json = JSON.stringify(args);
  return Object.values(TOKENS).some((t) => json.includes(t));
}

/* ───────────────────────────── smoke envelope loading ──────────────────────────────────────── */

/** A loaded smoke envelope keyed by its target tool name (the `tool` field, `§2`). */
export interface SmokeEnvelope {
  tool: string;
  arguments: Record<string, unknown>;
  fixture: LoadedFixture;
}

/**
 * Load every `kind:"smoke"` envelope under `fixtures/envelopes/` (Q03's 16 + WP-H12's 2 `convert.*`),
 * keyed by `tool`. Skips any envelope without a `tool`/`arguments` (malformed). Throws on a duplicate
 * `tool` (two payloads for one tool is a corpus bug).
 */
export function loadSmokeEnvelopes(): Map<string, SmokeEnvelope> {
  const out = new Map<string, SmokeEnvelope>();
  for (const fixture of loadFixturesByKind('smoke')) {
    const tool = fixture.envelope.tool;
    const args = fixture.envelope.arguments;
    if (typeof tool !== 'string' || args === undefined) {
      continue;
    }
    if (out.has(tool)) {
      throw new Error(`Duplicate smoke envelope for tool "${tool}" (${fixture.path})`);
    }
    out.set(tool, { tool, arguments: args, fixture });
  }
  return out;
}

/** Whether a smoke envelope's `requires` are met on the given capability snapshot (`§2` gate). */
export function smokeRunnable(env: SmokeEnvelope, caps: CapabilitySnapshot): boolean {
  return isFixtureRunnable(env.fixture.envelope, caps);
}

/* ───────────────────────────── catalog-driven input-schema self-check ───────────────────────── */

/** A single input-schema validation problem for the self-check. */
export interface SmokeSchemaIssue {
  tool: string;
  issues: string[];
}

/**
 * Validate every smoke payload against its tool's `inputSchema` (the WP-F04 catalog ZodRawShape),
 * using type-correct stand-ins for the disposable-draft tokens. This is the `fixtures:validate`-adjacent
 * DoD check (`§Acceptance Criteria` / `§Tests Required`) and runs WITHOUT a server. Returns the list of
 * failing tools (empty ⇒ all payloads are minimal+valid against their tool input).
 *
 * @param registry The WP-F04 tool registry (defaults to a fresh full catalog).
 */
export function checkSmokeInputSchemas(
  registry: ToolRegistry = createToolRegistry(),
): SmokeSchemaIssue[] {
  const failures: SmokeSchemaIssue[] = [];
  for (const env of loadSmokeEnvelopes().values()) {
    if (!registry.has(env.tool)) {
      failures.push({ tool: env.tool, issues: ['tool not present in the frozen catalog'] });
      continue;
    }
    const shape = registry.getDescriptor(env.tool).inputSchema;
    const schema = z.object(shape);
    const candidate = substituteForSchemaCheck(env.arguments);
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      failures.push({
        tool: env.tool,
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
      });
    }
  }
  return failures;
}

/* ───────────────────────────── SDK client (stdio) ──────────────────────────────────────────── */

/** Whether the App-Password env required to drive a LIVE smoke is present (`§5.4`). */
export function envReady(): boolean {
  return Boolean(process.env['WP_URL'] && process.env['WP_USER'] && process.env['WP_APP_PASSWORD']);
}

/** Whether the built server bin exists (`pnpm build` ran). */
export function serverBuilt(): boolean {
  return existsSync(SERVER_BIN);
}

/** The minimal SDK `Client` surface this driver uses. */
export interface SmokeClient {
  close(): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  listPrompts(): Promise<{ prompts: Array<{ name: string }> }>;
  readResource(args: { uri: string }): Promise<{ contents?: unknown[] } & Record<string, unknown>>;
  callTool(args: { name: string; arguments: Record<string, unknown> }): Promise<CallToolOutcome>;
}

/** The shape of a tool-call RESULT (no protocol error reached us — those would throw). */
export interface CallToolOutcome {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string } & Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Launch the built server over stdio with `ULTRA_TOOLS=lean` + the App-Password env, and return a
 * connected SDK client wrapper exposing the §Interface helpers. Returns `null` if the server bin is
 * absent or the SDK fails to connect (the test then SKIPs — grow-green, `§Detailed Requirements 7`).
 */
export async function connectSmokeClient(): Promise<SmokeClient | null> {
  if (!serverBuilt()) {
    return null;
  }
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_BIN],
      env: { ...process.env, ULTRA_TOOLS: 'lean' },
    });
    const client = new Client(
      { name: 'elementor-ultra-smoke', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client as unknown as SmokeClient;
  } catch {
    return null;
  }
}

/* ───────────────────────────── grow-green: handler-not-attached detection ───────────────────── */

/**
 * The sentinel phrase the server core (WP-T01) returns as an `isError` RESULT for a tool whose handler
 * is not yet attached ("the catalog can boot before every vertical lands", `server.ts`). The smoke
 * suite treats this as a SKIP (not a fail) so coverage grows green as verticals land
 * (`§Detailed Requirements 7`). NOT a protocol error — `callTool` does not throw here.
 */
export const HANDLER_NOT_ATTACHED_PHRASE = 'handler is not yet attached';

/** Whether a tool-call outcome is the "handler not yet attached" grow-green sentinel (⇒ SKIP). */
export function isHandlerNotAttached(outcome: CallToolOutcome): boolean {
  if (outcome.isError !== true) {
    return false;
  }
  const text = (outcome.content ?? []).map((c) => c.text ?? '').join(' ');
  if (text.includes(HANDLER_NOT_ATTACHED_PHRASE)) {
    return true;
  }
  const structured = outcome.structuredContent;
  const msg = typeof structured?.['message'] === 'string' ? structured['message'] : '';
  return msg.includes(HANDLER_NOT_ATTACHED_PHRASE);
}

/**
 * The SDK Client validates a tool result's `structuredContent` against the tool's declared
 * `outputSchema` and THROWS `McpError -32602 "Structured content does not match the tool's output
 * schema"` on a mismatch. During GROW-GREEN, a tool whose handler is not yet attached returns the
 * generic INTERNAL_ERROR isError payload, whose structured shape does NOT match the tool's real
 * outputSchema — so the SDK throws this BEFORE our `isHandlerNotAttached` check can see the result. This
 * recognizes that specific grow-green throw so the suite SKIPs rather than fails (`§Detailed
 * Requirements 7`). It does NOT swallow other protocol faults.
 */
export function isGrowGreenSchemaThrow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("does not match the tool's output schema") ||
    message.includes('Structured content does not match')
  );
}

/** The outcome of a guarded smoke call: either a usable result, or a grow-green SKIP reason. */
export type SafeCall =
  | { kind: 'result'; outcome: CallToolOutcome }
  | { kind: 'skip'; reason: string };

/**
 * Call a tool, classifying the two grow-green outcomes as SKIP (handler not attached — surfaced either
 * as an isError result OR as the SDK output-schema-mismatch throw) and letting every other protocol
 * error propagate (a genuine failure the suite must surface). On a clean result, returns it for the
 * caller's `outputSchema`/`isError` assertions (`§8(b)`).
 */
export async function safeCallTool(
  client: SmokeClient,
  name: string,
  args: Record<string, unknown>,
): Promise<SafeCall> {
  let outcome: CallToolOutcome;
  try {
    outcome = await client.callTool({ name, arguments: args });
  } catch (error) {
    if (isGrowGreenSchemaThrow(error)) {
      return {
        kind: 'skip',
        reason: 'handler not yet attached (output-schema mismatch, grow-green)',
      };
    }
    throw error; // a real protocol fault (-326xx) — the §8(b) hard-fail.
  }
  if (isHandlerNotAttached(outcome)) {
    return { kind: 'skip', reason: 'handler not yet attached (grow-green)' };
  }
  return { kind: 'result', outcome };
}

/* ───────────────────────────── disposable draft (setup / teardown) ──────────────────────────── */

/** The minimal atomic heading tree the disposable draft is built from (strictly typed, [R8]/S01). */
function disposableDraftElements(): unknown[] {
  return [
    {
      id: 'smdrft1',
      elType: 'widget',
      widgetType: 'e-heading',
      settings: {
        classes: { $$type: 'classes', value: [] },
        tag: { $$type: 'string', value: 'h1' },
        title: {
          $$type: 'html-v3',
          value: { content: { $$type: 'string', value: 'Smoke draft' }, children: [] },
        },
      },
      styles: {},
      editor_settings: [],
      interactions: [],
      elements: [],
    },
  ];
}

/**
 * Create the DISPOSABLE DRAFT the mutating smokes target (`§8`/`§Detailed Requirements 5`). Builds a
 * one-heading v4 page via `page.build` (status:'draft'), then re-reads `page.get_structure` to capture
 * the live root container id, an existing widget id, and a FRESH `base_hash` (NEVER cached — S02/R5:
 * ids are not stable across save). Returns `null` if the draft cannot be created (the suite then SKIPs
 * the mutating smokes — grow-green: the build/structure handlers may not be attached yet).
 *
 * Records the created post id into `createdPostIds` so teardown trashes it even on later failure.
 */
export async function createDisposableDraft(
  client: SmokeClient,
  createdPostIds: number[],
): Promise<DraftHandles | null> {
  const built = await safeCallTool(client, 'elementor.page.build', {
    title: 'Ultra MCP smoke disposable draft',
    status: 'draft',
    generation: 'v4',
    elements: disposableDraftElements(),
  });
  if (built.kind === 'skip' || built.outcome.isError === true) {
    return null; // handler not attached / REST not wired yet ⇒ SKIP mutating smokes.
  }
  const postId = numberField(built.outcome.structuredContent, 'id');
  if (postId === undefined) {
    return null;
  }
  createdPostIds.push(postId);

  const structure = await safeCallTool(client, 'elementor.page.get_structure', { post_id: postId });
  if (structure.kind === 'skip' || structure.outcome.isError === true) {
    return null;
  }
  const sc = structure.outcome.structuredContent ?? {};
  const baseHash = typeof sc['base_hash'] === 'string' ? sc['base_hash'] : undefined;
  const ids = firstContainerAndWidgetIds(sc['elements']);
  if (baseHash === undefined || ids === null) {
    return null;
  }
  return { postId, parentId: ids.parentId, elementId: ids.widgetId, baseHash };
}

/** Read a numeric field from a structured-content object (or `undefined`). */
function numberField(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = obj?.[key];
  return typeof v === 'number' ? v : undefined;
}

/**
 * From the live `get_structure.elements`, find a parent container id (the outermost element) and a
 * child widget id (the seed heading). Returns `null` if the tree shape is unexpected. The widget.insert
 * smoke targets the container; widget.update_settings targets the widget.
 */
function firstContainerAndWidgetIds(
  elements: unknown,
): { parentId: string; widgetId: string } | null {
  if (!Array.isArray(elements) || elements.length === 0) {
    return null;
  }
  const root = elements[0] as Record<string, unknown>;
  const rootId = typeof root['id'] === 'string' ? root['id'] : undefined;
  if (rootId === undefined) {
    return null;
  }
  // Prefer a nested widget child as the update target; fall back to the root itself.
  const children = Array.isArray(root['elements']) ? (root['elements'] as unknown[]) : [];
  const child = children.find((c) => typeof (c as Record<string, unknown>)?.['id'] === 'string') as
    | Record<string, unknown>
    | undefined;
  const widgetId = child !== undefined && typeof child['id'] === 'string' ? child['id'] : rootId;
  return { parentId: rootId, widgetId };
}

/**
 * Trash every disposable doc + sideloaded attachment created during the run (teardown — runs even on
 * failure, `§Implementation Notes`). Best-effort: each delete is wrapped so one failure never aborts the
 * rest. Uses `page.delete` (force_delete:true to skip trash) and `media` cleanup where available.
 */
export async function teardownDisposables(
  client: SmokeClient,
  createdPostIds: readonly number[],
): Promise<void> {
  for (const postId of createdPostIds) {
    try {
      await client.callTool({
        name: 'elementor.page.delete',
        arguments: { post_id: postId, confirm: true, force_delete: true },
      });
    } catch {
      /* best-effort teardown */
    }
  }
}
