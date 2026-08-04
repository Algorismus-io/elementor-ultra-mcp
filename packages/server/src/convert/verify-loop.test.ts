/**
 * W2 — verification-loop tests (contract 17 §2–3 + the contract 18 §7 P1-d/P1-e/P3-b hardening).
 *
 * Three layers, mirroring the fidelity/parse test structure:
 *   (1) PURE core — value comparison (incl. P3-b notation normalization), cause attribution
 *       (incl. P1-d shorthand/logical ledger matching), element matching, V1 diff, V2 audits
 *       (incl. P1-d real-viewport measurement), the P1-e content-presence audit, opacity-probe
 *       judging, gate composition, R1 repair derivation. No browser, always runs.
 *   (2) STUBBED BrowserPort — `runVerifyLoop` end-to-end over canned snapshots + tiny PNGs
 *       (requires `pixelmatch`/`pngjs`; skips cleanly when absent).
 *   (3) LIVE Chromium (WP-H03 pool) — a real source-vs-converted render pair via `data:` URLs,
 *       the behavioral scrollIn probe, and THE Driftwell corpus guard (§7 P1-e: the committed
 *       fixture must FAIL the hardened gate when degraded the way v17.0 conversions degraded it,
 *       and PASS only when the page is actually right); skips cleanly when Chromium is unavailable.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { closeBrowser } from './browser-pool.js';
import type { BrowserPort } from './fidelity.js';
import {
  ATTRIBUTED_RATIO_TARGET,
  BASE_DEFAULT_PAINTED_PROPS,
  DEFAULT_HEIGHT_TOLERANCE,
  MAX_REPAIR_ROUNDS,
  VERIFY_DEVICE_WIDTHS,
  VERIFY_PROPS,
  attributeCause,
  auditContentPresence,
  auditLayout,
  computeCauseStats,
  deriveRepairs,
  diffMatchedElements,
  evaluateVerifyGate,
  judgeOpacityProbe,
  matchElements,
  normalizeNotation,
  propMatchCandidates,
  runVerifyLoop,
  valuesDiverge,
  verifyRenderWidth,
} from './verify-loop.js';
import type {
  Divergence,
  ElementSnapshot,
  LayoutAudit,
  MatchedElement,
  PageSnapshot,
  VerifyLoopResult,
} from './verify-loop.js';
import type { DeclFallback } from './types.js';

/* ─────────────────────────── snapshot builders ───────────────────────────────────────────────── */

function el(overrides: Partial<ElementSnapshot> = {}): ElementSnapshot {
  return {
    tag: 'div',
    props: {},
    area: 1000,
    visible: true,
    text: '',
    base_classes: [],
    dangling_refs: [],
    ...overrides,
  };
}

function pageSnap(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    elements: {},
    text_nodes: [],
    body_text: '',
    element_count: 0,
    scroll_width: 1440,
    scroll_height: 2000,
    viewport_width: 1440,
    overflow_x: 'visible',
    first_element_id: '',
    ...overrides,
  };
}

function match(overrides: Partial<MatchedElement> = {}): MatchedElement {
  return {
    source_path: 'body>div',
    element: 'abc1234',
    source: el(),
    converted: el(),
    ...overrides,
  };
}

/* ─────────────────────────── (1) pure: valuesDiverge ─────────────────────────────────────────── */

