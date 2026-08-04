<?php
/**
 * WP-P02 — Abstract REST controller base every companion controller extends.
 *
 * Contract authority: 10-rest-api.md §0.1 (namespace `elementor-ultra/v1`), §0.5 (success envelope),
 * §0.6 (error envelope), §0.7 (status table), §0.8 (`op_id` regex `^[A-Za-z0-9_.-]{1,64}$`,
 * `base_hash = md5(_elementor_data)`, 409 on stale), §0.11 (pagination); 12-error-taxonomy.md §3.2
 * (`CONCURRENCY_STALE_HASH`), §3.1 (`SCHEMA_INVALID_PARAMS`).
 *
 * Gives controllers (WP-P06..P16) the shared envelope + helper surface so each one is consistent and
 * carries NO route logic of its own here (route schemas live in the controller WPs). Pulls in the
 * {@see Pagination} trait (`require_once`-loaded because the SPL autoloader resolves only `class-*.php`).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Error;
use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Plugin;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

// The SPL autoloader only resolves `class-*.php`; load the pagination trait explicitly so any
// subclass that `use Pagination;` sees it (the base itself uses it so list controllers inherit it).
require_once __DIR__ . '/trait-pagination.php';

/**
 * Base controller: success/error envelopes, the namespaced `route()` wrapper, op_id/base_hash helpers,
 * and the abstract `register_routes()` each controller implements. NO business routes here.
 */
abstract class Abstract_Controller {

	use Pagination;

	/** The `op_id` validation pattern (10-rest-api.md §0.8). */
	const OP_ID_PATTERN = '/^[A-Za-z0-9_.-]{1,64}$/';

	/**
	 * Register this controller's routes (called by {@see Registrar} on `rest_api_init`). Each concrete
	 * controller implements this with `register_rest_route( $this->namespace(), … )` (or `$this->route()`),
	 * declaring the per-route `args` schema + `permission_callback` itself (10-rest-api.md §1).
	 *
	 * @return void
	 */
	abstract public function register_routes(): void;

	/**
	 * The REST namespace every controller registers under (10-rest-api.md §0.1). Reads the frozen
	 * {@see Plugin::REST_NAMESPACE} constant.
	 */
	protected function namespace(): string {
		return Plugin::REST_NAMESPACE;
	}

	/**
	 * Convenience `register_rest_route` wrapper that prepends the namespace (10-rest-api.md §0.1).
	 * The `args` schema + `permission_callback` are supplied BY THE CONTROLLER (this WP owns no schemas).
	 *
	 * @param string                            $route       Route path beneath the namespace, e.g. `/documents/(?P<id>\d+)`.
	 * @param string|string[]                   $methods     HTTP method(s), e.g. `WP_REST_Server::READABLE` or `'POST'`.
	 * @param callable                          $callback    The route handler.
	 * @param callable                          $permission  The `permission_callback` (use {@see Permissions}).
	 * @param array<string,array<string,mixed>> $args       Per-route `args` schema (default none).
	 * @param bool                              $override    Passed through to `register_rest_route` `$override`.
	 * @return bool
	 */
	protected function route( string $route, $methods, callable $callback, callable $permission, array $args = array(), bool $override = false ): bool {
		return register_rest_route(
			$this->namespace(),
			$route,
			array(
				'methods'             => $methods,
				'callback'            => $callback,
				'permission_callback' => $permission,
				'args'                => $args,
			),
			$override
		);
	}

	/**
	 * Build the standard 2xx success envelope `{success:true,data:$data}` (10-rest-api.md §0.5). Mirrors
	 * Elementor variables REST `{success,data}` (modules/variables/classes/rest-api.php:418-423). NEVER
	 * wraps an already-wrapped payload — pass the route-specific `data`.
	 *
	 * @param mixed $data   Route-specific `data` payload.
	 * @param int   $status HTTP status (default 200).
	 */
	protected function ok( $data, int $status = 200 ): WP_REST_Response {
		return Response::success( $data, $status );
	}

