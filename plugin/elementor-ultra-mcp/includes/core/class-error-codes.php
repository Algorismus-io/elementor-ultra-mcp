<?php
/**
 * WP-F05 — Frozen error taxonomy: PHP constants mirroring the TS `ErrorCode` enum.
 *
 * Contract authority: spec/contracts/12-error-taxonomy.md §3 (catalog tables) + §6 (frozen code
 * list). These 29 SCREAMING_SNAKE_CASE codes are the stable-forever identifiers every PHP route,
 * permission_callback, and the validator emit. They MUST be byte-identical to the TS
 * `packages/shared/src/errors/codes.ts` `ERROR_CODES` list and the machine-readable
 * `packages/shared/schemas/error-codes.json`; WP-F06/F07 assert cross-language equality.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The frozen error-code catalog (constants) + per-code metadata (http_status, retryable, surface,
 * rpc_code). Values transcribed verbatim from spec/contracts/12-error-taxonomy.md §3.1–§3.5.
 */
final class Error_Codes {

	/** MCP surface values (12-error-taxonomy.md §1). */
	const SURFACE_PROTOCOL = 'protocol';
	const SURFACE_IS_ERROR = 'isError';

	/** JSON-RPC standard error codes used by surface:'protocol' taxonomy codes (§1). */
	const RPC_INVALID_PARAMS   = -32602;
	const RPC_METHOD_NOT_FOUND = -32601;
	const RPC_INTERNAL_ERROR   = -32603;

	/* §3.1 Validation / authoring */
	const VALIDATION_FAILED       = 'VALIDATION_FAILED';
	const SCHEMA_INVALID_PARAMS   = 'SCHEMA_INVALID_PARAMS';
	const ATOMIC_SETTINGS_INVALID = 'ATOMIC_SETTINGS_INVALID';
	const ATOMIC_STYLES_INVALID   = 'ATOMIC_STYLES_INVALID';
	const UNKNOWN_WIDGET_TYPE     = 'UNKNOWN_WIDGET_TYPE';
	const DUPLICATE_ELEMENT_ID    = 'DUPLICATE_ELEMENT_ID';
	const LOCAL_STYLE_UNLINKED    = 'LOCAL_STYLE_UNLINKED';
	const IMAGE_SRC_XOR_VIOLATION = 'IMAGE_SRC_XOR_VIOLATION';
	const HTML_V3_STRIPPED        = 'HTML_V3_STRIPPED';
	const SETTINGS_INVALID        = 'SETTINGS_INVALID';

	/* §3.2 Concurrency / safety */
	const LOCK_HELD              = 'LOCK_HELD';
	const AUTOSAVE_CONFLICT      = 'AUTOSAVE_CONFLICT';
	const CONCURRENCY_STALE_HASH = 'CONCURRENCY_STALE_HASH';
	const IDEMPOTENT_REPLAY      = 'IDEMPOTENT_REPLAY';

	/* §3.3 Design system / budget */
	const BUDGET_EXCEEDED  = 'BUDGET_EXCEEDED';
	const DUPLICATED_LABEL = 'DUPLICATED_LABEL';
	const INVALID_ORDER    = 'INVALID_ORDER';
	const WATERMARK_STALE  = 'WATERMARK_STALE';

	/* §3.4 Capabilities / experiments / auth */
	const CAPABILITY_MISSING  = 'CAPABILITY_MISSING';
	const EXPERIMENT_INACTIVE = 'EXPERIMENT_INACTIVE';
	const AUTH_FAILED         = 'AUTH_FAILED';
	const PRO_REQUIRED        = 'PRO_REQUIRED';
	const WOO_CONTEXT_INVALID = 'WOO_CONTEXT_INVALID';

	/* §3.5 Resource / lifecycle */
	const NOT_FOUND           = 'NOT_FOUND';
	const NOT_EDITABLE        = 'NOT_EDITABLE';
	const CSS_PRIME_FAILED    = 'CSS_PRIME_FAILED';
	const RENDER_FAILED       = 'RENDER_FAILED';
	const IMPORT_REMAP_FAILED = 'IMPORT_REMAP_FAILED';
	const RATE_LIMITED        = 'RATE_LIMITED';
	const UPSTREAM_ERROR      = 'UPSTREAM_ERROR';
	const INTERNAL_ERROR      = 'INTERNAL_ERROR';

	/**
	 * The frozen ordered list of all 31 codes (12-error-taxonomy.md §6). The single source the
	 * cross-language equality test reads on the PHP side.
	 *
	 * @return string[]
	 */
	public static function all(): array {
		return array(
			// §3.1 Validation / authoring.
			self::VALIDATION_FAILED,
			self::SCHEMA_INVALID_PARAMS,
			self::ATOMIC_SETTINGS_INVALID,
			self::ATOMIC_STYLES_INVALID,
			self::UNKNOWN_WIDGET_TYPE,
			self::DUPLICATE_ELEMENT_ID,
			self::LOCAL_STYLE_UNLINKED,
			self::IMAGE_SRC_XOR_VIOLATION,
			self::HTML_V3_STRIPPED,
			self::SETTINGS_INVALID,
			// §3.2 Concurrency / safety.
			self::LOCK_HELD,
			self::AUTOSAVE_CONFLICT,
			self::CONCURRENCY_STALE_HASH,
			self::IDEMPOTENT_REPLAY,
			// §3.3 Design system / budget.
			self::BUDGET_EXCEEDED,
			self::DUPLICATED_LABEL,
			self::INVALID_ORDER,
			self::WATERMARK_STALE,
			// §3.4 Capabilities / experiments / auth.
			self::CAPABILITY_MISSING,
			self::EXPERIMENT_INACTIVE,
			self::AUTH_FAILED,
			self::PRO_REQUIRED,
			self::WOO_CONTEXT_INVALID,
			// §3.5 Resource / lifecycle.
			self::NOT_FOUND,
			self::NOT_EDITABLE,
			self::CSS_PRIME_FAILED,
			self::RENDER_FAILED,
			self::IMPORT_REMAP_FAILED,
			self::RATE_LIMITED,
			self::UPSTREAM_ERROR,
			self::INTERNAL_ERROR,
		);
	}

