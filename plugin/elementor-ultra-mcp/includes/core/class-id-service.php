<?php
/**
 * WP-P04 — Id_Service: mint / dedupe / remap 7-hex element ids + rewrite local-style back-references.
 *
 * Contract authority:
 *  - 10-rest-api.md §10 (ids routes: `GET /documents/{id}/ids`, `POST /ids/validate`, `POST /ids/remap`),
 *    §2.6 step 4 (the writer dedupes ids before persist via remap_tree), §2.9 (duplicate replaces ALL ids).
 *  - 11-authoring-contract.md §8.1 (id handling), R3 (mint `substr(strtolower(dechex(wp_rand(0,PHP_INT_MAX))),0,7)`,
 *    dedupe vs a live set), R4 / §5.1 (local-style ids unique AND mirrored into settings.classes.value).
 *  - includes/utils.php:373-375 (the mint source `dechex(rand())` — we use the contract's exact wp_rand formula).
 *  - core/base/document.php:1641-1654 (export id replacement reference for dedupe_for_insert).
 *  - modules/atomic-widgets/import-export/modifiers/styles-ids-modifier.php (the EXACT local-style backref
 *    rewrite algorithm this service mirrors: rekey the `styles` map to `e-{newElementId}-{7hex}`, set each
 *    `styles[].id`, then rewrite every `classes`-typed envelope's `value[]` via old->new).
 *
 * SPIKE-VERIFIED CORRECTIONS:
 *  - [R5 — corrected] Elementor's Document::save does NOT regenerate element/local-style ids (verified
 *    empirically on a live save). Ids ARE stable across saves as long as the writer dedupes intra-tree
 *    only: passing the target post as `against_post_id` for a tree that REPLACES that post's tree makes
 *    every existing id "collide" and regenerate. `against_post_id` is for INSERT-shaped dedupe (a candidate
 *    fragment merging into a document that keeps its current tree), never for a full-tree save/replace.
 *
 * Pure computation — NEVER persists, NEVER writes meta (the ids routes are CAP_READ, 10 §10). All three
 * public methods are static so any controller (WP-P06/P08/P12/P15 + the Pro WPs) can call them directly.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Element-id minter / deduper / remapper. Resolves intra-tree and against-document id collisions and keeps
 * the local-style triple consistent: the `styles` map key === `styles[].id` === the value in
 * `settings.classes.value` (11 §5.1). The single source the ids routes + the write engine call.
 */
final class Id_Service {

	/** The `classes` prop-type key (modules/atomic-widgets/prop-types/classes-prop-type.php:12-13). */
	const CLASSES_PROP_TYPE = 'classes';

	/**
	 * Mint a fresh 7-hex element id (11 §8.1 R3, contract formula). EXACTLY
	 * `substr( strtolower( dechex( wp_rand( 0, PHP_INT_MAX ) ) ), 0, 7 )` — the frozen formula (mirrors
	 * the intent of includes/utils.php:373-375 while using WP's CSPRNG `wp_rand`). Note this can return a
	 * string shorter than 7 chars for small randoms; callers that need collision-free ids use
	 * {@see mint_unique()} which loops against a live set.
	 */
	public static function mint(): string {
		return substr( strtolower( dechex( wp_rand( 0, PHP_INT_MAX ) ) ), 0, 7 );
	}

	/**
	 * Mint a 7-hex id guaranteed absent from `$existing` (a `{id=>true}` set OR a list of ids). Loops the
	 * contract mint formula until unique. Used by remap/dedupe so two regenerated ids never re-collide.
	 *
	 * @param array<string,bool>|string[] $existing A used-id set ({id=>true}) or a plain id list.
	 */
	public static function mint_unique( array $existing ): string {
		$set = self::as_set( $existing );
		do {
			$id = self::mint();
		} while ( '' === $id || isset( $set[ $id ] ) );
		return $id;
	}

