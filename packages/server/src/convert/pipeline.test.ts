/**
 * WP-H11 — convert orchestrator (`pipeline.ts`) unit tests (§Tests Required).
 *
 * Vitest, NO live WordPress + NO Playwright: PARSE (the only Chromium-touching stage) is mocked to a
 * tiny deterministic IR so the REAL downstream stages (normalize..coverage) compose for real, and the
 * `ConvertPorts` are fully stubbed (vi.fn). The tests assert:
 *  - `htmlToTree` runs the stage composition (probes breakpoints/styles/capabilities + reads existing
 *    classes/variables) and persists NOTHING;
 *  - `htmlToPage` commit:false runs an AUTHORITATIVE dry_run and saves nothing (`committed:false`);
 *  - commit:true gate-deny (coverage below the floor) returns a clean refusal (`status:'gate_denied'`);
 *  - commit:true confirm-decline returns a clean non-error (`status:'declined'`);
 *  - commit:true happy-path runs the sequence (variables.batch → classes diff-PUT → resolve placeholders
 *    → authoritative dry_run → save → prime-css) and reports `committed:true` with honest `css_primed`;
 *  - a `DUPLICATED_LABEL` rename from the diff-PUT is surfaced (`duplicated_labels`);
 *  - a dry_run `valid:false` short-circuits to `status:'invalid'` (the save is NEVER attempted);
 *  - `op_id` threads to the save and `IDEMPOTENT_REPLAY` is surfaced informationally;
 *  - the `__class:`/`__var:` placeholder resolver rewrites the tree in one pass.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  htmlToTree,
  htmlToPage,
  resolvePlaceholders,
  shapeDiff,
  ConvertIntegrityError,
  DEFAULT_COVERAGE_GATE,
  DEFAULT_VERIFY_GATE,
  JS_PASSTHROUGH_TIER_REASONS,
  type Confirmer,
} from './pipeline.js';
import type { ConvertPorts } from './ports.js';
import type { ParseResult } from './types.js';
import type { IntegrityInput, IntegrityRunResult } from './integrity.js';
import type { VerifyLoopResult } from './verify-loop.js';

/* ───────────────────────────── PARSE mock (the only browser-touching stage) ─────────────────── */

// The mocked PARSE result: a flex row containing a heading + an image. Small but exercises real
// normalize/classify/map/style-extract/assemble/hoist/variable-extract/coverage downstream.
const mockParse = vi.fn<(input?: unknown) => Promise<ParseResult>>();
vi.mock('./parse.js', () => ({
  parseHtml: (input: unknown): Promise<ParseResult> => mockParse(input),
}));

/* ───────────── integrity + verify-loop seams (contract 17 wiring) ───────────── */

// `runIntegrity` defaults to the REAL implementation (the wiring is exercised end-to-end); single
// tests override it to inject violations (hard-fail / soft-surface paths).
const actualIntegrity = await vi.importActual<typeof import('./integrity.js')>('./integrity.js');
const mockRunIntegrity = vi.fn<(input: IntegrityInput) => IntegrityRunResult>();
vi.mock('./integrity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integrity.js')>();
  return {
    ...actual,
    runIntegrity: (input: IntegrityInput): IntegrityRunResult => mockRunIntegrity(input),
  };
});

// The post-save verify loop is browser-bound — mocked to a clean pass by default; the contract-17
// §2–3 tests drive repairs / gate failures through it.
const mockRunVerifyLoop = vi.fn<(ports: unknown, input: unknown) => Promise<VerifyLoopResult>>();
vi.mock('./verify-loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify-loop.js')>();
  return {
    ...actual,
    runVerifyLoop: (ports: unknown, input: unknown): Promise<VerifyLoopResult> =>
      mockRunVerifyLoop(ports, input),
  };
});

