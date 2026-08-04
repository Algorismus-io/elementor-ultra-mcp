<?php
/**
 * WP-R02 — Display_Settings_Helper: validate / flatten / merge the popup triggers+timing object.
 *
 * Contract authority:
 *  - 10-rest-api.md §8.4 (`POST /pro/popup`, `PUT /pro/popup/{id}/display`) — the
 *    `{triggers:{...},timing:{...}}` request shape, group toggles ∈ `"yes"|""`, sub-keys prefixed
 *    `{group}_{control}`.
 *  - 12-error-taxonomy.md §3.1 (`SCHEMA_INVALID_PARAMS` 400 — structurally impossible toggle/enum).
 *  - SUPPLEMENT.md §A.2 (the FULL triggers/timing object: group names, prefixed sub-controls,
 *    enum-bearing sub-controls, the `times` three-key gotcha, `exit_intent` toggle-only,
 *    `scrolling_offset` only meaningful with `scrolling_direction=down`, hidden
 *    `schedule_server_datetime`).
 *
 * Elementor Pro APIs (cited `path:line` relative to plugins/elementor-pro):
 *  - The storage is the NESTED `{triggers:{...},timing:{...}}` assoc under
 *    `_elementor_popup_display_settings` (`DISPLAY_SETTINGS_META_KEY`, popup/document.php:22) written
 *    by `save_display_settings_data()` (popup/document.php:115-116). `get_display_settings()`
 *    (popup/document.php:54-77) reads `$settings['triggers']` / `$settings['timing']` directly — a
 *    flat single-level array silently yields EMPTY trigger/timing stacks (the popup never auto-opens),
 *    which is why every write path here emits the nested shape and every read path tolerates legacy
 *    flat metas written by earlier plugin versions. Inside each section the keys are flat and
 *    group-prefixed (the editor's PopupSave hook saves `settings[type] = model.toJSON()` per type,
 *    popup/module.php:236).
 *  - Group toggle key = the bare group name; sub-controls are PREFIXED `{group}_{control}`
 *    (popup/display-settings/base.php). Trigger groups: popup/display-settings/triggers.php (class
 *    `Triggers`, `get_name()='popup_triggers'`). Timing groups: popup/display-settings/timing.php
 *    (class `Timing`, `get_name()='popup_timing'`).
 *
 * Design: this helper NEVER touches WordPress meta — it is a pure transform over the request and the
 * stored nested array. The {@see Popup_Service} reads/writes `_elementor_popup_display_settings` via the
 * popup Document's `save_display_settings_data()` / `get_display_settings_data()`. The helper's
 * validation is a SOFT allowlist (ticket Detailed-Req #3): unknown keys are PASSED THROUGH and surfaced
 * via {@see unverified_keys()} so future Pro controls never hard-fail us — only a structurally impossible
 * toggle value or a wrong enum on a KNOWN enum-bearing sub-control is a 400.
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
 * Pure transform/validation helper for the popup display-settings object. All methods are static so the
 * {@see Popup_Service} can call them without wiring (mirrors {@see Conditions_Helper}).
 */
final class Display_Settings_Helper {

	/** The two request groups (SUPPLEMENT §A.2). */
	const GROUP_TRIGGERS = 'triggers';

	/** The timing request group. */
	const GROUP_TIMING = 'timing';

	/**
	 * Known TRIGGER group toggle names (SUPPLEMENT §A.2 `popup/display-settings/triggers.php`). The value
	 * of each MUST be `"yes"` or `""`.
	 *
	 * @var string[]
	 */
	const TRIGGER_GROUPS = array( 'page_load', 'scrolling', 'scrolling_to', 'click', 'inactivity', 'exit_intent', 'adblock_detection' );

	/**
	 * Known TIMING group toggle names (SUPPLEMENT §A.2 `popup/display-settings/timing.php`). The value of
	 * each MUST be `"yes"` or `""`.
	 *
	 * @var string[]
	 */
	const TIMING_GROUPS = array( 'page_views', 'sessions', 'times', 'url', 'sources', 'logged_in', 'devices', 'browsers', 'schedule' );