	/**
	 * The used-id set for a document (10 §10 `GET /documents/{id}/ids`). Flattens the existing
	 * `_elementor_data` tree (read-only, never instantiated) and returns BOTH the element ids and the
	 * local-style ids (the keys of every node's `styles` map).
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array{ids:string[],local_style_ids:string[]}
	 */
	public static function used_ids( int $post_id ): array {
		$tree = self::read_tree( $post_id );
		if ( null === $tree ) {
			return array(
				'ids'             => array(),
				'local_style_ids' => array(),
			);
		}

		$ids       = array();
		$style_ids = array();
		self::collect_ids( $tree, $ids, $style_ids );

		return array(
			'ids'             => array_values( array_unique( $ids ) ),
			'local_style_ids' => array_values( array_unique( $style_ids ) ),
		);
	}

	/**
	 * Validate id uniqueness of a candidate tree (10 §10 `POST /ids/validate`). Reports intra-tree and
	 * against-document element-id collisions (R3) AND duplicate local-style ids across the tree (R4). No
	 * persist, no mutation.
	 *
	 * @param array<int,array<string,mixed>> $elements        The candidate tree.
	 * @param int                            $against_post_id When >0, also collide vs the document's used ids.
	 *
	 * @return array{valid:bool,collisions:string[],duplicate_local_styles:string[]}
	 */
	public static function validate_tree( array $elements, int $against_post_id = 0 ): array {
		$ids       = array();
		$style_ids = array();
		self::collect_ids( $elements, $ids, $style_ids );

		// Intra-tree element-id duplicates.
		$collisions = self::find_duplicates( $ids );

		// Against-document element-id collisions (merge/insert safety, R3).
		if ( $against_post_id > 0 ) {
			$existing = self::as_set( self::used_ids( $against_post_id )['ids'] );
			foreach ( array_unique( $ids ) as $id ) {
				if ( isset( $existing[ $id ] ) ) {
					$collisions[] = $id;
				}
			}
		}

		$duplicate_local_styles = self::find_duplicates( $style_ids );

		return array(
			'valid'                  => empty( $collisions ) && empty( $duplicate_local_styles ),
			'collisions'             => array_values( array_unique( $collisions ) ),
			'duplicate_local_styles' => array_values( array_unique( $duplicate_local_styles ) ),
		);
	}

	/**
	 * Remap ONLY colliding ids in a candidate tree (10 §10 `POST /ids/remap`, §2.6 step 4). Regenerates an
	 * element id when it (a) duplicates another id within the tree or (b) already exists in the target
	 * document; non-colliding ids are LEFT UNTOUCHED. When an element id changes, every dependent local
	 * style is rekeyed `e-{newElementId}-{7hex}` and its back-references in `settings.classes.value` are
	 * rewritten — keeping the `styles` map key === `styles[].id` === the `classes.value` entry consistent
	 * (mirror styles-ids-modifier.php). Returns the new tree + an `{oldId => newId}` map of changed ELEMENT
	 * ids (11 §8.1; the §10 response `remapped`).
	 *
	 * WARNING: `against_post_id` seeds the taken-set with the document's CURRENT ids, so it is only correct
	 * for INSERT-shaped candidates (a fragment merging into a document that keeps its existing tree). For a
	 * full-tree save/replace, pass 0 (intra-tree dedupe only) — the old tree is being replaced, its ids are
	 * not collisions, and remapping them would destabilize every element + local-style id on every write.
	 *
	 * @param array<int,array<string,mixed>> $elements        The candidate tree.
	 * @param int                            $against_post_id When >0, also dedupe vs the document's used ids
	 *                                                        (insert-shaped candidates ONLY — see WARNING).
	 *
	 * @return array{elements:array<int,array<string,mixed>>,remapped:array<string,string>}
	 */
	public static function remap_tree( array $elements, int $against_post_id = 0 ): array {
		// The live "taken" set we mint against: the document's used ids + every id already seen in the tree.
		$taken = ( $against_post_id > 0 )
			? self::as_set( self::used_ids( $against_post_id )['ids'] )
			: array();

		$remapped = array();
		$seen     = array(); // Ids accepted so far this pass (first occurrence wins; later dupes regenerate).

		$new_tree = self::walk_remap( $elements, $taken, $seen, $remapped );

		return array(
			'elements' => $new_tree,
			'remapped' => $remapped,
		);
	}

