/**
 * WP-H14b — first-party inline-CSS carry (the styles sibling of the contract-16 §5 JS passthrough).
 *
 * A live page's inline `<style>` blocks often hold behavior CSS the converter cannot express as
 * local styles: infinite `@keyframes` (marquees/tickers), the `animation:` bindings that attach
 * them, and rules styling SCRIPT-CREATED UI (`#sx-theme-toggle`) that only exists once the bundled
 * JS runs. Dropping them is why a converted clone renders static where the source moves.
 *
 * Deliberately NOT a wholesale stylesheet carry — re-emitting the source CSS would double-apply
 * against the converted local styles and fight the layout. The carry keeps exactly three rule
 * families, chosen to be additive-only:
 *   1. `@keyframes` / `@-webkit-keyframes` blocks (define animations; apply nothing by themselves);
 *   2. rules whose declarations bind an animation (`animation` / `animation-name`) — with
 *      `preserve_source_classes` on, their selectors re-match the converted elements;
 *   3. rules whose EVERY selector targets an id (`#…`) — converted elements never render source
 *      ids, so these are inert unless the carried JS creates the element (toggle, burger, drawer).
 * `@media` wrappers are preserved around matching inner rules. Everything else is excluded and
 * counted (never silent). Pure module — no I/O; the census scans the raw source html.
 */

import type { ClassicNode } from '../authoring/contract.js';
import { mintUniqueId } from '../authoring/ids.js';

import type { SiteCapabilities } from './types.js';

/* ─────────────────────────── census ──────────────────────────────────────────────────────────── */

/** One inline `<style>` block captured from the raw source html. */
export interface InlineStyleBlock {
  content: string;
  bytes: number;
}

/** Capture every inline `<style>` body from the raw source html (first-party by construction). */
export function censusInlineStyles(html: string): InlineStyleBlock[] {
  const out: InlineStyleBlock[] = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = styleRe.exec(html)) !== null) {
    const body = m[1] ?? '';
    if (body.trim() === '') {
      continue;
    }
    out.push({ content: body, bytes: new TextEncoder().encode(body).length });
  }
  return out;
}

/* ─────────────────────────── rule-level filter ───────────────────────────────────────────────── */

export type IncludeCss = 'none' | 'inline';

/** The carried/excluded partition counts (the report never carries CSS bytes, only counts). */
export interface CssCarryReport {
  mode: IncludeCss;
  carried: {
    keyframes: number;
    animation_bindings: number;
    id_rules: number;
    bytes: number;
  };
  excluded_rules: number;
  source_blocks: number;
  blocked_reason?: 'unfiltered_html_missing';
}

export interface CssCarryResult {
  widgetNode: ClassicNode | null;
  report: CssCarryReport;
}

/** A top-level CSS construct: `prelude { body }` (body may itself contain nested rules). */
interface CssConstruct {
  prelude: string;
  body: string;
}

