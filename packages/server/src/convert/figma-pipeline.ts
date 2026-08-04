/**
 * Contract 18 §1/§4/§6 — the FIGMA front-end orchestrator (`convert.figma_to_tree` /
 * `convert.figma_to_page`).
 *
 * The Figma path is a second FRONT-END on the existing pipeline, never a second pipeline:
 *
 *   fetch-to-file (figma-client, §7 manifest resume) → figmaParse (figma-parse.ts, pure)
 *     → `buildTreeFromParsed` (pipeline.ts — normalize..integrity, the §1 IR seam, UNCHANGED)
 *     → [figma_to_page only] `persistTreeBuild` (pipeline.ts — gate → confirm → authoritative
 *        dry_run → kit writes → save → prime → verify with the R3 draft-gate, UNCHANGED)
 *
 * Figma-specific responsibilities owned HERE (everything else is shared):
 *  - target resolution (`figma_url` | `file_key`+`node_id`) and the deterministic default work dir;
 *  - the TWO-PASS flatten render: pass 1 of `figmaParse` decides the §3 flatten roots, the
 *    orchestrator renders them via `FigmaPort.renderNodes` (cached in the work dir — render URLs
 *    expire in 30 days, a resume inside the window never re-renders), pass 2 attaches the URLs;
 *  - F3: temp asset URLs ride the IR only as `MediaRef.url` — ASSEMBLE sideloads them through
 *    `MediaPort` and persists ATTACHMENT IDS; no temp URL survives into a saved tree;
 *  - F4: the verify-loop SOURCE is the frame render PNG (a `file://` document embedding
 *    `render.png` replaces the source-page render in the 17 loop);
 *  - F5: the TEXT-presence audit — every visible TEXT node's characters from the source frame
 *    must appear in the converted output or be accounted (flattened/dropped), never silently lost;
 *  - the §6 `figma:{frame, tokens, flattened, responsive}` report extension.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

import {
  fetchFrameToWorkDir,
  loadExtraction,
  normalizeFigmaNodeId,
  parseFigmaUrl,
  type FigmaExtraction,
  type FigmaPort,
} from './figma-client.js';
import { figmaParse, type FigmaParseResult, type FigmaReport } from './figma-parse.js';
import type { FigmaFlattenMode } from './figma-flatten.js';
import {
  buildTreeFromParsed,
  persistTreeBuild,
  probeStageInputs,
  type Confirmer,
  type ConvertOptions,
  type HtmlToPageResult,
  type TreeBuild,
} from './pipeline.js';
import type { ConvertPorts } from './ports.js';
import type { ElementNode, ProposedVariable } from './types.js';

/* ───────────────────────────── tool-arg / result types (contract 18 §6) ─────────────────────── */

/** The `convert.figma_to_*` options bag (catalog `figmaConvertOptionsSchema`). */
export interface FigmaConvertOptions {
  /** §3 flatten policy boundary (default `balanced`). */
  flatten?: FigmaFlattenMode;
  hoist_classes?: boolean;
  extract_variables?: boolean;
  sideload_media?: boolean;
  /** Contract 17 #9 carry — Figma has no source font links, so this is a no-op unless parse grows them. */
  carry_fonts?: boolean;
  /** The §7 fetch-to-file work dir (default: a deterministic per-frame dir under the OS tmpdir). */
  work_dir?: string;
  /** Render scale for the F4 frame-render ground truth (default 1). */
  render_scale?: number;
}

/** `elementor.convert.figma_to_tree` args. */
export interface FigmaToTreeArgs {
  figma_url?: string;
  file_key?: string;
  node_id?: string;
  generation?: 'v4' | 'v3';
  options?: FigmaConvertOptions;
}

