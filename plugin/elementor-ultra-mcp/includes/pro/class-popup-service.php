<?php
/**
 * WP-R02 — Popup_Service: create a Pro popup doc + its three storage buckets, and merge display settings.
 *
 * Contract authority:
 *  - 10-rest-api.md §8 (Pro intro + ConditionTuple), §8.4 (`POST /pro/popup`,
 *    `PUT /pro/popup/{id}/display`), §0.8 (op_id), §0.9 (dry-run-before-commit),
 *    §0.10 (atomic CSS prime flag).
 *  - 12-error-taxonomy.md §3 (`SCHEMA_INVALID_PARAMS`, `ATOMIC_SETTINGS_INVALID`, `NOT_FOUND`,
 *    `NOT_EDITABLE`, `PRO_REQUIRED`).
 *  - SUPPLEMENT.md §A.2 (three storage buckets + full display/layout object), §A.7 (`pro.popup.create`
 *    behaviour; default condition `[["include","general"]]`).
 *
 * Elementor Pro APIs (cited `path:line` relative to plugins/elementor-pro, verified live on this site):
 *  - `Modules\Popup\Document extends Theme_Section_Document` — popup/document.php:20; `get_type()='popup'`
 *    — popup/document.php:29. Registered as document type `'popup'` via
 *    `register_document_type('popup', Document::class)` — popup/module.php:31,200.
 *  - `DISPLAY_SETTINGS_META_KEY = '_elementor_popup_display_settings'` — popup/document.php:22.
 *  - `save_display_settings_data($data)` -> `update_main_meta(DISPLAY_SETTINGS_META_KEY,$data)`
 *    — popup/document.php:115-116; getter `get_display_settings_data()` -> `get_main_meta(...)`
 *    — popup/document.php:111-112. This is a PLAIN meta write (no conditions/cache regen).
 *  - Popup location `popup` is `multiple=true` — popup/module.php:208-212 (NO conflict detection;
 *    unlike WP-R01 theme docs).
 *  - Frontend triggers only emit when the popup matches its `popup`-location conditions
 *    — popup/document.php:119-132 (a popup with display settings but no condition never auto-opens) —
 *    hence the SUPPLEMENT §A.7 default condition `[["include","general"]]`.
 *
 * Pipeline reuse (the parallelism principle — consumed, never reimplemented):
 *  - Pro presence: {@see Pro_Gate::require_pro()} (WP-R01) — 501 `PRO_REQUIRED` when Pro absent.
 *  - Element-tree validity: {@see \Elementor\Ultra\Validator::dry_run()} (WP-P03) — fail -> 422 +
 *    compensating delete of the orphan draft.
 *  - Layout `elements`/`layout_settings` persist via the SAME transactional
 *    {@see \Elementor\Ultra\Core\Document_Writer::save()} (WP-P04) as `/documents/{id}/save`
 *    (backup-before-write, base_hash, lock/autosave, CSS prime) — `layout_settings` -> the writer's
 *    `settings` path -> `_elementor_page_settings` (NEVER through `save_display_settings_data()`).
 *  - Conditions: {@see Conditions_Helper::save()} (WP-R01) at location `popup` (slash strings +
 *    `cache->regenerate()`; writing `_elementor_conditions` raw is FORBIDDEN).
 *  - Display settings shape: {@see Display_Settings_Helper} (validate/flatten/merge/group).
 *
 * Route registration: the {@see \Elementor\Ultra\Rest\Pro_Controller} (WP-R01) already lists
 * `\Elementor\Ultra\Pro\Popup_Service` in its `SIBLING_SERVICES`; it autoloads this class (SPL
 * autoloader, `includes/pro/class-popup-service.php`) and merges this `routes()` array into the live
 * `/pro/*` table on `rest_api_init`. This service therefore NEVER edits the controller — it only exposes
 * a public `routes(): array` (FROZEN descriptor shape).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

use Elementor\Ultra\Core\Document_Writer;
use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Rest\Permissions;
use Elementor\Ultra\Rest\Response;
use Elementor\Ultra\Validator;
use WP_Error;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Popup document + display-settings service. The {@see Pro_Controller} owns route registration; this
 * class returns its route descriptors via {@see routes()} and holds ALL popup business logic.
 */
final class Popup_Service {

	/** The popup document type slug (popup/module.php:31; `get_type()` — popup/document.php:29). */
	const POPUP_TYPE = 'popup';

	/** The display-settings meta key (popup/document.php:22). Echoed in the create response. */
	const DISPLAY_SETTINGS_META_KEY = '_elementor_popup_display_settings';

