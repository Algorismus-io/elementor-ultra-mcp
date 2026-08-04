/**
 * WP-H03 — PARSE stage tests.
 *
 * Two layers:
 *   (1) PURE helpers — always run (no Chromium): `INHERITED_PROPS`, `diffInheritedAgainstParent`,
 *       `computedDelta`, `detectStateRules`, `detectMediaRules`, `hasExternalStyleRefs`,
 *       `resolveCapturePlan`.
 *   (2) LIVE render-then-extract — requires a real Chromium; skips cleanly with a message when it is
 *       unavailable (mirrors the fixtures-harness capability-skip pattern). Asserts the acceptance
 *       criteria against small fixture HTML: whitelist-only `computed`, parent-diff drops inherited
 *       color, `:hover` delta via CDP, `@media` per-breakpoint deltas at PASSED widths (never
 *       hardcoded), media refs, `raw_inner_markup`, RTL `doc_direction`, and fidelity tiers.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { closeBrowser } from './browser-pool.js';
import { STYLE_WHITELIST } from './mapping-table.js';
import {
  INHERITED_PROPS,
  censusScripts,
  computedDelta,
  detectMediaRules,
  detectStateRules,
  diffInheritedAgainstParent,
  hasExternalStyleRefs,
  isTextBearingShape,
  parseHtml,
  resolveCapturePlan,
  type PseudoIrNode,
  type SourceIdIrNode,
} from './parse.js';
import type { BreakpointSpec, IrNode, ParseInput } from './types.js';

/* ───────────────────────────── pure helpers (always run) ────────────────────────────────────── */

