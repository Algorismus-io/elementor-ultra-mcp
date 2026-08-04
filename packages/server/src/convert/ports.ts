/**
 * WP-H11 — the convert PORTS: the side-effect adapters the orchestrator (`pipeline.ts`) and the pure
 * stages (WP-H03..H10) consume, each a THIN typed wrapper over the WP-F02 bound route facade
 * (`ToolContext.wp`, built from `wp/routes.ts` — WP-T02).
 *
 * OWNERSHIP / SEAM (WP-H11 §Detailed Requirements 5, §9): this module (and `pipeline.ts`) are the ONLY
 * HTML-pipeline code that touch the WP client. The pure stages receive ports/VALUES only — they never
 * import the client — which keeps every stage independently unit-testable. `buildPorts(ctx)` constructs
 * the port bundle ONCE from the runtime `ToolContext`; the orchestrator passes the individual ports to
 * the stages (`MediaPort`/`IdPort` into ASSEMBLE; the rest it calls directly).
 *
 * `MediaPort` + `IdPort` are the FROZEN seam shapes from `convert/types.ts` (WP-H01 / WP-H08); the
 * remaining ports are declared here (the contract refers to them as `DesignPort`/`DocumentPort`/
 * `SchemaPort`/`BrowserPort`). The `BrowserPort` is the WP-H03 shared Playwright pool (reused by PARSE +
 * the fidelity gate — never a second browser).
 *
 * Contract authority: 10-rest-api.md §2 (Documents: create / dry-run / replace-tree / prime-css /
 * get_structure base_hash), §3 (Schema: styles / breakpoints), §4 (Design: classes diff-PUT,
 * variables batch + watermark), §5 (Media: sideload), §12 (site/capabilities); WP-H11 §Interface.
 */

import { withPage as defaultWithPage } from './browser-pool.js';
import type { AssembleContext, IdPort as IdPortType, MediaPort as MediaPortType } from './types.js';
import type { BrowserPort } from './fidelity.js';
import { buildComposioFigmaPort, type FigmaPort as FigmaPortType } from './figma-client.js';

import type { ToolContext } from '../runtime/context.js';
import type {
  BatchVariablesRequest,
  BatchVariablesResponse,
  Capabilities,
  CreateDocumentRequest,
  CreateDocumentResponse,
  DryRunRequest,
  DryRunResponse,
  GetDocumentResponse,
  ListGlobalClassesResponse,
  ListVariablesResponse,
  PrimeCssRequest,
  PrimeCssResponse,
  PutGlobalClassesRequest,
  PutGlobalClassesResponse,
  ReplaceTreeRequest,
  ReplaceTreeResponse,
  SaveDocumentRequest,
  SaveDocumentResponse,
  SchemaBreakpointsResponse,
  SchemaStylesResponse,
  UpdateDocumentSettingsRequest,
  UpdateDocumentSettingsResponse,
  ValidateIdsRequest,
} from '@elementor-ultra/shared';

/* ───────────────────────────── re-exported frozen seam shapes ─────────────────────────────── */

/** The ASSEMBLE media seam (WP-H08 / `convert/types.ts`). Re-exported so callers import from one place. */
export type MediaPort = MediaPortType;
/** The ASSEMBLE id seam (WP-H08 / `convert/types.ts`). */
export type IdPort = IdPortType;
/** The WP-H03 browser-pool seam (re-exported from the fidelity gate). */
export type { BrowserPort };
/**
 * Contract 18 §4 — the Figma EXTRACTION seam (re-exported from `convert/figma-client.ts` so callers
 * import every port from one place). Three Composio READ slugs + one binary download; the 13 write
 * slugs are HARD-DENIED inside the client (allowlist, not denylist). NOT WP-bound: it talks to the
 * Composio backend (env `COMPOSIO_API_KEY`/`COMPOSIO_FIGMA_USER`), never to `ToolContext.wp`.
 */
export type FigmaPort = FigmaPortType;

/* ───────────────────────────── DesignPort (10-rest-api.md §4) ──────────────────────────────── */

/**
 * The design-system port: list/diff-PUT global classes (§4.1/§4.2) and list/batch global variables
 * (§4.4). The orchestrator reads the EXISTING classes/variables to drive HOIST/VARIABLE-EXTRACT reuse,
 * then (only on commit) creates the proposed ones — variables FIRST (batch + watermark), then classes
 * (diff-PUT), capturing the real minted ids to resolve the `__var:`/`__class:` placeholders.
 */
export interface DesignPort {
  /** `GET /design/classes` — the full current class set + the authoritative `order[]` (diff-PUT needs both). */
  listClasses(): Promise<ListGlobalClassesResponse>;
  /** `PUT /design/classes` — the diff-PUT (touched-only `items`, full `order`); returns `modified_labels`. */
  upsertClasses(body: PutGlobalClassesRequest): Promise<PutGlobalClassesResponse>;
  /** `GET /design/variables` — the current variables map + the optimistic-lock `watermark`. */
  listVariables(): Promise<ListVariablesResponse>;
  /** `POST /design/variables/batch` — create the proposed variables (watermark REQUIRED). */
  batchVariables(body: BatchVariablesRequest): Promise<BatchVariablesResponse>;
  /** `GET /design/fonts` — list non-catalog font families installed on this site. */
  listInstalledFonts(): Promise<string[]>;
}