	/**
	 * The known sub-controls per group (prefixed `{group}_{control}` — SUPPLEMENT §A.2). Used only as a
	 * SOFT allowlist: a key not present anywhere here is "unverified" (passed through + reported), NEVER
	 * rejected. `exit_intent` is intentionally absent (toggle-only, no sub-control — ticket Detailed-Req #7).
	 *
	 * @var array<string,string[]>
	 */
	const KNOWN_SUB_CONTROLS = array(
		'page_load'         => array( 'page_load_delay' ),
		'scrolling'         => array( 'scrolling_direction', 'scrolling_offset' ),
		'scrolling_to'      => array( 'scrolling_to_selector' ),
		'click'             => array( 'click_times' ),
		'inactivity'        => array( 'inactivity_time' ),
		'adblock_detection' => array( 'adblock_detection_delay' ),
		'page_views'        => array( 'page_views_views' ),
		'sessions'          => array( 'sessions_sessions' ),
		'times'             => array( 'times_times', 'times_period', 'times_count' ),
		'url'               => array( 'url_action', 'url_url' ),
		'sources'           => array( 'sources_sources' ),
		'logged_in'         => array( 'logged_in_users', 'logged_in_roles' ),
		'devices'           => array( 'devices_devices' ),
		'browsers'          => array( 'browsers_browsers', 'browsers_browsers_options' ),
		'schedule'          => array( 'schedule_timezone', 'schedule_start_date', 'schedule_end_date' ),
	);

	/**
	 * Enum allowlists for the enum-bearing sub-controls (SUPPLEMENT §A.2). Only these KNOWN sub-controls
	 * are enum-validated; everything else passes through. An empty-string member means "(off)" is allowed.
	 *
	 * @var array<string,string[]>
	 */
	const SUB_CONTROL_ENUMS = array(
		'scrolling_direction' => array( 'down', 'up' ),
		'times_period'        => array( '', 'session', 'day', 'week', 'month' ),
		'times_count'         => array( '', 'close' ),
		'url_action'          => array( 'show', 'hide', 'regex' ),
		'logged_in_users'     => array( 'all', 'custom' ),
		'browsers_browsers'   => array( 'all', 'custom' ),
		'schedule_timezone'   => array( 'site', 'visitor' ),
	);

	/**
	 * Sub-control keys that Elementor auto-fills / hides and that MUST be stripped from any input
	 * (ticket Detailed-Req #7; SUPPLEMENT §A.2 "`schedule_server_datetime` HIDDEN, auto-filled").
	 *
	 * @var string[]
	 */
	const STRIPPED_KEYS = array( 'schedule_server_datetime' );

	/**
	 * The two legal group-toggle values (10-rest-api.md §8.4; SUPPLEMENT §A.2).
	 *
	 * @var string[]
	 */
	const TOGGLE_VALUES = array( 'yes', '' );

	/**
	 * Validate the `{triggers?,timing?}` request object (ticket Detailed-Req #3). Returns a 400
	 * `SCHEMA_INVALID_PARAMS` `WP_Error` ONLY for a structurally impossible value: a group toggle that is
	 * neither `"yes"` nor `""`, or a KNOWN enum-bearing sub-control whose value is outside its enum.
	 * Unknown group/sub-control keys are PASSED THROUGH (soft allowlist) — surfaced later via
	 * {@see unverified_keys()}, never rejected.
	 *
	 * @param array<string,mixed> $display The `{triggers?:{...},timing?:{...}}` request object.
	 * @return true|WP_Error
	 */
	public static function validate( array $display ) {
		foreach ( array( self::GROUP_TRIGGERS, self::GROUP_TIMING ) as $section ) {
			if ( ! isset( $display[ $section ] ) ) {
				continue;
			}
			if ( ! is_array( $display[ $section ] ) ) {
				return self::invalid( $section, 'must be an object of {group toggles + prefixed sub-controls}' );
			}
			$toggles = self::group_names( $section );
			foreach ( $display[ $section ] as $key => $value ) {
				$key = (string) $key;

				// (a) A bare group name is a toggle and MUST be "yes" or "".
				if ( in_array( $key, $toggles, true ) ) {
					if ( ! self::is_legal_toggle( $value ) ) {
						return self::invalid(
							$section . '.' . $key,
							'group toggle must be "yes" or "" (got ' . self::scalar_label( $value ) . ')'
						);
					}
					continue;
				}

				// (b) A KNOWN enum-bearing sub-control MUST be inside its enum (only validate known enums).
				if ( isset( self::SUB_CONTROL_ENUMS[ $key ] ) && is_scalar( $value ) ) {
					$allowed = self::SUB_CONTROL_ENUMS[ $key ];
					if ( ! in_array( (string) $value, $allowed, true ) ) {
						return self::invalid(
							$section . '.' . $key,
							sprintf( 'must be one of [%s] (got "%s")', implode( '|', array_map( 'strval', $allowed ) ), (string) $value )
						);
					}
				}
				// (c) Anything else (unknown group toggle / unknown sub-control / non-enum sub-control)
				// passes through — reported via unverified_keys(), never a hard fail.
			}
		}
		return true;
	}

