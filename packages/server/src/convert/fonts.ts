/**
 * Contract 17 §5 #9 — WEBFONT CARRY (the 2026-06-11 odiff baseline's largest static-pixel loss:
 * ghost-text in every band because the converted page never loaded the source's webfonts).
 *
 * Pure stage: `(fontAssets, usedFamilies) → { widgetNode | null, report }`. PARSE captures the
 * source page's font assets (`ParseResult.fontAssets` — stylesheet `<link>`s that look like font
 * CSS plus the `@font-face` families visible via CSSOM/FontFaceSet); this module decides which of
 * those links the converted page actually NEEDS (a link is carried only when a family it provides
 * is used by the converted styles) and emits them as ONE V3 classic `html` widget
 * (`{elType:'widget', widgetType:'html', settings:{html:'<string>'}}` — the `html` settings key is
 * a FLAT string, same shape as `passthrough.ts`; classic settings carry NO typed envelopes). Every
 * emitted `<link>` tag carries the `data-emcp-fonts` marker so the carry is identifiable/removable
 * on the live page.
 *
 * Honesty invariants (contract 17 §0 — no silent anything):
 *   - EVERY captured font link appears in the report exactly once — `carried ∪ excluded` partitions
 *     `fontAssets.links`.
 *   - `families_uncarried` lists used families the page declared a `@font-face` for that NO carried
 *     link provides (e.g. an inline `<style>` `@font-face` — there is no `<link>` to carry), so V1's
 *     render diff can attribute the divergence `font_not_carried` instead of guessing.
 *
 * The INTEGRATOR (pipeline, not this module) gates the carry behind the `carry_fonts` option
 * (default ON) and appends the widget FIRST so fonts start loading before the content renders.
 * This module performs no I/O (pure given a seeded `RandomSource`) and never auto-commits anything.
 *
 * Contract 18 §7 — "Font system strategy" (supersedes carry-link-only) + P2-f:
 *   - Family matching NORMALIZES quoted / fallback-list / slug-cased family strings (the WPOS v2
 *     "JetBrains Mono missed" class): comparison happens on {@link matchKey} (unquoted, escape- and
 *     NBSP-tolerant, hyphen/underscore ≡ space so Bunny's `family=jetbrains-mono` slug matches the
 *     CSS name `"JetBrains Mono"`), never on raw strings.
 *   - The carry link DEMOTES to a fallback for NON-catalog faces only: when the integrator passes
 *     `options.nativeFamilies` (families Elementor's native atomic font pipeline auto-enqueues —
 *     root-caused + fixed PHP-side in `Css_Primer`/`Fonts_Service`, which normalize the collected
 *     `elementor_atomic_styles_fonts-*` option values to bare catalog names), a captured link whose
 *     used families are ALL natively served is excluded with reason `native_path` instead of being
 *     re-emitted. Absent `nativeFamilies` the behavior is unchanged (everything used is carried).
 */

import type { ClassicNode } from '../authoring/contract.js';
import { mintUniqueId, type RandomSource } from '../authoring/ids.js';

/* ─────────────────────────── constants ───────────────────────────────────────────────────────── */

/** Marker attribute carried by every emitted `<link>` tag (mirrors `passthrough.ts`'s marker). */
export const FONT_CARRY_MARKER = 'data-emcp-fonts';

/** Known webfont-CSS providers — a stylesheet `<link>` to any of these is a font stylesheet. */
const FONT_PROVIDER_RE =
  /fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit\.net|fast\.fonts\.net|cloud\.typography\.com|cdnfonts\.com|fontawesome/i;

/**
 * Generic "this stylesheet is font CSS" path heuristic for self-hosted font CSS: a `fonts`/`font`/
 * `webfonts` path token (`fonts.css`, `/fonts/faces.css`, `my-webfonts.css`). Deliberately narrow —
 * a false negative only means the link is not carried (reported via `families_uncarried`), while a
 * false positive would ship a whole foreign stylesheet onto the page.
 */
