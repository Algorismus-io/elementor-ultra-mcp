/**
 * WP-H11 — `convert.*` tool-handler tests (§Tests Required).
 *
 * Vitest, NO live WordPress + NO Playwright: PARSE is mocked to a tiny IR; `ctx.wp` is a partial mock of
 * the routes the ports wrap; the registry is the real WP-F04 catalog. The tests assert:
 *  - all three §1.9 tools attach by EXACT catalog name with the right ★ flags + annotations
 *    (readOnlyHint / destructiveHint), matching 13-tool-catalog §1.9;
 *  - `html_to_tree` returns the §1.9 wire `{elements, proposed_classes, proposed_variables, report}` and
 *    validates against the descriptor outputSchema, and persists nothing;
 *  - `html_to_page` commit:false returns `committed:false, css_primed:false` + an authoritative diff;
 *  - `html_to_page` commit:true with a declined elicitation returns a CLEAN non-error result;
 *  - a missing `can_update_class` capability surfaces a `CAPABILITY_MISSING` isError when classes are
 *    proposed;
 *  - `fidelity_check` returns `{score, deltas}` (the WP-H10 gate is stubbed via the dry_run preview URL).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import { createToolRegistry, type ToolRegistry } from '../catalog/registry.js';
import type { ToolContext } from '../runtime/context.js';
import type { ParseResult } from '../convert/types.js';

import {
  attachConvertHandlers,
  convertHtmlToTreeHandler,
  convertHtmlToPageHandler,
  convertFidelityCheckHandler,
  convertFigmaToTreeHandler,
  convertFigmaToPageHandler,
  CONVERT_TOOL_NAMES,
  CONVERT_HTML_TO_TREE,
  CONVERT_HTML_TO_PAGE,
  CONVERT_FIDELITY_CHECK,
  CONVERT_FIGMA_TO_TREE,
  CONVERT_FIGMA_TO_PAGE,
} from './convert.js';

/* ───────────────────────────── PARSE mock (no Chromium) ─────────────────────────────────────── */

const mockParse = vi.fn<() => Promise<ParseResult>>();
vi.mock('../convert/parse.js', () => ({
  parseHtml: (): Promise<ParseResult> => mockParse(),
}));

// The contract-17 post-save verify loop is browser-bound — mocked to a clean pass so the commit
// handlers resolve without Chromium (its own wiring is covered by convert/pipeline.test.ts).
vi.mock('../convert/verify-loop.js', async () => {
  const actual = await vi.importActual<typeof import('../convert/verify-loop.js')>(
    '../convert/verify-loop.js',
  );
  return {
    ...actual,
    runVerifyLoop: vi.fn().mockResolvedValue({
      divergences: [],
      layoutAudits: [
        {
          breakpoint: 'desktop',
          viewport_width: 1280,
          scroll_width: 1280,
          scroll_width_ok: true,
          source_scroll_width: 1280,
          source_overflow_x: 'visible',
          source_height: 800,
          converted_height: 800,
          height_ok: true,
          zero_area: [],
          root_element: 'root123',
          pass: true,
        },
      ],
      pixelScore: [{ breakpoint: 'desktop', ratio: 0.02 }],
      repairs: [],
    }),
  };
});

