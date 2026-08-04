<?php
/**
 * Plugin Name:       Elementor Ultra MCP
 * Plugin URI:        https://github.com/Algorismus-io/elementor-ultra-mcp
 * Description:        Companion WordPress plugin for the Elementor Ultra MCP server. Exposes the `elementor-ultra/v1` REST seam (documents, schema, design system, media, templates, Pro, ops, capabilities) consumed by the external TypeScript MCP server.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Requires Plugins:  elementor
 * Author:            Algorismus
 * Author URI:        https://algorismus.io
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       elementor-ultra-mcp
 *
 * @package Elementor\Ultra
 *
 * Bootstrap responsibilities (WP-P01, contract 10-rest-api.md §0.1/§0.3/§12,
 * 15-engineering-standards.md §1/§3/§7):
 *  - Define the load-bearing plugin constants every other PHP WP loads against.
 *  - Register the Composer (Jetpack) autoloader when present, else a minimal SPL
 *    fallback mapping `Elementor\Ultra\` -> includes/ (so the plugin activates on a
 *    bind-mounted live site with NO `composer install`).
 *  - Register the idempotent UPDATE_CLASS activation grant (WP-P01 / spike WP-S05).
 *  - Boot `Plugin` on `plugins_loaded` only when Elementor is present + compatible;
 *    on an incompatible/absent Elementor it STILL lets `Plugin::instance()` exist so
 *    `site/capabilities` can report health (15-engineering-standards.md §7 — never fatal).
 */

namespace Elementor\Ultra;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/*
 * --------------------------------------------------------------------------
 * Plugin constants (Detailed Requirements #1).
 * --------------------------------------------------------------------------
 * EMCP_* are the contract-named constants other WPs reference. We ALSO define
 * ELEMENTOR_ULTRA_MCP_VERSION because WP-F05's Capabilities::plugin_version()
 * reads that symbol for the `site/capabilities` payload; defining both keeps the
 * frozen capability probe correct without editing F05's owned file.
 */
if ( ! defined( 'EMCP_VERSION' ) ) {
	define( 'EMCP_VERSION', '1.0.0' );
}
if ( ! defined( 'EMCP_FILE' ) ) {
	define( 'EMCP_FILE', __FILE__ );
}
if ( ! defined( 'EMCP_PATH' ) ) {
	define( 'EMCP_PATH', plugin_dir_path( __FILE__ ) );
}
if ( ! defined( 'EMCP_URL' ) ) {
	define( 'EMCP_URL', plugin_dir_url( __FILE__ ) );
}
if ( ! defined( 'ELEMENTOR_ULTRA_MCP_VERSION' ) ) {
	// Mirror of EMCP_VERSION consumed by WP-F05 Capabilities::plugin_version().
	define( 'ELEMENTOR_ULTRA_MCP_VERSION', EMCP_VERSION );
}

/*
 * --------------------------------------------------------------------------
 * Autoloading (Detailed Requirements #1).
 * --------------------------------------------------------------------------
 * Prefer the Composer (Jetpack) autoloader when a `composer install` has run.
 * On the bind-mounted live site there is NO vendor/, so the require MUST be
 * guarded by file_exists and a lightweight SPL autoloader takes over.
 */
$emcp_composer_autoload = __DIR__ . '/vendor/autoload.php';
if ( file_exists( $emcp_composer_autoload ) ) {
	require_once $emcp_composer_autoload;
}
unset( $emcp_composer_autoload );

/**
 * Minimal PSR-4 fallback autoloader for `Elementor\Ultra\` -> includes/.
 *
 * Maps `Elementor\Ultra\Foo_Bar` -> includes/class-foo-bar.php and
 * `Elementor\Ultra\Core\Foo_Bar` -> includes/core/class-foo-bar.php (WordPress
 * file-naming, 15-engineering-standards.md §3.2). Because some shared classes
 * (WP-F05 Error_Codes / Capabilities / WP_Error_Map) live physically under
 * includes/core/ while keeping the FLAT `Elementor\Ultra` namespace, the loader
 * falls back to searching includes/core/ when the primary PSR-4 path is absent.
 *
 * @param string $class Fully-qualified class name being autoloaded.
 * @return void
 */
