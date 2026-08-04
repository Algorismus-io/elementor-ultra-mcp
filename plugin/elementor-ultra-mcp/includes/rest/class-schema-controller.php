<?php
/**
 * WP-P07 — Schema + Site controller: the read-only schema + capability surface.
 *
 * Contract authority: 10-rest-api.md §3 (SCHEMA routes: `GET /schema/widget/{type}`,
 * `/schema/styles`, `/schema/registered-types`, `/schema/breakpoints`), §12 (`GET /site/capabilities`
 * — the single most-called probe, frozen field set), §1 (frozen route index), §0.3 (all CAP_READ);
 * 11-authoring-contract.md §2.2 note (`_cssid` tolerated, NEVER stripped), §4 (atomic element types),
 * §5.2 (Style-Schema native props + valid states); 15-engineering-standards.md §7 (version guards
 * report via `site/capabilities`, NEVER fatal — it is the diagnostic of last resort).
 *
 * This controller is THIN glue: it instantiates the real (post-filter) Elementor schema and shapes the
 * §3/§12 envelopes via {@see Abstract_Controller::ok()}. It persists nothing; every response is
 * cacheable and CAP_READ. Schema responses (`widget`/`styles`/`registered-types`) are transient-cached
 * keyed by Elementor+Pro version so a version bump or the schema-drift job invalidates them;
 * `site/capabilities` is NOT cached (it reflects per-user caps like `can_update_class`).
 *
 * Grounded in Elementor source (paths relative to `plugins/elementor` / `plugins/elementor-pro`,
 * verified live against Elementor 4.1.1 + Pro 4.1.0):
 *  - `get_props_schema()` (STATIC, post-filter) on an atomic element instance — incl auto-injected
 *    `_cssid` (`elements/base/has-atomic-base.php:310-321`) and Pro `display-conditions` (injected via
 *    the `elementor/atomic-widgets/props-schema` filter). Each prop is a `Prop_Type` whose
 *    `jsonSerialize()` yields the authoritative `{kind,key,default,settings,...}` shape.
 *  - `\Elementor\Modules\AtomicWidgets\Styles\Style_Schema::get_style_schema()` (STATIC, post
 *    `elementor/atomic-widgets/styles/schema` filter, runtime-extended background) — ~71 flat css-prop
 *    → `Prop_Type` entries; `Size_Prop_Type::get_settings()['available_units']` carries the unit set.
 *  - `\Elementor\Modules\AtomicWidgets\Styles\Style_States::get_valid_states()` — the valid variant
 *    states (`styles/style-states.php`): `hover,active,focus,focus-visible,checked,e--selected` (+null).
 *  - `\Elementor\Plugin::$instance->breakpoints->get_active_breakpoints()` — live breakpoints (key,
 *    label, direction min|max, value); NEVER hardcode 767/1024 (`core/breakpoints/manager.php`).
 *  - `widgets_manager->get_widget_types($type)` (widgets) + `elements_manager->get_element_types($type)`
 *    (containers) for resolution + registered types.
 *  - `\Elementor\Ultra\Capabilities::build()` (WP-F05) — the frozen `site/capabilities` payload.
 *
 * Self-registration: this controller adds itself to the WP-P02 {@see Registrar} via the
 * `elementor_ultra/rest/register` action (fired on `rest_api_init`) — it NEVER edits the spine
 * `Registrar`/`Plugin` files (the parallelism principle, 01-architecture.md §4.3). The foundation WP
 * that owns the spine is responsible for INCLUDING the controller files at a wave boundary so this
 * `add_action()` is in place when the registrar fires (mirrors every other Wave-2 vertical controller,
 * e.g. `class-media-controller.php`); this file only declares its routes + self-registration.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Capabilities;
use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Plugin;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The SCHEMA + SITE REST controller (10-rest-api.md §3 + §12). Five read-only routes, all CAP_READ.
 */
final class Schema_Controller extends Abstract_Controller {

	/** Default atomic widget `version` when the live instance does not report one (10 §3.1). */
	const DEFAULT_VERSION = '0.0';

	/** Generation strings (10-rest-api.md §3.1). */
	const GENERATION_V4 = 'v4';
	const GENERATION_V3 = 'v3';

	/** Transient TTL for the cached schema responses (12 hours; version-keyed so a bump invalidates). */
	const CACHE_TTL = 43200;

	/** Transient key PREFIX for the version-keyed schema cache (Detailed Requirements #7). */
	const CACHE_PREFIX = 'emcp_schema_';

	/**
	 * Register the five read routes under `elementor-ultra/v1` (10-rest-api.md §1 SCHEMA + SITE). Every
	 * route is CAP_READ ({@see Permissions::can_read()}) and read-only.
	 *
	 * @return void
	 */
	public function register_routes(): void {
		$read = Permissions::can_read();

		// §3.1 GET /schema/widget/{type} — post-filter get_props_schema() (incl _cssid + Pro props).
		$this->route(
			'/schema/widget/(?P<type>[A-Za-z0-9_-]+)',
			WP_REST_Server::READABLE,
			array( $this, 'get_widget_schema' ),
			$read,
			array(
				'type' => array(
					'type'              => 'string',
					'required'          => true,
					'sanitize_callback' => 'sanitize_text_field',
				),
			)
		);

		// §3.2 GET /schema/styles — flat Style_Schema map + unit presets + states.
		$this->route(
			'/schema/styles',
			WP_REST_Server::READABLE,
			array( $this, 'get_styles_schema' ),
			$read
		);

		// §3.3 GET /schema/registered-types — registered elTypes/widgetTypes on this site.
		$this->route(
			'/schema/registered-types',
			WP_REST_Server::READABLE,
			array( $this, 'get_registered_types' ),
			$read
		);

		// §3.4 GET /schema/breakpoints — live active breakpoints (NEVER hardcode 767/1024).
		$this->route(
			'/schema/breakpoints',
			WP_REST_Server::READABLE,
			array( $this, 'get_breakpoints' ),
			$read
		);

		// §12 GET /site/capabilities — the full probe payload (NOT cached; per-user caps).
		$this->route(
			'/site/capabilities',
			WP_REST_Server::READABLE,
			array( $this, 'get_capabilities' ),
			$read
		);
	}

