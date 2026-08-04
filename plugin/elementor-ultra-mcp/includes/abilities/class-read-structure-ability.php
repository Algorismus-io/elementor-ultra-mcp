<?php
/**
 * WP-P16 — Read_Structure_Ability: read a document's element tree + base_hash via the secondary
 * (optional) WP-Abilities path. Delegates to the SAME read path as `GET /documents/{id}`
 * (10-rest-api.md §2.4). CAP_READ.
 *
 * The ability reads the document the way the REST read route does (10 §2.4): decode `_elementor_data`
 * for `elements`, read `_elementor_page_settings` for `settings`, and compute
 * `base_hash = md5(_elementor_data)` (§0.8). These are pure meta reads + the documented hash formula —
 * NO business logic is duplicated and nothing is persisted.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Abilities;

use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Read-only ability mirroring `GET /documents/{id}` (10-rest-api.md §2.4). CAP_READ (`edit_posts`).
 */
final class Read_Structure_Ability extends Abstract_Ability {

	/** {@inheritDoc} */
	protected function slug(): string {
		return 'read-structure';
	}

	/** {@inheritDoc} */
	protected function label(): string {
		return __( 'Read Elementor document structure', 'elementor-ultra-mcp' );
	}

	/** {@inheritDoc} */
	protected function description(): string {
		return __(
			'Returns an Elementor document\'s element tree, page settings, base_hash, and generation — the same payload as GET /documents/{id}. Read-only; persists nothing.',
			'elementor-ultra-mcp'
		);
	}

	/**
	 * Input schema mirrors the `GET /documents/{id}` path + query params (10-rest-api.md §2.4).
	 *
	 * @return array<string,mixed>
	 */
	protected function input_schema(): array {
		return array(
			'type'                 => 'object',
			'properties'           => array(
				'id'         => array(
					'type'        => 'integer',
					'description' => __( 'The document (post) id to read.', 'elementor-ultra-mcp' ),
				),
				'subtree_id' => array(
					'type'        => 'string',
					'description' => __( 'Return only the subtree rooted at this element id.', 'elementor-ultra-mcp' ),
				),
			),
			'required'             => array( 'id' ),
			'additionalProperties' => false,
		);
	}

	/**
	 * Output schema mirrors the `GET /documents/{id}` `data` payload (10-rest-api.md §2.4).
	 *
	 * @return array<string,mixed>
	 */
	protected function output_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'id'         => array( 'type' => 'integer' ),
				'elements'   => array( 'type' => 'array' ),
				'settings'   => array( 'type' => 'object' ),
				'base_hash'  => array( 'type' => 'string' ),
				'generation' => array( 'type' => 'string' ),
				'type'       => array( 'type' => 'string' ),
			),
		);
	}

	/** {@inheritDoc} Read = no environment mutation. */
	protected function annotations(): array {
		return array( 'readonly' => true );
	}

	/**
	 * CAP_READ — `edit_posts` (10-rest-api.md §0.3).
	 *
	 * @param mixed $input The ability input (unused; read is not object-cap gated).
	 */
	protected function capability( $input ): string {
		return 'edit_posts';
	}

	/**
	 * Read the document tree + base_hash exactly as `GET /documents/{id}` does (10 §2.4): decode
	 * `_elementor_data`, read `_elementor_page_settings`, compute `md5(_elementor_data)` (§0.8).
	 *
	 * @param array<string,mixed> $input The validated input (`{ id, subtree_id? }`).
	 * @return array<string,mixed>|WP_Error
	 */
	protected function run( array $input ) {
		$post_id = isset( $input['id'] ) ? (int) $input['id'] : 0;
		if ( $post_id <= 0 || ! get_post( $post_id ) ) {
			return new WP_Error(
				'NOT_FOUND',
				__( 'Document not found.', 'elementor-ultra-mcp' ),
				array(
					'status' => 404,
					'meta'   => array( 'post_id' => $post_id ),
				)
			);
		}

		$raw       = get_post_meta( $post_id, '_elementor_data', true );
		$raw_str   = is_string( $raw ) ? $raw : (string) wp_json_encode( is_array( $raw ) ? $raw : array() );
		$elements  = is_array( $raw ) ? $raw : ( is_string( $raw ) && '' !== $raw ? json_decode( $raw, true ) : array() );
		$elements  = is_array( $elements ) ? $elements : array();
		$base_hash = md5( $raw_str ); // 10 §0.8: base_hash = md5(_elementor_data).

		$settings = get_post_meta( $post_id, '_elementor_page_settings', true );
		$settings = is_array( $settings ) ? $settings : array();

		$subtree_id = isset( $input['subtree_id'] ) ? (string) $input['subtree_id'] : '';
		if ( '' !== $subtree_id ) {
			$found    = $this->find_subtree( $elements, $subtree_id );
			$elements = ( null === $found ) ? array() : array( $found );
		}

		return array(
			'id'         => $post_id,
			'elements'   => $elements,
			'settings'   => $settings,
			'base_hash'  => $base_hash,
			'generation' => $this->detect_generation( $elements ),
			'type'       => (string) get_post_meta( $post_id, '_elementor_template_type', true ),
		);
	}

	/**
	 * Depth-first search for the node whose `id` matches `$subtree_id` (10 §2.4 `subtree_id`). Returns
	 * the matching node (with its children) or null.
	 *
	 * @param array<int,array<string,mixed>> $nodes      The element nodes to search.
	 * @param string                         $subtree_id The element id to find.
	 * @return array<string,mixed>|null
	 */
	private function find_subtree( array $nodes, string $subtree_id ): ?array {
		foreach ( $nodes as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			if ( isset( $node['id'] ) && (string) $node['id'] === $subtree_id ) {
				return $node;
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$found = $this->find_subtree( $node['elements'], $subtree_id );
				if ( null !== $found ) {
					return $found;
				}
			}
		}
		return null;
	}

	/**
	 * The dominant node generation (`v4` when any node carries an atomic `version`/atomic widget type,
	 * else `v3`) — best-effort, mirroring the §2.4 `generation` field. Defers the authoritative
	 * per-node detection to the Validator on writes; this read-side hint stays cheap + dependency-free.
	 *
	 * @param array<int,array<string,mixed>> $elements The element tree.
	 */
	private function detect_generation( array $elements ): string {
		foreach ( $elements as $node ) {
			if ( is_array( $node ) && isset( $node['version'] ) ) {
				return 'v4';
			}
		}
		return empty( $elements ) ? 'v4' : 'v3';
	}
}
