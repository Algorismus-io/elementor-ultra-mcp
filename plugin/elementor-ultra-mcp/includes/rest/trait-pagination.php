<?php
/**
 * WP-P02 — Reusable pagination trait for ALL list routes (10-rest-api.md §0.11).
 *
 * Contract authority: 10-rest-api.md §0.11 (request `{limit,cursor,fields}` -> response
 * `{items,next_cursor,total}`; `limit` default 25 / max 100; `fields` = top-level projection;
 * `next_cursor:null` => last page; `total` = unfiltered count when cheaply computable else `null`).
 *
 * Cursor scheme (implementation-defined, documented per §0.11 so every controller is consistent):
 *   The default opaque cursor is base64( json_encode( { "offset": <int> } ) ). `read_pagination_args`
 *   decodes it to an offset; `paginate( $items, … )` (offset mode) slices `$items` by `[offset, limit)`
 *   and emits `next_cursor = encode_cursor(offset + limit)` while more rows remain, else `null`.
 *   Controllers with a natural keyset (post-id / term-id) MAY ignore the offset helper and pass their
 *   own opaque cursor through; the trait keeps the cursor opaque to callers either way.
 *
 * This trait is `require_once`-loaded by {@see Abstract_Controller} (the SPL autoloader resolves only
 * `class-*.php`, not `trait-*.php`), so any controller extending the base can `use Pagination;`.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use WP_REST_Request;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Provides the §0.11 pagination request-parse + response-shape helpers.
 */
trait Pagination {

	/** Default page size (10-rest-api.md §0.11). */
	private static $emcp_pagination_default_limit = 25;

	/** Maximum page size (10-rest-api.md §0.11). */
	private static $emcp_pagination_max_limit = 100;

	/**
	 * Parse `limit` / `cursor` / `fields` from a request (query for GET, body for POST-list)
	 * (10-rest-api.md §0.11). Clamps `limit` to 1..100 (default 25). `cursor` is returned both raw
	 * (opaque) and decoded to an `offset` (0 when absent/invalid). `fields` is a clean string[].
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return array{limit:int,cursor:?string,offset:int,fields:string[]}
	 */
	protected function read_pagination_args( WP_REST_Request $request ): array {
		$raw_limit = $request->get_param( 'limit' );
		$limit     = null === $raw_limit ? self::$emcp_pagination_default_limit : (int) $raw_limit;
		$limit     = max( 1, min( self::$emcp_pagination_max_limit, $limit ) );

		$cursor = $request->get_param( 'cursor' );
		$cursor = ( is_string( $cursor ) && '' !== $cursor ) ? $cursor : null;
		$offset = $this->decode_cursor( $cursor );

		$raw_fields = $request->get_param( 'fields' );
		$fields     = array();
		if ( is_array( $raw_fields ) ) {
			foreach ( $raw_fields as $field ) {
				if ( is_string( $field ) && '' !== $field ) {
					$fields[] = $field;
				}
			}
		} elseif ( is_string( $raw_fields ) && '' !== $raw_fields ) {
			// Allow a comma-separated string for GET convenience.
			foreach ( explode( ',', $raw_fields ) as $field ) {
				$field = trim( $field );
				if ( '' !== $field ) {
					$fields[] = $field;
				}
			}
		}

		return array(
			'limit'  => $limit,
			'cursor' => $cursor,
			'offset' => $offset,
			'fields' => $fields,
		);
	}

	/**
	 * Build the §0.11 paginated `data` envelope `{items,next_cursor,total}`.
	 *
	 * OFFSET MODE (default): `$items` is the FULL collection; the trait slices it by the request's
	 * `[offset, offset+limit)` window, applies the `fields` projection, and computes `next_cursor`
	 * (the offset-encoded cursor when more rows remain, else `null`).
	 *
	 * Pass `$already_windowed = true` when the controller already fetched exactly one page (keyset mode);
	 * then `$items` is treated as the page as-is, `$next_cursor` MUST be supplied by the controller, and
	 * only the `fields` projection is applied.
	 *
	 * @param array<int,array<string,mixed>> $items            Full collection (offset mode) or one page (keyset mode).
	 * @param WP_REST_Request                $request          The current request (for limit/cursor/fields).
	 * @param int|null                       $total            Unfiltered total when cheap, else null (§0.11).
	 * @param bool                           $already_windowed True if `$items` is already a single page (keyset mode).
	 * @param string|null                    $next_cursor      Keyset-mode next cursor (ignored in offset mode).
	 * @return array{items:array<int,array<string,mixed>>,next_cursor:?string,total:?int}
	 */
	protected function paginate( array $items, WP_REST_Request $request, ?int $total = null, bool $already_windowed = false, ?string $next_cursor = null ): array {
		$args   = $this->read_pagination_args( $request );
		$limit  = $args['limit'];
		$offset = $args['offset'];
		$fields = $args['fields'];

		if ( $already_windowed ) {
			$page = array_values( $items );
			$next = $next_cursor;
		} else {
			$page     = array_slice( array_values( $items ), $offset, $limit );
			$has_more = ( $offset + $limit ) < count( $items );
			$next     = $has_more ? $this->encode_cursor( $offset + $limit ) : null;
		}

		if ( ! empty( $fields ) ) {
			$page = $this->project_fields( $page, $fields );
		}

		return array(
			'items'       => array_values( $page ),
			'next_cursor' => $next,
			'total'       => $total,
		);
	}

	/**
	 * Project each item down to only the requested top-level keys (10-rest-api.md §0.11). Keys absent
	 * from an item are simply omitted (no nulls injected).
	 *
	 * @param array<int,array<string,mixed>> $items  Page items.
	 * @param string[]                       $fields Top-level keys to keep.
	 * @return array<int,array<string,mixed>>
	 */
	private function project_fields( array $items, array $fields ): array {
		$flip = array_fill_keys( $fields, true );
		$out  = array();
		foreach ( $items as $item ) {
			if ( ! is_array( $item ) ) {
				$out[] = $item;
				continue;
			}
			$out[] = array_intersect_key( $item, $flip );
		}
		return $out;
	}

	/**
	 * Encode an offset into the opaque default cursor: base64( {"offset":N} ).
	 *
	 * @param int $offset Zero-based offset.
	 */
	protected function encode_cursor( int $offset ): string {
		return base64_encode( (string) wp_json_encode( array( 'offset' => $offset ) ) );
	}

	/**
	 * Decode the opaque default cursor back to an offset (0 when null/malformed). Tolerant: a cursor the
	 * trait did not mint (a controller-specific keyset cursor) decodes to 0, which is harmless because
	 * keyset controllers do not consult the offset.
	 *
	 * @param string|null $cursor Opaque cursor.
	 */
	protected function decode_cursor( ?string $cursor ): int {
		if ( null === $cursor || '' === $cursor ) {
			return 0;
		}
		$decoded = base64_decode( $cursor, true );
		if ( false === $decoded ) {
			return 0;
		}
		$parsed = json_decode( $decoded, true );
		if ( is_array( $parsed ) && isset( $parsed['offset'] ) && is_numeric( $parsed['offset'] ) ) {
			return max( 0, (int) $parsed['offset'] );
		}
		return 0;
	}
}
