/**
 * Contract 18 §4 — the Composio Figma EXTRACTION client (fetch-to-file).
 *
 * The figma front-end's ONLY upstream seam: three READ slugs executed over Composio's REST execute
 * endpoint (`POST {base}/api/v3/tools/execute/{SLUG}`, header `x-api-key`). Everything else — and in
 * particular the 13 write slugs (comments / reactions / webhooks / dev-resources / variable writes) —
 * is HARD-DENIED by construction: {@link executeFigmaTool} enforces an ALLOWLIST (§4: "allowlist, not
 * denylist"), so a slug we never audited can never run, and a write slug gets a loud refusal.
 *
 * FETCH-TO-FILE (§4 + §7 infrastructure, R1-normative): Figma payloads are huge (~1.5MB+ per frame)
 * and MUST NOT ride agent context — every extraction artifact is persisted to a work dir as it is
 * fetched (`raw.json` full + `simplified.json` minimal + `render.png` + `image-fills.json`), with a
 * `manifest.json` (`{file_key, node_id, frame_name, frame_size, asset_map}` — the §7 resume
 * convention) written LAST as the completion marker. Resume = re-read the manifest, NEVER re-fetch
 * (the R1 mid-run agent deaths are the field proof).
 *
 * Asset-URL honesty (F3): the temp URLs in `asset_map` EXPIRE (renders 30 days, image fills 14 days)
 * — they exist only so the convert run can sideload through `MediaPort` and persist attachment ids;
 * they never land in a saved tree (the pipeline's F3 check guards it).
 *
 * Env (documented defaults — never hardcode credentials):
 *  - `COMPOSIO_API_KEY`      (REQUIRED — the `x-api-key` header; no default)
 *  - `COMPOSIO_FIGMA_USER`   (the Composio `user_id`; default `llctriox` — the connected account in
 *                             the project `.mcp.json` `figma-composio` URL `?user_id=llctriox`)
 *  - `COMPOSIO_FIGMA_ACCOUNT` (optional `connected_account_id`; omitted = Composio resolves the
 *                             toolkit connection for the user)
 *  - `COMPOSIO_BASE_URL`     (default `https://backend.composio.dev`)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/* ───────────────────────────── env resolution (documented defaults) ─────────────────────────── */

/** The Composio backend base URL (override via `COMPOSIO_BASE_URL`). */
export const DEFAULT_COMPOSIO_BASE_URL = 'https://backend.composio.dev';

/**
 * The default Composio `user_id` the Figma connection is keyed under — `llctriox` (Triox LLC), the
 * `user_id` query param of the project `.mcp.json` `figma-composio` server URL. Override via
 * `COMPOSIO_FIGMA_USER`.
 */
export const DEFAULT_COMPOSIO_FIGMA_USER = 'llctriox';

/** The resolved Composio client configuration (from env; never hardcoded credentials). */
export interface FigmaClientEnv {
  /** `COMPOSIO_API_KEY` — REQUIRED; its absence is a `config` {@link FigmaClientError}. */
  apiKey: string | undefined;
  /** `COMPOSIO_FIGMA_USER` (default {@link DEFAULT_COMPOSIO_FIGMA_USER}). */
  userId: string;
  /** `COMPOSIO_FIGMA_ACCOUNT` — optional explicit `connected_account_id`. */
  connectedAccountId: string | undefined;
  /** `COMPOSIO_BASE_URL` (default {@link DEFAULT_COMPOSIO_BASE_URL}). */
  baseUrl: string;
}

/** Resolve the client env with the documented defaults. */
export function resolveFigmaEnv(env: NodeJS.ProcessEnv = process.env): FigmaClientEnv {
  const trimmed = (v: string | undefined): string | undefined => {
    const t = (v ?? '').trim();
    return t === '' ? undefined : t;
  };
  return {
    apiKey: trimmed(env['COMPOSIO_API_KEY']),
    userId: trimmed(env['COMPOSIO_FIGMA_USER']) ?? DEFAULT_COMPOSIO_FIGMA_USER,
    connectedAccountId: trimmed(env['COMPOSIO_FIGMA_ACCOUNT']),
    baseUrl: trimmed(env['COMPOSIO_BASE_URL']) ?? DEFAULT_COMPOSIO_BASE_URL,
  };
}