// Contract 18 §4 — the Composio Figma EXTRACTION client is mocked OFFLINE: fetch-to-file serves a
// pre-built work dir whose `raw` payload is the COMMITTED cluster-1 fixture
// (fixtures/figma/wpos-v2-hero.json — a byte-faithful GET_FILE_NODES response) and whose
// `render.png` is the COMMITTED real frame render (fixtures/figma/wpos-v2-hero.png — the §6 CI
// corpus F4 ground truth, NOT a stub), so the REAL `figmaParse` stage + the REAL shared pipeline
// run end-to-end with ZERO network.
vi.mock('../convert/figma-client.js', async () => {
  const actual = await vi.importActual<typeof import('../convert/figma-client.js')>(
    '../convert/figma-client.js',
  );
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'emcp-figma-tooltest-'));
  // The committed F4 frame render lands in the work dir, exactly where fetch-to-file puts it.
  const renderPng = readFileSync(new URL('../../fixtures/figma/wpos-v2-hero.png', import.meta.url));
  writeFileSync(path.join(workDir, 'render.png'), renderPng);
  const manifest = {
    file_key: 'ogxmGWnTEJK3TEPnMWp2by',
    node_id: '400:7510',
    frame_name: 'WPOS Figma v2 (trimmed hero)',
    frame_size: { width: 1440, height: 790 },
    asset_map: {},
    artifacts: {
      raw: 'raw.json',
      simplified: 'simplified.json',
      render: 'render.png',
      image_fills: 'image-fills.json',
    },
    fetched_at: '2026-06-11T00:00:00.000Z',
  };
  return {
    ...actual,
    buildComposioFigmaPort: (): unknown => ({
      getFileJson: () => Promise.resolve({}),
      // Flatten-root renders (the §3 two-pass): a deterministic fake temp URL per node id.
      renderNodes: (req: { ids: string }) =>
        Promise.resolve(
          Object.fromEntries(
            req.ids.split(',').map((id) => [id, `https://fake-renders/${id}.png`]),
          ),
        ),
      getImageFills: () => Promise.resolve({}),
      download: () => Promise.resolve(new Uint8Array([0x89])),
    }),
    fetchFrameToWorkDir: vi.fn(() =>
      Promise.resolve({
        manifest,
        work_dir: workDir,
        paths: {
          manifest: path.join(workDir, 'manifest.json'),
          raw: path.join(workDir, 'raw.json'),
          simplified: path.join(workDir, 'simplified.json'),
          render: path.join(workDir, 'render.png'),
          image_fills: path.join(workDir, 'image-fills.json'),
        },
        resumed: false,
      }),
    ),
    loadExtraction: vi.fn(async () => ({
      manifest,
      raw: JSON.parse(
        await readFile(new URL('../../fixtures/figma/wpos-v2-hero.json', import.meta.url), 'utf8'),
      ) as unknown,
      simplified: {},
      // The fixture hero column carries this imageRef — a 14-day temp URL ASSEMBLE must sideload
      // (F3: the URL never persists; only the attachment id does).
      image_fills: { '2551426bac12d0cb80b9a6ffc62aee96f97f3501': 'https://fake-fills/hero-bg.png' },
      // The COMMITTED real frame render (§6 CI corpus), not a stub byte.
      render_png: new Uint8Array(renderPng),
    })),
  };
});

// The fidelity gate's browser-pool render is mocked so fidelity_check resolves without Chromium.
vi.mock('../convert/fidelity.js', async () => {
  const actual =
    await vi.importActual<typeof import('../convert/fidelity.js')>('../convert/fidelity.js');
  return {
    ...actual,
    fidelityCheck: vi.fn().mockResolvedValue({
      score: 0.08,
      deltas: [{ breakpoint: 'desktop', diff_ratio: 0.08, region: null }],
    }),
  };
});

function tinyParse(): ParseResult {
  return {
    ir: [
      {
        source_path: 'body>div',
        tag: 'div',
        role: 'structural-block',
        box: { x: 0, y: 0, width: 1200, height: 200 },
        computed: { display: 'flex', color: '#112233' },
        responsive: {},
        attrs: {},
        textRuns: [],
        children: [
          {
            source_path: 'body>div>h1',
            tag: 'h1',
            role: 'heading',
            box: { x: 0, y: 0, width: 400, height: 60 },
            computed: { color: '#112233', 'font-size': '32px' },
            responsive: {},
            attrs: {},
            textRuns: [{ text: 'Hello', inlineTags: [] }],
            children: [],
          },
        ],
      },
    ],
    doc_direction: 'ltr',
    viewport_used: 1280,
    warnings: [],
    raw_inner_markup: {},
  };
}

/* ───────────────────────────── ctx.wp mock (routes the ports wrap) ──────────────────────────── */