	/** The default condition so the popup can actually auto-trigger (SUPPLEMENT §A.7). */
	const DEFAULT_CONDITIONS = array( array( 'include', 'general' ) );

	/** Op-log route label for `POST /pro/popup`. */
	const OP_ROUTE_CREATE = 'pro/popup';

	/** Op-log route label for `PUT /pro/popup/{id}/display`. */
	const OP_ROUTE_DISPLAY = 'pro/popup/display';

	/**
	 * The two popup route descriptors (10-rest-api.md §8.4) in the FROZEN sibling-service shape the
	 * {@see Pro_Controller} expects:
	 *   `[ 'methods'=>WP_REST_Server::*, 'route'=>'/pro/...', 'callback'=>callable,
	 *      'permission_callback'=>callable, 'args'=>array ]`.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public function routes(): array {
		return array(
			// POST /pro/popup — CAP_EDIT_POST (create => edit_posts).
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'route'               => '/pro/popup',
				'callback'            => array( $this, 'create' ),
				'permission_callback' => Permissions::can_edit_post(),
				'args'                => array(
					'title'            => array(
						'type'     => 'string',
						'required' => false,
						'default'  => '',
					),
					'status'           => array(
						'type'     => 'string',
						'required' => false,
						'default'  => 'publish',
					),
					'elements'         => array(
						'type'     => 'array',
						'required' => false,
					),
					'layout_settings'  => array(
						'type'        => 'object',
						'required'    => false,
						'description' => 'Popup layout/style settings -> _elementor_page_settings (SUPPLEMENT §A.2).',
					),
					'display_settings' => array(
						'type'        => 'object',
						'required'    => false,
						'description' => '{triggers?:{...},timing?:{...}} -> _elementor_popup_display_settings (SUPPLEMENT §A.2).',
					),
					'conditions'       => array(
						'type'        => 'array',
						'required'    => false,
						'description' => 'ConditionTuple[]; defaults to [["include","general"]] so the popup auto-triggers.',
					),
					'prime_css'        => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'op_id'            => array(
						'type'     => 'string',
						'required' => false,
					),
				),
			),
			// PUT /pro/popup/{id}/display — CAP_EDIT_POST (merge triggers/timing).
			array(
				'methods'             => WP_REST_Server::EDITABLE,
				'route'               => '/pro/popup/(?P<id>\d+)/display',
				'callback'            => array( $this, 'set_display' ),
				'permission_callback' => Permissions::can_edit_post(),
				'args'                => array(
					'id'       => array(
						'type'              => 'integer',
						'required'          => true,
						'minimum'           => 1,
						'sanitize_callback' => 'absint',
					),
					'triggers' => array(
						'type'     => 'object',
						'required' => false,
					),
					'timing'   => array(
						'type'     => 'object',
						'required' => false,
					),
					'op_id'    => array(
						'type'     => 'string',
						'required' => false,
					),
				),
			),
		);
	}

	/**
	 * `POST /pro/popup` (10-rest-api.md §8.4; SUPPLEMENT §A.2/§A.7). Behaviour order (ticket Detailed-Req
	 * #1): Pro gate -> create popup doc -> validate optional `elements` (fail => 422 + delete orphan) ->
	 * persist `layout_settings`+`elements` via the writer -> store `display_settings` via
	 * `save_display_settings_data()` -> save conditions (default `include/general`) -> op-log.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function create( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		// (a) Pro presence (501 PRO_REQUIRED when absent) — first line of every /pro/* handler.
		$gate = Pro_Gate::require_pro( $op_id );
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		// Validate the display-settings shape BEFORE creating anything (so a bad shape never orphans a draft).
		$display = $request->get_param( 'display_settings' );
		$display = is_array( $display ) ? $display : array();
		if ( array() !== $display ) {
			$display_check = Display_Settings_Helper::validate( $display );
			if ( $display_check instanceof WP_Error ) {
				return self::attach_op_id( $display_check, $op_id );
			}
		}

		// Validate conditions shape (when supplied) BEFORE creating anything.
		$conditions = $request->get_param( 'conditions' );
		$conditions = is_array( $conditions ) ? $conditions : null;
		if ( null !== $conditions ) {
			$cond_check = Conditions_Helper::validate( $conditions );
			if ( $cond_check instanceof WP_Error ) {
				return self::attach_op_id( $cond_check, $op_id );
			}
		}

		$documents = self::documents_manager();
		if ( null === $documents ) {
			return Response::error( Error_Codes::UPSTREAM_ERROR, __( 'Elementor documents manager is unavailable.', 'elementor-ultra-mcp' ), 502, array(), array(), $op_id );
		}

		$title  = (string) $request->get_param( 'title' );
		$status = (string) $request->get_param( 'status' );
		$status = '' !== $status ? $status : 'publish';

		// (b) create the popup doc (documents-manager.php create() resolves the registered 'popup' type).
		$document = $documents->create(
			self::POPUP_TYPE,
			array(
				'post_title'  => '' !== $title ? $title : __( 'Popup', 'elementor-ultra-mcp' ),
				'post_status' => $status,
			)
		);

		if ( is_wp_error( $document ) ) {
			return \Elementor\Ultra\Core\Error::from_wp_error( $document );
		}
		if ( ! is_object( $document ) || ! method_exists( $document, 'get_main_id' ) ) {
			return Response::error( Error_Codes::INTERNAL_ERROR, __( 'Popup document creation returned an unexpected result.', 'elementor-ultra-mcp' ), 500, array(), array(), $op_id );
		}

		$post_id = (int) $document->get_main_id();

		$elements        = $request->get_param( 'elements' );
		$layout_settings = $request->get_param( 'layout_settings' );
		$layout_settings = is_array( $layout_settings ) ? $layout_settings : array();
		$prime_css       = (bool) $request->get_param( 'prime_css' );
		$has_elements    = is_array( $elements ) && array() !== $elements;

		$prime_required = false;
		$css_primed     = false;

		// (c) validate the atomic tree FIRST; on failure DELETE the draft (compensation) — no orphan.
		if ( $has_elements ) {
			$verdict = Validator::dry_run( $elements, $layout_settings, 0 );
			if ( empty( $verdict['valid'] ) ) {
				wp_delete_post( $post_id, true ); // Compensating delete (force — no trash).
				$errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
				return Response::error(
					Error_Codes::ATOMIC_SETTINGS_INVALID,
					sprintf(
						/* translators: %d: error count. */
						_n( 'The popup element tree failed validation (%d error); the draft was removed.', 'The popup element tree failed validation (%d errors); the draft was removed.', count( $errors ), 'elementor-ultra-mcp' ),
						count( $errors )
					),
					422,
					array( 'compensated' => true ),
					$errors,
					$op_id
				);
			}
		}

		// (d) persist elements + layout_settings via the SAME transactional writer as /documents/{id}/save.
		// layout_settings is a NORMAL page setting -> _elementor_page_settings (NOT display settings).
		if ( $has_elements || array() !== $layout_settings ) {
			$write_args = array(
				'op_id'     => $op_id,
				'prime_css' => $prime_css,
				'backup'    => true,
			);
			if ( $has_elements ) {
				$write_args['elements'] = $elements;
			}
			if ( array() !== $layout_settings ) {
				$write_args['settings'] = $layout_settings;
			}

			$result = Document_Writer::save( $post_id, $write_args );
			if ( is_wp_error( $result ) ) {
				wp_delete_post( $post_id, true ); // Compensating delete — a save failure leaves no orphan.
				return $result;
			}
			$prime_required = ! empty( $result['prime_required'] );
			$css_primed     = ! empty( $result['css_primed'] );
		}

		// (e) display settings (triggers + timing) -> _elementor_popup_display_settings (flat assoc).
		$unverified_keys  = array();
		$display_warnings = array();
		if ( array() !== $display ) {
			$flat = Display_Settings_Helper::flatten( $display );
			// Re-resolve the popup document (post-save) and persist via the popup-specific meta write.
			$popup_doc = self::popup_document( $post_id );
			if ( null === $popup_doc ) {
				wp_delete_post( $post_id, true );
				return Response::error( Error_Codes::UPSTREAM_ERROR, __( 'The created document is not a popup document.', 'elementor-ultra-mcp' ), 502, array(), array(), $op_id );
			}
			$popup_doc->save_display_settings_data( $flat ); // popup/document.php:115-116 (plain meta write).
			$unverified_keys  = Display_Settings_Helper::unverified_keys( $flat );
			$display_warnings = Display_Settings_Helper::warnings( $flat );
		}

		// (f) conditions (default include/general so the popup auto-triggers — SUPPLEMENT §A.7). Saved via
		// the helper at location `popup` (multiple=true => no conflict detection). Always saved so the
		// conditions cache regenerates (save_display_settings_data() does NOT regen — ticket Impl-Notes).
		$tuples            = ( null !== $conditions ) ? $conditions : self::DEFAULT_CONDITIONS;
		$saved             = Conditions_Helper::save( $post_id, $tuples );
		$conditions_stored = array();
		$cond_warnings     = array();
		$unverified_names  = array();
		if ( is_wp_error( $saved ) ) {
			return self::attach_op_id( $saved, $op_id );
		}
		$conditions_stored = $saved['conditions_stored'];
		$unverified_names  = $saved['unverified_names'];
		$cond_warnings     = $saved['warnings'];

		self::op_log( $post_id, $op_id, self::OP_ROUTE_CREATE );

		$data     = array(
			'post_id'               => $post_id,
			'edit_url'              => self::edit_url( $document, $post_id ),
			'display_settings_meta' => self::DISPLAY_SETTINGS_META_KEY,
			'conditions_stored'     => $conditions_stored,
			'prime_required'        => $prime_required,
			'css_primed'            => $css_primed,
		);
		$meta     = array();
		$warnings = array_values( array_merge( $display_warnings, $cond_warnings ) );
		if ( array() !== $unverified_keys ) {
			$meta['unverified_keys'] = $unverified_keys;
		}
		if ( array() !== $unverified_names ) {
			$meta['unverified_names'] = $unverified_names;
		}
		if ( array() !== $meta ) {
			$data['meta'] = $meta;
		}
		if ( array() !== $warnings ) {
			$data['warnings'] = $warnings;
		}

		return Response::success( $data, 201 );
	}

	/**
	 * `PUT /pro/popup/{id}/display` (10-rest-api.md §8.4). MERGES the `{triggers?,timing?}` patch into the
	 * existing `_elementor_popup_display_settings`, then `save_display_settings_data()`. Asserts the target
	 * is a popup (`get_type()==='popup'`) else 422 with `data.meta.actual_type` (404 when not a doc).
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function set_display( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$gate = Pro_Gate::require_pro( $op_id );
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		$post_id = (int) $request['id'];

		// 404 when the post does not exist / is not an Elementor document at all.
		$document = self::any_document( $post_id );
		if ( null === $document ) {
			return Response::error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %d: post id. */
					__( 'Document %d was not found.', 'elementor-ultra-mcp' ),
					$post_id
				),
				404,
				array( 'post_id' => $post_id ),
				array(),
				$op_id
			);
		}

		// 422 when the target IS a doc but NOT a popup (data.meta.actual_type — ticket Detailed-Req #8).
		$actual_type = (string) ( method_exists( $document, 'get_type' ) ? $document->get_type() : '' );
		if ( self::POPUP_TYPE !== $actual_type ) {
			return Response::error(
				Error_Codes::ATOMIC_SETTINGS_INVALID,
				sprintf(
					/* translators: 1: post id, 2: actual doc type. */
					__( 'Document %1$d is a "%2$s", not a popup; the display route only targets popups.', 'elementor-ultra-mcp' ),
					$post_id,
					$actual_type
				),
				422,
				array(
					'post_id'     => $post_id,
					'actual_type' => $actual_type,
				),
				array(),
				$op_id
			);
		}

		// Assemble the request patch in the {triggers?,timing?} shape, validate, flatten.
		$patch_request = array();
		$triggers      = $request->get_param( 'triggers' );
		$timing        = $request->get_param( 'timing' );
		if ( is_array( $triggers ) ) {
			$patch_request[ Display_Settings_Helper::GROUP_TRIGGERS ] = $triggers;
		}
		if ( is_array( $timing ) ) {
			$patch_request[ Display_Settings_Helper::GROUP_TIMING ] = $timing;
		}

		$display_check = Display_Settings_Helper::validate( $patch_request );
		if ( $display_check instanceof WP_Error ) {
			return self::attach_op_id( $display_check, $op_id );
		}

		// MERGE: existing (already flat) <- flattened patch. save_display_settings_data() (plain meta write).
		$existing = $document->get_display_settings_data(); // popup/document.php:111-112.
		$existing = is_array( $existing ) ? $existing : array();
		$patch    = Display_Settings_Helper::flatten( $patch_request );
		$merged   = Display_Settings_Helper::merge( $existing, $patch );

		$document->save_display_settings_data( $merged ); // popup/document.php:115-116.

		self::op_log( $post_id, $op_id, self::OP_ROUTE_DISPLAY );

		// Re-read so the response reflects exactly what is stored, then re-group to {triggers,timing}.
		$stored = $document->get_display_settings_data();
		$stored = is_array( $stored ) ? $stored : $merged;

		$data       = array(
			'saved'            => true,
			'display_settings' => Display_Settings_Helper::group( $stored ),
		);
		$unverified = Display_Settings_Helper::unverified_keys( $stored );
		$warnings   = Display_Settings_Helper::warnings( $stored );
		if ( array() !== $unverified ) {
			$data['meta'] = array( 'unverified_keys' => $unverified );
		}
		if ( array() !== $warnings ) {
			$data['warnings'] = $warnings;
		}

		return Response::success( $data );
	}

	/*
	 * ------------------------------------------------------------------------------------------------
	 * Internal helpers.
	 * ---------------------------------------------------------------------------------------------
	 */

	/**
	 * Validate the optional `op_id` (10-rest-api.md §0.8) WITHOUT extending the abstract controller (this
	 * is a plain service). Mirrors {@see Theme_Builder_Service::read_op_id()}.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return string|null|WP_Error
	 */
	private static function read_op_id( $request ) {
		$op_id = $request->get_param( 'op_id' );
		if ( null === $op_id || '' === $op_id ) {
			return null;
		}
		if ( ! is_string( $op_id ) || ! preg_match( '/^[A-Za-z0-9_.-]{1,64}$/', $op_id ) ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'Invalid op_id: must match ^[A-Za-z0-9_.-]{1,64}$.', 'elementor-ultra-mcp' ),
				400,
				array(
					'path'     => 'op_id',
					'expected' => '^[A-Za-z0-9_.-]{1,64}$',
				)
			);
		}
		return $op_id;
	}

	/**
	 * Attach the request `op_id` (+ existing data) onto a `WP_Error` produced by a shared helper so the
	 * §0.6 envelope echoes it. No-op when `$op_id` is null.
	 *
	 * @param WP_Error    $error The error to decorate.
	 * @param string|null $op_id The op id.
	 * @return WP_Error
	 */
	private static function attach_op_id( WP_Error $error, ?string $op_id ): WP_Error {
		if ( null === $op_id ) {
			return $error;
		}
		$data = (array) $error->get_error_data();
		$error->add_data( array_merge( $data, array( 'op_id' => $op_id ) ) );
		return $error;
	}

	/**
	 * Append one op-log row behind a class_exists guard (WP-P14 soft dep — never fails the route).
	 *
	 * @param int         $post_id The document id.
	 * @param string|null $op_id   The op id.
	 * @param string      $route   The route/tool label.
	 */
	private static function op_log( int $post_id, ?string $op_id, string $route ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		\Elementor\Ultra\Core\Op_Log::record(
			array(
				'op_id'      => $op_id,
				'post_id'    => $post_id,
				'route'      => $route,
				'after_hash' => md5( (string) get_post_meta( $post_id, '_elementor_data', true ) ),
				'result'     => 'ok',
			)
		);
	}

	/**
	 * The Elementor documents manager (or null when Elementor is unavailable).
	 *
	 * @return object|null
	 */
	private static function documents_manager() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		return ( null !== $plugin && isset( $plugin->documents ) ) ? $plugin->documents : null;
	}

	/**
	 * Resolve ANY Elementor document for `$post_id` (used to distinguish 404 "no doc" from 422 "not a
	 * popup"). Returns null when the post is not an Elementor document at all.
	 *
	 * @param int $post_id The post id.
	 * @return object|null
	 */
	private static function any_document( int $post_id ) {
		if ( $post_id <= 0 ) {
			return null;
		}
		$documents = self::documents_manager();
		if ( null === $documents || ! method_exists( $documents, 'get' ) ) {
			return null;
		}
		$document = $documents->get( $post_id );
		return is_object( $document ) ? $document : null;
	}

	/**
	 * Resolve `$post_id` as a popup Document (returns null when it is not a popup). Used after create to
	 * write display settings via the popup-specific `save_display_settings_data()`.
	 *
	 * @param int $post_id The post id.
	 * @return object|null
	 */
	private static function popup_document( int $post_id ) {
		$document = self::any_document( $post_id );
		if ( null === $document || ! method_exists( $document, 'get_type' ) || ! method_exists( $document, 'save_display_settings_data' ) ) {
			return null;
		}
		return ( self::POPUP_TYPE === (string) $document->get_type() ) ? $document : null;
	}

	/**
	 * The Elementor editor URL for a document (falls back to the WP edit-post link).
	 *
	 * @param object $document The document instance.
	 * @param int    $post_id  The document id.
	 */
	private static function edit_url( $document, int $post_id ): string {
		if ( is_object( $document ) && method_exists( $document, 'get_edit_url' ) ) {
			$url = $document->get_edit_url();
			if ( is_string( $url ) && '' !== $url ) {
				return $url;
			}
		}
		return (string) get_edit_post_link( $post_id, 'raw' );
	}
}