/* ───────────────────────────── slug allowlist (§4 — allowlist, not denylist) ────────────────── */

/**
 * The ONLY Composio Figma slugs the converter may execute (§4): file JSON in BOTH simplify modes
 * (the minimal/simplified response strips text typography — both are fetched), the frame render
 * (the F4 fidelity ground truth), and the image-fill URL map (14-day temp URLs → sideload).
 */
export const FIGMA_FETCH_TOOL_ALLOWLIST = [
  'FIGMA_GET_FILE_JSON',
  'FIGMA_RENDER_IMAGES_OF_FILE_NODES',
  'FIGMA_GET_IMAGE_FILLS',
] as const;

/** A slug the converter is allowed to execute. */
export type FigmaFetchToolSlug = (typeof FIGMA_FETCH_TOOL_ALLOWLIST)[number];

/**
 * The known WRITE slugs of the Composio Figma toolkit (comments / reactions / webhooks /
 * dev-resources / variable writes — contract 18 §4 hard-denies them for conversion agents). This
 * list exists ONLY to make the refusal message loud and specific; ENFORCEMENT is the allowlist
 * above (a write slug Composio adds tomorrow is denied without a list update).
 */
export const FIGMA_WRITE_TOOL_SLUGS: readonly string[] = [
  'FIGMA_ADD_A_COMMENT_TO_A_FILE',
  'FIGMA_DELETE_A_COMMENT',
  'FIGMA_ADD_A_REACTION_TO_A_COMMENT',
  'FIGMA_DELETE_A_REACTION',
  'FIGMA_CREATE_A_WEBHOOK',
  'FIGMA_UPDATE_A_WEBHOOK',
  'FIGMA_DELETE_A_WEBHOOK',
  'FIGMA_CREATE_DEV_RESOURCES',
  'FIGMA_UPDATE_DEV_RESOURCES',
  'FIGMA_DELETE_DEV_RESOURCE',
  'FIGMA_CREATE_MODIFY_DELETE_VARIABLES',
];

/* ───────────────────────────── errors ───────────────────────────────────────────────────────── */

/** The failure class of a {@link FigmaClientError} (the tool layer maps these to taxonomy codes). */
export type FigmaClientErrorCode =
  | 'denied' // a non-allowlisted (or write) slug — a converter bug, never retried
  | 'config' // missing COMPOSIO_API_KEY — environment, not upstream
  | 'http' // transport / non-2xx from the Composio backend
  | 'tool_failed' // Composio executed the tool and reported successful:false
  | 'bad_response'; // a 2xx whose payload does not carry what the slug promises

/** A typed Composio/Figma client failure. */
export class FigmaClientError extends Error {
  public readonly code: FigmaClientErrorCode;

  constructor(code: FigmaClientErrorCode, message: string) {
    super(message);
    this.name = 'FigmaClientError';
    this.code = code;
  }
}

/* ───────────────────────────── the execute call ─────────────────────────────────────────────── */

/** A `fetch`-compatible transport (injected by tests; default the Node 20 global). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link executeFigmaTool} (env + transport injection). */
export interface ExecuteFigmaToolOptions {
  env?: FigmaClientEnv;
  fetchImpl?: FetchLike;
}

/**
 * Execute ONE allowlisted Composio Figma tool (`POST {base}/api/v3/tools/execute/{SLUG}` with
 * `x-api-key`) and return its `data` payload. The allowlist check runs FIRST — before any env or
 * network access — so a denied slug can never leak a request. `successful:false` → `tool_failed`.
 */
