<?php
/**
 * WP-P13 — Cache & IDs REST controller: cache regen/flush + the pure-computation id routes.
 *
 * Contract authority:
 *  - 10-rest-api.md §9 (CACHE routes: `POST /cache/regen` CAP_MANAGE, `DELETE /cache` CAP_MANAGE),
 *    §10 (IDS routes: `POST /ids/validate` CAP_READ, `POST /ids/remap` CAP_READ — note `GET
 *    /documents/{id}/ids` is document-scoped and lives in WP-P06, NOT here), §0.3 (CAP_MANAGE =
 *    `manage_options`, CAP_READ = `edit_posts`), §0.12 (cache side effects), §0.5/§0.6 (envelopes).
 *  - 11-authoring-contract.md §8.1 (id handling — `ids/validate` + `ids/remap` before insert), §9
 *    (mint formula), §5.1 (local-style triple consistency).
 *  - 12-error-taxonomy.md §3.1 (`DUPLICATE_ELEMENT_ID` — what `ids/validate` helps the client avoid).
 *
 * This controller is a THIN REST facade. ALL logic lives in the reused core services
 * {@see \Elementor\Ultra\Core\Cache_Service} (WP-P05) and {@see \Elementor\Ultra\Core\Id_Service}
 * (WP-P04); the controller only parses args + shapes the §0.5 envelope (WP-P13 Implementation Notes).
 *
 * Capability split (WP-P13 §Detailed Requirements):
 *  - Cache routes are CAP_MANAGE — they regenerate/evict CSS (a site-wide side effect).
 *  - Id routes are CAP_READ — they are PURE FUNCTIONS of their input that PERSIST NOTHING; they help
 *    the TS client mint collision-free trees BEFORE a write so it avoids `DUPLICATE_ELEMENT_ID`
 *    (10 §10 / 12 §3.1). The controller MUST NOT write anything on the id routes.
 *
 * SPIKE-VERIFIED CORRECTIONS (WP-S07, this ticket's §Spike-Verified Corrections + SUMMARY.md C6):
 *  - [S07/C6] The flush MUST run in-process via `files_manager->clear_cache()` as the web-server uid
 *    that owns `uploads/elementor/css/*`. This REST handler satisfies that (uid 33 / Apache). The reused
 *    {@see Cache_Service::flush_all()} performs the in-process flush; this controller NEVER shells out to
 *    a CLI sidecar (uid 82) which clears DB meta but FAILS to unlink files while STILL printing Success.
 *  - [S07/R2] NEVER trust `clear_cache()`'s success string — it does not check `unlink()`'s return
 *    (`core/files/manager.php:111-113`). {@see Cache_Service::flush_all()} asserts the CSS dir is empty
 *    after the flush and returns FALSE on stale files; this controller surfaces that boolean verbatim as
 *    `{flushed:<bool>}` (a FALSE means "files remained" — surfaced honestly, not lied about as success).
 *  - [S07/R10] Multisite `--network` flush/regen is UNVERIFIED on the live target. `network:true` is
 *    gated inside the service: on a single-site install it degrades to the current site and returns a
 *    `warnings` note (we surface that note); on a real multisite it fans out per-subsite under
 *    `switch_to_blog()` with a per-site files-empty assertion (also caveated via `warnings`).
 *
 * Self-registration (WP-P01 spine parallelism): this controller adds itself to the WP-P02
 * {@see \Elementor\Ultra\Rest\Registrar} via the `elementor_ultra/rest/register` action — it NEVER
 * edits the spine `Registrar`/`Plugin` files. The registrar globs+requires `class-*-controller.php`,
 * so the file-scope `add_action()` below is in place when the registrar fires on `rest_api_init`.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Cache_Service;
use Elementor\Ultra\Core\Id_Service;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The CACHE + IDS REST controller (10-rest-api.md §9, §10). Four routes: two CAP_MANAGE cache writes
 * (regen/flush) and two CAP_READ pure-computation id helpers (validate/remap).
 */
final class Cache_Controller extends Abstract_Controller {