/** `elementor.convert.figma_to_page` args (the persist surface mirrors `html_to_page`). */
export interface FigmaToPageArgs extends FigmaToTreeArgs {
  post_id?: number;
  title?: string;
  status?: 'draft' | 'publish' | 'pending' | 'private';
  commit?: boolean;
  confirm?: boolean;
  coverage_gate?: number;
  verify_gate?: number;
  page_template?: 'elementor_canvas' | 'elementor_header_footer' | 'default';
}

/** The F5 TEXT-presence audit over the converted tree (every row accounted, never silent). */
export interface FigmaTextPresence {
  total: number;
  present: number;
  /** TEXT nodes accounted inside a §3 flatten render or an honest drop (not expected in the tree). */
  dropped: number;
  missing: Array<{ node_id: string; text: string }>;
  pass: boolean;
}

/** The §6 `figma:{…}` wire block (catalog `figmaReportSchema`). */
export interface FigmaReportBlock {
  frame: { file_key: string; node_id: string; name: string; width: number; height: number };
  /** Design tokens that became proposed variables (§2 token row → the shared variable-extract). */
  tokens: Array<{ name: string; type: string; value: string }>;
  flattened: Array<{ nodeId: string; reason: string }>;
  responsive: FigmaReport['responsive'];
  fonts?: FigmaReport['fonts'];
  dropped?: FigmaReport['dropped'];
  interaction_drops?: FigmaReport['interaction_drops'];
  responsive_frames?: FigmaReport['responsive_frames'];
  text_presence?: FigmaTextPresence;
  work_dir?: string;
  resumed?: boolean;
}

/** The figma tree build: the SHARED {@link TreeBuild} + the figma-side carriers. */
export interface FigmaTreeBuild extends TreeBuild {
  figma: FigmaReportBlock;
  /** The §7 extraction (manifest + absolute artifact paths — `paths.render` is the F4 PNG). */
  extraction: FigmaExtraction;
}

/** `figma_to_page` result: the SHARED persist result + the figma block. */
export type FigmaToPageResult = HtmlToPageResult & { figma?: FigmaReportBlock };

/** A bad `figma_to_*` argument set (the tool layer maps it to `VALIDATION_FAILED`). */
export class FigmaArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FigmaArgsError';
  }
}

/* ───────────────────────────── target + work-dir resolution ─────────────────────────────────── */

/** Resolve `{figma_url | file_key+node_id}` to the colon-form extraction target. */
export function resolveFigmaTarget(args: FigmaToTreeArgs): { file_key: string; node_id: string } {
  if (args.figma_url !== undefined && args.figma_url !== '') {
    const parsed = parseFigmaUrl(args.figma_url);
    const nodeId = args.node_id !== undefined ? normalizeFigmaNodeId(args.node_id) : parsed.node_id;
    if (nodeId === undefined) {
      throw new FigmaArgsError(
        'the figma_url carries no node-id — pass a frame URL (…?node-id=400-7508) or an explicit node_id',
      );
    }
    return { file_key: parsed.file_key, node_id: nodeId };
  }
  if (
    args.file_key !== undefined &&
    args.file_key !== '' &&
    args.node_id !== undefined &&
    args.node_id !== ''
  ) {
    return { file_key: args.file_key, node_id: normalizeFigmaNodeId(args.node_id) };
  }
  throw new FigmaArgsError(
    'a Figma target is required: pass figma_url (a figma.com/design frame URL) OR file_key + node_id',
  );
}

/** The deterministic default work dir for a frame (`<tmpdir>/emcp-figma/<file_key>-<node-id>`). */
export function defaultWorkDir(fileKey: string, nodeId: string): string {
  return path.join(
    os.tmpdir(),
    'emcp-figma',
    `${fileKey}-${nodeId.replace(/[^A-Za-z0-9]+/g, '-')}`,
  );
}

/* ───────────────────────────── flatten renders (two-pass, work-dir cached) ──────────────────── */

/** The work-dir cache file for §3 flatten-root render URLs (30-day temp URLs; resume-friendly). */
export const FLATTEN_RENDERS_FILE = 'flatten-renders.json';

