<?php
/**
 * WP-F05 — PHP `WP_Error` <-> taxonomy-code mapping (plugin contract).
 *
 * Contract authority: spec/contracts/12-error-taxonomy.md §2 (payload shape) + §4 (the WP_Error map).
 *
 * Two directions:
 *  - FORWARD (`to_wp_error`): a taxonomy code + message + meta -> a `WP_Error` whose `code` slug IS the
 *    taxonomy code and whose `data` carries `['status' => <http>]` (so `rest_ensure_response` /
 *    `WP_REST_Server` emit the right HTTP status) plus the structured `meta`.
 *  - REVERSE (`from_elementor_slug` / `classify_exception`): Elementor's own REST slugs and caught
 *    `\Exception`s -> a taxonomy code. The plugin NEVER leaks the raw throw message as a code; it
 *    catches the `\Exception` TYPE, classifies by the controller path that threw, and puts the
 *    appended parser errors in `meta.parser_errors` (12-error-taxonomy.md §4).
 *
 * The validator (WP-P03) and every write route import this map. It depends only on Error_Codes
 * (F05) — no Elementor classes — so it is loadable standalone.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra;

use Exception;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Builds taxonomy-conformant `WP_Error`s and classifies Elementor's own errors into the taxonomy.
 */
final class WP_Error_Map {

	/**
	 * Reverse map: Elementor / WP REST slug -> taxonomy code (12-error-taxonomy.md §4).
	 * `rest_forbidden` is ambiguous (cap fail vs not-editable); callers pass a hint to `from_elementor_slug`.
	 *
	 * @return array<string,string>
	 */
	private static function slug_map(): array {
		return array(
			// Elementor global-classes REST slugs (global-classes-rest-api.php).
			'global_classes_limit_exceeded' => Error_Codes::BUDGET_EXCEEDED,   // :336.
			'invalid_order'                 => Error_Codes::INVALID_ORDER,     // :369.
			'DUPLICATED_LABEL'              => Error_Codes::DUPLICATED_LABEL,  // :384.
			// WP core / cap-check slugs.
			'rest_forbidden'                => Error_Codes::CAPABILITY_MISSING,
			'rest_not_logged_in'            => Error_Codes::AUTH_FAILED,
			'rest_post_invalid_id'          => Error_Codes::NOT_FOUND,
		);
	}

	/**
	 * Build a `WP_Error` that carries a taxonomy code + the matching HTTP status + structured meta
	 * (12-error-taxonomy.md §2/§4). The `WP_Error` `code` IS the taxonomy code; `data` holds
	 * `['status' => <http>]` plus every meta key (parser errors land in `meta.parser_errors`).
	 *
	 * @param string              $code    A taxonomy code (Error_Codes::*).
	 * @param string              $message Human, actionable message (parser errors appended verbatim).
	 * @param array<string,mixed> $meta    Code-specific structured context (12-error-taxonomy.md §3).
	 * @param int|null            $status  Override HTTP status (defaults to the code's frozen status).
	 */
	public static function to_wp_error( string $code, string $message, array $meta = array(), ?int $status = null ): WP_Error {
		if ( ! Error_Codes::is_valid( $code ) ) {
			// Never leak an unknown code; collapse to INTERNAL_ERROR but keep the original in meta.
			$meta = array_merge( $meta, array( 'original_code' => $code ) );
			$code = Error_Codes::INTERNAL_ERROR;
		}

		$http = $status ?? Error_Codes::http_status( $code );

		$data = array_merge(
			array(
				'status'    => $http,
				'retryable' => Error_Codes::is_retryable( $code ),
				'surface'   => Error_Codes::surface( $code ),
			),
			$meta
		);

		return new WP_Error( $code, $message, $data );
	}

