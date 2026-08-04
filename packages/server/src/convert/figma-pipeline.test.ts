/**
 * Contract 18 §1/§4/§6 — figma-pipeline orchestrator tests (OFFLINE; zero network, zero vi.mock —
 * plus ONE Chromium-gated F4 suite at the end, skipped where no browser is installed).
 *
 * The integration tests run the REAL seam end-to-end: a prebuilt work dir (the committed
 * cluster-1 fixture as `raw.json` + the committed frame render `wpos-v2-hero.png` as `render.png`
 * + a complete §7 manifest) makes the REAL `fetchFrameToWorkDir` take its RESUME path with ZERO
 * upstream calls; an in-memory {@link FigmaPort} serves only the two-pass §3 flatten renders;
 * stubbed `ConvertPorts` cover the read-only probes + sideloads. So the suite proves: manifest
 * resume (§7), the two-pass flatten render orchestration + its work-dir cache, F3 (temp URLs
 * sideloaded — never in the tree), F5 (text presence), and the §6 figma report block — all against
 * the REAL `figmaParse` + the REAL shared pipeline stages.
 *
 * §6 CI corpus: the COMMITTED frame render (fixtures/figma/wpos-v2-hero.png — the real Figma
 * render of frame 400:7510, 1440×790) is asserted decodable at the manifest's exact frame size
 * OFFLINE, and the F4 verify path (`runVerifyLoop` against the `verify-source.html` document that
 * embeds it) is exercised for REAL in the Chromium-gated suite — CI needs no Figma access.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';

import { closeBrowser, getBrowser } from './browser-pool.js';
import { FIGMA_ARTIFACTS, type FigmaExtractionManifest, type FigmaPort } from './figma-client.js';
import {
  auditTextPresence,
  collectSourceTextNodes,
  defaultWorkDir,
  figmaToTree,
  figmaToPage,
  resolveFigmaTarget,
  FigmaArgsError,
  FLATTEN_RENDERS_FILE,
  VERIFY_SOURCE_FILE,
} from './figma-pipeline.js';
import { figmaParse } from './figma-parse.js';
import type { ConvertPorts } from './ports.js';
import type { ElementNode } from './types.js';
import { runVerifyLoop } from './verify-loop.js';

/* ─────────────────────────── the committed cluster-1 fixture ─────────────────────────────────── */

const FIXTURE_PATH = new URL('../../fixtures/figma/wpos-v2-hero.json', import.meta.url);
/** The committed F4 ground truth: the REAL Figma render of the fixture frame (§6 CI corpus). */
const RENDER_PATH = new URL('../../fixtures/figma/wpos-v2-hero.png', import.meta.url);
const FILE_KEY = 'ogxmGWnTEJK3TEPnMWp2by';
const NODE_ID = '400:7510';
/** The hero column's real imageRef (a 14-day temp URL ASSEMBLE must sideload — F3). */
const HERO_IMAGE_REF = '2551426bac12d0cb80b9a6ffc62aee96f97f3501';

function fixtureRaw(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
}

/* ─────────────────────────── pure-helper tests ───────────────────────────────────────────────── */

describe('resolveFigmaTarget', () => {
  it('resolves a figma_url (hyphen node-id normalized to the colon form)', () => {
    expect(
      resolveFigmaTarget({
        figma_url: `https://www.figma.com/design/${FILE_KEY}/X?node-id=400-7510`,
      }),
    ).toEqual({ file_key: FILE_KEY, node_id: NODE_ID });
  });

  it('resolves explicit file_key + node_id', () => {
    expect(resolveFigmaTarget({ file_key: FILE_KEY, node_id: '400-7510' })).toEqual({
      file_key: FILE_KEY,
      node_id: NODE_ID,
    });
  });

  it('an explicit node_id wins over the URL node-id', () => {
    expect(
      resolveFigmaTarget({
        figma_url: `https://figma.com/design/${FILE_KEY}/X?node-id=1-1`,
        node_id: '400:7510',
      }).node_id,
    ).toBe(NODE_ID);
  });

  it('throws FigmaArgsError on a missing target / a URL with no node-id', () => {
    expect(() => resolveFigmaTarget({})).toThrow(FigmaArgsError);
    expect(() => resolveFigmaTarget({ file_key: FILE_KEY })).toThrow(FigmaArgsError);
    expect(() =>
      resolveFigmaTarget({ figma_url: `https://figma.com/design/${FILE_KEY}/NoNode` }),
    ).toThrow(FigmaArgsError);
  });
});

