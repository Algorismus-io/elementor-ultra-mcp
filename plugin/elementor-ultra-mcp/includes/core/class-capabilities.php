<?php
/**
 * WP-F05 — Capabilities builder (Seam E, the PHP side / "the truth").
 *
 * Contract authority: spec/contracts/10-rest-api.md §12 (the `GET /site/capabilities` response `data`
 * shape), spec/contracts/12-error-taxonomy.md §3.4 (experiment slugs), spec/01-architecture.md §7
 * (capability/experiment gating is OWNED by PHP — `site/capabilities` is the truth; TS probes it
 * before assuming routes exist).
 *
 * `Capabilities::build()` returns the AUTHORITATIVE payload array. The `GET /site/capabilities` ROUTE
 * is registered by WP-P07's `class-schema-controller.php`, which calls `Capabilities::build()` and
 * returns it via `{success:true, data:<payload>}`. F05 owns ONLY the builder + the field set; keep
 * `build()`'s signature + keys stable so any caller depends on the contract, not the implementation.
 *
 * The TS-side normalized {@see \packages/shared/src/capabilities/types.ts Capabilities} shape is
 * derived from THIS RAW payload by the tool handler (discovery-capabilities.ts): `v4`<-`v4_default`,
 * `atomic`<-`atomic_available`, `pro`<-`pro_active`, experiment string-states -> booleans, etc.
 *
 * Grounded in Elementor source (paths relative to plugins/elementor):
 *  - UPDATE_CLASS cap `elementor_global_classes_update_class`
 *    (modules/global-classes/database/migrations/add-capabilities.php:8,14).
 *  - Atomic experiment slug `e_atomic_elements`
 *    (modules/atomic-widgets/module.php:135; get_experimental_data():190-204 — hidden BETA,
 *    default-inactive with new-site override).
 *  - Global classes experiment `e_classes` (modules/global-classes/module.php:11).
 *  - Read experiments via `\Elementor\Plugin::$instance->experiments->is_feature_active($slug)`
 *    (core/experiments/manager.php:257); read states via `get_features()[$slug]['state']`.
 *  - `classes_migrated`: the migrate-to-posts migration grants UPDATE_CLASS to administrator
 *    (add-capabilities.php:14); we report it via the administrator role holding the cap.
 *  - Breakpoints via the active breakpoints manager (NEVER hardcode px widths).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Builds the `/site/capabilities` payload (the precondition probe for ALL atomic/design-system/Pro
 * work). All Elementor reads are defensive (guarded by `class_exists` / `method_exists`) so the probe
 * never fatals on a partial install.
 */
final class Capabilities {

	/** The Elementor UPDATE_CLASS capability slug (add-capabilities.php:8). */
	const CAP_UPDATE_CLASS = 'elementor_global_classes_update_class';

	/** Canonical experiment slugs the probe reports (12-error-taxonomy.md §3.4). */
	const EXPERIMENT_SLUGS = array(
		'e_atomic_elements',  // atomic-widgets/module.php:135 (BETA/default-inactive).
		'e_classes',          // global-classes/module.php:11.
		'e_variables',        // variables/hooks.php.
		'e_opt_in_v4_page',   // atomic-opt-in/module.php.
		'e_pro_atomic_form',  // Pro atomic form fields.
		'e_wp_abilities_api', // WP Abilities API secondary path.
	);

	/** Experiment state strings (10-rest-api.md §12: `active|inactive|default`). */
	const STATE_ACTIVE   = 'active';
	const STATE_INACTIVE = 'inactive';
	const STATE_DEFAULT  = 'default';

