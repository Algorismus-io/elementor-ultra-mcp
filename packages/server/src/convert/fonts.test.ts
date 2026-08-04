/**
 * Contract 17 §5 #9 — WEBFONT CARRY tests (all PURE — no Chromium, no I/O).
 *
 * Covers: the raw-source font-link census (`censusFontLinks` — `<link rel=stylesheet>` + `@import`,
 * font-provider/path heuristics), URL → family attribution (`extractFamiliesFromFontUrl` — css2 /
 * legacy Google syntax, opaque CSS), used-family normalization (stacks, quotes, generics), and
 * `buildFontCarry`: ONE classic `html` widget (flat `settings.html` string — same shape as
 * `passthrough.ts`), used-family gating, opaque-link handling, the `carried ∪ excluded` report
 * partition, `families_uncarried`, escaping, and deterministic ids via a seeded `RandomSource`.
 */

import { describe, expect, it } from 'vitest';

import {
  FONT_CARRY_MARKER,
  buildFontCarry,
  censusFontLinks,
  extractFamiliesFromFontUrl,
  isFontStylesheetHref,
  normalizeUsedFamilies,
  type FontAssets,
} from './fonts.js';

/* ─────────────────────────── fixtures ────────────────────────────────────────────────────────── */

/** Deterministic random source (cycles 0, 1/16, 2/16, … → ids like `0123456`). */
function seededRand(): () => number {
  let i = 0;
  return () => (i++ % 16) / 16;
}

const GOOGLE_CSS2 =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=JetBrains+Mono:wght@400;700&display=swap';

function assets(partial: Partial<FontAssets> = {}): FontAssets {
  return { links: partial.links ?? [], families: partial.families ?? [] };
}

/* ─────────────────────────── censusFontLinks ─────────────────────────────────────────────────── */

describe('fonts: censusFontLinks (raw-source census)', () => {
  it('captures font stylesheet <link>s and ignores non-font stylesheets', () => {
    const html =
      `<link rel="preconnect" href="https://fonts.gstatic.com">` +
      `<link rel="stylesheet" href="${GOOGLE_CSS2}">` +
      `<link rel="stylesheet" href="https://example.com/theme/main.css">` +
      `<link href='./assets/fonts.css' rel='stylesheet'>` +
      `<div>content</div>`;
    expect(censusFontLinks(html)).toEqual([GOOGLE_CSS2, './assets/fonts.css']);
  });

  it('captures @import targets from the author css and inline <style> blocks', () => {
    const html =
      '<style>@import url("https://fonts.bunny.net/css?family=inter:400");</style><p>x</p>';
    const css = "@import 'https://fonts.googleapis.com/css2?family=Karla&display=swap';";
    // Order: <link> tags, then the author css arg, then inline <style> blocks.
    expect(censusFontLinks(html, css)).toEqual([
      'https://fonts.googleapis.com/css2?family=Karla&display=swap',
      'https://fonts.bunny.net/css?family=inter:400',
    ]);
  });

  it('dedupes repeated hrefs and returns [] when nothing font-ish is referenced', () => {
    const html =
      `<link rel="stylesheet" href="${GOOGLE_CSS2}">` +
      `<link rel="stylesheet" href="${GOOGLE_CSS2}">`;
    expect(censusFontLinks(html)).toEqual([GOOGLE_CSS2]);
    expect(censusFontLinks('<link rel="stylesheet" href="main.css"><p>x</p>')).toEqual([]);
  });

  it('isFontStylesheetHref: providers + font-path tokens, but not lookalikes', () => {
    expect(isFontStylesheetHref('https://use.typekit.net/abc1def.css')).toBe(true);
    expect(isFontStylesheetHref('/static/webfonts.css')).toBe(true);
    expect(isFontStylesheetHref('/fonts/faces.css?v=3')).toBe(true);
    expect(isFontStylesheetHref('https://example.com/frontend.css')).toBe(false);
    expect(isFontStylesheetHref('https://example.com/typography-tokens.css')).toBe(false);
  });
});

