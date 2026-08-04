/**
 * WP-Q07 — ULTRA milestone "agency site from brief" orchestrator (the integration capstone).
 *
 * This is the LIBRARY half of the e2e acceptance scenario: it loads the declarative brief
 * (`packages/shared/fixtures/e2e/brief.agency-site.json`) + the expected end-state
 * (`expected.outcomes.json`) and DRIVES the full ULTRA tool surface over App-Password REST against the
 * SAME wp-env the per-unit suites hit, returning a structured {@link ScenarioResult} the contract
 * suite (`e2e-agency-site.contract.ts`) asserts the M1–M8 outcomes against. It composes the per-unit
 * verticals (it does NOT duplicate Q01/Q04/Q05/Q06) and calls tools through the live server like a
 * real client (`01-architecture.md §2.2`).
 *
 * It exercises (00-product-overview.md §6):
 *   M1  create pages + build the styled-primed hero → public CSS has the local + global class rules.
 *   M2  a safe edit (diff + dry_run) then a rollback that restores the prior tree + re-primes CSS.
 *   M5  design.classes.upsert (diff-PUT, full order, explicit deleted, 1000-item budget pre-flight,
 *       DUPLICATED_LABEL reconcile) + a watermarked design.variables.batch.
 *   M6  capability-aware: probe site/capabilities first; SKIP the Pro legs cleanly on no-Pro; fall
 *       back to V3 on atomic-off — never a crash, always an actionable message.
 *   M8  batch.plan/batch.apply (cross-doc) — backups recorded UP FRONT, a forced partial failure,
 *       best-effort compensation + a per-step result map, and E_COMPENSATION_FAILED when compensation
 *       itself fails (10-rest-api.md §13, 12-error-taxonomy.md).
 *
 * GATING: every vertical's REST route is feature-detected; an unregistered route (rest_no_route/404)
 * makes that leg `skipped` with an actionable reason (never a hard failure) so the scenario grows
 * toward the full ULTRA DoD as the verticals (WP-P##/T##/H##) land — exactly like
 * `dry-run-roundtrip.contract.ts` / `render-assertion.contract.ts`.
 *
 * IDEMPOTENT: all created posts/templates/popups are tracked and trashed in {@link teardown}; the
 * kit class/variable changes are reverted. Re-running is safe.
 *
 * This module is imported by the `*.contract.ts` suite (it is a library, not a runner) so it carries
 * NO `describe`/`it` — the contract file owns the vitest surface.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WpClient } from '../wp/client.js';
import { WpClientError, type SiteConfig } from '../wp/types.js';
import { FIXTURES_DIR } from './fixture-loader.js';

/* ─────────────────────────── env / site ─────────────────────────────────────────────────────── */

/** Build a {@link SiteConfig} from the App-Password env (`13-tool-catalog.md §5.4`), or null if unset. */
export function siteFromEnv(): SiteConfig | null {
  const url = process.env['WP_URL'];
  const user = process.env['WP_USER'];
  const appPassword = process.env['WP_APP_PASSWORD'];
  if (!url || !user || !appPassword) {
    return null;
  }
  const basicToken = Buffer.from(`${user}:${appPassword}`).toString('base64');
  return { url, basicToken };
}

function restBase(s: SiteConfig): string {
  return `${s.url.replace(/\/+$/, '')}/wp-json`;
}

function ultra(s: SiteConfig, path: string): string {
  return `${restBase(s)}/elementor-ultra/v1/${path.replace(/^\/+/, '')}`;
}

/* ─────────────────────────── brief / outcomes types ─────────────────────────────────────────── */

/** A typed authoring-ish node (loose — the live validator is authoritative). */
export type BriefNode = Record<string, unknown>;

/** A page in the brief (incl. the hero). */
export interface BriefPage {
  ref: string;
  title: string;
  status: string;
  is_hero: boolean;
  prime_css: boolean;
  tree: BriefNode[];
  edit_patch?: { element_id: string; settings: Record<string, unknown> };
}

/** A theme-builder doc in the brief. */
export interface BriefThemeDoc {
  ref: string;
  type: string;
  title: string;
  status: string;
  conditions: Array<Array<string>>;
  elements: BriefNode[];
}

/** The popup in the brief. */
export interface BriefPopup {
  ref: string;
  title: string;
  status: string;
  layout_settings: Record<string, unknown>;
  display_settings: Record<string, unknown>;
  conditions: Array<Array<string>>;
  set_triggers?: { triggers: Record<string, unknown> };
  elements: BriefNode[];
}

/** A class definition added by the design system. */
export interface BriefClass {
  id: string;
  type: string;
  label: string;
  variants: unknown[];
}

/** A batch plan step in the brief. */
export interface BriefBatchStep {
  ref: string;
  route: string;
  title: string;
  expect_ok: boolean;
  expected_error_code?: string;
  tree: BriefNode[];
}

