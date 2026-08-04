<?php
/**
 * WP-P16 — Server_Registrar: the entry point of the OPTIONAL secondary WP-Abilities integration path.
 *
 * When the `wordpress/mcp-adapter` package is present, this registrar:
 *   (1) registers our ability category + the four abilities via the WordPress Abilities API
 *       (`wp_register_ability` on the `wp_abilities_api_init` action — WP core
 *       wp-includes/abilities-api.php:278, requires registration on that action), and
 *   (2) on the adapter's bootstrap action `mcp_adapter_init`, calls the adapter's `create_server()` to
 *       expose those abilities at an in-WordPress MCP endpoint (`/wp-json/elementor-ultra/mcp`),
 *       reusing the SAME App-Password + `current_user_can` boundary as REST (10-rest-api.md §0.2/§0.3).
 *
 * When the adapter is ABSENT (the common case — and the case on the live dev site, where the
 * `e_wp_abilities_api` experiment / mcp-adapter is inactive), this whole layer is a GRACEFUL NO-OP:
 * no abilities registered, no server created, NO fatal, NO admin notice — only the
 * `site/capabilities.abilities_adapter_present:false` flag (10-rest-api.md §12; WP-P16 Detailed
 * Requirements #1, Acceptance #1). The plugin's primary REST path (WP-P02..P15) is fully functional
 * without it.
 *
 * Contract authority:
 *  - 10-rest-api.md §12 (`abilities_adapter_present`), §11 (op-log wired to the same store), §0.2/§0.3
 *    (auth/cap boundary reused).
 *  - 15-engineering-standards.md §1 (optional `wordpress/mcp-adapter`, guarded — graceful no-op), §5
 *    (secondary path).
 *
 * ALL adapter symbols are pinned behind `class_exists`/`function_exists`/`did_action` (the adapter's API
 * surface is version-sensitive — WP-P16 Implementation Notes). The registrar's hook registration is
 * cheap: ability objects are only constructed when the secondary path is actually present.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Abilities;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Registers the secondary-path abilities + own MCP server when the optional adapter is present;
 * otherwise a no-op. Also the AUTHORITATIVE detector of adapter presence ({@see is_adapter_present()}).
 */
final class Server_Registrar {

	/**
	 * The optional `wordpress/mcp-adapter` bootstrap action (WP-P16 Interface / Implementation Notes —
	 * "cite the adapter's bootstrap action name `mcp_adapter_init`"). The adapter fires this on init so
	 * integrations can call `create_server()`; absent => never fired => secondary path stays dormant.
	 */
	const ADAPTER_INIT_ACTION = 'mcp_adapter_init';

	/**
	 * The WordPress core Abilities API registration action (wp-includes/abilities-api.php:278 — abilities
	 * MUST be registered on `wp_abilities_api_init`, else `_doing_it_wrong`). We only hook it when the
	 * secondary path is present.
	 */
	const ABILITIES_INIT_ACTION = 'wp_abilities_api_init';

	/**
	 * The WordPress core ability-CATEGORY registration action (wp-includes/abilities-api.php:467 —
	 * categories MUST be registered on `wp_abilities_api_categories_init`, a SEPARATE, EARLIER action than
	 * `wp_abilities_api_init`; registering a category on the wrong action `_doing_it_wrong`s + returns
	 * null). We only hook it when the secondary path is present.
	 */
	const CATEGORIES_INIT_ACTION = 'wp_abilities_api_categories_init';

	/** Our MCP server id (the secondary in-WordPress endpoint, exposed under the plugin namespace). */
	const SERVER_ID = 'elementor-ultra';

	/** The route namespace the secondary MCP endpoint is exposed under — `/wp-json/elementor-ultra/mcp`. */
	const SERVER_ROUTE_NAMESPACE = 'elementor-ultra';

	/** The route base within the namespace (`/wp-json/elementor-ultra/mcp`). */
	const SERVER_ROUTE = 'mcp';

	/**
	 * Candidate FQCNs for the `wordpress/mcp-adapter` server class across versions. The adapter's API
	 * surface is version-sensitive (WP-P16 Implementation Notes), so we probe a small set behind
	 * `class_exists`. If NONE resolve, the adapter is absent and the path is a no-op.
	 *
	 * @var string[]
	 */
	const ADAPTER_CLASS_CANDIDATES = array(
		'\WP\MCP\Core\McpAdapter',
		'\WP\MCP\McpAdapter',
		'\Automattic\MCP\McpAdapter',
		'\McpAdapter',
	);

	/**
	 * Memoized adapter-presence result (computed once per request).
	 *
	 * @var bool|null
	 */
	private static $adapter_present = null;

