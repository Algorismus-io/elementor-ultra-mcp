/**
 * WP-F05 — `elementor.site.capabilities` tool handler + `elementor://site/capabilities` resource
 * backing + the `probeCapabilities()` helper (Seam E, the TS-side probe).
 *
 * Contract authority:
 *  - spec/contracts/13-tool-catalog.md §1.1 (`elementor.site.capabilities` tool: title/description,
 *    empty inputSchema, the normalized `outputSchema` field set).
 *  - spec/contracts/10-rest-api.md §12 (`GET /site/capabilities` RAW response `data`).
 *  - spec/contracts/12-error-taxonomy.md §3.4 (experiment slugs, EXPERIMENT_INACTIVE/PRO_REQUIRED).
 *  - spec/01-architecture.md §7 (capability/experiment gating OWNED by PHP; TS probes it BEFORE
 *    assuming any route exists — the v4 fallback ladder, RESEARCH.md §8).
 *
 * Pipeline: the tool calls `wp/routes.ts` `getSiteCapabilities(client)` (WP-F02 wrapper) which returns
 * the RAW {@link SiteCapabilitiesResponse} (10-rest-api.md §12); this module NORMALIZES it into the
 * frozen {@link Capabilities} shape (13-tool-catalog.md §1.1 outputSchema). On a client error it
 * routes through `wp/errors.ts` per the surface rules.
 *
 * The SDK 1.x registers tools via `server.registerTool(name, { title, description, inputSchema,
 * outputSchema, annotations }, handler)` where inputSchema/outputSchema are ZodRawShape MAPS (flat
 * `{ field: zodType }`), NOT `z.object(...)` (13-tool-catalog.md §0). This module exports those maps
 * + the handler as a descriptor so the server WP (WP-T01) wires it into the registry without F05
 * owning `server.ts`.
 */

import { z } from 'zod';

import {
  EXPERIMENT_SLUGS,
  type Capabilities,
  type SiteCapabilitiesResponse,
  type ExperimentState,
} from '@elementor-ultra/shared';