	/**
	 * Regenerate ALL element ids in a tree (clone/insert of a library block, 11 §8.1; mirror the export id
	 * replacement core/base/document.php:1641-1654). Every element id is replaced with a fresh unique id and
	 * every dependent local style is rekeyed + its back-refs rewritten — guaranteeing zero cross-document
	 * collision. `$existing_ids` seeds the "taken" set (the target document's used ids).
	 *
	 * @param array<int,array<string,mixed>> $elements     The tree to clone.
	 * @param array<string,bool>|string[]    $existing_ids The target document's used-id set (or list).
	 *
	 * @return array{elements:array<int,array<string,mixed>>,remapped:array<string,string>}
	 */
	public static function dedupe_for_insert( array $elements, array $existing_ids ): array {
		$taken    = self::as_set( $existing_ids );
		$remapped = array();
		$seen     = array();

		$new_tree = self::walk_remap( $elements, $taken, $seen, $remapped, true );

		return array(
			'elements' => $new_tree,
			'remapped' => $remapped,
		);
	}

	// ------------------------------------------------------------------------------------------------
	// Internal: the remap walk.
	// ------------------------------------------------------------------------------------------------

	/**
	 * Depth-first remap walk. For each node: decide whether its element id must change (always when
	 * `$force`, else only on collision vs `$taken` or a prior `$seen`), regenerate + rewrite local styles
	 * when it does, then recurse into children. Mutates `$taken`/`$seen`/`$remapped` in place.
	 *
	 * @param array<int,array<string,mixed>> $elements The (sub)tree.
	 * @param array<string,bool>             $taken    Live taken-id set (mutated).
	 * @param array<string,bool>             $seen     Ids accepted this pass (mutated).
	 * @param array<string,string>           $remapped Out: old->new element-id map (mutated).
	 * @param bool                           $force    When true, regenerate EVERY element id (insert/clone).
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function walk_remap( array $elements, array &$taken, array &$seen, array &$remapped, bool $force = false ): array {
		$out = array();

		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				$out[] = $node;
				continue;
			}

			$old_id = isset( $node['id'] ) && is_string( $node['id'] ) ? $node['id'] : '';
			$new_id = $old_id;

			$must_regenerate = $force
				|| '' === $old_id
				|| isset( $taken[ $old_id ] )
				|| isset( $seen[ $old_id ] );

			if ( $must_regenerate ) {
				$new_id     = self::mint_unique( $taken );
				$node['id'] = $new_id;
				if ( '' !== $old_id ) {
					$remapped[ $old_id ] = $new_id;
				}
			}

			// Reserve the (possibly unchanged) id so siblings/children never re-collide.
			$taken[ $new_id ] = true;
			$seen[ $new_id ]  = true;

			// Rewrite local styles whenever the owning element id changed (the local-style id embeds the
			// element id, so a stable element id keeps its style ids stable — mirror styles-ids-modifier).
			if ( $new_id !== $old_id ) {
				$node = self::rewrite_local_styles( $node, $new_id, $taken );
			}

			// Recurse into children (both generations nest under `elements`).
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) && ! empty( $node['elements'] ) ) {
				$node['elements'] = self::walk_remap( $node['elements'], $taken, $seen, $remapped, $force );
			}

			$out[] = $node;
		}

		return $out;
	}

	/**
	 * Rekey a node's local `styles` map to `e-{newElementId}-{7hex}`, set each `styles[].id`, and rewrite
	 * every `classes`-typed envelope's `value[]` in `settings` via the old->new style-id map (EXACT mirror
	 * of styles-ids-modifier.php run(): replace_styles_ids() then replace_references()). The three places a
	 * local-style id lives — the styles map KEY, `styles[].id`, and `settings.classes.value` — stay
	 * consistent (11 §5.1, §8.1). New style ids are reserved in `$taken` so they cannot re-collide.
	 *
	 * @param array<string,mixed> $node       The node (element id already updated to $new_element_id).
	 * @param string              $new_element_id The node's new element id.
	 * @param array<string,bool>  $taken      Live taken-id set (mutated — new style ids reserved).
	 *
	 * @return array<string,mixed>
	 */
	private static function rewrite_local_styles( array $node, string $new_element_id, array &$taken ): array {
		$styles = isset( $node['styles'] ) && is_array( $node['styles'] ) ? $node['styles'] : array();
		if ( empty( $styles ) ) {
			return $node;
		}

		$style_old_to_new = array();
		$new_styles       = array();

		foreach ( $styles as $old_style_id => $style ) {
			$old_style_id = (string) $old_style_id;
			$new_style_id = self::generate_local_style_id( $new_element_id, $taken );

			$taken[ $new_style_id ]            = true;
			$style_old_to_new[ $old_style_id ] = $new_style_id;

			if ( is_array( $style ) ) {
				$style['id'] = $new_style_id; // styles[].id mirrors the map key (style-definition.php).
			}
			$new_styles[ $new_style_id ] = $style;
		}

		$node['styles'] = $new_styles;

		// Rewrite the back-references in settings.classes.value (replace_references()).
		if ( isset( $node['settings'] ) && is_array( $node['settings'] ) ) {
			$node['settings'] = self::rewrite_class_references( $node['settings'], $style_old_to_new );
		}

		return $node;
	}

