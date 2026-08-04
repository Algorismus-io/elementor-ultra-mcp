/**
 * WP-F04 — shared zod building blocks for the FROZEN tool catalog (Seam A).
 *
 * Contract authority:
 *  - spec/contracts/13-tool-catalog.md §0.6 (pagination shape, LOCKED),
 *    §0.1 (SDK 1.x ZodRawShape — `inputSchema`/`outputSchema` are flat `{ field: zodType }` maps),
 *    §0.1 (named authoring types ⇒ their `z.<Type>` schema: `ElementNode` ⇒ `elementNodeSchema`).
 *  - spec/contracts/11-authoring-contract.md §1 (the LOCKED type names mirrored here as zod schemas:
 *    `ElementNode`, `StyleVariant`, `GlobalClassObject` (StyleDefinition-shaped), `Diff`,
 *    `DryRunResult`, `ConditionTuple`, `CoverageReport`).
 *  - spec/contracts/15-engineering-standards.md §2.2 (validation = zod; ZodRawShape exactly matching
 *    Contract 13).
 *
 * These zod schemas mirror the hand-frozen TS types in `packages/server/src/authoring/contract.ts`
 * (WP-F03) and the JSON Schemas in `packages/shared/schemas/`. The PHP `dry_run` endpoint remains the
 * SINGLE SOURCE OF TRUTH for validity (15-engineering-standards.md §2.5); these schemas are the wire
 * shape the SDK validates structurally before the request reaches PHP — they intentionally stay
 * permissive on deeply-nested atomic payloads (`value: z.unknown()`) so the TS layer never hard-rejects
 * input that PHP would accept.
 */

import { z } from 'zod';

/* ───────────────────────────── §0.6 pagination (LOCKED) ─────────────────────────────────── */

/**
 * The pagination INPUT fields every list/read tool accepts (13-tool-catalog.md §0.6). Spread into a
 * tool's `inputSchema` ZodRawShape: `{ ...paginationInputShape, ...rest }`.
 */
export const paginationInputShape = {
  // The REST layer caps `limit` at 100 (10-rest-api.md §0.11 "max 100"; controllers register
  // `'maximum' => 100` so WP core 400s any larger value BEFORE the trait clamp runs). The §0.6
  // catalog text said max(200) — that drifted from the REST contract; the wire cap wins here so
  // every schema-legal call is REST-legal (#18).
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  fields: z.array(z.string()).optional(),
} as const;

/**
 * The pagination OUTPUT fields every list/read tool returns (13-tool-catalog.md §0.6). Spread into a
 * tool's `outputSchema` ZodRawShape together with the typed `items` array:
 * `{ items: z.array(itemSchema), ...paginationOutputShape }`.
 */
export const paginationOutputShape = {
  next_cursor: z.string().nullable(),
  total: z.number().int(),
} as const;

/** Build a paginated `outputSchema` ZodRawShape from a per-item schema (13-tool-catalog.md §0.6). */
export function paginatedOutput<T extends z.ZodTypeAny>(
  itemSchema: T,
): { items: z.ZodArray<T>; next_cursor: z.ZodNullable<z.ZodString>; total: z.ZodNumber } {
  return {
    items: z.array(itemSchema),
    ...paginationOutputShape,
  };
}

/**
 * Make a list item schema tolerant of §0.6 `fields` projection: the REST layer drops every item key
 * the caller did NOT request, so a projected item is an arbitrary SUBSET of the full item shape. A
 * required item property would make any `fields` call schema-invalid OUTPUT (MCP -32602), so every
 * list tool's `items` schema must validate the full shape's TYPES without requiring presence.
 */
export function fieldProjectedItem<T extends z.ZodRawShape>(
  itemSchema: z.ZodObject<T>,
): z.ZodObject<{ [K in keyof T]: z.ZodOptional<T[K]> }> {
  return itemSchema.partial();
}

/* ───────────────────────────── §3 typed envelopes (V4 atomic) ───────────────────────────── */

/**
 * The universal atomic typed envelope `{$$type,value,disabled?}` (11-authoring-contract.md §3,
 * `atomic-prop-types.schema.json#/$defs/TypedValue`). `value` is intentionally `z.unknown()` — the
 * per-`$$type` strict shapes live in PHP; the TS pre-filter is structural only (§2.5).
 */
