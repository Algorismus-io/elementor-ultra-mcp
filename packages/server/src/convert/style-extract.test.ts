/**
 * WP-H07 — STYLE-EXTRACT stage unit tests.
 *
 * Covers: native-vs-fallback per declaration; enum snapping; typed-object decomposition (box-shadow
 * success, gradient fallback); state + breakpoint variants; direction-aware logical conversion via
 * WP-H02; literal flagging; local-style id placeholder (the §5.1 mirroring requirement WP-H08
 * enforces); and a CONTRACT check that every produced `StyleDefinition`/`StyleVariant` validates
 * against `style-variant.schema.json` + `atomic-prop-types.schema.json` (loaded via Ajv2020). The
 * module is PURE — tiny `MappedNode` fixtures, no Playwright, no WP client.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import {
  extractStyles,
  placeholderLocalStyleId,
  expandBoxShorthand,
  NOISE_FILTER_SOURCE_PATH,
  PAINTED_BASE_DEFAULT_PROPS,
} from './style-extract.js';
import type {
  BoxRect,
  IrNode,
  MappedNode,
  MappingResult,
  StyleContext,
  StyleSchema,
  StyledNode,
} from './types.js';

/* ─────────────────────────── tiny MappedNode + ctx builders ──────────────────────────────────── */

const ZERO_BOX: BoxRect = { x: 0, y: 0, width: 0, height: 0 };

const TARGET: MappingResult = {
  generation: 'v4',
  elType: 'e-div-block',
  is_container: true,
  settings_seed: {},
  v3_fallback: { elType: 'container' },
};