/** One §3 flatten render request: the root id + whether it renders CLIPPED (no absolute bounds). */
interface FlattenRenderRoot {
  id: string;
  clipped: boolean;
}

/**
 * Render the §3 flatten roots (pass 1's `flattened[].render_node_id`) to temp PNG URLs, caching
 * the map in the work dir so a resume inside the 30-day window re-renders NOTHING. Default recipe:
 * `contents_only:false` + `use_absolute_bounds:true` (§2: overlapping-sibling icon clusters must
 * capture what overlaps them — the field-proven composite-visual recipe). Roots flagged `clipped`
 * (clip-escaping fan-outs — W18 pinstripes) render WITHOUT absolute bounds instead: the canvas
 * truth is the frame's clipped view, and absolute bounds bake the child overhang into the image.
 * Cache keys carry the mode (`<id>` / `<id>@clipped`) so a mode change never reuses a stale render.
 */
async function resolveFlattenRenders(
  figma: FigmaPort,
  fileKey: string,
  renderRoots: FlattenRenderRoot[],
  workDir: string,
  scale: number,
): Promise<Record<string, string>> {
  if (renderRoots.length === 0) {
    return {};
  }
  const cacheKey = (root: FlattenRenderRoot): string =>
    root.clipped ? `${root.id}@clipped` : root.id;
  const toUrlMap = (cached: Record<string, string>): Record<string, string> =>
    Object.fromEntries(renderRoots.map((root) => [root.id, cached[cacheKey(root)] as string]));
  const cachePath = path.join(workDir, FLATTEN_RENDERS_FILE);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, string>;
      if (renderRoots.every((root) => typeof cached[cacheKey(root)] === 'string')) {
        return toUrlMap(cached);
      }
    } catch {
      // unreadable cache → re-render below
    }
  }
  const cache: Record<string, string> = {};
  for (const clipped of [false, true]) {
    const batch = renderRoots.filter((root) => root.clipped === clipped);
    if (batch.length === 0) {
      continue;
    }
    const images = await figma.renderNodes({
      file_key: fileKey,
      ids: batch.map((root) => root.id).join(','),
      format: 'png',
      scale,
      contents_only: clipped, // clipped bands are self-contained; the icon recipe needs overlaps
      use_absolute_bounds: !clipped,
    });
    for (const root of batch) {
      const url = images[root.id];
      if (typeof url === 'string') {
        cache[cacheKey(root)] = url;
      }
      // A null render degrades inside figmaParse (FIGMA_RENDER_URL_MISSING warning) — never thrown.
    }
  }
  await mkdir(workDir, { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  return toUrlMap(cache);
}

/* ───────────────────────────── F5 — the TEXT-presence audit ─────────────────────────────────── */

/**
 * Entity-decode + lowercase + REMOVE all whitespace — the presence-match normal form. Whitespace
 * is squashed entirely (not just collapsed) because a TEXT node split across styled runs re-joins
 * around folded markup (`…our <a href>Terms</a>.`) with spacing the tag-strip cannot reconstruct.
 */
function normalizeText(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[‘’]/g, "'") // curly apostrophes ↔ ASCII (fold/typography variance)
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Every visible TEXT node (id + characters) in the PRIMARY frame's raw subtree. */
export function collectSourceTextNodes(
  raw: unknown,
  primaryNodeId: string,
): Array<{ node_id: string; text: string }> {
  const primary = findRawNode(raw, primaryNodeId, 0);
  if (primary === undefined) {
    return [];
  }
  const out: Array<{ node_id: string; text: string }> = [];
  const walk = (node: Record<string, unknown>): void => {
    if (node['visible'] === false) {
      return; // invisible subtrees are not content
    }
    if (node['type'] === 'TEXT' && typeof node['characters'] === 'string') {
      const text = node['characters'].trim();
      if (text !== '') {
        out.push({ node_id: typeof node['id'] === 'string' ? node['id'] : '', text });
      }
    }
    const children = node['children'];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child !== null && typeof child === 'object') {
          walk(child as Record<string, unknown>);
        }
      }
    }
  };
  walk(primary);
  return out;
}

