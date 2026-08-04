/**
 * WP-Q04 — HTML→native corpus regression RUNNER (`14-fixtures-harness.md §6`).
 *
 * This is the regression assertion over the HTML→native conversion vertical's output. For each
 * marketing section under WP-H12's `packages/shared/fixtures/html/sections/<n>/` it:
 *
 *   1. runs `convert.html_to_tree` (Contract 13 §1.9) on `input.html` (+ `input.css`),
 *   2. asserts `report.coverage` is within the per-section tolerance band of `expected.coverage.json`
 *      (the S3-anchored numbers — NEVER a hardcoded 85%; thresholds + tolerance come from WP-H12's
 *      `corpus.manifest.json`, RESEARCH.md §6.8, SUPPLEMENT §C.4),
 *   3. asserts `report.a11y` matches `expected.a11y.json` (heading hierarchy / empty interactive name /
 *      missing alt — RESEARCH.md §6.5; matched by rule+severity+locator, NOT minted element_id — §7),
 *   4. asserts `report.stripped_text` lists the expected stripped block tags (the html-v3 inline-only
 *      allowlist `[b,i,em,u,a,del,span,strong,sup,sub,s]` — everything else is stripped; RESEARCH.md
 *      §6.6, SUPPLEMENT §B.1),
 *   5. round-trips the produced `elements` through PHP `dry_run` (§3) and asserts `valid:true` — the
 *      hard gate: the converter must NEVER emit a tree PHP rejects (§6 step 5).
 *
 * OWNERSHIP (`14-fixtures-harness.md §11`): Q04 owns ONLY this runner. The corpus sections, their
 * `expected.coverage.json`/`expected.a11y.json`, and `corpus.manifest.json` are OWNED by WP-H12 — this
 * runner CONSUMES them, never edits them. Lowering a threshold is a WP-H12 manifest edit surfaced as a
 * PR diff (§6 last paragraph); a coverage regression below tolerance fails THIS test.
 *
 * GATING (Wave-2 skeleton): the orchestrator `convert.html_to_tree` is WP-H11 (the HTML pipeline
 * vertical). Until it ships this suite FEATURE-DETECTS it (a candidate dynamic import) and SKIPS with a
 * clear reason — never fails — so the runner lands now and the assertions light up the moment the
 * converter is live. The `dry_run` round-trip additionally feature-detects the WP-P03 REST route.
 *
 * `*.contract.ts` (not `*.test.ts`) ⇒ runs under `pnpm test:contract` (the wp-env stage), never under
 * the no-WP `pnpm test:unit` (`14-fixtures-harness.md §10`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';

import { WpClient } from '../wp/client.js';
import type { SiteConfig } from '../wp/types.js';
import type { ElementNode } from '../authoring/contract.js';
import { FIXTURES_DIR, isFixtureRunnable } from './fixture-loader.js';
import type { CapabilitySnapshot, FixtureEnvelope } from './fixture-loader.js';

/* ───────────────────────────── the html-v3 inline-only allowlist (SUPPLEMENT §B.1) ─────────── */

/**
 * The ONLY inline tags html-v3 keeps (`wp_kses` allowlist, `html-v3-prop-type.php:91`,
 * RESEARCH.md §6.6). Every other tag (`<br>`, `<mark>`, `<code>`, `<div>`, lists, headings-in-text…)
 * is silently stripped from text and MUST surface in `report.stripped_text`. The corpus runner uses
 * this set only to document intent — the actual expected stripped tags per section come from WP-H12's
 * `expected.coverage.json#stripped_text`.
 */
export const HTML_V3_INLINE_ALLOWLIST: ReadonlySet<string> = new Set([
  'b',
  'i',
  'em',
  'u',
  'a',
  'del',
  'span',
  'strong',
  'sup',
  'sub',
  's',
]);

/* ───────────────────────────── manifest + expected-file shapes (WP-H12-owned, READ-only) ─────── */

/** A per-section threshold/tolerance band (`corpus.manifest.json#sections[]`). PERCENTAGES (0..100). */
interface SectionThresholds {
  min_pct_native: number;
  min_pct_covered: number;
  max_pct_dropped: number;
}
interface SectionTolerance {
  pct_native: number;
  pct_covered: number;
}

