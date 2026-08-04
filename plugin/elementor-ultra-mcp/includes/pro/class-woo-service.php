<?php
/**
 * WP-R06 — Woo_Service: context-validated `POST /pro/woo/add-widget` (ULTRA, deferred).
 *
 * Contract authority:
 *  - 10-rest-api.md §8.8 (`POST /pro/woo/add-widget` — CAP_EDIT_POST; classify by category; single →
 *    require single-product template, archive → require shop/archive template, free/global → no context;
 *    mismatch → 422 `E_WOO_CONTEXT_INVALID` (`data.meta.{widget,required_context,actual_doc_type}`);
 *    `wc-add-to-cart` takes an explicit `product_id`, placeable anywhere; response `data`:
 *    `{ element, context_ok, context_warning, base_hash:<new> }`).
 *  - 10-rest-api.md §0.3 (cap map), §0.6 (error envelope), §0.8 (op_id/base_hash), §0.9 (dry-run
 *    before commit), §0.10 (atomic CSS prime flag).
 *  - 12-error-taxonomy.md §3.4 (`WOO_CONTEXT_INVALID` 422, `PRO_REQUIRED` 501 surface for Pro/Woo
 *    inactive — the `E_FEATURE_UNAVAILABLE` wire label, mirroring {@see Pro_Gate}), §3.5 (`NOT_FOUND`),
 *    §3.1 (`ATOMIC_SETTINGS_INVALID` for a node that fails dry_run).
 *  - SUPPLEMENT.md §A.5 (widget × category × context table), §A.7 (pro.woo.add_widget I/O).
 *
 * Elementor / Woo APIs (cited `path:line`):
 *  - WooCommerce presence: `class_exists('WooCommerce')` (the WC plugin main class) — the Woo plugin is
 *    NOT installed on the live dev site, so this route degrades to `woo-not-active` (501) while STILL
 *    registering (ticket: "Routes register live even if they return woo-not-active").
 *  - Pro Woo module presence: `\ElementorPro\Modules\Woocommerce\Module` (elementor-pro/modules/
 *    woocommerce/module.php) — required for the Woo widgets to be registered.
 *  - Live `get_categories()`: `\Elementor\Plugin::$instance->widgets_manager->get_widget_types($type)`
 *    then `$widget->get_categories()` (widgets-manager; base-widget.php:20-22 default
 *    `woocommerce-elements-single`). When the widget is unregistered the static §A.5 table is the
 *    fallback (handled by {@see Woo_Context_Validator}).
 *  - Target doc type: `_elementor_template_type` = `get_type()` (elementor/core/base/document.php:42).
 *    Woo removes `product` from `Module::get_public_post_types()` (elementor-pro/modules/theme-builder/
 *    module.php:44-46) so context is validated via the doc's OWN type, never theme conditions
 *    (ticket Impl-Notes).
 *
 * The widget node is built (classic V3 by default; atomic if the live type exposes `get_props_schema()`,
 * ticket Impl-Notes), classified + context-validated by the PURE {@see Woo_Context_Validator}, validated
 * via the AUTHORITATIVE {@see \Elementor\Ultra\Validator::dry_run()} (WP-P03), inserted under
 * `container_id` via the SAME granular {@see \Elementor\Ultra\Rest\Element_Ops} applier (WP-P06) +
 * persisted through the SAME transactional {@see \Elementor\Ultra\Core\Document_Writer::replace_tree()}
 * (WP-P04 — base_hash/lock/autosave/backup/op_id, CSS prime via WP-P05/S01) as `/documents/{id}/elements`.
 *
 * Route registration: this service exposes a public `routes(): array` returning the FROZEN descriptor
 * shape; the WP-R01 {@see \Elementor\Ultra\Rest\Pro_Controller} already lists
 * `\Elementor\Ultra\Pro\Woo_Service` in its `SIBLING_SERVICES` and merges `routes()` into the live
 * `/pro/*` table — so the route registers LIVE the moment this class file lands (no edit to the
 * controller needed; the SPL autoloader resolves this class when the controller references it).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

use Elementor\Ultra\Core\Document_Writer;
use Elementor\Ultra\Core\Id_Service;
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
 * WooCommerce add-widget service. The {@see \Elementor\Ultra\Rest\Pro_Controller} owns route
 * registration; this class returns its route descriptor via {@see routes()} and holds ALL Woo business
 * logic. The context-validation contract lives in the PURE {@see Woo_Context_Validator}.
 */