	/**
	 * Build the authoritative capabilities payload (10-rest-api.md §12). STABLE signature + keys —
	 * WP-P07's schema controller returns this verbatim under `data`.
	 *
	 * @return array<string,mixed> The frozen `/site/capabilities` data payload.
	 */
	public static function build(): array {
		$experiments = self::experiment_states();

		return array(
			'elementor_version'         => self::elementor_version(),
			'pro_version'               => self::pro_version(),
			'pro_active'                => self::pro_active(),
			'atomic_available'          => self::STATE_ACTIVE === ( $experiments['e_atomic_elements'] ?? self::STATE_INACTIVE ),
			'v4_default'                => self::v4_default( $experiments ),
			'experiments'               => $experiments,
			'global_classes'            => self::STATE_ACTIVE === ( $experiments['e_classes'] ?? self::STATE_INACTIVE ),
			'variables'                 => self::STATE_ACTIVE === ( $experiments['e_variables'] ?? self::STATE_INACTIVE ),
			'classes_migrated'          => self::classes_migrated(),
			'can_update_class'          => self::can_update_class(),
			'unfiltered_html'           => current_user_can( 'unfiltered_html' ),
			'custom_css_licensed'       => self::custom_css_licensed(),
			'breakpoints'               => self::breakpoints(),
			'registered_types'          => self::registered_types(),
			'multisite'                 => is_multisite(),
			'is_local'                  => self::is_local(),
			'app_passwords_available'   => self::app_passwords_available(),
			'abilities_adapter_present' => self::STATE_ACTIVE === ( $experiments['e_wp_abilities_api'] ?? self::STATE_INACTIVE ),
			'plugin_version'            => self::plugin_version(),
			'health'                    => 'ok',
		);
	}

	/**
	 * Map each known experiment slug -> its state string (active|inactive|default) so callers can gate
	 * precisely (12-error-taxonomy.md §3.4; 10-rest-api.md §12).
	 *
	 * @return array<string,string>
	 */
	private static function experiment_states(): array {
		$states   = array();
		$features = self::experiment_features();

		foreach ( self::EXPERIMENT_SLUGS as $slug ) {
			$states[ $slug ] = self::experiment_state( $slug, $features );
		}

		return $states;
	}

	/**
	 * Resolve one experiment's state. Prefers the registered feature's explicit `state` (so we can
	 * report `default`); falls back to `is_feature_active()` -> active|inactive.
	 *
	 * @param string                            $slug     Experiment slug.
	 * @param array<string,array<string,mixed>> $features Registered feature map (slug => feature).
	 */
	private static function experiment_state( string $slug, array $features ): string {
		if ( isset( $features[ $slug ]['state'] ) && is_string( $features[ $slug ]['state'] ) ) {
			$state = $features[ $slug ]['state'];
			if ( in_array( $state, array( self::STATE_ACTIVE, self::STATE_INACTIVE, self::STATE_DEFAULT ), true ) ) {
				// A 'default' state means "follow the feature's default"; resolve to active/inactive
				// via is_feature_active so callers always get a concrete gate, but keep 'default'
				// reported when the experiments manager itself reports 'default'.
				if ( self::STATE_DEFAULT === $state ) {
					return self::is_feature_active( $slug ) ? self::STATE_ACTIVE : self::STATE_INACTIVE;
				}
				return $state;
			}
		}

		return self::is_feature_active( $slug ) ? self::STATE_ACTIVE : self::STATE_INACTIVE;
	}

	/**
	 * The registered experiment feature map (slug => feature array), or [] if unavailable.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	private static function experiment_features(): array {
		$experiments = self::experiments_manager();
		if ( null === $experiments || ! method_exists( $experiments, 'get_features' ) ) {
			return array();
		}

		$features = $experiments->get_features();
		return is_array( $features ) ? $features : array();
	}

	/**
	 * `\Elementor\Plugin::$instance->experiments->is_feature_active($slug)` (core/experiments/manager.php:257),
	 * defended against a missing plugin/manager.
	 *
	 * @param string $slug Experiment slug.
	 */
	private static function is_feature_active( string $slug ): bool {
		$experiments = self::experiments_manager();
		if ( null === $experiments || ! method_exists( $experiments, 'is_feature_active' ) ) {
			return false;
		}

		return (bool) $experiments->is_feature_active( $slug );
	}

