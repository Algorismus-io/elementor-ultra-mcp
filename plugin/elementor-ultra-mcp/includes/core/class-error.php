<?php
/**
 * WP-P02 — Central error factory mirroring 12-error-taxonomy.md §2 `ErrorPayload`.
 *
 * Contract authority: 12-error-taxonomy.md §2 (payload shape), §3 (codes), §4 (`WP_Error`↔code map);
 * 10-rest-api.md §0.6 (REST error envelope), §0.7 (HTTP status table).
 *
 * This is the controller-facing convenience seam every REST controller (WP-P06..P16) and the validator
 * (WP-P03) use to mint taxonomy `WP_Error`s and to re-code Elementor's own errors. It is a thin layer
 * OVER the frozen WP-F05 primitives ({@see \Elementor\Ultra\Error_Codes},
 * {@see \Elementor\Ultra\WP_Error_Map}) — it does not redefine the taxonomy, it gives it the named
 * entry points this WP's interface promises (`make`, `from_wp_error`, `from_atomic_exception`) plus the
 * verbatim §4 `ELEMENTOR_SLUG_MAP` table.
 *
 * NEVER string-matches Elementor throw messages (10 §0.6, 12 §4): the atomic-exception classifier
 * formats by the phase the CALLER reports (WP-P03 supplies it), copying the raw text into
 * `meta.parser_errors` + the message — never into the `code`.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\WP_Error_Map;
use Exception;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Taxonomy-aware `WP_Error` factory + Elementor-slug translation table (12-error-taxonomy.md §4).
 */
final class Error {

	/**
	 * The frozen Elementor/WP REST slug -> taxonomy-code table (12-error-taxonomy.md §4). Quoted
	 * verbatim from the contract so `from_wp_error()` translates Elementor's own REST errors into our
	 * taxonomy. `rest_forbidden` maps to CAPABILITY_MISSING by default (NOT_EDITABLE is disambiguated by
	 * an explicit hint at the call site, mirroring WP-F05 WP_Error_Map::from_elementor_slug).
	 *
	 * Elementor source slugs (paths relative to plugins/elementor):
	 *  - `global_classes_limit_exceeded` (modules/global-classes/global-classes-rest-api.php:336).
	 *  - `invalid_order` (modules/global-classes/global-classes-rest-api.php:369).
	 *  - `DUPLICATED_LABEL` (modules/global-classes/global-classes-rest-api.php:384).
	 *  - `rest_forbidden` / `rest_not_logged_in` (WP core REST cap checks).
	 *
	 * @var array<string,string>
	 */
	const ELEMENTOR_SLUG_MAP = array(
		'global_classes_limit_exceeded' => Error_Codes::BUDGET_EXCEEDED,
		'invalid_order'                 => Error_Codes::INVALID_ORDER,
		'DUPLICATED_LABEL'              => Error_Codes::DUPLICATED_LABEL,
		'rest_forbidden'                => Error_Codes::CAPABILITY_MISSING,
		'rest_not_logged_in'            => Error_Codes::AUTH_FAILED,
		'rest_post_invalid_id'          => Error_Codes::NOT_FOUND,
	);

	/**
	 * Build a taxonomy `WP_Error` mirroring 12-error-taxonomy.md §2 `ErrorPayload`. Delegates the
	 * envelope construction to the frozen WP-F05 map so the `data` block (`status` + structured meta)
	 * is built consistently with the rest of the plugin.
	 *
	 * The returned `WP_Error` `code` IS the taxonomy code; `data` holds `['status'=>$status]` plus the
	 * caller meta and (when non-empty) the `errors[]` list. When returned from a route callback WordPress
	 * serializes it to the §0.6 envelope with the matching HTTP status line.
	 *
	 * @param string                         $code    Taxonomy code (Error_Codes::*).
	 * @param string                         $message Human, actionable message.
	 * @param int                            $status  HTTP status (10-rest-api.md §0.7).
	 * @param array<string,mixed>            $meta    Code-specific structured context (12 §3 meta keys).
	 * @param array<int,array<string,mixed>> $errors  Per-item validation errors `{path,code,message,meta?}`.
	 */
	public static function make( string $code, string $message, int $status, array $meta = array(), array $errors = array() ): WP_Error {
		$error = WP_Error_Map::to_wp_error( $code, $message, $meta, $status );

		if ( ! empty( $errors ) ) {
			$error->add_data(
				array_merge(
					(array) $error->get_error_data(),
					array( 'errors' => array_values( $errors ) )
				)
			);
		}

		return $error;
	}