describe('parse: pure helpers', () => {
  it('INHERITED_PROPS contains canonical inheritable typography props', () => {
    for (const p of [
      'color',
      'font-family',
      'font-size',
      'line-height',
      'text-align',
      'direction',
    ]) {
      expect(INHERITED_PROPS.has(p)).toBe(true);
    }
    // non-inheritable must NOT be present
    expect(INHERITED_PROPS.has('width')).toBe(false);
    expect(INHERITED_PROPS.has('background-color')).toBe(false);
  });

  it('diffInheritedAgainstParent drops inherited props equal to parent, keeps the rest', () => {
    const parent = { color: 'rgb(0, 0, 0)', 'font-size': '16px', width: '500px' };
    const child = {
      color: 'rgb(0, 0, 0)', // inherited equal -> dropped
      'font-size': '24px', // inherited but DIFFERENT -> kept
      width: '500px', // non-inheritable -> kept even though equal
      'background-color': 'rgb(255, 0, 0)', // non-inheritable, own -> kept
    };
    const out = diffInheritedAgainstParent(child, parent);
    expect(out).not.toHaveProperty('color');
    expect(out['font-size']).toBe('24px');
    expect(out['width']).toBe('500px');
    expect(out['background-color']).toBe('rgb(255, 0, 0)');
  });

  it('diffInheritedAgainstParent keeps everything for a root (no parent)', () => {
    const own = { color: 'rgb(1, 2, 3)', width: '10px' };
    expect(diffInheritedAgainstParent(own, null)).toEqual(own);
    expect(diffInheritedAgainstParent(own, undefined)).toEqual(own);
  });

  it('computedDelta returns only changed props', () => {
    const base = { color: 'a', width: '1px', height: '2px' };
    const state = { color: 'b', width: '1px', height: '3px' };
    expect(computedDelta(base, state)).toEqual({ color: 'b', height: '3px' });
  });

  it('detectStateRules finds :hover/:focus/:active and ignores plain rules', () => {
    expect(detectStateRules('.btn:hover { color: red }')).toBe(true);
    expect(detectStateRules('a:focus-visible { outline: 1px }')).toBe(true);
    expect(detectStateRules('.x { color: red }')).toBe(false);
    expect(detectStateRules('')).toBe(false);
  });

  it('detectMediaRules finds @media', () => {
    expect(detectMediaRules('@media (max-width: 600px) { .x { color: red } }')).toBe(true);
    expect(detectMediaRules('.x { color: red }')).toBe(false);
  });

  it('hasExternalStyleRefs detects <link rel=stylesheet> and @import', () => {
    expect(hasExternalStyleRefs('<link rel="stylesheet" href="x.css">')).toBe(true);
    expect(hasExternalStyleRefs('<div></div>', '@import "y.css";')).toBe(true);
    expect(hasExternalStyleRefs('<div></div>')).toBe(false);
  });

  it('censusScripts records EVERY script tag — src/inline_bytes/external (contract 16 §2)', () => {
    const html =
      '<div>x</div>' +
      '<script src="https://cdn.example.com/lib.js"></script>' +
      "<script>console.log('hi');</script>" +
      '<script type="module" src=\'/local/app.js\'></script>' +
      '<script></script>';
    const scripts = censusScripts(html);
    expect(scripts).toHaveLength(4);
    expect(scripts[0]).toEqual({
      src: 'https://cdn.example.com/lib.js',
      inline_bytes: 0,
      external: true,
    });
    expect(scripts[1]).toEqual({
      src: null,
      inline_bytes: "console.log('hi');".length,
      external: false,
    });
    expect(scripts[2]).toEqual({ src: '/local/app.js', inline_bytes: 0, external: true });
    expect(scripts[3]).toEqual({ src: null, inline_bytes: 0, external: false });
  });

  it('censusScripts: inline_bytes is BYTE length (multibyte content) and no scripts → []', () => {
    expect(censusScripts('<p>no scripts</p>')).toEqual([]);
    const [s] = censusScripts('<script>const x = "héllo";</script>');
    // 'é' is 2 bytes in UTF-8 → byte length exceeds the code-unit length
    expect(s?.inline_bytes).toBe(new TextEncoder().encode('const x = "héllo";').length);
  });

  it('censusScripts: unquoted src attributes are captured', () => {
    const [s] = censusScripts('<script src=foo.js defer></script>');
    expect(s).toEqual({ src: 'foo.js', inline_bytes: 0, external: true });
  });

  it('isTextBearingShape: known text tags bear text even with element children', () => {
    for (const tag of ['h1', 'p', 'a', 'button', 'li', 'small', 'td', 'summary']) {
      expect(
        isTextBearingShape({
          tag,
          hasNonWhitespaceText: true,
          elementChildCount: 2,
          hasBareTextChild: false,
        }),
      ).toBe(true);
    }
    // no text at all -> never text-bearing, even for known tags
    expect(
      isTextBearingShape({
        tag: 'p',
        hasNonWhitespaceText: false,
        elementChildCount: 0,
        hasBareTextChild: false,
      }),
    ).toBe(false);
  });

  it('isTextBearingShape: childless generic container with text is a leaf text node', () => {
    expect(
      isTextBearingShape({
        tag: 'div',
        hasNonWhitespaceText: true,
        elementChildCount: 0,
        hasBareTextChild: true,
      }),
    ).toBe(true);
  });

  it('isTextBearingShape: MIXED children — bare text beside element children bears text (contract 18 §7 P1-a)', () => {
    // `<div>$0<small>/forever</small></div>` — the bare '$0' must not be dropped.
    expect(
      isTextBearingShape({
        tag: 'div',
        hasNonWhitespaceText: true,
        elementChildCount: 1,
        hasBareTextChild: true,
      }),
    ).toBe(true);
    // element children only (all text lives in child elements) -> container, no runs
    expect(
      isTextBearingShape({
        tag: 'div',
        hasNonWhitespaceText: true,
        elementChildCount: 2,
        hasBareTextChild: false,
      }),
    ).toBe(false);
    // whitespace-only bare text (formatting between blocks) does not make a container text-bearing
    expect(
      isTextBearingShape({
        tag: 'section',
        hasNonWhitespaceText: true,
        elementChildCount: 3,
        hasBareTextChild: false,
      }),
    ).toBe(false);
  });

  it('resolveCapturePlan: fast = single, no states; high = all; balanced = states iff rules', () => {
    const base = (overrides: Partial<ParseInput>): ParseInput => ({
      html: '<div></div>',
      breakpoints: [],
      fidelity: 'balanced',
      ...overrides,
    });
    expect(resolveCapturePlan(base({ fidelity: 'fast' }))).toEqual({
      captureStates: false,
      captureBreakpoints: false,
    });
    expect(resolveCapturePlan(base({ fidelity: 'high' })).captureStates).toBe(true);
    expect(
      resolveCapturePlan(base({ fidelity: 'balanced', css: '.b:hover{color:red}' })).captureStates,
    ).toBe(true);
    expect(
      resolveCapturePlan(base({ fidelity: 'balanced', css: '.b{color:red}' })).captureStates,
    ).toBe(false);
    // explicit capture_states overrides the heuristic
    expect(
      resolveCapturePlan(base({ fidelity: 'balanced', capture_states: true, css: '' }))
        .captureStates,
    ).toBe(true);
  });
});

