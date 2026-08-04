<?php
/**
 * WP-R03 — Form_Builder_Service: the `/pro/form/*` Pro Forms surface (build a form widget + list actions).
 *
 * Contract authority:
 *  - 10-rest-api.md §8.5 (`POST /pro/form/build`, `GET /pro/form/actions`).
 *  - 10-rest-api.md §0.3 (cap map), §0.6 (error envelope), §0.8 (base_hash/op_id), §0.9 (dry-run),
 *    §0.10 (atomic CSS prime).
 *  - 11-authoring-contract.md §2 (classic `form` widget vs atomic `e-form` node shapes).
 *  - 12-error-taxonomy.md §3.4 (`PRO_REQUIRED`, `EXPERIMENT_INACTIVE`), §3.1 (`ATOMIC_SETTINGS_INVALID`,
 *    `SCHEMA_INVALID_PARAMS`), §3.5 (`NOT_FOUND`).
 *  - SUPPLEMENT.md §A.3/§A.7 (forms authoring), §B.1/§B.2 (atomic `e-form` props + email prop-type).
 *
 * Registration model (WP-R01). This service is one of {@see Pro_Controller}'s SIBLING_SERVICES: it ships
 * ONLY this file + the pure {@see Form_Mapper}, exposes a public {@see routes()} returning the FROZEN
 * descriptor shape, and the WP-R01 controller's `collect_descriptors()` loop picks it up (class_exists()-
 * guarded) on `rest_api_init` and registers the two routes LIVE — this file NEVER edits the controller or
 * the spine registrar. Every handler first-lines {@see Pro_Gate::require_pro()} so a Pro-inactive site 501s.
 *
 * Reuse (do NOT reimplement): {@see Pro_Gate} (Pro/experiment gate), {@see Validator} (authoritative
 * dry_run), {@see \Elementor\Ultra\Core\Document_Writer} (transactional persist), {@see Permissions}
 * (cap gates), {@see Response} (envelopes), {@see \Elementor\Ultra\Rest\Element_Ops} (pure granular
 * insert), {@see Form_Mapper} (pure spec->settings map).
 *
 * Elementor Pro APIs (cited `path:line` against bundled `plugins/elementor-pro/`):
 *  - Form widget `widgetType='form'`, `Forms\Widgets\Form extends Form_Base`, `get_name()='form'` —
 *    modules/forms/widgets/form.php:23-25.
 *  - Actions registrar `Module::instance()->actions_registrar->get()` (the license-gated registered set) —
 *    modules/forms/widgets/form.php:874; `Form_Actions_Registrar::FEATURE_NAME_CLASS_NAME_MAP` +
 *    `API::filter_active_features()` — modules/forms/registrars/form-actions-registrar.php:19-32,53. The
 *    registrar items are populated lazily by the `elementor_pro/forms/actions/register` action, so this
 *    service FIRES that action (idempotent — the registrar de-dupes by id) before reading `get()`.
 *  - Field types filter `elementor_pro/forms/field_types` — modules/forms/widgets/form.php:143.
 *  - Per-action `settings_controls` are read by grouping the live form-widget controls by the action's
 *    section, whose `condition.submit_actions == get_name()` (e.g. email.php:33-37, redirect.php:28-31,
 *    webhook.php:27-30) — this is generic + license-aware (every registered action's section carries that
 *    condition, so mailchimp/drip/etc. surface automatically without hardcoding).
 *
 * WP DEVIATION (live-verified, OVERRIDES the SUPPLEMENT §A.3 + ticket note): `email2` control ids are
 * SUFFIXED `_2` (`email_to_2`,`email_subject_2`,…) per `Email2::get_control_id($id)=>$id.'_2'`
 * (modules/forms/actions/email2.php:20-22) — NOT the documented `email2_` PREFIX. Confirmed live: the
 * `section_email_2` controls are `email_to_2`/`email_subject_2`/…  {@see Form_Mapper::map_actions()}
 * emits the `_2` suffix accordingly.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

use Elementor\Ultra\Core\Document_Writer;
use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Rest\Element_Ops;
use Elementor\Ultra\Rest\Permissions;
use Elementor\Ultra\Rest\Response;
use Elementor\Ultra\Validator;
use WP_Error;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Pro Forms service. {@see Pro_Controller} owns route registration; this class returns its two route
 * descriptors via {@see routes()} and holds ALL forms business logic. All WP I/O (registrar lookup, filter,
 * validation, persist) lives here; the spec->settings mapping is the pure {@see Form_Mapper}.
 */
final class Form_Builder_Service {

	/** The `e_pro_atomic_form` experiment slug the V4 atomic-form path requires (SUPPLEMENT §B.2). */
	const EXPERIMENT_ATOMIC_FORM = 'e_pro_atomic_form';

