<?php
/**
 * WP-P11 — NAV / MENUS REST controller: list nav menus, create + populate a menu in one call, and bind a
 * Pro nav-menu/mega-menu widget on a page to a WordPress menu term.
 *
 * Contract authority:
 *  - 10-rest-api.md §6 (NAV routes):
 *      • `GET  /nav/menus`        CAP_READ        — `{ items:[{term_id,name,slug,count}] }` (wraps `wp_get_nav_menus`).
 *      • `POST /nav/menus`        CAP_MANAGE      — `{name,items:[{title,url,parent,object_id,type}],op_id}`
 *                                                   → `{term_id,item_ids}` (wraps `wp_create_nav_menu` +
 *                                                   `wp_update_nav_menu_item`).
 *      • `POST /nav/bind-widget`  CAP_EDIT_POST   — `{post_id,element_id,term_id,base_hash,op_id}`
 *                                                   → `{success,base_hash}` (sets the widget's `settings.menu`).
 *  - 10-rest-api.md §0.3 (cap map), §0.5/§0.6 (envelopes), §0.7 (status table), §0.8 (`op_id` regex +
 *    `base_hash` optimistic lock on `bind-widget`).
 *  - 12-error-taxonomy.md §3.5 (`NOT_FOUND` 404 — post/element/term), §3.4 (`PRO_REQUIRED`).
 *
 * `bind-widget` is a genuine document WRITE (it mutates one element's `settings`), so it goes through the
 * universal write core {@see \Elementor\Ultra\Core\Document_Writer} (validate → base_hash/lock → backup →
 * SINGLE `Document::save`) — NEVER a raw `_elementor_data` meta write (11-authoring-contract.md §10,
 * 15-engineering-standards.md item 5). It is NOT atomic-CSS-affecting (it changes a setting, not styles),
 * so it does NOT prime CSS (WP-S01/WP-P05 do not apply here).
 *
 * SPIKE-VERIFIED CORRECTION (Pro source `nav-menu.php:69,1464` — verbatim read of the live Pro 4.1.0):
 *  - The contract describes setting `settings.menu` to a "derived menu_id", but the Pro nav-menu widget's
 *    `menu` SELECT control is keyed by the menu's SLUG, not its term_id:
 *        get_available_menus() builds `$options[ $menu->slug ] = $menu->name;`  (nav-menu.php:69-78)
 *        render() passes `'menu' => $settings['menu']` straight to `wp_nav_menu()` (nav-menu.php:1464),
 *        whose `menu` arg accepts a slug; on_export() reads `$element['settings']['menu']` as the slug and
 *        resolves it via `wp_get_nav_menu_object( $slug )` (nav-menu.php:1671-1672); on_import() writes the
 *        new SLUG back to `settings['menu']` (nav-menu.php:1711). The mega-menu widget shares the same
 *        slug-keyed `menu` control.
 *    Therefore `bind-widget` DERIVES the menu's SLUG from the supplied `term_id`
 *    (`wp_get_nav_menu_object( $term_id )->slug`) and stores THAT in `settings.menu` — the value the
 *    widget's `menu` control actually expects. The raw `term_id` would never resolve. (Recorded as a
 *    deviation in the WP manifest.)
 *
 * Self-registers with the WP-P02 {@see Registrar} via the `elementor_ultra/rest/register` action — it NEVER
 * edits the spine `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Document_Writer;
use Elementor\Ultra\Core\Guards;
use Elementor\Ultra\Error_Codes;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;
use WP_Term;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * NAV / MENUS controller (10-rest-api.md §6). Extends the WP-P02 base so it inherits the `{success,data}`
 * envelope, the taxonomy error helpers, the `op_id` parser and the `base_hash` helpers.
 */
final class Nav_Controller extends Abstract_Controller {

	/** Op-log route label for `POST /nav/menus`. */
	const OP_ROUTE_CREATE = 'nav/menus';

	/** Op-log route label for `POST /nav/bind-widget`. */
	const OP_ROUTE_BIND = 'nav/bind-widget';

