<?php
/**
 * WP-P01 — Guards service: experiment / Pro / atomic / capability probes for every controller.
 *
 * Contract authority: 10-rest-api.md §12 (`site/capabilities` experiment slugs + state strings),
 * §0.3 (UPDATE_CLASS gate); 12-error-taxonomy.md §3.4 (`PRO_REQUIRED`, `EXPERIMENT_INACTIVE`,
 * `CAPABILITY_MISSING`); 15-engineering-standards.md §7 (version guards report, never fatal).
 *
 * Every Pro / atomic reference here is defensive (`defined`/`class_exists`/`method_exists`) so the
 * plugin loads and serves free routes regardless of Pro presence or Elementor version. The
 * `require_*` helpers construct taxonomy `WP_Error`s for controllers to short-circuit with; the
 * `WP_Error` -> envelope serialization itself lives in WP-P02 (this WP only constructs them).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Plugin;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Read-only capability/experiment/version probes shared by all REST controllers.
 */
final class Guards {

	/** The atomic-elements experiment slug (modules/atomic-widgets/module.php:135). */
	const EXPERIMENT_ATOMIC = 'e_atomic_elements';

	/** Experiment state strings (10-rest-api.md §12). */
	const STATE_ACTIVE   = 'active';
	const STATE_INACTIVE = 'inactive';
	const STATE_DEFAULT  = 'default';

	/**
	 * Canonical experiment slugs reported in `site/capabilities` (10-rest-api.md §12,
	 * 12-error-taxonomy.md §3.4). Order matches the contract payload.
	 *
	 * @var string[]
	 */
	const EXPERIMENT_SLUGS = array(
		'e_atomic_elements',
		'e_classes',
		'e_variables',
		'e_opt_in_v4_page',
		'e_pro_atomic_form',
		'e_wp_abilities_api',
	);

	/** Whether Elementor core is active on this site. */
	public function is_elementor_active(): bool {
		return defined( 'ELEMENTOR_VERSION' ) || did_action( 'elementor/loaded' );
	}

	/** Whether Elementor Pro is active on this site. */
	public function is_pro_active(): bool {
		return defined( 'ELEMENTOR_PRO_VERSION' );
	}

	/** Elementor core version, or null when Elementor is absent. */
	public function elementor_version(): ?string {
		return defined( 'ELEMENTOR_VERSION' ) ? (string) ELEMENTOR_VERSION : null;
	}

	/** Elementor Pro version, or null when Pro is inactive. */
	public function pro_version(): ?string {
		return defined( 'ELEMENTOR_PRO_VERSION' ) ? (string) ELEMENTOR_PRO_VERSION : null;
	}

	/** Whether Elementor meets the minimum supported version (15-engineering-standards.md §7). */
	public function is_elementor_compatible(): bool {
		$version = $this->elementor_version();
		if ( null === $version ) {
			return false;
		}
		return version_compare( $version, Plugin::MIN_ELEMENTOR, '>=' );
	}

	/**
	 * Whether the V4 atomic-elements experiment is on (10-rest-api.md §12 `atomic_available`).
	 * Probes via the experiments manager (preferred over reading options directly).
	 */
	public function atomic_available(): bool {
		return self::STATE_ACTIVE === $this->experiment_state( self::EXPERIMENT_ATOMIC );
	}

	/**
	 * Resolve one experiment's state to `active|inactive|default` (10-rest-api.md §12). Prefers the
	 * registered feature's explicit `state` (so `default` can be reported); falls back to
	 * `is_feature_active()` -> active|inactive; an unregistered slug is `default`.
	 *
	 * @param string $slug Experiment slug.
	 */
	public function experiment_state( string $slug ): string {
		$manager = $this->experiments_manager();
		if ( null === $manager ) {
			return self::STATE_DEFAULT;
		}

		$features = method_exists( $manager, 'get_features' ) ? $manager->get_features() : array();
		$features = is_array( $features ) ? $features : array();

		if ( ! isset( $features[ $slug ] ) ) {
			// Slug not registered on this Elementor version (10-rest-api.md §12 / Implementation Notes).
			return self::STATE_DEFAULT;
		}

		if ( method_exists( $manager, 'is_feature_active' ) ) {
			return $manager->is_feature_active( $slug ) ? self::STATE_ACTIVE : self::STATE_INACTIVE;
		}

		return self::STATE_DEFAULT;
	}

	/**
	 * The `experiments` block for `site/capabilities` — every canonical slug mapped to its state
	 * string (10-rest-api.md §12).
	 *
	 * @return array<string,string>
	 */
	public function experiments_map(): array {
		$map = array();
		foreach ( self::EXPERIMENT_SLUGS as $slug ) {
			$map[ $slug ] = $this->experiment_state( $slug );
		}
		return $map;
	}

	/**
	 * `current_user_can(UPDATE_CLASS)` — gates ALL global-class writes (10-rest-api.md §0.3,
	 * spike WP-S05). False => 403 `CAPABILITY_MISSING` on every global-class write.
	 */
	public function can_update_class(): bool {
		return current_user_can( Activator::UPDATE_CLASS );
	}

	/**
	 * Short-circuit guard for Pro-only routes (12-error-taxonomy.md §3.4 `PRO_REQUIRED`).
	 *
	 * @param string $feature Optional feature label for the error meta.
	 * @return true|WP_Error `true` when Pro is active; otherwise a 409 `PRO_REQUIRED` WP_Error.
	 */
	public function require_pro( string $feature = '' ) {
		if ( $this->is_pro_active() ) {
			return true;
		}

		return new WP_Error(
			Error_Codes::PRO_REQUIRED,
			__( 'Elementor Pro is required for this operation.', 'elementor-ultra-mcp' ),
			array(
				'status' => 409,
				'meta'   => array( 'feature' => $feature ),
			)
		);
	}

	/**
	 * Short-circuit guard for experiment-gated routes (12-error-taxonomy.md §3.4
	 * `EXPERIMENT_INACTIVE`). A slug whose state is anything other than `active` fails.
	 *
	 * @param string $slug Experiment slug the route requires.
	 * @return true|WP_Error `true` when the experiment is active; otherwise a 409 `EXPERIMENT_INACTIVE`.
	 */
	public function require_experiment( string $slug ) {
		if ( self::STATE_ACTIVE === $this->experiment_state( $slug ) ) {
			return true;
		}

		return new WP_Error(
			Error_Codes::EXPERIMENT_INACTIVE,
			sprintf(
				/* translators: %s: Elementor experiment slug. */
				__( 'The required Elementor experiment "%s" is not active.', 'elementor-ultra-mcp' ),
				$slug
			),
			array(
				'status' => 409,
				'meta'   => array( 'experiment' => $slug ),
			)
		);
	}

	/**
	 * The Elementor experiments manager instance, or null when Elementor/the manager is absent.
	 * (`\Elementor\Plugin::$instance->experiments`, core/experiments/manager.php.)
	 *
	 * @return object|null
	 */
	private function experiments_manager() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}

		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->experiments ) ) {
			return null;
		}

		return $plugin->experiments;
	}
}