/* ─────────────────────────── extractFamiliesFromFontUrl ─────────────────────────────────────── */

describe('fonts: extractFamiliesFromFontUrl', () => {
  it('parses css2 multi-param URLs (axis lists stripped, + decoded to space)', () => {
    expect(extractFamiliesFromFontUrl(GOOGLE_CSS2)).toEqual([
      'Bricolage Grotesque',
      'JetBrains Mono',
    ]);
  });

  it('parses the legacy pipe syntax (family=A:400,700|B)', () => {
    expect(
      extractFamiliesFromFontUrl(
        'https://fonts.googleapis.com/css?family=Roboto:400,700|Open+Sans',
      ),
    ).toEqual(['Roboto', 'Open Sans']);
  });

  it('returns [] for opaque font CSS (no family params) and for empty/relative URLs', () => {
    expect(extractFamiliesFromFontUrl('https://use.typekit.net/abc1def.css')).toEqual([]);
    expect(extractFamiliesFromFontUrl('./assets/fonts.css')).toEqual([]);
  });
});

/* ─────────────────────────── normalizeUsedFamilies ──────────────────────────────────────────── */

describe('fonts: normalizeUsedFamilies', () => {
  it('splits stacks, strips quotes, drops generics, dedupes case-insensitively', () => {
    expect(
      normalizeUsedFamilies([
        '"Bricolage Grotesque", sans-serif',
        "'JetBrains Mono', monospace",
        'bricolage grotesque', // dup (case-insensitive — first casing wins)
        'system-ui',
      ]),
    ).toEqual(['Bricolage Grotesque', 'JetBrains Mono']);
  });

  it('returns [] for generics-only / empty input', () => {
    expect(normalizeUsedFamilies(['serif, sans-serif', ''])).toEqual([]);
    expect(normalizeUsedFamilies([])).toEqual([]);
  });

  it('P2-f: tolerates escaped quotes, NBSP whitespace, and drops UA-only stack tokens', () => {
    expect(
      normalizeUsedFamilies([
        '\\"JetBrains Mono\\", monospace', // JSON/inline-CSS escape leak-through
        'JetBrains Mono', // NBSP instead of a space (dup of the above)
        'Public Sans,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', // live field stack
      ]),
    ).toEqual(['JetBrains Mono', 'Public Sans', 'Segoe UI']);
  });
});

/* ─────────────────────────── buildFontCarry ──────────────────────────────────────────────────── */

