<?php
/**
 * WP-P16 — Ability_Definition: the value object describing one ability for registration.
 *
 * The SECONDARY (optional) WP-Abilities integration path. This VO carries everything the WordPress
 * Abilities API needs to register an ability via `wp_register_ability( $name, $args )` (WP core
 * `wp-includes/abilities-api.php:278` — args shape `{label, description, category, execute_callback,
 * permission_callback, input_schema, output_schema, meta}`), built from a concrete
 * {@see \Elementor\Ultra\Abilities\Abstract_Ability}. Keeping the registration arguments in one VO
 * lets {@see \Elementor\Ultra\Abilities\Server_Registrar} stay a thin glue layer that is identical
 * whether it registers via the core Abilities API or hands the same shape to the optional
 * `wordpress/mcp-adapter` `create_server()` builder.
 *
 * Contract authority:
 *  - 10-rest-api.md §12 (`abilities_adapter_present` flag), §0.2/§0.3 (the App-Password +
 *    `current_user_can` boundary the permission callback reuses), §2/§12 (the route payload shapes
 *    the input/output schemas mirror so a secondary-path MCP client sees the same shapes).
 *  - 15-engineering-standards.md §1 (optional `wordpress/mcp-adapter`, guarded — graceful no-op),
 *    §5 (secondary path).
 *
 * This file declares NO Elementor / adapter symbols at parse time — it is a pure data holder, safe to
 * load even when neither the Abilities API nor the adapter is present.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Abilities;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Immutable descriptor of a single ability: its fully-qualified name, human label/description,
 * category slug, input/output JSON Schemas, behavioural annotations, and the bound execute +
 * permission callbacks. Produced by {@see Abstract_Ability::to_definition()}; consumed by
 * {@see Server_Registrar} when (and only when) the secondary path is active.
 */
final class Ability_Definition {

	/**
	 * Fully-qualified ability name including the namespace prefix, e.g. `elementor-ultra/dry-run`
	 * (WP core requires a `<namespace>/<slug>` name — abilities-api.php:225-260).
	 *
	 * @var string
	 */
	private $name;

	/**
	 * Human-readable label (WP `wp_register_ability` `$args['label']`, required).
	 *
	 * @var string
	 */
	private $label;

	/**
	 * Detailed description of what the ability does + when to use it (`$args['description']`, required).
	 *
	 * @var string
	 */
	private $description;

	/**
	 * The ability-category slug (`$args['category']`, required — registered up front by the registrar
	 * via `wp_register_ability_category()`).
	 *
	 * @var string
	 */
	private $category;

	/**
	 * JSON Schema for the ability input (`$args['input_schema']`), mirroring the corresponding REST
	 * route request body so a secondary-path client sees the same shape (10-rest-api.md §2/§12).
	 *
	 * @var array<string,mixed>
	 */
	private $input_schema;

	/**
	 * JSON Schema for the ability output (`$args['output_schema']`), mirroring the corresponding REST
	 * route `data` payload (10-rest-api.md §2/§12).
	 *
	 * @var array<string,mixed>
	 */
	private $output_schema;

	/**
	 * Semantic annotations for tooling (`$args['meta']['annotations']` — `readonly`,`destructive`,
	 * `idempotent`; abilities-api.php docblock). Reads set `readonly:true`; writes describe their
	 * destructiveness/idempotency.
	 *
	 * @var array<string,bool>
	 */
	private $annotations;

	/**
	 * The execute callback (`$args['execute_callback']`): `fn( mixed $input ): mixed|WP_Error`.
	 * Bound to {@see Abstract_Ability::execute()} so it delegates to the SAME core service the REST
	 * controller uses (single source of truth).
	 *
	 * @var callable
	 */
	private $execute_callback;

	/**
	 * The permission callback (`$args['permission_callback']`): `fn( mixed $input ): bool|WP_Error`.
	 * Reuses the REST capability boundary (`current_user_can(...)`) so auth/cap gating matches REST
	 * (10-rest-api.md §0.2/§0.3).
	 *
	 * @var callable
	 */
	private $permission_callback;

	/**
	 * Construct an immutable ability descriptor.
	 *
	 * @param string              $name                Fully-qualified `<namespace>/<slug>` ability name.
	 * @param string              $label               Human-readable label.
	 * @param string              $description         Detailed description.
	 * @param string              $category            Ability-category slug.
	 * @param array<string,mixed> $input_schema        JSON Schema for input.
	 * @param array<string,mixed> $output_schema       JSON Schema for output.
	 * @param array<string,bool>  $annotations         Behavioural annotations (readonly/destructive/idempotent).
	 * @param callable            $execute_callback    `fn(mixed):mixed|WP_Error`.
	 * @param callable            $permission_callback `fn(mixed):bool|WP_Error`.
	 */
	public function __construct(
		string $name,
		string $label,
		string $description,
		string $category,
		array $input_schema,
		array $output_schema,
		array $annotations,
		callable $execute_callback,
		callable $permission_callback
	) {
		$this->name                = $name;
		$this->label               = $label;
		$this->description         = $description;
		$this->category            = $category;
		$this->input_schema        = $input_schema;
		$this->output_schema       = $output_schema;
		$this->annotations         = $annotations;
		$this->execute_callback    = $execute_callback;
		$this->permission_callback = $permission_callback;
	}

	/** The fully-qualified ability name (`<namespace>/<slug>`). */
	public function name(): string {
		return $this->name;
	}

	/** The ability-category slug. */
	public function category(): string {
		return $this->category;
	}

	/**
	 * The exact `$args` array for `wp_register_ability( $this->name(), $this->args() )` (WP core
	 * abilities-api.php:278). Identical shape the optional `mcp-adapter` `create_server()` consumes —
	 * keep this the single place the registration arguments are assembled.
	 *
	 * @return array<string,mixed>
	 */
	public function args(): array {
		return array(
			'label'               => $this->label,
			'description'         => $this->description,
			'category'            => $this->category,
			'input_schema'        => $this->input_schema,
			'output_schema'       => $this->output_schema,
			'execute_callback'    => $this->execute_callback,
			'permission_callback' => $this->permission_callback,
			'meta'                => array(
				'annotations'  => $this->annotations,
				'show_in_rest' => true,
			),
		);
	}
}