/** One entry under `corpus.manifest.json#sections[]` (WP-H12 owns; Q04 reads). */
interface ManifestSection {
  id: string;
  path: string;
  provisional?: boolean;
  expected_pct_native?: number;
  thresholds: SectionThresholds;
  tolerance: SectionTolerance;
  requires?: FixtureEnvelope['requires'];
  default_coverage_gate?: number;
}

/** The WP-H12 corpus manifest (`fixtures/html/sections/corpus.manifest.json`). */
interface CorpusManifest {
  $version?: number;
  default_coverage_gate?: number;
  sections: ManifestSection[];
}

/**
 * `expected.coverage.json` (the `CoverageReport.coverage` shape, `diff.schema.json#/$defs/CoverageReport`;
 * PERCENTAGES 0..100). `stripped_text` may live on this file (WP-H12 SHAPE NOTE on 05-rich-text-card).
 */
interface ExpectedCoverage {
  coverage: {
    pct_native: number;
    pct_local_or_global_class: number;
    pct_custom_css: number;
    pct_dropped: number;
  };
  stripped_text?: Array<{ locator: string; stripped_tags: string[] }>;
}

/** `expected.a11y.json` — findings matched by rule+severity+locator (NOT minted element_id, §7). */
interface ExpectedA11y {
  match_by?: string[];
  findings: Array<{
    rule: string;
    severity: 'warning' | 'blocker';
    locator: string;
    message?: string;
    [k: string]: unknown;
  }>;
}

/* ───────────────────────────── the converter report shape (tolerated dual-shape) ────────────── */

/**
 * The converter's coverage block. The Contract 13 §1.9 wire shape uses
 * `native_pct/class_pct/custom_css_pct/dropped_pct`; the `CoverageReport`/`diff.schema.json` shape
 * (what WP-H12's expected files use) uses `pct_native/pct_local_or_global_class/pct_custom_css/
 * pct_dropped`. The orchestrator may emit either; the runner NORMALIZES both into one shape before
 * comparing (so it is robust to whichever WP-H11 ships).
 */
type ReportCoverageAny = Partial<{
  // Contract 13 §1.9 wire names.
  native_pct: number;
  class_pct: number;
  custom_css_pct: number;
  dropped_pct: number;
  // diff.schema.json / CoverageReport names.
  pct_native: number;
  pct_local_or_global_class: number;
  pct_custom_css: number;
  pct_dropped: number;
}>;

/** A11y finding from the converter (tolerates either severity vocabulary). */
interface ReportA11yFinding {
  // diff.schema.json: warning|blocker ; Contract 13 §1.9 wire: warn|block.
  rule: string;
  severity: string;
  message?: string;
  // The source locator (CSS-ish selector of the offending node). H10 attaches it for matching by
  // structure; element_id is minted at runtime and NOT matched (§7).
  locator?: string;
  element_id?: string;
  node_id?: string;
  [k: string]: unknown;
}

/** Stripped-text record from the converter (per source-text node). */
interface ReportStripped {
  // diff.schema.json: stripped_tags ; Contract 13 §1.9 wire: tags.
  stripped_tags?: string[];
  tags?: string[];
  locator?: string;
  element_id?: string;
  node_id?: string;
  [k: string]: unknown;
}

/** The converter's `report` block (the union of both report shapes). */
interface ConvertReport {
  coverage: ReportCoverageAny;
  a11y?: ReportA11yFinding[];
  stripped_text?: ReportStripped[];
  [k: string]: unknown;
}

/** The `convert.html_to_tree` result the runner asserts over (Contract 13 §1.9 outputSchema). */
interface ConvertHtmlToTreeResult {
  elements: ElementNode[];
  report: ConvertReport;
  [k: string]: unknown;
}

/** The orchestrator signature the runner feature-detects (WP-H11). */
type HtmlToTreeFn = (args: {
  html: string;
  css?: string;
  generation?: 'v4' | 'v3';
  options?: Record<string, unknown>;
}) => Promise<ConvertHtmlToTreeResult>;

/* ───────────────────────────── corpus loading (WP-H12 fixtures, read-only) ──────────────────── */

