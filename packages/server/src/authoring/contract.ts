/**
 * Seam D — the FROZEN Elementor authoring JSON contract, as canonical TypeScript types.
 *
 * This module realizes `spec/contracts/11-authoring-contract.md` and the five JSON Schemas
 * (`spec/contracts/schemas/*.schema.json`, mirrored at `packages/shared/schemas/`) as the
 * hand-frozen TS type set. Downstream WPs (REST WP-F02, safety/diff WP-T, HTML convert
 * WP-H, fixtures WP-F06) import these EXACT names — do not rename.
 *
 * Two node generations coexist in the same tree (`11-authoring-contract.md §2`):
 *   - V4 ATOMIC (PRIMARY): `e-*` elTypes/widgetTypes; `settings` values are typed envelopes
 *     `{$$type,value,disabled?}`; CSS lives on a separate per-element `styles` map.
 *   - V3 CLASSIC (FALLBACK): section/column/container + classic widgets; `settings` is a flat
 *     assoc map of scalar/object control values; CSS is driven by control selectors.
 *
 * AUTHORITY: The PHP `dry_run` endpoint (WP-P03) is the SINGLE SOURCE OF TRUTH for validity.
 * These types are the shared shape; the TS pre-filter (`./prefilter.ts`) is a cheap structural
 * subset only (`15-engineering-standards.md §2.5`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- TypedValue.value is intentionally
   open (any atomic payload); the strict shapes live in the per-$$type members. The PHP
   dry_run validator is authoritative for nested/conditional value validity. */

/* ───────────────────────────── §3 Typed envelopes (V4 atomic) ───────────────────────── */

/**
 * The universal atomic typed envelope (`11-authoring-contract.md §3`,
 * `atomic-prop-types.schema.json#/$defs/TypedValue`). `$$type` MUST equal the prop type's
 * `get_key()` (`prop-types/concerns/has-generate.php:11-22`). The pre-filter accepts any string
 * `$$type`; PHP `dry_run` rejects unregistered keys. `disabled:true` soft-disables the value.
 *
 * Three base kinds (per `$$type`): PLAIN (`value` is a scalar), ARRAY (`value` is a plain array
 * of wrapped items), OBJECT (`value` is an assoc map of wrapped fields). UNION is NOT itself
 * wrapped — the chosen member's own envelope is emitted (`union-prop-type.php:74-96`). The
 * `classes` envelope is the one exception whose `value` is a BARE string array.
 */
export interface TypedValue<TType extends string = string, TVal = any> {
  $$type: TType;
  value: TVal;
  disabled?: boolean;
}

/** `$$type:'size'` — `value` object; `'auto'` ⇒ size null, `'custom'` ⇒ size is a string. */
export type Size = TypedValue<
  'size',
  {
    unit: string;
    size?: number | string | null;
  }
>;

/** `$$type:'dimensions'` — each logical edge is a Size envelope (never physical edges). */
export type Dimensions = TypedValue<
  'dimensions',
  {
    'block-start'?: Size;
    'inline-end'?: Size;
    'block-end'?: Size;
    'inline-start'?: Size;
  }
>;

/**
 * `$$type:'classes'` — value is a BARE array of class-name strings (NO inner wrapping;
 * `classes-prop-type.php:22`). Holds BOTH global-class ids (`g-*`) and local-style ids
 * (`e-<elementId>-<7hex>`). Each name matches `/^[A-Za-z][A-Za-z0-9_-]*$/`.
 */
export type Classes = TypedValue<'classes', string[]>;

/**
 * `$$type:'link'` — `destination` is a Union(url|query), emitted as the chosen member's own
 * envelope (so it is a plain TypedValue here). `tag` enum `['a','button']` default `'a'`
 * (`link-prop-type.php:38-50`). `isTargetBlank` may be a raw boolean or a boolean envelope.
 */
export type Link = TypedValue<
  'link',
  {
    destination?: TypedValue;
    isTargetBlank?: boolean | TypedValue;
    tag?: TypedValue;
  } & Record<string, unknown>