/** A clean (all-green) verify-loop pass at desktop. */
function cleanLoopResult(): VerifyLoopResult {
  return {
    divergences: [],
    layoutAudits: [
      {
        breakpoint: 'desktop',
        render_width: 1280,
        viewport_width: 1280,
        viewport_ok: true,
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
    pixelScore: [{ breakpoint: 'desktop', ratio: 0.01 }],
    repairs: [],
    contentAudit: {
      breakpoint: 'desktop',
      total: 0,
      present: 0,
      dropped: 0,
      missing: [],
      pass: true,
    },
    elementCounts: [{ breakpoint: 'desktop', source_count: 2, converted_count: 2, delta: 0 }],
    behaviorProbes: [],
    causeStats: { total: 0, attributed: 0, unknown: 0, attributed_ratio: 1 },
  };
}

/** One V1 divergence row (gate-threshold tests). */
function divergenceRow(prop = 'color'): VerifyLoopResult['divergences'][number] {
  return {
    element: 'abc1234',
    source_path: 'body>div>h1',
    prop,
    source_value: 'rgb(17, 34, 51)',
    converted_value: 'rgb(0, 0, 0)',
    cause: 'unknown',
    breakpoint: 'desktop',
  };
}

/** Build a tiny deterministic IR forest (one flex container with a heading child). */
function tinyParseResult(): ParseResult {
  return {
    ir: [
      {
        source_path: 'body>div',
        tag: 'div',
        role: 'structural-block',
        box: { x: 0, y: 0, width: 1200, height: 200 },
        computed: { display: 'flex', 'flex-direction': 'row', padding: '20px', color: '#112233' },
        responsive: {},
        attrs: { class: 'hero' },
        textRuns: [],
        children: [
          {
            source_path: 'body>div>h1',
            tag: 'h1',
            role: 'heading',
            box: { x: 20, y: 20, width: 400, height: 60 },
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

/* ───────────────────────────── ConvertPorts stub ───────────────────────────────────────────── */

interface StubPorts extends ConvertPorts {
  schema: {
    breakpoints: ReturnType<typeof vi.fn>;
    styles: ReturnType<typeof vi.fn>;
    capabilities: ReturnType<typeof vi.fn>;
  };
  design: {
    listClasses: ReturnType<typeof vi.fn>;
    upsertClasses: ReturnType<typeof vi.fn>;
    listVariables: ReturnType<typeof vi.fn>;
    batchVariables: ReturnType<typeof vi.fn>;
    listInstalledFonts: ReturnType<typeof vi.fn>;
  };
  document: {
    create: ReturnType<typeof vi.fn>;
    getStructure: ReturnType<typeof vi.fn>;
    dryRun: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    replaceTree: ReturnType<typeof vi.fn>;
    primeCss: ReturnType<typeof vi.fn>;
    updateSettings: ReturnType<typeof vi.fn>;
  };
  media: { sideloadUrl: ReturnType<typeof vi.fn>; upload: ReturnType<typeof vi.fn> };
  ids: { mint: ReturnType<typeof vi.fn>; validate: ReturnType<typeof vi.fn> };
  browser: { withPage: ReturnType<typeof vi.fn> };
}

function makePorts(): StubPorts {
  let mintCounter = 0;
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
          'font-size': { $$type: 'size', units: ['px', 'rem'] },
          padding: { $$type: 'dimensions' },
          display: { $$type: 'string', enum: ['flex', 'block', 'grid'] },
          // Present in the live schema; here so the I2 base-default check (contract 17 §1) sees the
          // e-flexbox `flex-direction` override emitted natively (no spurious soft violation).
          'flex-direction': { $$type: 'string', enum: ['row', 'column'] },
        },
        units: { 'font-size': ['px', 'rem'] },
        states: ['hover', 'focus'],
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
      listVariables: vi.fn().mockResolvedValue({ variables: {}, total: 0, watermark: 7 }),
      batchVariables: vi.fn().mockResolvedValue({ variables: {}, watermark: 8, total: 0 }),
      listInstalledFonts: vi.fn().mockResolvedValue([]),
    },
    document: {
      create: vi
        .fn()
        .mockResolvedValue({ id: 99, edit_url: 'http://x/edit', status: 'draft', type: 'page' }),
      getStructure: vi.fn().mockResolvedValue({
        id: 42,
        elements: [],
        settings: {},
        base_hash: 'hash-abc',
        generation: 'v4',
        type: 'page',
      }),
      dryRun: vi.fn().mockResolvedValue({
        valid: true,
        errors: [],
        diff: { changed_ids: [], new_ids: ['e-1'], removed_ids: [], before: {}, after: {} },
        preview_url: 'http://x/?p=99&preview=1',
        id_collisions: [],
        generation_detected: 'v4',
      }),
      save: vi.fn().mockResolvedValue({
        id: 99,
        diff: { changed_ids: [], new_ids: ['e-1'], removed_ids: [], before: {}, after: {} },
        base_hash: 'hash-new',
        preview_url: 'http://x/?p=99',
        backup_handle: { meta_key: 'k', revision_id: 1 },
        css_primed: false,
        prime_required: true,
        remapped_ids: {},
        idempotent_replay: false,
        op_id: 'op-xyz',
      }),
      replaceTree: vi.fn().mockResolvedValue({
        id: 42,
        diff: { changed_ids: ['e-1'], new_ids: [], removed_ids: [], before: {}, after: {} },
        base_hash: 'hash-new',
        preview_url: 'http://x/?p=42',
        backup_handle: { meta_key: 'k', revision_id: 2 },
        css_primed: false,
        prime_required: true,
        remapped_ids: {},
        idempotent_replay: false,
        op_id: 'op-xyz',
      }),
      primeCss: vi.fn().mockResolvedValue({
        id: 99,
        css_primed: true,
        approach_used: 'programmatic',
        css_files: ['local-99-frontend-desktop.css'],
        css_bytes: 1234,
        warnings: [],
      }),
      updateSettings: vi.fn().mockResolvedValue({ success: true, settings: {} }),
    },
    media: {
      sideloadUrl: vi.fn((url: string) => Promise.resolve({ id: ++mintCounter, url })),
      upload: vi.fn(() => Promise.resolve({ id: ++mintCounter, url: 'http://x/u' })),
    },
    ids: {
      mint: vi.fn((existing: Set<string>) => {
        let id = `e-stub-${++mintCounter}`;
        while (existing.has(id)) id = `e-stub-${++mintCounter}`;
        return id;
      }),
      validate: vi.fn().mockResolvedValue([]),
    },
    browser: { withPage: vi.fn() },
  };
}

const alwaysConfirm: Confirmer = () => Promise.resolve(true);
const alwaysDecline: Confirmer = () => Promise.resolve(false);

beforeEach(() => {
  vi.clearAllMocks();
  mockParse.mockResolvedValue(tinyParseResult());
  mockRunIntegrity.mockImplementation(actualIntegrity.runIntegrity);
  mockRunVerifyLoop.mockResolvedValue(cleanLoopResult());
});

/* ───────────────────────────── htmlToTree (stages 1-9, no persist) ──────────────────────────── */

describe('htmlToTree', () => {
  it('runs the stage composition (probes + reads) and persists nothing', async () => {
    const ports = makePorts();
    const build = await htmlToTree({ html: '<div class="hero"><h1>Hello</h1></div>' }, ports);

    // Read-only probes happened.
    expect(ports.schema.breakpoints).toHaveBeenCalledTimes(1);
    expect(ports.schema.styles).toHaveBeenCalledTimes(1);
    expect(ports.schema.capabilities).toHaveBeenCalledTimes(1);
    // Existing classes + variables were read for the reuse-first hoist / variable-extract.
    expect(ports.design.listClasses).toHaveBeenCalledTimes(1);
    expect(ports.design.listVariables).toHaveBeenCalledTimes(1);

    // NOTHING was written.
    expect(ports.document.create).not.toHaveBeenCalled();
    expect(ports.document.save).not.toHaveBeenCalled();
    expect(ports.document.dryRun).not.toHaveBeenCalled();
    expect(ports.design.upsertClasses).not.toHaveBeenCalled();
    expect(ports.design.batchVariables).not.toHaveBeenCalled();

    // The result shape matches the §1.9 outputSchema (internal report shape).
    expect(Array.isArray(build.result.elements)).toBe(true);
    expect(build.result.elements.length).toBeGreaterThan(0);
    expect(build.result.report.coverage).toHaveProperty('pct_native');
    expect(build.result.report).toHaveProperty('a11y');
    expect(build.result.report).toHaveProperty('fallbacks');
    expect(build.result.report).toHaveProperty('stripped_text');
  });

  it('chooses v3 generation when atomic is inactive (LOCKED fallback)', async () => {
    const ports = makePorts();
    ports.schema.capabilities.mockResolvedValue({
      v4: false,
      atomic: false,
      global_classes: false,
      variables: false,
      pro: false,
      pro_atomic_form: false,
      breakpoints: [],
      experiments: {},
      can_update_class: false,
      classes_migrated: false,
      registered_types: { atomic: [], classic: [] },
      versions: { elementor: '3.0.0', pro: null, plugin: '1.0.0' },
      unfiltered_html: true,
    });
    const build = await htmlToTree({ html: '<div></div>' }, ports);
    expect(build.generation).toBe('v3');
  });

  it('honors options.hoist_classes:false / extract_variables:false (no design reads)', async () => {
    const ports = makePorts();
    await htmlToTree(
      { html: '<div></div>', options: { hoist_classes: false, extract_variables: false } },
      ports,
    );
    expect(ports.design.listClasses).not.toHaveBeenCalled();
    expect(ports.design.listVariables).not.toHaveBeenCalled();
  });

  it('threads options.base_url into PARSE (relative URL / external-CSS resolution)', async () => {
    const ports = makePorts();
    await htmlToTree(
      { html: '<img src="/x.jpg">', options: { base_url: 'https://example.com/' } },
      ports,
    );
    expect(mockParse).toHaveBeenCalledWith(
      expect.objectContaining({ base_url: 'https://example.com/' }),
    );
  });

  it('returns a PERSISTABLE tree: no __class:/__var: tokens, no null base breakpoints, real g-* ids', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(twoCardParse());
    const build = await htmlToTree({ html: '<x/>' }, ports);

    const json = JSON.stringify(build.result.elements);
    expect(json).not.toContain('__class:');
    expect(json).not.toContain('__var:');
    expect(json).not.toContain('"breakpoint":null');

    // proposed_classes[].id is a REAL persistable id, consistent with the tree's rewritten references.
    expect(build.result.proposed_classes.length).toBeGreaterThan(0);
    for (const cls of build.result.proposed_classes) {
      expect(cls.id).toMatch(/^g-[0-9a-f]+$/);
      expect(json).toContain(`"${cls.id}"`);
      for (const v of cls.variants as Array<{ meta?: { breakpoint?: unknown } }>) {
        expect(v.meta?.breakpoint).not.toBeNull();
      }
    }
  });

  it('mints DETERMINISTIC class ids (replay-stable across runs of the same conversion)', async () => {
    mockParse.mockResolvedValue(twoCardParse());
    const a = await htmlToTree({ html: '<x/>' }, makePorts());
    mockParse.mockResolvedValue(twoCardParse());
    const b = await htmlToTree({ html: '<x/>' }, makePorts());
    expect(a.result.proposed_classes.length).toBeGreaterThan(0);
    expect(a.result.proposed_classes.map((c) => c.id)).toEqual(
      b.result.proposed_classes.map((c) => c.id),
    );
  });
});

/* ───────────────────────────── htmlToPage commit:false (preview) ────────────────────────────── */

describe('htmlToPage (commit:false, default)', () => {
  it('runs an authoritative dry_run and saves nothing', async () => {
    const ports = makePorts();
    const result = await htmlToPage({ html: '<div><h1>Hi</h1></div>' }, ports, alwaysConfirm);

    expect(result.status).toBe('preview');
    expect(result.committed).toBe(false);
    expect(result.css_primed).toBe(false);
    // The authoritative dry_run ran (post_id 0 for a new tree).
    expect(ports.document.dryRun).toHaveBeenCalledTimes(1);
    expect(ports.document.dryRun.mock.calls[0]?.[0]).toBe(0);
    // Nothing was persisted, no design writes.
    expect(ports.document.save).not.toHaveBeenCalled();
    expect(ports.document.replaceTree).not.toHaveBeenCalled();
    expect(ports.design.upsertClasses).not.toHaveBeenCalled();
    expect(ports.design.batchVariables).not.toHaveBeenCalled();
    // The diff is shaped from the authoritative dry_run diff.
    expect(result.diff.new_ids).toEqual(['e-1']);
  });
});

/* ───────────────────────────── htmlToPage commit:true gate / confirm ────────────────────────── */

describe('htmlToPage (commit:true)', () => {
  it('refuses with a clean gate_denied result when an a11y blocker is present', async () => {
    const ports = makePorts();
    // Two <h1>s in one page → the multiple-h1 a11y BLOCKER (default severity). The orchestrator always
    // sets require_no_blockers, so the gate denies regardless of coverage (coverage_gate:0).
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
          children: [headingNode('body>div>h1a'), headingNode('body>div>h1b')],
        },
      ],
      doc_direction: 'ltr',
      viewport_used: 1280,
      warnings: [],
      raw_inner_markup: {},
    });
    const result = await htmlToPage(
      { html: '<div><h1>A</h1><h1>B</h1></div>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('gate_denied');
    expect(result.committed).toBe(false);
    expect(result.gate_reasons?.length ?? 0).toBeGreaterThan(0);
    // A gate-deny never confirms, never persists.
    expect(ports.document.save).not.toHaveBeenCalled();
    expect(ports.design.upsertClasses).not.toHaveBeenCalled();
  });

  it('returns a clean declined result when the confirm is declined', async () => {
    const ports = makePorts();
    const result = await htmlToPage(
      { html: '<div><h1>Hi</h1></div>', commit: true, coverage_gate: 0 },
      ports,
      alwaysDecline,
    );
    expect(result.status).toBe('declined');
    expect(result.committed).toBe(false);
    // Declining is a clean non-error; nothing persisted.
    expect(ports.document.save).not.toHaveBeenCalled();
    expect(ports.design.batchVariables).not.toHaveBeenCalled();
  });

  it('runs the full commit sequence (variables → classes → dry_run → save → prime) and threads op_id', async () => {
    const ports = makePorts();
    // dry_run uses post_id 0 (new); save lands on the freshly-created page id 99.
    const result = await htmlToPage(
      { html: '<div><h1>Hi</h1></div>', title: 'My Page', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );

    expect(result.status).toBe('committed');
    expect(result.committed).toBe(true);
    expect(result.css_primed).toBe(true);
    expect(result.id).toBe(99);

    // Sequence: the authoritative dry_run runs FIRST (kit untouched on invalid), THEN variables.batch
    // + the classes diff-PUT, THEN save + prime. (At least the dry_run + create + save + prime always
    // run on a happy commit.)
    expect(ports.document.dryRun).toHaveBeenCalled();
    expect(ports.document.create).toHaveBeenCalledTimes(1);
    expect(ports.document.save).toHaveBeenCalledTimes(1);
    expect(ports.document.primeCss).toHaveBeenCalledTimes(1);
    expect(ports.document.replaceTree).not.toHaveBeenCalled();

    // op_id threads: the save's op_id equals the authoritative dry_run's op_id (same convert op).
    const dryOpId = (ports.document.dryRun.mock.calls.at(-1)?.[1] as { op_id?: string }).op_id;
    const saveOpId = (ports.document.save.mock.calls[0]?.[1] as { op_id?: string }).op_id;
    expect(typeof saveOpId).toBe('string');
    expect(saveOpId).toBe(dryOpId);
    // prime-css does NOT run inline in the save (we prime explicitly, S01 sequence).
    expect((ports.document.save.mock.calls[0]?.[1] as { prime_css?: boolean }).prime_css).toBe(
      false,
    );
  });

  it('op_id covers title/status/options — same html under a different title/include_js is a NEW commit, not a replay', async () => {
    const html = '<div><h1>Hi</h1></div>';
    const opIdFor = async (args: Parameters<typeof htmlToPage>[0]): Promise<string> => {
      const ports = makePorts();
      await htmlToPage({ ...args, commit: true, coverage_gate: 0 }, ports, alwaysConfirm);
      return (ports.document.save.mock.calls[0]?.[1] as { op_id: string }).op_id;
    };
    const base = await opIdFor({ html, title: 'Page A' });
    expect(await opIdFor({ html, title: 'Page A' })).toBe(base); // a true retry replays
    expect(await opIdFor({ html, title: 'Page B' })).not.toBe(base);
    expect(await opIdFor({ html, title: 'Page A', status: 'publish' })).not.toBe(base);
    expect(await opIdFor({ html, title: 'Page A', options: { include_js: 'none' } })).not.toBe(
      base,
    );
  });

  it('replaces an existing page with a fresh base_hash (optimistic lock) when post_id is given', async () => {
    const ports = makePorts();
    const result = await htmlToPage(
      { html: '<div><h1>Hi</h1></div>', post_id: 42, commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.id).toBe(42);
    // A fresh base_hash was read right before replace-tree.
    expect(ports.document.getStructure).toHaveBeenCalledWith(42);
    expect(ports.document.replaceTree).toHaveBeenCalledTimes(1);
    expect(
      (ports.document.replaceTree.mock.calls[0]?.[1] as { base_hash?: string }).base_hash,
    ).toBe('hash-abc');
    expect(ports.document.create).not.toHaveBeenCalled();
  });

  it('surfaces a dry_run valid:false as status:invalid and never saves — and never touches the kit', async () => {
    const ports = makePorts();
    // Two identical cards → HOIST proposes a class, so a kit write WOULD happen if the ordering
    // regressed back to write-before-dry_run.
    mockParse.mockResolvedValue(twoCardParse());
    ports.document.dryRun.mockResolvedValue({
      valid: false,
      errors: [{ path: 'elements[0].settings', code: 'ATOMIC_SETTINGS_INVALID', message: 'bad' }],
      diff: { changed_ids: [], new_ids: [], removed_ids: [], before: {}, after: {} },
      preview_url: null,
      id_collisions: [],
      generation_detected: 'v4',
    });
    const result = await htmlToPage(
      { html: '<div><h1>Hi</h1></div>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('invalid');
    expect(result.committed).toBe(false);
    expect(result.errors?.[0]?.code).toBe('ATOMIC_SETTINGS_INVALID');
    // The save is NEVER attempted on an invalid tree.
    expect(ports.document.save).not.toHaveBeenCalled();
    expect(ports.document.create).not.toHaveBeenCalled();
    // The dry_run runs BEFORE any kit write: an invalid conversion creates NO classes/variables.
    expect(ports.design.upsertClasses).not.toHaveBeenCalled();
    expect(ports.design.batchVariables).not.toHaveBeenCalled();
  });

  it('runs the authoritative dry_run BEFORE the classes diff-PUT and persists the deterministic ids', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(twoCardParse());
    const result = await htmlToPage(
      { html: '<x/>', title: 't', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(ports.design.upsertClasses).toHaveBeenCalledTimes(1);

    // Ordering: dry_run strictly before the diff-PUT (kit untouched until the tree is known-valid).
    const dryOrder = ports.document.dryRun.mock.invocationCallOrder[0]!;
    const putOrder = ports.design.upsertClasses.mock.invocationCallOrder[0]!;
    expect(dryOrder).toBeLessThan(putOrder);

    // The diff-PUT persists the EXACT deterministic ids the saved tree references (no random mint).
    const putBody = ports.design.upsertClasses.mock.calls[0]?.[0] as {
      changes: { added: string[] };
    };
    expect(putBody.changes.added.length).toBeGreaterThan(0);
    const saveBody = ports.document.save.mock.calls[0]?.[1] as { elements: unknown };
    const savedJson = JSON.stringify(saveBody.elements);
    for (const id of putBody.changes.added) {
      expect(id).toMatch(/^g-[0-9a-f]+$/);
      expect(savedJson).toContain(`"${id}"`);
    }
    expect(savedJson).not.toContain('__class:');
    expect(savedJson).not.toContain('__var:');
  });

  it('compensates the kit writes (deletes the added classes) and rethrows when the save fails', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(twoCardParse());
    ports.document.save.mockRejectedValue(new Error('CONCURRENCY_STALE_HASH'));

    await expect(
      htmlToPage(
        { html: '<x/>', title: 't', commit: true, coverage_gate: 0 },
        ports,
        alwaysConfirm,
      ),
    ).rejects.toThrow('CONCURRENCY_STALE_HASH');

    // First PUT added the classes; the second is the compensating delete of exactly those ids.
    expect(ports.design.upsertClasses).toHaveBeenCalledTimes(2);
    const first = ports.design.upsertClasses.mock.calls[0]?.[0] as {
      changes: { added: string[]; deleted: string[] };
    };
    const comp = ports.design.upsertClasses.mock.calls[1]?.[0] as {
      changes: { added: string[]; deleted: string[] };
      order: string[];
    };
    expect(first.changes.added.length).toBeGreaterThan(0);
    expect(comp.changes.added).toEqual([]);
    expect(comp.changes.deleted).toEqual(first.changes.added);
    for (const id of first.changes.added) {
      expect(comp.order).not.toContain(id);
    }
  });

  it('surfaces IDEMPOTENT_REPLAY informationally from the save', async () => {
    const ports = makePorts();
    ports.document.save.mockResolvedValue({
      id: 99,
      diff: { changed_ids: [], new_ids: [], removed_ids: [], before: {}, after: {} },
      base_hash: 'hash-new',
      preview_url: 'http://x/?p=99',
      backup_handle: { meta_key: 'k', revision_id: 1 },
      css_primed: false,
      prime_required: true,
      remapped_ids: {},
      idempotent_replay: true,
      op_id: 'op-xyz',
    });
    const result = await htmlToPage(
      { html: '<div><h1>Hi</h1></div>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.idempotent_replay).toBe(true);
  });

  it('reports committed:true with css_primed:false honestly when the prime fails', async () => {
    const ports = makePorts();
    ports.document.primeCss.mockRejectedValue(new Error('prime exploded'));
    const result = await htmlToPage(
      { html: '<div><h1>Hi</h1></div>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.committed).toBe(true);
    expect(result.css_primed).toBe(false);
  });
});

/* ───────────────────────────── placeholder resolution (one-pass) ────────────────────────────── */

describe('resolvePlaceholders', () => {
  it('rewrites __class: tokens in classes.value and __var: tokens in variable TypedValues, in one pass', () => {
    const tree = [
      {
        id: 'e-1',
        elType: 'e-div-block',
        settings: {
          classes: { $$type: 'classes', value: ['__class:fp-1', 'g-existing'] },
        },
        styles: {
          'e-local-1': {
            id: 'e-local-1',
            type: 'class',
            label: 'local',
            variants: [
              {
                meta: { breakpoint: 'desktop', state: null },
                props: {
                  color: { $$type: 'global-color-variable', value: '__var:color:#fff' },
                },
              },
            ],
          },
        },
        elements: [],
      },
    ] as unknown as Parameters<typeof resolvePlaceholders>[0];

    const out = resolvePlaceholders(
      tree,
      { '__var:color:#fff': 'e-gv-real' },
      { '__class:fp-1': 'g-real' },
    );

    const node = out[0] as unknown as {
      settings: { classes: { value: string[] } };
      styles: Record<string, { variants: Array<{ props: { color: { value: string } } }> }>;
    };
    expect(node.settings.classes.value).toEqual(['g-real', 'g-existing']);
    expect(node.styles['e-local-1']?.variants[0]?.props.color.value).toBe('e-gv-real');

    // Input tree is NOT mutated (deep-cloned).
    const original = tree[0] as unknown as { settings: { classes: { value: string[] } } };
    expect(original.settings.classes.value).toEqual(['__class:fp-1', 'g-existing']);
  });

  it('leaves an unmapped placeholder in place (the dry_run surfaces it)', () => {
    const tree = [
      {
        id: 'e-1',
        elType: 'e-div-block',
        settings: { classes: { $$type: 'classes', value: ['__class:unknown'] } },
        elements: [],
      },
    ] as unknown as Parameters<typeof resolvePlaceholders>[0];
    const out = resolvePlaceholders(tree, {}, {});
    const node = out[0] as unknown as { settings: { classes: { value: string[] } } };
    expect(node.settings.classes.value).toEqual(['__class:unknown']);
  });
});

/* ───────────────────────────── diff shaping (PHP authoritative → F03 Diff) ───────────────────── */

describe('shapeDiff', () => {
  it('maps RestDiff id arrays into NodeChange[] with op kinds + carries the id arrays', () => {
    const diff = shapeDiff({
      changed_ids: ['e-c'],
      new_ids: ['e-n'],
      removed_ids: ['e-r'],
      before: { 'e-r': { id: 'e-r', elType: 'e-div-block', settings: {} } },
      after: {
        'e-n': { id: 'e-n', elType: 'e-heading', widgetType: 'e-heading', settings: {} },
        'e-c': { id: 'e-c', elType: 'e-div-block', settings: {} },
      },
    });
    expect(diff.new_ids).toEqual(['e-n']);
    expect(diff.changed_ids).toEqual(['e-c']);
    expect(diff.removed_ids).toEqual(['e-r']);
    const ops = diff.changes.map((c) => `${c.id}:${c.op}`).sort();
    expect(ops).toEqual(['e-c:modified', 'e-n:added', 'e-r:removed']);
    const added = diff.changes.find((c) => c.id === 'e-n');
    expect(added?.elType).toBe('e-heading');
    expect(added?.widgetType).toBe('e-heading');
  });
});

/* ───────────────────────────── DUPLICATED_LABEL reconciliation ──────────────────────────────── */

describe('htmlToPage DUPLICATED_LABEL reconciliation', () => {
  it('surfaces a diff-PUT label rename in duplicated_labels when classes are proposed', async () => {
    const ports = makePorts();
    // Make HOIST propose a class: the tiny IR's single styled node won't be hoisted (min_uses=2), so
    // we force a proposal by having the diff-PUT report a rename and stub a proposed class via a
    // multi-node parse. Simplest: feed a parse with two identical siblings so HOIST promotes them.
    mockParse.mockResolvedValue({
      ir: [
        {
          source_path: 'body>div',
          tag: 'div',
          role: 'structural-block',
          box: { x: 0, y: 0, width: 1200, height: 200 },
          computed: { display: 'flex' },
          responsive: {},
          attrs: {},
          textRuns: [],
          children: [cardNode('body>div>a'), cardNode('body>div>b')],
        },
      ],
      doc_direction: 'ltr',
      viewport_used: 1280,
      warnings: [],
      raw_inner_markup: {},
    });
    ports.design.upsertClasses.mockResolvedValue({
      ok: true,
      modified_labels: { 'g-xxxx': { modified: 'card-2' } },
      order: ['g-xxxx'],
      total: 1,
    });

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );

    // If a class was proposed, the diff-PUT ran and the rename was surfaced.
    if (ports.design.upsertClasses.mock.calls.length > 0) {
      expect(result.duplicated_labels).toBeDefined();
      expect(Object.values(result.duplicated_labels ?? {})).toContain('card-2');
    }
    expect(result.status).toBe('committed');
  });
});

/** An `<h1>` heading IR node (two of these in one page → the multiple-h1 a11y blocker). */
function headingNode(sourcePath: string): ParseResult['ir'][number] {
  return {
    source_path: sourcePath,
    tag: 'h1',
    role: 'heading',
    box: { x: 0, y: 0, width: 400, height: 60 },
    computed: { color: '#112233', 'font-size': '32px' },
    responsive: {},
    attrs: {},
    textRuns: [{ text: 'Heading', inlineTags: [] }],
    children: [],
  };
}

/** A parse result with two identical "card" siblings (→ HOIST proposes one shared class). */
function twoCardParse(): ParseResult {
  return {
    ir: [
      {
        source_path: 'body>div',
        tag: 'div',
        role: 'structural-block',
        box: { x: 0, y: 0, width: 1200, height: 200 },
        computed: { display: 'flex' },
        responsive: {},
        attrs: {},
        textRuns: [],
        children: [cardNode('body>div>a'), cardNode('body>div>b')],
      },
    ],
    doc_direction: 'ltr',
    viewport_used: 1280,
    warnings: [],
    raw_inner_markup: {},
  };
}

/** A "card" IR node with shared styling (two of these → HOIST promotes a class). */
function cardNode(sourcePath: string): ParseResult['ir'][number] {
  return {
    source_path: sourcePath,
    tag: 'div',
    role: 'structural-block',
    box: { x: 0, y: 0, width: 300, height: 200 },
    computed: { padding: '16px', color: '#222222', 'background-color': '#eeeeee' },
    responsive: {},
    attrs: { class: 'card' },
    textRuns: [{ text: 'Card', inlineTags: [] }],
    children: [],
  };
}

/* ───────────────────────────── contract 16 — behavior-conversion wiring ─────────────────────── */

/** A bare parse-IR node (real CLASSIFY runs detection downstream — fixtures carry only signals). */
function irNode(
  over: Partial<ParseResult['ir'][number]> & { source_path: string },
): ParseResult['ir'][number] {
  return {
    tag: 'div',
    role: 'structural-block',
    box: { x: 0, y: 0, width: 600, height: 120 },
    computed: {},
    responsive: {},
    attrs: {},
    textRuns: [],
    children: [],
    ...over,
  };
}

function parseResultOf(ir: ParseResult['ir']): ParseResult {
  return { ir, doc_direction: 'ltr', viewport_used: 1280, warnings: [], raw_inner_markup: {} };
}

/** ARIA tabs at parse level: wrapper > tablist(2 triggers) + 2 panels (CLASSIFY detects + roles). */
function ariaTabsParse(): ParseResult {
  return parseResultOf([
    irNode({
      source_path: 'body>section',
      children: [
        irNode({
          source_path: 'body>section>nav',
          attrs: { role: 'tablist' },
          children: [
            irNode({
              source_path: 'body>section>nav>b1',
              tag: 'button',
              attrs: { role: 'tab' },
              textRuns: [{ text: 'Tab one', inlineTags: [] }],
            }),
            irNode({
              source_path: 'body>section>nav>b2',
              tag: 'button',
              attrs: { role: 'tab' },
              textRuns: [{ text: 'Tab two', inlineTags: [] }],
            }),
          ],
        }),
        irNode({
          source_path: 'body>section>p1',
          attrs: { role: 'tabpanel' },
          children: [
            irNode({
              source_path: 'body>section>p1>p',
              tag: 'p',
              role: 'text',
              textRuns: [{ text: 'PANEL-ONE-TEXT', inlineTags: [] }],
            }),
          ],
        }),
        irNode({
          source_path: 'body>section>p2',
          attrs: { role: 'tabpanel' },
          children: [
            irNode({
              source_path: 'body>section>p2>p',
              tag: 'p',
              role: 'text',
              textRuns: [{ text: 'PANEL-TWO-TEXT', inlineTags: [] }],
            }),
          ],
        }),
      ],
    }),
  ]);
}

/** An AOS entrance-animation candidate (declarative `data-aos` — CLASSIFY detects, Tier 2 emits). */
function entranceParse(): ParseResult {
  return parseResultOf([
    irNode({
      source_path: 'body>main',
      computed: { display: 'flex' },
      children: [
        irNode({
          source_path: 'body>main>h1',
          tag: 'h1',
          role: 'heading',
          textRuns: [{ text: 'Title', inlineTags: [] }],
        }),
        irNode({
          source_path: 'body>main>card',
          attrs: { 'data-aos': 'fade-up' },
          textRuns: [{ text: 'Animated content', inlineTags: [] }],
        }),
      ],
    }),
  ]);
}

/** A `custom-js` candidate: an unclaimed non-anchor click listener (parse runtime probe). */
function customJsParse(): ParseResult {
  return parseResultOf([
    irNode({
      source_path: 'body>main',
      computed: { display: 'flex' },
      children: [
        irNode({
          source_path: 'body>main>toggle',
          listeners: ['click'],
          textRuns: [{ text: 'Toggle me', inlineTags: [] }],
        }),
      ],
    }),
  ]);
}

const INLINE_SCRIPT_HTML = '<div><script>document.body.dataset.emcpTest = "1";</script></div>';

describe('contract 16 — htmlToTree behavior wiring', () => {
  it('§8.5: a zero-behavior page carries NO behavior section, no js_passthrough, no warnings', async () => {
    const ports = makePorts();
    const build = await htmlToTree({ html: '<div><h1>Hello</h1></div>' }, ports);
    expect(build.result.report.behavior).toBeUndefined();
    expect(build.result.js_passthrough).toBeUndefined();
    expect(build.result.warnings).toBeUndefined();
    expect(build.behaviors).toEqual([]);
    expect(build.interactionsAuthored).toEqual([]);
    const json = JSON.stringify(build.result.elements);
    expect(json).not.toContain('interaction-item');
    expect(json).not.toContain('data-emcp-passthrough');
  });

  it('Tier 1 (tabs): detection → e-tabs family restructure → report.behavior tier-1 entry', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(ariaTabsParse());
    const build = await htmlToTree({ html: '<x/>' }, ports);

    // The mapping is REACHABLE end-to-end: the assembled tree carries the e-tabs family.
    const json = JSON.stringify(build.result.elements);
    expect(json).toContain('e-tabs');
    expect(json).toContain('e-tabs-menu');
    expect(json).toContain('e-tab-content');

    // §8.4 — the tier-1 family REPLACES the static subtree (no duplicate static copy): each panel
    // paragraph exists as exactly ONE element node (its text appears in settings + editor label).
    const countNodesWithText = (nodes: unknown[], text: string): number => {
      let count = 0;
      for (const n of nodes) {
        const el = n as { settings?: unknown; elements?: unknown[] };
        if (JSON.stringify(el.settings ?? {}).includes(text)) count += 1;
        count += countNodesWithText(el.elements ?? [], text);
      }
      return count;
    };
    const wireElements = build.result.elements as unknown[];
    expect(countNodesWithText(wireElements, 'PANEL-ONE-TEXT')).toBe(1);
    expect(countNodesWithText(wireElements, 'PANEL-TWO-TEXT')).toBe(1);

    // §6 — the advisory behavior section, tier counts + score from the single tier-1 behavior.
    const behavior = build.result.report.behavior;
    expect(behavior).toBeDefined();
    expect(behavior?.behavior_gate).toBe('advisory');
    const tabs = behavior?.detected.find((b) => b.kind === 'tabs');
    expect(tabs?.tier).toBe(1);
    expect(behavior?.tiers.native).toBe(1);
    expect(behavior?.score).toBe(1);
  });

  it('Tier 2 (entrance): detection → S08 interactions attached → tier-2 entry + authored record', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(entranceParse());
    const build = await htmlToTree({ html: '<x/>' }, ports);

    // The S08 blob landed on an assembled element and the stage recorded what it authored.
    expect(build.interactionsAuthored).toHaveLength(1);
    expect(build.interactionsAuthored[0]?.items).toBeGreaterThan(0);
    expect(JSON.stringify(build.result.elements)).toContain('interaction-item');

    // The behavior is reported tier 2 (provisional until the post-save assert on commit).
    const behavior = build.result.report.behavior;
    const entrance = behavior?.detected.find((b) => b.kind === 'entrance-animation');
    expect(entrance?.tier).toBe(2);
    expect(behavior?.tiers.interactions).toBe(1);
  });

  it('§8.3: include_js absent (default) emits ZERO script bytes and NO js_passthrough report', async () => {
    const ports = makePorts();
    const build = await htmlToTree({ html: INLINE_SCRIPT_HTML }, ports);
    expect(build.result.js_passthrough).toBeUndefined();
    const json = JSON.stringify(build.result.elements);
    expect(json).not.toContain('data-emcp-passthrough');
    expect(json).not.toContain('emcpTest');
  });

  it("include_js:'none' (explicit) reports the census partition but bundles nothing", async () => {
    const ports = makePorts();
    const build = await htmlToTree(
      { html: INLINE_SCRIPT_HTML, options: { include_js: 'none' } },
      ports,
    );
    const pass = build.result.js_passthrough;
    expect(pass?.mode).toBe('none');
    expect(pass?.bundled).toEqual([]);
    expect(pass?.excluded).toHaveLength(1);
    expect(pass?.excluded[0]?.reason).toBe('include_js_none');
    expect(JSON.stringify(build.result.elements)).not.toContain('data-emcp-passthrough');
  });

  it("include_js:'bundle' + confirm appends ONE html widget LAST and tiers custom-js at 3", async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(customJsParse());
    const confirm = vi.fn<Confirmer>().mockResolvedValue(true);
    const build = await htmlToTree(
      { html: INLINE_SCRIPT_HTML, options: { include_js: 'bundle' } },
      ports,
      confirm,
    );

    // The JS elicitation confirm fired (independent of any commit confirm, §0.4).
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain('Bundle');

    // ONE classic html widget appended LAST, marker-wrapped.
    const last = build.result.elements.at(-1) as unknown as {
      elType: string;
      widgetType?: string;
      settings: { html?: string };
    };
    expect(last.elType).toBe('widget');
    expect(last.widgetType).toBe('html');
    expect(last.settings.html).toContain('data-emcp-passthrough');
    expect(last.settings.html).toContain('emcpTest');

    expect(build.result.js_passthrough?.mode).toBe('bundle');
    expect(build.result.js_passthrough?.bundled).toHaveLength(1);
    expect(build.result.js_passthrough?.bundled_bytes ?? 0).toBeGreaterThan(0);

    // The custom-js behavior rides the bundle: tier 3 with the frozen reason.
    const customJs = build.result.report.behavior?.detected.find((b) => b.kind === 'custom-js');
    expect(customJs?.tier).toBe(3);
    expect(customJs?.reason).toBe(JS_PASSTHROUGH_TIER_REASONS.bundled);
    expect(build.result.report.behavior?.tiers.passthrough).toBe(1);
  });

  it("include_js:'bundle' declined → proceeds WITHOUT JS, reported (warning + tier 4)", async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(customJsParse());
    const build = await htmlToTree(
      { html: INLINE_SCRIPT_HTML, options: { include_js: 'bundle' } },
      ports,
      alwaysDecline,
    );
    const json = JSON.stringify(build.result.elements);
    expect(json).not.toContain('data-emcp-passthrough');
    expect(build.result.warnings?.some((w) => w.includes('declined'))).toBe(true);
    expect(build.result.js_passthrough?.bundled).toEqual([]);
    const customJs = build.result.report.behavior?.detected.find((b) => b.kind === 'custom-js');
    expect(customJs?.tier).toBe(4);
    expect(customJs?.reason).toBe(JS_PASSTHROUGH_TIER_REASONS.declined);
  });

  it("include_js:'bundle' without an elicitation channel → proceeds WITHOUT JS, reported", async () => {
    const ports = makePorts();
    const build = await htmlToTree(
      { html: INLINE_SCRIPT_HTML, options: { include_js: 'bundle' } },
      ports,
    );
    expect(JSON.stringify(build.result.elements)).not.toContain('data-emcp-passthrough');
    expect(build.result.warnings?.some((w) => w.includes('no elicitation channel'))).toBe(true);
  });

  it("custom-js with include_js absent is an honest tier-4 drop ('not requested')", async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(customJsParse());
    const build = await htmlToTree({ html: '<div/>' }, ports);
    const customJs = build.result.report.behavior?.detected.find((b) => b.kind === 'custom-js');
    expect(customJs?.tier).toBe(4);
    expect(customJs?.reason).toBe(JS_PASSTHROUGH_TIER_REASONS.not_requested);
    expect(build.result.report.behavior?.tiers.dropped).toBe(1);
  });
});

describe('contract 16 — htmlToPage post-save interactions assert (§8 invariant 2)', () => {
  /** Wire the document stub so the readback (getStructure) returns what the save persisted. */
  function captureSavedTree(ports: StubPorts): { saved: () => unknown[] } {
    let savedElements: unknown[] = [];
    const baseResponse = {
      id: 99,
      diff: { changed_ids: [], new_ids: ['e-1'], removed_ids: [], before: {}, after: {} },
      base_hash: 'hash-new',
      preview_url: 'http://x/?p=99',
      backup_handle: { meta_key: 'k', revision_id: 1 },
      css_primed: false,
      prime_required: true,
      remapped_ids: {},
      idempotent_replay: false,
      op_id: 'op-xyz',
    };
    ports.document.save.mockImplementation((_id: number, body: { elements: unknown[] }) => {
      savedElements = body.elements;
      return Promise.resolve(baseResponse);
    });
    ports.document.getStructure.mockImplementation(() =>
      Promise.resolve({
        id: 99,
        elements: savedElements,
        settings: {},
        base_hash: 'hash-new',
        generation: 'v4',
        type: 'page',
      }),
    );
    return { saved: () => savedElements };
  }

  /** Deep-strip every `interactions` key (simulates the PHP sanitizer silently dropping all items). */
  function stripInteractions(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripInteractions);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => k !== 'interactions')
          .map(([k, v]) => [k, stripInteractions(v)]),
      );
    }
    return value;
  }

  it('keeps tier 2 when the authored interactions SURVIVE the readback', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(entranceParse());
    captureSavedTree(ports);
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.interactions_post_save).toHaveLength(1);
    expect(result.interactions_post_save?.[0]?.status).toBe('survived');
    expect(result.report.behavior?.tiers.interactions).toBe(1);
    expect(result.report.behavior?.tiers.dropped).toBe(0);
  });

  it('downgrades tier 2 → 4 when the sanitizer silently dropped the authored interactions', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(entranceParse());
    const capture = captureSavedTree(ports);
    // The readback returns the saved tree WITHOUT interactions (S08 silent-drop semantics).
    ports.document.getStructure.mockImplementation(() =>
      Promise.resolve({
        id: 99,
        elements: stripInteractions(capture.saved()),
        settings: {},
        base_hash: 'hash-new',
        generation: 'v4',
        type: 'page',
      }),
    );
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.interactions_post_save?.[0]?.status).toBe('dropped_by_sanitizer');
    // The report was downgraded — never a silent lie (§0.2 / §8.2).
    const entrance = result.report.behavior?.detected.find((b) => b.kind === 'entrance-animation');
    expect(entrance?.tier).toBe(4);
    expect(entrance?.reason).toContain('did NOT survive');
    expect(result.report.behavior?.tiers.interactions).toBe(0);
    expect(result.report.behavior?.tiers.dropped).toBe(1);
  });

  it('downgrades conservatively when the readback itself fails (survival UNVERIFIED)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(entranceParse());
    captureSavedTree(ports);
    ports.document.getStructure.mockRejectedValue(new Error('transient'));
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    // Nothing was read, so no checks list — but tier 2 cannot be claimed.
    expect(result.interactions_post_save).toBeUndefined();
    expect(result.report.behavior?.tiers.interactions).toBe(0);
    expect(result.report.behavior?.tiers.dropped).toBe(1);
  });

  it('runs NO readback when nothing was authored (zero-behavior commit unchanged)', async () => {
    const ports = makePorts();
    const result = await htmlToPage(
      { html: '<div><h1>Hi</h1></div>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.interactions_post_save).toBeUndefined();
    expect(result.report.behavior).toBeUndefined();
    // Create path: getStructure is ONLY the §8.2 readback, so it must not have run at all.
    expect(ports.document.getStructure).not.toHaveBeenCalled();
  });

  it('fires TWO independent elicitation confirms on a bundle+commit run (§0.4)', async () => {
    const ports = makePorts();
    const confirm = vi.fn<Confirmer>().mockResolvedValue(true);
    const result = await htmlToPage(
      {
        html: INLINE_SCRIPT_HTML,
        commit: true,
        coverage_gate: 0,
        options: { include_js: 'bundle' },
      },
      ports,
      confirm,
    );
    expect(result.status).toBe('committed');
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0]?.[0]).toContain('Bundle');
    expect(confirm.mock.calls[1]?.[0]).toContain('CREATE a new page');
    // The bundle widget rides the committed save.
    const saveBody = ports.document.save.mock.calls[0]?.[1] as { elements: unknown };
    expect(JSON.stringify(saveBody.elements)).toContain('data-emcp-passthrough');
    expect(result.js_passthrough?.mode).toBe('bundle');
  });
});