function mapped(
  partial: Partial<IrNode> & { source_path: string },
  target: MappingResult = TARGET,
): MappedNode {
  const base: IrNode = {
    source_path: partial.source_path,
    tag: partial.tag ?? 'div',
    role: partial.role ?? 'structural-block',
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
  return {
    ...base,
    target,
    settings_seed: {},
    children: (base.children as MappedNode[]).map((c) => ({
      ...c,
      target: c.target ?? TARGET,
      settings_seed: {},
      children: c.children ?? [],
    })),
  };
}

/** A text run so a fixture node counts as CONTENT-BEARING (the height/width policies key on it). */
const TEXT_RUN = { text: 'hello', inlineTags: [] };

/** MAP targets for the painted-base-default widgets (contract 17 I2/#8). */
const BUTTON_TARGET: MappingResult = {
  generation: 'v4',
  elType: 'widget',
  widgetType: 'e-button',
  is_container: false,
  settings_seed: {},
  v3_fallback: { elType: 'widget', widgetType: 'button' },
};
const FLEXBOX_TARGET: MappingResult = {
  generation: 'v4',
  elType: 'e-flexbox',
  is_container: true,
  settings_seed: {},
  v3_fallback: { elType: 'container' },
};
const SVG_TARGET: MappingResult = {
  generation: 'v4',
  elType: 'widget',
  widgetType: 'e-svg',
  is_container: false,
  settings_seed: {},
  v3_fallback: { elType: 'widget', widgetType: 'icon' },
};
/** A widget with a fully NEUTRAL base (no painted defaults) for the I2 contrast cases. */
const HEADING_TARGET: MappingResult = {
  generation: 'v4',
  elType: 'widget',
  widgetType: 'e-heading',
  is_container: false,
  settings_seed: {},
  v3_fallback: { elType: 'widget', widgetType: 'heading' },
};
/** The html-v3 folding text widget the P2-e underline-carry cases use. */
const PARAGRAPH_TARGET: MappingResult = {
  generation: 'v4',
  elType: 'widget',
  widgetType: 'e-paragraph',
  is_container: false,
  settings_seed: {},
  v3_fallback: { elType: 'widget', widgetType: 'text-editor' },
};

/** A representative live-shaped Style-Schema (the props the fixtures exercise). */
const SCHEMA: StyleSchema = {
  display: { $$type: 'string', enum: ['block', 'flex', 'inline-block', 'grid', 'none'] },
  color: { $$type: 'color' },
  'background-color': { $$type: 'color' },
  'font-size': { $$type: 'size', units: ['px', 'em', 'rem', '%', 'custom'] },
  'font-weight': {
    $$type: 'string',
    enum: ['100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold'],
  },
  width: { $$type: 'size', units: ['px', '%', 'auto', 'custom'] },
  height: { $$type: 'size', units: ['px', '%', 'auto', 'custom'] },
  'max-width': { $$type: 'size', units: ['px', '%', 'auto', 'custom'] },
  'min-height': { $$type: 'size', units: ['px', '%', 'custom'] },
  'flex-direction': { $$type: 'string', enum: ['row', 'column', 'row-reverse', 'column-reverse'] },
  'grid-template-columns': { $$type: 'string' },
  padding: { $$type: 'dimensions' },
  margin: { $$type: 'dimensions' },
  'border-radius': { $$type: 'border-radius' },
  'border-width': { $$type: 'border-width' },
  'text-align': { $$type: 'string', enum: ['start', 'center', 'end', 'justify'] },
  'box-shadow': { $$type: 'box-shadow' },
  background: { $$type: 'background' },
  'font-family': { $$type: 'string' },
  'inset-block-start': { $$type: 'size' },
  'inset-inline-start': { $$type: 'size' },
  'inset-inline-end': { $$type: 'size' },
  'inset-block-end': { $$type: 'size' },
};

function ctx(overrides: Partial<StyleContext> = {}): StyleContext {
  return {
    style_schema: SCHEMA,
    breakpoints: [
      { key: 'tablet', width: 1024, direction: 'max' },
      { key: 'mobile', width: 767, direction: 'max' },
    ],
    doc_direction: 'ltr',
    target_rtl: false,
    pro_active: true,
    ...overrides,
  };
}

/* ─────────────────────────── acceptance: base variant shape ──────────────────────────────────── */

describe('extractStyles — base variant (acceptance criterion 1)', () => {
  it('display:flex; padding:8px 4px 8px 12px; color:#111 → base variant with display, logical padding, color', () => {
    const node = mapped({
      source_path: 'body>div:nth-child(1)',
      computed: { display: 'flex', padding: '8px 4px 8px 12px', color: '#111' },
    });
    const res = extractStyles([node], ctx());
    const styled = res.styled_nodes[0]!;
    expect(styled.local_styles).toHaveLength(1);
    const variant = styled.local_styles[0]!.variants[0]!;
    expect(variant.meta).toEqual({ breakpoint: null, state: null });
    expect(variant.props['display']).toMatchObject({ $$type: 'string', value: 'flex' });
    expect(variant.props['color']).toMatchObject({ $$type: 'color', value: '#111' });

    // LTR logical padding: top→block-start, right→inline-end, bottom→block-end, left→inline-start.
    const pad = variant.props['padding'] as { $$type: string; value: Record<string, unknown> };
    expect(pad.$$type).toBe('dimensions');
    expect(pad.value['block-start']).toMatchObject({ value: { size: 8, unit: 'px' } });
    expect(pad.value['inline-end']).toMatchObject({ value: { size: 4, unit: 'px' } });
    expect(pad.value['block-end']).toMatchObject({ value: { size: 8, unit: 'px' } });
    expect(pad.value['inline-start']).toMatchObject({ value: { size: 12, unit: 'px' } });
  });
});

/* ─────────────────────────── I3 producer-side accounting (contract 17 §1) ────────────────────── */

describe('extractStyles — detected_declarations (the I3 producer tally)', () => {
  it('counts every accounting unit at the extraction seam: emitted props + fallback rows', () => {
    const node = mapped({
      source_path: 'a',
      computed: {
        display: 'flex',
        color: '#111',
        padding: '8px', // 1 unit (the collapsed dimensions prop)
        'background-image': 'linear-gradient(45deg, red, blue)', // schema-less here → fallback row
      },
    });
    const res = extractStyles([node], ctx());
    const nativeProps = res.styled_nodes[0]!.local_styles.reduce(
      (n, def) => n + def.variants.reduce((m, v) => m + Object.keys(v.props).length, 0),
      0,
    );
    const realRows = res.declaration_fallbacks.filter(
      (f) => f.source_path !== NOISE_FILTER_SOURCE_PATH,
    );
    // The producer's own tally equals its emissions + fallback rows (the noise SUMMARY record is
    // excluded) — the number the integrator's I3 balance is checked against.
    expect(res.detected_declarations).toBe(nativeProps + realRows.length);
    expect(res.detected_declarations).toBeGreaterThan(0);
  });

  it('excludes I4-filtered noise from the tally (real declarations only)', () => {
    const node = mapped({
      source_path: 'a',
      computed: { color: '#111', cursor: 'auto', transform: 'none', margin: '0px' },
    });
    const res = extractStyles([node], ctx());
    expect(res.detected_declarations).toBe(1); // only the color survives the noise filter
  });
});

/* ─────────────────────────── enum snapping ───────────────────────────────────────────────────── */

describe('extractStyles — enum snapping (criterion 2)', () => {
  it('font-weight:350 snaps to 400 (never the raw 350) with a recorded reason', () => {
    const node = mapped({ source_path: 'a', computed: { 'font-weight': '350' } });
    const res = extractStyles([node], ctx());
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(variant.props['font-weight']).toMatchObject({ value: '400' });
    expect(variant.props['font-weight']).not.toMatchObject({ value: '350' });
  });
});

/* ─────────────────────────── fallback routing ────────────────────────────────────────────────── */

describe('extractStyles — fallback ladder (criteria 3,4)', () => {
  it('display:table / grid-template-areas / text-shadow / white-space route to fallback (no native prop)', () => {
    const node = mapped({
      source_path: 'b',
      computed: {
        display: 'table',
        'grid-template-areas': '"a"',
        'text-shadow': '0 1px #000',
        'white-space': 'nowrap',
      },
    });
    const res = extractStyles([node], ctx());
    // None of these props is emitted natively — with Pro active they survive ONLY as the variant's
    // base64 custom_css escape hatch (no native props), and each is recorded as a fallback.
    const defs = res.styled_nodes[0]!.local_styles;
    expect(defs).toHaveLength(1);
    const variant = defs[0]!.variants[0]!;
    expect(Object.keys(variant.props)).toHaveLength(0);
    const decoded = Buffer.from(variant.custom_css!.raw, 'base64').toString('utf8');
    expect(decoded).toContain('display: table;');
    expect(decoded).toContain('white-space: nowrap;');
    const declarations = res.declaration_fallbacks.map((f) => f.declaration);
    expect(declarations).toContain('display: table');
    expect(declarations).toContain('grid-template-areas: "a"');
    expect(declarations).toContain('text-shadow: 0 1px #000');
    expect(declarations).toContain('white-space: nowrap');
  });

  it('flex longhands combine into the composite `flex` prop (not dropped to fallback)', () => {
    const node = mapped({
      source_path: 'fx',
      computed: { 'flex-grow': '2', 'flex-shrink': '1', 'flex-basis': '0px' },
    });
    const res = extractStyles([node], ctx());
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(variant.props['flex']).toMatchObject({
      $$type: 'flex',
      value: {
        flexGrow: { value: 2 },
        flexShrink: { value: 1 },
        flexBasis: { value: { size: 0 } },
      },
    });
    // The longhands must NOT appear as dropped fallbacks (they were combined, not lost).
    const decls = res.declaration_fallbacks.map((f) => f.declaration);
    expect(decls).not.toContain('flex-grow: 2');
    expect(decls).not.toContain('flex-basis: 0px');
  });

  it('default flex (0 1 auto) emits NO flex prop and creates NO fallback noise', () => {
    const node = mapped({
      source_path: 'fxd',
      computed: { 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto' },
    });
    const res = extractStyles([node], ctx());
    expect(res.styled_nodes[0]!.local_styles).toHaveLength(0);
    const decls = res.declaration_fallbacks.map((f) => f.declaration);
    expect(decls).not.toContain('flex-grow: 0');
    expect(decls).not.toContain('flex-basis: auto');
  });

  it('flex: 0 0 auto keeps the EXPLICIT auto basis — an omitted basis renders `flex:0 0` = basis 0%', () => {
    // Page-2390 regression: the icon shrink-guard `flex: 0 0 auto` was emitted without flexBasis;
    // the PHP Flex_Transformer rendered `flex: 0 0`, whose CSS-shorthand meaning is basis 0% —
    // every width-styled SVG in a flex row collapsed to 0px (11 zero-area icons).
    const node = mapped({
      source_path: 'fxa',
      computed: { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' },
    });
    const res = extractStyles([node], ctx());
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(variant.props['flex']).toEqual({
      $$type: 'flex',
      value: {
        flexGrow: { $$type: 'number', value: 0 },
        flexShrink: { $$type: 'number', value: 0 },
        flexBasis: { $$type: 'size', value: { unit: 'auto', size: null } },
      },
    });
  });

  it('a box-shadow decomposes AND a single gradient background maps to the native background prop', () => {
    const node = mapped({
      source_path: 'c',
      computed: {
        'box-shadow': '0 2px 8px rgba(0,0,0,0.2)',
        background: 'radial-gradient(circle, #1e293b 0%, #0f172a 100%)',
      },
    });
    const res = extractStyles([node], ctx());
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(variant.props['box-shadow']).toMatchObject({ $$type: 'box-shadow' });
    // The single radial gradient now renders natively (no longer a custom_css drop).
    expect(variant.props['background']).toMatchObject({ $$type: 'background' });
    const bgVal = (variant.props['background'] as { value: Record<string, unknown> }).value;
    expect(bgVal['background-overlay']).toBeDefined();
    const gradientFb = res.declaration_fallbacks.find((f) =>
      f.declaration.startsWith('background:'),
    );
    expect(gradientFb).toBeUndefined();
  });

  it('a conic gradient background still routes to custom_css', () => {
    const node = mapped({
      source_path: 'c',
      computed: { background: 'conic-gradient(#1e293b, #0f172a)' },
    });
    const res = extractStyles([node], ctx());
    const gradientFb = res.declaration_fallbacks.find((f) =>
      f.declaration.startsWith('background:'),
    );
    expect(gradientFb?.tier).toBe('custom_css');
  });

  it('on a FREE site (no Pro), a custom_css declaration is DROPPED (tier downgraded, reason notes it)', () => {
    const node = mapped({
      source_path: 'd',
      computed: { background: 'linear-gradient(90deg,#a,#b)' },
    });
    const res = extractStyles([node], ctx({ pro_active: false }));
    const fb = res.declaration_fallbacks.find((f) => f.declaration.startsWith('background:'))!;
    expect(fb.tier).not.toBe('custom_css');
    expect(fb.reason).toMatch(/dropped/i);
  });

  it('a FREE-site drop is NEVER recorded as tier native (coverage must bucket it as dropped)', () => {
    // Tier 'native' both inflated pct_native AND vanished from the fallback rollup (coverage.ts skips
    // native-tier records) — the drop must surface under the tier that buckets to 'dropped'.
    const node = mapped({
      source_path: 'd2',
      computed: { transform: 'translateX(10px)' },
    });
    const res = extractStyles([node], ctx({ pro_active: false }));
    const fb = res.declaration_fallbacks.find((f) => f.declaration.startsWith('transform:'))!;
    expect(fb.tier).toBe('html_widget');
    expect(fb.reason).toMatch(/DROPPED \(Pro inactive/);
    // Nothing materialized: no variant at all for a group whose only declaration was dropped.
    expect(res.styled_nodes[0]!.local_styles).toHaveLength(0);
  });

  it('with Pro active, a custom_css declaration is MATERIALIZED into the variant (base64 raw)', () => {
    const node = mapped({
      source_path: 'e',
      computed: { color: '#111', transform: 'translateX(10px)' },
    });
    const res = extractStyles([node], ctx({ pro_active: true }));
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(variant.custom_css).toBeDefined();
    const decoded = Buffer.from(variant.custom_css!.raw, 'base64').toString('utf8');
    expect(decoded).toContain('transform: translateX(10px);');
    // The fallback record stays tier custom_css (counted as covered — now truthfully).
    const fb = res.declaration_fallbacks.find((f) => f.declaration.startsWith('transform:'))!;
    expect(fb.tier).toBe('custom_css');
    expect(fb.reason).toMatch(/preserved in variant custom_css/);
  });

  it('MAP accent_rules materialize as NESTED custom_css rules on the BASE variant (contract 17 #8)', () => {
    // html-v3 strips every attribute (custom wp_kses allowlist), so the accent rides the local
    // style: `& em{color:…}` nests inside the element's rule block via CSS nesting.
    const node = mapped({
      source_path: 'h1',
      computed: { color: 'rgb(18, 32, 25)' },
    });
    node.accent_rules = [{ tag: 'em', color: 'rgb(12, 107, 74)' }];
    const res = extractStyles([node], ctx({ pro_active: true }));
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    const decoded = Buffer.from(variant.custom_css!.raw, 'base64').toString('utf8');
    expect(decoded).toContain('& em{color:rgb(12, 107, 74);}');
    const fb = res.declaration_fallbacks.find((f) => f.reason.includes('accent'))!;
    expect(fb.tier).toBe('custom_css');
    expect(fb.reason).toMatch(/nested custom_css rule/);
  });

  it('a FREE-site accent_rule is an HONEST drop (no custom_css channel)', () => {
    const node = mapped({
      source_path: 'h2',
      computed: { color: 'rgb(18, 32, 25)' },
    });
    node.accent_rules = [{ tag: 'em', color: 'rgb(12, 107, 74)' }];
    const res = extractStyles([node], ctx({ pro_active: false }));
    const fb = res.declaration_fallbacks.find((f) => f.reason.includes('accent'))!;
    expect(fb.tier).toBe('html_widget');
    expect(fb.reason).toMatch(/DROPPED \(Pro inactive/);
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(variant.custom_css).toBeUndefined();
  });

  it('emits a custom_css-ONLY variant when no declaration mapped natively (Pro active)', () => {
    const node = mapped({
      source_path: 'f',
      computed: { transform: 'rotate(3deg)' },
    });
    const res = extractStyles([node], ctx({ pro_active: true }));
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(Object.keys(variant.props)).toHaveLength(0);
    const decoded = Buffer.from(variant.custom_css!.raw, 'base64').toString('utf8');
    expect(decoded).toBe('transform: rotate(3deg);');
  });

  it('computed no-ops (background-image:none / transparent background) are not recorded or materialized', () => {
    const node = mapped({
      source_path: 'g',
      computed: { 'background-image': 'none', color: '#222' },
    });
    for (const pro of [true, false]) {
      const res = extractStyles([node], ctx({ pro_active: pro }));
      expect(
        res.declaration_fallbacks.find((f) => f.declaration.startsWith('background-image:')),
      ).toBeUndefined();
      const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
      expect(variant.custom_css).toBeUndefined();
    }
  });
});

/* ─────────────────────────── state + breakpoint variants ─────────────────────────────────────── */

describe('extractStyles — state + breakpoint variants (criterion 5)', () => {
  it(':hover declarations become a state:hover variant', () => {
    const node = mapped({
      source_path: 'e',
      computed: { color: '#111' },
      hoverComputed: { color: '#fff', 'background-color': '#000' },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    const hover = variants.find((v) => v.meta.state === 'hover');
    expect(hover).toBeTruthy();
    expect(hover!.props['color']).toMatchObject({ value: '#fff' });
    expect(hover!.meta.breakpoint).toBeNull();
  });

  it('per-breakpoint deltas become per-breakpoint variants with RESOLVED (non-hardcoded) keys', () => {
    const node = mapped({
      source_path: 'f',
      computed: { 'font-size': '48px' },
      responsive: { tablet: { 'font-size': '32px' }, mobile: { 'font-size': '24px' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    const tablet = variants.find((v) => v.meta.breakpoint === 'tablet');
    const mobile = variants.find((v) => v.meta.breakpoint === 'mobile');
    expect(tablet?.props['font-size']).toMatchObject({ value: { size: 32, unit: 'px' } });
    expect(mobile?.props['font-size']).toMatchObject({ value: { size: 24, unit: 'px' } });
  });
});

/* ─────────────────────────── direction-aware logical conversion (criterion 6) ────────────────── */

describe('extractStyles — text-align via WP-H02 (criterion 6)', () => {
  it('text-align:left → start (LTR)', () => {
    const node = mapped({ source_path: 'g', computed: { 'text-align': 'left' } });
    const res = extractStyles([node], ctx({ doc_direction: 'ltr', target_rtl: false }));
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(variant.props['text-align']).toMatchObject({ value: 'start' });
  });

  it('text-align:left → end (RTL target)', () => {
    const node = mapped({ source_path: 'h', computed: { 'text-align': 'left' } });
    const res = extractStyles([node], ctx({ target_rtl: true }));
    const variant = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(variant.props['text-align']).toMatchObject({ value: 'end' });
  });

  it('RTL padding mirrors the inline axis (left→inline-end, right→inline-start)', () => {
    // padding: <top> <right> <bottom> <left> = 0 0 0 12px → left=12px, right=0.
    const node = mapped({ source_path: 'i', computed: { padding: '0 0 0 12px' } });
    const res = extractStyles([node], ctx({ target_rtl: true }));
    const pad = res.styled_nodes[0]!.local_styles[0]!.variants[0]!.props['padding'] as {
      value: Record<string, unknown>;
    };
    // physical-left(12px) → inline-END in RTL; physical-right(0) → inline-START.
    expect(pad.value['inline-end']).toMatchObject({ value: { size: 12, unit: 'px' } });
    expect(pad.value['inline-start']).toMatchObject({ value: { size: 0, unit: 'px' } });
  });
});

/* ─────────────────────────── literal flagging (criterion 8) ──────────────────────────────────── */

describe('extractStyles — literal flagging', () => {
  it('literal colors/fonts/sizes are flagged with occurrence counts', () => {
    const a = mapped({
      source_path: 'n1',
      computed: { color: '#6366f1', 'font-family': 'Inter', 'font-size': '16px' },
    });
    const b = mapped({ source_path: 'n2', computed: { color: '#6366f1', 'font-size': '16px' } });
    const res = extractStyles([a, b], ctx());
    const colorLit = res.proposed_variable_literals.find(
      (l) => l.kind === 'color' && l.value === '#6366f1',
    );
    expect(colorLit?.occurrences).toEqual(['n1', 'n2']);
    expect(res.proposed_variable_literals.some((l) => l.kind === 'font')).toBe(true);
    const sizeLit = res.proposed_variable_literals.find(
      (l) => l.kind === 'size' && l.value === '16px',
    );
    expect(sizeLit?.occurrences).toEqual(['n1', 'n2']);
  });
});

/* ─────────────────────────── local-style id mirroring requirement (criterion) ────────────────── */

describe('extractStyles — local-style id placeholder (§5.1 mirroring, WP-H08 enforces)', () => {
  it('a native decl set yields a StyleDefinition with a deterministic, regex-valid placeholder id', () => {
    const node = mapped({ source_path: 'body>section', computed: { display: 'flex' } });
    const res = extractStyles([node], ctx());
    const def = res.styled_nodes[0]!.local_styles[0]!;
    expect(def.type).toBe('class');
    expect(def.id).toBe(placeholderLocalStyleId('body>section'));
    // Matches the classes name regex so it round-trips structurally before WP-H08 finalization.
    expect(def.id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  });

  it('the placeholder id is deterministic per source_path', () => {
    expect(placeholderLocalStyleId('x')).toBe(placeholderLocalStyleId('x'));
    expect(placeholderLocalStyleId('x')).not.toBe(placeholderLocalStyleId('y'));
  });
});

/* ─────────────────────────── decl_index for HOIST ───────────────────────────────────────────── */

describe('extractStyles — decl_index', () => {
  it('groups raw declarations by state/breakpoint key for WP-H09 fingerprinting', () => {
    const node = mapped({
      source_path: 'k',
      computed: { display: 'flex' },
      hoverComputed: { color: '#fff' },
      responsive: { tablet: { 'font-size': '20px' } },
    });
    const res = extractStyles([node], ctx());
    const idx = res.styled_nodes[0]!.decl_index;
    expect(idx['base']).toContainEqual({ prop: 'display', value: 'flex' });
    expect(idx['hover']).toContainEqual({ prop: 'color', value: '#fff' });
    expect(idx['tablet']).toContainEqual({ prop: 'font-size', value: '20px' });
  });
});

/* ─────────────────────────── recursion ──────────────────────────────────────────────────────── */

describe('extractStyles — recursion', () => {
  it('styles children too', () => {
    const child = mapped({ source_path: 'p>span', computed: { color: '#111' } });
    const parent = mapped({ source_path: 'p', computed: { display: 'flex' }, children: [child] });
    const res = extractStyles([parent], ctx());
    expect(res.styled_nodes[0]!.children).toHaveLength(1);
    // The frozen `StyledNode.children` is typed `MappedNode[]` (the IR seam); at runtime each child is
    // a fully-styled node, so cast to read its `local_styles`.
    const styledChild = res.styled_nodes[0]!.children[0]! as StyledNode;
    expect(styledChild.local_styles).toHaveLength(1);
  });
});

/* ─────────────────────────── responsive width policy (contract 17 — #7) ─────────────────────── */

describe('extractStyles — responsive width policy (contract 17 #7)', () => {
  it('a fluid content box trades its baked px width for max-width:100% (base) and drops the breakpoint echo', () => {
    // Parse captured the width SHRINKING at the narrower viewport — the box tracks the container,
    // so the desktop px is a capture artifact, not an authored width (the broken-mobile class).
    const node = mapped({
      source_path: 'w1',
      textRuns: [TEXT_RUN],
      computed: { width: '1180px', color: '#111' },
      responsive: { mobile: { width: '358px' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    const base = variants.find((v) => v.meta.breakpoint === null && v.meta.state === null)!;
    expect(base.props['width']).toBeUndefined();
    expect(base.props['max-width']).toMatchObject({ value: { size: 100, unit: '%' } });
    expect(base.props['color']).toMatchObject({ value: '#111' });
    // The mobile delta was ONLY the reflow echo of the same fluid width → no mobile variant at all,
    // and the exclusion is counted in the I4 summary (never silent).
    expect(variants.find((v) => v.meta.breakpoint === 'mobile')).toBeUndefined();
    const summary = res.declaration_fallbacks.find(
      (f) => f.source_path === NOISE_FILTER_SOURCE_PATH,
    );
    expect(summary?.reason).toMatch(/excluded before tier accounting/);
  });

  it('an explicit source max-width survives and suppresses the synthetic 100%', () => {
    const node = mapped({
      source_path: 'w2',
      textRuns: [TEXT_RUN],
      computed: { width: '1200px', 'max-width': '1200px' },
      responsive: { mobile: { width: '358px' } },
    });
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['width']).toBeUndefined();
    expect(base.props['max-width']).toMatchObject({ value: { size: 1200, unit: 'px' } });
  });

  it('a leaf decorative box (icon/avatar) keeps its exact px width at every breakpoint', () => {
    const node = mapped({
      source_path: 'w3',
      computed: { width: '24px' },
      responsive: { mobile: { width: '20px' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    const base = variants.find((v) => v.meta.breakpoint === null)!;
    const mobile = variants.find((v) => v.meta.breakpoint === 'mobile')!;
    expect(base.props['width']).toMatchObject({ value: { size: 24, unit: 'px' } });
    expect(mobile.props['width']).toMatchObject({ value: { size: 20, unit: 'px' } });
  });

  it('an authored media-query width override (GROWS at the narrower viewport) is NOT fluid — both kept', () => {
    const node = mapped({
      source_path: 'w4',
      textRuns: [TEXT_RUN],
      computed: { width: '300px' },
      responsive: { mobile: { width: '359px' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    expect(variants.find((v) => v.meta.breakpoint === null)!.props['width']).toMatchObject({
      value: { size: 300, unit: 'px' },
    });
    expect(variants.find((v) => v.meta.breakpoint === 'mobile')!.props['width']).toMatchObject({
      value: { size: 359, unit: 'px' },
    });
  });

  it('a FRACTIONAL (layout-derived) px width is fluid even without breakpoint deltas (fr/% tracks)', () => {
    // getComputedStyle resolves grid fr tracks / percentages to sub-pixel used values
    // (test.html's hero grid columns: 533.391px) — authored CSS px are integers.
    const node = mapped({
      source_path: 'w7',
      textRuns: [TEXT_RUN],
      computed: { width: '533.391px' },
    });
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['width']).toBeUndefined();
    expect(base.props['max-width']).toMatchObject({ value: { size: 100, unit: '%' } });
  });

  it('a kept fixed width with a collapse-to-full-width mobile override emits width:100% at the breakpoint', () => {
    // `width:300px` desktop + `width:100%` in the source's mobile media query: the 100% resolves to
    // ~the capture viewport (727px at the 767 capture). Baking 727px is only correct at exactly
    // 767 — the variant must carry the INTENT (100%) so it holds at 390 too.
    const node = mapped({
      source_path: 'w8',
      textRuns: [TEXT_RUN],
      computed: { width: '300px' },
      responsive: { mobile: { width: '727px' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    expect(variants.find((v) => v.meta.breakpoint === null)!.props['width']).toMatchObject({
      value: { size: 300, unit: 'px' },
    });
    expect(variants.find((v) => v.meta.breakpoint === 'mobile')!.props['width']).toMatchObject({
      value: { size: 100, unit: '%' },
    });
  });

  it('a content box filling ≥98% of its parent is fluid even without breakpoint deltas', () => {
    const child = mapped({
      source_path: 'p>div',
      box: { x: 0, y: 0, width: 1190, height: 80 },
      textRuns: [TEXT_RUN],
      computed: { width: '1190px' },
    });
    const parent = mapped({
      source_path: 'p',
      box: { x: 0, y: 0, width: 1200, height: 100 },
      computed: { display: 'flex' },
      children: [child],
    });
    const res = extractStyles([parent], ctx());
    const styledChild = res.styled_nodes[0]!.children[0]! as StyledNode;
    const base = styledChild.local_styles[0]!.variants[0]!;
    expect(base.props['width']).toBeUndefined();
    expect(base.props['max-width']).toMatchObject({ value: { size: 100, unit: '%' } });
  });

  it('a CONTENT-SIZED container child of a flex ROW carries an explicit width:auto (footer-stack class)', () => {
    // Elementor containers paint `width:100%` as their base (`.e-con{--width:100%}`): a fluid
    // shrink-to-fit flex-row child (the footer link-columns, the header nav) left without a width
    // fills the row and WRAPS under its siblings — page 2537's footer stacked vertically (+640px).
    const cols = mapped(
      {
        source_path: 'f>div',
        box: { x: 600, y: 0, width: 503, height: 200 },
        textRuns: [TEXT_RUN],
        computed: { width: '503.844px' },
      },
      FLEXBOX_TARGET,
    );
    const row = mapped(
      {
        source_path: 'f',
        box: { x: 0, y: 0, width: 1120, height: 220 },
        computed: { display: 'flex', 'flex-direction': 'row' },
        children: [cols],
      },
      FLEXBOX_TARGET,
    );
    const res = extractStyles([row], ctx());
    const styledChild = res.styled_nodes[0]!.children[0]! as StyledNode;
    const base = styledChild.local_styles[0]!.variants[0]!;
    expect(base.props['width']).toMatchObject({ value: { size: null, unit: 'auto' } });
    expect(base.props['max-width']).toMatchObject({ value: { size: 100, unit: '%' } });
  });

  it('a SPREAD flex-row (justify-content:space-between) FILLS its row (width:100%), not shrink-to-fit', () => {
    // A space-between header bar measures its CONTENT width at capture (logo+nav+icons = 413px).
    // Baking that — via width:auto OR the raw px — left-hugs the bar at any viewport wider than
    // capture (allbirds nav sat 413px-left at 1920). The spacing only distributes when the bar
    // fills its row, so the policy must override to width:100%.
    const bar = mapped(
      {
        source_path: 'header>nav',
        box: { x: 0, y: 0, width: 413, height: 64 },
        textRuns: [TEXT_RUN],
        computed: {
          display: 'flex',
          'flex-direction': 'row',
          'justify-content': 'space-between',
          width: '413px',
        },
      },
      FLEXBOX_TARGET,
    );
    const res = extractStyles([bar], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['width']).toMatchObject({ value: { size: 100, unit: '%' } });
  });

  it('a CONTENT-PACKED flex-row (justify-content:flex-start) is NOT force-filled (no spread to distribute)', () => {
    // The negative guard: only space-* rows fill. A flex-start row stays on its existing policy
    // (kept verbatim / width:auto for a content-sized child) — never forced to 100%.
    const bar = mapped(
      {
        source_path: 'header>nav',
        box: { x: 0, y: 0, width: 413, height: 64 },
        textRuns: [TEXT_RUN],
        computed: {
          display: 'flex',
          'flex-direction': 'row',
          'justify-content': 'flex-start',
          width: '413px',
        },
      },
      FLEXBOX_TARGET,
    );
    const res = extractStyles([bar], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['width']).not.toMatchObject({ value: { size: 100, unit: '%' } });
  });

  it('a WIDGET flex-row child (no painted base width) does NOT get the width:auto treatment', () => {
    const head = mapped(
      {
        source_path: 'f>h2',
        box: { x: 0, y: 0, width: 400, height: 40 },
        textRuns: [TEXT_RUN],
        computed: { width: '400.5px' },
      },
      HEADING_TARGET,
    );
    const row = mapped(
      {
        source_path: 'f',
        box: { x: 0, y: 0, width: 1120, height: 60 },
        computed: { display: 'flex' },
        children: [head],
      },
      FLEXBOX_TARGET,
    );
    const res = extractStyles([row], ctx());
    const styledChild = res.styled_nodes[0]!.children[0]! as StyledNode;
    const base = styledChild.local_styles[0]!.variants[0]!;
    expect(base.props['width']).toBeUndefined();
  });

  it('centered-block margins (max-width + equal L/R) restore `auto`; breakpoint echoes are consumed', () => {
    // `.wrap{max-width:1120px;margin:0 auto}` — getComputedStyle resolves the auto to the CAPTURE
    // viewport's px (80px at 1280); baking it pins the wrap off-center at every other width
    // (page 2584: the whole page sat 70px left of center at 1440).
    const node = mapped({
      source_path: 'wrap',
      textRuns: [TEXT_RUN],
      computed: {
        'max-width': '1120px',
        'margin-top': '0px',
        'margin-right': '80px',
        'margin-bottom': '0px',
        'margin-left': '80px',
      },
      responsive: { mobile: { 'margin-left': '24px', 'margin-right': '24px' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    const base = variants.find((v) => v.meta.breakpoint === null)!;
    const margin = base.props['margin'] as { value: Record<string, { value: unknown }> };
    expect(margin.value['inline-start']).toMatchObject({ value: { size: null, unit: 'auto' } });
    expect(margin.value['inline-end']).toMatchObject({ value: { size: null, unit: 'auto' } });
    // The mobile margin delta is the same auto re-resolved at the narrower capture — no variant.
    expect(variants.find((v) => v.meta.breakpoint === 'mobile')).toBeUndefined();
  });

  it('plain symmetric margins WITHOUT a max-width constraint stay verbatim (no auto guess)', () => {
    const node = mapped({
      source_path: 'm',
      textRuns: [TEXT_RUN],
      computed: { 'margin-left': '24px', 'margin-right': '24px' },
    });
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    const margin = base.props['margin'] as { value: Record<string, { value: unknown }> };
    expect(margin.value['inline-start']).toMatchObject({ value: { size: 24, unit: 'px' } });
  });

  it('per-breakpoint LAYOUT deltas (display/flex-direction/grid-template-columns/padding) emit variants', () => {
    // #7's other half: the per-breakpoint emission is NOT typography-only — source media-query
    // layout changes captured by parse land as breakpoint variant props.
    const node = mapped({
      source_path: 'w6',
      computed: { display: 'grid', 'grid-template-columns': 'repeat(3, 1fr)' },
      responsive: {
        mobile: {
          display: 'flex',
          'flex-direction': 'column',
          'grid-template-columns': 'repeat(1, 1fr)',
          'padding-top': '24px',
        },
      },
    });
    const res = extractStyles([node], ctx());
    const mobile = res.styled_nodes[0]!.local_styles[0]!.variants.find(
      (v) => v.meta.breakpoint === 'mobile',
    )!;
    expect(mobile.props['display']).toMatchObject({ value: 'flex' });
    expect(mobile.props['flex-direction']).toMatchObject({ value: 'column' });
    expect(mobile.props['grid-template-columns']).toMatchObject({ value: 'repeat(1, 1fr)' });
    const pad = mobile.props['padding'] as { value: Record<string, unknown> };
    expect(pad.value['block-start']).toMatchObject({ value: { size: 24, unit: 'px' } });
  });
});

/* ─────────────────────────── responsive grid-track policy (contract 18 §7 — P1-b) ────────────── */

describe('extractStyles — responsive grid-track policy (contract 18 §7 P1-b)', () => {
  it('a grid-only @media delta re-fluidizes: capture-resolved px tracks become minmax(0, 1fr) at BOTH base and breakpoint', () => {
    // The Driftwell failure class: `repeat(3, 1fr)` resolves to fractional equal px at the 1280
    // base capture and the mobile `grid-template-columns: 1fr` override resolves to ~the 767
    // capture width (735px). Baking either verbatim pins the capture geometry — the converted
    // page rendered 743px wide at 390 because the single mobile track stayed 735px fixed.
    const node = mapped({
      source_path: 'grid',
      box: { x: 0, y: 0, width: 1105, height: 600 },
      computed: {
        display: 'grid',
        'grid-template-columns': '352.5px 352.5px 352.5px',
        'column-gap': '24px',
      },
      responsive: { mobile: { 'grid-template-columns': '735px' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    expect(
      variants.find((v) => v.meta.breakpoint === null)!.props['grid-template-columns'],
    ).toMatchObject({
      $$type: 'string',
      value: 'repeat(3, minmax(0, 1fr))',
    });
    expect(
      variants.find((v) => v.meta.breakpoint === 'mobile')!.props['grid-template-columns'],
    ).toMatchObject({
      $$type: 'string',
      value: 'minmax(0, 1fr)',
    });
  });

  it('unequal fractional tracks convert RATIO-PRESERVING (2fr 1fr stays 2:1)', () => {
    const node = mapped({
      source_path: 'hero',
      box: { x: 0, y: 0, width: 824, height: 400 },
      computed: {
        display: 'grid',
        'grid-template-columns': '533.391px 266.695px',
        'column-gap': '24px',
      },
    });
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['grid-template-columns']).toMatchObject({
      value: 'minmax(0, 2fr) minmax(0, 1fr)',
    });
  });

  it('INTEGER px tracks that fill the container content width are fluid too (the fill signal)', () => {
    // 2×548 + 24 gap = 1120 — exactly the content width; an fr pair can resolve to integers.
    const node = mapped({
      source_path: 'cols',
      box: { x: 0, y: 0, width: 1120, height: 300 },
      computed: {
        display: 'grid',
        'grid-template-columns': '548px 548px',
        'column-gap': '24px',
      },
    });
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['grid-template-columns']).toMatchObject({
      value: 'repeat(2, minmax(0, 1fr))',
    });
  });

  it('authored FIXED tracks that do not fill stay verbatim; a collapse-to-viewport breakpoint delta still re-fluidizes', () => {
    // `240px 240px` in a 1200 box (40% fill) is authored intent — kept. The mobile delta resolves
    // ~the 767 capture viewport (the collapse-to-full-width pattern, same rule as the width
    // policy) → re-fluidized so it holds at 390 too.
    const node = mapped({
      source_path: 'fixed',
      box: { x: 0, y: 0, width: 1200, height: 300 },
      computed: { display: 'grid', 'grid-template-columns': '240px 240px' },
      responsive: { mobile: { 'grid-template-columns': '735px' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    expect(
      variants.find((v) => v.meta.breakpoint === null)!.props['grid-template-columns'],
    ).toMatchObject({
      value: '240px 240px',
    });
    expect(
      variants.find((v) => v.meta.breakpoint === 'mobile')!.props['grid-template-columns'],
    ).toMatchObject({
      value: 'minmax(0, 1fr)',
    });
  });

  it('an authored keyword/fr value passes through verbatim (never px-mangled)', () => {
    const node = mapped({
      source_path: 'kw',
      box: { x: 0, y: 0, width: 1120, height: 300 },
      computed: { display: 'grid', 'grid-template-columns': 'repeat(3, 1fr)' },
      responsive: { mobile: { 'grid-template-columns': 'repeat(1, minmax(0, 1fr))' } },
    });
    const res = extractStyles([node], ctx());
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    expect(
      variants.find((v) => v.meta.breakpoint === null)!.props['grid-template-columns'],
    ).toMatchObject({
      value: 'repeat(3, 1fr)',
    });
    expect(
      variants.find((v) => v.meta.breakpoint === 'mobile')!.props['grid-template-columns'],
    ).toMatchObject({
      value: 'repeat(1, minmax(0, 1fr))',
    });
  });

  it('a genuinely authored small fixed breakpoint track is kept (no false fluidization)', () => {
    const node = mapped({
      source_path: 'authored',
      box: { x: 0, y: 0, width: 1200, height: 300 },
      computed: { display: 'grid', 'grid-template-columns': '240px 240px' },
      responsive: { mobile: { 'grid-template-columns': '240px' } },
    });
    const res = extractStyles([node], ctx());
    const mobile = res.styled_nodes[0]!.local_styles[0]!.variants.find(
      (v) => v.meta.breakpoint === 'mobile',
    )!;
    expect(mobile.props['grid-template-columns']).toMatchObject({ value: '240px' });
  });
});

/* ─────────────────────────── folded in-text link underline (contract 18 §7 — P2-e) ───────────── */

describe('extractStyles — folded in-text link underline carry (contract 18 §7 P2-e)', () => {
  const LINKED_RUNS = [
    { text: 'Read the ', inlineTags: [] },
    { text: 'terms', inlineTags: ['a'], linkHref: 'https://x/terms' },
    { text: '.', inlineTags: [] },
  ];

  it('a text widget with a linked run carries `& a{text-decoration:underline;}` as nested custom_css (Pro)', () => {
    const node = mapped(
      {
        source_path: 'p',
        tag: 'p',
        role: 'text',
        textRuns: LINKED_RUNS,
        computed: { color: '#111' },
      },
      PARAGRAPH_TARGET,
    );
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    const decoded = Buffer.from(base.custom_css!.raw, 'base64').toString('utf8');
    expect(decoded).toContain('& a{text-decoration:underline;}');
    const fb = res.declaration_fallbacks.find(
      (f) => f.declaration === 'text-decoration: underline',
    )!;
    expect(fb.tier).toBe('custom_css');
    expect(fb.reason).toMatch(/nested custom_css rule/);
  });

  it('coexists with an accent rule on the same <a> (color + underline, two nested rules)', () => {
    const node = mapped(
      {
        source_path: 'p',
        tag: 'p',
        role: 'text',
        textRuns: [{ text: 'docs', inlineTags: ['a'], linkHref: '/docs', color: '#0C6B4A' }],
        computed: { color: '#111' },
      },
      PARAGRAPH_TARGET,
    );
    node.accent_rules = [{ tag: 'a', color: '#0C6B4A' }];
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    const decoded = Buffer.from(base.custom_css!.raw, 'base64').toString('utf8');
    expect(decoded).toContain('& a{color:#0C6B4A;}');
    expect(decoded).toContain('& a{text-decoration:underline;}');
  });

  it('on a FREE site the underline is an HONEST drop (no custom_css channel, never silent)', () => {
    const node = mapped(
      {
        source_path: 'p',
        tag: 'p',
        role: 'text',
        textRuns: LINKED_RUNS,
        computed: { color: '#111' },
      },
      PARAGRAPH_TARGET,
    );
    const res = extractStyles([node], ctx({ pro_active: false }));
    const fb = res.declaration_fallbacks.find(
      (f) => f.declaration === 'text-decoration: underline',
    )!;
    expect(fb.tier).toBe('html_widget');
    expect(fb.reason).toMatch(/DROPPED/);
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.custom_css).toBeUndefined();
  });

  it('runs WITHOUT linkHref get no underline rule; non-folding (container) targets get none either', () => {
    const plain = mapped(
      {
        source_path: 'p2',
        tag: 'p',
        role: 'text',
        textRuns: [{ text: 'no links here', inlineTags: ['em'] }],
        computed: { color: '#111' },
      },
      PARAGRAPH_TARGET,
    );
    const container = mapped({
      source_path: 'div',
      textRuns: LINKED_RUNS,
      computed: { color: '#111' },
    });
    const res = extractStyles([plain, container], ctx());
    expect(
      res.declaration_fallbacks.find((f) => f.declaration === 'text-decoration: underline'),
    ).toBeUndefined();
    for (const styled of res.styled_nodes) {
      const variant = styled.local_styles[0]?.variants[0];
      expect(variant?.custom_css).toBeUndefined();
    }
  });
});

/* ─────────────────────────── painted base defaults (contract 17 — #8 / I2) ───────────────────── */

describe('extractStyles — painted base defaults (contract 17 #8/I2)', () => {
  it('the exemption table pins the contract I2 widgets (consistent with integrity BASE_DEFAULTS)', () => {
    expect([...PAINTED_BASE_DEFAULT_PROPS['e-button']!].sort()).toEqual([
      'background',
      'border-radius',
      'padding',
    ]);
    expect([...PAINTED_BASE_DEFAULT_PROPS['e-flexbox']!].sort()).toEqual([
      'flex-direction',
      'padding',
    ]);
    expect([...PAINTED_BASE_DEFAULT_PROPS['e-div-block']!].sort()).toEqual(['padding']);
    expect([...PAINTED_BASE_DEFAULT_PROPS['e-svg']!].sort()).toEqual(['height', 'width']);
  });

  it('a transparent background on e-button is EMITTED explicitly (ghost buttons must not turn blue)', () => {
    const node = mapped(
      { source_path: 'btn', computed: { 'background-color': 'rgba(0, 0, 0, 0)', color: '#fff' } },
      BUTTON_TARGET,
    );
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['background']).toMatchObject({
      $$type: 'background',
      value: { color: { $$type: 'color', value: 'rgba(0, 0, 0, 0)' } },
    });
  });

  it('the same transparent background on a NEUTRAL widget stays a filtered no-op', () => {
    const node = mapped({
      source_path: 'div',
      computed: { 'background-color': 'rgba(0, 0, 0, 0)', color: '#fff' },
    });
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['background']).toBeUndefined();
    expect(base.custom_css).toBeUndefined();
  });

  it('a transparent HOVER background on e-button is also emitted (the delta is load-bearing)', () => {
    const node = mapped(
      {
        source_path: 'btnh',
        computed: { 'background-color': '#6366f1' },
        hoverComputed: { 'background-color': 'rgba(0, 0, 0, 0)' },
      },
      BUTTON_TARGET,
    );
    const res = extractStyles([node], ctx());
    const hover = res.styled_nodes[0]!.local_styles[0]!.variants.find(
      (v) => v.meta.state === 'hover',
    )!;
    expect(hover.props['background']).toMatchObject({
      value: { color: { value: 'rgba(0, 0, 0, 0)' } },
    });
  });

  it('zero padding + zero radius are emitted on e-button (painted base) but filtered on a neutral widget', () => {
    const computed = {
      'padding-top': '0px',
      'padding-right': '0px',
      'padding-bottom': '0px',
      'padding-left': '0px',
      'border-top-left-radius': '0px',
      'border-top-right-radius': '0px',
      'border-bottom-right-radius': '0px',
      'border-bottom-left-radius': '0px',
      color: '#111',
    };
    const onButton = extractStyles([mapped({ source_path: 'b', computed }, BUTTON_TARGET)], ctx());
    const buttonBase = onButton.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(buttonBase.props['padding']).toMatchObject({ $$type: 'dimensions' });
    expect(buttonBase.props['border-radius']).toMatchObject({ $$type: 'border-radius' });

    const onHeading = extractStyles(
      [mapped({ source_path: 'h', computed }, HEADING_TARGET)],
      ctx(),
    );
    const headingBase = onHeading.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(headingBase.props['padding']).toBeUndefined();
    expect(headingBase.props['border-radius']).toBeUndefined();
    const summary = onHeading.declaration_fallbacks.find(
      (f) => f.source_path === NOISE_FILTER_SOURCE_PATH,
    );
    expect(summary?.reason).toMatch(/8 computed-default/);
  });

  it('zero padding is ALSO emitted on e-div-block (its base paints 10px on every side)', () => {
    const computed = {
      'padding-top': '0px',
      'padding-right': '0px',
      'padding-bottom': '0px',
      'padding-left': '0px',
    };
    const res = extractStyles([mapped({ source_path: 'dz', computed })], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['padding']).toMatchObject({ $$type: 'dimensions' });
  });

  it('flex-direction:row is emitted on e-flexbox (base default is COLUMN) but filtered on e-div-block', () => {
    const computed = { display: 'flex', 'flex-direction': 'row' };
    const onFlexbox = extractStyles(
      [mapped({ source_path: 'fb', computed }, FLEXBOX_TARGET)],
      ctx(),
    );
    expect(
      onFlexbox.styled_nodes[0]!.local_styles[0]!.variants[0]!.props['flex-direction'],
    ).toMatchObject({ value: 'row' });

    const onDiv = extractStyles([mapped({ source_path: 'db', computed })], ctx());
    expect(
      onDiv.styled_nodes[0]!.local_styles[0]!.variants[0]!.props['flex-direction'],
    ).toBeUndefined();
  });

  it('width/height defaults are emitted on e-svg (50x50 base) but filtered on a neutral leaf', () => {
    const computed = { width: 'auto', height: 'auto', color: '#111' };
    const onSvg = extractStyles([mapped({ source_path: 'svg', computed }, SVG_TARGET)], ctx());
    const svgBase = onSvg.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(svgBase.props['width']).toMatchObject({ value: { size: null, unit: 'auto' } });

    const onDiv = extractStyles([mapped({ source_path: 'leaf', computed })], ctx());
    const divBase = onDiv.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(divBase.props['width']).toBeUndefined();
  });

  it('e-svg keeps an EXACT height even with element children (svg internals are not reflowable content)', () => {
    // PARSE captures svg internals (<circle>/<path>) as children, so the height→min-height remap
    // used to fire — but min-height:16px cannot override e-svg's painted 50px base height (the
    // icon balloons to 50px; the live-corpus I2 catch). A size-painting widget keeps `height`.
    const node = mapped(
      {
        source_path: 'svg',
        computed: { width: '16px', height: '16px' },
        children: [
          {
            source_path: 'svg>circle',
            tag: 'circle',
            role: 'structural-block',
            box: ZERO_BOX,
            computed: {},
            responsive: {},
            attrs: {},
            textRuns: [],
            children: [],
          },
        ],
      },
      SVG_TARGET,
    );
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['height']).toMatchObject({ value: { size: 16, unit: 'px' } });
    expect(base.props['min-height']).toBeUndefined();
  });

  it('background RIDERS (size/position) at browser defaults are NOISE even on a painted-base button (I4)', () => {
    const node = mapped(
      {
        source_path: 'btn',
        computed: {
          'background-color': 'rgba(0, 0, 0, 0)',
          'background-size': 'auto',
          'background-position': '0% 0%',
          color: '#fff',
        },
      },
      BUTTON_TARGET,
    );
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    // The FILL override still lands (ghost buttons stay transparent)…
    expect(base.props['background']).toMatchObject({
      value: { color: { value: 'rgba(0, 0, 0, 0)' } },
    });
    // …but the default riders are filtered as noise — never custom_css/dropped ledger rows.
    const riders = res.declaration_fallbacks.filter(
      (f) => f.source_path !== NOISE_FILTER_SOURCE_PATH && f.declaration.startsWith('background-'),
    );
    expect(riders).toEqual([]);
    expect(base.custom_css).toBeUndefined();
  });
});

/* ─────────────────────────── I4 computed-default noise filter (contract 17) ──────────────────── */

describe('extractStyles — I4 computed-default noise filter', () => {
  it('strips the per-element computed defaults BEFORE tier accounting and reports the count', () => {
    const node = mapped({
      source_path: 'n',
      computed: {
        color: '#222',
        transform: 'none',
        transition: 'all 0s ease 0s',
        'background-image': 'none',
        opacity: '1',
        position: 'static',
        'z-index': 'auto',
        order: '0',
        'min-width': '0px',
        'max-width': 'none',
        'flex-wrap': 'nowrap',
      },
    });
    const res = extractStyles([node], ctx({ pro_active: true }));
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    // ONLY the real declaration survives — nothing materialized into custom_css.
    expect(Object.keys(base.props)).toEqual(['color']);
    expect(base.custom_css).toBeUndefined();
    // Exactly ONE summary record carries the filtered count (10 no-ops) — no per-decl fallbacks.
    expect(res.declaration_fallbacks).toHaveLength(1);
    const summary = res.declaration_fallbacks[0]!;
    expect(summary.source_path).toBe(NOISE_FILTER_SOURCE_PATH);
    expect(summary.tier).toBe('native');
    expect(summary.reason).toMatch(/I4 noise filter: 10 /);
  });

  it('all-zero margin is filtered; a partially-zero margin (0 auto) is kept whole', () => {
    const zero = mapped({
      source_path: 'mz',
      computed: {
        'margin-top': '0px',
        'margin-right': '0px',
        'margin-bottom': '0px',
        'margin-left': '0px',
        color: '#111',
      },
    });
    const zeroRes = extractStyles([zero], ctx());
    expect(zeroRes.styled_nodes[0]!.local_styles[0]!.variants[0]!.props['margin']).toBeUndefined();

    const centered = mapped({ source_path: 'mc', computed: { margin: '0px auto' } });
    const centeredRes = extractStyles([centered], ctx());
    const m = centeredRes.styled_nodes[0]!.local_styles[0]!.variants[0]!.props['margin'] as {
      value: Record<string, unknown>;
    };
    expect(m.value['inline-start']).toMatchObject({ value: { size: null, unit: 'auto' } });
  });

  it('a zero-width border drops its style/color riders too (zero-effect carriers)', () => {
    const node = mapped({
      source_path: 'bz',
      computed: {
        'border-top-width': '0px',
        'border-right-width': '0px',
        'border-bottom-width': '0px',
        'border-left-width': '0px',
        'border-top-style': 'solid',
        'border-color': 'rgb(0, 0, 0)',
        color: '#111',
      },
    });
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['border-width']).toBeUndefined();
    expect(base.props['border-style']).toBeUndefined();
    expect(res.declaration_fallbacks[0]?.reason).toMatch(/I4 noise filter: 6 /);
  });

  it('a none-style outline drops its UA-default width/color riders (3px medium paints nothing)', () => {
    const node = mapped({
      source_path: 'ol',
      computed: {
        'outline-style': 'none',
        'outline-width': '3px',
        'outline-color': 'rgb(18, 32, 25)',
        color: '#111',
      },
    });
    const res = extractStyles([node], ctx({ pro_active: true }));
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(Object.keys(base.props)).toEqual(['color']);
    expect(base.custom_css).toBeUndefined();
    expect(res.declaration_fallbacks[0]?.reason).toMatch(/I4 noise filter: 3 /);
  });

  it('a REAL border still emits width + style together (the 2026-06-09 border-style fix holds)', () => {
    const node = mapped({
      source_path: 'br',
      computed: {
        'border-top-width': '1px',
        'border-right-width': '1px',
        'border-bottom-width': '1px',
        'border-left-width': '1px',
        'border-top-style': 'solid',
      },
    });
    const res = extractStyles([node], ctx());
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(base.props['border-width']).toMatchObject({ $$type: 'border-width' });
    expect(base.props['border-style']).toMatchObject({ value: 'solid' });
  });

  it('state/breakpoint DELTAS are never noise-filtered (a delta is a change from base)', () => {
    const node = mapped({
      source_path: 'dl',
      computed: { color: '#111', transform: 'translateX(4px)' },
      hoverComputed: { transform: 'none' },
      responsive: { mobile: { 'flex-wrap': 'nowrap' } },
    });
    const res = extractStyles([node], ctx({ pro_active: true }));
    const variants = res.styled_nodes[0]!.local_styles[0]!.variants;
    // hover's transform:none REMOVES the base transform — materialized, not filtered.
    const hover = variants.find((v) => v.meta.state === 'hover')!;
    expect(Buffer.from(hover.custom_css!.raw, 'base64').toString('utf8')).toContain(
      'transform: none;',
    );
    // the mobile flex-wrap delta is recorded down the ladder, not silently excluded.
    expect(res.declaration_fallbacks.some((f) => f.declaration === 'flex-wrap: nowrap')).toBe(true);
  });

  it('a transition with a real duration is NOT filtered (custom_css materialization preserved)', () => {
    const node = mapped({
      source_path: 'tr',
      computed: { transition: 'opacity 0.3s ease 0s' },
    });
    const res = extractStyles([node], ctx({ pro_active: true }));
    const base = res.styled_nodes[0]!.local_styles[0]!.variants[0]!;
    expect(Buffer.from(base.custom_css!.raw, 'base64').toString('utf8')).toContain(
      'transition: opacity 0.3s ease 0s;',
    );
  });

  it('zero noise → zero summary records (clean inputs stay byte-identical)', () => {
    const node = mapped({ source_path: 'cl', computed: { color: '#111' } });
    const res = extractStyles([node], ctx());
    expect(
      res.declaration_fallbacks.find((f) => f.source_path === NOISE_FILTER_SOURCE_PATH),
    ).toBeUndefined();
  });
});

/* ─────────────────────────── helper: box shorthand ──────────────────────────────────────────── */

describe('expandBoxShorthand', () => {
  it('expands 1/2/3/4-token shorthands', () => {
    expect(expandBoxShorthand('8px')).toEqual({
      top: '8px',
      right: '8px',
      bottom: '8px',
      left: '8px',
    });
    expect(expandBoxShorthand('8px 4px')).toEqual({
      top: '8px',
      right: '4px',
      bottom: '8px',
      left: '4px',
    });
    expect(expandBoxShorthand('1px 2px 3px')).toEqual({
      top: '1px',
      right: '2px',
      bottom: '3px',
      left: '2px',
    });
    expect(expandBoxShorthand('1px 2px 3px 4px')).toEqual({
      top: '1px',
      right: '2px',
      bottom: '3px',
      left: '4px',
    });
  });
});

/* ─────────────────────────── CONTRACT: schema validation (Ajv2020) ──────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(HERE, '..', '..', '..', 'shared', 'schemas');

/** Compile a validator for the StyleDefinition schema (+ its atomic-prop-types $ref). */
function compileStyleDefinitionValidator(): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  // Register the cross-referenced atomic-prop-types schema first (by its $id).
  const atomic = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'atomic-prop-types.schema.json'), 'utf8'),
  ) as AnySchemaObject;
  ajv.addSchema(atomic);
  const styleVariant = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'style-variant.schema.json'), 'utf8'),
  ) as AnySchemaObject;
  return ajv.compile(styleVariant);
}

describe('extractStyles — produced StyleDefinitions validate against the frozen schemas (criterion 9)', () => {
  const validate = compileStyleDefinitionValidator();

  it('a representative node produces schema-VALID StyleDefinitions', () => {
    const node = mapped({
      source_path: 'body>section.hero',
      computed: {
        display: 'flex',
        padding: '96px 24px',
        color: '#e2e8f0',
        'font-size': '56px',
        'font-weight': '800',
        'border-radius': '999px',
        'box-shadow': '0 2px 8px rgba(0,0,0,0.2)',
        'text-align': 'left',
      },
      hoverComputed: { color: '#ffffff' },
      responsive: { tablet: { 'font-size': '40px' } },
    });
    const res = extractStyles([node], ctx());
    const defs = res.styled_nodes[0]!.local_styles;
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      const ok = validate(def);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('every variant prop value is a well-formed TypedValue envelope', () => {
    const node = mapped({
      source_path: 'q',
      computed: { display: 'flex', width: 'auto', 'background-color': '#000', margin: '0 auto' },
    });
    const res = extractStyles([node], ctx());
    const def = res.styled_nodes[0]!.local_styles[0]!;
    const ok = validate(def);
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });
});
