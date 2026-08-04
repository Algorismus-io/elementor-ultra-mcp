<?php
/**
 * PHASE 2 (T2) — Additive `X-MCP-API-Key` authentication bridge.
 *
 * Purpose (does NOT replace the existing Application-Password / capability auth —
 * it is a SECOND, additive authentication vector):
 *  - When a REST request carries a valid `X-MCP-API-Key` header (constant-time
 *    `hash_equals` against a stored key option) AND nothing else has already
 *    authenticated the request, resolve the current user to a dedicated
 *    least-privilege SERVICE user (created on demand) whose role holds exactly
 *    the caps every {@see \Elementor\Ultra\Rest\Permissions} gate checks
 *    (edit_posts/edit_pages, manage_options, upload_files, and the Elementor
 *    UPDATE_CLASS cap). Because the current user is set BEFORE the
 *    `permission_callback` runs, EVERY existing route passes unchanged — no
 *    per-route rewrite.
 *
 * Auth precedence (why App-Password keeps working):
 *  - This runs on `determine_current_user` at priority 30, AFTER WordPress core's
 *    cookie (10) and Application-Password (20) validators. It ONLY acts when the
 *    user is STILL unresolved (`empty($user_id)`) AND an `X-MCP-API-Key` header is
 *    present. A request authenticated by an App Password is returned untouched.
 *  - A PRESENT-but-WRONG key leaves the user unresolved, so the route's
 *    `permission_callback` yields WordPress's normal 401 (logged-out) — matching
 *    the contract's AUTH_FAILED signature.
 *
 * Key storage:
 *  - Primary option `elementor_ultra_mcp_api_key` (self-sufficient standalone).
 *  - Fallback option `wpcursor_mcp_api_key` so a co-installed WPCursor plugin's
 *    key authenticates too (same-key co-install). Stored as plaintext to mirror
 *    the WPCursor/EWB ApiKeyAuth precedent (`hash_equals` vs the option value).
 *    NOTE for the box: consider storing a hash instead of plaintext.
 *
 * Provisioning:
 *  - `wp elementor-ultra mcp-key set <key>`  (seeds the option + service user)
 *  - `wp elementor-ultra mcp-key get`        (prints the stored key)
 *  - or plain `wp option update elementor_ultra_mcp_api_key <key>`.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Additive MCP-API-key authentication + on-demand least-privilege service user.
 */
final class Mcp_Key_Auth {

	/** Primary option holding the plaintext MCP API key (standalone self-sufficient). */
	const OPTION_KEY = 'elementor_ultra_mcp_api_key';

	/** Fallback option: the co-installed WPCursor plugin's key (same-key co-install). */
	const FALLBACK_OPTION = 'wpcursor_mcp_api_key';

	/** Dedicated least-privilege role slug for the MCP service identity. */
	const ROLE = 'elementor_ultra_service';

	/** Login for the on-demand service user. */
	const USER_LOGIN = 'elementor-ultra-service';

	/**
	 * Register the auth filter + WP-CLI provisioning command. Additive: it never
	 * removes or short-circuits the existing App-Password / cookie auth path.
	 *
	 * @return void
	 */
	public static function boot() {
		// Priority 30: after core cookie (10) + Application Password (20) validators.
		add_filter( 'determine_current_user', array( __CLASS__, 'authenticate' ), 30 );

		if ( defined( 'WP_CLI' ) && WP_CLI && class_exists( '\WP_CLI' ) ) {
			\WP_CLI::add_command( 'elementor-ultra mcp-key', array( __CLASS__, 'cli_mcp_key' ) );
		}
	}

	/**
	 * `determine_current_user` callback. Resolve the MCP service user ONLY when the
	 * request is still unauthenticated AND carries a valid `X-MCP-API-Key`.
	 *
	 * @param int|false $user_id User id resolved by earlier validators (0/false when none).
	 * @return int|false Service user id on a valid key, otherwise the untouched input.
	 */
	public static function authenticate( $user_id ) {
		// Never override an already-authenticated request (cookie / App Password).
		if ( ! empty( $user_id ) ) {
			return $user_id;
		}

		$provided = self::provided_key();
		if ( '' === $provided ) {
			return $user_id; // No MCP header — not our vector; leave as-is.
		}

		$stored = self::stored_key();
		if ( '' === $stored || ! hash_equals( $stored, $provided ) ) {
			// Present-but-invalid key: stay unauthenticated so the route yields 401.
			return $user_id;
		}

		$uid = self::ensure_service_user();
		return $uid ? $uid : $user_id;
	}

	/**
	 * Read the `X-MCP-API-Key` request header (Apache exposes it as HTTP_X_MCP_API_KEY;
	 * fall back to getallheaders() for other SAPIs).
	 *
	 * @return string Trimmed key, or '' when absent.
	 */
	private static function provided_key() {
		$val = '';
		if ( isset( $_SERVER['HTTP_X_MCP_API_KEY'] ) ) {
			$val = sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_MCP_API_KEY'] ) );
		} elseif ( function_exists( 'getallheaders' ) ) {
			foreach ( (array) getallheaders() as $name => $value ) {
				if ( 0 === strcasecmp( (string) $name, 'x-mcp-api-key' ) ) {
					$val = $value;
					break;
				}
			}
		}
		return is_string( $val ) ? trim( wp_unslash( $val ) ) : '';
	}