	/**
	 * Wire the secondary path — CHEAP, idempotent. Called by {@see \Elementor\Ultra\Plugin::init()}
	 * (behind a `class_exists` guard; the spine does not edit this file). Hooks the adapter's bootstrap
	 * action (a no-op until/unless the adapter fires it) and, when the secondary path is present, the
	 * core Abilities-API registration action. Constructs NO ability objects unless the path is present.
	 *
	 * @return void
	 */
	public static function init(): void {
		// Always (cheaply) listen for the adapter's bootstrap; the closure short-circuits if absent. If
		// the adapter is absent this listener simply never fires (the adapter never does the action).
		add_action( self::ADAPTER_INIT_ACTION, array( __CLASS__, 'on_adapter_init' ) );

		// Register the category + abilities on the core Abilities-API actions ONLY when the secondary path
		// is present — they are the secondary path's payload (WP-P16 Detailed Requirements #2/#7). When
		// the adapter is absent we stay fully dormant (Acceptance #1). The category MUST be registered on
		// the earlier `wp_abilities_api_categories_init` (abilities-api.php:467) BEFORE the abilities
		// (which reference it) register on `wp_abilities_api_init` (abilities-api.php:278).
		if ( self::is_secondary_path_present() ) {
			add_action( self::CATEGORIES_INIT_ACTION, array( __CLASS__, 'register_category' ) );
			add_action( self::ABILITIES_INIT_ACTION, array( __CLASS__, 'register_abilities' ) );
		}
	}

	/**
	 * The adapter's bootstrap callback (`mcp_adapter_init`). Fires ONLY when the `wordpress/mcp-adapter`
	 * is installed + initializing. Registers our abilities (idempotently, in case the abilities action
	 * already ran) and creates our own MCP server exposing them at `/wp-json/elementor-ultra/mcp`.
	 *
	 * @param mixed $adapter The adapter instance passed by `do_action( 'mcp_adapter_init', $adapter )`
	 *                       (signature is version-sensitive; treated opaquely behind guards).
	 * @return void
	 */
	public static function on_adapter_init( $adapter = null ): void {
		if ( ! self::is_secondary_path_present() ) {
			return; // Defensive: only act when the adapter genuinely resolved.
		}

		// The category + abilities register on their own (earlier) core actions wired in init(); the
		// adapter's bootstrap fires AFTER both, so by here they are already registered. We must NOT call
		// `wp_register_ability(_category)` outside their `doing_action` context (core `_doing_it_wrong`s +
		// returns null — abilities-api.php:281,468). So `on_adapter_init` only stands up our MCP server.
		self::create_server( $adapter );
	}

	/**
	 * Register the four abilities via the WordPress Abilities API (`wp_register_ability` —
	 * wp-includes/abilities-api.php:278). MUST run on `wp_abilities_api_init` (wired in {@see init()}).
	 * Each ability delegates to the SAME core service the REST controller uses (single source of truth —
	 * WP-P16 #3). Guarded so a partial environment (Abilities API absent) degrades silently. The category
	 * is registered separately + earlier by {@see register_category()} on `wp_abilities_api_categories_init`.
	 *
	 * @return void
	 */
	public static function register_abilities(): void {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return; // Core Abilities API not present — nothing to register.
		}