/* ───────────────────────────── DocumentPort (10-rest-api.md §2) ────────────────────────────── */

/**
 * The document port: create a page, run the AUTHORITATIVE dry_run, persist (create-then-save for a new
 * page OR replace-tree for an existing one), prime the atomic CSS (mandatory, WP-S01), and read the
 * current structure for the optimistic-lock `base_hash`. The orchestrator NEVER caches ids across a save
 * (they regenerate, S01/R5) — it re-reads from the save response.
 */
export interface DocumentPort {
  /** `POST /documents` — create a blank page; returns its id + edit url. */
  create(body: CreateDocumentRequest): Promise<CreateDocumentResponse>;
  /** `GET /documents/{id}` — the live tree + the optimistic-lock `base_hash` (read right before replace). */
  getStructure(id: number): Promise<GetDocumentResponse>;
  /** `POST /documents/{id}/dry-run` — the AUTHORITATIVE validity check (`{id}` may be 0 for a new tree). */
  dryRun(id: number, body: DryRunRequest): Promise<DryRunResponse>;
  /** `POST /documents/{id}/save` — persist (used for a freshly-created page, no base_hash contention). */
  save(id: number, body: SaveDocumentRequest): Promise<SaveDocumentResponse>;
  /** `POST /documents/{id}/replace-tree` — replace an existing tree (base_hash REQUIRED, optimistic lock). */
  replaceTree(id: number, body: ReplaceTreeRequest): Promise<ReplaceTreeResponse>;
  /** `POST /documents/{id}/prime-css` — prime atomic CSS after a save (mandatory, S01); returns `css_primed`. */
  primeCss(id: number, body?: PrimeCssRequest): Promise<PrimeCssResponse>;
  /**
   * `PUT /documents/{id}/settings` — deep-merge document settings (contract 17 §3 R3: the verify
   * loop's commit gate reverts a failed conversion to `post_status: draft` — never a raw meta write).
   */
  updateSettings(
    id: number,
    body: UpdateDocumentSettingsRequest,
  ): Promise<UpdateDocumentSettingsResponse>;
}

/* ───────────────────────────── SchemaPort (10-rest-api.md §3 / §12) ────────────────────────── */

/**
 * The schema/capability port: the live Style-Schema (STYLE-EXTRACT classifies declarations against it),
 * the active breakpoints (PARSE re-renders + STYLE-EXTRACT resolves responsive props against them), and
 * the normalized site-capabilities probe (MAP gates Pro/experiment targets; the orchestrator chooses
 * `generation` + gates the class-write capability on it).
 */
export interface SchemaPort {
  /** `GET /schema/styles` — the live atomic Style-Schema (props / units / states). */
  styles(): Promise<SchemaStylesResponse>;
  /** `GET /schema/breakpoints` — the active breakpoint set + direction. */
  breakpoints(): Promise<SchemaBreakpointsResponse>;
  /** The NORMALIZED capabilities probe (memoized by `CapabilitiesCache`, M6 gating). */
  capabilities(): Promise<Capabilities>;
}

/* ───────────────────────────── the port bundle ────────────────────────────────────────────── */

/**
 * The injected REST adapters the orchestrator threads through the pipeline (WP-H11 §Interface). Built
 * once from the runtime `ToolContext` by {@link buildPorts}; the pure stages receive the individual
 * ports (never the bundle, never the client).
 */
export interface ConvertPorts {
  media: MediaPort;
  ids: IdPort;
  design: DesignPort;
  document: DocumentPort;
  schema: SchemaPort;
  browser: BrowserPort;
  /**
   * Contract 18 §4 — the Figma extraction port (the `convert.figma_to_*` front-end's ONLY upstream
   * seam). ALWAYS present on the production bundle ({@link buildPorts} wires the env-configured
   * Composio client); typed optional because the HTML pipeline never touches it, so HTML-path tests
   * construct the bundle without one. A missing `COMPOSIO_API_KEY` is detected at CALL time inside
   * the client (a typed `config` error), never at bundle-build time.
   */
  figma?: FigmaPort;
}

/* ───────────────────────────── buildPorts (the only client-coupled seam) ───────────────────── */

/**
 * Build the {@link ConvertPorts} bundle from the runtime {@link ToolContext}. Each method is a thin
 * proxy over the WP-F02 bound route facade (`ctx.wp.*`) — NO business logic (that lives in the stages /
 * orchestrator). The `MediaPort`/`IdPort` adapt the REST shapes to the FROZEN ASSEMBLE seam:
 *  - `MediaPort.sideloadUrl` → `POST /media/sideload` → `{ id: attachment_id, url }` (deduped server-side);
 *  - `MediaPort.upload` → `POST /media/upload` (base64);
 *  - `IdPort.mint` is a PURE local minter (no REST) over the live used-id set (`AssembleContext`);
 *  - `IdPort.validate` → `POST /ids/validate` → the collisions list (best-effort cross-document hint).
 *
 * The `BrowserPort` is the WP-H03 shared pool (`browser-pool.withPage`) — the SAME instance PARSE +
 * the fidelity gate use (never a second browser).
 */