final class Woo_Service {

	/** Op-log route label for `POST /pro/woo/add-widget`. */
	const OP_ROUTE = 'pro/woo/add-widget';

	/**
	 * The route descriptor for `POST /pro/woo/add-widget` (10-rest-api.md §8.8). Returns the FROZEN
	 * descriptor shape every sibling Pro service `routes()` returns (the WP-R01 controller loop registers
	 * it): `[ 'methods', 'route', 'callback', 'permission_callback', 'args' ]`.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public function routes(): array {
		return array(
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'route'               => '/pro/woo/add-widget',
				'callback'            => array( $this, 'add_widget' ),
				'permission_callback' => Permissions::can_edit_post(), // No path id ⇒ falls back to edit_posts; edit_post enforced via the writer.
				'args'                => array(
					'post_id'       => array(
						'type'              => 'integer',
						'required'          => true,
						'minimum'           => 1,
						'sanitize_callback' => 'absint',
						'description'       => 'Target Elementor document id.',
					),
					'container_id'  => array(
						'type'        => 'string',
						'required'    => true,
						'description' => 'The container element id the widget is inserted under.',
					),
					'widget'        => array(
						'type'        => 'string',
						'required'    => true,
						'description' => 'A WooCommerce widget type (e.g. woocommerce-product-title, wc-add-to-cart).',
					),
					'product_id'    => array(
						'type'        => 'integer',
						'required'    => false,
						'description' => 'REQUIRED for wc-add-to-cart (the product to add); ignored otherwise.',
					),
					'settings'      => array(
						'type'        => 'object',
						'required'    => false,
						'description' => 'Optional widget settings merged into the built node.',
					),
					'index'         => array(
						'type'        => 'integer',
						'required'    => false,
						'default'     => 0,
						'description' => 'Insert position within the container children (default 0).',
					),
					'base_hash'     => array(
						'type'        => 'string',
						'required'    => true,
						'description' => 'Optimistic-concurrency token (md5 of _elementor_data). Re-read /documents/{id} for a fresh one.',
					),
					'force'         => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
					'context_force' => array(
						'type'        => 'boolean',
						'required'    => false,
						'default'     => false,
						'description' => 'Soft mode: place a context-mismatched widget anyway with context_ok:false + a warning (§8.8). Default = hard 422.',
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
		);
	}

	/**
	 * `POST /pro/woo/add-widget` (10-rest-api.md §8.8). Sequence:
	 *   (0) op_id validate → Pro gate (501 PRO_REQUIRED) → WooCommerce presence (501 woo-not-active).
	 *   (1) Resolve the target doc + its `_elementor_template_type`; 404 if not Elementor-built.
	 *   (2) Classify the widget via live `get_categories()` (fallback §A.5 table) → single|archive|free|global.
	 *   (3) Context-validate against the doc type. Hard 422 WOO_CONTEXT_INVALID unless `context_force:true`
	 *       (soft mode → context_ok:false + context_warning, still placed).
	 *   (4) `wc-add-to-cart` REQUIRES `product_id` (400 SCHEMA_INVALID_PARAMS otherwise).
	 *   (5) Build the node (classic by default; atomic if probed), dry_run, insert under `container_id`
	 *       via Element_Ops + persist via Document_Writer::replace_tree (base_hash/lock/autosave/backup/op_id/prime).
	 *   (6) Respond `{ element, context_ok, context_warning, base_hash:<new> }`.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function add_widget( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		// Pro presence (501 PRO_REQUIRED) — first line of every /pro/* handler.
		$gate = Pro_Gate::require_pro( $op_id );
		if ( $gate instanceof WP_Error ) {
			return $gate;
		}

		// WooCommerce + Pro Woo module presence (ticket Detailed-Req #1). 501 `woocommerce:false` when
		// absent — the Woo plugin is NOT installed on the live dev site, so this is the live path.
		$woo = self::woo_availability();
		if ( ! $woo['available'] ) {
			return Response::error(
				Error_Codes::PRO_REQUIRED,
				__( 'This route requires WooCommerce + the Elementor Pro WooCommerce module, which are not active on this site.', 'elementor-ultra-mcp' ),
				Pro_Gate::FEATURE_UNAVAILABLE_STATUS, // 501 — the §0.7 E_FEATURE_UNAVAILABLE status.
				array(
					'pro_active'     => true,
					'woocommerce'    => $woo['woocommerce'],
					'pro_woo_module' => $woo['module'],
				),
				array(),
				$op_id
			);
		}

		$widget = (string) $request->get_param( 'widget' );
		if ( '' === $widget ) {
			return self::schema_error( 'widget', __( 'A "widget" type is required.', 'elementor-ultra-mcp' ), $op_id );
		}

		$post_id = (int) $request->get_param( 'post_id' );
		if ( ! self::is_elementor_post( $post_id ) ) {
			return Response::error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %d: post id. */
					__( 'Document %d was not found or is not Elementor-built.', 'elementor-ultra-mcp' ),
					$post_id
				),
				404,
				array(
					'resource' => 'post',
					'id'       => $post_id,
				),
				array(),
				$op_id
			);
		}

		$actual_doc_type = (string) get_post_meta( $post_id, '_elementor_template_type', true );

		// (2) Classify via the live get_categories() (preferred), falling back to the static §A.5 table.
		$categories = self::widget_categories( $widget );
		$context    = Woo_Context_Validator::classify( $widget, $categories );

		// (4) wc-add-to-cart REQUIRES an explicit product_id (ticket Detailed-Req #6 / Acceptance).
		$product_id = $request->get_param( 'product_id' );
		$product_id = ( null !== $product_id && '' !== $product_id ) ? (int) $product_id : 0;
		if ( Woo_Context_Validator::WIDGET_ADD_TO_CART === $widget && $product_id <= 0 ) {
			return self::schema_error(
				'product_id',
				__( 'wc-add-to-cart requires a "product_id" (the product to add).', 'elementor-ultra-mcp' ),
				$op_id
			);
		}

		// (3) Context validation. Hard 422 unless context_force:true (soft mode → place with a warning).
		$context_force   = (bool) $request->get_param( 'context_force' );
		$context_ok      = true;
		$context_warning = null;
		$verdict         = Woo_Context_Validator::validate( $context, $actual_doc_type, $widget, $op_id );
		if ( $verdict instanceof WP_Error ) {
			if ( ! $context_force ) {
				return $verdict; // Default behaviour: hard 422 WOO_CONTEXT_INVALID.
			}
			// Soft mode (§8.8): place anyway, report context_ok:false + a human warning.
			$context_ok      = false;
			$context_warning = (string) $verdict->get_error_message();
		}

		// (5) Build the node, dry_run, insert under container_id, persist transactionally.
		$node = self::build_node( $widget, $request->get_param( 'settings' ), $product_id );

		// Authoritative validate-before-persist (10-rest-api.md §0.9 / WP-P03). $post_id => existing-id dedupe context.
		$dry = Validator::dry_run( array( $node ), array(), $post_id );
		if ( empty( $dry['valid'] ) ) {
			$errors = isset( $dry['errors'] ) && is_array( $dry['errors'] ) ? $dry['errors'] : array();
			return Response::error(
				Error_Codes::ATOMIC_SETTINGS_INVALID,
				sprintf(
					/* translators: 1: widget type. */
					__( 'The "%1$s" widget node failed validation and was not inserted.', 'elementor-ultra-mcp' ),
					$widget
				),
				422,
				array(
					'requested_type' => $widget,
					'context'        => $context,
				),
				$errors,
				$op_id
			);
		}

		$base_hash = (string) $request->get_param( 'base_hash' );
		$index     = (int) $request->get_param( 'index' );

		// Reuse the SAME granular applier as POST /documents/{id}/elements (WP-P06): an `insert` op under
		// `container_id`. Element_Ops mints a fresh, collision-free id for the node (Id_Service) + walks
		// the tree to place it; a missing container id → 404 from the applier.
		$current = self::read_tree( $post_id );
		$current = is_array( $current ) ? $current : array();

		$container_id = (string) $request->get_param( 'container_id' );
		$applied      = Element_Ops::apply(
			$current,
			array(
				array(
					'op'        => 'insert',
					'parent_id' => $container_id,
					'index'     => $index,
					'node'      => $node,
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

		// Resolve the freshly-minted node id (Element_Ops dedupes the inserted node's id against the tree).
		$inserted_id = self::remapped_id( (string) ( $node['id'] ?? '' ), $applied['remapped'] );

		// ONE transactional save of the resulting whole tree (validate-before-persist inside the writer):
		// base_hash optimistic-concurrency, lock/autosave guard, backup-before-write, op_id, CSS prime.
		$result = Document_Writer::replace_tree(
			$post_id,
			array(
				'elements'  => $applied['elements'],
				'base_hash' => $base_hash,
				'op_id'     => $op_id,
				'force'     => (bool) $request->get_param( 'force' ),
				'prime_css' => (bool) $request->get_param( 'prime_css' ),
				'backup'    => true,
			)
		);
		if ( is_wp_error( $result ) ) {
			return $result; // base_hash mismatch / lock / autosave / atomic-invalid all surface here.
		}

		self::op_log( $post_id, $op_id, self::OP_ROUTE );

		// (6) §8.8 response: the inserted element (with its final id), context flags, the NEW base_hash.
		$element       = $node;
		$element['id'] = '' !== $inserted_id ? $inserted_id : ( $node['id'] ?? '' );

		$data = array(
			'element'         => $element,
			'context_ok'      => $context_ok,
			'context_warning' => $context_warning,
			'base_hash'       => isset( $result['base_hash'] ) ? $result['base_hash'] : self::current_base_hash( $post_id ),
			'prime_required'  => ! empty( $result['prime_required'] ),
			'css_primed'      => ! empty( $result['css_primed'] ),
			'context'         => $context,
		);

		return Response::success( $data, 201 );
	}

	// =================================================================================================
	// Internal helpers.
	// =================================================================================================

	/**
	 * WooCommerce + Pro Woo module availability. `available` is true only when BOTH WooCommerce (the WC
	 * plugin) AND the Elementor Pro WooCommerce module are loaded — otherwise the Woo widgets are absent
	 * and the route degrades to `woo-not-active` (501). The Woo plugin is NOT installed on the live dev
	 * site, so `available` is false there (graceful degradation; the route still REGISTERS).
	 *
	 * @return array{available:bool,woocommerce:bool,module:bool}
	 */
	private static function woo_availability(): array {
		$woocommerce = class_exists( 'WooCommerce' ); // WC plugin main class.
		$module      = class_exists( '\ElementorPro\Modules\Woocommerce\Module' ); // Pro Woo module.
		return array(
			'available'   => $woocommerce && $module,
			'woocommerce' => $woocommerce,
			'module'      => $module,
		);
	}

	/**
	 * The live `get_categories()` array for a widget type, or `[]` when the type is unregistered (Woo
	 * inactive / unknown). Resolves the widget instance via the widgets manager
	 * (`widgets_manager->get_widget_types($type)`) then calls `get_categories()` (base-widget.php:20-22).
	 * The PURE {@see Woo_Context_Validator::classify()} uses the static §A.5 table as the fallback when
	 * this returns `[]`.
	 *
	 * @param string $widget The widget type id.
	 * @return string[]
	 */
	private static function widget_categories( string $widget ): array {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return array();
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->widgets_manager ) || ! is_object( $plugin->widgets_manager ) ) {
			return array();
		}
		if ( ! method_exists( $plugin->widgets_manager, 'get_widget_types' ) ) {
			return array();
		}
		$instance = $plugin->widgets_manager->get_widget_types( $widget );
		if ( ! is_object( $instance ) || ! method_exists( $instance, 'get_categories' ) ) {
			return array();
		}
		$categories = $instance->get_categories();
		return is_array( $categories ) ? array_values( array_filter( $categories, 'is_string' ) ) : array();
	}

	/**
	 * Build the Woo widget element node. Classic V3 by default (most Woo widgets are classic, ticket
	 * Impl-Notes); the node carries a minted id, `elType:widget`, the `widgetType`, an empty children
	 * array, and the merged settings. `wc-add-to-cart` gets its `product_id` control set. The
	 * validate-before-persist step ({@see Validator::dry_run}) is the authority on whether the produced
	 * node is acceptable — this builder is deliberately thin (the full per-widget control set is additive
	 * later; the load-bearing deliverable is the context contract).
	 *
	 * @param string $widget     The widget type id.
	 * @param mixed  $settings   Optional caller-supplied settings (object/array).
	 * @param int    $product_id The product id for wc-add-to-cart (0 when N/A).
	 * @return array<string,mixed>
	 */
	private static function build_node( string $widget, $settings, int $product_id ): array {
		$settings = is_array( $settings ) ? $settings : array();

		// wc-add-to-cart takes an explicit product_id (Add_To_Cart control), placeable anywhere.
		if ( Woo_Context_Validator::WIDGET_ADD_TO_CART === $widget && $product_id > 0 ) {
			$settings['product_id'] = (string) $product_id;
		}

		return array(
			'id'         => Id_Service::mint(),
			'elType'     => 'widget',
			'widgetType' => $widget,
			'settings'   => $settings,
			'elements'   => array(),
		);
	}

	/**
	 * Resolve the post-insert id for a node whose id may have been remapped by the {@see Element_Ops}
	 * dedupe pass (so the response echoes the node's FINAL id).
	 *
	 * @param string               $original The node id before insert.
	 * @param array<string,string> $remapped The applier's `{old=>new}` remap map.
	 */
	private static function remapped_id( string $original, array $remapped ): string {
		if ( '' === $original ) {
			return '';
		}
		return isset( $remapped[ $original ] ) ? (string) $remapped[ $original ] : $original;
	}

	/**
	 * Whether a post is an Elementor-built document (`_elementor_edit_mode='builder'`). Mirrors
	 * {@see \Elementor\Ultra\Rest\Documents_Controller::is_elementor_post()} (a plain service can't reach
	 * the controller's private helper).
	 *
	 * @param int $post_id The document id.
	 */
	private static function is_elementor_post( int $post_id ): bool {
		if ( $post_id <= 0 || null === get_post( $post_id ) ) {
			return false;
		}
		return 'builder' === (string) get_post_meta( $post_id, '_elementor_edit_mode', true );
	}

	/**
	 * Read + decode `_elementor_data` for a document (array or JSON string), or null.
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
	 * The current base_hash (`md5(_elementor_data)`) — the fallback when the writer result omits it.
	 *
	 * @param int $post_id The document id.
	 */
	private static function current_base_hash( int $post_id ): string {
		return md5( (string) get_post_meta( $post_id, '_elementor_data', true ) );
	}

	/**
	 * A 400 `SCHEMA_INVALID_PARAMS` WP_Error for a missing/invalid request field.
	 *
	 * @param string      $path    The offending param path.
	 * @param string      $message Human message.
	 * @param string|null $op_id   Echoed op_id.
	 * @return WP_Error
	 */
	private static function schema_error( string $path, string $message, ?string $op_id ): WP_Error {
		return Response::error(
			Error_Codes::SCHEMA_INVALID_PARAMS,
			$message,
			400,
			array( 'path' => $path ),
			array(),
			$op_id
		);
	}

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
				'after_hash' => self::current_base_hash( $post_id ),
				'result'     => 'ok',
			)
		);
	}
}
