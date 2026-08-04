/**
 * WP-H06 — MAP stage unit tests.
 *
 * Covers: v4-vs-v3 generation fallback; NO_ATOMIC_EQUIVALENT handling (list/table/accordion); tabs
 * paired/unpaired; form with/without `e_pro_atomic_form`; nav with/without Pro; `seedSettingsForRole`
 * per role; and the CLOSED-vocabulary scan (every produced target ∈ the authoring-contract §4 atomic
 * list, with the V3 fallback set when atomic is inactive). Uses tiny `IrNode` + capability fixtures —
 * no Playwright, no WP client (the module is pure).
 */

import { describe, expect, it } from 'vitest';

import {
  BEHAVIOR_TIER_REASONS,
  collectDetectedBehaviors,
  INLINE_FOLD_DROP_REASONS,
  mapIr,
  seedSettingsForRole,
} from './map.js';
import type {
  BoxRect,
  DetectedBehavior,
  IrNode,
  MappedNode,
  MapStageContext,
  SemanticRole,
  SiteCapabilities,
} from './types.js';

/* ─────────────────────────── tiny IR + capability builders ──────────────────────────────────── */

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

function text(t: string): { text: string; inlineTags: string[] }[] {
  return [{ text: t, inlineTags: [] }];
}

/** A maximal-capability site: atomic + Pro + the atomic-form experiment all ON. */
function caps(overrides: Partial<SiteCapabilities> = {}): SiteCapabilities {
  return {
    v4: true,
    atomic: true,
    global_classes: true,
    variables: true,
    pro: true,
    pro_atomic_form: true,
    breakpoints: [],
    experiments: {},
    can_update_class: true,
    classes_migrated: true,
    registered_types: { atomic: [], classic: [] },
    versions: { elementor: '4.1.1', pro: '4.1.0', plugin: '0.1.0' },
    unfiltered_html: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<MapStageContext> = {}): MapStageContext {
  return {
    generation: 'v4',
    capabilities: caps(),
    tab_pairing: {},
    ...overrides,
  };
}

/** Map a single root node and return its `MappedNode`. */
function mapOne(n: IrNode, c: MapStageContext = ctx()): MappedNode {
  const res = mapIr([n], c);
  return res.nodes[0]!;
}

/* ─────────────────────────── the closed atomic vocabulary (authoring-contract §4) ────────────── */

/** Containers + widgets + free form containers + Pro form fields (authoring-contract §4). */
const ATOMIC_TYPES: ReadonlySet<string> = new Set([
  // containers
  'e-div-block',
  'e-flexbox',
  'e-tabs',
  'e-tabs-menu',
  'e-tab',
  'e-tabs-content-area',
  'e-tab-content',
  // widgets
  'e-heading',
  'e-paragraph',
  'e-image',
  'e-button',
  'e-svg',
  'e-youtube',
  'e-divider',
  'e-self-hosted-video',
  // free form containers
  'e-form',
  'e-form-success-message',
  'e-form-error-message',
  // Pro form fields (gated on e_pro_atomic_form)
  'e-form-input',
  'e-form-textarea',
  'e-form-checkbox',
  'e-form-radio-button',
  'e-form-select',
  'e-form-date-picker',
  'e-form-time-picker',
  'e-form-file-upload',
  'e-form-label',
  'e-form-submit-button',
]);

/** The V3 classic widget/container vocabulary the V3-fallback path emits. */
const V3_TYPES: ReadonlySet<string> = new Set([
  'container',
  'heading',
  'text-editor',
  'image',
  'button',
  'divider',
  'icon',
  'video',
  'nested-tabs',
  'nav-menu',
  'form',
  'icon-list',
  'html',
  'nested-accordion',
]);

function effectiveType(target: MappedNode['target']): string {
  return target.widgetType ?? target.elType;
}

function walk(n: MappedNode, fn: (node: MappedNode) => void): void {
  fn(n);
  for (const c of n.children) {
    walk(c, fn);
  }
}

/* ─────────────────────────── generation fallback ladder ──────────────────────────────────────── */

describe('mapIr: generation fallback ladder (authoring-contract §9 whole-node)', () => {
  const tree: IrNode = node({
    source_path: 's',
    tag: 'section',
    role: 'structural-block',
    children: [
      node({ source_path: 's/h', tag: 'h1', role: 'heading', textRuns: text('Hi') }),
      node({ source_path: 's/p', tag: 'p', role: 'text', textRuns: text('body') }),
    ],
  });

  it('v4 + atomic ON → atomic targets, no whole-tree fallback', () => {
    const m = mapOne(tree, ctx({ generation: 'v4', capabilities: caps({ atomic: true }) }));
    expect(m.target.elType).toBe('e-div-block');
    expect(effectiveType(m.children[0]!.target)).toBe('e-heading');
    expect(effectiveType(m.children[1]!.target)).toBe('e-paragraph');
  });

  it('v4 but atomic INACTIVE → whole tree maps to V3 classic + v3_classic fallbacks', () => {
    const c = ctx({ generation: 'v4', capabilities: caps({ atomic: false }) });
    const res = mapIr([tree], c);
    const m = res.nodes[0]!;
    expect(m.target.elType).toBe('container');
    expect(effectiveType(m.children[0]!.target)).toBe('heading');
    expect(effectiveType(m.children[1]!.target)).toBe('text-editor');
    // every node recorded a v3_classic fallback
    expect(res.fallbacks.every((f) => f.tier === 'v3_classic')).toBe(true);
    expect(res.fallbacks.map((f) => f.source_path).sort()).toEqual(['s', 's/h', 's/p']);
  });

  it('generation v3 explicitly → V3 classic even with atomic capability present', () => {
    const m = mapOne(tree, ctx({ generation: 'v3', capabilities: caps({ atomic: true }) }));
    expect(m.target.elType).toBe('container');
  });
});

/* ─────────────────────────── NO_ATOMIC_EQUIVALENT (list / table / accordion) ─────────────────── */

describe('mapIr: NO_ATOMIC_EQUIVALENT roles', () => {
  it('list → structural e-div-block + paragraph items (v4), recorded NOT native', () => {
    const list = node({
      source_path: 'ul',
      tag: 'ul',
      role: 'list',
      children: [
        node({ source_path: 'ul/li1', tag: 'li', role: 'list-item', textRuns: text('one') }),
        node({ source_path: 'ul/li2', tag: 'li', role: 'list-item', textRuns: text('two') }),
      ],
    });
    const res = mapIr([list], ctx());
    const m = res.nodes[0]!;
    expect(m.target.elType).toBe('e-div-block');
    expect(effectiveType(m.children[0]!.target)).toBe('e-paragraph');
    const fb = res.fallbacks.find((f) => f.source_path === 'ul');
    expect(fb?.tier).toBe('structural_block');
  });

  it('list → icon-list (v3) when atomic inactive', () => {
    const list = node({ source_path: 'ul', tag: 'ul', role: 'list' });
    const m = mapOne(list, ctx({ capabilities: caps({ atomic: false }) }));
    expect(effectiveType(m.target)).toBe('icon-list');
  });

  it('table → structural grid (v4) recorded as structural_block', () => {
    const table = node({ source_path: 't', tag: 'table', role: 'table' });
    const res = mapIr([table], ctx());
    expect(res.nodes[0]!.target.elType).toBe('e-div-block');
    expect(res.fallbacks.find((f) => f.source_path === 't')?.tier).toBe('structural_block');
  });

  it('table → html widget last resort (v3) recorded as html_widget tier', () => {
    const table = node({ source_path: 't', tag: 'table', role: 'table' });
    const res = mapIr([table], ctx({ capabilities: caps({ atomic: false }) }));
    expect(effectiveType(res.nodes[0]!.target)).toBe('html');
    expect(res.fallbacks.find((f) => f.source_path === 't')?.tier).toBe('html_widget');
  });

  it('accordion → styled e-div-block approximation, recorded fallback', () => {
    const acc = node({ source_path: 'a', tag: 'details', role: 'accordion' });
    const res = mapIr([acc], ctx());
    expect(res.nodes[0]!.target.elType).toBe('e-div-block');
    expect(res.fallbacks.find((f) => f.source_path === 'a')?.tier).toBe('structural_block');
  });
});

/* ─────────────────────────── tabs paired / unpaired ──────────────────────────────────────────── */

describe('mapIr: tabs', () => {
  function tabsTree(): IrNode {
    return node({
      source_path: 'tabs',
      tag: 'div',
      role: 'tabs',
      children: [
        node({ source_path: 'tabs/t1', tag: 'button', role: 'tab', textRuns: text('Tab 1') }),
        node({ source_path: 'tabs/t2', tag: 'button', role: 'tab', textRuns: text('Tab 2') }),
        node({ source_path: 'tabs/c1', tag: 'div', role: 'tab-content' }),
        node({ source_path: 'tabs/c2', tag: 'div', role: 'tab-content' }),
      ],
    });
  }

  it('paired tabs → full e-tabs family with matching tab/content counts', () => {
    const res = mapIr([tabsTree()], ctx({ tab_pairing: { tabs: true } }));
    const m = res.nodes[0]!;
    expect(m.target.elType).toBe('e-tabs');
    const children: MappedNode[] = m.children;
    const tabTargets = children.filter((c) => c.role === 'tab').map((c) => c.target.elType);
    const contentTargets = children
      .filter((c) => c.role === 'tab-content')
      .map((c) => c.target.elType);
    expect(tabTargets).toEqual(['e-tab', 'e-tab']);
    expect(contentTargets).toEqual(['e-tab-content', 'e-tab-content']);
    expect(tabTargets.length).toBe(contentTargets.length);
    // a paired tabs container is native (no fallback recorded for it)
    expect(res.fallbacks.find((f) => f.source_path === 'tabs')).toBeUndefined();
  });

  it('unpaired tabs → structural e-div-block + fallback + warning', () => {
    const res = mapIr([tabsTree()], ctx({ tab_pairing: { tabs: false } }));
    const m = res.nodes[0]!;
    expect(m.target.elType).toBe('e-div-block');
    expect(res.fallbacks.find((f) => f.source_path === 'tabs')?.tier).toBe('structural_block');
    expect(res.warnings.some((w) => w.includes('tabs'))).toBe(true);
  });
});

/* ─────────────────────────── forms (e_pro_atomic_form gate) ──────────────────────────────────── */

describe('mapIr: forms', () => {
  function formTree(): IrNode {
    return node({
      source_path: 'f',
      tag: 'form',
      role: 'form',
      children: [
        node({ source_path: 'f/name', tag: 'input', role: 'form-field', attrs: { type: 'text' } }),
        node({ source_path: 'f/msg', tag: 'textarea', role: 'form-field' }),
        node({
          source_path: 'f/email',
          tag: 'input',
          role: 'form-field',
          attrs: { type: 'email' },
        }),
      ],
    });
  }

  it('form → e-form + concrete e-form-* fields with Pro + e_pro_atomic_form', () => {
    const res = mapIr(
      [formTree()],
      ctx({ capabilities: caps({ pro: true, pro_atomic_form: true }) }),
    );
    const m = res.nodes[0]!;
    expect(m.target.elType).toBe('e-form');
    expect(effectiveType(m.children[0]!.target)).toBe('e-form-input');
    expect(effectiveType(m.children[1]!.target)).toBe('e-form-textarea');
    expect(effectiveType(m.children[2]!.target)).toBe('e-form-input');
    expect(res.fallbacks.find((f) => f.source_path === 'f')).toBeUndefined();
  });

  it('form → structural fallback + warning when e_pro_atomic_form OFF (Pro on)', () => {
    const res = mapIr(
      [formTree()],
      ctx({ capabilities: caps({ pro: true, pro_atomic_form: false }) }),
    );
    const m = res.nodes[0]!;
    expect(m.target.elType).toBe('e-div-block');
    expect(res.fallbacks.find((f) => f.source_path === 'f')?.tier).toBe('structural_block');
    expect(res.warnings.some((w) => w.includes('e_pro_atomic_form'))).toBe(true);
  });

  it('form → V3 Pro form widget when atomic inactive', () => {
    const res = mapIr([formTree()], ctx({ capabilities: caps({ atomic: false }) }));
    expect(effectiveType(res.nodes[0]!.target)).toBe('form');
  });

  it('atomic form field input type clamps into the e-form-input enum', () => {
    const fld = node({
      source_path: 'fld',
      tag: 'input',
      role: 'form-field',
      attrs: { type: 'color', placeholder: 'pick', required: '' },
    });
    const m = mapOne(fld);
    expect(effectiveType(m.target)).toBe('e-form-input');
    expect(m.settings_seed['type']).toBe('text'); // 'color' not in enum → clamp
    expect(m.settings_seed['placeholder']).toBe('pick');
    expect(m.settings_seed['required']).toBe(true);
  });

  it('checkbox / radio / date / time / file fields pick their concrete atomic type', () => {
    const cases: Array<[string, string]> = [
      ['checkbox', 'e-form-checkbox'],
      ['radio', 'e-form-radio-button'],
      ['date', 'e-form-date-picker'],
      ['time', 'e-form-time-picker'],
      ['file', 'e-form-file-upload'],
    ];
    for (const [inputType, expected] of cases) {
      const fld = node({
        source_path: `fld-${inputType}`,
        tag: 'input',
        role: 'form-field',
        attrs: { type: inputType },
      });
      expect(effectiveType(mapOne(fld).target)).toBe(expected);
    }
    const sel = node({ source_path: 'sel', tag: 'select', role: 'form-field' });
    expect(effectiveType(mapOne(sel).target)).toBe('e-form-select');
  });
});

/* ─────────────────────────── nav with / without Pro ──────────────────────────────────────────── */

describe('mapIr: nav-menu', () => {
  const nav = node({ source_path: 'nav', tag: 'nav', role: 'nav-menu' });

  it('Pro active → e-div-block (bound-widget element type; binding is persist-time), native', () => {
    const res = mapIr([nav], ctx({ capabilities: caps({ pro: true }) }));
    expect(res.nodes[0]!.target.elType).toBe('e-div-block');
    expect(res.fallbacks.find((f) => f.source_path === 'nav')).toBeUndefined();
  });

  it('Pro inactive → e-div-block + e-button list, recorded fallback', () => {
    const res = mapIr([nav], ctx({ capabilities: caps({ pro: false }) }));
    expect(res.nodes[0]!.target.elType).toBe('e-div-block');
    expect(res.fallbacks.find((f) => f.source_path === 'nav')?.tier).toBe('structural_block');
  });

  it('atomic inactive → V3 Pro nav-menu widget', () => {
    const res = mapIr([nav], ctx({ capabilities: caps({ atomic: false }) }));
    expect(effectiveType(res.nodes[0]!.target)).toBe('nav-menu');
  });
});

/* ─────────────────────────── seedSettingsForRole per role ────────────────────────────────────── */

describe('seedSettingsForRole', () => {
  it('heading: tag from source level (clamped) + title raw text', () => {
    const h = node({ source_path: 'h', tag: 'h3', role: 'heading', textRuns: text('Welcome') });
    const m = mapOne(h);
    expect(m.settings_seed['tag']).toBe('h3');
    expect(m.settings_seed['title']).toBe('Welcome');
  });

  it('heading: non-h* source clamps to h2 default', () => {
    const h = node({ source_path: 'h', tag: 'div', role: 'heading', textRuns: text('T') });
    expect(mapOne(h).settings_seed['tag']).toBe('h2');
  });

  it('paragraph: tag p/span clamped + paragraph raw text', () => {
    const span = node({ source_path: 'p', tag: 'span', role: 'text', textRuns: text('inline') });
    const m = mapOne(span);
    expect(m.settings_seed['tag']).toBe('span');
    expect(m.settings_seed['paragraph']).toBe('inline');

    const div = node({ source_path: 'p2', tag: 'div', role: 'text', textRuns: text('x') });
    expect(mapOne(div).settings_seed['tag']).toBe('p'); // out-of-enum → p
  });

  it('button: text + link {destination,isTargetBlank,tag:a}', () => {
    const btn = node({
      source_path: 'b',
      tag: 'a',
      role: 'button',
      attrs: { href: '/go', target: '_blank' },
      textRuns: text('Click me'),
    });
    const m = mapOne(btn);
    expect(m.settings_seed['text']).toBe('Click me');
    expect(m.settings_seed['link']).toEqual({
      destination: '/go',
      isTargetBlank: true,
      tag: 'a',
    });
  });

  it('button without href omits the link seed', () => {
    const btn = node({ source_path: 'b', tag: 'button', role: 'button', textRuns: text('Submit') });
    expect(mapOne(btn).settings_seed['link']).toBeUndefined();
  });

  it('image: emits a media-pending marker for ASSEMBLE to sideload', () => {
    const img = node({
      source_path: 'img',
      tag: 'img',
      role: 'image',
      media: { kind: 'img', url: 'https://x/a.png', alt: 'A' },
    });
    const m = mapOne(img);
    expect(m.settings_seed['image']).toEqual({
      __media_pending: { kind: 'img', url: 'https://x/a.png', alt: 'A' },
    });
  });

  it('div-block: tag clamped from source enum (section ok, nav → div)', () => {
    const sect = node({ source_path: 's', tag: 'section', role: 'structural-block' });
    expect(mapOne(sect).settings_seed['tag']).toBe('section');

    const navLike = node({ source_path: 'n', tag: 'nav', role: 'structural-block' });
    expect(mapOne(navLike).settings_seed['tag']).toBe('div'); // nav not in container enum → div
  });

  it('youtube: source from the embed url', () => {
    const yt = node({
      source_path: 'yt',
      tag: 'iframe',
      role: 'media-embed-youtube',
      media: { kind: 'youtube', url: 'https://youtube.com/watch?v=abc', embedId: 'abc' },
    });
    expect(mapOne(yt).settings_seed['source']).toBe('https://youtube.com/watch?v=abc');
  });

  it('self-hosted video: media-pending marker for source', () => {
    const v = node({
      source_path: 'v',
      tag: 'video',
      role: 'media-embed-video',
      media: { kind: 'video', url: 'https://x/clip.mp4' },
    });
    expect(mapOne(v).settings_seed['source']).toEqual({
      __media_pending: { kind: 'video', url: 'https://x/clip.mp4' },
    });
  });

  it('seedSettingsForRole is callable standalone with a MappingResult', () => {
    const heading = node({ source_path: 'h', tag: 'h1', role: 'heading', textRuns: text('Big') });
    const target = mapOne(heading).target;
    const seed = seedSettingsForRole(heading, target);
    expect(seed['tag']).toBe('h1');
    expect(seed['title']).toBe('Big');
  });
});

/* ─────────────────────── inline html-v3 folding (the inline-span-in-text fix) ─────────────────── */

describe('seedSettingsForRole: inline allowlist markup folds into html-v3 content', () => {
  it('heading: a nested <span> run becomes inline <span> markup in title (no child node)', () => {
    // Mirrors PARSE output for `<h1>Customer intelligence, <span>on autopilot</span></h1>`: two runs,
    // the second carrying inlineTags:['span']. The span MUST fold into the title string, not a child.
    const h = node({
      source_path: 'h1',
      tag: 'h1',
      role: 'heading',
      textRuns: [
        { text: 'Customer intelligence, ', inlineTags: [] },
        { text: 'on autopilot', inlineTags: ['span'] },
      ],
    });
    const m = mapOne(h);
    expect(m.settings_seed['title']).toBe('Customer intelligence, <span>on autopilot</span>');
  });

  it('paragraph: a nested <strong> run becomes inline <strong> markup in paragraph', () => {
    const p = node({
      source_path: 'p',
      tag: 'p',
      role: 'text',
      textRuns: [
        { text: 'Lumen turns raw events into ', inlineTags: [] },
        { text: 'decisions', inlineTags: ['strong'] },
        { text: '.', inlineTags: [] },
      ],
    });
    expect(mapOne(p).settings_seed['paragraph']).toBe(
      'Lumen turns raw events into <strong>decisions</strong>.',
    );
  });

  it('button: inline markup folds into text', () => {
    const b = node({
      source_path: 'b',
      tag: 'a',
      role: 'button',
      attrs: { href: '/x' },
      textRuns: [
        { text: 'Read ', inlineTags: [] },
        { text: 'more', inlineTags: ['em'] },
      ],
    });
    expect(mapOne(b).settings_seed['text']).toBe('Read <em>more</em>');
  });

  it('nests inline tags outer→inner (PARSE wrapper order) and skips DISALLOWED inline tags', () => {
    // PARSE's extractTextRuns accumulates wrappers OUTER→INNER as it descends, so for
    // `<strong><em>A</em></strong>` the run carries inlineTags:['strong','em'].
    const h = node({
      source_path: 'h',
      tag: 'h2',
      role: 'heading',
      textRuns: [
        { text: 'A', inlineTags: ['strong', 'em'] }, // strong wraps em
        { text: 'B', inlineTags: ['mark'] }, // mark is NOT allowlisted → bare text
      ],
    });
    expect(mapOne(h).settings_seed['title']).toBe('<strong><em>A</em></strong>B');
  });

  it('escapes markup characters in text runs so html-v3 stays wp_kses-clean', () => {
    const h = node({
      source_path: 'h',
      tag: 'h2',
      role: 'heading',
      textRuns: [{ text: 'a < b & c > d', inlineTags: [] }],
    });
    expect(mapOne(h).settings_seed['title']).toBe('a &lt; b &amp; c &gt; d');
  });
});

/* ─────────────── inline <a href> + accent-color carry (contract 17 §5 / I3) ──────────────────── */

describe('seedSettingsForRole: in-text links carry href/target into html-v3 (contract 17 §5)', () => {
  it('paragraph: a linked run serializes a live <a href> (+ target), not a dead bare <a>', () => {
    // Mirrors PARSE output for `<p>Read the <a href="https://x/terms" target="_blank">terms</a>.</p>`:
    // `extractTextRuns` carries the nearest wrapping <a>'s destination on the run (linkHref/linkTarget).
    const p = node({
      source_path: 'p',
      tag: 'p',
      role: 'text',
      textRuns: [
        { text: 'Read the ', inlineTags: [] },
        { text: 'terms', inlineTags: ['a'], linkHref: 'https://x/terms', linkTarget: '_blank' },
        { text: '.', inlineTags: [] },
      ],
    });
    const seeded = mapOne(p).settings_seed['paragraph'];
    expect(seeded).toBe('Read the <a href="https://x/terms" target="_blank">terms</a>.');
    expect(seeded).toContain('href="https://x/terms"');
  });

  it('href lands on the INNERMOST <a> (the nearest wrapping link) and attr values are escaped', () => {
    const h = node({
      source_path: 'h',
      tag: 'h2',
      role: 'heading',
      textRuns: [{ text: 'go', inlineTags: ['strong', 'a'], linkHref: '/go?a=1&b="2"' }],
    });
    expect(mapOne(h).settings_seed['title']).toBe(
      '<strong><a href="/go?a=1&amp;b=&quot;2&quot;">go</a></strong>',
    );
  });

  it('a linked run without a captured target omits the target attr', () => {
    const p = node({
      source_path: 'p',
      tag: 'p',
      role: 'text',
      textRuns: [{ text: 'docs', inlineTags: ['a'], linkHref: '/docs' }],
    });
    expect(mapOne(p).settings_seed['paragraph']).toBe('<a href="/docs">docs</a>');
  });

  it('an <a> run WITHOUT linkHref keeps the pre-contract-17 bare serialization', () => {
    const p = node({
      source_path: 'p',
      tag: 'p',
      role: 'text',
      textRuns: [{ text: 'anchor', inlineTags: ['a'] }],
    });
    expect(mapOne(p).settings_seed['paragraph']).toBe('<a>anchor</a>');
  });

  it('defensive: a linked run whose inlineTags lost the <a> still wraps in <a href>', () => {
    const p = node({
      source_path: 'p',
      tag: 'p',
      role: 'text',
      textRuns: [{ text: 'go', inlineTags: ['strong'], linkHref: '/go' }],
    });
    expect(mapOne(p).settings_seed['paragraph']).toBe('<strong><a href="/go">go</a></strong>');
  });
});

describe('seedSettingsForRole: inline accent colors carry as accent_rules or are I3-recorded (contract 17 #8)', () => {
  // The style-attr carrier is a DEAD END: Html_Prop_Type sanitizes html-v3 with a custom wp_kses
  // allowlist that strips every attribute except a[href|target] (live-verified on page 2486 — the
  // saved <em style> came back bare). The fold emits CLEAN markup and records the accent on
  // `MappedNode.accent_rules`; STYLE-EXTRACT materializes it as a nested custom_css rule.
  it('em-inside-h1 records the emerald accent as an accent_rule (markup stays attribute-free)', () => {
    const h = node({
      source_path: 'h1',
      tag: 'h1',
      role: 'heading',
      computed: { color: 'rgb(26, 26, 26)' },
      textRuns: [
        { text: 'Ship ', inlineTags: [] },
        { text: 'faster', inlineTags: ['em'], color: '#0C6B4A' },
      ],
    });
    const res = mapIr([h], ctx());
    expect(res.nodes[0]!.settings_seed['title']).toBe('Ship <em>faster</em>');
    expect(res.nodes[0]!.accent_rules).toEqual([{ tag: 'em', color: '#0C6B4A' }]);
    expect(res.inline_drops).toEqual([]);
  });

  it('quote: a highlighted span records its accent color', () => {
    const q = node({
      source_path: 'q',
      tag: 'blockquote',
      role: 'text',
      computed: { color: 'rgb(60, 60, 60)' },
      textRuns: [
        { text: 'It ', inlineTags: [] },
        { text: 'just works', inlineTags: ['span'], color: 'rgb(12, 107, 74)' },
        { text: '.', inlineTags: [] },
      ],
    });
    const mapped = mapOne(q);
    expect(mapped.settings_seed['paragraph']).toBe('It <span>just works</span>.');
    expect(mapped.accent_rules).toEqual([{ tag: 'span', color: 'rgb(12, 107, 74)' }]);
  });

  it('the accent keys on the INNERMOST surviving tag of a nested run', () => {
    const h = node({
      source_path: 'h',
      tag: 'h2',
      role: 'heading',
      textRuns: [{ text: 'A', inlineTags: ['strong', 'em'], color: '#0C6B4A' }],
    });
    const mapped = mapOne(h);
    expect(mapped.settings_seed['title']).toBe('<strong><em>A</em></strong>');
    expect(mapped.accent_rules).toEqual([{ tag: 'em', color: '#0C6B4A' }]);
  });

  it('a link + accent run keeps the href inline and the color as an accent_rule on the <a>', () => {
    const p = node({
      source_path: 'p',
      tag: 'p',
      role: 'text',
      textRuns: [{ text: 'docs', inlineTags: ['a'], linkHref: '/docs', color: '#0C6B4A' }],
    });
    const mapped = mapOne(p);
    expect(mapped.settings_seed['paragraph']).toBe('<a href="/docs">docs</a>');
    expect(mapped.accent_rules).toEqual([{ tag: 'a', color: '#0C6B4A' }]);
  });

  it('two same-tag runs with the SAME color share one accent_rule; a CONFLICT is I3-recorded', () => {
    const h = node({
      source_path: 'h',
      tag: 'h2',
      role: 'heading',
      computed: { color: '#111111' },
      textRuns: [
        { text: 'one', inlineTags: ['em'], color: '#0C6B4A' },
        { text: 'two', inlineTags: ['em'], color: '#0C6B4A' },
        { text: 'odd', inlineTags: ['em'], color: '#AA0000' },
      ],
    });
    const res = mapIr([h], ctx());
    expect(res.nodes[0]!.accent_rules).toEqual([{ tag: 'em', color: '#0C6B4A' }]);
    expect(res.inline_drops).toEqual([
      {
        source_path: 'h',
        declaration: 'color: #AA0000',
        tier: 'dropped',
        reason: INLINE_FOLD_DROP_REASONS.color_conflict,
      },
    ]);
  });

  it('a run color EQUAL to the parent color is a no-op: no accent_rule, no drop record (I4)', () => {
    const h = node({
      source_path: 'h',
      tag: 'h2',
      role: 'heading',
      computed: { color: '#1A1A1A' },
      textRuns: [{ text: 'same', inlineTags: ['em'], color: '#1A1A1A' }],
    });
    const res = mapIr([h], ctx());
    expect(res.nodes[0]!.settings_seed['title']).toBe('<em>same</em>');
    expect(res.nodes[0]!.accent_rules).toBeUndefined();
    expect(res.inline_drops).toEqual([]);
  });

  it('a colored run with NO surviving inline tag records an I3 dropped entry (never silent)', () => {
    // `mark` is not in the html-v3 allowlist → the text folds bare and the color has no carrier.
    const h = node({
      source_path: 'h',
      tag: 'h2',
      role: 'heading',
      computed: { color: '#111111' },
      textRuns: [{ text: 'hot', inlineTags: ['mark'], color: '#0C6B4A' }],
    });
    const res = mapIr([h], ctx());
    expect(res.nodes[0]!.settings_seed['title']).toBe('hot');
    expect(res.inline_drops).toEqual([
      {
        source_path: 'h',
        declaration: 'color: #0C6B4A',
        tier: 'dropped',
        reason: INLINE_FOLD_DROP_REASONS.color_no_carrier,
      },
    ]);
  });

  it('mapIr reports inline_drops: [] on trees with no inline-fold losses', () => {
    const tree = node({
      source_path: 's',
      tag: 'section',
      role: 'structural-block',
      children: [node({ source_path: 'h', tag: 'h2', role: 'heading', textRuns: text('Plain') })],
    });
    expect(mapIr([tree], ctx()).inline_drops).toEqual([]);
  });
});

/* ─────────────────────────── closed-vocabulary scan + purity ─────────────────────────────────── */

describe('mapIr: closed atomic vocabulary (authoring-contract §4)', () => {
  /** A broad tree exercising every role so the scan covers the whole vocabulary. */
  function bigTree(): IrNode {
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
    return node({
      source_path: 'root',
      tag: 'div',
      role: 'structural-block',
      children: roles.map((role, i) =>
        node({ source_path: `root/${role}-${i}`, tag: 'div', role }),
      ),
    });
  }

  it('every produced target is in the §4 atomic list (v4 + atomic ON)', () => {
    const res = mapIr([bigTree()], ctx({ tab_pairing: { 'root/tabs-13': true } }));
    res.nodes.forEach((root) =>
      walk(root, (n) => {
        expect(ATOMIC_TYPES.has(effectiveType(n.target))).toBe(true);
        // elType is always an atomic container OR the generic `widget` host for atomic widgets.
        expect(n.target.elType === 'widget' || ATOMIC_TYPES.has(n.target.elType)).toBe(true);
      }),
    );
  });

  it('every produced target is in the V3 list (atomic inactive)', () => {
    const res = mapIr([bigTree()], ctx({ capabilities: caps({ atomic: false }) }));
    res.nodes.forEach((root) =>
      walk(root, (n) => {
        expect(V3_TYPES.has(effectiveType(n.target))).toBe(true);
      }),
    );
  });

  it('is pure / deterministic — identical output for the same input', () => {
    const tree = bigTree();
    const a = mapIr([tree], ctx());
    const b = mapIr([tree], ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the input IR', () => {
    const tree = bigTree();
    const snapshot = JSON.stringify(tree);
    mapIr([tree], ctx());
    expect(JSON.stringify(tree)).toBe(snapshot);
  });
});

/* ─────────────────────────── contract 16 §3 — behavior tiering + tier-1 restructures ──────────── */

/** A minimal `DetectedBehavior` fixture (detection leaves tier/reason unset — contract 16 §1). */
function behavior(kind: DetectedBehavior['kind'], nodeIds: string[] = []): DetectedBehavior {
  return { kind, confidence: 'high', evidence: ['test'], nodeIds };
}

/** Attach behaviors to a node (the classify-stage annotation MAP consumes). */
function withBehaviors(n: IrNode, ...behaviors: DetectedBehavior[]): IrNode {
  n.behaviors = behaviors;
  return n;
}

/** First behavior of `kind` carried anywhere in a mapped forest. */
function mappedBehavior(nodes: MappedNode[], kind: DetectedBehavior['kind']): DetectedBehavior {
  const found = collectDetectedBehaviors(nodes).find((b) => b.kind === kind);
  expect(found).toBeDefined();
  return found as DetectedBehavior;
}

describe('mapIr: tier-1 tabs restructure (contract 16 §3, recon e_tabs_working_tree)', () => {
  /** ARIA tabs: root wrapper > tablist(2 triggers) + 2 panels; behavior on the root. */
  function ariaTabsTree(): IrNode {
    const t1 = node({
      source_path: 'r/list/t1',
      tag: 'button',
      role: 'tab',
      textRuns: text('Tab one'),
    });
    const t2 = node({
      source_path: 'r/list/t2',
      tag: 'button',
      role: 'tab',
      textRuns: text('Tab two'),
      attrs: { 'aria-selected': 'true' },
    });
    const tablist = node({
      source_path: 'r/list',
      tag: 'div',
      role: 'tabs',
      computed: { display: 'flex' },
      children: [t1, t2],
    });
    const p1 = node({
      source_path: 'r/p1',
      tag: 'div',
      role: 'tab-content',
      children: [
        node({ source_path: 'r/p1/x', tag: 'p', role: 'text', textRuns: text('Panel one') }),
      ],
    });
    const p2 = node({
      source_path: 'r/p2',
      tag: 'div',
      role: 'tab-content',
      children: [
        node({ source_path: 'r/p2/x', tag: 'p', role: 'text', textRuns: text('Panel two') }),
      ],
    });
    return withBehaviors(
      node({
        source_path: 'r',
        tag: 'div',
        role: 'structural-block',
        children: [tablist, p1, p2],
      }),
      behavior('tabs', ['r', 'r/list', 'r/list/t1', 'r/list/t2', 'r/p1', 'r/p2']),
    );
  }

  it('rebuilds the canonical family: e-tabs > e-tabs-menu > e-tab* + e-tabs-content-area > e-tab-content*', () => {
    const res = mapIr([ariaTabsTree()], ctx());
    const root = res.nodes[0]!;
    expect(root.target.elType).toBe('e-tabs');
    const rootKids: MappedNode[] = root.children;
    expect(rootKids.map((c) => c.target.elType)).toEqual(['e-tabs-menu', 'e-tabs-content-area']);
    const [menu, area] = rootKids as [MappedNode, MappedNode];
    const menuKids: MappedNode[] = menu.children;
    const areaKids: MappedNode[] = area.children;
    expect(menuKids.map((c) => c.target.elType)).toEqual(['e-tab', 'e-tab']);
    expect(areaKids.map((c) => c.target.elType)).toEqual(['e-tab-content', 'e-tab-content']);
    // pairing invariant: counts MUST match (recon rule)
    expect(menuKids.length).toBe(areaKids.length);
  });

  it('tab labels: each e-tab holds ONE e-paragraph (tag span) from the trigger text', () => {
    const res = mapIr([ariaTabsTree()], ctx());
    const menu = res.nodes[0]!.children[0]!;
    const tab1 = menu.children[0]!;
    expect(tab1.source_path).toBe('r/list/t1'); // the trigger HOSTS the e-tab (styles preserved)
    expect(tab1.children).toHaveLength(1);
    const label = tab1.children[0]!;
    expect(label.target.widgetType).toBe('e-paragraph');
    expect(label.settings_seed['tag']).toBe('span');
    expect(label.settings_seed['paragraph']).toBe('Tab one');
  });

  it('panels are recursively converted INSIDE e-tab-content (the panel hosts the member)', () => {
    const res = mapIr([ariaTabsTree()], ctx());
    const area = res.nodes[0]!.children[1]!;
    const c1 = area.children[0]!;
    expect(c1.source_path).toBe('r/p1');
    expect(c1.children[0]!.target.widgetType).toBe('e-paragraph');
    expect(c1.children[0]!.settings_seed['paragraph']).toBe('Panel one');
  });

  it('LEAF panels (own textRuns, no children) get a synthesized text child — copy never drops', () => {
    const tree = ariaTabsTree();
    // make p1 a leaf panel: text on the panel's OWN runs, no child node (childless <div role=tabpanel>)
    const p1 = tree.children[1]!;
    p1.children = [];
    p1.textRuns = text('Leaf panel copy');
    const res = mapIr([tree], ctx());
    const area = res.nodes[0]!.children[1]!;
    const c1 = area.children[0]!;
    expect(c1.target.elType).toBe('e-tab-content');
    expect(c1.children).toHaveLength(1);
    expect(c1.children[0]!.target.widgetType).toBe('e-paragraph');
    expect(c1.children[0]!.settings_seed['paragraph']).toBe('Leaf panel copy');
  });

  it('panel runtime-visibility props are STRIPPED — a parse-time-hidden panel must not persist display:none', () => {
    const tree = ariaTabsTree();
    // inactive panel at parse time: hidden via display:none (+ a responsive override)
    const p2 = tree.children[2]!;
    p2.computed = { display: 'none', 'background-color': 'rgb(1, 2, 3)' };
    p2.responsive = { mobile: { display: 'none' } };
    const res = mapIr([tree], ctx());
    const area = res.nodes[0]!.children[1]!;
    const c2 = area.children[1]!;
    expect(c2.target.elType).toBe('e-tab-content');
    expect(c2.computed['display']).toBeUndefined();
    expect(c2.responsive['mobile']?.['display']).toBeUndefined();
    // non-visibility styling survives
    expect(c2.computed['background-color']).toBe('rgb(1, 2, 3)');
    // purity: the input IR is not mutated
    expect(p2.computed['display']).toBe('none');
  });

  it('the e-tabs-menu is hosted by the tablist (source_path + computed styles preserved)', () => {
    const res = mapIr([ariaTabsTree()], ctx());
    const menu = res.nodes[0]!.children[0]!;
    expect(menu.source_path).toBe('r/list');
    expect(menu.computed['display']).toBe('flex');
  });

  it('default-active-tab (0-based) comes from aria-selected', () => {
    const res = mapIr([ariaTabsTree()], ctx());
    expect(res.nodes[0]!.settings_seed['default-active-tab']).toBe(1);
  });

  it('tags the behavior tier 1 with the frozen reason; the INPUT behavior object is not mutated', () => {
    const tree = ariaTabsTree();
    const res = mapIr([tree], ctx());
    const tagged = mappedBehavior(res.nodes, 'tabs');
    expect(tagged.tier).toBe(1);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.tabs_native);
    // purity: the classify-stage object stays untiered
    expect(tree.behaviors![0]!.tier).toBeUndefined();
    expect(tree.behaviors![0]!.reason).toBeUndefined();
  });

  it('REPLACES the static subtree — no source_path appears twice (no-duplication audit, §8 inv. 4)', () => {
    const res = mapIr([ariaTabsTree()], ctx());
    const seen = new Map<string, number>();
    res.nodes.forEach((root) =>
      walk(root, (n) => seen.set(n.source_path, (seen.get(n.source_path) ?? 0) + 1)),
    );
    for (const [path, count] of seen) {
      expect(count, `source_path "${path}" appears ${String(count)} times`).toBe(1);
    }
    // the original trigger/panel/content paths each appear exactly once
    for (const p of ['r', 'r/list', 'r/list/t1', 'r/list/t2', 'r/p1', 'r/p1/x', 'r/p2', 'r/p2/x']) {
      expect(seen.get(p)).toBe(1);
    }
    // and the restructured root records NO fallback (it landed on its native target)
    expect(res.fallbacks.find((f) => f.source_path === 'r')).toBeUndefined();
  });

  it('trigger/panel count mismatch → NO restructure, behavior tier 4 (unpaired) + warning', () => {
    const tree = ariaTabsTree();
    tree.children = tree.children.slice(0, 2); // drop panel p2 → 2 triggers vs 1 panel
    const res = mapIr([tree], ctx());
    expect(res.nodes[0]!.target.elType).toBe('e-div-block'); // normal static mapping
    const tagged = mappedBehavior(res.nodes, 'tabs');
    expect(tagged.tier).toBe(4);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.tabs_unpaired);
    expect(res.warnings.some((w) => w.includes('tabs behavior detected'))).toBe(true);
  });

  it('atomic inactive → behavior tier 4 (e-tabs family unavailable), no restructure', () => {
    const res = mapIr([ariaTabsTree()], ctx({ capabilities: caps({ atomic: false }) }));
    const tagged = mappedBehavior(res.nodes, 'tabs');
    expect(tagged.tier).toBe(4);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.tabs_atomic_inactive);
  });

  it('content dropped by the replacement (non-trigger/panel text) is WARNED, never silent', () => {
    const tree = ariaTabsTree();
    tree.children.push(
      node({ source_path: 'r/extra', tag: 'p', role: 'text', textRuns: text('Stray note') }),
    );
    const res = mapIr([tree], ctx());
    expect(res.nodes[0]!.target.elType).toBe('e-tabs'); // still restructures
    expect(res.warnings.some((w) => w.includes('r/extra') && w.includes('dropped'))).toBe(true);
  });

  it('a behavior on the TABLIST rides its e-tabs-menu (untiered — the tier-2 stage owns it), never silently dropped', () => {
    const tree = ariaTabsTree();
    const tablist = tree.children[0]!;
    withBehaviors(tablist, behavior('entrance-animation', ['r/list']));
    const res = mapIr([tree], ctx());
    const entrance = collectDetectedBehaviors(res.nodes).filter(
      (b) => b.kind === 'entrance-animation',
    );
    expect(entrance).toHaveLength(1); // count(detected) == count(reported), §8 inv. 1
    const menu = res.nodes[0]!.children[0]!;
    expect(menu.behaviors?.map((b) => b.kind)).toEqual(['entrance-animation']);
    expect(menu.behaviors![0]!.tier).toBeUndefined(); // tier-2 kind passes through to its stage
    expect(tablist.behaviors![0]!.tier).toBeUndefined(); // purity: input IR untouched
  });

  it('a MAP-owned kind on a tab PANEL (e.g. a swiper carousel) leaves tier-TAGGED — coverage never sees it untiered', () => {
    const tree = ariaTabsTree();
    withBehaviors(tree.children[1]!, behavior('carousel', ['r/p1']));
    const res = mapIr([tree], ctx());
    const carousel = mappedBehavior(res.nodes, 'carousel');
    expect(carousel.tier).toBe(4);
    expect(carousel.reason).toBe(BEHAVIOR_TIER_REASONS.carousel_dropped);
  });

  it('a MAP-owned kind on a tab TRIGGER leaves tier-TAGGED (the e-tab host carries it)', () => {
    const tree = ariaTabsTree();
    withBehaviors(tree.children[0]!.children[0]!, behavior('marquee', ['r/list/t1']));
    const res = mapIr([tree], ctx());
    const marquee = mappedBehavior(res.nodes, 'marquee');
    expect(marquee.tier).toBe(4);
    expect(marquee.reason).toBe(BEHAVIOR_TIER_REASONS.marquee_dropped);
  });

  it('a behavior on a trigger DESCENDANT (only the synthetic label survives) is orphan-tagged tier 4, never silent', () => {
    const tree = ariaTabsTree();
    const t1 = tree.children[0]!.children[0]!;
    const span = node({
      source_path: 'r/list/t1/span',
      tag: 'span',
      role: 'text',
      textRuns: text('new'),
    });
    withBehaviors(span, behavior('entrance-animation', ['r/list/t1/span']));
    t1.children = [span];
    const res = mapIr([tree], ctx());
    const orphan = mappedBehavior(res.nodes, 'entrance-animation');
    expect(orphan.tier).toBe(4);
    expect(orphan.reason).toBe(BEHAVIOR_TIER_REASONS.host_replaced);
    // …but its text is CONSUMED into the tab label — no false "content dropped" warning
    expect(res.warnings.some((w) => w.includes('r/list/t1/span'))).toBe(false);
    const label = res.nodes[0]!.children[0]!.children[0]!.children[0]!;
    expect(label.settings_seed['paragraph']).toContain('new');
  });

  it('root === tablist: menu is synthetic, tablist styles move to the menu (not applied twice)', () => {
    const t1 = node({ source_path: 'tl/t1', tag: 'button', role: 'tab', textRuns: text('A') });
    const p1 = node({ source_path: 'tl/p1', tag: 'div', role: 'tab-content' });
    const tree = withBehaviors(
      node({
        source_path: 'tl',
        tag: 'div',
        role: 'tabs',
        computed: { display: 'flex' },
        children: [t1, p1],
      }),
      behavior('tabs', ['tl']),
    );
    const res = mapIr([tree], ctx());
    const root = res.nodes[0]!;
    expect(root.target.elType).toBe('e-tabs');
    expect(root.computed).toEqual({}); // stripped — row layout lives on the menu
    const menu = root.children[0]!;
    expect(menu.source_path).toBe('tl::e-tabs-menu');
    expect(menu.computed['display']).toBe('flex');
  });
});