/* ───────────────────────────── default gate ─────────────────────────────────────────────────── */

/* ───────────────────────────── contract 17 — pre-save integrity wiring (§1) ─────────────────── */

describe('contract 17 — pre-save integrity wiring', () => {
  it('runs runIntegrity on the FINAL wire tree with a balanced ledger + the I2 source map', async () => {
    const ports = makePorts();
    const build = await htmlToTree({ html: '<div class="hero"><h1>Hello</h1></div>' }, ports);

    expect(mockRunIntegrity).toHaveBeenCalledTimes(1);
    const input = mockRunIntegrity.mock.calls[0]?.[0];
    expect(input).toBeDefined();
    if (input === undefined) return;
    // The wire elements (post placeholder-resolution) — the exact tree a persist would save.
    expect(input.elements).toBe(build.result.elements);
    // The I3 ledger balances: the PRODUCER-side counts (style-extract's seam tally + the map/
    // normalize loss records) match the integrator's post-merge ledger.
    expect(input.ledger).toBeDefined();
    const ledger = input.ledger;
    if (ledger === undefined) return;
    expect(
      ledger.detected_declarations + ledger.inline_fold_effects + (ledger.pseudo_drop_effects ?? 0),
    ).toBe(ledger.native_count + ledger.declaration_fallbacks.length);
    // The I2 source correspondence is keyed by minted element ids and carries the IR computed sets.
    const sourceComputed = input.source_computed ?? {};
    const allComputed = Object.values(sourceComputed);
    expect(allComputed.length).toBeGreaterThan(0);
    expect(JSON.stringify(allComputed)).toContain('flex');
    // A clean run surfaces NO violations on the result.
    expect(build.result.integrity).toBeUndefined();
  });

  it('hard-fails the conversion on an I1 violation (throws; html_to_page never saves)', async () => {
    const ports = makePorts();
    mockRunIntegrity.mockReturnValue({
      violations: [
        {
          invariant: 'I1',
          nodeId: 'e-bad',
          styleId: 'e-bad-deadbee',
          direction: 'dangling_ref',
          detail: 'dangling ref planted by the test',
        },
      ],
      hardFail: true,
    });

    await expect(
      htmlToPage({ html: '<x/>', commit: true, coverage_gate: 0 }, ports, alwaysConfirm),
    ).rejects.toThrow(ConvertIntegrityError);
    // Nothing was validated or persisted — the converter bug fails BEFORE any write.
    expect(ports.document.dryRun).not.toHaveBeenCalled();
    expect(ports.document.create).not.toHaveBeenCalled();
    expect(ports.document.save).not.toHaveBeenCalled();
    expect(ports.design.upsertClasses).not.toHaveBeenCalled();
    expect(ports.design.batchVariables).not.toHaveBeenCalled();
  });

  it('hard-fails on an I3 accounting imbalance with the precise violation in the message', async () => {
    const ports = makePorts();
    mockRunIntegrity.mockReturnValue({
      violations: [
        { invariant: 'I3', expected: 9, actual: 7, detail: 'tier ledger does not balance (test)' },
      ],
      hardFail: true,
    });
    await expect(htmlToTree({ html: '<x/>' }, ports)).rejects.toThrow(/\[I3\].*does not balance/);
  });

  it('hard-fails on an I2 violation — base-default bleed-through never persists (§1)', async () => {
    const ports = makePorts();
    const i2 = {
      invariant: 'I2' as const,
      nodeId: 'e-btn',
      widget: 'e-button',
      prop: 'background-color',
      source_value: 'rgba(0, 0, 0, 0)',
      base_default: 'rgb(55, 94, 251)',
      detail: 'ghost button left to turn blue (test)',
    };
    mockRunIntegrity.mockReturnValue({ violations: [i2], hardFail: true });

    await expect(htmlToTree({ html: '<x/>' }, ports)).rejects.toThrow(ConvertIntegrityError);
    mockRunIntegrity.mockReturnValue({ violations: [i2], hardFail: true });
    await expect(
      htmlToPage({ html: '<x/>', commit: true, coverage_gate: 0 }, ports, alwaysConfirm),
    ).rejects.toThrow(/\[I2\].*ghost button/);
    expect(ports.document.save).not.toHaveBeenCalled();
    expect(ports.design.upsertClasses).not.toHaveBeenCalled();
  });

  it('hard-fails on an I4 violation — coverage-diluting noise is a converter bug (§1)', async () => {
    const ports = makePorts();
    mockRunIntegrity.mockReturnValue({
      violations: [
        {
          invariant: 'I4' as const,
          source_path: 'body>div',
          declaration: 'margin: 0px',
          tier: 'custom_css' as const,
          detail: 'computed-default noise survived the filter (test)',
        },
      ],
      hardFail: true,
    });
    await expect(htmlToTree({ html: '<x/>' }, ports)).rejects.toThrow(/\[I4\].*noise/);
  });

  it('wires the PRODUCER-side detected count (style-extract seam) — never re-derived post-tier', async () => {
    const ports = makePorts();
    await htmlToTree({ html: '<div class="hero"><h1>Hello</h1></div>' }, ports);
    const ledger = mockRunIntegrity.mock.calls[0]?.[0]?.ledger;
    expect(ledger).toBeDefined();
    if (ledger === undefined) return;
    // The tiny IR styles real declarations natively, so the producer tally is non-zero and equals
    // the native count (no fallbacks on this fixture) — counted at the extraction seam, not
    // re-derived from the compared arrays (the I3-tautology regression guard).
    expect(ledger.detected_declarations).toBeGreaterThan(0);
    expect(ledger.detected_declarations).toBe(ledger.native_count);
    expect(ledger.pseudo_drop_effects).toBe(0);
  });
});