/** Absolute path to WP-H12's corpus root: `packages/shared/fixtures/html/sections`. */
const CORPUS_DIR = join(FIXTURES_DIR, 'html', 'sections');
/** WP-H12's S3-anchored manifest (consumed, never owned). */
const MANIFEST_PATH = join(CORPUS_DIR, 'corpus.manifest.json');

/** A fully-loaded corpus section (manifest entry + its three expected files + the raw inputs). */
interface LoadedSection {
  id: string;
  dir: string;
  manifest: ManifestSection;
  html: string;
  css?: string;
  expectedCoverage: ExpectedCoverage;
  expectedA11y: ExpectedA11y;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Read WP-H12's corpus manifest, or null if WP-H12 has not landed it yet (feature-detect). */
export function loadCorpusManifest(): CorpusManifest | null {
  if (!existsSync(MANIFEST_PATH)) {
    return null;
  }
  return readJson<CorpusManifest>(MANIFEST_PATH);
}

/**
 * Load every corpus section declared in WP-H12's manifest. The manifest's `sections[]` ORDER is the
 * source of truth (so a manifest add/remove is the single edit point). Sections whose directory or
 * expected files are missing are skipped from the returned set (defensive — H12 owns them).
 */
export function loadCorpusSections(): LoadedSection[] {
  const manifest = loadCorpusManifest();
  if (manifest === null) {
    return [];
  }
  const out: LoadedSection[] = [];
  for (const entry of manifest.sections) {
    // `path` is relative to the fixtures `html/` dir (e.g. `sections/01-hero`).
    const dir = join(FIXTURES_DIR, 'html', entry.path);
    const htmlPath = join(dir, 'input.html');
    const coveragePath = join(dir, 'expected.coverage.json');
    const a11yPath = join(dir, 'expected.a11y.json');
    if (!existsSync(htmlPath) || !existsSync(coveragePath) || !existsSync(a11yPath)) {
      continue;
    }
    const cssPath = join(dir, 'input.css');
    const section: LoadedSection = {
      id: entry.id,
      dir,
      manifest: entry,
      html: readFileSync(htmlPath, 'utf8'),
      expectedCoverage: readJson<ExpectedCoverage>(coveragePath),
      expectedA11y: readJson<ExpectedA11y>(a11yPath),
    };
    if (existsSync(cssPath)) {
      section.css = readFileSync(cssPath, 'utf8');
    }
    out.push(section);
  }
  return out;
}

/* ───────────────────────────── coverage normalization + tolerance ──────────────────────────── */

/** The normalized coverage block the runner compares (percentages 0..100). */
interface NormCoverage {
  pct_native: number;
  pct_covered: number;
  pct_dropped: number;
}

/**
 * Normalize a converter coverage block (either report shape) into `{pct_native, pct_covered,
 * pct_dropped}`. `pct_covered` is the share landing native OR in a local/global class — the placement
 * split (local vs global) is not a fidelity loss (WP-S03 §3/§5). When the report only exposes
 * `native_pct`, `pct_covered` falls back to it (the converter counts class-placed declarations as
 * native in the wire shape).
 */
export function normalizeReportCoverage(cov: ReportCoverageAny): NormCoverage {
  const native = cov.pct_native ?? cov.native_pct ?? 0;
  const covered = cov.pct_local_or_global_class ?? cov.class_pct ?? native;
  const dropped = cov.pct_dropped ?? cov.dropped_pct ?? 0;
  return {
    pct_native: native,
    // `class_pct` in the wire shape is the class-placed SLICE, not the cumulative covered total;
    // covered = native (which already includes class-placed). Use the max so either interpretation
    // satisfies "≥ min_pct_covered".
    pct_covered: Math.max(native, covered),
    pct_dropped: dropped,
  };
}

/** A readable coverage-delta line for assertion failures (the §6 "readable delta"). */
function coverageDelta(section: LoadedSection, got: NormCoverage): string {
  const exp = section.expectedCoverage.coverage;
  const t = section.manifest.tolerance;
  return (
    `[${section.id}] coverage delta: ` +
    `native got=${got.pct_native} exp=${exp.pct_native} (±${t.pct_native}, min=${section.manifest.thresholds.min_pct_native}); ` +
    `covered got=${got.pct_covered} exp=${exp.pct_local_or_global_class} (±${t.pct_covered}, min=${section.manifest.thresholds.min_pct_covered}); ` +
    `dropped got=${got.pct_dropped} exp=${exp.pct_dropped} (max=${section.manifest.thresholds.max_pct_dropped})`
  );
}

/* ───────────────────────────── a11y / stripped matching (by structure, §7) ──────────────────── */

/** Map the converter's severity vocabulary (warn/block) onto the expected one (warning/blocker). */
function normalizeSeverity(sev: string): string {
  if (sev === 'warn') {
    return 'warning';
  }
  if (sev === 'block') {
    return 'blocker';
  }
  return sev;
}

/** The locator a converter finding resolves to (H10 attaches `locator`; never matched by minted id). */
function findingLocator(f: ReportA11yFinding | ReportStripped): string | undefined {
  return f.locator;
}

/** Stable key for an expected/actual a11y finding (rule + normalized severity + locator). */
function a11yKey(rule: string, severity: string, locator: string | undefined): string {
  return `${rule}|${normalizeSeverity(severity)}|${locator ?? ''}`;
}

/* ───────────────────────────── env / converter / dry-run feature detection ──────────────────── */

/** Build a {@link SiteConfig} from the App-Password env (`13-tool-catalog.md §5.4`), or null. */
function siteFromEnv(): SiteConfig | null {
  const url = process.env['WP_URL'];
  const user = process.env['WP_USER'];
  const appPassword = process.env['WP_APP_PASSWORD'];
  if (!url || !user || !appPassword) {
    return null;
  }
  const basicToken = Buffer.from(`${user}:${appPassword}`).toString('base64');
  return { url, basicToken };
}

/**
 * Feature-detect the WP-H11 orchestrator `convert.html_to_tree`. WP-H11's exact module/export name is
 * not frozen yet, so the runner probes a small set of candidate seams and returns the first callable
 * `html → {elements, report}` function it finds, or null (⇒ SKIP with a clear reason). Once WP-H11
 * ships, the enablement WP can collapse this to the real import.
 */
export async function resolveHtmlToTreeFn(): Promise<HtmlToTreeFn | null> {
  const candidates: Array<{ module: string; exportName: string }> = [
    { module: '../convert/html-to-tree.js', exportName: 'convertHtmlToTree' },
    { module: '../convert/html-to-tree.js', exportName: 'htmlToTree' },
    { module: '../convert/orchestrator.js', exportName: 'convertHtmlToTree' },
    { module: '../convert/orchestrator.js', exportName: 'htmlToTree' },
    { module: '../convert/convert.js', exportName: 'convertHtmlToTree' },
    { module: '../convert/index.js', exportName: 'convertHtmlToTree' },
    { module: '../convert/index.js', exportName: 'htmlToTree' },
  ];
  for (const { module, exportName } of candidates) {
    try {
      const mod = (await import(module)) as Record<string, unknown>;
      const fn = mod[exportName];
      if (typeof fn === 'function') {
        return fn as HtmlToTreeFn;
      }
    } catch {
      // Module not present yet — try the next candidate.
    }
  }
  return null;
}

/** Probe whether the dry-run route exists (WP-P03). 404/no_route ⇒ controller not registered yet. */
async function dryRunRouteAvailable(client: WpClient, site: SiteConfig): Promise<boolean> {
  try {
    await client.send(
      'POST',
      `${site.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/dry-run`,
      {
        body: { elements: [], generation: 'v4' },
      },
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return !/no_route|404|not\s*found/i.test(message);
  }
}

/* ───────────────────────────── the runner ──────────────────────────────────────────────────── */

const site = siteFromEnv();

describe('HTML→native corpus regression (§6)', () => {
  const manifest = loadCorpusManifest();
  const sections = loadCorpusSections();
  let convertFn: HtmlToTreeFn | null = null;
  let client: WpClient | undefined;
  let routeReady = false;

  // The contract job runs against the verified live site (Elementor 4.1.1 + Pro 4.1.0, V4 experiments
  // on). The same capability gate decides which sections are runnable on free-only / atomic-off installs
  // (each section's manifest `requires` is the gate, mirroring §2/§6 "requires skips").
  const caps: CapabilitySnapshot = {
    experiments: ['e_atomic_elements', 'e_classes', 'e_variables'],
    pro: true,
    elementor_version: '4.1.1',
  };

  beforeAll(async () => {
    convertFn = await resolveHtmlToTreeFn();
    if (site !== null) {
      client = new WpClient({ site });
      routeReady = await dryRunRouteAvailable(client, site);
    }
  });

  // ── corpus integrity (always runs, even before WP-H11/H12) ──────────────────────────────────
  it('WP-H12 corpus manifest is present and S3-anchored (never a hardcoded 85%)', () => {
    if (manifest === null) {
      console.warn(
        '[html-corpus] SKIP: WP-H12 corpus.manifest.json not present yet (fixtures pending).',
      );
      return;
    }
    expect(Array.isArray(manifest.sections)).toBe(true);
    expect(manifest.sections.length).toBeGreaterThanOrEqual(5); // ≥5 real marketing sections (§1).
    for (const s of manifest.sections) {
      // The regression gate is the S3 number, never a literal 85% (RESEARCH.md §6.8; eng-std §4.6/§6).
      expect(s.thresholds.min_pct_native).not.toBe(85);
      expect(s.thresholds.min_pct_native).toBeGreaterThan(0);
      expect(s.tolerance.pct_native).toBeGreaterThan(0);
    }
  });

  it('every manifest section has its WP-H12 input + expected files on disk', () => {
    if (manifest === null) {
      return; // covered by the skip above.
    }
    // The loaded set must cover every manifest section (no silently-dropped fixtures).
    expect(sections.map((s) => s.id).sort()).toEqual(manifest.sections.map((s) => s.id).sort());
  });

  it('reports converter availability (WP-H11) without failing when it is pending', async () => {
    const fn = await resolveHtmlToTreeFn();
    if (fn === null) {
      console.warn(
        '[html-corpus] convert.html_to_tree (WP-H11) not present yet — per-section assertions SKIP until it ships.',
      );
    }
    // Never a hard failure on absence — the suite lands in v1 and lights up when WP-H11 is live.
    expect(fn === null || typeof fn === 'function').toBe(true);
  });

  // ── per-section assertions (§6 steps 1–5), gated on WP-H11 + WP-P03 ──────────────────────────
  // A single typed table so `it.each` keeps the suite meaningful even before WP-H12 lands (one
  // self-skipping placeholder row), and runs one row per real section once it does.
  const cases: Array<readonly [string, LoadedSection | null]> =
    sections.length > 0
      ? sections.map((s) => [s.id, s] as const)
      : [['(no sections)', null] as const];

  it.each(cases)(
    'section "%s": coverage within tolerance + a11y + stripped-text + dry_run valid',
    async (label, section) => {
      if (section === null) {
        console.warn('[html-corpus] SKIP: no corpus sections loaded (WP-H12 pending).');
        return;
      }

      // Capability gate (free-only / atomic-off installs): skip sections whose requires are unmet (§6).
      const reqEnvelope = { requires: section.manifest.requires } as unknown as FixtureEnvelope;
      if (!isFixtureRunnable(reqEnvelope, caps)) {
        console.warn(`[html-corpus] SKIP "${label}": requires unmet on target site.`);
        return;
      }

      if (convertFn === null) {
        console.warn(
          `[html-corpus] SKIP "${label}": convert.html_to_tree (WP-H11) not registered yet.`,
        );
        return;
      }

      // ── step 1: run the converter ──────────────────────────────────────────────────────────
      const convertArgs: Parameters<HtmlToTreeFn>[0] = { html: section.html, generation: 'v4' };
      if (section.css !== undefined) {
        convertArgs.css = section.css;
      }
      const result = await convertFn(convertArgs);
      expect(Array.isArray(result.elements)).toBe(true);
      expect(result.report).toBeTruthy();

      // ── step 2: coverage within the S3-anchored tolerance band ───────────────────────────────
      const got = normalizeReportCoverage(result.report.coverage);
      const exp = section.expectedCoverage.coverage;
      const tol = section.manifest.tolerance;
      const thr = section.manifest.thresholds;
      const msg = coverageDelta(section, got);

      // (a) within ± tolerance of the measured S3 number …
      expect(Math.abs(got.pct_native - exp.pct_native), msg).toBeLessThanOrEqual(tol.pct_native);
      expect(Math.abs(got.pct_covered - exp.pct_local_or_global_class), msg).toBeLessThanOrEqual(
        tol.pct_covered,
      );
      // (b) … AND never below the hard regression floor (a regression below `min_*` fails — §6 step 2).
      expect(got.pct_native, msg).toBeGreaterThanOrEqual(thr.min_pct_native);
      expect(got.pct_covered, msg).toBeGreaterThanOrEqual(thr.min_pct_covered);
      expect(got.pct_dropped, msg).toBeLessThanOrEqual(thr.max_pct_dropped);

      // ── step 3: a11y findings match (rule+severity+locator SET, structural — §7) ──────────────
      const gotA11y = new Set(
        (result.report.a11y ?? []).map((f) => a11yKey(f.rule, f.severity, findingLocator(f))),
      );
      const wantA11y = new Set(
        section.expectedA11y.findings.map((f) => a11yKey(f.rule, f.severity, f.locator)),
      );
      expect(
        [...gotA11y].sort(),
        `[${label}] a11y mismatch: got=${JSON.stringify([...gotA11y])} want=${JSON.stringify([...wantA11y])}`,
      ).toEqual([...wantA11y].sort());

      // ── step 4: stripped-text lists the expected stripped block tags (inline-only allowlist) ──
      // The expected stripped_text lives on expected.coverage.json (WP-H12 SHAPE NOTE). Match the
      // stripped_tags SET per source-text node, keyed by locator (NOT minted element_id, §7).
      const expectedStripped = section.expectedCoverage.stripped_text ?? [];
      const gotStrippedByLocator = new Map<string, Set<string>>();
      for (const rec of result.report.stripped_text ?? []) {
        const loc = findingLocator(rec) ?? '';
        const tags = new Set(rec.stripped_tags ?? rec.tags ?? []);
        gotStrippedByLocator.set(loc, tags);
      }
      for (const want of expectedStripped) {
        const gotTags = gotStrippedByLocator.get(want.locator);
        expect(
          gotTags,
          `[${label}] no stripped_text record for locator "${want.locator}"`,
        ).toBeTruthy();
        // Every expected stripped tag must be reported, and NONE may be an allowlisted inline tag
        // (allowlisted inline markup survives — it is never stripped, SUPPLEMENT §B.1).
        for (const tag of want.stripped_tags) {
          expect(
            gotTags?.has(tag),
            `[${label}] expected stripped tag "${tag}" missing at "${want.locator}"`,
          ).toBe(true);
          expect(
            HTML_V3_INLINE_ALLOWLIST.has(tag),
            `[${label}] allowlisted inline tag "${tag}" must NOT be stripped`,
          ).toBe(false);
        }
      }
      // No reported stripped tag may be an allowlisted inline tag, anywhere in the report.
      for (const tags of gotStrippedByLocator.values()) {
        for (const tag of tags) {
          expect(
            HTML_V3_INLINE_ALLOWLIST.has(tag),
            `[${label}] reported stripped tag "${tag}" is on the inline allowlist (should survive)`,
          ).toBe(false);
        }
      }

      // ── step 5: the produced tree round-trips through PHP dry_run as valid:true (HARD GATE) ────
      if (site === null) {
        console.warn(
          `[html-corpus] SKIP dry_run for "${label}": WP_URL/WP_USER/WP_APP_PASSWORD not set.`,
        );
        return;
      }
      if (!routeReady) {
        console.warn(
          `[html-corpus] SKIP dry_run for "${label}": elementor-ultra/v1 dry-run route not registered yet (WP-P03 pending).`,
        );
        return;
      }
      const dryRunUrl = `${site.url.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/dry-run`;
      const dryRun = await client!.send<{ valid: boolean; errors?: Array<{ code: string }> }>(
        'POST',
        dryRunUrl,
        { body: { elements: result.elements, settings: {}, generation: 'v4' } },
      );
      // The converter must NEVER emit a tree PHP rejects (§6 step 5). On failure, surface the codes.
      expect(
        dryRun.valid,
        `[${label}] converter emitted a tree PHP dry_run REJECTS: ${JSON.stringify(dryRun.errors ?? [])}`,
      ).toBe(true);
    },
  );
});