/** Bounded-depth search for the raw node object with `id === nodeId` (any payload wrapper shape). */
function findRawNode(
  value: unknown,
  nodeId: string,
  depth: number,
): Record<string, unknown> | undefined {
  if (depth > 12 || value === null || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRawNode(item, nodeId, depth + 1);
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
    const found = findRawNode(child, nodeId, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Concatenate every settings string in the wire tree, tags stripped (the presence corpus). */
function treeTextCorpus(elements: ElementNode[]): string {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) {
        collect(child);
      }
    }
  };
  collect(elements);
  return normalizeText(parts.join('\n').replace(/<[^>]+>/g, ' '));
}

/**
 * The F5 invariant audit: every visible source TEXT node's characters appear in the converted
 * output, or sit inside a §3 flatten render / an honest drop (accounted) — silence is the only
 * forbidden outcome.
 */
export function auditTextPresence(
  raw: unknown,
  report: FigmaReport,
  elements: ElementNode[],
): FigmaTextPresence {
  const texts = collectSourceTextNodes(raw, report.frame.node_id);
  const accounted = new Set<string>();
  for (const flat of report.flattened) {
    accounted.add(flat.node_id);
    for (const covered of flat.covers) {
      accounted.add(covered);
    }
  }
  for (const drop of report.dropped) {
    accounted.add(drop.node_id);
  }
  const corpus = treeTextCorpus(elements);
  let present = 0;
  let dropped = 0;
  const missing: Array<{ node_id: string; text: string }> = [];
  for (const row of texts) {
    if (corpus.includes(normalizeText(row.text))) {
      present += 1;
    } else if (accounted.has(row.node_id)) {
      dropped += 1;
    } else {
      missing.push(row);
    }
  }
  return { total: texts.length, present, dropped, missing, pass: missing.length === 0 };
}

/* ───────────────────────────── figmaToTree (§6 preview tool) ────────────────────────────────── */

/** The figma port off the bundle, loudly absent-checked (buildPorts always wires it). */
function requireFigmaPort(ports: ConvertPorts): FigmaPort {
  if (ports.figma === undefined) {
    throw new Error(
      'the ConvertPorts bundle carries no FigmaPort — build it via buildPorts(ctx) (convert/ports.ts)',
    );
  }
  return ports.figma;
}

/** Map the figma options bag onto the SHARED stage-run options (no base_url / include_js for Figma). */
function toConvertOptions(options: FigmaConvertOptions): ConvertOptions {
  return {
    ...(options.hoist_classes !== undefined ? { hoist_classes: options.hoist_classes } : {}),
    ...(options.extract_variables !== undefined
      ? { extract_variables: options.extract_variables }
      : {}),
    ...(options.sideload_media !== undefined ? { sideload_media: options.sideload_media } : {}),
    ...(options.carry_fonts !== undefined ? { carry_fonts: options.carry_fonts } : {}),
  };
}

/** Map proposed variables to the §6 `tokens` rows (designer tokens minted as variables). */
function toTokens(vars: ProposedVariable[]): FigmaReportBlock['tokens'] {
  return vars.map((v) => ({ name: v.label, type: v.type, value: v.value }));
}

/**
 * `convert.figma_to_tree`: fetch (or RESUME) the frame extraction, run the pure figma-parse stage
 * (two passes when §3 flatten roots need renders), then the SHARED stage run. NO page persist —
 * the only writes are media sideloads (F3) when `sideload_media` is on, exactly like the HTML path.
 */
