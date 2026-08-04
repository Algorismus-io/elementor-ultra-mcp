/**
 * WP-F06 — TS fixture loader (the single point that interprets the LOCKED envelope).
 *
 * Reads the ONE copy of every golden fixture under `packages/shared/fixtures/`
 * (`14-fixtures-harness.md §1`), validates each against the envelope schema (§2) + the embedded
 * `tree[]` against the WP-F03 authoring schemas, and filters by the `requires` capability gates
 * (skips unmet, §2). The PHP loader (`tests/class-fixture-loader.php`) mirrors this byte-for-byte so
 * TS and PHP agree on what runs and what is skipped.
 *
 * AUTHORITY: `expect.valid` is the PHP `dry_run` verdict (§3) — this loader only PARSES + GATES; it
 * never decides validity. The Ajv validators come from `@elementor-ultra/shared` (the runtime mirror
 * of the five frozen authoring schemas).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import type { ElementNode } from '../authoring/contract.js';

/* ───────────────────────────── envelope types (mirror §2 / envelope.schema.json) ──────────── */

/** The three-way pre-filter verdict carried by a fixture (`14-fixtures-harness.md §4`). */
export type FixtureVerdict = 'accept' | 'reject' | 'defer';

/** Fixture family (`14-fixtures-harness.md §2`). */
export type FixtureKind = 'tree' | 'design' | 'html' | 'roundtrip' | 'smoke';

/** Capability gates; a fixture whose `requires` are unmet on the target install is SKIPPED. */
export interface FixtureRequires {
  experiments?: string[];
  pro?: boolean;
  min_elementor?: string;
}

/** The settings deep-merge regression block ([S04/C3/R3] spike correction). */
export interface MergeRegression {
  seed: Record<string, unknown>;
  patch: Record<string, unknown>;
  /** Dotted paths whose values MUST be unchanged after the patch. */
  survives: Record<string, unknown>;
  /** Dotted paths whose values MUST equal the patched values after the patch. */
  updates: Record<string, unknown>;
}

/** The LOCKED fixture envelope (`14-fixtures-harness.md §2`). */
export interface FixtureEnvelope {
  $fixture: 1;
  id: string;
  kind: FixtureKind;
  generation: 'v4' | 'v3' | 'mixed';
  title?: string;
  expect: { valid: boolean; errors?: string[] };
  requires?: FixtureRequires;
  tree?: ElementNode[];
  settings?: Record<string, unknown>;
  prefilter?: { verdict: FixtureVerdict };
  input_tree?: ElementNode[];
  normalized_expected?: ElementNode[];
  tool?: string;
  arguments?: Record<string, unknown>;
  merge_regression?: MergeRegression;
  _comment?: string;
}

/** A loaded fixture: the envelope + the absolute path + the directory it came from. */
export interface LoadedFixture {
  envelope: FixtureEnvelope;
  /** Absolute path to the fixture JSON file. */
  path: string;
  /** Sub-directory under `fixtures/` (e.g. `trees/v4/valid`). */
  relativeDir: string;
}

/** The capability snapshot a fixture's `requires` is evaluated against (the §4 / §3 gate). */
export interface CapabilitySnapshot {
  /** Active experiment slugs on the target site. */
  experiments: string[];
  /** Whether Elementor Pro is active. */
  pro: boolean;
  /** The target Elementor version (e.g. `4.1.1`). */
  elementor_version?: string;
}

/* ───────────────────────────── directory resolution ──────────────────────────────────────── */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to `packages/shared/fixtures`. Resolved relative to THIS module so it works from
 * `src/` (vitest, ts) and `dist/` (built) identically: from `packages/server/{src|dist}/test-harness`
 * up to the repo, then into `packages/shared/fixtures`.
 */
export const FIXTURES_DIR = resolve(HERE, '..', '..', '..', 'shared', 'fixtures');

/** The fixture sub-directories that hold `*.json` fixtures (envelope-bearing). */
const FIXTURE_SUBDIRS = [
  'trees/v4/valid',
  'trees/v4/invalid',
  'trees/v3/valid',
  'trees/v3/invalid',
  'trees/design',
  'roundtrip',
  'envelopes',
] as const;