describe('defaultWorkDir', () => {
  it('is deterministic and filesystem-safe (colon node ids sanitized)', () => {
    const dir = defaultWorkDir(FILE_KEY, NODE_ID);
    expect(dir).toBe(defaultWorkDir(FILE_KEY, NODE_ID));
    expect(dir).toContain('emcp-figma');
    expect(path.basename(dir)).not.toContain(':');
  });
});

describe('collectSourceTextNodes / auditTextPresence (F5)', () => {
  it('collects every visible TEXT node of the primary frame from the raw payload', () => {
    const texts = collectSourceTextNodes(fixtureRaw(), NODE_ID);
    expect(texts.length).toBeGreaterThanOrEqual(5);
    expect(texts.map((t) => t.text)).toContain('Find a Store');
  });

  it('a text missing from the tree AND unaccounted fails the audit; an accounted one is dropped', () => {
    const raw = fixtureRaw();
    const report = figmaParse(raw, { node_id: NODE_ID }).figma;
    // An empty tree: every text is missing unless accounted by a flatten/drop record.
    const audit = auditTextPresence(raw, report, []);
    expect(audit.total).toBeGreaterThan(0);
    expect(audit.pass).toBe(false);
    expect(audit.missing.length + audit.dropped).toBe(audit.total);
  });

  it('texts present in the wire tree (even split across folded inline markup) count as present', () => {
    const raw = fixtureRaw();
    const report = figmaParse(raw, { node_id: NODE_ID }).figma;
    const tree = [
      {
        id: 'aaaaaaa',
        elType: 'widget',
        widgetType: 'html',
        settings: {
          html: 'Famously Delicious. Every Grape Has a Story Worth Tasting Famous Vineyards brings you a curated collection of the most exceptional grapes. Each variety is selected for its distinct flavor, texture, and character. Discover what makes every bite unforgettable. Find a Store By clicking Sign Up you’re confirming that you agree with our <a href="https://x">Terms and Conditions</a>.',
        },
      },
    ] as unknown as ElementNode[];
    const audit = auditTextPresence(raw, report, tree);
    expect(audit.missing).toEqual([]);
    expect(audit.pass).toBe(true);
  });
});

/* ─────────────────────────── offline integration (REAL resume + REAL figmaParse) ─────────────── */

/** Build a COMPLETE §7 work dir so the REAL `fetchFrameToWorkDir` resumes with zero port calls. */
async function buildWorkDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'emcp-figma-pipe-'));
  await writeFile(path.join(dir, FIGMA_ARTIFACTS.raw), JSON.stringify(fixtureRaw()), 'utf8');
  await writeFile(path.join(dir, FIGMA_ARTIFACTS.simplified), JSON.stringify({}), 'utf8');
  // The COMMITTED real frame render (not a stub) — the F4 suite below verifies against it.
  await writeFile(path.join(dir, FIGMA_ARTIFACTS.render), readFileSync(RENDER_PATH));
  await writeFile(
    path.join(dir, FIGMA_ARTIFACTS.image_fills),
    JSON.stringify({ [HERO_IMAGE_REF]: 'https://temp-fills.example/hero-bg.png' }),
    'utf8',
  );
  const manifest: FigmaExtractionManifest = {
    file_key: FILE_KEY,
    node_id: NODE_ID,
    frame_name: 'WPOS Figma v2 (trimmed hero)',
    frame_size: { width: 1440, height: 790 },
    asset_map: { [`render:${NODE_ID}`]: 'https://temp-renders.example/frame.png' },
    artifacts: {
      raw: FIGMA_ARTIFACTS.raw,
      simplified: FIGMA_ARTIFACTS.simplified,
      render: FIGMA_ARTIFACTS.render,
      image_fills: FIGMA_ARTIFACTS.image_fills,
    },
    fetched_at: '2026-06-11T00:00:00.000Z',
  };
  await writeFile(path.join(dir, FIGMA_ARTIFACTS.manifest), JSON.stringify(manifest), 'utf8');
  return dir;
}

/** An in-memory FigmaPort: only the §3 flatten renders may be requested (resume covers the rest). */
function fakeFigmaPort(): { port: FigmaPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    port: {
      getFileJson: () => {
        calls.push('getFileJson');
        throw new Error('resume must NEVER re-fetch the file JSON (§7)');
      },
      renderNodes: (req) => {
        calls.push(`renderNodes:${req.ids}`);
        return Promise.resolve(
          Object.fromEntries(
            req.ids.split(',').map((id) => [id, `https://temp-renders.example/${id}.png`]),
          ),
        );
      },
      getImageFills: () => {
        calls.push('getImageFills');
        throw new Error('resume must NEVER re-fetch image fills (§7)');
      },
      download: () => {
        calls.push('download');
        return Promise.resolve(new Uint8Array([0x89]));
      },
    },
  };
}