	/** Op-log route label for `POST /pro/form/build`. */
	const OP_ROUTE_BUILD = 'pro/form/build';

	/** The classic Pro form `widgetType` (form.php:23-25). */
	const WIDGET_FORM = 'form';

	/** The atomic form ELEMENT type (registered under elements_manager, not widgets) — SUPPLEMENT §B.2. */
	const ELEMENT_E_FORM = 'e-form';

	/**
	 * The two route descriptors (10-rest-api.md §8.5), in the FROZEN sibling-service shape (WP-R01).
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public function routes(): array {
		return array(
			// POST /pro/form/build — CAP_EDIT_POST (falls back to edit_posts when no `id`/`post_id`).
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'route'               => '/pro/form/build',
				'callback'            => array( $this, 'build_route' ),
				'permission_callback' => Permissions::can_edit_post(),
				'args'                => array(
					'post_id'      => array(
						'type'        => 'integer',
						'required'    => false,
						'description' => 'When present with container_id, the widget is inserted + persisted; else {element} is returned.',
					),
					'container_id' => array(
						'type'        => 'string',
						'required'    => false,
						'description' => 'The parent element id the widget is inserted under (requires post_id to persist).',
					),
					'generation'   => array(
						'type'        => 'string',
						'required'    => false,
						'enum'        => array( 'v3', 'v4' ),
						'description' => 'v3 classic form (default) | v4 atomic e-form (requires e_pro_atomic_form).',
					),
					'form_name'    => array(
						'type'     => 'string',
						'required' => false,
					),
					'button_text'  => array(
						'type'     => 'string',
						'required' => false,
					),
					'input_size'   => array(
						'type'     => 'string',
						'required' => false,
					),
					'show_labels'  => array(
						'type'     => 'string',
						'required' => false,
					),
					'form_id'      => array(
						'type'     => 'string',
						'required' => false,
					),
					'fields'       => array(
						'type'        => 'array',
						'required'    => true,
						'description' => 'Field specs: {type,id,label?,placeholder?,required?,options?,rows?,width?,default_value?,html?}.',
					),
					'actions'      => array(
						'type'        => 'array',
						'required'    => false,
						'default'     => array( array( 'type' => 'email' ) ),
						'description' => 'Action specs: {type, ...action_settings}. Defaults to a single email action.',
					),
					'base_hash'    => array(
						'type'        => 'string',
						'required'    => false,
						'description' => 'Required when persisting (post_id+container_id) — optimistic concurrency token.',
					),
					'prime_css'    => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'force'        => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'op_id'        => array(
						'type'     => 'string',
						'required' => false,
					),
				),
			),
			// GET /pro/form/actions — CAP_READ.
			array(
				'methods'             => WP_REST_Server::READABLE,
				'route'               => '/pro/form/actions',
				'callback'            => array( $this, 'actions_route' ),
				'permission_callback' => Permissions::can_read(),
				'args'                => array(),
			),
		);
	}

	/*
	------------------------------------------------------------------------------------------------
	 * POST /pro/form/build
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * `POST /pro/form/build` (10-rest-api.md §8.5). Maps the spec -> a `form` (v3) or `e-form` (v4) node,
	 * validates it via the AUTHORITATIVE {@see Validator}, and either inserts+persists it under
	 * `container_id` (when `post_id`+`container_id` present) or returns `{element}` only.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function build_route( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		// (1) Pro presence — 501 PRO_REQUIRED when absent (first line of every /pro/* handler).
		$gate = Pro_Gate::require_pro( $op_id );
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		$result = $this->build( $this->collect_params( $request ) );
		if ( $result instanceof WP_Error ) {
			return $result;
		}

		$status = ! empty( $result['applied'] ) ? 200 : 200; // §8.5 returns 200 with `applied` flag.
		return Response::success( $result, $status );
	}

	/**
	 * Build a form widget node from `$params`, optionally persisting it. Pure-ish orchestration: it calls
	 * the pure {@see Form_Mapper} + the live registrar/filter/validator/writer. Returns the §8.5 `data`
	 * payload `{element, applied, base_hash?, warnings}` or a `WP_Error`.
	 *
	 * Public (not just the route) so PHPUnit can exercise the full map+validate path without a request.
	 *
	 * @param array<string,mixed> $params Normalized build params (see {@see collect_params()}).
	 * @return array<string,mixed>|WP_Error
	 */
	public function build( array $params ) {
		$op_id    = isset( $params['op_id'] ) && '' !== (string) $params['op_id'] ? (string) $params['op_id'] : null;
		$warnings = array();

		$fields = isset( $params['fields'] ) && is_array( $params['fields'] ) ? $params['fields'] : null;
		if ( null === $fields || array() === $fields ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'A non-empty "fields" array is required.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'fields' ),
				array(),
				$op_id
			);
		}