describe('valuesDiverge', () => {
  it('treats identical values as non-divergent', () => {
    expect(valuesDiverge('color', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)')).toBe(false);
    expect(valuesDiverge('display', 'flex', 'flex')).toBe(false);
  });

  it('tolerates px jitter within max(2px, 3%) but flags real deltas', () => {
    expect(valuesDiverge('font-size', '16px', '17px')).toBe(false); // 1px jitter
    expect(valuesDiverge('width', '1000px', '1020px')).toBe(false); // 2% of 1020
    expect(valuesDiverge('width', '1000px', '1100px')).toBe(true); // 10%
    expect(valuesDiverge('padding-top', '0px', '10px')).toBe(true); // the e-flexbox 10px base
  });

  it('compares colors channel-wise with a small tolerance', () => {
    expect(valuesDiverge('color', 'rgb(12, 107, 74)', 'rgb(13, 106, 75)')).toBe(false);
    expect(valuesDiverge('color', 'rgb(12, 107, 74)', 'rgb(56, 95, 243)')).toBe(true);
  });

  it('treats any fully-transparent pair as equal (ghost buttons stay ghosts)', () => {
    expect(valuesDiverge('background-color', 'rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0)')).toBe(
      false,
    );
    // transparent source vs the painted e-button base blue IS a divergence:
    expect(valuesDiverge('background-color', 'rgba(0, 0, 0, 0)', 'rgb(56, 95, 243)')).toBe(true);
  });

  it('compares font-family by FIRST family, unquoted + case-insensitive', () => {
    expect(
      valuesDiverge('font-family', '"Bricolage Grotesque", sans-serif', 'bricolage grotesque'),
    ).toBe(false);
    expect(valuesDiverge('font-family', '"Bricolage Grotesque", sans-serif', 'Inter, serif')).toBe(
      true,
    );
  });

  it('treats url()→url() background-image pairs as equal (sideloading rewrites the URL)', () => {
    expect(
      valuesDiverge(
        'background-image',
        'url("https://source.example/hero.png")',
        'url("http://localhost:8899/wp-content/uploads/hero.png")',
      ),
    ).toBe(false);
    expect(valuesDiverge('background-image', 'url("x.png")', 'none')).toBe(true);
  });
});

/* ─────────────────────────── (1) pure: notation normalization (§7 P3-b) ──────────────────────── */

describe('normalizeNotation (P3-b)', () => {
  it('strips the redundant 0%/100% first/last gradient stops (the Driftwell noise class)', () => {
    expect(
      normalizeNotation('linear-gradient(135deg, rgb(238, 240, 255) 0%, rgb(232, 251, 244) 100%)'),
    ).toBe('linear-gradient(135deg, rgb(238, 240, 255), rgb(232, 251, 244))');
    // … so the pair never counts as a divergence (the P3-b corpus guard):
    expect(
      valuesDiverge(
        'background-image',
        'linear-gradient(135deg, rgb(238, 240, 255), rgb(232, 251, 244))',
        'linear-gradient(135deg, rgb(238, 240, 255) 0%, rgb(232, 251, 244) 100%)',
      ),
    ).toBe(false);
  });

  it('keeps SEMANTIC stop positions (middle stops, non-default first/last)', () => {
    const middle =
      'linear-gradient(135deg, rgb(238, 240, 255) 0%, rgb(247, 243, 255) 55%, rgb(232, 251, 244) 100%)';
    expect(normalizeNotation(middle)).toBe(
      'linear-gradient(135deg, rgb(238, 240, 255), rgb(247, 243, 255) 55%, rgb(232, 251, 244))',
    );
    // A non-default first stop is meaning, not notation:
    expect(normalizeNotation('linear-gradient(rgb(0, 0, 0) 20%, rgb(255, 255, 255))')).toBe(
      'linear-gradient(rgb(0, 0, 0) 20%, rgb(255, 255, 255))',
    );
    expect(
      valuesDiverge(
        'background-image',
        'linear-gradient(rgb(0, 0, 0) 20%, rgb(255, 255, 255))',
        'linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))',
      ),
    ).toBe(true);
  });

  it('handles radial/conic/repeating gradients and non-gradient values untouched', () => {
    expect(
      normalizeNotation('radial-gradient(circle at 50% 50%, rgb(1, 2, 3) 0%, rgb(4, 5, 6) 100%)'),
    ).toBe('radial-gradient(circle at 50% 50%, rgb(1, 2, 3), rgb(4, 5, 6))');
    expect(normalizeNotation('RGB(0, 0, 0)')).toBe('rgb(0, 0, 0)');
    expect(normalizeNotation('  flex ')).toBe('flex');
  });
});

/* ─────────────────────────── (1) pure: verifyRenderWidth (§7 P1-d V2) ────────────────────────── */

describe('verifyRenderWidth (P1-d — measure INSIDE the breakpoint range)', () => {
  it('renders a max-direction breakpoint at its DEVICE width, never the boundary (the 743/390 lie)', () => {
    // Elementor's live mobile spec is {width: 767, direction: 'max'} — the v17.0 loop rendered AT
    // 767, so a 743px-wide layout "passed mobile". The hardened loop renders inside the range.
    expect(verifyRenderWidth({ key: 'mobile', width: 767, direction: 'max' })).toBe(390);
    expect(verifyRenderWidth({ key: 'tablet', width: 1024, direction: 'max' })).toBe(768);
    expect(VERIFY_DEVICE_WIDTHS['mobile']).toBe(390);
  });

  it('min-direction breakpoints stress their own boundary; unmapped/narrow customs fall back', () => {
    expect(verifyRenderWidth({ key: 'desktop', width: 1280, direction: 'min' })).toBe(1280);
    expect(verifyRenderWidth({ key: 'widescreen', width: 2400, direction: 'min' })).toBe(2400);
    // A site whose custom mobile boundary sits BELOW the device width renders at the boundary
    // (the device width would be OUTSIDE the breakpoint's range):
    expect(verifyRenderWidth({ key: 'mobile', width: 360, direction: 'max' })).toBe(360);
    expect(verifyRenderWidth({ key: 'kiosk', width: 500, direction: 'max' })).toBe(500);
  });
});

/* ─────────────────────────── (1) pure: attributeCause ────────────────────────────────────────── */

describe('attributeCause', () => {
  const path = 'body>div>a';

  it('dangling_ref wins over everything (I1 direction 1)', () => {
    expect(
      attributeCause({
        source_path: path,
        prop: 'background-color',
        converted: { base_classes: ['e-button-base'], dangling_refs: ['e-abc1234-deadbee'] },
      }),
    ).toBe('dangling_ref');
  });

  it('font-family diffs attribute font_not_carried (contract #9 loop guard)', () => {
    expect(
      attributeCause({
        source_path: path,
        prop: 'font-family',
        converted: { base_classes: [], dangling_refs: [] },
      }),
    ).toBe('font_not_carried');
  });

  it('reads the I3 tier ledger: custom_css → custom_css_unrendered, html_widget → dropped_declaration', () => {
    const ledger: DeclFallback[] = [
      {
        source_path: path,
        declaration: 'color: oklch(0.5 0.1 150)',
        tier: 'custom_css',
        reason: 'unmappable',
      },
      {
        source_path: path,
        declaration: 'width: fit-content',
        tier: 'html_widget',
        reason: 'no native prop',
      },
    ];
    expect(
      attributeCause({
        source_path: path,
        prop: 'color',
        converted: { base_classes: [], dangling_refs: [] },
        ledger,
      }),
    ).toBe('custom_css_unrendered');
    expect(
      attributeCause({
        source_path: path,
        prop: 'width',
        converted: { base_classes: [], dangling_refs: [] },
        ledger,
      }),
    ).toBe('dropped_declaration');
  });

  it('pseudo_unrepresentable: own-row reason AND pseudo-child paths (#10)', () => {
    const own: DeclFallback[] = [
      {
        source_path: path,
        declaration: 'background-color: red',
        tier: 'custom_css',
        reason: 'pseudo_unrepresentable mask',
      },
    ];
    expect(
      attributeCause({
        source_path: path,
        prop: 'background-color',
        converted: { base_classes: [], dangling_refs: [] },
        ledger: own,
      }),
    ).toBe('pseudo_unrepresentable');

    const child: DeclFallback[] = [
      {
        source_path: `${path}::before`,
        declaration: 'content: ""',
        tier: 'html_widget',
        reason: 'pseudo_unrepresentable',
      },
    ];
    expect(
      attributeCause({
        source_path: path,
        prop: 'height',
        converted: { base_classes: [], dangling_refs: [] },
        ledger: child,
      }),
    ).toBe('pseudo_unrepresentable');
  });

  it('base_default: prop in the painted base set of a carried base class (I2)', () => {
    expect(
      attributeCause({
        source_path: path,
        prop: 'background-color',
        converted: { base_classes: ['e-button-base'], dangling_refs: [] },
      }),
    ).toBe('base_default');
    expect(
      attributeCause({
        source_path: path,
        prop: 'padding-top',
        converted: { base_classes: ['e-flexbox-base'], dangling_refs: [] },
      }),
    ).toBe('base_default');
    expect(
      attributeCause({
        source_path: path,
        prop: 'width',
        converted: { base_classes: ['e-svg-base'], dangling_refs: [] },
      }),
    ).toBe('base_default');
  });

  it('falls through to unknown (R2 territory — never guessed)', () => {
    expect(
      attributeCause({
        source_path: path,
        prop: 'display',
        converted: { base_classes: ['e-div-block-base'], dangling_refs: [] },
      }),
    ).toBe('unknown');
  });

  it('the base-default table only names painting widgets (e-div-block is neutral)', () => {
    expect(Object.keys(BASE_DEFAULT_PAINTED_PROPS)).toEqual([
      'e-button-base',
      'e-flexbox-base',
      'e-svg-base',
    ]);
  });
});

/* ─────────────────────────── (1) pure: shorthand/logical ledger matching (§7 P1-d) ───────────── */

describe('attributeCause — shorthand/logical declaration matching (P1-d)', () => {
  const path = 'body>section>div';
  const noRefs = { base_classes: [], dangling_refs: [] };
  const row = (declaration: string, tier: DeclFallback['tier'] = 'html_widget'): DeclFallback => ({
    source_path: path,
    declaration,
    tier,
    reason: 'no native prop',
  });

  it('a SHORTHAND ledger row covers its longhands (authors write shorthands — the 100%-unknown bug)', () => {
    const ledger = [
      row('background: linear-gradient(135deg, #eef0ff, #e8fbf4)', 'custom_css'),
      row('padding: 24px 32px'),
      row('border: 1px solid #e3e6f2'),
      row('font: 600 13px/1.2 Inter'),
      row('border-radius: 14px', 'custom_css'),
    ];
    const cause = (prop: string): string =>
      attributeCause({ source_path: path, prop, converted: noRefs, ledger });
    expect(cause('background-color')).toBe('custom_css_unrendered');
    expect(cause('background-image')).toBe('custom_css_unrendered');
    expect(cause('padding-top')).toBe('dropped_declaration');
    expect(cause('border-top-width')).toBe('dropped_declaration');
    expect(cause('border-top-style')).toBe('dropped_declaration');
    expect(cause('font-size')).toBe('dropped_declaration');
    expect(cause('border-top-left-radius')).toBe('custom_css_unrendered');
  });

  it('LOGICAL spellings cover their physical longhands (padding-inline-start → padding-left)', () => {
    const ledger = [row('padding-inline-start: 24px'), row('border-block-start-width: 2px')];
    expect(
      attributeCause({ source_path: path, prop: 'padding-left', converted: noRefs, ledger }),
    ).toBe('dropped_declaration');
    expect(
      attributeCause({ source_path: path, prop: 'border-top-width', converted: noRefs, ledger }),
    ).toBe('dropped_declaration');
    expect(propMatchCandidates('padding-left')).toContain('padding-inline-start');
    expect(propMatchCandidates('border-top-left-radius')).toContain('border-radius');
  });

  it('an unrelated declaration still does NOT cover the prop (no over-attribution)', () => {
    const ledger = [row('margin: 0 auto'), row('color: #15203b')];
    expect(
      attributeCause({ source_path: path, prop: 'background-color', converted: noRefs, ledger }),
    ).toBe('unknown');
  });
});

/* ─────────────────────────── (1) pure: computeCauseStats (§7 P1-d corpus guard) ──────────────── */

describe('computeCauseStats (P1-d — ≥80% non-unknown causes)', () => {
  const div = (cause: Divergence['cause'], prop = 'color'): Divergence => ({
    element: 'abc1234',
    source_path: 'body>div',
    prop,
    source_value: 'a',
    converted_value: 'b',
    cause,
    breakpoint: 'desktop',
  });

  it('summarizes attribution; an empty report is fully attributed', () => {
    expect(computeCauseStats([])).toEqual({
      total: 0,
      attributed: 0,
      unknown: 0,
      attributed_ratio: 1,
    });
    const stats = computeCauseStats([
      div('base_default'),
      div('dangling_ref'),
      div('font_not_carried'),
      div('unknown'),
    ]);
    expect(stats).toEqual({ total: 4, attributed: 3, unknown: 1, attributed_ratio: 0.75 });
  });

  it('a representative diff with a real (shorthand-heavy) ledger attributes ≥80% (corpus guard)', () => {
    // The Driftwell-class scenario: a button whose base painted through, a ghost div whose styles
    // landed on custom_css via SHORTHAND declarations, a font that did not carry, one true unknown.
    const ledgerPath = 'body>section>div';
    const ledger: DeclFallback[] = [
      {
        source_path: ledgerPath,
        declaration: 'background: linear-gradient(135deg, #eef0ff, #e8fbf4)',
        tier: 'custom_css',
        reason: 'unmappable',
      },
      {
        source_path: ledgerPath,
        declaration: 'padding: 24px',
        tier: 'html_widget',
        reason: 'no native prop',
      },
    ];
    const matches: MatchedElement[] = [
      match({
        source_path: 'body>a',
        element: 'btn0001',
        source: el({ props: { 'background-color': 'rgba(0, 0, 0, 0)', 'padding-top': '0px' } }),
        converted: el({
          props: { 'background-color': 'rgb(56, 95, 243)', 'padding-top': '12px' },
          base_classes: ['e-button-base'],
        }),
      }),
      match({
        source_path: ledgerPath,
        element: 'div0001',
        source: el({
          props: {
            'background-image': 'linear-gradient(135deg, rgb(238, 240, 255), rgb(232, 251, 244))',
            'padding-top': '24px',
            'font-family': 'Inter, sans-serif',
            display: 'grid',
          },
        }),
        converted: el({
          props: {
            'background-image': 'none',
            'padding-top': '0px',
            'font-family': 'Times, serif',
            display: 'block',
          },
        }),
      }),
    ];
    const divergences = diffMatchedElements(matches, 'desktop', ledger);
    const stats = computeCauseStats(divergences);
    expect(stats.total).toBe(6);
    expect(stats.unknown).toBe(1); // the display diff — genuinely unattributable, stays R2
    expect(stats.attributed_ratio).toBeGreaterThanOrEqual(ATTRIBUTED_RATIO_TARGET);
  });
});

/* ─────────────────────────── (1) pure: matchElements ─────────────────────────────────────────── */

describe('matchElements', () => {
  it('matches via the assembler idMap, including the bare-hex data-id spelling', () => {
    const source = pageSnap({ elements: { 'body>div': el(), 'body>div>h1': el() } });
    const converted = pageSnap({
      elements: { abc1234: el(), 'e-def5678': el() },
    });
    const matches = matchElements(source, converted, {
      'body>div': 'e-abc1234', // minted with the e- prefix; saved data-id is bare hex
      'body>div>h1': 'e-def5678', // saved verbatim
      'body>div>p': 'e-0000000', // unmatched — silently absent from V1 (V2/V3 still cover it)
    });
    expect(matches.map((m) => [m.source_path, m.element])).toEqual([
      ['body>div', 'abc1234'],
      ['body>div>h1', 'e-def5678'],
    ]);
  });

  it('falls back to UNIQUE-text pairing when no idMap is given', () => {
    const source = pageSnap({
      elements: {
        'body>h1': el({ text: 'Run the back office' }),
        'body>p:nth-child(2)': el({ text: 'dup' }),
        'body>p:nth-child(3)': el({ text: 'dup' }), // ambiguous on the source side
        'body>span': el({ text: 'ab' }), // too short
      },
    });
    const converted = pageSnap({
      elements: {
        aaa1111: el({ text: 'Run the back office' }),
        bbb2222: el({ text: 'dup' }),
        ccc3333: el({ text: 'ab' }),
      },
    });
    const matches = matchElements(source, converted);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source_path).toBe('body>h1');
    expect(matches[0]?.element).toBe('aaa1111');
  });
});