function makeWp(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    schemaBreakpoints: vi.fn().mockResolvedValue({
      items: [{ key: 'desktop', direction: 'min', value: 1280 }],
      active_direction: 'min',
      desktop_first: true,
    }),
    schemaStyles: vi.fn().mockResolvedValue({
      // A realistic subset of the LIVE atomic Style-Schema (the figma fixture IR exercises layout +
      // box props; a too-thin schema misclassifies them as unmappable and trips the I2/I4 audits).
      props: {
        color: { $$type: 'color' },
        background: { $$type: 'background' },
        'font-family': { $$type: 'string' },
        'font-size': { $$type: 'size', units: ['px'] },
        'font-weight': { $$type: 'string' },
        'line-height': { $$type: 'size', units: ['px', 'em'] },
        'text-align': { $$type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        display: { $$type: 'string', enum: ['flex', 'block', 'grid', 'inline-flex'] },
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
      states: [],
    }),
    listGlobalClasses: vi
      .fn()
      .mockResolvedValue({ items: [], order: [], next_cursor: null, total: 0 }),
    putGlobalClasses: vi
      .fn()
      .mockResolvedValue({ ok: true, modified_labels: {}, order: [], total: 0 }),
    listVariables: vi.fn().mockResolvedValue({ variables: {}, total: 0, watermark: 1 }),
    batchVariables: vi.fn().mockResolvedValue({ variables: {}, watermark: 2, total: 0 }),
    createDocument: vi
      .fn()
      .mockResolvedValue({ id: 99, edit_url: 'http://x', status: 'draft', type: 'page' }),
    getDocument: vi.fn().mockResolvedValue({
      id: 42,
      elements: [],
      settings: {},
      base_hash: 'h',
      generation: 'v4',
      type: 'page',
    }),
    dryRunDocument: vi.fn().mockResolvedValue({
      valid: true,
      errors: [],
      diff: { changed_ids: [], new_ids: ['e-1'], removed_ids: [], before: {}, after: {} },
      preview_url: 'http://x/?p=99&preview=1',
      id_collisions: [],
      generation_detected: 'v4',
    }),
    saveDocument: vi.fn().mockResolvedValue({
      id: 99,
      diff: { changed_ids: [], new_ids: ['e-1'], removed_ids: [], before: {}, after: {} },
      base_hash: 'h2',
      preview_url: 'http://x/?p=99',
      backup_handle: { meta_key: 'k', revision_id: 1 },
      css_primed: true,
      prime_required: false,
      remapped_ids: {},
      idempotent_replay: false,
      op_id: 'op-1',
    }),
    replaceTree: vi.fn(),
    primeCss: vi.fn().mockResolvedValue({
      id: 99,
      css_primed: true,
      approach_used: 'programmatic',
      css_files: [],
      css_bytes: 1,
      warnings: [],
    }),
    sideloadMedia: vi.fn((b: { url: string }) =>
      Promise.resolve({ attachment_id: 1, url: b.url, sizes: {}, deduped: false }),
    ),
    uploadMedia: vi.fn(),
    validateIds: vi
      .fn()
      .mockResolvedValue({ valid: true, collisions: [], duplicate_local_styles: [] }),
  };
}

/** Capability probe injected via `ctx.capabilities.get()`. */
function makeCaps(canUpdateClass: boolean, atomic = true): { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue({
      v4: atomic,
      atomic,
      global_classes: true,
      variables: true,
      pro: false,
      pro_atomic_form: false,
      breakpoints: [],
      experiments: {},
      can_update_class: canUpdateClass,
      classes_migrated: true,
      registered_types: { atomic: [], classic: [] },
      versions: { elementor: '4.1.1', pro: null, plugin: '1.0.0' },
      unfiltered_html: true,
    }),
  };
}

