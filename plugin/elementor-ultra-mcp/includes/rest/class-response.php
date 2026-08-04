<?php
/**
 * WP-P02 — Shared REST response builders (success / error envelopes).
 *
 * Contract authority: 10-rest-api.md §0.5 (success envelope `{success,data}`), §0.6 (error envelope
 * `{code,message,data:{status,op_id?,errors[]?,meta?}}`); 12-error-taxonomy.md §2 (`ErrorPayload`).
 *
 * These static helpers are the single place the `{success,data}` 2xx envelope and the WordPress-REST
 * error envelope are constructed, so every controller (WP-P06..P16) emits byte-identical shapes. The
 * success envelope deliberately mirrors Elementor's own variables REST `{success,data}` shape
 * (modules/variables/classes/rest-api.php:418-423) for cross-plugin consistency; the error envelope
 * mirrors the same controller's error path (modules/variables/classes/rest-api.php:465-473).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Error_Codes;
use WP_Error;
use WP_REST_Response;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Stateless envelope factory used by {@see Abstract_Controller} and any direct caller.
 */
final class Response {

	/**
	 * Build the standard 2xx success envelope (10-rest-api.md §0.5).
	 *
	 * Mirrors Elementor variables REST `{success,data}` (modules/variables/classes/rest-api.php:418-423).
	 * NEVER double-wraps: callers pass the route-specific `data` payload, not an already-wrapped body.
	 *
	 * @param mixed $data   The route-specific `data` payload (any JSON-serializable value).
	 * @param int   $status HTTP status (default 200).
	 */
	public static function success( $data, int $status = 200 ): WP_REST_Response {
		return new WP_REST_Response(
			array(
				'success' => true,
				'data'    => $data,
			),
			$status
		);
	}

	/**
	 * Build a taxonomy `WP_Error` carrying the §0.6 error envelope.
	 *
	 * The returned `WP_Error`, when handed back from a REST route callback, is serialized by WordPress
	 * to EXACTLY (10-rest-api.md §0.6):
	 *   `{ "code": <code>, "message": <message>, "data": { "status": <status>, "op_id"?: ..., "errors"?: [...], "meta"?: {...} } }`
	 * `op_id` is emitted only when non-null; `errors` only when non-empty. `meta` is always present (may
	 * be an empty object) so callers can rely on its existence.
	 *
	 * @param string                         $code    Taxonomy code (Error_Codes::*).
	 * @param string                         $message Human, actionable message.
	 * @param int                            $status  HTTP status (also the response status line).
	 * @param array<string,mixed>            $meta    Code-specific structured context (§3 meta keys).
	 * @param array<int,array<string,mixed>> $errors Per-item validation errors `{path,code,message,meta?}`.
	 * @param string|null                    $op_id   Echoed request op_id when supplied (§0.8).
	 */
	public static function error( string $code, string $message, int $status, array $meta = array(), array $errors = array(), ?string $op_id = null ): WP_Error {
		// Collapse an unknown code to INTERNAL_ERROR but never leak it as the wire code (12 §2).
		if ( ! Error_Codes::is_valid( $code ) ) {
			$meta = array_merge( $meta, array( 'original_code' => $code ) );
			$code = Error_Codes::INTERNAL_ERROR;
		}

		$data = array( 'status' => $status );

		if ( null !== $op_id ) {
			$data['op_id'] = $op_id;
		}

		if ( ! empty( $errors ) ) {
			$data['errors'] = array_values( $errors );
		}

		// `meta` is always present (10-rest-api.md §0.6); empty -> {} on the wire via WP_REST_Server.
		$data['meta'] = $meta;

		return new WP_Error( $code, $message, $data );
	}

	/**
	 * Serialize a taxonomy `WP_Error` into the §0.6 error envelope as a `WP_REST_Response` for the rare
	 * cases a handler must return a response object instead of letting WordPress serialize the `WP_Error`
	 * natively (e.g. inside a `try/catch` that already built a response). The body matches §0.6 exactly.
	 *
	 * @param WP_Error $error A `WP_Error` (ideally produced by {@see Response::error()}).
	 */
	public static function from_wp_error( WP_Error $error ): WP_REST_Response {
		$code = $error->get_error_code();
		$code = is_string( $code ) && '' !== $code ? $code : Error_Codes::INTERNAL_ERROR;

		$raw  = $error->get_error_data();
		$data = is_array( $raw ) ? $raw : array();

		$status = isset( $data['status'] ) ? (int) $data['status'] : Error_Codes::http_status( (string) $code );

		// Rebuild the §0.6 `data` block in canonical order; carry status/op_id/errors/meta only.
		$body_data = array( 'status' => $status );
		if ( isset( $data['op_id'] ) && null !== $data['op_id'] ) {
			$body_data['op_id'] = $data['op_id'];
		}
		if ( isset( $data['errors'] ) && is_array( $data['errors'] ) && ! empty( $data['errors'] ) ) {
			$body_data['errors'] = array_values( $data['errors'] );
		}
		$body_data['meta'] = isset( $data['meta'] ) && is_array( $data['meta'] ) ? $data['meta'] : array();

		return new WP_REST_Response(
			array(
				'code'    => (string) $code,
				'message' => (string) $error->get_error_message(),
				'data'    => $body_data,
			),
			$status
		);
	}
}