export async function executeFigmaTool(
  slug: string,
  args: Record<string, unknown>,
  options?: ExecuteFigmaToolOptions,
): Promise<unknown> {
  if (!(FIGMA_FETCH_TOOL_ALLOWLIST as readonly string[]).includes(slug)) {
    const isWrite = FIGMA_WRITE_TOOL_SLUGS.includes(slug);
    throw new FigmaClientError(
      'denied',
      isWrite
        ? `Figma tool "${slug}" is a WRITE slug and is HARD-DENIED for conversion agents ` +
            `(contract 18 §4) — the converter only ever reads ` +
            `(${FIGMA_FETCH_TOOL_ALLOWLIST.join(', ')}).`
        : `Figma tool "${slug}" is not on the conversion fetch allowlist ` +
            `(${FIGMA_FETCH_TOOL_ALLOWLIST.join(', ')}) — denied (allowlist, not denylist; ` +
            `contract 18 §4).`,
    );
  }
  const env = options?.env ?? resolveFigmaEnv();
  if (env.apiKey === undefined) {
    throw new FigmaClientError(
      'config',
      'COMPOSIO_API_KEY is not set — the Figma front-end executes Composio tools over REST and ' +
        'needs the x-api-key header (see convert/figma-client.ts env docs).',
    );
  }
  const fetchImpl = options?.fetchImpl ?? (fetch as FetchLike);
  const url = `${env.baseUrl}/api/v3/tools/execute/${slug}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'x-api-key': env.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        arguments: args,
        user_id: env.userId,
        ...(env.connectedAccountId !== undefined
          ? { connected_account_id: env.connectedAccountId }
          : {}),
      }),
    });
  } catch (error: unknown) {
    throw new FigmaClientError('http', `Composio execute ${slug} failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new FigmaClientError(
      'http',
      `Composio execute ${slug} → HTTP ${String(response.status)}${body !== '' ? `: ${body.slice(0, 300)}` : ''}`,
    );
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { successful?: boolean; data?: unknown; error?: unknown }
    | undefined;
  if (payload === undefined) {
    throw new FigmaClientError('bad_response', `Composio execute ${slug} returned non-JSON`);
  }
  if (payload.successful === false) {
    throw new FigmaClientError(
      'tool_failed',
      `Figma tool ${slug} failed: ${typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error ?? 'unknown error')}`,
    );
  }
  return payload.data;
}

/* ───────────────────────────── FigmaPort (the convert seam) ─────────────────────────────────── */

/**
 * The Figma extraction PORT the convert pipeline consumes (re-exported from `convert/ports.ts`
 * alongside the WP-bound ports). Three reads + one binary download — nothing else exists on the
 * seam, so the §4 hard-deny is structural for everything above the client.
 */
export interface FigmaPort {
  /**
   * `FIGMA_GET_FILE_JSON` — `response_detail:'full'` = the raw Figma API response (text typography
   * intact); `'minimal'` = the simplified/deduplicated form (~70% smaller; `$fillN` table).
   */
  getFileJson(req: {
    file_key: string;
    ids: string;
    response_detail: 'minimal' | 'full';
    depth?: number;
    geometry?: string;
  }): Promise<unknown>;
  /** `FIGMA_RENDER_IMAGES_OF_FILE_NODES` — node id → temp render URL (30-day expiry; null = failed). */
  renderNodes(req: {
    file_key: string;
    ids: string;
    format?: 'png' | 'jpg' | 'svg' | 'pdf';
    scale?: number;
    contents_only?: boolean;
    use_absolute_bounds?: boolean;
  }): Promise<Record<string, string | null>>;
  /** `FIGMA_GET_IMAGE_FILLS` — `imageRef` → temp download URL (14-day expiry). */
  getImageFills(fileKey: string): Promise<Record<string, string>>;
  /** Download a (temp) asset URL to bytes — used for the frame render PNG. */
  download(url: string): Promise<Uint8Array>;
}

