<?php
/**
 * WP-R03 — Form_Mapper: the PURE (no WP I/O) spec -> `form` widget settings mapper for Pro Forms.
 *
 * Contract authority:
 *  - 10-rest-api.md §8.5 (`POST /pro/form/build` request/response shape).
 *  - 11-authoring-contract.md §2 (classic vs atomic node shape — this mapper emits the V3 classic shape;
 *    the atomic `e-form` tree is built by {@see Form_Builder_Service}).
 *  - SUPPLEMENT.md §A.3 (form widget + form_fields repeater + actions), §A.7 (pro.form.build behaviour).
 *
 * Elementor Pro APIs this mapper mirrors (cited `path:line` against the bundled source under
 * `plugins/elementor-pro/`):
 *  - Form widget `widgetType='form'`, `Forms\Widgets\Form extends Form_Base`, `get_name()='form'` —
 *    modules/forms/widgets/form.php:23-25.
 *  - Fields repeater `form_fields` + default 3 fields (name/email[required]/message) —
 *    modules/forms/widgets/form.php:564-598 (defaults :569-595; `custom_id` defaults at :571,581).
 *  - `field_type` SELECT default `'text'` (base list) — modules/forms/widgets/form.php:111-128.
 *  - Repeater keys (`field_label`, `placeholder`, `required` SWITCHER `return_value 'true'`,
 *    `field_options`, `width` `100..20` def `100`, `rows` def 4, `field_value`, `field_html`,
 *    `custom_id` TEXT `required:true`) — modules/forms/widgets/form.php:151-537 (`custom_id` :507-535).
 *  - Form-level controls (`form_name` def 'New Form', `button_text` def 'Send', `input_size` def 'sm',
 *    `show_labels` def 'true', `submit_actions` SELECT2 multiple def `['email']`) —
 *    modules/forms/widgets/form.php:896-908.
 *  - Email action controls (`email_to`, `email_subject`, `email_content` def `[all-fields]`,
 *    `email_from`, `email_from_name`, `email_reply_to` = a field custom_id, `email_to_cc`, `email_to_bcc`,
 *    `form_metadata`, `email_content_type` def 'html') — modules/forms/actions/email.php:42-224.
 *  - Email2 control ids are SUFFIXED `_2` (NOT prefixed `email2_`) — `Email2::get_control_id($id)` returns
 *    `$id . '_2'` (modules/forms/actions/email2.php:20-22). Live-verified: `section_email_2` controls are
 *    `email_to_2`,`email_subject_2`,…  This OVERRIDES the SUPPLEMENT §A.3 "email2_ prefix" note (see the
 *    WP deviation recorded on {@see Form_Builder_Service}).
 *  - Redirect control `redirect_to` — modules/forms/actions/redirect.php:34-55.
 *  - Webhook controls `webhooks` + `webhooks_advanced_data` (def 'no') — modules/forms/actions/webhook.php:32-59.
 *
 * 100% pure: every method is static, takes plain arrays, returns plain arrays, and performs NO WordPress
 * calls (no `add_filter`, no `get_option`, no `wp_rand`) so it is unit-testable off-WP. The one source of
 * non-determinism — the per-field repeater `_id` — is injected by the caller (so tests can pass fixed ids).
 * {@see Form_Builder_Service} supplies real `wp_rand`-minted ids and the live registrar/filter checks.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Pure field/action mapper for the classic `form` widget. Holds NO WP state.
 */
final class Form_Mapper {

	/**
	 * The base `field_type` enum (modules/forms/widgets/form.php:111-128). The service ALSO unions any type
	 * added by the `elementor_pro/forms/field_types` filter (form.php:143) before validating — this mapper
	 * accepts whatever type the service passes through (the service is the gate); this list is the documented
	 * default + the fallback when the live filter is unavailable.
	 *
	 * @var string[]
	 */
	const BASE_FIELD_TYPES = array(
		'text',
		'email',
		'textarea',
		'url',
		'tel',
		'radio',
		'select',
		'checkbox',
		'acceptance',
		'number',
		'date',
		'time',
		'upload',
		'password',
		'html',
		'hidden',
	);

	/**
	 * Field types that accept a `placeholder` (form.php:151-537 — placeholder control `condition` =
	 * tel/text/email/textarea/number/url/password). For any other type the placeholder is dropped.
	 *
	 * @var string[]
	 */
	const PLACEHOLDER_TYPES = array( 'tel', 'text', 'email', 'textarea', 'number', 'url', 'password' );