/* ─────────────────────── contract 17 — #10 pseudo honest-drop wiring (I3/V1) ────────────────── */

describe('contract 17 — #10 pseudo-drop ledger wiring', () => {
  /** The tiny IR with an UNREPRESENTABLE ::after (text content) on the container. */
  function pseudoDropParseResult(): ParseResult {
    const base = tinyParseResult();
    const div = base.ir[0] as ParseResult['ir'][number] & {
      pseudoAfter?: Record<string, string>;
    };
    div.pseudoAfter = {
      content: '"→"',
      display: 'inline',
      width: 'auto',
      height: 'auto',
    };
    return base;
  }

  it('an unrepresentable pseudo lands in the declaration ledger, the report AND warnings', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(pseudoDropParseResult());
    const build = await htmlToTree({ html: '<x/>' }, ports);

    // The ledger row: synthetic ::pseudo-* path + the contract reason token (verify-loop cause
    // attribution keys on BOTH — the rows the §2 V1 'pseudo_unrepresentable' branch matches).
    const row = build.declarationLedger.find((r) => r.source_path.includes('::pseudo-after'));
    expect(row).toBeDefined();
    expect(row?.source_path).toBe('body>div::pseudo-after');
    expect(row?.tier).toBe('html_widget');
    expect(row?.reason).toContain('pseudo_unrepresentable');

    // The coverage report buckets it as a DROPPED declaration (a loss, never silent).
    expect(build.result.report.coverage.pct_dropped).toBeGreaterThan(0);
    expect(
      build.result.report.fallbacks.some((f) => f.reason.includes('pseudo_unrepresentable')),
    ).toBe(true);

    // The tool-result warning (a drop with no warning is the §0 bug class).
    expect(
      build.result.warnings?.some(
        (w) => w.includes('::after') && w.includes('pseudo_unrepresentable'),
      ),
    ).toBe(true);

    // And the I3 accounting carries it on BOTH sides (producer count + ledger row) — balanced.
    const ledger = mockRunIntegrity.mock.calls[0]?.[0]?.ledger;
    expect(ledger?.pseudo_drop_effects).toBe(1);
    expect(
      (ledger?.detected_declarations ?? 0) +
        (ledger?.inline_fold_effects ?? 0) +
        (ledger?.pseudo_drop_effects ?? 0),
    ).toBe((ledger?.native_count ?? 0) + (ledger?.declaration_fallbacks.length ?? 0));
  });

  it('verify-loop cause attribution matches the wired rows (the #10 loop guard is LIVE code)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(pseudoDropParseResult());
    const build = await htmlToTree({ html: '<x/>' }, ports);
    const { attributeCause } =
      await vi.importActual<typeof import('./verify-loop.js')>('./verify-loop.js');
    // A divergence on the pseudo's REAL parent attributes to pseudo_unrepresentable via the
    // pseudo-child prefix match — the exact rows this pipeline now produces.
    expect(
      attributeCause({
        source_path: 'body>div',
        prop: 'background-color',
        converted: { base_classes: [], dangling_refs: [] },
        ledger: build.declarationLedger,
      }),
    ).toBe('pseudo_unrepresentable');
  });
});