	/**
	 * Rewrite every `classes`-typed envelope's `value[]` array via an old->new style-id map (mirror
	 * Styles_Ids_Modifier::replace_references). A `classes` envelope is `{$$type:'classes', value:string[]}`.
	 * Unmapped values (global class ids, untouched local ids) pass through unchanged.
	 *
	 * @param array<string,mixed>  $settings        The node settings.
	 * @param array<string,string> $style_old_to_new old-style-id => new-style-id.
	 *
	 * @return array<string,mixed>
	 */
	private static function rewrite_class_references( array $settings, array $style_old_to_new ): array {
		if ( empty( $style_old_to_new ) ) {
			return $settings;
		}

		foreach ( $settings as $key => $value ) {
			if ( ! is_array( $value ) ) {
				continue;
			}
			$is_classes = isset( $value['$$type'] ) && self::CLASSES_PROP_TYPE === $value['$$type'];
			if ( $is_classes && isset( $value['value'] ) && is_array( $value['value'] ) ) {
				$settings[ $key ]['value'] = array_map(
					static function ( $style_id ) use ( $style_old_to_new ) {
						$style_id = (string) $style_id;
						return $style_old_to_new[ $style_id ] ?? $style_id;
					},
					$value['value']
				);
			}
		}

		return $settings;
	}

	/**
	 * Normalize every local-style id to the CSS-safe form Elementor itself emits, so the local-style triple
	 * (styles map KEY === `styles[].id` === `settings.classes.value` entry) stays consistent with the CSS
	 * SELECTOR Elementor renders — the fix for the "large atomic page renders UNSTYLED / `css_primed:false`"
	 * bug (mixed-case local-style ids).
	 *
	 * ROOT CAUSE this closes: Elementor's `Style_Parser::parse()` runs `sanitize_key()` on each style's `id`
	 * (modules/atomic-widgets/parsers/style-parser.php:231-232) BEFORE `Styles_Renderer::get_base_selector()`
	 * emits `.` . (`cssName` ?? `id`). So a style id `heroWrap` is rendered as the selector `.herowrap`. But
	 * the element's rendered `class="..."` attribute comes from `settings.classes.value` (which mirrors the
	 * styles-map KEY) and we persist THAT verbatim — `heroWrap`. Result: `class="heroWrap"` in the HTML vs
	 * `.herowrap` in the primed CSS — a CASE-SENSITIVE mismatch, so the rule never applies and the element is
	 * unstyled. It also trips a (correct) `CSS_PRIME_FAILED`, because the primer asserts `.heroWrap` is present
	 * in the file while only `.herowrap` was written. Elementor mints its own ids all-lowercase
	 * (`e-<elId>-<7hex>`), so this only bites human-readable ids supplied by an authoring path.
	 *
	 * FIX: apply the SAME `sanitize_key()` to the styles-map KEY + `styles[].id` + every `classes`-typed
	 * `value[]` backref BEFORE save, so all four sites (map key, style id, rendered class attribute, CSS
	 * selector) agree. Idempotent for already-canonical ids (Elementor's own `e-…` ids are unchanged), so it
	 * is a safe unconditional pass on every write. Global-class ids referenced in `classes.value` are NOT keys
	 * of any `styles` map, so they never enter the rewrite map and pass through untouched.
	 *
	 * @param array<int,array<string,mixed>> $elements The candidate tree.
	 *
	 * @return array<int,array<string,mixed>> The tree with local-style ids canonicalized.
	 */
	public static function normalize_local_style_ids( array $elements ): array {
		// Pass 1 (tree-wide): collect the canonical form of EVERY local-style map key anywhere in the tree.
		// Tree-wide (not per-node) is REQUIRED because a common authoring pattern DEFINES a local style once
		// (on one element's `styles` map) and REUSES it on many other elements by referencing the class token
		// in `settings.classes.value` WITHOUT re-declaring the `styles` map (Elementor renders the selector
		// globally, so `.card` styles every element carrying that class). Those reuse-by-reference backrefs
		// must be rewritten with the SAME canonical map as the definition, or they diverge from the CSS.
		$old_to_new = array();
		self::collect_local_style_canonical_map( $elements, $old_to_new );

		if ( empty( $old_to_new ) ) {
			return $elements; // Every local-style id is already canonical (e.g. Elementor's own `e-…` ids).
		}

		// Pass 2 (tree-wide): rekey every `styles` map (+ mirror `styles[].id`) and rewrite EVERY
		// `classes.value` backref via the shared map (covers both definers and reuse-by-reference consumers).
		return self::apply_local_style_canonical_map( $elements, $old_to_new );
	}

