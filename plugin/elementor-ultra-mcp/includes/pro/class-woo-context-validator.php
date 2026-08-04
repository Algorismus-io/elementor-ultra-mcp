<?php
/**
 * WP-R06 — Woo_Context_Validator: the PURE WooCommerce widget × theme-builder-context contract.
 *
 * Contract authority:
 *  - 10-rest-api.md §8.8 (`POST /pro/woo/add-widget`: classify by category; single → require a
 *    single-product template, archive → require a shop/archive template, free/global → no context;
 *    mismatch → 422 `E_WOO_CONTEXT_INVALID` with `data.meta.{widget,required_context,actual_doc_type}`).
 *  - 12-error-taxonomy.md §3.4 (`WOO_CONTEXT_INVALID`, HTTP 422, surface isError).
 *  - SUPPLEMENT.md §A.5 (the widget × category × required-context table — baked in here as a constant
 *    map AND a live-`get_categories()` override path).
 *
 * Elementor Pro APIs (cited `path:line` — referenced by category, NOT instantiated here):
 *  - `Base_Widget` default category `woocommerce-elements-single` —
 *    elementor-pro/modules/woocommerce/widgets/base-widget.php:20-22 (`get_categories()` returns
 *    `['woocommerce-elements-single']`); every single-family widget inherits this.
 *  - Archive family category `woocommerce-elements-archive` — wc-archive-products (`Archive_Products`),
 *    woocommerce-archive-description, woocommerce-products (`Products`), wc-categories (SUPPLEMENT §A.5).
 *  - Context-free category `woocommerce-elements` — cart/checkout/my-account/purchase-summary/notices;
 *    `woocommerce-menu-cart` is `theme-elements,woocommerce-elements`; `wc-add-to-cart`
 *    (`Add_To_Cart extends Widget_Button`) is global and takes an explicit `product_id` (SUPPLEMENT §A.5).
 *  - Doc-type slug source for context: the target doc's `_elementor_template_type` = `get_type()`
 *    (elementor/core/base/document.php:42, save_template_type() :1451-1452). Woo removes `product` from
 *    `Module::get_public_post_types()` (elementor-pro/modules/theme-builder/module.php:44-46) so we
 *    validate via the doc's OWN type, NEVER via theme conditions (ticket Impl-Notes).
 *
 * This class is PURE: it performs NO WordPress I/O. The live `get_categories()` array is INJECTED by
 * {@see Woo_Service} (which resolves it from the widgets manager); the static §A.5 table is the fallback
 * for unregistered/unknown types. Every method is unit-testable without a WP bootstrap.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Rest\Response;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Pure WooCommerce context classifier + validator. Holds NO state and touches NO WordPress globals.
 */
final class Woo_Context_Validator {

	/** Context: widget requires a Single-Product theme-builder template (or a product page). */
	const CONTEXT_SINGLE = 'single';

	/** Context: widget requires a Products-Archive / Shop template. */
	const CONTEXT_ARCHIVE = 'archive';

	/** Context: context-free Woo widget (cart/checkout/my-account/menu-cart/notices). */
	const CONTEXT_FREE = 'free';

	/** Context: global widget (`wc-add-to-cart`) — placeable anywhere with an explicit `product_id`. */
	const CONTEXT_GLOBAL = 'global';

	/** Elementor Pro widget category for the single-product family (base-widget.php:20-22). */
	const CATEGORY_SINGLE = 'woocommerce-elements-single';

	/** Elementor Pro widget category for the products-archive family (SUPPLEMENT §A.5). */
	const CATEGORY_ARCHIVE = 'woocommerce-elements-archive';

	/** Elementor Pro widget category for context-free Woo widgets (SUPPLEMENT §A.5). */
	const CATEGORY_FREE = 'woocommerce-elements';

	/** The global add-to-cart widget that takes an explicit product_id (Add_To_Cart, SUPPLEMENT §A.5). */
	const WIDGET_ADD_TO_CART = 'wc-add-to-cart';

