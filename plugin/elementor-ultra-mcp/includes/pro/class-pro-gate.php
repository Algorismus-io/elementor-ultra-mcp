<?php
/**
 * WP-R01 — Pro_Gate: the shared Pro/experiment presence gate every `/pro/*` route first-lines.
 *
 * Contract authority:
 *  - 10-rest-api.md §8 (Pro intro: "EVERY route here first checks Pro is active and the needed
 *    experiment; if not -> 501 `E_FEATURE_UNAVAILABLE` (`data.meta.{pro_active,experiment}`)").
 *  - 10-rest-api.md §0.7 (status table — row 501: "route present but feature gated off
 *    (experiment/Pro inactive) -> `E_FEATURE_UNAVAILABLE`").
 *  - 12-error-taxonomy.md §3.4 (`PRO_REQUIRED`, `EXPERIMENT_INACTIVE`).
 *
 * Code-vs-status reconciliation (recorded as a WP deviation): the FROZEN taxonomy
 * {@see \Elementor\Ultra\Error_Codes} assigns `PRO_REQUIRED`/`EXPERIMENT_INACTIVE` a default HTTP
 * status of 409, but the REST contract §0.7 / §8 mandate HTTP 501 for "feature gated off" on the
 * `/pro/*` surface (the wire-code label is `E_FEATURE_UNAVAILABLE`). The WP-R01 ticket states this
 * verbatim — "Return 501 `E_FEATURE_UNAVAILABLE` … (HTTP 501, taxonomy `PRO_REQUIRED`)". This gate
 * therefore emits the canonical taxonomy `code` (`PRO_REQUIRED`/`EXPERIMENT_INACTIVE`) with an
 * EXPLICIT 501 status (the §0.7 status takes precedence over the taxonomy default for this surface).
 *
 * Pro presence is detected via `defined('ELEMENTOR_PRO_VERSION')` (elementor-pro/elementor-pro.php
 * defines it at file scope) AND `class_exists('\ElementorPro\Plugin')`. When Pro is ABSENT the gate
 * returns the 501 `WP_Error` so the route is dormant-but-present (graceful degradation) — on the live
 * dev site Pro 4.1.0 IS active, so the gate passes.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Rest\Response;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Shared Pro/experiment gate. All methods are static so any `/pro/*` handler can first-line them
 * without wiring (mirrors {@see \Elementor\Ultra\Core\Document_Writer}'s static surface).
 */
final class Pro_Gate {

	/** The HTTP status the §0.7 status table mandates for a gated-off Pro feature. */
	const FEATURE_UNAVAILABLE_STATUS = 501;

	/**
	 * Whether Elementor Pro is active. True iff BOTH the Pro version constant is defined AND the Pro
	 * plugin class exists (elementor-pro/elementor-pro.php defines `ELEMENTOR_PRO_VERSION`; the Pro
	 * autoloader exposes `\ElementorPro\Plugin`).
	 */
	public static function is_pro_active(): bool {
		return defined( 'ELEMENTOR_PRO_VERSION' ) && class_exists( '\ElementorPro\Plugin' );
	}

	/**
	 * Whether an Elementor experiment is ACTIVE. Reads the core experiments manager
	 * (`\Elementor\Plugin::$instance->experiments->is_feature_active($slug)`,
	 * elementor/core/experiments/manager.php:257). Returns false when Elementor is unavailable.
	 *
	 * @param string $slug The experiment slug (e.g. `e_pro_atomic_form`).
	 */
	public static function is_experiment_active( string $slug ): bool {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return false;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->experiments ) || ! is_object( $plugin->experiments ) ) {
			return false;
		}
		if ( ! method_exists( $plugin->experiments, 'is_feature_active' ) ) {
			return false;
		}
		return (bool) $plugin->experiments->is_feature_active( $slug );
	}

	/**
	 * Pro-presence guard every `/pro/*` handler first-lines. Returns `true` when Pro is active, else a
	 * 501 `PRO_REQUIRED` (`E_FEATURE_UNAVAILABLE`) `WP_Error` with `data.meta.pro_active=false`
	 * (10-rest-api.md §8 / §0.7). Returning the `WP_Error` directly from a route callback makes
	 * WordPress serialize it to the §0.6 envelope with the 501 status line.
	 *
	 * @param string|null $op_id Echoed request op_id when supplied.
	 * @return true|WP_Error
	 */
	public static function require_pro( ?string $op_id = null ) {
		if ( self::is_pro_active() ) {
			return true;
		}
		return Response::error(
			Error_Codes::PRO_REQUIRED,
			__( 'This route requires Elementor Pro, which is not active on this site.', 'elementor-ultra-mcp' ),
			self::FEATURE_UNAVAILABLE_STATUS,
			array( 'pro_active' => false ),
			array(),
			$op_id
		);
	}

	/**
	 * Experiment guard for routes that ALSO require a specific Elementor experiment (e.g. the atomic
	 * form path's `e_pro_atomic_form`, deferred to WP-R03). Returns `true` when the experiment is
	 * active, else a 501 `EXPERIMENT_INACTIVE` (`E_FEATURE_UNAVAILABLE`) `WP_Error` with
	 * `data.meta.experiment=<slug>` (10-rest-api.md §8). Callers first-line {@see require_pro()} BEFORE
	 * this so a Pro-inactive site reports `pro_active:false` rather than an experiment slug.
	 *
	 * @param string      $slug  The required experiment slug.
	 * @param string|null $op_id Echoed request op_id when supplied.
	 * @return true|WP_Error
	 */
	public static function require_experiment( string $slug, ?string $op_id = null ) {
		if ( self::is_experiment_active( $slug ) ) {
			return true;
		}
		return Response::error(
			Error_Codes::EXPERIMENT_INACTIVE,
			sprintf(
				/* translators: %s: experiment slug. */
				__( 'This route requires the "%s" Elementor experiment, which is not active.', 'elementor-ultra-mcp' ),
				$slug
			),
			self::FEATURE_UNAVAILABLE_STATUS,
			array(
				'pro_active' => self::is_pro_active(),
				'experiment' => $slug,
			),
			array(),
			$op_id
		);
	}
}
