<?php
/**
 * WP-P03 — Diff_Builder: the structured by-id tree diff returned inside a `DryRunResult`.
 *
 * Contract authority: 12-error-taxonomy.md / schemas/diff.schema.json#/$defs/Diff (the FROZEN diff
 * shape); 10-rest-api.md §2.3 (dry-run route payload). Flattens a `before` and `after` element tree to
 * `{id => node}` maps and computes `changes[]` + `new_ids` / `changed_ids` / `removed_ids`. When
 * `before` is null EVERY node is `added` (a fresh document / post_id==0). Pure, read-only, allocation
 * only — instantiates nothing and touches no Elementor APIs (the validator owns instantiation; the diff
 * is a structural set/JSON comparison so it can never throw on Elementor-version drift, P03 notes #d).
 *
 * The output validates against schemas/diff.schema.json#/$defs/Diff: `changes[]` (NodeChange), plus the
 * `new_ids` / `changed_ids` / `removed_ids` id lists. `moved` is detected when a node keeps its id but
 * changes parent or sibling index; `modified` is a same-parent content change with `changed_paths`.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Builds the FROZEN structured tree diff (schemas/diff.schema.json#/$defs/Diff).
 */
final class Diff_Builder {

	/**
	 * Build the `diff` block for a `DryRunResult`. A null `$before_elements` means there is no prior
	 * document (post_id==0) so every node in `$after_elements` is `added` and appears in `new_ids`.
	 *
	 * @param array<int,array<string,mixed>>|null $before_elements The prior tree (null ⇒ everything new).
	 * @param array<int,array<string,mixed>>      $after_elements  The candidate tree.
	 *
	 * @return array{changes:array<int,array<string,mixed>>,new_ids:string[],changed_ids:string[],removed_ids:string[]}
	 */
	public static function build( ?array $before_elements, array $after_elements ): array {
		$before_map = ( null === $before_elements ) ? array() : self::flatten( $before_elements );
		$after_map  = self::flatten( $after_elements );

		$changes     = array();
		$new_ids     = array();
		$changed_ids = array();
		$removed_ids = array();

		// Added + modified + moved (walk the candidate tree).
		foreach ( $after_map as $id => $after_entry ) {
			$after_node = $after_entry['node'];

			if ( ! array_key_exists( $id, $before_map ) ) {
				$new_ids[] = $id;
				$changes[] = self::pack(
					$id,
					'added',
					$after_node,
					array(
						'after'     => $after_node,
						'to_parent' => $after_entry['parent'],
						'to_index'  => $after_entry['index'],
					)
				);
				continue;
			}

			$before_entry = $before_map[ $id ];
			$before_node  = $before_entry['node'];

			$moved    = ( $before_entry['parent'] !== $after_entry['parent'] )
				|| ( $before_entry['index'] !== $after_entry['index'] );
			$modified = self::node_content_differs( $before_node, $after_node );

			if ( $modified ) {
				$changed_ids[] = $id;
				$changes[]     = self::pack(
					$id,
					'modified',
					$after_node,
					array(
						'before'        => $before_node,
						'after'         => $after_node,
						'changed_paths' => self::changed_paths( $before_node, $after_node ),
					)
				);
			} elseif ( $moved ) {
				// A pure relocation (id + content stable, position changed).
				$changes[] = self::pack(
					$id,
					'moved',
					$after_node,
					array(
						'from_parent' => $before_entry['parent'],
						'to_parent'   => $after_entry['parent'],
						'from_index'  => $before_entry['index'],
						'to_index'    => $after_entry['index'],
					)
				);
			}
		}

		// Removed (in before, gone from after).
		foreach ( $before_map as $id => $before_entry ) {
			if ( ! array_key_exists( $id, $after_map ) ) {
				$removed_ids[] = $id;
				$changes[]     = self::pack(
					$id,
					'removed',
					$before_entry['node'],
					array(
						'before'      => $before_entry['node'],
						'from_parent' => $before_entry['parent'],
						'from_index'  => $before_entry['index'],
					)
				);
			}
		}

		return array(
			'changes'     => $changes,
			'new_ids'     => array_values( $new_ids ),
			'changed_ids' => array_values( $changed_ids ),
			'removed_ids' => array_values( $removed_ids ),
		);
	}

	/**
	 * Assemble one NodeChange (schemas/diff.schema.json#/$defs/NodeChange). `elType`/`widgetType` are
	 * lifted onto the change for cheap client-side display; position/snapshot fields come from `$extra`.
	 *
	 * @param string              $id    Node id.
	 * @param string              $op    One of added|removed|modified|moved.
	 * @param array<string,mixed> $node  The node (for elType/widgetType lift).
	 * @param array<string,mixed> $extra Op-specific fields (before/after/changed_paths/parents/indices).
	 *
	 * @return array<string,mixed>
	 */
	private static function pack( string $id, string $op, array $node, array $extra ): array {
		$change = array(
			'id' => $id,
			'op' => $op,
		);

		if ( isset( $node['elType'] ) && is_string( $node['elType'] ) ) {
			$change['elType'] = $node['elType'];
		}
		if ( isset( $node['widgetType'] ) && is_string( $node['widgetType'] ) ) {
			$change['widgetType'] = $node['widgetType'];
		}

		foreach ( $extra as $key => $value ) {
			if ( null === $value && in_array( $key, array( 'from_parent', 'to_parent' ), true ) ) {
				// Root-level nodes have a null parent; omit the optional pointer rather than emit null
				// (NodeChange.from_parent/to_parent are ElementId strings — additionalProperties:false).
				continue;
			}
			$change[ $key ] = $value;
		}

		return $change;
	}