describe('fonts: buildFontCarry', () => {
  it('carries a Google link when one of its families is used (stack input, case-insensitive)', () => {
    const { widgetNode, report } = buildFontCarry(
      assets({ links: [GOOGLE_CSS2], families: ['Bricolage Grotesque', 'JetBrains Mono'] }),
      ['"bricolage grotesque", sans-serif'],
      { rand: seededRand() },
    );
    expect(widgetNode).not.toBeNull();
    // ONE classic html widget — flat settings.html string, no typed envelopes (passthrough shape).
    expect(widgetNode).toMatchObject({ elType: 'widget', widgetType: 'html' });
    expect(widgetNode?.id).toMatch(/^[0-9a-f]{7}$/);
    const html = widgetNode?.settings['html'] as string;
    expect(html).toContain(`<link rel="stylesheet" ${FONT_CARRY_MARKER} href="`);
    // & in the href passes verbatim (raw attribute text — no double-encoding), " would be escaped.
    expect(html).toContain('family=Bricolage+Grotesque');
    expect(html).toContain('&display=swap');
    expect(report.carried).toEqual([
      { href: GOOGLE_CSS2, families: ['Bricolage Grotesque', 'JetBrains Mono'] },
    ]);
    expect(report.excluded).toEqual([]);
    expect(report.families_used).toEqual(['bricolage grotesque']);
    expect(report.families_uncarried).toEqual([]);
  });

  it('excludes a link whose declared families are unused (no_used_family) → null widget', () => {
    const { widgetNode, report } = buildFontCarry(
      assets({ links: [GOOGLE_CSS2], families: ['Bricolage Grotesque'] }),
      ['Arial, sans-serif'],
    );
    expect(widgetNode).toBeNull();
    expect(report.carried).toEqual([]);
    expect(report.excluded).toEqual([
      {
        href: GOOGLE_CSS2,
        families: ['Bricolage Grotesque', 'JetBrains Mono'],
        reason: 'no_used_family',
      },
    ]);
  });

  it('opaque font CSS: carried iff a captured @font-face family is used', () => {
    const opaque = 'https://use.typekit.net/abc1def.css';
    const used = buildFontCarry(assets({ links: [opaque], families: ['Proxima Nova'] }), [
      '"Proxima Nova", sans-serif',
    ]);
    expect(used.widgetNode).not.toBeNull();
    expect(used.report.carried).toEqual([{ href: opaque, families: [] }]);

    const unused = buildFontCarry(assets({ links: [opaque], families: ['Proxima Nova'] }), [
      'Georgia, serif',
    ]);
    expect(unused.widgetNode).toBeNull();
    expect(unused.report.excluded).toEqual([
      { href: opaque, families: [], reason: 'no_used_family' },
    ]);
  });

  it('emits ONE widget for multiple carried links and partitions the census exactly once', () => {
    const fa = assets({
      links: [GOOGLE_CSS2, './assets/fonts.css', 'https://fonts.bunny.net/css?family=karla:400'],
      families: ['Bricolage Grotesque', 'LocalFace', 'Karla'],
    });
    const { widgetNode, report } = buildFontCarry(fa, ['Bricolage Grotesque', 'LocalFace'], {
      rand: seededRand(),
    });
    // google (declared family used) + opaque (a used family has a @font-face) carried; bunny's
    // declared family (karla) is unused → excluded.
    expect(report.carried.map((c) => c.href)).toEqual([GOOGLE_CSS2, './assets/fonts.css']);
    expect(report.excluded.map((e) => e.href)).toEqual([
      'https://fonts.bunny.net/css?family=karla:400',
    ]);
    expect(report.carried.length + report.excluded.length).toBe(fa.links.length);
    const html = widgetNode?.settings['html'] as string;
    expect(html.match(/<link /g)).toHaveLength(2);
    expect(html.split('\n')).toHaveLength(2);
  });

  it('families_uncarried: a used @font-face family with NO carriable link is reported (I3)', () => {
    // Inline <style> @font-face — the face exists, but there is no <link> to carry.
    const { widgetNode, report } = buildFontCarry(assets({ families: ['LocalFace'] }), [
      '"LocalFace", serif',
    ]);
    expect(widgetNode).toBeNull();
    expect(report.families_uncarried).toEqual(['LocalFace']);
  });

  it('families_uncarried is empty when an opaque carried link plausibly provides the face', () => {
    const { report } = buildFontCarry(
      assets({ links: ['./assets/fonts.css'], families: ['LocalFace'] }),
      ['LocalFace'],
    );
    expect(report.carried).toHaveLength(1);
    expect(report.families_uncarried).toEqual([]);
  });

  it('escapes " in hrefs and is deterministic with a seeded rand + usedIds dedupe', () => {
    const weird = 'https://fonts.googleapis.com/css2?family=Karla"onload=x&display=swap';
    const a = buildFontCarry(assets({ links: [weird], families: [] }), ['Karla"onload=x'], {
      rand: seededRand(),
    });
    expect(a.widgetNode?.settings['html'] as string).toContain('&quot;onload=x');
    expect(a.widgetNode?.settings['html'] as string).not.toContain('"onload');
    const b = buildFontCarry(assets({ links: [weird], families: [] }), ['Karla"onload=x'], {
      rand: seededRand(),
    });
    expect(b.widgetNode?.id).toBe(a.widgetNode?.id);
    const c = buildFontCarry(assets({ links: [weird], families: [] }), ['Karla"onload=x'], {
      rand: seededRand(),
      usedIds: new Set([a.widgetNode?.id ?? '']),
    });
    expect(c.widgetNode?.id).not.toBe(a.widgetNode?.id);
  });

  it('tolerates undefined fontAssets and empty used families (null widget, honest empty report)', () => {
    const none = buildFontCarry(undefined, []);
    expect(none.widgetNode).toBeNull();
    expect(none.report).toEqual({
      carried: [],
      excluded: [],
      families_used: [],
      families_uncarried: [],
    });
  });

  it('P2-f: matches provider slug casing (bunny jetbrains-mono) against the quoted CSS stack', () => {
    // The WPOS v2 miss class: the used value is a quoted fallback stack, the link declares the
    // family as a lowercase hyphenated slug — matching must normalize BOTH sides.
    const bunny = 'https://fonts.bunny.net/css?family=jetbrains-mono:400,700';
    const { widgetNode, report } = buildFontCarry(
      assets({ links: [bunny], families: ['JetBrains Mono'] }),
      ['"JetBrains Mono", monospace'],
      { rand: seededRand() },
    );
    expect(widgetNode).not.toBeNull();
    expect(report.carried).toEqual([{ href: bunny, families: ['jetbrains-mono'] }]);
    expect(report.families_uncarried).toEqual([]);
  });

  it('18 §7: demotes a link to native_path when ALL its used families load natively', () => {
    const { widgetNode, report } = buildFontCarry(
      assets({ links: [GOOGLE_CSS2], families: ['Bricolage Grotesque', 'JetBrains Mono'] }),
      ['"Bricolage Grotesque", sans-serif', '"JetBrains Mono", monospace'],
      { rand: seededRand(), nativeFamilies: ['Bricolage Grotesque', 'JetBrains Mono'] },
    );
    expect(widgetNode).toBeNull();
    expect(report.carried).toEqual([]);
    expect(report.excluded).toEqual([
      {
        href: GOOGLE_CSS2,
        families: ['Bricolage Grotesque', 'JetBrains Mono'],
        reason: 'native_path',
      },
    ]);
    // Natively-served families are NOT uncarried — the native path covers them.
    expect(report.families_uncarried).toEqual([]);
  });

  it('18 §7: still carries a link that provides at least one used NON-native family', () => {
    const { widgetNode, report } = buildFontCarry(
      assets({ links: [GOOGLE_CSS2], families: ['Bricolage Grotesque', 'JetBrains Mono'] }),
      ['Bricolage Grotesque', 'JetBrains Mono'],
      { rand: seededRand(), nativeFamilies: ['Bricolage Grotesque'] },
    );
    expect(widgetNode).not.toBeNull();
    expect(report.carried.map((c) => c.href)).toEqual([GOOGLE_CSS2]);
    expect(report.excluded).toEqual([]);
  });

  it('18 §7: opaque links demote too, and native faces leave families_uncarried', () => {
    // Opaque self-hosted font CSS whose only used @font-face family is natively served → demoted.
    const demoted = buildFontCarry(
      assets({ links: ['./assets/fonts.css'], families: ['Inter'] }),
      ['Inter, sans-serif'],
      { nativeFamilies: ['Inter'] },
    );
    expect(demoted.widgetNode).toBeNull();
    expect(demoted.report.excluded).toEqual([
      { href: './assets/fonts.css', families: [], reason: 'native_path' },
    ]);
    expect(demoted.report.families_uncarried).toEqual([]);

    // A used @font-face family with NO link at all stays uncarried — unless it is native.
    const uncarried = buildFontCarry(assets({ families: ['LocalFace'] }), ['LocalFace'], {
      nativeFamilies: [],
    });
    expect(uncarried.report.families_uncarried).toEqual(['LocalFace']);
    const native = buildFontCarry(assets({ families: ['LocalFace'] }), ['LocalFace'], {
      nativeFamilies: ['LocalFace'],
    });
    expect(native.report.families_uncarried).toEqual([]);
  });
});