		// (1) Generation selection (Detailed-Req #1). Default v3; v4 only when the atomic-form experiment is
		// active, else FALL BACK to v3 with a warning (contract default).
		$generation = isset( $params['generation'] ) && is_string( $params['generation'] ) ? $params['generation'] : 'v3';
		if ( 'v4' === $generation && ! Pro_Gate::is_experiment_active( self::EXPERIMENT_ATOMIC_FORM ) ) {
			$generation = 'v3';
			$warnings[] = 'atomic form unavailable; built classic form';
		}

		// (2) Validate each field type against the live base list ∪ the `elementor_pro/forms/field_types`
		// filter (Detailed-Req #2). An unknown type is a 422 with the offending field path.
		$allowed_types = $this->allowed_field_types();
		foreach ( array_values( $fields ) as $i => $field ) {
			$type = is_array( $field ) && isset( $field['type'] ) && is_string( $field['type'] ) ? $field['type'] : '';
			if ( '' === $type || ! in_array( $type, $allowed_types, true ) ) {
				return Response::error(
					Error_Codes::SCHEMA_INVALID_PARAMS,
					sprintf(
						/* translators: 1: field index, 2: the invalid field type. */
						__( 'Field %1$d has an invalid field type "%2$s".', 'elementor-ultra-mcp' ),
						(int) $i,
						$type
					),
					422,
					array(
						'path'    => sprintf( 'fields[%d].type', (int) $i ),
						'allowed' => $allowed_types,
					),
					array(),
					$op_id
				);
			}
		}

		// (3) Filter actions to the license-gated registered set (Detailed-Req #3). An unregistered action is
		// DROPPED (warning), not an error.
		$registered = $this->registered_action_names();
		$actions_in = isset( $params['actions'] ) && is_array( $params['actions'] ) ? $params['actions'] : array();
		$actions    = array();
		foreach ( array_values( $actions_in ) as $action ) {
			$type = is_array( $action ) && isset( $action['type'] ) && is_string( $action['type'] ) ? $action['type'] : '';
			if ( '' === $type ) {
				continue;
			}
			if ( ! in_array( $type, $registered, true ) ) {
				$warnings[] = sprintf( "action '%s' not registered (license)", $type );
				continue;
			}
			$actions[] = $action;
		}

		// (4) Build the node for the chosen generation.
		if ( 'v4' === $generation ) {
			$element = $this->build_atomic_node( $params, $fields, $actions, $op_id );
		} else {
			$element = $this->build_classic_node( $params, $fields, $actions, $op_id );
		}
		if ( $element instanceof WP_Error ) {
			return $element;
		}

		// (5) Validate the produced node via the AUTHORITATIVE Validator (10 §0.9) — a single-node tree.
		$verdict = Validator::dry_run( array( $element ), array(), 0 );
		if ( empty( $verdict['valid'] ) ) {
			$errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
			return Response::error(
				Error_Codes::ATOMIC_SETTINGS_INVALID,
				sprintf(
					/* translators: %d: error count. */
					_n( 'The form widget failed validation (%d error).', 'The form widget failed validation (%d errors).', count( $errors ), 'elementor-ultra-mcp' ),
					count( $errors )
				),
				422,
				array( 'generation' => $generation ),
				$errors,
				$op_id
			);
		}

		// (6) Persist vs return-only (Detailed-Req #6).
		$post_id      = isset( $params['post_id'] ) ? (int) $params['post_id'] : 0;
		$container_id = isset( $params['container_id'] ) && is_string( $params['container_id'] ) ? $params['container_id'] : '';

		if ( $post_id > 0 && '' !== $container_id ) {
			return $this->persist( $post_id, $container_id, $element, $params, $warnings, $op_id );
		}

