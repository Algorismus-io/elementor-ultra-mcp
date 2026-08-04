<?php
/**
 * WP-P09 — `Variables_Service`: the single home of the design VARIABLES + V3 kit globals logic.
 *
 * Contract authority: 10-rest-api.md §4.4 (variables CRUD + batch + watermark + limits), §4.5 (V3 kit
 * colors/fonts), §4.6 (element-defaults), §4.7 (sync-v4-to-v3 bridge var), §4.8 (deploy all-or-nothing),
 * §0.12 (full cache flush); 11-authoring-contract.md §7 (V3 globals binding string formats);
 * 12-error-taxonomy.md §3.3 (BUDGET_EXCEEDED, DUPLICATED_LABEL, WATERMARK_STALE), §3.5 (NOT_FOUND), §4
 * (Elementor slug → taxonomy mapping).
 *
 * This service PROXIES Elementor's own variables service (the watermark-aware optimistic-concurrency
 * store) rather than reimplementing variable storage — it wraps:
 *  - `Elementor\Modules\Variables\Services\Variables_Service` (create/update/delete/restore/process_batch)
 *    instantiated EXACTLY as Elementor does in `modules/variables/hooks.php`
 *    (`new Variables_Service( new Variables_Repository( active_kit ), new Batch_Processor() )`).
 *  - the active kit's `Document::update_settings()` (deep-merge `array_replace_recursive`) for the V3
 *    repeaters `system_colors`/`custom_colors`/`system_typography`/`custom_typography` + element defaults
 *    (the supported path; NEVER raw `_elementor_page_settings` writes on the kit — Detailed Requirements #9).
 *
 * The three variable types are ALL FREE: `global-color-variable`, `global-font-variable`,
 * `global-size-variable` (`modules/variables/prop-types/*-variable-prop-type.php::get_key`). Limits
 * mirror Elementor's REST: id ≤ 64, label ≤ 50, value ≤ 512, ≤ 1000 variables
 * (`modules/variables/classes/rest-api.php:31-33`, `modules/variables/storage/constants.php`).
 *
 * SPIKE-VERIFIED CORRECTIONS:
 *  - [S07/C6/R2] After EVERY variables/globals write the CONTROLLER (not this service) flushes CSS
 *    in-process via {@see \Elementor\Ultra\Core\Cache_Service::flush_design_system()} and asserts the CSS
 *    dir is empty (the flush is reliable only as the web-server uid; the success string is never trusted).
 *  - Elementor's `Variables_Service::process_batch()` does NOT enforce the `watermark` (the rest-api
 *    REQUIRES it but never checks staleness). This service therefore performs the OPTIMISTIC-CONCURRENCY
 *    check itself (`load().watermark != expected` → 409 `WATERMARK_STALE`) BEFORE delegating the batch, so
 *    the §4.4 contract guarantee holds (Detailed Requirements #2).
 *  - Elementor's `Batch_Processor` supports only `create|update|delete|restore`; the contract batch op set
 *    additionally includes `reorder`. We translate a `reorder` op into per-id `update {order}` operations
 *    before delegating, so a contract-shape `reorder` works end-to-end.
 *
 * Reused by WP-P09's own `design/deploy` (which pre-flights this service's `preflight_budget` alongside
 * WP-P08's, then applies classes then variables) — `preflight_budget` + `batch` live here exactly once.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

use Elementor\Ultra\Error_Codes;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Stateless service over Elementor's variables store + the active kit's V3 globals. Returns plain arrays
 * (or a taxonomy {@see WP_Error}) so the controller just envelopes them and runs the cache flush.
 */
final class Variables_Service {

	/** Maximum variables per install (mirrors `Storage\Constants::TOTAL_VARIABLES_COUNT`). */
	const MAX_ITEMS = 1000;

	/** Max id length (mirrors `Classes\Rest_Api::MAX_ID_LENGTH`). */
	const MAX_ID_LENGTH = 64;

	/** Max label length (mirrors `Classes\Rest_Api::MAX_LABEL_LENGTH`). */
	const MAX_LABEL_LENGTH = 50;

	/** Max value length (mirrors `Classes\Rest_Api::MAX_VALUE_LENGTH`). */
	const MAX_VALUE_LENGTH = 512;

	/** The three FREE variable type keys (prop-types/*-variable-prop-type.php::get_key). */
	const TYPE_COLOR = 'global-color-variable';
	const TYPE_FONT  = 'global-font-variable';
	const TYPE_SIZE  = 'global-size-variable';

	/** Elementor variables service FQCN (guarded — module gated behind the `e_variables` experiment). */
	const SERVICE_CLASS    = '\Elementor\Modules\Variables\Services\Variables_Service';
	const REPOSITORY_CLASS = '\Elementor\Modules\Variables\Storage\Variables_Repository';
	const BATCH_PROC_CLASS = '\Elementor\Modules\Variables\Services\Batch_Operations\Batch_Processor';

	/** V3 kit repeater keys (Contract 10 §4.5). */
	const COLOR_REPEATERS = array( 'system_colors', 'custom_colors' );
	const FONT_REPEATERS  = array( 'system_typography', 'custom_typography' );

	// ---------------------------------------------------------------------
	// Variables (Contract 10 §4.4).
	// ---------------------------------------------------------------------

	/**
	 * List variables (Contract 10 §4.4): `{variables,total,watermark}`. `variables` is the Elementor
	 * `data` map keyed by id; `watermark` is the optimistic-concurrency token the caller echoes on a batch.
	 *
	 * @return array{variables:array<string,mixed>,total:int,watermark:int}|WP_Error
	 */
	public function list() {
		$service = $this->service();
		if ( $service instanceof WP_Error ) {
			return $service;
		}

		try {
			$record = $service->load();
		} catch ( \Throwable $e ) {
			return $this->upstream( 'Variables_Service::load', $e );
		}

		$data = isset( $record['data'] ) && is_array( $record['data'] ) ? $record['data'] : array();

		return array(
			'variables' => $data,
			'total'     => count( $data ),
			'watermark' => isset( $record['watermark'] ) ? (int) $record['watermark'] : 0,
		);
	}