describe('mapIr: form behavior tier + e-form family completion (contract 16 §3)', () => {
  function formWithBehavior(attrs: Record<string, string> = {}): IrNode {
    return withBehaviors(
      node({
        source_path: 'fb',
        tag: 'form',
        role: 'form',
        attrs,
        children: [
          node({
            source_path: 'fb/email',
            tag: 'input',
            role: 'form-field',
            attrs: { type: 'email' },
          }),
          node({
            source_path: 'fb/send',
            tag: 'button',
            role: 'button',
            textRuns: text('Send'),
          }),
        ],
      }),
      behavior('form', ['fb', 'fb/email']),
    );
  }

  it('native e-form path → behavior tier 1; reason reports actions NOT converted', () => {
    const res = mapIr([formWithBehavior()], ctx());
    const tagged = mappedBehavior(res.nodes, 'form');
    expect(tagged.tier).toBe(1);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.form_native);
    expect(tagged.reason).toContain('NOT converted');
  });

  it('a source form `action` is surfaced as a warning (reported, not converted)', () => {
    const res = mapIr([formWithBehavior({ action: '/api/contact' })], ctx());
    expect(
      res.warnings.some(
        (w) => w.includes('form action "/api/contact"') && w.includes('NOT converted'),
      ),
    ).toBe(true);
  });

  it('e_pro_atomic_form OFF → behavior tier 4 (static approximation, does not submit)', () => {
    const res = mapIr(
      [formWithBehavior()],
      ctx({ capabilities: caps({ pro: true, pro_atomic_form: false }) }),
    );
    const tagged = mappedBehavior(res.nodes, 'form');
    expect(tagged.tier).toBe(4);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.form_unavailable);
  });

  it('a submit <button> INSIDE the active e-form → e-form-submit-button with html-v3 text seed', () => {
    const res = mapIr([formWithBehavior()], ctx());
    const submit = res.nodes[0]!.children[1]!;
    expect(effectiveType(submit.target)).toBe('e-form-submit-button');
    expect(submit.settings_seed['text']).toBe('Send');
  });

  it('an <input type=submit> form-field → e-form-submit-button, text from the value attr', () => {
    const tree = node({
      source_path: 'f2',
      tag: 'form',
      role: 'form',
      children: [
        node({
          source_path: 'f2/go',
          tag: 'input',
          role: 'form-field',
          attrs: { type: 'submit', value: 'Go' },
        }),
      ],
    });
    const res = mapIr([tree], ctx());
    const submit = res.nodes[0]!.children[0]!;
    expect(effectiveType(submit.target)).toBe('e-form-submit-button');
    expect(submit.settings_seed['text']).toBe('Go');
  });

  it('a button OUTSIDE any form stays e-button', () => {
    const btn = node({ source_path: 'b', tag: 'button', role: 'button', textRuns: text('Hi') });
    expect(effectiveType(mapOne(btn).target)).toBe('e-button');
  });
});