>;

/**
 * `$$type:'image-src'` — `value` carries `id` (image-attachment-id envelope) XOR `url` (url
 * envelope): NEVER both, NEVER neither (`image-src-prop-type.php:36-44`, `$has_id xor $has_url`).
 * Prefer ID-only after `media.sideload_url`. Modeled as a discriminated XOR union so TS rejects
 * the both/neither shapes; the pre-filter maps a runtime violation to `IMAGE_SRC_XOR_VIOLATION`.
 */
export type ImageSrc = TypedValue<
  'image-src',
  | { id: TypedValue; url?: never; alt?: TypedValue }
  | { url: TypedValue; id?: never; alt?: TypedValue }
>;

/** `$$type:'image'` — `src` is an ImageSrc envelope (REQUIRED); `size` is a string envelope. */
export type Image = TypedValue<
  'image',
  {
    src: ImageSrc;
    size?: TypedValue;
  }
>;

/**
 * `$$type:'html-v3'` — `content` is null OR a WRAPPED string envelope; `children` is a PLAIN
 * array (no wrapping). The rendered inner HTML is `wp_kses`-filtered to the INLINE-ONLY allowlist
 * `[b,i,em,u,a,del,span,strong,sup,sub,s]` (`html-v3-prop-type.php:82,91`) — all other tags are
 * SILENTLY STRIPPED. Block content MUST be promoted to sibling element nodes before emission.
 */
export type HtmlV3 = TypedValue<
  'html-v3',
  {
    content?: TypedValue<'string', string> | null;
    children?: unknown[];
  }
>;

/**
 * `$$type` one of `global-color-variable | global-font-variable | global-size-variable`.
 * `value` is the variable id string (`e-gv-*`). All three are FREE (`variables/hooks.php:48-51`).
 * Renders `var(--<label>)`.
 */
export type GlobalVariableRef = TypedValue<
  'global-color-variable' | 'global-font-variable' | 'global-size-variable',
  string
>;

/* ───────────────────────────── §5 Atomic styles ─────────────────────────────────────── */

/**
 * Variant breakpoint key (`style-variant.schema.json#/$defs/BreakpointKey`). `null` = base/desktop.
 * The ACTIVE breakpoint set is site-dependent — resolve via `elementor.breakpoints.get`; NEVER
 * hardcode px widths. This is the canonical superset from `core/breakpoints/manager.php:17-23`.
 */
export type BreakpointKey =
  | null
  | 'mobile'
  | 'mobile_extra'
  | 'tablet'
  | 'tablet_extra'
  | 'laptop'
  | 'desktop'
  | 'widescreen'
  // Site-defined custom breakpoints are possible; keep the type open while preserving the
  // canonical literals above for autocomplete. PHP dry_run is authoritative on the live set.
  | (string & {});

/**
 * Variant state (`styles/style-states.php:6-12`, `style-variant.schema.json#/$defs/StyleState`).
 * `null` = normal. State lives on `variant.meta`, NEVER on a prop.
 */
export type StyleState =
  | null
  | 'hover'
  | 'active'
  | 'focus'
  | 'focus-visible'
  | 'checked'
  | 'e--selected';

/** Variant selector context: breakpoint + state together select which CSS rule the variant emits. */
export interface StyleMeta {
  breakpoint: BreakpointKey;
  state: StyleState;
}

/**
 * One responsive/state variant of a style (`styles/style-variant.php:38-42`). `props` is a flat map
 * of Style-Schema CSS prop name → TypedValue (probe valid keys via `elementor.schema.styles`).
 * `custom_css` is Pro-only (raw escape hatch); null/omitted on free, where it is stripped
 * (`atomic-widget-styles.php:94-114`).
 */
export interface StyleVariant {
  meta: StyleMeta;
  props: Record<string, TypedValue>;
  custom_css?: { raw: string } | null;
}

