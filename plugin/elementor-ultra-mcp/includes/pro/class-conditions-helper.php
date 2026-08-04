<?php
/**
 * WP-R01 — Conditions_Helper: writes display conditions ONLY through `Conditions_Manager::save_conditions()`.
 *
 * Contract authority:
 *  - 10-rest-api.md §8 (ConditionTuple `[type, name, sub_name?, sub_id?]`, `type ∈ include|exclude`;
 *    "Stored slash-joined via `Conditions_Manager::save_conditions()` … which ALSO calls
 *    `cache->regenerate()` — writing meta directly is FORBIDDEN").
 *  - 10-rest-api.md §8.2 (conflicts), §8.3 (conditions-config tree + id-bearing subs).
 *  - 12-error-taxonomy.md §3.1 (`SCHEMA_INVALID_PARAMS` for a structurally impossible tuple).
 *  - SUPPLEMENT.md §A.1 (slash-storage contract, condition catalog, id-bearing sub controls, Woo gotcha).
 *
 * Elementor Pro APIs (cited `path:line` relative to plugins/elementor-pro):
 *  - `Conditions_Manager::save_conditions()` — modules/theme-builder/classes/conditions-manager.php:300-326
 *    (loops `unset($condition['_id']); $conditions_to_save[] = rtrim(implode('/',$condition),'/')` :303-306;
 *    empty -> `delete_meta('_elementor_conditions')` :318; else `update_meta(...)` :320; `cache->regenerate()` :323).
 *  - `Conditions_Manager::get_conditions_config()` — conditions-manager.php:236-244.
 *  - `Conditions_Manager::get_conditions_conflicts_by_location()` — conditions-manager.php:124-169
 *    (returns `[]` when the location is `multiple` :130-132; skips `$ignore_post_id` :145-147; matches
 *    `array_search($condition,$conditions,true)` :149).
 *  - `Module::instance()->get_conditions_manager()` — modules/theme-builder/module.php:77-79.
 *  - `Module::instance()->get_locations_manager()->get_location($location)` — locations-manager.php:503-513.
 *  - Condition decode `array_pad(explode('/',...),4,'')` — conditions-manager.php:507-508.
 *
 * Shared by the theme-builder (WP-R01) AND the popup (WP-R02) surfaces: popup conditions also save
 * through this helper at location `popup` (which is `multiple=true` so `conflicts()` always returns `[]`).
 *
 * NEVER writes `_elementor_conditions` raw (wrong shape + stale cache). After save it RE-READS the meta
 * to return the canonical slash strings (`conditions_stored`) — it never re-derives them in PHP (the
 * manager `rtrim`s the slash join, so the stored value is authoritative — ticket Detailed-Req #6).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Rest\Response;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Display-conditions helper. All methods are static so any Pro service can call them without wiring.
 */
final class Conditions_Helper {

	/** The valid `type` values for a ConditionTuple (10-rest-api.md §8; SUPPLEMENT §A.1). */
	const VALID_TYPES = array( 'include', 'exclude' );

	/**
	 * Sub-condition names that take a trailing `sub_id` (10-rest-api.md §8.3 `id_bearing`; SUPPLEMENT
	 * §A.1 "`sub_id` source controls"). Derived from the core catalog ONLY (never hardcode CPT/tax
	 * names beyond these structural building blocks):
	 *  - `post`                -> post_id (conditions/post.php).
	 *  - `taxonomy`,`in_taxonomy` (and `in_*`/`in_*_children` term conditions) -> term_id (taxonomy.php / in-taxonomy.php).
	 *  - `author`,`by_author`  -> author_id (author.php / by-author.php).
	 *  - `child_of`,`any_child_of` -> parent_id (child-of.php).
	 *
	 * @var string[]
	 */
	const ID_BEARING = array( 'post', 'taxonomy', 'in_taxonomy', 'author', 'by_author', 'child_of', 'any_child_of' );

	/** The postmeta key the manager flattens slash strings into. */
	const CONDITIONS_META_KEY = '_elementor_conditions';

