/**
 * Contract 16 §5 — Tier 3 JS PASSTHROUGH unit tests.
 *
 * Covers the §8 honesty invariants this stage owns: `include_js:'none'` (the default) emits ZERO
 * script bytes (§8.3) while still reporting the census; the analytics denylist excludes-and-reports;
 * the `unfiltered_html` capability gate refuses with a reported reason; `bundled ∪ excluded` always
 * partitions the input census; and the emitted node is ONE V3 classic `html` widget whose `html`
 * settings key is a FLAT string (`plugins/elementor/includes/widgets/html.php`).
 */

import { describe, expect, it } from 'vitest';

import { censusScripts } from './parse.js';
import {
  ANALYTICS_DENYLIST,
  buildJsPassthrough,
  censusScriptsWithContent,
  PASSTHROUGH_MARKER,
  type PassthroughScript,
} from './passthrough.js';

/* ─────────────────────────── fixtures ────────────────────────────────────────────────────────── */

const CAPS_OK = { unfiltered_html: true };
const CAPS_NO = { unfiltered_html: false };

/** Deterministic random source (cycles 0, 1/16, 2/16, … → ids like `0123456`). */
function seededRand(): () => number {
  let i = 0;
  return () => (i++ % 16) / 16;
}

function external(src: string): PassthroughScript {
  return { src, inline_bytes: 0, external: true };
}

function inline(content: string): PassthroughScript {
  return {
    src: null,
    inline_bytes: new TextEncoder().encode(content).length,
    external: false,
    content,
  };
}

/* ─────────────────────────── include_js:'none' (the default) ─────────────────────────────────── */

describe('buildJsPassthrough — none default (§8.3)', () => {
  const scripts = [external('https://cdn.example.com/lib.js'), inline('console.log("hi");')];

  it("include_js:'none' returns a null widget and zero bytes", () => {
    const { widgetNode, report } = buildJsPassthrough(scripts, 'none', CAPS_OK);
    expect(widgetNode).toBeNull();
    expect(report.bundled_bytes).toBe(0);
    expect(report.bundled).toEqual([]);
    expect(report.mode).toBe('none');
  });

  it("undefined include_js defaults to 'none' (the tool-surface default)", () => {
    const { widgetNode, report } = buildJsPassthrough(scripts, undefined, CAPS_OK);
    expect(widgetNode).toBeNull();
    expect(report.mode).toBe('none');
    expect(report.bundled_bytes).toBe(0);
  });

  it('the census is still reported (never silent — §0.2)', () => {
    const { report } = buildJsPassthrough(scripts, 'none', CAPS_OK);
    expect(report.excluded).toHaveLength(2);
    expect(report.excluded.every((e) => e.reason === 'include_js_none')).toBe(true);
  });

  it('an undefined/empty census yields an empty report', () => {
    const empty = buildJsPassthrough(undefined, 'none', CAPS_OK);
    expect(empty.widgetNode).toBeNull();
    expect(empty.report).toEqual({ mode: 'none', bundled: [], excluded: [], bundled_bytes: 0 });
  });
});

/* ─────────────────────────── bundle mode ─────────────────────────────────────────────────────── */

