/**
 * Contract 18 §1-§3/§5 — FIGMA-PARSE stage tests (all PURE — no Chromium, no network).
 *
 * Fixtures (committed, CI needs no Figma access — §6):
 *  - `fixtures/figma/wpos-v2-hero.json` — trimmed from a REAL `GET_FILE_NODES` response (WPOS Figma
 *    v2 hero, file ogxmGWnTEJK3TEPnMWp2by, frame 400:7510): auto-layout buttons, real
 *    characterStyleOverrides + a Figma-shaped hyperlink, visible image fill, LAYER_BLUR ellipse,
 *    a real VECTOR, an invisible rectangle, and an ON_HOVER swap whose target is OUTSIDE the
 *    extraction (the honest-drop leg).
 *  - `fixtures/figma/synthetic-responsive.json` — synthesized faithfully to the API shape for the
 *    rows a single real frame cannot carry: §5 sibling breakpoint frames (Landing/Desktop+Mobile),
 *    ON_CLICK URL / NAVIGATE, an ON_HOVER swap whose variant target IS in the payload, an
 *    AFTER_TIMEOUT DISSOLVE entrance, an ON_DRAG honest drop, a device-mockup flatten, the
 *    forms-not-inferred report, and a Google-catalog family.
 *
 * Covers every §2 mapping row (auto-layout, fills/strokes/effects/radius, TEXT+overrides+hyperlink,
 * image fills → MediaRef, vectors → flatten, prototype interactions), the §3 flatten policy across
 * all three modes, §5 responsive (frames + synthesized) and semantics (headings, buttons, forms),
 * per-family font availability, the F1 accounting invariant, and survival of the designer-intent
 * roles/behaviors through the UNCHANGED normalize → classify stages.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  auditFigmaAccounting,
  collectFigmaNodeIds,
  figmaParse,
  headingTagFor,
  type FigmaParseOptions,
  type FigmaParseResult,
} from './figma-parse.js';
import {
  flattenVerdict,
  isAbsoluteFanOut,
  isLayeredCluster,
  overlapRatio,
  type FigmaRawNode,
} from './figma-flatten.js';
import { isCatalogFamily } from './figma-fonts-catalog.js';
import { classifyIr } from './classify.js';
import { normalizeIr } from './normalize.js';
import type { IrNode } from './types.js';

/* ─────────────────────────── fixtures ────────────────────────────────────────────────────────── */

function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../fixtures/figma/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const WPOS = loadFixture('wpos-v2-hero.json');
const SYNTH = loadFixture('synthetic-responsive.json');

/** The visible image fill imageRef on the WPOS "Placeholder Lightbox" frame. */
const WPOS_IMAGE_REF = '0e989ef7b52f507272a1d0919cabe50c891fe16f';

function parseWpos(opts: FigmaParseOptions = {}): FigmaParseResult {
  return figmaParse(WPOS, opts);
}

function parseSynth(opts: FigmaParseOptions = {}): FigmaParseResult {
  return figmaParse(SYNTH, opts);
}