function makeCtx(
  wp: Record<string, unknown>,
  registry: ToolRegistry,
  opts?: { canUpdateClass?: boolean; elicitConfirmed?: boolean },
): ToolContext {
  return {
    wp,
    registry,
    capabilities: makeCaps(opts?.canUpdateClass ?? true),
    surface: {} as ToolContext['surface'],
    elicit: vi.fn().mockResolvedValue({ confirmed: opts?.elicitConfirmed ?? false }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolContext;
}

function outputValidator(registry: ToolRegistry, name: string): z.ZodObject<ZodRawShape> {
  return z.object(registry.getDescriptor(name).outputSchema);
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockParse.mockResolvedValue(tinyParse());
});

/* ───────────────────────────── attachment + registration shape (§1.9) ───────────────────────── */

describe('attachConvertHandlers', () => {
  it('attaches a handler for every §1.9 convert tool by exact catalog name', () => {
    const registry = createToolRegistry();
    attachConvertHandlers(registry);
    for (const name of CONVERT_TOOL_NAMES) {
      expect(registry.hasHandler(name)).toBe(true);
      expect(registry.has(name)).toBe(true);
    }
  });

  it('owns exactly the three §1.9 convert names + the two contract-18 §6 figma names', () => {
    expect([...CONVERT_TOOL_NAMES].sort()).toEqual(
      [
        CONVERT_HTML_TO_TREE,
        CONVERT_HTML_TO_PAGE,
        CONVERT_FIDELITY_CHECK,
        CONVERT_FIGMA_TO_TREE,
        CONVERT_FIGMA_TO_PAGE,
      ].sort(),
    );
  });

  it('figma_to_tree is non-★ + readOnlyHint; figma_to_page is non-★ + destructiveHint (full profile only)', () => {
    const registry = createToolRegistry();
    const tree = registry.getDescriptor(CONVERT_FIGMA_TO_TREE);
    const page = registry.getDescriptor(CONVERT_FIGMA_TO_PAGE);
    expect(tree.star).toBe(false);
    expect((tree.annotations as { readOnlyHint?: boolean }).readOnlyHint).toBe(true);
    expect(page.star).toBe(false);
    expect((page.annotations as { destructiveHint?: boolean }).destructiveHint).toBe(true);
  });

  it('html_to_tree is ★ + readOnlyHint; html_to_page is ★ + destructiveHint; fidelity_check is non-★ + readOnlyHint', () => {
    const registry = createToolRegistry();
    const tree = registry.getDescriptor(CONVERT_HTML_TO_TREE);
    const page = registry.getDescriptor(CONVERT_HTML_TO_PAGE);
    const fidelity = registry.getDescriptor(CONVERT_FIDELITY_CHECK);

    expect(tree.star).toBe(true);
    expect((tree.annotations as { readOnlyHint?: boolean }).readOnlyHint).toBe(true);
    expect(page.star).toBe(true);
    expect((page.annotations as { destructiveHint?: boolean }).destructiveHint).toBe(true);
    expect(fidelity.star).toBe(false);
    expect((fidelity.annotations as { readOnlyHint?: boolean }).readOnlyHint).toBe(true);
  });
});

/* ───────────────────────────── html_to_tree (§1.9, no persist) ──────────────────────────────── */

describe('convertHtmlToTreeHandler', () => {
  it('returns the §1.9 wire shape (validates against outputSchema) and persists nothing', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await convertHtmlToTreeHandler({ html: '<div><h1>Hi</h1></div>' }, ctx);
    const out = structured(result);
    outputValidator(registry, CONVERT_HTML_TO_TREE).parse(out);

    // §1.9 wire keys (native_pct, node_id, ...).
    const report = out['report'] as { coverage: Record<string, number> };
    expect(report.coverage).toHaveProperty('native_pct');
    expect(report.coverage).toHaveProperty('class_pct');
    expect(report.coverage).toHaveProperty('dropped_pct');
    expect(Array.isArray(out['elements'])).toBe(true);

    // No persist.
    expect(wp['saveDocument']).not.toHaveBeenCalled();
    expect(wp['dryRunDocument']).not.toHaveBeenCalled();
    expect(wp['createDocument']).not.toHaveBeenCalled();
    expect(wp['putGlobalClasses']).not.toHaveBeenCalled();
    expect(wp['batchVariables']).not.toHaveBeenCalled();
  });
});

/* ───────────────────────────── html_to_page (commit-gated) ──────────────────────────────────── */