/* ───────────────────────────── contract 17 — #9 font carry wiring ───────────────────────────── */

const INTER_LINK = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap';
/** A NON-catalog (self-hosted) font stylesheet — the native path cannot serve it, so it CARRIES. */
const SELF_HOSTED_LINK = 'https://example.com/assets/fonts/inter.css';

/**
 * A parse result whose heading uses Inter and whose document carried a SELF-HOSTED font CSS link
 * (non-catalog — outside the contract-18 §7 native-path demotion, so the carry stage still emits).
 */
function fontParseResult(): import('./parse.js').FontAwareParseResult {
  const base = tinyParseResult();
  const div = base.ir[0];
  const h1 = div?.children[0];
  if (h1 !== undefined) {
    h1.computed['font-family'] = 'Inter, sans-serif';
  }
  return { ...base, fontAssets: { links: [SELF_HOSTED_LINK], families: ['Inter'] } };
}

/** Same page but the link is a GOOGLE Fonts link — catalog by construction (native-path demotion). */
function googleFontParseResult(): import('./parse.js').FontAwareParseResult {
  const base = fontParseResult();
  return { ...base, fontAssets: { links: [INTER_LINK], families: ['Inter'] } };
}

describe('contract 17 — #9 font carry wiring', () => {
  it('prepends ONE font-enqueue html widget FIRST and reports the carry (default ON)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(fontParseResult());
    const build = await htmlToTree({ html: '<x/>' }, ports);

    const first = build.result.elements[0] as {
      elType?: string;
      widgetType?: string;
      settings?: { html?: string };
    };
    expect(first?.elType).toBe('widget');
    expect(first?.widgetType).toBe('html');
    expect(first?.settings?.html).toContain('data-emcp-fonts');
    expect(first?.settings?.html).toContain(SELF_HOSTED_LINK);

    expect(build.result.fonts).toBeDefined();
    expect(build.result.fonts?.carried).toEqual([{ href: SELF_HOSTED_LINK, families: [] }]);
    expect(build.result.fonts?.families_used).toContain('Inter');
  });

  it('contract 18 §7: a used GOOGLE-catalog link DEMOTES to native_path on an atomic site (no widget)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(googleFontParseResult());
    const build = await htmlToTree({ html: '<x/>' }, ports);

    // The native atomic font pipeline serves catalog families (PHP Fonts_Service fix) — the carry
    // link is EXCLUDED with the stable native_path reason, never re-emitted; the family does NOT
    // count as uncarried (the native path covers it).
    expect(JSON.stringify(build.result.elements)).not.toContain('data-emcp-fonts');
    expect(build.result.fonts?.carried).toEqual([]);
    expect(build.result.fonts?.excluded).toEqual([
      { href: INTER_LINK, families: ['Inter'], reason: 'native_path' },
    ]);
    expect(build.result.fonts?.families_uncarried).toEqual([]);
  });

  it('contract 18 §7: NO demotion on a v3 (non-atomic) site — the google link still carries', async () => {
    const ports = makePorts();
    ports.schema.capabilities.mockResolvedValue({
      v4: false,
      atomic: false,
      global_classes: false,
      variables: false,
      pro: false,
      pro_atomic_form: false,
      breakpoints: [],
      experiments: {},
      can_update_class: false,
      classes_migrated: false,
      registered_types: { atomic: [], classic: [] },
      versions: { elementor: '3.0.0', pro: null, plugin: '1.0.0' },
      unfiltered_html: true,
    });
    mockParse.mockResolvedValue(googleFontParseResult());
    const build = await htmlToTree({ html: '<x/>' }, ports);
    expect(build.generation).toBe('v3');
    expect(build.result.fonts?.carried).toEqual([{ href: INTER_LINK, families: ['Inter'] }]);
  });

  it('carry_fonts:false skips the stage entirely (no widget, no report)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(fontParseResult());
    const build = await htmlToTree({ html: '<x/>', options: { carry_fonts: false } }, ports);

    expect(build.result.fonts).toBeUndefined();
    expect(JSON.stringify(build.result.elements)).not.toContain('data-emcp-fonts');
  });

  it('a zero-font page emits neither widget nor report (pre-contract-17 results unchanged)', async () => {
    const ports = makePorts();
    const build = await htmlToTree({ html: '<div><h1>Hello</h1></div>' }, ports);
    expect(build.result.fonts).toBeUndefined();
    expect(JSON.stringify(build.result.elements)).not.toContain('data-emcp-fonts');
  });

  it('the font report rides the html_to_page result (committed path)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(fontParseResult());
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.fonts?.carried[0]?.href).toBe(SELF_HOSTED_LINK);
  });
});