function emcp_autoload( $class ) {
	$prefix = 'Elementor\\Ultra\\';
	if ( 0 !== strpos( $class, $prefix ) ) {
		return;
	}

	// Sub-namespace path relative to the namespace root (e.g. "Core\Guards" or "Error_Codes").
	$relative = substr( $class, strlen( $prefix ) );
	$parts    = explode( '\\', $relative );

	// Last segment -> WP file name `class-<kebab>.php` (underscores -> hyphens, lowercased).
	$class_name = array_pop( $parts );
	$file_name  = 'class-' . strtolower( str_replace( '_', '-', $class_name ) ) . '.php';

	// Sub-namespace segments -> directory path (e.g. Core -> core/).
	$sub_dir = '';
	if ( ! empty( $parts ) ) {
		$sub_dir = strtolower( str_replace( '_', '-', implode( '/', $parts ) ) ) . '/';
	}

	$base = EMCP_PATH . 'includes/';

	// 1) Primary PSR-4 path: includes/<sub-namespace>/class-<name>.php.
	$primary = $base . $sub_dir . $file_name;
	if ( is_readable( $primary ) ) {
		require_once $primary;
		return;
	}

	// 2) Fallback for flat-namespaced shared classes physically nested in includes/core/.
	$fallback = $base . 'core/' . $file_name;
	if ( '' === $sub_dir && is_readable( $fallback ) ) {
		require_once $fallback;
	}
}

\spl_autoload_register( __NAMESPACE__ . '\\emcp_autoload' );

/*
 * --------------------------------------------------------------------------
 * Activation hook (Implementation Notes — must be registered at file scope).
 * --------------------------------------------------------------------------
 * The activator is required directly because the autoloader (and Elementor) may
 * not be ready when activation runs (activation fires before `plugins_loaded`).
 */
require_once __DIR__ . '/includes/core/class-activator.php';
register_activation_hook( __FILE__, array( __NAMESPACE__ . '\\Core\\Activator', 'activate' ) );

/*
 * --------------------------------------------------------------------------
 * Re-grant safety net (Detailed Requirements #7).
 * --------------------------------------------------------------------------
 * On a site where the plugin was UPDATED (not re-activated) and the Elementor
 * migration never granted UPDATE_CLASS to administrator, re-run the grant once
 * per request for `administrator` only, guarded by a short transient so it is
 * cheap. We never broaden the safety-net grant beyond administrator.
 */
add_action(
	'admin_init',
	static function () {
		if ( ! function_exists( 'get_transient' ) || get_transient( 'emcp_update_class_safety_net' ) ) {
			return;
		}
		set_transient( 'emcp_update_class_safety_net', 1, HOUR_IN_SECONDS );
		Core\Activator::ensure_administrator_cap();
	}
);

/*
 * --------------------------------------------------------------------------
 * PHASE 2 (T2) — Additive X-MCP-API-Key auth bridge.
 * --------------------------------------------------------------------------
 * Registers a `determine_current_user` filter (priority 30, after core cookie +
 * Application-Password validators) that resolves a dedicated least-privilege
 * service user when a request carries a valid `X-MCP-API-Key`. Purely additive:
 * the existing App-Password / capability auth path is untouched. Also registers
 * the `wp elementor-ultra mcp-key` provisioning command under WP-CLI.
 */
Core\Mcp_Key_Auth::boot();

/*
 * --------------------------------------------------------------------------
 * Optional local-only App-Password availability filter (spike WP-S06).
 * --------------------------------------------------------------------------
 * App-Password Basic AUTH already works over plain HTTP with NO filter. This
 * filter ONLY affects App-Password CREATION via the WP admin UI on a non-SSL
 * host, and is hard-guarded to local environments so production keeps HTTPS.
 */