/**
 * A style object (`styles/style-definition.php:36-39`). As a LOCAL style it lives in an element's
 * `styles` map keyed by its id (convention `e-<elementId>-<7hex>`) AND its id MUST also appear in
 * that element's `classes` prop (else the style silently detaches, §5.1). As a GLOBAL CLASS it
 * lives in the `e_global_class` CPT (id `g-*`) and is referenced by id only. `type` is `'class'`.
 */
export interface StyleDefinition {
  id: string;
  type: 'class';
  label: string;
  variants: StyleVariant[];
}

/* ───────────────────────────── §2 Element nodes ─────────────────────────────────────── */

/**
 * Verified atomic CONTAINER element types (`modules/atomic-widgets/elements/`,
 * `11-authoring-contract.md §4`). Forms containers (`e-form*`) are FREE.
 */
export type AtomicContainerType =
  | 'e-div-block'
  | 'e-flexbox'
  | 'e-tabs'
  | 'e-tabs-menu'
  | 'e-tab'
  | 'e-tabs-content-area'
  | 'e-tab-content'
  | 'e-form'
  | 'e-form-success-message'
  | 'e-form-error-message';

/**
 * Verified atomic WIDGET types (`modules/atomic-widgets/elements/` + Pro atomic forms gated on
 * `e_pro_atomic_form`). `e-tab-content` can serialize as a widget per the frozen element-node schema.
 */
export type AtomicWidgetType =
  | 'e-heading'
  | 'e-paragraph'
  | 'e-image'
  | 'e-button'
  | 'e-svg'
  | 'e-youtube'
  | 'e-divider'
  | 'e-self-hosted-video'
  | 'e-tab-content'
  | 'e-form-input'
  | 'e-form-textarea'
  | 'e-form-checkbox'
  | 'e-form-radio-button'
  | 'e-form-select'
  | 'e-form-date-picker'
  | 'e-form-time-picker'
  | 'e-form-file-upload'
  | 'e-form-label'
  | 'e-form-submit-button';

/**
 * Editor-only metadata; array OR object (`element-node.schema.json`). Often holds a `{title}` label
 * or the idempotency `op_id` (hidden). Default `[]`.
 */
export type EditorSettings = unknown[] | Record<string, unknown>;

/**
 * V4 atomic CONTAINER node (extends `Atomic_Element_Base`). Serializes WITHOUT `widgetType`. Carries
 * sibling keys `version/styles/editor_settings/interactions` in addition to `settings/elements`.
 * `settings` values are TypedValue envelopes and ALWAYS include `classes` (default empty). The
 * auto-injected `_cssid` (string, `has-atomic-base.php:310-321`) may appear on round-trip — tolerate,
 * do not author. Every local `styles` id MUST also be present in `settings.classes.value` (§5.1).
 */
export interface AtomicContainerNode {
  id: string;
  elType: AtomicContainerType;
  version?: string;
  settings: Record<string, TypedValue>;
  styles?: Record<string, StyleDefinition>;
  editor_settings?: EditorSettings;
  interactions?: unknown[];
  origin_id?: string;
  isInner?: boolean;
  isLocked?: boolean;
  elements?: ElementNode[];
}

/**
 * V4 atomic WIDGET node (extends `Atomic_Widget_Base`). Serializes `elType:'widget'` +
 * `widgetType:'e-*'`. Same sibling keys as containers; `elements` is typically empty.
 */
export interface AtomicWidgetNode {
  id: string;
  elType: 'widget';
  widgetType: AtomicWidgetType;
  version?: string;
  settings: Record<string, TypedValue>;
  styles?: Record<string, StyleDefinition>;
  editor_settings?: EditorSettings;
  interactions?: unknown[];
  origin_id?: string;
  isLocked?: boolean;
  elements?: ElementNode[];
}

/** An atomic node is a container or a widget (`AtomicNode = AtomicContainerNode | AtomicWidgetNode`). */
export type AtomicNode = AtomicContainerNode | AtomicWidgetNode;