	/**
	 * Build a taxonomy `WP_Error` carrying the §0.6 error envelope (returned from a route callback so
	 * WordPress serializes it with the matching HTTP status). `op_id`/`errors` emitted only when supplied.
	 *
	 * @param string                         $code    Taxonomy code (Error_Codes::*).
	 * @param string                         $message Human, actionable message.
	 * @param int                            $status  HTTP status (10-rest-api.md §0.7).
	 * @param array<string,mixed>            $meta    Code-specific structured context.
	 * @param array<int,array<string,mixed>> $errors  Per-item validation errors.
	 * @param string|null                    $op_id   Echoed request op_id when supplied.
	 */
	protected function fail( string $code, string $message, int $status, array $meta = array(), array $errors = array(), ?string $op_id = null ): WP_Error {
		return Response::error( $code, $message, $status, $meta, $errors, $op_id );
	}

	/**
	 * Serialize a taxonomy `WP_Error` to the §0.6 envelope as a `WP_REST_Response` (used when a handler
	 * must return a response object rather than letting WordPress serialize the `WP_Error` natively).
	 *
	 * @param WP_Error $error The error to serialize.
	 */
	protected function wp_error_to_response( WP_Error $error ): WP_REST_Response {
		return Response::from_wp_error( $error );
	}

	/**
	 * Validate the optional `op_id` request field against `^[A-Za-z0-9_.-]{1,64}$` (10-rest-api.md §0.8).
	 * Returns `null` when absent, the validated string when valid, or a 400 `SCHEMA_INVALID_PARAMS`
	 * `WP_Error` when present-but-malformed (10-rest-api.md §0.7 — arg-shape failures are 400).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return string|null|WP_Error
	 */
	protected function read_op_id( WP_REST_Request $request ) {
		$op_id = $request->get_param( 'op_id' );
		if ( null === $op_id || '' === $op_id ) {
			return null;
		}
		if ( ! is_string( $op_id ) || ! preg_match( self::OP_ID_PATTERN, $op_id ) ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'Invalid op_id: must match ^[A-Za-z0-9_.-]{1,64}$.', 'elementor-ultra-mcp' ),
				400,
				array(
					'path'     => 'op_id',
					'expected' => '^[A-Za-z0-9_.-]{1,64}$',
				)
			);
		}
		return $op_id;
	}

	/**
	 * The current optimistic-concurrency token for a document: `md5( get_post_meta($id,'_elementor_data',true) )`
	 * (10-rest-api.md §0.8). Returned by every document READ; compared by WRITE routes.
	 *
	 * @param int $post_id Document/post id.
	 */
	protected function current_base_hash( int $post_id ): string {
		return md5( (string) get_post_meta( $post_id, '_elementor_data', true ) );
	}

	/**
	 * Optimistic-concurrency check (10-rest-api.md §0.8). Skips the check when `$expected` is null OR
	 * `$force` is true (the first-build / forced-overwrite cases). On mismatch returns a 409
	 * `CONCURRENCY_STALE_HASH` `WP_Error` (REST surfaces it as `E_BASE_HASH_MISMATCH` per §0.8; the
	 * CANONICAL taxonomy `code` is `CONCURRENCY_STALE_HASH`, 12-error-taxonomy.md §3.2). Consumed by the
	 * WP-P06+ write controllers BEFORE they persist.
	 *
	 * @param int         $post_id  Document/post id.
	 * @param string|null $expected Caller-supplied base_hash (null = no check).
	 * @param bool        $force    When true, bypass the check entirely.
	 * @return true|WP_Error
	 */
	protected function assert_base_hash( int $post_id, ?string $expected, bool $force = false ) {
		if ( null === $expected || $force ) {
			return true;
		}

		$actual = $this->current_base_hash( $post_id );
		if ( hash_equals( $actual, (string) $expected ) ) {
			return true;
		}

		return $this->fail(
			Error_Codes::CONCURRENCY_STALE_HASH,
			__( 'The document changed since you last read it (stale base_hash). Re-read the document for a fresh base_hash and retry.', 'elementor-ultra-mcp' ),
			409,
			array(
				'post_id'       => $post_id,
				'expected_hash' => $expected,
				'actual_hash'   => $actual,
			)
		);
	}

	/**
	 * Re-code a WordPress/Elementor `WP_Error` into a taxonomy `WP_Error` (12-error-taxonomy.md §4) via
	 * the central {@see Error} factory — the seam controllers use when proxying Elementor's own REST.
	 *
	 * @param WP_Error $error The upstream error.
	 * @param string   $hint  Optional disambiguation hint (e.g. 'not_editable').
	 */
	protected function map_wp_error( WP_Error $error, string $hint = '' ): WP_Error {
		return Error::from_wp_error( $error, $hint );
	}
}
