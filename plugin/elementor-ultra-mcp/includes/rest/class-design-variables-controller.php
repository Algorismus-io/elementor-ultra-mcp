<?php
/**
 * WP-P09 — Design controller (variables + V3 globals + element-defaults + sync + deploy).
 *
 * Contract authority: 10-rest-api.md §4.4 (variables CRUD + batch + watermark + limits), §4.5 (V3 kit
 * colors/fonts), §4.6 (element-defaults), §4.7 (sync-v4-to-v3), §4.8 (deploy all-or-nothing), §0.3 (caps),
 * §0.5/§0.6 (envelopes), §0.8 (op_id), §0.12 (full cache flush); 11-authoring-contract.md §7 (V3 globals
 * binding string formats); 12-error-taxonomy.md §3.3 (BUDGET_EXCEEDED, DUPLICATED_LABEL, WATERMARK_STALE),
 * §3.4 (CAPABILITY_MISSING), §4 (Elementor slug → taxonomy mapping).
 *
 * Routes (Contract 10 §4.4–§4.8):
 *  - `GET    /design/variables`             CAP_READ   — `{variables,total,watermark}`.
 *  - `POST   /design/variables`             CAP_MANAGE — create `{type,label,value}` → `{variable,watermark}`.
 *  - `PUT    /design/variables/{id}`        CAP_MANAGE — update `{label,value,order?,type?}` → `{variable,watermark}`.
 *  - `DELETE /design/variables/{id}`        CAP_MANAGE — soft-delete → `{variable,watermark}`.
 *  - `POST   /design/variables/{id}/restore` CAP_MANAGE — `{label?,value?,type?}` → `{variable,watermark}`.
 *  - `POST   /design/variables/batch`       CAP_MANAGE — `{watermark,operations[]}` → `{variables,watermark,total}`.
 *  - `GET/PUT /design/global-colors`        CAP_READ/CAP_MANAGE — V3 kit `system_colors`/`custom_colors`.
 *  - `GET/PUT /design/global-fonts`         CAP_READ/CAP_MANAGE — V3 kit `system_typography`/`custom_typography`.
 *  - `GET/PUT /design/element-defaults`     CAP_READ/CAP_MANAGE — per-widget kit defaults.
 *  - `POST   /design/sync-v4-to-v3`         CAP_MANAGE — `{variable_id}` → `{success,bridge_var}`.
 *  - `POST   /design/deploy`                CAP_UPDATE_CLASS — `{global_classes,global_variables}` → `{classes,variables}`.
 *
 * All read/write logic lives in {@see \Elementor\Ultra\Core\Variables_Service} (variables + V3 globals) and
 * {@see \Elementor\Ultra\Core\Global_Classes_Service} (reused by `deploy` only). The controller owns the
 * route schemas, cap gates, the post-write cache flush + the op-log row.
 *
 * SPIKE-VERIFIED CORRECTIONS:
 *  - [S07/C6/R2] After EVERY successful write (variables, colors, fonts, defaults, sync, deploy) the
 *    controller flushes CSS in-process via {@see \Elementor\Ultra\Core\Cache_Service::flush_design_system()}
 *    (which empties the whole CSS dir + the kit's own CSS, then asserts the dir is empty — the success
 *    string is NEVER trusted). A non-owner-uid flush is a warning; the write already succeeded.
 *  - The variables watermark is enforced by the service (Elementor's own service omits the staleness check),
 *    so a stale batch returns 409 WATERMARK_STALE.
 *  - `deploy` pre-flights BOTH budgets (classes via WP-P08 `Global_Classes_Service::preflight_budget`,
 *    variables via `Variables_Service::preflight_budget`) BEFORE applying either; on overflow it applies
 *    NEITHER (all-or-nothing).
 *
 * Self-registers with the WP-P02 {@see Registrar} via `elementor_ultra/rest/register` — NEVER edits the
 * spine `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Cache_Service;
use Elementor\Ultra\Core\Global_Classes_Service;
use Elementor\Ultra\Core\Variables_Service;
use Elementor\Ultra\Error_Codes;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The variables + V3 globals + sync + deploy design REST controller (Contract 10 §4.4–§4.8).
 */
