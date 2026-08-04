<?php
/**
 * WP-P15 — Batch controller: the cross-document transaction surface (ULTRA).
 *
 * Contract authority: 10-rest-api.md §13 (`POST /batch/plan`, `POST /batch/apply` — CAP_EDIT_POST; each
 * step re-checks its own cap; plan/apply shapes + compensation semantics), §0.5/§0.6 (envelopes), §0.8
 * (`op_id` + idempotent replay), §0.9 (per-step dry-run is AUTHORITATIVE), §0.10 (atomic doc steps prime);
 * 12-error-taxonomy.md §3.1 (`E_BAD_REQUEST`→`VALIDATION_FAILED`), §3.5 (`E_COMPENSATION_FAILED`→
 * `INTERNAL_ERROR`/`UPSTREAM_ERROR`; the contract `E_*` alias rides in `meta.rest_code`).
 *
 * This is a THIN wrapper over {@see \Elementor\Ultra\Core\Batch_Runner} (all transaction logic lives in
 * the runner, kept HTTP-independent + unit-testable). The controller owns only the two route schemas, the
 * CAP_EDIT_POST gate, request-shape validation (the ONLY 400/malformed path), the op_id read + batch
 * idempotent-replay short-circuit, and the §0.5/§0.6 envelope.
 *
 * Self-registers with the WP-P02 {@see Registrar} via the `elementor_ultra/rest/register` action — it
 * NEVER edits the spine `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Batch_Runner;
use Elementor\Ultra\Core\Op_Log;
use Elementor\Ultra\Error_Codes;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The BATCH REST controller (10-rest-api.md §13). Two routes: `POST /batch/plan`, `POST /batch/apply`.
 */
final class Batch_Controller extends Abstract_Controller {

	/** Hard cap on steps per batch (defensive — a malformed/abusive request shape is a 400). */
	const MAX_STEPS = 200;

