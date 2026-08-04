<?php
/**
 * WP-R04 — Loop_Query_Mapper: the PURE, unit-testable mapper that turns a high-level loop request into the
 * FLAT loop-grid/loop-carousel widget `settings` map (SUPPLEMENT.md §A.4 worked CPT loop).
 *
 * Contract authority:
 *  - 10-rest-api.md §8.6 (`POST /pro/loop/bind-grid` settings shape).
 *  - SUPPLEMENT.md §A.4 (worked loop-grid JSON: `_skin`, top-level `posts_per_page`/`columns`,
 *    `{skin}_query_*` keys, `template_id`, pagination) + §A.7 (pro.loop.bind_grid I/O).
 *
 * This class touches NO WordPress / Elementor API — it is a deterministic array→array transform so the
 * single most error-prone detail (the `{skin}_query_` prefix) can be exhaustively unit-tested off-WP. The
 * prefix is DERIVED, never hardcoded (Impl-Notes): it mirrors Pro's
 * `Base::get_query_name() = str_replace('-','_',$skin_id) . '_' . Module::QUERY_ID('query')`
 * (elementor-pro/modules/loop-builder/widgets/base.php:32-35) → e.g. `post` → `post_query_`,
 * `post-taxonomy`/`post_taxonomy` → `post_taxonomy_query_`, `product` → `product_query_`.
 *
 * The load-bearing gotcha encoded here: `posts_per_page` + `columns` sit at the widget ROOT, NEVER under
 * the `{skin}_query_` prefix. The query `Group_Control_Related` EXCLUDES `posts_per_page`
 * (elementor-pro/modules/loop-builder/skins/skin-loop-base.php:54-63), so a prefixed
 * `{skin}_query_posts_per_page` is a silent no-op (SUPPLEMENT §A.4).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Pure loop-query → widget-settings mapper. No state, no I/O — every method is static + side-effect-free.
 */
final class Loop_Query_Mapper {

	/** The query-group control name Pro joins onto the skin id (`Module::QUERY_ID`, loop-builder/module.php). */
	const QUERY_ID = 'query';

	/** The default skin (Posts) — `LOOP_POST_SKIN_ID` (loop-builder/module.php:26). */
	const DEFAULT_SKIN = 'post';

	/** The default widget type (loop-grid.php:21 `get_name()='loop-grid'`). */
	const DEFAULT_WIDGET = 'loop-grid';

	/** The grid's default per-page count (loop-grid.php:85, def 6). */
	const DEFAULT_POSTS_PER_PAGE = 6;

	/**
	 * The `{skin}_query_` prefix DERIVED from a skin id, mirroring Pro's `Base::get_query_name()`
	 * (elementor-pro/modules/loop-builder/widgets/base.php:32-35):
	 *   `str_replace('-','_',$skin_id) . '_' . Module::QUERY_ID . '_'`.
	 * e.g. `post` → `post_query_`, `post-taxonomy` → `post_taxonomy_query_`, `product` → `product_query_`.
	 *
	 * @param string $skin The skin id (`post|post_taxonomy|product|product_taxonomy`, hyphens tolerated).
	 */
	public static function query_prefix( string $skin ): string {
		$skin_id = str_replace( '-', '_', $skin );
		return $skin_id . '_' . self::QUERY_ID . '_';
	}

	/**
	 * Build the FLAT loop widget settings map (SUPPLEMENT §A.4). Returns ONLY the keys the caller supplied
	 * meaningful values for, in a stable order: `template_id`, `_skin`, top-level `posts_per_page`/`columns`
	 * (+responsive), the `{skin}_query_*` group keys, then pagination.
	 *
	 * @param string                   $skin           The skin id → `_skin` (drives the query prefix).
	 * @param array<string,mixed>      $query          The high-level query: `post_type`, `orderby`, `order`,
	 *                                                  `include_term_ids`, `exclude_ids`, `posts_ids`, `query_id`,
	 *                                                  `offset`, `avoid_duplicates`, `ignore_sticky_posts`.
	 * @param int                      $posts_per_page Top-level per-page count (def 6).
	 * @param string|null              $columns        Top-level columns (responsive base); null = omit.
	 * @param array<string,mixed>|null $pagination     Optional `{type,load_type}` → `pagination_*` keys.
	 * @param string                   $template_id    The bound loop-item template id (kept as a string).
	 *
	 * @return array<string,mixed> The flat widget `settings` map.
	 */
	public static function map( string $skin, array $query, int $posts_per_page, ?string $columns = null, ?array $pagination = null, string $template_id = '' ): array {
		$settings = array();

		// `template_id` (string) at the widget root — the bound loop-item doc (loop-grid.php:119-122). Almost
		// every loop control is conditioned on `template_id!=''` (loop-grid.php:154-190).
		if ( '' !== $template_id ) {
			$settings['template_id'] = $template_id;
		}

		// `_skin` = the chosen skin (base.php:96 stores the skin in `_skin`).
		$settings['_skin'] = '' !== $skin ? $skin : self::DEFAULT_SKIN;

		// `posts_per_page` TOP-LEVEL (loop-grid.php:85, def 6) — NEVER `{skin}_query_posts_per_page` (the
		// query group EXCLUDES it; setting it there is a silent no-op — SUPPLEMENT §A.4 gotcha).
		$settings['posts_per_page'] = $posts_per_page > 0 ? $posts_per_page : self::DEFAULT_POSTS_PER_PAGE;

		// `columns` TOP-LEVEL (responsive, def 3 / tablet 2 / mobile 1 — loop-grid.php:62-340).
		if ( null !== $columns && '' !== $columns ) {
			$settings['columns'] = $columns;
		}
		// Responsive columns when explicitly provided via the query bag's optional helpers.
		foreach ( array( 'columns_tablet', 'columns_mobile' ) as $responsive_key ) {
			if ( isset( $query[ $responsive_key ] ) && '' !== (string) $query[ $responsive_key ] ) {
				$settings[ $responsive_key ] = (string) $query[ $responsive_key ];
			}
		}

		// The `{skin}_query_*` group keys (group-control-query.php:34-401), prefix DERIVED from the skin.
		foreach ( self::query_settings( $skin, $query ) as $key => $value ) {
			$settings[ $key ] = $value;
		}

		// Pagination keys at the widget root (base.php:174-343); load type defaults to page-reload in Pro.
		if ( is_array( $pagination ) ) {
			if ( isset( $pagination['type'] ) && '' !== (string) $pagination['type'] ) {
				$settings['pagination_type'] = (string) $pagination['type'];
			}
			if ( isset( $pagination['load_type'] ) && '' !== (string) $pagination['load_type'] ) {
				$settings['pagination_load_type'] = (string) $pagination['load_type'];
			}
		}

		return $settings;
	}