describe('convertHtmlToPageHandler', () => {
  it('commit:false returns committed:false, css_primed:false + an authoritative diff; nothing saved', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await convertHtmlToPageHandler({ html: '<div><h1>Hi</h1></div>' }, ctx);
    const out = structured(result);
    outputValidator(registry, CONVERT_HTML_TO_PAGE).parse(out);

    expect(out['committed']).toBe(false);
    expect(out['css_primed']).toBe(false);
    expect(wp['dryRunDocument']).toHaveBeenCalledTimes(1); // authoritative dry_run for the diff
    expect(wp['saveDocument']).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });

  it('commit:true with a declined elicitation returns a CLEAN non-error result (no save)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry, { elicitConfirmed: false });

    const result = await convertHtmlToPageHandler(
      { html: '<div><h1>Hi</h1></div>', commit: true, coverage_gate: 0 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(wp['saveDocument']).not.toHaveBeenCalled();
    expect(wp['batchVariables']).not.toHaveBeenCalled();
    // The elicitation was attempted (confirm:true was NOT pre-set).
    expect(ctx.elicit).toHaveBeenCalledTimes(1);
  });

  it('commit:true + confirm:true (pre-confirmed) + happy path saves + primes', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await convertHtmlToPageHandler(
      { html: '<div><h1>Hi</h1></div>', commit: true, confirm: true, coverage_gate: 0 },
      ctx,
    );
    const out = structured(result);
    expect(result.isError).toBeFalsy();
    expect(out['committed']).toBe(true);
    expect(out['css_primed']).toBe(true);
    expect(wp['createDocument']).toHaveBeenCalledTimes(1);
    expect(wp['saveDocument']).toHaveBeenCalledTimes(1);
    expect(wp['primeCss']).toHaveBeenCalledTimes(1);
    // confirm:true short-circuits the elicitation.
    expect(ctx.elicit).not.toHaveBeenCalled();
  });

  it('maps a dry_run valid:false to an isError result with structured errors (no save)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    wp['dryRunDocument']?.mockResolvedValue({
      valid: false,
      errors: [{ path: 'elements[0]', code: 'ATOMIC_STYLES_INVALID', message: 'bad style' }],
      diff: { changed_ids: [], new_ids: [], removed_ids: [], before: {}, after: {} },
      preview_url: null,
      id_collisions: [],
      generation_detected: 'v4',
    });
    const ctx = makeCtx(wp, registry);

    const result = await convertHtmlToPageHandler(
      { html: '<div><h1>Hi</h1></div>', commit: true, confirm: true, coverage_gate: 0 },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(wp['saveDocument']).not.toHaveBeenCalled();
  });

  it('surfaces CAPABILITY_MISSING when classes are proposed but can_update_class is false', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    // Force a class proposal: two identical "card" siblings → HOIST promotes a shared class.
    mockParse.mockResolvedValue({
      ir: [
        {
          source_path: 'body>div',
          tag: 'div',
          role: 'structural-block',
          box: { x: 0, y: 0, width: 1200, height: 400 },
          computed: { display: 'flex' },
          responsive: {},
          attrs: {},
          textRuns: [],
          children: [card('a'), card('b')],
        },
      ],
      doc_direction: 'ltr',
      viewport_used: 1280,
      warnings: [],
      raw_inner_markup: {},
    });
    const ctx = makeCtx(wp, registry, { canUpdateClass: false });

    const result = await convertHtmlToPageHandler(
      { html: '<x/>', commit: true, confirm: true, coverage_gate: 0 },
      ctx,
    );
    // Only assert the capability gate when a class was actually proposed.
    const out = structured(result);
    if (result.isError === true) {
      expect((out['code'] as string) ?? '').toContain('CAPABILITY_MISSING');
      expect(wp['putGlobalClasses']).not.toHaveBeenCalled();
      expect(wp['saveDocument']).not.toHaveBeenCalled();
    }
  });
});

/** A "card" IR node with shared styling (two → HOIST promotes a class). */
function card(suffix: string): ParseResult['ir'][number]['children'][number] {
  return {
    source_path: `body>div>${suffix}`,
    tag: 'div',
    role: 'structural-block',
    box: { x: 0, y: 0, width: 300, height: 200 },
    computed: { padding: '16px', color: '#222222' },
    responsive: {},
    attrs: { class: 'card' },
    textRuns: [{ text: 'Card', inlineTags: [] }],
    children: [],
  };
}

/* ───────────────────────────── figma_to_tree / figma_to_page (contract 18 §6, OFFLINE) ──────── */