final class Design_Variables_Controller extends Abstract_Controller {

	/** Op-log route prefix (mapped to `route` in the audit trail). */
	const OP_ROUTE = 'design';

	/**
	 * Register the §4.4–§4.8 routes (each declares its own `args` schema + `permission_callback`).
	 *
	 * @return void
	 */
	public function register_routes(): void {
		// --- §4.4 Variables -------------------------------------------------
		$this->route(
			'/design/variables',
			WP_REST_Server::READABLE,
			array( $this, 'list_variables' ),
			Permissions::can_read(),
			array(
				'limit'  => $this->limit_arg(),
				'cursor' => array(
					'type'     => 'string',
					'required' => false,
				),
				'fields' => array(
					'type'     => array( 'array', 'string' ),
					'required' => false,
				),
			)
		);

		$this->route(
			'/design/variables',
			WP_REST_Server::CREATABLE,
			array( $this, 'create_variable' ),
			Permissions::can_manage(),
			array(
				'type'  => array(
					'type'     => 'string',
					'required' => true,
				),
				'label' => array(
					'type'     => 'string',
					'required' => true,
				),
				'value' => array(
					'type'     => 'string',
					'required' => true,
				),
				'op_id' => $this->op_id_arg(),
			)
		);

		// NOTE: register `/design/variables/batch` BEFORE the `(?P<id>...)` routes so the literal `batch`
		// segment is matched by the batch handler, not captured as an id by the dynamic pattern (WordPress
		// REST resolves routes in registration order).
		$this->route(
			'/design/variables/batch',
			WP_REST_Server::CREATABLE,
			array( $this, 'batch_variables' ),
			Permissions::can_manage(),
			array(
				'watermark'  => array(
					'type'     => 'integer',
					'required' => true,
					'minimum'  => 0,
				),
				'operations' => array(
					'type'     => 'array',
					'required' => true,
				),
				'op_id'      => $this->op_id_arg(),
			)
		);

		$this->route(
			'/design/variables/(?P<id>[A-Za-z0-9_.-]+)',
			WP_REST_Server::EDITABLE,
			array( $this, 'update_variable' ),
			Permissions::can_manage(),
			array(
				'id'    => $this->id_arg(),
				'label' => array(
					'type'     => 'string',
					'required' => true,
				),
				'value' => array(
					'type'     => 'string',
					'required' => true,
				),
				'order' => array(
					'type'     => 'integer',
					'required' => false,
				),
				'type'  => array(
					'type'     => 'string',
					'required' => false,
				),
				'op_id' => $this->op_id_arg(),
			)
		);

		$this->route(
			'/design/variables/(?P<id>[A-Za-z0-9_.-]+)',
			WP_REST_Server::DELETABLE,
			array( $this, 'delete_variable' ),
			Permissions::can_manage(),
			array(
				'id'    => $this->id_arg(),
				'op_id' => $this->op_id_arg(),
			)
		);

		$this->route(
			'/design/variables/(?P<id>[A-Za-z0-9_.-]+)/restore',
			WP_REST_Server::CREATABLE,
			array( $this, 'restore_variable' ),
			Permissions::can_manage(),
			array(
				'id'    => $this->id_arg(),
				'label' => array(
					'type'     => 'string',
					'required' => false,
				),
				'value' => array(
					'type'     => 'string',
					'required' => false,
				),
				'type'  => array(
					'type'     => 'string',
					'required' => false,
				),
				'op_id' => $this->op_id_arg(),
			)
		);

		// --- §4.5 Global colors / fonts ------------------------------------
		$this->route(
			'/design/global-colors',
			WP_REST_Server::READABLE,
			array( $this, 'get_global_colors' ),
			Permissions::can_read()
		);
		$this->route(
			'/design/global-colors',
			WP_REST_Server::EDITABLE,
			array( $this, 'put_global_colors' ),
			Permissions::can_manage(),
			array(
				'system_colors' => array(
					'type'     => 'array',
					'required' => false,
				),
				'custom_colors' => array(
					'type'     => 'array',
					'required' => false,
				),
				'op_id'         => $this->op_id_arg(),
			)
		);

		$this->route(
			'/design/global-fonts',
			WP_REST_Server::READABLE,
			array( $this, 'get_global_fonts' ),
			Permissions::can_read()
		);
		$this->route(
			'/design/global-fonts',
			WP_REST_Server::EDITABLE,
			array( $this, 'put_global_fonts' ),
			Permissions::can_manage(),
			array(
				'system_typography' => array(
					'type'     => 'array',
					'required' => false,
				),
				'custom_typography' => array(
					'type'     => 'array',
					'required' => false,
				),
				'op_id'             => $this->op_id_arg(),
			)
		);

		// --- §4.6 Element defaults -----------------------------------------
		$this->route(
			'/design/element-defaults',
			WP_REST_Server::READABLE,
			array( $this, 'get_element_defaults' ),
			Permissions::can_read()
		);
		$this->route(
			'/design/element-defaults',
			WP_REST_Server::EDITABLE,
			array( $this, 'put_element_defaults' ),
			Permissions::can_manage(),
			array(
				'type'     => array(
					'type'     => 'string',
					'required' => true,
				),
				'settings' => array(
					'type'     => 'object',
					'required' => true,
				),
				'op_id'    => $this->op_id_arg(),
			)
		);

		// --- §4.7 Sync v4 -> v3 --------------------------------------------
		$this->route(
			'/design/sync-v4-to-v3',
			WP_REST_Server::CREATABLE,
			array( $this, 'sync_v4_to_v3' ),
			Permissions::can_manage(),
			array(
				'variable_id' => array(
					'type'     => 'string',
					'required' => true,
				),
				'op_id'       => $this->op_id_arg(),
			)
		);

		// --- §4.8 Deploy ---------------------------------------------------
		$this->route(
			'/design/deploy',
			WP_REST_Server::CREATABLE,
			array( $this, 'deploy' ),
			Permissions::can_update_class(),
			array(
				'global_classes'   => array(
					'type'     => 'object',
					'required' => false,
				),
				'global_variables' => array(
					'type'     => 'object',
					'required' => false,
				),
				'op_id'            => $this->op_id_arg(),
			)
		);
	}