describe('buildJsPassthrough — bundle mode (§5)', () => {
  it('emits ONE classic html widget: external tags + IIFE-wrapped inline, all marked', () => {
    const { widgetNode, report } = buildJsPassthrough(
      [external('https://cdn.example.com/lib.js'), inline('window.x = 1;')],
      'bundle',
      CAPS_OK,
      { rand: seededRand() },
    );
    expect(widgetNode).not.toBeNull();
    expect(widgetNode?.elType).toBe('widget');
    expect(widgetNode?.widgetType).toBe('html');
    expect(widgetNode?.id).toMatch(/^[0-9a-f]{7}$/);
    // V3 classic settings: the `html` key is a FLAT string (html.php CODE control — no envelopes).
    const html = widgetNode?.settings['html'];
    expect(typeof html).toBe('string');
    const payload = html as string;
    expect(payload).toContain(
      `<script ${PASSTHROUGH_MARKER} src="https://cdn.example.com/lib.js">`,
    );
    expect(payload).toContain(`<script ${PASSTHROUGH_MARKER}>`);
    expect(payload).toContain('(function () {\nwindow.x = 1;\n})();');
    expect(report.bundled).toHaveLength(2);
    expect(report.bundled_bytes).toBe(new TextEncoder().encode(payload).length);
  });

  it('bundled ∪ excluded partitions the census (§0.2 — nothing silent)', () => {
    const scripts = [
      external('https://cdn.example.com/lib.js'),
      external('https://www.googletagmanager.com/gtag/js?id=G-1'),
      inline('window.x = 1;'),
      inline(''),
      { src: null, inline_bytes: 42, external: false }, // bytes-only census entry (no content)
      external('/js/app.js'), // relative, no base_url
    ];
    const { report } = buildJsPassthrough(scripts, 'bundle', CAPS_OK);
    expect(report.bundled.length + report.excluded.length).toBe(scripts.length);
    expect(report.excluded.map((e) => e.reason).sort()).toEqual([
      'analytics_denylist',
      'empty_inline',
      'inline_content_unavailable',
      'relative_src_unresolvable',
    ]);
  });

  it('resolves a relative src against base_url; excludes it without one', () => {
    const rel = [external('/js/app.js')];
    const withBase = buildJsPassthrough(rel, 'bundle', CAPS_OK, {
      base_url: 'https://source.example.com/page',
    });
    expect(withBase.widgetNode?.settings['html']).toContain(
      'src="https://source.example.com/js/app.js"',
    );
    const withoutBase = buildJsPassthrough(rel, 'bundle', CAPS_OK);
    expect(withoutBase.widgetNode).toBeNull();
    expect(withoutBase.report.excluded[0]?.reason).toBe('relative_src_unresolvable');
  });

  it('passes protocol-relative srcs verbatim and escapes quotes in the attribute', () => {
    const { widgetNode } = buildJsPassthrough(
      [external('//cdn.example.com/a.js'), external('https://x.example.com/a.js?q="v"')],
      'bundle',
      CAPS_OK,
    );
    const payload = widgetNode?.settings['html'] as string;
    expect(payload).toContain('src="//cdn.example.com/a.js"');
    expect(payload).toContain('src="https://x.example.com/a.js?q=&quot;v&quot;"');
  });

  it('returns null (zero bytes) when nothing is bundleable', () => {
    const { widgetNode, report } = buildJsPassthrough(
      [external('https://static.hotjar.com/c.js')],
      'bundle',
      CAPS_OK,
    );
    expect(widgetNode).toBeNull();
    expect(report.bundled_bytes).toBe(0);
    expect(report.excluded).toHaveLength(1);
  });

  it('mints the widget id against usedIds (no collision with the converted tree)', () => {
    const used = new Set(['0123456']);
    const { widgetNode } = buildJsPassthrough([inline('window.x = 1;')], 'bundle', CAPS_OK, {
      rand: seededRand(),
      usedIds: used,
    });
    expect(widgetNode?.id).not.toBe('0123456');
    expect(used.has(widgetNode?.id as string)).toBe(true);
  });

  it('flags double-handling review when a tier-1/2 behavior was converted (§5)', () => {
    const scripts = [inline('initTabs();')];
    const flagged = buildJsPassthrough(scripts, 'bundle', CAPS_OK, {
      behaviors: [{ kind: 'tabs', confidence: 'high', evidence: [], nodeIds: [], tier: 1 }],
    });
    expect(flagged.report.double_handling_review).toBe(true);
    const unflagged = buildJsPassthrough(scripts, 'bundle', CAPS_OK, {
      behaviors: [{ kind: 'carousel', confidence: 'high', evidence: [], nodeIds: [], tier: 4 }],
    });
    expect(unflagged.report.double_handling_review).toBeUndefined();
  });
});

/* ─────────────────────────── analytics denylist (§5) ─────────────────────────────────────────── */

