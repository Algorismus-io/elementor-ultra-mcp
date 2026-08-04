<?php
/**
 * WP-P16 — Abstract_Ability: the base every concrete ability extends in the SECONDARY (optional)
 * WP-Abilities integration path.
 *
 * Each concrete ability is a thin "schema + permission + delegation" shell over the SAME core service
 * a REST controller uses — there is ONE implementation of truth (10-rest-api.md §0.9 dry-run is
 * AUTHORITATIVE; §0.10 save primes atomic CSS; WP-P16 Detailed Requirements #3). The ability NEVER
 * duplicates business logic; `execute()` validates input against the declared schema, checks the SAME
 * capability the REST route uses, then delegates to the core service and returns its result (or a
 * `WP_Error`).
 *
 * Contract authority:
 *  - 10-rest-api.md §0.2/§0.3 (App-Password Basic auth + `current_user_can` is the security boundary —
 *    reused verbatim by {@see permission_callback()}), §2/§12 (route payload shapes the schemas
 *    mirror), §11 (write abilities append to the same op-log store via `Op_Log::record`).
 *  - 12-error-taxonomy.md §3.4 (`CAPABILITY_MISSING`/`AUTH_FAILED` on the permission gate).
 *  - 15-engineering-standards.md §1, §5 (optional adapter / secondary path).
 *
 * GRACEFUL ABSENCE: this class declares NO Abilities-API / adapter symbols at parse time. It is only
 * ever instantiated by {@see Server_Registrar} AFTER the secondary path is confirmed present, so it is
 * safe to ship even though the adapter (and, in a degraded build, the core Abilities API) is absent.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Abilities;

use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Base ability: declares name/label/description/schemas/capability and the `execute()` delegation
 * contract. Concrete abilities implement the abstract members; {@see to_definition()} turns the
 * ability into the {@see Ability_Definition} the registrar registers.
 */
abstract class Abstract_Ability {

	/**
	 * The ability namespace prefix WP core requires (`<namespace>/<slug>`; abilities-api.php name
	 * validation). Matches the plugin's REST namespace root so the secondary path is unmistakably ours.
	 */
	const ABILITY_NAMESPACE = 'elementor-ultra';

	/**
	 * The ability category every ability in this path belongs to. Registered once by
	 * {@see Server_Registrar} via `wp_register_ability_category()` before any ability is registered.
	 */
	const ABILITY_CATEGORY = 'elementor-ultra';

	/**
	 * The ability slug (without the namespace prefix), e.g. `dry-run`. Concrete abilities define it.
	 */
	abstract protected function slug(): string;

	/** Human-readable label for `wp_register_ability` (`$args['label']`). */
	abstract protected function label(): string;

	/** Detailed description of what the ability does + when to use it (`$args['description']`). */
	abstract protected function description(): string;

	/**
	 * JSON Schema for the ability input, mirroring the corresponding REST route request body
	 * (10-rest-api.md §2/§12). Empty array = no input.
	 *
	 * @return array<string,mixed>
	 */
	abstract protected function input_schema(): array;

	/**
	 * JSON Schema for the ability output, mirroring the corresponding REST route `data` payload
	 * (10-rest-api.md §2/§12).
	 *
	 * @return array<string,mixed>
	 */
	abstract protected function output_schema(): array;

	/**
	 * Behavioural annotations for tooling (abilities-api.php docblock: `readonly`,`destructive`,
	 * `idempotent`). Reads return `['readonly' => true]`; writes describe destructiveness/idempotency.
	 *
	 * @return array<string,bool>
	 */
	abstract protected function annotations(): array;

	/**
	 * The WordPress capability gate this ability requires — IDENTICAL to the corresponding REST route's
	 * `permission_callback` capability (10-rest-api.md §0.3): `edit_posts` for CAP_READ, `edit_post`
	 * (object) for CAP_EDIT_POST. Returning the bare capability keeps the boundary in one place.
	 *
	 * @param mixed $input The (already-array-normalized) ability input, so object-cap abilities can
	 *                     resolve the target post id.
	 */
	abstract protected function capability( $input ): string;