	/** Op-log `route` value for the cache-regen write (10-rest-api.md §11; WP-P14 store). */
	const OP_ROUTE_REGEN = 'cache/regen';

	/** Op-log `route` value for the cache-flush write (10-rest-api.md §11; WP-P14 store). */
	const OP_ROUTE_FLUSH = 'cache/flush';

	/**
	 * Register the four routes (10-rest-api.md §9, §10):
	 *  - `POST   /cache/regen`   CAP_MANAGE — regenerate CSS (per-post or global, network-gated).
	 *  - `DELETE /cache`         CAP_MANAGE — full `files_manager->clear_cache()` flush (network-gated).
	 *  - `POST   /ids/validate`  CAP_READ   — validate id uniqueness of a candidate tree (no persist).
	 *  - `POST   /ids/remap`     CAP_READ   — remap colliding ids + rewrite local-style backrefs (no persist).
	 *
	 * @return void
	 */
	public function register_routes(): void {
		// POST /cache/regen — CAP_MANAGE (§9).
		$this->route(
			'/cache/regen',
			WP_REST_Server::CREATABLE,
			array( $this, 'regen' ),
			Permissions::can_manage(),
			array(
				'post_id' => array(
					'type'              => 'integer',
					'required'          => false,
					'sanitize_callback' => 'absint',
					'description'       => 'Target post id. Omit for a global regen (batched 100/run).',
				),
				'network' => array(
					'type'        => 'boolean',
					'required'    => false,
					'default'     => false,
					'description' => 'Multisite fan-out (S07-gated; degrades to current site on single-site).',
				),
				'op_id'   => array(
					'type'        => 'string',
					'required'    => false,
					'description' => 'Idempotency / audit id (^[A-Za-z0-9_.-]{1,64}$).',
				),
			)
		);

		// DELETE /cache — CAP_MANAGE (§9).
		$this->route(
			'/cache',
			WP_REST_Server::DELETABLE,
			array( $this, 'flush' ),
			Permissions::can_manage(),
			array(
				'network' => array(
					'type'        => 'boolean',
					'required'    => false,
					'default'     => false,
					'description' => 'Multisite fan-out (S07-gated; degrades to current site on single-site).',
				),
				'op_id'   => array(
					'type'        => 'string',
					'required'    => false,
					'description' => 'Idempotency / audit id (^[A-Za-z0-9_.-]{1,64}$).',
				),
			)
		);

		// POST /ids/validate — CAP_READ, pure computation (§10).
		$this->route(
			'/ids/validate',
			WP_REST_Server::CREATABLE,
			array( $this, 'ids_validate' ),
			Permissions::can_read(),
			array(
				'elements'        => array(
					'type'        => 'array',
					'required'    => true,
					'description' => 'Candidate element tree to validate for id uniqueness.',
				),
				'against_post_id' => array(
					'type'              => 'integer',
					'required'          => false,
					'default'           => 0,
					'sanitize_callback' => 'absint',
					'description'       => 'When >0, also collide vs the target document\'s used ids.',
				),
			)
		);

		// POST /ids/remap — CAP_READ, pure computation (§10).
		$this->route(
			'/ids/remap',
			WP_REST_Server::CREATABLE,
			array( $this, 'ids_remap' ),
			Permissions::can_read(),
			array(
				'elements'        => array(
					'type'        => 'array',
					'required'    => true,
					'description' => 'Candidate element tree whose colliding ids should be regenerated.',
				),
				'against_post_id' => array(
					'type'              => 'integer',
					'required'          => false,
					'default'           => 0,
					'sanitize_callback' => 'absint',
					'description'       => 'When >0, also dedupe vs the target document\'s used ids.',
				),
			)
		);
	}