add_filter(
	'wp_is_application_passwords_available',
	static function ( $available ) {
		return ( function_exists( 'wp_get_environment_type' ) && 'local' === wp_get_environment_type() )
			? true
			: $available;
	}
);

/*
 * --------------------------------------------------------------------------
 * GATE LOCK (contract 17 §3) — vector-agnostic publish quarantine.
 * --------------------------------------------------------------------------
 * The fidelity verify gate (TS) reverts a bad conversion to DRAFT and marks the
 * post `_emcp_quarantined`. A build tried to force such a page live by POSTing
 * CORE WP REST (`/wp-json/wp/v2/pages/<id>` {status:'publish'}) from the
 * authenticated browser — bypassing the elementor-ultra MCP gate entirely.
 *
 * `wp_insert_post_data` is the ONE seam every publish flows through (core REST,
 * wp-admin, WP-CLI, the MCP), so enforcing here is vector-agnostic: a quarantined
 * post is forced back to `draft` on any publish attempt, no matter how it arrives.
 * The quarantine clears on a PASSING re-conversion (the TS convert handler calls
 * the endpoint below) or by a human deleting the meta.
 */
add_filter(
	'wp_insert_post_data',
	static function ( $data, $postarr ) {
		$public = array( 'publish', 'private', 'future' );
		if ( ! is_array( $data ) || ! isset( $data['post_status'] ) || ! in_array( $data['post_status'], $public, true ) ) {
			return $data;
		}
		$id = isset( $postarr['ID'] ) ? (int) $postarr['ID'] : 0;
		if ( $id > 0 && get_post_meta( $id, '_emcp_quarantined', true ) ) {
			$data['post_status'] = 'draft';
			error_log( sprintf( '[elementor-ultra] GATE LOCK: forced post %d back to draft — quarantined by a failed verify gate (contract 17 §3).', $id ) );
		}
		return $data;
	},
	10,
	2
);

/*
 * Quarantine set/clear endpoint — the TS convert handler marks a gate-FAILED page
 * quarantined and CLEARS it on a passing conversion. Setting it also forces a live
 * page back to draft immediately. Edit cap required (App-Password authed).
 */
add_action(
	'rest_api_init',
	static function () {
		register_rest_route(
			'elementor-ultra/v1',
			'/documents/(?P<id>\\d+)/quarantine',
			array(
				'methods'             => 'POST',
				'permission_callback' => static function () {
					return function_exists( 'current_user_can' ) && current_user_can( 'edit_posts' );
				},
				'callback'            => static function ( $request ) {
					$id = (int) $request['id'];
					$on = filter_var( $request->get_param( 'on' ), FILTER_VALIDATE_BOOLEAN );
					if ( $on ) {
						update_post_meta( $id, '_emcp_quarantined', '1' );
						$reason = $request->get_param( 'reason' );
						if ( is_string( $reason ) && '' !== $reason ) {
							update_post_meta( $id, '_emcp_quarantine_reason', sanitize_text_field( $reason ) );
						}
						$post = get_post( $id );
						if ( $post && in_array( $post->post_status, array( 'publish', 'private', 'future' ), true ) ) {
							wp_update_post(
								array(
									'ID'          => $id,
									'post_status' => 'draft',
								)
							);
						}
					} else {
						delete_post_meta( $id, '_emcp_quarantined' );
						delete_post_meta( $id, '_emcp_quarantine_reason' );
					}
					return array(
						'id'          => $id,
						'quarantined' => $on,
					);
				},
			)
		);
	}
);

/*
 * --------------------------------------------------------------------------
 * Boot gate (Detailed Requirements #2).
 * --------------------------------------------------------------------------
 * Instantiate the singleton on `plugins_loaded` (priority 20 — after Elementor's
 * own boot). `Plugin::instance()` ALWAYS exists so `site/capabilities` can report
 * health; it only registers controllers when Elementor is present + compatible.
 */
add_action(
	'plugins_loaded',
	static function () {
		Plugin::instance()->boot();
	},
	20
);