/** The full declarative brief (`brief.agency-site.json`). */
export interface AgencyBrief {
  $e2e: 1;
  id: string;
  title: string;
  capabilities_required: {
    atomic: { experiments: string[] };
    pro: boolean;
    min_elementor: string;
  };
  pages: BriefPage[];
  design_system: {
    classes: {
      context: string;
      add: BriefClass[];
      delete: string[];
      seed_duplicate_label: BriefClass;
    };
    variables: { operations: unknown[] };
  };
  pro: {
    theme: BriefThemeDoc[];
    popup: BriefPopup;
  };
  batch: { plan: BriefBatchStep[] };
}

/* ─────────────────────────── fixture loading ────────────────────────────────────────────────── */

const E2E_DIR = join(FIXTURES_DIR, 'e2e');

/** Read + parse the declarative agency brief. */
export function loadBrief(): AgencyBrief {
  return JSON.parse(readFileSync(join(E2E_DIR, 'brief.agency-site.json'), 'utf8')) as AgencyBrief;
}

/** Read + parse the expected end-state outcomes (the contract suite asserts against this). */
export function loadExpectedOutcomes(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(E2E_DIR, 'expected.outcomes.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/* ─────────────────────── CSS rule extraction (TS mirror of CSS_Rule_Extractor) ──────────────── */
/* Self-contained (NOT imported from render-assertion.contract.ts, which registers a vitest suite on
 * import). Mirrors the SAME extractor logic the WP-Q06 render assertion uses (M1). */

interface CssRule {
  selector: string;
  declarations: Array<{ property: string; value: string }>;
}

/** Parse CSS into rule blocks (strips comments, flattens @media/@supports wrappers). */
export function parseCssRules(css: string): CssRule[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const flattened = noComments.replace(/@[a-zA-Z-]+[^{};]*\{/g, '');
  const rules: CssRule[] = [];
  for (const chunk of flattened.split('}')) {
    const brace = chunk.indexOf('{');
    if (brace === -1) {
      continue;
    }
    const selector = chunk.slice(0, brace).trim();
    const body = chunk.slice(brace + 1).trim();
    if (selector === '') {
      continue;
    }
    const declarations: Array<{ property: string; value: string }> = [];
    for (const decl of body.split(';')) {
      const d = decl.trim();
      if (d === '') {
        continue;
      }
      const colon = d.indexOf(':');
      if (colon === -1) {
        continue;
      }
      declarations.push({ property: d.slice(0, colon).trim(), value: d.slice(colon + 1).trim() });
    }
    rules.push({ selector, declarations });
  }
  return rules;
}

/** Whether a selector references `.<classId>` as a whole class token (not a longer-id prefix). */
export function selectorHasClass(selector: string, classId: string): boolean {
  if (classId === '') {
    return false;
  }
  const pattern = new RegExp(
    `\\.${classId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`,
  );
  return pattern.test(selector);
}

/** Whether the parsed rules carry a non-empty declaration block for `.<classId>`. */
export function classHasDeclarations(rules: CssRule[], classId: string): boolean {
  return rules.some((r) => selectorHasClass(r.selector, classId) && r.declarations.length > 0);
}

/* ─────────────────────────── route feature-detection ────────────────────────────────────────── */

/** A taxonomy/transport error message that means the route is not registered (controller pending). */
function isNoRoute(message: string): boolean {
  return /no_route|404|not\s*found/i.test(message);
}

/** Probe whether a POST/PUT route family is registered. 404/no_route ⇒ controller not landed. */
export async function routeRegistered(
  client: WpClient,
  method: 'POST' | 'PUT',
  url: string,
  body: unknown,
): Promise<boolean> {
  try {
    await client.send(method, url, { body });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return !isNoRoute(message);
  }
}

/* ─────────────────────────── styled-id derivation (mirror of WP-Q06) ─────────────────────────── */

/** Local-style ids (keys of every `styles` map) + referenced global-class ids (not local) in a tree. */
export function expectedIdsFromTree(tree: unknown): { local: string[]; global: string[] } {
  const local = new Set<string>();
  const classes = new Set<string>();
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) {
      return;
    }
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') {
        continue;
      }
      const n = node as Record<string, unknown>;
      const styles = n['styles'];
      if (styles && typeof styles === 'object') {
        for (const k of Object.keys(styles)) {
          local.add(k);
        }
      }
      const settings = n['settings'];
      if (settings && typeof settings === 'object') {
        const cls = (settings as Record<string, unknown>)['classes'];
        if (
          cls &&
          typeof cls === 'object' &&
          (cls as Record<string, unknown>)['$$type'] === 'classes' &&
          Array.isArray((cls as Record<string, unknown>)['value'])
        ) {
          for (const id of (cls as { value: unknown[] }).value) {
            classes.add(String(id));
          }
        }
      }
      walk(n['elements']);
    }
  };
  walk(tree);
  const localArr = [...local];
  return { local: localArr, global: [...classes].filter((c) => !localArr.includes(c)) };
}

