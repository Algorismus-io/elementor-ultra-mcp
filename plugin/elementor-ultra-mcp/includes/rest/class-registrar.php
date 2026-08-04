<?php
/**
 * WP-P02 — REST registrar: wires every controller under `elementor-ultra/v1` on `rest_api_init`.
 *
 * Contract authority: 10-rest-api.md §0.1 (namespace `elementor-ultra/v1`), §0.5 (success envelope);
 * 12-error-taxonomy.md §3.4 (auth/cap surfaces); spike WP-S06 (Basic auth over plain HTTP — NO HTTPS
 * enforcement here; `?rest_route=` access works for the registered routes).
 *
 * Boot seam: {@see \Elementor\Ultra\Plugin::init()} (WP-P01 spine) calls the STATIC
 * `\Elementor\Ultra\Rest\Registrar::init()` behind `class_exists`/`method_exists`. `init()` hooks
 * `rest_api_init`; on that hook it fires the `elementor_ultra/rest/register` action passing the live
 * registrar so each controller WP self-registers via
 *   `add_action( 'elementor_ultra/rest/register', fn( $reg ) => $reg->register_controller( new Foo_Controller() ) );`
 * — adding a controller therefore NEVER edits this file (the parallelism principle). After the action
 * the registrar calls `register_routes()` on every collected controller.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Plugin;
use WP_REST_Request;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Collects controllers (via an action) and registers their routes on `rest_api_init`.
 */
final class Registrar {

	/** The action controllers hook to self-register (Detailed Requirements #1). */
	const REGISTER_ACTION = 'elementor_ultra/rest/register';

	/** Singleton — the registrar instance hooked on `rest_api_init`. */
	private static ?Registrar $instance = null;

	/**
	 * Collected controllers awaiting `register_routes()`.
	 *
	 * @var Abstract_Controller[]
	 */
	private $controllers = array();

	/**
	 * Every controller CLASS ever collected (`class-string => class-string`), across registration
	 * rounds. The WP test framework's hook restoration strips the controllers' file-scope
	 * `REGISTER_ACTION` hooks between tests (file-scope `add_action` only runs once per `require_once`),
	 * so a re-fire would collect nothing — known classes are re-instantiated instead (additive only;
	 * production fires once per request so this stays a no-op there).
	 *
	 * @var array<string,string>
	 */
	private $known_controllers = array();

	/**
	 * The `WP_REST_Server` instance routes were last registered against (idempotency guard).
	 *
	 * Per-SERVER, not per-process: WordPress fires `rest_api_init` every time the REST server global
	 * is (re)built (`rest_get_server()`, and the WP test pattern of `new WP_REST_Server` per test).
	 * Core controllers re-register on each fire; a boolean guard would leave any SECOND server of the
	 * process without our namespace (observed as 404s in the PHPUnit suite).
	 *
	 * @var WP_REST_Server|null
	 */
	private $registered_server = null;

	/** Private constructor — use {@see Registrar::init()}. */
	private function __construct() {}

	/**
	 * Static boot entry the spine ({@see Plugin::init()}) invokes. Hooks `rest_api_init` so route
	 * registration happens at the correct WordPress lifecycle stage. Idempotent across multiple calls.
	 *
	 * @return void
	 */
	public static function init() {
		$registrar = self::instance();
		add_action( 'rest_api_init', array( $registrar, 'register_routes' ) );
	}