	/**
	 * Create a variable (Contract 10 §4.4): `{type,label,value}` → `{variable,watermark}`. Validates the
	 * type against the three FREE keys + id/label/value limits, then delegates to Elementor (which enforces
	 * the 1000 cap + unique-label and mints the id).
	 *
	 * @param array<string,mixed> $data `{type,label,value}`.
	 * @return array{variable:array<string,mixed>,watermark:int}|WP_Error
	 */
	public function create( array $data ) {
		$type  = isset( $data['type'] ) ? (string) $data['type'] : '';
		$label = isset( $data['label'] ) ? (string) $data['label'] : '';
		$value = isset( $data['value'] ) ? (string) $data['value'] : '';

		$pre = $this->validate_type( $type );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}
		$pre = $this->validate_label( $label );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}
		$pre = $this->validate_value( $value );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}

		$service = $this->service();
		if ( $service instanceof WP_Error ) {
			return $service;
		}

		try {
			$result = $service->create(
				array(
					'type'  => $type,
					'label' => $label,
					'value' => $value,
				)
			);
		} catch ( \Throwable $e ) {
			return $this->map_variable_exception( $e );
		}

		return $this->normalize_variable_result( $result );
	}

	/**
	 * Update a variable (Contract 10 §4.4): `{label,value,order?,type?}` (label+value REQUIRED) →
	 * `{variable,watermark}`. A forbidden type transition surfaces as `VALIDATION_FAILED` (Elementor's
	 * `Type_Mismatch`); a missing id → `NOT_FOUND`; a duplicate label → `DUPLICATED_LABEL`.
	 *
	 * @param string              $id   The variable id.
	 * @param array<string,mixed> $data `{label,value,order?,type?}`.
	 * @return array{variable:array<string,mixed>,watermark:int}|WP_Error
	 */
	public function update( string $id, array $data ) {
		$pre = $this->validate_id( $id );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}

		$label = isset( $data['label'] ) ? (string) $data['label'] : '';
		$value = isset( $data['value'] ) ? (string) $data['value'] : '';

		$pre = $this->validate_label( $label );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}
		$pre = $this->validate_value( $value );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}

		$update = array(
			'label' => $label,
			'value' => $value,
		);

		if ( isset( $data['type'] ) && '' !== (string) $data['type'] ) {
			$type_check = $this->validate_type( (string) $data['type'] );
			if ( $type_check instanceof WP_Error ) {
				return $type_check;
			}
			$update['type'] = (string) $data['type'];
		}

		if ( isset( $data['order'] ) && null !== $data['order'] ) {
			$update['order'] = (int) $data['order'];
		}

		$service = $this->service();
		if ( $service instanceof WP_Error ) {
			return $service;
		}

		try {
			$result = $service->update( $id, $update );
		} catch ( \Throwable $e ) {
			return $this->map_variable_exception( $e );
		}

		return $this->normalize_variable_result( $result );
	}

	/**
	 * Soft-delete a variable (Contract 10 §4.4) → `{variable,watermark}` (restorable).
	 *
	 * @param string $id The variable id.
	 * @return array{variable:array<string,mixed>,watermark:int}|WP_Error
	 */
	public function delete( string $id ) {
		$pre = $this->validate_id( $id );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}

		$service = $this->service();
		if ( $service instanceof WP_Error ) {
			return $service;
		}

		try {
			$result = $service->delete( $id );
		} catch ( \Throwable $e ) {
			return $this->map_variable_exception( $e );
		}

		return $this->normalize_variable_result( $result );
	}

	/**
	 * Restore a soft-deleted variable (Contract 10 §4.4): optional `{label?,value?,type?}` overrides →
	 * `{variable,watermark}`.
	 *
	 * @param string              $id        The variable id.
	 * @param array<string,mixed> $overrides Optional `{label?,value?,type?}`.
	 * @return array{variable:array<string,mixed>,watermark:int}|WP_Error
	 */
	public function restore( string $id, array $overrides = array() ) {
		$pre = $this->validate_id( $id );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}

		$clean = array();
		if ( isset( $overrides['label'] ) && '' !== (string) $overrides['label'] ) {
			$pre = $this->validate_label( (string) $overrides['label'] );
			if ( $pre instanceof WP_Error ) {
				return $pre;
			}
			$clean['label'] = (string) $overrides['label'];
		}
		if ( isset( $overrides['value'] ) && '' !== (string) $overrides['value'] ) {
			$pre = $this->validate_value( (string) $overrides['value'] );
			if ( $pre instanceof WP_Error ) {
				return $pre;
			}
			$clean['value'] = (string) $overrides['value'];
		}
		if ( isset( $overrides['type'] ) && '' !== (string) $overrides['type'] ) {
			$pre = $this->validate_type( (string) $overrides['type'] );
			if ( $pre instanceof WP_Error ) {
				return $pre;
			}
			$clean['type'] = (string) $overrides['type'];
		}

		$service = $this->service();
		if ( $service instanceof WP_Error ) {
			return $service;
		}

		try {
			$result = $service->restore( $id, $clean );
		} catch ( \Throwable $e ) {
			return $this->map_variable_exception( $e );
		}

		return $this->normalize_variable_result( $result );
	}

	/**
	 * Atomic multi-op batch (Contract 10 §4.4). REQUIRES `$watermark`; a stale watermark fails the WHOLE
	 * batch → 409 `WATERMARK_STALE` with `meta.{expected_watermark,actual_watermark}` (the optimistic-
	 * concurrency check Elementor's own service omits). On a per-id operation failure returns the §4.4
	 * batch-error envelope as a `WP_Error` whose `data` carries `{<id>:{status,message}}` + the taxonomy
	 * `code`. On success returns `{variables,watermark,total}`.
	 *
	 * @param int                            $watermark  The expected watermark (optimistic-concurrency token).
	 * @param array<int,array<string,mixed>> $operations Contract-shape ops (`{type,payload?,id?,order?}`).
	 * @return array{variables:array<string,mixed>,watermark:int,total:int}|WP_Error
	 */
	public function batch( int $watermark, array $operations ) {
		$service = $this->service();
		if ( $service instanceof WP_Error ) {
			return $service;
		}

		// (a) Optimistic-concurrency: the live watermark MUST equal the caller's expected watermark, else
		// the whole batch fails (Contract 10 §4.4; 12 §3.3 WATERMARK_STALE). Elementor's service does not
		// enforce this, so we do it here BEFORE delegating.
		$current = $this->list();
		if ( $current instanceof WP_Error ) {
			return $current;
		}
		$actual = (int) $current['watermark'];
		if ( $actual !== $watermark ) {
			return $this->error(
				Error_Codes::WATERMARK_STALE,
				__( 'The variables watermark is stale: another change occurred since you read it. Re-read design/variables for the current watermark and retry the batch.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::WATERMARK_STALE ),
				array(
					'expected_watermark' => $watermark,
					'actual_watermark'   => $actual,
				)
			);
		}

		// (b) Translate the contract op shape to Elementor's expected shape (and expand `reorder`).
		$translated = $this->translate_batch_operations( $operations );
		if ( $translated instanceof WP_Error ) {
			return $translated;
		}

		// (c) Delegate the atomic batch. A per-id failure throws BatchOperationFailed (caught → §4.4 shape).
		try {
			$service->process_batch( $translated );
		} catch ( \Throwable $e ) {
			return $this->map_batch_exception( $e );
		}

		// (d) Re-read for the canonical post-batch `{variables,watermark,total}`.
		$after = $this->list();
		if ( $after instanceof WP_Error ) {
			return $after;
		}

		return array(
			'variables' => $after['variables'],
			'watermark' => (int) $after['watermark'],
			'total'     => (int) $after['total'],
		);
	}

	/**
	 * Variables budget pre-flight (Contract 10 §4.2/§4.4; 12 §3.3 BUDGET_EXCEEDED). Computes the net
	 * variable count a batch would result in and rejects when it would exceed `MAX_ITEMS`, applying
	 * NOTHING. Public so `design/deploy` can pre-flight BOTH budgets before applying either (all-or-
	 * nothing). Counts only non-deleted (live) variables, mirroring Elementor's limit assertion.
	 *
	 * @param array<int,array<string,mixed>> $operations Contract-shape batch ops.
	 * @return true|WP_Error
	 */
	public function preflight_budget( array $operations ) {
		$current = $this->list();
		if ( $current instanceof WP_Error ) {
			return $current;
		}

		$existing = $this->count_live( $current['variables'] );

		$creates  = 0;
		$restores = 0;
		foreach ( $operations as $op ) {
			$type = isset( $op['type'] ) ? (string) $op['type'] : '';
			if ( 'create' === $type ) {
				++$creates;
			} elseif ( 'restore' === $type ) {
				++$restores;
			}
		}

		// A restore re-counts a previously-deleted var against the limit; treat both as additive (Elementor
		// asserts the limit on every create + restore individually, so the worst-case net is existing + both).
		$projected = $existing + $creates + $restores;

		if ( $projected > self::MAX_ITEMS ) {
			return $this->error(
				Error_Codes::BUDGET_EXCEEDED,
				sprintf(
					/* translators: 1: projected count, 2: maximum allowed. */
					__( 'Variables limit exceeded: this change would result in %1$d variables (maximum %2$d). Delete some variables first.', 'elementor-ultra-mcp' ),
					$projected,
					self::MAX_ITEMS
				),
				Error_Codes::http_status( Error_Codes::BUDGET_EXCEEDED ),
				array(
					'current_count' => $projected,
					'max_allowed'   => self::MAX_ITEMS,
					'kind'          => 'variables',
				)
			);
		}

		return true;
	}

	// ---------------------------------------------------------------------
	// V3 global colors / fonts / element-defaults (Contract 10 §4.5 / §4.6).
	// ---------------------------------------------------------------------

	/**
	 * GET the active kit's V3 color repeaters (Contract 10 §4.5): `{system_colors,custom_colors}`.
	 *
	 * @return array{system_colors:array<int,mixed>,custom_colors:array<int,mixed>}|WP_Error
	 */
	public function get_global_colors() {
		$settings = $this->kit_settings();
		if ( $settings instanceof WP_Error ) {
			return $settings;
		}

		return array(
			'system_colors' => $this->repeater( $settings, 'system_colors' ),
			'custom_colors' => $this->repeater( $settings, 'custom_colors' ),
		);
	}

	/**
	 * PUT V3 colors (Contract 10 §4.5). Deep-merges each repeater item by `_id` (overwrite-or-append) so a
	 * partial update never wipes unrelated colors, then persists via the kit's `Document::update_settings()`
	 * (the supported path — Detailed Requirements #9). Returns the merged repeaters.
	 *
	 * @param array<string,mixed> $patch `{system_colors?:[],custom_colors?:[]}`.
	 * @return array{system_colors:array<int,mixed>,custom_colors:array<int,mixed>}|WP_Error
	 */
	public function put_global_colors( array $patch ) {
		return $this->put_repeaters( $patch, self::COLOR_REPEATERS, 'get_global_colors' );
	}

	/**
	 * GET the active kit's V3 typography repeaters (Contract 10 §4.5):
	 * `{system_typography,custom_typography}`.
	 *
	 * @return array{system_typography:array<int,mixed>,custom_typography:array<int,mixed>}|WP_Error
	 */
	public function get_global_fonts() {
		$settings = $this->kit_settings();
		if ( $settings instanceof WP_Error ) {
			return $settings;
		}

		return array(
			'system_typography' => $this->repeater( $settings, 'system_typography' ),
			'custom_typography' => $this->repeater( $settings, 'custom_typography' ),
		);
	}

	/**
	 * PUT V3 typography (Contract 10 §4.5). Deep-merges each repeater item by `_id` and persists via the
	 * kit's `Document::update_settings()`. Returns the merged repeaters.
	 *
	 * @param array<string,mixed> $patch `{system_typography?:[],custom_typography?:[]}`.
	 * @return array{system_typography:array<int,mixed>,custom_typography:array<int,mixed>}|WP_Error
	 */
	public function put_global_fonts( array $patch ) {
		return $this->put_repeaters( $patch, self::FONT_REPEATERS, 'get_global_fonts' );
	}

	/**
	 * GET per-widget kit element defaults (Contract 10 §4.6): `{defaults:{<type>:{...}}}`. Reads the kit's
	 * `default_<type>` settings buckets (the per-widget default panel store).
	 *
	 * @return array{defaults:array<string,mixed>}|WP_Error
	 */
	public function get_element_defaults() {
		$settings = $this->kit_settings();
		if ( $settings instanceof WP_Error ) {
			return $settings;
		}

		$defaults = array();
		foreach ( $settings as $key => $value ) {
			if ( is_string( $key ) && 0 === strpos( $key, 'default_' ) ) {
				$defaults[ substr( $key, strlen( 'default_' ) ) ] = $value;
			}
		}

		return array( 'defaults' => $defaults );
	}

	/**
	 * PUT per-widget kit element defaults (Contract 10 §4.6): `{type,settings}` → `{defaults:{<type>:{...}}}`.
	 * Writes `settings` into the kit's `default_<type>` bucket via `Document::update_settings()` and returns
	 * the full per-widget defaults map.
	 *
	 * @param string              $type     The widget type (e.g. `heading`).
	 * @param array<string,mixed> $settings The default settings to store.
	 * @return array{defaults:array<string,mixed>}|WP_Error
	 */
	public function put_element_defaults( string $type, array $settings ) {
		$type = trim( $type );
		if ( '' === $type ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'type is required and must be a non-empty widget type.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'type' )
			);
		}

		$kit = $this->active_kit();
		if ( $kit instanceof WP_Error ) {
			return $kit;
		}

		$write = $this->update_kit_settings( $kit, array( 'default_' . $type => $settings ) );
		if ( $write instanceof WP_Error ) {
			return $write;
		}

		return $this->get_element_defaults();
	}

	// ---------------------------------------------------------------------
	// sync-v4-to-v3 (Contract 10 §4.7).
	// ---------------------------------------------------------------------

	/**
	 * Flag a V4 variable `sync_to_v3` and compute its V3 bridge custom-property name (Contract 10 §4.7).
	 * The bridge var follows `--e-global-color-v4-<Label>`. The flag is persisted on the variable via the
	 * Elementor variables service (`apply_changes` accepts `sync_to_v3`); the full design-system + kit
	 * flush the controller runs afterward regenerates the bridge stylesheet.
	 *
	 * @param string $variable_id The V4 variable id.
	 * @return array{success:bool,bridge_var:string}|WP_Error
	 */
	public function sync_v4_to_v3( string $variable_id ) {
		$pre = $this->validate_id( $variable_id );
		if ( $pre instanceof WP_Error ) {
			return $pre;
		}

		$list = $this->list();
		if ( $list instanceof WP_Error ) {
			return $list;
		}

		if ( ! isset( $list['variables'][ $variable_id ] ) || ! is_array( $list['variables'][ $variable_id ] ) ) {
			return $this->error(
				Error_Codes::NOT_FOUND,
				sprintf(
					/* translators: %s: the variable id. */
					__( 'Variable %s not found; cannot sync to V3.', 'elementor-ultra-mcp' ),
					$variable_id
				),
				Error_Codes::http_status( Error_Codes::NOT_FOUND ),
				array(
					'resource' => 'variable',
					'id'       => $variable_id,
				)
			);
		}

		$variable = $list['variables'][ $variable_id ];
		$label    = isset( $variable['label'] ) ? (string) $variable['label'] : '';
		$value    = isset( $variable['value'] ) ? (string) $variable['value'] : '';

		// Persist the sync_to_v3 flag through the Elementor service (update accepts label+value+sync_to_v3
		// via Variable::apply_changes). label+value are REQUIRED by update; carry the existing ones through.
		$service = $this->service();
		if ( $service instanceof WP_Error ) {
			return $service;
		}

		try {
			$service->update(
				$variable_id,
				array(
					'label'      => $label,
					'value'      => $value,
					'sync_to_v3' => true,
				)
			);
		} catch ( \Throwable $e ) {
			return $this->map_variable_exception( $e );
		}

		return array(
			'success'    => true,
			'bridge_var' => $this->bridge_var_name( $label ),
		);
	}

	// ---------------------------------------------------------------------
	// Internals — variables.
	// ---------------------------------------------------------------------

	/**
	 * Resolve a fresh Elementor `Variables_Service` bound to the active kit, instantiated EXACTLY as
	 * Elementor's own `hooks.php` does. Returns a taxonomy error when the variables module is unavailable
	 * (the `e_variables` experiment off / Elementor missing).
	 *
	 * @return object|WP_Error
	 */
	private function service() {
		if ( ! class_exists( self::SERVICE_CLASS ) || ! class_exists( self::REPOSITORY_CLASS ) || ! class_exists( self::BATCH_PROC_CLASS ) ) {
			return $this->error(
				Error_Codes::EXPERIMENT_INACTIVE,
				__( 'Elementor variables are unavailable (the e_variables experiment is off or the module is not loaded). Enable it under Elementor > Settings > Features.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::EXPERIMENT_INACTIVE ),
				array(
					'experiment'   => 'e_variables',
					'required_for' => 'design/variables',
				)
			);
		}

		$kit = $this->active_kit();
		if ( $kit instanceof WP_Error ) {
			return $kit;
		}

		$repository_class = self::REPOSITORY_CLASS;
		$batch_class      = self::BATCH_PROC_CLASS;
		$service_class    = self::SERVICE_CLASS;

		try {
			return new $service_class( new $repository_class( $kit ), new $batch_class() );
		} catch ( \Throwable $e ) {
			return $this->upstream( 'Variables_Service::__construct', $e );
		}
	}

	/**
	 * Normalize an Elementor variables-service result (`{variable,watermark}`) to our shape, coercing the
	 * watermark to int and the variable to an array.
	 *
	 * @param mixed $result The upstream result.
	 * @return array{variable:array<string,mixed>,watermark:int}
	 */
	private function normalize_variable_result( $result ): array {
		$result   = is_array( $result ) ? $result : array();
		$variable = isset( $result['variable'] ) && is_array( $result['variable'] ) ? $result['variable'] : array();

		return array(
			'variable'  => $variable,
			'watermark' => isset( $result['watermark'] ) ? (int) $result['watermark'] : 0,
		);
	}

	/**
	 * Translate contract-shape batch ops (`{type,payload?,id?,order?}`) into Elementor's expected shape
	 * (`{type,variable?,id?,label?,value?}`), expanding a `reorder` op into per-id `update {order}` ops
	 * (Elementor's Batch_Processor has no `reorder`). Validates per-op required fields AND runs the SAME
	 * `validate_type`/`validate_label`/`validate_value` rules as the single-variable routes on every
	 * create/update/restore payload (see `validate_batch_payload()` — without it an invalid label/value
	 * persists through batch and becomes un-fixable). Returns the translated op list (Elementor-shape) or
	 * a 400 `SCHEMA_INVALID_PARAMS` on a malformed op.
	 *
	 * @param array<int,array<string,mixed>> $operations Contract-shape ops.
	 * @return array<int,array<string,mixed>>|WP_Error
	 */
	private function translate_batch_operations( array $operations ) {
		$out = array();

		foreach ( $operations as $index => $op ) {
			if ( ! is_array( $op ) || ! isset( $op['type'] ) ) {
				return $this->batch_op_error( $index, __( 'each operation must be an object with a type.', 'elementor-ultra-mcp' ) );
			}

			$type    = (string) $op['type'];
			$payload = isset( $op['payload'] ) && is_array( $op['payload'] ) ? $op['payload'] : array();
			$id      = isset( $op['id'] ) ? (string) $op['id'] : '';

			switch ( $type ) {
				case 'create':
					if ( empty( $payload ) ) {
						return $this->batch_op_error( $index, __( 'a create operation requires a payload {type,label,value}.', 'elementor-ultra-mcp' ) );
					}
					$pre = $this->validate_batch_payload( $index, $payload, true );
					if ( $pre instanceof WP_Error ) {
						return $pre;
					}
					$out[] = array(
						'type'     => 'create',
						'variable' => $this->variable_payload( $payload ),
					);
					break;

				case 'update':
					if ( '' === $id ) {
						return $this->batch_op_error( $index, __( 'an update operation requires an id.', 'elementor-ultra-mcp' ) );
					}
					$pre = $this->validate_batch_payload( $index, $payload, false );
					if ( $pre instanceof WP_Error ) {
						return $pre;
					}
					$out[] = array(
						'type'     => 'update',
						'id'       => $id,
						'variable' => $this->variable_payload( $payload ),
					);
					break;

				case 'delete':
					if ( '' === $id ) {
						return $this->batch_op_error( $index, __( 'a delete operation requires an id.', 'elementor-ultra-mcp' ) );
					}
					$out[] = array(
						'type' => 'delete',
						'id'   => $id,
					);
					break;

				case 'restore':
					if ( '' === $id ) {
						return $this->batch_op_error( $index, __( 'a restore operation requires an id.', 'elementor-ultra-mcp' ) );
					}
					$pre = $this->validate_batch_payload( $index, $payload, false );
					if ( $pre instanceof WP_Error ) {
						return $pre;
					}
					$restore_op = array(
						'type' => 'restore',
						'id'   => $id,
					);
					if ( isset( $payload['label'] ) ) {
						$restore_op['label'] = (string) $payload['label'];
					}
					if ( isset( $payload['value'] ) ) {
						$restore_op['value'] = (string) $payload['value'];
					}
					$out[] = $restore_op;
					break;

				case 'reorder':
					$order = isset( $op['order'] ) && is_array( $op['order'] ) ? $op['order'] : array();
					if ( empty( $order ) ) {
						return $this->batch_op_error( $index, __( 'a reorder operation requires a non-empty order array of ids.', 'elementor-ultra-mcp' ) );
					}
					// Elementor's Batch_Processor has no reorder op; express ordering as per-id update {order}.
					$position = 0;
					foreach ( $order as $ordered_id ) {
						$out[] = array(
							'type'     => 'update',
							'id'       => (string) $ordered_id,
							'variable' => array( 'order' => $position ),
						);
						++$position;
					}
					break;

				default:
					return $this->batch_op_error( $index, __( 'operation type must be one of create|update|delete|restore|reorder.', 'elementor-ultra-mcp' ) );
			}
		}

		return $out;
	}

	/**
	 * Pre-validate a batch op's payload fields with the SAME `validate_type`/`validate_label`/
	 * `validate_value` rules as the single-variable routes (create/update/restore). REQUIRED because
	 * Elementor's `Batch_Processor` validates only the PRE-change record (`Variable::apply_changes()`
	 * runs `validate()` BEFORE merging the incoming fields), so an invalid label/value (e.g. a label
	 * containing spaces) submitted through batch would PERSIST — and then be un-fixable: the corrective
	 * rename fails the pre-change validation upstream, leaving delete as the only recovery. This is the
	 * PHP-authoritative gate; the TS pre-checks in `tools/design.ts` are a non-authoritative subset.
	 *
	 * @param int|string          $index       The op index (threaded into the error path).
	 * @param array<string,mixed> $payload     The contract op payload (`{type?,label?,value?,order?}`).
	 * @param bool                $require_all Whether `type`+`label`+`value` are ALL required (create).
	 * @return true|WP_Error
	 */
	private function validate_batch_payload( $index, array $payload, bool $require_all ) {
		if ( $require_all || isset( $payload['type'] ) ) {
			$pre = $this->validate_type( isset( $payload['type'] ) ? (string) $payload['type'] : '' );
			if ( $pre instanceof WP_Error ) {
				return $this->batch_op_error( $index, $pre->get_error_message() );
			}
		}
		if ( $require_all || isset( $payload['label'] ) ) {
			$pre = $this->validate_label( isset( $payload['label'] ) ? (string) $payload['label'] : '' );
			if ( $pre instanceof WP_Error ) {
				return $this->batch_op_error( $index, $pre->get_error_message() );
			}
		}
		if ( $require_all || isset( $payload['value'] ) ) {
			$pre = $this->validate_value( isset( $payload['value'] ) ? (string) $payload['value'] : '' );
			if ( $pre instanceof WP_Error ) {
				return $this->batch_op_error( $index, $pre->get_error_message() );
			}
		}
		return true;
	}

	/**
	 * Extract the Elementor variable payload (`{type?,label?,value?,order?}`) from a contract op payload.
	 *
	 * @param array<string,mixed> $payload The contract op payload.
	 * @return array<string,mixed>
	 */
	private function variable_payload( array $payload ): array {
		$out = array();
		foreach ( array( 'type', 'label', 'value' ) as $field ) {
			if ( isset( $payload[ $field ] ) ) {
				$out[ $field ] = (string) $payload[ $field ];
			}
		}
		if ( isset( $payload['order'] ) && null !== $payload['order'] ) {
			$out['order'] = (int) $payload['order'];
		}
		return $out;
	}

	/**
	 * Count live (non-soft-deleted) variables in a `{id:variable}` map.
	 *
	 * @param array<string,mixed> $variables The id-keyed variables map.
	 */
	private function count_live( array $variables ): int {
		$count = 0;
		foreach ( $variables as $variable ) {
			if ( ! is_array( $variable ) ) {
				continue;
			}
			$deleted = ( isset( $variable['deleted'] ) && $variable['deleted'] )
				|| ( isset( $variable['deleted_at'] ) && ! empty( $variable['deleted_at'] ) );
			if ( ! $deleted ) {
				++$count;
			}
		}
		return $count;
	}

	// ---------------------------------------------------------------------
	// Internals — V3 kit globals.
	// ---------------------------------------------------------------------

	/**
	 * Deep-merge repeater items by `_id` and persist via the kit's `Document::update_settings()`. Shared by
	 * colors + fonts. Only the repeater keys in `$allowed` are merged (others in the patch are ignored).
	 *
	 * @param array<string,mixed> $patch       The PUT body.
	 * @param string[]            $allowed     The repeater keys this write may touch.
	 * @param string              $read_method The getter to call for the post-write echo.
	 * @return array<string,mixed>|WP_Error
	 */
	private function put_repeaters( array $patch, array $allowed, string $read_method ) {
		$current = $this->kit_settings();
		if ( $current instanceof WP_Error ) {
			return $current;
		}

		$kit = $this->active_kit();
		if ( $kit instanceof WP_Error ) {
			return $kit;
		}

		$write_patch = array();
		foreach ( $allowed as $repeater_key ) {
			if ( ! array_key_exists( $repeater_key, $patch ) ) {
				continue;
			}
			$incoming = is_array( $patch[ $repeater_key ] ) ? $patch[ $repeater_key ] : array();
			$existing = $this->repeater( $current, $repeater_key );
			// Pass the FULLY merged repeater so update_settings()'s array_replace_recursive replaces the
			// whole list with the merged result (no per-index clobber of unrelated entries).
			$write_patch[ $repeater_key ] = $this->merge_repeater_by_id( $existing, $incoming );
		}

		if ( empty( $write_patch ) ) {
			// Nothing to write — echo the current state (no-op PUT).
			return $this->{$read_method}();
		}

		$write = $this->update_kit_settings( $kit, $write_patch );
		if ( $write instanceof WP_Error ) {
			return $write;
		}

		return $this->{$read_method}();
	}

	/**
	 * Merge incoming repeater items into existing ones BY `_id` (overwrite-or-append). An incoming item
	 * with an `_id` matching an existing item replaces that item (shallow per-item replace); an incoming
	 * item with a new/absent `_id` is appended. Never replaces the whole repeater (Detailed Requirements #3).
	 *
	 * @param array<int,mixed> $existing The current repeater items.
	 * @param array<int,mixed> $incoming The PUT repeater items.
	 * @return array<int,array<string,mixed>>
	 */
	private function merge_repeater_by_id( array $existing, array $incoming ): array {
		$by_id      = array();
		$order      = array();
		$no_id_rows = array();

		foreach ( $existing as $item ) {
			if ( ! is_array( $item ) ) {
				continue;
			}
			$id = isset( $item['_id'] ) ? (string) $item['_id'] : '';
			if ( '' === $id ) {
				$no_id_rows[] = $item;
				continue;
			}
			if ( ! isset( $by_id[ $id ] ) ) {
				$order[] = $id;
			}
			$by_id[ $id ] = $item;
		}

		foreach ( $incoming as $item ) {
			if ( ! is_array( $item ) ) {
				continue;
			}
			$id = isset( $item['_id'] ) ? (string) $item['_id'] : '';
			if ( '' === $id ) {
				// No _id — cannot match; append as a new row (defensive; clients SHOULD supply _id).
				$no_id_rows[] = $item;
				continue;
			}
			if ( ! isset( $by_id[ $id ] ) ) {
				$order[]      = $id;
				$by_id[ $id ] = $item;
			} else {
				// Overwrite the matched item's keys, preserving any keys the patch omits.
				$by_id[ $id ] = array_merge( $by_id[ $id ], $item );
			}
		}

		$merged = array();
		foreach ( $order as $id ) {
			$merged[] = $by_id[ $id ];
		}
		foreach ( $no_id_rows as $row ) {
			$merged[] = $row;
		}

		return $merged;
	}

	/**
	 * Persist a settings patch onto the active kit via `Document::update_settings()` (the supported deep-
	 * merge path; `array_replace_recursive`). Returns true or an upstream error.
	 *
	 * @param object              $kit   The active kit document.
	 * @param array<string,mixed> $patch The settings patch.
	 * @return true|WP_Error
	 */
	private function update_kit_settings( $kit, array $patch ) {
		if ( ! method_exists( $kit, 'update_settings' ) ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'The active kit does not support update_settings(); cannot write kit globals.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::UPSTREAM_ERROR )
			);
		}

		try {
			$kit->update_settings( $patch );
		} catch ( \Throwable $e ) {
			return $this->upstream( 'Kit::update_settings', $e );
		}

		return true;
	}

	/**
	 * Read the active kit's full settings (`_elementor_page_settings`), or a taxonomy error when the kit is
	 * unavailable.
	 *
	 * @return array<string,mixed>|WP_Error
	 */
	private function kit_settings() {
		$kit = $this->active_kit();
		if ( $kit instanceof WP_Error ) {
			return $kit;
		}

		$kit_id   = method_exists( $kit, 'get_main_id' ) ? (int) $kit->get_main_id() : 0;
		$settings = $kit_id > 0 ? get_post_meta( $kit_id, '_elementor_page_settings', true ) : array();

		return is_array( $settings ) ? $settings : array();
	}

	/**
	 * Extract a repeater list (`$key`) from a settings array as a clean numeric list.
	 *
	 * @param array<string,mixed> $settings The settings array.
	 * @param string              $key      The repeater key.
	 */
	private function repeater( array $settings, string $key ): array {
		if ( ! isset( $settings[ $key ] ) || ! is_array( $settings[ $key ] ) ) {
			return array();
		}
		return array_values( $settings[ $key ] );
	}

	/**
	 * The active Elementor kit document, or a taxonomy error when the kits manager / kit is unavailable.
	 *
	 * @return object|WP_Error
	 */
	private function active_kit() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'Elementor is not available.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::UPSTREAM_ERROR )
			);
		}

		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->kits_manager ) ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'The Elementor kits manager is unavailable.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::UPSTREAM_ERROR )
			);
		}

		$manager = $plugin->kits_manager;
		if ( ! method_exists( $manager, 'get_active_kit' ) ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'The Elementor kits manager cannot resolve the active kit.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::UPSTREAM_ERROR )
			);
		}

		$kit = $manager->get_active_kit();
		if ( null === $kit || ! is_object( $kit ) ) {
			return $this->error(
				Error_Codes::UPSTREAM_ERROR,
				__( 'No active Elementor kit; kit globals cannot be read or written.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::UPSTREAM_ERROR )
			);
		}

		return $kit;
	}

	// ---------------------------------------------------------------------
	// Internals — validation + bridge var.
	// ---------------------------------------------------------------------

	/**
	 * Validate a variable type is one of the three FREE keys.
	 *
	 * @param string $type The candidate type.
	 * @return true|WP_Error
	 */
	private function validate_type( string $type ) {
		$allowed = array( self::TYPE_COLOR, self::TYPE_FONT, self::TYPE_SIZE );
		if ( ! in_array( $type, $allowed, true ) ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				sprintf(
					/* translators: 1: the offending type, 2: the allowed types. */
					__( 'Invalid variable type "%1$s": must be one of %2$s.', 'elementor-ultra-mcp' ),
					$type,
					implode( ', ', $allowed )
				),
				400,
				array(
					'path'    => 'type',
					'allowed' => $allowed,
				)
			);
		}
		return true;
	}

	/**
	 * Validate a variable id is non-empty and ≤ MAX_ID_LENGTH.
	 *
	 * @param string $id The candidate id.
	 * @return true|WP_Error
	 */
	private function validate_id( string $id ) {
		$id = trim( $id );
		if ( '' === $id ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'A variable id is required.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'id' )
			);
		}
		if ( strlen( $id ) > self::MAX_ID_LENGTH ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				sprintf(
					/* translators: %d: max id length. */
					__( 'Variable id cannot exceed %d characters.', 'elementor-ultra-mcp' ),
					self::MAX_ID_LENGTH
				),
				400,
				array(
					'path'       => 'id',
					'max_length' => self::MAX_ID_LENGTH,
				)
			);
		}
		return true;
	}

	/**
	 * Validate a variable label: non-empty, ≤ MAX_LABEL_LENGTH, no whitespace (Elementor `validate()`).
	 *
	 * @param string $label The candidate label.
	 * @return true|WP_Error
	 */
	private function validate_label( string $label ) {
		$label = trim( $label );
		if ( '' === $label ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'A variable label is required.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'label' )
			);
		}
		if ( strlen( $label ) > self::MAX_LABEL_LENGTH ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				sprintf(
					/* translators: %d: max label length. */
					__( 'Variable label cannot exceed %d characters.', 'elementor-ultra-mcp' ),
					self::MAX_LABEL_LENGTH
				),
				400,
				array(
					'path'       => 'label',
					'max_length' => self::MAX_LABEL_LENGTH,
				)
			);
		}
		if ( preg_match( '/\s/', $label ) ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'Variable label must not contain spaces or whitespace.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'label' )
			);
		}
		return true;
	}

	/**
	 * Validate a variable value: non-empty, ≤ MAX_VALUE_LENGTH.
	 *
	 * @param string $value The candidate value.
	 * @return true|WP_Error
	 */
	private function validate_value( string $value ) {
		$value = trim( $value );
		if ( '' === $value ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'A variable value is required.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'value' )
			);
		}
		if ( strlen( $value ) > self::MAX_VALUE_LENGTH ) {
			return $this->error(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				sprintf(
					/* translators: %d: max value length. */
					__( 'Variable value cannot exceed %d characters.', 'elementor-ultra-mcp' ),
					self::MAX_VALUE_LENGTH
				),
				400,
				array(
					'path'       => 'value',
					'max_length' => self::MAX_VALUE_LENGTH,
				)
			);
		}
		return true;
	}

	/**
	 * Compute the V3 bridge custom-property name for a synced V4 color variable (Contract 10 §4.7):
	 * `--e-global-color-v4-<Label>`. The label is sanitized to a CSS-ident-safe slug.
	 *
	 * @param string $label The variable label.
	 */
	private function bridge_var_name( string $label ): string {
		// Keep the label readable but CSS-ident-safe (spaces should not occur — labels reject whitespace).
		$slug = preg_replace( '/[^A-Za-z0-9_-]+/', '-', $label );
		$slug = is_string( $slug ) ? trim( $slug, '-' ) : '';
		return '--e-global-color-v4-' . $slug;
	}

	// ---------------------------------------------------------------------
	// Internals — error mapping.
	// ---------------------------------------------------------------------

	/**
	 * Map a single-variable Elementor exception to a taxonomy `WP_Error` (12 §4). Translates the variables
	 * exceptions to the frozen codes: VariablesLimitReached → BUDGET_EXCEEDED, DuplicatedLabel →
	 * DUPLICATED_LABEL, RecordNotFound → NOT_FOUND, Type_Mismatch → VALIDATION_FAILED, InvalidVariable →
	 * VALIDATION_FAILED, else UPSTREAM_ERROR. NEVER string-matches the message for classification.
	 *
	 * @param \Throwable $e The caught exception.
	 */
	private function map_variable_exception( \Throwable $e ): WP_Error {
		$class = get_class( $e );

		if ( $this->is_a( $class, 'VariablesLimitReached' ) ) {
			return $this->error(
				Error_Codes::BUDGET_EXCEEDED,
				__( 'Variables limit reached (maximum 1000). Delete some variables first.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::BUDGET_EXCEEDED ),
				array(
					'max_allowed' => self::MAX_ITEMS,
					'kind'        => 'variables',
				)
			);
		}

		if ( $this->is_a( $class, 'DuplicatedLabel' ) ) {
			// Contract 10 §4.4: a variable duplicate-label is a HARD 422 reject (no auto-rename) — unlike the
			// soft 200 DUPLICATED_LABEL of the global-class diff-PUT. Override the taxonomy default status.
			return $this->error(
				Error_Codes::DUPLICATED_LABEL,
				__( 'A variable with that label already exists. Choose a unique label.', 'elementor-ultra-mcp' ),
				422,
				array( 'kind' => 'variables' )
			);
		}

		if ( $this->is_a( $class, 'RecordNotFound' ) ) {
			return $this->error(
				Error_Codes::NOT_FOUND,
				__( 'Variable not found.', 'elementor-ultra-mcp' ),
				Error_Codes::http_status( Error_Codes::NOT_FOUND ),
				array( 'resource' => 'variable' )
			);
		}

		if ( $this->is_a( $class, 'Type_Mismatch' ) || $this->is_a( $class, 'InvalidVariable' ) ) {
			return $this->error(
				Error_Codes::VALIDATION_FAILED,
				$e->getMessage(),
				Error_Codes::http_status( Error_Codes::VALIDATION_FAILED ),
				array( 'kind' => 'variables' )
			);
		}

		return $this->upstream( 'Variables_Service', $e );
	}

	/**
	 * Map a caught batch exception to a taxonomy `WP_Error`. A `BatchOperationFailed` carries per-id error
	 * details; we surface them in the §4.4 batch-error shape (the `data` block keys are the operation ids,
	 * each `{status,code,message}`), choosing the taxonomy `code` from the dominant per-id error code. Any
	 * other exception falls back to the single-variable mapper.
	 *
	 * @param \Throwable $e The caught exception.
	 */
	private function map_batch_exception( \Throwable $e ): WP_Error {
		if ( ! $this->is_a( get_class( $e ), 'BatchOperationFailed' ) || ! method_exists( $e, 'getErrorDetails' ) ) {
			return $this->map_variable_exception( $e );
		}

		$details = $e->getErrorDetails();
		$details = is_array( $details ) ? $details : array();

		// Re-key per-id details to the §4.4 shape `{<id>:{status,message,code?}}` + pick a taxonomy code.
		$by_id          = array();
		$dominant_code  = Error_Codes::VALIDATION_FAILED;
		$dominant_found = false;

		foreach ( $details as $op_id => $detail ) {
			$detail  = is_array( $detail ) ? $detail : array();
			$slug    = isset( $detail['code'] ) ? (string) $detail['code'] : '';
			$code    = $this->batch_slug_to_code( $slug );
			$status  = isset( $detail['status'] ) ? (int) $detail['status'] : Error_Codes::http_status( $code );
			$message = isset( $detail['message'] ) ? (string) $detail['message'] : '';

			$by_id[ (string) $op_id ] = array(
				'status'  => $status,
				'code'    => $code,
				'message' => $message,
			);

			if ( ! $dominant_found ) {
				$dominant_code  = $code;
				$dominant_found = true;
			}
		}

		// Build the WP_Error so the §0.6 `data` block carries both the per-id map (under `errors_by_id`,
		// matching the §4.4 batch-error `data` payload) and the taxonomy meta. The §4.4 contract describes
		// the body as `{success:false,code,data:{<id>:...}}`; we honor the per-id `data` payload via meta so
		// the standard envelope still serializes a stable taxonomy `code`.
		return $this->error(
			$dominant_code,
			__( 'One or more batch operations failed; the whole batch was rejected (atomic). See per-operation details.', 'elementor-ultra-mcp' ),
			Error_Codes::http_status( $dominant_code ),
			array(
				'kind'         => 'variables',
				'batch_failed' => true,
				'errors_by_id' => $by_id,
			),
			$this->batch_errors_list( $by_id )
		);
	}

	/**
	 * Translate an Elementor per-id batch error slug to a taxonomy code (12 §4 + variables-specific slugs).
	 * Elementor groups per-id slugs into `batch_*` codes at the rest layer; the underlying per-id slugs are
	 * `duplicated_label` / `invalid_variable_limit_reached` / `variable_not_found`. We accept BOTH the raw
	 * per-id slugs and the grouped `batch_*` slugs.
	 *
	 * @param string $slug The Elementor error code slug.
	 */
	private function batch_slug_to_code( string $slug ): string {
		switch ( $slug ) {
			case 'duplicated_label':
			case 'batch_duplicated_label':
				return Error_Codes::DUPLICATED_LABEL;
			case 'invalid_variable_limit_reached':
			case 'batch_variables_limit_reached':
				return Error_Codes::BUDGET_EXCEEDED;
			case 'variable_not_found':
			case 'batch_variables_not_found':
				return Error_Codes::NOT_FOUND;
			case 'type_mismatch':
				return Error_Codes::VALIDATION_FAILED;
			default:
				return Error_Codes::VALIDATION_FAILED;
		}
	}

	/**
	 * Build the standard `errors[]` list (`{path,code,message,meta}`) from the per-id batch map so the §0.6
	 * envelope carries machine-readable per-op detail.
	 *
	 * @param array<string,array{status:int,code:string,message:string}> $by_id Per-id batch errors.
	 * @return array<int,array<string,mixed>>
	 */
	private function batch_errors_list( array $by_id ): array {
		$errors = array();
		foreach ( $by_id as $op_id => $detail ) {
			$errors[] = array(
				'path'    => 'operations.' . $op_id,
				'code'    => $detail['code'],
				'message' => $detail['message'],
				'meta'    => array(
					'op_id'  => (string) $op_id,
					'status' => $detail['status'],
				),
			);
		}
		return $errors;
	}

	/**
	 * A 400 SCHEMA_INVALID_PARAMS for a malformed batch operation at `$index`.
	 *
	 * @param int|string $index The operation index.
	 * @param string     $why   The human reason the op is malformed.
	 */
	private function batch_op_error( $index, string $why ): WP_Error {
		return $this->error(
			Error_Codes::SCHEMA_INVALID_PARAMS,
			sprintf(
				/* translators: 1: operation index, 2: the reason. */
				__( 'Invalid batch operation at index %1$s: %2$s', 'elementor-ultra-mcp' ),
				(string) $index,
				$why
			),
			400,
			array( 'path' => 'operations.' . $index )
		);
	}

	/**
	 * Whether an exception class name ends with a given Elementor exception short name (so we match the
	 * variables exceptions without hard-coupling to their FQCNs / loading them).
	 *
	 * @param string $class_name The exception FQCN.
	 * @param string $short_name The Elementor exception short class name.
	 */
	private function is_a( string $class_name, string $short_name ): bool {
		$parts = explode( '\\', $class_name );
		$base  = (string) end( $parts );
		return $base === $short_name;
	}

	/**
	 * Build an UPSTREAM_ERROR (502) for an unexpected upstream throw.
	 *
	 * @param string     $where The upstream operation that threw.
	 * @param \Throwable $e     The caught throwable.
	 */
	private function upstream( string $where, \Throwable $e ): WP_Error {
		return $this->error(
			Error_Codes::UPSTREAM_ERROR,
			sprintf(
				/* translators: 1: upstream operation, 2: error message. */
				__( 'Variables upstream error in %1$s: %2$s', 'elementor-ultra-mcp' ),
				$where,
				$e->getMessage()
			),
			Error_Codes::http_status( Error_Codes::UPSTREAM_ERROR ),
			array( 'upstream' => $where )
		);
	}

	/**
	 * Mint a taxonomy `WP_Error` via the shared {@see Error} factory (so the `data` block matches §0.6).
	 *
	 * @param string                         $code    Taxonomy code.
	 * @param string                         $message Human, actionable message.
	 * @param int                            $status  HTTP status.
	 * @param array<string,mixed>            $meta    Structured context.
	 * @param array<int,array<string,mixed>> $errors  Per-item validation errors.
	 */
	private function error( string $code, string $message, int $status, array $meta = array(), array $errors = array() ): WP_Error {
		return Error::make( $code, $message, $status, $meta, $errors );
	}
}