/* ─────────────────────────── (1) pure: diffMatchedElements ───────────────────────────────────── */

describe('diffMatchedElements', () => {
  it('emits one caused divergence row per diverging prop, skipping source-invisible elements', () => {
    const matches: MatchedElement[] = [
      match({
        source_path: 'body>a',
        element: 'btn0001',
        source: el({
          props: { 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(12, 107, 74)' },
        }),
        converted: el({
          props: { 'background-color': 'rgb(56, 95, 243)', color: 'rgb(12, 107, 74)' },
          base_classes: ['e-button-base'],
        }),
      }),
      match({
        source_path: 'body>div',
        element: 'hid0001',
        source: el({ visible: false, props: { color: 'rgb(0, 0, 0)' } }),
        converted: el({ props: { color: 'rgb(255, 0, 0)' } }),
      }),
    ];
    const divergences = diffMatchedElements(matches, 'desktop');
    expect(divergences).toEqual([
      {
        element: 'btn0001',
        source_path: 'body>a',
        prop: 'background-color',
        source_value: 'rgba(0, 0, 0, 0)',
        converted_value: 'rgb(56, 95, 243)',
        cause: 'base_default',
        breakpoint: 'desktop',
      },
    ]);
  });

  it('only diffs props present on BOTH sides (the fixed prop set is the universe)', () => {
    const matches = [
      match({
        source: el({ props: { color: 'rgb(0, 0, 0)' } }),
        converted: el({ props: {} }),
      }),
    ];
    expect(diffMatchedElements(matches, 'mobile')).toEqual([]);
    expect(VERIFY_PROPS).toContain('display'); // the contract's fixed set is frozen here
    expect(VERIFY_PROPS).toContain('background-color');
  });
});

/* ─────────────────────────── (1) pure: auditLayout ───────────────────────────────────────────── */

describe('auditLayout', () => {
  it('passes when scrollWidth == viewport, heights within tolerance, no zero-area losses', () => {
    const audit = auditLayout(
      pageSnap({ scroll_height: 2000 }),
      pageSnap({
        scroll_width: 390,
        viewport_width: 390,
        scroll_height: 2100,
        first_element_id: 'root111',
      }),
      [match()],
      'mobile',
    );
    expect(audit.pass).toBe(true);
    expect(audit.scroll_width_ok).toBe(true);
    expect(audit.height_ok).toBe(true);
    expect(audit.zero_area).toEqual([]);
    expect(audit.root_element).toBe('root111');
  });

  it('fails on horizontal overflow (the 390 scrollWidth class)', () => {
    const audit = auditLayout(
      pageSnap(),
      pageSnap({ scroll_width: 1180, viewport_width: 390 }),
      [],
      'mobile',
    );
    expect(audit.scroll_width_ok).toBe(false);
    expect(audit.pass).toBe(false);
  });

  it('flags visible zero-area elements that had area in the source (the SVG wrapper class)', () => {
    const audit = auditLayout(
      pageSnap(),
      pageSnap(),
      [
        match({
          source_path: 'body>svg',
          element: 'svg0001',
          source: el({ area: 2500 }),
          converted: el({ area: 0 }),
        }),
        // invisible-in-source → not a loss:
        match({ source: el({ area: 2500, visible: false }), converted: el({ area: 0 }) }),
      ],
      'desktop',
    );
    expect(audit.zero_area).toEqual([{ element: 'svg0001', source_path: 'body>svg' }]);
    expect(audit.pass).toBe(false);
  });

  it('applies the height tolerance against the SOURCE height', () => {
    const ok = auditLayout(
      pageSnap({ scroll_height: 1000 }),
      pageSnap({ scroll_height: 1000 + 1000 * DEFAULT_HEIGHT_TOLERANCE }),
      [],
      'desktop',
    );
    expect(ok.height_ok).toBe(true);
    const fail = auditLayout(
      pageSnap({ scroll_height: 1000 }),
      pageSnap({ scroll_height: 1300 }),
      [],
      'desktop',
    );
    expect(fail.height_ok).toBe(false);
  });

  it('FAILS when the viewport was not actually applied (P1-d: the snapshot cannot be trusted)', () => {
    // The 743/390 lie, replayed: the loop ASKED for 390 but the page measured at the 767 boundary —
    // 743 ≤ 767+1 would "pass" the naive scrollWidth check; the viewport assertion catches it.
    const audit = auditLayout(
      pageSnap(),
      pageSnap({ scroll_width: 743, viewport_width: 767 }),
      [],
      'mobile',
      390,
    );
    expect(audit.render_width).toBe(390);
    expect(audit.viewport_ok).toBe(false);
    expect(audit.pass).toBe(false);
    // Measured FOR REAL at 390, the same page fails on scroll_width itself:
    const real = auditLayout(
      pageSnap(),
      pageSnap({ scroll_width: 743, viewport_width: 390 }),
      [],
      'mobile',
      390,
    );
    expect(real.viewport_ok).toBe(true);
    expect(real.scroll_width_ok).toBe(false);
    expect(real.pass).toBe(false);
  });
});

/* ─────────────────────────── (1) pure: auditContentPresence (§7 P1-e / P1-a guard) ───────────── */

describe('auditContentPresence (P1-e)', () => {
  const source = pageSnap({
    text_nodes: [
      { path: 'body>h1', text: 'Sleep smarter, wake brighter' },
      { path: 'body>div>div', text: '$10' }, // the P1-a mixed-children class (bare text + <small>)
      { path: 'body>div>div>small', text: '/month' },
      { path: 'body>ul>li', text: 'decorative bullet' },
    ],
  });

  it('every source string ≥3 chars must be present in the converted DOM or honestly dropped', () => {
    const converted = pageSnap({
      body_text: 'Sleep smarter, wake brighter /month Get started',
    });
    const audit = auditContentPresence(source, converted, 'desktop', ['decorative bullet']);
    expect(audit.total).toBe(4);
    expect(audit.present).toBe(2);
    expect(audit.dropped).toBe(1);
    // "$10" silently lost — neither rendered nor in a drop entry → the audit FAILS (P1-a guard):
    expect(audit.missing).toEqual([{ source_path: 'body>div>div', text: '$10' }]);
    expect(audit.pass).toBe(false);
  });

  it('passes when everything is present (and dedupes repeated missing strings)', () => {
    const ok = auditContentPresence(
      source,
      pageSnap({ body_text: 'Sleep smarter, wake brighter $10 /month decorative bullet' }),
      'desktop',
    );
    expect(ok.pass).toBe(true);
    expect(ok.missing).toEqual([]);

    const dup = pageSnap({
      text_nodes: [
        { path: 'body>p', text: 'repeated copy' },
        { path: 'body>p', text: 'repeated copy' },
      ],
    });
    const audit = auditContentPresence(dup, pageSnap({ body_text: '' }), 'desktop');
    expect(audit.total).toBe(2);
    expect(audit.missing).toHaveLength(1);
  });
});

/* ─────────────────────────── (1) pure: judgeOpacityProbe (§7 P1-e / P1-c guard) ──────────────── */

describe('judgeOpacityProbe (P1-e behavioral probes)', () => {
  const scrollIn = { element_id: 'abc1234', trigger: 'scrollIn' };

  it('a scrollIn element must show the <1 → 1 opacity ramp (P1-c corpus guard)', () => {
    const pass = judgeOpacityProbe(scrollIn, {
      found: true,
      initial: 0,
      series: [0, 0.4, 0.9, 1],
    });
    expect(pass.pass).toBe(true);
    expect(pass.kind).toBe('interactions');
    expect(pass.detail).toContain('ramp observed');
  });

  it('constant 1.0 opacity FAILS a scrollIn probe (the "no initial hide" bug class)', () => {
    const probe = judgeOpacityProbe(scrollIn, {
      found: true,
      initial: 1,
      series: [1, 1, 1, 1],
    });
    expect(probe.pass).toBe(false);
    expect(probe.detail).toContain('NO <1 → 1 opacity ramp');
  });

  it('a missing element and a never-visible element are honest failures', () => {
    expect(judgeOpacityProbe(scrollIn, undefined).pass).toBe(false);
    expect(judgeOpacityProbe(scrollIn, { found: false, initial: -1, series: [] }).pass).toBe(false);
    const stuckHidden = judgeOpacityProbe(
      { element_id: 'abc1234', trigger: 'load' },
      { found: true, initial: 0, series: [0, 0, 0] },
    );
    expect(stuckHidden.pass).toBe(false);
  });

  it('non-scroll triggers assert end-state visibility (the ramp may pre-date sampling)', () => {
    const load = judgeOpacityProbe(
      { element_id: 'abc1234', trigger: 'load' },
      { found: true, initial: 1, series: [1, 1] },
    );
    expect(load.pass).toBe(true);
  });
});

/* ─────────────────────────── (1) pure: evaluateVerifyGate (§6 F6 hardened verdict) ───────────── */

describe('evaluateVerifyGate (the hardened gate)', () => {
  function greenResult(): VerifyLoopResult {
    return {
      divergences: [],
      layoutAudits: [
        auditLayout(pageSnap(), pageSnap({ first_element_id: 'root111' }), [], 'desktop', 1440),
      ],
      pixelScore: [{ breakpoint: 'desktop', ratio: 0.01 }],
      repairs: [],
      contentAudit: {
        breakpoint: 'desktop',
        total: 3,
        present: 3,
        dropped: 0,
        missing: [],
        pass: true,
      },
      elementCounts: [{ breakpoint: 'desktop', source_count: 10, converted_count: 12, delta: 2 }],
      behaviorProbes: [],
      causeStats: { total: 0, attributed: 0, unknown: 0, attributed_ratio: 1 },
    };
  }

  it('passes a fully green loop', () => {
    expect(evaluateVerifyGate(greenResult(), { divergenceThreshold: 25 })).toEqual({
      pass: true,
      reasons: [],
    });
  });

  it('fails on the P1-e blind spots the v17.0 gate could not see (content + behavior)', () => {
    const result = greenResult();
    result.contentAudit = {
      breakpoint: 'desktop',
      total: 3,
      present: 2,
      dropped: 0,
      missing: [{ source_path: 'body>div', text: '$10' }],
      pass: false,
    };
    result.behaviorProbes = [
      { kind: 'interactions', nodeId: 'abc1234', pass: false, detail: 'NO <1 → 1 opacity ramp' },
    ];
    const verdict = evaluateVerifyGate(result, { divergenceThreshold: 25 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('content-presence'))).toBe(true);
    expect(verdict.reasons.some((r) => r.includes('behavioral probe'))).toBe(true);
  });

  it('still enforces the v17.0 inputs (V2 audits + the divergence threshold)', () => {
    const overflow = greenResult();
    overflow.layoutAudits = [
      auditLayout(
        pageSnap(),
        pageSnap({ scroll_width: 743, viewport_width: 390 }),
        [],
        'mobile',
        390,
      ),
    ];
    expect(evaluateVerifyGate(overflow, { divergenceThreshold: 25 }).pass).toBe(false);

    const noisy = greenResult();
    noisy.divergences = [
      {
        element: 'a',
        source_path: 'body>div',
        prop: 'color',
        source_value: 'a',
        converted_value: 'b',
        cause: 'unknown',
        breakpoint: 'desktop',
      },
    ];
    expect(evaluateVerifyGate(noisy, { divergenceThreshold: 0 }).pass).toBe(false);
  });
});

/* ─────────────────────────── (1) pure: deriveRepairs ─────────────────────────────────────────── */

describe('deriveRepairs', () => {
  const divergence = (overrides: Partial<Divergence>): Divergence => ({
    element: 'abc1234',
    source_path: 'body>div',
    prop: 'background-color',
    source_value: 'rgba(0, 0, 0, 0)',
    converted_value: 'rgb(56, 95, 243)',
    cause: 'base_default',
    breakpoint: 'desktop',
    ...overrides,
  });
  const audit = (overrides: Partial<LayoutAudit>): LayoutAudit => ({
    breakpoint: 'mobile',
    render_width: 390,
    viewport_width: 390,
    viewport_ok: true,
    scroll_width: 390,
    scroll_width_ok: true,
    source_scroll_width: 390,
    source_overflow_x: 'visible',
    source_height: 1000,
    converted_height: 1000,
    height_ok: true,
    zero_area: [],
    root_element: 'root111',
    pass: true,
    ...overrides,
  });

  it('repairs ONLY the mechanical causes, deduped per nodeId|prop (first breakpoint wins)', () => {
    const repairs = deriveRepairs(
      [
        divergence({ cause: 'base_default' }),
        divergence({ cause: 'base_default', breakpoint: 'mobile' }), // dedupe
        divergence({ cause: 'dangling_ref', prop: 'width', source_value: '48px' }),
        divergence({ cause: 'dropped_declaration', prop: 'color' }), // R2 — not mechanical
        divergence({ cause: 'unknown', prop: 'display' }), // R2
        divergence({ cause: 'base_default', prop: 'color', element: '' }), // unmatched node
      ],
      [],
    );
    expect(repairs).toEqual([
      {
        nodeId: 'abc1234',
        prop: 'background-color',
        value: 'rgba(0, 0, 0, 0)',
        cause: 'base_default',
      },
      { nodeId: 'abc1234', prop: 'width', value: '48px', cause: 'dangling_ref' },
    ]);
  });

  it('carries a source overflow-x onto the page root when the converted page overflows', () => {
    const repairs = deriveRepairs(
      [],
      [
        audit({
          scroll_width_ok: false,
          scroll_width: 1180,
          source_overflow_x: 'hidden',
          pass: false,
        }),
      ],
    );
    // Emitted as the composite `overflow` — the atomic Style-Schema has no `overflow-x` key, so a
    // literal carry would never classify and the applier would skip it.
    expect(repairs).toEqual([
      { nodeId: 'root111', prop: 'overflow', value: 'hidden', cause: 'missing_overflow_x' },
    ]);
  });

  it('carries the clip even when the source scrollWidth reports the CLIPPED extent (propagation)', () => {
    // Body `overflow-x:hidden` propagates to the viewport: the source shows no scrollbar, but its
    // scrollWidth still reports the clipped content extent (test.html: 1440 on a 1280 viewport for
    // an absolutely-positioned hero glow). The declared clip IS the containment — carry it.
    const repairs = deriveRepairs(
      [],
      [
        audit({
          scroll_width_ok: false,
          source_overflow_x: 'hidden',
          source_scroll_width: 1440,
          viewport_width: 1280,
        }),
      ],
    );
    expect(repairs).toEqual([
      { nodeId: 'root111', prop: 'overflow', value: 'hidden', cause: 'missing_overflow_x' },
    ]);
  });

  it('does NOT repair overflow the source did not solve itself (R2, not mechanical)', () => {
    // source body has no overflow-x rule — even a genuinely overflowing source stays R2:
    expect(
      deriveRepairs([], [audit({ scroll_width_ok: false, source_overflow_x: 'visible' })]),
    ).toEqual([]);
    expect(
      deriveRepairs(
        [],
        [
          audit({
            scroll_width_ok: false,
            source_overflow_x: 'visible',
            source_scroll_width: 1180,
          }),
        ],
      ),
    ).toEqual([]);
  });

  it('prefers the caller-supplied rootNodeId over the rendered root', () => {
    const repairs = deriveRepairs(
      [],
      [audit({ scroll_width_ok: false, source_overflow_x: 'clip' })],
      'e-pageroot',
    );
    expect(repairs[0]?.nodeId).toBe('e-pageroot');
  });

  it('bounds the integrator at 2 repair rounds (§3 R1, frozen)', () => {
    expect(MAX_REPAIR_ROUNDS).toBe(2);
  });
});

/* ─────────────────────────── (2) runVerifyLoop over a STUBBED BrowserPort ────────────────────── */

/** Probe the optional pixel deps (declared deps; absent only in a stripped env). */
const PIXELMATCH_SPEC = 'pixelmatch';
const PNGJS_SPEC = 'pngjs';
let pixelDepsAvailable: boolean | null = null;
async function probePixelDeps(): Promise<boolean> {
  if (pixelDepsAvailable !== null) return pixelDepsAvailable;
  try {
    await import(PIXELMATCH_SPEC);
    await import(PNGJS_SPEC);
    pixelDepsAvailable = true;
  } catch {
    console.warn('[verify-loop.test] SKIP stub-port cases: pixelmatch/pngjs not installed.');
    pixelDepsAvailable = false;
  }
  return pixelDepsAvailable;
}

/** Minimal local pngjs module surface for building tiny solid PNGs. */
interface PngModule {
  PNG: {
    new (o: { width: number; height: number }): { data: Buffer; width: number; height: number };
    sync: { write(p: unknown): Buffer };
  };
}

async function solidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Promise<Buffer> {
  const { PNG } = (await import(PNGJS_SPEC)) as unknown as PngModule;
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

/**
 * A stub BrowserPort whose fake Page recognizes the in-page snapshot function by its
 * `emcpVerifySnapshot` marker (and the opacity probe by its `emcpOpacityProbe` marker — checked
 * FIRST, since the probe source also mentions `data-id`) and answers from a queue
 * (source, converted, per breakpoint); screenshots come from a queue of canned PNGs.
 */
function stubPort(
  snapshots: PageSnapshot[],
  pngs: Buffer[],
  probeRows: Record<string, import('./verify-loop.js').OpacityProbeRow> = {},
): BrowserPort {
  let snapIdx = 0;
  let pngIdx = 0;
  const page = {
    goto: () => Promise.resolve(undefined),
    setContent: () => Promise.resolve(undefined),
    waitForLoadState: () => Promise.resolve(undefined),
    waitForTimeout: () => Promise.resolve(undefined),
    evaluate: (fn: unknown) => {
      if (String(fn).includes('emcpOpacityProbe')) {
        return Promise.resolve(probeRows);
      }
      if (String(fn).includes('emcpVerifySnapshot') || String(fn).includes('data-id')) {
        const snap = snapshots[snapIdx];
        snapIdx += 1;
        return Promise.resolve(snap);
      }
      return Promise.resolve(undefined); // the settle pass
    },
    screenshot: () => {
      const png = pngs[pngIdx % pngs.length];
      pngIdx += 1;
      return Promise.resolve(png);
    },
  };
  return {
    withPage: async (fn) => fn(page as never),
  };
}

describe('runVerifyLoop (stubbed port)', () => {
  it('produces divergences, audits, pixel scores, and repairs per breakpoint', async () => {
    if (!(await probePixelDeps())) return;

    const sourceSnap = pageSnap({
      elements: {
        'body>a': el({
          text: 'Get started',
          props: { 'background-color': 'rgba(0, 0, 0, 0)', color: 'rgb(12, 107, 74)' },
        }),
      },
      scroll_height: 1000,
      overflow_x: 'hidden',
      scroll_width: 390,
      viewport_width: 390,
    });
    const convertedSnap = pageSnap({
      elements: {
        btn0001: el({
          text: 'Get started',
          props: { 'background-color': 'rgb(56, 95, 243)', color: 'rgb(12, 107, 74)' },
          base_classes: ['e-button-base'],
        }),
      },
      scroll_width: 1180, // horizontal overflow at mobile
      viewport_width: 390,
      scroll_height: 1000,
      first_element_id: 'root111',
    });
    const samePng = await solidPng(8, 8, [255, 0, 0, 255]);
    const diffPng = await solidPng(8, 8, [0, 0, 255, 255]);

    const result = await runVerifyLoop(
      { browser: stubPort([sourceSnap, convertedSnap], [samePng, diffPng]) },
      {
        sourceUrlOrHtml: '<html><body><a>Get started</a></body></html>',
        pageUrl: 'http://stub.local/page/',
        breakpoints: [{ key: 'mobile', width: 390, direction: 'max' }],
      },
    );

    // V1: the ghost-button divergence, text-matched (no idMap), attributed base_default.
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toMatchObject({
      element: 'btn0001',
      prop: 'background-color',
      cause: 'base_default',
      breakpoint: 'mobile',
    });
    // V2: overflow fails — and the breakpoint rendered at the DEVICE width (P1-d), which the
    // snapshot's viewport matches.
    expect(result.layoutAudits).toHaveLength(1);
    expect(result.layoutAudits[0]?.render_width).toBe(390);
    expect(result.layoutAudits[0]?.viewport_ok).toBe(true);
    expect(result.layoutAudits[0]?.scroll_width_ok).toBe(false);
    expect(result.layoutAudits[0]?.pass).toBe(false);
    // V3: fully-different solid PNGs → ratio 1.
    expect(result.pixelScore).toEqual([{ breakpoint: 'mobile', ratio: 1 }]);
    // §7 P1-d/P1-e carriers: cause stats over the one (attributed) divergence + count delta rows.
    expect(result.causeStats).toEqual({ total: 1, attributed: 1, unknown: 0, attributed_ratio: 1 });
    expect(result.elementCounts).toEqual([
      { breakpoint: 'mobile', source_count: 0, converted_count: 0, delta: 0 },
    ]);
    expect(result.contentAudit.pass).toBe(true); // no canned text_nodes → nothing to lose
    expect(result.behaviorProbes).toEqual([]); // no interactions supplied → no probe page-load
    // R1: the base_default prop repair + the overflow carry (source body had hidden; emitted as
    // the composite `overflow` — the only schema-placeable form).
    expect(result.repairs).toEqual([
      {
        nodeId: 'btn0001',
        prop: 'background-color',
        value: 'rgba(0, 0, 0, 0)',
        cause: 'base_default',
      },
      { nodeId: 'root111', prop: 'overflow', value: 'hidden', cause: 'missing_overflow_x' },
    ]);
  });

  it('reports a failed pixel diff as an honest worst-score row, never silently', async () => {
    if (!(await probePixelDeps())) return;
    const snap = pageSnap();
    const result = await runVerifyLoop(
      { browser: stubPort([snap, snap], [Buffer.from('not a png')]) },
      {
        sourceUrlOrHtml: '<html><body></body></html>',
        pageUrl: 'http://stub.local/page/',
        breakpoints: [{ key: 'desktop', width: 1440, direction: 'min' }],
      },
    );
    expect(result.pixelScore).toHaveLength(1);
    expect(result.pixelScore[0]?.ratio).toBe(1);
    expect(result.pixelScore[0]?.error).toBeTruthy();
  });

  it('runs the P1-e content audit + behavioral probes and the hardened gate consumes them', async () => {
    if (!(await probePixelDeps())) return;
    const png = await solidPng(4, 4, [10, 20, 30, 255]);
    const sourceSnap = pageSnap({
      text_nodes: [
        { path: 'body>h1', text: 'Sleep smarter' },
        { path: 'body>div', text: '$10' },
      ],
      body_text: 'Sleep smarter $10',
      element_count: 8,
    });
    const convertedSnap = pageSnap({
      body_text: 'Sleep smarter', // "$10" silently lost (the P1-a class)
      element_count: 6, // two elements gone — the delta report makes it visible
      first_element_id: 'root111',
    });

    const result = await runVerifyLoop(
      {
        browser: stubPort([sourceSnap, convertedSnap], [png], {
          fade001: { found: true, initial: 0, series: [0, 0.5, 1] },
          dead002: { found: true, initial: 1, series: [1, 1, 1] },
        }),
      },
      {
        sourceUrlOrHtml: '<html><body></body></html>',
        pageUrl: 'http://stub.local/page/',
        breakpoints: [{ key: 'desktop', width: 1440, direction: 'min' }],
        interactions: [
          { element_id: 'fade001', trigger: 'scrollIn' },
          { element_id: 'dead002', trigger: 'scrollIn' },
        ],
      },
    );

    expect(result.contentAudit.pass).toBe(false);
    expect(result.contentAudit.missing).toEqual([{ source_path: 'body>div', text: '$10' }]);
    expect(result.elementCounts).toEqual([
      { breakpoint: 'desktop', source_count: 8, converted_count: 6, delta: -2 },
    ]);
    expect(result.behaviorProbes).toHaveLength(2);
    expect(result.behaviorProbes[0]).toMatchObject({ nodeId: 'fade001', pass: true });
    expect(result.behaviorProbes[1]).toMatchObject({ nodeId: 'dead002', pass: false });

    const verdict = evaluateVerifyGate(result, { divergenceThreshold: 25 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('content-presence'))).toBe(true);
    expect(verdict.reasons.some((r) => r.includes('dead002'))).toBe(true);
  });
});

/* ─────────────────────────── (3) LIVE Chromium (WP-H03 pool) ─────────────────────────────────── */

let chromiumAvailable: boolean | null = null;
async function probeChromium(): Promise<boolean> {
  if (chromiumAvailable !== null) return chromiumAvailable;
  try {
    const { getBrowser } = await import('./browser-pool.js');
    const browser = await getBrowser();
    chromiumAvailable = browser.isConnected();
  } catch (err) {
    console.warn(
      `[verify-loop.test] SKIP live cases: Chromium unavailable (${(err as Error).message}). ` +
        'Run `pnpm --filter @elementor-ultra/server exec playwright install chromium`.',
    );
    chromiumAvailable = false;
  }
  return chromiumAvailable;
}

afterAll(async () => {
  await closeBrowser();
});

describe('runVerifyLoop (live Chromium)', () => {
  it('diffs a real source render against a real converted render (data: URL)', async () => {
    if (!(await probeChromium()) || !(await probePixelDeps())) return;

    const sourceHtml =
      '<!doctype html><html><head><style>' +
      'body{margin:0;overflow-x:hidden}' +
      'a.cta{display:inline-block;background:transparent;color:rgb(12,107,74);padding:8px}' +
      '</style></head><body><a class="cta">Get started today</a></body></html>';
    // The "converted" page: an e-button-base node whose background painted through (the bug class).
    const convertedHtml =
      '<!doctype html><html><head><style>' +
      'body{margin:0}' +
      '.e-button-base{display:inline-block;background:rgb(56,95,243);color:rgb(12,107,74);padding:8px}' +
      '</style></head><body>' +
      '<a data-id="abc1234" class="e-abc1234-1234567 e-button-base">Get started today</a>' +
      '</body></html>';

    const result = await runVerifyLoop(undefined, {
      sourceUrlOrHtml: sourceHtml,
      pageUrl: `data:text/html,${encodeURIComponent(convertedHtml)}`,
      breakpoints: [{ key: 'desktop', width: 800, direction: 'min' }],
    });

    // The local-style class has NO rendered rule on the converted page → every divergence on the
    // element attributes dangling_ref (I1 wins over base_default), and each is repairable.
    const bg = result.divergences.find((d) => d.prop === 'background-color');
    expect(bg).toBeDefined();
    expect(bg?.element).toBe('abc1234');
    expect(bg?.cause).toBe('dangling_ref');
    expect(
      result.repairs.some((r) => r.nodeId === 'abc1234' && r.prop === 'background-color'),
    ).toBe(true);
    expect(result.layoutAudits[0]?.scroll_width_ok).toBe(true);
    expect(result.pixelScore[0]?.ratio).toBeGreaterThan(0);
  }, 60_000);

  it('a faithful conversion yields zero divergences, passing audits, near-zero pixel score', async () => {
    if (!(await probeChromium()) || !(await probePixelDeps())) return;

    const styled =
      '<!doctype html><html><head><style>' +
      'body{margin:0}h1{color:rgb(18,32,25);font-size:32px;margin:0;padding:4px}' +
      '</style></head><body><h1 data-id="hd00001">Faithful heading</h1></body></html>';

    const result = await runVerifyLoop(undefined, {
      sourceUrlOrHtml: styled,
      pageUrl: `data:text/html,${encodeURIComponent(styled)}`,
      breakpoints: [{ key: 'desktop', width: 800, direction: 'min' }],
      idMap: { 'body>h1': 'hd00001' },
    });

    expect(result.divergences).toEqual([]);
    expect(result.layoutAudits[0]?.pass).toBe(true);
    expect(result.pixelScore[0]?.ratio).toBeLessThan(0.01);
    expect(result.repairs).toEqual([]);
    expect(result.contentAudit.pass).toBe(true);
    expect(result.contentAudit.total).toBeGreaterThan(0); // "Faithful heading" was audited
  }, 60_000);

  it('behaviorally probes scrollIn elements per frame (P1-e/P1-c: ramp vs the constant-1.0 bug)', async () => {
    if (!(await probeChromium()) || !(await probePixelDeps())) return;

    // A page with one WORKING scrollIn fade (initial hide + IntersectionObserver reveal) and one
    // DEAD one (stamped but never hidden — the field-observed P1-c class: opacity constant 1.0).
    const html =
      '<!doctype html><html><head><style>' +
      'body{margin:0}.spacer{height:2400px}' +
      '#fade{opacity:0;transition:opacity 300ms ease}#fade.in{opacity:1}' +
      '</style></head><body>' +
      '<div class="spacer"></div>' +
      '<div id="fade" data-id="fade001">Fades in on scroll</div>' +
      '<div id="dead" data-id="dead002">Stamped but never hidden</div>' +
      '<script>' +
      'var el=document.getElementById("fade");' +
      'new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)el.classList.add("in");});},{threshold:0.1}).observe(el);' +
      '</script>' +
      '</body></html>';

    const result = await runVerifyLoop(undefined, {
      sourceUrlOrHtml: html,
      pageUrl: `data:text/html,${encodeURIComponent(html)}`,
      breakpoints: [{ key: 'desktop', width: 800, direction: 'min' }],
      interactions: [
        { element_id: 'fade001', trigger: 'scrollIn' },
        { element_id: 'dead002', trigger: 'scrollIn' },
      ],
    });

    expect(result.behaviorProbes).toHaveLength(2);
    const fade = result.behaviorProbes.find((p) => p.nodeId === 'fade001');
    const dead = result.behaviorProbes.find((p) => p.nodeId === 'dead002');
    expect(fade?.pass).toBe(true); // <1 → 1 ramp observed per frame
    expect(dead?.pass).toBe(false); // constant 1.0 — exactly the P1-c "interactions dead" class
    expect(dead?.detail).toContain('NO <1 → 1 opacity ramp');
  }, 90_000);
});

/* ─────────────────────────── (3) THE Driftwell corpus guard (§7 P1-d/P1-e) ───────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIFTWELL_FIXTURE = resolve(HERE, '..', '..', '..', '..', 'test-baseline.html');

/**
 * Degrade the Driftwell source the way the v17.0 converter degraded it (field-verified R3 classes):
 *  - P1-a: the bare `$10` text node beside `<small>/month</small>` is silently dropped,
 *  - P1-b: the price grid is pinned to a rigid 743px 3-column layout that NO media query collapses
 *    (the grid-template-columns-only media deltas the style-extract emission missed) — 743 fits the
 *    767 mobile BOUNDARY the old loop rendered at, and overflows the real 390 device width.
 */
function degradeLikeV17(html: string): string {
  const dropped = html.replace('>$10<small>', '><small>');
  expect(dropped).not.toBe(html); // the fixture must still contain the mixed-children pattern
  // 3×228px tracks + 2×26px gaps = 736px inside the forced 740px box → the rendered extent is
  // wrap-padding (24) + 740 = 764px: INSIDE the 767 mobile boundary, way outside the 390 device.
  return dropped.replace(
    '</head>',
    '<style>.price-grid{grid-template-columns:repeat(3,228px) !important;' +
      'width:740px !important;max-width:none !important}</style></head>',
  );
}

describe('the committed Driftwell fixture (corpus guard: FAIL degraded, PASS faithful)', () => {
  const breakpoints = [
    { key: 'desktop' as const, width: 1280, direction: 'min' as const },
    // Elementor's REAL mobile spec — the 767 boundary the v17.0 loop rendered at (the lie):
    { key: 'mobile' as const, width: 767, direction: 'max' as const },
  ];

  it('a v17.0-degraded conversion FAILS the hardened gate (the old gate saw nothing)', async () => {
    if (!(await probeChromium()) || !(await probePixelDeps())) return;
    if (!existsSync(DRIFTWELL_FIXTURE)) {
      console.warn(`[verify-loop.test] SKIP Driftwell guard: ${DRIFTWELL_FIXTURE} not found.`);
      return;
    }
    const source = readFileSync(DRIFTWELL_FIXTURE, 'utf8');
    const degraded = degradeLikeV17(source);

    const result = await runVerifyLoop(undefined, {
      sourceUrlOrHtml: source,
      pageUrl: `data:text/html,${encodeURIComponent(degraded)}`,
      breakpoints,
    });

    // P1-d: mobile measured INSIDE the breakpoint viewport for real (390, not the 767 boundary).
    const mobile = result.layoutAudits.find((a) => a.breakpoint === 'mobile');
    expect(mobile).toBeDefined();
    expect(mobile?.render_width).toBe(390);
    expect(mobile?.viewport_ok).toBe(true);
    // The 743px grid: fits the OLD boundary render (≤ 767+1 — the v17.0 "pass")…
    expect(mobile?.scroll_width).toBeGreaterThan(700);
    expect(mobile?.scroll_width).toBeLessThanOrEqual(768);
    // …but is horizontal overflow at the real device width:
    expect(mobile?.scroll_width_ok).toBe(false);
    expect(mobile?.pass).toBe(false);

    // P1-e/P1-a: the dropped "$10" is INVISIBLE to V1 prop diffing (the old gate's only content
    // signal) but the content-presence audit reports it.
    expect(result.contentAudit.pass).toBe(false);
    expect(result.contentAudit.missing.some((m) => m.text === '$10')).toBe(true);

    // The hardened verdict fails — on BOTH new signals.
    const verdict = evaluateVerifyGate(result, { divergenceThreshold: 25 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('V2 layout audit failed at mobile'))).toBe(true);
    expect(verdict.reasons.some((r) => r.includes('content-presence'))).toBe(true);
  }, 240_000);

  it('the faithful page PASSES the hardened gate (the gate only fails what is actually wrong)', async () => {
    if (!(await probeChromium()) || !(await probePixelDeps())) return;
    if (!existsSync(DRIFTWELL_FIXTURE)) {
      console.warn(`[verify-loop.test] SKIP Driftwell guard: ${DRIFTWELL_FIXTURE} not found.`);
      return;
    }
    const source = readFileSync(DRIFTWELL_FIXTURE, 'utf8');

    const result = await runVerifyLoop(undefined, {
      sourceUrlOrHtml: source,
      pageUrl: `data:text/html,${encodeURIComponent(source)}`,
      breakpoints,
    });

    expect(result.layoutAudits).toHaveLength(2);
    for (const audit of result.layoutAudits) {
      expect(audit.viewport_ok).toBe(true);
      expect(audit.pass).toBe(true);
    }
    expect(result.contentAudit.pass).toBe(true);
    expect(result.contentAudit.total).toBeGreaterThan(20); // the fixture is text-rich
    expect(result.divergences).toEqual([]);
    expect(evaluateVerifyGate(result, { divergenceThreshold: 25 })).toEqual({
      pass: true,
      reasons: [],
    });
  }, 240_000);
});