	/**
	 * `POST /cache/regen` handler (10-rest-api.md §9). With `post_id` → V3 per-post regen
	 * ({@see Cache_Service::regen_post}); without → global regen batched 100/run
	 * ({@see Cache_Service::regen_global}). `network:true` is S07-gated inside the service (fan-out on
	 * multisite, degrade-with-warning on single-site). CAP_MANAGE.
	 *
	 * Response `data` (§9): `{ "regenerated":<bool|int>, "scope":"post"|"global"|"network", "post_id"?:int, "warnings"?:string[] }`.
	 * For the per-post case `regenerated` is the boolean the contract example shows
	 * (`{ "regenerated":true,"scope":"post","post_id":42 }`); for the global/network case it is the int
	 * count of posts regenerated (the actionable signal for a batched run).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|\WP_Error
	 */
	public function regen( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( is_wp_error( $op_id ) ) {
			return $op_id;
		}

		$service = new Cache_Service();

		$post_id_param = $request->get_param( 'post_id' );
		$has_post      = ( null !== $post_id_param && '' !== $post_id_param && (int) $post_id_param > 0 );
		$network       = (bool) $request->get_param( 'network' );

		if ( $has_post ) {
			$post_id     = (int) $post_id_param;
			$regenerated = $service->regen_post( $post_id );

			$data = array(
				'regenerated' => $regenerated,
				'scope'       => 'post',
				'post_id'     => $post_id,
			);

			$this->record_cache_op(
				self::OP_ROUTE_REGEN,
				$op_id,
				$post_id,
				$regenerated ? 'ok' : 'noop',
				array(
					'scope'   => 'post',
					'network' => false,
				)
			);

			return $this->ok( $data );
		}

		// Global (optionally network) regen. The service shapes `{regenerated:int, scope?, warnings?}`.
		$result = $service->regen_global( $network );

		$data = array(
			'regenerated' => isset( $result['regenerated'] ) ? (int) $result['regenerated'] : 0,
			'scope'       => isset( $result['scope'] ) ? (string) $result['scope'] : 'global',
		);
		if ( isset( $result['warnings'] ) && ! empty( $result['warnings'] ) ) {
			$data['warnings'] = array_values( (array) $result['warnings'] );
		}

		$this->record_cache_op(
			self::OP_ROUTE_REGEN,
			$op_id,
			null,
			'ok',
			array(
				'scope'       => $data['scope'],
				'network'     => $network,
				'regenerated' => $data['regenerated'],
			)
		);

		return $this->ok( $data );
	}

	/**
	 * `DELETE /cache` handler (10-rest-api.md §9). Full in-process flush via
	 * {@see Cache_Service::flush_all} — `\Elementor\Plugin::$instance->files_manager->clear_cache()` run
	 * as the web-server uid (S07/C6). Per S07/R2 the service ASSERTS `glob(uploads/elementor/css/*)` is
	 * empty after the flush and returns FALSE when stale files remain — this handler surfaces that boolean
	 * verbatim (`{flushed:<bool>}`), NEVER trusting `clear_cache()`'s always-Success string. CAP_MANAGE.
	 *
	 * Response `data` (§9): `{ "flushed":<bool>, "warnings"?:string[] }`. A `flushed:false` means the CSS
	 * dir was NOT confirmed empty (the uid-mismatch silent-failure trap) — surfaced honestly.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|\WP_Error
	 */
	public function flush( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( is_wp_error( $op_id ) ) {
			return $op_id;
		}

		$network = (bool) $request->get_param( 'network' );

		$service = new Cache_Service();
		$flushed = $service->flush_all( $network );

		$data = array( 'flushed' => $flushed );

		// S07/R10: surface the single-site degrade caveat so a network:true caller is never silently
		// partial. On a real multisite the service fans out + caveats per-subsite via its own warning.
		if ( $network && ! is_multisite() ) {
			$data['warnings'] = array( 'network:true requested but the install is single-site; flushed the current site only (S07).' );
		}

		$this->record_cache_op(
			self::OP_ROUTE_FLUSH,
			$op_id,
			null,
			$flushed ? 'ok' : 'stale',
			array( 'network' => $network )
		);

		return $this->ok( $data );
	}