	/**
	 * Run the ability's core logic by DELEGATING to the SAME core service the REST controller uses
	 * (WP-P16 #3 — single source of truth). Returns the service result (an assoc array mirroring the
	 * REST `data` payload) or a `WP_Error` on failure. NEVER duplicates validation/locking/backup/prime.
	 *
	 * @param array<string,mixed> $input The validated input.
	 * @return array<string,mixed>|WP_Error
	 */
	abstract protected function run( array $input );

	/**
	 * The execute callback bound into the {@see Ability_Definition} (`$args['execute_callback']`):
	 * normalizes input to an array then delegates to {@see run()}. WP core validates the input against
	 * `input_schema` before this runs (WP_Ability::validate_input()); we additionally coerce to an
	 * array so a null/scalar input degrades to an empty patch rather than a type error.
	 *
	 * @param mixed $input The raw ability input (validated against the schema by WP core).
	 * @return array<string,mixed>|WP_Error
	 */
	public function execute( $input = null ) {
		return $this->run( is_array( $input ) ? $input : array() );
	}

	/**
	 * The permission callback bound into the {@see Ability_Definition} (`$args['permission_callback']`).
	 * Reuses the EXACT REST capability boundary (10-rest-api.md §0.2/§0.3): App-Password Basic auth has
	 * already populated the current user by the time abilities run, so this is purely the
	 * `current_user_can(...)` gate. Returns `true` or a taxonomy 403/401 `WP_Error` (never a bare false,
	 * so a structured reason reaches the client — 12-error-taxonomy.md §3.4).
	 *
	 * @param mixed $input The raw ability input (for object-cap resolution).
	 * @return true|WP_Error
	 */
	public function permission_callback( $input = null ) {
		$normalized = is_array( $input ) ? $input : array();
		$capability = $this->capability( $normalized );

		// Object capability (`edit_post`) needs the target id; resolve it from the input when present.
		$post_id = isset( $normalized['id'] ) ? (int) $normalized['id'] : 0;

		$allowed = ( $post_id > 0 )
			? current_user_can( $capability, $post_id )
			: current_user_can( $capability );

		if ( $allowed ) {
			return true;
		}

		// Mirror the REST gate's logged-in (403) vs logged-out (401) split (Permissions::deny()).
		$status = function_exists( 'rest_authorization_required_code' ) ? rest_authorization_required_code() : 403;

		if ( 401 === $status ) {
			return new WP_Error(
				'AUTH_FAILED',
				__( 'Authentication required: a valid Application Password is missing or invalid.', 'elementor-ultra-mcp' ),
				array(
					'status' => 401,
					'meta'   => array(
						'reason'     => 'not_logged_in',
						'capability' => $capability,
					),
				)
			);
		}

		return new WP_Error(
			'CAPABILITY_MISSING',
			__( 'You do not have permission to perform this operation.', 'elementor-ultra-mcp' ),
			array(
				'status' => 403,
				'meta'   => array(
					'capability' => $capability,
					'user_id'    => get_current_user_id(),
				),
			)
		);
	}

	/**
	 * Build the {@see Ability_Definition} for this ability: the fully-qualified name plus the bound
	 * execute/permission callbacks and schemas. Consumed by {@see Server_Registrar} to register the
	 * ability (via the core Abilities API and/or the optional mcp-adapter `create_server()`).
	 */
	public function to_definition(): Ability_Definition {
		return new Ability_Definition(
			self::ABILITY_NAMESPACE . '/' . $this->slug(),
			$this->label(),
			$this->description(),
			self::ABILITY_CATEGORY,
			$this->input_schema(),
			$this->output_schema(),
			$this->annotations(),
			array( $this, 'execute' ),
			array( $this, 'permission_callback' )
		);
	}

	/**
	 * Append one op-log row through the SHARED store (10-rest-api.md §11) so ability writes land in the
	 * SAME audit trail as REST writes. Guarded behind `class_exists` so a build without WP-P14 degrades
	 * to no-logging (the underlying write still succeeds — Op_Log::record is itself failure-tolerant).
	 *
	 * @param array{op_id?:?string,post_id?:?int,route?:?string,before_hash?:?string,after_hash?:?string,result?:?string,meta?:mixed} $row Row fields.
	 * @return void
	 */
	protected function record_op( array $row ): void {
		if ( class_exists( '\Elementor\Ultra\Core\Op_Log' ) && method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			\Elementor\Ultra\Core\Op_Log::record( $row );
		}
	}
}