/** Split a stylesheet into top-level constructs by brace matching (comments stripped first). */
function splitConstructs(css: string): CssConstruct[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: CssConstruct[] = [];
  let i = 0;
  let preludeStart = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = src.slice(preludeStart, i).trim();
      let depth = 1;
      const bodyStart = i + 1;
      i += 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') depth -= 1;
        i += 1;
      }
      const body = src.slice(bodyStart, i - 1);
      if (prelude !== '') {
        out.push({ prelude, body });
      }
      preludeStart = i;
    } else if (ch === ';') {
      // at-statement without a block (@import/@charset) — never carried
      preludeStart = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

const KEYFRAMES_PRELUDE = /^@(-webkit-)?keyframes\b/i;
const MEDIA_PRELUDE = /^@media\b/i;
const ANIMATION_DECL = /(^|[\s;{])(-webkit-)?animation(-name)?\s*:/i;

/** True iff EVERY comma-separated selector in the group starts with an id (`#…`). */
function idOnlySelectors(prelude: string): boolean {
  const parts = prelude
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return parts.length > 0 && parts.every((s) => s.startsWith('#'));
}

interface FilterCounts {
  keyframes: number;
  animation_bindings: number;
  id_rules: number;
  excluded: number;
}

/** Filter one construct list to the three carried families; returns the kept CSS text. */
function filterConstructs(constructs: CssConstruct[], counts: FilterCounts): string {
  const kept: string[] = [];
  for (const c of constructs) {
    if (KEYFRAMES_PRELUDE.test(c.prelude)) {
      counts.keyframes += 1;
      kept.push(`${c.prelude}{${c.body}}`);
      continue;
    }
    if (MEDIA_PRELUDE.test(c.prelude)) {
      const inner = filterConstructs(splitConstructs(c.body), counts);
      if (inner !== '') {
        kept.push(`${c.prelude}{${inner}}`);
      }
      continue;
    }
    if (c.prelude.startsWith('@')) {
      counts.excluded += 1; // @font-face / @supports / … — the font carry owns fonts
      continue;
    }
    if (ANIMATION_DECL.test(c.body)) {
      counts.animation_bindings += 1;
      kept.push(`${c.prelude}{${c.body}}`);
      continue;
    }
    if (idOnlySelectors(c.prelude)) {
      counts.id_rules += 1;
      kept.push(`${c.prelude}{${c.body}}`);
      continue;
    }
    counts.excluded += 1;
  }
  return kept.join('\n');
}

/* ─────────────────────────── buildCssCarry ───────────────────────────────────────────────────── */

/** Marker attribute so a carried block is greppable on the built page. */
const CARRY_MARKER = 'data-emcp-css-carry="1"';

/**
 * Build the ONE classic `html` widget carrying the filtered first-party inline CSS. Mirrors
 * `buildJsPassthrough`: `mode:'none'` emits nothing (census still reported); missing
 * `unfiltered_html` blocks the carry (kses strips `<style>` on save otherwise); an empty
 * post-filter result emits no widget. Pure given a seeded `rand`.
 */
export function buildCssCarry(
  blocks: InlineStyleBlock[] | undefined,
  includeCss: IncludeCss | undefined,
  capabilities: Pick<SiteCapabilities, 'unfiltered_html'>,
  options: { usedIds?: Set<string>; rand?: () => number } = {},
): CssCarryResult {
  const mode: IncludeCss = includeCss ?? 'none';
  const census = blocks ?? [];
  const emptyCarried = { keyframes: 0, animation_bindings: 0, id_rules: 0, bytes: 0 };
  if (mode === 'none' || census.length === 0) {
    return {
      widgetNode: null,
      report: { mode, carried: emptyCarried, excluded_rules: 0, source_blocks: census.length },
    };
  }
  if (!capabilities.unfiltered_html) {
    return {
      widgetNode: null,
      report: {
        mode,
        carried: emptyCarried,
        excluded_rules: 0,
        source_blocks: census.length,
        blocked_reason: 'unfiltered_html_missing',
      },
    };
  }
  const counts: FilterCounts = { keyframes: 0, animation_bindings: 0, id_rules: 0, excluded: 0 };
  const carriedCss = census
    .map((b) => filterConstructs(splitConstructs(b.content), counts))
    .filter((s) => s !== '')
    .join('\n');
  if (carriedCss === '') {
    return {
      widgetNode: null,
      report: {
        mode,
        carried: emptyCarried,
        excluded_rules: counts.excluded,
        source_blocks: census.length,
      },
    };
  }
  const html = `<style ${CARRY_MARKER}>\n${carriedCss}\n</style>`;
  const widgetNode: ClassicNode = {
    id: mintUniqueId(options.usedIds ?? new Set(), options.rand ?? Math.random),
    elType: 'widget',
    widgetType: 'html',
    settings: { html },
  };
  return {
    widgetNode,
    report: {
      mode,
      carried: {
        keyframes: counts.keyframes,
        animation_bindings: counts.animation_bindings,
        id_rules: counts.id_rules,
        bytes: new TextEncoder().encode(html).length,
      },
      excluded_rules: counts.excluded,
      source_blocks: census.length,
    },
  };
}
