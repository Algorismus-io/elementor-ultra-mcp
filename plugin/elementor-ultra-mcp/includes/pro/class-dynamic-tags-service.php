<?php
/**
 * WP-R05 — Dynamic_Tags_Service: bind a dynamic tag (tag_to_text mirror) + list tags + per-tag schema.
 *
 * Contract authority:
 *  - 10-rest-api.md §8.7 (`POST /pro/dynamic/bind`, `GET /pro/dynamic/tags`,
 *    `GET /pro/dynamic/tags/{name}`).
 *  - 10-rest-api.md §0.3 (cap map: bind=CAP_EDIT_POST, tags=CAP_READ), §0.6 (envelope),
 *    §0.8 (base_hash/op_id), §0.9 (dry-run-before-commit), §8 (Pro intro: 501 PRO_REQUIRED gate).
 *  - 12-error-taxonomy.md §3.1 (`VALIDATION_FAILED` — the taxonomy surface of the REST wire-code
 *    `E_DYNAMIC_INCOMPATIBLE`; meta carries `rest_code`,`control`,`tag`,`control_categories`,
 *    `tag_categories`), §3.5 (`NOT_FOUND`), §3.4 (`PRO_REQUIRED`).
 *  - SUPPLEMENT.md §A.6 (dynamic-tags groups/categories, the `[elementor-tag …]` shortcode encoding,
 *    `__dynamic__[control]` storage, the dynamic-active + category-intersection rule, ACF license gate).
 *
 * Elementor APIs (cited `path:line` relative to plugins/elementor / plugins/elementor-pro):
 *  - `\Elementor\Plugin::$instance->dynamic_tags` = `Dynamic_Tags\Manager` (core, ALWAYS present —
 *    constructed at includes/plugin.php:711). Core dynamic tags work WITHOUT Pro; only the Pro/ACF tag
 *    FAMILIES need Pro (SUPPLEMENT §A.6 + ticket Detailed-Req #8), so `bind` of a CORE tag does NOT
 *    require the Pro gate; Pro/ACF tags are gated.
 *  - `Manager::get_tags()` — core/dynamic-tags/manager.php:272-309: `[tag_name => ['class','instance']]`.
 *  - `Manager::get_tag_info($name)` — manager.php:258-266 (null when unregistered).
 *  - `Manager::DYNAMIC_SETTING_KEY = '__dynamic__'` — manager.php:22 (binding storage key).
 *  - `Base_Tag` (extends `Controls_Stack`) — core/dynamic-tags/base-tag.php:19: `get_name()`,
 *    `get_title()` (:53), `get_group()` (:42), `get_categories()` (:35), `get_controls()` (inherited).
 *  - `Manager::tag_to_text()` — manager.php:141-142 (reproduced byte-identically by {@see Dynamic_Encoder}).
 *  - Pro `Modules\DynamicTags\Module::LICENSE_FEATURE_ACF_NAME = 'dynamic-tags-acf'` +
 *    `\ElementorPro\License\API::is_licence_has_feature()` — elementor-pro/modules/dynamic-tags/module.php:34,
 *    used to compute `available` for ACF-group tags (license-gated, SUPPLEMENT §A.6).
 *  - Control `dynamic` config `['active'=>true,'categories'=>[...]]` read off the target widget's control
 *    schema (V3 `get_controls()[control]['dynamic']`; V4 `get_props_schema()[control]` dynamic union member
 *    via schema/widget) — SUPPLEMENT §A.6; mirrors {@see \Elementor\Ultra\Rest\Schema_Controller}.
 *
 * The bind WRITE mutates ONE element's `settings.__dynamic__[control]` (and optional static fallback
 * `settings[control]`) then persists via the SAME transactional {@see \Elementor\Ultra\Core\Document_Writer}
 * (WP-P04) every write routes through — backup -> base_hash/lock/autosave check -> AUTHORITATIVE dry_run
 * (WP-P03) -> SINGLE Document::save -> new base_hash. It NEVER raw-writes `_elementor_data`.
 *
 * The {@see \Elementor\Ultra\Rest\Pro_Controller} (WP-R01) OWNS route registration; this class returns its
 * three route descriptors via {@see routes()} (the controller's `SIBLING_SERVICES` loop instantiates this
 * class — `\Elementor\Ultra\Pro\Dynamic_Tags_Service` — and merges them). To keep `files_owned` disjoint
 * this file is NEVER edited by the controller and the controller is NEVER edited here; the SPL autoloader
 * resolves this class on-demand when the Pro controller references it (MEMORY: pro services load via the
 * pro controller, NOT the rest/class-*-controller glob), so the routes register LIVE.
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
 * Dynamic-tags service: bind + list + per-tag schema. The {@see Pro_Controller} owns route registration;
 * this class holds ALL dynamic-tags business logic and exposes its routes via {@see routes()}.
 */
final class Dynamic_Tags_Service {

	/** The dynamic-binding storage key (core `Manager::DYNAMIC_SETTING_KEY`, manager.php:22). */
	const DYNAMIC_SETTING_KEY = '__dynamic__';

	/** The REST wire-code for a dynamic-incompatible bind (10-rest-api.md §8.7; surfaced via VALIDATION_FAILED). */
	const REST_CODE_INCOMPATIBLE = 'E_DYNAMIC_INCOMPATIBLE';

	/** The ACF dynamic-tags group name (license-gated; SUPPLEMENT §A.6 / pro dynamic-tags/module.php). */
	const ACF_GROUP = 'acf';

	/** The Pro license feature slug ACF dynamic tags require (pro dynamic-tags/module.php:34). */
	const ACF_LICENSE_FEATURE = 'dynamic-tags-acf';