/** Reserved classic settings keys for dynamic + global bindings (`11-authoring-contract.md §6/§7`). */
export interface ClassicReservedSettings {
  /**
   * `ctrl -> '[elementor-tag id=".." name=".." settings="<urlencoded JSON_FORCE_OBJECT>"]'`
   * (`core/dynamic-tags/manager.php:141-142`). Empty settings encode as `%7B%7D`, NOT empty string.
   */
  __dynamic__?: Record<string, string>;
  /**
   * `ctrl -> 'globals/colors?id=<_id>'` or `'globals/typography?id=<_id>'` (typography group key is
   * `typography_typography`).
   */
  __globals__?: Record<string, string>;
}

/**
 * V3 classic node (FALLBACK). `section/column/container` element, or any classic widget. `settings`
 * is a FLAT assoc map of scalar/object control values (NO typed envelopes); responsive overrides use
 * SUFFIX keys (`_tablet`/`_mobile`), never nested objects; group controls expand to flat prefixed keys;
 * switcher = `'yes'`/`''`. Emit only non-default keys. `widgetType` is required when `elType=='widget'`
 * and MUST NOT start with `e-` (that is the atomic namespace).
 */
export interface ClassicNode {
  id: string;
  elType: 'section' | 'column' | 'container' | 'widget';
  widgetType?: string;
  settings: ClassicReservedSettings & Record<string, unknown>;
  isInner?: boolean;
  isLocked?: boolean;
  elements?: ElementNode[];
}

/**
 * Discriminated union over all node kinds (`element-node.schema.json#/$defs/ElementNode`). A subtree
 * MAY mix generations but nesting must be tested (rule R6). Discrimination is deterministic — see
 * `isAtomicContainerNode`/`isAtomicWidgetNode`/`isClassicNode` for the routing. PHP `dry_run` remains
 * authoritative.
 */
export type ElementNode = AtomicContainerNode | AtomicWidgetNode | ClassicNode;

/* ───────────────────────────── Node discriminators ──────────────────────────────────── */

const ATOMIC_CONTAINER_TYPES: ReadonlySet<string> = new Set<AtomicContainerType>([
  'e-div-block',
  'e-flexbox',
  'e-tabs',
  'e-tabs-menu',
  'e-tab',
  'e-tabs-content-area',
  'e-tab-content',
  'e-form',
  'e-form-success-message',
  'e-form-error-message',
]);

/** True if the node is an atomic container (`e-*` elType, never `'widget'`). */
export function isAtomicContainerNode(node: ElementNode): node is AtomicContainerNode {
  return ATOMIC_CONTAINER_TYPES.has(node.elType);
}

/** True if the node is an atomic widget (`elType:'widget'` with an `e-*` widgetType). */
export function isAtomicWidgetNode(node: ElementNode): node is AtomicWidgetNode {
  return (
    node.elType === 'widget' &&
    typeof (node as AtomicWidgetNode).widgetType === 'string' &&
    (node as AtomicWidgetNode).widgetType.startsWith('e-')
  );
}

/** True if the node is a V3 classic node (everything the atomic discriminators do not claim). */
export function isClassicNode(node: ElementNode): node is ClassicNode {
  return !isAtomicContainerNode(node) && !isAtomicWidgetNode(node);
}

/** True for any atomic node (container or widget). */
export function isAtomicNode(node: ElementNode): node is AtomicNode {
  return isAtomicContainerNode(node) || isAtomicWidgetNode(node);
}

/* ───────────────────────────── §10 Page tree (read/write) ───────────────────────────── */

/**
 * Authoring generation of the tree (`page-tree.schema.json#/$defs/Generation`). `'v4'` = atomic
 * primary; `'v3'` = classic fallback; `'mixed'` = subtree mixes generations. New pages default to
 * `v4` when atomic is active (probe via `elementor.site.capabilities`), else `v3`.
 */
export type Generation = 'v4' | 'v3' | 'mixed';

