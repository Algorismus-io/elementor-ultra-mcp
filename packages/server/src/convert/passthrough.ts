/**
 * Contract 16 §5 — Tier 3 JS PASSTHROUGH (opt-in).
 *
 * Pure stage: `(pageScripts, include_js, capabilities) → { widgetNode | null, report }`. When the
 * caller opts in (`include_js:'bundle'`), every bundleable `<script>` from the PARSE census —
 * external `src` tags plus inline bodies — is bundled into ONE V3 classic `html` widget
 * (`{elType:'widget', widgetType:'html', settings:{html:'<string>'}}` — the `html` settings key is a
 * FLAT string, `plugins/elementor/includes/widgets/html.php` CODE control; classic settings carry NO
 * typed envelopes). Inline bodies are IIFE-wrapped and every emitted `<script>` tag carries the
 * `data-emcp-passthrough` marker so the bundle is identifiable/removable on the live page.
 *
 * Honesty invariants (contract 16 §0.2 / §8):
 *   - EVERY input script appears in the report exactly once — `bundled ∪ excluded` partitions the
 *     census; nothing is silently dropped.
 *   - `include_js:'none'` (the default) emits ZERO script bytes into the page (§8.3): the widget is
 *     `null`, `bundled_bytes` is 0, and the census is reported `excluded` with reason.
 *   - Analytics/tracking scripts are EXCLUDED by default (denylist) and reported as excluded (§5).
 *   - Bundling requires site `unfiltered_html` (§5); the elicitation confirm is the TOOL layer's
 *     responsibility — this stage only enforces the capability gate (decline → null + reported).
 *
 * The frozen `PageScript` census (`types.ts`, contract 16 §1) records inline BYTES only, never the
 * body — so this stage takes `PassthroughScript` (census + optional `content`). Use
 * {@link censusScriptsWithContent} to capture the bodies from the raw source html; an inline script
 * whose content was not captured is an honest exclusion, never a guess.
 *
 * The orchestrator appends the widget LAST and never auto-commits it (§0.4); this module performs
 * no I/O (acceptance: `buildJsPassthrough` is pure given a seeded `RandomSource`).
 */

import type { ClassicNode } from '../authoring/contract.js';
import { mintUniqueId, type RandomSource } from '../authoring/ids.js';
import type { DetectedBehavior, PageScript, SiteCapabilities } from './types.js';

/* ─────────────────────────── constants ───────────────────────────────────────────────────────── */

/** Marker attribute carried by every emitted `<script>` tag (contract 16 §5). */
export const PASSTHROUGH_MARKER = 'data-emcp-passthrough';

/**
 * Analytics/tracking denylist (contract 16 §5 — "gtag, gtm, fbq, hotjar…"). Probed against the
 * external `src` URL or the inline body; matches are EXCLUDED from the bundle and reported.
 */
export const ANALYTICS_DENYLIST =
  /gtag|googletagmanager|fbq|facebook|hotjar|clarity|mixpanel|segment|plausible|matomo|\/wp-includes\//i;

/** The Tier-3 opt-in switch (contract 16 §5; tool-surface default is `'none'`). */
export type IncludeJs = 'none' | 'bundle';

/* ─────────────────────────── input / report shapes ───────────────────────────────────────────── */

/**
 * A census entry PLUS the inline body. The frozen `PageScript` (contract 16 §1) records
 * `inline_bytes` only; bundling needs the bytes themselves, so the integrator captures them with
 * {@link censusScriptsWithContent} (absent `content` on an inline script = honest exclusion).
 */
export interface PassthroughScript extends PageScript {
  /** Raw inline `<script>` body (absent for external scripts and for bytes-only census entries). */
  content?: string;
}

/** Why a script was excluded from the bundle (stable tokens — report consumers match on these). */
export type PassthroughExclusionReason =
  | 'include_js_none' // §8.3 — bundling not requested (the default)
  | 'unfiltered_html_missing' // §5 capability gate refused
  | 'analytics_denylist' // §5 tracking denylist match
  | 'inline_content_unavailable' // inline body not captured (bytes-only census entry)
  | 'empty_inline' // inline script with a blank body — nothing to bundle
  | 'relative_src_unresolvable'; // relative src with no base_url to resolve against

/** One census script as it appears in the report (`PageScript` fields, no body). */
export interface PassthroughScriptEntry {
  src: string | null;
  inline_bytes: number;
  external: boolean;
}