/* ───────────────────────────── validation (envelope + authoring tree) ─────────────────────── */

/** Absolute path to the runtime mirror of the five frozen authoring schemas (`packages/shared/schemas`). */
const SCHEMAS_DIR = resolve(HERE, '..', '..', '..', 'shared', 'schemas');

/** The five frozen authoring schema filenames (`11-authoring-contract.md §1`). */
const AUTHORING_SCHEMA_FILES = [
  'atomic-prop-types.schema.json',
  'style-variant.schema.json',
  'element-node.schema.json',
  'page-tree.schema.json',
  'diff.schema.json',
] as const;

/** The `$id` base the authoring schemas cross-`$ref` against (bare-filename refs resolve here). */
const ELEMENT_NODE_REF =
  'https://elementor-ultra-mcp/spec/contracts/schemas/element-node.schema.json#/$defs/ElementNode';

/**
 * Build an Ajv (draft 2020-12) with the five authoring schemas registered by `$id` (so cross-`$ref`
 * resolution works) PLUS the fixture envelope schema. `strict:false` because the frozen schemas use
 * `examples`/`$comment`/conditional shapes Ajv strict mode flags. Mirrors the shared `createAjv()` but
 * reads the JSON from disk so this module has NO dependency on the (uncompiled) shared schemas barrel.
 */
/** The Ajv 2020 instance type (avoids using the default-import binding directly as a type). */
type AjvInstance = InstanceType<typeof Ajv2020>;

function buildAjv(): AjvInstance {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const file of AUTHORING_SCHEMA_FILES) {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8')) as AnySchemaObject;
    ajv.addSchema(schema);
  }
  const envelope = JSON.parse(
    readFileSync(join(FIXTURES_DIR, 'envelope.schema.json'), 'utf8'),
  ) as AnySchemaObject;
  ajv.addSchema(envelope, 'fixture-envelope');
  return ajv;
}

let ajvInstance: AjvInstance | undefined;
function ajv(): AjvInstance {
  if (ajvInstance === undefined) {
    ajvInstance = buildAjv();
  }
  return ajvInstance;
}

let envelopeValidate: ValidateFunction | undefined;
let elementNodeValidate: ValidateFunction | undefined;

function getEnvelopeValidator(): ValidateFunction {
  if (envelopeValidate === undefined) {
    envelopeValidate = ajv().getSchema('fixture-envelope') as ValidateFunction;
  }
  return envelopeValidate;
}

/** A validator for a single `ElementNode` (the authoring `element-node.schema.json#/$defs/ElementNode`). */
function getElementNodeValidator(): ValidateFunction {
  if (elementNodeValidate === undefined) {
    elementNodeValidate =
      (ajv().getSchema(ELEMENT_NODE_REF) as ValidateFunction | undefined) ??
      ajv().compile({ $ref: ELEMENT_NODE_REF });
  }
  return elementNodeValidate;
}

/** A structured validation problem for `fixtures:validate` reporting. */
export interface FixtureValidationIssue {
  path: string;
  message: string;
}

/**
 * Validate a single fixture object against the envelope schema (§2) AND, where the tree is meant to
 * be structurally well-formed, the embedded `tree[]`/`input_tree[]` against the authoring
 * ElementNode schema. Authoring-tree validation is SKIPPED for `prefilter.verdict === 'reject'`
 * fixtures — those carry a deliberately malformed tree by design (e.g. bare-string props, [R8]); the
 * envelope is still validated and the reject is asserted by the pre-filter + PHP `dry_run`.
 *
 * Returns the list of issues (empty ⇒ valid).
 */