	/**
	 * The static §A.5 widget → context FALLBACK table. Used only when a live `get_categories()` array is
	 * unavailable (Woo inactive, or the widget type unregistered). The live category override (see
	 * {@see classify()}) takes precedence so NEW Woo widgets classify correctly without a table edit.
	 *
	 * @var array<string,string>
	 */
	const WIDGET_CONTEXT = array(
		// Single-product family (category woocommerce-elements-single).
		'woocommerce-product-title'                  => self::CONTEXT_SINGLE,
		'woocommerce-product-price'                  => self::CONTEXT_SINGLE,
		'woocommerce-product-images'                 => self::CONTEXT_SINGLE,
		'woocommerce-product-add-to-cart'            => self::CONTEXT_SINGLE,
		'woocommerce-product-rating'                 => self::CONTEXT_SINGLE,
		'woocommerce-product-stock'                  => self::CONTEXT_SINGLE,
		'woocommerce-product-meta'                   => self::CONTEXT_SINGLE,
		'woocommerce-product-short-description'      => self::CONTEXT_SINGLE,
		'woocommerce-product-content'                => self::CONTEXT_SINGLE,
		'woocommerce-product-data-tabs'              => self::CONTEXT_SINGLE,
		'woocommerce-product-additional-information' => self::CONTEXT_SINGLE,
		'woocommerce-product-related'                => self::CONTEXT_SINGLE, // Products_Base.
		'woocommerce-product-upsell'                 => self::CONTEXT_SINGLE, // Products_Base.
		'woocommerce-category-image'                 => self::CONTEXT_SINGLE,
		'woocommerce-breadcrumb'                     => self::CONTEXT_SINGLE,
		// Products-archive family (category woocommerce-elements-archive).
		'wc-archive-products'                        => self::CONTEXT_ARCHIVE, // Archive_Products.
		'woocommerce-archive-description'            => self::CONTEXT_ARCHIVE,
		'woocommerce-products'                       => self::CONTEXT_ARCHIVE, // Products.
		'wc-categories'                              => self::CONTEXT_ARCHIVE,
		// Context-free (category woocommerce-elements / theme-elements).
		'woocommerce-cart'                           => self::CONTEXT_FREE,
		'woocommerce-checkout-page'                  => self::CONTEXT_FREE,
		'woocommerce-my-account'                     => self::CONTEXT_FREE,
		'woocommerce-purchase-summary'               => self::CONTEXT_FREE,
		'woocommerce-notices'                        => self::CONTEXT_FREE,
		'woocommerce-menu-cart'                      => self::CONTEXT_FREE, // theme-elements,woocommerce-elements.
		// Global — explicit product_id, placeable anywhere (Add_To_Cart extends Widget_Button).
		self::WIDGET_ADD_TO_CART                     => self::CONTEXT_GLOBAL,
	);

	/**
	 * The set of `_elementor_template_type` slugs that satisfy the SINGLE context. A Woo single-product
	 * theme-builder template is registered by the Woo module as `product` (the WooCommerce single doc
	 * type); the typed Elementor single docs (`single`, `single-post`, `single-page`) also expose product
	 * controls when editing a product, so they are accepted (ticket Impl-Notes — accept the Woo module's
	 * registered product-single doc type and the single/single-post family). Validation is via the doc's
	 * OWN `_elementor_template_type`, never via theme conditions (theme-builder/module.php:44-46).
	 *
	 * @var string[]
	 */
	const SINGLE_DOC_TYPES = array( 'product', 'product-post', 'single', 'single-post', 'single-page' );

	/**
	 * The set of `_elementor_template_type` slugs that satisfy the ARCHIVE context. The Woo module
	 * registers `product-archive` (the Shop / products-archive template); the typed Elementor archive
	 * docs (`archive`, `search-results`) also render product loops on a shop archive (SUPPLEMENT §A.1).
	 *
	 * @var string[]
	 */
	const ARCHIVE_DOC_TYPES = array( 'product-archive', 'products-archive', 'archive', 'search-results' );

	/**
	 * The canonical `required_context` label surfaced in `data.meta.required_context` per the context
	 * (10-rest-api.md §8.8). `single` → `single-product`, `archive` → `products-archive`.
	 *
	 * @var array<string,string>
	 */
	const REQUIRED_CONTEXT_LABEL = array(
		self::CONTEXT_SINGLE  => 'single-product',
		self::CONTEXT_ARCHIVE => 'products-archive',
		self::CONTEXT_FREE    => 'none',
		self::CONTEXT_GLOBAL  => 'none',
	);