export const typedValueSchema: z.ZodType = z.lazy(() =>
  z.object({
    $$type: z.string(),
    value: z.unknown(),
    disabled: z.boolean().optional(),
  }),
);

/* ───────────────────────────── §5 atomic styles ─────────────────────────────────────────── */

/** Variant selector meta — breakpoint + state (11-authoring-contract.md §5, `StyleMeta`). */
export const styleMetaSchema = z.object({
  breakpoint: z.string().nullable(),
  state: z.string().nullable(),
});

/**
 * One responsive/state variant of a style (`StyleVariant`, 11-authoring-contract.md §1/§5). `props`
 * is a flat map of Style-Schema CSS prop → TypedValue; `custom_css` is Pro-only.
 */
export const styleVariantSchema = z.object({
  meta: styleMetaSchema,
  props: z.record(z.string(), typedValueSchema),
  custom_css: z.object({ raw: z.string() }).nullable().optional(),
});

/**
 * A global-class object — the `StyleDefinition`-shaped object carrying `id`/`label`/`type:"class"`/
 * `variants[]` (REST contract §4; 13-tool-catalog.md NOTE — referred to as `GlobalClassObject`).
 */
export const globalClassObjectSchema = z.object({
  id: z.string(),
  type: z.literal('class'),
  label: z.string(),
  variants: z.array(styleVariantSchema),
});

/* ───────────────────────────── §2 element nodes ─────────────────────────────────────────── */

/**
 * The `ElementNode` discriminated union (11-authoring-contract.md §1/§2,
 * `element-node.schema.json#/$defs/ElementNode`) as a zod schema (per §0.1, `ElementNode` ⇒
 * `elementNodeSchema`). A subtree MAY mix V4 atomic + V3 classic nodes, so this is a recursive,
 * permissive shape — PHP `dry_run` is authoritative on per-elType validity. `settings` is left open
 * (atomic = typed-envelope map, classic = flat assoc map) so the TS layer never hard-rejects.
 */
export const elementNodeSchema: z.ZodType = z.lazy(() =>
  z.object({
    id: z.string(),
    elType: z.string(),
    // PHP's `projection=summary` emits `widgetType: null` on containers (`isset(...) ? ... : null`),
    // so the wire value is string-or-null-or-absent.
    widgetType: z.string().nullable().optional(),
    version: z.string().optional(),
    // PHP serializes an EMPTY settings map (`{}`) as a JSON array (`[]`) — classic `_elementor_data`
    // routinely stores `"settings":[]` — and the authoritative validator ALSO accepts a fully ABSENT
    // `settings` key (it defaults to `array()`). Normalize both to `{}` before validating so
    // PHP-shaped trees round-trip through `get_structure` output AND `replace_tree`/`dry_run`/
    // `page_build` input (#37); handlers receive the PARSED value, so downstream consumers (e.g. the
    // prefilter) always see an object.
    settings: z.preprocess(
      (v) => (v === undefined || (Array.isArray(v) && v.length === 0) ? {} : v),
      z.record(z.string(), z.unknown()),
    ),
    // PHP serializes an EMPTY styles map (`{}`) as a JSON array (`[]`) — an atomic node with no local
    // styles round-trips as `styles: []`, which would fail `z.record` and reject `get_structure` output
    // (#3b). Normalize an empty `[]` to `{}` before validating so styles-less atomic nodes validate.
    styles: z
      .preprocess(
        (v) => (Array.isArray(v) && v.length === 0 ? {} : v),
        z.record(z.string(), globalClassObjectSchema),
      )
      .optional(),
    editor_settings: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
    // The native wire format for V4 interactions (spike S08) is a JSON-encoded STRING of
    // `{version, items:[interaction-item…]}`; PHP also accepts the decoded object, and emits `[]`
    // when empty. Accept all three — typing this as bare array rejected every authored interaction.
    interactions: z
      .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
      .optional(),
    origin_id: z.string().optional(),
    isInner: z.boolean().optional(),
    isLocked: z.boolean().optional(),
    elements: z.array(elementNodeSchema).optional(),
  }),
);