	/**
	 * `POST /ids/validate` handler (10-rest-api.md §10). PURE computation via
	 * {@see Id_Service::validate_tree} — reports intra-tree + against-document element-id collisions (R3)
	 * and duplicate local-style ids (R4) so the client avoids `DUPLICATE_ELEMENT_ID` (12 §3.1) BEFORE a
	 * write. PERSISTS NOTHING (CAP_READ).
	 *
	 * Response `data` (§10): `{ "valid":bool, "collisions":string[], "duplicate_local_styles":string[] }`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response
	 */
	public function ids_validate( WP_REST_Request $request ): WP_REST_Response {
		$elements        = $this->read_elements( $request );
		$against_post_id = (int) $request->get_param( 'against_post_id' );

		$result = Id_Service::validate_tree( $elements, $against_post_id );

		return $this->ok(
			array(
				'valid'                  => (bool) $result['valid'],
				'collisions'             => array_values( $result['collisions'] ),
				'duplicate_local_styles' => array_values( $result['duplicate_local_styles'] ),
			)
		);
	}

	/**
	 * `POST /ids/remap` handler (10-rest-api.md §10, §2.6 step 4). PURE computation via
	 * {@see Id_Service::remap_tree} — regenerates ONLY colliding element ids (mint formula
	 * `substr(strtolower(dechex(wp_rand())),0,7)`, `includes/utils.php:373-375`) and rewrites their
	 * local-style back-references (the `styles` map keys, `styles[].id`, and `settings.classes.value`),
	 * keeping the §5.1 local-style triple consistent (mirror `styles-ids-modifier.php`). PERSISTS NOTHING
	 * (CAP_READ).
	 *
	 * Response `data` (§10): `{ "elements":[...], "remapped":{ "<oldId>":"<newId>" } }`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response
	 */
	public function ids_remap( WP_REST_Request $request ): WP_REST_Response {
		$elements        = $this->read_elements( $request );
		$against_post_id = (int) $request->get_param( 'against_post_id' );

		$result = Id_Service::remap_tree( $elements, $against_post_id );

		return $this->ok(
			array(
				'elements' => array_values( $result['elements'] ),
				'remapped' => (object) $result['remapped'],
			)
		);
	}

	// ---------------------------------------------------------------------
	// Internals.
	// ---------------------------------------------------------------------

	/**
	 * Read the `elements` candidate tree from the request as a plain array (defensive: coerce a non-array
	 * to an empty tree so the pure id services never fatal on a malformed body — `register_rest_route`'s
	 * `type:array` already rejects non-array values with a 400 before we get here).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return array<int,array<string,mixed>>
	 */
	private function read_elements( WP_REST_Request $request ): array {
		$elements = $request->get_param( 'elements' );
		return is_array( $elements ) ? $elements : array();
	}

	/**
	 * Append one op-log row for a cache WRITE (10-rest-api.md §11; WP-P14 store). Guarded + best-effort:
	 * a build without the WP-P14 `Op_Log` store degrades to no-logging and the cache op still succeeds;
	 * an `op_id` is recorded when supplied. The id routes are READS and intentionally log nothing.
	 *
	 * @param string              $route   The op-log `route` value (self::OP_ROUTE_*).
	 * @param string|null         $op_id   The validated request op_id (or null).
	 * @param int|null            $post_id The affected post id (null for global/network).
	 * @param string              $result  The result string (`ok`|`noop`|`stale`).
	 * @param array<string,mixed> $meta    Structured context for the row.
	 * @return void
	 */
	private function record_cache_op( string $route, ?string $op_id, ?int $post_id, string $result, array $meta ): void {
		if ( null === $op_id ) {
			return;
		}
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		try {
			\Elementor\Ultra\Core\Op_Log::record(
				array(
					'op_id'   => $op_id,
					'post_id' => $post_id,
					'route'   => $route,
					'result'  => $result,
					'meta'    => $meta,
				)
			);
		} catch ( \Throwable $e ) {
			unset( $e ); // Op-log is best-effort; it must never fail the cache op.
		}
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (WP-P01 spine parallelism).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar;
 * we hand it a fresh controller instance so it registers the four cache/ids routes WITHOUT any edit to
 * the spine `class-registrar.php` / `class-plugin.php`.
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Cache_Controller() );
		}
	}
);