	/**
	 * Field types for which `required` is NOT a valid control (form.php repeater excludes the SWITCHER for
	 * these) — the `required:"true"` key is dropped for them.
	 *
	 * @var string[]
	 */
	const NO_REQUIRED_TYPES = array( 'checkbox', 'recaptcha', 'recaptcha_v3', 'hidden', 'html', 'step' );

	/**
	 * Field types that accept `field_options` (the newline `Label|value` list) — select/checkbox/radio only
	 * (form.php:151-537).
	 *
	 * @var string[]
	 */
	const OPTIONS_TYPES = array( 'select', 'checkbox', 'radio' );

	/**
	 * Allowed `width` values (form.php `width` SELECT, def `100`). A spec width not in this set falls back
	 * to `100`.
	 *
	 * @var string[]
	 */
	const WIDTHS = array( '100', '80', '75', '70', '66', '60', '50', '40', '33', '30', '25', '20' );

	/** Default `width` (form.php:151-537 — `default => '100'`). */
	const DEFAULT_WIDTH = '100';

	/** The `required` SWITCHER `return_value` — THE STRING `'true'`, never a boolean (the #1 forms gotcha). */
	const REQUIRED_TRUE = 'true';

	/** Form-level control defaults — emit a key ONLY when the spec value differs (RESEARCH §4 classic rule). */
	const FORM_DEFAULTS = array(
		'form_name'   => 'New Form',
		'button_text' => 'Send',
		'input_size'  => 'sm',
		'show_labels' => 'true',
	);

	/** The default `submit_actions` (form.php:896-908). */
	const DEFAULT_SUBMIT_ACTIONS = array( 'email' );