export function buildPorts(ctx: ToolContext): ConvertPorts {
  const media: MediaPort = {
    async sideloadUrl(url: string, alt?: string): Promise<{ id: number; url: string }> {
      const data = await ctx.wp.sideloadMedia({
        url,
        ...(alt !== undefined ? { alt } : {}),
      });
      return { id: data.attachment_id, url: data.url };
    },
    async upload(bytes: Uint8Array, filename: string): Promise<{ id: number; url: string }> {
      const data = await ctx.wp.uploadMedia({
        data: Buffer.from(bytes).toString('base64'),
        filename,
      });
      return { id: data.attachment_id, url: data.url };
    },
  };

  const ids: IdPort = {
    // Pure local mint — a fresh charset-valid `e-*` id not already in `existing` (no REST round-trip).
    mint(existing: Set<string>): string {
      return mintLocalElementId(existing);
    },
    // Best-effort cross-document collision hint: POST the (so-far-minted) ids and return the collisions
    // the live document set already holds, so ASSEMBLE can avoid them. A failure is swallowed by the
    // ASSEMBLE caller (it wraps this in try/catch) — validate is advisory, never load-bearing.
    async validate(idsList: string[]): Promise<string[]> {
      // `POST /ids/validate` expects an `elements[]` tree, not a bare id list; we wrap each id as a
      // minimal placeholder node so PHP can report collisions against the live set. When the list is
      // empty there is nothing to validate — return [] without a round-trip.
      if (idsList.length === 0) {
        return [];
      }
      const body: ValidateIdsRequest = {
        elements: idsList.map((id) => ({
          id,
          elType: 'e-div-block',
          settings: {},
        })),
      };
      const resp = await ctx.wp.validateIds(body);
      return resp.collisions;
    },
  };

  const design: DesignPort = {
    listClasses: () => ctx.wp.listGlobalClasses({ context: 'frontend' }),
    upsertClasses: (body) => ctx.wp.putGlobalClasses(body),
    listVariables: () => ctx.wp.listVariables(),
    batchVariables: (body) => ctx.wp.batchVariables(body),
    listInstalledFonts: async () => {
      const data = await ctx.wp.listInstalledFonts();
      return data.families;
    },
  };

  const document: DocumentPort = {
    create: (body) => ctx.wp.createDocument(body),
    getStructure: (id) => ctx.wp.getDocument(id),
    dryRun: (id, body) => ctx.wp.dryRunDocument(id, body),
    save: (id, body) => ctx.wp.saveDocument(id, body),
    replaceTree: (id, body) => ctx.wp.replaceTree(id, body),
    primeCss: (id, body) => ctx.wp.primeCss(id, body),
    updateSettings: (id, body) => ctx.wp.updateDocumentSettings(id, body),
  };

  const schema: SchemaPort = {
    styles: () => ctx.wp.schemaStyles(),
    breakpoints: () => ctx.wp.schemaBreakpoints(),
    capabilities: () => ctx.capabilities.get(),
  };

  const browser: BrowserPort = { withPage: defaultWithPage };

  // Contract 18 §4 — the env-configured Composio Figma extraction port. Construction is free of
  // env/network access (credentials resolve per call), so it is safe to build unconditionally.
  const figma: FigmaPort = buildComposioFigmaPort();

  return { media, ids, design, document, schema, browser, figma };
}

/* ───────────────────────────── local element-id minter ────────────────────────────────────── */

/**
 * Mint a fresh charset-valid Elementor element id (`e-<hex>`) not present in `existing`. Charset-safe
 * (`/^[A-Za-z][A-Za-z0-9_-]*$/`); collision-checked against the in-flight used-id set. PURE + local —
 * the authoritative collision avoidance is PHP's on save (ids regenerate, S01/R5); this only minimizes
 * in-tree collisions during ASSEMBLE. The 7-hex body matches the WP-H08 minted-id shape.
 */
function mintLocalElementId(existing: Set<string>): string {
  for (let attempt = 0; attempt < 100000; attempt++) {
    const id = `e-${randomHex(7)}`;
    if (!existing.has(id)) {
      return id;
    }
  }
  // Practically unreachable (2^28 space); deterministic last resort widens the body.
  let id = `e-${randomHex(12)}`;
  while (existing.has(id)) {
    id = `e-${randomHex(12)}`;
  }
  return id;
}

/** A short lowercase-hex token of `n` chars (uses `Math.random` — id uniqueness, not crypto). */
function randomHex(n: number): string {
  let s = '';
  while (s.length < n) {
    s += Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  }
  return s.slice(0, n);
}

/* Keep `AssembleContext` imported (the `IdPort.mint(existing)` signature is the `AssembleContext.ids`
 * seam) without tripping `noUnusedLocals` — referenced here as documentation of the seam. */
export type AssembleIdSeam = AssembleContext['ids'];