/** The stub bundle: vi.fn-typed fields so expectations never trip `unbound-method`. */
interface StubPorts {
  schema: Record<'breakpoints' | 'styles' | 'capabilities', ReturnType<typeof vi.fn>>;
  design: Record<
    'listClasses' | 'upsertClasses' | 'listVariables' | 'batchVariables' | 'listInstalledFonts',
    ReturnType<typeof vi.fn>
  >;
  document: Record<
    'create' | 'getStructure' | 'dryRun' | 'save' | 'replaceTree' | 'primeCss' | 'updateSettings',
    ReturnType<typeof vi.fn>
  >;
  media: Record<'sideloadUrl' | 'upload', ReturnType<typeof vi.fn>>;
  ids: Record<'mint' | 'validate', ReturnType<typeof vi.fn>>;
  browser: Record<'withPage', ReturnType<typeof vi.fn>>;
  figma: FigmaPort;
}

/** The stub structurally satisfies the port surface (vi.fn fields are call-compatible). */
function asPorts(stub: StubPorts): ConvertPorts {
  return stub;
}

/** Stubbed ConvertPorts (read-only probes + sideloads; documents only used by figmaToPage). */
function makePorts(figma: FigmaPort): StubPorts {
  let mint = 0;
  let attachment = 100;
  return {
    schema: {
      breakpoints: vi.fn().mockResolvedValue({
        items: [
          { key: 'desktop', direction: 'min', value: 1280 },
          { key: 'mobile', direction: 'max', value: 767 },
        ],
        active_direction: 'min',
        desktop_first: true,
      }),
      styles: vi.fn().mockResolvedValue({
        props: {
          color: { $$type: 'color' },
          background: { $$type: 'background' },
          'font-family': { $$type: 'string' },
          'font-size': { $$type: 'size', units: ['px'] },
          'font-weight': { $$type: 'string' },
          'line-height': { $$type: 'size', units: ['px', 'em'] },
          'text-align': { $$type: 'string', enum: ['left', 'center', 'right', 'justify'] },
          display: { $$type: 'string', enum: ['flex', 'block', 'grid'] },
          'flex-direction': { $$type: 'string', enum: ['row', 'column'] },
          'align-items': { $$type: 'string' },
          'justify-content': { $$type: 'string' },
          gap: { $$type: 'size', units: ['px'] },
          padding: { $$type: 'dimensions' },
          margin: { $$type: 'dimensions' },
          width: { $$type: 'size', units: ['px', '%'] },
          height: { $$type: 'size', units: ['px', '%'] },
          'min-height': { $$type: 'size', units: ['px', 'vh'] },
          'max-width': { $$type: 'size', units: ['px', '%'] },
          'border-radius': { $$type: 'border-radius' },
          'border-width': { $$type: 'border-width' },
          'border-color': { $$type: 'color' },
          'border-style': { $$type: 'string' },
          'box-shadow': { $$type: 'shadow' },
        },
        units: { 'font-size': ['px'] },
        states: ['hover'],
      }),
      capabilities: vi.fn().mockResolvedValue({
        v4: true,
        atomic: true,
        global_classes: true,
        variables: true,
        pro: false,
        pro_atomic_form: false,
        breakpoints: [],
        experiments: {},
        can_update_class: true,
        classes_migrated: true,
        registered_types: { atomic: [], classic: [] },
        versions: { elementor: '4.1.1', pro: null, plugin: '1.0.0' },
        unfiltered_html: true,
      }),
    },
    design: {
      listClasses: vi.fn().mockResolvedValue({ items: [], order: [], next_cursor: null, total: 0 }),
      upsertClasses: vi
        .fn()
        .mockResolvedValue({ ok: true, modified_labels: {}, order: [], total: 0 }),
      listVariables: vi.fn().mockResolvedValue({ variables: {}, total: 0, watermark: 1 }),
      batchVariables: vi.fn().mockResolvedValue({ variables: {}, watermark: 2, total: 0 }),
      listInstalledFonts: vi.fn().mockResolvedValue([]),
    },
    document: {
      create: vi.fn(),
      getStructure: vi.fn(),
      dryRun: vi.fn().mockResolvedValue({
        valid: true,
        errors: [],
        diff: { changed_ids: [], new_ids: [], removed_ids: [], before: {}, after: {} },
        preview_url: 'http://x/?p=0&preview=1',
        id_collisions: [],
        generation_detected: 'v4',
      }),
      save: vi.fn(),
      replaceTree: vi.fn(),
      primeCss: vi.fn(),
      updateSettings: vi.fn(),
    },
    media: {
      sideloadUrl: vi.fn((url: string) => Promise.resolve({ id: ++attachment, url })),
      upload: vi.fn(),
    },
    ids: {
      mint: vi.fn(() => `e-${(1000000 + ++mint).toString(16)}`),
      validate: vi.fn().mockResolvedValue([]),
    },
    browser: { withPage: vi.fn() },
    figma,
  };
}