import { getSiteCapabilities } from '../wp/routes.js';
import { WpClient } from '../wp/client.js';
import { WpClientError } from '../wp/types.js';
import { fromClientError, type ToolResult } from '../wp/errors.js';
import type { ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';

/** The frozen tool name (13-tool-catalog.md §1.1). Downstream agents reuse this exact identifier. */
export const SITE_CAPABILITIES_TOOL_NAME = 'elementor.site.capabilities';

/** The frozen resource URI backing the same payload (13-tool-catalog.md §1.1 resource). */
export const SITE_CAPABILITIES_RESOURCE_URI = 'elementor://site/capabilities';

/* ───────────────────────────── tool schemas (ZodRawShape maps, §0/§1.1) ───────────────────── */

/** Empty inputSchema (13-tool-catalog.md §1.1: `inputSchema: {}`). */
export const siteCapabilitiesInputSchema = {} as const;

/**
 * The normalized `outputSchema` field map (13-tool-catalog.md §1.1) as a ZodRawShape. Keys match the
 * frozen {@link Capabilities} field set EXACTLY.
 */
export const siteCapabilitiesOutputSchema = {
  v4: z.boolean(),
  atomic: z.boolean(),
  global_classes: z.boolean(),
  variables: z.boolean(),
  pro: z.boolean(),
  pro_atomic_form: z.boolean(),
  breakpoints: z.array(
    z.object({
      key: z.string(),
      label: z.string().optional(),
      direction: z.enum(['min', 'max']),
      value: z.number(),
    }),
  ),
  experiments: z.record(z.string(), z.boolean()),
  can_update_class: z.boolean(),
  classes_migrated: z.boolean(),
  registered_types: z.object({
    atomic: z.array(z.string()),
    classic: z.array(z.string()),
  }),
  versions: z.object({
    elementor: z.string(),
    pro: z.string().nullable(),
    plugin: z.string(),
  }),
  unfiltered_html: z.boolean(),
  /** M-g (contract 18 §7) — Pro-license custom-css feature flag; absent on older plugins. */
  custom_css_licensed: z.boolean().optional(),
} as const;

/** The static descriptor the server WP feeds to `server.registerTool(...)` (13-tool-catalog.md §1.1). */
export const siteCapabilitiesToolDescriptor = {
  name: SITE_CAPABILITIES_TOOL_NAME,
  title: 'Probe site capabilities',
  description:
    'Report experiments, Pro presence, registered element types, breakpoints, capabilities, and migration state for the target site.',
  inputSchema: siteCapabilitiesInputSchema,
  outputSchema: siteCapabilitiesOutputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
} as const;

/* ───────────────────────────── RAW -> normalized mapping (§12 -> §1.1) ─────────────────────── */

/** True iff a RAW experiment state string means the experiment is active (10-rest-api.md §12). */
function experimentActive(state: ExperimentState | undefined): boolean {
  return state === 'active';
}

/**
 * Normalize the RAW REST `/site/capabilities` envelope (10-rest-api.md §12) into the frozen
 * {@link Capabilities} probe shape (13-tool-catalog.md §1.1 outputSchema). Maps the RAW names to the
 * normalized names (`v4_default`->`v4`, `atomic_available`->`atomic`, `pro_active`->`pro`), turns the
 * experiment string-state map into a boolean map (each known slug present), and re-splits
 * `registered_types.{elements,widgets}` into `{atomic,classic}`.
 */
export function normalizeCapabilities(raw: SiteCapabilitiesResponse): Capabilities {
  const experiments: Record<string, boolean> = {};
  // Ensure every known slug is present (callers gate on them); include any extra RAW slugs too.
  for (const slug of EXPERIMENT_SLUGS) {
    experiments[slug] = experimentActive(raw.experiments[slug]);
  }
  for (const [slug, state] of Object.entries(raw.experiments)) {
    experiments[slug] = experimentActive(state);
  }

  return {
    v4: raw.v4_default,
    atomic: raw.atomic_available,
    global_classes: raw.global_classes,
    variables: raw.variables,
    pro: raw.pro_active,
    pro_atomic_form: experimentActive(raw.experiments['e_pro_atomic_form']),
    breakpoints: raw.breakpoints.map((bp) => ({
      key: bp.key,
      ...(bp.label !== undefined ? { label: bp.label } : {}),
      direction: bp.direction,
      value: bp.value,
    })),
    experiments,
    can_update_class: raw.can_update_class,
    classes_migrated: raw.classes_migrated,
    registered_types: {
      atomic: raw.registered_types.elements,
      classic: raw.registered_types.widgets,
    },
    versions: {
      elementor: raw.elementor_version,
      pro: raw.pro_version,
      plugin: raw.plugin_version,
    },
    unfiltered_html: raw.unfiltered_html,
    // M-g: license-level custom-css availability. Absent on older companion plugins → omit (the
    // consumer defaults it to `pro` so behavior is unchanged against a pre-M-g plugin).
    ...(raw.custom_css_licensed !== undefined
      ? { custom_css_licensed: raw.custom_css_licensed }
      : {}),
  };
}

/* ───────────────────────────── probe helper (arch §7) ─────────────────────────────────────── */

/**
 * Fetch + normalize the target site's capabilities (01-architecture.md §7). This is the MANDATORY
 * precondition probe other tool WPs call BEFORE assuming a route exists — the v4 fallback ladder and
 * the EXPERIMENT_INACTIVE / PRO_REQUIRED gating ladders read this. Throws the underlying
 * {@link WpClientError} on failure (the caller decides whether to surface it via `wp/errors.ts`).
 *
 * @param client A configured {@link WpClient} for the target site.
 */
export async function probeCapabilities(client: WpClient): Promise<Capabilities> {
  const raw = await getSiteCapabilities(client);
  return normalizeCapabilities(raw);
}

/* ───────────────────────────── tool handler (§1.1) ───────────────────────────────────────── */

/** Whether a thrown value is a {@link WpClientError} (carries a taxonomy `payload`). */
function isWpClientError(value: unknown): value is WpClientError {
  return value instanceof WpClientError;
}

/**
 * The `elementor.site.capabilities` tool handler (13-tool-catalog.md §1.1). Probes the site, returns
 * the normalized {@link Capabilities} as `structuredContent` plus a human-readable text summary. On a
 * client error it routes through `wp/errors.ts` (`fromClientError`) so the surface rules
 * (12-error-taxonomy.md §5) decide protocol-throw vs isError-result.
 *
 * @param client A configured {@link WpClient} for the target site.
 */
export async function siteCapabilitiesHandler(client: WpClient): Promise<ToolResult> {
  let capabilities: Capabilities;
  try {
    capabilities = await probeCapabilities(client);
  } catch (error: unknown) {
    if (isWpClientError(error)) {
      return fromClientError(error);
    }
    throw error;
  }

  return {
    content: [{ type: 'text', text: summarizeCapabilities(capabilities) }],
    structuredContent: capabilities as unknown as Record<string, unknown>,
  };
}

/** A compact one-line human summary of the probe result (for the tool's text content). */
export function summarizeCapabilities(c: Capabilities): string {
  const activeExperiments = Object.entries(c.experiments)
    .filter(([, active]) => active)
    .map(([slug]) => slug);
  return [
    `v4=${c.v4}`,
    `atomic=${c.atomic}`,
    `pro=${c.pro}`,
    `global_classes=${c.global_classes}`,
    `variables=${c.variables}`,
    `can_update_class=${c.can_update_class}`,
    `classes_migrated=${c.classes_migrated}`,
    `experiments_active=[${activeExperiments.join(', ')}]`,
  ].join(' ');
}

/**
 * Resource backing for `elementor://site/capabilities` (13-tool-catalog.md §1.1). Returns the
 * normalized {@link Capabilities} payload as the resource contents; the server WP wraps it in the SDK
 * resource envelope. Throws the underlying error on failure.
 *
 * @param client A configured {@link WpClient} for the target site.
 */
export async function siteCapabilitiesResource(client: WpClient): Promise<Capabilities> {
  return probeCapabilities(client);
}

/**
 * Attach the F05-owned `elementor.site.capabilities` handler to the WP-F04 registry. The handler takes
 * a raw {@link WpClient} (capability probing is a bespoke flow), so we adapt it to the registry's
 * `(args, ctx)` runtime signature by pulling `ctx.wp.client` (the raw client on the bound route facade).
 * Called from the server-core (a0) attach block — without this the most-called probe tool boots as a
 * descriptor but is not callable.
 */
export function attachCapabilitiesHandlers(registry: ToolRegistry): void {
  // Mirror the discovery attach pattern: build the (args, ctx) adapter and cast to the registry's loose
  // `(args) => unknown` handler shape (the server-core invokes it as `(args, ctx)` at call time).
  const handler = (_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> =>
    siteCapabilitiesHandler(ctx.wp.client);
  registry.attachHandler(
    SITE_CAPABILITIES_TOOL_NAME,
    handler as unknown as (args: Record<string, unknown>) => unknown,
  );
}