/**
 * Document/page settings (`_elementor_page_settings`). Free-form assoc map; partial updates use
 * GET-merge-PUT in the plugin until `save_settings` merge semantics are confirmed (WP-S04).
 */
export type PageSettings = Record<string, unknown>;

/**
 * Read envelope from `elementor.page.get_structure` (`page-tree.schema.json#/$defs/PageTreeRead`).
 * `base_hash` is the optimistic-lock token to echo back on writes (md5 of the stored
 * `_elementor_data` string). `used_ids` (optional) is the in-use id set for client-side dedupe.
 */
export interface PageTreeRead {
  post_id: number;
  elements: ElementNode[];
  settings?: PageSettings;
  generation?: Generation;
  base_hash: string;
  used_ids?: string[];
}

/**
 * Write envelope to `elementor.page.replace_tree` / `page.build`
 * (`page-tree.schema.json#/$defs/PageTreeWrite`). `base_hash` is REQUIRED for `replace_tree`
 * (optimistic lock); `op_id` enables idempotent replay; `generation` selects atomic vs classic
 * emission; `force` overrides lock/autosave guards.
 */
export interface PageTreeWrite {
  post_id?: number;
  elements: ElementNode[];
  settings?: PageSettings;
  generation?: Generation;
  base_hash?: string;
  op_id?: string;
  force?: boolean;
}

/**
 * `PageTree` is the canonical document-tree envelope. The page-tree schema's root is the read shape,
 * so `PageTree` aliases `PageTreeRead`; use `PageTreeWrite` for the authored write shape.
 */
export type PageTree = PageTreeRead;

/* ───────────────────────────── diff / dry-run / coverage ────────────────────────────── */

/** A single node-level change (`diff.schema.json#/$defs/NodeChange`). */
export interface NodeChange {
  id: string;
  op: 'added' | 'removed' | 'modified' | 'moved';
  elType?: string;
  widgetType?: string;
  /** Prior node snapshot (omitted for `added`). */
  before?: unknown;
  /** New node snapshot (omitted for `removed`). */
  after?: unknown;
  from_parent?: string;
  to_parent?: string;
  from_index?: number;
  to_index?: number;
  /** For `modified`: dotted settings/styles paths that changed. */
  changed_paths?: string[];
}

/** Side effects on global classes/variables (`diff.schema.json#/$defs/Diff.design_system`). */
export interface DiffDesignSystem {
  classes_added?: string[];
  classes_modified?: string[];
  classes_deleted?: string[];
  variables_added?: string[];
  /** `DUPLICATED_LABEL` auto-renames the agent must reconcile: `<id> -> {modified:<newLabel>}`. */
  modified_labels?: Record<string, { modified?: string }>;
}

/** Aggregate structured diff for a write/edit (`diff.schema.json#/$defs/Diff`). */
export interface Diff {
  changes: NodeChange[];
  /** Freshly minted ids. */
  new_ids?: string[];
  /** Ids whose content changed. */
  changed_ids?: string[];
  /** Deleted ids. */
  removed_ids?: string[];
  base_hash_before?: string;
  base_hash_after?: string;
  design_system?: DiffDesignSystem;
}

/**
 * One structured validation error from PHP `dry_run` (`diff.schema.json#/$defs/ValidationError`,
 * aligns with `12-error-taxonomy.md` `ValidationError`). `code` is a taxonomy code; `message` carries
 * the appended parser errors verbatim — DO NOT string-match the throw message.
 */
export interface ValidationError {
  code: string;
  message: string;
  element_id?: string;
  style_id?: string;
  /** Offending prop / control name when known. */
  prop?: string;
  retryable?: boolean;
}

/** Per-node fallback-ladder record (`diff.schema.json`, RESEARCH.md §6.4 / `11-authoring-contract.md §9`). */
export interface CoverageFallback {
  element_id?: string;
  tier?: 'native' | 'local_style' | 'global_class' | 'custom_css' | 'html_widget';
  reason?: string;
}