const FONT_PATH_RE = /(?:^|[/._-])(?:web)?fonts?(?:[/._-][^"'\s)]*)?\.css(?:[?#]|$)/i;

/**
 * CSS generic family keywords — never webfonts, dropped when normalizing used-family stacks
 * (`font-family: "Bricolage Grotesque", sans-serif` uses ONE webfont, not two families).
 */
const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
  'inherit',
  'initial',
  'unset',
  'revert',
  // UA-only system-stack tokens (never webfonts; common fillers in computed stacks like
  // `Public Sans,-apple-system,BlinkMacSystemFont,…` — P2-f field data). Real font names
  // (`Segoe UI`, `Helvetica Neue`) are deliberately NOT listed: they could be self-hosted faces.
  '-apple-system',
  'blinkmacsystemfont',
]);

/* ─────────────────────────── shapes ──────────────────────────────────────────────────────────── */

/** PARSE's font capture (contract 17 #9): font stylesheet links + `@font-face` families (CSSOM). */
export interface FontAssets {
  /** Hrefs of `<link rel=stylesheet>`/`@import` targets that look like font CSS, document order. */
  links: string[];
  /** Distinct `@font-face` family names visible via CSSOM/FontFaceSet (sorted, unquoted). */
  families: string[];
}

/** One font link as it appears in the report (`families` = names attributed from the URL, may be empty). */
export interface FontLinkEntry {
  href: string;
  /** Families the link declares in its URL (Google/Bunny `family=` params); `[]` = opaque font CSS. */
  families: string[];
}

/**
 * Why a captured font link was kept out of the carry (stable tokens — report consumers match on
 * them). `no_used_family` = nothing the link provides is used by the converted styles;
 * `native_path` = everything it provides that IS used loads via Elementor's native atomic font
 * pipeline (contract 18 §7 demotion — the carry is fallback for non-catalog faces only).
 */
export type FontLinkExclusionReason = 'no_used_family' | 'native_path';

/** An excluded font link + the reason (never silent — contract 17 §0). */
export interface FontLinkExcludedEntry extends FontLinkEntry {
  reason: FontLinkExclusionReason;
}

/** The font-carry section of the conversion report (`carried ∪ excluded` partitions the capture). */
export interface FontCarryReport {
  carried: FontLinkEntry[];
  excluded: FontLinkExcludedEntry[];
  /** The normalized webfont families the converted styles actually use (generics dropped, deduped). */
  families_used: string[];
  /** Used families with a captured `@font-face` that NO carried link provides (V1 `font_not_carried`). */
  families_uncarried: string[];
}

/** Optional knobs (all pure — a seeded `rand` makes the minted widget id deterministic). */
export interface FontCarryOptions {
  /** Random source for the widget-id mint (tests pass a seeded source). */
  rand?: RandomSource;
  /** Live/in-tree element ids the minted widget id must not collide with (WP-F03 dedupe). */
  usedIds?: Set<string>;
  /**
   * Families the live site's NATIVE atomic font pipeline auto-enqueues (contract 18 §7: the
   * Google-catalog ∪ Pro-Custom-Fonts/`fonts.install` faces, probed by the integrator). When
   * provided, a link is carried only for used families OUTSIDE this set; a used-but-native-only
   * link is excluded with reason `native_path` and its families never count as `families_uncarried`
   * (the native path serves them). Undefined → no demotion (carry-everything-used, 17 #9 behavior).
   */
  nativeFamilies?: Iterable<string>;
}

/** Stage output: the single classic `html` widget carrying the `<link>` tags (or null) + the report. */
export interface FontCarryResult {
  widgetNode: ClassicNode | null;
  report: FontCarryReport;
}

/* ─────────────────────────── family normalization ────────────────────────────────────────────── */

/**
 * Clean ONE family-name fragment for display: strip backslash escapes (`\"JetBrains Mono\"` —
 * JSON/inline-CSS leak-through), surrounding quotes (straight + typographic), and collapse all
 * whitespace (incl. NBSP) to single spaces. P2-f: every comparison/normalization shares this.
 */