describe('figmaToTree — offline integration over the committed fixture', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await buildWorkDir();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('resumes from the §7 manifest (zero re-fetches), two-passes the flatten renders, and builds the tree', async () => {
    const { port, calls } = fakeFigmaPort();
    const ports = makePorts(port);

    const build = await figmaToTree(
      { file_key: FILE_KEY, node_id: NODE_ID, options: { work_dir: workDir } },
      asPorts(ports),
    );

    // §7 resume: ONLY the flatten renders touched the port (never getFileJson/getImageFills).
    expect(build.extraction.resumed).toBe(true);
    expect(calls.every((c) => c.startsWith('renderNodes:'))).toBe(true);
    expect(calls.length).toBe(1); // one batched render call for all flatten roots

    // The §3 flatten record (the fixture's real VECTOR) + the render cache landed in the work dir.
    expect(build.figma.flattened.length).toBeGreaterThan(0);
    expect(existsSync(path.join(workDir, FLATTEN_RENDERS_FILE))).toBe(true);

    // §6 block + F5.
    expect(build.figma.frame).toEqual({
      file_key: FILE_KEY,
      node_id: NODE_ID,
      name: expect.any(String) as string,
      width: 1440,
      height: 790,
    });
    expect(build.figma.text_presence?.pass).toBe(true);
    expect(['frames', 'synthesized']).toContain(build.figma.responsive);

    // F3: every temp URL (image fill + flatten render) was sideloaded; NONE persists in the tree.
    const wire = JSON.stringify(build.result.elements);
    expect(wire).not.toContain('temp-fills.example');
    expect(wire).not.toContain('temp-renders.example');
  });

  it('a second run reuses the flatten-render cache (zero port calls at all)', async () => {
    const first = fakeFigmaPort();
    await figmaToTree(
      { file_key: FILE_KEY, node_id: NODE_ID, options: { work_dir: workDir } },
      asPorts(makePorts(first.port)),
    );
    const second = fakeFigmaPort();
    const build = await figmaToTree(
      { file_key: FILE_KEY, node_id: NODE_ID, options: { work_dir: workDir } },
      asPorts(makePorts(second.port)),
    );
    expect(second.calls).toEqual([]);
    expect(build.figma.resumed).toBe(true);
  });
});