	/** The Elementor experiments manager instance, or null when Elementor is absent. */
	private static function experiments_manager() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}

		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->experiments ) ) {
			return null;
		}

		return $plugin->experiments;
	}

	/**
	 * `current_user_can(UPDATE_CLASS)` — gates ALL global-class writes (add-capabilities.php:14,
	 * 12-error-taxonomy.md §3.4). Absent => 403 on every global-class write.
	 */
	private static function can_update_class(): bool {
		return current_user_can( self::CAP_UPDATE_CLASS );
	}

	/**
	 * Whether the `migrate-to-posts` migration that grants UPDATE_CLASS has run (RESEARCH.md §2.2;
	 * migrate-to-posts.php). Detected via the administrator role holding the migration-granted cap
	 * (add-capabilities.php:14 grants UPDATE_CLASS to administrator on migration).
	 */
	private static function classes_migrated(): bool {
		$role = get_role( 'administrator' );
		if ( null === $role || ! is_object( $role ) || ! method_exists( $role, 'has_cap' ) ) {
			return false;
		}

		return (bool) $role->has_cap( self::CAP_UPDATE_CLASS );
	}

	/**
	 * `v4_default`: V4 atomic is the default authoring generation for new pages. True when the atomic
	 * experiment is active AND the per-page opt-in is not forcing legacy. Conservative: atomic active.
	 *
	 * @param array<string,string> $experiments Resolved experiment states.
	 */
	private static function v4_default( array $experiments ): bool {
		return self::STATE_ACTIVE === ( $experiments['e_atomic_elements'] ?? self::STATE_INACTIVE );
	}

	/**
	 * Active breakpoints as `[{ key, label, direction, value }]` (10-rest-api.md §12; NEVER hardcode
	 * px widths — read from the active breakpoints manager). Returns [] if unavailable.
	 *
	 * @return array<int,array{key:string,label:string,direction:string,value:int}>
	 */
	private static function breakpoints(): array {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return array();
		}

		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->breakpoints ) || ! method_exists( $plugin->breakpoints, 'get_active_breakpoints' ) ) {
			return array();
		}

		$out    = array();
		$active = $plugin->breakpoints->get_active_breakpoints();
		if ( ! is_array( $active ) ) {
			return array();
		}

		foreach ( $active as $key => $breakpoint ) {
			$direction = is_object( $breakpoint ) && method_exists( $breakpoint, 'get_direction' )
				? (string) $breakpoint->get_direction()
				: 'max';
			$value     = is_object( $breakpoint ) && method_exists( $breakpoint, 'get_value' )
				? (int) $breakpoint->get_value()
				: 0;
			$label     = is_object( $breakpoint ) && method_exists( $breakpoint, 'get_label' )
				? (string) $breakpoint->get_label()
				: (string) $key;

			$out[] = array(
				'key'       => (string) $key,
				'label'     => $label,
				'direction' => $direction,
				'value'     => $value,
			);
		}

		return $out;
	}

	/**
	 * Registered element/widget type ids, split as `{ elements, widgets }` (10-rest-api.md §12; the TS
	 * handler normalizes elements->atomic, widgets->classic). Delegates to the canonical
	 * {@see \Elementor\Ultra\Rest\Schema_Controller::registered_types()} helper (its header invites
	 * exactly this reuse); the inline read below is a defensive fallback for partial installs.
	 * Returns empty arrays if unavailable.
	 *
	 * @return array{elements:string[],widgets:string[]}
	 */
	private static function registered_types(): array {
		if ( class_exists( '\Elementor\Ultra\Rest\Schema_Controller' ) ) {
			return \Elementor\Ultra\Rest\Schema_Controller::registered_types();
		}

		$elements = array();
		$widgets  = array();

		if ( class_exists( '\Elementor\Plugin' ) ) {
			$plugin = \Elementor\Plugin::$instance;

			if ( null !== $plugin && isset( $plugin->elements_manager ) && method_exists( $plugin->elements_manager, 'get_element_types' ) ) {
				$types = $plugin->elements_manager->get_element_types();
				if ( is_array( $types ) ) {
					$elements = array_keys( $types );
				}
			}

			if ( null !== $plugin && isset( $plugin->widgets_manager ) && method_exists( $plugin->widgets_manager, 'get_widget_types' ) ) {
				$types = $plugin->widgets_manager->get_widget_types();
				if ( is_array( $types ) ) {
					$widgets = array_keys( $types );
				}
			}
		}

		sort( $elements );
		sort( $widgets );

		return array(
			'elements' => array_values( array_map( 'strval', $elements ) ),
			'widgets'  => array_values( array_map( 'strval', $widgets ) ),
		);
	}

	/** Elementor core version, or '' when Elementor is absent. */
	private static function elementor_version(): string {
		return defined( 'ELEMENTOR_VERSION' ) ? (string) ELEMENTOR_VERSION : '';
	}

	/** Elementor Pro version, or null when Pro is inactive. */
	private static function pro_version(): ?string {
		return defined( 'ELEMENTOR_PRO_VERSION' ) ? (string) ELEMENTOR_PRO_VERSION : null;
	}

	/** Whether Elementor Pro is active. */
	private static function pro_active(): bool {
		return defined( 'ELEMENTOR_PRO_VERSION' );
	}

	/**
	 * Contract 18 §7 M-g — whether the Pro LICENSE includes the custom-css feature (the `custom_css.raw`
	 * style-variant surface). False when Pro is inactive. When Pro is active, consult the License API's
	 * feature list when available; an indeterminate license layer (older Pro, no API) degrades to TRUE
	 * (pro_active) so a dev/GPL stack keeps the historical behavior — the flag only DOWNGRADES coverage
	 * when the license layer affirmatively lacks the feature.
	 *
	 * @return bool
	 */
	private static function custom_css_licensed(): bool {
		if ( ! self::pro_active() ) {
			return false;
		}
		try {
			if ( class_exists( '\ElementorPro\License\API' ) && method_exists( '\ElementorPro\License\API', 'is_licence_has_feature' ) ) {
				$license_data = null;
				if ( method_exists( '\ElementorPro\License\API', 'get_license_data' ) ) {
					$license_data = \ElementorPro\License\API::get_license_data();
				}
				// Only trust an affirmative feature list; an empty/absent list is indeterminate.
				if ( is_array( $license_data ) && ! empty( $license_data['features'] ) && is_array( $license_data['features'] ) ) {
					return in_array( 'custom-css', $license_data['features'], true )
						|| (bool) \ElementorPro\License\API::is_licence_has_feature( 'custom-css' );
				}
			}
		} catch ( \Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement.DetectedCatch -- license probe must never fatal the capabilities route.
			// Indeterminate license layer — fall through to the pro_active default.
		}
		return true;
	}

	/** The companion plugin version, or '' when its constant is undefined. */
	private static function plugin_version(): string {
		return defined( 'ELEMENTOR_ULTRA_MCP_VERSION' ) ? (string) ELEMENTOR_ULTRA_MCP_VERSION : '';
	}

	/** Whether WP Application Passwords are available on this site (RESEARCH.md §8 / S6). */
	private static function app_passwords_available(): bool {
		return function_exists( 'wp_is_application_passwords_available' )
			? (bool) wp_is_application_passwords_available()
			: false;
	}

	/** Heuristic: whether the site looks like a local/dev install (informational; 10-rest-api.md §12). */
	private static function is_local(): bool {
		if ( function_exists( 'wp_get_environment_type' ) ) {
			$env = wp_get_environment_type();
			if ( in_array( $env, array( 'local', 'development' ), true ) ) {
				return true;
			}
		}

		$host = isset( $_SERVER['HTTP_HOST'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_HOST'] ) ) : '';
		return (bool) preg_match( '/(^localhost|\.local$|\.test$|^127\.0\.0\.1)/', $host );
	}
}