describe('mapIr: video-embed / carousel / nav-toggle behavior tiers (contract 16 §3)', () => {
  it('video-embed (youtube) → tier 1, routed to e-youtube', () => {
    const vid = withBehaviors(
      node({
        source_path: 'v',
        tag: 'iframe',
        role: 'media-embed-youtube',
        media: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=x' },
      }),
      behavior('video-embed', ['v']),
    );
    const res = mapIr([vid], ctx());
    const tagged = mappedBehavior(res.nodes, 'video-embed');
    expect(tagged.tier).toBe(1);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.video_youtube);
    expect(effectiveType(res.nodes[0]!.target)).toBe('e-youtube');
  });

  it('video-embed (self-hosted) → tier 1, routed to e-self-hosted-video', () => {
    const vid = withBehaviors(
      node({
        source_path: 'v2',
        tag: 'video',
        role: 'media-embed-video',
        media: { kind: 'video', url: 'https://cdn.x/clip.mp4' },
      }),
      behavior('video-embed', ['v2']),
    );
    const tagged = mappedBehavior(mapIr([vid], ctx()).nodes, 'video-embed');
    expect(tagged.tier).toBe(1);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.video_self_hosted);
  });

  it('carousel → tier 4 with the honest drop reason; mapping itself is unchanged', () => {
    const car = withBehaviors(
      node({
        source_path: 'car',
        tag: 'div',
        role: 'structural-block',
        children: [node({ source_path: 'car/s1', tag: 'div', role: 'structural-block' })],
      }),
      behavior('carousel', ['car']),
    );
    const res = mapIr([car], ctx());
    const tagged = mappedBehavior(res.nodes, 'carousel');
    expect(tagged.tier).toBe(4);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.carousel_dropped);
    expect(res.nodes[0]!.target.elType).toBe('e-div-block');
  });

  it('nav-toggle → tier 4 with the honest drop reason', () => {
    const nav = withBehaviors(
      node({ source_path: 'nt', tag: 'nav', role: 'nav-menu' }),
      behavior('nav-toggle', ['nt']),
    );
    const tagged = mappedBehavior(mapIr([nav], ctx()).nodes, 'nav-toggle');
    expect(tagged.tier).toBe(4);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.nav_toggle_dropped);
  });

  it('marquee / countdown → tier 4 honest drops (no native target on any tier)', () => {
    const n = withBehaviors(
      node({ source_path: 'mq', tag: 'div', role: 'structural-block' }),
      behavior('marquee', ['mq']),
      behavior('countdown', ['mq']),
    );
    const all = collectDetectedBehaviors(mapIr([n], ctx()).nodes);
    expect(all.find((b) => b.kind === 'marquee')?.tier).toBe(4);
    expect(all.find((b) => b.kind === 'marquee')?.reason).toBe(
      BEHAVIOR_TIER_REASONS.marquee_dropped,
    );
    expect(all.find((b) => b.kind === 'countdown')?.tier).toBe(4);
    expect(all.find((b) => b.kind === 'countdown')?.reason).toBe(
      BEHAVIOR_TIER_REASONS.countdown_dropped,
    );
  });

  it('tier-2/3 kinds (entrance-animation / hover-effect / custom-js) pass through UNTAGGED', () => {
    const n = withBehaviors(
      node({ source_path: 'an', tag: 'div', role: 'structural-block' }),
      behavior('entrance-animation', ['an']),
      behavior('hover-effect', ['an']),
      behavior('custom-js', ['an']),
    );
    const all = collectDetectedBehaviors(mapIr([n], ctx()).nodes);
    expect(all).toHaveLength(3);
    for (const b of all) {
      expect(b.tier).toBeUndefined();
      expect(b.reason).toBeUndefined();
    }
  });
});

