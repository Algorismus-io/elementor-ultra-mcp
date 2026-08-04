<?php
/**
 * WP-P16 — Capabilities_Ability: report the site capability/experiment probe via the secondary
 * (optional) WP-Abilities path. Delegates to the SAME {@see \Elementor\Ultra\Capabilities::build()}
 * the REST `GET /site/capabilities` route returns (10-rest-api.md §12). CAP_READ.
 *
 * The single most-called probe (RESEARCH.md §8); exposing it on the secondary path lets an in-WordPress
 * MCP client gate experiment/Pro features exactly as the external TS server does — with one source of
 * truth (the F05 builder). The `abilities_adapter_present` flag the builder reports is, by the time this
 * ability can run, necessarily `true` for this client (the ability layer only registers when the
 * secondary path is present), so the payload is self-consistent.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Abilities;

use Elementor\Ultra\Capabilities;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Read-only capabilities ability mirroring `GET /site/capabilities` (10-rest-api.md §12). CAP_READ
 * (`edit_posts`).
 */
final class Capabilities_Ability extends Abstract_Ability {

	/** {@inheritDoc} */
	protected function slug(): string {
		return 'capabilities';
	}

	/** {@inheritDoc} */
	protected function label(): string {
		return __( 'Get Elementor Ultra site capabilities', 'elementor-ultra-mcp' );
	}

	/** {@inheritDoc} */
	protected function description(): string {
		return __(
			'Returns the site capability/experiment/version probe (Elementor + Pro versions, atomic/V4 state, experiments, breakpoints, registered types, caps) — the same payload as GET /site/capabilities. Read-only.',
			'elementor-ultra-mcp'
		);
	}

	/**
	 * No input — the probe takes the current site/user as-is (10-rest-api.md §12).
	 *
	 * @return array<string,mixed>
	 */
	protected function input_schema(): array {
		return array(
			'type'                 => 'object',
			'properties'           => array(),
			'additionalProperties' => false,
		);
	}

	/**
	 * Output schema mirrors the `GET /site/capabilities` `data` payload (10-rest-api.md §12). Kept open
	 * (`additionalProperties` true) so it stays in sync with the F05 builder without re-declaring every
	 * field here.
	 *
	 * @return array<string,mixed>
	 */
	protected function output_schema(): array {
		return array(
			'type'                 => 'object',
			'properties'           => array(
				'elementor_version'         => array( 'type' => array( 'string', 'null' ) ),
				'pro_active'                => array( 'type' => 'boolean' ),
				'atomic_available'          => array( 'type' => 'boolean' ),
				'v4_default'                => array( 'type' => 'boolean' ),
				'experiments'               => array( 'type' => 'object' ),
				'breakpoints'               => array( 'type' => 'array' ),
				'registered_types'          => array( 'type' => 'object' ),
				'abilities_adapter_present' => array( 'type' => 'boolean' ),
				'health'                    => array( 'type' => 'string' ),
			),
			'additionalProperties' => true,
		);
	}

	/** {@inheritDoc} Pure read of site state. */
	protected function annotations(): array {
		return array(
			'readonly'   => true,
			'idempotent' => true,
		);
	}

	/**
	 * CAP_READ — `edit_posts` (10-rest-api.md §0.3).
	 *
	 * @param mixed $input The ability input (unused; the probe is not object-cap gated).
	 */
	protected function capability( $input ): string {
		return 'edit_posts';
	}

	/**
	 * Delegate to the AUTHORITATIVE F05 capabilities builder (10 §12). SAME payload the REST route
	 * returns under `data` — single source of truth (WP-P16 #3).
	 *
	 * @param array<string,mixed> $input Unused (no input).
	 * @return array<string,mixed>|WP_Error
	 */
	protected function run( array $input ) {
		unset( $input );

		if ( ! class_exists( '\Elementor\Ultra\Capabilities' ) ) {
			return new WP_Error(
				'NOT_AVAILABLE',
				__( 'The capabilities builder is unavailable on this site.', 'elementor-ultra-mcp' ),
				array( 'status' => 500 )
			);
		}

		return Capabilities::build();
	}
}