/** An excluded census script + the reason it was kept out of the bundle (never silent, §0.2). */
export interface PassthroughExcludedEntry extends PassthroughScriptEntry {
  reason: PassthroughExclusionReason;
}

/** The Tier-3 section of the behavior report (`bundled ∪ excluded` partitions the input census). */
export interface PassthroughReport {
  /** The effective mode (`include_js` after defaulting). */
  mode: IncludeJs;
  bundled: PassthroughScriptEntry[];
  excluded: PassthroughExcludedEntry[];
  /** Byte length of the emitted `settings.html` payload — 0 whenever `widgetNode` is null (§8.3). */
  bundled_bytes: number;
  /** Set when `'bundle'` was requested but the site capability gate refused (§5). */
  blocked_reason?: 'unfiltered_html_missing';
  /**
   * §5: scripts are opaque, so a script whose only detected effect was already converted at tier 1/2
   * is still bundled verbatim — this flag marks the result for human double-handling review.
   */
  double_handling_review?: boolean;
}

/** Stage output: the single classic `html` widget (or null) + the honest report. */
export interface PassthroughResult {
  widgetNode: ClassicNode | null;
  report: PassthroughReport;
}

/** Optional knobs (all pure — a seeded `rand` makes the minted widget id deterministic). */
export interface PassthroughOptions {
  /** Source-page base URL; relative external `src` values are resolved against it (else excluded). */
  base_url?: string;
  /** Tiered behaviors from MAP/interactions — any tier-1/2 entry sets `double_handling_review`. */
  behaviors?: DetectedBehavior[];
  /** Random source for the widget-id mint (tests pass a seeded source). */
  rand?: RandomSource;
  /** Live/in-tree element ids the minted widget id must not collide with (WP-F03 dedupe). */
  usedIds?: Set<string>;
}

/* ─────────────────────────── content-capturing census ────────────────────────────────────────── */

/**
 * Script census WITH inline bodies. Same scan as `parse.censusScripts` (contract 16 §2 — raw SOURCE
 * html, never the live DOM) but keeps the inline `content` Tier 3 needs to bundle. MUST stay in
 * lockstep with `parse.ts:censusScripts` (parity is unit-tested) — the frozen `PageScript` fields of
 * each entry are byte-identical to the census; `content` is the additive carrier.
 */
export function censusScriptsWithContent(html: string): PassthroughScript[] {
  const out: PassthroughScript[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  const srcRe = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    // Non-executable script types (JSON-LD, speculation rules, templates) are DATA — bundling
    // them as JS throws `Unexpected token ':'` on the built page (field-found, 2026-07-03).
    const typeM = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const scriptType = (typeM ? (typeM[1] ?? typeM[2] ?? '') : '').trim().toLowerCase();
    if (scriptType !== '' && scriptType !== 'text/javascript' && scriptType !== 'module') {
      continue;
    }
    const srcMatch = srcRe.exec(attrs);
    const src = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? null) : null;
    const external = src !== null;
    const entry: PassthroughScript = {
      src,
      inline_bytes: external ? 0 : new TextEncoder().encode(body).length,
      external,
    };
    if (!external) {
      entry.content = body;
    }
    out.push(entry);
  }
  return out;
}

/* ─────────────────────────── bundle assembly helpers ─────────────────────────────────────────── */

/** Report-entry projection of a script (drops the body — the report never carries script bytes). */
function toEntry(script: PassthroughScript): PassthroughScriptEntry {
  return { src: script.src, inline_bytes: script.inline_bytes, external: script.external };
}

/** Exclude the WHOLE census with one reason (the `'none'` default and the capability-gate refusal). */
function excludeAll(
  scripts: PassthroughScript[],
  reason: PassthroughExclusionReason,
): PassthroughExcludedEntry[] {
  return scripts.map((s) => ({ ...toEntry(s), reason }));
}

/**
 * Resolve an external `src` for re-emission. Absolute (`https?://`) and protocol-relative (`//`)
 * URLs pass verbatim (scripts are opaque, §5); a relative src is resolved against `base_url` when
 * provided, else `null` (it would point at the WP site, not the source site — honest exclusion).
 */