	// =====================================================================
	// §4.4 Variables.
	// =====================================================================

	/**
	 * `GET /design/variables` (Contract 10 §4.4). Returns `{variables,total,watermark}`. `variables` is the
	 * full id-keyed map (objects, not paginated array) so the agent can build a watermark-correct batch.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function list_variables( WP_REST_Request $request ) {
		unset( $request );

		$result = $this->variables()->list();
		if ( $result instanceof WP_Error ) {
			return $result;
		}

		return $this->ok(
			array(
				'variables' => (object) $result['variables'], // Force an object so an empty map serializes as an object, not an array.
				'total'     => (int) $result['total'],
				'watermark' => (int) $result['watermark'],
			)
		);
	}

	/**
	 * `POST /design/variables` (Contract 10 §4.4). Create `{type,label,value}` → `{variable,watermark}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function create_variable( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$result = $this->variables()->create(
			array(
				'type'  => (string) $request->get_param( 'type' ),
				'label' => (string) $request->get_param( 'label' ),
				'value' => (string) $request->get_param( 'value' ),
			)
		);
		if ( $result instanceof WP_Error ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$warnings = $this->flush( $op_id, $request, 'variables/create', $result );

		return $this->variable_response( $result, $warnings );
	}

	/**
	 * `PUT /design/variables/{id}` (Contract 10 §4.4). Update `{label,value,order?,type?}` (label+value
	 * REQUIRED) → `{variable,watermark}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function update_variable( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$data  = array(
			'label' => (string) $request->get_param( 'label' ),
			'value' => (string) $request->get_param( 'value' ),
		);
		$order = $request->get_param( 'order' );
		if ( null !== $order ) {
			$data['order'] = (int) $order;
		}
		$type = $request->get_param( 'type' );
		if ( null !== $type && '' !== (string) $type ) {
			$data['type'] = (string) $type;
		}

		$result = $this->variables()->update( (string) $request->get_param( 'id' ), $data );
		if ( $result instanceof WP_Error ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$warnings = $this->flush( $op_id, $request, 'variables/update', $result );

		return $this->variable_response( $result, $warnings );
	}

	/**
	 * `DELETE /design/variables/{id}` (Contract 10 §4.4). Soft-delete → `{variable,watermark}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function delete_variable( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$result = $this->variables()->delete( (string) $request->get_param( 'id' ) );
		if ( $result instanceof WP_Error ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$warnings = $this->flush( $op_id, $request, 'variables/delete', $result );

		return $this->variable_response( $result, $warnings );
	}

	/**
	 * `POST /design/variables/{id}/restore` (Contract 10 §4.4). Restore `{label?,value?,type?}` →
	 * `{variable,watermark}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function restore_variable( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$overrides = array();
		foreach ( array( 'label', 'value', 'type' ) as $field ) {
			$value = $request->get_param( $field );
			if ( null !== $value && '' !== (string) $value ) {
				$overrides[ $field ] = (string) $value;
			}
		}

		$result = $this->variables()->restore( (string) $request->get_param( 'id' ), $overrides );
		if ( $result instanceof WP_Error ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$warnings = $this->flush( $op_id, $request, 'variables/restore', $result );

		return $this->variable_response( $result, $warnings );
	}

	/**
	 * `POST /design/variables/batch` (Contract 10 §4.4). Atomic multi-op with REQUIRED `watermark`; a stale
	 * watermark fails the whole batch → 409 `WATERMARK_STALE`; a per-id failure → the §4.4 batch-error
	 * shape. On success → `{variables,watermark,total}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function batch_variables( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$watermark  = (int) $request->get_param( 'watermark' );
		$operations = $request->get_param( 'operations' );
		if ( ! is_array( $operations ) || empty( $operations ) ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'operations is required and must be a non-empty array.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'operations' ),
				array(),
				$op_id
			);
		}

		$result = $this->variables()->batch( $watermark, $operations );
		if ( $result instanceof WP_Error ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$warnings = $this->flush( $op_id, $request, 'variables/batch', $result );

		$data = array(
			'variables' => (object) $result['variables'],
			'watermark' => (int) $result['watermark'],
			'total'     => (int) $result['total'],
		);
		if ( ! empty( $warnings ) ) {
			$data['warnings'] = array_values( $warnings );
		}

		return $this->ok( $data );
	}

	// =====================================================================
	// §4.5 Global colors / fonts.
	// =====================================================================

	/**
	 * `GET /design/global-colors` (Contract 10 §4.5).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_global_colors( WP_REST_Request $request ) {
		unset( $request );
		$result = $this->variables()->get_global_colors();
		return $result instanceof WP_Error ? $result : $this->ok( $result );
	}

	/**
	 * `PUT /design/global-colors` (Contract 10 §4.5). Deep-merges colors by `_id` and flushes.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function put_global_colors( WP_REST_Request $request ) {
		return $this->put_repeater_route(
			$request,
			array( 'system_colors', 'custom_colors' ),
			'put_global_colors',
			'global-colors'
		);
	}

	/**
	 * `GET /design/global-fonts` (Contract 10 §4.5).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_global_fonts( WP_REST_Request $request ) {
		unset( $request );
		$result = $this->variables()->get_global_fonts();
		return $result instanceof WP_Error ? $result : $this->ok( $result );
	}

	/**
	 * `PUT /design/global-fonts` (Contract 10 §4.5). Deep-merges typography by `_id` and flushes.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function put_global_fonts( WP_REST_Request $request ) {
		return $this->put_repeater_route(
			$request,
			array( 'system_typography', 'custom_typography' ),
			'put_global_fonts',
			'global-fonts'
		);
	}

	// =====================================================================
	// §4.6 Element defaults.
	// =====================================================================

	/**
	 * `GET /design/element-defaults` (Contract 10 §4.6).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_element_defaults( WP_REST_Request $request ) {
		unset( $request );
		$result = $this->variables()->get_element_defaults();
		if ( $result instanceof WP_Error ) {
			return $result;
		}
		return $this->ok( array( 'defaults' => (object) $result['defaults'] ) );
	}

	/**
	 * `PUT /design/element-defaults` (Contract 10 §4.6). Writes `{type,settings}` into the kit's per-widget
	 * defaults and flushes.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function put_element_defaults( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$type     = (string) $request->get_param( 'type' );
		$settings = $request->get_param( 'settings' );
		$settings = is_array( $settings ) ? $settings : array();

		$result = $this->variables()->put_element_defaults( $type, $settings );
		if ( $result instanceof WP_Error ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$warnings = $this->flush( $op_id, $request, 'element-defaults', $result );

		$data = array( 'defaults' => (object) $result['defaults'] );
		if ( ! empty( $warnings ) ) {
			$data['warnings'] = array_values( $warnings );
		}

		return $this->ok( $data );
	}

	// =====================================================================
	// §4.7 Sync v4 -> v3.
	// =====================================================================

	/**
	 * `POST /design/sync-v4-to-v3` (Contract 10 §4.7). Flags `sync_to_v3` + returns the bridge var, then
	 * flushes (so the bridge stylesheet regenerates).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function sync_v4_to_v3( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$result = $this->variables()->sync_v4_to_v3( (string) $request->get_param( 'variable_id' ) );
		if ( $result instanceof WP_Error ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$warnings = $this->flush( $op_id, $request, 'sync-v4-to-v3', $result );

		$data = array(
			'success'    => (bool) $result['success'],
			'bridge_var' => (string) $result['bridge_var'],
		);
		if ( ! empty( $warnings ) ) {
			$data['warnings'] = array_values( $warnings );
		}

		return $this->ok( $data );
	}

	// =====================================================================
	// §4.8 Deploy.
	// =====================================================================

	/**
	 * `POST /design/deploy` (Contract 10 §4.8). All-or-nothing combined apply of classes + variables. Pre-
	 * flights BOTH budgets BEFORE applying either; on overflow applies NEITHER → 422 `BUDGET_EXCEEDED`.
	 * Then applies classes (WP-P08 `apply_diff`) then variables (`batch`), captures the soft `modified_labels`,
	 * flushes ONCE, and returns `{classes:{ok,modified_labels},variables:{watermark}}`. Requires UPDATE_CLASS.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function deploy( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$classes_in   = $request->get_param( 'global_classes' );
		$variables_in = $request->get_param( 'global_variables' );
		$classes_in   = is_array( $classes_in ) ? $classes_in : array();
		$variables_in = is_array( $variables_in ) ? $variables_in : array();

		$has_classes   = ! empty( $classes_in );
		$has_variables = ! empty( $variables_in );

		if ( ! $has_classes && ! $has_variables ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'deploy requires at least one of global_classes or global_variables.', 'elementor-ultra-mcp' ),
				400,
				array(),
				array(),
				$op_id
			);
		}

		$classes_service   = $this->classes();
		$variables_service = $this->variables();

		// --- Budget pre-flight for BOTH before applying EITHER (all-or-nothing). ---
		if ( $has_classes ) {
			$classes_budget = $classes_service->preflight_budget( $this->classes_diff_body( $classes_in ) );
			if ( $classes_budget instanceof WP_Error ) {
				return $this->attach_op_id( $classes_budget, $op_id );
			}
		}

		$variable_operations = array();
		$variable_watermark  = 0;
		if ( $has_variables ) {
			$variable_operations = isset( $variables_in['operations'] ) && is_array( $variables_in['operations'] )
				? $variables_in['operations']
				: array();
			$variable_watermark  = isset( $variables_in['watermark'] ) ? (int) $variables_in['watermark'] : 0;

			$variables_budget = $variables_service->preflight_budget( $variable_operations );
			if ( $variables_budget instanceof WP_Error ) {
				return $this->attach_op_id( $variables_budget, $op_id );
			}
		}

		// --- Apply classes first (the budget pre-flight already guaranteed both fit). ---
		$classes_result = array(
			'ok'              => true,
			'modified_labels' => array(),
		);
		if ( $has_classes ) {
			$applied = $classes_service->apply_diff( $this->classes_diff_body( $classes_in, $op_id ) );
			if ( $applied instanceof WP_Error ) {
				return $this->attach_op_id( $applied, $op_id );
			}
			$classes_result = array(
				'ok'              => true,
				'modified_labels' => isset( $applied['modified_labels'] ) ? (array) $applied['modified_labels'] : array(),
			);
		}

		// --- Then apply variables. ---
		$variables_result = array( 'watermark' => $variable_watermark );
		if ( $has_variables ) {
			$applied_vars = $variables_service->batch( $variable_watermark, $variable_operations );
			if ( $applied_vars instanceof WP_Error ) {
				// Classes already applied; surface the variables failure (the caller can re-read + retry vars).
				return $this->attach_op_id( $applied_vars, $op_id );
			}
			$variables_result = array( 'watermark' => (int) $applied_vars['watermark'] );
		}

		// --- Single full flush after the combined apply (Contract 10 §0.12). ---
		$warnings = $this->flush( $op_id, $request, 'deploy', array() );

		$data = array(
			'classes'   => array(
				'ok'              => (bool) $classes_result['ok'],
				'modified_labels' => (object) $classes_result['modified_labels'],
			),
			'variables' => array(
				'watermark' => (int) $variables_result['watermark'],
			),
		);
		if ( ! empty( $warnings ) ) {
			$data['warnings'] = array_values( $warnings );
		}

		return $this->ok( $data );
	}

	// =====================================================================
	// Internals.
	// =====================================================================

	/** The variables + V3 globals service (single home of that logic). */
	private function variables(): Variables_Service {
		return new Variables_Service();
	}