/* ───────────────────────────── live render-then-extract (requires Chromium) ──────────────────── */

let chromiumAvailable: boolean | null = null;

async function probeChromium(): Promise<boolean> {
  if (chromiumAvailable !== null) return chromiumAvailable;
  try {
    const { getBrowser } = await import('./browser-pool.js');
    const browser = await getBrowser();
    chromiumAvailable = browser.isConnected();
  } catch (err) {
    console.warn(
      `[parse.test] SKIP live cases: Chromium unavailable (${(err as Error).message}). ` +
        'Run `pnpm --filter @elementor-ultra/server exec playwright install chromium`.',
    );
    chromiumAvailable = false;
  }
  return chromiumAvailable;
}

afterAll(async () => {
  await closeBrowser();
});

/** Depth-first find of the first node whose tag matches in an IR forest. */
function findByTag(roots: IrNode[], tag: string): IrNode | undefined {
  for (const n of roots) {
    if (n.tag === tag) return n;
    const inChild = findByTag(n.children, tag);
    if (inChild) return inChild;
  }
  return undefined;
}

/** Depth-first find by source_path substring (e.g. a class-bearing element). */
function findBySourcePath(roots: IrNode[], needle: string): IrNode | undefined {
  for (const n of roots) {
    if (n.source_path.includes(needle)) return n;
    const inChild = findBySourcePath(n.children, needle);
    if (inChild) return inChild;
  }
  return undefined;
}

const BPS: BreakpointSpec[] = [
  { key: 'mobile', width: 400, direction: 'max' },
  { key: 'desktop', width: 1200, direction: 'min' },
];