	/**
	 * Frozen per-code metadata (12-error-taxonomy.md §3 tables, EXACT values). Each entry:
	 * `[ 'http_status' => int, 'retryable' => bool, 'surface' => self::SURFACE_*, 'rpc_code' => ?int,
	 * 'soft' => bool ]`. `rpc_code` is non-null ONLY when surface === protocol.
	 *
	 * @return array<string,array{http_status:int,retryable:bool,surface:string,rpc_code:?int,soft:bool}>
	 */
	public static function meta(): array {
		return array(
			// §3.1 Validation / authoring.
			self::VALIDATION_FAILED       => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::SCHEMA_INVALID_PARAMS   => array(
				'http_status' => 400,
				'retryable'   => false,
				'surface'     => self::SURFACE_PROTOCOL,
				'rpc_code'    => self::RPC_INVALID_PARAMS,
				'soft'        => false,
			),
			self::ATOMIC_SETTINGS_INVALID => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::ATOMIC_STYLES_INVALID   => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::UNKNOWN_WIDGET_TYPE     => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::DUPLICATE_ELEMENT_ID    => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::LOCAL_STYLE_UNLINKED    => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::IMAGE_SRC_XOR_VIOLATION => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::HTML_V3_STRIPPED        => array(
				'http_status' => 200,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => true,
			),
			self::SETTINGS_INVALID        => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),

			// §3.2 Concurrency / safety.
			self::LOCK_HELD               => array(
				'http_status' => 409,
				'retryable'   => true,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::AUTOSAVE_CONFLICT       => array(
				'http_status' => 409,
				'retryable'   => true,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::CONCURRENCY_STALE_HASH  => array(
				'http_status' => 409,
				'retryable'   => true,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::IDEMPOTENT_REPLAY       => array(
				'http_status' => 200,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => true,
			),

			// §3.3 Design system / budget.
			self::BUDGET_EXCEEDED         => array(
				'http_status' => 400,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::DUPLICATED_LABEL        => array(
				'http_status' => 200,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => true,
			),
			self::INVALID_ORDER           => array(
				'http_status' => 400,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::WATERMARK_STALE         => array(
				'http_status' => 409,
				'retryable'   => true,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),

			// §3.4 Capabilities / experiments / auth.
			self::CAPABILITY_MISSING      => array(
				'http_status' => 403,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::EXPERIMENT_INACTIVE     => array(
				'http_status' => 409,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::AUTH_FAILED             => array(
				'http_status' => 401,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::PRO_REQUIRED            => array(
				'http_status' => 409,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::WOO_CONTEXT_INVALID     => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),

			// §3.5 Resource / lifecycle.
			self::NOT_FOUND               => array(
				'http_status' => 404,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::NOT_EDITABLE            => array(
				'http_status' => 403,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::CSS_PRIME_FAILED        => array(
				'http_status' => 500,
				'retryable'   => true,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::RENDER_FAILED           => array(
				'http_status' => 200,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => true,
			),
			self::IMPORT_REMAP_FAILED     => array(
				'http_status' => 422,
				'retryable'   => false,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::RATE_LIMITED            => array(
				'http_status' => 429,
				'retryable'   => true,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::UPSTREAM_ERROR          => array(
				'http_status' => 502,
				'retryable'   => true,
				'surface'     => self::SURFACE_IS_ERROR,
				'rpc_code'    => null,
				'soft'        => false,
			),
			self::INTERNAL_ERROR          => array(
				'http_status' => 500,
				'retryable'   => false,
				'surface'     => self::SURFACE_PROTOCOL,
				'rpc_code'    => self::RPC_INTERNAL_ERROR,
				'soft'        => false,
			),
		);
	}

	/**
	 * True iff `$code` is one of the frozen 31 taxonomy codes.
	 *
	 * @param string $code Candidate code.
	 */
	public static function is_valid( string $code ): bool {
		return in_array( $code, self::all(), true );
	}

	/**
	 * The frozen HTTP status for a code (12-error-taxonomy.md §3). Defaults to 500 for an unknown code.
	 *
	 * @param string $code Taxonomy code.
	 */
	public static function http_status( string $code ): int {
		$meta = self::meta();
		return isset( $meta[ $code ] ) ? (int) $meta[ $code ]['http_status'] : 500;
	}

	/**
	 * Whether a code is retryable (12-error-taxonomy.md §3).
	 *
	 * @param string $code Taxonomy code.
	 */
	public static function is_retryable( string $code ): bool {
		$meta = self::meta();
		return isset( $meta[ $code ] ) ? (bool) $meta[ $code ]['retryable'] : false;
	}

	/**
	 * The default MCP surface for a code (12-error-taxonomy.md §3).
	 *
	 * @param string $code Taxonomy code.
	 */
	public static function surface( string $code ): string {
		$meta = self::meta();
		return isset( $meta[ $code ] ) ? (string) $meta[ $code ]['surface'] : self::SURFACE_IS_ERROR;
	}
}