describe('mapIr: accordion behavior — classic nested-accordion per the recon verdict (contract 16 §3)', () => {
  function detailsAccordion(): IrNode {
    const summary = node({
      source_path: 'acc/sum',
      tag: 'summary',
      role: 'structural-block',
      textRuns: text('What is it?'),
    });
    const content = node({
      source_path: 'acc/body',
      tag: 'div',
      role: 'structural-block',
      children: [
        node({ source_path: 'acc/body/p', tag: 'p', role: 'text', textRuns: text('An answer.') }),
      ],
    });
    return withBehaviors(
      node({
        source_path: 'acc',
        tag: 'details',
        role: 'accordion',
        children: [summary, content],
      }),
      behavior('accordion', ['acc', 'acc/sum', 'acc/body']),
    );
  }

  it('details/summary → classic nested-accordion: items repeater + container child with the converted content', () => {
    const res = mapIr([detailsAccordion()], ctx());
    const m = res.nodes[0]!;
    expect(effectiveType(m.target)).toBe('nested-accordion');
    expect(m.target.elType).toBe('widget');
    const items = m.settings_seed['items'] as Array<{ _id: string; item_title: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.item_title).toBe('What is it?');
    expect(items[0]!._id).toMatch(/^[0-9a-f]{7}$/);
    // one classic container child per item, content_width:full (upstream item shape)
    expect(m.children).toHaveLength(1);
    const item = m.children[0]!;
    expect(item.target.elType).toBe('container');
    expect(item.settings_seed['content_width']).toBe('full');
    // the item content is the RECURSIVELY converted panel subtree
    expect(item.children[0]!.source_path).toBe('acc/body');
    expect(item.children[0]!.children[0]!.target.widgetType).toBe('e-paragraph');
  });

  it('tags the behavior tier 1 + records the node on the v3_classic whole-node ladder', () => {
    const res = mapIr([detailsAccordion()], ctx());
    const tagged = mappedBehavior(res.nodes, 'accordion');
    expect(tagged.tier).toBe(1);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.accordion_native);
    const fb = res.fallbacks.find((f) => f.source_path === 'acc');
    expect(fb?.tier).toBe('v3_classic');
  });

  it('repeater _ids are deterministic across runs (mapIr stays pure)', () => {
    const a = mapIr([detailsAccordion()], ctx());
    const b = mapIr([detailsAccordion()], ctx());
    expect(JSON.stringify(a.nodes[0]!.settings_seed)).toBe(
      JSON.stringify(b.nodes[0]!.settings_seed),
    );
  });

  it('capability check: a POPULATED classic registry WITHOUT nested-accordion degrades to tier 4', () => {
    const res = mapIr(
      [detailsAccordion()],
      ctx({
        capabilities: caps({ registered_types: { atomic: [], classic: ['heading', 'button'] } }),
      }),
    );
    expect(res.nodes[0]!.target.elType).toBe('e-div-block'); // stacked-sections approximation
    const tagged = mappedBehavior(res.nodes, 'accordion');
    expect(tagged.tier).toBe(4);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.accordion_not_registered);
  });

  it('capability check: a populated registry WITH nested-accordion allows the tier-1 path', () => {
    const res = mapIr(
      [detailsAccordion()],
      ctx({
        capabilities: caps({
          registered_types: { atomic: [], classic: ['heading', 'nested-accordion'] },
        }),
      }),
    );
    expect(effectiveType(res.nodes[0]!.target)).toBe('nested-accordion');
  });

  it('aria-expanded trigger + sibling panel pairs extract MULTI-item accordions', () => {
    const tree = withBehaviors(
      node({
        source_path: 'faq',
        tag: 'div',
        role: 'structural-block',
        children: [
          node({
            source_path: 'faq/q1',
            tag: 'button',
            role: 'button',
            attrs: { 'aria-expanded': 'false' },
            textRuns: text('Q1'),
          }),
          node({ source_path: 'faq/a1', tag: 'div', role: 'structural-block' }),
          node({
            source_path: 'faq/q2',
            tag: 'button',
            role: 'button',
            attrs: { 'aria-expanded': 'false' },
            textRuns: text('Q2'),
          }),
          node({ source_path: 'faq/a2', tag: 'div', role: 'structural-block' }),
        ],
      }),
      behavior('accordion', ['faq']),
    );
    const res = mapIr([tree], ctx());
    const m = res.nodes[0]!;
    expect(effectiveType(m.target)).toBe('nested-accordion');
    const items = m.settings_seed['items'] as Array<{ _id: string; item_title: string }>;
    expect(items.map((i) => i.item_title)).toEqual(['Q1', 'Q2']);
    expect(m.children).toHaveLength(2);
    expect(m.children[0]!.children[0]!.source_path).toBe('faq/a1');
    expect(m.children[1]!.children[0]!.source_path).toBe('faq/a2');
  });

  it('items not structurally extractable (classname-only) → tier 4, stacked sections', () => {
    const tree = withBehaviors(
      node({
        source_path: 'cls',
        tag: 'div',
        role: 'structural-block',
        children: [node({ source_path: 'cls/x', tag: 'div', role: 'structural-block' })],
      }),
      behavior('accordion', ['cls']),
    );
    const res = mapIr([tree], ctx());
    expect(res.nodes[0]!.target.elType).toBe('e-div-block');
    const tagged = mappedBehavior(res.nodes, 'accordion');
    expect(tagged.tier).toBe(4);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.accordion_unextractable);
  });

  it('atomic inactive → tier 4 (V3 fallback path, behavior conversion not verified there)', () => {
    const res = mapIr([detailsAccordion()], ctx({ capabilities: caps({ atomic: false }) }));
    const tagged = mappedBehavior(res.nodes, 'accordion');
    expect(tagged.tier).toBe(4);
    expect(tagged.reason).toBe(BEHAVIOR_TIER_REASONS.accordion_atomic_inactive);
  });

  it('does not mutate the input IR (behaviors stay untiered on the classify-stage tree)', () => {
    const tree = detailsAccordion();
    const snapshot = JSON.stringify(tree);
    mapIr([tree], ctx());
    expect(JSON.stringify(tree)).toBe(snapshot);
  });
});