describe('buildJsPassthrough — analytics denylist (§5)', () => {
  it.each([
    'https://www.googletagmanager.com/gtm.js?id=GTM-1',
    'https://www.google.com/gtag/js',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://static.hotjar.com/c/hotjar-1.js',
    'https://www.clarity.ms/tag/abc',
    'https://cdn.mixpanel.com/mixpanel.js',
    'https://cdn.segment.com/analytics.js/v1/x/analytics.min.js',
    'https://plausible.io/js/script.js',
    'https://cdn.matomo.cloud/matomo.js',
  ])('excludes external %s', (src) => {
    const { widgetNode, report } = buildJsPassthrough([external(src)], 'bundle', CAPS_OK);
    expect(widgetNode).toBeNull();
    expect(report.excluded).toEqual([
      { src, inline_bytes: 0, external: true, reason: 'analytics_denylist' },
    ]);
  });

  it('excludes inline bodies that match the denylist (gtag/fbq bootstraps)', () => {
    const gtagBoot = inline("window.dataLayer = window.dataLayer || []; gtag('js', new Date());");
    const fbqBoot = inline("fbq('init', '123'); fbq('track', 'PageView');");
    const { widgetNode, report } = buildJsPassthrough([gtagBoot, fbqBoot], 'bundle', CAPS_OK);
    expect(widgetNode).toBeNull();
    expect(report.excluded.every((e) => e.reason === 'analytics_denylist')).toBe(true);
  });

  it('keeps non-analytics scripts alongside excluded analytics ones', () => {
    const { widgetNode, report } = buildJsPassthrough(
      [external('https://www.googletagmanager.com/gtag/js'), inline('initMenu();')],
      'bundle',
      CAPS_OK,
    );
    expect(report.bundled).toHaveLength(1);
    expect(report.excluded).toHaveLength(1);
    const payload = widgetNode?.settings['html'] as string;
    expect(payload).not.toContain('googletagmanager');
    expect(payload).toContain('initMenu();');
  });

  it('the exported denylist matches every contract-named tracker', () => {
    for (const probe of [
      'gtag',
      'googletagmanager',
      'fbq',
      'facebook',
      'hotjar',
      'clarity',
      'mixpanel',
      'segment',
      'plausible',
      'matomo',
    ]) {
      expect(ANALYTICS_DENYLIST.test(probe)).toBe(true);
    }
    expect(ANALYTICS_DENYLIST.test('https://cdn.example.com/lib.js')).toBe(false);
  });
});

/* ─────────────────────────── capability gate (§5) ────────────────────────────────────────────── */

describe('buildJsPassthrough — unfiltered_html gate (§5)', () => {
  it('refuses bundling without unfiltered_html, reporting every script', () => {
    const scripts = [external('https://cdn.example.com/lib.js'), inline('window.x = 1;')];
    const { widgetNode, report } = buildJsPassthrough(scripts, 'bundle', CAPS_NO);
    expect(widgetNode).toBeNull();
    expect(report.bundled_bytes).toBe(0);
    expect(report.blocked_reason).toBe('unfiltered_html_missing');
    expect(report.excluded).toHaveLength(2);
    expect(report.excluded.every((e) => e.reason === 'unfiltered_html_missing')).toBe(true);
  });
});

/* ─────────────────────────── content-capturing census ────────────────────────────────────────── */

describe('censusScriptsWithContent — lockstep with parse.censusScripts', () => {
  const html = `<!doctype html><html><head>
    <script src="https://cdn.example.com/lib.js"></script>
    <script>console.log("inline one");</script>
    <script src='/js/app.js' defer></script>
  </head><body><script type="module">window.go = () => 1;</script></body></html>`;

  it('PageScript fields are identical to the frozen census', () => {
    const withContent = censusScriptsWithContent(html);
    const frozen = censusScripts(html);
    expect(
      withContent.map(({ src, inline_bytes, external: ext }) => ({
        src,
        inline_bytes,
        external: ext,
      })),
    ).toEqual(frozen);
  });

  it('captures inline bodies (and only inline bodies)', () => {
    const scripts = censusScriptsWithContent(html);
    expect(scripts).toHaveLength(4);
    expect(scripts[0]?.content).toBeUndefined(); // external
    expect(scripts[1]?.content).toBe('console.log("inline one");');
    expect(scripts[2]?.content).toBeUndefined(); // external
    expect(scripts[3]?.content).toBe('window.go = () => 1;');
  });

  it('round-trips into a bundle', () => {
    const { widgetNode } = buildJsPassthrough(censusScriptsWithContent(html), 'bundle', CAPS_OK, {
      base_url: 'https://source.example.com/',
    });
    const payload = widgetNode?.settings['html'] as string;
    expect(payload).toContain('src="https://cdn.example.com/lib.js"');
    expect(payload).toContain('src="https://source.example.com/js/app.js"');
    expect(payload).toContain('console.log("inline one");');
    expect(payload).toContain('window.go = () => 1;');
  });
});