	// §3.1 — GET /schema/widget/{type}.

	/**
	 * Return the POST-FILTER per-widget prop schema for an atomic type, or `get_controls()` for a
	 * classic type (10-rest-api.md §3.1). Atomic `data`: `{type,generation,is_container,props_schema,
	 * dynamic_props,version}`; classic `data`: `{type,generation:'v3',controls}`. Unregistered type ->
	 * 404 `NOT_FOUND`. Cached per Elementor+Pro version.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|\WP_Error
	 */
	public function get_widget_schema( WP_REST_Request $request ) {
		$type = (string) $request->get_param( 'type' );

		$cached = $this->cache_get( 'widget_' . $type );
		if ( null !== $cached ) {
			return $this->ok( $cached );
		}

		$element = $this->resolve_element( $type );
		if ( null === $element ) {
			return $this->fail(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %s: requested widget/element type. */
					__( 'The type "%s" is not a registered widget or element on this site.', 'elementor-ultra-mcp' ),
					$type
				),
				404,
				array( 'type' => $type )
			);
		}

		if ( $this->is_atomic( $element ) ) {
			$data = $this->atomic_widget_payload( $type, $element );
		} else {
			$data = $this->classic_widget_payload( $type, $element );
		}

		$this->cache_set( 'widget_' . $type, $data );
		return $this->ok( $data );
	}

	/**
	 * Build the atomic `{type,generation,is_container,props_schema,dynamic_props,version}` payload from
	 * the live POST-FILTER `get_props_schema()` (10-rest-api.md §3.1; 11 §4.1 — authoritative). `_cssid`
	 * and any Pro-injected props (e.g. `display-conditions`) are PRESERVED, never stripped (11 §2.2).
	 *
	 * @param string $type    The widget/element type id.
	 * @param object $element The resolved atomic element instance.
	 * @return array<string,mixed>
	 */
	private function atomic_widget_payload( string $type, $element ): array {
		$schema        = (array) call_user_func( array( $element, 'get_props_schema' ) );
		$props_schema  = array();
		$dynamic_props = array();

		// Deterministic key order keeps the schema-drift diff readable (Implementation Notes).
		ksort( $schema );

		foreach ( $schema as $name => $prop_type ) {
			$raw                   = $this->prop_type_to_array( $prop_type );
			$props_schema[ $name ] = $this->normalize_prop( $raw );
			if ( isset( $props_schema[ $name ]['dynamic']['active'] ) && true === $props_schema[ $name ]['dynamic']['active'] ) {
				$dynamic_props[] = (string) $name;
			}
		}

		sort( $dynamic_props );

		return array(
			'type'          => $type,
			'generation'    => self::GENERATION_V4,
			'is_container'  => $this->is_container( $element ),
			'props_schema'  => $props_schema,
			'dynamic_props' => array_values( array_unique( $dynamic_props ) ),
			'version'       => $this->atomic_version( $element ),
		);
	}

	/**
	 * Build the classic `{type,generation:'v3',controls}` payload from `get_controls()` (10 §3.1).
	 *
	 * @param string $type    The widget type id.
	 * @param object $element The resolved classic widget instance.
	 * @return array<string,mixed>
	 */
	private function classic_widget_payload( string $type, $element ): array {
		$controls = array();
		if ( method_exists( $element, 'get_controls' ) ) {
			$controls = (array) $element->get_controls();
		}

		return array(
			'type'       => $type,
			'generation' => self::GENERATION_V3,
			'controls'   => $controls,
		);
	}

	/**
	 * Normalize ONE atomic prop's serialized array into the contract §3.1 shape
	 * `{kind,key,default,settings:{enum?,units?,required?},dynamic?:{active,categories}}`. The full raw
	 * serialization (union members / object shape / array item) is preserved under the original keys so
	 * the schema-drift baseline (Contract 14 §5) and downstream validators retain every detail; the
	 * normalized `settings`/`dynamic` are computed conveniences layered on top.
	 *
	 * @param array<string,mixed> $raw The `Prop_Type::jsonSerialize()` array for one prop.
	 * @return array<string,mixed>
	 */
	private function normalize_prop( array $raw ): array {
		$out = array(
			'kind'    => isset( $raw['kind'] ) ? $raw['kind'] : 'unknown',
			'key'     => isset( $raw['key'] ) ? $raw['key'] : ( isset( $raw['kind'] ) ? $raw['kind'] : 'unknown' ),
			'default' => isset( $raw['default'] ) ? $raw['default'] : null,
		);

		// Normalized settings block: enum / units / required, harvested from this prop or its members.
		$settings = array();

		$enum = $this->extract_enum( $raw );
		if ( null !== $enum ) {
			$settings['enum'] = $enum;
		}

		$units = $this->extract_units( $raw );
		if ( null !== $units ) {
			$settings['units'] = $units;
		}

		if ( isset( $raw['settings']['required'] ) && true === $raw['settings']['required'] ) {
			$settings['required'] = true;
		}

		$out['settings'] = $settings;

		// Dynamic capability: a `dynamic` union member exposes `settings.categories` (11 §6, §3.1).
		$dynamic = $this->extract_dynamic( $raw );
		if ( null !== $dynamic ) {
			$out['dynamic'] = $dynamic;
		}

		// Carry the structural detail so nothing is lost (union members / object shape / array item).
		if ( isset( $raw['prop_types'] ) && is_array( $raw['prop_types'] ) ) {
			$out['prop_types'] = $raw['prop_types'];
		}
		if ( isset( $raw['shape'] ) && is_array( $raw['shape'] ) ) {
			$out['shape'] = $raw['shape'];
		}
		if ( isset( $raw['item_prop_type'] ) && is_array( $raw['item_prop_type'] ) ) {
			$out['item_prop_type'] = $raw['item_prop_type'];
		}

		return $out;
	}

	// §3.2 — GET /schema/styles.

	/**
	 * Return the flat Style-Schema css-prop map + unit presets + states (10-rest-api.md §3.2). Each
	 * prop is normalized to `{kind,key,enum?,members?(union),units?}`. `units` is the preset map derived
	 * live from the schema's `size` props (NEVER hardcoded); `states` is the valid variant-state list.
	 * Cached per Elementor+Pro version.
	 *
	 * @param WP_REST_Request $request The current request (unused).
	 * @return WP_REST_Response|\WP_Error
	 */
	public function get_styles_schema( WP_REST_Request $request ) {
		unset( $request );

		$cached = $this->cache_get( 'styles' );
		if ( null !== $cached ) {
			return $this->ok( $cached );
		}

		$schema = $this->style_schema();
		ksort( $schema );

		$props = array();
		foreach ( $schema as $name => $prop_type ) {
			$raw            = $this->prop_type_to_array( $prop_type );
			$props[ $name ] = $this->normalize_style_prop( $raw );
		}

		$data = array(
			'props'  => $props,
			'units'  => $this->unit_presets( $schema ),
			'states' => $this->valid_states(),
		);

		$this->cache_set( 'styles', $data );
		return $this->ok( $data );
	}

	/**
	 * Normalize one Style-Schema prop to `{kind,key,enum?,members?(union),units?}` (10-rest-api.md §3.2).
	 *
	 * @param array<string,mixed> $raw The `Prop_Type::jsonSerialize()` array for one css prop.
	 * @return array<string,mixed>
	 */
	private function normalize_style_prop( array $raw ): array {
		$out = array(
			'kind' => isset( $raw['kind'] ) ? $raw['kind'] : 'unknown',
			'key'  => isset( $raw['key'] ) ? $raw['key'] : ( isset( $raw['kind'] ) ? $raw['kind'] : 'unknown' ),
		);

		$enum = $this->extract_enum( $raw );
		if ( null !== $enum ) {
			$out['enum'] = $enum;
		}

		// Union props expose their member `$$type` keys so the validator knows the alternatives (11 §3).
		if ( isset( $raw['prop_types'] ) && is_array( $raw['prop_types'] ) ) {
			$out['members'] = array_values( array_keys( $raw['prop_types'] ) );
		}

		$units = $this->extract_units( $raw );
		if ( null !== $units ) {
			$out['units'] = $units;
		}

		return $out;
	}

	// §3.3 — GET /schema/registered-types.

	/**
	 * Return `{elements,widgets,atomic_available,pro_active}` (10-rest-api.md §3.3). Used by validation
	 * R2 (11 §8). Cached per Elementor+Pro version. `elements` = container/element types,
	 * `widgets` = widget types (both atomic + classic, as Elementor registers them).
	 *
	 * @param WP_REST_Request $request The current request (unused).
	 * @return WP_REST_Response|\WP_Error
	 */
	public function get_registered_types( WP_REST_Request $request ) {
		unset( $request );

		$cached = $this->cache_get( 'registered_types' );
		if ( null !== $cached ) {
			return $this->ok( $cached );
		}

		$types  = self::registered_types();
		$guards = $this->guards();

		$data = array(
			'elements'         => $types['elements'],
			'widgets'          => $types['widgets'],
			'atomic_available' => null !== $guards ? (bool) $guards->atomic_available() : false,
			'pro_active'       => null !== $guards ? (bool) $guards->is_pro_active() : defined( 'ELEMENTOR_PRO_VERSION' ),
		);

		$this->cache_set( 'registered_types', $data );
		return $this->ok( $data );
	}

	/**
	 * The canonical registered-types source (10-rest-api.md §3.3) — a static helper WP-P03/P05 MAY call
	 * via this class (they depend on WP-P07) or recompute. Returns `{elements,widgets}` of real ids.
	 *
	 * @return array{elements:string[],widgets:string[]}
	 */
	public static function registered_types(): array {
		$elements = array();
		$widgets  = array();

		if ( class_exists( '\Elementor\Plugin' ) ) {
			$plugin = \Elementor\Plugin::$instance;

			if ( null !== $plugin && isset( $plugin->elements_manager ) && method_exists( $plugin->elements_manager, 'get_element_types' ) ) {
				$element_types = $plugin->elements_manager->get_element_types();
				if ( is_array( $element_types ) ) {
					$elements = array_keys( $element_types );
				}
			}

			if ( null !== $plugin && isset( $plugin->widgets_manager ) && method_exists( $plugin->widgets_manager, 'get_widget_types' ) ) {
				$widget_types = $plugin->widgets_manager->get_widget_types();
				if ( is_array( $widget_types ) ) {
					$widgets = array_keys( $widget_types );
				}
			}
		}

		sort( $elements );
		sort( $widgets );

		return array(
			'elements' => array_values( array_map( 'strval', $elements ) ),
			'widgets'  => array_values( array_map( 'strval', $widgets ) ),
		);
	}

	// §3.4 — GET /schema/breakpoints.

	/**
	 * Return the LIVE active breakpoints `{items:[{key,label,direction,value}],active_direction,
	 * desktop_first}` (10-rest-api.md §3.4). NEVER hardcodes 767/1024 — reads the active breakpoints
	 * manager. Cached per Elementor+Pro version.
	 *
	 * @param WP_REST_Request $request The current request (unused).
	 * @return WP_REST_Response|\WP_Error
	 */
	public function get_breakpoints( WP_REST_Request $request ) {
		unset( $request );

		$cached = $this->cache_get( 'breakpoints' );
		if ( null !== $cached ) {
			return $this->ok( $cached );
		}

		$items            = self::breakpoints();
		$active_direction = $this->active_direction( $items );

		$data = array(
			'items'            => $items,
			'active_direction' => $active_direction,
			// Desktop-first when the active breakpoints describe widths BELOW desktop (max-width).
			'desktop_first'    => 'max' === $active_direction,
		);

		$this->cache_set( 'breakpoints', $data );
		return $this->ok( $data );
	}

	/**
	 * The canonical live breakpoints source (10-rest-api.md §3.4) — a static helper WP-P03/P05 MAY call
	 * via this class or recompute. Returns `[{key,label,direction,value}]` from the active breakpoints
	 * manager (NEVER hardcoded). Empty when Elementor/the manager is unavailable.
	 *
	 * @return array<int,array{key:string,label:string,direction:string,value:int}>
	 */
	public static function breakpoints(): array {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return array();
		}

		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->breakpoints ) || ! method_exists( $plugin->breakpoints, 'get_active_breakpoints' ) ) {
			return array();
		}

		$active = $plugin->breakpoints->get_active_breakpoints();
		if ( ! is_array( $active ) ) {
			return array();
		}

		$items = array();
		foreach ( $active as $key => $breakpoint ) {
			$direction = is_object( $breakpoint ) && method_exists( $breakpoint, 'get_direction' )
				? (string) $breakpoint->get_direction()
				: 'max';
			$value     = is_object( $breakpoint ) && method_exists( $breakpoint, 'get_value' )
				? (int) $breakpoint->get_value()
				: 0;
			$label     = is_object( $breakpoint ) && method_exists( $breakpoint, 'get_label' )
				? (string) $breakpoint->get_label()
				: (string) $key;

			$items[] = array(
				'key'       => (string) $key,
				'label'     => $label,
				'direction' => $direction,
				'value'     => $value,
			);
		}

		return $items;
	}

	/**
	 * The dominant breakpoint direction (`min`|`max`) across the active set (10-rest-api.md §3.4).
	 * Defaults to `max` (desktop-first) which is Elementor's default authoring direction.
	 *
	 * @param array<int,array{direction:string}> $items Active breakpoint items.
	 */
	private function active_direction( array $items ): string {
		$min = 0;
		$max = 0;
		foreach ( $items as $item ) {
			if ( isset( $item['direction'] ) && 'min' === $item['direction'] ) {
				++$min;
			} else {
				++$max;
			}
		}
		return $min > $max ? 'min' : 'max';
	}

	// §12 — GET /site/capabilities.

	/**
	 * Return the FULL frozen `site/capabilities` probe payload (10-rest-api.md §12). NOT cached (it
	 * reflects per-user caps like `can_update_class`/`unfiltered_html`). MUST respond even when Elementor
	 * is below MIN or controllers are not booted — it is the diagnostic of last resort
	 * (15-engineering-standards.md §7). On a degraded site `health` is overridden to `degraded`.
	 *
	 * @param WP_REST_Request $request The current request (unused).
	 * @return WP_REST_Response|\WP_Error
	 */
	public function get_capabilities( WP_REST_Request $request ) {
		unset( $request );

		$data = $this->build_capabilities();

		// §7: report degradation rather than fatally erroring (never block the probe).
		$data['health'] = $this->health( $data );

		return $this->ok( $data );
	}

	/**
	 * Assemble the capabilities payload via the WP-F05 {@see Capabilities::build()} builder (the frozen
	 * field set). When F05 is unavailable (defensive — should never happen in a normal build) fall back
	 * to a minimal degraded payload carrying the frozen keys so the probe still answers.
	 *
	 * @return array<string,mixed>
	 */
	private function build_capabilities(): array {
		if ( class_exists( '\Elementor\Ultra\Capabilities' ) && method_exists( '\Elementor\Ultra\Capabilities', 'build' ) ) {
			$payload = Capabilities::build();
			if ( is_array( $payload ) ) {
				return $payload;
			}
		}

		return $this->minimal_capabilities();
	}

	/**
	 * Decide `health`: `ok` normally, `degraded` when Elementor is absent/below MIN, or atomic is
	 * unavailable while Pro/atomic were expected (15-engineering-standards.md §7 / Detailed
	 * Requirements #5). Preserves an explicitly-set `degraded` from the builder.
	 *
	 * @param array<string,mixed> $data The assembled capabilities payload.
	 */
	private function health( array $data ): string {
		if ( isset( $data['health'] ) && 'degraded' === $data['health'] ) {
			return 'degraded';
		}

		$guards = $this->guards();
		if ( null === $guards ) {
			// No Guards service — cannot assert compatibility; degrade conservatively if Elementor absent.
			return defined( 'ELEMENTOR_VERSION' ) ? 'ok' : 'degraded';
		}

		if ( ! $guards->is_elementor_active() || ! $guards->is_elementor_compatible() ) {
			return 'degraded';
		}

		return 'ok';
	}

	/**
	 * The minimal frozen-key capabilities payload used only when the WP-F05 builder is unavailable. All
	 * §12 keys are present so the probe shape never breaks; `health` is `degraded`.
	 *
	 * @return array<string,mixed>
	 */
	private function minimal_capabilities(): array {
		$experiments = array();
		foreach ( array( 'e_atomic_elements', 'e_classes', 'e_variables', 'e_opt_in_v4_page', 'e_pro_atomic_form', 'e_wp_abilities_api' ) as $slug ) {
			$experiments[ $slug ] = 'default';
		}

		return array(
			'elementor_version'         => defined( 'ELEMENTOR_VERSION' ) ? (string) ELEMENTOR_VERSION : '',
			'pro_version'               => defined( 'ELEMENTOR_PRO_VERSION' ) ? (string) ELEMENTOR_PRO_VERSION : null,
			'pro_active'                => defined( 'ELEMENTOR_PRO_VERSION' ),
			'atomic_available'          => false,
			'v4_default'                => false,
			'experiments'               => $experiments,
			'global_classes'            => false,
			'variables'                 => false,
			'classes_migrated'          => false,
			'can_update_class'          => current_user_can( Permissions::UPDATE_CLASS_FALLBACK ),
			'unfiltered_html'           => current_user_can( 'unfiltered_html' ),
			'breakpoints'               => self::breakpoints(),
			'registered_types'          => self::registered_types(),
			'multisite'                 => is_multisite(),
			'is_local'                  => $this->is_local(),
			'app_passwords_available'   => function_exists( 'wp_is_application_passwords_available' ) ? (bool) wp_is_application_passwords_available() : false,
			'abilities_adapter_present' => false,
			'plugin_version'            => Plugin::VERSION,
			'health'                    => 'degraded',
		);
	}

	/** Heuristic: whether the site looks local/dev (10-rest-api.md §12, fallback path only). */
	private function is_local(): bool {
		if ( function_exists( 'wp_get_environment_type' ) ) {
			$env = wp_get_environment_type();
			if ( in_array( $env, array( 'local', 'development' ), true ) ) {
				return true;
			}
		}
		$host = isset( $_SERVER['HTTP_HOST'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_HOST'] ) ) : '';
		return (bool) preg_match( '/(^localhost|\.local$|\.test$|^127\.0\.0\.1)/', $host );
	}

	// Elementor resolution / introspection helpers.

	/**
	 * Resolve a type id to its Elementor element/widget instance, trying the widgets manager first
	 * (widgets like `e-heading`, `heading`) then the elements manager (containers like `e-div-block`,
	 * `container`, `e-form`). Returns null when unregistered on this site.
	 *
	 * @param string $type The widget/element type id.
	 * @return object|null
	 */
	private function resolve_element( string $type ) {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
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
	 * Whether an element instance is V4/atomic — detected by the presence of the (static)
	 * `get_props_schema()` method that only atomic elements declare.
	 *
	 * @param object $element The resolved element instance.
	 */
	private function is_atomic( $element ): bool {
		return method_exists( $element, 'get_props_schema' );
	}

	/**
	 * Whether an atomic element is a CONTAINER (its `elType` is not `widget`). Atomic widgets serialize
	 * `elType:'widget'`; atomic containers (`e-div-block`, …) serialize their own elType (11 §4).
	 *
	 * @param object $element The resolved atomic element instance.
	 */
	private function is_container( $element ): bool {
		$el_type = $this->element_type( $element );
		return '' !== $el_type && 'widget' !== $el_type;
	}

	/**
	 * The element's `elType` (`widget` for widgets, the container type id for containers). Prefers the
	 * static `get_type()`; falls back to `get_initial_config()['elType']`.
	 *
	 * @param object $element The resolved element instance.
	 */
	private function element_type( $element ): string {
		if ( method_exists( $element, 'get_type' ) ) {
			$value = call_user_func( array( $element, 'get_type' ) );
			if ( is_string( $value ) && '' !== $value ) {
				return $value;
			}
		}
		if ( method_exists( $element, 'get_initial_config' ) ) {
			$config = $element->get_initial_config();
			if ( is_array( $config ) && isset( $config['elType'] ) && is_string( $config['elType'] ) ) {
				return $config['elType'];
			}
		}
		return '';
	}

	/**
	 * The atomic widget `version` (10-rest-api.md §3.1). Read from `get_initial_config()['version']`
	 * with the frozen `0.0` default when the instance does not report one.
	 *
	 * @param object $element The resolved atomic element instance.
	 */
	private function atomic_version( $element ): string {
		if ( method_exists( $element, 'get_initial_config' ) ) {
			$config = $element->get_initial_config();
			if ( is_array( $config ) && isset( $config['version'] ) && is_scalar( $config['version'] ) ) {
				$version = (string) $config['version'];
				if ( '' !== $version ) {
					return $version;
				}
			}
		}
		return self::DEFAULT_VERSION;
	}

	/**
	 * Serialize a `Prop_Type` to a PURE nested associative array — the authoritative editor-facing
	 * `{kind,key,default,settings,prop_types?,shape?,item_prop_type?}` shape. `Prop_Type::jsonSerialize()`
	 * returns a top-level array whose nested members are `stdClass`/objects; we round-trip through
	 * `wp_json_encode`/`json_decode($x,true)` so EVERY level is a plain array (downstream `is_array`
	 * checks then hold uniformly). Falls back to `get_key`/`get_default`/`get_settings` defensively.
	 *
	 * @param mixed $prop_type A `Prop_Type` instance (or already-array).
	 * @return array<string,mixed>
	 */
	private function prop_type_to_array( $prop_type ): array {
		if ( is_array( $prop_type ) ) {
			return $this->to_pure_array( $prop_type );
		}

		if ( is_object( $prop_type ) && ( $prop_type instanceof \JsonSerializable || method_exists( $prop_type, 'jsonSerialize' ) ) ) {
			$pure = $this->to_pure_array( $prop_type );
			if ( ! empty( $pure ) ) {
				return $pure;
			}
		}

		$out = array();
		if ( is_object( $prop_type ) ) {
			if ( method_exists( $prop_type, 'get_key' ) ) {
				$out['key']  = $prop_type->get_key();
				$out['kind'] = $prop_type->get_key();
			}
			if ( method_exists( $prop_type, 'get_default' ) ) {
				$out['default'] = $this->to_pure_array( $prop_type->get_default() );
			}
			if ( method_exists( $prop_type, 'get_settings' ) ) {
				$out['settings'] = $this->to_pure_array( $prop_type->get_settings() );
			}
		}
		return $out;
	}

	/**
	 * Deep-convert any value (object/array/scalar) into pure nested associative arrays via a JSON
	 * round-trip. Used so `jsonSerialize()` output (which nests `stdClass` members) is uniformly
	 * array-shaped for the `is_array` traversals in the normalizers.
	 *
	 * @param mixed $value Any JSON-serializable value.
	 * @return array<int|string,mixed>
	 */
	private function to_pure_array( $value ): array {
		if ( is_scalar( $value ) || null === $value ) {
			return array();
		}
		$decoded = json_decode( (string) wp_json_encode( $value ), true );
		return is_array( $decoded ) ? $decoded : array();
	}

	/**
	 * Extract the enum value list from a serialized prop: directly from `settings.enum`, else from a
	 * `string` union member's `settings.enum` (e.g. atomic `tag` whose string member is enum-constrained).
	 *
	 * @param array<string,mixed> $raw Serialized prop array.
	 * @return string[]|null
	 */
	private function extract_enum( array $raw ) {
		if ( isset( $raw['settings']['enum'] ) && is_array( $raw['settings']['enum'] ) ) {
			return array_values( $raw['settings']['enum'] );
		}

		if ( isset( $raw['prop_types'] ) && is_array( $raw['prop_types'] ) ) {
			foreach ( $raw['prop_types'] as $member ) {
				if ( is_array( $member ) && isset( $member['settings']['enum'] ) && is_array( $member['settings']['enum'] ) ) {
					return array_values( $member['settings']['enum'] );
				}
			}
		}

		return null;
	}

	/**
	 * Extract the available-units list from a serialized prop: directly from `settings.available_units`
	 * (a `size` prop), else from a `size` union member.
	 *
	 * @param array<string,mixed> $raw Serialized prop array.
	 * @return string[]|null
	 */
	private function extract_units( array $raw ) {
		if ( isset( $raw['settings']['available_units'] ) && is_array( $raw['settings']['available_units'] ) ) {
			return array_values( $raw['settings']['available_units'] );
		}

		if ( isset( $raw['prop_types'] ) && is_array( $raw['prop_types'] ) ) {
			foreach ( $raw['prop_types'] as $key => $member ) {
				if ( ! is_array( $member ) ) {
					continue;
				}
				if ( 'size' === $key && isset( $member['settings']['available_units'] ) && is_array( $member['settings']['available_units'] ) ) {
					return array_values( $member['settings']['available_units'] );
				}
				if ( isset( $member['settings']['available_units'] ) && is_array( $member['settings']['available_units'] ) ) {
					return array_values( $member['settings']['available_units'] );
				}
			}
		}

		return null;
	}

	/**
	 * Extract the dynamic-binding descriptor `{active:true,categories:[...]}` when a prop (or a union
	 * member) carries a `dynamic` member exposing `settings.categories` (11 §6 / §3.1). Null otherwise.
	 *
	 * @param array<string,mixed> $raw Serialized prop array.
	 * @return array{active:bool,categories:string[]}|null
	 */
	private function extract_dynamic( array $raw ) {
		$categories = $this->find_dynamic_categories( $raw, 0 );
		if ( null === $categories ) {
			return null;
		}
		return array(
			'active'     => true,
			'categories' => $categories,
		);
	}

	/**
	 * Recursively search a serialized prop (union members + object shape, bounded depth) for a `dynamic`
	 * member and return its `settings.categories`. Bounded to avoid pathological deep recursion.
	 *
	 * @param array<string,mixed> $raw   Serialized prop (or sub-prop) array.
	 * @param int                 $depth Current recursion depth.
	 * @return string[]|null
	 */
	private function find_dynamic_categories( array $raw, int $depth ) {
		if ( $depth > 4 ) {
			return null;
		}

		if ( isset( $raw['prop_types'] ) && is_array( $raw['prop_types'] ) ) {
			foreach ( $raw['prop_types'] as $key => $member ) {
				if ( ! is_array( $member ) ) {
					continue;
				}
				if ( 'dynamic' === $key || ( isset( $member['key'] ) && 'dynamic' === $member['key'] ) ) {
					$cats = isset( $member['settings']['categories'] ) && is_array( $member['settings']['categories'] )
						? array_values( array_map( 'strval', $member['settings']['categories'] ) )
						: array();
					return $cats;
				}
				$nested = $this->find_dynamic_categories( $member, $depth + 1 );
				if ( null !== $nested ) {
					return $nested;
				}
			}
		}

		if ( isset( $raw['shape'] ) && is_array( $raw['shape'] ) ) {
			foreach ( $raw['shape'] as $field ) {
				if ( is_array( $field ) ) {
					$nested = $this->find_dynamic_categories( $field, $depth + 1 );
					if ( null !== $nested ) {
						return $nested;
					}
				}
			}
		}

		return null;
	}

	// Style-Schema helpers.

	/**
	 * The live flat Style-Schema map (`css-prop` => `Prop_Type`) via the (static)
	 * `Style_Schema::get_style_schema()` (post-filter, runtime-extended). Empty when unavailable.
	 *
	 * @return array<string,mixed>
	 */
	private function style_schema(): array {
		$class = '\Elementor\Modules\AtomicWidgets\Styles\Style_Schema';
		if ( class_exists( $class ) && method_exists( $class, 'get_style_schema' ) ) {
			$schema = call_user_func( array( $class, 'get_style_schema' ) );
			if ( is_array( $schema ) ) {
				return $schema;
			}
		}
		return array();
	}

	/**
	 * The valid variant states for `schema/styles.states` (10-rest-api.md §3.2; 11 §5.2). Reads
	 * `Style_States::get_valid_states()` and drops the trailing `null` (normal) sentinel so the wire
	 * value is the frozen `[hover,active,focus,focus-visible,checked,e--selected]` list. Falls back to
	 * the frozen literal when the class is unavailable.
	 *
	 * @return string[]
	 */
	private function valid_states(): array {
		$frozen = array( 'hover', 'active', 'focus', 'focus-visible', 'checked', 'e--selected' );

		$class = '\Elementor\Modules\AtomicWidgets\Styles\Style_States';
		if ( class_exists( $class ) && method_exists( $class, 'get_valid_states' ) ) {
			$states = call_user_func( array( $class, 'get_valid_states' ) );
			if ( is_array( $states ) ) {
				$states = array_values(
					array_filter(
						$states,
						static function ( $state ) {
							return null !== $state && '' !== $state;
						}
					)
				);
				if ( ! empty( $states ) ) {
					return array_map( 'strval', $states );
				}
			}
		}

		return $frozen;
	}

	/**
	 * Build the `units` preset map for `schema/styles` (10-rest-api.md §3.2) — derived LIVE from the
	 * Style-Schema's `size` props (NEVER hardcoded). The widest unit set (width/height etc.) is named
	 * `standard`; the typographic set (font-size/line-height etc.) is named `typography`; any further
	 * distinct sets are exposed under stable `setN` keys so nothing is lost.
	 *
	 * @param array<string,mixed> $schema The flat Style-Schema map.
	 * @return array<string,string[]>
	 */
	private function unit_presets( array $schema ): array {
		// Probe representative props for their unit sets.
		$standard   = $this->units_for_prop( $schema, 'width' );
		$typography = $this->units_for_prop( $schema, 'font-size' );

		$presets = array();
		if ( null !== $standard ) {
			$presets['standard'] = $standard;
		}
		if ( null !== $typography ) {
			$presets['typography'] = $typography;
		}

		// Collect any further distinct unit sets across all size props (deterministic order).
		$seen = array();
		foreach ( $presets as $units ) {
			$seen[ implode( ',', $units ) ] = true;
		}

		$extra_index = 0;
		$names       = array();
		foreach ( $schema as $name => $prop_type ) {
			$units = $this->extract_units( $this->prop_type_to_array( $prop_type ) );
			if ( null === $units ) {
				continue;
			}
			$key = implode( ',', $units );
			if ( isset( $seen[ $key ] ) ) {
				continue;
			}
			$seen[ $key ]  = true;
			$names[ $key ] = $units;
		}
		ksort( $names );
		foreach ( $names as $units ) {
			$presets[ 'set' . $extra_index ] = $units;
			++$extra_index;
		}

		// Conservative fallback if the schema yielded nothing (Elementor unavailable).
		if ( empty( $presets ) ) {
			$presets['standard']   = array( 'px', '%', 'em', 'rem', 'vw', 'vh', 'ch', 'auto', 'custom' );
			$presets['typography'] = array( 'px', 'em', 'rem', 'vw', 'vh', 'ch', '%', 'custom' );
		}

		return $presets;
	}

	/**
	 * The available units for a named Style-Schema prop, or null when the prop is absent/unit-less.
	 *
	 * @param array<string,mixed> $schema The flat Style-Schema map.
	 * @param string              $prop   The css prop name to probe.
	 * @return string[]|null
	 */
	private function units_for_prop( array $schema, string $prop ) {
		if ( ! isset( $schema[ $prop ] ) ) {
			return null;
		}
		return $this->extract_units( $this->prop_type_to_array( $schema[ $prop ] ) );
	}

	// Caching (version-keyed transients; Detailed Requirements #7).

	/**
	 * The version-keyed transient name for a schema cache slot — `emcp_schema_{elementor}_{pro}_{slot}`
	 * (md5 of the version tuple keeps the key short + invalidates on a version bump or the drift job).
	 *
	 * @param string $slot Cache slot id (e.g. `styles`, `widget_e-heading`).
	 */
	private function cache_key( string $slot ): string {
		$el  = defined( 'ELEMENTOR_VERSION' ) ? (string) ELEMENTOR_VERSION : '0';
		$pro = defined( 'ELEMENTOR_PRO_VERSION' ) ? (string) ELEMENTOR_PRO_VERSION : '0';
		return self::CACHE_PREFIX . md5( $el . '|' . $pro . '|' . $slot );
	}

	/**
	 * Read a cached schema payload, or null on a miss.
	 *
	 * @param string $slot Cache slot id.
	 * @return array<string,mixed>|null
	 */
	private function cache_get( string $slot ) {
		$value = get_transient( $this->cache_key( $slot ) );
		return is_array( $value ) ? $value : null;
	}

	/**
	 * Store a schema payload in the version-keyed transient cache.
	 *
	 * @param string              $slot Cache slot id.
	 * @param array<string,mixed> $data Payload to cache.
	 * @return void
	 */
	private function cache_set( string $slot, array $data ): void {
		set_transient( $this->cache_key( $slot ), $data, self::CACHE_TTL );
	}

	// Misc.

	/**
	 * The shared {@see \Elementor\Ultra\Core\Guards} probe service, or null when the spine has not
	 * constructed it (e.g. an extremely early or degraded boot).
	 *
	 * @return \Elementor\Ultra\Core\Guards|null
	 */
	private function guards() {
		if ( class_exists( '\Elementor\Ultra\Plugin' ) ) {
			$plugin = Plugin::instance();
			if ( null !== $plugin && isset( $plugin->guards ) && $plugin->guards instanceof \Elementor\Ultra\Core\Guards ) {
				return $plugin->guards;
			}
		}
		if ( class_exists( '\Elementor\Ultra\Core\Guards' ) ) {
			return new \Elementor\Ultra\Core\Guards();
		}
		return null;
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration + self-load (Parallelization Notes; 01-architecture.md §4.3/§4.4).
 * --------------------------------------------------------------------------
 * The spine `Registrar` (WP-P02) fires `elementor_ultra/rest/register` on `rest_api_init` and the spine
 * "discovers" verticals rather than editing them (§4.3). Two seams are wired here, both touching ONLY
 * this owned file:
 *
 *  1. Self-REGISTRATION: hand the registrar a fresh controller instance on its `REGISTER_ACTION`
 *     (the primary path), AND — defensively, so route registration is resilient to hook ORDERING —
 *     register the five routes directly on `rest_api_init` at priority 9 (before the registrar's own
 *     `register_routes()` at the default priority 10) if the registrar action has not already done it.
 *     Either path registers the routes exactly once (the `EMCP_SCHEMA_ROUTES_REGISTERED` one-shot).
 *
 *  2. Self-LOAD ("discovery"): the SPL autoloader only parses this file when `Schema_Controller` is
 *     first referenced, and the WP-P02 spine `Registrar` does not include controller files itself, so
 *     absent an external include this file's hooks would never be parsed. We therefore register a
 *     `plugins_loaded` (priority 30 — after the spine boots at 20) self-loader from the ALWAYS-loaded
 *     plugin bootstrap is NOT possible from here (the file is not yet loaded); instead the discovery
 *     touchpoint is the registrar's action itself. To guarantee the file is parsed in time, the spine /
 *     integration includes `includes/rest/class-*-controller.php` at the wave boundary (§4.4). When that
 *     include runs (or any reference loads the class), BOTH hooks below are installed and the routes go
 *     live. This block is guarded by a one-shot constant so a standalone load (php -l / PHPUnit) is safe.
 */
if ( ! defined( 'EMCP_SCHEMA_CONTROLLER_BOOTSTRAPPED' ) ) {
	define( 'EMCP_SCHEMA_CONTROLLER_BOOTSTRAPPED', true );

	/**
	 * Register the SCHEMA + SITE routes exactly once, regardless of which seam triggers it (the
	 * registrar `REGISTER_ACTION` collector or the direct `rest_api_init` priority-9 fallback).
	 *
	 * @return void
	 */
	$emcp_schema_register_routes = static function () {
		if ( defined( 'EMCP_SCHEMA_ROUTES_REGISTERED' ) ) {
			return;
		}
		define( 'EMCP_SCHEMA_ROUTES_REGISTERED', true );
		( new Schema_Controller() )->register_routes();
	};

	// Primary path: self-register with the WP-P02 registrar so it participates in the controller count.
	add_action(
		Registrar::REGISTER_ACTION,
		static function ( $registrar ) use ( $emcp_schema_register_routes ) {
			if ( $registrar instanceof Registrar ) {
				$registrar->register_controller( new Schema_Controller() );
			}
			// Mark routes as registered via the registrar so the direct fallback below no-ops.
			if ( ! defined( 'EMCP_SCHEMA_ROUTES_REGISTERED' ) ) {
				define( 'EMCP_SCHEMA_ROUTES_REGISTERED', true );
			}
			unset( $emcp_schema_register_routes );
		}
	);

	// Order-independent fallback: if this file is loaded but the registrar's action already fired (or is
	// hooked at a later priority), register the routes directly at `rest_api_init` priority 9.
	add_action( 'rest_api_init', $emcp_schema_register_routes, 9 );
}
