<?php
/**
 * WP-P02 — Permission-callback factories for the five capability gates (10-rest-api.md §0.3).
 *
 * Contract authority: 10-rest-api.md §0.2 (Basic auth; the `permission_callback` is the security
 * boundary; NO HTTPS enforcement), §0.3 (capability map table — quoted verbatim below);
 * 12-error-taxonomy.md §3.4 (`CAPABILITY_MISSING` 403, meta keys `capability`,`user_id`);
 * 15-engineering-standards.md §3.3 (every route declares a `permission_callback`).
 *
 * Each factory returns a CLOSURE suitable for `register_rest_route( ..., 'permission_callback' => ... )`.
 * The closure returns `true` (allowed) or a taxonomy `WP_Error('CAPABILITY_MISSING', …, status 403)` —
 * NEVER a bare `false`. A bare `false` makes WordPress emit its generic `rest_forbidden` body; we want
 * OUR §0.6 envelope so the agent reads a structured `CAPABILITY_MISSING` with `meta.capability`.
 *
 * Auth (401) is handled by WordPress core BEFORE the permission_callback runs: an absent/invalid
 * Application Password yields `401 rest_not_logged_in` automatically (10 §0.2 / §0.7, spike S6). This
 * layer therefore implements ONLY the capability (403) gates and adds NO HTTPS check (S6 — Basic auth
 * works over plain HTTP on LocalWP/wp-env).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Capabilities;
use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Static factories returning `permission_callback` closures for the §0.3 capability gates.
 */
final class Permissions {

	/**
	 * Literal Elementor UPDATE_CLASS capability slug (modules/global-classes/database/migrations/add-capabilities.php:8).
	 * Hard-coded fallback used when {@see Capabilities::CAP_UPDATE_CLASS} is unavailable (spike WP-S05:
	 * the FQCN `Add_Capabilities` may not be loaded; the literal string is always safe).
	 */
	const UPDATE_CLASS_FALLBACK = 'elementor_global_classes_update_class';

	/**
	 * CAP_READ — `current_user_can('edit_posts')` (10-rest-api.md §0.3). Discovery / read routes.
	 *
	 * @return callable(WP_REST_Request):(true|\WP_Error)
	 */
	public static function can_read(): callable {
		return static function ( WP_REST_Request $request ) {
			return self::gate( 'edit_posts', $request );
		};
	}

	/**
	 * CAP_EDIT_POST — `current_user_can('edit_post', (int)$request['id'])` (10-rest-api.md §0.3).
	 * Document-mutate routes; falls back to `edit_posts` when there is no `id` (the create case).
	 *
	 * @return callable(WP_REST_Request):(true|\WP_Error)
	 */
	public static function can_edit_post(): callable {
		return static function ( WP_REST_Request $request ) {
			$id = $request['id'] ?? null;

			// No id (create) -> the generic create capability (10 §0.3 "falls back to edit_posts").
			if ( null === $id || '' === $id || 0 === (int) $id ) {
				return self::gate( 'edit_posts', $request );
			}

			$post_id = (int) $id;
			if ( current_user_can( 'edit_post', $post_id ) ) {
				return true;
			}

			return self::deny( 'edit_post', array( 'post_id' => $post_id ) );
		};
	}

	/**
	 * CAP_MANAGE — `current_user_can('manage_options')` (10-rest-api.md §0.3). Design-system, cache,
	 * kit, ops, capability-sensitive routes.
	 *
	 * @return callable(WP_REST_Request):(true|\WP_Error)
	 */
	public static function can_manage(): callable {
		return static function ( WP_REST_Request $request ) {
			return self::gate( 'manage_options', $request );
		};
	}

	/**
	 * CAP_UPDATE_CLASS — `current_user_can(Add_Capabilities::UPDATE_CLASS)` (10-rest-api.md §0.3,
	 * spike WP-S05). Global-class WRITES only. Uses the WP-F05 `Capabilities::CAP_UPDATE_CLASS` constant
	 * (= the migration-granted `elementor_global_classes_update_class`) with a literal fallback so the
	 * gate never fatals if the F05 class is unavailable.
	 *
	 * @return callable(WP_REST_Request):(true|\WP_Error)
	 */
	public static function can_update_class(): callable {
		return static function ( WP_REST_Request $request ) {
			return self::gate( self::update_class_cap(), $request );
		};
	}

