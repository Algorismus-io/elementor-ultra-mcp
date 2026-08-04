/**
 * WP-H04 — NORMALIZE stage tests.
 *
 * PURE unit tests against hand-authored IR fixtures (no Chromium, no I/O — `normalizeIr` is a pure
 * transform, ticket Parallelization Notes: "unit-testable the moment WP-H01 lands ... with
 * hand-authored IR fixtures"). Covers the acceptance criteria:
 *   - block-child promotion (mixed text+block `<p>`) → nodes attached INSIDE the restructured host
 *     (contract 18 §7 P2-a — never stray top-level siblings) + `PromotionRecord`;
 *   - pseudo synthesis placement: ::before → FIRST child of the host incl. inline/inline-flex
 *     text-bearing hosts (P2-b), ::after → LAST child;
 *   - stripped-tag accounting for each non-allowlisted tag (`mark`/`code`/`small`/`font`/`br`);
 *   - whitespace collapse + `pre` preservation; whitespace-only node drop;
 *   - redundant-wrapper unwrap (safe vs unsafe — flex/padded/background/semantic NEVER);
 *   - URL resolution against `base_url` + entity decode;
 *   - idempotence (second pass empty records);
 *   - `INLINE_ALLOWLIST` exact-11 snapshot;
 *   - CONTRACT: `StrippedRecord` field names match `CoverageReport.stripped_text` in diff.schema.json.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  INLINE_ALLOWLIST,
  classifyPseudoCapture,
  computeStrippedTags,
  decodeEntities,
  normalizeIr,
  synthesizePseudoNode,
  type PseudoKind,
} from './normalize.js';
import type { PseudoIrNode } from './parse.js';
import type { BoxRect, ComputedStyleSet, IrNode, NormalizeContext, TextRun } from './types.js';

/* ─────────────────────────── tiny IR builders ───────────────────────────────────────────────── */

const ZERO_BOX: BoxRect = { x: 0, y: 0, width: 0, height: 0 };

function node(partial: Partial<IrNode> & { source_path: string; tag: string }): IrNode {
  return {
    source_path: partial.source_path,
    tag: partial.tag,
    role: partial.role ?? 'unknown',
    box: partial.box ?? ZERO_BOX,
    computed: partial.computed ?? {},
    responsive: partial.responsive ?? {},
    attrs: partial.attrs ?? {},
    textRuns: partial.textRuns ?? [],
    children: partial.children ?? [],
    ...(partial.media !== undefined ? { media: partial.media } : {}),
    ...(partial.hoverComputed !== undefined ? { hoverComputed: partial.hoverComputed } : {}),
    ...(partial.focusComputed !== undefined ? { focusComputed: partial.focusComputed } : {}),
  };
}

function run(text: string, inlineTags: string[] = []): TextRun {
  return { text, inlineTags };
}

function ctx(partial: Partial<NormalizeContext> = {}): NormalizeContext {
  return {
    raw_inner_markup: partial.raw_inner_markup ?? {},
    unwrap_redundant: partial.unwrap_redundant ?? false,
    ...(partial.base_url !== undefined ? { base_url: partial.base_url } : {}),
  };
}

/* ─────────────────────────── INLINE_ALLOWLIST snapshot ──────────────────────────────────────── */

describe('normalize: INLINE_ALLOWLIST', () => {
  it('equals exactly the 11 tags from html-v3-prop-type.php:91', () => {
    expect([...INLINE_ALLOWLIST].sort()).toEqual(
      ['a', 'b', 'del', 'em', 'i', 's', 'span', 'strong', 'sub', 'sup', 'u'].sort(),
    );
    expect(INLINE_ALLOWLIST.size).toBe(11);
  });

  it('excludes commonly-mistaken inline tags that PHP strips', () => {
    for (const t of ['br', 'mark', 'code', 'small', 'font', 'abbr', 'cite', 'q']) {
      expect(INLINE_ALLOWLIST.has(t)).toBe(false);
    }
  });
});

/* ─────────────────────────── computeStrippedTags ────────────────────────────────────────────── */

describe('normalize: computeStrippedTags (report mirror)', () => {
  it('returns non-allowlisted tags only, in document order, de-duplicated', () => {
    const raw =
      'Hello <strong>bold</strong> <mark>hl</mark> <code>x</code><br /> <span>ok</span> <mark>again</mark>';
    expect(computeStrippedTags(raw)).toEqual(['mark', 'code', 'br']);
  });

  it('lists every non-allowlisted inline tag (br, mark, code, small, font)', () => {
    const raw = '<br><mark>a</mark><code>b</code><small>c</small><font>d</font>';
    expect(computeStrippedTags(raw)).toEqual(['br', 'mark', 'code', 'small', 'font']);
  });

  it('lists nested block + list tags (mirrors PHP wp_kses strip)', () => {
    const raw = '<div><img /><span>t</span></div><ul><li>x</li></ul>';
    expect(computeStrippedTags(raw)).toEqual(['div', 'img', 'ul', 'li']);
  });

  it('keeps allowlisted-only markup empty', () => {
    expect(
      computeStrippedTags('<strong>a</strong> <em>b</em> <a href="#">c</a> <span>d</span>'),
    ).toEqual([]);
  });

  it('matches the H12 rich-text-card corpus stripped set', () => {
    // The 05-rich-text-card <p.note__lead> raw inner markup (block-in-text + non-allowlisted inline).
    const raw = `The converter now ships <strong>native atomic output</strong> with a much smaller
      <code>custom_css</code> tail. We <mark>highlight</mark> every fallback so you always
      know what changed.<br />
      Read the <a href="/changelog">full changelog</a> for details.
      <div class="note__inset"><img class="note__thumb" src="x.png" /><span>t</span></div>
      <ul class="note__points"><li>a</li><li>b</li></ul>`;
    // Corpus expected: ["mark","code","br","div","ul","li"] (img also appears in the raw markup).
    const tags = computeStrippedTags(raw);
    for (const t of ['mark', 'code', 'br', 'div', 'ul', 'li']) {
      expect(tags).toContain(t);
    }
    expect(tags).not.toContain('strong');
    expect(tags).not.toContain('a');
    expect(tags).not.toContain('span');
  });
});

/* ─────────────────────────── decodeEntities ─────────────────────────────────────────────────── */

describe('normalize: decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('Tom &amp; Jerry &copy; 2026 &mdash; done')).toBe(
      'Tom & Jerry © 2026 — done',
    );
    expect(decodeEntities('&lt;tag&gt; &quot;q&quot;')).toBe('<tag> "q"');
    expect(decodeEntities('a&nbsp;b')).toBe('a b'); // &nbsp; → U+00A0 NBSP
  });

  it('decodes decimal + hex numeric entities', () => {
    expect(decodeEntities('&#169; &#x2014; &#65;')).toBe('© — A');
  });

  it('leaves unknown named entities + bare ampersands verbatim (lossless)', () => {
    expect(decodeEntities('R&D and &notanentity; & alone')).toBe('R&D and &notanentity; & alone');
  });

  it('is a no-op on text with no entities', () => {
    expect(decodeEntities('plain text')).toBe('plain text');
  });
});

/* ─────────────────────────── block-child promotion ──────────────────────────────────────────── */