	/** Woo-gated condition names that silently do not fire for theme docs when Woo is active (SUPPLEMENT §A.1). */
	const WOO_GATED_NAMES = array( 'product', 'product_archive' );

	/**
	 * Validate ConditionTuples STRUCTURALLY (ticket Detailed-Req #7). Returns a 400
	 * `SCHEMA_INVALID_PARAMS` `WP_Error` ONLY for a structurally impossible tuple — `type` not in the
	 * enum, a non-array tuple, or an empty `name`. Unknown site-specific CPT/taxonomy `name`/`sub_name`
	 * are PASSED THROUGH (the site may register them) and surfaced to the caller via
	 * {@see unverified_names()} — never rejected (never hardcode beyond the core catalog).
	 *
	 * @param array<int,mixed> $tuples The raw ConditionTuple array.
	 * @return true|WP_Error
	 */
	public static function validate( array $tuples ) {
		foreach ( $tuples as $i => $tuple ) {
			if ( ! is_array( $tuple ) || array() === $tuple ) {
				return self::invalid( $i, 'tuple must be a non-empty array [type, name, sub_name?, sub_id?]' );
			}
			// Positional access (the wire shape is a JSON array, decoded to a 0-indexed PHP array).
			$type = isset( $tuple[0] ) ? (string) $tuple[0] : '';
			$name = isset( $tuple[1] ) ? (string) $tuple[1] : '';

			if ( ! in_array( $type, self::VALID_TYPES, true ) ) {
				return self::invalid( $i . '.0', 'type must be one of include|exclude' );
			}
			if ( '' === $name ) {
				return self::invalid( $i . '.1', 'name is required' );
			}
		}
		return true;
	}