	/**
	 * Re-code a WordPress/Elementor `WP_Error` to a taxonomy `WP_Error` using `ELEMENTOR_SLUG_MAP`
	 * (12-error-taxonomy.md §4). An already-taxonomy `WP_Error` (its `code` is a valid taxonomy code) is
	 * returned unchanged. An unmatched slug maps to UPSTREAM_ERROR (default 502) UNLESS it already
	 * carries a `status` in data, in which case that status is preserved.
	 *
	 * @param WP_Error $e    The upstream `WP_Error` to translate.
	 * @param string   $hint Optional disambiguation hint (e.g. 'not_editable' for `rest_forbidden`).
	 */
	public static function from_wp_error( WP_Error $e, string $hint = '' ): WP_Error {
		$slug = (string) $e->get_error_code();

		// Already one of ours — pass through untouched.
		if ( '' !== $slug && Error_Codes::is_valid( $slug ) ) {
			return $e;
		}

		$data       = is_array( $e->get_error_data() ) ? $e->get_error_data() : array();
		$has_status = isset( $data['status'] );
		$status_in  = $has_status ? (int) $data['status'] : null;

		if ( 'rest_forbidden' === $slug && 'not_editable' === $hint ) {
			$code = Error_Codes::NOT_EDITABLE;
		} elseif ( array_key_exists( $slug, self::ELEMENTOR_SLUG_MAP ) ) {
			$code = self::ELEMENTOR_SLUG_MAP[ $slug ];
		} else {
			$code = Error_Codes::UPSTREAM_ERROR;
		}

		// Unmatched slug: keep the upstream status if present (12 §4 — "unless they already carry a status").
		$status = ( Error_Codes::UPSTREAM_ERROR === $code && $has_status )
			? (int) $status_in
			: Error_Codes::http_status( $code );

		$meta = $data;
		unset( $meta['status'], $meta['retryable'], $meta['surface'], $meta['op_id'], $meta['errors'] );
		$meta['upstream_slug'] = $slug;

		return self::make( $code, (string) $e->get_error_message(), $status, $meta );
	}

	/**
	 * Format a caught atomic save `\Exception` into a taxonomy `WP_Error` (10-rest-api.md §0.6,
	 * 12-error-taxonomy.md §4). Classifies into ATOMIC_SETTINGS_INVALID vs ATOMIC_STYLES_INVALID by the
	 * STRUCTURE/phase the CALLER reports (WP-P03 catches the throw and supplies the phase) — NEVER by
	 * parsing the message. The raw throw text is copied into `meta.parser_errors` AND appended to the
	 * human message; it never becomes the `code`.
	 *
	 * @param Exception           $e   The caught atomic exception.
	 * @param array<string,mixed> $ctx Caller context. Recognized keys:
	 *                                  `phase` ('settings'|'styles'|''), `element_id`, `style_id`, `prop`,
	 *                                  `parser_errors` (string[]).
	 */
	public static function from_atomic_exception( Exception $e, array $ctx = array() ): WP_Error {
		$phase         = isset( $ctx['phase'] ) && is_string( $ctx['phase'] ) ? $ctx['phase'] : '';
		$parser_errors = isset( $ctx['parser_errors'] ) && is_array( $ctx['parser_errors'] ) ? $ctx['parser_errors'] : array();

		$meta = $ctx;
		unset( $meta['phase'], $meta['parser_errors'] );

		// Delegate classification (by phase, not message) + payload assembly to the frozen WP-F05 map.
		return WP_Error_Map::from_exception( $e, $phase, $parser_errors, $meta );
	}
}
