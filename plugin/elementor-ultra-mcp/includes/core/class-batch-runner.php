<?php
/**
 * WP-P15 — Batch_Runner: the cross-document transaction engine (ULTRA).
 *
 * Contract authority: 10-rest-api.md §13 (BATCH plan/apply shapes + compensation semantics), §0.9
 * (the PHP dry-run is the AUTHORITATIVE per-step validator), §0.8 (`op_id` threading + idempotent
 * replay), §0.10 (atomic doc steps prime CSS after their save); 12-error-taxonomy.md §3.1
 * (`E_BAD_REQUEST`→`VALIDATION_FAILED`), §3.5 (`E_COMPENSATION_FAILED`→`INTERNAL_ERROR`/`UPSTREAM_ERROR`).
 *
 * This is the HTTP-independent core the thin {@see \Elementor\Ultra\Rest\Batch_Controller} wraps, so it is
 * unit-testable in isolation. It NEVER makes HTTP sub-requests (slow + auth-fragile, Implementation
 * Notes): each step's `route` string is dispatched to the SAME live CORE SERVICES the REST controllers
 * use ({@see Document_Writer}, {@see Global_Classes_Service}) by a small route→service map. Pro routes
 * (`pro/*`) are dispatched to the WP-R## Pro builders behind `class_exists`/`method_exists` guards so this
 * WP builds + runs even when the Pro packages are absent — those steps degrade to a per-step failure
 * (`PRO_REQUIRED`), never a fatal.
 *
 * The wire `code` always uses the FROZEN taxonomy (WP-F05 {@see Error_Codes}); the contract's `E_*`
 * aliases (`E_BAD_REQUEST`, `E_COMPENSATION_FAILED`, `E_ATOMIC_VALIDATION`) are docblock/`meta` identities,
 * never emitted as the wire `code` (which would be collapsed to INTERNAL_ERROR by {@see Response::error}).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Validator;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The cross-document plan/apply engine with up-front backups + best-effort compensation. All state lives
 * in method-locals (a fresh instance per request); no static mutation so concurrent batches never share.
 */
final class Batch_Runner {

	/**
	 * Document-write routes dispatched through {@see Document_Writer}. Each touches a single existing doc.
	 *
	 * @var string[]
	 */
	const DOC_WRITE_ROUTES = array(
		'documents/save',
		'documents/replace-tree',
		'documents/settings',
	);

	/**
	 * Document-CREATE routes (mint a NEW doc → recorded for compensation delete).
	 *
	 * @var string[]
	 */
	const DOC_CREATE_ROUTES = array(
		'documents',
		'documents/create',
	);

	/**
	 * Design-system routes that touch the kit (`{kit:true}` backup; global mutation per [S02/R6]).
	 *
	 * @var string[]
	 */
	const DESIGN_ROUTES = array(
		'design/classes',
		'design/deploy',
	);

	/**
	 * Pro routes dispatched to the WP-R## builders behind class_exists guards. The contract identity
	 * `E_*` alias for a failed-compensation/unavailable-Pro step is `PRO_REQUIRED` (12 §3.4).
	 *
	 * @var array<string,array{class:string,method:string,create:bool}>
	 */
	const PRO_DISPATCH = array(
		'pro/theme'      => array(
			'class'  => '\Elementor\Ultra\Pro\Theme_Builder_Service',
			'method' => 'create',
			'create' => true,
		),
		'pro/popup'      => array(
			'class'  => '\Elementor\Ultra\Pro\Popup_Service',
			'method' => 'create',
			'create' => true,
		),
		'pro/loop/item'  => array(
			'class'  => '\Elementor\Ultra\Pro\Loop_Service',
			'method' => 'create_item',
			'create' => true,
		),
		'pro/form/build' => array(
			'class'  => '\Elementor\Ultra\Pro\Form_Builder_Service',
			'method' => 'build',
			'create' => false,
		),
	);

	/*
	-------------------------------------------------------------------------------------------------
	 * PLAN
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Dry-plan a multi-document brief with NO persist (10 §13). For each `{route,body}` step it runs the
	 * route's VALIDATOR-only path (document steps → {@see Validator::dry_run}; design steps → the budget
	 * pre-flight; Pro steps → the Pro builder's validate-only, guarded), collecting per-step
	 * `{step,route,valid,diff}` plus the union of `backups_required` (each touched `post_id` + `{kit:true}`
	 * when design is touched). The aggregate `valid` is the AND of every step.
	 *
	 * @param array<int,array<string,mixed>> $steps Ordered list of `{route, body}` step descriptors.
	 * @return array{plan:array<int,array<string,mixed>>,backups_required:array<int,array<string,mixed>>,valid:bool}
	 */
	public function plan( array $steps ): array {
		$plan             = array();
		$backups_required = array();
		$all_valid        = true;
		$kit_touched      = false;

		foreach ( array_values( $steps ) as $i => $step ) {
			$route = is_array( $step ) && isset( $step['route'] ) ? (string) $step['route'] : '';
			$body  = is_array( $step ) && isset( $step['body'] ) && is_array( $step['body'] ) ? $step['body'] : array();

			$entry = $this->plan_step( $i, $route, $body );

			if ( empty( $entry['valid'] ) ) {
				$all_valid = false;
			}

			// Collect required backups: each touched existing doc + the kit when design is touched.
			$post_id = $this->touched_post_id( $route, $body );
			if ( $post_id > 0 ) {
				$backups_required[] = array( 'post_id' => $post_id );
			}
			if ( $this->is_design_route( $route ) ) {
				$kit_touched = true;
			}

			$plan[] = $entry;
		}

		if ( $kit_touched ) {
			$backups_required[] = array( 'kit' => true );
		}

		return array(
			'plan'             => $plan,
			'backups_required' => $this->dedupe_backups( $backups_required ),
			'valid'            => $all_valid,
		);
	}

