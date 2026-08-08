<?php
/**
 * WP-P08 — Design controller (global classes): list, the NORMATIVE diff-PUT, and usage.
 *
 * Contract authority: 10-rest-api.md §4.1 (`GET /design/classes`), §4.2 (`PUT /design/classes` —
 * NORMATIVE diff-PUT), §4.3 (`GET /design/classes/usage`), §0.3 (CAP_READ / CAP_UPDATE_CLASS /
 * CAP_MANAGE), §0.5/§0.6 (envelopes), §0.11 (pagination), §0.12 (cache flush);
 * 11-authoring-contract.md §5/§5.1/§7 (style objects + class-name rules);
 * 12-error-taxonomy.md §3.3/§3.4.
 *
 * Three routes:
 *  - `GET  /design/classes`        CAP_READ         — `{items,order,next_cursor,total}` (FULL order always).
 *  - `PUT  /design/classes`        CAP_UPDATE_CLASS — diff-PUT upsert/delete/reorder → `{ok,modified_labels,order,total}`.
 *  - `GET  /design/classes/usage`  CAP_MANAGE       — `{usage:{id:{total,pages:[{post_id,count}]}}}`.
 *
 * All read/write logic lives in {@see \Elementor\Ultra\Core\Global_Classes_Service} (so WP-P09's
 * `design/deploy` reuses `apply_diff`/`preflight_budget` without duplication). The controller owns ONLY
 * the route schemas, the cap gates, the cache flush + the op-log row.
 *
 * SPIKE-VERIFIED CORRECTIONS:
 *  - [S05] Write gate = literal `elementor_global_classes_update_class` via {@see Permissions::can_update_class}
 *    (a missing cap returns OUR 403 `CAPABILITY_MISSING` with an actionable message). GET reads stay open
 *    behind CAP_READ / CAP_MANAGE.
 *  - [S07/C6/R2] After EVERY successful write the controller flushes CSS in-process via
 *    {@see \Elementor\Ultra\Core\Cache_Service::flush_design_system()} (which empties the whole CSS dir and
 *    asserts it). A non-owner-uid flush is reported as a warning — the write already succeeded.
 *  - [S02/R6] A diff that DELETES a class is a GLOBAL mutation: Elementor's `Global_Classes_Cleanup`
 *    rewrites every document's `_elementor_data`. The full design-system flush (which empties the entire
 *    CSS dir) is the mitigation; the controller additionally best-effort re-primes the documents that used
 *    a deleted class (from the usage map) when {@see Css_Primer} is available.
 *
 * Self-registers with the WP-P02 {@see Registrar} via the `elementor_ultra/rest/register` action — it
 * NEVER edits the spine `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Cache_Service;
use Elementor\Ultra\Core\Global_Classes_Service;
use Elementor\Ultra\Error_Codes;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The global-class design REST controller (10-rest-api.md §4.1–§4.3).
 */
final class Design_Classes_Controller extends Abstract_Controller {

	/** Op-log route label for the diff-PUT (mapped to `tool` in the audit trail). */
	const OP_ROUTE = 'design/classes';

	/** Cap-by-the-route: gives the 403 message the exact slug to surface (Contract 12 §3.4). */
	const UPDATE_CLASS_CAP = 'elementor_global_classes_update_class';