/* ───────────────────────────── contract 17 — post-save verify loop (§2–3) ───────────────────── */

describe('contract 17 — post-save verify loop (§2–3)', () => {
  it('runs the loop after a commit and reports verification (clean gate pass)', async () => {
    const ports = makePorts();
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );

    expect(result.status).toBe('committed');
    expect(mockRunVerifyLoop).toHaveBeenCalledTimes(1);
    const input = mockRunVerifyLoop.mock.calls[0]?.[1] as {
      pageUrl: string;
      breakpoints: unknown[];
      idMap?: Record<string, string>;
      ledger?: unknown[];
      rootNodeId?: string;
    };
    // The anonymously-renderable page URL (`?page_id=N` — the save's preview_url is auth-gated
    // for non-published pages) + the probed breakpoints + the correspondence + the I3 ledger +
    // the REAL page-root id (the overflow-repair target — never derived from the rendered DOM).
    expect(input.pageUrl).toBe('http://x/?page_id=99');
    expect(input.breakpoints.length).toBeGreaterThanOrEqual(2); // desktop + mobile from the probe
    expect(input.idMap).toBeDefined();
    expect(Array.isArray(input.ledger)).toBe(true);
    expect(input.rootNodeId).toBeDefined();

    expect(result.verification).toBeDefined();
    expect(result.verification?.gate.pass).toBe(true);
    expect(result.verification?.gate.action).toBe('none');
    expect(result.verification?.pixel_scores).toEqual([{ breakpoint: 'desktop', ratio: 0.01 }]);
    // A DRAFT commit is temporarily published so the loop can render it, then restored: every
    // commit gets the loop (contract 17 §3 — verification is not publish-only). The FIRST write is
    // the 8b canvas template (a new page renders the source's own chrome, not the theme column).
    expect(ports.document.updateSettings).toHaveBeenCalledTimes(3);
    expect(ports.document.updateSettings.mock.calls[0]).toEqual([
      99,
      { settings: { template: 'elementor_canvas' } },
    ]);
    expect(ports.document.updateSettings.mock.calls[1]).toEqual([
      99,
      { settings: { post_status: 'publish' } },
    ]);
    expect(ports.document.updateSettings.mock.calls[2]).toEqual([
      99,
      { settings: { post_status: 'draft' } },
    ]);
    expect(result.verification?.gate.reasons.join(' ')).toContain('restored to "draft"');
  });

  it('passes the FIRST ATOMIC node as rootNodeId — never the prepended font-carry html widget', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(fontParseResult());
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    // The tree's FIRST element is the classic font-carry html widget (cannot host atomic repairs);
    // the overflow-repair target must be the first ATOMIC node after it.
    const saveBody = ports.document.save.mock.calls[0]?.[1] as {
      elements: Array<{ id: string; elType: string; widgetType?: string }>;
    };
    const first = saveBody.elements[0];
    const firstAtomic = saveBody.elements.find(
      (el) => el.elType !== 'widget' || el.widgetType?.startsWith('e-') === true,
    );
    expect(first?.widgetType).toBe('html');
    expect(firstAtomic).toBeDefined();
    const input = mockRunVerifyLoop.mock.calls[0]?.[1] as { rootNodeId?: string };
    expect(input.rootNodeId).toBe(firstAtomic?.id);
    expect(input.rootNodeId).not.toBe(first?.id);
  });

  it('commit:false (preview) runs NO verify loop', async () => {
    const ports = makePorts();
    const result = await htmlToPage({ html: '<x/>' }, ports, alwaysConfirm);
    expect(result.status).toBe('preview');
    expect(mockRunVerifyLoop).not.toHaveBeenCalled();
    expect(result.verification).toBeUndefined();
  });

  it('applies R1 repairs through the normal save path (base_hash + re-prime) and re-verifies', async () => {
    const ports = makePorts();
    // The live saved tree the repair round reads back: one atomic heading node.
    ports.document.getStructure.mockResolvedValue({
      id: 99,
      elements: [
        {
          id: 'abc1234',
          elType: 'widget',
          widgetType: 'e-heading',
          settings: {
            classes: { $$type: 'classes', value: ['e-abc1234-1111111'] },
          },
          styles: {
            'e-abc1234-1111111': {
              id: 'e-abc1234-1111111',
              type: 'class',
              label: 'local',
              variants: [{ meta: { breakpoint: 'desktop', state: null }, props: {} }],
            },
          },
          elements: [],
        },
      ],
      settings: {},
      base_hash: 'hash-live',
      generation: 'v4',
      type: 'page',
    });
    const repair = {
      nodeId: 'abc1234',
      prop: 'color',
      value: '#ff0000',
      cause: 'base_default' as const,
    };
    mockRunVerifyLoop
      .mockResolvedValueOnce({
        ...cleanLoopResult(),
        divergences: [divergenceRow('color')],
        repairs: [repair],
      })
      .mockResolvedValueOnce(cleanLoopResult());

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );

    // One repair round: replace-tree with the LIVE base_hash, then a re-prime, then a re-verify.
    expect(ports.document.replaceTree).toHaveBeenCalledTimes(1);
    const [repairPageId, repairBody] = ports.document.replaceTree.mock.calls[0] as [
      number,
      { elements: unknown[]; base_hash: string },
    ];
    expect(repairPageId).toBe(99);
    expect(repairBody.base_hash).toBe('hash-live');
    // The patched node carries the repaired prop as a TYPED value in its base variant.
    expect(JSON.stringify(repairBody.elements)).toContain('"color"');
    expect(JSON.stringify(repairBody.elements)).toContain('#ff0000');
    expect(ports.document.primeCss.mock.calls.length).toBeGreaterThanOrEqual(2); // commit + repair
    expect(mockRunVerifyLoop).toHaveBeenCalledTimes(2);

    expect(result.verification?.repairs.applied).toEqual([repair]);
    expect(result.verification?.repairs.rounds).toBe(1);
    expect(result.verification?.gate.pass).toBe(true);
  });

  it('R3 gate: a V2 failure on a published page reverts it to draft and says so', async () => {
    const ports = makePorts();
    const clean = cleanLoopResult();
    mockRunVerifyLoop.mockResolvedValue({
      ...clean,
      layoutAudits: clean.layoutAudits.map((a) => ({
        ...a,
        scroll_width: 1700,
        scroll_width_ok: false,
        pass: false,
      })),
    });

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0, status: 'publish' },
      ports,
      alwaysConfirm,
    );

    expect(result.status).toBe('committed');
    expect(result.verification?.gate.pass).toBe(false);
    expect(result.verification?.gate.v2_pass).toBe(false);
    expect(result.verification?.gate.action).toBe('reverted_to_draft');
    expect(ports.document.updateSettings).toHaveBeenCalledWith(99, {
      settings: { post_status: 'draft' },
    });
    expect(result.verification?.gate.reasons.join(' ')).toContain('horizontal overflow');
  });

  it('R3 gate: divergences over verify_gate fail the gate; a draft page ends at draft (restored)', async () => {
    const ports = makePorts();
    mockRunVerifyLoop.mockResolvedValue({
      ...cleanLoopResult(),
      divergences: [divergenceRow('color'), divergenceRow('width'), divergenceRow('height')],
    });

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0, verify_gate: 2 },
      ports,
      alwaysConfirm,
    );

    expect(result.verification?.gate.pass).toBe(false);
    expect(result.verification?.gate.v2_pass).toBe(true);
    expect(result.verification?.gate.divergence_count).toBe(3);
    expect(result.verification?.gate.threshold).toBe(2);
    // The draft page was temporarily published for the loop render and ends back at draft —
    // the failing gate never leaves it publicly visible. (3 writes: 8b template, publish, draft.)
    expect(ports.document.updateSettings).toHaveBeenCalledTimes(3);
    expect(ports.document.updateSettings.mock.calls.at(-1)).toEqual([
      99,
      { settings: { post_status: 'draft' } },
    ]);
    expect(result.verification?.gate.action).toBe('none');
    expect(result.verification?.gate.reasons.join(' ')).toContain('STAYS "draft"');
  });

  it('R3 gate: a status write that keeps failing is a machine-readable revert_failed + a LOUD warning', async () => {
    const ports = makePorts();
    const clean = cleanLoopResult();
    mockRunVerifyLoop.mockResolvedValue({
      ...clean,
      layoutAudits: clean.layoutAudits.map((a) => ({ ...a, scroll_width_ok: false, pass: false })),
    });
    ports.document.updateSettings.mockRejectedValue(new Error('settings route down'));

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0, status: 'publish' },
      ports,
      alwaysConfirm,
    );

    expect(result.status).toBe('committed');
    expect(result.verification?.gate.pass).toBe(false);
    expect(result.verification?.gate.action).toBe('revert_failed');
    // The fail-closed write retried once (2 attempts) before reporting; the rejected 8b template
    // write (1 attempt, downgraded to a warning) rides ahead of them.
    expect(ports.document.updateSettings).toHaveBeenCalledTimes(3);
    expect(result.verification?.gate.reasons.join(' ')).toContain('PUBLICLY VISIBLE');
    // Never just a reason string buried in the verdict: a TOP-LEVEL warning rides the result.
    expect(result.warnings?.some((w) => w.includes('R3 gate FAIL-CLOSED FAILURE'))).toBe(true);
  });

  it('a loop fault is an honest warning — committed:true stands, verification omitted (draft secured)', async () => {
    const ports = makePorts();
    mockRunVerifyLoop.mockRejectedValue(new Error('chromium exploded'));

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );

    expect(result.status).toBe('committed');
    expect(result.committed).toBe(true);
    expect(result.verification).toBeUndefined();
    expect(result.warnings?.some((w) => w.includes('verification loop did NOT run'))).toBe(true);
    // The draft commit was temporarily published for the loop — the fault path restores draft.
    expect(ports.document.updateSettings.mock.calls.at(-1)).toEqual([
      99,
      { settings: { post_status: 'draft' } },
    ]);
  });

  it('R3 FAIL-CLOSED: a loop fault on a PUBLISH commit reverts the page to draft (never live unverified)', async () => {
    const ports = makePorts();
    mockRunVerifyLoop.mockRejectedValue(new Error('chromium exploded'));

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0, status: 'publish' },
      ports,
      alwaysConfirm,
    );

    expect(result.status).toBe('committed');
    expect(result.verification).toBeUndefined();
    // Contract 17 §3: 'commit:true + passing loop = publish' — no loop, no publish.
    expect(ports.document.updateSettings).toHaveBeenCalledWith(99, {
      settings: { post_status: 'draft' },
    });
    const warning = result.warnings?.find((w) => w.includes('verification loop did NOT run'));
    expect(warning).toBeDefined();
    expect(warning).toContain('secured to "draft"');
  });

  it('DEFAULT_VERIFY_GATE is the contract-17 §3 default threshold (25)', () => {
    expect(DEFAULT_VERIFY_GATE).toBe(25);
  });
});

