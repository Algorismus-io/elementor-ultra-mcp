/**
 * @elementor-ultra/shared — JSON Schema registry + compiled Ajv validators (WP-F03).
 *
 * This module is the RUNTIME MIRROR of the five FROZEN authoring schemas that live
 * (as the canonical source) at `spec/contracts/schemas/*.schema.json`. The copies in
 * THIS directory (`packages/shared/schemas/*.schema.json`) are kept byte-identical to
 * the spec originals by `scripts/sync-schemas.mjs` (which fails CI on any drift —
 * `14-fixtures-harness.md §10`, `15-engineering-standards.md §5.5`: contracts are the
 * source, shared is the mirror).
 *
 * The schemas cross-reference each other by BARE FILENAME (e.g.
 * `atomic-prop-types.schema.json#/$defs/TypedValue`). Each schema carries a stable
 * `$id` of the form `https://elementor-ultra-mcp/spec/contracts/schemas/<name>.schema.json`,
 * so a bare-filename `$ref` resolves against that base URI to the sibling schema's `$id`.
 * Registering all five by `$id` is therefore sufficient for cross-`$ref` resolution.
 *
 * AUTHORITY NOTE: these validators are STRUCTURAL only. The PHP `dry_run` endpoint
 * (WP-P03) is the SINGLE SOURCE OF TRUTH for atomic settings/styles validity
 * (`11-authoring-contract.md §8`, `14-fixtures-harness.md §0`). These Ajv validators
 * are used to (a) validate fixture files against the envelope/node shapes
 * (`pnpm fixtures:validate`, WP-F06) and (b) meta-validate the schemas themselves.
 * They are NOT the write-path pre-filter — that is the hand-authored cheap subset in
 * `packages/server/src/authoring/prefilter.ts`.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import type { AnySchemaObject, ValidateFunction } from 'ajv';

import atomicPropTypesSchema from './atomic-prop-types.schema.json' with { type: 'json' };
import styleVariantSchema from './style-variant.schema.json' with { type: 'json' };
import elementNodeSchema from './element-node.schema.json' with { type: 'json' };
import pageTreeSchema from './page-tree.schema.json' with { type: 'json' };
import diffSchema from './diff.schema.json' with { type: 'json' };
import pageSettingsSchema from './page-settings.schema.json' with { type: 'json' };

/**
 * The frozen schemas, as plain JSON objects (the runtime mirror): the five authoring schemas plus
 * the contract-18 §7-AI S1 document-settings allowlist (`page-settings`).
 */
export const schemas = {
  'atomic-prop-types': atomicPropTypesSchema as AnySchemaObject,
  'style-variant': styleVariantSchema as AnySchemaObject,
  'element-node': elementNodeSchema as AnySchemaObject,
  'page-tree': pageTreeSchema as AnySchemaObject,
  diff: diffSchema as AnySchemaObject,
  'page-settings': pageSettingsSchema as AnySchemaObject,
} as const;

/** Stable key set for the frozen schemas (used by the sync guard + drift tests). */
export type SchemaKey = keyof typeof schemas;

/** Ordered list of schema keys (deterministic for snapshot/sync). */
export const SCHEMA_KEYS: readonly SchemaKey[] = [
  'atomic-prop-types',
  'style-variant',
  'element-node',
  'page-tree',
  'diff',
  'page-settings',
] as const;

/**
 * Build an Ajv (draft 2020-12) instance with ALL five schemas registered by `$id`
 * so cross-`$ref` resolution works. `strict:false` because the frozen schemas use
 * `examples`/`$comment` and conditional `if/then/else` shapes that Ajv strict mode
 * flags as ambiguous — the schemas are the contract, not Ajv's opinion of them.
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    // The schemas reference each other by $id; add them all up front.
    schemas: [
      atomicPropTypesSchema,
      styleVariantSchema,
      elementNodeSchema,
      pageTreeSchema,
      diffSchema,
      pageSettingsSchema,
    ] as AnySchemaObject[],
  });
  return ajv;
}

/** A single shared Ajv instance with the five schemas registered. */
const sharedAjv = createAjv();

/** Resolve a registered schema's `$id` from its short key. */
function schemaId(key: SchemaKey): string {
  const id = (schemas[key] as { $id?: string }).$id;
  if (id === undefined) {
    throw new Error(`schema "${key}" is missing a $id`);
  }
  return id;
}

/**
 * Get a compiled Ajv validator for one of the five top-level schemas. The validator
 * checks the schema's ROOT shape (each schema's top-level `$ref` points at its primary
 * `$def`: DryRunResult, PageTreeRead, ElementNode, StyleDefinition, TypedValue).
 */
export function getValidator(key: SchemaKey): ValidateFunction {
  const id = schemaId(key);
  const existing = sharedAjv.getSchema(id);
  if (existing) {
    return existing;
  }
  return sharedAjv.compile(schemas[key]);
}

/**
 * Get a compiled validator for a specific `$def` inside one of the schemas, e.g.
 * `getDefValidator('atomic-prop-types', 'TypedValue')` or
 * `getDefValidator('element-node', 'AtomicWidgetNode')`. Used by fixture validation
 * and unit tests that assert against a sub-shape rather than the schema root.
 */
export function getDefValidator(key: SchemaKey, def: string): ValidateFunction {
  const ref = `${schemaId(key)}#/$defs/${def}`;
  const existing = sharedAjv.getSchema(ref);
  if (existing) {
    return existing;
  }
  return sharedAjv.compile({ $ref: ref });
}

/** Convenience: the primary (root) validators keyed by schema key. */
export const validators: Readonly<Record<SchemaKey, ValidateFunction>> = Object.freeze(
  Object.fromEntries(SCHEMA_KEYS.map((key) => [key, getValidator(key)])) as Record<
    SchemaKey,
    ValidateFunction
  >,
);