	/**
	 * Register the three §4.1–§4.3 routes (each declares its own `args` schema + `permission_callback`).
	 *
	 * @return void
	 */
	public function register_routes(): void {
		// GET /design/classes — list (CAP_READ).
		$this->route(
			'/design/classes',
			WP_REST_Server::READABLE,
			array( $this, 'get_classes' ),
			Permissions::can_read(),
			array(
				'context' => $this->context_arg(),
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

		// PUT /design/classes — diff-PUT (CAP_UPDATE_CLASS).
		$this->route(
			'/design/classes',
			WP_REST_Server::EDITABLE, // POST|PUT|PATCH — clients send PUT (Contract 10 §4.2).
			array( $this, 'put_classes' ),
			Permissions::can_update_class(),
			array(
				'context' => $this->context_arg(),
				'changes' => array(
					'type'        => 'object',
					'required'    => true,
					'description' => 'Diff descriptor: which ids were added/deleted/modified and whether order changed.',
				),
				'items'   => array(
					'type'        => 'object',
					'required'    => false,
					'default'     => array(),
					'description' => 'Touched-only style objects keyed by id (added ∪ modified).',
				),
				'order'   => array(
					'type'        => 'array',
					'required'    => true,
					'description' => 'The FULL final id order (existing − deleted + added).',
				),
				'op_id'   => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);

		// GET /design/classes/usage — usage (CAP_MANAGE).
		$this->route(
			'/design/classes/usage',
			WP_REST_Server::READABLE,
			array( $this, 'get_usage' ),
			Permissions::can_manage(),
			array(
				'context' => $this->context_arg(),
			)
		);
	}

	/**
	 * `GET /design/classes` (Contract 10 §4.1). Returns `{items,order,next_cursor,total}`. `items` is
	 * paginated per §0.11 but `order` is ALWAYS the FULL current order array (a paged client still needs
	 * every id to build a valid diff-PUT). `context` selects frontend vs preview variant data.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_classes( WP_REST_Request $request ) {
		$context = $this->read_context( $request );

		$listed = $this->service()->list( $context );
		if ( $listed instanceof WP_Error ) {
			return $listed;
		}

		$items_map  = $listed['items'];
		$full_order = $listed['order'];

		// Build a stable, ordered list of item objects (in `order` sequence) for pagination.
		$ordered_items = array();
		foreach ( $full_order as $id ) {
			$id = (string) $id;
			if ( isset( $items_map[ $id ] ) ) {
				$ordered_items[] = $items_map[ $id ];
			}
		}
		// Append any items not present in `order` (defensive; keeps every item reachable).
		foreach ( $items_map as $id => $item ) {
			if ( ! in_array( (string) $id, array_map( 'strval', $full_order ), true ) ) {
				$ordered_items[] = $item;
			}
		}

		$total = count( $ordered_items );
		$page  = $this->paginate( $ordered_items, $request, $total );

		return $this->ok(
			array(
				'items'       => $page['items'],
				'order'       => array_values( $full_order ), // ALWAYS the full order (§4.1).
				'next_cursor' => $page['next_cursor'],
				'total'       => $page['total'],
			)
		);
	}

	/**
	 * `PUT /design/classes` — the NORMATIVE diff-PUT (Contract 10 §4.2). Reads + validates the EXACT
	 * body, delegates the budget/order/variant/duplicate-label logic to the service, applies the diff via
	 * the repository, flushes the design-system cache, and (on a delete) re-primes affected documents.
	 * Returns `{ok,modified_labels,order,total}` — a non-empty `modified_labels` is a 200 SOFT outcome.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function put_classes( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		// `changes` is REQUIRED and must be an object carrying the diff descriptor (Contract 10 §4.2).
		$changes = $request->get_param( 'changes' );
		if ( ! is_array( $changes ) ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'changes is required and must be an object {added[],deleted[],modified[],order:bool}.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'changes' ),
				array(),
				$op_id
			);
		}

		$order = $request->get_param( 'order' );
		if ( ! is_array( $order ) ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'order is required and must be the full final id array.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'order' ),
				array(),
				$op_id
			);
		}

		$items = $request->get_param( 'items' );
		$items = is_array( $items ) ? $items : array();

		$body = array(
			'context' => $this->read_context( $request ),
			'changes' => $changes,
			'items'   => $items,
			'order'   => $order,
			'op_id'   => $op_id,
		);

		$result = $this->service()->apply_diff( $body );
		if ( $result instanceof WP_Error ) {
			// Echo op_id into the error envelope so the agent can correlate (§0.8).
			return $this->attach_op_id( $result, $op_id );
		}

		// Cache flush AFTER apply (Contract 10 §0.12; [S07/C6/R2]). The full design-system flush empties
		// the entire CSS dir and asserts it — satisfying the [S02/R6] "full flush" requirement for deletes.
		$warnings    = array();
		$deleted_ids = isset( $result['meta']['deleted_ids'] ) && is_array( $result['meta']['deleted_ids'] )
			? $result['meta']['deleted_ids']
			: array();

		$flushed = $this->flush_design_system();
		if ( false === $flushed ) {
			$warnings[] = 'Design-system CSS flush did not confirm the CSS dir is empty (uid mismatch?). The classes were written; CSS may regenerate on next visit (S07/R2).';
		}

		// [S02/R6] GENERALIZED (field root-cause 2026-08-08): the flush above empties the WHOLE css dir,
		// and Elementor's own invalidation additionally deletes the global css of every page using a
		// touched class — so re-priming only DELETED-class documents left every added/modified-class
		// page unstyled until someone visited it (the "css keeps fucking up" mystery: a partial deploy
		// or standalone classes write reliably unstyled all clean-skipped pages). Re-prime the
		// documents affected by EVERY touched class (added + modified + deleted).
		$touched = array_values( array_unique( array_merge(
			$deleted_ids,
			isset( $body['changes']['added'] ) && is_array( $body['changes']['added'] ) ? $body['changes']['added'] : array(),
			isset( $body['changes']['modified'] ) && is_array( $body['changes']['modified'] ) ? $body['changes']['modified'] : array()
		) ) );
		if ( ! empty( $touched ) ) {
			$warnings = array_merge( $warnings, $this->reprime_documents_for_deleted_classes( $touched ) );
		}

		// Op-log row (best-effort; never fails the write — WP-P14 store guarded).
		$this->record_op( $op_id, $request, $result );

		$data = array(
			'ok'              => true,
			'modified_labels' => (object) $result['modified_labels'], // {} when no rename (object, not []).
			'order'           => array_values( $result['order'] ),
			'total'           => (int) $result['total'],
		);

		if ( ! empty( $warnings ) ) {
			$data['warnings'] = array_values( $warnings );
		}

		return $this->ok( $data );
	}

	/**
	 * `GET /design/classes/usage` (Contract 10 §4.3). Returns `{usage:{id:{total,pages:[{post_id,count}]}}}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_usage( WP_REST_Request $request ) {
		$context = $this->read_context( $request );

		$usage = $this->service()->usage( $context );
		if ( $usage instanceof WP_Error ) {
			return $usage;
		}

		return $this->ok(
			array(
				// Force an object even when empty so the wire shape is `{}` not `[]`.
				'usage' => (object) $usage['usage'],
			)
		);
	}

	// ---------------------------------------------------------------------
	// Internals.
	// ---------------------------------------------------------------------

	/** The global-classes service (single home of the diff/budget/order logic). */
	private function service(): Global_Classes_Service {
		return new Global_Classes_Service();
	}

	/** The shared cache service (used for the post-write design-system flush). */
	private function cache(): Cache_Service {
		return new Cache_Service();
	}

	/**
	 * Run the post-write full design-system flush (Contract 10 §0.12; [S07/C6/R2]). Returns the
	 * assertion result (true = CSS dir confirmed empty) or false when the service is unavailable.
	 *
	 * @return bool
	 */
	private function flush_design_system(): bool {
		if ( ! class_exists( '\Elementor\Ultra\Core\Cache_Service' ) ) {
			return false;
		}
		try {
			return $this->cache()->flush_design_system();
		} catch ( \Throwable $e ) {
			unset( $e );
			return false;
		}
	}

	/**
	 * Best-effort re-prime the documents that USED a now-deleted global class ([S02/R6]). Deleting a kit
	 * class fires `Global_Classes_Cleanup` which rewrites those documents' `_elementor_data`; the full
	 * CSS flush already cleared their cached CSS, so re-priming rebuilds their atomic CSS proactively
	 * rather than on first visit. Targeted (only the pages from the usage map) so it stays cheap, and
	 * fully guarded — a missing primer / usage source is a no-op warning, never a failure.
	 *
	 * @param string[] $deleted_ids The deleted class ids.
	 * @return string[] Warnings (empty on full success).
	 */
	private function reprime_documents_for_deleted_classes( array $deleted_ids ): array {
		if ( ! class_exists( '\Elementor\Ultra\Core\Css_Primer' ) ) {
			return array( 'A class was deleted; affected documents were not re-primed (Css_Primer unavailable). They will re-render on next visit (R6).' );
		}

		// Resolve the documents that used the deleted classes BEFORE the delete (the usage map was just
		// captured for those ids). The flush already cleared CSS; re-priming is the proactive rebuild.
		$post_ids = $this->post_ids_using_classes( $deleted_ids );
		if ( empty( $post_ids ) ) {
			return array();
		}

		$warnings = array();
		try {
			$primer = new \Elementor\Ultra\Core\Css_Primer();
		} catch ( \Throwable $e ) {
			return array( 'A class was deleted; re-prime skipped (Css_Primer could not be constructed): ' . $e->getMessage() );
		}

		foreach ( $post_ids as $post_id ) {
			try {
				$primer->prime( (int) $post_id );
			} catch ( \Throwable $e ) {
				$warnings[] = sprintf( 'Re-prime of document %d after class deletion failed: %s', (int) $post_id, $e->getMessage() );
			}
		}

		return $warnings;
	}

	/**
	 * Collect the post ids that reference any of the given class ids, from the service usage map. Capped
	 * defensively so a pathological usage map cannot turn a delete into an unbounded prime storm.
	 *
	 * @param string[] $class_ids Class ids to resolve usage for.
	 * @return int[] Unique post ids (capped).
	 */
	private function post_ids_using_classes( array $class_ids ): array {
		$usage = $this->service()->usage( Global_Classes_Service::CONTEXT_FRONTEND );
		if ( $usage instanceof WP_Error || ! isset( $usage['usage'] ) || ! is_array( $usage['usage'] ) ) {
			return array();
		}

		$wanted   = array_fill_keys( array_map( 'strval', $class_ids ), true );
		$post_ids = array();
		foreach ( $usage['usage'] as $class_id => $info ) {
			if ( ! isset( $wanted[ (string) $class_id ] ) ) {
				continue;
			}
			$pages = isset( $info['pages'] ) && is_array( $info['pages'] ) ? $info['pages'] : array();
			foreach ( $pages as $page ) {
				$pid = isset( $page['post_id'] ) ? (int) $page['post_id'] : 0;
				if ( $pid > 0 ) {
					$post_ids[ $pid ] = true;
				}
			}
		}

		// Cap to a sane batch so a delete never primes hundreds of docs in one request.
		return array_slice( array_keys( $post_ids ), 0, 100 );
	}

	/**
	 * Record the diff-PUT in the WP-P14 op-log store (best-effort; a logging fault NEVER fails the write).
	 *
	 * @param string|null         $op_id   The request op_id.
	 * @param WP_REST_Request     $request The current request (for the acting user).
	 * @param array<string,mixed> $result The service result (for the after-state summary).
	 * @return void
	 */
	private function record_op( ?string $op_id, WP_REST_Request $request, array $result ): void {
		unset( $request ); // Acting user resolved by Op_Log from the current user.
		if ( null === $op_id ) {
			return;
		}
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		try {
			\Elementor\Ultra\Core\Op_Log::record(
				array(
					'op_id'  => $op_id,
					'route'  => self::OP_ROUTE,
					'result' => 'ok',
					'meta'   => array(
						'total'           => isset( $result['total'] ) ? (int) $result['total'] : null,
						'modified_labels' => isset( $result['modified_labels'] ) ? array_keys( (array) $result['modified_labels'] ) : array(),
					),
				)
			);
		} catch ( \Throwable $e ) {
			unset( $e ); // Op-log is best-effort.
		}
	}

	/**
	 * The shared `context` arg schema (`frontend`|`preview`, default `frontend`) — Contract 10 §4.1/§4.2.
	 *
	 * @return array<string,mixed>
	 */
	private function context_arg(): array {
		return array(
			'type'     => 'string',
			'required' => false,
			'default'  => Global_Classes_Service::CONTEXT_FRONTEND,
			'enum'     => array(
				Global_Classes_Service::CONTEXT_FRONTEND,
				Global_Classes_Service::CONTEXT_PREVIEW,
			),
		);
	}

	/**
	 * Read + normalize the `context` request param to `frontend`|`preview`.
	 *
	 * @param WP_REST_Request $request The current request.
	 */
	private function read_context( WP_REST_Request $request ): string {
		$context = $request->get_param( 'context' );
		$context = is_string( $context ) ? $context : Global_Classes_Service::CONTEXT_FRONTEND;
		return Global_Classes_Service::CONTEXT_PREVIEW === $context
			? Global_Classes_Service::CONTEXT_PREVIEW
			: Global_Classes_Service::CONTEXT_FRONTEND;
	}

	/**
	 * Echo the request `op_id` into an error envelope's `data` block (§0.8) so the agent can correlate
	 * the failure with its request.
	 *
	 * @param WP_Error    $error The taxonomy error.
	 * @param string|null $op_id The request op_id.
	 */
	private function attach_op_id( WP_Error $error, ?string $op_id ): WP_Error {
		if ( null === $op_id ) {
			return $error;
		}
		$data = $error->get_error_data();
		$data = is_array( $data ) ? $data : array();
		if ( ! isset( $data['op_id'] ) ) {
			$data['op_id'] = $op_id;
			$error->add_data( $data );
		}
		return $error;
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar;
 * we hand it a fresh controller instance so it registers the three §4.1–§4.3 routes WITHOUT editing the
 * spine `class-registrar.php` / `class-plugin.php`.
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Design_Classes_Controller() );
		}
	}
);