/**
 * A free-form assoc map that round-trips through PHP `json_encode`, which serializes an EMPTY assoc
 * array as a JSON array (`[]`), never `{}`. Normalize `[]` → `{}` before validating so PHP-emitted
 * empty bags (`page_settings: []`, `settings: []`) never fail `z.record` output validation (#3b).
 */
export const phpAssocRecordSchema = z.preprocess(
  (v) => (Array.isArray(v) && v.length === 0 ? {} : v),
  z.record(z.string(), z.unknown()),
);

/** A page/document settings bag (`_elementor_page_settings`, free-form assoc map). */
export const pageSettingsSchema = phpAssocRecordSchema;

/* ───────────────────────── §7-AI S1 document-settings allowlist (contract 18) ───────────── */

/** The `_wp_page_template` values the allowlist accepts (page-settings.schema.json). */
export const PAGE_TEMPLATE_VALUES = [
  'default',
  'elementor_canvas',
  'elementor_header_footer',
  'elementor_theme',
] as const;

/** The `post_status` values the allowlist accepts (page-settings.schema.json). */
export const POST_STATUS_VALUES = ['draft', 'publish', 'pending', 'private', 'future'] as const;

/**
 * The contract-18 §7-AI S1 document-settings ALLOWLIST as a zod prefilter (mirrors the frozen
 * `page-settings.schema.json`; PHP `Validator::validate_settings` stays AUTHORITATIVE). Unknown keys
 * pass through verbatim; known keys with render-fatal shapes are hard rejects:
 *
 *  - `custom_css` MUST be a plain string. The object `{raw:<base64>}` shape is the STYLE-VARIANT
 *    form (contract 11 §5) — on PAGE settings it fatals Pro's custom-css module (`trim()` on an
 *    array, AF1) sitewide while `css_primed:true` reports green. REJECT object/array.
 *  - `template` ∈ {@link PAGE_TEMPLATE_VALUES} (incl. `elementor_canvas`).
 *  - `hide_title` is boolean (the legacy switcher strings `'yes'`/`''` also pass so stored
 *    settings round-trip through GET-merge-PUT).
 *  - `post_status` ∈ {@link POST_STATUS_VALUES}.
 *
 * INPUT-side only: outputs keep the permissive {@link pageSettingsSchema} so reads never reject
 * what a site already stores.
 */
export const pageSettingsInputSchema = z.preprocess(
  (v) => (Array.isArray(v) && v.length === 0 ? {} : v),
  z.record(z.string(), z.unknown()).superRefine((settings, ctx) => {
    const customCss = settings['custom_css'];
    if (customCss !== undefined && typeof customCss !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['custom_css'],
        message:
          'settings.custom_css must be a plain CSS string on page/document settings. The ' +
          '{$$type/raw} object shape is the STYLE-variant form and fatals the front-end ' +
          '(SETTINGS_INVALID, contract 18 §7-AI S1).',
      });
    }
    const template = settings['template'];
    if (
      template !== undefined &&
      !(
        typeof template === 'string' &&
        (PAGE_TEMPLATE_VALUES as readonly string[]).includes(template)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['template'],
        message: `settings.template must be one of: ${PAGE_TEMPLATE_VALUES.join(', ')} (SETTINGS_INVALID).`,
      });
    }
    const hideTitle = settings['hide_title'];
    if (
      hideTitle !== undefined &&
      typeof hideTitle !== 'boolean' &&
      hideTitle !== 'yes' &&
      hideTitle !== ''
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hide_title'],
        message:
          "settings.hide_title must be a boolean (or the legacy 'yes'/'' switcher strings) (SETTINGS_INVALID).",
      });
    }
    const postStatus = settings['post_status'];
    if (
      postStatus !== undefined &&
      !(
        typeof postStatus === 'string' &&
        (POST_STATUS_VALUES as readonly string[]).includes(postStatus)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['post_status'],
        message: `settings.post_status must be one of: ${POST_STATUS_VALUES.join(', ')} (SETTINGS_INVALID).`,
      });
    }
  }),
);

/* ───────────────────────────── diff / dry-run (§0.7, §11) ──────────────────────────────── */