	/**
	 * Validate ONE step (no persist) → `{step,route,valid,diff,errors?}`. A failed/unsupported route is a
	 * non-valid plan entry carrying the taxonomy error (NOT an exception): plan never throws.
	 *
	 * @param int                 $index The step index.
	 * @param string              $route The step route string.
	 * @param array<string,mixed> $body  The step body.
	 * @return array<string,mixed>
	 */
	private function plan_step( int $index, string $route, array $body ) {
		$base = array(
			'step'  => $index,
			'route' => $route,
			'valid' => false,
			'diff'  => null,
		);

		// Document write / create steps → the AUTHORITATIVE validator (10 §0.9).
		if ( $this->is_doc_route( $route ) ) {
			$elements = isset( $body['elements'] ) && is_array( $body['elements'] ) ? $body['elements'] : null;
			$settings = isset( $body['settings'] ) && is_array( $body['settings'] ) ? $body['settings'] : array();
			$post_id  = $this->touched_post_id( $route, $body );

			// A settings-only update (no elements) is valid by shape — there is no tree to validate.
			if ( null === $elements ) {
				$base['valid'] = true;
				$base['diff']  = array(
					'changed_ids' => array(),
					'new_ids'     => array(),
					'removed_ids' => array(),
				);
				return $base;
			}

			$result        = Validator::dry_run( $elements, $settings, $post_id );
			$base['valid'] = ! empty( $result['valid'] );
			$base['diff']  = isset( $result['diff'] ) ? $result['diff'] : null;
			if ( ! $base['valid'] ) {
				$base['errors'] = isset( $result['errors'] ) ? array_values( (array) $result['errors'] ) : array();
			}
			return $base;
		}

		// Design-system steps → budget/order pre-flight (no persist).
		if ( $this->is_design_route( $route ) ) {
			$diff_body = $this->design_diff_body( $body );
			$service   = $this->design_service();
			if ( null === $service ) {
				$base['errors'] = array( $this->plan_error( Error_Codes::UPSTREAM_ERROR, 'Global classes service unavailable.' ) );
				return $base;
			}
			$pre = $service->preflight_budget( $diff_body );
			if ( $pre instanceof WP_Error ) {
				$base['errors'] = array( $this->wp_error_to_item( $pre ) );
				return $base;
			}
			$base['valid'] = true;
			$base['diff']  = array(
				'kit'         => true,
				'added_ids'   => $this->id_list( $diff_body['changes']['added'] ?? array() ),
				'deleted_ids' => $this->id_list( $diff_body['changes']['deleted'] ?? array() ),
			);
			return $base;
		}

		// Pro steps → the Pro builder's validate-only path when present; degrade gracefully otherwise.
		if ( $this->is_pro_route( $route ) ) {
			$validate = $this->pro_validate( $route, $body );
			if ( $validate instanceof WP_Error ) {
				$base['errors'] = array( $this->wp_error_to_item( $validate ) );
				return $base;
			}
			$base['valid'] = true;
			$base['diff']  = is_array( $validate ) ? $validate : null;
			return $base;
		}

		// Unknown route → E_BAD_REQUEST (wire VALIDATION_FAILED).
		$base['errors'] = array(
			$this->plan_error(
				Error_Codes::VALIDATION_FAILED,
				sprintf( 'Unsupported batch route "%s".', $route ),
				array(
					'rest_code' => 'E_BAD_REQUEST',
					'route'     => $route,
				)
			),
		);
		return $base;
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * APPLY
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Execute a plan with up-front backups + best-effort compensation (10 §13).
	 *
	 *   a. Re-validate the (possibly stale) plan.
	 *   b. Backup-all-up-front: snapshot every touched EXISTING doc + the kit (when design is touched)
	 *      BEFORE any write; record which docs are NEW (created in this batch).
	 *   c. Execute steps IN ORDER via the route→service dispatch (one Document::save per doc step).
	 *   d. On a step failure: STOP, then COMPENSATE in REVERSE — delete docs created in THIS batch,
	 *      rollback modified existing docs to their up-front snapshot, restore the kit snapshot.
	 *   e. Return `{results:[{step,ok,post_id?,error?}],compensated}` (the controller returns HTTP 200).
	 *
	 * A failed step never throws — its `results[]` entry carries the outcome. A FAILED compensation is
	 * signalled by a `WP_Error('INTERNAL_ERROR', …, meta.rest_code='E_COMPENSATION_FAILED')` so the
	 * controller can return HTTP 500 with diagnostic `meta`.
	 *
	 * @param array<int,array<string,mixed>> $plan  The plan steps `[{route, body}]`.
	 * @param string|null                    $op_id The batch op id (§0.8) for the op-log + replay key.
	 * @return array{results:array<int,array<string,mixed>>,compensated:bool}|WP_Error
	 */
	public function apply( array $plan, ?string $op_id = null ) {
		$steps = $this->normalize_plan_steps( $plan );

		// (a) Re-validate the plan (a plan handed to apply may be stale).
		$revalidate = $this->plan( $steps );

		// (b) Backup-all-up-front. Snapshot every touched EXISTING doc + the kit BEFORE any write.
		$doc_snapshots = array(); // post_id => backup meta_key (existing docs only).
		$kit_snapshot  = null;    // {items,order} captured up front, or null when no design step.
		$kit_needed    = false;

		foreach ( $steps as $step ) {
			$route   = $step['route'];
			$body    = $step['body'];
			$post_id = $this->touched_post_id( $route, $body );
			if ( $post_id > 0 && get_post( $post_id ) && ! isset( $doc_snapshots[ $post_id ] ) ) {
				$handle = Backup_Service::snapshot( $post_id, 'pre-batch', $op_id );
				if ( is_array( $handle ) && isset( $handle['meta_key'] ) ) {
					$doc_snapshots[ $post_id ] = (string) $handle['meta_key'];
				}
			}
			if ( $this->is_design_route( $route ) ) {
				$kit_needed = true;
			}
		}

		if ( $kit_needed ) {
			$kit_snapshot = $this->snapshot_kit(); // {items,order} or null when unavailable.
		}

		// (c) Execute steps IN ORDER.
		$results      = array();
		$created_ids  = array();  // docs created in THIS batch (reverse-deleted on failure).
		$modified_ids = array();  // existing docs we actually wrote (rolled back on failure).
		$kit_written  = false;
		$failed       = false;

		foreach ( $steps as $index => $step ) {
			$route = $step['route'];
			$body  = $step['body'];

			$outcome = $this->apply_step( $route, $body, $op_id, (int) $index );

			if ( $outcome instanceof WP_Error ) {
				$results[] = array(
					'step'  => $index,
					'ok'    => false,
					'error' => $this->wp_error_to_item( $outcome ),
				);
				$failed    = true;
				break; // STOP on the first failure.
			}

			$row = array(
				'step' => $index,
				'ok'   => true,
			);
			if ( isset( $outcome['post_id'] ) ) {
				$row['post_id'] = (int) $outcome['post_id'];
			}
			$results[] = $row;

			// Track what we changed for compensation.
			if ( ! empty( $outcome['created'] ) && isset( $outcome['post_id'] ) ) {
				$created_ids[] = (int) $outcome['post_id'];
			} elseif ( isset( $outcome['post_id'] ) && (int) $outcome['post_id'] > 0 ) {
				$modified_ids[ (int) $outcome['post_id'] ] = true;
			}
			if ( $this->is_design_route( $route ) ) {
				$kit_written = true;
			}
		}

		$compensated = false;

		// (d) Compensate on failure — REVERSE of application.
		if ( $failed ) {
			$comp = $this->compensate( $created_ids, array_keys( $modified_ids ), $doc_snapshots, $kit_written, $kit_snapshot, $op_id );
			if ( $comp instanceof WP_Error ) {
				// (e) A FAILED compensation → HTTP 500 E_COMPENSATION_FAILED (wire INTERNAL_ERROR).
				return $comp;
			}
			$compensated = true;
		}

		// op-log one batch row.
		$this->log_batch( $op_id, $failed ? 'failed' : 'ok', count( $results ) );

		return array(
			'results'     => $results,
			'compensated' => $compensated,
		);
	}

	/**
	 * Dispatch ONE step to its live core service (one Document::save per doc step). Returns a normalized
	 * `{post_id?, created?:bool}` outcome or a taxonomy WP_Error (never throws into the apply loop).
	 *
	 * @param string              $route The step route.
	 * @param array<string,mixed> $body  The step body.
	 * @param string|null         $op_id The batch op id threaded onto each step's write.
	 * @param int                 $index The zero-based step index (salts the derived per-step op_id).
	 * @return array<string,mixed>|WP_Error
	 */
	private function apply_step( string $route, array $body, ?string $op_id, int $index = 0 ) {
		// Thread the batch op id onto a step that has none (per-step op_ids may already be present, §0.8).
		if ( null !== $op_id && ( ! isset( $body['op_id'] ) || '' === (string) $body['op_id'] ) ) {
			$body['op_id'] = $this->step_op_id( $op_id, $route, $index );
		}

		switch ( true ) {
			case 'documents/save' === $route:
				$post_id = $this->touched_post_id( $route, $body );
				if ( $post_id <= 0 ) {
					return $this->step_error( Error_Codes::VALIDATION_FAILED, 'documents/save requires a post_id/id.', 'E_BAD_REQUEST' );
				}
				$res = Document_Writer::save( $post_id, $this->doc_args( $body, true ) );
				return $this->doc_outcome( $res, $post_id, false );

			case 'documents/replace-tree' === $route:
				$post_id = $this->touched_post_id( $route, $body );
				if ( $post_id <= 0 ) {
					return $this->step_error( Error_Codes::VALIDATION_FAILED, 'documents/replace-tree requires a post_id/id.', 'E_BAD_REQUEST' );
				}
				$res = Document_Writer::replace_tree( $post_id, $this->doc_args( $body, true ) );
				return $this->doc_outcome( $res, $post_id, false );

			case 'documents/settings' === $route:
				$post_id = $this->touched_post_id( $route, $body );
				if ( $post_id <= 0 ) {
					return $this->step_error( Error_Codes::VALIDATION_FAILED, 'documents/settings requires a post_id/id.', 'E_BAD_REQUEST' );
				}
				$patch = isset( $body['settings'] ) && is_array( $body['settings'] ) ? $body['settings'] : array();
				$res   = Document_Writer::apply_settings_merge(
					$post_id,
					$patch,
					isset( $body['base_hash'] ) ? (string) $body['base_hash'] : null,
					isset( $body['op_id'] ) ? (string) $body['op_id'] : null
				);
				return $this->doc_outcome( $res, $post_id, false );

			case $this->is_doc_create_route( $route ):
				return $this->apply_create( $body );

			case $this->is_design_route( $route ):
				$service = $this->design_service();
				if ( null === $service ) {
					return $this->step_error( Error_Codes::UPSTREAM_ERROR, 'Global classes service unavailable.', 'E_BAD_REQUEST', 502 );
				}
				$res = $service->apply_diff( $this->design_diff_body( $body ) );
				if ( $res instanceof WP_Error ) {
					return $res;
				}
				$this->flush_design_system();
				return array();

			case $this->is_pro_route( $route ):
				return $this->apply_pro( $route, $body );

			default:
				return $this->step_error( Error_Codes::VALIDATION_FAILED, sprintf( 'Unsupported batch route "%s".', $route ), 'E_BAD_REQUEST' );
		}
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * COMPENSATION
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Best-effort compensation in REVERSE of application (10 §13, Implementation Notes): delete docs
	 * CREATED in this batch (`wp_delete_post($id,true)`), rollback MODIFIED existing docs to their up-front
	 * snapshot ({@see Backup_Service::rollback}), then restore the kit snapshot. Each undo is independent;
	 * any that CANNOT be undone is collected and, if non-empty, returned as a 500 `E_COMPENSATION_FAILED`
	 * (wire INTERNAL_ERROR) with diagnostic `meta` so a human can intervene (12 §3.5).
	 *
	 * @param int[]                    $created_ids   Docs created in this batch (delete forever).
	 * @param int[]                    $modified_ids  Existing docs we wrote (rollback to snapshot).
	 * @param array<int,string>        $doc_snapshots post_id => snapshot meta_key.
	 * @param bool                     $kit_written   Whether the kit was actually written.
	 * @param array<string,mixed>|null $kit_snapshot The up-front kit `{items,order}` (or null).
	 * @param string|null              $op_id         The batch op id.
	 * @return true|WP_Error true on a clean compensation; WP_Error when something could NOT be undone.
	 */
	private function compensate( array $created_ids, array $modified_ids, array $doc_snapshots, bool $kit_written, $kit_snapshot, ?string $op_id ) {
		$failures = array();

		// 1) Delete docs created in this batch (reverse order).
		foreach ( array_reverse( array_values( $created_ids ) ) as $id ) {
			$id = (int) $id;
			if ( $id <= 0 ) {
				continue;
			}
			$deleted = wp_delete_post( $id, true );
			if ( ! $deleted ) {
				$failures[] = array(
					'kind'    => 'delete_created_doc',
					'post_id' => $id,
					'reason'  => 'wp_delete_post returned falsy',
				);
			}
		}

		// 2) Rollback modified existing docs to their up-front snapshot.
		foreach ( array_reverse( array_values( $modified_ids ) ) as $id ) {
			$id = (int) $id;
			if ( $id <= 0 || ! isset( $doc_snapshots[ $id ] ) ) {
				continue;
			}
			$res = Backup_Service::rollback( $id, $doc_snapshots[ $id ], false );
			if ( $res instanceof WP_Error ) {
				$failures[] = array(
					'kind'     => 'rollback_doc',
					'post_id'  => $id,
					'snapshot' => $doc_snapshots[ $id ],
					'reason'   => $res->get_error_message(),
				);
			}
		}

		// 3) Restore the kit snapshot (global-classes) when the kit was touched.
		if ( $kit_written ) {
			$restored = $this->restore_kit( $kit_snapshot );
			if ( $restored instanceof WP_Error ) {
				$failures[] = array(
					'kind'   => 'restore_kit',
					'reason' => $restored->get_error_message(),
				);
			} else {
				$this->flush_design_system();
			}
		}

		if ( empty( $failures ) ) {
			return true;
		}

		return new WP_Error(
			Error_Codes::INTERNAL_ERROR,
			__( 'A batch step failed AND compensation could not fully restore the pre-batch state. Manual intervention is required for the items listed in meta.unrecovered.', 'elementor-ultra-mcp' ),
			array(
				'status' => 500,
				'op_id'  => $op_id,
				'meta'   => array(
					'rest_code'   => 'E_COMPENSATION_FAILED',
					'unrecovered' => array_values( $failures ),
				),
			)
		);
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * Document CREATE dispatch
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Create a blank document (10 §2.2) and, when `elements` are supplied, validate (AUTHORITATIVE) then
	 * persist them via {@see Document_Writer}. The new id is flagged `created:true` so compensation can
	 * delete it on a later step's failure. A failed validate deletes the orphan draft before returning.
	 *
	 * @param array<string,mixed> $body The create body `{title,post_type,template_type,status,elements?,settings?,op_id?}`.
	 * @return array<string,mixed>|WP_Error
	 */
	private function apply_create( array $body ) {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return $this->step_error( Error_Codes::UPSTREAM_ERROR, 'Elementor is not active; cannot create a document.', 'E_BAD_REQUEST', 502 );
		}

		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->documents ) ) {
			return $this->step_error( Error_Codes::UPSTREAM_ERROR, 'Elementor documents manager unavailable.', 'E_BAD_REQUEST', 502 );
		}

		$post_type     = isset( $body['post_type'] ) && '' !== (string) $body['post_type'] ? (string) $body['post_type'] : 'page';
		$template_type = isset( $body['template_type'] ) && '' !== (string) $body['template_type'] ? (string) $body['template_type'] : $this->derive_template_type( $post_type );
		$title         = isset( $body['title'] ) && '' !== (string) $body['title'] ? (string) $body['title'] : 'New Page';
		$status        = isset( $body['status'] ) && '' !== (string) $body['status'] ? (string) $body['status'] : 'draft';

		try {
			$document = $plugin->documents->create(
				$template_type,
				array(
					'post_title'  => $title,
					'post_status' => $status,
					'post_type'   => $post_type,
				)
			);
		} catch ( \Throwable $e ) {
			return $this->step_error( Error_Codes::UPSTREAM_ERROR, sprintf( 'Document create failed: %s', $e->getMessage() ), 'E_BAD_REQUEST', 502 );
		}

		if ( ! $document || is_wp_error( $document ) ) {
			return $this->step_error( Error_Codes::UPSTREAM_ERROR, 'Document create returned no document.', 'E_BAD_REQUEST', 502 );
		}

		$post_id = (int) $document->get_main_id();
		if ( $post_id <= 0 ) {
			return $this->step_error( Error_Codes::UPSTREAM_ERROR, 'Created document has no post id.', 'E_BAD_REQUEST', 502 );
		}

		// Persist the tree (when supplied) through the transactional writer. Force + no backup: the doc is
		// brand-new in THIS batch (compensation deletes it; an up-front snapshot is unnecessary).
		$elements = isset( $body['elements'] ) && is_array( $body['elements'] ) ? $body['elements'] : null;
		if ( null !== $elements ) {
			$args             = $this->doc_args( $body, false );
			$args['force']    = true;
			$args['backup']   = false;
			$args['elements'] = $elements;
			$res              = Document_Writer::save( $post_id, $args );
			if ( $res instanceof WP_Error ) {
				// Delete the orphan draft so a failed validate leaves no partial state.
				wp_delete_post( $post_id, true );
				return $res;
			}
		}

		return array(
			'post_id' => $post_id,
			'created' => true,
		);
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * Pro dispatch (guarded — graceful degrade when Pro WPs absent)
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Validate-only a Pro step (plan path). Resolves the guarded Pro service; when present and it exposes a
	 * `validate(array):mixed` method, delegate, else accept the step shape as valid (the apply path is the
	 * authoritative gate). When Pro is absent → a `PRO_REQUIRED` WP_Error (degrade gracefully).
	 *
	 * @param string              $route The pro route.
	 * @param array<string,mixed> $body  The step body.
	 * @return array<string,mixed>|true|WP_Error
	 */
	private function pro_validate( string $route, array $body ) {
		$svc = $this->pro_service( $route );
		if ( $svc instanceof WP_Error ) {
			return $svc;
		}
		if ( is_object( $svc ) && method_exists( $svc, 'validate' ) ) {
			$out = $svc->validate( $body );
			return is_wp_error( $out ) ? $out : ( is_array( $out ) ? $out : true );
		}
		return true;
	}

	/**
	 * Apply a Pro step via the guarded Pro builder. Returns `{post_id?,created?:bool}` or a WP_Error.
	 * Pro create routes (`pro/theme`/`pro/popup`/`pro/loop/item`) flag `created:true` so a later failure
	 * compensates by deleting the created doc.
	 *
	 * @param string              $route The pro route.
	 * @param array<string,mixed> $body  The step body.
	 * @return array<string,mixed>|WP_Error
	 */
	private function apply_pro( string $route, array $body ) {
		$svc = $this->pro_service( $route );
		if ( $svc instanceof WP_Error ) {
			return $svc;
		}

		$spec   = self::PRO_DISPATCH[ $route ];
		$method = $spec['method'];

		if ( ! is_object( $svc ) || ! method_exists( $svc, $method ) ) {
			return $this->step_error(
				Error_Codes::PRO_REQUIRED,
				sprintf( 'The Pro builder for "%s" is unavailable.', $route ),
				'E_FEATURE_UNAVAILABLE',
				Error_Codes::http_status( Error_Codes::PRO_REQUIRED )
			);
		}

		try {
			$out = $svc->{$method}( $body );
		} catch ( \Throwable $e ) {
			return $this->step_error( Error_Codes::UPSTREAM_ERROR, sprintf( 'Pro step "%s" failed: %s', $route, $e->getMessage() ), 'E_BAD_REQUEST', 502 );
		}

		if ( $out instanceof WP_Error ) {
			return $out;
		}

		$new_id = $this->extract_pro_post_id( $out );
		$result = array();
		if ( $new_id > 0 ) {
			$result['post_id'] = $new_id;
			$result['created'] = ! empty( $spec['create'] );
		}
		return $result;
	}

	/**
	 * Resolve a guarded Pro service instance for a route, or a `PRO_REQUIRED` WP_Error when its class is
	 * not loaded (the Pro WP is absent / Pro inactive). Never fatals.
	 *
	 * @param string $route The pro route.
	 * @return object|WP_Error
	 */
	private function pro_service( string $route ) {
		if ( ! isset( self::PRO_DISPATCH[ $route ] ) ) {
			return $this->step_error( Error_Codes::VALIDATION_FAILED, sprintf( 'Unsupported Pro route "%s".', $route ), 'E_BAD_REQUEST' );
		}
		$class = self::PRO_DISPATCH[ $route ]['class'];
		if ( ! class_exists( $class ) ) {
			return $this->step_error(
				Error_Codes::PRO_REQUIRED,
				sprintf( 'Elementor Pro (or its companion builder) is required for "%s" but is not active.', $route ),
				'E_FEATURE_UNAVAILABLE',
				Error_Codes::http_status( Error_Codes::PRO_REQUIRED )
			);
		}
		try {
			return new $class();
		} catch ( \Throwable $e ) {
			return $this->step_error( Error_Codes::UPSTREAM_ERROR, sprintf( 'Could not construct the Pro builder for "%s": %s', $route, $e->getMessage() ), 'E_BAD_REQUEST', 502 );
		}
	}

	/**
	 * Best-effort extract of a created doc id from a Pro builder's return payload (`post_id`/`template_id`).
	 *
	 * @param mixed $out The Pro builder return value.
	 * @return int
	 */
	private function extract_pro_post_id( $out ): int {
		if ( ! is_array( $out ) ) {
			return 0;
		}
		foreach ( array( 'post_id', 'template_id', 'id' ) as $key ) {
			if ( isset( $out[ $key ] ) && (int) $out[ $key ] > 0 ) {
				return (int) $out[ $key ];
			}
		}
		return 0;
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * Kit snapshot / restore (design-system compensation)
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Snapshot the active kit's global-classes `{items,order}` (frontend context) UP FRONT, via the live
	 * {@see Global_Classes_Service::list}. Returns null when the design service / kit is unavailable (no
	 * design step can have run, so there is nothing to restore).
	 *
	 * @return array{items:array<string,mixed>,order:string[]}|null
	 */
	private function snapshot_kit() {
		$service = $this->design_service();
		if ( null === $service ) {
			return null;
		}
		$snapshot = $service->list( Global_Classes_Service::CONTEXT_FRONTEND );
		if ( $snapshot instanceof WP_Error || ! is_array( $snapshot ) ) {
			return null;
		}
		return array(
			'items' => isset( $snapshot['items'] ) && is_array( $snapshot['items'] ) ? $snapshot['items'] : array(),
			'order' => isset( $snapshot['order'] ) && is_array( $snapshot['order'] ) ? array_values( $snapshot['order'] ) : array(),
		);
	}

	/**
	 * Restore a kit `{items,order}` snapshot by re-writing the global-classes repository wholesale
	 * (`Global_Classes_Repository::put($items,$order)` — the inverse of any diff applied during the batch).
	 * Guarded so it never fatals when the module is absent.
	 *
	 * @param array<string,mixed>|null $kit_snapshot The up-front kit snapshot.
	 * @return true|WP_Error
	 */
	private function restore_kit( $kit_snapshot ) {
		if ( null === $kit_snapshot ) {
			// Nothing to restore (the kit was never snapshot-able); treat as a no-op success.
			return true;
		}

		$repo_class = '\Elementor\Modules\GlobalClasses\Global_Classes_Repository';
		if ( ! class_exists( $repo_class ) ) {
			return new WP_Error( Error_Codes::UPSTREAM_ERROR, 'Global classes repository unavailable for kit restore.' );
		}

		$kit = $this->active_kit();
		if ( null === $kit ) {
			return new WP_Error( Error_Codes::UPSTREAM_ERROR, 'No active kit for global-classes restore.' );
		}

		try {
			$repository = $repo_class::make( $kit );
			$items      = isset( $kit_snapshot['items'] ) && is_array( $kit_snapshot['items'] ) ? $kit_snapshot['items'] : array();
			$order      = isset( $kit_snapshot['order'] ) && is_array( $kit_snapshot['order'] ) ? array_values( $kit_snapshot['order'] ) : array();
			$repository->put( $items, $order );
		} catch ( \Throwable $e ) {
			return new WP_Error( Error_Codes::UPSTREAM_ERROR, sprintf( 'Kit restore failed: %s', $e->getMessage() ) );
		}

		return true;
	}

	/** The active Elementor kit, or null when the kits manager is unavailable. */
	private function active_kit() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->kits_manager ) || ! method_exists( $plugin->kits_manager, 'get_active_kit' ) ) {
			return null;
		}
		return $plugin->kits_manager->get_active_kit();
	}

	/** Flush + re-prime the design system after a kit write/restore ([S02/R6] global mutation). */
	private function flush_design_system(): void {
		if ( class_exists( '\Elementor\Ultra\Core\Cache_Service' ) ) {
			( new Cache_Service() )->flush_design_system();
		}
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * Helpers — route classification + body normalization
	 * ---------------------------------------------------------------------------------------------- */

	/** True iff `$route` is a document write OR create route. */
	private function is_doc_route( string $route ): bool {
		return $this->is_doc_write_route( $route ) || $this->is_doc_create_route( $route );
	}

	/** True iff `$route` is a document write route (existing doc). */
	private function is_doc_write_route( string $route ): bool {
		return in_array( $route, self::DOC_WRITE_ROUTES, true );
	}

	/** True iff `$route` is a document CREATE route (new doc). */
	private function is_doc_create_route( string $route ): bool {
		return in_array( $route, self::DOC_CREATE_ROUTES, true );
	}

	/** True iff `$route` touches the kit (design system). */
	private function is_design_route( string $route ): bool {
		return in_array( $route, self::DESIGN_ROUTES, true );
	}

	/** True iff `$route` is a Pro builder route (`pro/*`). */
	private function is_pro_route( string $route ): bool {
		return 0 === strpos( $route, 'pro/' );
	}

	/**
	 * The existing-doc id a step touches (`post_id` then `id`); 0 for create/design/Pro-create steps.
	 *
	 * @param string              $route The step route.
	 * @param array<string,mixed> $body  The step body.
	 * @return int
	 */
	private function touched_post_id( string $route, array $body ): int {
		if ( ! $this->is_doc_write_route( $route ) ) {
			return 0;
		}
		foreach ( array( 'post_id', 'id' ) as $key ) {
			if ( isset( $body[ $key ] ) && (int) $body[ $key ] > 0 ) {
				return (int) $body[ $key ];
			}
		}
		return 0;
	}

	/**
	 * Build the {@see Document_Writer} args from a step body (elements/settings/base_hash/op_id/force/
	 * prime_css). `$default_prime` enables atomic priming (§0.10) for ordinary writes; the create path
	 * overrides per-call.
	 *
	 * @param array<string,mixed> $body          The step body.
	 * @param bool                $default_prime Whether to default `prime_css` true (atomic-CSS rule, S1).
	 * @return array<string,mixed>
	 */
	private function doc_args( array $body, bool $default_prime ): array {
		$args = array();
		if ( isset( $body['elements'] ) && is_array( $body['elements'] ) ) {
			$args['elements'] = $body['elements'];
		}
		if ( isset( $body['settings'] ) && is_array( $body['settings'] ) ) {
			$args['settings'] = $body['settings'];
		}
		if ( isset( $body['base_hash'] ) && '' !== (string) $body['base_hash'] ) {
			$args['base_hash'] = (string) $body['base_hash'];
		}
		if ( isset( $body['op_id'] ) && '' !== (string) $body['op_id'] ) {
			$args['op_id'] = (string) $body['op_id'];
		}
		if ( ! empty( $body['force'] ) ) {
			$args['force'] = true;
		}
		// §0.10 / S1: atomic doc steps prime CSS after their save unless the body opts out.
		$args['prime_css'] = array_key_exists( 'prime_css', $body ) ? ! empty( $body['prime_css'] ) : $default_prime;
		return $args;
	}

	/**
	 * Normalize a Document_Writer return into the apply outcome `{post_id, created}` or pass the WP_Error.
	 *
	 * @param array<string,mixed>|WP_Error $res     The writer return.
	 * @param int                          $post_id The target doc id.
	 * @param bool                         $created Whether this write created the doc.
	 * @return array<string,mixed>|WP_Error
	 */
	private function doc_outcome( $res, int $post_id, bool $created ) {
		if ( $res instanceof WP_Error ) {
			return $res;
		}
		return array(
			'post_id' => $post_id,
			'created' => $created,
		);
	}

	/**
	 * Normalize a design step body into the diff-PUT body {@see Global_Classes_Service::apply_diff} expects.
	 * Accepts either an already-shaped `{changes,items,order,context}` body OR a `design/deploy` body whose
	 * `global_classes` sub-object carries the diff (10 §6 deploy shape).
	 *
	 * @param array<string,mixed> $body The design step body.
	 * @return array<string,mixed>
	 */
	private function design_diff_body( array $body ): array {
		if ( isset( $body['global_classes'] ) && is_array( $body['global_classes'] ) ) {
			$gc = $body['global_classes'];
			return array(
				'context' => isset( $body['context'] ) ? $body['context'] : ( $gc['context'] ?? 'frontend' ),
				'changes' => isset( $gc['changes'] ) && is_array( $gc['changes'] ) ? $gc['changes'] : array(
					'added'    => $gc['added'] ?? array(),
					'deleted'  => $gc['deleted'] ?? array(),
					'modified' => $gc['modified'] ?? array(),
				),
				'items'   => isset( $gc['items'] ) && is_array( $gc['items'] ) ? $gc['items'] : array(),
				'order'   => isset( $gc['order'] ) && is_array( $gc['order'] ) ? $gc['order'] : array(),
				'op_id'   => $body['op_id'] ?? null,
			);
		}
		return $body;
	}

	/** The guarded global-classes service, or null when unavailable. */
	private function design_service() {
		if ( ! class_exists( '\Elementor\Ultra\Core\Global_Classes_Service' ) ) {
			return null;
		}
		return new Global_Classes_Service();
	}

	/**
	 * Normalize a list of class ids (string entries) from a (possibly mixed) array.
	 *
	 * @param mixed $list The raw value.
	 * @return string[]
	 */
	private function id_list( $list ): array {
		if ( ! is_array( $list ) ) {
			return array();
		}
		$out = array();
		foreach ( $list as $entry ) {
			if ( is_string( $entry ) && '' !== $entry ) {
				$out[] = $entry;
			}
		}
		return $out;
	}

	/**
	 * Coerce a stored/raw plan into uniform `{route, body}` step descriptors. Accepts the plan as
	 * `[{route,body}]` (preferred) AND tolerates a bare list of routes/bodies defensively.
	 *
	 * @param array<int,mixed> $plan The plan steps.
	 * @return array<int,array{route:string,body:array<string,mixed>}>
	 */
	private function normalize_plan_steps( array $plan ): array {
		$steps = array();
		foreach ( array_values( $plan ) as $entry ) {
			if ( ! is_array( $entry ) ) {
				continue;
			}
			$route   = isset( $entry['route'] ) ? (string) $entry['route'] : '';
			$body    = isset( $entry['body'] ) && is_array( $entry['body'] ) ? $entry['body'] : array();
			$steps[] = array(
				'route' => $route,
				'body'  => $body,
			);
		}
		return $steps;
	}

	/**
	 * De-duplicate the `backups_required` list (same post_id once; `{kit:true}` once).
	 *
	 * @param array<int,array<string,mixed>> $list The raw required-backups list.
	 * @return array<int,array<string,mixed>>
	 */
	private function dedupe_backups( array $list ): array {
		$seen_posts = array();
		$kit        = false;
		$out        = array();
		foreach ( $list as $entry ) {
			if ( isset( $entry['post_id'] ) ) {
				$pid = (int) $entry['post_id'];
				if ( $pid > 0 && ! isset( $seen_posts[ $pid ] ) ) {
					$seen_posts[ $pid ] = true;
					$out[]              = array( 'post_id' => $pid );
				}
			} elseif ( ! empty( $entry['kit'] ) ) {
				$kit = true;
			}
		}
		if ( $kit ) {
			$out[] = array( 'kit' => true );
		}
		return $out;
	}

	/** Derive a default template_type from a post_type (page→wp-page, post→wp-post, else wp-page). */
	private function derive_template_type( string $post_type ): string {
		switch ( $post_type ) {
			case 'post':
				return 'wp-post';
			case 'page':
				return 'wp-page';
			default:
				return 'wp-page';
		}
	}

	/**
	 * A deterministic per-step op id derived from the batch op id + STEP INDEX + route (§0.8; contract 18
	 * §7 M-e). The index salt is what keeps two identical-route steps in one batch from colliding on the
	 * same derived op_id (the 2nd step silently no-oped as an idempotent replay before the salt). The
	 * index sits BEFORE the route suffix so it survives the 64-char truncation. Truncated to the 64-char
	 * op_id limit; non-conforming characters in the route are stripped so the derived id stays valid.
	 *
	 * @param string $batch_op_id The batch op id.
	 * @param string $route       The step route.
	 * @param int    $index       The zero-based step index within the batch.
	 * @return string
	 */
	private function step_op_id( string $batch_op_id, string $route, int $index = 0 ): string {
		$suffix = preg_replace( '/[^A-Za-z0-9_.-]/', '-', $route );
		$id     = $batch_op_id . '.' . $index . '.' . $suffix;
		return substr( $id, 0, 64 );
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * Error helpers
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Build a step WP_Error carrying the wire taxonomy `code` plus the contract `E_*` alias in `meta`.
	 *
	 * @param string $code      The wire taxonomy code (Error_Codes::*).
	 * @param string $message   The human message.
	 * @param string $rest_code The contract `E_*` alias (recorded in meta.rest_code).
	 * @param int    $status    Optional HTTP status (defaults to the code's frozen status).
	 * @return WP_Error
	 */
	private function step_error( string $code, string $message, string $rest_code, int $status = 0 ): WP_Error {
		$status = $status > 0 ? $status : Error_Codes::http_status( $code );
		return new WP_Error(
			$code,
			$message,
			array(
				'status' => $status,
				'meta'   => array( 'rest_code' => $rest_code ),
			)
		);
	}

	/**
	 * A plan-entry error item `{code,message,meta?}` (the plan never returns a WP_Error — it embeds errors).
	 *
	 * @param string              $code    The wire taxonomy code.
	 * @param string              $message The human message.
	 * @param array<string,mixed> $meta    Optional structured meta.
	 * @return array<string,mixed>
	 */
	private function plan_error( string $code, string $message, array $meta = array() ): array {
		return array(
			'code'    => $code,
			'message' => $message,
			'meta'    => $meta,
		);
	}

	/**
	 * Flatten a taxonomy WP_Error to a `{code,message,meta?}` item for a per-step `error`/plan entry.
	 *
	 * @param WP_Error $error The taxonomy WP_Error.
	 * @return array<string,mixed>
	 */
	private function wp_error_to_item( WP_Error $error ): array {
		$data = $error->get_error_data();
		$data = is_array( $data ) ? $data : array();
		$item = array(
			'code'    => (string) $error->get_error_code(),
			'message' => (string) $error->get_error_message(),
		);
		if ( isset( $data['meta'] ) && is_array( $data['meta'] ) && ! empty( $data['meta'] ) ) {
			$item['meta'] = $data['meta'];
		}
		if ( isset( $data['errors'] ) && is_array( $data['errors'] ) && ! empty( $data['errors'] ) ) {
			$item['errors'] = array_values( $data['errors'] );
		}
		return $item;
	}

	/**
	 * Record one batch op-log row (failure-tolerant; never throws into the batch — Op_Log swallows).
	 *
	 * @param string|null $op_id  The batch op id.
	 * @param string      $result The result label (`ok`/`failed`).
	 * @param int         $count  The number of step results produced.
	 * @return void
	 */
	private function log_batch( ?string $op_id, string $result, int $count ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) ) {
			return;
		}
		Op_Log::record(
			array(
				'op_id'  => $op_id,
				'route'  => 'batch/apply',
				'result' => $result,
				'meta'   => array( 'steps' => $count ),
			)
		);
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * Idempotent replay (§0.8) — used by the controller
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Whether this batch `op_id` has already been applied (§0.8). Consults the op-log for a prior
	 * `batch/apply` row with the same id (the batch-level idempotency key). When true the controller
	 * returns the prior result with `idempotent_replay:true` WITHOUT re-applying.
	 *
	 * @param string $op_id The batch op id.
	 * @return bool
	 */
	public function batch_already_applied( string $op_id ): bool {
		if ( '' === $op_id || ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) ) {
			return false;
		}
		$row = Op_Log::find_by_op_id( $op_id, 0 );
		return is_array( $row ) && isset( $row['tool'] ) && 'batch/apply' === $row['tool'];
	}
}