		foreach ( self::abilities() as $ability ) {
			$definition = $ability->to_definition();

			// Idempotent: skip if already registered (the action can run via two paths).
			if ( function_exists( 'wp_has_ability' ) && wp_has_ability( $definition->name() ) ) {
				continue;
			}

			wp_register_ability( $definition->name(), $definition->args() );
		}
	}

	/**
	 * Create our OWN MCP server via the adapter's `create_server()` (10-rest-api.md §5 secondary path),
	 * exposing the four abilities at `/wp-json/elementor-ultra/mcp` with auth + capability gating reusing
	 * the SAME App-Password / `current_user_can` boundary as REST (each ability's `permission_callback`).
	 *
	 * The adapter's `create_server()` signature is version-sensitive (WP-P16 Implementation Notes), so we
	 * resolve the adapter instance/class defensively and only invoke a `create_server` method when it is
	 * callable. The op-log observability handler is the SAME store as REST — ability WRITES append via
	 * `Document_Writer`'s `Op_Log::record` (10-rest-api.md §11), so no separate wiring is needed here.
	 *
	 * @param mixed $adapter The adapter instance from `mcp_adapter_init`, when provided.
	 * @return void
	 */
	private static function create_server( $adapter = null ): void {
		$instance = is_object( $adapter ) ? $adapter : self::adapter_instance();
		if ( null === $instance || ! is_object( $instance ) || ! method_exists( $instance, 'create_server' ) ) {
			return; // Adapter present but no usable create_server on this version — degrade silently.
		}

		$ability_names = array();
		foreach ( self::abilities() as $ability ) {
			$ability_names[] = $ability->to_definition()->name();
		}

		// Defensive invocation: the exact create_server() arity is version-sensitive. We pass the
		// well-known descriptor positionally; any TypeError/argument mismatch is swallowed so a version
		// skew can NEVER break the primary REST path (WP-P16 Implementation Notes).
		try {
			$instance->create_server(
				self::SERVER_ID,
				self::SERVER_ROUTE_NAMESPACE,
				self::SERVER_ROUTE,
				__( 'Elementor Ultra MCP', 'elementor-ultra-mcp' ),
				__( 'In-WordPress MCP server exposing Elementor Ultra abilities (secondary path).', 'elementor-ultra-mcp' ),
				(string) ( defined( 'EMCP_VERSION' ) ? EMCP_VERSION : '1.0.0' ),
				array(),       // transports — adapter default.
				array(),       // error handler — adapter default.
				$ability_names // the abilities this server exposes.
			);
		} catch ( \Throwable $e ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- diagnostic only; the optional secondary path must never fatal.
			error_log( 'Elementor Ultra MCP secondary-path create_server skipped: ' . $e->getMessage() );
		}
	}

	/**
	 * Whether the optional `wordpress/mcp-adapter` is present. AUTHORITATIVE detection for the
	 * `site/capabilities.abilities_adapter_present` flag (10-rest-api.md §12; WP-P16 Detailed
	 * Requirements #6 — this WP owns the registrar that knows whether the adapter loaded). Memoized.
	 *
	 * Public so the capabilities probe (or any caller) can report accurate adapter presence rather than
	 * inferring it from an experiment slug.
	 */
	public static function is_adapter_present(): bool {
		if ( null !== self::$adapter_present ) {
			return self::$adapter_present;
		}

		foreach ( self::ADAPTER_CLASS_CANDIDATES as $class ) {
			if ( class_exists( $class ) ) {
				self::$adapter_present = true;
				return true;
			}
		}

		self::$adapter_present = false;
		return false;
	}

	/**
	 * Whether the secondary path should activate: the adapter must be present (its absence makes the
	 * whole layer a no-op). Kept separate from {@see is_adapter_present()} so the gating condition has a
	 * single, named home.
	 */
	private static function is_secondary_path_present(): bool {
		return self::is_adapter_present();
	}

	/**
	 * Register the ability category (`wp_register_ability_category` — abilities-api.php:467, REQUIRED on
	 * the `wp_abilities_api_categories_init` action BEFORE the abilities that reference it register on
	 * `wp_abilities_api_init`). MUST run on that earlier action (wired in {@see init()}); calling it off
	 * that action `_doing_it_wrong`s + returns null. Idempotent + guarded so it degrades silently when
	 * unavailable. Public so it can be the action callback.
	 *
	 * @return void
	 */
	public static function register_category(): void {
		if ( ! function_exists( 'wp_register_ability_category' ) ) {
			return;
		}

		if ( function_exists( 'wp_has_ability_category' ) && wp_has_ability_category( Abstract_Ability::ABILITY_CATEGORY ) ) {
			return;
		}

		wp_register_ability_category(
			Abstract_Ability::ABILITY_CATEGORY,
			array(
				'label'       => __( 'Elementor Ultra', 'elementor-ultra-mcp' ),
				'description' => __( 'Abilities for authoring and inspecting Elementor documents via the Elementor Ultra MCP secondary path.', 'elementor-ultra-mcp' ),
			)
		);
	}

	/**
	 * The MVP-minimal set of concrete abilities (WP-P16 Interface): read structure, dry-run, save
	 * elements, capabilities. Each is a thin schema+permission+delegation shell over a core service.
	 * Additional abilities are added later as new files (disjoint) — this list is the only enumeration.
	 *
	 * @return Abstract_Ability[]
	 */
	private static function abilities(): array {
		return array(
			new Read_Structure_Ability(),
			new Dry_Run_Ability(),
			new Save_Elements_Ability(),
			new Capabilities_Ability(),
		);
	}

	/**
	 * Resolve the adapter singleton instance when `mcp_adapter_init` did not hand one to us. Probes the
	 * candidate classes for a conventional `instance()`/`get_instance()` accessor; returns null when
	 * none is available (the path then stays dormant). Version-sensitive, fully guarded.
	 *
	 * @return object|null
	 */
	private static function adapter_instance() {
		foreach ( self::ADAPTER_CLASS_CANDIDATES as $class ) {
			if ( ! class_exists( $class ) ) {
				continue;
			}
			foreach ( array( 'instance', 'get_instance' ) as $accessor ) {
				if ( method_exists( $class, $accessor ) ) {
					$candidate = call_user_func( array( $class, $accessor ) );
					if ( is_object( $candidate ) ) {
						return $candidate;
					}
				}
			}
		}
		return null;
	}
}
