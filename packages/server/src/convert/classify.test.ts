/**
 * WP-H05 — CLASSIFY stage tests.
 *
 * PURE unit tests against hand-authored IR fixtures (no Chromium, no I/O — `classifyIr`/`classifyNode`
 * are pure transforms; ticket Parallelization Notes: unit-testable against hand-authored IR the moment
 * WP-H01 lands; corpus runtime is WP-H10's). The fixtures mirror the WP-H12 corpus section structures
 * (hero, pricing card, feature grid, cta banner, rich-text card) so the deterministic classifier is
 * exercised against realistic marketing shapes.
 *
 * Covers the acceptance criteria:
 *   - role-assignment matrix for each tag / display / ARIA / class-hint case;
 *   - flex-row for horizontal children, grid for true 2D, flex default for ambiguous 1D;
 *   - tabs & accordion pairing count;
 *   - AI-hint accept (consistent) / reject (inconsistent) recorded in role_overrides + warnings;
 *   - suggestName slug derivation + label-rule compliance (never g-<hex>, 2-50, no leading digit,
 *     not reserved `container`);
 *   - determinism + purity (no I/O).
 */

import { describe, expect, it } from 'vitest';

import {
  classifyIr,
  classifyNode,
  computeTabPairing,
  detectBehaviors,
  detectUndetectableClasses,
  suggestName,
} from './classify.js';
import type { AiRoleHint, BoxRect, DetectedBehavior, IrNode, SemanticRole } from './types.js';

/* ─────────────────────────── tiny IR builders ───────────────────────────────────────────────── */

const ZERO_BOX: BoxRect = { x: 0, y: 0, width: 0, height: 0 };

function box(x: number, y: number, width: number, height: number): BoxRect {
  return { x, y, width, height };
}

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
    ...(partial.listeners !== undefined ? { listeners: partial.listeners } : {}),
    ...(partial.animationProbe !== undefined ? { animationProbe: partial.animationProbe } : {}),
    ...(partial.transitionProbe !== undefined ? { transitionProbe: partial.transitionProbe } : {}),
  };
}

function cls(c: string): Record<string, string> {
  return { class: c };
}

function withText(t: string): { text: string; inlineTags: string[] }[] {
  return [{ text: t, inlineTags: [] }];
}

/* ─────────────────────────── tag-based role matrix ──────────────────────────────────────────── */

describe('classify: tag → role matrix', () => {
  const cases: Array<[string, Partial<IrNode>, SemanticRole]> = [
    ['h1 → heading', { tag: 'h1' }, 'heading'],
    ['h3 → heading', { tag: 'h3' }, 'heading'],
    ['p → text', { tag: 'p' }, 'text'],
    ['span → text', { tag: 'span', textRuns: withText('hi') }, 'text'],
    ['img → image', { tag: 'img' }, 'image'],
    ['svg → icon-svg', { tag: 'svg' }, 'icon-svg'],
    ['button → button', { tag: 'button' }, 'button'],
    ['hr → divider', { tag: 'hr' }, 'divider'],
    ['video → media-embed-video', { tag: 'video' }, 'media-embed-video'],
    ['ul → list', { tag: 'ul' }, 'list'],
    ['ol → list', { tag: 'ol' }, 'list'],
    ['li → list-item', { tag: 'li' }, 'list-item'],
    ['table → table', { tag: 'table' }, 'table'],
    ['nav → nav-menu', { tag: 'nav' }, 'nav-menu'],
    ['form → form', { tag: 'form' }, 'form'],
    ['input → form-field', { tag: 'input' }, 'form-field'],
    ['textarea → form-field', { tag: 'textarea' }, 'form-field'],
    ['select → form-field', { tag: 'select' }, 'form-field'],
    ['details → accordion', { tag: 'details' }, 'accordion'],
    ['summary → accordion-item', { tag: 'summary' }, 'accordion-item'],
  ];

  for (const [name, partial, expected] of cases) {
    it(name, () => {
      expect(classifyNode(node({ source_path: 's', tag: 'x', ...partial }))).toBe(expected);
    });
  }

  it('a (empty, no text/children) → link by default', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'a', attrs: { href: '/x' } }))).toBe('link');
  });

  it('a runless text-tag WRAPPER with element children is NOT text (the spark-icon class)', () => {
    // Page-2439 regression: `<span class="spark"><svg/></span>` classified 'text' by tag → mapped
    // to a LEAF e-paragraph → the svg child silently vanished. A runless wrapper must fall through
    // to the structural signals (here: inline-flex → a layout container; the svg child survives).
    const spark = node({
      source_path: 's>span',
      tag: 'span',
      computed: { display: 'inline-flex' },
      children: [node({ source_path: 's>span>svg', tag: 'svg' })],
    });
    expect(classifyNode(spark)).not.toBe('text');
    // A genuinely texty span (runs, no element children) still classifies text.
    expect(
      classifyNode(node({ source_path: 't', tag: 'span', textRuns: withText('hi') })),
    ).toBe('text');
  });

  it('a plain leaf TEXT anchor (e.g. a nav link) → text (e-paragraph carries text+href, NO button chrome)', () => {
    expect(
      classifyNode(
        node({
          source_path: 's',
          tag: 'a',
          attrs: { href: '#', class: 'muted' },
          textRuns: [{ text: 'Features', inlineTags: [] }],
        }),
      ),
    ).toBe('text');
  });

  it('a BUTTON-LIKE text anchor (.btn) → button (keeps e-button chrome)', () => {
    expect(
      classifyNode(
        node({
          source_path: 's',
          tag: 'a',
          attrs: { href: '/start', class: 'btn btn-primary' },
          textRuns: [{ text: 'Start free trial', inlineTags: [] }],
        }),
      ),
    ).toBe('button');
  });

  it('a WRAPPING anchor (element children) stays link (an e-div-block link container)', () => {
    expect(
      classifyNode(
        node({
          source_path: 's',
          tag: 'a',
          attrs: { href: '/card' },
          children: [node({ source_path: 's>img', tag: 'img' })],
        }),
      ),
    ).toBe('link');
  });

  it('a.button → button (class-hinted anchor)', () => {
    expect(
      classifyNode(node({ source_path: 's', tag: 'a', attrs: cls('button button--solid') })),
    ).toBe('button');
  });

  it('a.btn → button', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'a', attrs: cls('btn') }))).toBe('button');
  });

  it('a.cta → button', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'a', attrs: cls('cta') }))).toBe('button');
  });

  it('iframe[youtube] → media-embed-youtube', () => {
    expect(
      classifyNode(
        node({
          source_path: 's',
          tag: 'iframe',
          attrs: { src: 'https://www.youtube.com/embed/abc' },
        }),
      ),
    ).toBe('media-embed-youtube');
  });

  it('iframe[youtu.be] → media-embed-youtube', () => {
    expect(
      classifyNode(
        node({ source_path: 's', tag: 'iframe', attrs: { src: 'https://youtu.be/abc' } }),
      ),
    ).toBe('media-embed-youtube');
  });

  it('iframe[non-youtube] → media-embed-video', () => {
    expect(
      classifyNode(
        node({ source_path: 's', tag: 'iframe', attrs: { src: 'https://example.com/x' } }),
      ),
    ).toBe('media-embed-video');
  });

  it('i.fa-star (icon font) → icon-svg', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'i', attrs: cls('fa fa-star') }))).toBe(
      'icon-svg',
    );
  });

  it('i with no icon class → not icon-svg', () => {
    // bare <i> is italic inline text; with no children/text it is undecidable → unknown
    expect(classifyNode(node({ source_path: 's', tag: 'i' }))).toBe('unknown');
  });
});