	/**
	 * Build the FROZEN structured payload (12-error-taxonomy.md §2) from a `WP_Error` produced by this
	 * map — the array the REST envelope serializes. Shape: `{code,message,http_status,retryable,surface,
	 * rpc_code,meta}`. `meta` is the `WP_Error` data minus the transport keys.
	 *
	 * @param WP_Error $error A taxonomy `WP_Error` (ideally from `to_wp_error`).
	 *
	 * @return array{code:string,message:string,http_status:int,retryable:bool,surface:string,rpc_code:?int,meta:array<string,mixed>}
	 */
	public static function to_payload( WP_Error $error ): array {
		$code = $error->get_error_code();
		$code = is_string( $code ) && Error_Codes::is_valid( $code ) ? $code : Error_Codes::INTERNAL_ERROR;

		$data = $error->get_error_data();
		$data = is_array( $data ) ? $data : array();

		$http     = isset( $data['status'] ) ? (int) $data['status'] : Error_Codes::http_status( $code );
		$meta_map = Error_Codes::meta();
		$rpc_code = isset( $meta_map[ $code ] ) ? $meta_map[ $code ]['rpc_code'] : null;

		// Strip transport keys; everything else is structured meta.
		$meta = $data;
		unset( $meta['status'], $meta['retryable'], $meta['surface'] );

		return array(
			'code'        => $code,
			'message'     => (string) $error->get_error_message(),
			'http_status' => $http,
			'retryable'   => Error_Codes::is_retryable( $code ),
			'surface'     => Error_Codes::surface( $code ),
			'rpc_code'    => $rpc_code,
			'meta'        => $meta,
		);
	}

	/**
	 * Reverse map: an Elementor / WP REST slug -> a taxonomy code (12-error-taxonomy.md §4). `$hint`
	 * disambiguates `rest_forbidden` (`'not_editable'` -> NOT_EDITABLE, else CAPABILITY_MISSING).
	 * Unknown slugs fall through to UPSTREAM_ERROR (an unclassifiable non-2xx).
	 *
	 * @param string $slug Elementor / WP error slug.
	 * @param string $hint Optional disambiguation hint (e.g. 'not_editable').
	 */
	public static function from_elementor_slug( string $slug, string $hint = '' ): string {
		if ( 'rest_forbidden' === $slug && 'not_editable' === $hint ) {
			return Error_Codes::NOT_EDITABLE;
		}

		$map = self::slug_map();
		return $map[ $slug ] ?? Error_Codes::UPSTREAM_ERROR;
	}

	/**
	 * Classify a caught atomic `\Exception` into a taxonomy code by the CONTROLLER PATH that threw —
	 * NOT by string-matching the throw text (12-error-taxonomy.md §4, Implementation Notes). The
	 * Props_Parser path throws "Settings validation failed." (-> ATOMIC_SETTINGS_INVALID); the
	 * Style_Parser path throws "Styles validation failed for style ..." (-> ATOMIC_STYLES_INVALID).
	 * Callers pass which parser path they were on; absent that, an unclassifiable throw is INTERNAL_ERROR.
	 *
	 * @param Exception $e    The caught exception (the message becomes part of the payload message,
	 *                        and its appended parser errors go to meta.parser_errors — never a code).
	 * @param string    $path The controller/parser path: 'settings' | 'styles' | '' (unknown).
	 */
	public static function classify_exception( Exception $e, string $path = '' ): string {
		unset( $e ); // Deliberately NOT string-matched (12-error-taxonomy.md §4).
		switch ( $path ) {
			case 'settings':
				return Error_Codes::ATOMIC_SETTINGS_INVALID;
			case 'styles':
				return Error_Codes::ATOMIC_STYLES_INVALID;
			default:
				return Error_Codes::INTERNAL_ERROR;
		}
	}

	/**
	 * Build a taxonomy `WP_Error` from a caught atomic `\Exception` (12-error-taxonomy.md §4). Classifies
	 * by `$path`, uses the exception message as the human message, and stores the appended parser errors
	 * in `meta.parser_errors`. The raw throw text NEVER becomes the `code`.
	 *
	 * @param Exception           $e             The caught atomic exception.
	 * @param string              $path          'settings' | 'styles' | '' (unknown).
	 * @param string[]            $parser_errors Structured parser errors to surface in meta.
	 * @param array<string,mixed> $meta          Extra structured context (e.g. element_id, style_id).
	 */
	public static function from_exception( Exception $e, string $path = '', array $parser_errors = array(), array $meta = array() ): WP_Error {
		$code = self::classify_exception( $e, $path );
		$meta = array_merge( $meta, array( 'parser_errors' => $parser_errors ) );
		return self::to_wp_error( $code, (string) $e->getMessage(), $meta );
	}
}
