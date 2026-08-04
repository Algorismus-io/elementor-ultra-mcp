<?php
/**
 * WP-R04 — Loop_Service: the Pro Loop Builder service — creates a `loop-item` template doc and binds a
 * `loop-grid`/`loop-carousel` widget to it with a prefixed query (SUPPLEMENT.md §A.4 / §A.7).
 *
 * Contract authority:
 *  - 10-rest-api.md §8.6 (`POST /pro/loop/item`, `POST /pro/loop/bind-grid`), §8 (Pro intro / 501 gate),
 *    §0.3 (cap map), §0.8 (op_id/base_hash), §0.9 (dry-run-before-commit), §0.10 (atomic CSS prime).
 *  - 12-error-taxonomy.md §3 (PRO_REQUIRED, NOT_FOUND, ATOMIC_SETTINGS_INVALID, SCHEMA_INVALID_PARAMS).
 *  - SUPPLEMENT.md §A.4 (worked CPT loop JSON + the `{skin}_query_` prefix + top-level posts_per_page
 *    gotcha), §A.7 (pro.loop.create_item / pro.loop.bind_grid I/O).
 *
 * Registration: the {@see \Elementor\Ultra\Rest\Pro_Controller} (WP-R01) lists this class in its
 * `SIBLING_SERVICES` and, on `rest_api_init`, instantiates it (class_exists-guarded by the SPL autoloader)
 * and merges this class's {@see routes()} descriptors into the `/pro/*` registration loop — so the two
 * routes register LIVE without this file editing the controller or the spine. The Pro_Controller IS a
 * `class-*-controller.php` picked up by the registrar glob, and it `use`s/references the sibling service
 * names, which the autoloader resolves on demand to THIS file (per the spine on-demand model).
 *
 * Elementor / Pro APIs (cited `path:line`):
 *  - `Plugin::$instance->documents->create('loop-item', {post_title,post_status})` →
 *    elementor/core/documents-manager.php (sets `_elementor_template_type='loop-item'`); the loop-item doc
 *    type is registered by elementor-pro/modules/loop-builder/module.php:287-288
 *    (`LoopDocument::DOCUMENT_TYPE='loop-item'`, documents/loop.php:26/46-47).
 *  - `_elementor_template_type` == `get_type()` — elementor/core/base/document.php:42 (read it directly via
 *    get_post_meta for the bind assertion — SUPPLEMENT §A.1).
 *  - loop-grid widget `get_name()='loop-grid'` (loop-grid.php:21); loop-carousel `'loop-carousel'`
 *    (loop-carousel.php:16-17); `template_id` control (loop-grid base.php:119-122,
 *    `Template_Query::CONTROL_ID`); a non-loop-item template silently renders nothing
 *    (loop-grid.php:154-190).
 *  - Skins `post`/`post_taxonomy` (loop-builder/module.php:26-27); Woo adds `product`/`product_taxonomy`
 *    (woocommerce/module.php:45-46) — present ONLY when WooCommerce is active.
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
 * Pro Loop Builder service. {@see Pro_Controller} owns route registration; this class returns its two route
 * descriptors via {@see routes()} and holds ALL loop business logic. The flat widget-settings derivation is
 * delegated to the pure {@see Loop_Query_Mapper}.
 */
final class Loop_Service {

	/** The canonical loop-item doc-type slug (loop-builder/module.php:24 / documents/loop.php:26). */
	const LOOP_ITEM_TYPE = 'loop-item';

	/** The two valid loop widget types (loop-grid.php:21 / loop-carousel.php:16-17). */
	const VALID_WIDGETS = array( 'loop-grid', 'loop-carousel' );

	/** The default loop widget (loop-grid). */
	const DEFAULT_WIDGET = 'loop-grid';

	/** The free-with-Pro skins (loop-builder/module.php:26-27) — always available when Pro is active. */
	const CORE_SKINS = array( 'post', 'post_taxonomy' );

	/** The Woo-only skins (woocommerce/module.php:45-46) — require WooCommerce active. */
	const WOO_SKINS = array( 'product', 'product_taxonomy' );

	/** The local wire-code label for a non-loop-item template binding (mapped onto the frozen taxonomy). */
	const REST_CODE_LOOP_TEMPLATE_INVALID = 'E_LOOP_TEMPLATE_INVALID';

	/** Op-log route label for `POST /pro/loop/item`. */
	const OP_ROUTE_ITEM = 'pro/loop/item';

	/** Op-log route label for `POST /pro/loop/bind-grid`. */
	const OP_ROUTE_BIND = 'pro/loop/bind-grid';

