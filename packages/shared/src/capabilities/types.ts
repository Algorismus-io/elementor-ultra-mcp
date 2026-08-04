/**
 * WP-F05 — Capability/experiment probe types (Seam E, the TS-side consumer view).
 *
 * The capabilities payload is the precondition probe for ALL atomic / design-system / Pro work
 * (`01-architecture.md §7`, RESEARCH.md §8). The PHP builder (`class-capabilities.php`) produces the
 * authoritative payload; the `GET /site/capabilities` route (registered by WP-P07) returns it; the
 * `elementor.site.capabilities` tool + `elementor://site/capabilities` resource expose the NORMALIZED
 * shape below to agents.
 *
 * This module defines the NORMALIZED capabilities shape — the `elementor.site.capabilities` tool
 * `outputSchema` (`13-tool-catalog.md §1.1`): boolean feature flags + the field set the F05 ticket
 * freezes (`v4, atomic, global_classes, variables, pro, pro_atomic_form, breakpoints[],
 * experiments{}, can_update_class, classes_migrated`). The RAW REST `/site/capabilities` envelope is
 * the wider `SiteCapabilitiesResponse` (WP-F02 `rest/types.ts`, `10-rest-api.md §12`); the tool
 * handler (`packages/server/src/tools/discovery-capabilities.ts`) maps RAW → NORMALIZED.
 *
 * Field names are immutable identifiers every other WP reuses verbatim.
 */

/** The canonical experiment slugs the probe reports (`12-error-taxonomy.md §3.4`, RESEARCH.md §8). */
export const EXPERIMENT_SLUGS = [
  /** Atomic V4 elements — BETA/default-inactive with new-site override (`atomic-widgets/module.php:193-195`). */
  'e_atomic_elements',
  /** Global classes (`global-classes/module.php:21,38-52`). */
  'e_classes',
  /** Global variables (`variables/hooks.php:48-51`). */
  'e_variables',
  /** Per-page V4 opt-in (`atomic-opt-in/module.php:11`). */
  'e_opt_in_v4_page',
  /** Pro atomic form fields (`e-form-*`). */
  'e_pro_atomic_form',
  /** WP Abilities API secondary path. */
  'e_wp_abilities_api',
] as const;

/** A known experiment slug. The `experiments` map keeps the type open for site-defined slugs. */
export type ExperimentSlug = (typeof EXPERIMENT_SLUGS)[number];

/**
 * One active breakpoint as reported by the probe (`13-tool-catalog.md §1.1` outputSchema:
 * `{ key, label, direction, value }`). `direction` ∈ `min|max`; NEVER hardcode px widths
 * (`core/breakpoints/manager.php:17-23`).
 */
export interface CapabilityBreakpoint {
  key: string;
  label?: string;
  direction: 'min' | 'max';
  value: number;
}

/** Registered element/widget type ids, split atomic vs classic (`13-tool-catalog.md §1.1`). */
export interface RegisteredTypes {
  atomic: string[];
  classic: string[];
}

/** Elementor / Pro / companion-plugin versions (`13-tool-catalog.md §1.1`; `pro` null when inactive). */
export interface CapabilityVersions {
  elementor: string;
  pro: string | null;
  plugin: string;
}

/**
 * The FROZEN normalized capabilities payload — the `elementor.site.capabilities` tool output
 * (`13-tool-catalog.md §1.1`) and the F05 ticket field set. Booleans gate features; `experiments`
 * maps each known slug → active boolean so callers can gate precisely (`EXPERIMENT_INACTIVE` /
 * `PRO_REQUIRED` ladders). Built from the RAW REST payload by the tool handler.
 */
export interface Capabilities {
  /** V4 atomic is the default authoring generation for new pages on this site. */
  v4: boolean;
  /** Atomic elements are available (the `e_atomic_elements` experiment is active). */
  atomic: boolean;
  /** Global classes are available (`e_classes`). */
  global_classes: boolean;
  /** Global variables are available (`e_variables`). */
  variables: boolean;
  /** Elementor Pro is active. */
  pro: boolean;
  /** Pro atomic form fields are available (`e_pro_atomic_form`). */
  pro_atomic_form: boolean;
  /** Active breakpoints (resolve responsive props against these; never hardcode). */
  breakpoints: CapabilityBreakpoint[];
  /** Each known experiment slug → active boolean. */
  experiments: Record<string, boolean>;
  /** `current_user_can('elementor_global_classes_update_class')` — gates ALL global-class writes. */
  can_update_class: boolean;
  /** Whether the `migrate-to-posts` migration that grants UPDATE_CLASS has run. */
  classes_migrated: boolean;
  /** Registered atomic + classic types (probe before assuming a `widgetType` exists). */
  registered_types: RegisteredTypes;
  /** Version triple (Elementor / Pro / companion plugin). */
  versions: CapabilityVersions;
  /** Whether `unfiltered_html` is granted (affects content-filter fidelity, not a route gate). */
  unfiltered_html: boolean;
  /**
   * Contract 18 §7 M-g — whether the Pro LICENSE includes the (atomic) custom-css feature. The
   * convert coverage math counts `custom_css`-tier declarations as DROPPED when this is `false`
   * (portability only: the style would not render on the target site). Optional: absent on older
   * companion plugins (callers default it to `pro`).
   */
  custom_css_licensed?: boolean;
}