		// Return-only: no persist, no base_hash (the TS caller places it).
		$data = array(
			'element' => $element,
			'applied' => false,
		);
		if ( array() !== $warnings ) {
			$data['warnings'] = array_values( array_unique( $warnings ) );
		}
		return $data;
	}

	/**
	 * Insert `$element` under `$container_id` and persist via the SAME granular path as
	 * `POST /documents/{id}/elements` ({@see Element_Ops::apply} + {@see Document_Writer::replace_tree}):
	 * read tree -> insert op -> ONE validate+save with backup/lock/base_hash/op_id (Detailed-Req #6/#9).
	 *
	 * @param int                 $post_id      The target document.
	 * @param string              $container_id The parent element id.
	 * @param array<string,mixed> $element      The form widget node.
	 * @param array<string,mixed> $params       The build params (base_hash/force/prime_css).
	 * @param string[]            $warnings     Accumulated warnings.
	 * @param string|null         $op_id        The op id.
	 * @return array<string,mixed>|WP_Error
	 */
	private function persist( int $post_id, string $container_id, array $element, array $params, array $warnings, ?string $op_id ) {
		if ( ! self::is_elementor_post( $post_id ) ) {
			return Response::error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %d: post id. */
					__( 'Document %d was not found or is not Elementor-built.', 'elementor-ultra-mcp' ),
					$post_id
				),
				404,
				array( 'post_id' => $post_id ),
				array(),
				$op_id
			);
		}

		// A single-element insert is a surgical write -> base_hash REQUIRED (10 §0.8; mirrors replace_tree).
		$base_hash = isset( $params['base_hash'] ) ? (string) $params['base_hash'] : '';
		$force     = ! empty( $params['force'] );
		if ( '' === $base_hash && ! $force ) {
			return Response::error(
				Error_Codes::CONCURRENCY_STALE_HASH,
				__( 'Persisting a form into a document requires a base_hash (re-read the document for a fresh one), or pass force:true.', 'elementor-ultra-mcp' ),
				409,
				array( 'post_id' => $post_id ),
				array(),
				$op_id
			);
		}

		$tree = self::read_tree( $post_id );
		$tree = is_array( $tree ) ? $tree : array();

		// Pure in-memory insert under the container (mints fresh ids for the subtree, deduped vs the doc).
		$applied = Element_Ops::apply(
			$tree,
			array(
				array(
					'op'        => 'insert',
					'parent_id' => $container_id,
					'node'      => $element,
				),
			),
			$post_id
		);
		if ( $applied instanceof WP_Error ) {
			$data = (array) $applied->get_error_data();
			if ( null !== $op_id ) {
				$applied->add_data( array_merge( $data, array( 'op_id' => $op_id ) ) );
			}
			return $applied;
		}

		// ONE save of the resulting whole tree (validate-before-persist happens inside the writer, §0.9).
		$result = Document_Writer::replace_tree(
			$post_id,
			array(
				'elements'  => $applied['elements'],
				'base_hash' => $base_hash,
				'op_id'     => $op_id,
				'force'     => $force,
				'prime_css' => ! empty( $params['prime_css'] ),
				'backup'    => true,
			)
		);
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		self::op_log( $post_id, $op_id, self::OP_ROUTE_BUILD, isset( $result['base_hash'] ) ? (string) $result['base_hash'] : '' );

		$data = array(
			'element'        => $element,
			'applied'        => true,
			'base_hash'      => isset( $result['base_hash'] ) ? $result['base_hash'] : '',
			'remapped_ids'   => isset( $applied['remapped'] ) ? $applied['remapped'] : array(),
			'css_primed'     => ! empty( $result['css_primed'] ),
			'prime_required' => ! empty( $result['prime_required'] ),
		);
		if ( array() !== $warnings ) {
			$data['warnings'] = array_values( array_unique( $warnings ) );
		}
		return $data;
	}

	/**
	 * Build the V3 classic `form` widget node (SUPPLEMENT §A.3). Maps fields via {@see Form_Mapper::map_fields}
	 * (id minter = {@see \Elementor\Ultra\Core\Id_Service::mint}), actions via {@see Form_Mapper::map_actions},
	 * and form-level controls via {@see Form_Mapper::map_form_controls}.
	 *
	 * @param array<string,mixed>            $params  The build params (form-level controls).
	 * @param array<int,array<string,mixed>> $fields  The field specs.
	 * @param array<int,array<string,mixed>> $actions The (registered-only) action specs.
	 * @param string|null                    $op_id   The op id (for errors).
	 * @return array<string,mixed>|WP_Error
	 */
	private function build_classic_node( array $params, array $fields, array $actions, ?string $op_id ) {
		unset( $op_id ); // Classic mapping cannot fail structurally; the Validator is the gate.

		$id_minter = static function (): string {
			if ( class_exists( '\Elementor\Ultra\Core\Id_Service' ) && method_exists( '\Elementor\Ultra\Core\Id_Service', 'mint' ) ) {
				return \Elementor\Ultra\Core\Id_Service::mint();
			}
			// Off-WP fallback (never used live): a 7-char hex from mt_rand.
			return substr( str_pad( dechex( wp_rand( 0, 0xFFFFFFF ) ), 7, '0', STR_PAD_LEFT ), 0, 7 );
		};

		$form_fields = Form_Mapper::map_fields( $fields, $id_minter );
		$mapped      = Form_Mapper::map_actions( $actions );
		$controls    = Form_Mapper::map_form_controls( $params );

		$settings = array_merge( $controls, $mapped['settings'] );

		// Always emit submit_actions explicitly (the default is ['email']; an empty action set => []).
		$settings['form_fields']    = $form_fields;
		$settings['submit_actions'] = array() !== $mapped['submit_actions'] ? $mapped['submit_actions'] : array();

		return array(
			'id'         => $id_minter(),
			'elType'     => 'widget',
			'widgetType' => self::WIDGET_FORM,
			'settings'   => $settings,
			'elements'   => array(),
		);
	}

	/**
	 * Build the V4 atomic `e-form` node + atomic input children (SUPPLEMENT §B.1/§B.2). Only emitted when
	 * `e_pro_atomic_form` is active (the caller already fell back to v3 otherwise). Field specs map to
	 * `e-form-input`/`e-form-textarea`/`e-form-select`/`e-form-submit-button` typed-envelope nodes; the email
	 * action maps to the `email` prop-type envelope on the `e-form` element. The Validator is authoritative.
	 *
	 * @param array<string,mixed>            $params  The build params.
	 * @param array<int,array<string,mixed>> $fields  The field specs.
	 * @param array<int,array<string,mixed>> $actions The (registered-only) action specs.
	 * @param string|null                    $op_id   The op id (for errors).
	 * @return array<string,mixed>|WP_Error
	 */
	private function build_atomic_node( array $params, array $fields, array $actions, ?string $op_id ) {
		unset( $op_id );

		$id_minter = static function (): string {
			if ( class_exists( '\Elementor\Ultra\Core\Id_Service' ) && method_exists( '\Elementor\Ultra\Core\Id_Service', 'mint' ) ) {
				return \Elementor\Ultra\Core\Id_Service::mint();
			}
			return substr( str_pad( dechex( wp_rand( 0, 0xFFFFFFF ) ), 7, '0', STR_PAD_LEFT ), 0, 7 );
		};

		// --- Atomic input children ---.
		$children = array();
		foreach ( array_values( $fields ) as $field ) {
			$field = is_array( $field ) ? $field : array();
			$type  = isset( $field['type'] ) && is_string( $field['type'] ) ? $field['type'] : 'text';
			$req   = ! empty( $field['required'] ) || ( isset( $field['required'] ) && in_array( strtolower( (string) $field['required'] ), array( 'true', '1', 'yes' ), true ) );

			if ( 'textarea' === $type ) {
				$settings = array();
				if ( isset( $field['placeholder'] ) && is_scalar( $field['placeholder'] ) && '' !== (string) $field['placeholder'] ) {
					$settings['placeholder'] = self::wrap_string( (string) $field['placeholder'] );
				}
				if ( isset( $field['rows'] ) && is_numeric( $field['rows'] ) ) {
					$settings['rows'] = self::wrap_number( (int) $field['rows'] );
				}
				if ( $req ) {
					$settings['required'] = self::wrap_boolean( true );
				}
				$children[] = self::atomic_widget( $id_minter(), 'e-form-textarea', $settings );
				continue;
			}

			if ( 'select' === $type ) {
				$children[] = self::atomic_widget( $id_minter(), 'e-form-select', array() );
				continue;
			}

			// Default: a text-like input. The atomic `e-form-input` `type` enum is text/email/number/tel/password.
			$input_type = in_array( $type, array( 'text', 'email', 'number', 'tel', 'password' ), true ) ? $type : 'text';
			$settings   = array(
				'type' => self::wrap_string( $input_type ),
			);
			if ( isset( $field['placeholder'] ) && is_scalar( $field['placeholder'] ) && '' !== (string) $field['placeholder'] ) {
				$settings['placeholder'] = self::wrap_string( (string) $field['placeholder'] );
			}
			if ( $req ) {
				$settings['required'] = self::wrap_boolean( true );
			}
			$children[] = self::atomic_widget( $id_minter(), 'e-form-input', $settings );
		}

		// --- The submit button (text is html-v3 — author the {content,children} form per §B.2). ---.
		$button_text = isset( $params['button_text'] ) && is_scalar( $params['button_text'] ) && '' !== (string) $params['button_text'] ? (string) $params['button_text'] : 'Send';
		$children[]  = self::atomic_widget(
			$id_minter(),
			'e-form-submit-button',
			array( 'text' => self::wrap_html_v3( $button_text ) )
		);

		// --- The e-form element settings (form-name, actions-after-submit, email). ---.
		$settings = array();

		$form_name             = isset( $params['form_name'] ) && is_scalar( $params['form_name'] ) && '' !== (string) $params['form_name'] ? (string) $params['form_name'] : 'Form';
		$settings['form-name'] = self::wrap_string( $form_name );

		// `submit_actions` -> `actions-after-submit` (string-array). Default ['email'] when empty.
		$action_names = array();
		foreach ( array_values( $actions ) as $action ) {
			$t = is_array( $action ) && isset( $action['type'] ) && is_string( $action['type'] ) ? $action['type'] : '';
			if ( '' !== $t ) {
				$action_names[] = $t;
			}
		}
		if ( array() === $action_names ) {
			$action_names = array( 'email' );
		}
		$settings['actions-after-submit'] = self::wrap_string_array( array_values( array_unique( $action_names ) ) );

		// The email action -> the `email` prop-type object (SUPPLEMENT §B.1). Use the first email action.
		foreach ( array_values( $actions ) as $action ) {
			if ( is_array( $action ) && isset( $action['type'] ) && 'email' === $action['type'] ) {
				$settings['email'] = self::map_atomic_email( $action );
				break;
			}
		}

		return array(
			'id'       => $id_minter(),
			'elType'   => self::ELEMENT_E_FORM,
			'settings' => $settings,
			'elements' => $children,
		);
	}

	/*
	------------------------------------------------------------------------------------------------
	 * GET /pro/form/actions
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * `GET /pro/form/actions` (10-rest-api.md §8.5). Returns ONLY the license-gated registered actions from
	 * `actions_registrar->get()`, each with `name`, `label`, and `settings_controls` (the control ids the
	 * action registers, read live from the form widget's section grouping).
	 *
	 * @param \WP_REST_Request $request The current request (unused).
	 * @return \WP_REST_Response|WP_Error
	 */
	public function actions_route( $request ) {
		unset( $request );

		$gate = Pro_Gate::require_pro();
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		return Response::success( array( 'actions' => $this->list_actions() ) );
	}

	/**
	 * The registered (license-gated) form actions with their control ids. Public so PHPUnit can assert it
	 * filters by the live registrar without a request.
	 *
	 * @return array<int,array{name:string,label:string,settings_controls:array<int,string>}>
	 */
	public function list_actions(): array {
		$module = self::forms_module();
		if ( null === $module || ! isset( $module->actions_registrar ) ) {
			return array();
		}

		// Populate the registrar (lazy — its `init()` adds the `actions/register` listener; firing it is
		// idempotent: the registrar de-dupes by id). form-actions-registrar.php:48-57.
		$this->ensure_actions_registered( $module );

		$items = $module->actions_registrar->get();
		if ( ! is_array( $items ) ) {
			return array();
		}

		$controls_by_action = $this->controls_by_action();

		$out = array();
		foreach ( $items as $id => $action ) {
			if ( ! is_object( $action ) || ! method_exists( $action, 'get_name' ) || ! method_exists( $action, 'get_label' ) ) {
				continue;
			}
			$name              = (string) $action->get_name();
			$settings_controls = isset( $controls_by_action[ $name ] ) ? array_values( $controls_by_action[ $name ] ) : array();
			$out[]             = array(
				'name'              => $name,
				'label'             => (string) $action->get_label(),
				'settings_controls' => $settings_controls,
			);
		}

		return $out;
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Live Pro lookups (registrar / filter / control sections).
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * The set of registered (license-gated) action names from `actions_registrar->get()`
	 * (form-actions-registrar.php). Returns the bare names (keys = action ids).
	 *
	 * @return string[]
	 */
	private function registered_action_names(): array {
		$module = self::forms_module();
		if ( null === $module || ! isset( $module->actions_registrar ) ) {
			return array();
		}
		$this->ensure_actions_registered( $module );

		$items = $module->actions_registrar->get();
		if ( ! is_array( $items ) ) {
			return array();
		}

		$names = array();
		foreach ( $items as $action ) {
			if ( is_object( $action ) && method_exists( $action, 'get_name' ) ) {
				$names[] = (string) $action->get_name();
			}
		}
		return array_values( array_unique( $names ) );
	}

	/**
	 * The allowed `field_type` set = the base list (Form_Mapper::BASE_FIELD_TYPES) ∪ any keys added by the
	 * live `elementor_pro/forms/field_types` filter (form.php:143). When the filter is unavailable (Pro
	 * inactive — not reached here, the gate runs first) the base list is returned.
	 *
	 * @return string[]
	 */
	private function allowed_field_types(): array {
		$base = Form_Mapper::BASE_FIELD_TYPES;
		if ( ! function_exists( 'apply_filters' ) ) {
			return $base;
		}
		// The live form passes a label-keyed map (`{type => label}`); the KEYS are the valid types.
		$seed = array();
		foreach ( $base as $type ) {
			$seed[ $type ] = $type;
		}
		$filtered = apply_filters( 'elementor_pro/forms/field_types', $seed ); // form.php:143.
		if ( ! is_array( $filtered ) || array() === $filtered ) {
			return $base;
		}
		return array_values( array_unique( array_map( 'strval', array_keys( $filtered ) ) ) );
	}

	/**
	 * Map each registered action name -> its `settings_controls` ids, read from the LIVE form widget by
	 * grouping controls by the section whose `condition.submit_actions == <action name>` (email.php:33-37,
	 * redirect.php:28-31, webhook.php:27-30 — every action's section carries this condition). License-aware:
	 * an action that is not registered has no section, so it contributes nothing.
	 *
	 * @return array<string,array<int,string>> name => control ids.
	 */
	private function controls_by_action(): array {
		$widget = self::form_widget();
		if ( null === $widget || ! method_exists( $widget, 'get_controls' ) ) {
			return array();
		}
		$controls = $widget->get_controls();
		if ( ! is_array( $controls ) ) {
			return array();
		}

		// section_id => action name (from its condition.submit_actions, a single string).
		$section_action = array();
		foreach ( $controls as $id => $control ) {
			if ( ! is_array( $control ) ) {
				continue;
			}
			$is_section = isset( $control['type'] ) && 'section' === $control['type'];
			$cond       = isset( $control['condition']['submit_actions'] ) ? $control['condition']['submit_actions'] : null;
			if ( $is_section && is_string( $cond ) && '' !== $cond ) {
				$section_action[ (string) $id ] = $cond;
			}
		}

		$by_action = array();
		foreach ( $controls as $id => $control ) {
			if ( ! is_array( $control ) ) {
				continue;
			}
			$section = isset( $control['section'] ) ? (string) $control['section'] : '';
			if ( '' === $section || ! isset( $section_action[ $section ] ) ) {
				continue;
			}
			$action_name                 = $section_action[ $section ];
			$by_action[ $action_name ]   = $by_action[ $action_name ] ?? array();
			$by_action[ $action_name ][] = (string) $id;
		}

		return $by_action;
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Atomic typed-envelope helpers (SUPPLEMENT §B.1).
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Build an atomic widget node `{id, elType:'widget', widgetType, settings, elements:[]}`.
	 *
	 * @param string              $id         The element id.
	 * @param string              $widget     The atomic widgetType (e.g. `e-form-input`).
	 * @param array<string,mixed> $settings   The typed-envelope settings.
	 * @return array<string,mixed>
	 */
	private static function atomic_widget( string $id, string $widget, array $settings ): array {
		return array(
			'id'         => $id,
			'elType'     => 'widget',
			'widgetType' => $widget,
			'settings'   => $settings,
			'elements'   => array(),
		);
	}

	/**
	 * Map an `email` action spec to the atomic `email` prop-type object (SUPPLEMENT §B.1). Fields are wrapped
	 * strings; `message` defaults to `[all-fields]`.
	 *
	 * @param array<string,mixed> $action The email action spec.
	 * @return array<string,mixed> The `{$$type:'email', value:{...}}` envelope.
	 */
	private static function map_atomic_email( array $action ): array {
		$value = array();

		$map = array(
			'to'        => 'email_to',
			'subject'   => 'email_subject',
			'from'      => 'email_from',
			'from-name' => 'email_from_name',
			'reply-to'  => 'email_reply_to',
			'cc'        => 'email_to_cc',
			'bcc'       => 'email_to_bcc',
		);
		foreach ( $map as $prop => $spec_key ) {
			if ( isset( $action[ $spec_key ] ) && is_scalar( $action[ $spec_key ] ) && '' !== (string) $action[ $spec_key ] ) {
				$value[ $prop ] = self::wrap_string( (string) $action[ $spec_key ] );
			}
		}

		$content          = isset( $action['email_content'] ) && is_scalar( $action['email_content'] ) ? (string) $action['email_content'] : '';
		$value['message'] = self::wrap_string( '' !== $content ? $content : '[all-fields]' );

		return array(
			'$$type' => 'email',
			'value'  => $value,
		);
	}

	/**
	 * Wrap a string in the `{$$type:'string', value}` envelope (SUPPLEMENT §B.1).
	 *
	 * @param string $value The string value.
	 * @return array{ "$$type":string, value:string }
	 */
	private static function wrap_string( string $value ): array {
		return array(
			'$$type' => 'string',
			'value'  => $value,
		);
	}

	/**
	 * Wrap a number in the `{$$type:'number', value}` envelope.
	 *
	 * @param int|float $value The numeric value.
	 * @return array{ "$$type":string, value:(int|float) }
	 */
	private static function wrap_number( $value ): array {
		return array(
			'$$type' => 'number',
			'value'  => $value,
		);
	}

	/**
	 * Wrap a boolean in the `{$$type:'boolean', value}` envelope.
	 *
	 * @param bool $value The boolean value.
	 * @return array{ "$$type":string, value:bool }
	 */
	private static function wrap_boolean( bool $value ): array {
		return array(
			'$$type' => 'boolean',
			'value'  => $value,
		);
	}

	/**
	 * Wrap a list of strings in the `{$$type:'string-array', value:[{$$type:'string',value}, ...]}` envelope.
	 *
	 * @param array<int,string> $values The string values.
	 * @return array<string,mixed>
	 */
	private static function wrap_string_array( array $values ): array {
		$items = array();
		foreach ( array_values( $values ) as $v ) {
			$items[] = self::wrap_string( (string) $v );
		}
		return array(
			'$$type' => 'string-array',
			'value'  => $items,
		);
	}

	/**
	 * Wrap plain text in the `html-v3` envelope `{$$type:'html-v3', value:{content:{$$type:'string',value}}}`
	 * (SUPPLEMENT §B.1/§B.2 — `e-form-submit-button` `text` is html-v3; author the `{content,children}` form).
	 *
	 * @param string $text The plain text.
	 * @return array<string,mixed>
	 */
	private static function wrap_html_v3( string $text ): array {
		return array(
			'$$type' => 'html-v3',
			'value'  => array(
				'content' => self::wrap_string( $text ),
			),
		);
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Internal WP helpers.
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Collect + normalize the build params from the request into the plain-array shape {@see build()} expects.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return array<string,mixed>
	 */
	private function collect_params( $request ): array {
		$keys = array( 'post_id', 'container_id', 'generation', 'form_name', 'button_text', 'input_size', 'show_labels', 'form_id', 'fields', 'actions', 'base_hash', 'prime_css', 'force', 'op_id' );
		$out  = array();
		foreach ( $keys as $key ) {
			$value = $request->get_param( $key );
			if ( null !== $value ) {
				$out[ $key ] = $value;
			}
		}
		return $out;
	}

	/**
	 * The Elementor Pro Forms module instance (or null when Pro/Forms is unavailable).
	 *
	 * @return object|null
	 */
	private static function forms_module() {
		if ( ! class_exists( '\ElementorPro\Modules\Forms\Module' ) ) {
			return null;
		}
		$module = \ElementorPro\Modules\Forms\Module::instance();
		return is_object( $module ) ? $module : null;
	}

	/**
	 * Fire the `elementor_pro/forms/actions/register` action so the actions registrar is populated (the
	 * registrar's `init()` listens for it; firing is idempotent — `Registrar::register()` de-dupes by id,
	 * form-actions-registrar.php:48-57). Safe to call repeatedly.
	 *
	 * @param object $module The forms module instance.
	 */
	private function ensure_actions_registered( $module ): void {
		if ( ! function_exists( 'do_action' ) || ! isset( $module->actions_registrar ) ) {
			return;
		}
		$existing = $module->actions_registrar->get();
		if ( is_array( $existing ) && array() !== $existing ) {
			return; // Already populated — avoid re-firing.
		}
		do_action( 'elementor_pro/forms/actions/register', $module->actions_registrar );
	}

	/**
	 * A live `form` widget instance whose controls are fully registered (its constructor runs
	 * `register_controls()`, which registers each action's section). Used to read `settings_controls`.
	 *
	 * @return object|null
	 */
	private static function form_widget() {
		if ( ! class_exists( '\ElementorPro\Modules\Forms\Widgets\Form' ) ) {
			return null;
		}
		try {
			$widget = new \ElementorPro\Modules\Forms\Widgets\Form();
		} catch ( \Throwable $e ) {
			return null;
		}
		return is_object( $widget ) ? $widget : null;
	}

	/**
	 * Whether `$post_id` is an Elementor-built document (mirrors the documents controller's guard).
	 *
	 * @param int $post_id The candidate post id.
	 */
	private static function is_elementor_post( int $post_id ): bool {
		if ( $post_id <= 0 || null === get_post( $post_id ) ) {
			return false;
		}
		return 'builder' === (string) get_post_meta( $post_id, '_elementor_edit_mode', true );
	}

	/**
	 * Read the current element tree from `_elementor_data` (mirrors the documents controller's read_tree).
	 *
	 * @param int $post_id The document id.
	 * @return array<int,array<string,mixed>>|null
	 */
	private static function read_tree( int $post_id ): ?array {
		$raw = get_post_meta( $post_id, '_elementor_data', true );
		if ( is_array( $raw ) ) {
			return $raw;
		}
		if ( is_string( $raw ) && '' !== $raw ) {
			$decoded = json_decode( $raw, true );
			return is_array( $decoded ) ? $decoded : null;
		}
		return null;
	}

	/**
	 * Validate the optional `op_id` (10 §0.8) — mirrors {@see Theme_Builder_Service::read_op_id()}.
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
	 * Append one op-log row behind a class_exists guard (soft dep — never fails the route).
	 *
	 * @param int         $post_id    The document id.
	 * @param string|null $op_id      The op id.
	 * @param string      $route      The route/tool label.
	 * @param string      $after_hash The post-write base_hash.
	 */
	private static function op_log( int $post_id, ?string $op_id, string $route, string $after_hash ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		\Elementor\Ultra\Core\Op_Log::record(
			array(
				'op_id'      => $op_id,
				'post_id'    => $post_id,
				'route'      => $route,
				'after_hash' => '' !== $after_hash ? $after_hash : md5( (string) get_post_meta( $post_id, '_elementor_data', true ) ),
				'result'     => 'ok',
			)
		);
	}
}