	/*
	------------------------------------------------------------------------------------------------
	 * Fields.
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Map an ergonomic field spec list to the `form_fields` repeater array (SUPPLEMENT §A.3/§A.7,
	 * form.php:564-598). Each output item carries a unique repeater `_id` (caller-supplied via `$id_minter`,
	 * deduped within the repeater), a unique sanitized `custom_id`, `field_type`, `field_label`, and — when
	 * applicable to the type — `required:"true"` (the STRING), `placeholder`, `field_options`, `width`,
	 * `rows`, `field_value`, `field_html`.
	 *
	 * @param array<int,array<string,mixed>> $fields    The ergonomic field specs
	 *                                                   (`{type,id,label?,placeholder?,required?,options?,rows?,
	 *                                                   width?,default_value?,html?}`).
	 * @param callable():string              $id_minter A side-effect-free repeater-id minter (the service
	 *                                                   passes `Id_Service::mint`); the mapper dedupes its
	 *                                                   output within the repeater so collisions never persist.
	 *
	 * @return array<int,array<string,mixed>> The `form_fields` repeater rows.
	 */
	public static function map_fields( array $fields, callable $id_minter ): array {
		$rows           = array();
		$taken_custom   = array();
		$taken_repeater = array();

		foreach ( array_values( $fields ) as $field ) {
			if ( ! is_array( $field ) ) {
				continue; // The service validates shape; skip a non-array defensively.
			}

			$type = isset( $field['type'] ) && is_string( $field['type'] ) ? $field['type'] : 'text';

			$raw_id                     = isset( $field['id'] ) && is_scalar( $field['id'] ) ? (string) $field['id'] : '';
			$custom_id                  = self::unique_custom_id( $raw_id, $taken_custom );
			$taken_custom[ $custom_id ] = true;

			// A unique repeater `_id` (deduped within this repeater) — minted by the caller.
			$repeater_id                    = self::mint_unique( $id_minter, $taken_repeater );
			$taken_repeater[ $repeater_id ] = true;

			$row = array(
				'_id'        => $repeater_id,
				'custom_id'  => $custom_id,
				'field_type' => $type,
			);

			$label = isset( $field['label'] ) && is_scalar( $field['label'] ) ? (string) $field['label'] : '';
			if ( '' !== $label ) {
				$row['field_label'] = $label;
			}

			// `required:"true"` — THE STRING (SWITCHER `return_value 'true'`); dropped for ineligible types.
			if ( self::truthy( $field['required'] ?? null ) && ! in_array( $type, self::NO_REQUIRED_TYPES, true ) ) {
				$row['required'] = self::REQUIRED_TRUE;
			}

			// `placeholder` only for placeholder-eligible types (form.php condition).
			$placeholder = isset( $field['placeholder'] ) && is_scalar( $field['placeholder'] ) ? (string) $field['placeholder'] : '';
			if ( '' !== $placeholder && in_array( $type, self::PLACEHOLDER_TYPES, true ) ) {
				$row['placeholder'] = $placeholder;
			}

			// `field_options` newline `Label|value` string — select/checkbox/radio only.
			if ( in_array( $type, self::OPTIONS_TYPES, true ) && isset( $field['options'] ) && is_array( $field['options'] ) ) {
				$options = self::map_options( $field['options'] );
				if ( '' !== $options ) {
					$row['field_options'] = $options;
				}
			}

			// `rows` — textarea only (the control is conditioned on textarea; carry it only there).
			if ( 'textarea' === $type && isset( $field['rows'] ) && is_numeric( $field['rows'] ) ) {
				$row['rows'] = (int) $field['rows'];
			}

			// `width` — snap to the allowed set, default 100. Emit only when non-default.
			$width = self::normalize_width( $field['width'] ?? null );
			if ( self::DEFAULT_WIDTH !== $width ) {
				$row['width'] = $width;
			}

			// `field_value` (advanced-tab default value).
			if ( isset( $field['default_value'] ) && is_scalar( $field['default_value'] ) ) {
				$dv = (string) $field['default_value'];
				if ( '' !== $dv ) {
					$row['field_value'] = $dv;
				}
			}

			// `field_html` — html type only.
			if ( 'html' === $type && isset( $field['html'] ) && is_string( $field['html'] ) && '' !== $field['html'] ) {
				$row['field_html'] = $field['html'];
			}

			$rows[] = $row;
		}

		return $rows;
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Actions.
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Map an ergonomic action spec list to `{submit_actions, settings}` (SUPPLEMENT §A.3/§A.7). The mapper
	 * does NOT know which actions are licensed — the service filters `$actions` to the registered set BEFORE
	 * calling this (dropping unregistered ones with a warning). For each surviving action it appends the type
	 * to `submit_actions` and expands its known control ids flat into `settings` (passing through unknown
	 * keys). `email` controls are bare; `email2` controls are SUFFIXED `_2` (live-verified, see the deviation
	 * note on {@see Form_Builder_Service}).
	 *
	 * @param array<int,array<string,mixed>> $actions The (already license-filtered) action specs.
	 *
	 * @return array{submit_actions:array<int,string>,settings:array<string,mixed>}
	 */
	public static function map_actions( array $actions ): array {
		$submit   = array();
		$settings = array();

		foreach ( array_values( $actions ) as $action ) {
			if ( ! is_array( $action ) ) {
				continue;
			}
			$type = isset( $action['type'] ) && is_string( $action['type'] ) ? $action['type'] : '';
			if ( '' === $type ) {
				continue;
			}

			$submit[] = $type;

			switch ( $type ) {
				case 'email':
					$settings = array_merge( $settings, self::map_email_action( $action, '' ) );
					break;
				case 'email2':
					// SUFFIX `_2` per Email2::get_control_id (email2.php:20-22) — NOT a `email2_` prefix.
					$settings = array_merge( $settings, self::map_email_action( $action, '_2' ) );
					break;
				case 'redirect':
					$settings = array_merge( $settings, self::map_redirect_action( $action ) );
					break;
				case 'webhook':
					$settings = array_merge( $settings, self::map_webhook_action( $action ) );
					break;
				default:
					// Unknown/integration action: pass through every non-`type` key verbatim (TS schema is
					// `.passthrough()`). The service already proved the type is registered.
					$settings = array_merge( $settings, self::passthrough( $action ) );
			}
		}

		return array(
			'submit_actions' => array_values( array_unique( $submit ) ),
			'settings'       => $settings,
		);
	}

	/**
	 * Expand an `email`/`email2` action into its flat control ids (email.php:42-224). `$suffix` is `''` for
	 * the first email action and `'_2'` for `email2` (Email2::get_control_id). `email_content` defaults to
	 * `[all-fields]`; `form_metadata` is a list (SELECT2 multiple); `email_reply_to` is a FIELD custom_id
	 * reference, not an address (email.php).
	 *
	 * @param array<string,mixed> $action The action spec.
	 * @param string              $suffix '' or '_2'.
	 *
	 * @return array<string,mixed>
	 */
	private static function map_email_action( array $action, string $suffix ): array {
		$out = array();

		$scalar_map = array(
			'email_to'           => 'email_to',
			'email_subject'      => 'email_subject',
			'email_from'         => 'email_from',
			'email_from_name'    => 'email_from_name',
			'email_reply_to'     => 'email_reply_to', // A field custom_id, NOT an address (email.php).
			'email_to_cc'        => 'email_to_cc',
			'email_to_bcc'       => 'email_to_bcc',
			'email_content_type' => 'email_content_type',
		);
		foreach ( $scalar_map as $spec_key => $control ) {
			if ( isset( $action[ $spec_key ] ) && is_scalar( $action[ $spec_key ] ) ) {
				$val = (string) $action[ $spec_key ];
				if ( '' !== $val ) {
					$out[ $control . $suffix ] = $val;
				}
			}
		}

		// `email_content` defaults to `[all-fields]` (email.php:83) when not provided.
		$content                          = isset( $action['email_content'] ) && is_scalar( $action['email_content'] ) ? (string) $action['email_content'] : '';
		$out[ 'email_content' . $suffix ] = '' !== $content ? $content : '[all-fields]';

		// `form_metadata` SELECT2 multiple — accept a list (drop non-strings).
		if ( isset( $action['form_metadata'] ) && is_array( $action['form_metadata'] ) ) {
			$meta = array_values( array_filter( $action['form_metadata'], 'is_string' ) );
			if ( array() !== $meta ) {
				$out[ 'form_metadata' . $suffix ] = $meta;
			}
		}

		return $out;
	}

	/**
	 * Expand a `redirect` action -> `redirect_to` (redirect.php:34-55). Not suffixed (single action).
	 *
	 * @param array<string,mixed> $action The action spec.
	 *
	 * @return array<string,mixed>
	 */
	private static function map_redirect_action( array $action ): array {
		$to = isset( $action['redirect_to'] ) && is_scalar( $action['redirect_to'] ) ? (string) $action['redirect_to'] : '';
		return '' !== $to ? array( 'redirect_to' => $to ) : array();
	}

	/**
	 * Expand a `webhook` action -> `webhooks` (+ `webhooks_advanced_data` def 'no') (webhook.php:32-59).
	 *
	 * @param array<string,mixed> $action The action spec.
	 *
	 * @return array<string,mixed>
	 */
	private static function map_webhook_action( array $action ): array {
		$out = array();
		$url = isset( $action['webhooks'] ) && is_scalar( $action['webhooks'] ) ? (string) $action['webhooks'] : '';
		if ( '' !== $url ) {
			$out['webhooks'] = $url;
		}
		$adv                           = isset( $action['webhooks_advanced_data'] ) && is_scalar( $action['webhooks_advanced_data'] ) ? (string) $action['webhooks_advanced_data'] : 'no';
		$out['webhooks_advanced_data'] = '' !== $adv ? $adv : 'no';
		return $out;
	}

	/**
	 * Pass through every key of an integration action except `type` (the TS schema is `.passthrough()`, so
	 * integration controls like `mailchimp_api_key`/`mailchimp_list` flow through verbatim).
	 *
	 * @param array<string,mixed> $action The action spec.
	 *
	 * @return array<string,mixed>
	 */
	private static function passthrough( array $action ): array {
		$out = $action;
		unset( $out['type'] );
		return $out;
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Form-level controls.
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Map the form-level controls (form.php:896-908). Emits ONLY keys that differ from the Elementor default
	 * (RESEARCH §4 classic rule: emit only non-default). `form_id` is always emitted when supplied (it has
	 * no meaningful default).
	 *
	 * @param array<string,mixed> $spec The build request params (`form_name`, `button_text`, `input_size`,
	 *                                   `show_labels`, `form_id`).
	 *
	 * @return array<string,mixed>
	 */
	public static function map_form_controls( array $spec ): array {
		$out = array();

		foreach ( self::FORM_DEFAULTS as $key => $default ) {
			if ( ! isset( $spec[ $key ] ) || ! is_scalar( $spec[ $key ] ) ) {
				continue;
			}
			$val = (string) $spec[ $key ];
			if ( '' !== $val && $val !== (string) $default ) {
				$out[ $key ] = $val;
			}
		}

		if ( isset( $spec['form_id'] ) && is_scalar( $spec['form_id'] ) && '' !== (string) $spec['form_id'] ) {
			$out['form_id'] = (string) $spec['form_id'];
		}

		return $out;
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Custom-id sanitization.
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Sanitize a raw field id to `[A-Za-z0-9_]` and dedupe against `$taken` (SUPPLEMENT §A.3 — `custom_id`
	 * is `required:true` and referenced by `[field id="..."]`, so it MUST be unique and a clean data key).
	 * Spaces/dashes/punctuation collapse to `_`; a leading digit is prefixed `f_` (a valid identifier); an
	 * empty/blank id becomes `field`; collisions append `_2`, `_3`, … Pure (no WP).
	 *
	 * @param string             $raw   The raw id (may be empty / dirty).
	 * @param array<string,bool> $taken The set of already-used custom ids (`[id=>true]`).
	 *
	 * @return string A unique `[A-Za-z0-9_]` id.
	 */
	public static function unique_custom_id( string $raw, array $taken ): string {
		// Replace any run of non-[A-Za-z0-9_] with a single underscore.
		$clean = preg_replace( '/[^A-Za-z0-9_]+/', '_', $raw );
		$clean = is_string( $clean ) ? trim( $clean, '_' ) : '';

		if ( '' === $clean ) {
			$clean = 'field';
		}
		// A data key must not start with a digit.
		if ( preg_match( '/^[0-9]/', $clean ) ) {
			$clean = 'f_' . $clean;
		}

		$candidate = $clean;
		$suffix    = 2;
		while ( isset( $taken[ $candidate ] ) ) {
			$candidate = $clean . '_' . $suffix;
			++$suffix;
		}

		return $candidate;
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Internal pure helpers.
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Convert an `options:[{label,value}]` list (or a list of strings) to the `field_options` newline string
	 * `Label|value\n...` (form.php — `field_options` TEXTAREA). A bare string item becomes `value` with the
	 * value reused as the label.
	 *
	 * @param array<int,mixed> $options The option specs.
	 *
	 * @return string The newline-joined `Label|value` string.
	 */
	private static function map_options( array $options ): string {
		$lines = array();
		foreach ( array_values( $options ) as $opt ) {
			if ( is_string( $opt ) ) {
				$lines[] = $opt; // Bare value -> label == value (Elementor treats a single token as both).
				continue;
			}
			if ( ! is_array( $opt ) ) {
				continue;
			}
			$label = isset( $opt['label'] ) && is_scalar( $opt['label'] ) ? (string) $opt['label'] : '';
			$value = isset( $opt['value'] ) && is_scalar( $opt['value'] ) ? (string) $opt['value'] : '';
			if ( '' === $label && '' === $value ) {
				continue;
			}
			if ( '' === $value ) {
				$lines[] = $label; // Label only -> single token.
			} elseif ( '' === $label ) {
				$lines[] = $value;
			} else {
				$lines[] = $label . '|' . $value;
			}
		}
		return implode( "\n", $lines );
	}

	/**
	 * Snap a spec width to the allowed set, defaulting to `100` (form.php `width` SELECT def `100`).
	 *
	 * @param mixed $width The spec width (string/int/null).
	 *
	 * @return string A valid width string.
	 */
	private static function normalize_width( $width ): string {
		if ( is_scalar( $width ) ) {
			$candidate = (string) $width;
			if ( in_array( $candidate, self::WIDTHS, true ) ) {
				return $candidate;
			}
		}
		return self::DEFAULT_WIDTH;
	}

	/**
	 * Truthiness for the spec `required` flag — accepts bool true, `'true'`/`'1'`/`'yes'`, or int 1.
	 *
	 * @param mixed $value The spec value.
	 */
	private static function truthy( $value ): bool {
		if ( is_bool( $value ) ) {
			return $value;
		}
		if ( is_int( $value ) ) {
			return 1 === $value;
		}
		if ( is_string( $value ) ) {
			return in_array( strtolower( $value ), array( 'true', '1', 'yes' ), true );
		}
		return false;
	}

	/**
	 * Mint a repeater id via `$id_minter`, retrying until it is absent from `$taken` (the minter may collide
	 * on short randoms). Pure relative to this class — randomness lives entirely in the injected callable.
	 *
	 * @param callable():string  $id_minter The id minter.
	 * @param array<string,bool> $taken     Ids already used in this repeater.
	 *
	 * @return string A repeater id not in `$taken`.
	 */
	private static function mint_unique( callable $id_minter, array $taken ): string {
		$attempts = 0;
		do {
			$id = (string) call_user_func( $id_minter );
			++$attempts;
		} while ( ( '' === $id || isset( $taken[ $id ] ) ) && $attempts < 50 );

		// Deterministic fallback so the mapper never loops forever on a degenerate minter.
		if ( '' === $id || isset( $taken[ $id ] ) ) {
			$id = 'fld' . ( count( $taken ) + 1 );
		}
		return $id;
	}
}
