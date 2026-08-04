/**
 * WP-H10 — accessibility LINT (`CoverageReport.a11y[]`).
 *
 * Walks the ASSEMBLED `ElementNode[]` (the WP-H08 authoring tree, with MINTED ids + typed-envelope
 * settings) and emits `A11yFinding`s for the three rules RESEARCH.md §6.5 mandates the converter owns:
 *
 *   1. HEADING HIERARCHY — there must be exactly one `e-heading` with `tag:h1`; heading levels must not
 *      skip (h2 → h4 is a `warning`). MULTIPLE h1s in one page conversion is a `blocker` (configurable).
 *      The atomic heading widget only enforces the h1-h6 ENUM (`atomic-heading.php`), NOT hierarchy, so
 *      hierarchy is OUR responsibility (WP-H10 §2).
 *   2. EMPTY INTERACTIVE NAME — an `e-button` (or a link container acting as a button) whose accessible
 *      name (its text, falling back to a non-empty `link` destination/aria-label) is empty → `warning`
 *      (or `blocker` per config). Icon-only links whose only content is an aria-hidden glyph have no
 *      accessible name (WP-H10 §2; corpus 04-cta-banner).
 *   3. MISSING ALT — an `e-image` whose sideloaded media carries no (non-empty) `alt` → `warning`.
 *
 * Findings are keyed by the node's MINTED `element_id` (the `id` on the `ElementNode`); the corpus suite
 * matches by rule+severity+LOCATOR, not by minted id (`14-fixtures-harness §7`).
 *
 * Pure + synchronous (acceptance: `lintA11y` is pure).
 */

import { isAtomicContainerNode, isAtomicWidgetNode } from '../authoring/contract.js';
import type { ElementNode, TypedValue } from '../authoring/contract.js';
import type { A11yFinding } from './types.js';

/* ─────────────────────────── lint config ─────────────────────────────────────────────────────── */

/** Per-run lint severity policy (the few rules whose severity the spec lets the caller escalate). */
export interface A11yLintConfig {
  /** Severity for >1 `e-heading` with `tag:h1` in a single page conversion. Default `'blocker'`. */
  multiple_h1_severity?: 'warning' | 'blocker';
  /** Severity for an interactive element with an empty accessible name. Default `'warning'`. */
  empty_interactive_severity?: 'warning' | 'blocker';
}

const DEFAULT_CONFIG: Required<A11yLintConfig> = {
  multiple_h1_severity: 'blocker',
  empty_interactive_severity: 'warning',
};

/* ─────────────────────────── typed-envelope text extraction ──────────────────────────────────── */

/** A loose typeguard for any typed-value envelope (`{$$type, value}`). */
function isEnvelope(v: unknown): v is TypedValue {
  return typeof v === 'object' && v !== null && '$$type' in (v as Record<string, unknown>);
}

/** Strip ALL markup from an html-v3 / raw text string, leaving only the visible text. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '') // drop tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, '') // drop other named entities (their visible glyph is non-text-ish)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the visible text of a `title`/`text`/`paragraph` setting. The value is an `html-v3` envelope
 * (`{content:{$$type:'string',value}|null, children:[]}`) for text props (ASSEMBLE wraps them so), or a
 * plain `string` envelope as a degenerate case. Returns `''` when there is no visible text.
 */
function envelopeText(setting: unknown): string {
  if (!isEnvelope(setting)) return '';
  if (setting.$$type === 'html-v3') {
    const inner = setting.value as { content?: TypedValue | null } | undefined;
    const content = inner?.content;
    if (isEnvelope(content) && typeof content.value === 'string') {
      return plainText(content.value);
    }
    return '';
  }
  if (setting.$$type === 'string' && typeof setting.value === 'string') {
    return plainText(setting.value);
  }
  return '';
}

/** Read a `tag` string-envelope setting (the heading level h1..h6, or a container tag). */
function tagOf(node: ElementNode): string | undefined {
  const settings = (node as { settings?: Record<string, unknown> }).settings;
  const tagSetting = settings?.['tag'];
  if (isEnvelope(tagSetting) && typeof tagSetting.value === 'string') {
    return tagSetting.value.toLowerCase();
  }
  return undefined;
}

/** Read the `alt` text from an `e-image` node's `image.value.src.value.alt` string-envelope. */
function imageAlt(node: ElementNode): string {
  const settings = (node as { settings?: Record<string, unknown> }).settings;
  const image = settings?.['image'];
  if (!isEnvelope(image)) return '';
  const imageVal = image.value as { src?: TypedValue } | undefined;
  const src = imageVal?.src;
  if (!isEnvelope(src)) return '';
  const srcVal = src.value as { alt?: TypedValue } | undefined;
  const alt = srcVal?.alt;
  if (isEnvelope(alt) && typeof alt.value === 'string') {
    return alt.value.trim();
  }
  return '';
}

/**
 * The accessible name of an interactive node (`e-button` / link container). Priority: visible button
 * `text`, then a non-empty `aria-label`/`label` setting, then a non-empty `link` `label`. An icon-only
 * link whose only child is an aria-hidden glyph yields `''` (no accessible name).
 */