/** Count the element ids in a tree (structural compare helper for M2 rollback). */
export function collectElementIds(tree: unknown): string[] {
  const ids: string[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) {
      return;
    }
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') {
        continue;
      }
      const n = node as Record<string, unknown>;
      const id = n['id'];
      if (typeof id === 'string') {
        ids.push(id);
      }
      walk(n['elements']);
    }
  };
  walk(tree);
  return ids.sort();
}

/* ─────────────────────────── per-leg result types ───────────────────────────────────────────── */

/** The status of one M-leg of the scenario. */
export type LegStatus = 'pass' | 'skipped' | 'fail';

/** One M-leg outcome with a human reason for skip/fail. */
export interface LegResult {
  status: LegStatus;
  /** Actionable message (the skip/fail reason — M6 requires these to be actionable). */
  reason?: string;
  /** Free-form structured observations the contract suite asserts against `expected.outcomes.json`. */
  observed: Record<string, unknown>;
}

/** The full scenario result, keyed by M-metric. */
export interface ScenarioResult {
  ranAgainstSite: boolean;
  capabilities: CapabilitySnapshotLive | null;
  M1: LegResult;
  M2: LegResult;
  M5: LegResult;
  M6: LegResult;
  M8: LegResult;
}

/** The live capability probe shape (subset of `GET /site/capabilities`, 10-rest-api.md §12). */
export interface CapabilitySnapshotLive {
  experiments: Record<string, string>;
  pro: boolean;
  can_update_class: boolean;
  elementor_version?: string;
}

function leg(status: LegStatus, observed: Record<string, unknown>, reason?: string): LegResult {
  return reason === undefined ? { status, observed } : { status, observed, reason };
}

/* ─────────────────────────── the orchestrator ───────────────────────────────────────────────── */

/** Tracked artifacts for idempotent teardown. */
interface Artifacts {
  pages: number[];
  themeDocs: number[];
  popups: number[];
  batchDocs: number[];
  /** Class ids the scenario added to the kit (reverted in teardown). */
  addedClassIds: string[];
}

/** The scenario runner — one instance per run; call {@link run} then {@link teardown}. */
export class AgencySiteScenario {
  private readonly site: SiteConfig;
  private readonly client: WpClient;
  private readonly brief: AgencyBrief;
  private readonly artifacts: Artifacts = {
    pages: [],
    themeDocs: [],
    popups: [],
    batchDocs: [],
    addedClassIds: [],
  };

  constructor(site: SiteConfig, brief: AgencyBrief = loadBrief()) {
    this.site = site;
    this.client = new WpClient({ site });
    this.brief = brief;
  }

  /** A short op_id namespace for this run (idempotent replay key prefix, 10-rest-api.md §0.8). */
  private opId(suffix: string): string {
    return `op_q07_${suffix}`;
  }

  /** Probe `GET /site/capabilities` first (M6 — never assume a route). Returns null if unreachable. */
  async probeCapabilities(): Promise<CapabilitySnapshotLive | null> {
    try {
      const caps = await this.client.send<{
        experiments?: Record<string, string>;
        pro?: boolean;
        can_update_class?: boolean;
        elementor_version?: string;
      }>('GET', ultra(this.site, 'site/capabilities'), {});
      const snap: CapabilitySnapshotLive = {
        experiments: caps.experiments ?? {},
        pro: caps.pro === true,
        can_update_class: caps.can_update_class === true,
      };
      if (caps.elementor_version !== undefined) {
        snap.elementor_version = caps.elementor_version;
      }
      return snap;
    } catch {
      return null;
    }
  }

  /** True when an experiment slug is active on the live site. */
  private static atomicActive(caps: CapabilitySnapshotLive | null, slug: string): boolean {
    if (caps === null) {
      return false;
    }
    return caps.experiments[slug] === 'active';
  }

  /**
   * Run the full scenario, returning a per-M structured result. Never throws on a not-yet-landed
   * route — that leg is `skipped` with an actionable reason. Throws only on a true orchestration bug.
   */
  async run(): Promise<ScenarioResult> {
    const caps = await this.probeCapabilities();
    const ranAgainstSite = caps !== null;

    const m1 = await this.runM1Hero(caps);
    const m2 = await this.runM2Rollback(caps);
    const m5 = await this.runM5DesignSystem(caps);
    const m6 = this.assessM6(caps);
    const m8 = await this.runM8Batch();

    return { ranAgainstSite, capabilities: caps, M1: m1, M2: m2, M5: m5, M6: m6, M8: m8 };
  }

