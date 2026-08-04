<?php
/**
 * WP-P16 — Dry_Run_Ability: AUTHORITATIVE validate + diff (NO persist) via the secondary (optional)
 * WP-Abilities path. Delegates to the SAME {@see \Elementor\Ultra\Validator::dry_run()} the REST
 * `POST /documents/{id}/dry-run` route uses (10-rest-api.md §2.3, §0.9). CAP_EDIT_POST.
 *
 * Because it calls the SAME validator, this ability returns the SAME `DryRunResult` as the REST route
 * (WP-P16 Acceptance: "Dry_Run_Ability returns the SAME DryRunResult as the REST dry-run"). No business
 * logic is duplicated and nothing is persisted (the validator instantiates + parses only).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Abilities;

use Elementor\Ultra\Validator;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Authoritative dry-run ability mirroring `POST /documents/{id}/dry-run` (10-rest-api.md §2.3).
 * CAP_EDIT_POST (`edit_post`).
 */
final class Dry_Run_Ability extends Abstract_Ability {

	/** {@inheritDoc} */
	protected function slug(): string {
		return 'dry-run';
	}

	/** {@inheritDoc} */
	protected function label(): string {
		return __( 'Validate an Elementor element tree (dry-run)', 'elementor-ultra-mcp' );
	}

	/** {@inheritDoc} */
	protected function description(): string {
		return __(
			'Authoritatively validates an Elementor element tree and returns the diff against an optional existing document — the same result as POST /documents/{id}/dry-run. Persists nothing.',
			'elementor-ultra-mcp'
		);
	}

	/**
	 * Input schema mirrors the dry-run request body (10-rest-api.md §2.3). `id` may be 0 to validate a
	 * brand-new tree.
	 *
	 * @return array<string,mixed>
	 */
	protected function input_schema(): array {
		return array(
			'type'                 => 'object',
			'properties'           => array(
				'id'         => array(
					'type'        => 'integer',
					'description' => __( 'Existing document id to diff against, or 0 for a brand-new tree.', 'elementor-ultra-mcp' ),
					'default'     => 0,
				),
				'elements'   => array(
					'type'        => 'array',
					'description' => __( 'The authoring-contract element tree to validate (V4 atomic or V3 classic nodes).', 'elementor-ultra-mcp' ),
				),
				'settings'   => array(
					'type'        => 'object',
					'description' => __( 'Optional page-settings patch (validated structurally).', 'elementor-ultra-mcp' ),
				),
				'generation' => array(
					'type'        => 'string',
					'enum'        => array( 'auto', 'v4', 'v3' ),
					'description' => __( 'Generation hint; the validator detects per-node generation regardless.', 'elementor-ultra-mcp' ),
					'default'     => 'auto',
				),
				'op_id'      => array(
					'type'        => 'string',
					'description' => __( 'Optional operation id for correlation.', 'elementor-ultra-mcp' ),
				),
			),
			'required'             => array( 'elements' ),
			'additionalProperties' => false,
		);
	}

	/**
	 * Output schema mirrors the FROZEN DryRunResult (schemas/diff.schema.json#/$defs/DryRunResult,
	 * 10-rest-api.md §2.3) the validator returns.
	 *
	 * @return array<string,mixed>
	 */
	protected function output_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'valid'               => array( 'type' => 'boolean' ),
				'errors'              => array( 'type' => 'array' ),
				'diff'                => array( 'type' => 'object' ),
				'generation_detected' => array( 'type' => 'string' ),
				'id_collisions'       => array( 'type' => 'array' ),
				'preview_url'         => array( 'type' => array( 'string', 'null' ) ),
			),
		);
	}

	/** {@inheritDoc} Dry-run instantiates + parses only — no environment mutation. */
	protected function annotations(): array {
		return array(
			'readonly'   => true,
			'idempotent' => true,
		);
	}

	/**
	 * CAP_EDIT_POST — `edit_post` (10-rest-api.md §0.3). Falls back to `edit_posts` for id 0.
	 *
	 * @param mixed $input The ability input; the object `edit_post` cap needs the target `id`.
	 */
	protected function capability( $input ): string {
		$id = isset( $input['id'] ) ? (int) $input['id'] : 0;
		return $id > 0 ? 'edit_post' : 'edit_posts';
	}

	/**
	 * Delegate to the AUTHORITATIVE validator (10 §0.9). Returns the SAME DryRunResult the REST route
	 * returns (same `Validator::dry_run` call signature). NEVER persists.
	 *
	 * @param array<string,mixed> $input The validated input.
	 * @return array<string,mixed>|WP_Error
	 */
	protected function run( array $input ) {
		if ( ! class_exists( '\Elementor\Ultra\Validator' ) ) {
			return new WP_Error(
				'NOT_AVAILABLE',
				__( 'The element-tree validator is unavailable on this site.', 'elementor-ultra-mcp' ),
				array( 'status' => 500 )
			);
		}

		$elements = isset( $input['elements'] ) && is_array( $input['elements'] ) ? $input['elements'] : array();
		$settings = isset( $input['settings'] ) && is_array( $input['settings'] ) ? $input['settings'] : array();
		$post_id  = isset( $input['id'] ) ? (int) $input['id'] : 0;
		$hint     = isset( $input['generation'] ) ? (string) $input['generation'] : 'auto';

		// SAME call the REST dry-run controller makes — single source of truth (WP-P16 #3).
		return Validator::dry_run( $elements, $settings, $post_id, $hint );
	}
}