	/**
	 * Register `POST /batch/plan` + `POST /batch/apply` (both CAP_EDIT_POST) — 10-rest-api.md §13.
	 *
	 * @return void
	 */
	public function register_routes(): void {
		$this->route(
			'/batch/plan',
			'POST',
			array( $this, 'post_plan' ),
			Permissions::can_edit_post(),
			array(
				'steps' => array(
					'type'     => 'array',
					'required' => true,
				),
				'op_id' => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);

		$this->route(
			'/batch/apply',
			'POST',
			array( $this, 'post_apply' ),
			Permissions::can_edit_post(),
			array(
				'plan'  => array(
					'type'     => 'array',
					'required' => true,
				),
				'op_id' => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);
	}

	/**
	 * `POST /batch/plan` (10 §13). Dry-plans a multi-document brief with NO persist: each `{route,body}`
	 * step is validated via the runner, returning `{plan:[{step,route,valid,diff}],backups_required,valid}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function post_plan( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$steps = $request->get_param( 'steps' );
		$bad   = $this->validate_steps( $steps, $op_id );
		if ( $bad instanceof WP_Error ) {
			return $bad;
		}

		$runner = new Batch_Runner();
		$result = $runner->plan( $steps );

		return $this->ok( $result );
	}

	/**
	 * `POST /batch/apply` (10 §13). Executes a plan with up-front backups + best-effort compensation.
	 * Returns `{results:[{step,ok,post_id?,error?}],compensated}` at HTTP 200 — a FAILED step is carried in
	 * `results[]` (NOT an HTTP error). The ONLY non-200 cases: a malformed request (400) and a FAILED
	 * compensation (500 `E_COMPENSATION_FAILED`, wire INTERNAL_ERROR).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function post_apply( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$plan = $request->get_param( 'plan' );
		$bad  = $this->validate_plan( $plan, $op_id );
		if ( $bad instanceof WP_Error ) {
			return $bad;
		}

		$runner = new Batch_Runner();

		// (§0.8) Idempotent replay: an already-applied batch op returns its prior results, no re-apply.
		if ( is_string( $op_id ) && '' !== $op_id && $runner->batch_already_applied( $op_id ) ) {
			$prior                      = $this->prior_batch_result( $op_id );
			$prior['idempotent_replay'] = true;
			return $this->ok( $prior );
		}

		$result = $runner->apply( $plan, is_string( $op_id ) ? $op_id : null );

		// A FAILED compensation is the only path that surfaces as a non-200 (500 E_COMPENSATION_FAILED).
		if ( $result instanceof WP_Error ) {
			return $result;
		}

		return $this->ok( $result );
	}

	/*
	-------------------------------------------------------------------------------------------------
	 * Request-shape validation (the ONLY 400 / malformed path — 10 §13)
	 * ---------------------------------------------------------------------------------------------- */

	/**
	 * Validate a `steps` payload shape (plan). Each entry MUST be an object with a non-empty string `route`
	 * and (optionally) an object `body`. A malformed shape → 400 `E_BAD_REQUEST` (wire SCHEMA_INVALID_PARAMS).
	 *
	 * @param mixed       $steps The raw `steps` param.
	 * @param string|null $op_id The echoed op id.
	 * @return true|WP_Error
	 */
	private function validate_steps( $steps, $op_id ) {
		if ( ! is_array( $steps ) || empty( $steps ) ) {
			return $this->bad_request( 'steps must be a non-empty array of {route, body} descriptors.', 'steps', $op_id );
		}
		if ( count( $steps ) > self::MAX_STEPS ) {
			return $this->bad_request(
				sprintf( 'Too many steps (%d); the maximum is %d.', count( $steps ), self::MAX_STEPS ),
				'steps',
				$op_id
			);
		}
		foreach ( array_values( $steps ) as $i => $step ) {
			if ( ! is_array( $step ) || ! isset( $step['route'] ) || ! is_string( $step['route'] ) || '' === trim( $step['route'] ) ) {
				return $this->bad_request(
					sprintf( 'steps[%d] must be an object with a non-empty string "route".', $i ),
					sprintf( 'steps[%d].route', $i ),
					$op_id
				);
			}
			if ( isset( $step['body'] ) && ! is_array( $step['body'] ) ) {
				return $this->bad_request(
					sprintf( 'steps[%d].body must be an object when present.', $i ),
					sprintf( 'steps[%d].body', $i ),
					$op_id
				);
			}
		}
		return true;
	}

	/**
	 * Validate a `plan` payload shape (apply). Identical structural rules to {@see validate_steps} — a plan
	 * is the same list of `{route, body}` descriptors. A malformed shape → 400 `E_BAD_REQUEST`.
	 *
	 * @param mixed       $plan  The raw `plan` param.
	 * @param string|null $op_id The echoed op id.
	 * @return true|WP_Error
	 */
	private function validate_plan( $plan, $op_id ) {
		if ( ! is_array( $plan ) || empty( $plan ) ) {
			return $this->bad_request( 'plan must be a non-empty array of {route, body} step descriptors.', 'plan', $op_id );
		}
		if ( count( $plan ) > self::MAX_STEPS ) {
			return $this->bad_request(
				sprintf( 'Too many plan steps (%d); the maximum is %d.', count( $plan ), self::MAX_STEPS ),
				'plan',
				$op_id
			);
		}
		foreach ( array_values( $plan ) as $i => $step ) {
			if ( ! is_array( $step ) || ! isset( $step['route'] ) || ! is_string( $step['route'] ) || '' === trim( $step['route'] ) ) {
				return $this->bad_request(
					sprintf( 'plan[%d] must be an object with a non-empty string "route".', $i ),
					sprintf( 'plan[%d].route', $i ),
					$op_id
				);
			}
			if ( isset( $step['body'] ) && ! is_array( $step['body'] ) ) {
				return $this->bad_request(
					sprintf( 'plan[%d].body must be an object when present.', $i ),
					sprintf( 'plan[%d].body', $i ),
					$op_id
				);
			}
		}
		return true;
	}

	/**
	 * Build the canonical malformed-request 400 (wire `SCHEMA_INVALID_PARAMS`; contract alias `E_BAD_REQUEST`
	 * in `meta.rest_code`). The ONLY 400 path in this controller (10 §13 — a failed STEP is never a 400).
	 *
	 * @param string      $message The human message.
	 * @param string      $path    The offending JSON path into the request body.
	 * @param string|null $op_id   The echoed op id.
	 * @return WP_Error
	 */
	private function bad_request( string $message, string $path, $op_id ): WP_Error {
		return $this->fail(
			Error_Codes::SCHEMA_INVALID_PARAMS,
			$message,
			400,
			array(
				'path'      => $path,
				'rest_code' => 'E_BAD_REQUEST',
			),
			array(),
			is_string( $op_id ) ? $op_id : null
		);
	}

	/**
	 * Reconstruct the prior `batch/apply` result envelope for an idempotent replay (§0.8). The op-log stores
	 * a step count in `meta.steps`; we cannot reconstruct each per-step payload, so we return a stable
	 * `{results:[],compensated:false}` shell carrying the recorded outcome — enough for the agent to detect
	 * "already applied" without re-executing. The `idempotent_replay` flag is set by the caller.
	 *
	 * @param string $op_id The batch op id.
	 * @return array<string,mixed>
	 */
	private function prior_batch_result( string $op_id ): array {
		$compensated = false;
		if ( class_exists( '\Elementor\Ultra\Core\Op_Log' ) ) {
			$row = Op_Log::find_by_op_id( $op_id, 0 );
			if ( is_array( $row ) && isset( $row['result'] ) ) {
				$compensated = ( 'failed' === $row['result'] );
			}
		}
		return array(
			'results'     => array(),
			'compensated' => $compensated,
		);
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar; we
 * hand it a fresh controller instance so it registers `POST /batch/plan` + `POST /batch/apply` without any
 * edit to the spine `class-registrar.php` / `class-plugin.php`.
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Batch_Controller() );
		}
	}
);