export function validateFixtureObject(obj: unknown, label: string): FixtureValidationIssue[] {
  const issues: FixtureValidationIssue[] = [];
  const validateEnvelope = getEnvelopeValidator();
  if (!validateEnvelope(obj)) {
    for (const e of validateEnvelope.errors ?? []) {
      issues.push({ path: `${label}${e.instancePath}`, message: e.message ?? 'invalid' });
    }
    // If the envelope itself is malformed, do not also run the tree check (it may be junk).
    return issues;
  }

  const env = obj as FixtureEnvelope;

  // Authoring-tree conformance: only for well-formed-by-design trees (not deliberate rejects).
  const isDeliberateReject = env.prefilter?.verdict === 'reject';
  if (!isDeliberateReject) {
    const trees: Array<{ key: string; nodes: ElementNode[] | undefined }> = [
      { key: 'tree', nodes: env.tree },
      { key: 'input_tree', nodes: env.input_tree },
      { key: 'normalized_expected', nodes: env.normalized_expected },
    ];
    const validateNode = getElementNodeValidator();
    for (const { key, nodes } of trees) {
      if (nodes === undefined) {
        continue;
      }
      nodes.forEach((node, i) => {
        if (!validateNode(node)) {
          for (const e of validateNode.errors ?? []) {
            issues.push({
              path: `${label}/${key}/${i}${e.instancePath}`,
              message: e.message ?? 'invalid ElementNode',
            });
          }
        }
      });
    }
  }

  return issues;
}

/* ───────────────────────────── loading ───────────────────────────────────────────────────── */

/** Read + JSON-parse a fixture file into a typed envelope (does NOT validate; use the validator). */
export function readFixtureFile(absPath: string): FixtureEnvelope {
  const raw = readFileSync(absPath, 'utf8');
  return JSON.parse(raw) as FixtureEnvelope;
}

/**
 * Load every `*.json` fixture under `packages/shared/fixtures/` (across the known sub-dirs),
 * skipping `.gitkeep` and any non-`.json` file. Does NOT filter by capability — that is
 * {@link isFixtureRunnable} / {@link loadRunnableFixtures}. Returns them sorted by path for
 * deterministic ordering.
 */
export function loadAllFixtures(): LoadedFixture[] {
  const out: LoadedFixture[] = [];
  for (const sub of FIXTURE_SUBDIRS) {
    const dir = join(FIXTURES_DIR, sub);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const path = join(dir, name);
      const envelope = readFixtureFile(path);
      out.push({ envelope, path, relativeDir: sub });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Load only fixtures of a given `kind` (e.g. `'tree'`, `'roundtrip'`, `'smoke'`, `'design'`). */
export function loadFixturesByKind(kind: FixtureKind): LoadedFixture[] {
  return loadAllFixtures().filter((f) => f.envelope.kind === kind);
}

/* ───────────────────────────── capability gating (mirror PHP) ─────────────────────────────── */

/** Compare two dotted version strings (e.g. `4.1.1` vs `4.1.0`). Returns -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The single capability-gate predicate (`14-fixtures-harness.md §2`/§3 step 1). The PHP loader
 * mirrors this EXACTLY so both runners skip the same fixtures given the same capability payload:
 *   - every `requires.experiments` slug must be active,
 *   - if `requires.pro` is true, Pro must be active,
 *   - the site's Elementor version must be ≥ `requires.min_elementor`.
 * A fixture with no `requires` is always runnable.
 */
export function isFixtureRunnable(env: FixtureEnvelope, caps: CapabilitySnapshot): boolean {
  const req = env.requires;
  if (req === undefined) {
    return true;
  }
  if (req.experiments !== undefined) {
    for (const slug of req.experiments) {
      if (!caps.experiments.includes(slug)) {
        return false;
      }
    }
  }
  if (req.pro === true && !caps.pro) {
    return false;
  }
  if (req.min_elementor !== undefined && caps.elementor_version !== undefined) {
    if (compareVersions(caps.elementor_version, req.min_elementor) < 0) {
      return false;
    }
  }
  return true;
}

/** Load every fixture, partitioned into runnable vs skipped given a capability snapshot. */
export function loadRunnableFixtures(caps: CapabilitySnapshot): {
  runnable: LoadedFixture[];
  skipped: LoadedFixture[];
} {
  const runnable: LoadedFixture[] = [];
  const skipped: LoadedFixture[] = [];
  for (const f of loadAllFixtures()) {
    if (isFixtureRunnable(f.envelope, caps)) {
      runnable.push(f);
    } else {
      skipped.push(f);
    }
  }
  return { runnable, skipped };
}

/** A human label for a fixture (its id, falling back to the filename). */
export function fixtureLabel(f: LoadedFixture): string {
  return f.envelope.id || basename(f.path, '.json');
}