	/**
	 * Flatten a tree to `{id => {node, parent, index}}`. `node` is a shallow copy WITHOUT its `elements`
	 * child array (so content comparison ignores structure — structure is captured by parent/index). A
	 * malformed entry without a string `id` is skipped (the validator separately reports R1/VALIDATION_FAILED).
	 *
	 * @param array<int,array<string,mixed>> $elements Tree (array of nodes).
	 * @param string|null                    $parent   Parent node id (null at root).
	 *
	 * @return array<string,array{node:array<string,mixed>,parent:?string,index:int}>
	 */
	private static function flatten( array $elements, ?string $parent = null ): array {
		$map = array();
		$i   = 0;
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				++$i;
				continue;
			}
			$id = isset( $node['id'] ) && is_string( $node['id'] ) ? $node['id'] : null;

			$children = isset( $node['elements'] ) && is_array( $node['elements'] ) ? $node['elements'] : array();

			if ( null !== $id ) {
				$shallow = $node;
				unset( $shallow['elements'] );
				// First occurrence wins for the snapshot; duplicates are reported by the validator
				// (DUPLICATE_ELEMENT_ID) — the diff just needs one entry per id.
				if ( ! array_key_exists( $id, $map ) ) {
					$map[ $id ] = array(
						'node'   => $shallow,
						'parent' => $parent,
						'index'  => $i,
					);
				}
			}

			if ( ! empty( $children ) ) {
				$map = $map + self::flatten( $children, $id );
			}
			++$i;
		}
		return $map;
	}

	/**
	 * Whether two node snapshots (already stripped of `elements`) differ in content. A normalized
	 * canonical JSON comparison: key-order-insensitive (recursively ksort'd) so a re-serialization with
	 * different key order is NOT a spurious change.
	 *
	 * @param array<string,mixed> $a Before snapshot.
	 * @param array<string,mixed> $b After snapshot.
	 */
	private static function node_content_differs( array $a, array $b ): bool {
		return self::canonical( $a ) !== self::canonical( $b );
	}

	/**
	 * The top-level dotted paths that changed between two node snapshots (NodeChange.changed_paths). A
	 * shallow, agent-readable list (`settings.title`, `styles.<id>`, `widgetType`) — deep prop paths are
	 * out of scope for the dry-run diff (the validator already pinpoints invalid props by element/style id).
	 *
	 * @param array<string,mixed> $before Before snapshot.
	 * @param array<string,mixed> $after  After snapshot.
	 *
	 * @return string[]
	 */
	private static function changed_paths( array $before, array $after ): array {
		$paths = array();
		$keys  = array_unique( array_merge( array_keys( $before ), array_keys( $after ) ) );

		foreach ( $keys as $key ) {
			if ( 'id' === $key ) {
				continue;
			}
			$b = $before[ $key ] ?? null;
			$a = $after[ $key ] ?? null;

			if ( self::canonical( $b ) === self::canonical( $a ) ) {
				continue;
			}

			// One level deeper for the settings / styles maps so the agent sees which prop / style changed.
			if ( in_array( $key, array( 'settings', 'styles' ), true ) && is_array( $b ) && is_array( $a ) ) {
				$sub = array_unique( array_merge( array_keys( $b ), array_keys( $a ) ) );
				foreach ( $sub as $sub_key ) {
					if ( self::canonical( $b[ $sub_key ] ?? null ) !== self::canonical( $a[ $sub_key ] ?? null ) ) {
						$paths[] = $key . '.' . $sub_key;
					}
				}
				continue;
			}

			$paths[] = (string) $key;
		}

		return array_values( array_unique( $paths ) );
	}

	/**
	 * A deterministic, key-order-insensitive serialization used for equality. Arrays are recursively
	 * ksort'd before encoding so `{a:1,b:2}` and `{b:2,a:1}` compare equal.
	 *
	 * @param mixed $value Any JSON-able value.
	 */
	private static function canonical( $value ): string {
		$normalized = self::ksort_recursive( $value );
		$json       = wp_json_encode( $normalized );
		return is_string( $json ) ? $json : '';
	}

	/**
	 * Recursively ksort an array (associative maps only — list arrays keep order, which IS significant for
	 * variants/elements/etc.).
	 *
	 * @param mixed $value Any value.
	 *
	 * @return mixed
	 */
	private static function ksort_recursive( $value ) {
		if ( ! is_array( $value ) ) {
			return $value;
		}

		$is_list = array_keys( $value ) === range( 0, count( $value ) - 1 );

		$out = array();
		foreach ( $value as $k => $v ) {
			$out[ $k ] = self::ksort_recursive( $v );
		}

		if ( ! $is_list ) {
			ksort( $out );
		}

		return $out;
	}
}