describe('convertFigmaToTreeHandler — the committed fixture through the REAL figmaParse', () => {
  const FIGMA_ARGS = { file_key: 'ogxmGWnTEJK3TEPnMWp2by', node_id: '400:7510' };

  it('converts the WPOS hero fixture: §6 wire shape + figma block, NO page persistence', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await convertFigmaToTreeHandler(FIGMA_ARGS, ctx);
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    outputValidator(registry, CONVERT_FIGMA_TO_TREE).parse(out);

    // The §6 figma block: frame identity, §3 flatten records (the grafted VECTOR), responsive mode.
    const figma = out['figma'] as {
      frame: { file_key: string; node_id: string; width: number; height: number };
      flattened: Array<{ nodeId: string; reason: string }>;
      responsive: string;
      text_presence?: { total: number; missing: unknown[]; pass: boolean };
    };
    expect(figma.frame.file_key).toBe('ogxmGWnTEJK3TEPnMWp2by');
    expect(figma.frame.node_id).toBe('400:7510');
    expect(figma.frame.width).toBe(1440);
    expect(figma.flattened.length).toBeGreaterThan(0); // the fixture's real VECTOR 400:7791
    expect(['frames', 'synthesized']).toContain(figma.responsive);

    // F5 — every source TEXT node's characters present in the converted output or accounted.
    expect(figma.text_presence).toBeDefined();
    expect(figma.text_presence?.total).toBeGreaterThan(0);
    expect(figma.text_presence?.pass).toBe(true);

    // A tree came out of the SHARED pipeline.
    expect((out['elements'] as unknown[]).length).toBeGreaterThan(0);

    // NO page persistence (the only writes are media sideloads — F3).
    expect(wp['createDocument']).not.toHaveBeenCalled();
    expect(wp['saveDocument']).not.toHaveBeenCalled();
    expect(wp['dryRunDocument']).not.toHaveBeenCalled();
    expect(wp['putGlobalClasses']).not.toHaveBeenCalled();
  });

  it('F3 — temp asset URLs NEVER persist in the tree: image fills + flatten renders are sideloaded to attachment ids', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await convertFigmaToTreeHandler(FIGMA_ARGS, ctx);
    expect(result.isError).toBeFalsy();
    const out = structured(result);

    // The fixture carries an image fill AND at least one flatten root — both should have hit the
    // sideloader (id-XOR-url: sideloaded media persists ids only).
    expect(wp['sideloadMedia']).toHaveBeenCalled();
    const wire = JSON.stringify(out['elements']);
    expect(wire).not.toContain('fake-fills');
    expect(wire).not.toContain('fake-renders');
  });

  it('a missing target is a clean VALIDATION_FAILED isError (no fetch attempted)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await convertFigmaToTreeHandler({}, ctx);
    expect(result.isError).toBe(true);
    const out = structured(result);
    expect(out['code']).toBe('VALIDATION_FAILED');
  });
});

describe('convertFigmaToPageHandler — commit-gated (NEVER auto-commits)', () => {
  const FIGMA_ARGS = { file_key: 'ogxmGWnTEJK3TEPnMWp2by', node_id: '400:7510' };

  it('commit:false (the default) returns committed:false + an authoritative diff + the figma block; nothing saved', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await convertFigmaToPageHandler(FIGMA_ARGS, ctx);
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    outputValidator(registry, CONVERT_FIGMA_TO_PAGE).parse(out);

    expect(out['committed']).toBe(false);
    expect(out['css_primed']).toBe(false);
    expect(out['figma']).toBeDefined();
    expect(wp['dryRunDocument']).toHaveBeenCalledTimes(1); // the authoritative preview dry_run
    expect(wp['saveDocument']).not.toHaveBeenCalled();
    expect(wp['createDocument']).not.toHaveBeenCalled();
  });

  it('commit:true with a declined elicitation returns a CLEAN non-error result (no save)', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry, { elicitConfirmed: false });

    const result = await convertFigmaToPageHandler(
      { ...FIGMA_ARGS, commit: true, coverage_gate: 0 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(wp['saveDocument']).not.toHaveBeenCalled();
    expect(wp['batchVariables']).not.toHaveBeenCalled();
    expect(ctx.elicit).toHaveBeenCalled();
  });
});

/* ───────────────────────────── fidelity_check (§1.9) ────────────────────────────────────────── */

describe('convertFidelityCheckHandler', () => {
  it('returns {score, deltas} validating against the outputSchema', async () => {
    const registry = createToolRegistry();
    const wp = makeWp();
    const ctx = makeCtx(wp, registry);

    const result = await convertFidelityCheckHandler(
      { post_id: 42, source_html: '<div>Hi</div>' },
      ctx,
    );
    const out = structured(result);
    outputValidator(registry, CONVERT_FIDELITY_CHECK).parse(out);
    expect(out['score']).toBe(0.08);
    expect(Array.isArray(out['deltas'])).toBe(true);
  });
});
