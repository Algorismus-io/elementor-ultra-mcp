/**
 * WP-F06 — Test-harness public surface.
 *
 * Re-exports the fixture loader (the single point that interprets the LOCKED envelope) and the smoke
 * suite's frozen expectation constants (lean ★ set, resource URIs, prompt names) so other WPs and the
 * `fixtures:validate` / `fixtures:snapshot-schemas` scripts can reuse them without reaching into the
 * runner files. The `*.contract.ts` / `*.test.ts` / `inspector-smoke.ts` runners are NOT re-exported —
 * they are entry points run by the test runner, not library modules (`14-fixtures-harness.md §1/§10`).
 */

export {
  FIXTURES_DIR,
  loadAllFixtures,
  loadFixturesByKind,
  readFixtureFile,
  validateFixtureObject,
  isFixtureRunnable,
  loadRunnableFixtures,
  compareVersions,
  fixtureLabel,
} from './fixture-loader.js';

export type {
  FixtureEnvelope,
  FixtureKind,
  FixtureVerdict,
  FixtureRequires,
  MergeRegression,
  LoadedFixture,
  CapabilitySnapshot,
  FixtureValidationIssue,
} from './fixture-loader.js';

export { LEAN_STAR_TOOLS, META_TOOLS, RESOURCE_URIS, PROMPT_NAMES } from './inspector-smoke.js';
