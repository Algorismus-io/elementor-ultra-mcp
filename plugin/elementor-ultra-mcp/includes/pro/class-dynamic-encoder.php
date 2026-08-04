<?php
/**
 * WP-R05 — Dynamic_Encoder: the PURE, byte-identical mirror of core `Manager::tag_to_text`.
 *
 * Contract authority:
 *  - 10-rest-api.md §8.7 ("Builds `[elementor-tag id=\"<rand7>\" name=\"<tag>\"
 *    settings=\"<urlencode(JSON_FORCE_OBJECT)>\"]`"; "Empty settings -> `settings=\"%7B%7D\"`
 *    (NOT empty string)").
 *  - SUPPLEMENT.md §A.6 (the three worked tag-binding strings + the `%7B%7D` empty-settings gotcha).
 *  - 12-error-taxonomy.md §2 (envelope — this pure class never errors; it only encodes).
 *
 * Elementor API mirrored (cited `path:line` relative to plugins/elementor):
 *  - `Dynamic_Tags\Manager::tag_to_text()` — core/dynamic-tags/manager.php:141-142:
 *        sprintf('[%1$s id="%2$s" name="%3$s" settings="%4$s"]',
 *          self::TAG_LABEL, $tag->get_id(), $tag->get_name(),
 *          urlencode( wp_json_encode( $tag->get_settings(), JSON_FORCE_OBJECT ) ));
 *  - `TAG_LABEL = 'elementor-tag'` — core/dynamic-tags/manager.php:16.
 *
 * Why a SEPARATE pure class (not just calling the live Manager): the encoder is the #1
 * cross-runtime fidelity target — its output MUST be byte-for-byte equal to the TS mirror
 * (WP-R11). Live `tag_to_text()` needs a registered Tag instance (and its `get_settings()`),
 * which is not available in pure unit tests and is non-deterministic (the id is random). This
 * class reproduces the EXACT string transform with no WP I/O beyond `wp_json_encode`/`urlencode`
 * (both pure), so PHPUnit + the cross-runtime fixture (`dynamic.encodings.json`) can assert
 * byte-equality with a FIXED `id`.
 *
 * The single gotcha encoded here: `JSON_FORCE_OBJECT` forces `{}` (object) for an empty/assoc
 * settings array, so empty settings serialize to `{}` then urlencode to `%7B%7D` — never `[]`
 * (`%5B%5D`) and never the empty string. `wp_json_encode` is preferred over bare `json_encode`
 * because it is the EXACT function the core manager uses (it applies the same flags + WP's depth
 * default), guaranteeing byte-identity.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Pro;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Pure dynamic-tag shortcode encoder. All methods are static + side-effect-free (the only WP calls
 * are `wp_json_encode`/`urlencode`, both pure transforms).
 */
final class Dynamic_Encoder {

	/** The shortcode label — MUST equal core `Manager::TAG_LABEL` (manager.php:16). */
	const TAG_LABEL = 'elementor-tag';

	/** The urlencoded empty-settings JSON object `{}` (the #1 dynamic gotcha, §A.6). */
	const EMPTY_SETTINGS = '%7B%7D';

	/** The alphabet for the random 7-char `id` (alphanumeric, matching core's mt_rand-style ids). */
	const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

	/** The fixed length of a generated tag `id` (manager ids are 7-char alphanumeric, §A.6). */
	const ID_LENGTH = 7;

	/**
	 * Encode a dynamic-tag binding to the EXACT `tag_to_text` shortcode string (SUPPLEMENT §A.6;
	 * manager.php:141-142). Byte-identical to:
	 *   `[elementor-tag id="<id>" name="<tag>" settings="<urlencode(wp_json_encode($settings,JSON_FORCE_OBJECT))>"]`
	 *
	 * EMPTY settings -> `settings="%7B%7D"` (urlencoded `{}`), NEVER empty string. The `$id` defaults
	 * to a fresh random 7-char alphanumeric (the live ids are random); pass a fixed `$id` for stable
	 * cross-runtime fixtures + idempotency.
	 *
	 * @param string                   $tag_name The tag name (e.g. `post-title`, `acf-text`).
	 * @param array<string,mixed>|null $settings The tag's settings object (null/[] -> `{}`).
	 * @param string|null              $id       Optional fixed 7-char id; null -> random.
	 * @return string The exact shortcode string.
	 */
	public static function encode( string $tag_name, ?array $settings = array(), ?string $id = null ): string {
		$tag_id = ( null === $id || '' === $id ) ? self::random_id() : $id;

		return sprintf(
			'[%1$s id="%2$s" name="%3$s" settings="%4$s"]',
			self::TAG_LABEL,
			$tag_id,
			$tag_name,
			self::encode_settings( is_array( $settings ) ? $settings : array() )
		);
	}

	/**
	 * Encode JUST the `settings="..."` value: `urlencode(wp_json_encode($settings, JSON_FORCE_OBJECT))`
	 * (manager.php:142). Empty/assoc -> `{}` -> `%7B%7D` (JSON_FORCE_OBJECT prevents the `[]` an empty
	 * PHP array would otherwise produce). Exposed separately so callers/tests can assert the value alone.
	 *
	 * @param array<string,mixed> $settings The tag settings.
	 * @return string The urlencoded JSON object string.
	 */
	public static function encode_settings( array $settings ): string {
		if ( array() === $settings ) {
			return self::EMPTY_SETTINGS; // Fast-path: the exact `%7B%7D` literal (§A.6 gotcha).
		}

		// JSON_FORCE_OBJECT mirrors the manager EXACTLY (manager.php:142) — assoc/empty serialize as
		// `{}`/object, never `[]`. wp_json_encode is the SAME function the core manager uses (byte-id).
		$json = wp_json_encode( $settings, JSON_FORCE_OBJECT );
		if ( false === $json || null === $json ) {
			return self::EMPTY_SETTINGS; // Defensive: a non-encodable value degrades to empty `{}`.
		}

		// `urlencode()` (NOT `rawurlencode`) — the EXACT function core `Manager::tag_to_text` calls
		// (manager.php:142). It encodes a space as `+`; the worked §A.6 strings (no spaces) are identical
		// either way, but settings WITH spaces MUST follow the manager's `urlencode` for byte-identity.
		return urlencode( $json ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.urlencode_urlencode -- byte-identical to core Manager::tag_to_text (manager.php:142).
	}

	/**
	 * A random 7-char alphanumeric id (the live tag ids are 7-char random; SUPPLEMENT §A.6). Uses
	 * `wp_rand` when available (CSPRNG-backed) else `mt_rand`, so it is safe under both WP and pure
	 * PHPUnit. Determinism is NOT required here — callers needing a stable id pass `$id` to {@see encode}.
	 *
	 * @return string A 7-char [A-Za-z0-9] id.
	 */
	public static function random_id(): string {
		$alphabet = self::ID_ALPHABET;
		$max      = strlen( $alphabet ) - 1;
		$id       = '';
		for ( $i = 0; $i < self::ID_LENGTH; $i++ ) {
			// `wp_rand` (CSPRNG-backed) under WordPress; `mt_rand` only in a bare-PHPUnit context with no
			// WP. Determinism is NOT required — callers needing a stable id pass `$id` to {@see encode}.
			$index = function_exists( 'wp_rand' )
				? wp_rand( 0, $max )
				: mt_rand( 0, $max ); // phpcs:ignore WordPress.WP.AlternativeFunctions.rand_mt_rand -- bare-PHPUnit fallback only; wp_rand is used under WP.
			$id   .= $alphabet[ $index ];
		}
		return $id;
	}
}