describe('normalize: block-child promotion', () => {
  it('promotes a nested <div> out of a <p> INSIDE the restructured host (P2-a) + records it', () => {
    const p = node({
      source_path: 'section>p',
      tag: 'p',
      textRuns: [run('Intro '), run('changelog', ['a'])],
    });
    const section = node({ source_path: 'section', tag: 'section', children: [p] });
    const res = normalizeIr(
      [section],
      ctx({ raw_inner_markup: { 'section>p': 'Intro <a>changelog</a><div>inset</div>' } }),
    );

    const sec = res.ir[0]!;
    // The host stays the section's only child; it is restructured into a container holding the
    // synthesized ::text content leaf + the promoted div (document order) — never a stray sibling.
    expect(sec.children.map((c) => c.source_path)).toEqual(['section>p']);
    const host = sec.children[0]!;
    expect(host.textRuns).toEqual([]);
    expect(host.children.map((c) => c.tag)).toEqual(['p', 'div']);
    const promotedDiv = host.children[1]!;
    expect(promotedDiv.role).toBe('structural-block');
    expect(promotedDiv.source_path).toContain('::promoted');

    // the content leaf carries the surviving runs (inline-allowlisted only).
    const content = host.children[0]!;
    expect(content.source_path).toBe('section>p::text');
    for (const tr of content.textRuns) {
      for (const t of tr.inlineTags) expect(INLINE_ALLOWLIST.has(t)).toBe(true);
    }

    expect(res.promotions).toHaveLength(1);
    expect(res.promotions[0]!.from_source_path).toBe('section>p');
    expect(res.promotions[0]!.promoted_to).toHaveLength(1);
  });

  it('preserves document order for multiple promoted blocks (text [block] [block])', () => {
    const p = node({ source_path: 'p', tag: 'p', textRuns: [run('lead')] });
    const res = normalizeIr(
      [node({ source_path: 'root', tag: 'section', children: [p] })],
      ctx({ raw_inner_markup: { p: 'lead <div>a</div> <ul><li>x</li></ul>' } }),
    );
    const root = res.ir[0]!;
    expect(root.children).toHaveLength(1); // the restructured host — no stray siblings (P2-a)
    const host = root.children[0]!;
    // content leaf first, then div, then ul (li is nested inside the ul tag in markup but scanned at
    // the same level here as a promotable block — order follows first-seen document order: div, ul, li).
    const tags = host.children.map((c) => c.tag);
    expect(tags[0]).toBe('p'); // the ::text content leaf keeps the host tag
    expect(host.children[0]!.source_path).toBe('p::text');
    expect(tags).toContain('div');
    expect(tags).toContain('ul');
  });

  it('maps heading/list block tags to seed roles on promotion', () => {
    const p = node({ source_path: 'p', tag: 'p', textRuns: [run('x')] });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({ raw_inner_markup: { p: 'x <h3>head</h3> <ul><li>i</li></ul>' } }),
    );
    const host = res.ir[0]!.children[0]!;
    const promoted = host.children.filter((c) => c.source_path.includes('::promoted'));
    const byTag = new Map(promoted.map((c) => [c.tag, c.role]));
    expect(byTag.get('h3')).toBe('heading');
    expect(byTag.get('ul')).toBe('list');
    expect(byTag.get('li')).toBe('list-item');
  });

  it('does NOT promote when the text node has only allowlisted inline markup', () => {
    const p = node({ source_path: 'p', tag: 'p', textRuns: [run('hello', ['strong'])] });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({ raw_inner_markup: { p: '<strong>hello</strong> <em>world</em>' } }),
    );
    expect(res.promotions).toHaveLength(0);
    expect(res.ir[0]!.children.map((c) => c.tag)).toEqual(['p']);
  });

  it('FOLDS an inline-allowlist child of a text node (PARSE wires it as a child) — it is DROPPED', () => {
    // PARSE's in-page walker wires EVERY element child, so an inline <span> inside an <h1> arrives BOTH
    // as a child IR node AND captured in the h1's textRuns. NORMALIZE must DROP the span child so the
    // heading stays a LEAF (the span survives only as inline html-v3 markup of the heading) — the bug.
    const h1 = node({
      source_path: 'h1',
      tag: 'h1',
      textRuns: [run('Customer intelligence, '), run('on autopilot', ['span'])],
      children: [
        node({
          source_path: 'h1>span',
          tag: 'span',
          textRuns: [run('on autopilot')],
        }),
      ],
    });
    const res = normalizeIr(
      [h1],
      ctx({
        raw_inner_markup: {
          h1: 'Customer intelligence, <span style="color:#6c5ce7">on autopilot</span>',
        },
        unwrap_redundant: true,
      }),
    );
    // The heading is a LEAF — the inline <span> child is folded away, NOT promoted.
    expect(res.ir).toHaveLength(1);
    expect(res.ir[0]!.tag).toBe('h1');
    expect(res.ir[0]!.children).toHaveLength(0);
    expect(res.promotions).toHaveLength(0);
  });

  it('folds MULTIPLE inline children (span/strong/em/inline-a) of a text node but keeps a block child', () => {
    const p = node({
      source_path: 'p',
      tag: 'p',
      textRuns: [run('a'), run('b', ['strong']), run('c', ['a'])],
      children: [
        node({ source_path: 'p>strong', tag: 'strong', textRuns: [run('b')] }),
        node({ source_path: 'p>a', tag: 'a', textRuns: [run('c')], attrs: { href: '#' } }),
      ],
    });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({
        raw_inner_markup: { p: 'a <strong>b</strong> <a href="#">c</a><div>blk</div>' },
        unwrap_redundant: true,
      }),
    );
    const root = res.ir[0]!;
    // p keeps no inline children; the <div> from raw inner markup lands INSIDE the restructured
    // host (P2-a) next to the ::text content leaf — never as a sibling of p.
    expect(root.children.map((c) => c.source_path)).toEqual(['p']);
    const host = root.children[0]!;
    expect(host.children.some((c) => c.tag === 'strong' || c.tag === 'a')).toBe(false);
    expect(host.children.map((c) => c.tag)).toContain('div');
    expect(host.children[0]!.source_path).toBe('p::text');
  });

  it('does NOT fold an inline child that carries MEDIA (an <a><img></a> is a real node — promoted)', () => {
    // An inline-allowlist tag is dropped ONLY when it is pure inline text. A media-bearing inline
    // element (e.g. an <a> that itself is an image wrapper) is a real node and must survive. It is
    // MOVED out of the html-v3 content into the restructured host (P2-a) — the ::text leaf carries
    // the runs, so the image is never dropped by ASSEMBLE's leaf-text-widget backstop.
    const a = node({
      source_path: 'p>a',
      tag: 'a',
      media: { kind: 'img', url: 'https://x/i.png' },
      textRuns: [run('img')],
      attrs: { href: '#' },
    });
    const p = node({
      source_path: 'p',
      tag: 'p',
      textRuns: [run('see '), run('img', ['a'])],
      children: [a],
    });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({ raw_inner_markup: { p: 'see <a href="#">img</a>' }, unwrap_redundant: true }),
    );
    const root = res.ir[0]!;
    expect(root.children.map((c) => c.source_path)).toEqual(['p']);
    const host = root.children[0]!;
    const content = host.children.find((c) => c.source_path === 'p::text')!;
    expect(content.children).toHaveLength(0); // the text leaf stays a leaf
    const promoted = host.children.find((c) => c.tag === 'a')!;
    expect(promoted.source_path).toBe('p>a'); // the REAL node survives (media + attrs intact)
    expect(promoted.media).toMatchObject({ kind: 'img', url: 'https://x/i.png' });
    expect(promoted.attrs['href']).toBe('#');
  });

  it('MOVES a real block child (with its full subtree + styles) out of a text node — no empty husk', () => {
    // The content-loss bug: promotion synthesized an EMPTY husk from the raw-markup tag scan while
    // the REAL nested block stayed under the text node and was silently dropped by ASSEMBLE's
    // leaf-text-widget backstop. The real child must be MOVED out instead.
    const li = node({ source_path: 'bq>ul>li', tag: 'li', textRuns: [run('point one')] });
    const ul = node({
      source_path: 'bq>ul',
      tag: 'ul',
      computed: { 'background-color': 'rgb(1, 2, 3)' },
      box: { x: 1, y: 2, width: 300, height: 40 },
      attrs: { class: 'points' },
      children: [li],
    });
    const bq = node({
      source_path: 'bq',
      tag: 'blockquote',
      textRuns: [run('quote text')],
      children: [ul],
    });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [bq] })],
      ctx({ raw_inner_markup: { bq: 'quote text<ul class="points"><li>point one</li></ul>' } }),
    );
    const root = res.ir[0]!;
    // The blockquote host is restructured (P2-a): content leaf + the REAL moved ul INSIDE it.
    expect(root.children.map((c) => c.source_path)).toEqual(['bq']);
    const host = root.children[0]!;
    expect(host.tag).toBe('blockquote'); // blockquote is container-safe in CLASSIFY — tag kept
    expect(host.children.map((c) => c.source_path)).toEqual(['bq::text', 'bq>ul']);
    const quote = host.children[0]!;
    expect(quote.children).toHaveLength(0); // leaf text widget
    expect(quote.textRuns[0]!.text).toBe('quote text');
    const movedUl = host.children[1]!;
    // The REAL node moved — styles, box, attrs and subtree intact; NOT a zero-box synthetic husk.
    expect(movedUl.source_path).toBe('bq>ul');
    expect(movedUl.source_path).not.toContain('::promoted');
    expect(movedUl.computed['background-color']).toBe('rgb(1, 2, 3)');
    expect(movedUl.box.width).toBe(300);
    expect(movedUl.children).toHaveLength(1);
    expect(movedUl.children[0]!.textRuns[0]!.text).toBe('point one');
    // The promotion record points at the REAL path.
    expect(res.promotions).toHaveLength(1);
    expect(res.promotions[0]!.from_source_path).toBe('bq');
    expect(res.promotions[0]!.promoted_to).toEqual(['bq>ul']);
    // No phantom duplicate from the raw-markup scan on top of the real move.
    expect(host.children.filter((c) => c.tag === 'ul')).toHaveLength(1);
  });

  it('hoists a block nested INSIDE a foldable inline wrapper (<span><div>…</div></span>)', () => {
    const div = node({ source_path: 'p>span>div', tag: 'div', textRuns: [run('inset')] });
    const span = node({
      source_path: 'p>span',
      tag: 'span',
      textRuns: [run('styled')],
      children: [div],
    });
    const p = node({
      source_path: 'p',
      tag: 'p',
      textRuns: [run('lead '), run('styled', ['span'])],
      children: [span],
    });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({ raw_inner_markup: { p: 'lead <span>styled<div>inset</div></span>' } }),
    );
    const root = res.ir[0]!;
    // span folded into the paragraph's runs; the real div hoisted INTO the restructured host (P2-a).
    expect(root.children.map((c) => c.source_path)).toEqual(['p']);
    const host = root.children[0]!;
    expect(host.children.map((c) => c.source_path)).toEqual(['p::text', 'p>span>div']);
    expect(host.children[1]!.textRuns[0]!.text).toBe('inset');
  });

  it('folds a <br> child of a text node — no phantom promoted sibling (<p>a<br>b</p>)', () => {
    // PARSE recurses <br> in extractTextRuns (its INLINE_ALLOW is the 11-tag allowlist + mark/code/
    // br/abbr/cite), so the line break leaves a textless, childless <br> child node whose text (none)
    // is already accounted for in the parent's runs. Promoting it would emit a phantom 'unknown' block
    // widget that adds gap spacing in flex columns — it must be folded (dropped) instead.
    const br = node({ source_path: 'p>br', tag: 'br' });
    const p = node({
      source_path: 'p',
      tag: 'p',
      textRuns: [run('line1'), run('line2')],
      children: [br],
    });
    const res = normalizeIr([p], ctx({ raw_inner_markup: { p: 'line1<br>line2' } }));
    expect(res.ir).toHaveLength(1); // exactly one root — no promoted <br> sibling
    expect(res.ir[0]!.tag).toBe('p');
    expect(res.ir[0]!.children).toHaveLength(0);
    expect(res.promotions).toHaveLength(0);
    // the strip is still reported (br is NOT in the 11-tag wp_kses allowlist).
    expect(res.stripped).toEqual([{ source_path: 'p', stripped_tags: ['br'] }]);
  });

  it('folds mark/code/abbr/cite children of a text node — text already in the runs, never duplicated', () => {
    // <p>x <mark>y</mark> z</p>: PARSE captures 'y' in the parent's runs AND wires <mark> as a child.
    // Folding only the 11-tag allowlist promoted the <mark> child as a sibling text node, duplicating
    // 'y' as a separate widget. Everything extractTextRuns recurses must fold.
    for (const tag of ['mark', 'code', 'abbr', 'cite']) {
      const child = node({ source_path: `p>${tag}`, tag, textRuns: [run('y')] });
      const p = node({
        source_path: 'p',
        tag: 'p',
        textRuns: [run('x '), run('y', [tag]), run(' z')],
        children: [child],
      });
      const res = normalizeIr([p], ctx({ raw_inner_markup: { p: `x <${tag}>y</${tag}> z` } }));
      expect(res.ir).toHaveLength(1); // one root — no duplicate text widget
      expect(res.ir[0]!.children).toHaveLength(0); // leaf text widget
      expect(res.promotions).toHaveLength(0);
      expect(res.ir[0]!.textRuns.map((r) => r.text)).toEqual(['x ', 'y', ' z']);
      // the strip stays visible in the report.
      expect(res.stripped).toEqual([{ source_path: 'p', stripped_tags: [tag] }]);
    }
  });

  it('still hoists a block nested INSIDE a parse-folded inline child (<p><code><div>…</div></code></p>)', () => {
    const div = node({ source_path: 'p>code>div', tag: 'div', textRuns: [run('inset')] });
    const code = node({
      source_path: 'p>code',
      tag: 'code',
      textRuns: [run('snippet')],
      children: [div],
    });
    const p = node({
      source_path: 'p',
      tag: 'p',
      textRuns: [run('lead '), run('snippet', ['code'])],
      children: [code],
    });
    const res = normalizeIr(
      [p],
      ctx({ raw_inner_markup: { p: 'lead <code>snippet<div>inset</div></code>' } }),
    );
    // code folded into the paragraph's runs; the real div hoisted INTO the restructured host —
    // even at the FOREST ROOT the host stays the single top-level node (P2-a: no stray roots).
    expect(res.ir.map((n) => n.source_path)).toEqual(['p']);
    const host = res.ir[0]!;
    expect(host.children.map((c) => c.source_path)).toEqual(['p::text', 'p>code>div']);
    expect(host.children[1]!.textRuns[0]!.text).toBe('inset');
  });
});