	/**
	 * Build ONLY the prefixed `{skin}_query_*` group keys for `$query`. Pure (the prefix is derived once).
	 * Mirrors the `Group_Control_Related` fields (group-control-query.php:34-401):
	 *   `{p}post_type`, `{p}orderby`, `{p}order`, `{p}include` + `{p}include_term_ids`,
	 *   `{p}exclude` + `{p}exclude_ids`, `{p}posts_ids` (when `post_type='by_id'`), `{p}query_id`,
	 *   `{p}offset`, `{p}avoid_duplicates`, `{p}ignore_sticky_posts`.
	 *
	 * @param string              $skin  The skin id (drives the prefix).
	 * @param array<string,mixed> $query The high-level query bag.
	 *
	 * @return array<string,mixed> The prefixed query keys (only those the caller supplied).
	 */
	private static function query_settings( string $skin, array $query ): array {
		$prefix = self::query_prefix( '' !== $skin ? $skin : self::DEFAULT_SKIN );
		$out    = array();

		$post_type = isset( $query['post_type'] ) ? (string) $query['post_type'] : '';
		if ( '' !== $post_type ) {
			$out[ $prefix . 'post_type' ] = $post_type;
		}

		// Manual selection: `post_type='by_id'` pairs with `{p}posts_ids` (SUPPLEMENT §A.4 "Manual" note).
		if ( 'by_id' === $post_type ) {
			$posts_ids = self::string_list( $query['posts_ids'] ?? null );
			if ( array() !== $posts_ids ) {
				$out[ $prefix . 'posts_ids' ] = $posts_ids;
			}
		}

		if ( isset( $query['orderby'] ) && '' !== (string) $query['orderby'] ) {
			$out[ $prefix . 'orderby' ] = (string) $query['orderby'];
		}
		if ( isset( $query['order'] ) && '' !== (string) $query['order'] ) {
			$out[ $prefix . 'order' ] = (string) $query['order'];
		}

		// `include_term_ids` → set BOTH `{p}include`:['terms'] AND `{p}include_term_ids` (the include control is
		// a SELECT2 of terms|authors; SUPPLEMENT §A.4 worked example). Term ids are stored as STRINGS.
		$include_term_ids = self::string_list( $query['include_term_ids'] ?? null );
		if ( array() !== $include_term_ids ) {
			$out[ $prefix . 'include' ]          = array( 'terms' );
			$out[ $prefix . 'include_term_ids' ] = $include_term_ids;
		}

		// `exclude_ids` → set BOTH `{p}exclude`:['current_post'] is NOT what's meant here; the exclude SELECT2
		// covers current_post|manual_selection|terms|authors. `exclude_ids` is the manual-selection list, so we
		// surface `{p}exclude`:['manual_selection'] + `{p}exclude_ids`.
		$exclude_ids = self::string_list( $query['exclude_ids'] ?? null );
		if ( array() !== $exclude_ids ) {
			$out[ $prefix . 'exclude' ]     = array( 'manual_selection' );
			$out[ $prefix . 'exclude_ids' ] = $exclude_ids;
		}

		if ( isset( $query['query_id'] ) && '' !== (string) $query['query_id'] ) {
			$out[ $prefix . 'query_id' ] = (string) $query['query_id'];
		}
		if ( isset( $query['offset'] ) && '' !== (string) $query['offset'] ) {
			$out[ $prefix . 'offset' ] = (int) $query['offset'];
		}
		if ( isset( $query['avoid_duplicates'] ) && '' !== (string) $query['avoid_duplicates'] ) {
			$out[ $prefix . 'avoid_duplicates' ] = (string) $query['avoid_duplicates'];
		}
		if ( isset( $query['ignore_sticky_posts'] ) && '' !== (string) $query['ignore_sticky_posts'] ) {
			$out[ $prefix . 'ignore_sticky_posts' ] = (string) $query['ignore_sticky_posts'];
		}

		return $out;
	}

	/**
	 * Coerce a value to a clean list of non-empty STRINGS (term/post ids are stored as strings in the loop
	 * query group — SUPPLEMENT §A.4 worked example `["15","16"]`). Accepts an array or a scalar.
	 *
	 * @param mixed $value The candidate (array | scalar | null).
	 *
	 * @return string[] A re-indexed list of non-empty string ids.
	 */
	private static function string_list( $value ): array {
		if ( null === $value || '' === $value ) {
			return array();
		}
		$items = is_array( $value ) ? $value : array( $value );
		$out   = array();
		foreach ( $items as $item ) {
			if ( is_array( $item ) ) {
				continue; // Skip nested arrays — ids are scalar.
			}
			$str = (string) $item;
			if ( '' !== $str ) {
				$out[] = $str;
			}
		}
		return array_values( $out );
	}
}
