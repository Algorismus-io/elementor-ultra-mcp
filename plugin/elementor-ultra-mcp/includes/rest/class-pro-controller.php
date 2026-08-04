<?php
/**
 * WP-R01 — PRO REST controller: the registration hub for the whole `/pro/*` surface (10-rest-api.md §8).
 *
 * Contract authority:
 *  - 10-rest-api.md §8 (Pro intro + ConditionTuple), §8.1-§8.3 (theme routes — owned by THIS WP),
 *    §8.4-§8.8 (popup/form/loop/dynamic/woo — owned by sibling WP-R02..WP-R06 services).
 *  - 10-rest-api.md §0.1 (namespace), §0.3 (cap map), §0.5/§0.6 (envelopes), §0.7 (status table).
 *  - 12-error-taxonomy.md §3.4 (`PRO_REQUIRED`).
 *
 * Registration model (ticket Interface + Detailed-Req #1). `Pro_Controller::register_routes()` builds the
 * route table by MERGING this WP's three theme routes (via {@see Theme_Builder_Service::routes()}) with
 * the `routes()` arrays returned by the five sibling Pro services (Popup/Form/Loop/Dynamic/Woo). The
 * descriptor shape is FROZEN here:
 *     [ 'methods'=>WP_REST_Server::*, 'route'=>'/pro/...', 'callback'=>callable,
 *       'permission_callback'=>callable, 'args'=>array ].
 * Each sibling service is loaded class_exists()-guarded — a sibling service file that has not landed yet
 * does NOT fatal (the controller is complete + degrades gracefully). To keep `files_owned` disjoint the
 * sibling WPs NEVER edit this file: they only ship `includes/pro/class-<name>.php` exposing a public
 * `routes(): array`, which the SPL autoloader resolves and this loop picks up.
 *
 * Pro/experiment gating lives in EACH service handler (every `/pro/*` handler first-lines
 * {@see \Elementor\Ultra\Pro\Pro_Gate::require_pro()}) so a Pro-inactive site 501s with `PRO_REQUIRED`
 * (`E_FEATURE_UNAVAILABLE`) at call time; the routes are still REGISTERED (present-but-dormant).
 *
 * Self-registers with the WP-P02 {@see Registrar} via the `elementor_ultra/rest/register` action — it
 * NEVER edits the spine `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Pro\Theme_Builder_Service;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * PRO controller (10-rest-api.md §8). Thin: registration + the descriptor loop only — all business logic
 * lives in the per-domain service classes. Extends the WP-P02 base for the `namespace()` helper.
 */
final class Pro_Controller extends Abstract_Controller {

	/**
	 * The fully-qualified sibling Pro service class names (WP-R02..WP-R06), in `/pro/*` contract order
	 * (§8.4 popup, §8.5 form, §8.6 loop, §8.7 dynamic, §8.8 woo). Each is autoloaded from
	 * `includes/pro/class-<kebab>.php` and exposes a public `routes(): array`. A class that is not yet
	 * present is skipped (class_exists()-guarded) so the controller never fatals on a missing sibling.
	 *
	 * @var string[]
	 */
	const SIBLING_SERVICES = array(
		'\Elementor\Ultra\Pro\Popup_Service',
		'\Elementor\Ultra\Pro\Form_Builder_Service',
		'\Elementor\Ultra\Pro\Loop_Service',
		'\Elementor\Ultra\Pro\Dynamic_Tags_Service',
		'\Elementor\Ultra\Pro\Woo_Service',
	);

	/**
	 * Register every `/pro/*` route (10-rest-api.md §8) under `elementor-ultra/v1`. Merges this WP's
	 * theme routes with each available sibling service's `routes()` and registers them all via the FROZEN
	 * descriptor shape. Each route declares its OWN `args` schema + `permission_callback` (supplied by
	 * its service) so this controller owns no per-route schema.
	 *
	 * @return void
	 */
	public function register_routes(): void {
		foreach ( $this->collect_descriptors() as $descriptor ) {
			if ( ! $this->is_valid_descriptor( $descriptor ) ) {
				continue;
			}
			$this->route(
				(string) $descriptor['route'],
				$descriptor['methods'],
				$descriptor['callback'],
				$descriptor['permission_callback'],
				isset( $descriptor['args'] ) && is_array( $descriptor['args'] ) ? $descriptor['args'] : array()
			);
		}
	}

	/**
	 * Collect every Pro route descriptor: this WP's theme routes plus each available sibling service's
	 * `routes()`. Sibling instantiation is class_exists()-guarded + the `routes()` result is type-checked
	 * so a malformed/absent sibling never breaks registration.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private function collect_descriptors(): array {
		$descriptors = array();

		// This WP — theme builder (inline, always present).
		foreach ( ( new Theme_Builder_Service() )->routes() as $descriptor ) {
			$descriptors[] = $descriptor;
		}

		// Sibling Pro services (WP-R02..WP-R06) — guarded so a not-yet-landed file does not fatal.
		foreach ( self::SIBLING_SERVICES as $class ) {
			if ( ! class_exists( $class ) ) {
				continue; // The SPL autoloader returns false when includes/pro/class-<kebab>.php is absent.
			}
			$service = new $class();
			if ( ! is_object( $service ) || ! method_exists( $service, 'routes' ) ) {
				continue;
			}
			$routes = $service->routes();
			if ( ! is_array( $routes ) ) {
				continue;
			}
			foreach ( $routes as $descriptor ) {
				$descriptors[] = $descriptor;
			}
		}

		return $descriptors;
	}

	/**
	 * Whether a route descriptor matches the FROZEN shape (Detailed-Req #1). Guards against a malformed
	 * sibling descriptor silently registering a broken route.
	 *
	 * @param mixed $descriptor The candidate descriptor.
	 */
	private function is_valid_descriptor( $descriptor ): bool {
		return is_array( $descriptor )
			&& isset( $descriptor['methods'], $descriptor['route'], $descriptor['callback'], $descriptor['permission_callback'] )
			&& is_string( $descriptor['route'] )
			&& is_callable( $descriptor['callback'] )
			&& is_callable( $descriptor['permission_callback'] );
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar globs `class-*-controller.php` and fires `elementor_ultra/rest/register` on
 * `rest_api_init`, passing the live registrar; we hand it a fresh Pro_Controller so it registers the
 * whole §8 PRO surface WITHOUT editing the spine `class-registrar.php` / `class-plugin.php`.
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Pro_Controller() );
		}
	}
);
