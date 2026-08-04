/**
 * WP-Q02 — Deterministic normalizer for live Elementor `get_props_schema()` snapshots
 * (`14-fixtures-harness.md §5 step 3`).
 *
 * The schema-drift guard byte-diffs a LIVE post-filter `get_props_schema()` (per widget) and the live
 * `Style_Schema::get()` against committed baselines (`packages/shared/fixtures/schemas/*.schema.json`).
 * Raw Elementor `Prop_Type::jsonSerialize()` output is NOT diff-stable: it interleaves volatile,
 * human-facing fields (`meta.description`, `meta.label`) and volatile runtime fields (`initial_value`)
 * with the load-bearing contract (prop NAMES, `$$type`/`key` discriminators, ENUM members, REQUIRED /
 * dependency flags, UNIT presets, defaults). This module reduces a raw schema to ONLY the contract
 * surface, with every object key stably sorted, so a serialized snapshot is byte-deterministic and any
 * Elementor version bump (an added/removed/changed prop, a flipped enum member, a new unit) surfaces as
 * a minimal diff (`§5 step 5`).
 *
 * The SAME normalizer is used by the manual `fixtures:snapshot-schemas` script (WP-F06) that writes the
 * baselines and by the `schema-drift.test.ts` job that re-fetches + diffs them, so the two can never
 * disagree about the canonical form (`§5`).
 *
 * Normalization rules (`§5 step 3`):
 *   - KEEP   prop names (object keys), `$$type` / `key` discriminators, enum members, required /
 *            `dependencies` flags, unit presets, and defaults (a default change IS contract drift).
 *   - STRIP  volatile human-facing fields (`meta` — labels/descriptions) and volatile runtime fields
 *            (`initial_value`); drop empty `dependencies:null` / `settings:[]` noise so an additive,
 *            non-semantic Elementor serialization tweak does not show as drift.
 *   - SORT   every object's keys lexicographically (arrays keep their order — enum / unit ORDER is part
 *            of the contract; a reordered enum is a real, reviewable change).
 *
 * AUTHORITY: PHP `get_props_schema()` (post-filter, `has-atomic-base.php:310-321`) is the source of
 * truth for the live shape; this module only canonicalizes it. The baseline is NEVER auto-updated by
 * the drift job (`§5`); regeneration is the manual, reviewed `fixtures:snapshot-schemas`.
 */

/** A JSON value (the shape `JSON.parse` / a raw schema fetch yields). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A normalized schema is a stable-sorted JSON object (prop-name → normalized prop-type). */
export type NormalizedSchema = { [key: string]: JsonValue };

/**
 * Volatile, human-facing keys stripped at EVERY depth: descriptions/labels never affect validity and
 * churn between Elementor releases (`§5 step 3` "strip volatile fields like labels/descriptions").
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set<string>([
  'meta', // { description, label } — human-facing only
  'initial_value', // volatile runtime-resolved value, never part of the authoring contract
]);

/** True when `value` is a non-null plain object (record). */
function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when an entry is structural NOISE that should be dropped so a non-semantic serialization tweak
 * never registers as drift: an empty-object/empty-array `settings`, a `null`/empty `dependencies`, or a
 * `null` `default`. Enum-/unit-bearing `settings` (a non-empty object) is KEPT. Called only AFTER the
 * value itself has been normalized (so emptiness is checked on the canonical form).
 */
function isDroppableNoise(key: string, value: JsonValue): boolean {
  if (key === 'dependencies') {
    if (value === null) {
      return true;
    }
    if (Array.isArray(value) && value.length === 0) {
      return true;
    }
    if (isRecord(value) && Object.keys(value).length === 0) {
      return true;
    }
    return false;
  }
  if (key === 'settings') {
    if (Array.isArray(value) && value.length === 0) {
      return true;
    }
    if (isRecord(value) && Object.keys(value).length === 0) {
      return true;
    }
    return false;
  }
  if (key === 'default' && value === null) {
    return true;
  }
  return false;
}

/**
 * Recursively normalize an arbitrary JSON value: strip {@link VOLATILE_KEYS}, drop structural noise
 * ({@link isDroppableNoise}), and stable-sort every object's keys. Array element ORDER is preserved
 * (enum/unit order is contract).
 */
function normalizeValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (VOLATILE_KEYS.has(key)) {
        continue;
      }
      const normalizedChild = normalizeValue(value[key] as JsonValue);
      if (isDroppableNoise(key, normalizedChild)) {
        continue;
      }
      out[key] = normalizedChild;
    }
    return out;
  }
  // Primitives (string/number/boolean/null) pass through unchanged.
  return value;
}

/**
 * Normalize a single live widget/style schema object (prop-name → raw `Prop_Type::jsonSerialize()`)
 * into the canonical, byte-diffable baseline form. The top level is itself stable-sorted so the prop
 * ENUMERATION order does not churn — an ADDED or REMOVED prop is the only thing that moves the keys.
 */
export function normalizeSchema(raw: unknown): NormalizedSchema {
  if (!isRecord(raw)) {
    throw new TypeError(
      `normalizeSchema: expected a schema object (prop-name → prop-type), got ${
        raw === null ? 'null' : typeof raw
      }.`,
    );
  }
  return normalizeValue(raw) as NormalizedSchema;
}

/**
 * Serialize a normalized schema to the EXACT byte form committed as a baseline + produced by the drift
 * fetch: 2-space-indented JSON with a trailing newline. Because {@link normalizeSchema} already
 * stable-sorts, `JSON.stringify` emits keys in that stable order, so two equal schemas serialize to
 * identical bytes (`§5 step 4` byte-diff).
 */
export function serializeNormalizedSchema(schema: NormalizedSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/** A per-prop drift delta for the human-readable failure message (`§5 step 5`). */
export interface SchemaDelta {
  /** Prop names present in the live schema but missing from the baseline. */
  added: string[];
  /** Prop names present in the baseline but missing from the live schema. */
  removed: string[];
  /** Prop names present in both whose normalized prop-type bodies differ. */
  changed: string[];
}

/** True when the delta carries no added/removed/changed props (the schemas match). */
export function isEmptyDelta(delta: SchemaDelta): boolean {
  return delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0;
}

/**
 * Compute the per-prop {@link SchemaDelta} between a committed `baseline` and a freshly-normalized
 * `live` schema. Both MUST already be normalized ({@link normalizeSchema}); the comparison is a
 * deterministic JSON deep-equal per prop. The drift test renders this into a readable per-widget
 * message so a maintainer can either regenerate (intentional bump) or investigate (`§5 step 5`).
 */
export function diffSchemas(baseline: NormalizedSchema, live: NormalizedSchema): SchemaDelta {
  const baselineKeys = new Set(Object.keys(baseline));
  const liveKeys = new Set(Object.keys(live));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const key of liveKeys) {
    if (!baselineKeys.has(key)) {
      added.push(key);
    }
  }
  for (const key of baselineKeys) {
    if (!liveKeys.has(key)) {
      removed.push(key);
    }
  }
  for (const key of liveKeys) {
    if (!baselineKeys.has(key)) {
      continue;
    }
    if (!deepEqual(baseline[key] as JsonValue, live[key] as JsonValue)) {
      changed.push(key);
    }
  }

  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

/**
 * Render a {@link SchemaDelta} for a named widget/schema into a single readable line set for the drift
 * failure message (`§5 step 5`): explicit added / removed / changed prop lists so the maintainer sees
 * exactly what moved.
 */
export function formatDelta(name: string, delta: SchemaDelta): string {
  if (isEmptyDelta(delta)) {
    return `${name}: no drift.`;
  }
  const parts: string[] = [];
  if (delta.added.length > 0) {
    parts.push(`added props [${delta.added.join(', ')}]`);
  }
  if (delta.removed.length > 0) {
    parts.push(`removed props [${delta.removed.join(', ')}]`);
  }
  if (delta.changed.length > 0) {
    parts.push(`changed props [${delta.changed.join(', ')}]`);
  }
  return `${name}: ${parts.join('; ')}.`;
}

/**
 * Deterministic deep-equality over normalized JSON values. Object key ORDER is irrelevant (both sides
 * are normalized + sorted, but this is order-independent regardless); array order IS significant (enum
 * / unit order is contract). Pure — no `JSON.stringify` reliance so it cannot be fooled by key order.
 */
export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i] as JsonValue, b[i] as JsonValue)) {
        return false;
      }
    }
    return true;
  }
  if (isRecord(a) && isRecord(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) {
      return false;
    }
    for (const key of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) {
        return false;
      }
      if (!deepEqual(a[key] as JsonValue, b[key] as JsonValue)) {
        return false;
      }
    }
    return true;
  }
  // One is a primitive and the other an object/array, or differing primitives.
  return false;
}