	/**
	 * Normalize the `{triggers:{...},timing:{...}}` request shape into the NESTED
	 * `{triggers:{...},timing:{...}}` assoc that `_elementor_popup_display_settings` stores (SUPPLEMENT
	 * §A.2; popup/document.php:54-77 reads `$settings['triggers']` / `$settings['timing']` directly).
	 * BOTH section keys are always present (Pro reads them without `isset`). Keys inside each section
	 * stay flat and group-prefixed so they never collide. Strips hidden/auto-filled keys
	 * ({@see STRIPPED_KEYS}). Group toggle values are cast to STRING (ticket Impl-Notes); numeric
	 * sub-controls (delays, counts) keep their native type — Elementor reads them as-is. A KNOWN key
	 * sent under the wrong section is routed to the section Pro actually reads it from; unknown keys
	 * stay in the section they were sent under (soft allowlist — never lost).
	 *
	 * @param array<string,mixed> $display The `{triggers?:{...},timing?:{...}}` request object.
	 * @return array{triggers:array<string,mixed>,timing:array<string,mixed>} The stored nested shape.
	 */
	public static function flatten( array $display ): array {
		$out         = array(
			self::GROUP_TRIGGERS => array(),
			self::GROUP_TIMING   => array(),
		);
		$all_toggles = array_merge( self::TRIGGER_GROUPS, self::TIMING_GROUPS );
		foreach ( array( self::GROUP_TRIGGERS, self::GROUP_TIMING ) as $section ) {
			if ( ! isset( $display[ $section ] ) || ! is_array( $display[ $section ] ) ) {
				continue;
			}
			foreach ( $display[ $section ] as $key => $value ) {
				$key = (string) $key;
				if ( in_array( $key, self::STRIPPED_KEYS, true ) ) {
					continue; // schedule_server_datetime is auto-filled/hidden — never store user input.
				}
				// Cast bare group toggles to string ("yes"/""); leave sub-controls (incl. arrays/numbers) as-is.
				$target = self::section_for_key( $key, $section );
				if ( in_array( $key, $all_toggles, true ) ) {
					$out[ $target ][ $key ] = self::to_toggle_string( $value );
					continue;
				}
				$out[ $target ][ $key ] = $value;
			}
		}
		return $out;
	}

	/**
	 * Merge a normalized `{triggers,timing}` patch into the EXISTING stored
	 * `_elementor_popup_display_settings` array (ticket Detailed-Req #4; 10-rest-api.md §8.4 — the display
	 * route MERGES). The merge is PER SECTION: within `triggers` (and within `timing`) a present patch key
	 * overwrites and an absent one is preserved — a patch that only touches `timing` leaves `triggers`
	 * untouched. Both operands are normalized first ({@see group}), so editor-saved nested metas, our own
	 * nested writes, AND legacy flat metas written by earlier plugin versions all merge correctly. Hidden
	 * keys are stripped.
	 *
	 * @param array<string,mixed> $existing The stored display settings (nested, or legacy flat).
	 * @param array<string,mixed> $patch    The patch (normalized via {@see flatten}).
	 * @return array{triggers:array<string,mixed>,timing:array<string,mixed>} The merged nested settings.
	 */
	public static function merge( array $existing, array $patch ): array {
		$existing = self::group( $existing );
		$patch    = self::group( $patch );
		$merged   = array();
		foreach ( array( self::GROUP_TRIGGERS, self::GROUP_TIMING ) as $section ) {
			$merged[ $section ] = array_merge( $existing[ $section ], $patch[ $section ] );
			foreach ( self::STRIPPED_KEYS as $key ) {
				unset( $merged[ $section ][ $key ] );
			}
		}
		return $merged;
	}