	/** The WP-P08 global-classes service (reused by deploy only — NEVER edits WP-P08's files). */
	private function classes(): Global_Classes_Service {
		return new Global_Classes_Service();
	}

	/** The shared cache service (post-write design-system flush). */
	private function cache(): Cache_Service {
		return new Cache_Service();
	}

	/**
	 * Shared `PUT /design/global-*` handler: reads the repeater patch, delegates the `_id`-aware deep merge
	 * to the service, flushes, and echoes the merged repeaters (+ any flush warnings).
	 *
	 * @param WP_REST_Request $request      The current request.
	 * @param string[]        $repeaters    The repeater keys this route may touch.
	 * @param string          $service_call The Variables_Service write method.
	 * @param string          $op_route     The op-log route label.
	 * @return WP_REST_Response|WP_Error
	 */
	private function put_repeater_route( WP_REST_Request $request, array $repeaters, string $service_call, string $op_route ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$patch = array();
		foreach ( $repeaters as $key ) {
			$value = $request->get_param( $key );
			if ( is_array( $value ) ) {
				$patch[ $key ] = $value;
			}
		}

		if ( empty( $patch ) ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				sprintf(
					/* translators: %s: the comma-separated repeater keys. */
					__( 'At least one of %s is required (an array of repeater items).', 'elementor-ultra-mcp' ),
					implode( ', ', $repeaters )
				),
				400,
				array( 'expected' => $repeaters ),
				array(),
				$op_id
			);
		}

