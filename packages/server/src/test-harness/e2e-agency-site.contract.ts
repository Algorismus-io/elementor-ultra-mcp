/**
 * WP-Q07 — ULTRA milestone acceptance: "agency site from brief" (the integration capstone).
 *
 * This `*.contract.ts` suite (runs under `pnpm test:contract`, requires wp-env) DRIVES the
 * {@link AgencySiteScenario} orchestrator over the live MCP/REST surface and asserts the M1–M8
 * success-metric end-state (`00-product-overview.md §6`) against `expected.outcomes.json`. It is the
 * acceptance test for the ULTRA milestone — it proves the per-unit verticals (Q01/Q04/Q05/Q06) hold
 * together as a SYSTEM, not just per unit. It reuses the WP-Q06 styled-render assertion (M1) and
 * composes the design/Pro/batch verticals it exercises.
 *
 * GATING: each leg feature-detects its REST route; an unregistered route makes the leg `skipped` with
 * an actionable message (never a hard fail) so the scenario lands incrementally as the verticals
 * (WP-P##/T##/H##) ship — the SAME skip-not-fail discipline as `dry-run-roundtrip.contract.ts` and
 * `render-assertion.contract.ts`. When no live site is configured (no `WP_URL/WP_USER/WP_APP_PASSWORD`)
 * the whole suite skips with a clear reason.
 *
 * IDEMPOTENT: the scenario trashes ALL created posts/templates/popups + reverts kit changes in
 * `afterAll` (teardown), so a re-run is clean.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { WpClient } from '../wp/client.js';
import {
  AgencySiteScenario,
  loadBrief,
  loadExpectedOutcomes,
  siteFromEnv,
  type AgencyBrief,
  type LegResult,
  type ScenarioResult,
} from './e2e-scenario.js';

const site = siteFromEnv();
const SKIP_NO_ENV = site === null;

/** Probe whether ANY elementor-ultra/v1 route is reachable (the surface is registered at all). */
async function surfaceReachable(client: WpClient, baseUrl: string): Promise<boolean> {
  try {
    await client.send(
      'GET',
      `${baseUrl.replace(/\/+$/, '')}/wp-json/elementor-ultra/v1/site/capabilities`,
      {},
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A 404 rest_no_route ⇒ the whole namespace is unregistered (plugin not active / no controllers).
    return !/no_route/i.test(message);
  }
}

/** Assert a leg is acceptable: it either PASSED, or SKIPPED with an actionable (non-empty) reason. */
function expectLegOkOrSkipped(label: string, legR: LegResult): void {
  if (legR.status === 'skipped') {
    expect(legR.reason, `${label} skip must carry an actionable reason`).toBeTruthy();
    console.warn(`[e2e-agency-site] SKIP ${label}: ${legR.reason}`);
    return;
  }
  expect(legR.status, `${label} must pass (or skip with a reason): ${legR.reason ?? ''}`).toBe(
    'pass',
  );
}

describe('e2e agency site from brief (ULTRA milestone — M1-M8 acceptance)', () => {
  const brief: AgencyBrief = loadBrief();
  const expected = loadExpectedOutcomes();
  let scenario: AgencySiteScenario | undefined;
  let result: ScenarioResult | undefined;
  let proLeg: LegResult | undefined;
  let reachable = false;

  beforeAll(async () => {
    if (site === null) {
      return;
    }
    const client = new WpClient({ site });
    reachable = await surfaceReachable(client, site.url);
    if (!reachable) {
      return;
    }
    scenario = new AgencySiteScenario(site, brief);
    result = await scenario.run();
    // The Pro theme/popup leg is run explicitly (it tracks artifacts for teardown + M6 Pro-skip).
    proLeg = await scenario.runProThemeAndPopup(result.capabilities);
  }, 180_000);

  afterAll(async () => {
    if (scenario !== undefined) {
      await scenario.teardown();
    }
  }, 120_000);

  /* ── corpus presence (always runs, no WP) ── */

  it('loads the declarative brief + expected outcomes', () => {
    expect(brief.$e2e).toBe(1);
    expect(brief.id).toBe('brief.agency-site');
    expect(brief.pages.some((p) => p.is_hero)).toBe(true);
    expect((expected as { metrics?: unknown }).metrics).toBeDefined();
  });

  it('the brief exercises every ULTRA vertical (pages + design + Pro + batch)', () => {
    expect(brief.pages.length).toBeGreaterThanOrEqual(2);
    expect(brief.design_system.classes.add.length).toBeGreaterThan(0);
    expect(brief.design_system.classes.seed_duplicate_label).toBeDefined();
    expect(brief.design_system.variables.operations.length).toBeGreaterThan(0);
    expect(brief.pro.theme.length).toBeGreaterThanOrEqual(2);
    expect(brief.pro.popup).toBeDefined();
    // M8: the batch plan carries a deliberately invalid step (the forced partial failure).
    expect(brief.batch.plan.some((s) => s.expect_ok === false)).toBe(true);
  });

  it('the forced-failure batch step is invalid by construction (bare-string prop, [R8])', () => {
    const failStep = brief.batch.plan.find((s) => s.expect_ok === false);
    expect(failStep).toBeDefined();
    expect(failStep?.expected_error_code).toBe('E_ATOMIC_VALIDATION');
    // A bare string `tag` (not a {$$type,value} envelope) — the live validator rejects it.
    const node = failStep?.tree[0] as Record<string, unknown> | undefined;
    const settings = node?.['settings'] as Record<string, unknown> | undefined;
    expect(typeof settings?.['tag']).toBe('string');
  });

  /* ── live legs (skip cleanly when the route / site is unavailable) ── */

  it('runs against the live MCP/REST surface (or skips with reason)', () => {
    if (SKIP_NO_ENV) {
      console.warn(
        '[e2e-agency-site] SKIP: WP_URL/WP_USER/WP_APP_PASSWORD not set (no live site).',
      );
      return;
    }
    if (!reachable) {
      console.warn(
        '[e2e-agency-site] SKIP: elementor-ultra/v1 namespace unreachable (plugin inactive / controllers pending).',
      );
      return;
    }
    expect(result).toBeDefined();
    expect(result?.ranAgainstSite).toBe(true);
  });

  it('M1 — hero renders styled (public CSS has the local + global class rules)', () => {
    if (SKIP_NO_ENV || !reachable || result === undefined) {
      console.warn('[e2e-agency-site] SKIP M1: live surface unavailable.');
      return;
    }
    expectLegOkOrSkipped('M1', result.M1);
    if (result.M1.status === 'pass') {
      expect(result.M1.observed['hero_page_created']).toBe(true);
      expect(result.M1.observed['css_primed']).toBe(true);
      expect(result.M1.observed['global_class_rule_present']).toBe(true);
    }
  });

  it('M2 — safe edit (diff + dry_run) then rollback restores prior tree + re-primes CSS', () => {
    if (SKIP_NO_ENV || !reachable || result === undefined) {
      console.warn('[e2e-agency-site] SKIP M2: live surface unavailable.');
      return;
    }
    expectLegOkOrSkipped('M2', result.M2);
    if (result.M2.status === 'pass') {
      expect(result.M2.observed['edit_produced_diff']).toBe(true);
      expect(result.M2.observed['edit_passed_dry_run']).toBe(true);
      expect(result.M2.observed['rollback_restored_prior_tree']).toBe(true);
      expect(result.M2.observed['rollback_reprimed_css']).toBe(true);
    }
  });

  it('M5 — class diff-PUT (budget pre-flight) + DUPLICATED_LABEL reconcile + variables.batch', () => {
    if (SKIP_NO_ENV || !reachable || result === undefined) {
      console.warn('[e2e-agency-site] SKIP M5: live surface unavailable.');
      return;
    }
    expectLegOkOrSkipped('M5', result.M5);
    if (result.M5.status === 'pass') {
      expect(result.M5.observed['budget_preflighted']).toBe(true);
      expect(result.M5.observed['budget_max_allowed']).toBe(1000);
      expect(result.M5.observed['classes_put_ok']).toBe(true);
      // The seeded duplicate label produced a non-empty modified_labels soft outcome (a 200).
      expect(result.M5.observed['duplicated_label_reconciled']).toBe(true);
    }
  });

  it('M6 — capability-aware: probes site/capabilities first; clean Pro-skip / V3 fallback, no crash', () => {
    if (SKIP_NO_ENV || !reachable || result === undefined) {
      console.warn('[e2e-agency-site] SKIP M6: live surface unavailable.');
      return;
    }
    expectLegOkOrSkipped('M6', result.M6);
    expect(result.M6.observed['probes_capabilities_first']).toBe(true);
    // The Pro theme/popup leg MUST be pass (Pro present) OR a clean skip with an actionable message.
    if (proLeg !== undefined) {
      expectLegOkOrSkipped('M6/pro', proLeg);
      const caps = result.capabilities;
      if (caps !== null && !caps.pro) {
        // No-Pro install: the Pro leg MUST have skipped (never thrown) — that is the M6 guarantee.
        expect(proLeg.status).toBe('skipped');
      }
      if (proLeg.status === 'pass') {
        // Conditions persisted as slash-joined strings (SUPPLEMENT §A.1).
        expect(proLeg.observed['conditions_are_slash_joined']).toBe(true);
        expect(proLeg.observed['display_settings_meta_key']).toBe(
          '_elementor_popup_display_settings',
        );
      }
    }
  });

  it('M8 — batch records backups up front, partial failure compensates, per-step result map', () => {
    if (SKIP_NO_ENV || !reachable || result === undefined) {
      console.warn('[e2e-agency-site] SKIP M8: live surface unavailable.');
      return;
    }
    expectLegOkOrSkipped('M8', result.M8);
    if (result.M8.status === 'pass') {
      // Either the normal partial-failure-with-compensation outcome OR the forced compensation
      // failure surfacing E_COMPENSATION_FAILED (the dedicated variant) is acceptable.
      const obs = result.M8.observed;
      if (obs['compensation_failed'] === true) {
        expect(obs['compensation_failure_code']).toBeDefined();
      } else {
        expect(obs['backups_recorded_up_front']).toBe(true);
        expect(obs['step0_ok']).toBe(true);
        expect(obs['step1_failed']).toBe(true);
        expect(obs['compensated']).toBe(true);
        expect(obs['results_map_shape_ok']).toBe(true);
      }
    }
  });

  it('the expected-outcomes map covers M1, M2, M5, M6, M8 with the contract end-state', () => {
    const metrics = (expected as { metrics?: Record<string, unknown> }).metrics ?? {};
    for (const m of ['M1', 'M2', 'M5', 'M6', 'M8']) {
      expect(metrics[m], `expected.outcomes.json must encode ${m}`).toBeDefined();
    }
    // M8 encodes the E_COMPENSATION_FAILED surface + the per-step result map shape (12-error-taxonomy).
    const m8 = metrics['M8'] as Record<string, unknown>;
    expect(m8['compensation_failure_surfaces_code']).toBe('E_COMPENSATION_FAILED');
    expect((m8['results_map_shape'] as { step_fields?: string[] })?.step_fields).toEqual([
      'step_index',
      'ok',
      'output',
      'error',
      'compensated',
    ]);
  });
});