	/**
	 * Normalize ANY stored display-settings array into the `{triggers:{...},timing:{...}}` shape
	 * (10-rest-api.md §8.4 — `PUT /pro/popup/{id}/display` returns `{triggers,timing}`; also the storage
	 * shape Pro reads). Already-nested sections pass through. A legacy FLAT key (written by earlier plugin
	 * versions) is routed by its group PREFIX: a key whose group (the longest matching known group) is a
	 * trigger group lands in `triggers`, a timing group in `timing`. Unknown flat keys (no known prefix)
	 * are placed in `triggers` by default but never lost. Both section keys are always present.
	 *
	 * @param array<string,mixed> $settings The stored display settings (nested, legacy flat, or mixed).
	 * @return array{triggers:array<string,mixed>,timing:array<string,mixed>}
	 */
	public static function group( array $settings ): array {
		$out = array(
			self::GROUP_TRIGGERS => array(),
			self::GROUP_TIMING   => array(),
		);
		foreach ( $settings as $key => $value ) {
			$key = (string) $key;
			// Already-nested section: merge its (flat, prefixed) keys into the matching output section.
			if ( ( self::GROUP_TRIGGERS === $key || self::GROUP_TIMING === $key ) && is_array( $value ) ) {
				foreach ( $value as $sub_key => $sub_value ) {
					$out[ $key ][ (string) $sub_key ] = $sub_value;
				}
				continue;
			}
			// Legacy flat key: route by its group prefix.
			$section                 = self::section_for_key( $key );
			$out[ $section ][ $key ] = $value;
		}
		return $out;
	}

	/**
	 * The keys that could not be cross-checked against the known group/sub-control allowlist (ticket
	 * Detailed-Req #3 — "Unknown keys → pass through + add to `data.meta.unverified_keys[]`"). Accepts the
	 * stored nested form (or a legacy flat one) so the service can attach it to the success response.
	 *
	 * @param array<string,mixed> $settings The display settings (nested post-flatten, or legacy flat).
	 * @return string[]
	 */
	public static function unverified_keys( array $settings ): array {
		$known      = self::known_flat_keys();
		$unverified = array();
		foreach ( array_keys( self::to_flat( $settings ) ) as $key ) {
			$key = (string) $key;
			if ( ! in_array( $key, $known, true ) ) {
				$unverified[] = $key;
			}
		}
		return array_values( array_unique( $unverified ) );
	}

	/**
	 * Soft warnings for the SUPPLEMENT §A.2 gotchas that must NOT hard-fail (ticket Detailed-Req #7):
	 *  - `scrolling_offset` present without `scrolling_direction='down'` (offset only applies down-scroll).
	 * Returns a list of human, non-fatal warning strings (empty when none apply).
	 *
	 * @param array<string,mixed> $settings The display settings (nested post-flatten, or legacy flat).
	 * @return string[]
	 */
	public static function warnings( array $settings ): array {
		$flat     = self::to_flat( $settings );
		$warnings = array();
		if ( array_key_exists( 'scrolling_offset', $flat ) ) {
			$direction = isset( $flat['scrolling_direction'] ) ? (string) $flat['scrolling_direction'] : '';
			if ( 'down' !== $direction ) {
				$warnings[] = __( 'scrolling_offset only applies when scrolling_direction="down"; it will be ignored otherwise.', 'elementor-ultra-mcp' );
			}
		}
		return $warnings;
	}

	/*
	 * ------------------------------------------------------------------------------------------------
	 * Internal helpers.
	 * ---------------------------------------------------------------------------------------------
	 */

	/**
	 * The group toggle names for a request section.
	 *
	 * @param string $section `triggers` or `timing`.
	 * @return string[]
	 */
	private static function group_names( string $section ): array {
		return self::GROUP_TRIGGERS === $section ? self::TRIGGER_GROUPS : self::TIMING_GROUPS;
	}

	/**
	 * The full flat allowlist: every group toggle name + every known prefixed sub-control.
	 *
	 * @return string[]
	 */
	private static function known_flat_keys(): array {
		$keys = array_merge( self::TRIGGER_GROUPS, self::TIMING_GROUPS );
		foreach ( self::KNOWN_SUB_CONTROLS as $subs ) {
			foreach ( $subs as $sub ) {
				$keys[] = $sub;
			}
		}
		return array_values( array_unique( $keys ) );
	}

