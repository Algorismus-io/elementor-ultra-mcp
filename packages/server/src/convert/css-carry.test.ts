/**
 * WP-H14b — first-party inline-CSS carry tests. Pure module (no Chromium): census the raw source
 * html's `<style>` blocks, filter to the three additive rule families (@keyframes / animation
 * bindings / id-selector rules), emit ONE html widget. Mirrors the passthrough test discipline:
 * partition accounting is total, defaults emit zero bytes, capability gate blocks with a reason.
 */

import { describe, expect, it } from 'vitest';

import { buildCssCarry, censusInlineStyles } from './css-carry.js';

const CAPS_OK = { unfiltered_html: true };
const CAPS_NO = { unfiltered_html: false };
const seeded = { rand: () => 0.42 };

/** The field shape: a ticker marquee + its binding + script-created-UI rules + layout noise. */
const FIELD_CSS = `
  /* comment stripped */
  @keyframes rkDiscA { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  .rk-disc-flow { animation: rkDiscA 50s linear infinite; }
  #sx-theme-toggle { position: fixed; right: 22px; }
  #sx-theme-toggle:hover, #rw-burger { transform: scale(1.05); }
  .rk-band { background: #ec5a1e; padding: 96px 0; }
  .rk-h2, #mixed { font-size: 3rem; }
  @media (max-width: 880px) {
    .rk-disc-flow { animation-name: rkDiscB; }
    .rk-band { padding: 48px 0; }
  }
  @font-face { font-family: X; src: url(x.woff2); }
  @import url(other.css);
`;

describe('censusInlineStyles', () => {
  it('captures every non-empty inline <style> body with byte counts', () => {
    const html = `<style>.a{color:red}</style><div>x</div><style type="text/css">\n@keyframes k{}\n</style><style>   </style>`;
    const blocks = censusInlineStyles(html);
    expect(blocks.length).toBe(2); // the whitespace-only block is skipped
    expect(blocks[0]?.content).toContain('.a{color:red}');
    expect(blocks[1]?.content).toContain('@keyframes k');
    expect(blocks.every((b) => b.bytes > 0)).toBe(true);
  });
});

describe('buildCssCarry — the three carried families, everything else excluded', () => {
  const blocks = censusInlineStyles(`<style>${FIELD_CSS}</style>`);

  it("mode 'inline': carries keyframes + animation bindings + id-only rules; excludes the rest", () => {
    const res = buildCssCarry(blocks, 'inline', CAPS_OK, seeded);
    expect(res.widgetNode).not.toBeNull();
    const html = (res.widgetNode?.settings as { html: string }).html;
    // 1 — keyframes carried whole
    expect(html).toContain('@keyframes rkDiscA');
    expect(html).toContain('translateX(-50%)');
    // 2 — animation bindings carried (top-level AND inside the preserved @media wrapper)
    expect(html).toContain('.rk-disc-flow');
    expect(html).toMatch(/@media \(max-width: 880px\)\{[\s\S]*animation-name: rkDiscB/);
    // 3 — id-only selector groups carried (script-created UI)
    expect(html).toContain('#sx-theme-toggle');
    expect(html).toContain('#rw-burger');
    // exclusions: layout rules, mixed id+class groups, @font-face, @import
    expect(html).not.toContain('.rk-band');
    expect(html).not.toContain('#mixed');
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('@import');
    // partition accounting
    expect(res.report.carried.keyframes).toBe(1);
    expect(res.report.carried.animation_bindings).toBe(2); // top-level + in-@media
    expect(res.report.carried.id_rules).toBe(2);
    expect(res.report.excluded_rules).toBeGreaterThanOrEqual(3); // .rk-band ×2, mixed, @font-face
    expect(res.report.carried.bytes).toBeGreaterThan(0);
  });

  it('DEFAULT (absent/none): zero style bytes, no widget, census still counted', () => {
    for (const mode of [undefined, 'none' as const]) {
      const res = buildCssCarry(blocks, mode, CAPS_OK, seeded);
      expect(res.widgetNode).toBeNull();
      expect(res.report.carried.bytes).toBe(0);
      expect(res.report.source_blocks).toBe(1);
    }
  });

  it('unfiltered_html missing → blocked with a reason, never a widget (kses strips <style>)', () => {
    const res = buildCssCarry(blocks, 'inline', CAPS_NO, seeded);
    expect(res.widgetNode).toBeNull();
    expect(res.report.blocked_reason).toBe('unfiltered_html_missing');
  });

  it('nothing carriable (pure layout CSS) → no widget, exclusions counted', () => {
    const layoutOnly = censusInlineStyles('<style>.x{color:red}.y{margin:0}</style>');
    const res = buildCssCarry(layoutOnly, 'inline', CAPS_OK, seeded);
    expect(res.widgetNode).toBeNull();
    expect(res.report.excluded_rules).toBe(2);
  });
});