/** Accessibility lint finding. */
export interface CoverageA11y {
  element_id?: string;
  rule?: string;
  severity?: 'warning' | 'blocker';
  message?: string;
}

/** `html-v3` inline-only allowlist strip finding (pre/post inner-markup diff). */
export interface CoverageStrippedText {
  element_id?: string;
  stripped_tags?: string[];
}

/**
 * HTML→native conversion report (`diff.schema.json#/$defs/CoverageReport`, RESEARCH.md §6.6/§6.8).
 * Honest per-section coverage; gates auto-commit.
 */
export interface CoverageReport {
  coverage?: {
    pct_native?: number;
    pct_local_or_global_class?: number;
    pct_custom_css?: number;
    pct_dropped?: number;
  };
  fallbacks?: CoverageFallback[];
  a11y?: CoverageA11y[];
  stripped_text?: CoverageStrippedText[];
  /** Optional pixelmatch diffPixels/total from `convert.fidelity_check`. Lower is better. */
  visual_diff_score?: number;
}

/**
 * Returned by `elementor.page.dry_run` (`diff.schema.json#/$defs/DryRunResult`): the AUTHORITATIVE
 * validate+diff with no persist. `valid` gates commit; `errors[]` are keyed by element id for agent
 * self-correction.
 */
export interface DryRunResult {
  valid: boolean;
  errors?: ValidationError[];
  diff?: Diff;
  /** Optional `get_wp_preview_url()` for a visual preview (nonce `post_preview_<id>`). */
  preview_url?: string;
  report?: CoverageReport;
}

/* ───────────────────────────── normalize() (round-trip identity) ─────────────────────── */

/**
 * Editor/PHP round-trip side-effects the normalizer must tolerate so a `build → read → normalize`
 * comparison does not show spurious changes (`14-fixtures-harness.md §7`):
 *   - `_cssid` is auto-injected into atomic `settings` (`has-atomic-base.php:310-321`).
 *   - empty `styles`/`editor_settings`/`interactions`/`elements` sibling keys are normalized.
 *   - `html-v3` content normalization (inline-only `wp_kses`) — text presence is compared, not exact
 *     markup; this normalizer drops empty `children` arrays but does NOT re-run kses (PHP does that).
 * IDs are preserved (callers compare structurally, not by literal id — see `14-fixtures-harness.md §7`).
 */

const EMPTY_SIBLING_KEYS = ['styles', 'editor_settings', 'interactions', 'elements'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

/** Deep-clone a JSON-safe value (the authoring tree is always JSON-serializable). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeNode(input: ElementNode): ElementNode {
  const node = cloneJson(input) as unknown as Record<string, unknown>;

  // Tolerate the auto-injected _cssid (round-trip only; never authored) by stripping it so two
  // structurally-identical trees (one pre-save, one post-read) compare equal.
  if (isPlainObject(node['settings'])) {
    const settings = node['settings'];
    if ('_cssid' in settings) {
      delete settings['_cssid'];
    }
  }

  // Drop empty optional sibling keys so {styles:{}} and (absent) compare equal.
  for (const key of EMPTY_SIBLING_KEYS) {
    if (key in node && isEmptyContainer(node[key])) {
      delete node[key];
    }
  }

  // Recurse into children (kept only when non-empty).
  const children = input.elements;
  if (Array.isArray(children) && children.length > 0) {
    node['elements'] = children.map((child) => normalizeNode(child));
  }

  return node as unknown as ElementNode;
}

/**
 * Normalize a tree (array of top-level `ElementNode`) for round-trip identity comparison
 * (`14-fixtures-harness.md §7`). Idempotent: `normalize(normalize(t)) === normalize(t)` structurally.
 * Tolerates `_cssid` injection and empty sibling-key noise; preserves ids and content.
 */
export function normalize(tree: ElementNode[]): ElementNode[] {
  return tree.map((node) => normalizeNode(node));
}

/* eslint-enable @typescript-eslint/no-explicit-any */