	/**
	 * CAP_UPLOAD — `current_user_can('upload_files')` (10-rest-api.md §0.3). Media routes.
	 *
	 * @return callable(WP_REST_Request):(true|\WP_Error)
	 */
	public static function can_upload(): callable {
		return static function ( WP_REST_Request $request ) {
			return self::gate( 'upload_files', $request );
		};
	}

	/**
	 * Resolve the UPDATE_CLASS capability slug: prefer the WP-F05 constant, fall back to the literal
	 * (spike WP-S05 — the literal is always valid even when the Elementor class is unloaded).
	 */
	private static function update_class_cap(): string {
		if ( class_exists( '\Elementor\Ultra\Capabilities' ) && defined( '\Elementor\Ultra\Capabilities::CAP_UPDATE_CLASS' ) ) {
			return Capabilities::CAP_UPDATE_CLASS;
		}
		return self::UPDATE_CLASS_FALLBACK;
	}

	/**
	 * Generic gate: allow when the current user has `$capability`, else return the taxonomy 403.
	 *
	 * @param string          $capability The WordPress capability to check.
	 * @param WP_REST_Request $request    The current request (unused for non-object caps; kept for parity).
	 * @return true|\WP_Error
	 */
	private static function gate( string $capability, WP_REST_Request $request ) {
		unset( $request ); // Object caps that need the request use can_edit_post directly.
		if ( current_user_can( $capability ) ) {
			return true;
		}
		return self::deny( $capability );
	}

	/**
	 * Build the canonical permission-denied `WP_Error` matching the reference 401/403 signatures
	 * (spike [S05/S06]; 10-rest-api.md §0.2/§0.7; 12-error-taxonomy.md §3.4). The HTTP status follows
	 * WordPress core's own rule `rest_authorization_required_code()` = `is_user_logged_in() ? 403 : 401`
	 * (wp-includes/rest-api.php:1421), so our routes behave EXACTLY like WP core / Elementor's own routes:
	 *
	 *  - NO / invalid Application Password (user logged out) -> 401 `AUTH_FAILED` (12 §3.4 — 401, meta
	 *    `reason`). Mirrors core's `rest_not_logged_in` / `rest_forbidden` 401 for absent credentials.
	 *  - Authenticated but lacking the capability (user logged in) -> 403 `CAPABILITY_MISSING` (12 §3.4 —
	 *    403, meta `capability`,`user_id`). Mirrors the no-cap signature on the global-classes PUT.
	 *
	 * Either way the body is OUR taxonomy `{code,message,data:{status,meta}}` envelope (§0.6), never a
	 * bare `false`. No HTTPS enforcement (spike S6 — Basic auth works over plain HTTP).
	 *
	 * @param string              $capability The capability that failed.
	 * @param array<string,mixed> $extra_meta Additional structured meta to merge (e.g. `post_id`).
	 * @return \WP_Error
	 */
	private static function deny( string $capability, array $extra_meta = array() ) {
		$status = rest_authorization_required_code(); // 401 when logged out, 403 when logged in.

		if ( 401 === $status ) {
			// Absent/invalid credentials -> auth failure (logged-out user).
			return Response::error(
				\Elementor\Ultra\Error_Codes::AUTH_FAILED,
				__( 'Authentication required: a valid Application Password is missing or invalid.', 'elementor-ultra-mcp' ),
				401,
				array_merge(
					array(
						'reason'     => 'not_logged_in',
						'capability' => $capability,
					),
					$extra_meta
				)
			);
		}

		// Authenticated but lacking the capability.
		return Response::error(
			\Elementor\Ultra\Error_Codes::CAPABILITY_MISSING,
			__( 'You do not have permission to perform this operation.', 'elementor-ultra-mcp' ),
			403,
			array_merge(
				array(
					'capability' => $capability,
					'user_id'    => get_current_user_id(),
				),
				$extra_meta
			)
		);
	}
}