	/** The registrar singleton. */
	public static function instance(): Registrar {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * A controller self-registers by passing its instance here (from the `REGISTER_ACTION` hook).
	 *
	 * @param Abstract_Controller $controller The controller to register.
	 * @return void
	 */
	public function register_controller( Abstract_Controller $controller ) {
		$this->controllers[] = $controller;
	}

	/**
	 * `rest_api_init` callback. Fires the self-registration action (so controllers add themselves), then
	 * registers the seam health route + every collected controller's routes. Idempotent per SERVER:
	 * a repeat fire against the same `WP_REST_Server` is a no-op, while a NEW server (core rebuilds the
	 * global; tests construct one per case) re-registers the full namespace like core controllers do.
	 *
	 * @param WP_REST_Server|null $server The server `rest_api_init` passed (null on direct calls).
	 * @return void
	 */
	public function register_routes( $server = null ) {
		if ( ! $server instanceof WP_REST_Server && isset( $GLOBALS['wp_rest_server'] ) && $GLOBALS['wp_rest_server'] instanceof WP_REST_Server ) {
			$server = $GLOBALS['wp_rest_server'];
		}
		if ( null !== $this->registered_server && $this->registered_server === $server ) {
			return;
		}
		$this->registered_server = $server;
		$this->controllers       = array(); // Fresh collection round — never double-register on re-fires.

		// Always-present seam health route (proves the routing+auth+envelope scaffolding live).
		$this->register_seam_route();

		// Spine controller-discovery (01-architecture.md §4.4 wave-boundary include): the SPL autoloader
		// is LAZY, so a controller's file-scope `add_action( REGISTER_ACTION, ... )` self-registration
		// never runs until something loads the file. This generic glob require_once's every
		// `class-*-controller.php` sibling BEFORE the action fires, so each controller WP self-registers
		// without this spine file ever being edited per-controller (the parallelism principle holds).
		$this->load_controllers();

		// Let every controller WP add itself without editing this spine file (Detailed Requirements #1).
		do_action( self::REGISTER_ACTION, $this );

		// Re-fire resilience: file-scope hooks fire only on FIRST file load, and the WP test framework
		// strips mid-test-added hooks between tests — re-instantiate any known class that did not
		// self-collect this round (see {@see Registrar::$known_controllers}).
		$collected = array();
		foreach ( $this->controllers as $controller ) {
			$collected[ get_class( $controller ) ] = true;
		}
		foreach ( $this->known_controllers as $class ) {
			if ( ! isset( $collected[ $class ] ) && class_exists( $class ) ) {
				$this->controllers[] = new $class();
			}
		}

		foreach ( $this->controllers as $controller ) {
			$this->known_controllers[ get_class( $controller ) ] = get_class( $controller );
			$controller->register_routes();
		}
	}

	/**
	 * Load every `class-*-controller.php` in this directory so their file-scope self-registration hooks
	 * are in place when {@see self::REGISTER_ACTION} fires. Generic + idempotent (`require_once`): a new
	 * controller WP just drops its file here and is picked up — no edit to this spine method. The
	 * non-controller infrastructure files (`class-registrar.php`, `class-abstract-controller.php`,
	 * `class-permissions.php`, `class-response.php`) do not match the `*-controller.php` glob except the
	 * abstract base, which is skipped explicitly (it is autoloaded on demand by the concrete controllers).
	 *
	 * @return void
	 */
	private function load_controllers() {
		$files = glob( __DIR__ . '/class-*-controller.php' );
		if ( false === $files ) {
			return;
		}
		foreach ( $files as $file ) {
			if ( 'class-abstract-controller.php' === basename( $file ) ) {
				continue; // Abstract base — autoloaded on demand by concrete controllers.
			}
			require_once $file;
		}
	}

	/**
	 * Register the minimal internal seam route `GET elementor-ultra/v1/_seam`. It is the canonical proof
	 * that a route registered through the registrar is callable under App-Password Basic auth and returns
	 * the EXACT `{success,data}` envelope (10-rest-api.md §0.5) — and that an unauthenticated request
	 * gets WordPress core's 401 BEFORE the `permission_callback` runs (10 §0.2 / §0.7, spike S6). It is a
	 * read-only diagnostic gated by CAP_READ (`edit_posts`); it is NOT the frozen `site/capabilities`
	 * route (that is owned by WP-P07) and carries no Elementor coupling.
	 *
	 * @return void
	 */
	private function register_seam_route() {
		register_rest_route(
			Plugin::REST_NAMESPACE,
			'/_seam',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'seam_handler' ),
				'permission_callback' => Permissions::can_read(),
				'args'                => array(),
			)
		);
	}

	/**
	 * Seam health handler: returns the §0.5 success envelope with a tiny, dependency-free payload.
	 *
	 * @param WP_REST_Request $request The current request (unused).
	 * @return \WP_REST_Response
	 */
	public function seam_handler( WP_REST_Request $request ) {
		unset( $request );
		return Response::success(
			array(
				'ok'             => true,
				'namespace'      => Plugin::REST_NAMESPACE,
				'plugin_version' => Plugin::VERSION,
				'controllers'    => count( $this->controllers ),
			)
		);
	}
}