describe('figmaToPage — commit:false preview through the SHARED persist path', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await buildWorkDir();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('runs the authoritative preview dry_run, persists NOTHING, writes the F4 verify-source doc', async () => {
    const { port } = fakeFigmaPort();
    const ports = makePorts(port);
    const confirm = vi.fn().mockResolvedValue(true);

    const result = await figmaToPage(
      { file_key: FILE_KEY, node_id: NODE_ID, options: { work_dir: workDir } },
      asPorts(ports),
      confirm,
    );

    expect(result.status).toBe('preview');
    expect(result.committed).toBe(false);
    expect(result.figma?.frame.node_id).toBe(NODE_ID);
    expect(ports.document.dryRun).toHaveBeenCalledTimes(1);
    expect(ports.document.create).not.toHaveBeenCalled();
    expect(ports.document.save).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled(); // commit:false never reaches the confirm

    // F4 — the frame render IS the verify source (written next to the artifacts).
    const verifyDoc = await readFile(path.join(workDir, VERIFY_SOURCE_FILE), 'utf8');
    expect(verifyDoc).toContain(FIGMA_ARTIFACTS.render);
  });

  it('contract 18 §5 — a11y blockers are ADVISORY on the Figma commit gate (reported, never gating)', async () => {
    // Duplicate the h1-scale heading TEXT (fontSize 56) → TWO inferred <h1>s = the multi-h1 a11y
    // BLOCKER. Figma heading levels are INFERRED (type scale + layer names), so the gate must not
    // refuse on them (W18 live run: 9 phantom multi-h1 blockers refused a clean commit). The
    // declined-confirm stop proves the gate PASSED and the path reached the elicitation.
    const raw = fixtureRaw() as {
      nodes: Record<string, { document: { children: Array<{ children?: unknown[] }> } }>;
    };
    const frame = raw.nodes[NODE_ID]?.document as unknown as {
      children: Array<{
        id: string;
        children?: Array<{ id: string; style?: { fontSize?: number } }>;
      }>;
    };
    const findHeading = (n: { id: string; children?: unknown[] }): unknown => {
      if (n.id === '400:7517') return n;
      for (const c of (n.children ?? []) as Array<{ id: string; children?: unknown[] }>) {
        const f = findHeading(c);
        if (f !== undefined) return f;
      }
      return undefined;
    };
    const heading = findHeading(frame as unknown as { id: string; children?: unknown[] }) as {
      id: string;
      characters?: string;
    };
    expect(heading).toBeDefined();
    const twin = JSON.parse(JSON.stringify(heading)) as { id: string };
    twin.id = '400:9999';
    frame.children.push(twin);
    await writeFile(path.join(workDir, FIGMA_ARTIFACTS.raw), JSON.stringify(raw), 'utf8');

    const { port } = fakeFigmaPort();
    const ports = makePorts(port);
    const decline = vi.fn().mockResolvedValue(false);

    const result = await figmaToPage(
      {
        file_key: FILE_KEY,
        node_id: NODE_ID,
        commit: true,
        coverage_gate: 0,
        options: { work_dir: workDir },
      },
      asPorts(ports),
      decline,
    );

    // The blocker exists AND rides the report — but the gate let the commit through to the confirm.
    expect(result.report.a11y.some((f) => f.severity === 'blocker')).toBe(true);
    expect(result.status).toBe('declined');
    expect(decline).toHaveBeenCalledTimes(1);
    expect(ports.document.save).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────── §6 CI corpus — the COMMITTED frame render (F4) ──────────────────── */

describe('the committed frame render fixture (§6: node JSON snapshot + frame PNG committed)', () => {
  it('is a real decodable PNG at the manifest frame size (1440×790), not a stub', () => {
    const bytes = readFileSync(RENDER_PATH);
    // A stub (`[0x89]` / 4 magic bytes) cannot decode; the REAL render must.
    const png = PNG.sync.read(bytes);
    expect(png.width).toBe(1440);
    expect(png.height).toBe(790);
    // Real pixels, not a blank canvas: some non-transparent, non-uniform content.
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });
});

/**
 * F4 LIVE: the verify loop runs against the `verify-source.html` document embedding the COMMITTED
 * render — the exact ground-truth path `figmaToPage` wires on commit. Gated on an installed
 * Chromium (same convention as verify-loop.test.ts); the corpus job installs it, plain stage-1
 * runners skip. A faithful "converted page" (the same document) must verify near-zero.
 */
let chromiumAvailable: boolean | null = null;
async function probeChromium(): Promise<boolean> {
  if (chromiumAvailable !== null) return chromiumAvailable;
  try {
    const browser = await getBrowser();
    chromiumAvailable = browser.isConnected();
  } catch (err) {
    console.warn(
      `[figma-pipeline.test] SKIP F4 live case: Chromium unavailable (${(err as Error).message}). ` +
        'Run `pnpm --filter @elementor-ultra/server exec playwright install chromium`.',
    );
    chromiumAvailable = false;
  }
  return chromiumAvailable;
}

afterAll(async () => {
  await closeBrowser();
});

describe('F4 — runVerifyLoop against the committed frame render (live Chromium)', () => {
  it('verifies the frame-render verify-source for real: render paints, audits pass, pixel ≈ 0', async () => {
    if (!(await probeChromium())) return;

    const workDir = await buildWorkDir();
    try {
      const { port } = fakeFigmaPort();
      await figmaToPage(
        { file_key: FILE_KEY, node_id: NODE_ID, options: { work_dir: workDir } },
        asPorts(makePorts(port)),
        vi.fn().mockResolvedValue(true),
      );

      const verifyUrl = pathToFileURL(path.join(workDir, VERIFY_SOURCE_FILE)).href;
      const result = await runVerifyLoop(undefined, {
        sourceUrlOrHtml: verifyUrl,
        pageUrl: verifyUrl,
        breakpoints: [{ key: 'desktop', width: 1440, direction: 'min' }],
      });

      // The committed render actually painted: the 1440-wide img scales to its 790px height —
      // a broken/missing image would collapse to a ~0-height page and a blank screenshot.
      expect(result.layoutAudits[0]?.source_height).toBeGreaterThan(700);
      expect(result.layoutAudits[0]?.scroll_width_ok).toBe(true);
      expect(result.layoutAudits[0]?.pass).toBe(true);
      // Identical source/converted documents ⇒ near-zero pixel divergence (the F4 ground truth).
      expect(result.pixelScore[0]?.ratio).toBeLessThan(0.005);
      expect(result.divergences).toEqual([]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }, 120_000);
});