	/**
	 * Classify a Woo widget into one of `single|archive|free|global`. The LIVE `get_categories()` array
	 * (when supplied) is authoritative — a category of `woocommerce-elements-single` → single,
	 * `woocommerce-elements-archive` → archive, `woocommerce-elements`/`theme-elements`-only → free. The
	 * `wc-add-to-cart` widget is global regardless of category (it inherits the Button category). When no
	 * live categories are available (Woo inactive / unregistered type) the static §A.5 table is the
	 * fallback; an entirely unknown widget defaults to `single` (the `Base_Widget` default category) so a
	 * mystery Woo widget is conservatively gated to single-product rather than placed anywhere.
	 *
	 * @param string   $widget     The widget type id (e.g. `woocommerce-product-title`).
	 * @param string[] $categories The live `get_categories()` array (empty when unavailable).
	 * @return string One of self::CONTEXT_*.
	 */
	public static function classify( string $widget, array $categories = array() ): string {
		// `wc-add-to-cart` is ALWAYS global (explicit product_id) — its Button category would otherwise
		// misclassify it (Add_To_Cart extends Widget_Button, SUPPLEMENT §A.5).
		if ( self::WIDGET_ADD_TO_CART === $widget ) {
			return self::CONTEXT_GLOBAL;
		}

		// Live category override (preferred — new Woo widgets classify without a table edit, Impl-Notes).
		$categories = array_values( array_filter( $categories, 'is_string' ) );
		if ( array() !== $categories ) {
			if ( in_array( self::CATEGORY_SINGLE, $categories, true ) ) {
				return self::CONTEXT_SINGLE;
			}
			if ( in_array( self::CATEGORY_ARCHIVE, $categories, true ) ) {
				return self::CONTEXT_ARCHIVE;
			}
			if ( in_array( self::CATEGORY_FREE, $categories, true ) ) {
				return self::CONTEXT_FREE;
			}
		}

		// Static §A.5 fallback table (Woo inactive / unregistered type).
		if ( isset( self::WIDGET_CONTEXT[ $widget ] ) ) {
			return self::WIDGET_CONTEXT[ $widget ];
		}

		// Unknown Woo-prefixed widget → conservative single (the Base_Widget default category).
		return self::CONTEXT_SINGLE;
	}

	/**
	 * The `_elementor_template_type` slugs that satisfy a given context. `single` → the single-product doc
	 * types; `archive` → the shop/archive doc types; `free`/`global` → `[]` (no context requirement).
	 *
	 * @param string $context One of self::CONTEXT_*.
	 * @return string[]
	 */
	public static function required_doc_types( string $context ): array {
		switch ( $context ) {
			case self::CONTEXT_SINGLE:
				return self::SINGLE_DOC_TYPES;
			case self::CONTEXT_ARCHIVE:
				return self::ARCHIVE_DOC_TYPES;
			default:
				return array(); // free / global: placeable anywhere.
		}
	}

	/**
	 * The canonical `required_context` label for a context (10-rest-api.md §8.8 `data.meta`).
	 *
	 * @param string $context One of self::CONTEXT_*.
	 */
	public static function required_context_label( string $context ): string {
		return isset( self::REQUIRED_CONTEXT_LABEL[ $context ] ) ? self::REQUIRED_CONTEXT_LABEL[ $context ] : 'none';
	}

	/**
	 * Whether a context requires ANY validation against the target doc type. `free`/`global` skip it.
	 *
	 * @param string $context One of self::CONTEXT_*.
	 */
	public static function requires_context( string $context ): bool {
		return self::CONTEXT_SINGLE === $context || self::CONTEXT_ARCHIVE === $context;
	}

	/**
	 * Validate a classified context against the TARGET document's `_elementor_template_type`. Returns
	 * `true` when the placement is allowed (matching context, or a context-free/global widget), else a
	 * 422 `WOO_CONTEXT_INVALID` `WP_Error` whose `data.meta` carries `{widget, required_context,
	 * actual_doc_type}` (10-rest-api.md §8.8; 12-error-taxonomy.md §3.4). PURE — no WP I/O; the caller
	 * supplies `$actual_doc_type` (read from postmeta) and `$widget` (for the meta echo).
	 *
	 * @param string      $context        One of self::CONTEXT_*.
	 * @param string      $actual_doc_type The target doc's `_elementor_template_type` (may be '').
	 * @param string      $widget         The widget type id (for the error meta).
	 * @param string|null $op_id          Echoed request op_id when supplied.
	 * @return true|WP_Error
	 */
	public static function validate( string $context, string $actual_doc_type, string $widget = '', ?string $op_id = null ) {
		// free / global contexts place anywhere — never an error (10-rest-api.md §8.8).
		if ( ! self::requires_context( $context ) ) {
			return true;
		}

		$allowed = self::required_doc_types( $context );
		if ( in_array( $actual_doc_type, $allowed, true ) ) {
			return true;
		}

		return Response::error(
			Error_Codes::WOO_CONTEXT_INVALID,
			sprintf(
				/* translators: 1: widget type, 2: required context label, 3: actual doc type. */
				__( 'The WooCommerce widget "%1$s" requires a %2$s template; the target document type is "%3$s".', 'elementor-ultra-mcp' ),
				$widget,
				self::required_context_label( $context ),
				'' !== $actual_doc_type ? $actual_doc_type : '(none)'
			),
			422,
			array(
				'widget'           => $widget,
				'required_context' => self::required_context_label( $context ),
				'actual_doc_type'  => $actual_doc_type,
				'allowed_types'    => $allowed,
			),
			array(),
			$op_id
		);
	}
}