function accessibleName(node: ElementNode): string {
  const settings = (node as { settings?: Record<string, unknown> }).settings ?? {};

  // Visible button/link text (the primary accessible name).
  const text = envelopeText(settings['text']);
  if (text !== '') return text;

  // An explicit aria-label / label setting, if the converter carried one.
  for (const key of ['aria-label', 'aria_label', 'label']) {
    const v = settings[key];
    if (isEnvelope(v) && typeof v.value === 'string' && plainText(v.value) !== '') {
      return plainText(v.value);
    }
  }

  // A link with an aria-label baked into its envelope value.
  const link = settings['link'];
  if (isEnvelope(link)) {
    const linkVal = link.value as { label?: TypedValue } | undefined;
    const label = linkVal?.label;
    if (isEnvelope(label) && typeof label.value === 'string' && plainText(label.value) !== '') {
      return plainText(label.value);
    }
  }

  return '';
}

/** True iff the node is an interactive element subject to the empty-name rule. */
function isInteractive(node: ElementNode): boolean {
  if (isAtomicWidgetNode(node) && node.widgetType === 'e-button') return true;
  // A link container: an `e-div-block`/`e-flexbox` carrying a `link` setting acts as an interactive
  // anchor (MAP wraps a block-level <a> as a link container — mapping-table `link` role).
  if (isAtomicContainerNode(node)) {
    const settings = (node as { settings?: Record<string, unknown> }).settings ?? {};
    if (isEnvelope(settings['link'])) return true;
  }
  return false;
}

/* ─────────────────────────── tree walk ───────────────────────────────────────────────────────── */

/** Depth-first walk of the assembled forest, document order. */
function walk(nodes: ElementNode[], visit: (node: ElementNode) => void): void {
  for (const node of nodes) {
    visit(node);
    const children = (node as { elements?: ElementNode[] }).elements;
    if (children && children.length > 0) {
      walk(children, visit);
    }
  }
}

/** Heading-level integer (1..6) for an `e-heading` node, defaulting to h2 when the tag is absent. */
function headingLevel(node: ElementNode): number {
  const tag = tagOf(node);
  if (tag !== undefined && /^h[1-6]$/.test(tag)) {
    return Number(tag.slice(1));
  }
  return 2; // atomic-heading defaults to h2 when unset (atomic-heading.php)
}

/* ─────────────────────────── lintA11y ────────────────────────────────────────────────────────── */

/**
 * Run the three a11y rules over an assembled tree and return the findings (`CoverageReport.a11y[]`).
 * Pure + synchronous. Findings are emitted in document order, grouped per rule pass for determinism.
 */
export function lintA11y(elements: ElementNode[], config?: A11yLintConfig): A11yFinding[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const findings: A11yFinding[] = [];

  // Collect headings in document order for the hierarchy pass.
  const headings: ElementNode[] = [];
  walk(elements, (node) => {
    if (isAtomicWidgetNode(node) && node.widgetType === 'e-heading') {
      headings.push(node);
    }
  });

  // ── Rule 1: heading hierarchy ──────────────────────────────────────────────────────────────
  const h1s = headings.filter((h) => headingLevel(h) === 1);
  if (h1s.length > 1) {
    // The FIRST h1 is canonical; every EXTRA h1 is flagged (multiple-h1).
    for (const extra of h1s.slice(1)) {
      findings.push({
        element_id: extra.id,
        rule: 'heading-hierarchy',
        severity: cfg.multiple_h1_severity,
        message: `Multiple <h1> headings in one page conversion (expected exactly one).`,
      });
    }
  }
  // Skipped-level detection: a heading whose level is more than one deeper than the previous heading.
  let prevLevel: number | null = null;
  for (const h of headings) {
    const level = headingLevel(h);
    if (prevLevel !== null && level > prevLevel + 1) {
      findings.push({
        element_id: h.id,
        rule: 'heading-hierarchy',
        severity: 'warning',
        message:
          `Heading level skipped: h${prevLevel} followed by h${level} ` +
          `(expected h${prevLevel + 1}).`,
      });
    }
    // Track the deepest level seen so far so a single deep heading after a return to a shallow level
    // (h2 → h4 → h3 → h5) still flags the h5 jump only when it skips relative to the prior heading.
    prevLevel = level;
  }

  // ── Rules 2 + 3: interactive names + image alt (single document-order pass) ──────────────────
  walk(elements, (node) => {
    // Rule 2: empty interactive name.
    if (isInteractive(node)) {
      if (accessibleName(node) === '') {
        findings.push({
          element_id: node.id,
          rule: 'empty-interactive-name',
          severity: cfg.empty_interactive_severity,
          message:
            'Interactive element has no accessible name ' +
            '(empty text and no aria-label; an icon-only glyph is not an accessible name).',
        });
      }
    }
    // Rule 3: missing image alt.
    if (isAtomicWidgetNode(node) && node.widgetType === 'e-image') {
      if (imageAlt(node) === '') {
        findings.push({
          element_id: node.id,
          rule: 'missing-alt',
          severity: 'warning',
          message: 'Image has no alt attribute; sideloaded media is missing alt text.',
        });
      }
    }
  });

  return findings;
}