describe('collectDetectedBehaviors (contract 16 §6 — every MAP-owned kind leaves tiered)', () => {
  it('every tabs/accordion/form/video/carousel/nav-toggle behavior carries a tier after mapIr', () => {
    const forest: IrNode[] = [
      withBehaviors(
        node({ source_path: 'k1', tag: 'div', role: 'structural-block' }),
        behavior('carousel', ['k1']),
      ),
      withBehaviors(
        node({ source_path: 'k2', tag: 'nav', role: 'nav-menu' }),
        behavior('nav-toggle', ['k2']),
      ),
      withBehaviors(
        node({ source_path: 'k3', tag: 'form', role: 'form' }),
        behavior('form', ['k3']),
      ),
      withBehaviors(
        node({
          source_path: 'k4',
          tag: 'iframe',
          role: 'media-embed-youtube',
          media: { kind: 'youtube', url: 'https://youtu.be/x' },
        }),
        behavior('video-embed', ['k4']),
      ),
    ];
    const res = mapIr(forest, ctx());
    const all = collectDetectedBehaviors(res.nodes);
    expect(all).toHaveLength(4);
    for (const b of all) {
      expect(b.tier, `${b.kind} must leave MAP tiered`).toBeDefined();
      expect(b.reason).toBeDefined();
    }
  });
});