/* ─────────────────────────── ARIA precedence (precedence 1) ─────────────────────────────────── */

describe('classify: ARIA role precedence (beats tag)', () => {
  it('role=tablist → tabs', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'div', attrs: { role: 'tablist' } }))).toBe(
      'tabs',
    );
  });

  it('role=tab → tab', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'button', attrs: { role: 'tab' } }))).toBe(
      'tab',
    );
  });

  it('role=tabpanel → tab-content', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'div', attrs: { role: 'tabpanel' } }))).toBe(
      'tab-content',
    );
  });

  it('role=button on a div → button (ARIA over structural)', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'div', attrs: { role: 'button' } }))).toBe(
      'button',
    );
  });

  it('role=navigation → nav-menu', () => {
    expect(
      classifyNode(node({ source_path: 's', tag: 'div', attrs: { role: 'navigation' } })),
    ).toBe('nav-menu');
  });

  it('role=separator → divider', () => {
    expect(classifyNode(node({ source_path: 's', tag: 'div', attrs: { role: 'separator' } }))).toBe(
      'divider',
    );
  });
});

/* ─────────────────────────── display + class hints + geometry ───────────────────────────────── */

describe('classify: layout (display / class / geometry)', () => {
  it('display:flex row → flex-row', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      computed: { display: 'flex', 'flex-direction': 'row' },
      children: [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 50) }),
        node({ source_path: 'b', tag: 'div', box: box(110, 0, 100, 50) }),
      ],
    });
    expect(classifyNode(c)).toBe('flex-row');
  });

  it('display:flex column → flex-col', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      computed: { display: 'flex', 'flex-direction': 'column' },
      children: [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 100, 50) }),
        node({ source_path: 'b', tag: 'div', box: box(0, 60, 100, 50) }),
      ],
    });
    expect(classifyNode(c)).toBe('flex-col');
  });

  it('horizontally-laid block children (dirty CSS, no flex) → flex-row via geometry', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      computed: { display: 'block' },
      children: [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 200, 100) }),
        node({ source_path: 'b', tag: 'div', box: box(220, 0, 200, 100) }),
      ],
    });
    expect(classifyNode(c)).toBe('flex-row');
  });

  it('true 2D grid → grid', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      computed: {
        display: 'grid',
        'grid-template-columns': '1fr 1fr',
        'grid-template-rows': '1fr 1fr',
      },
      children: [
        node({ source_path: 'r1c1', tag: 'div', box: box(0, 0, 100, 100) }),
        node({ source_path: 'r1c2', tag: 'div', box: box(110, 0, 100, 100) }),
        node({ source_path: 'r2c1', tag: 'div', box: box(0, 110, 100, 100) }),
        node({ source_path: 'r2c2', tag: 'div', box: box(110, 110, 100, 100) }),
      ],
    });
    expect(classifyNode(c)).toBe('grid');
  });

  it('ambiguous 1D grid display (single column track) defaults to flex, not grid', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      computed: { display: 'grid', 'grid-template-columns': '1fr' },
      children: [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 400, 100) }),
        node({ source_path: 'b', tag: 'div', box: box(0, 110, 400, 100) }),
      ],
    });
    // not a true 2D grid → falls to flex-col via geometry (stacked)
    expect(classifyNode(c)).toBe('flex-col');
  });

  it('class .row → flex-row', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      attrs: cls('row'),
      children: [node({ source_path: 'a', tag: 'div' })],
    });
    expect(classifyNode(c)).toBe('flex-row');
  });

  it('class .col → flex-col', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      attrs: cls('col'),
      children: [node({ source_path: 'a', tag: 'div' })],
    });
    expect(classifyNode(c)).toBe('flex-col');
  });

  it('class .card → structural-block', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      attrs: cls('card'),
      children: [node({ source_path: 'a', tag: 'p' })],
    });
    expect(classifyNode(c)).toBe('structural-block');
  });

  it('a div with block children defaults to structural-block', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      computed: { display: 'block' },
      children: [node({ source_path: 'a', tag: 'p', box: box(0, 0, 400, 30) })],
    });
    expect(classifyNode(c)).toBe('structural-block');
  });

  it('an empty undecidable div → unknown (never throws)', () => {
    expect(classifyNode(node({ source_path: 'c', tag: 'div' }))).toBe('unknown');
  });
});

/* ─────────────────────────── hero fixture (mirrors corpus 01-hero) ──────────────────────────── */