	/**
	 * Read the stored key: primary option first, then the WPCursor co-install fallback.
	 *
	 * @return string Trimmed stored key, or '' when none configured.
	 */
	private static function stored_key() {
		$key = (string) get_option( self::OPTION_KEY, '' );
		if ( '' === $key ) {
			$key = (string) get_option( self::FALLBACK_OPTION, '' );
		}
		return trim( $key );
	}

	/**
	 * Persist the MCP API key (plaintext) and make sure the service identity exists.
	 *
	 * @param string $key The plaintext MCP API key to store.
	 * @return string The stored key.
	 */
	public static function set_key( $key ) {
		$key = trim( (string) $key );
		update_option( self::OPTION_KEY, $key );
		self::ensure_service_user();
		return $key;
	}

	/**
	 * Ensure the least-privilege service user exists (create-on-demand) and carries
	 * the service role. Idempotent.
	 *
	 * @return int Service user id (0 on failure).
	 */
	public static function ensure_service_user() {
		self::ensure_role();

		$user = get_user_by( 'login', self::USER_LOGIN );
		if ( $user ) {
			if ( ! in_array( self::ROLE, (array) $user->roles, true ) ) {
				$user->set_role( self::ROLE );
			}
			return (int) $user->ID;
		}

		$uid = wp_insert_user(
			array(
				'user_login'   => self::USER_LOGIN,
				'user_pass'    => wp_generate_password( 48, true, true ),
				'user_email'   => 'elementor-ultra-service@localhost.invalid',
				'display_name' => 'Elementor Ultra Service',
				'role'         => self::ROLE,
			)
		);

		if ( is_wp_error( $uid ) ) {
			error_log( '[elementor-ultra] failed to create MCP service user: ' . $uid->get_error_message() );
			return 0;
		}
		return (int) $uid;
	}

	/**
	 * Create the service role if absent, else additively grant any missing caps
	 * (idempotent, never revokes).
	 *
	 * @return void
	 */
	private static function ensure_role() {
		$caps = self::service_caps();
		$role = get_role( self::ROLE );

		if ( ! $role ) {
			add_role( self::ROLE, 'Elementor Ultra Service', $caps );
			return;
		}
		foreach ( $caps as $cap => $grant ) {
			if ( $grant && ! $role->has_cap( $cap ) ) {
				$role->add_cap( $cap );
			}
		}
	}

	/**
	 * The exact capability set every {@see \Elementor\Ultra\Rest\Permissions} gate
	 * checks: read/edit/publish/delete for posts AND pages (so `edit_post` on any
	 * document passes), upload_files, manage_options, edit_theme_options (nav menus),
	 * and the Elementor UPDATE_CLASS cap (global-class writes).
	 *
	 * @return array<string,bool>
	 */
	private static function service_caps() {
		$caps = array(
			'read'                   => true,
			'upload_files'           => true,
			'manage_options'         => true,
			'manage_categories'      => true,
			'edit_theme_options'     => true,
			// Posts.
			'edit_posts'             => true,
			'edit_others_posts'      => true,
			'edit_published_posts'   => true,
			'publish_posts'          => true,
			'delete_posts'           => true,
			'delete_others_posts'    => true,
			'delete_published_posts' => true,
			'read_private_posts'     => true,
			// Pages (documents are the `page` post type).
			'edit_pages'             => true,
			'edit_others_pages'      => true,
			'edit_published_pages'   => true,
			'publish_pages'          => true,
			'delete_pages'           => true,
			'delete_others_pages'    => true,
			'delete_published_pages' => true,
			'read_private_pages'     => true,
		);
		// Elementor global-classes write capability (UPDATE_CLASS, add-capabilities.php:8).
		$caps[ Activator::UPDATE_CLASS ] = true;
		return $caps;
	}

	/**
	 * WP-CLI: `wp elementor-ultra mcp-key <set|get> [<key>]`.
	 *
	 *   wp elementor-ultra mcp-key set wpc_mcp_xxxxx   → store key + ensure service user
	 *   wp elementor-ultra mcp-key set                 → generate a random key
	 *   wp elementor-ultra mcp-key get                 → print the stored key
	 *
	 * @param array<int,string>    $args       Positional args.
	 * @param array<string,string> $assoc_args Flags.
	 * @return void
	 */
	public static function cli_mcp_key( $args, $assoc_args ) {
		$sub = isset( $args[0] ) ? $args[0] : 'get';

		if ( 'set' === $sub ) {
			$key = isset( $args[1] ) ? $args[1] : ( isset( $assoc_args['key'] ) ? $assoc_args['key'] : '' );
			if ( '' === $key ) {
				$key = wp_generate_password( 48, false );
			}
			$stored = self::set_key( $key );
			\WP_CLI::success( 'MCP API key stored + service user ready.' );
			\WP_CLI::line( $stored );
			return;
		}

		\WP_CLI::line( self::stored_key() );
	}
}