function resolveSrc(src: string, baseUrl?: string): string | null {
  if (src === '') return null;
  if (/^(?:https?:)?\/\//i.test(src)) return src;
  if (baseUrl !== undefined) {
    try {
      return new URL(src, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Minimal attribute escape for the re-emitted `src`. The census captured RAW attribute text (already
 * entity-encoded where the source was), so only `"` — impossible inside the double-quoted attribute
 * we emit — is escaped; everything else passes verbatim to avoid double-encoding `&amp;` etc.
 */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

/* ─────────────────────────── buildJsPassthrough ──────────────────────────────────────────────── */

/**
 * Build the Tier-3 passthrough widget (contract 16 §5). Pure; returns the ONE classic `html` widget
 * bundling every bundleable script — external tags re-emitted, inline bodies IIFE-wrapped, all
 * marked `data-emcp-passthrough` — or `null` (mode `'none'`, capability-gate refusal, or nothing
 * bundleable). The report always partitions the full census (§0.2). `include_js` defaults to
 * `'none'` (§5 — passing `undefined` is the tool-surface default).
 */
export function buildJsPassthrough(
  pageScripts: PassthroughScript[] | undefined,
  includeJs: IncludeJs | undefined,
  capabilities: Pick<SiteCapabilities, 'unfiltered_html'>,
  options: PassthroughOptions = {},
): PassthroughResult {
  const mode: IncludeJs = includeJs ?? 'none';
  const scripts = pageScripts ?? [];

  // §8.3 — the default emits ZERO script bytes; the census is still reported (never silent).
  if (mode === 'none') {
    return {
      widgetNode: null,
      report: {
        mode,
        bundled: [],
        excluded: excludeAll(scripts, 'include_js_none'),
        bundled_bytes: 0,
      },
    };
  }

  // §5 capability gate — bundling requires site `unfiltered_html` (WP strips <script> otherwise).
  if (!capabilities.unfiltered_html) {
    return {
      widgetNode: null,
      report: {
        mode,
        bundled: [],
        excluded: excludeAll(scripts, 'unfiltered_html_missing'),
        bundled_bytes: 0,
        blocked_reason: 'unfiltered_html_missing',
      },
    };
  }

  const bundled: PassthroughScriptEntry[] = [];
  const excluded: PassthroughExcludedEntry[] = [];
  const tags: string[] = [];

  for (const script of scripts) {
    // §5 denylist — probed against the src URL (external) or the inline body.
    const probe = script.external ? (script.src ?? '') : (script.content ?? '');
    if (ANALYTICS_DENYLIST.test(probe)) {
      excluded.push({ ...toEntry(script), reason: 'analytics_denylist' });
      continue;
    }
    if (script.external) {
      const resolved = resolveSrc(script.src ?? '', options.base_url);
      if (resolved === null) {
        excluded.push({ ...toEntry(script), reason: 'relative_src_unresolvable' });
        continue;
      }
      tags.push(`<script ${PASSTHROUGH_MARKER} src="${escapeAttr(resolved)}"></script>`);
      bundled.push(toEntry(script));
      continue;
    }
    // Inline: bundle the captured body IIFE-wrapped (one IIFE per source script so a runtime error
    // in one body cannot leak bindings into — though it may still halt — the rest of its tag).
    if (script.content === undefined) {
      excluded.push({ ...toEntry(script), reason: 'inline_content_unavailable' });
      continue;
    }
    if (script.content.trim() === '') {
      excluded.push({ ...toEntry(script), reason: 'empty_inline' });
      continue;
    }
    tags.push(
      `<script ${PASSTHROUGH_MARKER}>\n(function () {\n${script.content}\n})();\n</script>`,
    );
    bundled.push(toEntry(script));
  }

  if (bundled.length === 0) {
    return { widgetNode: null, report: { mode, bundled, excluded, bundled_bytes: 0 } };
  }

  const html = tags.join('\n');
  const widgetNode: ClassicNode = {
    id: mintUniqueId(options.usedIds ?? new Set(), options.rand ?? Math.random),
    elType: 'widget',
    widgetType: 'html',
    settings: { html },
  };
  const report: PassthroughReport = {
    mode,
    bundled,
    excluded,
    bundled_bytes: new TextEncoder().encode(html).length,
  };
  // §5 — scripts are opaque: anything converted at tier 1/2 may ALSO live in a bundled script.
  if ((options.behaviors ?? []).some((b) => b.tier === 1 || b.tier === 2)) {
    report.double_handling_review = true;
  }
  return { widgetNode, report };
}
