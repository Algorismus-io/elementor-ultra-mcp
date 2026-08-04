<?php
/**
 * WP-R01 — Theme_Builder_Service: creates typed theme-builder documents + sets/reads display conditions.
 *
 * Contract authority:
 *  - 10-rest-api.md §8.1 (`POST /pro/theme`), §8.2 (`PUT /pro/theme/{id}/conditions`),
 *    §8.3 (`GET /pro/theme/conditions-config`).
 *  - 10-rest-api.md §0.9 (dry-run-before-commit), §0.10 (atomic CSS prime flag).
 *  - 12-error-taxonomy.md §3.1 (`SCHEMA_INVALID_PARAMS`), §3.5 (`NOT_FOUND`, `NOT_EDITABLE`),
 *    §3.1 (`ATOMIC_SETTINGS_INVALID` 422 for an invalid atomic tree), §3.4 (`PRO_REQUIRED`).
 *  - SUPPLEMENT.md §A.1 (doc-type slugs + the `_elementor_template_type` = `get_type()` rule),
 *    §A.7 (pro.theme.create / set_conditions behaviour).
 *
 * Elementor APIs (cited `path:line`):
 *  - `Plugin::$instance->documents->create($type, $post_data, $meta_data)` —
 *    elementor/core/documents-manager.php:376-429 (`$meta_data['_elementor_location']` is persisted as
 *    post meta when supplied; `_elementor_template_type` is set to `$type` :398).
 *  - Doc-type slugs `header/footer/single-post/single-page/archive/search-results/error-404/section` —
 *    elementor-pro/modules/theme-builder/documents/*.php (SUPPLEMENT §A.1 table). Legacy `single` is
 *    HIDDEN (theme-builder/module.php:169-171) and REJECTED here.
 *  - `_elementor_template_type` = `get_name()` = `get_type()` — elementor/core/base/document.php:42,
 *    save_template_type() :1451-1452 (read `$doc->get_type()` for the canonical slug — Impl-Notes).
 *  - Section location validation — `Module::instance()->get_locations_manager()->get_locations()`
 *    (theme-builder/classes/locations-manager.php:492-501); the location is stored to
 *    `_elementor_location` (section.php:131-142).
 *  - `$document->get_location()` (for conflict detection) — theme-document.php:703-710.
 *
 * The element tree (when present) is validated with the AUTHORITATIVE {@see \Elementor\Ultra\Validator}
 * (WP-P03) and persisted via the SAME transactional {@see \Elementor\Ultra\Core\Document_Writer}
 * (WP-P04) as `/documents/{id}/save` (backup-before-write, base_hash, lock/autosave, CSS prime all flow
 * identically). A failed validate DELETES the just-created draft (compensation — ticket Detailed-Req #3)
 * so no orphan remains. Display conditions are written ONLY through {@see Conditions_Helper}.
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
 * Theme-builder document + conditions service. The {@see Pro_Controller} owns route registration; this
 * class returns its route descriptors via {@see routes()} and holds ALL theme business logic.
 */
final class Theme_Builder_Service {

	/** The eight valid theme-builder doc-type slugs (10-rest-api.md §8.1; SUPPLEMENT §A.1). */
	const VALID_TYPES = array( 'header', 'footer', 'single-post', 'single-page', 'archive', 'search-results', 'error-404', 'section' );

	/** The legacy/hidden doc type that is explicitly REJECTED (theme-builder/module.php:169-171). */
	const HIDDEN_TYPE = 'single';

	/** Op-log route label for `POST /pro/theme`. */
	const OP_ROUTE_CREATE = 'pro/theme';

	/** Op-log route label for `PUT /pro/theme/{id}/conditions`. */
	const OP_ROUTE_CONDITIONS = 'pro/theme/conditions';