export async function figmaToTree(
  args: FigmaToTreeArgs,
  ports: ConvertPorts,
  confirm?: Confirmer,
): Promise<FigmaTreeBuild> {
  const options = args.options ?? {};
  const target = resolveFigmaTarget(args);
  const figma = requireFigmaPort(ports);
  const workDir = options.work_dir ?? defaultWorkDir(target.file_key, target.node_id);

  // ── fetch-to-file (or §7 manifest resume) + read the payloads back from disk. ─────────────────
  const extraction = await fetchFrameToWorkDir(figma, {
    file_key: target.file_key,
    node_id: target.node_id,
    work_dir: workDir,
    ...(options.render_scale !== undefined ? { render_scale: options.render_scale } : {}),
  });
  // Everything below uses the EXTRACTION's dir (== workDir on the live path; tests may stub it).
  const loaded = await loadExtraction(extraction.work_dir);

  // ── probes (shared) + the pure figma-parse stage. ─────────────────────────────────────────────
  const probes = await probeStageInputs(ports, args.generation);

  // Probe site-installed non-catalog fonts so figma-parse marks them as 'local' (not 'missing').
  // Non-fatal: a network failure degrades to no local-family hints (fonts fall back to substitution).
  let local_families: string[] = [];
  try {
    local_families = await ports.design.listInstalledFonts();
  } catch {
    // best-effort
  }

  const parseOpts = {
    ...(options.flatten !== undefined ? { flatten: options.flatten } : {}),
    node_id: target.node_id,
    image_fills: loaded.image_fills,
    ...(local_families.length > 0 ? { local_families } : {}),
  };

  // Pass 1 decides the §3 flatten roots; the orchestrator renders them (cached); pass 2 attaches
  // the URLs (figmaParse is pure + cheap — re-running is the simple correct two-pass shape).
  let envelope: FigmaParseResult = figmaParse(loaded.raw, parseOpts);
  const flattenRoots = envelope.figma.flattened.map((f) => ({
    id: f.render_node_id,
    clipped: f.clip_render === true,
  }));
  if (flattenRoots.length > 0) {
    const renderUrls = await resolveFlattenRenders(
      figma,
      target.file_key,
      flattenRoots,
      extraction.work_dir,
      options.render_scale ?? 1,
    );
    envelope = figmaParse(loaded.raw, { ...parseOpts, render_urls: renderUrls });
  }

  // ── the SHARED stage run (normalize..integrity — the §1 IR seam, one code path). ─────────────
  const treeBuild = await buildTreeFromParsed(
    envelope, // ParseResult-compatible; Figma sources carry no scripts (an empty census)
    [],
    { options: toConvertOptions(options), probes },
    ports,
    confirm,
  );

  // ── F5 — the TEXT-presence audit over the FINAL wire tree. ───────────────────────────────────
  const textPresence = auditTextPresence(loaded.raw, envelope.figma, treeBuild.result.elements);
  const figmaBlock: FigmaReportBlock = {
    frame: { file_key: target.file_key, ...envelope.figma.frame },
    tokens: toTokens(treeBuild.result.proposed_variables),
    flattened: envelope.figma.flattened.map((f) => ({ nodeId: f.node_id, reason: f.reason })),
    responsive: envelope.figma.responsive,
    fonts: envelope.figma.fonts,
    dropped: envelope.figma.dropped,
    interaction_drops: envelope.figma.interaction_drops,
    ...(envelope.figma.responsive_frames !== undefined
      ? { responsive_frames: envelope.figma.responsive_frames }
      : {}),
    text_presence: textPresence,
    work_dir: extraction.work_dir,
    resumed: extraction.resumed,
  };
  if (!textPresence.pass) {
    treeBuild.result.warnings = [
      ...(treeBuild.result.warnings ?? []),
      `F5 TEXT-presence audit FAILED: ${String(textPresence.missing.length)} source text ` +
        `node(s) neither present in the converted output nor accounted as flattened/dropped ` +
        `(first: ${JSON.stringify(textPresence.missing[0]?.text.slice(0, 80) ?? '')}) — contract 18 §6 F5`,
    ];
  }

  return { ...treeBuild, figma: figmaBlock, extraction };
}