describe('parse: live render-then-extract', () => {
  it('computed contains ONLY whitelist keys', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div class="root"><h1>Hi</h1><p>Body</p></div>',
      css: '.root{padding:20px;background:#fff}h1{color:rgb(255,0,0)}',
      breakpoints: BPS,
      fidelity: 'balanced',
    });
    const whitelist = new Set(STYLE_WHITELIST);
    const checkNode = (n: IrNode): void => {
      for (const key of Object.keys(n.computed)) {
        expect(whitelist.has(key), `non-whitelist computed key: ${key}`).toBe(true);
      }
      n.children.forEach(checkNode);
    };
    res.ir.forEach(checkNode);
    expect(res.ir.length).toBeGreaterThan(0);
  }, 90_000);

  it('parent-diff: a child with no own color rule omits color (inherited from colored parent)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div class="wrap"><span class="inner">child text</span></div>',
      css: '.wrap{color:rgb(0,128,255)}',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'balanced',
    });
    const span = findByTag(res.ir, 'span');
    expect(span).toBeDefined();
    // span inherits the parent's color -> dropped from its computed
    expect(span?.computed).not.toHaveProperty('color');
    // the wrap itself authored the color -> present (body is the parent of wrap, default black)
    const wrap = findByTag(res.ir, 'div');
    expect(wrap?.computed['color']).toBe('rgb(0, 128, 255)');
  }, 90_000);

  it('forced :hover via CDP yields hoverComputed with ONLY the changed prop', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<button class="cta">Click</button>',
      css:
        '.cta{background-color:rgb(0,0,255);color:rgb(255,255,255)}' +
        '.cta:hover{background-color:rgb(255,0,0)}',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'high',
      capture_states: true,
    });
    const btn = findByTag(res.ir, 'button');
    expect(btn).toBeDefined();
    expect(btn?.hoverComputed).toBeDefined();
    expect(btn?.hoverComputed?.['background-color']).toBe('rgb(255, 0, 0)');
    // color did NOT change on hover -> must not appear in the hover delta
    expect(btn?.hoverComputed).not.toHaveProperty('color');
  }, 120_000);

  it('per-breakpoint capture records deltas at the PASSED widths (not hardcoded)', async () => {
    if (!(await probeChromium())) return;
    const customBps: BreakpointSpec[] = [
      { key: 'mobile', width: 375, direction: 'max' },
      { key: 'desktop', width: 1440, direction: 'min' },
    ];
    const res = await parseHtml({
      html: '<div class="box">x</div>',
      css: '.box{font-size:30px}@media (max-width:500px){.box{font-size:14px}}',
      breakpoints: customBps,
      fidelity: 'high',
    });
    // base capture is at the widest (1440) where font-size is 30px; mobile (375) -> 14px delta
    expect(res.viewport_used).toBe(1440);
    const box = findBySourcePath(res.ir, 'div');
    expect(box).toBeDefined();
    expect(box?.responsive['mobile']?.['font-size']).toBe('14px');
    // desktop equals the base width -> no separate delta entry
    expect(box?.responsive['desktop']).toBeUndefined();
  }, 120_000);

  it('media refs: <img>, background-image, youtube iframe, <video>, <svg>', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html:
        '<img src="https://example.com/a.png" alt="alt text" srcset="a.png 1x">' +
        '<div class="bg">bg</div>' +
        '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>' +
        '<video src="https://example.com/v.mp4"></video>' +
        '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      css: '.bg{background-image:url("https://example.com/bg.jpg")}',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const img = findByTag(res.ir, 'img');
    expect(img?.media).toMatchObject({
      kind: 'img',
      url: 'https://example.com/a.png',
      alt: 'alt text',
    });
    expect(img?.media?.srcset).toContain('a.png');

    const bg = findBySourcePath(res.ir, 'div');
    expect(bg?.media).toMatchObject({ kind: 'background' });
    expect(bg?.media?.url).toContain('bg.jpg');

    const iframe = findByTag(res.ir, 'iframe');
    expect(iframe?.media).toMatchObject({ kind: 'youtube', embedId: 'dQw4w9WgXcQ' });

    const video = findByTag(res.ir, 'video');
    expect(video?.media).toMatchObject({ kind: 'video', url: 'https://example.com/v.mp4' });

    const svg = findByTag(res.ir, 'svg');
    expect(svg?.media?.kind).toBe('svg');
    expect(svg?.media?.url).toContain('<rect');
  }, 90_000);

  it('raw_inner_markup captures verbatim inner HTML of text-bearing nodes', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<h2 class="t">Hello <strong>bold</strong> world</h2>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const h2 = findByTag(res.ir, 'h2');
    expect(h2).toBeDefined();
    const raw = res.raw_inner_markup[h2!.source_path];
    expect(raw).toBeDefined();
    expect(raw).toContain('<strong>bold</strong>');
    // text runs split by inline markup
    expect(
      h2?.textRuns.some((r) => r.text.includes('bold') && r.inlineTags.includes('strong')),
    ).toBe(true);
  }, 90_000);

  it('preserves inter-run whitespace: sibling spans and <br> never glue into one word', async () => {
    if (!(await probeChromium())) return;
    // Field bug (live-site convert, 2026-07-02): the whitespace-only text node between
    // `<span>…</span> <span>…</span>` and a `<br>` separator were dropped, so the runs joined as
    // "Intelligence.Powered" / "yourengineering". A single space must survive the join.
    const res = await parseHtml({
      html:
        '<h2 class="a"><span>Engineering Intelligence.</span> <span>Powered by AI.</span></h2>' +
        '<p class="b">Ready to transform your<br>engineering operations?</p>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const h2 = findByTag(res.ir, 'h2');
    const joinedH2 = (h2?.textRuns ?? []).map((r) => r.text).join('');
    expect(joinedH2).toContain('Intelligence. Powered'); // space survived the span boundary
    expect(joinedH2).not.toContain('Intelligence.Powered');
    const p = findByTag(res.ir, 'p');
    const joinedP = (p?.textRuns ?? []).map((r) => r.text).join('');
    expect(joinedP).toContain('your engineering'); // <br> contributes a separator
    expect(joinedP).not.toContain('yourengineering');
  }, 90_000);

  it('captures the wrapping <a href>/target on inline-link text runs (linkHref/linkTarget)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<p>Read the <a href="/changelog" target="_blank">full <strong>changelog</strong></a> now</p>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const p = findByTag(res.ir, 'p');
    expect(p).toBeDefined();
    type LinkedRun = (typeof p extends undefined ? never : IrNode)['textRuns'][number] & {
      linkHref?: string;
      linkTarget?: string;
    };
    const runs = (p?.textRuns ?? []) as LinkedRun[];
    // The anchor-wrapped runs carry the destination (inlineTags holds names only — the href would
    // otherwise be lost and every in-text link serialized back as a dead bare <a>).
    const linked = runs.find((r) => r.text.includes('full'));
    expect(linked?.inlineTags).toContain('a');
    expect(linked?.linkHref).toBe('/changelog');
    expect(linked?.linkTarget).toBe('_blank');
    // The nested <strong> run inside the anchor inherits the same link.
    const nested = runs.find((r) => r.text.includes('changelog'));
    expect(nested?.inlineTags).toEqual(['a', 'strong']);
    expect(nested?.linkHref).toBe('/changelog');
    // Runs OUTSIDE the anchor carry no link.
    const plain = runs.find((r) => r.text.includes('Read the'));
    expect(plain?.linkHref).toBeUndefined();
  }, 90_000);

  it('captures the run color when an inline wrapper RECOLORS it (contract 17 #8 accent)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html:
        '<style>h1{color:rgb(18,32,25)} h1 em{color:rgb(12,107,74)}</style>' +
        '<h1>The counter that <em>runs the back office</em> for <span>you</span>.</h1>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const h = findByTag(res.ir, 'h1');
    const runs = (h?.textRuns ?? []) as Array<IrNode['textRuns'][number] & { color?: string }>;
    // The recolored <em> run carries its computed color — MAP's html-v3 fold can only emit the
    // accent style it was GIVEN (page-2439 regression: an ink-colored hero <em>).
    const accent = runs.find((r) => r.text.includes('runs the back office'));
    expect(accent?.color).toBe('rgb(12, 107, 74)');
    // A wrapper that does NOT recolor stays color-free (I4 — no noise).
    const same = runs.find((r) => r.text.includes('you'));
    expect(same?.color).toBeUndefined();
    const plain = runs.find((r) => r.text.includes('The counter'));
    expect(plain?.color).toBeUndefined();
  }, 90_000);

  /* ───────────── contract 18 §7 — P1-a mixed children / P2-d source ids / per-run color ──────── */

  it('mixed children: a bare text node beside an element child is captured, not dropped (P1-a)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div class="price">$0<small>/forever</small></div>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const div = findByTag(res.ir, 'div');
    expect(div).toBeDefined();
    // The bare '$0' lands in the container's runs (it belongs to no child element).
    expect(div?.textRuns.some((r) => r.text.includes('$0'))).toBe(true);
    // `small` is NOT in INLINE_ALLOW — its text is NOT duplicated into the container's runs…
    expect(div?.textRuns.some((r) => r.text.includes('/forever'))).toBe(false);
    // …because it stays a REAL IR child node (NORMALIZE promotes it to a sibling of the text host).
    const small = findByTag(res.ir, 'small');
    expect(small?.textRuns.some((r) => r.text.includes('/forever'))).toBe(true);
    // raw_inner_markup is captured for the now-text-bearing host so NORMALIZE's stripped-tag
    // accounting sees the `<small>` (P1-a: any stripped text MUST land in stripped_text).
    expect(res.raw_inner_markup[div!.source_path]).toContain('<small>');
  }, 90_000);

  it('mixed children: INLINE_ALLOW element children fold into the runs (no loss when NORMALIZE drops them)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div class="note">Save <span>40%</span> today<p>terms apply</p></div>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const div = findByTag(res.ir, 'div');
    // Bare text + the inline <span> text are ALL in the runs (NORMALIZE folds the duplicate span
    // child node away — the runs are the only carrier of '40%').
    expect(div?.textRuns.map((r) => r.text).join('')).toContain('Save ');
    expect(div?.textRuns.some((r) => r.text === '40%' && r.inlineTags.includes('span'))).toBe(true);
    expect(div?.textRuns.some((r) => r.text.includes('today'))).toBe(true);
    // The block <p> child is NOT folded into the runs — it stays a real IR child node.
    expect(div?.textRuns.some((r) => r.text.includes('terms apply'))).toBe(false);
    const p = findByTag(res.ir, 'p');
    expect(p?.textRuns.some((r) => r.text.includes('terms apply'))).toBe(true);
  }, 90_000);

  it('mixed children: whitespace-only bare text between blocks does NOT make a container text-bearing', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div class="wrap">\n  <p>one</p>\n  <p>two</p>\n</div>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const div = findByTag(res.ir, 'div');
    expect(div?.textRuns).toEqual([]);
    expect(res.raw_inner_markup[div!.source_path]).toBeUndefined();
  }, 90_000);

  it('mixed children: per-run computed color is captured on recolored inline runs (cluster-D residual)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html:
        '<style>.price{color:rgb(18,32,25)} .unit{color:rgb(120,120,120)}</style>' +
        '<div class="price">$0<span class="unit">/mo</span></div>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const div = findByTag(res.ir, 'div');
    const runs = (div?.textRuns ?? []) as Array<IrNode['textRuns'][number] & { color?: string }>;
    // The recolored <span> run carries its own computed color — the accent carry (contract 17 #8)
    // now works on mixed-children hosts too, end-to-end into MAP's nested custom_css emission.
    const unit = runs.find((r) => r.text === '/mo');
    expect(unit?.inlineTags).toContain('span');
    expect(unit?.color).toBe('rgb(120, 120, 120)');
    // The bare-text run matches the host color -> color-free (I4 — no noise).
    const bare = runs.find((r) => r.text.includes('$0'));
    expect(bare).toBeDefined();
    expect(bare?.color).toBeUndefined();
  }, 90_000);

  it('source element id attributes land on IR nodes as sourceId (contract 18 §7 P2-d)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html:
        '<section id="pricing"><h2 id="pricing-title">Plans</h2><p>copy</p></section>' +
        '<div class="plain">no id</div>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const section = findByTag(res.ir, 'section') as SourceIdIrNode | undefined;
    expect(section?.sourceId).toBe('pricing');
    const h2 = findByTag(res.ir, 'h2') as SourceIdIrNode | undefined;
    expect(h2?.sourceId).toBe('pricing-title');
    // the raw attribute still rides attrs verbatim (the additive field is the downstream seam)
    expect(section?.attrs['id']).toBe('pricing');
    // id-less nodes carry NO sourceId key (no noise — same purity rule as the probe fields)
    const div = findByTag(res.ir, 'div') as SourceIdIrNode | undefined;
    expect(div?.sourceId).toBeUndefined();
    expect(JSON.stringify(div)).not.toContain('"sourceId"');
    const p = findByTag(res.ir, 'p') as SourceIdIrNode | undefined;
    expect(p?.sourceId).toBeUndefined();
  }, 90_000);

  it('doc_direction reflects computed root direction (rtl fixture -> rtl)', async () => {
    if (!(await probeChromium())) return;
    const rtl = await parseHtml({
      html: '<html dir="rtl"><body><p>שלום</p></body></html>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    expect(rtl.doc_direction).toBe('rtl');
    const ltr = await parseHtml({
      html: '<div>hello</div>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    expect(ltr.doc_direction).toBe('ltr');
  }, 90_000);

  it('fidelity fast does a single capture (no states, no breakpoint deltas)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<button class="cta">x</button>',
      css: '.cta:hover{color:red}@media(max-width:500px){.cta{color:blue}}',
      breakpoints: [{ key: 'mobile', width: 400, direction: 'max' }],
      fidelity: 'fast',
    });
    const btn = findByTag(res.ir, 'button');
    expect(btn?.hoverComputed).toBeUndefined();
    expect(Object.keys(btn?.responsive ?? {})).toHaveLength(0);
  }, 90_000);

  it('malformed HTML does not throw (lenient parse)', async () => {
    if (!(await probeChromium())) return;
    await expect(
      parseHtml({
        html: '<div><p>unclosed <span>tags',
        breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
        fidelity: 'fast',
      }),
    ).resolves.toBeDefined();
  }, 90_000);

  it('external <link> with no base_url surfaces a ParseWarning (no crash)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<link rel="stylesheet" href="missing.css"><div>x</div>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    expect(res.warnings.some((w) => w.code === 'EXTERNAL_CSS_UNRESOLVED')).toBe(true);
  }, 90_000);

  /* ───────────── contract 16 §2 — behavior runtime probes (keyframes / transition / listeners) ── */

  it('@keyframes probe: animation-name != none → animationProbe with opacity/transform deltas', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div class="anim">fades in</div>',
      css:
        '@keyframes fadeInUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}' +
        '.anim{animation:fadeInUp 0.6s ease-out 0.1s both}',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const div = findByTag(res.ir, 'div');
    expect(div?.animationProbe).toBeDefined();
    expect(div?.animationProbe?.name).toBe('fadeInUp');
    expect(div?.animationProbe?.duration).toBe('0.6s');
    expect(div?.animationProbe?.delay).toBe('0.1s');
    expect(div?.animationProbe?.easing).toBe('ease-out');
    expect(div?.animationProbe?.keyframeProps).toEqual(['opacity', 'transform']);
    expect(div?.animationProbe?.opacity).toEqual({ from: 0, to: 1 });
    expect(div?.animationProbe?.transform?.from).toContain('translateY(20px)');
  }, 90_000);

  it('transition probe: a non-zero-duration transition is captured; default `all 0s` is not', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<button class="b">go</button><p>plain</p>',
      css: '.b{transition:background-color 0.3s ease}',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const btn = findByTag(res.ir, 'button');
    expect(btn?.transitionProbe).toBeDefined();
    expect(btn?.transitionProbe?.property).toBe('background-color');
    expect(btn?.transitionProbe?.duration).toBe('0.3s');
    const p = findByTag(res.ir, 'p');
    expect(p?.transitionProbe).toBeUndefined();
  }, 90_000);

  it('listener probe: click listeners land on IrNode.listeners; anchors are skipped', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html:
        '<div class="trigger">open</div>' +
        '<a href="/x" class="link">nav</a>' +
        '<p class="plain">none</p>' +
        '<script>' +
        "document.querySelector('.trigger').addEventListener('click', function(){});" +
        "document.querySelector('.link').addEventListener('click', function(){});" +
        '</script>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const div = findBySourcePath(res.ir, 'div');
    expect(div?.listeners).toEqual(['click']);
    // anchors navigate natively — excluded from the probe even when they DO have listeners
    const a = findByTag(res.ir, 'a');
    expect(a?.listeners).toBeUndefined();
    const p = findByTag(res.ir, 'p');
    expect(p?.listeners).toBeUndefined();
  }, 90_000);

  it('script census: pageScripts is always populated from the source HTML', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div>x</div><script src="https://cdn.example.com/x.js"></script><script>1;</script>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    expect(res.pageScripts).toEqual([
      { src: 'https://cdn.example.com/x.js', inline_bytes: 0, external: true },
      { src: null, inline_bytes: 2, external: false },
    ]);
  }, 90_000);

  it('non-visual tags (<script>/<style>/…) never become IR nodes — no script SOURCE TEXT leaks into the tree (contract 16 §8.3)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html:
        '<div><h1>Hello</h1><script>console.log("LEAKME");</script></div>' +
        '<script>console.log("BODYLEVEL");</script><style>.x{color:red}</style>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const serialized = JSON.stringify(res.ir);
    expect(serialized).not.toContain('LEAKME');
    expect(serialized).not.toContain('BODYLEVEL');
    const tags = res.ir.map((n) => n.tag);
    expect(tags).not.toContain('script');
    expect(tags).not.toContain('style');
    // the census still records both scripts (nothing silently lost)
    expect(res.pageScripts).toHaveLength(2);
  }, 90_000);

  /* ───────────── contract 17 #9/#10 — webfont capture + ::before/::after capture ───────────── */

  it('fontAssets: font <link> census from the raw source + @font-face families via CSSOM', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html:
        '<link rel="stylesheet" href="./theme/fonts.css">' +
        '<link rel="stylesheet" href="./theme/main.css">' +
        '<p class="t">hi</p>',
      css:
        "@font-face{font-family:'LocalFace';src:url(data:font/woff2;base64,AAAA) format('woff2')}" +
        ".t{font-family:'LocalFace',serif}",
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    // links: raw-source census, font-ish stylesheets only (main.css is not a font stylesheet).
    expect(res.fontAssets.links).toEqual(['./theme/fonts.css']);
    // families: the inline @font-face is visible via CSSOM even though its src never loaded.
    expect(res.fontAssets.families).toContain('LocalFace');
  }, 90_000);

  it('fontAssets: a font-free page yields empty links + families', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div><p>plain</p></div>',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    expect(res.fontAssets).toEqual({ links: [], families: [] });
  }, 90_000);

  it('::before capture: a rendering empty-content sized box lands on pseudoBefore (contract 17 #10)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div class="dot">item</div><p>plain</p>',
      css:
        '.dot{position:relative}' +
        '.dot::before{content:"";display:block;position:absolute;top:0;left:0;' +
        'width:8px;height:8px;background:rgb(255,0,0);border-radius:50%}',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const dot = findByTag(res.ir, 'div') as PseudoIrNode | undefined;
    expect(dot?.pseudoBefore).toBeDefined();
    expect(dot?.pseudoBefore?.['content']).toBe('""');
    expect(dot?.pseudoBefore?.['width']).toBe('8px');
    expect(dot?.pseudoBefore?.['height']).toBe('8px');
    expect(dot?.pseudoBefore?.['background-color']).toBe('rgb(255, 0, 0)');
    expect(dot?.pseudoBefore?.['position']).toBe('absolute');
    expect(dot?.pseudoBefore?.['top']).toBe('0px');
    expect(dot?.pseudoBefore?.['display']).toBe('block');
    expect(dot?.pseudoAfter).toBeUndefined();
    // an element with no pseudo rule carries nothing.
    const p = findByTag(res.ir, 'p') as PseudoIrNode | undefined;
    expect(p?.pseudoBefore).toBeUndefined();
    expect(p?.pseudoAfter).toBeUndefined();
  }, 90_000);

  it('::after capture: text-content pseudos are captured verbatim; display:none pseudos are skipped', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<a class="more" href="/x">More</a><div class="hidden">x</div>',
      css:
        '.more::after{content:"→"}' +
        '.hidden::before{content:"";display:none;width:4px;height:4px}',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    const a = findByTag(res.ir, 'a') as PseudoIrNode | undefined;
    // captured (it RENDERS) — representability is NORMALIZE's verdict, not parse's.
    expect(a?.pseudoAfter?.['content']).toBe('"→"');
    const hidden = findByTag(res.ir, 'div') as PseudoIrNode | undefined;
    expect(hidden?.pseudoBefore).toBeUndefined();
  }, 90_000);

  it("pseudo capture never alters the element's own computed pick (purity)", async () => {
    if (!(await probeChromium())) return;
    const css = '.box{padding:10px;background:rgb(0, 128, 0)}';
    const html = '<div class="box">x</div>';
    const bps: BreakpointSpec[] = [{ key: 'desktop', width: 1200, direction: 'min' }];
    // absolutely positioned so the pseudo is out of flow — the host's OWN layout is unchanged and
    // any computed difference could only come from the capture code itself.
    const withPseudoCss = await parseHtml({
      html,
      css: `${css}.box::before{content:"";position:absolute;display:block;width:5px;height:5px;background:rgb(255,0,0)}`,
      breakpoints: bps,
      fidelity: 'fast',
    });
    const without = await parseHtml({ html, css, breakpoints: bps, fidelity: 'fast' });
    const a = findByTag(withPseudoCss.ir, 'div');
    const b = findByTag(without.ir, 'div');
    expect(a?.computed).toEqual(b?.computed);
    // and a pseudo-free page carries NO pseudo keys at all.
    expect(JSON.stringify(without.ir)).not.toContain('"pseudoBefore"');
    expect(JSON.stringify(without.ir)).not.toContain('"pseudoAfter"');
  }, 120_000);

  it('invariant 5: a zero-behavior page carries NONE of the probe fields (pure annotation)', async () => {
    if (!(await probeChromium())) return;
    const res = await parseHtml({
      html: '<div class="root"><h1>Hi</h1><p>Body</p></div>',
      css: '.root{padding:20px}',
      breakpoints: [{ key: 'desktop', width: 1200, direction: 'min' }],
      fidelity: 'fast',
    });
    expect(res.pageScripts).toEqual([]);
    const serialized = JSON.stringify(res.ir);
    for (const key of ['"behaviors"', '"animationProbe"', '"transitionProbe"', '"listeners"']) {
      expect(serialized).not.toContain(key);
    }
  }, 90_000);
});