/** Find the IR node with the given `source_path` anywhere in the forest (throws when absent). */
function mustFind(ir: IrNode[], sourcePath: string): IrNode {
  const walk = (n: IrNode): IrNode | undefined => {
    if (n.source_path === sourcePath) return n;
    for (const c of n.children) {
      const found = walk(c);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const root of ir) {
    const found = walk(root);
    if (found !== undefined) return found;
  }
  throw new Error(`IR node ${sourcePath} not found`);
}

/** All IR nodes, flattened depth-first. */
function allNodes(ir: IrNode[]): IrNode[] {
  const out: IrNode[] = [];
  const walk = (n: IrNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const root of ir) walk(root);
  return out;
}

/* ─────────────────────────── envelope (§1: ParseResult-compatible) ──────────────────────────── */

describe('figmaParse: ParseResult envelope', () => {
  it('emits the frozen envelope: ir + ltr + viewport from frame width + empty raw_inner_markup', () => {
    const res = parseWpos();
    expect(res.doc_direction).toBe('ltr');
    expect(res.viewport_used).toBe(1440);
    expect(res.raw_inner_markup).toEqual({});
    expect(res.pageScripts).toEqual([]);
    expect(res.ir).toHaveLength(1);
    expect(res.figma.frame).toEqual({ node_id: '400:7510', name: 'Hero', width: 1440, height: 790 });
  });

  it('is deterministic: same input → byte-identical output', () => {
    expect(JSON.stringify(parseWpos())).toBe(JSON.stringify(parseWpos()));
  });

  it('throws on a payload with no node documents', () => {
    expect(() => figmaParse({ nope: true })).toThrow(/no Figma node documents/);
  });

  it('tolerates the LIVE Composio execute envelope + /files full-file shape (drift guard)', () => {
    // Live-verified 2026-06-11 (W18 leg 3): `simplify:false` returns the `/files` shape under a
    // `{data, raw_data, simplified}` wrapper — DOCUMENT/CANVAS roots must descend so the page
    // FRAMES are the top-level documents (400:7508 was "not a top-level document" before the fix).
    const frameDoc = (WPOS as { nodes: Record<string, { document: unknown }> }).nodes['400:7510']
      ?.document;
    const liveShape = {
      data: {
        name: 'WPOS',
        role: 'viewer',
        document: {
          id: '0:0',
          type: 'DOCUMENT',
          children: [{ id: '0:1', type: 'CANVAS', name: 'Page 1', children: [frameDoc] }],
        },
      },
      raw_data: null,
      simplified: false,
    };
    const res = figmaParse(liveShape, { node_id: '400:7510' });
    expect(res.figma.frame).toEqual({ node_id: '400:7510', name: 'Hero', width: 1440, height: 790 });
    expect(JSON.stringify(res.ir)).toBe(JSON.stringify(parseWpos({ node_id: '400:7510' }).ir));
  });

  it('NONE-layout (hand-placed) children carry absolute offsets; the parent anchors them', () => {
    // W18 page 3282: NONE-layout sections previously emitted NO placement — children reflowed
    // into vertical stacks (14,485px page vs the 6,225px frame). The canvas truth for a
    // non-auto-layout frame is absolute geometry.
    const frame: FigmaRawNode = {
      id: 'n:0',
      type: 'FRAME',
      name: 'Section',
      absoluteBoundingBox: { x: 0, y: 100, width: 1440, height: 800 },
      children: [
        { id: 'n:1', type: 'RECTANGLE', absoluteBoundingBox: { x: 40, y: 150, width: 600, height: 300 } },
        { id: 'n:2', type: 'RECTANGLE', absoluteBoundingBox: { x: 700, y: 400, width: 600, height: 300 } },
      ],
    };
    const res = figmaParse({ nodes: { 'n:0': { document: frame } } }, { node_id: 'n:0' });
    const root = mustFind(res.ir, 'figma:n:0');
    expect(root.computed['position']).toBe('relative');
    const first = mustFind(res.ir, 'figma:n:1');
    expect(first.computed['position']).toBe('absolute');
    expect(first.computed['top']).toBe('50px');
    expect(first.computed['left']).toBe('40px');
    expect(first.computed['width']).toBe('600px');
    expect(first.computed['max-width']).toBe('100%');
    const second = mustFind(res.ir, 'figma:n:2');
    expect(second.computed['top']).toBe('300px');
    expect(second.computed['left']).toBe('700px');

    // Auto-layout containers anchor too — a static flex parent lets ABSOLUTE-escape children
    // anchor to a higher relative ancestor and double-apply offsets (page 3326: scrollWidth 2245).
    const auto: FigmaRawNode = {
      ...frame,
      id: 'n:9',
      layoutMode: 'VERTICAL',
      children: [{ id: 'n:10', type: 'RECTANGLE', absoluteBoundingBox: { x: 0, y: 100, width: 100, height: 100 } }],
    };
    const autoRes = figmaParse({ nodes: { 'n:9': { document: auto } } }, { node_id: 'n:9' });
    expect(mustFind(autoRes.ir, 'figma:n:9').computed['position']).toBe('relative');

    // clipsContent is the canvas truth: overhanging children are HIDDEN (page 3370: an
    // off-canvas decorative child drove scrollWidth 1440 → 2245 without the clip).
    const clipped: FigmaRawNode = { ...frame, id: 'n:20', clipsContent: true };
    const clipRes = figmaParse({ nodes: { 'n:20': { document: clipped } } }, { node_id: 'n:20' });
    expect(mustFind(clipRes.ir, 'figma:n:20').computed['overflow']).toBe('hidden');
    expect(root.computed['overflow']).toBeUndefined(); // no clip → no overflow style
  });

  it('the root frame is full-bleed: background carried, min-height, NO fixed width', () => {
    const root = mustFind(parseWpos().ir, 'figma:400:7510');
    expect(root.computed['background-color']).toBe('rgb(255, 255, 255)');
    expect(root.computed['min-height']).toBe('790px');
    expect(root.computed['width']).toBeUndefined();
  });
});

/* ─────────────────────────── §2 row: auto-layout → flex roles + styles ──────────────────────── */

describe('figmaParse: auto-layout (designer intent REPLACES flex-inference)', () => {
  it('HORIZONTAL auto-layout → flex-row role + EXPLICIT display:flex computed styles', () => {
    const node = mustFind(parseWpos().ir, 'figma:400:7520'); // "Main Buttons"
    expect(node.role).toBe('flex-row');
    expect(node.computed['display']).toBe('flex');
    expect(node.computed['flex-direction']).toBe('row');
    expect(node.computed['justify-content']).toBe('flex-start');
  });

  it('padding longhands are ALWAYS emitted (0px included — guards the intrinsic e-flexbox 10px)', () => {
    const node = mustFind(parseWpos().ir, 'figma:400:7520');
    expect(node.computed['padding-top']).toBe('0px');
    expect(node.computed['padding-left']).toBe('0px');
    expect(node.computed['gap']).toBe('0px');
  });

  it('itemSpacing/padding/axis-align map to gap/padding/justify/align (synthetic Cards row)', () => {
    const cards = mustFind(parseSynth().ir, 'figma:1:10');
    expect(cards.role).toBe('flex-row');
    expect(cards.computed['gap']).toBe('24px');
    expect(cards.computed['padding-top']).toBe('40px');
    expect(cards.computed['padding-left']).toBe('40px');
    expect(cards.computed['align-items']).toBe('center');
    expect(cards.computed['width']).toBe('1200px'); // FIXED sizing.
  });

  it('VERTICAL auto-layout → flex-col role; FILL children get flex-grow:1', () => {
    const cardA = mustFind(parseSynth().ir, 'figma:1:11');
    expect(cardA.role).toBe('flex-col');
    expect(cardA.computed['flex-direction']).toBe('column');
    // Card A FILLs the horizontal primary axis of the Cards row.
    expect(cardA.computed['flex-grow']).toBe('1');
  });

  it('non-auto-layout frames stay structural blocks (geometry inference owns them downstream)', () => {
    const root = mustFind(parseWpos().ir, 'figma:400:7510');
    expect(root.role).toBe('structural-block');
    expect(root.computed['display']).toBe('block');
  });
});

/* ─────────────────────────── §2 row: fills / strokes / effects / cornerRadius ───────────────── */

describe('figmaParse: fills, strokes, effects, cornerRadius', () => {
  it('SOLID fill → background-color; stroke → border longhands; cornerRadius → radius longhands', () => {
    const ir = parseWpos().ir;
    const button = allNodes(ir).find((n) => n.role === 'button');
    expect(button).toBeDefined();
    const b = button as IrNode;
    expect(b.computed['background-color']).toBe('rgb(255, 255, 255)');
    expect(b.computed['border-color']).toBe('rgb(16, 87, 66)');
    // individualStrokeWeights on the real instance: top/right 3, bottom/left 6.
    expect(b.computed['border-top-width']).toBe('3px');
    expect(b.computed['border-bottom-width']).toBe('6px');
    expect(b.computed['border-top-style']).toBe('solid');
    expect(b.computed['border-top-left-radius']).toBe('8px');
  });

  it('invisible paints are skipped (visible:false fills never become backgrounds)', () => {
    // "Column" (400:7514) carries only a visible:false solid → no background-color.
    const column = mustFind(parseWpos().ir, 'figma:400:7514');
    expect(column.computed['background-color']).toBeUndefined();
  });

  it('DROP_SHADOW effects → a combined box-shadow declaration', () => {
    const frame = mustFind(parseWpos().ir, 'figma:400:7515'); // two visible drop shadows
    const shadow = frame.computed['box-shadow'] ?? '';
    expect(shadow).toContain('0px 2px 3px');
    expect(shadow).toContain('0px 6px 10px');
    expect(shadow.split(',').length).toBeGreaterThanOrEqual(2);
  });

  it('node opacity < 1 is carried', () => {
    const res = parseWpos({ flatten: 'minimal' });
    const ellipse = mustFind(res.ir, 'figma:400:7513');
    // The visible solid paint has opacity 0.28 → rgba alpha.
    expect(ellipse.computed['background-color']).toBe('rgba(0, 0, 0, 0.28)');
  });
});

/* ─────────────────────────── §2 row: TEXT + characterStyleOverrides (+hyperlink) ────────────── */

describe('figmaParse: TEXT → TextRun[] + typography', () => {
  it('maps the base type style onto computed typography', () => {
    const heading = mustFind(parseWpos().ir, 'figma:400:7517');
    expect(heading.computed['font-family']).toBe('FONTSPRING DEMO - Novaletra Serif CF Heavy');
    expect(heading.computed['font-size']).toBe('56px');
    expect(heading.computed['font-weight']).toBe('900');
    expect(heading.computed['line-height']).toBe('67.2px');
    expect(heading.computed['text-align']).toBe('center');
    expect(heading.computed['color']).toBe('rgb(255, 255, 255)');
    // textAutoResize:HEIGHT (fixed wrap width) → max-width, never a rigid width.
    expect(heading.computed['max-width']).toBe('571px');
    expect(heading.computed['width']).toBeUndefined();
  });

  it('characterStyleOverrides split into runs; the hyperlink override carries linkHref (F5: no text lost)', () => {
    const terms = mustFind(parseWpos().ir, 'figma:I400:7509;29:15170');
    const fullText = terms.textRuns.map((r) => r.text).join('');
    expect(fullText).toBe(
      "By clicking Sign Up you're confirming that you agree with our Terms and Conditions.",
    );
    expect(terms.textRuns.length).toBeGreaterThanOrEqual(2);
    const linked = terms.textRuns.find((r) => r.linkHref !== undefined);
    expect(linked).toBeDefined();
    expect(linked?.linkHref).toBe('https://example.com/terms');
    expect(linked?.text).toContain('Terms and Conditions');
  });

  it('empty TEXT nodes are honestly dropped, never emitted as ghost paragraphs', () => {
    const res = figmaParse({
      document: {
        id: '0:1',
        type: 'FRAME',
        name: 'F',
        absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 100 },
        children: [
          {
            id: '0:2',
            type: 'TEXT',
            name: 'empty',
            characters: '   ',
            absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
      },
    });
    expect(res.figma.dropped.some((d) => d.node_id === '0:2' && d.reason === 'empty text')).toBe(true);
  });
});

/* ─────────────────────────── §5 semantics: heading levels, buttons, forms ───────────────────── */

describe('figmaParse: §5 semantics', () => {
  it('headingTagFor: type scale + layer names (explicit hN token wins)', () => {
    expect(headingTagFor(56, 'Hero headline')).toBe('h1');
    expect(headingTagFor(32, 'Heading')).toBe('h2');
    expect(headingTagFor(24, 'Card title')).toBe('h3');
    expect(headingTagFor(18, 'Section title')).toBe('h4');
    expect(headingTagFor(18, 'Body copy')).toBe('p');
    expect(headingTagFor(16, 'Lorem ipsum')).toBe('p');
    expect(headingTagFor(48, 'H3 / Eyebrow')).toBe('h3'); // explicit token beats the scale
  });

  it('assigns h1/h3/p across the WPOS hero text scale', () => {
    const ir = parseWpos().ir;
    expect(mustFind(ir, 'figma:400:7517').tag).toBe('h1');
    expect(mustFind(ir, 'figma:400:7518').tag).toBe('h3');
    expect(mustFind(ir, 'figma:400:7519').tag).toBe('p');
    expect(mustFind(ir, 'figma:400:7519').role).toBe('text');
  });

  it('button-named all-text instances fold into ONE leaf <a class="btn"> (shape+text composition)', () => {
    const ir = parseWpos().ir;
    const button = mustFind(ir, 'figma:I400:7520;25:14175');
    expect(button.role).toBe('button');
    expect(button.tag).toBe('a');
    expect(button.attrs['class']).toBe('btn');
    expect(button.children).toHaveLength(0);
    expect(button.textRuns.map((r) => r.text).join('')).toBe('Find a Store');
    // Paint merged from the deepest painted wrapper; typography from the text leaf.
    expect(button.computed['padding-left']).toBe('24px');
    expect(button.computed['padding-top']).toBe('12px');
    expect(button.computed['font-size']).toBe('16px');
  });

  it('forms are NOT inferred — converted as boxes and REPORTED', () => {
    const res = parseSynth();
    expect(res.warnings.some((w) => w.code === 'FIGMA_FORM_NOT_INFERRED')).toBe(true);
    // The form subtree still converts natively (pictures of forms stay pictures).
    expect(res.figma.native).toContain('1:40');
    expect(res.figma.native).toContain('1:42');
    expect(allNodes(res.ir).some((n) => n.role === 'form' || n.role === 'form-field')).toBe(false);
  });
});

/* ─────────────────────────── §2 row: image fills → MediaRef (sideload seam) ─────────────────── */

describe('figmaParse: image fills', () => {
  it('a visible IMAGE fill on a childless frame → e-image with the GET_IMAGE_FILLS url', () => {
    const res = parseWpos({
      image_fills: { [WPOS_IMAGE_REF]: 'https://figma-temp.example/fill.png' },
    });
    const lightbox = mustFind(res.ir, 'figma:400:7511');
    expect(lightbox.tag).toBe('img');
    expect(lightbox.role).toBe('image');
    expect(lightbox.media).toEqual({
      kind: 'img',
      url: 'https://figma-temp.example/fill.png',
      alt: 'Placeholder Lightbox',
    });
  });

  it('a missing image-fill URL degrades to a warning, never a throw or a silent drop', () => {
    const res = parseWpos();
    expect(res.warnings.some((w) => w.code === 'FIGMA_IMAGE_FILL_URL_MISSING')).toBe(true);
    const lightbox = mustFind(res.ir, 'figma:400:7511');
    expect(lightbox.media?.url).toBeUndefined();
  });
});

/* ─────────────────────────── §3 flatten policy ──────────────────────────────────────────────── */

describe('figmaParse: §3 flatten policy', () => {
  it('vectors flatten in EVERY mode with the render-node record', () => {
    for (const flatten of ['aggressive', 'balanced', 'minimal'] as const) {
      const res = parseWpos({ flatten });
      const rec = res.figma.flattened.find((f) => f.node_id === '400:7791');
      expect(rec).toBeDefined();
      expect(rec?.reason).toBe('vector');
      expect(rec?.render_node_id).toBe('400:7791');
      expect(rec?.covers).toEqual([]);
      const node = mustFind(res.ir, 'figma:400:7791');
      expect(node.role).toBe('image');
      expect(node.tag).toBe('img');
      expect(node.attrs['data-figma-flatten']).toBe('vector');
    }
  });

  it('flatten roots take their render URL from options.render_urls; absent → loud warning', () => {
    const withUrl = parseWpos({ render_urls: { '400:7791': 'https://figma-temp.example/vector.png' } });
    expect(mustFind(withUrl.ir, 'figma:400:7791').media?.url).toBe(
      'https://figma-temp.example/vector.png',
    );
    const without = parseWpos();
    expect(
      without.warnings.some(
        (w) => w.code === 'FIGMA_RENDER_URL_MISSING' && w.source_path === 'figma:400:7791',
      ),
    ).toBe(true);
  });

  it('balanced flattens blur effects; minimal keeps them native with an honest filter declaration', () => {
    const balanced = parseWpos();
    expect(balanced.figma.flattened.some((f) => f.node_id === '400:7513' && f.reason === 'layer-blur')).toBe(
      true,
    );
    const minimal = parseWpos({ flatten: 'minimal' });
    expect(minimal.figma.flattened.some((f) => f.node_id === '400:7513')).toBe(false);
    expect(minimal.figma.native).toContain('400:7513');
    expect(mustFind(minimal.ir, 'figma:400:7513').computed['filter']).toBe('blur(90.5px)');
  });

  it('device mockups flatten in balanced with their subtree in covers', () => {
    const res = parseSynth();
    const rec = res.figma.flattened.find((f) => f.node_id === '1:50');
    expect(rec?.reason).toBe('device-mockup');
    expect(rec?.covers).toEqual(['1:51', '1:52']);
  });

  it('aggressive flattens at least as much as balanced; balanced at least as much as minimal', () => {
    const count = (mode: 'aggressive' | 'balanced' | 'minimal'): number =>
      parseWpos({ flatten: mode }).figma.flattened.length;
    expect(count('aggressive')).toBeGreaterThanOrEqual(count('balanced'));
    expect(count('balanced')).toBeGreaterThanOrEqual(count('minimal'));
  });
});

describe('figma-flatten: verdict unit rows', () => {
  const box = (
    x: number,
    y: number,
    w: number,
    h: number,
  ): { x: number; y: number; width: number; height: number } => ({ x, y, width: w, height: h });
  const cluster: FigmaRawNode = {
    id: 'c:1',
    type: 'FRAME',
    name: 'Photo stack',
    absoluteBoundingBox: box(0, 0, 400, 300),
    children: [
      { id: 'c:2', type: 'RECTANGLE', absoluteBoundingBox: box(0, 0, 300, 200) },
      { id: 'c:3', type: 'RECTANGLE', absoluteBoundingBox: box(100, 50, 300, 200) },
    ],
  };

  it('overlapRatio: disjoint 0, contained 1', () => {
    expect(overlapRatio({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 })).toBe(0);
    expect(overlapRatio({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: 20, height: 20 })).toBe(1);
  });

  it('a no-text overlapping stack is a layered cluster → flattened in balanced, kept in minimal', () => {
    expect(isLayeredCluster(cluster)).toBe(true);
    expect(flattenVerdict(cluster, 'balanced')).toEqual({ flatten: true, reason: 'layered-cluster' });
    expect(flattenVerdict(cluster, 'minimal')).toEqual({ flatten: false, reason: null });
  });

  it('TEXT is sacred: a cluster containing visible text never cluster-flattens', () => {
    const withText: FigmaRawNode = {
      ...cluster,
      id: 'c:9',
      children: [
        ...(cluster.children ?? []),
        { id: 'c:4', type: 'TEXT', characters: 'Real content', absoluteBoundingBox: box(10, 10, 100, 20) },
      ],
    };
    expect(isLayeredCluster(withText)).toBe(false);
    expect(flattenVerdict(withText, 'balanced').flatten).toBe(false);
  });

  it('W18 pinstripe guard: a no-text NONE-layout fan-out (many children) flattens in balanced', () => {
    // The live W18 "stripes" frames: 255 absolutely-placed 5.65×2132px rectangles in a clipped
    // FRAME. CSS placement does not exist outside auto-layout → native build reflowed them into a
    // 543,000px vertical stack (scrollHeight 1,099,489px; the verify-loop screenshot could not
    // even capture it). Balanced MUST render these as one image.
    const stripes: FigmaRawNode = {
      id: 'p:0',
      type: 'FRAME',
      name: 'stripes',
      absoluteBoundingBox: box(0, 0, 1440, 23),
      children: Array.from({ length: 255 }, (_, i) => ({
        id: `p:${String(i + 1)}`,
        type: 'RECTANGLE' as const,
        absoluteBoundingBox: box(i * 5.65, 0, 5.65, 2132),
      })),
    };
    expect(isAbsoluteFanOut(stripes)).toBe(true);
    expect(flattenVerdict(stripes, 'balanced')).toEqual({ flatten: true, reason: 'absolute-fan-out' });
    expect(flattenVerdict(stripes, 'minimal')).toEqual({ flatten: false, reason: null });

    // A clipping fan-out renders CLIPPED (absolute bounds would bake the 2132px overhang into
    // the 23px band) — the flatten record carries clip_render for the orchestrator.
    const frame: FigmaRawNode = {
      id: 'f:0',
      type: 'FRAME',
      name: 'Page',
      absoluteBoundingBox: box(0, 0, 1440, 800),
      children: [{ ...stripes, clipsContent: true }],
    };
    const res = figmaParse({ nodes: { 'f:0': { document: frame } } }, { node_id: 'f:0' });
    const rec = res.figma.flattened.find((f) => f.node_id === 'p:0');
    expect(rec?.reason).toBe('absolute-fan-out');
    expect(rec?.clip_render).toBe(true);

    // The flattened band is hand-placed like any NONE-layout child — IN-FLOW placement pushed
    // every sibling down by the band height on page 3414 (photo cards displaced 1165px).
    const bandIr = mustFind(res.ir, 'figma:p:0');
    expect(bandIr.computed['position']).toBe('absolute');
    expect(bandIr.computed['top']).toBe('0px');
    expect(bandIr.computed['left']).toBe('0px');
  });

  it('a child escaping the parent clip box is a fan-out even with few children', () => {
    const overhang: FigmaRawNode = {
      id: 'o:0',
      type: 'FRAME',
      name: 'band',
      absoluteBoundingBox: box(0, 0, 1440, 40),
      children: [
        { id: 'o:1', type: 'RECTANGLE', absoluteBoundingBox: box(0, 0, 6, 2132) },
        { id: 'o:2', type: 'RECTANGLE', absoluteBoundingBox: box(20, 0, 6, 2132) },
      ],
    };
    expect(isAbsoluteFanOut(overhang)).toBe(true);
    expect(flattenVerdict(overhang, 'balanced').reason).toBe('absolute-fan-out');
  });

  it('a fan-out containing visible TEXT stays native (text is sacred)', () => {
    const withText: FigmaRawNode = {
      id: 't:0',
      type: 'FRAME',
      name: 'stripes',
      absoluteBoundingBox: box(0, 0, 1440, 23),
      children: [
        ...Array.from({ length: 9 }, (_, i) => ({
          id: `t:${String(i + 1)}`,
          type: 'RECTANGLE' as const,
          absoluteBoundingBox: box(i * 10, 0, 6, 20),
        })),
        { id: 't:99', type: 'TEXT', characters: 'Real content', absoluteBoundingBox: box(0, 0, 100, 20) },
      ],
    };
    expect(isAbsoluteFanOut(withText)).toBe(false);
    expect(flattenVerdict(withText, 'balanced').flatten).toBe(false);
  });

  it('aggressive flattens no-text absolute-layout containers even without overlap', () => {
    const sparse: FigmaRawNode = {
      id: 's:1',
      type: 'FRAME',
      name: 'Decor',
      absoluteBoundingBox: box(0, 0, 1000, 400),
      children: [
        { id: 's:2', type: 'RECTANGLE', absoluteBoundingBox: box(0, 0, 100, 100) },
        { id: 's:3', type: 'RECTANGLE', absoluteBoundingBox: box(500, 200, 100, 100) },
      ],
    };
    expect(flattenVerdict(sparse, 'balanced').flatten).toBe(false);
    expect(flattenVerdict(sparse, 'aggressive')).toEqual({
      flatten: true,
      reason: 'uncertain-absolute-subtree',
    });
  });
});

/* ─────────────────────────── §2 row: prototype interactions ─────────────────────────────────── */

describe('figmaParse: prototype interactions', () => {
  it('ON_CLICK URL → tier-1 link on the folded button', () => {
    const button = mustFind(parseSynth().ir, 'figma:1:20');
    expect(button.role).toBe('button');
    expect(button.attrs['href']).toBe('https://example.com/signup');
    expect(button.textRuns.map((r) => r.text).join('')).toBe('Get started');
  });

  it('ON_CLICK NAVIGATE → in-page link (honest #figma-<dest> anchor)', () => {
    const nav = mustFind(parseSynth().ir, 'figma:1:80');
    expect(nav.tag).toBe('a');
    expect(nav.attrs['href']).toBe('#figma-1-10');
  });

  it('ON_HOVER variant swap with the target IN the payload → hoverComputed + transition probe + behavior', () => {
    const tile = mustFind(parseSynth().ir, 'figma:1:30');
    expect(tile.hoverComputed).toEqual({ 'background-color': 'rgb(31, 41, 55)' });
    expect(tile.transitionProbe).toEqual({
      property: 'background-color',
      duration: '0.2s',
      easing: 'ease',
    });
    expect(tile.behaviors?.some((b) => b.kind === 'hover-effect')).toBe(true);
  });

  it('ON_HOVER with the variant target OUTSIDE the extraction → honest drop + warning', () => {
    const res = parseWpos();
    expect(
      res.figma.interaction_drops.some((d) => d.node_id === '400:7520' && d.trigger === 'ON_HOVER'),
    ).toBe(true);
    expect(res.warnings.some((w) => w.code === 'FIGMA_HOVER_TARGET_MISSING')).toBe(true);
    expect(mustFind(res.ir, 'figma:400:7520').hoverComputed).toBeUndefined();
  });

  it('AFTER_TIMEOUT DISSOLVE → entrance-animation approximation (tier-2 fade downstream)', () => {
    const banner = mustFind(parseSynth().ir, 'figma:1:70');
    expect(banner.animationProbe).toEqual({
      name: 'figma-appear',
      duration: '0.4s',
      delay: '0.5s',
      easing: 'ease',
      keyframeProps: ['opacity'],
      opacity: { from: 0, to: 1 },
    });
    expect(banner.behaviors?.some((b) => b.kind === 'entrance-animation')).toBe(true);
  });

  it('unmappable triggers (drag) are honest-dropped — never silent', () => {
    const res = parseSynth();
    const drop = res.figma.interaction_drops.find((d) => d.node_id === '1:60');
    expect(drop).toBeDefined();
    expect(drop?.trigger).toBe('ON_DRAG');
    expect(res.warnings.some((w) => w.code === 'FIGMA_INTERACTION_DROPPED' && w.source_path === 'figma:1:60')).toBe(
      true,
    );
    // The element itself stays native (only the interaction is dropped).
    expect(res.figma.native).toContain('1:60');
  });
});

/* ─────────────────────────── §5 responsive ──────────────────────────────────────────────────── */

describe('figmaParse: §5 responsive', () => {
  it('sibling <Name>/Desktop|Mobile frames → node-correspondence per-breakpoint overrides', () => {
    const res = parseSynth();
    expect(res.figma.responsive).toBe('frames');
    expect(res.figma.responsive_frames).toEqual({ mobile: '2:1' });
    const cards = mustFind(res.ir, 'figma:1:10');
    expect(cards.responsive['mobile']).toMatchObject({
      'flex-direction': 'column',
      gap: '16px',
      'padding-top': '16px',
      'padding-left': '16px',
    });
    const heading = mustFind(res.ir, 'figma:1:12');
    expect(heading.responsive['mobile']).toMatchObject({
      'font-size': '22px',
      'line-height': '28px',
    });
  });

  it('variant frame nodes are accounted (native when matched) — F1 holds across frames', () => {
    const res = parseSynth();
    expect(res.figma.native).toContain('2:10');
    expect(res.figma.native).toContain('2:12');
    const audit = auditFigmaAccounting(collectFigmaNodeIds(SYNTH), res.figma);
    expect(audit.missing).toEqual([]);
    expect(audit.duplicated).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('unrelated top-level frames become reference frames: dropped with reason + warning', () => {
    const res = parseSynth();
    expect(res.figma.dropped.some((d) => d.node_id === '9:1' && d.reason.includes('reference frame'))).toBe(true);
    expect(res.figma.dropped.some((d) => d.node_id === '9:2')).toBe(true);
    expect(res.warnings.some((w) => w.code === 'FIGMA_REFERENCE_FRAME')).toBe(true);
  });

  it('ABSENT variant frames → heuristic adaptation REPORTED as synthesized', () => {
    const res = parseWpos();
    expect(res.figma.responsive).toBe('synthesized');
    expect(res.figma.responsive_frames).toBeUndefined();
    // Display-scale heading steps down on mobile.
    const h1 = mustFind(res.ir, 'figma:400:7517');
    expect(h1.responsive['mobile']).toMatchObject({ 'font-size': '39px' });
  });

  it('synthesize_responsive:false suppresses the heuristic (still reported as synthesized)', () => {
    const res = parseWpos({ synthesize_responsive: false });
    const h1 = mustFind(res.ir, 'figma:400:7517');
    expect(h1.responsive['mobile']).toBeUndefined();
  });
});

/* ─────────────────────────── fonts: per-family availability ─────────────────────────────────── */

describe('figmaParse: font availability {google|local|missing}', () => {
  it('catalog families resolve to google; unknown design faces are missing (with a warning)', () => {
    const synth = parseSynth();
    expect(synth.figma.fonts['Inter']).toBe('google');
    const wpos = parseWpos();
    expect(wpos.figma.fonts['FONTSPRING DEMO - Novaletra Serif CF Heavy']).toBe('missing');
    expect(wpos.figma.fonts['FONTSPRING DEMO - Armin Soft SemiBold']).toBe('missing');
    expect(wpos.warnings.some((w) => w.code === 'FIGMA_FONT_UNAVAILABLE')).toBe(true);
  });

  it('opts.local_families promotes site-installed faces to local', () => {
    const res = parseWpos({ local_families: ['FONTSPRING DEMO - Novaletra Serif CF Heavy'] });
    expect(res.figma.fonts['FONTSPRING DEMO - Novaletra Serif CF Heavy']).toBe('local');
    expect(res.figma.fonts['FONTSPRING DEMO - Armin Soft SemiBold']).toBe('missing');
  });

  it('catalog-drift guard: known-good families from the pinned plugin source resolve as catalog', () => {
    // Membership-only guard (a routine upstream catalog ADDITION is not a drift failure).
    for (const family of ['Inter', 'Roboto', 'JetBrains Mono', 'Bricolage Grotesque', 'ABeeZee']) {
      expect(isCatalogFamily(family)).toBe(true);
    }
    expect(isCatalogFamily('FONTSPRING DEMO - Armin Soft SemiBold')).toBe(false);

    // When the pinned upstream source is present, spot-check real rows against the mirror.
    const fontsPhp = fileURLToPath(
      new URL('../../../../plugins/elementor/includes/fonts.php', import.meta.url),
    );
    if (existsSync(fontsPhp)) {
      const src = readFileSync(fontsPhp, 'utf8');
      const rows = [...src.matchAll(/'([^']+)'\s*=>\s*self::(?:GOOGLE|EARLYACCESS|SYSTEM)\b/g)]
        .map((m) => m[1] as string)
        .filter((f) => !f.includes('\\'));
      expect(rows.length).toBeGreaterThan(1000);
      for (const family of rows.filter((_, i) => i % 100 === 0)) {
        expect(isCatalogFamily(family), `catalog drift: ${family}`).toBe(true);
      }
    }
  });
});

/* ─────────────────────────── F1: total node accounting ──────────────────────────────────────── */

describe('figmaParse: F1 invariant (native | flattened | dropped+reason, exactly one)', () => {
  it('every WPOS node is accounted exactly once, in every flatten mode', () => {
    const sourceIds = collectFigmaNodeIds(WPOS);
    expect(sourceIds).toHaveLength(18);
    for (const flatten of ['aggressive', 'balanced', 'minimal'] as const) {
      const res = parseWpos({ flatten });
      const audit = auditFigmaAccounting(sourceIds, res.figma);
      expect(audit.missing).toEqual([]);
      expect(audit.duplicated).toEqual([]);
      expect(audit.ok).toBe(true);
      expect(res.warnings.some((w) => w.code === 'FIGMA_F1_VIOLATION')).toBe(false);
    }
  });

  it('invisible nodes are dropped WITH a reason (the WPOS hidden rectangle)', () => {
    const res = parseWpos();
    const drop = res.figma.dropped.find((d) => d.node_id === '400:7522');
    expect(drop).toBeDefined();
    expect(drop?.reason).toContain('invisible');
  });

  it('folded-button descendants land in native (merged, not lost)', () => {
    const res = parseWpos();
    expect(res.figma.native).toContain('I400:7520;25:14175');
    expect(res.figma.native).toContain('I400:7520;25:14175;23:10532');
    expect(res.figma.native).toContain('I400:7520;25:14175;23:10532;4179:8893');
  });

  it('the audit catches silent loss and double accounting (a converter bug surfaces loudly)', () => {
    const res = parseWpos();
    const broken = {
      ...res.figma,
      native: [...res.figma.native.slice(1), res.figma.native[0] as string, res.figma.native[0] as string],
    };
    const sourceIds = collectFigmaNodeIds(WPOS);
    const audit = auditFigmaAccounting(sourceIds, broken);
    expect(audit.ok).toBe(false);
    expect(audit.duplicated).toContain(res.figma.native[0] as string);
  });
});

/* ─────────────────────────── downstream survival (normalize → classify, UNCHANGED) ──────────── */

describe('figmaParse: designer intent survives the unchanged normalize → classify stages', () => {
  function normalizeThenClassify(res: FigmaParseResult): IrNode[] {
    const normalized = normalizeIr(res.ir, { raw_inner_markup: {}, unwrap_redundant: false });
    return classifyIr(normalized.ir, { infer_flex: true }).ir;
  }

  it('flex/button/heading roles re-derive identically from the emitted explicit signals', () => {
    const classified = normalizeThenClassify(parseWpos());
    expect(mustFind(classified, 'figma:400:7520').role).toBe('flex-row');
    expect(mustFind(classified, 'figma:I400:7520;25:14175').role).toBe('button');
    expect(mustFind(classified, 'figma:400:7517').role).toBe('heading');
    expect(mustFind(classified, 'figma:400:7519').role).toBe('text');
  });

  it('hover/entrance behaviors RE-DETECT from the emitted probe carriers (classify wipes annotations)', () => {
    const classified = normalizeThenClassify(parseSynth());
    const tile = mustFind(classified, 'figma:1:30');
    expect(tile.behaviors?.some((b) => b.kind === 'hover-effect')).toBe(true);
    const banner = mustFind(classified, 'figma:1:70');
    expect(banner.behaviors?.some((b) => b.kind === 'entrance-animation')).toBe(true);
  });

  it('content presence (F5 seed): every source text string survives into the classified IR', () => {
    const res = parseSynth();
    const classified = normalizeThenClassify(res);
    const allText = allNodes(classified)
      .flatMap((n) => n.textRuns.map((r) => r.text))
      .join(' ');
    for (const expected of ['Fast setup', 'Open pricing', 'Get started', 'Hover me', 'Limited offer']) {
      expect(allText).toContain(expected);
    }
  });
});