describe('contract 17 — 8b page template (canvas-by-default for NEW pages)', () => {
  it("page_template:'default' opts a new page back into the theme template (no template write)", async () => {
    const ports = makePorts();
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0, page_template: 'default' },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    // Only the loop's temporary publish + restore — no settings write carries a template.
    const bodies = ports.document.updateSettings.mock.calls.map(
      (c) => (c[1] as { settings: Record<string, unknown> }).settings,
    );
    expect(bodies.every((s) => !('template' in s))).toBe(true);
  });

  it("an EXISTING post_id's template is the operator's choice — untouched without an explicit arg", async () => {
    const ports = makePorts();
    ports.document.getStructure.mockResolvedValue({
      id: 42,
      elements: [],
      settings: { post_status: 'publish' },
      base_hash: 'hash-abc',
      generation: 'v4',
      type: 'page',
    });
    const result = await htmlToPage(
      { html: '<x/>', post_id: 42, commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(ports.document.updateSettings).not.toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        settings: expect.objectContaining({ template: expect.anything() }),
      }),
    );
  });

  it('an explicit page_template DOES land on an existing post_id (before the verify loop)', async () => {
    const ports = makePorts();
    ports.document.getStructure.mockResolvedValue({
      id: 42,
      elements: [],
      settings: { post_status: 'publish' },
      base_hash: 'hash-abc',
      generation: 'v4',
      type: 'page',
    });
    const result = await htmlToPage(
      {
        html: '<x/>',
        post_id: 42,
        commit: true,
        coverage_gate: 0,
        page_template: 'elementor_header_footer',
      },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(ports.document.updateSettings).toHaveBeenCalledWith(42, {
      settings: { template: 'elementor_header_footer' },
    });
    // The template write precedes the loop render — the loop judges the canvas/template render.
    const templateCallOrder = ports.document.updateSettings.mock.invocationCallOrder[0];
    const loopCallOrder = mockRunVerifyLoop.mock.invocationCallOrder[0];
    expect(templateCallOrder).toBeLessThan(loopCallOrder ?? 0);
  });

  it('a failed template write is a LOUD warning, never a silent skip (commit + verification stand)', async () => {
    const ports = makePorts();
    ports.document.updateSettings
      .mockRejectedValueOnce(new Error('settings route down'))
      .mockResolvedValue({ success: true, settings: {} });
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.committed).toBe(true);
    expect(result.verification).toBeDefined();
    expect(result.warnings?.some((w) => w.includes('page template "elementor_canvas"'))).toBe(true);
  });
});

/* ───────────────────── contract 18 §7 — the INTEGRATOR wiring (hardened gate + P1-c + honesty) ── */