/* ───────────────────────────── figmaToPage (§6 commit tool) ─────────────────────────────────── */

/** The F4 verify-source document name written next to the artifacts. */
export const VERIFY_SOURCE_FILE = 'verify-source.html';

/**
 * Write the F4 verify-loop source document: a chrome-less page that IS the frame render PNG
 * (scaled to the viewport width — the frame is the desktop truth; narrower breakpoints judge a
 * proportional scale of the design). Returns its `file://` URL for `VerifyLoopInput.sourceUrlOrHtml`.
 */
async function writeVerifySource(extraction: FigmaExtraction): Promise<string> {
  const docPath = path.join(extraction.work_dir, VERIFY_SOURCE_FILE);
  const renderFile = path.basename(extraction.paths.render);
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0}img{display:block;width:100%;height:auto}' +
    `</style></head><body><img src="${renderFile}" alt="figma frame render"></body></html>`;
  await writeFile(docPath, html, 'utf8');
  return pathToFileURL(docPath).href;
}

/**
 * `convert.figma_to_page`: the figma tree build + the SHARED persist path (gate → confirm →
 * authoritative dry_run → kit writes → save → prime → contract-17 verify loop with the R3
 * draft-gate). `commit:false` is the default and persists NOTHING; the verify ground truth is the
 * frame render PNG (F4); replay identity is the frame extraction (file_key/node_id/fetched_at) +
 * every result-changing arg.
 */
export async function figmaToPage(
  args: FigmaToPageArgs,
  ports: ConvertPorts,
  confirm: Confirmer,
): Promise<FigmaToPageResult> {
  const treeBuild = await figmaToTree(
    {
      ...(args.figma_url !== undefined ? { figma_url: args.figma_url } : {}),
      ...(args.file_key !== undefined ? { file_key: args.file_key } : {}),
      ...(args.node_id !== undefined ? { node_id: args.node_id } : {}),
      ...(args.generation !== undefined ? { generation: args.generation } : {}),
      ...(args.options !== undefined ? { options: args.options } : {}),
    },
    ports,
    confirm,
  );
  const { manifest } = treeBuild.extraction;
  const verifySource = await writeVerifySource(treeBuild.extraction);

  const result = await persistTreeBuild(
    treeBuild,
    {
      ...(args.post_id !== undefined ? { post_id: args.post_id } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.commit !== undefined ? { commit: args.commit } : {}),
      ...(args.coverage_gate !== undefined ? { coverage_gate: args.coverage_gate } : {}),
      ...(args.verify_gate !== undefined ? { verify_gate: args.verify_gate } : {}),
      ...(args.page_template !== undefined ? { page_template: args.page_template } : {}),
      // Contract 18 §5 — a11y is ADVISORY for Figma input (semantics are inferred, never authored);
      // findings still ride the report but never refuse the commit.
      a11y_advisory: true,
      preview_op_seed: [
        'convert.figma.dry_run.preview',
        manifest.file_key,
        manifest.node_id,
        manifest.fetched_at,
      ],
      // Replay identity: the EXTRACTION (a resumed manifest keeps fetched_at, so an identical
      // re-call replays; a re-fetched design is a new commit) + every result-changing arg.
      commit_op_seed: [
        'convert.figma.commit',
        manifest.file_key,
        manifest.node_id,
        manifest.fetched_at,
        args.post_id ?? 'new',
        args.title ?? '',
        args.status ?? '',
        treeBuild.generation,
        args.options ?? {},
      ],
      verify_source: verifySource,
      source_label: `Convert Figma frame "${treeBuild.figma.frame.name}"`,
    },
    ports,
    confirm,
  );

  return { ...result, figma: treeBuild.figma };
}