	/**
	 * The two loop route descriptors (10-rest-api.md §8.6). Same FROZEN descriptor shape every sibling Pro
	 * service `routes()` returns (WP-R01): `[ methods, route, callback, permission_callback, args ]`.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public function routes(): array {
		return array(
			// POST /pro/loop/item — CAP_EDIT_POST.
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'route'               => '/pro/loop/item',
				'callback'            => array( $this, 'create_item' ),
				'permission_callback' => Permissions::can_edit_post(),
				'args'                => array(
					'title'     => array(
						'type'     => 'string',
						'required' => false,
						'default'  => '',
					),
					'status'    => array(
						'type'     => 'string',
						'required' => false,
						'default'  => 'publish',
					),
					'elements'  => array(
						'type'     => 'array',
						'required' => false,
					),
					'prime_css' => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'op_id'     => array(
						'type'     => 'string',
						'required' => false,
					),
				),
			),
			// POST /pro/loop/bind-grid — CAP_EDIT_POST.
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'route'               => '/pro/loop/bind-grid',
				'callback'            => array( $this, 'bind_grid' ),
				'permission_callback' => Permissions::can_edit_post(),
				'args'                => array(
					'template_id'    => array(
						'type'        => array( 'string', 'integer' ),
						'required'    => true,
						'description' => 'The bound loop-item template id; must be a loop-item doc.',
					),
					'widget'         => array(
						'type'        => 'string',
						'required'    => false,
						'enum'        => self::VALID_WIDGETS,
						'default'     => self::DEFAULT_WIDGET,
						'description' => 'loop-grid|loop-carousel.',
					),
					'skin'           => array(
						'type'        => 'string',
						'required'    => false,
						'default'     => 'post',
						'description' => 'post|post_taxonomy|product|product_taxonomy (product* need Woo).',
					),
					'columns'        => array(
						'type'     => array( 'string', 'integer' ),
						'required' => false,
					),
					'posts_per_page' => array(
						'type'     => 'integer',
						'required' => false,
						'default'  => Loop_Query_Mapper::DEFAULT_POSTS_PER_PAGE,
					),
					'query'          => array(
						'type'        => 'object',
						'required'    => false,
						'default'     => array(),
						'description' => 'post_type, orderby?, order?, include_term_ids?, exclude_ids?, posts_ids?, query_id?.',
					),
					'pagination'     => array(
						'type'        => 'object',
						'required'    => false,
						'description' => '{type, load_type} -> pagination_type / pagination_load_type.',
					),
					'post_id'        => array(
						'type'        => 'integer',
						'required'    => false,
						'description' => 'When set with container_id, the widget is inserted + persisted.',
					),
					'container_id'   => array(
						'type'        => 'string',
						'required'    => false,
						'description' => 'The parent container element id to insert the widget under.',
					),
					'base_hash'      => array(
						'type'     => 'string',
						'required' => false,
					),
					'force'          => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'prime_css'      => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'op_id'          => array(
						'type'     => 'string',
						'required' => false,
					),
				),
			),
		);
	}

	/*
	 * ------------------------------------------------------------------------------------------------
	 * POST /pro/loop/item
	 * ---------------------------------------------------------------------------------------------
	 */