/* ─────────────────────────── stripped-tag accounting ────────────────────────────────────────── */

describe('normalize: stripped-tag accounting', () => {
  it('records a StrippedRecord per text node with non-allowlisted tags', () => {
    const p = node({ source_path: 'p', tag: 'p', textRuns: [run('hi')] });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({
        raw_inner_markup: { p: 'hi <mark>x</mark> <code>y</code> <small>z</small> <font>w</font>' },
      }),
    );
    expect(res.stripped).toHaveLength(1);
    expect(res.stripped[0]!.source_path).toBe('p');
    expect(res.stripped[0]!.stripped_tags).toEqual(['mark', 'code', 'small', 'font']);
  });

  it('records inline <br> as stripped (not in allowlist)', () => {
    const p = node({ source_path: 'p', tag: 'p', textRuns: [run('line one line two')] });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({ raw_inner_markup: { p: 'line one<br>line two' } }),
    );
    expect(res.stripped[0]!.stripped_tags).toContain('br');
  });

  it('produces NO StrippedRecord for allowlisted-only text', () => {
    const p = node({ source_path: 'p', tag: 'p', textRuns: [run('a', ['strong'])] });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({ raw_inner_markup: { p: '<strong>a</strong>' } }),
    );
    expect(res.stripped).toHaveLength(0);
  });
});