	/**
	 * Convert ConditionTuples to the manager's positional `[type, name, sub_name, sub_id]` form and save
	 * via `Conditions_Manager::save_conditions()` (which writes the slash strings + `cache->regenerate()`,
	 * conditions-manager.php:300-326). Re-reads `_elementor_conditions` to return the canonical stored
	 * slash strings (ticket Detailed-Req #6 — trust the stored value, do not re-derive).
	 *
	 * An EMPTY `$tuples` array clears the conditions (the manager deletes the meta and STILL regenerates
	 * the cache — conditions-manager.php:317-323, relied on for the `[]`-clears semantics).
	 *
	 * Returns `{ conditions_stored, unverified_names, warnings }`. `warnings` carries the Woo gotcha
	 * (ticket Detailed-Req #8): when a saved condition names `product`/`product_archive` and WooCommerce
	 * is active, the condition silently never fires for theme docs.
	 *
	 * @param int              $post_id The theme/popup document id.
	 * @param array<int,mixed> $tuples  The ConditionTuple array (already validated).
	 *
	 * @return array{conditions_stored:string[],unverified_names:string[],warnings:string[]}|WP_Error
	 */
	public static function save( int $post_id, array $tuples ) {
		$manager = self::conditions_manager();
		if ( null === $manager ) {
			return Response::error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'The Elementor Pro theme-builder conditions manager is unavailable.', 'elementor-ultra-mcp' ),
				502
			);
		}

		// Strip any `_id` keys defensively + pass positional arrays (the manager also `unset($condition['_id'])`
		// at conditions-manager.php:304, then `rtrim(implode('/', $condition), '/')` — trailing empties trimmed).
		$manager_input = self::to_manager_form( $tuples );

		// AUTHORITATIVE write: slash strings + cache->regenerate() (conditions-manager.php:300-323). Never raw.
		$manager->save_conditions( $post_id, $manager_input );

		return array(
			'conditions_stored' => self::read_stored( $post_id ),
			'unverified_names'  => self::unverified_names( $tuples ),
			'warnings'          => self::woo_warnings( $tuples ),
		);
	}

	/**
	 * Re-read the stored canonical slash strings from `_elementor_conditions` (post-save). Returns a
	 * clean string[] (empty array when the meta was deleted / never set).
	 *
	 * @param int $post_id The document id.
	 * @return string[]
	 */
	public static function read_stored( int $post_id ): array {
		$raw = get_post_meta( $post_id, self::CONDITIONS_META_KEY, true );
		if ( ! is_array( $raw ) ) {
			return array();
		}
		return array_values( array_map( 'strval', $raw ) );
	}

	/**
	 * Conflict detection for a single tuple at a location (ticket Detailed-Req #4; SUPPLEMENT §A.1).
	 * Wraps `Conditions_Manager::get_conditions_conflicts_by_location($condition, $location, $ignore_post_id)`
	 * (conditions-manager.php:124-169). Single-instance locations (header/footer/single) conflict on a
	 * duplicate include; popup location is `multiple=true` so the manager returns `[]` (no conflict).
	 * `$ignore_post_id` is the current post id so a doc never conflicts with itself (ticket Impl-Notes).
	 *
	 * @param int              $post_id  The current document id (used as `$ignore_post_id`).
	 * @param array<int,mixed> $tuples   The ConditionTuple array.
	 * @param string           $location The theme location (header/footer/single/archive/popup/section locations).
	 *
	 * @return array<int,array{template_id:int,template_title:string,edit_url:string}>
	 */
	public static function conflicts( int $post_id, array $tuples, string $location ): array {
		$manager = self::conditions_manager();
		if ( null === $manager || '' === $location ) {
			return array();
		}

		$conflicts = array();
		$seen      = array();
		foreach ( self::to_manager_form( $tuples ) as $condition ) {
			// The manager matches the EXACT positional array against its location cache
			// (`array_search($condition, $conditions, true)`, conditions-manager.php:149).
			$found = $manager->get_conditions_conflicts_by_location( $condition, $location, $post_id );
			if ( ! is_array( $found ) ) {
				continue;
			}
			foreach ( $found as $row ) {
				if ( ! is_array( $row ) || ! isset( $row['template_id'] ) ) {
					continue;
				}
				$tid = (int) $row['template_id'];
				if ( isset( $seen[ $tid ] ) ) {
					continue;
				}
				$seen[ $tid ] = true;
				$conflicts[]  = array(
					'template_id'    => $tid,
					'template_title' => isset( $row['template_title'] ) ? (string) $row['template_title'] : '',
					'edit_url'       => isset( $row['edit_url'] ) ? (string) $row['edit_url'] : '',
				);
			}
		}
		return $conflicts;
	}

	/**
	 * The live conditions-config tree (10-rest-api.md §8.3) — `Conditions_Manager::get_conditions_config()`
	 * (conditions-manager.php:236-244; each entry = `Controls_Stack` config + `Condition_Base::get_initial_config()`
	 * extras `{label, all_label, sub_conditions}`, condition-base.php:42-48). Returns `[]` when Pro is
	 * unavailable so the route degrades gracefully.
	 *
	 * @return array<string,mixed>
	 */
	public static function config_tree(): array {
		$manager = self::conditions_manager();
		if ( null === $manager || ! method_exists( $manager, 'get_conditions_config' ) ) {
			return array();
		}
		$config = $manager->get_conditions_config();
		return is_array( $config ) ? $config : array();
	}

	/**
	 * The id-bearing sub-condition names (10-rest-api.md §8.3 `id_bearing`). A copy of the frozen core
	 * catalog so callers learn which subs take a trailing `sub_id` WITHOUT hardcoding CPT/tax names.
	 *
	 * @return string[]
	 */
	public static function id_bearing(): array {
		return self::ID_BEARING;
	}

	/**
	 * The theme locations (10-rest-api.md §8.3 `locations`) — keys of
	 * `Module::instance()->get_locations_manager()->get_locations()` (locations-manager.php:492-501).
	 *
	 * @return string[]
	 */
	public static function location_keys(): array {
		$locations = self::all_locations();
		return array_values( array_map( 'strval', array_keys( $locations ) ) );
	}

	/**
	 * The full locations map (used to validate a `section` document's `location` and to resolve a doc's
	 * location for conflict detection). Empty when Pro/locations-manager is unavailable.
	 *
	 * @return array<string,mixed>
	 */
	public static function all_locations(): array {
		$module = self::theme_module();
		if ( null === $module || ! method_exists( $module, 'get_locations_manager' ) ) {
			return array();
		}
		$manager = $module->get_locations_manager();
		if ( ! is_object( $manager ) || ! method_exists( $manager, 'get_locations' ) ) {
			return array();
		}
		$locations = $manager->get_locations();
		return is_array( $locations ) ? $locations : array();
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Internal helpers.
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Convert ConditionTuples to the manager's positional `[type, name, sub_name, sub_id]` arrays,
	 * dropping any `_id` key and any null/empty trailing slots (the manager `rtrim`s the slash join,
	 * conditions-manager.php:305, so trailing empties are harmless but we trim for a clean match in
	 * conflict detection which uses strict `array_search`).
	 *
	 * @param array<int,mixed> $tuples The raw tuples.
	 * @return array<int,array<int,string>>
	 */
	private static function to_manager_form( array $tuples ): array {
		$out = array();
		foreach ( $tuples as $tuple ) {
			if ( ! is_array( $tuple ) ) {
				continue;
			}
			// Accept either a positional array or an assoc form; normalize to positional, drop `_id`.
			unset( $tuple['_id'] );
			if ( self::is_assoc( $tuple ) ) {
				$ordered = array(
					isset( $tuple['type'] ) ? (string) $tuple['type'] : '',
					isset( $tuple['name'] ) ? (string) $tuple['name'] : '',
					isset( $tuple['sub_name'] ) ? (string) $tuple['sub_name'] : '',
					isset( $tuple['sub_id'] ) ? (string) $tuple['sub_id'] : '',
				);
			} else {
				$ordered = array(
					isset( $tuple[0] ) ? (string) $tuple[0] : '',
					isset( $tuple[1] ) ? (string) $tuple[1] : '',
					isset( $tuple[2] ) ? (string) $tuple[2] : '',
					isset( $tuple[3] ) ? (string) $tuple[3] : '',
				);
			}
			// Trim trailing empties so a 2-tuple matches the manager's stored 2-tuple in conflict search.
			while ( count( $ordered ) > 1 && '' === end( $ordered ) ) {
				array_pop( $ordered );
			}
			$out[] = array_values( $ordered );
		}
		return $out;
	}

	/**
	 * Names that could not be cross-checked against the live conditions-config keys (passed through, not
	 * rejected — ticket Detailed-Req #7). A name/sub_name is "verified" when it is a key in the config
	 * tree; an unknown site-specific CPT/taxonomy name is reported here for the caller's awareness.
	 *
	 * @param array<int,mixed> $tuples The raw tuples.
	 * @return string[]
	 */
	private static function unverified_names( array $tuples ): array {
		$config = self::config_tree();
		if ( array() === $config ) {
			return array(); // Cannot verify without the tree; do not flood the caller.
		}
		$known      = self::known_names( $config );
		$unverified = array();
		foreach ( $tuples as $tuple ) {
			if ( ! is_array( $tuple ) ) {
				continue;
			}
			foreach ( array(
				1 => 'name',
				2 => 'sub_name',
			) as $idx => $label ) {
				$value = isset( $tuple[ $idx ] ) ? (string) $tuple[ $idx ] : ( isset( $tuple[ $label ] ) ? (string) $tuple[ $label ] : '' );
				if ( '' === $value ) {
					continue;
				}
				if ( ! in_array( $value, $known, true ) ) {
					$unverified[] = $value;
				}
			}
		}
		return array_values( array_unique( $unverified ) );
	}

	/**
	 * The Woo gotcha warnings (ticket Detailed-Req #8; SUPPLEMENT §A.1) — appended when a saved
	 * condition names `product`/`product_archive` and WooCommerce is active (those conditions silently
	 * never fire for theme docs; Woo templates are handled by the WooCommerce module instead). Non-fatal.
	 *
	 * @param array<int,mixed> $tuples The raw tuples.
	 * @return string[]
	 */
	private static function woo_warnings( array $tuples ): array {
		if ( ! class_exists( 'WooCommerce' ) && ! function_exists( 'WC' ) ) {
			return array();
		}
		$warnings = array();
		foreach ( $tuples as $tuple ) {
			if ( ! is_array( $tuple ) ) {
				continue;
			}
			foreach ( array( 1, 2 ) as $idx ) {
				$value = isset( $tuple[ $idx ] ) ? (string) $tuple[ $idx ] : '';
				if ( in_array( $value, self::WOO_GATED_NAMES, true ) ) {
					$warnings[] = sprintf(
						/* translators: %s: condition name (product / product_archive). */
						__( 'Condition "%s" does not fire for theme documents while WooCommerce is active; use the WooCommerce module templates instead.', 'elementor-ultra-mcp' ),
						$value
					);
				}
			}
		}
		return array_values( array_unique( $warnings ) );
	}

	/**
	 * Flatten the conditions-config tree to the full set of known condition keys (top-level + every
	 * nested `sub_conditions` name) so {@see unverified_names()} can cross-check name/sub_name.
	 *
	 * @param array<string,mixed> $config The config tree (top-level keyed by condition name).
	 * @return string[]
	 */
	private static function known_names( array $config ): array {
		$names = array_keys( $config );
		foreach ( $config as $entry ) {
			if ( is_array( $entry ) && isset( $entry['sub_conditions'] ) && is_array( $entry['sub_conditions'] ) ) {
				foreach ( $entry['sub_conditions'] as $sub ) {
					$names[] = (string) $sub;
				}
			}
		}
		return array_values( array_unique( array_map( 'strval', $names ) ) );
	}

	/**
	 * Build a 400 `SCHEMA_INVALID_PARAMS` `WP_Error` for a structurally impossible tuple.
	 *
	 * @param string $path   The dotted path into the conditions array (e.g. `0.0`).
	 * @param string $reason Human reason.
	 */
	private static function invalid( string $path, string $reason ): WP_Error {
		return Response::error(
			Error_Codes::SCHEMA_INVALID_PARAMS,
			sprintf(
				/* translators: 1: dotted path, 2: reason. */
				__( 'Invalid condition tuple at conditions.%1$s: %2$s.', 'elementor-ultra-mcp' ),
				$path,
				$reason
			),
			400,
			array(
				'path'   => 'conditions.' . $path,
				'reason' => $reason,
			)
		);
	}

	/** Whether a PHP array is associative (has at least one non-integer key). */
	private static function is_assoc( array $arr ): bool {
		foreach ( array_keys( $arr ) as $k ) {
			if ( ! is_int( $k ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The Pro theme-builder Module instance (`\ElementorPro\Modules\ThemeBuilder\Module::instance()`,
	 * module.php) or null when Pro is unavailable.
	 *
	 * @return object|null
	 */
	private static function theme_module() {
		if ( ! Pro_Gate::is_pro_active() ) {
			return null;
		}
		if ( ! class_exists( '\ElementorPro\Modules\ThemeBuilder\Module' ) ) {
			return null;
		}
		$module = \ElementorPro\Modules\ThemeBuilder\Module::instance();
		return is_object( $module ) ? $module : null;
	}

	/**
	 * The Pro conditions manager (`Module::instance()->get_conditions_manager()`, module.php:77-79) or
	 * null when Pro is unavailable.
	 *
	 * @return object|null
	 */
	private static function conditions_manager() {
		$module = self::theme_module();
		if ( null === $module || ! method_exists( $module, 'get_conditions_manager' ) ) {
			return null;
		}
		$manager = $module->get_conditions_manager();
		return is_object( $manager ) ? $manager : null;
	}
}