	/**
	 * `POST /pro/loop/item` (10-rest-api.md §8.6; SUPPLEMENT §A.7 pro.loop.create_item). Creates a post with
	 * `_elementor_template_type='loop-item'`; if `elements` present, validates via dry_run then persists via
	 * the transactional writer (atomic → optional prime). Compensating-deletes the draft on a failed write.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function create_item( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		// Pro presence (501 PRO_REQUIRED when absent) — first line of every /pro/* handler.
		$gate = Pro_Gate::require_pro( $op_id );
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		$documents = self::documents_manager();
		if ( null === $documents ) {
			return Response::error( Error_Codes::UPSTREAM_ERROR, __( 'Elementor documents manager is unavailable.', 'elementor-ultra-mcp' ), 502, array(), array(), $op_id );
		}

		$title  = (string) $request->get_param( 'title' );
		$status = (string) $request->get_param( 'status' );
		$status = '' !== $status ? $status : 'publish';

		// (a) create the loop-item doc (documents-manager->create sets `_elementor_template_type='loop-item'`;
		// the loop-item type is registered by loop-builder/module.php:287-288).
		$document = $documents->create(
			self::LOOP_ITEM_TYPE,
			array(
				'post_title'  => '' !== $title ? $title : __( 'Loop Item', 'elementor-ultra-mcp' ),
				'post_status' => $status,
			)
		);

		if ( is_wp_error( $document ) ) {
			return \Elementor\Ultra\Core\Error::from_wp_error( $document );
		}
		if ( ! is_object( $document ) || ! method_exists( $document, 'get_main_id' ) ) {
			return Response::error( Error_Codes::INTERNAL_ERROR, __( 'Loop-item creation returned an unexpected result.', 'elementor-ultra-mcp' ), 500, array(), array(), $op_id );
		}

		$template_id = (int) $document->get_main_id();

		$elements     = $request->get_param( 'elements' );
		$prime_css    = (bool) $request->get_param( 'prime_css' );
		$has_elements = is_array( $elements ) && array() !== $elements;

		// (b) validate the optional atomic tree FIRST; on failure DELETE the draft (compensation — no orphan).
		if ( $has_elements ) {
			$verdict = Validator::dry_run( $elements, array(), 0 );
			if ( empty( $verdict['valid'] ) ) {
				wp_delete_post( $template_id, true ); // Compensating delete (force — no trash).
				$errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
				return Response::error(
					Error_Codes::ATOMIC_SETTINGS_INVALID,
					sprintf(
						/* translators: %d: error count. */
						_n( 'The loop-item element tree failed validation (%d error); the draft was removed.', 'The loop-item element tree failed validation (%d errors); the draft was removed.', count( $errors ), 'elementor-ultra-mcp' ),
						count( $errors )
					),
					422,
					array( 'compensated' => true ),
					$errors,
					$op_id
				);
			}

			// (c) persist via the SAME transactional writer as /documents/{id}/save (validate → save → prime).
			$result = Document_Writer::save(
				$template_id,
				array(
					'elements'  => $elements,
					'op_id'     => $op_id,
					'prime_css' => $prime_css,
					'backup'    => true,
				)
			);
			if ( is_wp_error( $result ) ) {
				wp_delete_post( $template_id, true ); // Compensating delete — a save failure leaves no orphan.
				return $result;
			}
		}

		self::op_log( $template_id, $op_id, self::OP_ROUTE_ITEM );

		return Response::success(
			array(
				'template_id' => $template_id,
				'edit_url'    => self::edit_url( $document, $template_id ),
			),
			201
		);
	}

	/*
	 * ------------------------------------------------------------------------------------------------
	 * POST /pro/loop/bind-grid
	 * ---------------------------------------------------------------------------------------------
	 */

	/**
	 * `POST /pro/loop/bind-grid` (10-rest-api.md §8.6; SUPPLEMENT §A.4/§A.7). Builds a loop-grid/loop-carousel
	 * widget bound to a loop-item template + a prefixed query. ASSERTS the `template_id` is a loop-item doc
	 * (else 422 — the load-bearing guard). When `post_id`+`container_id` are present, validates the node via
	 * dry_run, inserts it under the container, and persists; otherwise returns just `{element}`.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function bind_grid( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$gate = Pro_Gate::require_pro( $op_id );
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		// --- widget + skin selection -----------------------------------------------------------------
		$widget = (string) $request->get_param( 'widget' );
		$widget = '' !== $widget ? $widget : self::DEFAULT_WIDGET;
		if ( ! in_array( $widget, self::VALID_WIDGETS, true ) ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'widget must be loop-grid or loop-carousel.', 'elementor-ultra-mcp' ),
				400,
				array(
					'path'     => 'widget',
					'expected' => self::VALID_WIDGETS,
				),
				array(),
				$op_id
			);
		}

		$skin = (string) $request->get_param( 'skin' );
		$skin = '' !== $skin ? $skin : 'post';

		// Skin/Woo coupling: product* skins require WooCommerce active (woocommerce/module.php:45-46).
		if ( in_array( $skin, self::WOO_SKINS, true ) && ! self::is_woo_active() ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'A product skin requires WooCommerce, which is not active on this site.', 'elementor-ultra-mcp' ),
				422,
				array(
					'path'   => 'skin',
					'skin'   => $skin,
					'reason' => 'product skin requires WooCommerce',
				),
				array(),
				$op_id
			);
		}
		if ( ! in_array( $skin, self::CORE_SKINS, true ) && ! in_array( $skin, self::WOO_SKINS, true ) ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'Unknown loop skin.', 'elementor-ultra-mcp' ),
				400,
				array(
					'path'     => 'skin',
					'expected' => array_merge( self::CORE_SKINS, self::WOO_SKINS ),
				),
				array(),
				$op_id
			);
		}

		// --- template_id loop-item assertion (THE load-bearing guard, §8.6) --------------------------
		$template_id     = self::read_template_id( $request->get_param( 'template_id' ) );
		$template_id_int = (int) $template_id;
		if ( '' === $template_id || $template_id_int <= 0 ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'template_id is required.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'template_id' ),
				array(),
				$op_id
			);
		}

		$template_post = get_post( $template_id_int );
		if ( ! $template_post ) {
			return Response::error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %d: template id. */
					__( 'Loop template %d was not found.', 'elementor-ultra-mcp' ),
					$template_id_int
				),
				404,
				array( 'template_id' => (string) $template_id ),
				array(),
				$op_id
			);
		}

		// Read `_elementor_template_type` directly — it equals get_type() (SUPPLEMENT §A.1). A non-loop-item
		// template silently renders nothing (loop-grid.php:154-190) → reject with the actual type in meta.
		$actual_type = (string) get_post_meta( $template_id_int, '_elementor_template_type', true );
		if ( self::LOOP_ITEM_TYPE !== $actual_type ) {
			$error = Response::error(
				Error_Codes::ATOMIC_SETTINGS_INVALID,
				__( 'template_id must reference a loop-item template; a non-loop-item template renders nothing.', 'elementor-ultra-mcp' ),
				422,
				array(
					'template_id'   => (string) $template_id,
					'actual_type'   => '' !== $actual_type ? $actual_type : null,
					'expected_type' => self::LOOP_ITEM_TYPE,
					'rest_code'     => self::REST_CODE_LOOP_TEMPLATE_INVALID,
				),
				array(),
				$op_id
			);
			return $error;
		}

		// --- build the flat widget settings via the pure mapper --------------------------------------
		$columns_param = $request->get_param( 'columns' );
		$columns       = ( null !== $columns_param && '' !== (string) $columns_param ) ? (string) $columns_param : null;

		$query = $request->get_param( 'query' );
		$query = is_array( $query ) ? $query : array();

		$pagination = $request->get_param( 'pagination' );
		$pagination = is_array( $pagination ) ? $pagination : null;

		$posts_per_page = (int) $request->get_param( 'posts_per_page' );

		$settings = Loop_Query_Mapper::map(
			$skin,
			$query,
			$posts_per_page,
			$columns,
			$pagination,
			(string) $template_id
		);

		// Assemble the widget element node (classic V3 loop widget — elType 'widget' + widgetType).
		$element = array(
			'id'         => self::mint_id(),
			'elType'     => 'widget',
			'widgetType' => $widget,
			'settings'   => $settings,
			'elements'   => array(),
		);

		// --- persist vs return-only ------------------------------------------------------------------
		$post_id      = (int) $request->get_param( 'post_id' );
		$container_id = (string) $request->get_param( 'container_id' );
		$want_persist = $post_id > 0 && '' !== $container_id;

		if ( ! $want_persist ) {
			self::op_log( $template_id_int, $op_id, self::OP_ROUTE_BIND );
			return Response::success(
				array(
					'element' => $element,
					'applied' => false,
				)
			);
		}

		// Validate the widget node via dry_run BEFORE any mutation (10 §0.9). post_id=0 here: this validates
		// the NODE's structural/atomic validity in isolation — the doc-collision check is left to the writer,
		// which re-mints/dedupes inserted ids against the live document during replace_tree (a node minted id
		// that happens to match an existing doc id is NOT an error; the writer remaps it).
		$verdict = Validator::dry_run( array( $element ), array(), 0 );
		if ( empty( $verdict['valid'] ) ) {
			$errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
			return Response::error(
				Error_Codes::ATOMIC_SETTINGS_INVALID,
				sprintf(
					/* translators: %d: error count. */
					_n( 'The loop widget failed validation (%d error); nothing was written.', 'The loop widget failed validation (%d errors); nothing was written.', count( $errors ), 'elementor-ultra-mcp' ),
					count( $errors )
				),
				422,
				array(),
				$errors,
				$op_id
			);
		}

		// Read the current tree, place the widget under `container_id`, then ONE replace_tree (the writer
		// re-mints ids, validates, backs up, and primes — exactly as /documents/{id}/elements does).
		$tree = self::read_tree( $post_id );
		if ( null === $tree ) {
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

		$placed = false;
		$tree   = self::place_under_container( $tree, $container_id, $element, $placed );
		if ( ! $placed ) {
			return Response::error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %s: container element id. */
					__( 'Container element "%s" was not found in the document.', 'elementor-ultra-mcp' ),
					$container_id
				),
				404,
				array(
					'post_id'      => $post_id,
					'container_id' => $container_id,
				),
				array(),
				$op_id
			);
		}

		$base_hash = (string) $request->get_param( 'base_hash' );
		$result    = Document_Writer::replace_tree(
			$post_id,
			array(
				'elements'  => $tree,
				'base_hash' => $base_hash,
				'op_id'     => $op_id,
				'force'     => (bool) $request->get_param( 'force' ),
				'prime_css' => (bool) $request->get_param( 'prime_css' ),
				'backup'    => true,
			)
		);
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		self::op_log( $post_id, $op_id, self::OP_ROUTE_BIND );

		return Response::success(
			array(
				'element'   => $element,
				'applied'   => true,
				'base_hash' => isset( $result['base_hash'] ) ? $result['base_hash'] : null,
			)
		);
	}

	/*
	 * ------------------------------------------------------------------------------------------------
	 * Internal helpers.
	 * ---------------------------------------------------------------------------------------------
	 */

	/**
	 * Whether WooCommerce is active (gates the `product`/`product_taxonomy` skins — woocommerce/module.php
	 * registers them only when Woo is present).
	 */
	private static function is_woo_active(): bool {
		return class_exists( '\WooCommerce' ) || ( function_exists( 'WC' ) );
	}

	/**
	 * Normalise the `template_id` param (string|int) to a non-empty string id (kept as a string in the
	 * widget settings — Template_Query stores it as a string).
	 *
	 * @param mixed $raw The raw param.
	 */
	private static function read_template_id( $raw ): string {
		if ( is_int( $raw ) ) {
			return $raw > 0 ? (string) $raw : '';
		}
		if ( is_string( $raw ) ) {
			$trimmed = trim( $raw );
			return ctype_digit( $trimmed ) ? $trimmed : '';
		}
		return '';
	}

	/**
	 * Place `$node` at the end of the children of the element whose id is `$container_id` (depth-first).
	 * Mirrors the granular-insert placement the WP-P06 documents controller uses, then hands the WHOLE tree
	 * to the writer (one save). Sets `$placed` true when the container is found.
	 *
	 * @param array<int,array<string,mixed>> $elements     The tree (transformed on a copy).
	 * @param string                         $container_id The parent element id.
	 * @param array<string,mixed>            $node         The widget node to insert.
	 * @param bool                           $placed       Out-param: whether the container was found.
	 *
	 * @return array<int,array<string,mixed>> The transformed tree.
	 */
	private static function place_under_container( array $elements, string $container_id, array $node, bool &$placed ): array {
		foreach ( $elements as $i => $element ) {
			if ( ! is_array( $element ) ) {
				continue;
			}
			if ( isset( $element['id'] ) && (string) $element['id'] === $container_id ) {
				$children            = isset( $element['elements'] ) && is_array( $element['elements'] ) ? $element['elements'] : array();
				$children[]          = $node;
				$element['elements'] = $children;
				$elements[ $i ]      = $element;
				$placed              = true;
				return $elements;
			}
			if ( isset( $element['elements'] ) && is_array( $element['elements'] ) ) {
				$element['elements'] = self::place_under_container( $element['elements'], $container_id, $node, $placed );
				$elements[ $i ]      = $element;
				if ( $placed ) {
					return $elements;
				}
			}
		}
		return $elements;
	}

	/**
	 * Mint a fresh element id (delegates to the WP-P04 {@see \Elementor\Ultra\Id_Service}; the writer
	 * re-mints/dedupes anyway on persist, but a return-only response still needs a valid id).
	 */
	private static function mint_id(): string {
		if ( class_exists( '\Elementor\Ultra\Id_Service' ) && method_exists( '\Elementor\Ultra\Id_Service', 'mint' ) ) {
			return \Elementor\Ultra\Id_Service::mint();
		}
		return substr( str_replace( '.', '', uniqid( '', true ) ), 0, 7 );
	}

	/**
	 * The post's `_elementor_data` tree as a decoded array (read-only). Null when the post is absent / not
	 * Elementor-built (an empty tree returns []).
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array<int,array<string,mixed>>|null
	 */
	private static function read_tree( int $post_id ): ?array {
		if ( $post_id <= 0 || ! get_post( $post_id ) ) {
			return null;
		}
		$raw = get_post_meta( $post_id, '_elementor_data', true );
		if ( is_array( $raw ) ) {
			return $raw;
		}
		if ( is_string( $raw ) && '' !== $raw ) {
			$decoded = json_decode( $raw, true );
			return is_array( $decoded ) ? $decoded : array();
		}
		// A post that has no _elementor_data yet but IS an Elementor post still accepts a tree (empty start).
		return ( 'builder' === get_post_meta( $post_id, '_elementor_edit_mode', true ) ) ? array() : null;
	}

	/**
	 * Validate the optional `op_id` (10-rest-api.md §0.8). Mirrors the theme service's helper (this is a
	 * plain service, not a controller).
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