/* ─────────────────────────── whitespace ─────────────────────────────────────────────────────── */

describe('normalize: whitespace', () => {
  it('collapses internal whitespace runs and trims leading/trailing', () => {
    const p = node({
      source_path: 'p',
      tag: 'p',
      textRuns: [run('   hello   \n\t  world   ')],
    });
    const res = normalizeIr([p], ctx());
    expect(res.ir[0]!.textRuns[0]!.text).toBe('hello world');
  });

  it('drops whitespace-only text nodes between block elements', () => {
    const wsChild = node({ source_path: 'r>span', tag: 'span', textRuns: [run('   \n  ')] });
    const realChild = node({ source_path: 'r>div', tag: 'div', textRuns: [run('content')] });
    const root = node({ source_path: 'r', tag: 'section', children: [wsChild, realChild] });
    const res = normalizeIr([root], ctx());
    expect(res.ir[0]!.children.map((c) => c.source_path)).toEqual(['r>div']);
  });

  it('does NOT collapse whitespace inside white-space:pre nodes', () => {
    const pre = node({
      source_path: 'pre',
      tag: 'pre',
      computed: { 'white-space': 'pre' },
      textRuns: [run('  code\n    indented  ')],
    });
    const res = normalizeIr([pre], ctx());
    expect(res.ir[0]!.textRuns[0]!.text).toBe('  code\n    indented  ');
  });

  it('defaults to preserve for a <pre> tag even without computed white-space', () => {
    const pre = node({ source_path: 'pre', tag: 'pre', textRuns: [run('a   b')] });
    const res = normalizeIr([pre], ctx());
    expect(res.ir[0]!.textRuns[0]!.text).toBe('a   b');
  });
});

/* ─────────────────────────── redundant-wrapper unwrap ───────────────────────────────────────── */

describe('normalize: redundant-wrapper unwrap', () => {
  it('unwraps a single-child styleless <div> wrapper when unwrap_redundant:true', () => {
    const inner = node({ source_path: 'r>div>div', tag: 'div', textRuns: [run('x')] });
    const wrapper = node({ source_path: 'r>div', tag: 'div', children: [inner] });
    const root = node({ source_path: 'r', tag: 'section', children: [wrapper] });
    const res = normalizeIr([root], ctx({ unwrap_redundant: true }));
    // wrapper collapsed → its inner div is now the direct child.
    expect(res.ir[0]!.children).toHaveLength(1);
    expect(res.ir[0]!.children[0]!.source_path).toBe('r>div>div');
    expect(res.warnings.some((w) => w.includes('unwrapped'))).toBe(true);
  });

  it('does NOT unwrap when unwrap_redundant:false', () => {
    const inner = node({ source_path: 'r>div>div', tag: 'div', textRuns: [run('x')] });
    const wrapper = node({ source_path: 'r>div', tag: 'div', children: [inner] });
    const root = node({ source_path: 'r', tag: 'section', children: [wrapper] });
    const res = normalizeIr([root], ctx({ unwrap_redundant: false }));
    expect(res.ir[0]!.children[0]!.source_path).toBe('r>div');
  });

  it('NEVER unwraps a flex/grid wrapper (layout loss)', () => {
    const inner = node({ source_path: 'r>div>div', tag: 'div', textRuns: [run('x')] });
    const wrapper = node({
      source_path: 'r>div',
      tag: 'div',
      computed: { display: 'flex', gap: '16px' },
      children: [inner],
    });
    const root = node({ source_path: 'r', tag: 'section', children: [wrapper] });
    const res = normalizeIr([root], ctx({ unwrap_redundant: true }));
    expect(res.ir[0]!.children[0]!.source_path).toBe('r>div');
  });

  it('NEVER unwraps a padded / background wrapper', () => {
    const innerA = node({ source_path: 'a>div', tag: 'div', textRuns: [run('x')] });
    const padded = node({
      source_path: 'a',
      tag: 'div',
      computed: { padding: '24px' },
      children: [innerA],
    });
    const innerB = node({ source_path: 'b>div', tag: 'div', textRuns: [run('y')] });
    const bg = node({
      source_path: 'b',
      tag: 'div',
      computed: { 'background-color': 'rgb(255, 0, 0)' },
      children: [innerB],
    });
    const res = normalizeIr([padded, bg], ctx({ unwrap_redundant: true }));
    expect(res.ir.map((n) => n.source_path)).toEqual(['a', 'b']);
  });

  it('NEVER unwraps a semantic-tag wrapper (header/section/nav...)', () => {
    const inner = node({ source_path: 'header>div', tag: 'div', textRuns: [run('x')] });
    const header = node({ source_path: 'header', tag: 'header', children: [inner] });
    const res = normalizeIr([header], ctx({ unwrap_redundant: true }));
    expect(res.ir[0]!.tag).toBe('header');
  });

  it('collapses a chain of redundant wrappers (div>div>div around one node)', () => {
    const leaf = node({ source_path: 'a>b>c', tag: 'p', textRuns: [run('deep')] });
    const w2 = node({ source_path: 'a>b', tag: 'div', children: [leaf] });
    const w1 = node({ source_path: 'a', tag: 'div', children: [w2] });
    const res = normalizeIr([w1], ctx({ unwrap_redundant: true }));
    expect(res.ir).toHaveLength(1);
    expect(res.ir[0]!.tag).toBe('p');
    expect(res.ir[0]!.source_path).toBe('a>b>c');
  });

  it('merges non-conflicting inherited typography from the unwrapped wrapper into the child', () => {
    const inner = node({
      source_path: 'r>div>p',
      tag: 'p',
      computed: { color: 'rgb(0, 0, 0)' },
      textRuns: [run('x')],
    });
    const wrapper = node({
      source_path: 'r>div',
      tag: 'div',
      // font-family is non-default inherited typography but NOT a layout-bearing prop → unwrap allowed.
      computed: { 'font-family': 'Inter' },
      children: [inner],
    });
    const root = node({ source_path: 'r', tag: 'section', children: [wrapper] });
    const res = normalizeIr([root], ctx({ unwrap_redundant: true }));
    const child = res.ir[0]!.children[0]!;
    expect(child.source_path).toBe('r>div>p');
    expect(child.computed['font-family']).toBe('Inter');
    expect(child.computed['color']).toBe('rgb(0, 0, 0)');
  });
});