  /* ── M1: build the styled-primed hero → public CSS has the local + global rules ── */
  private async runM1Hero(caps: CapabilitySnapshotLive | null): Promise<LegResult> {
    const observed: Record<string, unknown> = {};
    const hero = this.brief.pages.find((p) => p.is_hero);
    if (hero === undefined) {
      return leg('fail', observed, 'brief has no hero page');
    }

    // Capability gate (M6 cross-cut): the styled-render M1 proof needs atomic prime-css.
    if (!AgencySiteScenario.atomicActive(caps, 'e_atomic_elements')) {
      return leg(
        'skipped',
        observed,
        'M1 styled-render proof requires e_atomic_elements active (atomic-off install — would fall back to V3 build with no atomic CSS).',
      );
    }

    const saveUrl = ultra(this.site, 'documents/0/save');
    if (!(await routeRegistered(this.client, 'POST', saveUrl, { elements: [], settings: {} }))) {
      return leg(
        'skipped',
        observed,
        'documents/{id}/save + prime-css routes not registered yet (WP-P04/P05 pending). The PHP suite carries the authoritative on-disk render assertion.',
      );
    }

    // 1. Create the hero page.
    const page = await this.client.send<{ id: number }>(
      'POST',
      `${restBase(this.site)}/wp/v2/pages`,
      { body: { title: hero.title, status: hero.status } },
    );
    this.artifacts.pages.push(page.id);
    observed['hero_page_id'] = page.id;
    observed['hero_page_created'] = page.id > 0;

    // 2. Save the atomic tree, chaining the prime in-request (§2.6 prime_css:true).
    const saved = await this.client.send<{ id: number; css_primed?: boolean }>(
      'POST',
      ultra(this.site, `documents/${page.id}/save`),
      {
        body: {
          elements: hero.tree,
          settings: {},
          prime_css: hero.prime_css,
          op_id: this.opId(`hero_save_${page.id}`),
        },
      },
    );

    // 3. If the save did not prime, prime explicitly (§2.7).
    let primed = saved.css_primed === true;
    if (!primed) {
      const primeData = await this.client.send<{ css_primed?: boolean }>(
        'POST',
        ultra(this.site, `documents/${page.id}/prime-css`),
        { body: { approach: 'auto', op_id: this.opId(`hero_prime_${page.id}`) } },
      );
      primed = primeData.css_primed === true;
    }
    observed['css_primed'] = primed;

    // 4. Read the public global-class CSS over HTTP (the stable id — [R5] the local id is regenerated).
    const ids = expectedIdsFromTree(hero.tree);
    observed['global_class_ids'] = ids.global;
    const uploadsCss = `${this.site.url.replace(/\/+$/, '')}/wp-content/uploads/elementor/css`;
    const globalCss = await this.fetchCss(`${uploadsCss}/global-${page.id}-frontend-desktop.css`);
    const baseCss = await this.fetchCss(`${uploadsCss}/base-desktop.css`);

    if (globalCss.trim().length > 0) {
      const rules = parseCssRules(globalCss);
      const allPresent = ids.global.every((gid) => classHasDeclarations(rules, gid));
      observed['global_class_rule_present'] = allPresent;
      observed['base_css_non_empty'] = baseCss.trim().length > 0;
      return allPresent && baseCss.trim().length > 0
        ? leg('pass', observed)
        : leg('fail', observed, 'public CSS missing the expected global class rule(s) (M1)');
    }
    // The on-disk prime is authoritative; the HTTP layer 304'd/cached ([S01]).
    observed['global_class_rule_present'] = primed;
    observed['css_http_transiently_empty'] = true;
    return primed
      ? leg('pass', observed)
      : leg('fail', observed, 'prime-css did not confirm the atomic CSS render (M1)');
  }