		$result = $this->variables()->{$service_call}( $patch );
		if ( $result instanceof WP_Error ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$warnings = $this->flush( $op_id, $request, $op_route, $result );

		if ( ! empty( $warnings ) ) {
			$result['warnings'] = array_values( $warnings );
		}

		return $this->ok( $result );
	}

	/**
	 * Build the §4.2 diff-PUT body the WP-P08 service expects from a deploy `global_classes` block. The
	 * deploy block follows the §4.2 shape (`{added,modified,deleted,items,order}`); we reshape it into the
	 * `{context,changes:{added,deleted,modified,order},items,order,op_id}` body `apply_diff`/`preflight_budget`
	 * consume.
	 *
	 * @param array<string,mixed> $classes_in The deploy `global_classes` block.
	 * @param string|null         $op_id      Optional op id to thread through.
	 * @return array<string,mixed>
	 */
	private function classes_diff_body( array $classes_in, ?string $op_id = null ): array {
		$changes = isset( $classes_in['changes'] ) && is_array( $classes_in['changes'] )
			? $classes_in['changes']
			: array(
				'added'    => isset( $classes_in['added'] ) ? $classes_in['added'] : array(),
				'deleted'  => isset( $classes_in['deleted'] ) ? $classes_in['deleted'] : array(),
				'modified' => isset( $classes_in['modified'] ) ? $classes_in['modified'] : array(),
				'order'    => isset( $classes_in['order'] ) ? true : false,
			);

		return array(
			'context' => Global_Classes_Service::CONTEXT_FRONTEND,
			'changes' => $changes,
			'items'   => isset( $classes_in['items'] ) && is_array( $classes_in['items'] ) ? $classes_in['items'] : array(),
			'order'   => isset( $classes_in['order'] ) && is_array( $classes_in['order'] ) ? $classes_in['order'] : array(),
			'op_id'   => $op_id,
		);
	}