	/** Op-log route label for `POST /pro/dynamic/bind`. */
	const OP_ROUTE_BIND = 'pro/dynamic/bind';

	/**
	 * The three route descriptors (10-rest-api.md §8.7) in the FROZEN sibling-service shape the
	 * {@see Pro_Controller} merges (ticket Interface; WP-R01 Detailed-Req #1):
	 *   `[ 'methods'=>WP_REST_Server::*, 'route'=>'/pro/...', 'callback'=>callable,
	 *      'permission_callback'=>callable, 'args'=>array ]`.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	public function routes(): array {
		return array(
			// POST /pro/dynamic/bind — CAP_EDIT_POST (no id => falls back to edit_posts; element write).
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'route'               => '/pro/dynamic/bind',
				'callback'            => array( $this, 'bind' ),
				'permission_callback' => Permissions::can_edit_post(),
				'args'                => array(
					'post_id'        => array(
						'type'              => 'integer',
						'required'          => false,
						'minimum'           => 1,
						'sanitize_callback' => 'absint',
						'description'       => 'Target document. Omit (with element_id) for encode-only mode (no persist).',
					),
					'element_id'     => array(
						'type'        => 'string',
						'required'    => false,
						'description' => 'Target element id within the document. Omit for encode-only mode.',
					),
					'control'        => array(
						'type'        => 'string',
						'required'    => true,
						'description' => 'The control name to bind (must be dynamic.active=true).',
					),
					'tag'            => array(
						'type'        => 'string',
						'required'    => true,
						'description' => 'The dynamic tag name (e.g. post-title, acf-text).',
					),
					'tag_settings'   => array(
						'type'        => 'object',
						'required'    => false,
						'description' => 'The tag settings object; empty -> settings="%7B%7D".',
					),
					'fallback_value' => array(
						'required'    => false,
						'description' => 'Optional static fallback written to settings[control].',
					),
					'id'             => array(
						'type'        => 'string',
						'required'    => false,
						'description' => 'Optional fixed 7-char tag id (for stable/idempotent encodings).',
					),
					'base_hash'      => array(
						'type'     => 'string',
						'required' => false,
					),
					'op_id'          => array(
						'type'     => 'string',
						'required' => false,
					),
					'prime_css'      => array(
						'type'     => 'boolean',
						'required' => false,
						'default'  => false,
					),
				),
			),
			// GET /pro/dynamic/tags — CAP_READ — paginated tag list.
			array(
				'methods'             => WP_REST_Server::READABLE,
				'route'               => '/pro/dynamic/tags',
				'callback'            => array( $this, 'list_tags' ),
				'permission_callback' => Permissions::can_read(),
				'args'                => array(
					'page'     => array(
						'type'              => 'integer',
						'required'          => false,
						'default'           => 1,
						'minimum'           => 1,
						'sanitize_callback' => 'absint',
					),
					'per_page' => array(
						'type'              => 'integer',
						'required'          => false,
						'default'           => 100,
						'minimum'           => 1,
						'maximum'           => 100,
						'sanitize_callback' => 'absint',
					),
				),
			),
			// GET /pro/dynamic/tags/{name} — CAP_READ — per-tag controls/args.
			array(
				'methods'             => WP_REST_Server::READABLE,
				'route'               => '/pro/dynamic/tags/(?P<name>[A-Za-z0-9_-]+)',
				'callback'            => array( $this, 'get_tag' ),
				'permission_callback' => Permissions::can_read(),
				'args'                => array(
					'name' => array(
						'type'              => 'string',
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					),
				),
			),
		);
	}

	// --- POST /pro/dynamic/bind. ---

	/**
	 * `POST /pro/dynamic/bind` (10-rest-api.md §8.7; SUPPLEMENT §A.6). Encodes the tag (byte-identical to
	 * `Manager::tag_to_text`), validates dynamic-compatibility, then — when `post_id`+`element_id` are
	 * present — writes `settings.__dynamic__[control]` (+ optional `settings[control]` fallback) and
	 * persists via the WP-P04 writer. Encode-only mode (no post_id/element_id) returns the string with
	 * `applied:false` and persists nothing (the TS caller writes it).
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function bind( $request ) {
		$op_id = self::read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$control = (string) $request->get_param( 'control' );
		$tag     = (string) $request->get_param( 'tag' );
		if ( '' === $control || '' === $tag ) {
			return Response::error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'Both "control" and "tag" are required.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => '' === $control ? 'control' : 'tag' ),
				array(),
				$op_id
			);
		}

		$tag_settings = $request->get_param( 'tag_settings' );
		$tag_settings = is_array( $tag_settings ) ? $tag_settings : array();
		$fixed_id     = $request->get_param( 'id' );
		$fixed_id     = is_string( $fixed_id ) && '' !== $fixed_id ? $fixed_id : null;

		// (1) Tag-family gate: CORE tags work without Pro; Pro/ACF tag families are Pro-gated (§A.6 / #8).
		$family_gate = self::gate_tag_family( $tag, $op_id );
		if ( $family_gate instanceof WP_Error ) {
			return $family_gate;
		}

		// (2) Assert the tag is registered (manager.php:258-266).
		$tag_instance = self::tag_instance( $tag );
		if ( null === $tag_instance ) {
			return self::incompatible(
				sprintf(
					/* translators: %s: tag name. */
					__( 'The dynamic tag "%s" is not registered on this site.', 'elementor-ultra-mcp' ),
					$tag
				),
				array(
					'control'            => $control,
					'tag'                => $tag,
					'reason'             => 'tag_not_registered',
					'control_categories' => array(),
					'tag_categories'     => array(),
				),
				$op_id
			);
		}
		$tag_categories = self::tag_categories( $tag_instance );

		// (3) ENCODE the shortcode FIRST (so encode-only mode + every response carries it).
		$dynamic_string = Dynamic_Encoder::encode( $tag, $tag_settings, $fixed_id );

		$post_id    = (int) $request->get_param( 'post_id' );
		$element_id = $request->get_param( 'element_id' );
		$element_id = is_string( $element_id ) ? $element_id : '';

		// (4) Encode-only mode: no post_id/element_id -> return the string, persist nothing (§8.7).
		if ( $post_id <= 0 || '' === $element_id ) {
			return Response::success(
				self::with_op(
					array(
						'dynamic_string' => $dynamic_string,
						'applied'        => false,
					),
					$op_id
				)
			);
		}

		// (5) Resolve the document + the target element node (404 when absent).
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

		$node = self::find_node( $tree, $element_id );
		if ( null === $node ) {
			return Response::error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %s: element id. */
					__( 'Element "%s" was not found in the document.', 'elementor-ultra-mcp' ),
					$element_id
				),
				404,
				array(
					'post_id'    => $post_id,
					'element_id' => $element_id,
				),
				array(),
				$op_id
			);
		}

		// (6) Read the element's control schema + validate dynamic-compatibility (ticket Detailed-Req #2).
		$widget_type = self::node_type( $node );
		$compat      = self::assert_compatible( $widget_type, $control, $tag, $tag_categories, $op_id );
		if ( $compat instanceof WP_Error ) {
			return $compat;
		}
		$warnings = isset( $compat['warnings'] ) && is_array( $compat['warnings'] ) ? $compat['warnings'] : array();

		// (7) Mutate the ONE node: settings.__dynamic__[control] = shortcode (+ optional static fallback).
		$fallback_value = $request->has_param( 'fallback_value' ) ? $request->get_param( 'fallback_value' ) : null;
		$mutated_tree   = self::bind_into_tree( $tree, $element_id, $control, $dynamic_string, $request->has_param( 'fallback_value' ), $fallback_value );

		// (8) AUTHORITATIVE validate of the resulting tree BEFORE persist (universal WRITE rule, 10 §0.9).
		// This is a WHOLE-TREE REPLACE (the mutated tree IS the document), so validate STANDALONE via
		// validate_only() — exactly what Document_Writer::replace_tree does internally. dry_run($post_id)
		// would (wrongly) treat the tree as an INSERT and flag every existing id as a self-collision.
		$verdict = Validator::validate_only( $mutated_tree, array() );
		if ( empty( $verdict['valid'] ) ) {
			$errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
			return Response::error(
				Error_Codes::ATOMIC_SETTINGS_INVALID,
				sprintf(
					/* translators: %d: error count. */
					_n( 'The dynamic binding produced an invalid element tree (%d error); nothing was written.', 'The dynamic binding produced an invalid element tree (%d errors); nothing was written.', count( $errors ), 'elementor-ultra-mcp' ),
					count( $errors )
				),
				422,
				array(
					'control' => $control,
					'tag'     => $tag,
				),
				$errors,
				$op_id
			);
		}

		// (9) Persist the WHOLE (one-node-mutated) tree via the transactional writer (backup/base_hash/
		// lock/autosave/dry_run/single-save/new-hash). replace_tree requires elements + base_hash.
		$base_hash = $request->get_param( 'base_hash' );
		$base_hash = is_string( $base_hash ) && '' !== $base_hash ? $base_hash : self::current_base_hash( $post_id );

		$result = Document_Writer::replace_tree(
			$post_id,
			array(
				'elements'  => $mutated_tree,
				'base_hash' => $base_hash,
				'op_id'     => $op_id,
				'prime_css' => (bool) $request->get_param( 'prime_css' ),
				'backup'    => true,
			)
		);
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		self::op_log( $post_id, $op_id );

		$data = array(
			'dynamic_string' => $dynamic_string,
			'applied'        => true,
			'base_hash'      => isset( $result['base_hash'] ) ? (string) $result['base_hash'] : self::current_base_hash( $post_id ),
		);
		if ( isset( $result['prime_required'] ) ) {
			$data['prime_required'] = (bool) $result['prime_required'];
		}
		if ( isset( $result['css_primed'] ) ) {
			$data['css_primed'] = (bool) $result['css_primed'];
		}
		if ( array() !== $warnings ) {
			$data['warnings'] = $warnings;
		}

		return Response::success( self::with_op( $data, $op_id ) );
	}

	// --- GET /pro/dynamic/tags  +  GET /pro/dynamic/tags/{name}. ---

	/**
	 * `GET /pro/dynamic/tags` (10-rest-api.md §8.7). Paginated `{items:[{name,title,group,categories[],
	 * settings_controls[],available}],page,per_page,total,total_pages}` from the live tags manager
	 * (manager.php:272-309). `available` reflects license-gating: ACF-group tags are `available:false`
	 * when the `dynamic-tags-acf` license feature is absent (SUPPLEMENT §A.6). Free + Pro tags both listed.
	 * Read-only; NOT Pro-gated (core tags exist without Pro).
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function list_tags( $request ) {
		$manager = self::dynamic_tags_manager();
		if ( null === $manager ) {
			return Response::error( Error_Codes::UPSTREAM_ERROR, __( 'The Elementor dynamic-tags manager is unavailable.', 'elementor-ultra-mcp' ), 502 );
		}

		$tags  = self::all_tags( $manager );
		$items = array();
		foreach ( $tags as $name => $tag_info ) {
			$instance = self::tag_info_instance( $tag_info );
			if ( null === $instance ) {
				continue;
			}
			$group   = self::tag_group( $instance );
			$items[] = array(
				'name'              => (string) $name,
				'title'             => self::tag_title( $instance ),
				'group'             => $group,
				'categories'        => self::tag_categories( $instance ),
				'settings_controls' => self::tag_control_names( $instance ),
				'available'         => self::tag_available( $group ),
			);
		}

		// Stable order by name so pagination is deterministic.
		usort(
			$items,
			static function ( $a, $b ) {
				return strcmp( (string) $a['name'], (string) $b['name'] );
			}
		);

		return Response::success( self::paginate( $items, $request ) );
	}

	/**
	 * `GET /pro/dynamic/tags/{name}` (10-rest-api.md §8.7). Returns `{name,title,group,categories,
	 * controls}` for the registered tag, or 404 `NOT_FOUND` when unregistered. Read-only; NOT Pro-gated.
	 *
	 * @param \WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function get_tag( $request ) {
		$name     = (string) $request->get_param( 'name' );
		$instance = self::tag_instance( $name );
		if ( null === $instance ) {
			return Response::error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %s: tag name. */
					__( 'The dynamic tag "%s" is not registered on this site.', 'elementor-ultra-mcp' ),
					$name
				),
				404,
				array( 'name' => $name )
			);
		}

		$group = self::tag_group( $instance );

		return Response::success(
			array(
				'name'       => $name,
				'title'      => self::tag_title( $instance ),
				'group'      => $group,
				'categories' => self::tag_categories( $instance ),
				'controls'   => self::tag_controls( $instance ),
				'available'  => self::tag_available( $group ),
			)
		);
	}

	// --- Dynamic-compatibility validation (ticket Detailed-Req #2/#4). ---

	/**
	 * Validate a bind is dynamic-compatible (ticket Detailed-Req #2; SUPPLEMENT §A.6): (a) the control is
	 * `dynamic.active=true`; (b) the tag's categories intersect the control's `dynamic.categories`. Reads
	 * the live control schema off the resolved element (V3 `get_controls()`, V4 `get_props_schema()` —
	 * mirroring {@see \Elementor\Ultra\Rest\Schema_Controller}; never re-deriving control introspection).
	 * Returns `{warnings?:string[]}` on success or a 422 `E_DYNAMIC_INCOMPATIBLE` WP_Error.
	 *
	 * @param string      $widget_type    The element's widgetType/elType.
	 * @param string      $control        The control name to bind.
	 * @param string      $tag            The tag name (for meta).
	 * @param string[]    $tag_categories The tag's categories.
	 * @param string|null $op_id          Echoed op id.
	 * @return array{warnings?:string[]}|WP_Error
	 */
	private static function assert_compatible( string $widget_type, string $control, string $tag, array $tag_categories, ?string $op_id ) {
		$element = self::resolve_element( $widget_type );
		if ( null === $element ) {
			// Cannot introspect the type — surface as incompatible with an explicit reason (#2).
			return self::incompatible(
				sprintf(
					/* translators: %s: widget type. */
					__( 'The element type "%s" could not be resolved to validate dynamic compatibility.', 'elementor-ultra-mcp' ),
					$widget_type
				),
				array(
					'control'            => $control,
					'tag'                => $tag,
					'widget_type'        => $widget_type,
					'reason'             => 'type_not_resolved',
					'control_categories' => array(),
					'tag_categories'     => $tag_categories,
				),
				$op_id
			);
		}

		$is_atomic = method_exists( $element, 'get_props_schema' );
		$dynamic   = $is_atomic
			? self::atomic_control_dynamic( $element, $control )
			: self::classic_control_dynamic( $element, $control );

		$warnings = array();

		if ( $is_atomic && null === $dynamic ) {
			// V4 atomic dynamic prop shape is SPIKE-discovered (RESEARCH §4.3 OQ#7; ticket Detailed-Req #4).
			// We still produce the V3-style __dynamic__ binding (Elementor's atomic settings accept the
			// __dynamic__ key for dynamic-capable props), but warn the shape is unverified.
			$warnings[] = 'atomic dynamic prop shape unverified — verify via schema.widget';
			return array( 'warnings' => $warnings );
		}

		// (a) control.dynamic.active === true.
		if ( null === $dynamic || empty( $dynamic['active'] ) ) {
			return self::incompatible(
				sprintf(
					/* translators: 1: control, 2: widget type. */
					__( 'Control "%1$s" on "%2$s" is not dynamic-capable (dynamic.active is not true).', 'elementor-ultra-mcp' ),
					$control,
					$widget_type
				),
				array(
					'control'            => $control,
					'tag'                => $tag,
					'widget_type'        => $widget_type,
					'reason'             => 'control_not_dynamic',
					'control_categories' => array(),
					'tag_categories'     => $tag_categories,
				),
				$op_id
			);
		}

		// (b) tag categories ∩ control dynamic categories must be non-empty — UNLESS the control declares
		// NO categories. An empty `dynamic.categories` is Elementor's "unrestricted" default (e.g. the
		// classic heading `title` control declares `dynamic => ['active'=>true]` with no `categories` key,
		// verified live): the editor accepts ANY tag there, so the intersection check is skipped and any
		// registered tag binds. The intersection is enforced ONLY when the control explicitly restricts
		// categories (SUPPLEMENT §A.6 — "the tag's category must intersect the control's dynamic.categories").
		$control_categories = isset( $dynamic['categories'] ) && is_array( $dynamic['categories'] )
			? array_values( array_map( 'strval', $dynamic['categories'] ) )
			: array();
		$intersection       = array_values( array_intersect( $tag_categories, $control_categories ) );
		if ( array() !== $control_categories && array() === $intersection ) {
			return self::incompatible(
				sprintf(
					/* translators: 1: tag, 2: control. */
					__( 'The tag "%1$s" categories do not intersect control "%2$s" dynamic categories.', 'elementor-ultra-mcp' ),
					$tag,
					$control
				),
				array(
					'control'            => $control,
					'tag'                => $tag,
					'widget_type'        => $widget_type,
					'reason'             => 'category_mismatch',
					'control_categories' => $control_categories,
					'tag_categories'     => $tag_categories,
				),
				$op_id
			);
		}

		return array();
	}

	/**
	 * Read a CLASSIC (V3) control's `dynamic` config (`['active'=>bool,'categories'=>[]]`) from the live
	 * `get_controls()` (mirrors {@see \Elementor\Ultra\Rest\Schema_Controller::classic_widget_payload}).
	 * Null when the control is absent or carries no `dynamic` block.
	 *
	 * @param object $element The resolved widget instance.
	 * @param string $control The control name.
	 * @return array{active:bool,categories:string[]}|null
	 */
	private static function classic_control_dynamic( $element, string $control ) {
		if ( ! method_exists( $element, 'get_controls' ) ) {
			return null;
		}
		$controls = (array) $element->get_controls();
		if ( ! isset( $controls[ $control ] ) || ! is_array( $controls[ $control ] ) ) {
			return null;
		}
		$cfg = $controls[ $control ];
		if ( ! isset( $cfg['dynamic'] ) || ! is_array( $cfg['dynamic'] ) ) {
			return null;
		}
		$dynamic = $cfg['dynamic'];
		return array(
			'active'     => ! empty( $dynamic['active'] ),
			'categories' => isset( $dynamic['categories'] ) && is_array( $dynamic['categories'] )
				? array_values( array_map( 'strval', $dynamic['categories'] ) )
				: array(),
		);
	}

	/**
	 * Read a V4 ATOMIC prop's dynamic descriptor from the live (post-filter) `get_props_schema()`,
	 * reusing the SAME `dynamic` union-member detection as {@see \Elementor\Ultra\Rest\Schema_Controller}
	 * (a prop is dynamic-capable iff it carries a `dynamic` union member exposing `settings.categories`,
	 * 11 §6 / §3.1). Returns `['active'=>true,'categories'=>[...]]`, or null when the prop is absent or
	 * NOT dynamic-capable (the SPIKE-unverified branch is handled by {@see assert_compatible}).
	 *
	 * @param object $element The resolved atomic element instance.
	 * @param string $control The prop name.
	 * @return array{active:bool,categories:string[]}|null
	 */
	private static function atomic_control_dynamic( $element, string $control ) {
		$schema = (array) call_user_func( array( $element, 'get_props_schema' ) );
		if ( ! isset( $schema[ $control ] ) ) {
			return null;
		}
		$raw        = self::prop_to_array( $schema[ $control ] );
		$categories = self::find_dynamic_categories( $raw, 0 );
		if ( null === $categories ) {
			return null;
		}
		return array(
			'active'     => true,
			'categories' => $categories,
		);
	}

	/**
	 * Recursively search a serialized prop (union members + object shape, bounded depth 4) for a
	 * `dynamic` member and return its `settings.categories` (mirrors
	 * {@see \Elementor\Ultra\Rest\Schema_Controller::find_dynamic_categories}). Null when none.
	 *
	 * @param array<string,mixed> $raw   The serialized prop (or sub-prop).
	 * @param int                 $depth Recursion depth.
	 * @return string[]|null
	 */
	private static function find_dynamic_categories( array $raw, int $depth ) {
		if ( $depth > 4 ) {
			return null;
		}
		if ( isset( $raw['prop_types'] ) && is_array( $raw['prop_types'] ) ) {
			foreach ( $raw['prop_types'] as $key => $member ) {
				if ( ! is_array( $member ) ) {
					continue;
				}
				if ( 'dynamic' === $key || ( isset( $member['key'] ) && 'dynamic' === $member['key'] ) ) {
					return isset( $member['settings']['categories'] ) && is_array( $member['settings']['categories'] )
						? array_values( array_map( 'strval', $member['settings']['categories'] ) )
						: array();
				}
				$nested = self::find_dynamic_categories( $member, $depth + 1 );
				if ( null !== $nested ) {
					return $nested;
				}
			}
		}
		if ( isset( $raw['shape'] ) && is_array( $raw['shape'] ) ) {
			foreach ( $raw['shape'] as $field ) {
				if ( is_array( $field ) ) {
					$nested = self::find_dynamic_categories( $field, $depth + 1 );
					if ( null !== $nested ) {
						return $nested;
					}
				}
			}
		}
		return null;
	}

	// --- Tree mutation (one-node, pure). ---

	/**
	 * Return a NEW tree with the node `$element_id`'s `settings.__dynamic__[control]` set to the
	 * shortcode (+ optional static `settings[control]` fallback). The original tree is not mutated.
	 *
	 * @param array<int,array<string,mixed>> $tree           The element tree.
	 * @param string                         $element_id     The target element id.
	 * @param string                         $control        The control name.
	 * @param string                         $dynamic_string The shortcode.
	 * @param bool                           $has_fallback   Whether a static fallback was supplied.
	 * @param mixed                          $fallback_value The static fallback value.
	 * @return array<int,array<string,mixed>>
	 */
	private static function bind_into_tree( array $tree, string $element_id, string $control, string $dynamic_string, bool $has_fallback, $fallback_value ): array {
		return self::map_node(
			$tree,
			$element_id,
			static function ( array $node ) use ( $control, $dynamic_string, $has_fallback, $fallback_value ): array {
				$settings = isset( $node['settings'] ) && is_array( $node['settings'] ) ? $node['settings'] : array();

				$dynamic                               = isset( $settings[ self::DYNAMIC_SETTING_KEY ] ) && is_array( $settings[ self::DYNAMIC_SETTING_KEY ] )
					? $settings[ self::DYNAMIC_SETTING_KEY ]
					: array();
				$dynamic[ $control ]                   = $dynamic_string;
				$settings[ self::DYNAMIC_SETTING_KEY ] = $dynamic;

				if ( $has_fallback ) {
					$settings[ $control ] = $fallback_value; // Static fallback shown when the tag resolves empty.
				}

				$node['settings'] = $settings;
				return $node;
			}
		);
	}

	/**
	 * Apply `$mutator` to the first node whose id === `$target_id` (depth-first); returns the new tree.
	 * Mirrors {@see \Elementor\Ultra\Rest\Documents_Controller::map_node} (the granular element-op walker).
	 *
	 * @param array<int,array<string,mixed>> $elements  The (sub)tree.
	 * @param string                         $target_id The element id.
	 * @param callable                       $mutator   `fn(array $node): array`.
	 * @return array<int,array<string,mixed>>
	 */
	private static function map_node( array $elements, string $target_id, callable $mutator ): array {
		$out = array();
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				$out[] = $node;
				continue;
			}
			if ( isset( $node['id'] ) && (string) $node['id'] === $target_id ) {
				$out[] = $mutator( $node );
				continue;
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$node['elements'] = self::map_node( $node['elements'], $target_id, $mutator );
			}
			$out[] = $node;
		}
		return $out;
	}

	/**
	 * Depth-first find the node with id === `$target_id` (null when absent).
	 *
	 * @param array<int,array<string,mixed>> $elements  The (sub)tree.
	 * @param string                         $target_id The element id.
	 * @return array<string,mixed>|null
	 */
	private static function find_node( array $elements, string $target_id ) {
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			if ( isset( $node['id'] ) && (string) $node['id'] === $target_id ) {
				return $node;
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$found = self::find_node( $node['elements'], $target_id );
				if ( null !== $found ) {
					return $found;
				}
			}
		}
		return null;
	}

	/**
	 * The node's widgetType (atomic/classic widgets) or elType (containers).
	 *
	 * @param array<string,mixed> $node The element node.
	 */
	private static function node_type( array $node ): string {
		if ( isset( $node['widgetType'] ) && is_string( $node['widgetType'] ) && '' !== $node['widgetType'] ) {
			return $node['widgetType'];
		}
		return isset( $node['elType'] ) && is_string( $node['elType'] ) ? $node['elType'] : '';
	}

	// --- Live Elementor dynamic-tags introspection. ---

	/**
	 * The core dynamic-tags Manager (`\Elementor\Plugin::$instance->dynamic_tags`, plugin.php:711) — ALWAYS
	 * present when Elementor is active (core feature). Null when Elementor is unavailable.
	 *
	 * @return object|null
	 */
	private static function dynamic_tags_manager() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->dynamic_tags ) || ! is_object( $plugin->dynamic_tags ) ) {
			return null;
		}
		return $plugin->dynamic_tags;
	}

	/**
	 * The full registered-tags map (`Manager::get_tags()`, manager.php:272-309) =
	 * `[tag_name => ['class'=>..., 'instance'=>Base_Tag]]`. Empty when the manager is unavailable.
	 *
	 * @param object $manager The dynamic-tags manager.
	 * @return array<string,mixed>
	 */
	private static function all_tags( $manager ): array {
		if ( ! method_exists( $manager, 'get_tags' ) ) {
			return array();
		}
		$tags = $manager->get_tags();
		return is_array( $tags ) ? $tags : array();
	}

	/**
	 * The Base_Tag instance for a tag name (via `Manager::get_tag_info()`, manager.php:258-266). Null when
	 * unregistered or the manager is unavailable.
	 *
	 * @param string $name The tag name.
	 * @return object|null
	 */
	private static function tag_instance( string $name ) {
		$manager = self::dynamic_tags_manager();
		if ( null === $manager || ! method_exists( $manager, 'get_tag_info' ) ) {
			return null;
		}
		$info = $manager->get_tag_info( $name );
		return self::tag_info_instance( is_array( $info ) ? $info : array() );
	}

	/**
	 * Extract the Base_Tag `instance` from a `get_tags()`/`get_tag_info()` entry (manager.php:417).
	 *
	 * @param array<string,mixed> $tag_info The `['class','instance']` entry.
	 * @return object|null
	 */
	private static function tag_info_instance( array $tag_info ) {
		if ( isset( $tag_info['instance'] ) && is_object( $tag_info['instance'] ) ) {
			return $tag_info['instance'];
		}
		return null;
	}

	/**
	 * The tag's categories (`Base_Tag::get_categories()`, base-tag.php:35). Always an array of strings.
	 *
	 * @param object $instance The Base_Tag instance.
	 * @return string[]
	 */
	private static function tag_categories( $instance ): array {
		if ( ! method_exists( $instance, 'get_categories' ) ) {
			return array();
		}
		$cats = $instance->get_categories();
		return is_array( $cats ) ? array_values( array_map( 'strval', $cats ) ) : array();
	}

	/**
	 * The tag's title (`Base_Tag::get_title()`, base-tag.php:53).
	 *
	 * @param object $instance The Base_Tag instance.
	 */
	private static function tag_title( $instance ): string {
		return method_exists( $instance, 'get_title' ) ? (string) $instance->get_title() : '';
	}

	/**
	 * The tag's group (`Base_Tag::get_group()`, base-tag.php:42). May be a string or an array (some tags
	 * declare multiple groups) — normalized to a single string (first group) for the §8.7 list shape.
	 *
	 * @param object $instance The Base_Tag instance.
	 */
	private static function tag_group( $instance ): string {
		if ( ! method_exists( $instance, 'get_group' ) ) {
			return '';
		}
		$group = $instance->get_group();
		if ( is_array( $group ) ) {
			return isset( $group[0] ) ? (string) $group[0] : '';
		}
		return (string) $group;
	}

	/**
	 * The tag's settings controls (inherited `Controls_Stack::get_controls()`). Full control configs keyed
	 * by control name (for `GET /pro/dynamic/tags/{name}`).
	 *
	 * @param object $instance The Base_Tag instance.
	 * @return array<string,mixed>
	 */
	private static function tag_controls( $instance ): array {
		if ( ! method_exists( $instance, 'get_controls' ) ) {
			return array();
		}
		$controls = $instance->get_controls();
		return is_array( $controls ) ? $controls : array();
	}

	/**
	 * Just the tag's control NAMES (for the list `settings_controls[]` — lighter than full configs).
	 *
	 * @param object $instance The Base_Tag instance.
	 * @return string[]
	 */
	private static function tag_control_names( $instance ): array {
		return array_values( array_map( 'strval', array_keys( self::tag_controls( $instance ) ) ) );
	}

	/**
	 * Whether a tag is `available` given license-gating (SUPPLEMENT §A.6). ACF-group tags require the
	 * `dynamic-tags-acf` license feature; all other registered tags are available. A registered tag is
	 * always available unless its group is license-gated AND the feature is absent (defensive — license-
	 * gated tags are usually not registered at all, so this only marks placeholders).
	 *
	 * @param string $group The tag's group.
	 */
	private static function tag_available( string $group ): bool {
		if ( self::ACF_GROUP !== $group ) {
			return true;
		}
		return self::has_license_feature( self::ACF_LICENSE_FEATURE );
	}

	/**
	 * Whether the Pro license has a named feature, via `\ElementorPro\License\API::is_licence_has_feature()`
	 * (elementor-pro/modules/dynamic-tags/module.php:34/44). Returns true when the API is unavailable so a
	 * registered tag is not falsely marked unavailable (it would not be registered without the feature).
	 *
	 * @param string $feature The license feature slug.
	 */
	private static function has_license_feature( string $feature ): bool {
		if ( class_exists( '\ElementorPro\License\API' ) && method_exists( '\ElementorPro\License\API', 'is_licence_has_feature' ) ) {
			return (bool) \ElementorPro\License\API::is_licence_has_feature( $feature );
		}
		return true; // No license API to consult -> assume available (a registered tag implies the feature).
	}

	// --- Tag-family gating (core tags work without Pro; Pro/ACF families are Pro-gated — #8). ---

	/**
	 * Gate a tag by FAMILY (ticket Detailed-Req #8; SUPPLEMENT §A.6): CORE dynamic tags work WITHOUT Pro,
	 * so a core tag bind is NOT gated. A tag whose name resolves to a Pro/ACF family is gated behind the
	 * shared {@see Pro_Gate} (501 PRO_REQUIRED when Pro is inactive). On the live dev site Pro is active so
	 * this passes; off Pro, core tags still bind while Pro/ACF tags 501. We treat a tag as "Pro" when it is
	 * NOT registered by core (i.e. only registered when Pro is active) — detected by Pro presence + tag
	 * family. Since core registers a fixed set and ACF/Pro add the rest, we gate when the tag is registered
	 * ONLY under Pro: if Pro is inactive and the tag is unregistered we already 422 (#2); if Pro is active
	 * everything passes. The explicit gate is for the ACF family (license-gated even under Pro).
	 *
	 * @param string      $tag   The tag name.
	 * @param string|null $op_id Echoed op id.
	 * @return true|WP_Error
	 */
	private static function gate_tag_family( string $tag, ?string $op_id ) {
		$instance = self::tag_instance( $tag );
		// Unknown tag here -> let the caller's #2 "tag not registered" check produce the precise 422.
		if ( null === $instance ) {
			return true;
		}
		$group = self::tag_group( $instance );

		// ACF tags additionally require Pro + the ACF license feature (SUPPLEMENT §A.6).
		if ( self::ACF_GROUP === $group ) {
			$gate = Pro_Gate::require_pro( $op_id );
			if ( $gate instanceof WP_Error ) {
				return $gate;
			}
			if ( ! self::has_license_feature( self::ACF_LICENSE_FEATURE ) ) {
				return Response::error(
					Error_Codes::PRO_REQUIRED,
					__( 'ACF dynamic tags require the Elementor Pro "dynamic-tags-acf" license feature.', 'elementor-ultra-mcp' ),
					Pro_Gate::FEATURE_UNAVAILABLE_STATUS,
					array(
						'feature'    => self::ACF_LICENSE_FEATURE,
						'pro_active' => Pro_Gate::is_pro_active(),
					),
					array(),
					$op_id
				);
			}
		}

		return true;
	}

	// --- Element-schema resolution (mirrors Schema_Controller; never re-derives control introspection). ---

	/**
	 * Resolve a type id to its Elementor element/widget instance (widgets first, then containers) — the
	 * SAME resolution {@see \Elementor\Ultra\Rest\Schema_Controller::resolve_element} performs (the
	 * authoritative control-schema source per ticket Detailed-Req #2). Null when unregistered.
	 *
	 * @param string $type The widget/element type id.
	 * @return object|null
	 */
	private static function resolve_element( string $type ) {
		if ( '' === $type || ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin ) {
			return null;
		}
		if ( isset( $plugin->widgets_manager ) && method_exists( $plugin->widgets_manager, 'get_widget_types' ) ) {
			$widget = $plugin->widgets_manager->get_widget_types( $type );
			if ( is_object( $widget ) ) {
				return $widget;
			}
		}
		if ( isset( $plugin->elements_manager ) && method_exists( $plugin->elements_manager, 'get_element_types' ) ) {
			$element = $plugin->elements_manager->get_element_types( $type );
			if ( is_object( $element ) ) {
				return $element;
			}
		}
		return null;
	}

	/**
	 * Serialize a `Prop_Type` to a PURE nested array via a JSON round-trip (mirrors
	 * {@see \Elementor\Ultra\Rest\Schema_Controller::prop_type_to_array}).
	 *
	 * @param mixed $prop_type A `Prop_Type` (or already-array).
	 * @return array<string,mixed>
	 */
	private static function prop_to_array( $prop_type ): array {
		if ( is_array( $prop_type ) ) {
			$decoded = json_decode( (string) wp_json_encode( $prop_type ), true );
			return is_array( $decoded ) ? $decoded : array();
		}
		if ( is_object( $prop_type ) ) {
			$decoded = json_decode( (string) wp_json_encode( $prop_type ), true );
			if ( is_array( $decoded ) ) {
				return $decoded;
			}
		}
		return array();
	}

	// --- Pagination + document/base_hash + envelope helpers. ---

	/**
	 * Paginate a list to the §0.11 list shape `{items,page,per_page,total,total_pages}` (per_page caps at
	 * 100 per the list-route cap rule).
	 *
	 * @param array<int,array<string,mixed>> $items   The full list (pre-paginated).
	 * @param \WP_REST_Request               $request The request (page/per_page).
	 * @return array<string,mixed>
	 */
	private static function paginate( array $items, $request ): array {
		$page     = (int) $request->get_param( 'page' );
		$per_page = (int) $request->get_param( 'per_page' );
		$page     = $page > 0 ? $page : 1;
		$per_page = $per_page > 0 ? min( $per_page, 100 ) : 100;

		$total       = count( $items );
		$total_pages = (int) ceil( $total / $per_page );
		$offset      = ( $page - 1 ) * $per_page;
		$slice       = array_slice( $items, $offset, $per_page );

		return array(
			'items'       => array_values( $slice ),
			'page'        => $page,
			'per_page'    => $per_page,
			'total'       => $total,
			'total_pages' => $total_pages,
		);
	}

	/**
	 * The post's `_elementor_data` tree as a decoded array, or null when absent/not Elementor-built
	 * (mirrors {@see \Elementor\Ultra\Core\Document_Writer::read_tree}).
	 *
	 * @param int $post_id The document id.
	 * @return array<int,array<string,mixed>>|null
	 */
	private static function read_tree( int $post_id ): ?array {
		if ( $post_id <= 0 ) {
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
	 * The current optimistic-concurrency token `md5(_elementor_data)` (10 §0.8) — used when the caller
	 * omits base_hash (the binding is a surgical one-node mutation; we read-then-write atomically).
	 *
	 * @param int $post_id The document id.
	 */
	private static function current_base_hash( int $post_id ): string {
		return md5( (string) get_post_meta( $post_id, '_elementor_data', true ) );
	}

	/**
	 * Build a 422 `E_DYNAMIC_INCOMPATIBLE` error surfaced as the taxonomy `VALIDATION_FAILED` (12 §3.1;
	 * ticket Error-mapping #8) with `data.meta.rest_code='E_DYNAMIC_INCOMPATIBLE'` + the compatibility
	 * meta (`control,tag,control_categories,tag_categories`).
	 *
	 * @param string              $message Human message.
	 * @param array<string,mixed> $meta    Compatibility meta.
	 * @param string|null         $op_id   Echoed op id.
	 * @return WP_Error
	 */
	private static function incompatible( string $message, array $meta, ?string $op_id ): WP_Error {
		return Response::error(
			Error_Codes::VALIDATION_FAILED,
			$message,
			422,
			array_merge( array( 'rest_code' => self::REST_CODE_INCOMPATIBLE ), $meta ),
			array(),
			$op_id
		);
	}

	/**
	 * Merge a non-null op_id into a success `data` payload (echoed per §0.8).
	 *
	 * @param array<string,mixed> $data  The data payload.
	 * @param string|null         $op_id The op id.
	 * @return array<string,mixed>
	 */
	private static function with_op( array $data, ?string $op_id ): array {
		if ( null !== $op_id ) {
			$data['op_id'] = $op_id;
		}
		return $data;
	}

	/**
	 * Validate the optional `op_id` (10 §0.8) — mirrors {@see Theme_Builder_Service::read_op_id}.
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
	 * Append one op-log row behind a class_exists guard (WP-P14 soft dep — never fails the route). Mirrors
	 * {@see Theme_Builder_Service::op_log}.
	 *
	 * @param int         $post_id The document id.
	 * @param string|null $op_id   The op id.
	 */
	private static function op_log( int $post_id, ?string $op_id ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		\Elementor\Ultra\Core\Op_Log::record(
			array(
				'op_id'      => $op_id,
				'post_id'    => $post_id,
				'route'      => self::OP_ROUTE_BIND,
				'after_hash' => self::current_base_hash( $post_id ),
				'result'     => 'ok',
			)
		);
	}
}
