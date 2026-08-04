<?php
/**
 * WP-P14 — Ops controller: exposes the paginated `GET /ops/log` write audit trail.
 *
 * Contract authority: 10-rest-api.md §11 (`GET /ops/log` — CAP_MANAGE; query `post_id?`, `user?`,
 * plus `limit/cursor`; response `data` `{items:[{op_id,post_id,user,tool,before_hash,after_hash,
 * result,ts}],next_cursor,total}`), §0.11 (pagination), §0.3 (CAP_MANAGE = `manage_options`).
 *
 * Reads from the shared {@see \Elementor\Ultra\Core\Op_Log} store (the same store every WRITE route
 * appends to). The store is a SOFT dependency: if a build ships without WP-P14's core store this
 * controller still registers and returns an empty page (the route is always present + introspectable).
 *
 * Self-registration: this controller adds itself to the WP-P02 {@see \Elementor\Ultra\Rest\Registrar}
 * via the `elementor_ultra/rest/register` action (so it NEVER edits the spine `Registrar`/`Plugin`
 * files — the parallelism principle). The hook is wired at file load (the SPL autoloader requires the
 * class file when the FQCN is first referenced; the action below fires on `rest_api_init`).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Op_Log;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The OPS REST controller (10-rest-api.md §11). One read route: `GET /ops/log`.
 */
final class Ops_Controller extends Abstract_Controller {

	/**
	 * Register `GET elementor-ultra/v1/ops/log` (CAP_MANAGE, paginated) — 10-rest-api.md §11.
	 *
	 * @return void
	 */
	public function register_routes(): void {
		$this->route(
			'/ops/log',
			WP_REST_Server::READABLE,
			array( $this, 'get_log' ),
			Permissions::can_manage(),
			array(
				'post_id' => array(
					'type'              => 'integer',
					'required'          => false,
					'sanitize_callback' => 'absint',
				),
				'user'    => array(
					'type'              => 'string',
					'required'          => false,
					'sanitize_callback' => 'sanitize_text_field',
				),
				'limit'   => array(
					'type'     => 'integer',
					'required' => false,
					'default'  => 25,
					'minimum'  => 1,
					'maximum'  => 100,
				),
				'cursor'  => array(
					'type'     => 'string',
					'required' => false,
				),
				'fields'  => array(
					'type'     => array( 'array', 'string' ),
					'required' => false,
				),
			)
		);
	}

	/**
	 * `GET /ops/log` handler (10-rest-api.md §11). Reads the op-log store filtered by `post_id`/
	 * `user`, newest first, paginated per §0.11. Returns the §0.11 `{items,next_cursor,total}`
	 * envelope inside the §0.5 `{success,data}` success envelope; each item carries the §11 fields
	 * (`op_id, post_id, user, tool, before_hash, after_hash, result, ts`).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response
	 */
	public function get_log( WP_REST_Request $request ): WP_REST_Response {
		$args   = $this->read_pagination_args( $request );
		$fields = $args['fields'];

		// Soft dependency: when the WP-P14 store is absent (a build without it), degrade to an empty
		// page rather than 500 — the route stays introspectable + the contract envelope intact.
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) ) {
			return $this->ok(
				array(
					'items'       => array(),
					'next_cursor' => null,
					'total'       => 0,
				)
			);
		}

		$post_id = $request->get_param( 'post_id' );
		$user    = $request->get_param( 'user' );

		$result = Op_Log::query(
			array(
				'post_id' => ( null === $post_id || '' === $post_id ) ? null : (int) $post_id,
				'user'    => ( is_string( $user ) && '' !== $user ) ? $user : null,
				'limit'   => $args['limit'],
				'offset'  => $args['offset'],
			)
		);

		// Apply the optional top-level `fields` projection (§0.11) using the shared trait helper.
		if ( ! empty( $fields ) ) {
			$result['items'] = $this->paginate(
				$result['items'],
				$request,
				$result['total'],
				true,
				$result['next_cursor']
			)['items'];
		}

		return $this->ok(
			array(
				'items'       => array_values( $result['items'] ),
				'next_cursor' => $result['next_cursor'],
				'total'       => $result['total'],
			)
		);
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live
 * registrar; we hand it a fresh controller instance so it registers `GET /ops/log` without any edit
 * to the spine `class-registrar.php` / `class-plugin.php`.
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Ops_Controller() );
		}
	}
);