/* ─────────────────────────── URL resolution + entity decode ─────────────────────────────────── */

describe('normalize: URL resolution + entities', () => {
  it('resolves relative media + href against base_url', () => {
    const img = node({
      source_path: 'img',
      tag: 'img',
      media: { kind: 'img', url: 'images/a.png', alt: 'Tom &amp; Jerry' },
    });
    const link = node({
      source_path: 'a',
      tag: 'a',
      attrs: { href: '/changelog' },
      textRuns: [run('go')],
    });
    const res = normalizeIr([img, link], ctx({ base_url: 'https://ex.com/blog/post/' }));
    expect(res.ir[0]!.media!.url).toBe('https://ex.com/blog/post/images/a.png');
    expect(res.ir[0]!.media!.alt).toBe('Tom & Jerry');
    expect(res.ir[1]!.attrs['href']).toBe('https://ex.com/changelog');
  });

  it('leaves absolute / data / mailto / fragment / protocol-relative URLs untouched', () => {
    const mk = (href: string): IrNode =>
      node({ source_path: href, tag: 'a', attrs: { href }, textRuns: [run('x')] });
    const inputs = [
      'https://other.com/x',
      'data:image/png;base64,AAAA',
      'mailto:a@b.com',
      'tel:+123',
      '#section',
      '//cdn.com/x.png',
    ];
    const res = normalizeIr(inputs.map(mk), ctx({ base_url: 'https://ex.com/' }));
    res.ir.forEach((n, i) => expect(n.attrs['href']).toBe(inputs[i]));
  });

  it('leaves relative URLs unchanged when no base_url is provided', () => {
    const img = node({ source_path: 'img', tag: 'img', media: { kind: 'img', url: 'a.png' } });
    const res = normalizeIr([img], ctx());
    expect(res.ir[0]!.media!.url).toBe('a.png');
  });

  it('resolves each candidate in a srcset', () => {
    const img = node({
      source_path: 'img',
      tag: 'img',
      media: { kind: 'img', url: 'a.png', srcset: 'a.png 1x, b.png 2x' },
    });
    const res = normalizeIr([img], ctx({ base_url: 'https://ex.com/img/' }));
    expect(res.ir[0]!.media!.srcset).toBe(
      'https://ex.com/img/a.png 1x, https://ex.com/img/b.png 2x',
    );
  });

  it('never URL-resolves an svg media (stores raw markup in url)', () => {
    const svg = node({
      source_path: 'svg',
      tag: 'svg',
      media: { kind: 'svg', url: '<svg viewBox="0 0 1 1"></svg>' },
    });
    const res = normalizeIr([svg], ctx({ base_url: 'https://ex.com/' }));
    expect(res.ir[0]!.media!.url).toBe('<svg viewBox="0 0 1 1"></svg>');
  });

  it('decodes entities in text runs', () => {
    const p = node({ source_path: 'p', tag: 'p', textRuns: [run('A &amp; B &copy;')] });
    const res = normalizeIr([p], ctx());
    expect(res.ir[0]!.textRuns[0]!.text).toBe('A & B ©');
  });

  it('preserves the per-run inline-link capture (linkHref/linkTarget) and resolves it against base_url', () => {
    // PARSE attaches the nearest wrapping <a href>'s destination to the run (inlineTags carries tag
    // NAMES only) — NORMALIZE must carry it through and base_url-resolve it like any other URL.
    const linked = {
      text: 'full changelog',
      inlineTags: ['a'],
      linkHref: '/changelog',
      linkTarget: '_blank',
    };
    const p = node({
      source_path: 'p',
      tag: 'p',
      textRuns: [run('Read the '), linked],
    });
    const res = normalizeIr([p], ctx({ base_url: 'https://ex.com/blog/' }));
    const out = res.ir[0]!.textRuns[1] as TextRun & { linkHref?: string; linkTarget?: string };
    expect(out.text).toBe('full changelog');
    expect(out.inlineTags).toEqual(['a']);
    expect(out.linkHref).toBe('https://ex.com/changelog');
    expect(out.linkTarget).toBe('_blank');
  });

  it('preserves the per-run accent color capture (contract 17 #8)', () => {
    // PARSE attaches `color` to a run whose inline wrapper recolors it (`h1 em { color: … }`) —
    // NORMALIZE must carry it through or MAP's html-v3 fold re-inks the accent (page 2439).
    const accent = { text: 'runs the back office', inlineTags: ['em'], color: 'rgb(12, 107, 74)' };
    const h = node({ source_path: 'h', tag: 'h1', textRuns: [run('The counter that '), accent] });
    const res = normalizeIr([h], ctx());
    const out = res.ir[0]!.textRuns[1] as TextRun;
    expect(out.text).toBe('runs the back office');
    expect(out.color).toBe('rgb(12, 107, 74)');
  });
});

/* ─────────────────────────── idempotence ────────────────────────────────────────────────────── */

describe('normalize: idempotence', () => {
  it('second pass on the normalized tree yields empty stripped/promotions and a stable tree', () => {
    const p = node({
      source_path: 'section>p',
      tag: 'p',
      textRuns: [run('  Intro &amp; more  '), run('link', ['a'])],
    });
    const wsChild = node({ source_path: 'section>span', tag: 'span', textRuns: [run('   ')] });
    const wrapper = node({
      source_path: 'section>div',
      tag: 'div',
      children: [node({ source_path: 'section>div>p', tag: 'p', textRuns: [run('y')] })],
    });
    const section = node({
      source_path: 'section',
      tag: 'section',
      children: [p, wsChild, wrapper],
    });

    const first = normalizeIr(
      [section],
      ctx({
        base_url: 'https://ex.com/',
        unwrap_redundant: true,
        raw_inner_markup: {
          'section>p': 'Intro &amp; more <a>link</a><mark>hl</mark><div>blk</div>',
        },
      }),
    );
    expect(first.promotions.length).toBeGreaterThan(0);
    expect(first.stripped.length).toBeGreaterThan(0);

    // Second pass: feed the normalized tree back. The text node's surviving inner markup is now
    // inline-only, so the realistic re-parse carries no block/stripped raw markup → no new records.
    const second = normalizeIr(
      first.ir,
      ctx({ base_url: 'https://ex.com/', unwrap_redundant: true, raw_inner_markup: {} }),
    );
    expect(second.promotions).toHaveLength(0);
    expect(second.stripped).toHaveLength(0);
    // Structurally stable: same node count + same source paths.
    expect(serializePaths(second.ir)).toEqual(serializePaths(first.ir));
    // Text already decoded + collapsed → unchanged.
    expect(JSON.stringify(second.ir)).toEqual(JSON.stringify(first.ir));
  });
});