	/**
	 * The route descriptors for the three theme routes (10-rest-api.md §8.1-§8.3). The descriptor shape
	 * is the FROZEN contract every sibling Pro service `routes()` returns (ticket Detailed-Req #1):
	 *   `[ 'methods'=>WP_REST_Server::*, 'route'=>'/pro/...', 'callback'=>callable,
	 *      'permission_callback'=>callable, 'args'=>array ]`.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public function routes(): array {
		return array(
			// POST /pro/theme — CAP_EDIT_POST (no id => create => falls back to edit_posts).
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'route'               => '/pro/theme',
				'callback'            => array( $this, 'create' ),
				'permission_callback' => Permissions::can_edit_post(),
				'args'                => array(
					'type'          => array(
						'type'        => 'string',
						'required'    => true,
						'enum'        => self::VALID_TYPES,
						'description' => 'Theme-builder doc type: ' . implode( '|', self::VALID_TYPES ) . ' (single is rejected).',
					),
					'title'         => array(
						'type'     => 'string',
						'required' => false,
						'default'  => '',
					),
					'status'        => array(
						'type'     => 'string',
						'required' => false,
						'default'  => 'publish',
					),
					'location'      => array(
						'type'        => 'string',
						'required'    => false,
						'description' => 'Required only for type=section; must exist in get_locations().',
					),
					'elements'      => array(
						'type'     => 'array',
						'required' => false,
					),
					'page_settings' => array(
						'type'     => 'object',
						'required' => false,
					),
					'conditions'    => array(
						'type'        => 'array',
						'required'    => false,
						'description' => 'ConditionTuple[] = [type,name,sub_name?,sub_id?]; type in include|exclude.',
					),
					'prime_css'     => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'op_id'         => array(
						'type'     => 'string',
						'required' => false,
					),
				),
			),
			// PUT /pro/theme/{id}/conditions — CAP_EDIT_POST.
			array(
				'methods'             => WP_REST_Server::EDITABLE,
				'route'               => '/pro/theme/(?P<id>\d+)/conditions',
				'callback'            => array( $this, 'set_conditions' ),
				'permission_callback' => Permissions::can_edit_post(),
				'args'                => array(
					'id'              => array(
						'type'              => 'integer',
						'required'          => true,
						'minimum'           => 1,
						'sanitize_callback' => 'absint',
					),
					'conditions'      => array(
						'type'        => 'array',
						'required'    => true,
						'description' => 'ConditionTuple[]; [] CLEARS all conditions.',
					),
					'check_conflicts' => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'op_id'           => array(
						'type'     => 'string',
						'required' => false,
					),
				),
			),
			// GET /pro/theme/conditions-config — CAP_READ.
			array(
				'methods'             => WP_REST_Server::READABLE,
				'route'               => '/pro/theme/conditions-config',
				'callback'            => array( $this, 'conditions_config' ),
				'permission_callback' => Permissions::can_read(),
				'args'                => array(),
			),
		);
	}

	/**
	 * `POST /pro/theme` (10-rest-api.md §8.1; SUPPLEMENT §A.7). Validates `type`, rejects `single`,
	 * requires + validates `location` for sections, creates the typed doc, validates+persists an optional
	 * atomic `elements` tree (compensating-delete on validate failure), then applies optional conditions.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function create( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		// Pro presence (501 PRO_REQUIRED when absent) — first line of every /pro/* handler.
		$gate = Pro_Gate::require_pro( $op_id );
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		$type = (string) $request->get_param( 'type' );

		// Explicitly REJECT the legacy/hidden `single` type (theme-builder/module.php:169-171).
		if ( self::HIDDEN_TYPE === $type ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'The "single" theme type is hidden/legacy; use "single-post" or "single-page".', 'elementor-ultra-mcp' ),
				400,
				array(
					'path'   => 'type',
					'reason' => 'single is hidden/legacy; use single-post/single-page',
				),
				array(),
				$op_id
			);
		}
		if ( ! in_array( $type, self::VALID_TYPES, true ) ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				sprintf(
					/* translators: %s: pipe-joined valid types. */
					__( 'Invalid theme type; expected one of %s.', 'elementor-ultra-mcp' ),
					implode( '|', self::VALID_TYPES )
				),
				400,
				array(
					'path'     => 'type',
					'expected' => self::VALID_TYPES,
				),
				array(),
				$op_id
			);
		}

		// `location` is REQUIRED for sections and MUST exist in get_locations() (ticket Detailed-Req #3).
		$location  = $request->get_param( 'location' );
		$location  = is_string( $location ) ? $location : null;
		$meta_data = array();
		if ( 'section' === $type ) {
			if ( null === $location || '' === $location ) {
				return Response::error(
					Error_Codes::SCHEMA_INVALID_PARAMS,
					__( 'A "location" is required for type=section.', 'elementor-ultra-mcp' ),
					400,
					array( 'path' => 'location' ),
					array(),
					$op_id
				);
			}
			$locations = Conditions_Helper::all_locations();
			if ( ! isset( $locations[ $location ] ) ) {
				return Response::error(
					Error_Codes::SCHEMA_INVALID_PARAMS,
					sprintf(
						/* translators: %s: requested location. */
						__( 'Unknown section location "%s".', 'elementor-ultra-mcp' ),
						$location
					),
					400,
					array(
						'path'      => 'location',
						'available' => array_keys( $locations ),
					),
					array(),
					$op_id
				);
			}
			// Persisted to `_elementor_location` by documents->create() (section.php:131-142 mirrors this).
			$meta_data['_elementor_location'] = $location;
		}

		$documents = self::documents_manager();
		if ( null === $documents ) {
			return Response::error( Error_Codes::UPSTREAM_ERROR, __( 'Elementor documents manager is unavailable.', 'elementor-ultra-mcp' ), 502, array(), array(), $op_id );
		}

		$title  = (string) $request->get_param( 'title' );
		$status = (string) $request->get_param( 'status' );
		$status = '' !== $status ? $status : 'publish';

		// (a) create the typed theme doc (documents-manager.php:376-429).
		$document = $documents->create(
			$type,
			array(
				'post_title'  => '' !== $title ? $title : ucwords( str_replace( '-', ' ', $type ) ),
				'post_status' => $status,
			),
			$meta_data
		);

		if ( is_wp_error( $document ) ) {
			return \Elementor\Ultra\Core\Error::from_wp_error( $document );
		}
		if ( ! is_object( $document ) || ! method_exists( $document, 'get_main_id' ) ) {
			return Response::error( Error_Codes::INTERNAL_ERROR, __( 'Theme document creation returned an unexpected result.', 'elementor-ultra-mcp' ), 500, array(), array(), $op_id );
		}

		$post_id = (int) $document->get_main_id();

		$elements      = $request->get_param( 'elements' );
		$page_settings = $request->get_param( 'page_settings' );
		$prime_css     = (bool) $request->get_param( 'prime_css' );
		$has_elements  = is_array( $elements ) && array() !== $elements;

		$prime_required = false;
		$css_primed     = false;

		// (b) validate the atomic tree FIRST; on failure DELETE the draft (compensation) — no orphan.
		if ( $has_elements ) {
			$verdict = Validator::dry_run( $elements, is_array( $page_settings ) ? $page_settings : array(), 0 );
			if ( empty( $verdict['valid'] ) ) {
				wp_delete_post( $post_id, true ); // Compensating delete (force — no trash).
				$errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
				return Response::error(
					Error_Codes::ATOMIC_SETTINGS_INVALID,
					sprintf(
						/* translators: %d: error count. */
						_n( 'The theme document element tree failed validation (%d error); the draft was removed.', 'The theme document element tree failed validation (%d errors); the draft was removed.', count( $errors ), 'elementor-ultra-mcp' ),
						count( $errors )
					),
					422,
					array( 'compensated' => true ),
					$errors,
					$op_id
				);
			}
		}

		// (c) persist elements/settings via the SAME transactional writer as /documents/{id}/save.
		if ( $has_elements || ( is_array( $page_settings ) && array() !== $page_settings ) ) {
			$write_args = array(
				'op_id'     => $op_id,
				'prime_css' => $prime_css,
				'backup'    => true,
			);
			if ( $has_elements ) {
				$write_args['elements'] = $elements;
			}
			if ( is_array( $page_settings ) && array() !== $page_settings ) {
				$write_args['settings'] = $page_settings;
			}

			$result = Document_Writer::save( $post_id, $write_args );
			if ( is_wp_error( $result ) ) {
				wp_delete_post( $post_id, true ); // Compensating delete — a save failure leaves no orphan.
				return $result;
			}
			$prime_required = ! empty( $result['prime_required'] );
			$css_primed     = ! empty( $result['css_primed'] );
		}

		// (d) optional display conditions (slash strings + cache->regenerate() via the helper).
		$conditions_stored = array();
		$unverified_names  = array();
		$warnings          = array();
		$conditions        = $request->get_param( 'conditions' );
		if ( is_array( $conditions ) ) {
			$validation = Conditions_Helper::validate( $conditions );
			if ( $validation instanceof WP_Error ) {
				// The doc + tree are valid; only the conditions were malformed — surface the 400 but keep
				// the doc (caller can retry conditions via PUT). Attach op_id.
				$data = (array) $validation->get_error_data();
				if ( null !== $op_id ) {
					$validation->add_data(
						array_merge(
							$data,
							array(
								'op_id'   => $op_id,
								'post_id' => $post_id,
							)
						)
					);
				}
				return $validation;
			}
			$saved = Conditions_Helper::save( $post_id, $conditions );
			if ( is_wp_error( $saved ) ) {
				return $saved;
			}
			$conditions_stored = $saved['conditions_stored'];
			$unverified_names  = $saved['unverified_names'];
			$warnings          = $saved['warnings'];
		}

		self::op_log( $post_id, $op_id, self::OP_ROUTE_CREATE );

		$data = array(
			'post_id'           => $post_id,
			'edit_url'          => self::edit_url( $document, $post_id ),
			'template_type'     => (string) $document->get_type(), // Canonical slug (SUPPLEMENT §A.1).
			'location'          => 'section' === $type ? $location : null,
			'conditions_stored' => $conditions_stored,
			'prime_required'    => $prime_required,
			'css_primed'        => $css_primed,
		);
		if ( array() !== $unverified_names ) {
			$data['unverified_names'] = $unverified_names;
		}
		if ( array() !== $warnings ) {
			$data['warnings'] = $warnings;
		}

		return Response::success( $data, 201 );
	}

	/**
	 * `PUT /pro/theme/{id}/conditions` (10-rest-api.md §8.2; SUPPLEMENT §A.7). REPLACES all conditions
	 * (`[]` clears). When `check_conflicts:true`, computes conflicts for the doc's location, then saves,
	 * then returns BOTH (the contract returns conflicts ALONGSIDE a successful save).
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function set_conditions( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$gate = Pro_Gate::require_pro( $op_id );
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		$post_id  = (int) $request['id'];
		$document = self::theme_document( $post_id );
		if ( null === $document ) {
			return Response::error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %d: post id. */
					__( 'Theme document %d was not found.', 'elementor-ultra-mcp' ),
					$post_id
				),
				404,
				array( 'post_id' => $post_id ),
				array(),
				$op_id
			);
		}

		$conditions = $request->get_param( 'conditions' );
		if ( ! is_array( $conditions ) ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'conditions must be an array (use [] to clear).', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'conditions' ),
				array(),
				$op_id
			);
		}

		$validation = Conditions_Helper::validate( $conditions );
		if ( $validation instanceof WP_Error ) {
			$data = (array) $validation->get_error_data();
			if ( null !== $op_id ) {
				$validation->add_data( array_merge( $data, array( 'op_id' => $op_id ) ) );
			}
			return $validation;
		}

		// Compute conflicts BEFORE saving (so the doc's existing conditions don't pollute the check), then
		// save, then return both (10-rest-api.md §8.2). $ignore_post_id=$post_id => never self-conflicts.
		$check_conflicts = (bool) $request->get_param( 'check_conflicts' );
		$conflicts       = null;
		if ( $check_conflicts ) {
			$location  = (string) ( method_exists( $document, 'get_location' ) ? $document->get_location() : '' );
			$conflicts = Conditions_Helper::conflicts( $post_id, $conditions, $location );
		}

		$saved = Conditions_Helper::save( $post_id, $conditions );
		if ( is_wp_error( $saved ) ) {
			return $saved;
		}

		self::op_log( $post_id, $op_id, self::OP_ROUTE_CONDITIONS );

		$data = array(
			'saved'             => true,
			'conditions_stored' => $saved['conditions_stored'],
		);
		if ( null !== $conflicts ) {
			$data['conflicts'] = $conflicts;
		}
		if ( array() !== $saved['unverified_names'] ) {
			$data['unverified_names'] = $saved['unverified_names'];
		}
		if ( array() !== $saved['warnings'] ) {
			$data['warnings'] = $saved['warnings'];
		}

		return Response::success( $data );
	}

	/**
	 * `GET /pro/theme/conditions-config` (10-rest-api.md §8.3). Returns the live
	 * `get_conditions_config()` tree + `id_bearing` + `locations` (no hardcoded CPT/tax names).
	 *
	 * @param \WP_REST_Request $request The current request (unused).
	 * @return \WP_REST_Response|WP_Error
	 */
	public function conditions_config( $request ) {
		unset( $request );

		$gate = Pro_Gate::require_pro();
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		return Response::success(
			array(
				'tree'       => Conditions_Helper::config_tree(),
				'id_bearing' => Conditions_Helper::id_bearing(),
				'locations'  => Conditions_Helper::location_keys(),
			)
		);
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Internal helpers.
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Validate the optional `op_id` (10-rest-api.md §0.8) WITHOUT extending the abstract controller (this
	 * is a plain service). Mirrors {@see \Elementor\Ultra\Rest\Abstract_Controller::read_op_id()}.
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
	 * Resolve a Pro Theme_Document for `$post_id` via the theme-builder Module (so non-theme posts and
	 * missing posts both resolve to null). Uses `Module::instance()->get_document()` which itself returns
	 * null for a non-Theme_Document (theme-builder/module.php:107+).
	 *
	 * @param int $post_id The document id.
	 * @return object|null
	 */
	private static function theme_document( int $post_id ) {
		if ( $post_id <= 0 || ! class_exists( '\ElementorPro\Modules\ThemeBuilder\Module' ) ) {
			return null;
		}
		$module = \ElementorPro\Modules\ThemeBuilder\Module::instance();
		if ( ! is_object( $module ) || ! method_exists( $module, 'get_document' ) ) {
			return null;
		}
		$document = $module->get_document( $post_id );
		return is_object( $document ) ? $document : null;
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
