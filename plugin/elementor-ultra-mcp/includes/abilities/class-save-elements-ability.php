<?php
/**
 * WP-P16 — Save_Elements_Ability: transactionally save an Elementor element tree via the secondary
 * (optional) WP-Abilities path. Delegates to the SAME {@see \Elementor\Ultra\Core\Document_Writer::save()}
 * the REST `POST /documents/{id}` (save) route uses (10-rest-api.md §2.6). CAP_EDIT_POST.
 *
 * Because it routes through `Document_Writer::save`, the ability AUTOMATICALLY inherits the full locked
 * write sequence — is_editable -> lock/autosave check -> base_hash check -> idempotency replay -> backup
 * -> id mint/dedupe -> AUTHORITATIVE validate -> single Document::save -> op-log row -> optional atomic
 * CSS prime (WP-P16 Acceptance: "Save_Elements_Ability goes through Document_Writer (validated, locked,
 * backed up) and primes atomic CSS (S1-gated)"). NO write logic is duplicated.
 *
 * SPIKE-VERIFIED CORRECTIONS (inherited via Document_Writer, do NOT re-implement):
 *  - [S01] An atomic Document::save emits ZERO front-end CSS, so the writer triggers an explicit
 *    Css_Primer prime when `prime_css:true`; this ability passes `prime_css` through so atomic saves are
 *    S1-gated. [S04] page-settings-only patches deep-merge via Document::update_settings (the writer
 *    handles the split). [R5] local-style ids are NOT stable across save — the writer re-reads ids +
 *    base_hash; this ability returns whatever the writer reports.
 *
 * Op-log: the writer already appends one row per save (10 §11) to the SAME store as REST, so the audit
 * trail is unified — this ability does not double-log.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Abilities;

use Elementor\Ultra\Core\Document_Writer;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Transactional save ability mirroring `POST /documents/{id}` (10-rest-api.md §2.6). CAP_EDIT_POST
 * (`edit_post`).
 */
final class Save_Elements_Ability extends Abstract_Ability {

	/** {@inheritDoc} */
	protected function slug(): string {
		return 'save-elements';
	}

	/** {@inheritDoc} */
	protected function label(): string {
		return __( 'Save an Elementor element tree', 'elementor-ultra-mcp' );
	}

	/** {@inheritDoc} */
	protected function description(): string {
		return __(
			'Transactionally saves an Elementor document\'s element tree and/or page settings — validated, locked, backed up, and (for atomic trees) CSS-primed — the same as POST /documents/{id}. Requires base_hash for optimistic concurrency.',
			'elementor-ultra-mcp'
		);
	}

	/**
	 * Input schema mirrors the save request body (10-rest-api.md §2.6).
	 *
	 * @return array<string,mixed>
	 */
	protected function input_schema(): array {
		return array(
			'type'                 => 'object',
			'properties'           => array(
				'id'        => array(
					'type'        => 'integer',
					'description' => __( 'The document (post) id to save.', 'elementor-ultra-mcp' ),
				),
				'elements'  => array(
					'type'        => 'array',
					'description' => __( 'The authoring-contract element tree to persist.', 'elementor-ultra-mcp' ),
				),
				'settings'  => array(
					'type'        => 'object',
					'description' => __( 'Optional page-settings patch (deep-merged).', 'elementor-ultra-mcp' ),
				),
				'base_hash' => array(
					'type'        => 'string',
					'description' => __( 'Optimistic-concurrency token (md5 of the current _elementor_data). Re-read for a fresh one if stale.', 'elementor-ultra-mcp' ),
				),
				'force'     => array(
					'type'        => 'boolean',
					'description' => __( 'Bypass the base_hash/lock checks (override). Use sparingly.', 'elementor-ultra-mcp' ),
					'default'     => false,
				),
				'prime_css' => array(
					'type'        => 'boolean',
					'description' => __( 'Prime atomic CSS in-request after the save (S1). Required for atomic trees to render.', 'elementor-ultra-mcp' ),
					'default'     => false,
				),
				'op_id'     => array(
					'type'        => 'string',
					'description' => __( 'Idempotency / correlation operation id.', 'elementor-ultra-mcp' ),
				),
			),
			'required'             => array( 'id' ),
			'additionalProperties' => false,
		);
	}

	/**
	 * Output schema mirrors the save `data` payload (10-rest-api.md §2.6).
	 *
	 * @return array<string,mixed>
	 */
	protected function output_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'id'                => array( 'type' => 'integer' ),
				'diff'              => array( 'type' => 'object' ),
				'base_hash'         => array( 'type' => 'string' ),
				'preview_url'       => array( 'type' => array( 'string', 'null' ) ),
				'backup_handle'     => array( 'type' => array( 'string', 'null' ) ),
				'css_primed'        => array( 'type' => 'boolean' ),
				'prime_required'    => array( 'type' => 'boolean' ),
				'remapped_ids'      => array( 'type' => 'object' ),
				'idempotent_replay' => array( 'type' => 'boolean' ),
				'op_id'             => array( 'type' => array( 'string', 'null' ) ),
			),
		);
	}

	/** {@inheritDoc} A save mutates the document (additive update; not idempotent across distinct trees). */
	protected function annotations(): array {
		return array(
			'readonly'    => false,
			'destructive' => false,
		);
	}

	/**
	 * CAP_EDIT_POST — `edit_post` (10-rest-api.md §0.3).
	 *
	 * @param mixed $input The ability input; the object `edit_post` cap needs the target `id`.
	 */
	protected function capability( $input ): string {
		return 'edit_post';
	}

	/**
	 * Delegate to the transactional writer (10 §2.6). The writer validates (AUTHORITATIVE), locks,
	 * backs up, saves once, op-logs, and primes atomic CSS when `prime_css` — all inherited, none
	 * re-implemented here. Returns the writer's §2.6 `data` payload or its `WP_Error`.
	 *
	 * @param array<string,mixed> $input The validated input.
	 * @return array<string,mixed>|WP_Error
	 */
	protected function run( array $input ) {
		if ( ! class_exists( '\Elementor\Ultra\Core\Document_Writer' ) ) {
			return new WP_Error(
				'NOT_AVAILABLE',
				__( 'The document writer is unavailable on this site.', 'elementor-ultra-mcp' ),
				array( 'status' => 500 )
			);
		}

		$post_id = isset( $input['id'] ) ? (int) $input['id'] : 0;
		if ( $post_id <= 0 ) {
			return new WP_Error(
				'BAD_REQUEST',
				__( 'A document id is required to save.', 'elementor-ultra-mcp' ),
				array( 'status' => 400 )
			);
		}

		// Build the writer args from the SAME keys the REST save body uses (10 §2.6). The writer owns the
		// validate/lock/backup/save/prime/op-log sequence — single source of truth (WP-P16 #3).
		$args = array();
		if ( isset( $input['elements'] ) && is_array( $input['elements'] ) ) {
			$args['elements'] = $input['elements'];
		}
		if ( isset( $input['settings'] ) && is_array( $input['settings'] ) ) {
			$args['settings'] = $input['settings'];
		}
		if ( isset( $input['base_hash'] ) ) {
			$args['base_hash'] = (string) $input['base_hash'];
		}
		if ( isset( $input['op_id'] ) ) {
			$args['op_id'] = (string) $input['op_id'];
		}
		$args['force']     = ! empty( $input['force'] );
		$args['prime_css'] = ! empty( $input['prime_css'] );

		return Document_Writer::save( $post_id, $args );
	}
}