function serializePaths(nodes: IrNode[]): string[] {
  const out: string[] = [];
  const walk = (n: IrNode): void => {
    out.push(n.source_path);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/* ─────────────────────────── CONTRACT: schema field-name alignment ──────────────────────────── */

describe('normalize: contract — StrippedRecord matches diff.schema CoverageReport.stripped_text', () => {
  it('stripped_tags is the field name the diff.schema.json stripped_text item declares', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../../../spec/contracts/schemas/diff.schema.json', import.meta.url),
        'utf8',
      ),
    ) as {
      $defs: {
        CoverageReport: {
          properties: {
            stripped_text: { items: { properties: Record<string, unknown> } };
          };
        };
      };
    };
    const itemProps = schema.$defs.CoverageReport.properties.stripped_text.items.properties;
    expect(Object.keys(itemProps)).toContain('stripped_tags');
    expect(Object.keys(itemProps)).toContain('element_id');

    // A produced StrippedRecord carries `stripped_tags` (H10 maps source_path → element_id when folding
    // into the final report; the array field name MUST match the schema verbatim).
    const p = node({ source_path: 'p', tag: 'p', textRuns: [run('x')] });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [p] })],
      ctx({ raw_inner_markup: { p: 'x <mark>y</mark>' } }),
    );
    const rec = res.stripped[0]!;
    expect(rec).toHaveProperty('stripped_tags');
    expect(Array.isArray(rec.stripped_tags)).toBe(true);
    // every element is a string (schema: items.stripped_tags.items.type === 'string').
    for (const t of rec.stripped_tags) expect(typeof t).toBe('string');
  });
});

/* ─────────────────────────── Pseudo-element synthesis (contract 17 #10) ─────────────────────── */

/** Attach PARSE's additive pseudo capture fields to a builder node. */
function withPseudo(
  base: IrNode,
  pseudo: { before?: ComputedStyleSet; after?: ComputedStyleSet },
): IrNode {
  const n = base as PseudoIrNode;
  if (pseudo.before !== undefined) n.pseudoBefore = pseudo.before;
  if (pseudo.after !== undefined) n.pseudoAfter = pseudo.after;
  return n;
}

/** A representable capture: empty-content sized box (a red dot). */
function dotCapture(overrides: ComputedStyleSet = {}): ComputedStyleSet {
  return {
    content: '""',
    display: 'block',
    position: 'static',
    width: '8px',
    height: '8px',
    'background-color': 'rgb(255, 0, 0)',
    'border-radius': '50%',
    ...overrides,
  };
}

describe('normalize: classifyPseudoCapture (pure verdicts)', () => {
  it('an empty-content sized box is representable', () => {
    expect(classifyPseudoCapture(dotCapture())).toEqual({ representable: true });
    // single-quoted / whitespace-only content literals are also "empty"
    expect(classifyPseudoCapture(dotCapture({ content: "''" }))).toEqual({ representable: true });
    expect(classifyPseudoCapture(dotCapture({ content: '" "' }))).toEqual({ representable: true });
  });

  it('text content / counter() / url() content is unrepresentable', () => {
    for (const content of ['"→"', '"NEW"', 'counter(li)', 'attr(data-x)', 'url("x.png")']) {
      const verdict = classifyPseudoCapture(dotCapture({ content }));
      expect(verdict.representable).toBe(false);
    }
  });

  it('mask-bearing pseudos are unrepresentable', () => {
    const verdict = classifyPseudoCapture(dotCapture({ 'mask-image': 'url("icon.svg")' }));
    expect(verdict).toEqual({ representable: false, detail: 'mask-bearing' });
    // mask-image:none does NOT block
    expect(classifyPseudoCapture(dotCapture({ 'mask-image': 'none' })).representable).toBe(true);
  });

  it('zero/auto-size boxes are unrepresentable', () => {
    expect(classifyPseudoCapture(dotCapture({ width: '0px' })).representable).toBe(false);
    expect(classifyPseudoCapture(dotCapture({ height: 'auto' })).representable).toBe(false);
    const noWidth = dotCapture();
    delete noWidth['width'];
    expect(classifyPseudoCapture(noWidth).representable).toBe(false);
  });
});

describe('normalize: synthesizePseudoNode (pure)', () => {
  const host = node({ source_path: 'div', tag: 'div' });

  it('builds a styled childless div with deterministic path, marker attr and px box', () => {
    const synth = synthesizePseudoNode(host, 'before', dotCapture());
    expect(synth.source_path).toBe('div::pseudo-before');
    expect(synth.tag).toBe('div');
    expect(synth.role).toBe('structural-block');
    expect(synth.attrs).toEqual({ 'data-emcp-pseudo': 'before' });
    expect(synth.textRuns).toEqual([]);
    expect(synth.children).toEqual([]);
    expect(synth.box).toEqual({ x: 0, y: 0, width: 8, height: 8 });
    expect(synth.computed).toEqual({
      width: '8px',
      height: '8px',
      display: 'block',
      'background-color': 'rgb(255, 0, 0)',
      'border-radius': '50%',
    });
  });

  it('drops inert paint props (transparent bg, none image, 0px radius) — I4 noise rule', () => {
    const synth = synthesizePseudoNode(
      host,
      'after',
      dotCapture({
        'background-color': 'rgba(0, 0, 0, 0)',
        'background-image': 'none',
        'border-radius': '0px',
      }),
    );
    expect(synth.source_path).toBe('div::pseudo-after');
    expect(synth.computed).toEqual({ width: '8px', height: '8px', display: 'block' });
  });

  it('carries padding longhands VERBATIM — including 0px (I2: painted container bases)', () => {
    const synth = synthesizePseudoNode(
      host,
      'before',
      dotCapture({
        'padding-top': '0px',
        'padding-right': '4px',
        'padding-bottom': '0px',
        'padding-left': '4px',
      }),
    );
    // Zero padding is NOT inert here: the synthesized node maps to a container whose base padding
    // PAINTS (e-div-block/e-flexbox 10px), so the explicit 0px override must survive to emission.
    expect(synth.computed['padding-top']).toBe('0px');
    expect(synth.computed['padding-right']).toBe('4px');
    expect(synth.computed['padding-bottom']).toBe('0px');
    expect(synth.computed['padding-left']).toBe('4px');
  });

  it('honors absolute positioning: position + non-auto insets carried, static dropped', () => {
    const abs = synthesizePseudoNode(
      host,
      'before',
      dotCapture({ position: 'absolute', top: '0px', left: '0px', right: 'auto', bottom: 'auto' }),
    );
    expect(abs.computed['position']).toBe('absolute');
    expect(abs.computed['top']).toBe('0px');
    expect(abs.computed['left']).toBe('0px');
    expect(abs.computed).not.toHaveProperty('right');
    expect(abs.computed).not.toHaveProperty('bottom');
    const stat = synthesizePseudoNode(host, 'before', dotCapture());
    expect(stat.computed).not.toHaveProperty('position');
  });
});