function cleanFamilyName(name: string): string {
  return name
    .replace(/\\(["'])/g, '$1')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .replace(/^["'‘’“”]+|["'‘’“”]+$/g, '')
    .trim();
}

/** Canonical comparison key for a family name (unquoted, whitespace-collapsed, lowercased). */
function familyKey(name: string): string {
  return cleanFamilyName(name).toLowerCase();
}

/**
 * SLUG-TOLERANT comparison key (P2-f): {@link familyKey} with hyphens/underscores ≡ spaces, so a
 * provider slug (`Bunny's family=jetbrains-mono`) matches the CSS name (`"JetBrains Mono"`). Used
 * for ALL link↔used↔face matching; display strings keep their original casing/spelling.
 */
function matchKey(name: string): string {
  return familyKey(name).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize raw used-family inputs into distinct webfont family names: each input may be a whole
 * `font-family` STACK (`'"Bricolage Grotesque", sans-serif'`) — split on commas, strip quotes
 * (escaped/typographic included), collapse whitespace (incl. NBSP), drop CSS generic keywords and
 * UA-only stack tokens, dedupe case-insensitively (first casing wins). Pure; exported so the
 * integrator can feed `font-family` declarations straight from styled nodes.
 */
export function normalizeUsedFamilies(values: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    for (const part of String(value).split(',')) {
      const cleaned = cleanFamilyName(part);
      if (cleaned.length === 0) continue;
      const key = cleaned.toLowerCase();
      if (GENERIC_FONT_FAMILIES.has(key)) continue;
      if (!seen.has(key)) seen.set(key, cleaned);
    }
  }
  return [...seen.values()];
}

/* ─────────────────────────── link census (raw source scan — pure) ────────────────────────────── */

/** True when a stylesheet href looks like font CSS (provider match or font-ish path token). */
export function isFontStylesheetHref(href: string): boolean {
  return FONT_PROVIDER_RE.test(href) || FONT_PATH_RE.test(href);
}

/**
 * Census of font stylesheet references in the RAW source (contract 17 #9): every
 * `<link rel="stylesheet" href=…>` in the html plus every `@import` in the author CSS (and inline
 * `<style>` blocks) whose target {@link isFontStylesheetHref}. Scans the raw input — what the
 * AUTHOR shipped is what the carry re-emits — never the live DOM. Pure (regex, no parser); called
 * by PARSE to populate `ParseResult.fontAssets.links`. Deduped, document order.
 */
export function censusFontLinks(html: string, css?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (href: string): void => {
    const trimmed = href.trim();
    if (trimmed.length === 0 || seen.has(trimmed) || !isFontStylesheetHref(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  // <link rel="stylesheet" href="…"> (attribute order-independent).
  const linkRe = /<link\b([^>]*)>/gi;
  const relRe = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  const hrefRe = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const rel = relRe.exec(attrs);
    const relValue = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? '').toLowerCase();
    if (!/\bstylesheet\b/.test(relValue)) continue;
    const href = hrefRe.exec(attrs);
    const hrefValue = href?.[1] ?? href?.[2] ?? href?.[3];
    if (hrefValue !== undefined) push(hrefValue);
  }

  // @import url(…) / @import "…" — in the author css plus inline <style> blocks of the html.
  const importSources: string[] = [];
  if (css !== undefined && css.length > 0) importSources.push(css);
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  while ((m = styleRe.exec(html)) !== null) {
    importSources.push(m[1] ?? '');
  }
  const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;
  for (const source of importSources) {
    while ((m = importRe.exec(source)) !== null) {
      const target = m[2] ?? m[4];
      if (target !== undefined) push(target);
    }
  }
  return out;
}

/* ─────────────────────────── URL → family attribution ────────────────────────────────────────── */

/**
 * Extract the family names a font-CSS URL declares (Google Fonts css/css2 + Bunny `family=` params:
 * `family=Name:wght@…`, repeated params, legacy `Name1|Name2`). Opaque font CSS (Typekit kits,
 * self-hosted `fonts.css`) declares nothing in the URL → `[]`. Pure.
 */
export function extractFamiliesFromFontUrl(href: string): string[] {
  let url: URL;
  try {
    url = new URL(href, 'https://base.invalid/');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of url.searchParams.getAll('family')) {
    for (const part of raw.split('|')) {
      const name = (part.split(':')[0] ?? '').replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
      if (name.length === 0) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(name);
      }
    }
  }
  return out;
}

/* ─────────────────────────── widget assembly ─────────────────────────────────────────────────── */

/**
 * Minimal attribute escape for the re-emitted `href`. The census captured RAW attribute text
 * (already entity-encoded where the source was), so only `"` — impossible inside the double-quoted
 * attribute we emit — is escaped; everything else passes verbatim to avoid double-encoding `&amp;`
 * (mirrors `passthrough.ts`).
 */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

/* ─────────────────────────── buildFontCarry ──────────────────────────────────────────────────── */

/**
 * Build the font-carry widget (contract 17 #9 + 18 §7). Pure; returns ONE classic `html` widget
 * re-emitting the captured font `<link>`s — only those providing a family the converted styles
 * actually use — or `null` when nothing qualifies. A link whose URL declares its families
 * (Google/Bunny) is carried iff one of them is used; an OPAQUE font-CSS link (Typekit, self-hosted)
 * is carried iff any captured `@font-face` family is used (the URL proves nothing, the page's
 * declared faces are the best evidence). All matching is {@link matchKey}-normalized (P2-f:
 * quoted/fallback-list/slug strings). With `options.nativeFamilies` the carry DEMOTES to fallback
 * for non-catalog faces only (18 §7): a used-but-natively-served-only link is excluded with reason
 * `native_path`. The report always partitions the full link capture and lists used-but-uncarried
 * `@font-face` families so the verify loop can attribute `font_not_carried` divergences.
 *
 * @param fontAssets   PARSE's `ParseResult.fontAssets` capture (`undefined` tolerated → empty).
 * @param usedFamilies raw `font-family` values used by the converted styles (stacks accepted).
 */
export function buildFontCarry(
  fontAssets: FontAssets | undefined,
  usedFamilies: Iterable<string>,
  options: FontCarryOptions = {},
): FontCarryResult {
  const assets = fontAssets ?? { links: [], families: [] };
  const used = normalizeUsedFamilies(usedFamilies);
  const usedKeys = new Set(used.map(matchKey));
  // Used families NOT served by the native atomic font pipeline — the set the carry must cover.
  // Without `nativeFamilies` every used family needs the carry (17 #9 behavior, no demotion).
  const nativeKeys = new Set([...(options.nativeFamilies ?? [])].map(matchKey));
  const neededKeys = new Set([...usedKeys].filter((k) => !nativeKeys.has(k)));
  const faceKeys = new Set(assets.families.map(matchKey));
  const anyFaceUsed = assets.families.some((f) => usedKeys.has(matchKey(f)));
  const anyFaceNeeded = assets.families.some((f) => neededKeys.has(matchKey(f)));

  const carried: FontLinkEntry[] = [];
  const excluded: FontLinkExcludedEntry[] = [];
  for (const href of assets.links) {
    const families = extractFamiliesFromFontUrl(href);
    const providesUsed =
      families.length > 0 ? families.some((f) => usedKeys.has(matchKey(f))) : anyFaceUsed;
    const providesNeeded =
      families.length > 0 ? families.some((f) => neededKeys.has(matchKey(f))) : anyFaceNeeded;
    if (providesNeeded) {
      carried.push({ href, families });
    } else if (providesUsed) {
      // Everything this link provides that the page uses loads via the NATIVE pipeline (18 §7).
      excluded.push({ href, families, reason: 'native_path' });
    } else {
      excluded.push({ href, families, reason: 'no_used_family' });
    }
  }

  // Used families the page declared a @font-face for that no carried link provides — excluding
  // natively-served families (the native path covers them; 18 §7). When an OPAQUE link is carried
  // its families are unattributable — treat them as covered rather than guess.
  const coveredKeys = new Set<string>();
  let opaqueCarried = false;
  for (const entry of carried) {
    if (entry.families.length === 0) opaqueCarried = true;
    for (const f of entry.families) coveredKeys.add(matchKey(f));
  }
  const familiesUncarried = opaqueCarried
    ? []
    : used.filter(
        (f) =>
          !nativeKeys.has(matchKey(f)) &&
          faceKeys.has(matchKey(f)) &&
          !coveredKeys.has(matchKey(f)),
      );

  const report: FontCarryReport = {
    carried,
    excluded,
    families_used: used,
    families_uncarried: familiesUncarried,
  };
  if (carried.length === 0) {
    return { widgetNode: null, report };
  }

  const html = carried
    .map((entry) => `<link rel="stylesheet" ${FONT_CARRY_MARKER} href="${escapeAttr(entry.href)}">`)
    .join('\n');
  const widgetNode: ClassicNode = {
    id: mintUniqueId(options.usedIds ?? new Set(), options.rand ?? Math.random),
    elType: 'widget',
    widgetType: 'html',
    settings: { html },
  };
  return { widgetNode, report };
}