	/**
	 * Pass 1 of {@see normalize_local_style_ids}: walk the whole tree and record `originalId => sanitize_key()`
	 * for every local-style map key whose canonical form differs from the original. `sanitize_key()` is the
	 * EXACT transform Elementor applies to a style id before rendering its selector (style-parser.php:231-232).
	 *
	 * @param array<int,array<string,mixed>> $elements   The (sub)tree.
	 * @param array<string,string>           $old_to_new Out: original-style-id => canonical-style-id (mutated).
	 *
	 * @return void
	 */
	private static function collect_local_style_canonical_map( array $elements, array &$old_to_new ): void {
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			if ( isset( $node['styles'] ) && is_array( $node['styles'] ) ) {
				foreach ( array_keys( $node['styles'] ) as $style_id ) {
					$style_id  = (string) $style_id;
					$canonical = function_exists( 'sanitize_key' ) ? sanitize_key( $style_id ) : strtolower( $style_id );
					// Never blank out an id (sanitize_key can strip an all-symbol token to ''): keep original.
					if ( '' === $canonical ) {
						$canonical = $style_id;
					}
					if ( $canonical !== $style_id ) {
						$old_to_new[ $style_id ] = $canonical;
					}
				}
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) && ! empty( $node['elements'] ) ) {
				self::collect_local_style_canonical_map( $node['elements'], $old_to_new );
			}
		}
	}

	/**
	 * Pass 2 of {@see normalize_local_style_ids}: rekey each node's `styles` map to the canonical id (mirroring
	 * into `styles[].id`) and rewrite each node's `classes`-typed `value[]` backrefs via the shared `$old_to_new`
	 * map. Entries that are not local-style ids (e.g. global-class ids) are absent from the map and pass through.
	 *
	 * @param array<int,array<string,mixed>> $elements   The (sub)tree.
	 * @param array<string,string>           $old_to_new original-style-id => canonical-style-id.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function apply_local_style_canonical_map( array $elements, array $old_to_new ): array {
		$out = array();
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				$out[] = $node;
				continue;
			}

			if ( isset( $node['styles'] ) && is_array( $node['styles'] ) && ! empty( $node['styles'] ) ) {
				$new_styles = array();
				foreach ( $node['styles'] as $style_id => $style ) {
					$style_id  = (string) $style_id;
					$canonical = $old_to_new[ $style_id ] ?? $style_id;
					if ( is_array( $style ) ) {
						$style['id'] = $canonical; // styles[].id mirrors the map key (style-definition.php).
					}
					// Last write wins on a canonical collision (two ids sanitizing to the same token would
					// also collide inside Elementor); the shared selector is the intended one anyway.
					$new_styles[ $canonical ] = $style;
				}
				$node['styles'] = $new_styles;
			}

			if ( isset( $node['settings'] ) && is_array( $node['settings'] ) ) {
				$node['settings'] = self::rewrite_class_references( $node['settings'], $old_to_new );
			}

			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) && ! empty( $node['elements'] ) ) {
				$node['elements'] = self::apply_local_style_canonical_map( $node['elements'], $old_to_new );
			}

			$out[] = $node;
		}
		return $out;
	}

	/**
	 * Generate a fresh local-style id `e-{elementId}-{7hex}` guaranteed absent from `$taken` (convention
	 * 11 §5.1; mirror Atomic Utils::generate_id("e-{id}-", ...) which is `substr(bin2hex(random_bytes(4)),0,7)`).
	 *
	 * @param string             $element_id The owning element id.
	 * @param array<string,bool> $taken      The live taken-id set.
	 */
	private static function generate_local_style_id( string $element_id, array $taken ): string {
		$prefix = 'e-' . $element_id . '-';
		do {
			$suffix = substr( bin2hex( random_bytes( 4 ) ), 0, 7 );
			$id     = $prefix . $suffix;
		} while ( isset( $taken[ $id ] ) );
		return $id;
	}

	// ------------------------------------------------------------------------------------------------
	// Internal: helpers.
	// ------------------------------------------------------------------------------------------------

	/**
	 * Flatten a tree, collecting element ids + local-style ids (the keys of each node's `styles` map).
	 *
	 * @param array<int,array<string,mixed>> $elements  The tree.
	 * @param string[]                       $ids       Out: element ids (with duplicates, for dup detection).
	 * @param string[]                       $style_ids Out: local-style ids (with duplicates).
	 */
	private static function collect_ids( array $elements, array &$ids, array &$style_ids ): void {
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			if ( isset( $node['id'] ) && is_string( $node['id'] ) && '' !== $node['id'] ) {
				$ids[] = $node['id'];
			}
			if ( isset( $node['styles'] ) && is_array( $node['styles'] ) ) {
				foreach ( array_keys( $node['styles'] ) as $style_id ) {
					$style_ids[] = (string) $style_id;
				}
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) && ! empty( $node['elements'] ) ) {
				self::collect_ids( $node['elements'], $ids, $style_ids );
			}
		}
	}

	/**
	 * Return the values that appear more than once in a list.
	 *
	 * @param string[] $values The id list.
	 *
	 * @return string[]
	 */
	private static function find_duplicates( array $values ): array {
		$counts = array();
		foreach ( $values as $v ) {
			$v            = (string) $v;
			$counts[ $v ] = isset( $counts[ $v ] ) ? $counts[ $v ] + 1 : 1;
		}
		$dups = array();
		foreach ( $counts as $v => $c ) {
			if ( $c > 1 ) {
				$dups[] = (string) $v;
			}
		}
		return $dups;
	}

	/**
	 * Normalize a `{id=>true}` set OR a plain id list into a `{id=>true}` set.
	 *
	 * @param array<string,bool>|string[] $ids Set or list.
	 *
	 * @return array<string,bool>
	 */
	private static function as_set( array $ids ): array {
		// Detect whether this is already an id-keyed set whose values are all boolean true.
		$is_set = true;
		foreach ( $ids as $k => $v ) {
			if ( ! is_string( $k ) || true !== $v ) {
				$is_set = false;
				break;
			}
		}
		if ( $is_set ) {
			return $ids;
		}

		$set = array();
		foreach ( $ids as $id ) {
			if ( is_string( $id ) && '' !== $id ) {
				$set[ $id ] = true;
			}
		}
		return $set;
	}

	/**
	 * Read a post's `_elementor_data` as a decoded array WITHOUT instantiating it (pure read; the ids
	 * routes are CAP_READ, no side effects). Returns null when absent/unreadable.
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array<int,array<string,mixed>>|null
	 */
	private static function read_tree( int $post_id ): ?array {
		if ( $post_id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return null;
		}
		$raw = get_post_meta( $post_id, '_elementor_data', true );
		if ( is_array( $raw ) ) {
			return $raw;
		}
		if ( is_string( $raw ) && '' !== $raw ) {
			$decoded = json_decode( $raw, true );
			return is_array( $decoded ) ? $decoded : null;
		}
		return null;
	}
}