function heroFixture(): IrNode {
  return node({
    source_path: 'section',
    tag: 'section',
    attrs: cls('hero'),
    computed: { display: 'block' },
    children: [
      node({
        source_path: 'section/inner',
        tag: 'div',
        attrs: cls('hero__inner'),
        computed: { display: 'flex', 'flex-direction': 'row', gap: '48px' },
        box: box(0, 0, 1200, 520),
        children: [
          node({
            source_path: 'section/inner/copy',
            tag: 'div',
            attrs: cls('hero__copy'),
            computed: { display: 'flex', 'flex-direction': 'column' },
            box: box(0, 0, 600, 520),
            children: [
              node({
                source_path: 'eyebrow',
                tag: 'p',
                attrs: cls('hero__eyebrow'),
                textRuns: withText('New'),
              }),
              node({
                source_path: 'title',
                tag: 'h1',
                attrs: cls('hero__title'),
                textRuns: withText('Ship marketing pages'),
              }),
              node({
                source_path: 'lead',
                tag: 'p',
                attrs: cls('hero__lead'),
                textRuns: withText('Turn any HTML section'),
              }),
              node({
                source_path: 'actions',
                tag: 'div',
                attrs: cls('hero__actions'),
                computed: { display: 'flex', 'flex-direction': 'row', gap: '12px' },
                box: box(0, 300, 600, 50),
                children: [
                  node({
                    source_path: 'cta1',
                    tag: 'a',
                    attrs: cls('button button--solid'),
                    textRuns: withText('Start free'),
                  }),
                  node({
                    source_path: 'cta2',
                    tag: 'a',
                    attrs: cls('button button--ghost'),
                    textRuns: withText('Watch the demo'),
                  }),
                ],
              }),
            ],
          }),
          node({
            source_path: 'section/inner/media',
            tag: 'div',
            attrs: cls('hero__media'),
            box: box(620, 0, 580, 520),
            children: [
              node({
                source_path: 'img',
                tag: 'img',
                attrs: { class: 'hero__img', alt: 'preview' },
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

describe('classify: hero fixture (corpus 01-hero shape)', () => {
  it('assigns decisive roles end-to-end', () => {
    const result = classifyIr([heroFixture()], { infer_flex: true });
    const byPath = new Map<string, SemanticRole>();
    const walk = (n: IrNode): void => {
      byPath.set(n.source_path, n.role);
      n.children.forEach(walk);
    };
    result.ir.forEach(walk);

    expect(byPath.get('section')).toBe('structural-block');
    expect(byPath.get('section/inner')).toBe('flex-row');
    expect(byPath.get('section/inner/copy')).toBe('flex-col');
    expect(byPath.get('title')).toBe('heading');
    expect(byPath.get('eyebrow')).toBe('text');
    expect(byPath.get('actions')).toBe('flex-row');
    expect(byPath.get('cta1')).toBe('button');
    expect(byPath.get('cta2')).toBe('button');
    expect(byPath.get('img')).toBe('image');
  });

  it('every node has a non-unknown role (signals decisive)', () => {
    const result = classifyIr([heroFixture()], { infer_flex: true });
    const roles: SemanticRole[] = [];
    const walk = (n: IrNode): void => {
      roles.push(n.role);
      n.children.forEach(walk);
    };
    result.ir.forEach(walk);
    expect(roles).not.toContain('unknown');
  });
});

/* ─────────────────────────── tabs & accordion pairing ───────────────────────────────────────── */

describe('classify: tabs pairing', () => {
  function tabsFixture(menuCount: number, panelCount: number): IrNode {
    const tabs: IrNode[] = [];
    for (let i = 0; i < menuCount; i += 1) {
      tabs.push(node({ source_path: `tab${i}`, tag: 'button', attrs: { role: 'tab' } }));
    }
    const panels: IrNode[] = [];
    for (let i = 0; i < panelCount; i += 1) {
      panels.push(node({ source_path: `panel${i}`, tag: 'div', attrs: { role: 'tabpanel' } }));
    }
    return node({
      source_path: 'tabs',
      tag: 'div',
      attrs: { role: 'tablist' },
      children: [node({ source_path: 'menu', tag: 'div', children: tabs }), ...panels],
    });
  }

  it('matched menu/panel counts → paired true', () => {
    const result = classifyIr([tabsFixture(3, 3)], { infer_flex: true });
    const pairing = computeTabPairing(result.ir);
    expect(pairing['tabs']).toBe(true);
  });

  it('mismatched menu/panel counts → paired false', () => {
    const result = classifyIr([tabsFixture(3, 2)], { infer_flex: true });
    const pairing = computeTabPairing(result.ir);
    expect(pairing['tabs']).toBe(false);
  });

  it('accordion details/summary pairing computed', () => {
    const acc = node({
      source_path: 'acc',
      tag: 'details',
      children: [
        node({ source_path: 'sum', tag: 'summary', textRuns: withText('Q') }),
        node({ source_path: 'body', tag: 'div', textRuns: withText('A') }),
      ],
    });
    const result = classifyIr([acc], { infer_flex: true });
    const pairing = computeTabPairing(result.ir);
    expect(pairing['acc']).toBe(true);
  });

  it('accordion with a summary but no content → not paired', () => {
    const acc = node({
      source_path: 'acc',
      tag: 'details',
      children: [node({ source_path: 'sum', tag: 'summary', textRuns: withText('Q') })],
    });
    const result = classifyIr([acc], { infer_flex: true });
    expect(computeTabPairing(result.ir)['acc']).toBe(false);
  });
});

/* ─────────────────────────── AI-hint seam (accept / reject) ─────────────────────────────────── */

describe('classify: AI-hint seam', () => {
  it('adopts a consistent layout-family refinement (structural → flex-row on a div)', () => {
    const c = node({
      source_path: 'amb',
      tag: 'div',
      computed: { display: 'block' },
      children: [node({ source_path: 'x', tag: 'p' })],
    });
    const hints: AiRoleHint[] = [{ source_path: 'amb', role: 'flex-row', confidence: 0.9 }];
    const result = classifyIr([c], { infer_flex: true, ai_hints: hints });
    expect(result.ir[0]?.role).toBe('flex-row');
    const accepted = result.role_overrides.find(
      (o) => o.source === 'ai' && o.source_path === 'amb',
    );
    expect(accepted?.accepted).toBe(true);
    expect(accepted?.to).toBe('flex-row');
  });

  it('REJECTS an AI hint that contradicts a decisive tag (button hint on an h1)', () => {
    const h1 = node({ source_path: 'h', tag: 'h1', textRuns: withText('Title') });
    const hints: AiRoleHint[] = [{ source_path: 'h', role: 'button' }];
    const result = classifyIr([h1], { infer_flex: true, ai_hints: hints });
    expect(result.ir[0]?.role).toBe('heading'); // deterministic wins
    const ov = result.role_overrides.find((o) => o.source === 'ai' && o.source_path === 'h');
    expect(ov?.accepted).toBe(false);
    expect(
      result.warnings.some((w) => w.includes('rejected AI role hint') && w.includes('h')),
    ).toBe(true);
  });

  it('REJECTS an AI hint that contradicts a decisive tag (heading hint on an img)', () => {
    const img = node({ source_path: 'i', tag: 'img', attrs: { alt: 'x' } });
    const result = classifyIr([img], {
      infer_flex: true,
      ai_hints: [{ source_path: 'i', role: 'heading' }],
    });
    expect(result.ir[0]?.role).toBe('image');
    expect(result.role_overrides.find((o) => o.source_path === 'i')?.accepted).toBe(false);
  });

  it('REJECTS an AI grid hint on a node that is not a true 2D grid', () => {
    const c = node({
      source_path: 'amb',
      tag: 'div',
      computed: { display: 'block' },
      children: [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 200, 100) }),
        node({ source_path: 'b', tag: 'div', box: box(210, 0, 200, 100) }),
      ],
    });
    const result = classifyIr([c], {
      infer_flex: true,
      ai_hints: [{ source_path: 'amb', role: 'grid' }],
    });
    expect(result.ir[0]?.role).not.toBe('grid');
    expect(result.role_overrides.find((o) => o.source_path === 'amb')?.accepted).toBe(false);
  });

  it('a hint equal to the deterministic role is not recorded as a conflict', () => {
    const h1 = node({ source_path: 'h', tag: 'h1', textRuns: withText('T') });
    const result = classifyIr([h1], {
      infer_flex: true,
      ai_hints: [{ source_path: 'h', role: 'heading' }],
    });
    expect(result.ir[0]?.role).toBe('heading');
    expect(result.role_overrides.filter((o) => o.source === 'ai').length).toBe(0);
  });

  it('with no hints classification is fully deterministic (no ai overrides)', () => {
    const result = classifyIr([heroFixture()], { infer_flex: true });
    expect(result.role_overrides.every((o) => o.source === 'deterministic')).toBe(true);
  });
});

/* ─────────────────────────── suggestName (Anima/Locofy smart naming) ────────────────────────── */

describe('classify: suggestName', () => {
  it('derives a slug from a valid source class', () => {
    expect(suggestName(node({ source_path: 's', tag: 'div', attrs: cls('hero__inner') }))).toBe(
      'hero-inner',
    );
  });

  it('falls back to the role slug when there is no usable class', () => {
    expect(suggestName(node({ source_path: 's', tag: 'div', role: 'flex-row' }))).toBe('row');
  });

  it('combines role + leading text for a heading', () => {
    const name = suggestName(
      node({
        source_path: 's',
        tag: 'h1',
        role: 'heading',
        textRuns: withText('Ship marketing pages'),
      }),
    );
    expect(name.startsWith('heading-')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(50);
  });

  it('never returns a g-<hex> name', () => {
    const names = [
      suggestName(node({ source_path: 's', tag: 'div', attrs: cls('card') })),
      suggestName(node({ source_path: 's', tag: 'div', role: 'structural-block' })),
      suggestName(node({ source_path: 's', tag: 'p', role: 'text', textRuns: withText('hello') })),
    ];
    for (const n of names) expect(/^g-[0-9a-f]+$/.test(n)).toBe(false);
  });

  it('rejects the reserved label `container` and falls back to the role slug', () => {
    const name = suggestName(
      node({ source_path: 's', tag: 'div', role: 'structural-block', attrs: cls('container') }),
    );
    expect(name).not.toBe('container');
    expect(name).toBe('block');
  });

  it('strips a leading digit (R7: no leading digit)', () => {
    const name = suggestName(
      node({ source_path: 's', tag: 'div', role: 'structural-block', attrs: cls('3col-grid') }),
    );
    expect(/^[a-z]/.test(name)).toBe(true);
    expect(name).toBe('col-grid');
  });

  it('always produces a label within 2-50 chars', () => {
    const longClass = 'a'.repeat(80);
    const name = suggestName(
      node({ source_path: 's', tag: 'div', role: 'structural-block', attrs: cls(longClass) }),
    );
    expect(name.length).toBeGreaterThanOrEqual(2);
    expect(name.length).toBeLessThanOrEqual(50);
  });

  it('all role slugs are valid labels (2-50, leading letter, not reserved)', () => {
    const roles: SemanticRole[] = [
      'structural-block',
      'flex-row',
      'flex-col',
      'grid',
      'heading',
      'text',
      'image',
      'button',
      'link',
      'divider',
      'icon-svg',
      'media-embed-youtube',
      'media-embed-video',
      'tabs',
      'tab',
      'tab-content',
      'form',
      'form-field',
      'nav-menu',
      'list',
      'list-item',
      'table',
      'accordion',
      'accordion-item',
      'unknown',
    ];
    for (const role of roles) {
      const name = suggestName(node({ source_path: 's', tag: 'div', role }));
      expect(name.length).toBeGreaterThanOrEqual(2);
      expect(name.length).toBeLessThanOrEqual(50);
      expect(/^[a-z]/.test(name)).toBe(true);
      expect(name).not.toBe('container');
    }
  });
});

/* ─────────────────────────── infer_flex:false behaviour ─────────────────────────────────────── */

describe('classify: infer_flex flag', () => {
  it('infer_flex:false does NOT infer flex from geometry (dirty CSS → structural-block)', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      computed: { display: 'block' },
      children: [
        node({ source_path: 'a', tag: 'div', box: box(0, 0, 200, 100) }),
        node({ source_path: 'b', tag: 'div', box: box(220, 0, 200, 100) }),
      ],
    });
    expect(classifyIr([c], { infer_flex: false }).ir[0]?.role).toBe('structural-block');
    expect(classifyIr([c], { infer_flex: true }).ir[0]?.role).toBe('flex-row');
  });

  it('infer_flex:false still honors explicit display:flex', () => {
    const c = node({
      source_path: 'c',
      tag: 'div',
      computed: { display: 'flex', 'flex-direction': 'column' },
      children: [node({ source_path: 'a', tag: 'div' }), node({ source_path: 'b', tag: 'div' })],
    });
    expect(classifyIr([c], { infer_flex: false }).ir[0]?.role).toBe('flex-col');
  });
});

/* ─────────────────────────── behavior detection (contract 16 §2) ────────────────────────────── */

/** All behaviors attached anywhere in a classified forest, with the carrying node's path. */
function collectBehaviors(roots: IrNode[]): Array<{ path: string; behavior: DetectedBehavior }> {
  const out: Array<{ path: string; behavior: DetectedBehavior }> = [];
  const walk = (n: IrNode): void => {
    for (const b of n.behaviors ?? []) out.push({ path: n.source_path, behavior: b });
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

describe('classify: behavior detection — tabs via ARIA role', () => {
  /** tablist + panels under a shared wrapper (the realistic shape: panels are tablist SIBLINGS). */
  function ariaTabsFixture(): IrNode {
    return node({
      source_path: 'wrap',
      tag: 'div',
      children: [
        node({
          source_path: 'wrap/menu',
          tag: 'div',
          attrs: { role: 'tablist' },
          children: [
            node({ source_path: 'wrap/menu/t1', tag: 'button', attrs: { role: 'tab' } }),
            node({ source_path: 'wrap/menu/t2', tag: 'button', attrs: { role: 'tab' } }),
          ],
        }),
        node({
          source_path: 'wrap/p1',
          tag: 'div',
          attrs: { role: 'tabpanel' },
          textRuns: withText('Panel one'),
        }),
        node({
          source_path: 'wrap/p2',
          tag: 'div',
          attrs: { role: 'tabpanel' },
          textRuns: withText('Panel two'),
        }),
      ],
    });
  }

  it('attaches a high-confidence tabs behavior to the pattern ROOT (minimal common ancestor)', () => {
    const result = classifyIr([ariaTabsFixture()], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('wrap'); // NOT the tablist — panels are its siblings
    const b = found[0]?.behavior;
    expect(b?.kind).toBe('tabs');
    expect(b?.confidence).toBe('high');
    expect(b?.evidence).toContain('role=tablist');
    expect(b?.evidence).toContain('role=tabpanel');
    // nodeIds carry trigger + panels
    expect(b?.nodeIds).toEqual(
      expect.arrayContaining(['wrap/menu', 'wrap/menu/t1', 'wrap/menu/t2', 'wrap/p1', 'wrap/p2']),
    );
    // detection leaves the tier unassigned (mapping's job)
    expect(b?.tier).toBeUndefined();
  });

  it('attaches to the tablist itself when it CONTAINS the panels', () => {
    const tablist = node({
      source_path: 'tabs',
      tag: 'div',
      attrs: { role: 'tablist' },
      children: [
        node({ source_path: 'tabs/t1', tag: 'button', attrs: { role: 'tab' } }),
        node({ source_path: 'tabs/p1', tag: 'div', attrs: { role: 'tabpanel' } }),
      ],
    });
    const result = classifyIr([tablist], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('tabs');
    expect(found[0]?.behavior.kind).toBe('tabs');
  });

  it('a tablist with NO panels anywhere is not a complete tabs pattern (no behavior)', () => {
    const lonely = node({
      source_path: 'menu',
      tag: 'div',
      attrs: { role: 'tablist' },
      children: [node({ source_path: 'menu/t1', tag: 'button', attrs: { role: 'tab' } })],
    });
    const result = classifyIr([lonely], { infer_flex: true });
    expect(collectBehaviors(result.ir)).toHaveLength(0);
  });
});

describe('classify: behavior detection — accordion via details/summary', () => {
  it('a <details><summary> pair → high-confidence accordion on the details node', () => {
    const acc = node({
      source_path: 'faq',
      tag: 'details',
      children: [
        node({ source_path: 'faq/q', tag: 'summary', textRuns: withText('Q?') }),
        node({ source_path: 'faq/a', tag: 'div', textRuns: withText('A.') }),
      ],
    });
    const result = classifyIr([acc], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('faq');
    const b = found[0]?.behavior;
    expect(b?.kind).toBe('accordion');
    expect(b?.confidence).toBe('high');
    expect(b?.evidence).toContain('tag:details');
    expect(b?.evidence).toContain('tag:summary');
    expect(b?.nodeIds).toEqual(expect.arrayContaining(['faq', 'faq/q', 'faq/a']));
  });

  it('aria-expanded trigger + sibling panel → accordion at the shared parent', () => {
    const acc = node({
      source_path: 'item',
      tag: 'div',
      children: [
        node({
          source_path: 'item/btn',
          tag: 'button',
          attrs: { 'aria-expanded': 'false' },
          textRuns: withText('Toggle'),
        }),
        node({ source_path: 'item/panel', tag: 'div', textRuns: withText('Body') }),
      ],
    });
    const result = classifyIr([acc], { infer_flex: true });
    const found = collectBehaviors(result.ir).filter((f) => f.behavior.kind === 'accordion');
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('item');
    expect(found[0]?.behavior.evidence).toContain('aria-expanded');
    expect(found[0]?.behavior.nodeIds).toEqual(
      expect.arrayContaining(['item', 'item/btn', 'item/panel']),
    );
  });

  it('classname accordion|collapse → medium-confidence accordion (classname-only)', () => {
    const acc = node({
      source_path: 'acc',
      tag: 'div',
      attrs: cls('accordion'),
      children: [node({ source_path: 'acc/x', tag: 'div', textRuns: withText('x') })],
    });
    const result = classifyIr([acc], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.behavior.kind).toBe('accordion');
    expect(found[0]?.behavior.confidence).toBe('medium');
    expect(found[0]?.behavior.evidence).toContain('classname:accordion');
  });
});

describe('classify: behavior detection — carousel via classname', () => {
  function carouselFixture(extra?: Partial<IrNode>): IrNode {
    return node({
      source_path: 'car',
      tag: 'div',
      attrs: cls('swiper'),
      children: [
        node({ source_path: 'car/s1', tag: 'div', attrs: cls('swiper-slide') }),
        node({ source_path: 'car/s2', tag: 'div', attrs: cls('swiper-slide') }),
      ],
      ...extra,
    });
  }

  it('classname swiper → medium-confidence carousel on the root, slides in nodeIds', () => {
    const result = classifyIr([carouselFixture()], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('car');
    const b = found[0]?.behavior;
    expect(b?.kind).toBe('carousel');
    expect(b?.confidence).toBe('medium');
    expect(b?.evidence).toContain('classname:swiper');
    expect(b?.nodeIds).toEqual(expect.arrayContaining(['car', 'car/s1', 'car/s2']));
  });

  it('classname + runtime click listener raises confidence to high (multiple signals)', () => {
    const result = classifyIr([carouselFixture({ listeners: ['click'] })], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.behavior.confidence).toBe('high');
    expect(found[0]?.behavior.evidence).toEqual(
      expect.arrayContaining(['classname:swiper', 'listener:click']),
    );
  });

  it('the HIGHEST matching node claims the pattern (no nested duplicate from .swiper-slide…)', () => {
    // slick inside a 'carousel'-classed wrapper: only the wrapper claims
    const wrapper = node({
      source_path: 'w',
      tag: 'div',
      attrs: cls('hero-carousel'),
      children: [carouselFixture()],
    });
    const result = classifyIr([wrapper], { infer_flex: true });
    const carousels = collectBehaviors(result.ir).filter((f) => f.behavior.kind === 'carousel');
    expect(carousels).toHaveLength(1);
    expect(carousels[0]?.path).toBe('w');
  });
});

describe('classify: behavior detection — entrance animation via keyframes probe', () => {
  it('an animationProbe (PARSE @keyframes capture) → high-confidence entrance-animation', () => {
    const animated = node({
      source_path: 'hero',
      tag: 'div',
      textRuns: withText('Hi'),
      animationProbe: {
        name: 'fadeInUp',
        duration: '0.6s',
        delay: '0s',
        easing: 'ease-out',
        keyframeProps: ['opacity', 'transform'],
        opacity: { from: 0, to: 1 },
        transform: { from: 'translateY(20px)', to: 'none' },
      },
    });
    const result = classifyIr([animated], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    const b = found[0]?.behavior;
    expect(b?.kind).toBe('entrance-animation');
    expect(b?.confidence).toBe('high');
    expect(b?.evidence).toEqual(
      expect.arrayContaining(['keyframes:fadeInUp', 'animates:opacity+transform']),
    );
  });

  it('animation-library classname (animate__) → medium-confidence entrance-animation', () => {
    const aos = node({
      source_path: 'a',
      tag: 'div',
      attrs: cls('animate__animated animate__fadeIn'),
      textRuns: withText('x'),
    });
    const result = classifyIr([aos], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.behavior.kind).toBe('entrance-animation');
    expect(found[0]?.behavior.confidence).toBe('medium');
  });

  it('data-aos attribute counts as entrance evidence', () => {
    const aos = node({
      source_path: 'a',
      tag: 'div',
      attrs: { 'data-aos': 'fade-up' },
      textRuns: withText('x'),
    });
    const result = classifyIr([aos], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.behavior.kind).toBe('entrance-animation');
    expect(found[0]?.behavior.evidence).toContain('attr:data-aos');
  });

  it('short ambiguous hints match whole tokens only (class "chaos" is NOT aos)', () => {
    const notAos = node({
      source_path: 'n',
      tag: 'div',
      attrs: cls('chaos wowzers'),
      textRuns: withText('x'),
    });
    const result = classifyIr([notAos], { infer_flex: true });
    expect(collectBehaviors(result.ir)).toHaveLength(0);
  });
});

describe('classify: behavior detection — hover-effect, form, nav-toggle, video, custom-js', () => {
  it('hover delta + covering transition → high-confidence hover-effect', () => {
    const btn = node({
      source_path: 'b',
      tag: 'button',
      textRuns: withText('Go'),
      hoverComputed: { 'background-color': 'rgb(255, 0, 0)' },
      transitionProbe: { property: 'background-color', duration: '0.3s', easing: 'ease' },
    });
    const result = classifyIr([btn], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    const b = found[0]?.behavior;
    expect(b?.kind).toBe('hover-effect');
    expect(b?.confidence).toBe('high');
    expect(b?.evidence).toEqual(
      expect.arrayContaining([
        'hover-delta:background-color',
        'transition:background-color 0.3s',
      ]),
    );
  });

  it('hover delta WITHOUT a covering transition is NOT a behavior (static :hover styling)', () => {
    const btn = node({
      source_path: 'b',
      tag: 'button',
      textRuns: withText('Go'),
      hoverComputed: { 'background-color': 'rgb(255, 0, 0)' },
    });
    const result = classifyIr([btn], { infer_flex: true });
    expect(collectBehaviors(result.ir)).toHaveLength(0);
  });

  it('a transition on an UNRELATED prop does not make the hover delta a hover-effect', () => {
    const btn = node({
      source_path: 'b',
      tag: 'button',
      textRuns: withText('Go'),
      hoverComputed: { 'background-color': 'rgb(255, 0, 0)' },
      transitionProbe: { property: 'opacity', duration: '0.3s', easing: 'ease' },
    });
    const result = classifyIr([btn], { infer_flex: true });
    expect(collectBehaviors(result.ir)).toHaveLength(0);
  });

  it('<form> → high-confidence form behavior with its fields in nodeIds', () => {
    const form = node({
      source_path: 'f',
      tag: 'form',
      children: [
        node({ source_path: 'f/email', tag: 'input', attrs: { type: 'email' } }),
        node({ source_path: 'f/send', tag: 'button', textRuns: withText('Send') }),
      ],
    });
    const result = classifyIr([form], { infer_flex: true });
    const found = collectBehaviors(result.ir).filter((f) => f.behavior.kind === 'form');
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('f');
    expect(found[0]?.behavior.evidence).toContain('tag:form');
    expect(found[0]?.behavior.nodeIds).toEqual(expect.arrayContaining(['f', 'f/email']));
  });

  it('role=navigation + hamburger toggle button → high-confidence nav-toggle on the nav root', () => {
    const nav = node({
      source_path: 'nav',
      tag: 'nav',
      children: [
        node({
          source_path: 'nav/toggle',
          tag: 'button',
          attrs: { class: 'hamburger', 'aria-expanded': 'false' },
        }),
        node({
          source_path: 'nav/links',
          tag: 'ul',
          children: [node({ source_path: 'nav/links/li', tag: 'li', textRuns: withText('Home') })],
        }),
      ],
    });
    const result = classifyIr([nav], { infer_flex: true });
    const found = collectBehaviors(result.ir).filter((f) => f.behavior.kind === 'nav-toggle');
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe('nav');
    expect(found[0]?.behavior.confidence).toBe('high');
    expect(found[0]?.behavior.evidence).toEqual(
      expect.arrayContaining(['role=navigation', 'toggle-button', 'classname:hamburger']),
    );
    expect(found[0]?.behavior.nodeIds).toEqual(expect.arrayContaining(['nav', 'nav/toggle']));
  });

  it('a YouTube iframe → video-embed behavior (routed through the behavior report)', () => {
    const yt = node({
      source_path: 'v',
      tag: 'iframe',
      attrs: { src: 'https://www.youtube.com/embed/abc123' },
    });
    const result = classifyIr([yt], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.behavior.kind).toBe('video-embed');
    expect(found[0]?.behavior.evidence).toContain('media:youtube');
  });

  it('an unclaimed non-anchor click listener → low-confidence custom-js candidate trigger', () => {
    const div = node({
      source_path: 'd',
      tag: 'div',
      textRuns: withText('open'),
      listeners: ['click'],
    });
    const result = classifyIr([div], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.behavior.kind).toBe('custom-js');
    expect(found[0]?.behavior.confidence).toBe('low');
    expect(found[0]?.behavior.evidence).toEqual(['listener:click']);
  });

  it('a listener INSIDE a claimed pattern is the pattern trigger, not custom-js', () => {
    const car = node({
      source_path: 'car',
      tag: 'div',
      attrs: cls('swiper'),
      children: [
        node({ source_path: 'car/next', tag: 'div', listeners: ['click'] }),
        node({ source_path: 'car/s1', tag: 'div' }),
      ],
    });
    const result = classifyIr([car], { infer_flex: true });
    const kinds = collectBehaviors(result.ir).map((f) => f.behavior.kind);
    expect(kinds).toContain('carousel');
    expect(kinds).not.toContain('custom-js');
  });

  it('marquee tag and ticker classname detected', () => {
    const m1 = node({ source_path: 'm1', tag: 'marquee', textRuns: withText('news') });
    const m2 = node({
      source_path: 'm2',
      tag: 'div',
      attrs: cls('ticker'),
      textRuns: withText('news'),
    });
    const result = classifyIr([m1, m2], { infer_flex: true });
    const found = collectBehaviors(result.ir).filter((f) => f.behavior.kind === 'marquee');
    expect(found).toHaveLength(2);
    expect(found[0]?.behavior.confidence).toBe('high'); // tag
    expect(found[1]?.behavior.confidence).toBe('medium'); // classname
  });

  it('detectBehaviors returns exactly the behaviors it attached (count parity, §8 inv 1)', () => {
    const result = classifyIr(
      [
        node({
          source_path: 'f',
          tag: 'form',
          children: [node({ source_path: 'f/i', tag: 'input' })],
        }),
      ],
      { infer_flex: true },
    );
    // re-run detection on a stripped clone to compare returned vs attached
    const clone = JSON.parse(JSON.stringify(result.ir)) as IrNode[];
    const strip = (n: IrNode): void => {
      delete n.behaviors;
      n.children.forEach(strip);
    };
    clone.forEach(strip);
    const returned = detectBehaviors(clone);
    expect(returned).toHaveLength(collectBehaviors(clone).length);
    expect(returned).toEqual(collectBehaviors(result.ir).map((f) => f.behavior));
  });
});

/* ─────────────────────────── invariant 5 — zero-behavior regression ─────────────────────────── */

describe('classify: contract 16 §8 invariant 5 — zero-behavior pages are unchanged', () => {
  it('the corpus 01-hero fixture classifies with ZERO new optional fields (pure annotation)', () => {
    const result = classifyIr([heroFixture()], { infer_flex: true });
    const serialized = JSON.stringify(result);
    // none of the contract-16 optional fields may appear anywhere in the output
    for (const key of ['"behaviors"', '"animationProbe"', '"transitionProbe"', '"listeners"']) {
      expect(serialized, `unexpected contract-16 field ${key} on a zero-behavior fixture`).not.toContain(
        key,
      );
    }
  });

  it('classify output for the hero fixture is byte-identical except the new optional fields', () => {
    const result = classifyIr([heroFixture()], { infer_flex: true });
    // strip the (absent) optional fields and assert deep equality — i.e. the ONLY thing contract 16
    // could have changed is additive optional fields, and on a zero-behavior fixture even those are
    // absent, so the output equals its own stripped form byte-for-byte.
    const strip = (n: IrNode): IrNode => {
      const { behaviors, animationProbe, transitionProbe, listeners, ...rest } = n;
      void behaviors;
      void animationProbe;
      void transitionProbe;
      void listeners;
      return { ...rest, children: n.children.map(strip) };
    };
    const stripped = {
      ir: result.ir.map(strip),
      role_overrides: result.role_overrides,
      warnings: result.warnings,
    };
    expect(JSON.stringify(result)).toBe(JSON.stringify(stripped));
    // and the pre-contract-16 role expectations still hold exactly (frozen expectations above)
    expect(result.warnings).toEqual([]);
  });
});

/* ─────────────────────────── P2-c — keyframe-driven elements never vanish (contract 18 §7) ──── */

describe('classify: P2-c — computed animation-name != none always yields a behavior + a mappable role', () => {
  /** The page-2658 pulse dot: a childless, textless div driven entirely by looping @keyframes. */
  const pulseDot = (): IrNode =>
    node({
      source_path: 'body>div>span',
      tag: 'div',
      attrs: cls('dot'),
      box: box(10, 10, 12, 12),
      computed: { 'background-color': 'rgb(34, 197, 94)' },
      animationProbe: {
        name: 'pulse',
        duration: '2s',
        delay: '0s',
        easing: 'ease-in-out',
        keyframeProps: ['opacity', 'transform'],
        opacity: { from: 1, to: 1 }, // loops back — NOT an extractable entrance intent
        transform: { from: 'none', to: 'none' },
      },
    });

  it('the pulse dot yields an entrance-animation DetectedBehavior (never silence)', () => {
    const result = classifyIr([pulseDot()], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.behavior.kind).toBe('entrance-animation');
    expect(found[0]?.behavior.evidence).toContain('keyframes:pulse');
  });

  it('the pulse dot (empty leaf) classifies structural-block, NEVER unknown — the element survives', () => {
    // Without the probe, an empty undecidable leaf is `unknown` (pinned existing behavior)…
    expect(
      classifyNode(node({ source_path: 'e', tag: 'div', box: box(10, 10, 12, 12) })),
    ).toBe('unknown');
    // …but a behavior-bearing one is a painted box that must survive as a mappable container.
    expect(classifyNode(pulseDot())).toBe('structural-block');
    const result = classifyIr([pulseDot()], { infer_flex: true });
    expect(result.ir).toHaveLength(1);
    expect(result.ir[0]?.role).toBe('structural-block');
  });

  it('infer_flex:false parity — the behavior-bearing empty leaf is still structural-block', () => {
    const result = classifyIr([pulseDot()], { infer_flex: false });
    expect(result.ir[0]?.role).toBe('structural-block');
  });

  it('listener/transition signals also rescue an empty leaf from unknown', () => {
    expect(
      classifyNode(node({ source_path: 'l', tag: 'div', listeners: ['click'] })),
    ).toBe('structural-block');
    expect(
      classifyNode(
        node({
          source_path: 't',
          tag: 'div',
          transitionProbe: { property: 'opacity', duration: '0.3s', easing: 'ease' },
        }),
      ),
    ).toBe('structural-block');
  });

  it('an UNRESOLVED @keyframes rule (CSSOM miss) still yields the behavior, with an honesty marker', () => {
    const unresolved = node({
      source_path: 'u',
      tag: 'div',
      textRuns: withText('x'),
      animationProbe: {
        name: 'mystery',
        duration: '1s',
        delay: '0s',
        easing: 'linear',
        keyframeProps: [], // the @keyframes rule was not readable via CSSOM
      },
    });
    const result = classifyIr([unresolved], { infer_flex: true });
    const found = collectBehaviors(result.ir);
    expect(found).toHaveLength(1);
    expect(found[0]?.behavior.evidence).toEqual(
      expect.arrayContaining([
        'keyframes:mystery',
        'animates:unresolved(@keyframes rule not readable via CSSOM)',
      ]),
    );
  });
});

/* ─────────────────────────── detection honesty — undetectable classes (contract 18 §7) ──────── */

describe('classify: detectUndetectableClasses — rAF count-ups appear with script-census evidence', () => {
  const statNode = (): IrNode =>
    node({
      source_path: 'body>div>span',
      tag: 'span',
      attrs: cls('stat-number'),
      textRuns: withText('4,500+'),
    });

  it('an inline rAF + text-write script yields a raf-text-mutation note with census evidence', () => {
    const notes = detectUndetectableClasses(
      [
        {
          src: null,
          inline_bytes: 220,
          content:
            'function tick(){el.textContent = String(n++); requestAnimationFrame(tick);} tick();',
        },
      ],
      [statNode()],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.class).toBe('raf-text-mutation');
    expect(notes[0]?.evidence[0]).toMatch(/script-census: inline script \(220B\)/);
    expect(notes[0]?.evidence[0]).toMatch(/requestAnimationFrame/);
    expect(notes[0]?.nodeIds).toContain('body>div>span');
  });

  it('a known count-up library src is evidence even without inline content', () => {
    const notes = detectUndetectableClasses(
      [{ src: 'https://cdn.example.com/countUp.min.js' }],
      [statNode()],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.evidence[0]).toContain('count-up library script');
  });

  it('no census evidence → an honest empty array (numeric nodes alone are not evidence)', () => {
    expect(detectUndetectableClasses([], [statNode()])).toEqual([]);
    expect(
      detectUndetectableClasses(
        [{ src: null, inline_bytes: 30, content: 'console.log("hi")' }],
        [statNode()],
      ),
    ).toEqual([]);
  });

  it('suspect nodes are best-effort hints (note survives with zero suspects)', () => {
    const notes = detectUndetectableClasses(
      [{ src: null, content: 'requestAnimationFrame(step); el.innerText = v;' }],
      [node({ source_path: 'p', tag: 'p', textRuns: withText('hello world') })],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.nodeIds).toEqual([]);
  });

  it('deterministic: same inputs → identical notes', () => {
    const scripts = [{ src: null, inline_bytes: 50, content: 'requestAnimationFrame(f); x.textContent = y;' }];
    const a = detectUndetectableClasses(scripts, [statNode()]);
    const b = detectUndetectableClasses(scripts, [statNode()]);
    expect(a).toEqual(b);
  });
});

/* ─────────────────────────── determinism + purity ───────────────────────────────────────────── */

describe('classify: determinism + purity', () => {
  it('same input → identical output', () => {
    const a = classifyIr([heroFixture()], { infer_flex: true });
    const b = classifyIr([heroFixture()], { infer_flex: true });
    expect(a.ir).toEqual(b.ir);
    expect(a.role_overrides).toEqual(b.role_overrides);
    expect(a.warnings).toEqual(b.warnings);
  });

  it('does NOT mutate the input tree (returns a new tree)', () => {
    const input = heroFixture();
    const before = JSON.parse(JSON.stringify(input)) as IrNode;
    classifyIr([input], { infer_flex: true });
    expect(input).toEqual(before);
  });
});