describe('normalize: pseudo-element synthesis in the tree', () => {
  it('container host: ::before → FIRST child, ::after → LAST child, with synth records', () => {
    const child = node({ source_path: 'div>p', tag: 'p', textRuns: [run('text')] });
    const container = withPseudo(
      node({ source_path: 'div', tag: 'div', computed: { display: 'flex' }, children: [child] }),
      { before: dotCapture(), after: dotCapture({ width: '40px', height: '4px' }) },
    );
    const res = normalizeIr([container], ctx());
    const out = res.ir[0]!;
    expect(out.children.map((c) => c.source_path)).toEqual([
      'div::pseudo-before',
      'div>p',
      'div::pseudo-after',
    ]);
    expect(out.children[2]!.box).toEqual({ x: 0, y: 0, width: 40, height: 4 });
    expect(res.pseudo_synthesized).toEqual([
      { source_path: 'div', pseudo: 'before', synthesized_path: 'div::pseudo-before' },
      { source_path: 'div', pseudo: 'after', synthesized_path: 'div::pseudo-after' },
    ]);
    expect(res.pseudo_drops).toEqual([]);
  });

  it('TEXT-BEARING host: pseudos attach INSIDE the restructured host (P2-a), never as siblings', () => {
    const heading = withPseudo(
      node({ source_path: 'section>h2', tag: 'h2', textRuns: [run('Title')] }),
      { before: dotCapture({ width: '40px', height: '4px' }), after: dotCapture() },
    );
    const section = node({ source_path: 'section', tag: 'section', children: [heading] });
    const res = normalizeIr([section], ctx());
    const out = res.ir[0]!;
    // The host stays the section's ONLY child; pseudos + the ::text content leaf live inside it.
    expect(out.children.map((c) => c.source_path)).toEqual(['section>h2']);
    const host = out.children[0]!;
    // h2 is a LEAF-forcing tag in CLASSIFY — the container retags to div, the content leaf keeps h2
    // so the heading semantics survive on the node that carries the text.
    expect(host.tag).toBe('div');
    expect(host.textRuns).toEqual([]);
    expect(host.children.map((c) => c.source_path)).toEqual([
      'section>h2::pseudo-before',
      'section>h2::text',
      'section>h2::pseudo-after',
    ]);
    const content = host.children[1]!;
    expect(content.tag).toBe('h2');
    expect(content.role).toBe('heading');
    expect(content.textRuns[0]!.text).toBe('Title');
    expect(res.pseudo_synthesized).toHaveLength(2);
  });

  it('text-bearing host with promoted inner blocks: children are [content, promoted, after] — ONE root (P2-a)', () => {
    const innerBlock = node({ source_path: 'p>div', tag: 'div', textRuns: [run('callout')] });
    const p = withPseudo(
      node({ source_path: 'p', tag: 'p', textRuns: [run('intro')], children: [innerBlock] }),
      { after: dotCapture() },
    );
    const res = normalizeIr([p], ctx());
    // Pre-P2-a this spilled ['p', 'p>div', 'p::pseudo-after'] as THREE top-level roots (the page
    // 2658 stray-sibling ghosting). Everything must stay inside the single restructured root.
    expect(res.ir.map((n) => n.source_path)).toEqual(['p']);
    expect(res.ir[0]!.children.map((c) => c.source_path)).toEqual([
      'p::text',
      'p>div',
      'p::pseudo-after',
    ]);
  });

  it('unrepresentable pseudos: honest drop with reason pseudo_unrepresentable + warning (I3)', () => {
    const arrow = withPseudo(node({ source_path: 'a', tag: 'a', textRuns: [run('More')] }), {
      after: dotCapture({ content: '"→"' }),
    });
    const masked = withPseudo(node({ source_path: 'div', tag: 'div' }), {
      before: dotCapture({ 'mask-image': 'url("icon.svg")' }),
    });
    const res = normalizeIr(
      [node({ source_path: 'r', tag: 'section', children: [arrow, masked] })],
      ctx(),
    );
    expect(res.pseudo_synthesized).toEqual([]);
    expect(res.pseudo_drops).toEqual([
      {
        source_path: 'a',
        pseudo: 'after',
        content: '"→"',
        reason: 'pseudo_unrepresentable',
        detail: 'text content ("→")',
      },
      {
        source_path: 'div',
        pseudo: 'before',
        reason: 'pseudo_unrepresentable',
        content: '""',
        detail: 'mask-bearing',
      },
    ]);
    expect(res.warnings.some((w) => w.includes('pseudo_unrepresentable'))).toBe(true);
    // no node was synthesized anywhere
    expect(JSON.stringify(res.ir)).not.toContain('pseudo-');
  });

  it('a styleless wrapper carrying a pseudo capture is NEVER unwrapped', () => {
    const inner = node({ source_path: 'div>p', tag: 'p', textRuns: [run('x')] });
    const wrapper = withPseudo(node({ source_path: 'div', tag: 'div', children: [inner] }), {
      before: dotCapture(),
    });
    const res = normalizeIr([wrapper], ctx({ unwrap_redundant: true }));
    expect(res.ir[0]!.source_path).toBe('div');
    expect(res.ir[0]!.children.map((c) => c.source_path)).toEqual(['div::pseudo-before', 'div>p']);
  });

  it('idempotence: the pseudo fields are consumed — a second pass synthesizes nothing', () => {
    const container = withPseudo(
      node({ source_path: 'div', tag: 'div', computed: { display: 'flex' } }),
      { before: dotCapture() },
    );
    const first = normalizeIr([container], ctx());
    expect(first.pseudo_synthesized).toHaveLength(1);
    const second = normalizeIr(first.ir, ctx());
    expect(second.pseudo_synthesized).toEqual([]);
    expect(second.pseudo_drops).toEqual([]);
    expect(JSON.stringify(second.ir)).toEqual(JSON.stringify(first.ir));
  });

  it('a pseudo-only box is not mistaken for whitespace and survives the root filter', () => {
    const spacer = withPseudo(node({ source_path: 'span', tag: 'span' }), {
      after: dotCapture(),
    });
    const res = normalizeIr([spacer], ctx());
    expect(res.ir.map((n) => n.source_path)).toEqual(['span']);
    expect(res.ir[0]!.children.map((c) => c.source_path)).toEqual(['span::pseudo-after']);
  });

  it('PseudoKind covers exactly before/after (placement contract)', () => {
    const kinds: PseudoKind[] = ['before', 'after'];
    expect(kinds).toHaveLength(2);
  });
});

/* ─────────────────── Contract 18 §7 P2-a/P2-b — attachment placement guards ─────────────────── */