describe('contract 18 §7 — hardened verify gate wiring (§6 F6)', () => {
  it('a FAILED content-presence audit fails the gate (P1-a/P1-e — the pre-17.1 gate could not see it)', async () => {
    const ports = makePorts();
    const clean = cleanLoopResult();
    mockRunVerifyLoop.mockResolvedValue({
      ...clean,
      contentAudit: {
        breakpoint: 'desktop',
        total: 12,
        present: 11,
        dropped: 0,
        missing: [{ source_path: 'body>div>p', text: '$0/forever' }],
        pass: false,
      },
    });

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0, status: 'publish' },
      ports,
      alwaysConfirm,
    );

    expect(result.status).toBe('committed');
    expect(result.verification?.gate.pass).toBe(false);
    // V2 itself passed — ONLY the new blind-spot audit failed the gate.
    expect(result.verification?.gate.v2_pass).toBe(true);
    expect(result.verification?.gate.action).toBe('reverted_to_draft');
    expect(result.verification?.gate.reasons.join(' ')).toContain('content-presence audit failed');
    expect(result.verification?.gate.reasons.join(' ')).toContain('$0/forever');
    expect(result.verification?.content_audit.missing).toHaveLength(1);
  });

  it('a FAILED behavioral probe fails the gate (P1-c — dead interactions never pass silently)', async () => {
    const ports = makePorts();
    mockRunVerifyLoop.mockResolvedValue({
      ...cleanLoopResult(),
      behaviorProbes: [
        {
          kind: 'interactions',
          nodeId: 'abc1234',
          pass: false,
          detail: 'NO <1 → 1 opacity ramp on a scrollIn element',
        },
      ],
    });

    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0, status: 'publish' },
      ports,
      alwaysConfirm,
    );

    expect(result.verification?.gate.pass).toBe(false);
    expect(result.verification?.gate.action).toBe('reverted_to_draft');
    expect(result.verification?.gate.reasons.join(' ')).toContain(
      'behavioral probe failed on abc1234',
    );
    expect(result.verification?.behavior_probes).toHaveLength(1);
  });

  it('the verification carrier surfaces ALL hardened-loop outputs (content/counts/probes/causes)', async () => {
    const ports = makePorts();
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.verification?.content_audit.pass).toBe(true);
    expect(result.verification?.element_counts).toEqual([
      { breakpoint: 'desktop', source_count: 2, converted_count: 2, delta: 0 },
    ]);
    expect(result.verification?.behavior_probes).toEqual([]);
    expect(result.verification?.cause_stats).toEqual({
      total: 0,
      attributed: 0,
      unknown: 0,
      attributed_ratio: 1,
    });
  });

  it('threads droppedTexts + one scrollIn probe target per AUTHORED interaction into the loop input', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(entranceParse());
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');

    // The authored element id is recoverable from the SAVED tree (the element carrying the blob).
    const saveBody = ports.document.save.mock.calls[0]?.[1] as {
      elements: Array<Record<string, unknown>>;
    };
    const findBearing = (nodes: Array<Record<string, unknown>>): string | undefined => {
      for (const node of nodes) {
        if (typeof node['interactions'] === 'string' && node['interactions'] !== '') {
          return node['id'] as string;
        }
        const found = findBearing((node['elements'] as Array<Record<string, unknown>>) ?? []);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const bearingId = findBearing(saveBody.elements);
    expect(bearingId).toBeDefined();

    const input = mockRunVerifyLoop.mock.calls[0]?.[1] as {
      droppedTexts?: string[];
      interactions?: Array<{ element_id: string; trigger: string }>;
    };
    expect(input.droppedTexts).toEqual([]);
    // ONE probe target per authored element — never one per stamped node (P3-c measurement).
    expect(input.interactions).toEqual([{ element_id: bearingId, trigger: 'scrollIn' }]);
  });

  it('a zero-interaction commit passes NO interactions key (loop skips the probe page-load)', async () => {
    const ports = makePorts();
    await htmlToPage({ html: '<x/>', commit: true, coverage_gate: 0 }, ports, alwaysConfirm);
    const input = mockRunVerifyLoop.mock.calls[0]?.[1] as { interactions?: unknown };
    expect(input.interactions).toBeUndefined();
  });
});

describe('contract 18 §7 — P1-c interaction-wiring diagnosis (post-save)', () => {
  /** Wire the document stub so the §8.2 readback returns what the save persisted (locally scoped). */
  function captureReadback(ports: StubPorts): { saved: () => unknown[] } {
    let savedElements: unknown[] = [];
    ports.document.save.mockImplementation((_id: number, body: { elements: unknown[] }) => {
      savedElements = body.elements;
      return Promise.resolve({
        id: 99,
        diff: { changed_ids: [], new_ids: ['e-1'], removed_ids: [], before: {}, after: {} },
        base_hash: 'hash-new',
        preview_url: 'http://x/?p=99',
        backup_handle: { meta_key: 'k', revision_id: 1 },
        css_primed: false,
        prime_required: true,
        remapped_ids: {},
        idempotent_replay: false,
        op_id: 'op-xyz',
      });
    });
    ports.document.getStructure.mockImplementation(() =>
      Promise.resolve({
        id: 99,
        elements: savedElements,
        settings: {},
        base_hash: 'hash-new',
        generation: 'v4',
        type: 'page',
      }),
    );
    return { saved: () => savedElements };
  }

  /** Deep-strip every `interactions` key (the PHP sanitizer's silent-drop shape). */
  function stripInteractionsDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripInteractionsDeep);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => k !== 'interactions')
          .map(([k, v]) => [k, stripInteractionsDeep(v)]),
      );
    }
    return value;
  }

  it('a fully-wired save raises NO diagnosis warning', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(entranceParse());
    captureReadback(ports);
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.interactions_post_save?.[0]?.status).toBe('survived');
    expect(result.warnings?.some((w) => w.includes('P1-c interaction wiring'))).toBeFalsy();
  });

  it('a broken wiring leg (items lost) is PINNED with the diagnosis summary + problem rows', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(entranceParse());
    const capture = captureReadback(ports);
    ports.document.getStructure.mockImplementation(() =>
      Promise.resolve({
        id: 99,
        elements: stripInteractionsDeep(capture.saved()),
        settings: {},
        base_hash: 'hash-new',
        generation: 'v4',
        type: 'page',
      }),
    );
    const result = await htmlToPage(
      { html: '<x/>', commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    const joined = (result.warnings ?? []).join('\n');
    expect(joined).toContain('P1-c interaction wiring diagnosis FAILED');
    expect(joined).toContain('items_lost');
    expect(joined).toContain('Validation::sanitize drops invalid items with NO error');
  });
});

describe('contract 18 §7 — detection honesty (undetectable_classes wiring)', () => {
  const COUNT_UP_HTML =
    '<div><span class="counter">120</span>' +
    '<script>let i=0;function tick(){el.textContent = String(i++);requestAnimationFrame(tick);}tick();</script></div>';

  /** A stat leaf whose text is a short numeric value (the census suspect shape). */
  function statParse(): ParseResult {
    return parseResultOf([
      irNode({
        source_path: 'body>div',
        computed: { display: 'flex' },
        children: [
          irNode({
            source_path: 'body>div>span',
            tag: 'span',
            role: 'text',
            attrs: { class: 'counter' },
            textRuns: [{ text: '120', inlineTags: [] }],
          }),
        ],
      }),
    ]);
  }

  it('a rAF count-up page surfaces a report-level undetectable_classes note (never silence)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(statParse());
    const build = await htmlToTree({ html: COUNT_UP_HTML }, ports);
    const notes = build.result.undetectable_classes;
    expect(notes).toBeDefined();
    expect(notes?.[0]?.class).toBe('raf-text-mutation');
    expect(notes?.[0]?.evidence.length).toBeGreaterThan(0);
    expect(notes?.[0]?.nodeIds).toContain('body>div>span');
  });

  it('the notes ride the html_to_page result too (committed path)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(statParse());
    const result = await htmlToPage(
      { html: COUNT_UP_HTML, commit: true, coverage_gate: 0 },
      ports,
      alwaysConfirm,
    );
    expect(result.status).toBe('committed');
    expect(result.undetectable_classes?.[0]?.class).toBe('raf-text-mutation');
  });

  it('a script-free page omits the field entirely (pre-18 results unchanged)', async () => {
    const ports = makePorts();
    const build = await htmlToTree({ html: '<div><h1>Hello</h1></div>' }, ports);
    expect(build.result.undetectable_classes).toBeUndefined();
  });
});

describe('contract 18 §7 — TextRun.color + source-id carry through the pipeline (P2-d / #8)', () => {
  /** A section carrying a source [id] anchor + a paragraph with an inline <em> accent run. */
  function accentAnchorParse(): ParseResult {
    return parseResultOf([
      irNode({
        source_path: 'body>section',
        computed: { display: 'flex', color: 'rgb(0, 0, 0)' },
        attrs: { id: 'pricing' },
        children: [
          irNode({
            source_path: 'body>section>p',
            tag: 'p',
            role: 'text',
            computed: { color: 'rgb(0, 0, 0)' },
            textRuns: [
              { text: 'Plans start at ', inlineTags: [] },
              { text: 'free', inlineTags: ['em'], color: 'rgb(255, 0, 0)' },
            ],
          }),
        ],
      }),
    ]);
  }

  /** Collect every base64 custom_css raw in the tree, decoded. */
  function decodedCustomCss(elements: unknown[]): string {
    const raws: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const v of value) visit(v);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        const rec = value as Record<string, unknown>;
        const cc = rec['custom_css'] as
          | { raw?: unknown; value?: { raw?: unknown } }
          | undefined;
        const raw = cc?.raw ?? cc?.value?.raw;
        if (typeof raw === 'string' && raw !== '') {
          raws.push(Buffer.from(raw, 'base64').toString('utf8'));
        }
        for (const v of Object.values(rec)) visit(v);
      }
    };
    visit(elements);
    return raws.join('\n');
  }

  it('Pro site: the accent run materializes as a NESTED custom_css rule and the [id] lands as _cssid', async () => {
    const ports = makePorts();
    ports.schema.capabilities.mockResolvedValue({
      v4: true,
      atomic: true,
      global_classes: true,
      variables: true,
      pro: true,
      pro_atomic_form: false,
      breakpoints: [],
      experiments: {},
      can_update_class: true,
      classes_migrated: true,
      registered_types: { atomic: [], classic: [] },
      versions: { elementor: '4.1.1', pro: '4.1.0', plugin: '1.0.0' },
      unfiltered_html: true,
    });
    mockParse.mockResolvedValue(accentAnchorParse());
    const build = await htmlToTree({ html: '<x/>' }, ports);

    // P2-d — the source [id] seeds the renderable `_cssid` prop (in-page hrefs resolve).
    const json = JSON.stringify(build.result.elements);
    expect(json).toContain('_cssid');
    expect(json).toContain('pricing');

    // #8 — the per-run accent color rides a nested custom_css rule (NEVER a style attr).
    const css = decodedCustomCss(build.result.elements as unknown[]);
    expect(css).toContain('& em{color:rgb(255, 0, 0);}');
    expect(json).not.toContain('style=');

    // The custom_css tier row is in the ledger (I3 accounting carries the accent).
    expect(
      build.declarationLedger.some(
        (r) => r.tier === 'custom_css' && r.declaration.includes('color: rgb(255, 0, 0)'),
      ),
    ).toBe(true);
  });

  it('non-Pro site: the accent is an HONEST inline-fold drop in the I3 ledger (17 fixup residual)', async () => {
    const ports = makePorts();
    mockParse.mockResolvedValue(accentAnchorParse());
    const build = await htmlToTree({ html: '<x/>' }, ports);

    // Pro inactive → no custom_css channel: the accent lands in the dropped tier, never silently.
    const dropRow = build.declarationLedger.find(
      (r) => r.declaration.includes('color: rgb(255, 0, 0)') && r.tier === 'html_widget',
    );
    expect(dropRow).toBeDefined();
    expect(build.result.report.coverage.pct_dropped).toBeGreaterThan(0);

    // And the I3 accounting balances WITH the fold/drop effects on the expected side.
    const ledger = mockRunIntegrity.mock.calls[0]?.[0]?.ledger;
    expect(ledger).toBeDefined();
    expect(
      (ledger?.detected_declarations ?? 0) +
        (ledger?.inline_fold_effects ?? 0) +
        (ledger?.pseudo_drop_effects ?? 0),
    ).toBe((ledger?.native_count ?? 0) + (ledger?.declaration_fallbacks.length ?? 0));
  });
});

describe('DEFAULT_COVERAGE_GATE', () => {
  it('is the S3-anchored 60% floor (never 85%)', () => {
    expect(DEFAULT_COVERAGE_GATE).toBe(0.6);
  });
});