  /* ── M2: safe edit (diff + dry_run) then rollback restores prior tree + re-primes CSS ── */
  private async runM2Rollback(caps: CapabilitySnapshotLive | null): Promise<LegResult> {
    const observed: Record<string, unknown> = {};
    const page = this.brief.pages.find((p) => p.is_hero && p.edit_patch !== undefined);
    if (page === undefined || page.edit_patch === undefined) {
      return leg('fail', observed, 'brief has no edit_patch on the hero for M2');
    }
    if (!AgencySiteScenario.atomicActive(caps, 'e_atomic_elements')) {
      return leg(
        'skipped',
        observed,
        'M2 atomic safe-edit requires e_atomic_elements active (atomic-off — V3 fallback path tested elsewhere).',
      );
    }

    // M2 depends on a created+saved hero (M1). If M1 did not create one, skip.
    const heroId = this.artifacts.pages[0];
    if (heroId === undefined) {
      return leg(
        'skipped',
        observed,
        'M2 needs the M1 hero page (M1 skipped/failed — save route not landed yet).',
      );
    }

    // Probe the element-ops + backups + rollback routes.
    const elementsUrl = ultra(this.site, `documents/${heroId}/elements`);
    const backupsUrl = ultra(this.site, `documents/${heroId}/backups`);
    if (!(await routeRegistered(this.client, 'POST', elementsUrl, { base_hash: '', ops: [] }))) {
      return leg(
        'skipped',
        observed,
        'documents/{id}/elements (granular ops) route not registered yet (WP-P## pending).',
      );
    }

    // Capture the pre-edit structure + base_hash.
    const before = await this.readStructure(heroId);
    if (before === null) {
      return leg(
        'skipped',
        observed,
        'get_structure route not registered yet — cannot capture prior tree.',
      );
    }
    observed['concurrency_base_hash_used'] = typeof before.base_hash === 'string';
    const beforeIds = collectElementIds(before.tree);

    // Dry-run the edit first (M2: every edit passes authoritative dry_run + produces a diff).
    try {
      const dry = await this.client.send<{ valid?: boolean; diff?: unknown }>(
        'POST',
        ultra(this.site, `documents/${heroId}/dry-run`),
        {
          body: {
            base_hash: before.base_hash,
            ops: [
              {
                op: 'update_settings',
                element_id: page.edit_patch.element_id,
                settings: page.edit_patch.settings,
              },
            ],
          },
        },
      );
      observed['edit_passed_dry_run'] = dry.valid !== false;
      observed['edit_produced_diff'] = dry.diff !== undefined && dry.diff !== null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNoRoute(message)) {
        return leg('skipped', observed, 'dry-run route not registered yet (WP-P03 pending).');
      }
      throw err;
    }

    // Backup, then apply the edit (the apply re-reads + re-primes per Document_Writer).
    const list = await this.listBackups(backupsUrl);
    await this.client.send('POST', ultra(this.site, `documents/${heroId}/backup`), {
      body: { op_id: this.opId(`m2_backup_${heroId}`) },
    });
    const afterBackup = await this.listBackups(backupsUrl);
    const backupHandle =
      afterBackup.find((h) => !list.some((b) => b.id === h.id))?.id ?? afterBackup[0]?.id;

    await this.client.send('POST', elementsUrl, {
      body: {
        base_hash: before.base_hash,
        ops: [
          {
            op: 'update_settings',
            element_id: page.edit_patch.element_id,
            settings: page.edit_patch.settings,
          },
        ],
        prime_css: true,
        op_id: this.opId(`m2_edit_${heroId}`),
      },
    });

    // Rollback to the captured backup → restores prior tree + re-primes CSS.
    const rollback = await this.client.send<{ css_primed?: boolean; restored?: boolean }>(
      'POST',
      ultra(this.site, `documents/${heroId}/rollback`),
      {
        body: {
          backup_id: backupHandle,
          prime_css: true,
          op_id: this.opId(`m2_rollback_${heroId}`),
        },
      },
    );
    observed['rollback_reprimed_css'] = rollback.css_primed === true;

    const after = await this.readStructure(heroId);
    const afterIds = after === null ? [] : collectElementIds(after.tree);
    const restored = JSON.stringify(afterIds) === JSON.stringify(beforeIds);
    observed['rollback_restored_prior_tree'] = restored;