	/**
	 * Resolve which section (`triggers`/`timing`) a flat key belongs to, by the LONGEST known
	 * group-name prefix it matches (so `scrolling_to_selector` resolves to the `scrolling_to` group, not
	 * `scrolling`). Unknown keys fall back to `$default` (never lost).
	 *
	 * @param string $key     The flat key.
	 * @param string $default The section for unknown keys (`triggers` by default).
	 * @return string `triggers` or `timing`.
	 */
	private static function section_for_key( string $key, string $default = self::GROUP_TRIGGERS ): string {
		$best_group = '';
		foreach ( array_merge( self::TRIGGER_GROUPS, self::TIMING_GROUPS ) as $group ) {
			if ( $key === $group || 0 === strpos( $key, $group . '_' ) ) {
				if ( strlen( $group ) > strlen( $best_group ) ) {
					$best_group = $group;
				}
			}
		}
		if ( '' === $best_group ) {
			return $default;
		}
		return in_array( $best_group, self::TIMING_GROUPS, true ) ? self::GROUP_TIMING : self::GROUP_TRIGGERS;
	}

	/**
	 * Project ANY display-settings shape (nested, legacy flat, or mixed) onto ONE flat assoc of the
	 * group-prefixed keys — the form the allowlist/warning checks operate on. Pure read-side helper;
	 * never used for storage.
	 *
	 * @param array<string,mixed> $settings The display settings.
	 * @return array<string,mixed> The flat key projection.
	 */
	private static function to_flat( array $settings ): array {
		$flat = array();
		foreach ( self::group( $settings ) as $section_keys ) {
			foreach ( $section_keys as $key => $value ) {
				$flat[ (string) $key ] = $value;
			}
		}
		return $flat;
	}

	/**
	 * Whether a value is a legal group toggle (`"yes"` or `""`). Accepts only string scalars — a boolean
	 * `true`/`false` or `"true"` is NOT a legal toggle (ticket Acceptance: `page_load:'true'` is flagged).
	 *
	 * @param mixed $value The toggle value.
	 */
	private static function is_legal_toggle( $value ): bool {
		return is_string( $value ) && in_array( $value, self::TOGGLE_VALUES, true );
	}

	/**
	 * Cast any value to the canonical toggle string: truthy `'yes'|true|1|'1'` -> `'yes'`, everything else
	 * -> `''` (ticket Impl-Notes "cast all toggle values to string"). This NORMALIZES a flagged-but-passed
	 * toggle (e.g. `'true'`) into a storable string so the popup still functions.
	 *
	 * @param mixed $value The raw toggle value.
	 */
	private static function to_toggle_string( $value ): string {
		if ( true === $value || 'yes' === $value || 1 === $value || '1' === $value ) {
			return 'yes';
		}
		return 'yes' === (string) $value ? 'yes' : '';
	}

	/**
	 * A short human label for a non-string scalar/value (for error messages).
	 *
	 * @param mixed $value The value.
	 */
	private static function scalar_label( $value ): string {
		if ( is_bool( $value ) ) {
			return $value ? 'true(bool)' : 'false(bool)';
		}
		if ( is_array( $value ) ) {
			return 'array';
		}
		if ( null === $value ) {
			return 'null';
		}
		return '"' . (string) $value . '"';
	}

	/**
	 * Build a 400 `SCHEMA_INVALID_PARAMS` `WP_Error` for a structurally impossible display value.
	 *
	 * @param string $path   The dotted path (e.g. `triggers.page_load`).
	 * @param string $reason Human reason.
	 */
	private static function invalid( string $path, string $reason ): WP_Error {
		return Response::error(
			Error_Codes::SCHEMA_INVALID_PARAMS,
			sprintf(
				/* translators: 1: dotted path, 2: reason. */
				__( 'Invalid display_settings at %1$s: %2$s.', 'elementor-ultra-mcp' ),
				$path,
				$reason
			),
			400,
			array(
				'path'   => 'display_settings.' . $path,
				'reason' => $reason,
			)
		);
	}
}