	/**
	 * The Pro widget types that bind to a WordPress nav-menu term via their slug-keyed `menu` control
	 * (Pro `nav-menu.php` / `mega-menu.php` `get_name()`). Only these accept a `settings.menu` bind.
	 *
	 * @var string[]
	 */
	const BINDABLE_WIDGET_TYPES = array( 'nav-menu', 'mega-menu' );

	/**
	 * Register the three NAV routes under `elementor-ultra/v1` (10-rest-api.md §6). Each route declares its
	 * own `args` schema + `permission_callback` (this controller owns those, never the spine).
	 *
	 * @return void
	 */
	public function register_routes(): void {
		// GET /nav/menus — list (CAP_READ).
		$this->route(
			'/nav/menus',
			WP_REST_Server::READABLE,
			array( $this, 'list_menus' ),
			Permissions::can_read()
		);

		// POST /nav/menus — create + populate (CAP_MANAGE).
		$this->route(
			'/nav/menus',
			WP_REST_Server::CREATABLE, // POST.
			array( $this, 'create_menu' ),
			Permissions::can_manage(),
			array(
				'name'  => array(
					'type'        => 'string',
					'required'    => true,
					'description' => 'The menu name (becomes the nav-menu term name).',
				),
				'items' => array(
					'type'        => 'array',
					'required'    => false,
					'default'     => array(),
					'description' => 'Ordered menu items: {title,url,parent,object_id,type}. `parent` is 0 (top-level) or the 1-based index of an earlier item in this list (to nest within one call).',
				),
				'op_id' => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);

		// POST /nav/bind-widget — bind a Pro nav/mega-menu widget to a menu term (CAP_EDIT_POST, a document WRITE).
		$this->route(
			'/nav/bind-widget',
			WP_REST_Server::CREATABLE, // POST.
			array( $this, 'bind_widget' ),
			Permissions::can_edit_post(),
			array(
				'post_id'    => array(
					'type'        => 'integer',
					'required'    => true,
					'minimum'     => 1,
					'description' => 'The document (page/post) containing the widget.',
				),
				'element_id' => array(
					'type'        => 'string',
					'required'    => true,
					'description' => 'The target widget element id within the document tree.',
				),
				'term_id'    => array(
					'type'        => 'integer',
					'required'    => true,
					'minimum'     => 1,
					'description' => 'The WordPress nav-menu term id to bind.',
				),
				'base_hash'  => array(
					'type'        => 'string',
					'required'    => true,
					'description' => 'Optimistic-concurrency token (md5 of _elementor_data) from the last document read.',
				),
				'op_id'      => array(
					'type'     => 'string',
					'required' => false,
				),
				'force'      => array(
					'type'     => 'boolean',
					'required' => false,
					'default'  => false,
				),
			)
		);
	}

	// ---------------------------------------------------------------------------------------------------
	// GET /nav/menus
	// ---------------------------------------------------------------------------------------------------

	/**
	 * List the site's WordPress nav menus (10-rest-api.md §6). Maps each {@see WP_Term} to
	 * `{term_id,name,slug,count}` via `wp_get_nav_menus()`.
	 *
	 * @param WP_REST_Request $request The current request.
	 *
	 * @return WP_REST_Response
	 */
	public function list_menus( WP_REST_Request $request ): WP_REST_Response {
		unset( $request ); // No query params (full list per §6).

		$menus = wp_get_nav_menus();
		$items = array();

		if ( is_array( $menus ) ) {
			foreach ( $menus as $menu ) {
				if ( ! $menu instanceof WP_Term ) {
					continue;
				}
				$items[] = array(
					'term_id' => (int) $menu->term_id,
					'name'    => (string) $menu->name,
					'slug'    => (string) $menu->slug,
					'count'   => (int) $menu->count,
				);
			}
		}

		return $this->ok( array( 'items' => $items ) );
	}

	// ---------------------------------------------------------------------------------------------------
	// POST /nav/menus
	// ---------------------------------------------------------------------------------------------------

	/**
	 * Create a nav menu and populate it with items in one call (10-rest-api.md §6). Wraps
	 * `wp_create_nav_menu()` + `wp_update_nav_menu_item()`. Returns `{term_id, item_ids}` (item_ids ordered
	 * as supplied). `parent` is resolved within the batch: 0 = top-level; a 1-based index of an EARLIER item
	 * in this list nests under that item's freshly-created menu-item id; any other value is treated as an
	 * existing menu-item id (passed through).
	 *
	 * @param WP_REST_Request $request The current request.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public function create_menu( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$name = (string) $request->get_param( 'name' );
		$name = trim( $name );
		if ( '' === $name ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'A non-empty menu "name" is required.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'name' ),
				array(),
				$op_id
			);
		}

		$term_id = wp_create_nav_menu( $name );
		if ( is_wp_error( $term_id ) ) {
			// e.g. a duplicate name -> WP returns a WP_Error; surface it as a 422 validation failure.
			return $this->fail(
				Error_Codes::VALIDATION_FAILED,
				$term_id->get_error_message(),
				422,
				array( 'name' => $name ),
				array(),
				$op_id
			);
		}
		$term_id = (int) $term_id;

		$items = $request->get_param( 'items' );
		$items = is_array( $items ) ? $items : array();

		$item_ids = array();
		foreach ( $items as $index => $item ) {
			if ( ! is_array( $item ) ) {
				continue;
			}

			$parent_post_id = $this->resolve_parent( $item, $item_ids );

			$item_data = array(
				'menu-item-title'     => isset( $item['title'] ) ? (string) $item['title'] : '',
				'menu-item-url'       => isset( $item['url'] ) ? (string) $item['url'] : '',
				'menu-item-parent-id' => $parent_post_id,
				'menu-item-object-id' => isset( $item['object_id'] ) ? (int) $item['object_id'] : 0,
				'menu-item-type'      => isset( $item['type'] ) ? (string) $item['type'] : 'custom',
				'menu-item-status'    => 'publish',
			);

			// A real object reference (post/page/category) carries an `object` (e.g. 'page','category').
			if ( isset( $item['object'] ) && '' !== (string) $item['object'] ) {
				$item_data['menu-item-object'] = (string) $item['object'];
			}

			$new_item_id = wp_update_nav_menu_item( $term_id, 0, $item_data );
			if ( is_wp_error( $new_item_id ) ) {
				return $this->fail(
					Error_Codes::VALIDATION_FAILED,
					sprintf(
						/* translators: 1: zero-based item index, 2: WP error message. */
						__( 'Failed to create menu item at index %1$d: %2$s', 'elementor-ultra-mcp' ),
						(int) $index,
						$new_item_id->get_error_message()
					),
					422,
					array(
						'term_id' => $term_id,
						'index'   => (int) $index,
					),
					array(),
					$op_id
				);
			}

			$item_ids[] = (int) $new_item_id;
		}

		$this->op_log( $term_id, $op_id, self::OP_ROUTE_CREATE, 'ok' );

		return $this->ok(
			array(
				'term_id'  => $term_id,
				'item_ids' => $item_ids,
			)
		);
	}

	/**
	 * Resolve the parent menu-item post id for a create-item. `parent` 0/absent = top-level; a 1-based index
	 * of an EARLIER item in this batch nests under that item's freshly-created id; otherwise the value is
	 * treated as an existing menu-item post id (passed through verbatim).
	 *
	 * @param array<string,mixed> $item             The request item.
	 * @param array<int,int>      $created_item_ids The menu-item ids created so far (in order).
	 */
	private function resolve_parent( array $item, array $created_item_ids ): int {
		$parent = isset( $item['parent'] ) ? (int) $item['parent'] : 0;
		if ( $parent <= 0 ) {
			return 0;
		}

		// A 1-based index into THIS batch's already-created items => nest under that item.
		if ( $parent <= count( $created_item_ids ) ) {
			return (int) $created_item_ids[ $parent - 1 ];
		}

		// Otherwise treat it as an existing menu-item post id.
		return $parent;
	}

	// ---------------------------------------------------------------------------------------------------
	// POST /nav/bind-widget
	// ---------------------------------------------------------------------------------------------------

	/**
	 * Bind a Pro nav-menu/mega-menu widget on a page to a WordPress menu term (10-rest-api.md §6). Reads the
	 * document tree, locates `element_id`, asserts it is a bindable Pro nav widget, derives the menu SLUG
	 * from `term_id` (the value the widget's `menu` control expects — see the SPIKE correction in the file
	 * header), sets `settings.menu`, and routes the modified WHOLE tree through {@see Document_Writer} (single
	 * validate + single save, base_hash/lock/backup). Returns the fresh `{success, base_hash}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public function bind_widget( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		// Pro gate: the bindable nav widgets cannot exist without Elementor Pro (Detailed Requirements #4).
		$guards = new Guards();
		$pro    = $guards->require_pro( 'nav-menu' );
		if ( is_wp_error( $pro ) ) {
			return $this->attach_op_id( $pro, $op_id );
		}

		$post_id    = (int) $request->get_param( 'post_id' );
		$element_id = (string) $request->get_param( 'element_id' );
		$term_id    = (int) $request->get_param( 'term_id' );
		$base_hash  = (string) $request->get_param( 'base_hash' );
		$force      = (bool) $request->get_param( 'force' );

		// (a) The term must exist -> derive its slug (the value `settings.menu` stores; header SPIKE note).
		$menu_object = wp_get_nav_menu_object( $term_id );
		if ( ! $menu_object instanceof WP_Term ) {
			return $this->not_found( sprintf( 'Nav-menu term %d not found.', $term_id ), array( 'term_id' => $term_id ), $op_id );
		}
		$menu_slug = (string) $menu_object->slug;

		// (b) Read the document tree.
		$tree = $this->read_document_tree( $post_id );
		if ( null === $tree ) {
			return $this->not_found( sprintf( 'Document %d not found or has no Elementor data.', $post_id ), array( 'post_id' => $post_id ), $op_id );
		}

		// (c) Locate the target element by id (returns a reference into the tree).
		$found = false;
		$tree  = $this->set_widget_menu( $tree, $element_id, $menu_slug, $found, $bind_error );

		if ( ! $found ) {
			return $this->not_found(
				sprintf( 'Element %s not found in document %d.', $element_id, $post_id ),
				array(
					'post_id'    => $post_id,
					'element_id' => $element_id,
				),
				$op_id
			);
		}

		if ( null !== $bind_error ) {
			// The element exists but is NOT a bindable nav/mega-menu widget -> 422.
			return $this->attach_op_id( $bind_error, $op_id );
		}

		// (d) Route the modified WHOLE tree through the transactional writer (validate + base_hash/lock +
		// backup + SINGLE save). NEVER a raw _elementor_data write (11 §10, Standards item 5). The bind is a
		// setting change, not a style change, so it does NOT prime CSS (WP-S01 does not apply).
		$result = Document_Writer::replace_tree(
			$post_id,
			array(
				'elements'  => $tree,
				'base_hash' => $base_hash,
				'op_id'     => $op_id,
				'force'     => $force,
				'backup'    => true,
				'prime_css' => false,
			)
		);

		if ( is_wp_error( $result ) ) {
			return $this->attach_op_id( $result, $op_id );
		}

		$new_hash = isset( $result['base_hash'] ) ? (string) $result['base_hash'] : $this->current_base_hash( $post_id );

		$this->op_log( $post_id, $op_id, self::OP_ROUTE_BIND, 'ok' );

		return $this->ok(
			array(
				'success'   => true,
				'base_hash' => $new_hash,
			)
		);
	}

	// ---------------------------------------------------------------------------------------------------
	// Internal: tree read + walk.
	// ---------------------------------------------------------------------------------------------------

	/**
	 * Read a document's `_elementor_data` tree as a decoded array, or null when the post is absent / has no
	 * Elementor data (the NOT_FOUND case for `bind-widget`).
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array<int,array<string,mixed>>|null
	 */
	private function read_document_tree( int $post_id ): ?array {
		if ( $post_id <= 0 || null === get_post( $post_id ) ) {
			return null;
		}

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
	 * Depth-first walk that sets `settings.menu = $menu_slug` on the node whose element id is `$element_id`.
	 * Returns the (possibly modified) tree. `$found` is set true when the element id is located; `$bind_error`
	 * is set to a 422 WP_Error when the located element is NOT a bindable Pro nav/mega-menu widget
	 * (Acceptance Criteria — a non-nav widget returns 422).
	 *
	 * @param array<int,array<string,mixed>> $elements   The tree (or sub-tree) to walk.
	 * @param string                         $element_id The target element id.
	 * @param string                         $menu_slug  The menu slug to write into `settings.menu`.
	 * @param bool                           $found      OUT — set true once the element is located.
	 * @param WP_Error|null                  $bind_error OUT — set when the located element is not bindable.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private function set_widget_menu( array $elements, string $element_id, string $menu_slug, bool &$found, &$bind_error = null ) {
		foreach ( $elements as $i => $node ) {
			if ( $found ) {
				break;
			}
			if ( ! is_array( $node ) ) {
				continue;
			}

			$node_id = isset( $node['id'] ) ? (string) $node['id'] : '';
			if ( $node_id === $element_id ) {
				$found = true;

				$widget_type = isset( $node['widgetType'] ) ? (string) $node['widgetType'] : '';
				if ( ! in_array( $widget_type, self::BINDABLE_WIDGET_TYPES, true ) ) {
					$bind_error = $this->fail(
						Error_Codes::VALIDATION_FAILED,
						sprintf(
							/* translators: 1: element id, 2: its widget type. */
							__( 'Element %1$s is a "%2$s", not a bindable nav-menu/mega-menu widget; cannot bind a menu.', 'elementor-ultra-mcp' ),
							$element_id,
							'' !== $widget_type ? $widget_type : '(non-widget element)'
						),
						422,
						array(
							'element_id'       => $element_id,
							'widget_type'      => $widget_type,
							'bindable_widgets' => self::BINDABLE_WIDGET_TYPES,
						)
					);
					return $elements;
				}

				// Set settings.menu to the menu SLUG (the value the widget's `menu` control expects;
				// Pro nav-menu.php:69,1464 — see the file-header SPIKE correction).
				if ( ! isset( $node['settings'] ) || ! is_array( $node['settings'] ) ) {
					$node['settings'] = array();
				}
				$node['settings']['menu'] = $menu_slug;
				$elements[ $i ]           = $node;
				return $elements;
			}

			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$node['elements'] = $this->set_widget_menu( $node['elements'], $element_id, $menu_slug, $found, $bind_error );
				$elements[ $i ]   = $node;
			}
		}

		return $elements;
	}

	// ---------------------------------------------------------------------------------------------------
	// Internal: small helpers.
	// ---------------------------------------------------------------------------------------------------

	/**
	 * Build the canonical 404 `NOT_FOUND` taxonomy error (12-error-taxonomy.md §3.5) with the request op_id
	 * echoed (§0.8).
	 *
	 * @param string              $message The human message.
	 * @param array<string,mixed> $meta    Structured context (post_id/element_id/term_id).
	 * @param string|null         $op_id   The request op_id.
	 */
	private function not_found( string $message, array $meta, ?string $op_id ): WP_Error {
		return $this->fail( Error_Codes::NOT_FOUND, $message, 404, $meta, array(), $op_id );
	}

	/**
	 * Echo the request op_id into an existing taxonomy error's `data` block (§0.8) so the agent can correlate
	 * the failure with its request. No-op when there is no op_id or one is already present.
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

	/**
	 * Append one op-log row behind a class_exists guard (WP-P14; soft dep — never fails the route). Mirrors
	 * the writer's own op-log call so the two NAV writes are auditable (Detailed Requirements #5).
	 *
	 * @param int         $target_id The created term id / written post id.
	 * @param string|null $op_id     The request op_id.
	 * @param string      $route     The route/tool label.
	 * @param string      $result    The result label.
	 */
	private function op_log( int $target_id, ?string $op_id, string $route, string $result ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		\Elementor\Ultra\Core\Op_Log::record(
			array(
				'op_id'   => $op_id,
				'post_id' => $target_id,
				'route'   => $route,
				'result'  => $result,
			)
		);
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar; we
 * hand it a fresh controller instance so it registers the three §6 NAV routes WITHOUT editing the spine
 * `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Nav_Controller() );
		}
	}
);