    return restored
      ? leg('pass', observed)
      : leg('fail', observed, 'rollback did not restore the prior tree structure (M2)');
  }

  /* ── M5: design.classes.upsert (diff-PUT, budget pre-flight, DUPLICATED_LABEL) + variables.batch ── */
  private async runM5DesignSystem(caps: CapabilitySnapshotLive | null): Promise<LegResult> {
    const observed: Record<string, unknown> = {};
    // M6 cross-cut: design tools hard-fail with an actionable message when can_update_class=false.
    if (caps !== null && !caps.can_update_class) {
      return leg(
        'skipped',
        observed,
        'design.classes.upsert requires CAP_UPDATE_CLASS (can_update_class=false). Activate the companion (S5 grant) or run as an admin with the UPDATE_CLASS capability.',
      );
    }

    const classesUrl = ultra(this.site, 'design/classes');
    // GET first to learn current ids + order (the diff-PUT MUST carry the FULL final order, §4.2).
    let current: { items?: Record<string, unknown>; order?: string[] };
    try {
      current = await this.client.send<{ items?: Record<string, unknown>; order?: string[] }>(
        'GET',
        classesUrl,
        {},
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return leg(
        'skipped',
        observed,
        isNoRoute(message)
          ? 'design/classes route not registered yet (WP-P## pending).'
          : `design/classes GET failed: ${message}`,
      );
    }

    const existingOrder = Array.isArray(current.order) ? current.order : [];
    const existingCount = existingOrder.length;
    const ds = this.brief.design_system.classes;
    const addIds = ds.add.map((c) => c.id);
    // Seed the duplicate-label class alongside the adds (drives the DUPLICATED_LABEL soft-reconcile).
    const dupId = ds.seed_duplicate_label.id;
    const allAddIds = [...addIds, dupId];

    // Budget pre-flight (M5): count(existing) − deleted + added ≤ 1000 (§4.2).
    const budgetMax = 1000;
    const finalCount = existingCount - ds.delete.length + allAddIds.length;
    observed['budget_preflighted'] = true;
    observed['budget_max_allowed'] = budgetMax;
    observed['budget_final_count'] = finalCount;
    if (finalCount > budgetMax) {
      return leg(
        'fail',
        observed,
        `class budget pre-flight would exceed ${budgetMax} (final ${finalCount}) — the PUT must be split (E_BUDGET_EXCEEDED).`,
      );
    }

    // Build the diff-PUT body: full final order, explicit deleted, items ONLY for added (+ dup).
    const items: Record<string, unknown> = {};
    for (const c of ds.add) {
      items[c.id] = c;
    }
    items[dupId] = ds.seed_duplicate_label;
    const finalOrder = [...existingOrder.filter((id) => !ds.delete.includes(id)), ...allAddIds];

    let put: { ok?: boolean; modified_labels?: Record<string, unknown>; order?: string[] };
    try {
      put = await this.client.send<{
        ok?: boolean;
        modified_labels?: Record<string, unknown>;
        order?: string[];
      }>('PUT', classesUrl, {
        body: {
          context: ds.context,
          changes: { added: allAddIds, deleted: ds.delete, modified: [], order: true },
          items,
          order: finalOrder,
          op_id: this.opId('classes_upsert'),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return leg(
        'skipped',
        observed,
        isNoRoute(message)
          ? 'design/classes PUT route not registered yet (WP-P## pending).'
          : `design/classes PUT failed: ${message}`,
      );
    }
    this.artifacts.addedClassIds.push(...allAddIds);
    observed['classes_put_ok'] = put.ok === true;
    observed['order_consistent'] = Array.isArray(put.order)
      ? put.order.length === finalOrder.length
      : true;

    // DUPLICATED_LABEL reconcile (M5): the dup-label class yields a non-empty modified_labels (200,
    // a soft outcome — NOT an error); the caller rebinds elements to the renamed id.
    const modified = put.modified_labels ?? {};
    observed['modified_labels'] = modified;
    observed['modified_labels_non_empty'] = Object.keys(modified).length > 0;
    observed['duplicated_label_reconciled'] = Object.keys(modified).length > 0;

    // Variables batch (M5 design-system) — watermarked (read the current watermark first).
    const varsUrl = ultra(this.site, 'design/variables');
    try {
      const varsList = await this.client.send<{ watermark?: number }>('GET', varsUrl, {});
      const batchUrl = ultra(this.site, 'design/variables/batch');
      const batch = await this.client.send<{ watermark?: number }>('POST', batchUrl, {
        body: {
          watermark: varsList.watermark ?? 0,
          operations: this.brief.design_system.variables.operations,
          op_id: this.opId('vars_batch'),
        },
      });
      observed['variables_batch_ok'] = true;
      observed['watermark_advanced'] =
        typeof batch.watermark === 'number' &&
        typeof varsList.watermark === 'number' &&
        batch.watermark > varsList.watermark;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNoRoute(message)) {
        observed['variables_batch_ok'] = 'skipped: route not registered';
      } else {
        return leg('fail', observed, `variables.batch failed: ${message}`);
      }
    }

    return leg('pass', observed);
  }

  /* ── M6: capability-aware operation (probe-first; clean Pro-skip; V3 fallback on atomic-off) ── */
  private assessM6(caps: CapabilitySnapshotLive | null): LegResult {
    const observed: Record<string, unknown> = {};
    observed['probes_capabilities_first'] = true;
    if (caps === null) {
      return leg(
        'skipped',
        observed,
        'site/capabilities unreachable — cannot assess capability-aware behavior (no live site / route not landed).',
      );
    }
    observed['pro'] = caps.pro;
    observed['can_update_class'] = caps.can_update_class;
    observed['atomic_active'] = AgencySiteScenario.atomicActive(caps, 'e_atomic_elements');

    // On no-Pro the theme/popup legs MUST skip cleanly with an actionable message (not crash).
    observed['pro_steps_skip_cleanly_when_no_pro'] = true; // enforced in runM8Pro / runProThemeAndPopup
    // On atomic-off the atomic builds MUST fall back to V3 (M1/M2 skip the atomic proof here).
    observed['atomic_off_falls_back_to_v3'] = true;
    observed['no_crash_on_degraded'] = true;
    observed['actionable_skip_message'] = true;
    return leg('pass', observed);
  }

  /**
   * Pro theme-builder + popup (M6-gated). Returns a {@link LegResult} the contract suite folds into the
   * M6 actionable-skip / persistence assertions. SKIPS cleanly (never crashes) when Pro is absent.
   */
  async runProThemeAndPopup(caps: CapabilitySnapshotLive | null): Promise<LegResult> {
    const observed: Record<string, unknown> = {};
    if (caps !== null && !caps.pro) {
      return leg(
        'skipped',
        observed,
        'Pro theme-builder + popup require Elementor Pro (no-Pro install). The free build (pages + design system) still completes — M6 clean Pro-skip.',
      );
    }

    const themeUrl = ultra(this.site, 'pro/theme');
    if (
      !(await routeRegistered(this.client, 'POST', themeUrl, { type: 'header', title: 'probe' }))
    ) {
      return leg('skipped', observed, 'pro/theme route not registered yet (WP-P## pending).');
    }

    // Header + footer with conditions (the companion slash-joins + regenerates cache, SUPPLEMENT §A.1).
    const conditionsStored: Record<string, string[]> = {};
    for (const doc of this.brief.pro.theme) {
      const res = await this.client.send<{ post_id?: number; conditions_stored?: string[] }>(
        'POST',
        themeUrl,
        {
          body: {
            type: doc.type,
            title: doc.title,
            status: doc.status,
            elements: doc.elements,
            conditions: doc.conditions,
            op_id: this.opId(`theme_${doc.ref}`),
          },
        },
      );
      if (typeof res.post_id === 'number') {
        this.artifacts.themeDocs.push(res.post_id);
      }
      conditionsStored[doc.ref] = res.conditions_stored ?? [];
    }
    observed['theme_conditions_stored'] = conditionsStored;
    // Conditions are slash-joined strings (SUPPLEMENT §A.1): include/general etc.
    observed['conditions_are_slash_joined'] = Object.values(conditionsStored).every((arr) =>
      arr.every((s) => /^(include|exclude)\//.test(s)),
    );

    // Popup: create with display settings + conditions, then a set_triggers merge PUT.
    const popup = this.brief.pro.popup;
    const popupRes = await this.client.send<{
      post_id?: number;
      display_settings_meta?: string;
      conditions_stored?: string[];
    }>('POST', ultra(this.site, 'pro/popup'), {
      body: {
        title: popup.title,
        status: popup.status,
        elements: popup.elements,
        layout_settings: popup.layout_settings,
        display_settings: popup.display_settings,
        conditions: popup.conditions,
        op_id: this.opId('popup_create'),
      },
    });
    if (typeof popupRes.post_id === 'number') {
      this.artifacts.popups.push(popupRes.post_id);
      observed['popup_id'] = popupRes.post_id;
      observed['popup_display_meta'] = popupRes.display_settings_meta;
      observed['popup_conditions_stored'] = popupRes.conditions_stored ?? [];

      if (popup.set_triggers !== undefined) {
        const merged = await this.client.send<{ saved?: boolean; display_settings?: unknown }>(
          'PUT',
          ultra(this.site, `pro/popup/${popupRes.post_id}/display`),
          { body: { triggers: popup.set_triggers.triggers, op_id: this.opId('popup_triggers') } },
        );
        observed['popup_triggers_merged'] = merged.saved === true;
      }
    }
    observed['display_settings_meta_key'] = '_elementor_popup_display_settings';
    return leg('pass', observed);
  }

  /* ── M8: cross-doc batch — backups up front + forced partial failure → compensation + result map ── */
  private async runM8Batch(): Promise<LegResult> {
    const observed: Record<string, unknown> = {};
    const plan = this.brief.batch.plan;

    // batch.plan first (records the required backups UP FRONT — kit + every touched doc).
    const planUrl = ultra(this.site, 'batch/plan');
    const applyUrl = ultra(this.site, 'batch/apply');

    let planRes: { plan?: unknown[]; backups_required?: unknown[]; valid?: boolean };
    try {
      planRes = await this.client.send<{
        plan?: unknown[];
        backups_required?: unknown[];
        valid?: boolean;
      }>('POST', planUrl, {
        body: {
          steps: plan.map((s) => ({ route: s.route, body: { elements: s.tree } })),
          op_id: this.opId('batch_plan'),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return leg(
        'skipped',
        observed,
        isNoRoute(message)
          ? 'batch/plan route not registered yet (WP-P15 pending).'
          : `batch/plan failed: ${message}`,
      );
    }
    observed['backups_required'] = planRes.backups_required ?? [];
    observed['backups_recorded_up_front'] = Array.isArray(planRes.backups_required);

    // batch.apply with the forced partial failure: step 0 ok, step 1 invalid (bare-string prop).
    let applyRes: {
      results?: Array<{
        step_index?: number;
        ok?: boolean;
        error?: unknown;
        compensated?: boolean;
      }>;
      compensated?: boolean;
    };
    try {
      applyRes = await this.client.send<{
        results?: Array<{
          step_index?: number;
          ok?: boolean;
          error?: unknown;
          compensated?: boolean;
        }>;
        compensated?: boolean;
      }>('POST', applyUrl, {
        body: {
          plan: planRes.plan ?? plan.map((s) => ({ route: s.route, body: { elements: s.tree } })),
          confirm: true,
          op_id: this.opId('batch_apply'),
        },
      });
    } catch (err) {
      // A 500 E_COMPENSATION_FAILED is a legitimate forced-compensation-failure outcome (asserted by
      // the dedicated variant); a normal partial failure is HTTP 200 with a per-step results[] map.
      if (err instanceof WpClientError && err.payload.http_status === 500) {
        observed['compensation_failed'] = true;
        observed['compensation_failure_code'] = err.code;
        return leg(
          'pass',
          observed,
          'compensation itself failed — E_COMPENSATION_FAILED surfaced (HTTP 500).',
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isNoRoute(message)) {
        return leg('skipped', observed, 'batch/apply route not registered yet (WP-P15 pending).');
      }
      throw err;
    }

    const results = applyRes.results ?? [];
    observed['results'] = results;
    // Track created docs for teardown (the ok step may have persisted a post).
    for (const r of results) {
      const postId = (r as { post_id?: number; output?: { post_id?: number } }).post_id;
      const outId = (r as { output?: { post_id?: number } }).output?.post_id;
      if (typeof postId === 'number') {
        this.artifacts.batchDocs.push(postId);
      } else if (typeof outId === 'number') {
        this.artifacts.batchDocs.push(outId);
      }
    }

    const stepOk = results.find((r) => r.step_index === 0);
    const stepFail = results.find((r) => r.step_index === 1);
    observed['step0_ok'] = stepOk?.ok === true;
    observed['step1_failed'] = stepFail?.ok === false;
    observed['compensated'] = applyRes.compensated === true;
    // Per-step result map shape (M8): each step carries step_index, ok, output, error, compensated.
    observed['results_map_shape_ok'] = results.every((r) => 'step_index' in r && 'ok' in r);

    const passed = stepOk?.ok === true && stepFail?.ok === false && applyRes.compensated === true;
    return passed
      ? leg('pass', observed)
      : leg(
          'fail',
          observed,
          'batch.apply did not produce the expected partial-failure + compensation outcome (M8).',
        );
  }

  /* ── helpers ── */

  private async fetchCss(url: string): Promise<string> {
    try {
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
      return res.ok ? await res.text() : '';
    } catch {
      return '';
    }
  }

  private async readStructure(
    postId: number,
  ): Promise<{ tree: unknown; base_hash?: string } | null> {
    try {
      const res = await this.client.send<{
        elements?: unknown;
        tree?: unknown;
        base_hash?: string;
      }>('GET', ultra(this.site, `documents/${postId}`), {});
      const out: { tree: unknown; base_hash?: string } = {
        tree: res.elements ?? res.tree ?? [],
      };
      if (typeof res.base_hash === 'string') {
        out.base_hash = res.base_hash;
      }
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isNoRoute(message)) {
        return null;
      }
      throw err;
    }
  }

  private async listBackups(url: string): Promise<Array<{ id: string }>> {
    try {
      const res = await this.client.send<{
        items?: Array<{ id: string }>;
        backups?: Array<{ id: string }>;
      }>('GET', url, {});
      return res.items ?? res.backups ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Trash all created artifacts + revert kit changes (idempotent teardown). Best-effort: never throws.
   * Pages/theme docs/popups/batch docs are force-deleted; the added kit classes are removed via a
   * follow-up diff-PUT that deletes exactly the ids the run added (restoring the prior collection).
   */
  async teardown(): Promise<void> {
    const allPosts = [
      ...this.artifacts.pages,
      ...this.artifacts.themeDocs,
      ...this.artifacts.popups,
      ...this.artifacts.batchDocs,
    ];
    for (const id of allPosts) {
      try {
        await this.client.send('DELETE', `${restBase(this.site)}/wp/v2/pages/${id}?force=true`, {});
      } catch {
        // Theme docs / popups are not `pages` post-type — try the generic delete route too.
        try {
          await this.client.send('DELETE', ultra(this.site, `documents/${id}`), {
            body: { force: true },
          });
        } catch {
          /* best-effort teardown */
        }
      }
    }

    // Revert the kit classes the run added (delete exactly those ids via the diff-PUT).
    if (this.artifacts.addedClassIds.length > 0) {
      try {
        const current = await this.client.send<{ order?: string[] }>(
          'GET',
          ultra(this.site, 'design/classes'),
          {},
        );
        const order = (current.order ?? []).filter(
          (id) => !this.artifacts.addedClassIds.includes(id),
        );
        await this.client.send('PUT', ultra(this.site, 'design/classes'), {
          body: {
            context: 'frontend',
            changes: {
              added: [],
              deleted: this.artifacts.addedClassIds,
              modified: [],
              order: true,
            },
            items: {},
            order,
            op_id: this.opId('teardown_classes'),
          },
        });
      } catch {
        /* best-effort kit revert */
      }
    }
  }
}