/** Build the production {@link FigmaPort} over {@link executeFigmaTool} (env-configured Composio). */
export function buildComposioFigmaPort(options?: ExecuteFigmaToolOptions): FigmaPort {
  const fetchImpl = options?.fetchImpl ?? (fetch as FetchLike);
  return {
    async getFileJson(req): Promise<unknown> {
      // Composio backend drift (live-verified 2026-06-11): the execute API IGNORES
      // `response_detail` and honors `simplify` instead ('full' requests came back simplified,
      // which figma-parse rightly rejects). Send BOTH — the documented param for forward-compat
      // and the honored boolean for the live backend.
      return executeFigmaTool(
        'FIGMA_GET_FILE_JSON',
        { ...req, simplify: req.response_detail !== 'full' },
        options,
      );
    },
    async renderNodes(req): Promise<Record<string, string | null>> {
      const data = await executeFigmaTool(
        'FIGMA_RENDER_IMAGES_OF_FILE_NODES',
        { format: 'png', ...req },
        options,
      );
      const images = pluckRecord(data, ['images']) ?? pluckRecord(data, ['data', 'images']);
      if (images === undefined) {
        throw new FigmaClientError(
          'bad_response',
          'FIGMA_RENDER_IMAGES_OF_FILE_NODES returned no images map',
        );
      }
      return images as Record<string, string | null>;
    },
    async getImageFills(fileKey): Promise<Record<string, string>> {
      const data = await executeFigmaTool('FIGMA_GET_IMAGE_FILLS', { file_key: fileKey }, options);
      // The REST shape is `{meta: {images: {imageRef: url}}}`; tolerate a flattened `images` too.
      const images =
        pluckRecord(data, ['meta', 'images']) ??
        pluckRecord(data, ['images']) ??
        pluckRecord(data, ['data', 'meta', 'images']);
      return (images ?? {}) as Record<string, string>;
    },
    async download(url): Promise<Uint8Array> {
      let response: Response;
      try {
        response = await fetchImpl(url);
      } catch (error: unknown) {
        throw new FigmaClientError('http', `asset download failed: ${(error as Error).message}`);
      }
      if (!response.ok) {
        throw new FigmaClientError(
          'http',
          `asset download → HTTP ${String(response.status)} (${url.slice(0, 120)}) — Figma temp ` +
            'URLs expire (renders 30d / image fills 14d); delete the work dir manifest to re-fetch',
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

/** Defensive nested-record pluck (`data.meta.images` etc.) — returns undefined off-shape. */
function pluckRecord(value: unknown, pathKeys: string[]): Record<string, unknown> | undefined {
  let cur: unknown = value;
  for (const key of pathKeys) {
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur !== null && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : undefined;
}

/* ───────────────────────────── figma URL parsing ────────────────────────────────────────────── */

/**
 * Parse a Figma design URL into `{file_key, node_id?}`. Accepts `figma.com/design/{key}/…` and the
 * legacy `figma.com/file/{key}/…`; the `node-id` query param uses hyphens (`400-7508`) and is
 * normalized to the API colon form (`400:7508`).
 */
export function parseFigmaUrl(url: string): { file_key: string; node_id?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FigmaClientError('bad_response', `not a valid Figma URL: ${url}`);
  }
  const match = /\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/.exec(parsed.pathname);
  if (match === null) {
    throw new FigmaClientError(
      'bad_response',
      `cannot extract a file key from "${url}" — expected figma.com/design/{file_key}/… ` +
        '(FigJam boards and Slides are not supported)',
    );
  }
  const nodeParam = parsed.searchParams.get('node-id');
  return {
    file_key: match[1] as string,
    ...(nodeParam !== null && nodeParam !== ''
      ? { node_id: normalizeFigmaNodeId(nodeParam) }
      : {}),
  };
}

/** Normalize a node id to the API colon form (`400-7508` → `400:7508`). */
export function normalizeFigmaNodeId(nodeId: string): string {
  return nodeId.trim().replace(/-/g, ':');
}

/* ───────────────────────────── fetch-to-file + manifest (§7 resume convention) ──────────────── */

/** The §7 NORMATIVE extraction manifest, persisted as `manifest.json` next to the artifacts. */
export interface FigmaExtractionManifest {
  file_key: string;
  node_id: string;
  frame_name: string;
  frame_size: { width: number; height: number };
  /**
   * Temp asset URLs keyed by `imageRef` (image fills, 14-day expiry) plus the frame render under
   * `render:{node_id}` (30-day expiry). F3: these NEVER persist into a tree — they are sideloaded
   * through `MediaPort` during convert and only attachment ids are saved.
   */
  asset_map: Record<string, string>;
  /** Artifact filenames RELATIVE to the work dir (additive to the §7 shape; resume reads these). */
  artifacts: { raw: string; simplified: string; render: string; image_fills: string };
  /** ISO timestamp of the fetch (asset URLs expire 14/30 days after it). */
  fetched_at: string;
}

/** The frozen artifact filenames inside a work dir. */
export const FIGMA_ARTIFACTS = {
  manifest: 'manifest.json',
  raw: 'raw.json',
  simplified: 'simplified.json',
  render: 'render.png',
  image_fills: 'image-fills.json',
} as const;

/** A completed (fresh or resumed) extraction: the manifest + absolute artifact paths. */
export interface FigmaExtraction {
  manifest: FigmaExtractionManifest;
  work_dir: string;
  paths: { manifest: string; raw: string; simplified: string; render: string; image_fills: string };
  /** True when the work dir already held a complete manifest and NOTHING was re-fetched. */
  resumed: boolean;
}

/** The fetch request for {@link fetchFrameToWorkDir}. */
export interface FetchFrameRequest {
  file_key: string;
  /** Colon-form node id (`400:7508`); hyphen form is normalized. */
  node_id: string;
  /** The artifact work dir (created if missing). */
  work_dir: string;
  /** Render scale for the frame PNG ground truth (default 1 = frame-exact pixels). */
  render_scale?: number;
}

/**
 * Fetch ONE frame's full extraction to the work dir — or RESUME from it. Resume semantics (§7,
 * R1-normative): a `manifest.json` whose artifacts all exist short-circuits with ZERO upstream
 * calls (the manifest is written LAST, so its presence proves a complete extraction). A fresh
 * fetch persists every payload as it arrives: `raw.json` (`response_detail:'full'` — simplified
 * strips text typography), `simplified.json` (`'minimal'`), `render.png` (the F4 fidelity ground
 * truth), `image-fills.json`, then the manifest.
 */
export async function fetchFrameToWorkDir(
  port: FigmaPort,
  req: FetchFrameRequest,
): Promise<FigmaExtraction> {
  const nodeId = normalizeFigmaNodeId(req.node_id);
  const workDir = req.work_dir;
  const paths = {
    manifest: path.join(workDir, FIGMA_ARTIFACTS.manifest),
    raw: path.join(workDir, FIGMA_ARTIFACTS.raw),
    simplified: path.join(workDir, FIGMA_ARTIFACTS.simplified),
    render: path.join(workDir, FIGMA_ARTIFACTS.render),
    image_fills: path.join(workDir, FIGMA_ARTIFACTS.image_fills),
  };

  // ── RESUME: a complete manifest means never re-fetch (the §7 convention). ────────────────────
  if (existsSync(paths.manifest)) {
    const manifest = JSON.parse(
      await readFile(paths.manifest, 'utf8'),
    ) as FigmaExtractionManifest;
    const complete = Object.values(paths).every((p) => existsSync(p));
    if (complete && manifest.file_key === req.file_key && manifest.node_id === nodeId) {
      return { manifest, work_dir: workDir, paths, resumed: true };
    }
    // A manifest for a DIFFERENT frame (or with missing artifacts) is not resumable — re-fetch
    // into the same dir (the caller chose it; artifacts are overwritten atomically per file).
  }

  await mkdir(workDir, { recursive: true });

  // ── (1) file JSON, BOTH simplify modes (§4) — persisted as fetched. ──────────────────────────
  const raw = await port.getFileJson({ file_key: req.file_key, ids: nodeId, response_detail: 'full' });
  await writeFile(paths.raw, JSON.stringify(raw), 'utf8');
  const simplified = await port.getFileJson({
    file_key: req.file_key,
    ids: nodeId,
    response_detail: 'minimal',
  });
  await writeFile(paths.simplified, JSON.stringify(simplified), 'utf8');

  // ── (2) the frame render (F4 fidelity ground truth) → render.png. ────────────────────────────
  const images = await port.renderNodes({
    file_key: req.file_key,
    ids: nodeId,
    format: 'png',
    scale: req.render_scale ?? 1,
  });
  const renderUrl = images[nodeId] ?? images[Object.keys(images)[0] ?? ''];
  if (renderUrl === undefined || renderUrl === null) {
    throw new FigmaClientError(
      'bad_response',
      `frame ${nodeId} did not render (null/missing in the images map) — invalid id, invisible ` +
        'node, or 0% opacity',
    );
  }
  const renderPng = await port.download(renderUrl);
  await writeFile(paths.render, renderPng);

  // ── (3) image fills (14-day temp URLs keyed by imageRef) → image-fills.json. ─────────────────
  const fills = await port.getImageFills(req.file_key);
  await writeFile(paths.image_fills, JSON.stringify(fills), 'utf8');

  // ── (4) the manifest, LAST (its presence = extraction complete; the resume marker). ──────────
  const frameDoc = findFrameDocument(raw, nodeId);
  const manifest: FigmaExtractionManifest = {
    file_key: req.file_key,
    node_id: nodeId,
    frame_name: frameDoc?.name ?? nodeId,
    frame_size: frameDoc?.size ?? { width: 0, height: 0 },
    asset_map: {
      ...Object.fromEntries(
        Object.entries(fills).filter(([, url]) => typeof url === 'string'),
      ),
      [`render:${nodeId}`]: renderUrl,
    },
    artifacts: {
      raw: FIGMA_ARTIFACTS.raw,
      simplified: FIGMA_ARTIFACTS.simplified,
      render: FIGMA_ARTIFACTS.render,
      image_fills: FIGMA_ARTIFACTS.image_fills,
    },
    fetched_at: new Date().toISOString(),
  };
  await writeFile(paths.manifest, JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, work_dir: workDir, paths, resumed: false };
}

/** The loaded payloads of a completed extraction (read back from the work dir, never context). */
export interface LoadedExtraction {
  manifest: FigmaExtractionManifest;
  raw: unknown;
  simplified: unknown;
  image_fills: Record<string, string>;
  render_png: Uint8Array;
}

/** Read a completed extraction's payloads back from disk (resume-side of fetch-to-file). */
export async function loadExtraction(workDir: string): Promise<LoadedExtraction> {
  const manifest = JSON.parse(
    await readFile(path.join(workDir, FIGMA_ARTIFACTS.manifest), 'utf8'),
  ) as FigmaExtractionManifest;
  const raw = JSON.parse(await readFile(path.join(workDir, manifest.artifacts.raw), 'utf8'));
  const simplified = JSON.parse(
    await readFile(path.join(workDir, manifest.artifacts.simplified), 'utf8'),
  );
  const imageFills = JSON.parse(
    await readFile(path.join(workDir, manifest.artifacts.image_fills), 'utf8'),
  ) as Record<string, string>;
  const renderPng = new Uint8Array(
    await readFile(path.join(workDir, manifest.artifacts.render)),
  );
  return { manifest, raw, simplified, image_fills: imageFills, render_png: renderPng };
}

/* ───────────────────────────── frame-document mining (defensive) ────────────────────────────── */

/**
 * Mine the requested node's `name` + `absoluteBoundingBox` size from the RAW `/nodes`-shaped
 * response (`{nodes: {"400:7508": {document: {...}}}}` — tolerated under wrapper keys). Returns
 * undefined off-shape; the manifest then carries the node id as the name and a 0×0 size (the
 * figma-parse stage re-derives the real frame box from the node tree).
 */
export function findFrameDocument(
  raw: unknown,
  nodeId: string,
): { name: string; size: { width: number; height: number } } | undefined {
  const doc = findNodeById(raw, nodeId, 0);
  if (doc === undefined) {
    return undefined;
  }
  const name = typeof doc['name'] === 'string' ? doc['name'] : nodeId;
  const box = doc['absoluteBoundingBox'];
  const size =
    box !== null && typeof box === 'object'
      ? {
          width: numberOr((box as Record<string, unknown>)['width'], 0),
          height: numberOr((box as Record<string, unknown>)['height'], 0),
        }
      : { width: 0, height: 0 };
  return { name, size: { width: Math.round(size.width), height: Math.round(size.height) } };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Bounded-depth object-graph search for a node object with `id === nodeId`. */
function findNodeById(
  value: unknown,
  nodeId: string,
  depth: number,
): Record<string, unknown> | undefined {
  if (depth > 12 || value === null || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNodeById(item, nodeId, depth + 1);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record['id'] === nodeId && typeof record['type'] === 'string') {
    return record;
  }
  for (const child of Object.values(record)) {
    const found = findNodeById(child, nodeId, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