	/**
	 * Run the post-write full design-system flush (Contract 10 §0.12; [S07/C6/R2]) + record the op-log row.
	 * Returns any flush warnings (empty on full success). The write already succeeded before this runs —
	 * a non-owner-uid flush is a warning, never a failure.
	 *
	 * @param string|null         $op_id    The request op id.
	 * @param WP_REST_Request     $request  The current request.
	 * @param string              $op_route The op-log route label.
	 * @param array<string,mixed> $result   The service result (for the op-log after-state summary).
	 * @return string[]
	 */
	private function flush( ?string $op_id, WP_REST_Request $request, string $op_route, array $result ): array {
		$warnings = array();

		$flushed = $this->flush_design_system();
		if ( false === $flushed ) {
			$warnings[] = 'Design-system CSS flush did not confirm the CSS dir is empty (uid mismatch?). The write succeeded; CSS may regenerate on next visit (S07/R2).';
		}

		$this->record_op( $op_id, $request, $op_route, $result );

		return $warnings;
	}

	/**
	 * Run the full design-system flush (Contract 10 §0.12). Returns the assertion result (true = CSS dir
	 * confirmed empty) or false when the service is unavailable / a non-owner uid left stale files.
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
	 * Record a write in the WP-P14 op-log store (best-effort; a logging fault NEVER fails the write).
	 *
	 * @param string|null         $op_id    The request op id.
	 * @param WP_REST_Request     $request  The current request (acting user resolved by Op_Log).
	 * @param string              $op_route The op-log route label.
	 * @param array<string,mixed> $result   The service result (for the after-state summary).
	 * @return void
	 */
	private function record_op( ?string $op_id, WP_REST_Request $request, string $op_route, array $result ): void {
		unset( $request );
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
					'route'  => self::OP_ROUTE . '/' . $op_route,
					'result' => 'ok',
					'meta'   => array(
						'watermark' => isset( $result['watermark'] ) ? (int) $result['watermark'] : null,
					),
				)
			);
		} catch ( \Throwable $e ) {
			unset( $e ); // Op-log is best-effort.
		}
	}

	/**
	 * Wrap a single-variable result into the §4.4 `{variable,watermark}` response (+ optional warnings).
	 *
	 * @param array<string,mixed> $result   The service result.
	 * @param string[]            $warnings Flush warnings (empty on success).
	 * @return WP_REST_Response
	 */
	private function variable_response( array $result, array $warnings ): WP_REST_Response {
		$data = array(
			'variable'  => (object) ( isset( $result['variable'] ) ? (array) $result['variable'] : array() ),
			'watermark' => isset( $result['watermark'] ) ? (int) $result['watermark'] : 0,
		);
		if ( ! empty( $warnings ) ) {
			$data['warnings'] = array_values( $warnings );
		}
		return $this->ok( $data );
	}

	/**
	 * Echo the request `op_id` into an error envelope's `data` block (§0.8) so the agent can correlate.
	 *
	 * @param WP_Error    $error The taxonomy error.
	 * @param string|null $op_id The request op id.
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

	/** The shared `limit` arg schema (§0.11). */
	private function limit_arg(): array {
		return array(
			'type'     => 'integer',
			'required' => false,
			'default'  => 25,
			'minimum'  => 1,
			'maximum'  => 100,
		);
	}

	/** The shared `op_id` arg schema (§0.8). */
	private function op_id_arg(): array {
		return array(
			'type'     => 'string',
			'required' => false,
		);
	}

	/** The shared `{id}` path arg schema. */
	private function id_arg(): array {
		return array(
			'type'     => 'string',
			'required' => true,
		);
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar; we
 * hand it a fresh controller instance so it registers the §4.4–§4.8 routes WITHOUT editing the spine
 * `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Design_Variables_Controller() );
		}
	}
);