/* ─────────────────────────── source-id carry (contract 18 §7 — P2-d) ─────────────────────────── */

describe('mapIr: source element ids carry onto converted nodes (contract 18 §7 P2-d)', () => {
  it('an atomic widget keeps its source id as the renderable `_cssid` setting', () => {
    // `_cssid` is the universal atomic prop the base twig macros render as `id="…"` — the
    // `attributes` transformer is a render no-op, so raw attrs would silently drop.
    const h = node({
      source_path: 'h',
      tag: 'h2',
      role: 'heading',
      attrs: { id: 'pricing' },
      textRuns: text('Pricing'),
    });
    const m = mapOne(h);
    expect(m.settings_seed['_cssid']).toBe('pricing');
    expect(m.settings_seed['_element_id']).toBeUndefined();
  });

  it('an atomic container (section anchor target) keeps its source id too', () => {
    const section = node({
      source_path: 's',
      tag: 'section',
      role: 'structural-block',
      attrs: { id: 'about' },
    });
    const m = mapOne(section);
    expect(m.target.elType.startsWith('e-')).toBe(true);
    expect(m.settings_seed['_cssid']).toBe('about');
  });

  it('a V3-classic target carries the id as the classic `_element_id` setting instead', () => {
    const section = node({
      source_path: 's',
      tag: 'section',
      role: 'structural-block',
      attrs: { id: 'about' },
    });
    const m = mapOne(section, ctx({ generation: 'v3' }));
    expect(m.settings_seed['_element_id']).toBe('about');
    expect(m.settings_seed['_cssid']).toBeUndefined();
  });

  it('no source id (or a whitespace-only one) seeds nothing', () => {
    const plain = mapOne(node({ source_path: 'p', tag: 'p', role: 'text', textRuns: text('x') }));
    expect(plain.settings_seed['_cssid']).toBeUndefined();
    expect(plain.settings_seed['_element_id']).toBeUndefined();
    const blank = mapOne(
      node({ source_path: 'b', tag: 'div', role: 'structural-block', attrs: { id: '   ' } }),
    );
    expect(blank.settings_seed['_cssid']).toBeUndefined();
    expect(blank.settings_seed['_element_id']).toBeUndefined();
  });

  it('a tier-1 restructured pattern ROOT keeps its anchor id (accordion → classic `_element_id`)', () => {
    const summary = node({
      source_path: 'acc/sum',
      tag: 'summary',
      role: 'structural-block',
      textRuns: text('Q?'),
    });
    const content = node({
      source_path: 'acc/body',
      tag: 'div',
      role: 'structural-block',
      children: [node({ source_path: 'acc/body/p', tag: 'p', role: 'text', textRuns: text('A.') })],
    });
    const acc = withBehaviors(
      node({
        source_path: 'acc',
        tag: 'details',
        role: 'accordion',
        attrs: { id: 'faq' },
        children: [summary, content],
      }),
      behavior('accordion', ['acc']),
    );
    const m = mapOne(acc);
    // nested-accordion is a CLASSIC widget inside the V4 document → the classic id setting.
    expect(m.settings_seed['_element_id']).toBe('faq');
    expect(m.settings_seed['items']).toBeDefined();
  });
});