describe('normalize: P2-a — synthesized/promoted nodes never spill to top level', () => {
  it('a text-bearing FOREST ROOT with promotions + pseudos yields exactly ONE top-level node', () => {
    // The page 2658 probe: stray top-level siblings after the root (69px + 68px, one holding a
    // paragraph) added +20px page height and dominated the odiff. The corpus guard is structural:
    // input root count == output root count, every attachment INSIDE the host at the correct index.
    const block = node({
      source_path: 'root>div',
      tag: 'div',
      box: { x: 0, y: 20, width: 600, height: 69 },
      textRuns: [run('callout paragraph')],
    });
    const root = withPseudo(
      node({
        source_path: 'root',
        tag: 'p',
        textRuns: [run('lead text')],
        children: [block],
      }),
      { before: dotCapture({ width: '28px', height: '2px' }), after: dotCapture() },
    );
    const res = normalizeIr([root], ctx());
    expect(res.ir).toHaveLength(1); // ONE root — nothing strays to top level
    const host = res.ir[0]!;
    expect(host.source_path).toBe('root');
    expect(host.children.map((c) => c.source_path)).toEqual([
      'root::pseudo-before',
      'root::text',
      'root>div',
      'root::pseudo-after',
    ]);
    // the moved block keeps its real geometry/content (it is the REAL node, not a husk).
    expect(host.children[2]!.box.height).toBe(69);
    expect(host.children[2]!.textRuns[0]!.text).toBe('callout paragraph');
    expect(res.promotions).toHaveLength(1);
    expect(res.pseudo_synthesized).toHaveLength(2);
  });

  it('host identity survives the restructure: source_path, attrs (anchor ids), computed, probes', () => {
    const block = node({ source_path: 'p>div', tag: 'div', textRuns: [run('x')] });
    const host = node({
      source_path: 'p',
      tag: 'p',
      attrs: { id: 'pricing', class: 'lede' },
      computed: { 'background-color': 'rgb(10, 20, 30)', 'font-size': '19px' },
      textRuns: [run('text')],
      children: [block],
    });
    const res = normalizeIr([host], ctx());
    const out = res.ir[0]!;
    // The container keeps the host's identity — in-page anchors (#pricing) and styles stay intact.
    expect(out.source_path).toBe('p');
    expect(out.attrs['id']).toBe('pricing');
    expect(out.computed['background-color']).toBe('rgb(10, 20, 30)');
    // The content leaf inherits the host typography baseline.
    const content = out.children.find((c) => c.source_path === 'p::text')!;
    expect(content.computed['font-size']).toBe('19px');
    expect(content.computed).not.toHaveProperty('background-color'); // layout/paint NOT copied
  });

  it('LEAF-forcing host tags (h1-6/button/li) retag to div; the ::text leaf keeps the tag', () => {
    for (const tag of ['h3', 'button', 'li']) {
      const block = node({ source_path: `${tag}>div`, tag: 'div', textRuns: [run('inner')] });
      const host = node({
        source_path: tag,
        tag,
        textRuns: [run('label')],
        children: [block],
      });
      const res = normalizeIr([host], ctx());
      const out = res.ir[0]!;
      expect(out.tag).toBe('div'); // CLASSIFY would force a leaf widget on the original tag
      const content = out.children[0]!;
      expect(content.source_path).toBe(`${tag}::text`);
      expect(content.tag).toBe(tag); // semantics survive on the text-carrying leaf
    }
    // container-safe text tags keep their own tag (CLASSIFY falls through to layout signals).
    for (const tag of ['p', 'span', 'blockquote', 'a']) {
      const block = node({ source_path: `${tag}>div`, tag: 'div', textRuns: [run('inner')] });
      const host = node({ source_path: tag, tag, textRuns: [run('label')], children: [block] });
      const res = normalizeIr([host], ctx());
      expect(res.ir[0]!.tag).toBe(tag);
    }
  });

  it('restructure preserves TextRun.color + linkHref/linkTarget on the ::text content leaf', () => {
    // Cluster A (parse) attaches per-run accent color (contract 17 #8) and inline-link capture —
    // the restructure must carry both onto the synthesized content leaf, not drop them.
    const accent = { text: 'accent', inlineTags: ['em'], color: 'rgb(12, 107, 74)' };
    const linked = {
      text: 'changelog',
      inlineTags: ['a'],
      linkHref: '/changelog',
      linkTarget: '_blank',
    };
    const block = node({ source_path: 'p>div', tag: 'div', textRuns: [run('blk')] });
    const host = node({
      source_path: 'p',
      tag: 'p',
      textRuns: [run('lead '), accent, linked],
      children: [block],
    });
    const res = normalizeIr([host], ctx({ base_url: 'https://ex.com/' }));
    const content = res.ir[0]!.children.find((c) => c.source_path === 'p::text')!;
    const runs = content.textRuns as (TextRun & { linkHref?: string; linkTarget?: string })[];
    expect(runs.map((r) => r.text)).toEqual(['lead ', 'accent', 'changelog']);
    expect(runs[1]!.color).toBe('rgb(12, 107, 74)');
    expect(runs[2]!.linkHref).toBe('https://ex.com/changelog');
    expect(runs[2]!.linkTarget).toBe('_blank');
  });

  it('a restructured tree is idempotent (second pass: no records, byte-stable)', () => {
    const block = node({ source_path: 'p>div', tag: 'div', textRuns: [run('blk')] });
    const host = withPseudo(
      node({ source_path: 'p', tag: 'p', textRuns: [run('lead')], children: [block] }),
      { before: dotCapture() },
    );
    const first = normalizeIr([host], ctx());
    expect(first.promotions).toHaveLength(1);
    expect(first.pseudo_synthesized).toHaveLength(1);
    const second = normalizeIr(first.ir, ctx());
    expect(second.promotions).toHaveLength(0);
    expect(second.pseudo_synthesized).toHaveLength(0);
    expect(JSON.stringify(second.ir)).toEqual(JSON.stringify(first.ir));
  });
});

describe('normalize: P2-b — inline/inline-flex host pseudo is its FIRST CHILD', () => {
  it('eyebrow fixture: the ::before dash lands as the FIRST CHILD of the inline-flex host', () => {
    // Driftwell `.eyebrow` (display:inline-flex; gap:10px) with a 28×2px ::before dash. Sibling
    // placement rendered the dash as a block at the SECTION's top-left; as the host's first child
    // it stays in the host's own inline-flex flow, right before the text.
    const eyebrow = withPseudo(
      node({
        source_path: 'section>p',
        tag: 'p',
        computed: {
          display: 'inline-flex',
          'align-items': 'center',
          gap: '10px',
          'font-size': '13px',
          'letter-spacing': '0.14em',
        },
        textRuns: [run('Sleep science, in your pocket')],
      }),
      { before: dotCapture({ width: '28px', height: '2px', display: 'inline-block' }) },
    );
    const section = node({ source_path: 'section', tag: 'section', children: [eyebrow] });
    const res = normalizeIr([section], ctx());
    const host = res.ir[0]!.children[0]!;
    expect(host.source_path).toBe('section>p');
    // the host keeps its inline-flex layout — the dash participates in ITS flow, not the parent's.
    expect(host.computed['display']).toBe('inline-flex');
    expect(host.children.map((c) => c.source_path)).toEqual([
      'section>p::pseudo-before',
      'section>p::text',
    ]);
    const dash = host.children[0]!;
    expect(dash.computed['width']).toBe('28px');
    expect(dash.computed['height']).toBe('2px');
    expect(host.children[1]!.textRuns[0]!.text).toBe('Sleep science, in your pocket');
  });

  it('inline host ::after is the LAST child, after the content leaf', () => {
    const tagPill = withPseudo(
      node({
        source_path: 'span',
        tag: 'span',
        computed: { display: 'inline-flex' },
        textRuns: [run('New')],
      }),
      { after: dotCapture({ width: '6px', height: '6px' }) },
    );
    const res = normalizeIr([tagPill], ctx());
    expect(res.ir).toHaveLength(1);
    expect(res.ir[0]!.children.map((c) => c.source_path)).toEqual([
      'span::text',
      'span::pseudo-after',
    ]);
  });
});