/** One node-level change (`diff.schema.json#/$defs/NodeChange`). */
export const nodeChangeSchema = z.object({
  id: z.string(),
  op: z.enum(['added', 'removed', 'modified', 'moved']),
  elType: z.string().optional(),
  widgetType: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  from_parent: z.string().optional(),
  to_parent: z.string().optional(),
  from_index: z.number().int().optional(),
  to_index: z.number().int().optional(),
  changed_paths: z.array(z.string()).optional(),
});

/** Side effects on global classes/variables (`diff.schema.json#/$defs/Diff.design_system`). */
export const diffDesignSystemSchema = z.object({
  classes_added: z.array(z.string()).optional(),
  classes_modified: z.array(z.string()).optional(),
  classes_deleted: z.array(z.string()).optional(),
  variables_added: z.array(z.string()).optional(),
  modified_labels: z.record(z.string(), z.object({ modified: z.string().optional() })).optional(),
});

/**
 * The aggregate structured diff (`Diff`, 11-authoring-contract.md §1, `diff.schema.json#/$defs/Diff`).
 * Per §0.1, `Diff` ⇒ `diffSchema`. `changes` is the only required key (mirrors WP-F03's `Diff` type).
 */
export const diffSchema = z.object({
  changes: z.array(nodeChangeSchema),
  new_ids: z.array(z.string()).optional(),
  changed_ids: z.array(z.string()).optional(),
  removed_ids: z.array(z.string()).optional(),
  base_hash_before: z.string().optional(),
  base_hash_after: z.string().optional(),
  design_system: diffDesignSystemSchema.optional(),
});

/**
 * One structured validation error from PHP `dry_run` (`ValidationError`, `diff.schema.json#/$defs/
 * ValidationError`). Note: the `page.dry_run` tool's `errors[]` shape in 13-tool-catalog.md §1.2 uses
 * NULLABLE `element_id`/`style_id`/`prop` — see `dryRunErrorSchema` for that exact wire shape.
 */
export const validationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  element_id: z.string().optional(),
  style_id: z.string().optional(),
  prop: z.string().optional(),
  retryable: z.boolean().optional(),
});

/**
 * The `errors[]` item shape EXACTLY as 13-tool-catalog.md §1.2 `elementor.page.dry_run` outputSchema
 * specifies it (nullable id/prop fields, required `code`+`message`).
 */
export const dryRunErrorSchema = z.object({
  element_id: z.string().nullable(),
  style_id: z.string().nullable(),
  prop: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

/**
 * The HTML→native coverage report (`CoverageReport`, `diff.schema.json#/$defs/CoverageReport`). Per
 * §0.1 this mirrors the WP-F03 type; the exact `convert.html_to_tree` `report` outputSchema shape is
 * defined inline in `schemas/convert.ts` (it uses different coverage key names per 13 §1.9).
 */
export const coverageReportSchema = z.object({
  coverage: z
    .object({
      pct_native: z.number().optional(),
      pct_local_or_global_class: z.number().optional(),
      pct_custom_css: z.number().optional(),
      pct_dropped: z.number().optional(),
    })
    .optional(),
  fallbacks: z.array(z.record(z.string(), z.unknown())).optional(),
  a11y: z.array(z.record(z.string(), z.unknown())).optional(),
  stripped_text: z.array(z.record(z.string(), z.unknown())).optional(),
  visual_diff_score: z.number().optional(),
});

/* ───────────────────────────── §8 display conditions (Pro) ──────────────────────────────── */

/**
 * A display-condition tuple (`ConditionTuple`, REST contract §8 / shared; 13-tool-catalog.md §1.8):
 * `z.tuple([z.enum(['include','exclude']), z.string()]).rest(z.string())` — slash-joined server-side.
 */
export const conditionTupleSchema = z
  .tuple([z.enum(['include', 'exclude']), z.string()])
  .rest(z.string());

/* ───────────────────────────── §0.7 common write outputs ────────────────────────────────── */

/**
 * The optimistic-lock token returned by every document-touching write (13-tool-catalog.md §0.7):
 * the new `base_hash = md5(_elementor_data)`.
 */
export const baseHashOutputSchema = z.string();
