<?php
/**
 * Contract 18 §7 — `Fonts_Service`: the NATIVE atomic font pipeline fix + `design/fonts/install`.
 *
 * Contract authority: 18-figma-frontend.md §7 "Font system strategy" (root-cause + fix the native
 * path; carry-link demotes to non-catalog fallback) + §7-AI S4 (`elementor.design.fonts.install` —
 * woff2 under uploads + @font-face registration, Pro Custom Fonts CPT when available else kit
 * custom CSS, CAP_MANAGE, font mimes allowed on THIS path only).
 *
 * ROOT CAUSE (live-verified 2026-06-11 on the wp-stack target, pages 2658/2089/1892):
 * Elementor V4's native font pipeline DOES collect during a headless prime — the in-process
 * dispatch regenerates the atomic CSS, `Atomic_Styles_Manager::render_css()`'s `on_prop_transform`
 * hook fires for every `font-family` prop, and the values persist into the
 * `elementor_atomic_styles_fonts-{local|global}-<postId>-<context>` options (hypothesis "headless
 * prime skips the prop-transform collection" is FALSE; hypothesis "canvas template skips enqueue"
 * is FALSE — the Google link appears on a canvas page once values match). The failure is the VALUE
 * SHAPE: converted/kit-built pages store raw CSS values — quoted names (`"JetBrains Mono"`) and
 * fallback stacks (`Inter, sans-serif`, `"Bricolage Grotesque", Inter, sans-serif`) — while
 * `Fonts::get_font_type()` (includes/fonts.php:1835) is an EXACT array-key lookup against the
 * catalog (`'JetBrains Mono' => GOOGLE`). Every stored value misses, falls into the
 * `maybe_enqueue_icon_font()` branch of `Frontend::get_list_of_google_fonts_by_type()`, and is
 * silently dropped — so converted pages never natively load ANY font. (Editor-built pages store
 * bare names because the typography control picks single catalog families — that is why the
 * native path "works" for them.) SECOND value-shape miss (live-verified on page 2658's LOCAL
 * styles): converted pages mint font DESIGN VARIABLES, so the collected value is the transformed
 * `var(--font-Inter)` token — also never a catalog key. Normalization therefore resolves `var()`
 * references against the active kit's `_elementor_global_variables` before catalog matching.
 *
 * THE FIX: after every prime dispatch (the moment the options are freshly re-collected),
 * {@see Fonts_Service::normalize_collected_fonts()} rewrites each stored value into its component
 * BARE family names — quotes stripped, stacks split, CSS generic keywords and UA-only stack tokens
 * dropped, casing canonicalized against `Fonts::get_fonts()` (case-insensitive) so the frontend's
 * exact-key lookup succeeds. Non-catalog families are KEPT bare (a Pro Custom Fonts /
 * `design/fonts/install` registration matches them via the `elementor/fonts/additional_fonts`
 * filter at render time) and surfaced as warnings so callers know to install or carry them.
 *
 * `install()` implements S4: accept `{source: url|base64, family, weight, style}`, sniff REAL font
 * bytes (woff2/woff/ttf/otf magic), store the file under uploads as an attachment with the font
 * mime allowed ONLY inside this call (scoped `upload_mimes` filter — the media routes still reject
 * fonts), then register the @font-face via the Pro Custom Fonts CPT (`elementor_font` — wired into
 * the native enqueue through `additional_fonts` + `print_font_links/custom`) when Pro is active,
 * else append a marker-wrapped @font-face block to the active kit's `custom_css` page setting
 * (a plain STRING — the AF1 inverse-trap; never the `{raw:…}` object).
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
 * Native-font-pipeline normalization + the `design/fonts/install` write (contract 18 §7 / S4).
 */
final class Fonts_Service {

	/** Mirror of Elementor's `FONTS_KEY_PREFIX` (modules/atomic-widgets/styles/style-fonts.php:9). */
	const FONTS_OPTION_PREFIX = 'elementor_atomic_styles_fonts-';

	/** The atomic style-key nodes whose per-post font options the prime re-collects. */
	const STYLE_NODES = array( 'local', 'global' );

	/** The render-context segments a post's font options may exist under. */
	const CONTEXTS = array( 'frontend', 'preview' );

	/** Pro Custom Fonts CPT (Fonts_Manager::CPT) + its type taxonomy/term. */
	const PRO_FONT_CPT      = 'elementor_font';
	const PRO_FONT_TAXONOMY = 'elementor_font_type';
	const PRO_FONT_TERM     = 'custom';

	/** Pro Custom Fonts meta keys (Custom_Fonts::FONT_META_KEY / FONT_FACE_META_KEY). */
	const PRO_FONT_FILES_META = 'elementor_font_files';
	const PRO_FONT_FACE_META  = 'elementor_font_face';

	/** Pro's cached `{family: type}` map option (Fonts_Manager::FONTS_OPTION_NAME) — must refresh. */
	const PRO_FONTS_LIST_OPTION = 'elementor_fonts_manager_fonts';

	/** Hard byte ceiling for an installed font file (matches the wp-stack upload override budget). */
	const MAX_FONT_BYTES = 10485760; // 10 MiB.

	/**
	 * CSS generic keywords + UA-only stack tokens — never installable webfonts, dropped when a
	 * stored stack is split (mirrors `GENERIC_FONT_FAMILIES` in packages/server/src/convert/fonts.ts;
	 * real-but-uncatalogued system names like `Segoe UI` are deliberately KEPT and reported).
	 *
	 * @var string[]
	 */
	const GENERIC_FAMILIES = array(
		'serif',
		'sans-serif',
		'monospace',
		'cursive',
		'fantasy',
		'system-ui',
		'ui-serif',
		'ui-sans-serif',
		'ui-monospace',
		'ui-rounded',
		'emoji',
		'math',
		'fangsong',
		'inherit',
		'initial',
		'unset',
		'revert',
		'-apple-system',
		'blinkmacsystemfont',
	);

	/** Font formats accepted by `install()`: extension => mime (allowed on THIS path only — S4). */
	const FONT_MIMES = array(
		'woff2' => 'font/woff2',
		'woff'  => 'font/woff',
		'ttf'   => 'font/ttf',
		'otf'   => 'font/otf',
	);

	/** Max depth when resolving `var(--…)` references (a variable's value may itself reference one). */
	const MAX_VAR_DEPTH = 3;

	/**
	 * Per-request cache of the lowercased catalog index (`lc family => canonical family`).
	 *
	 * @var array<string,string>|null
	 */
	private static $catalog_index = null;

	/**
	 * Per-request cache of the active kit's variables (`lc label => string value`).
	 *
	 * @var array<string,string>|null
	 */
	private static $kit_variables_index = null;

	// ---------------------------------------------------------------------
	// Native-path normalization (contract 18 §7 "Font system strategy").
	// ---------------------------------------------------------------------

	/**
	 * Rewrite the freshly collected `elementor_atomic_styles_fonts-*` option values for a post into
	 * bare, catalog-matchable family names so the NATIVE frontend enqueue actually fires (see the
	 * file docblock for the live-verified root cause). Idempotent: already-bare values re-resolve to
	 * themselves and the option is left untouched. Both style nodes (`local`/`global`) and both
	 * render contexts (`frontend`/`preview`) are normalized — the prime dispatch rewrites the
	 * frontend pair, while stale preview options from editor visits are normalized opportunistically.
	 *
	 * @param int $post_id The primed post.
	 * @return array{normalized:string[],non_catalog:string[],warnings:string[]}
	 */
	public static function normalize_collected_fonts( int $post_id ): array {
		$normalized  = array();
		$non_catalog = array();

		foreach ( self::STYLE_NODES as $node ) {
			foreach ( self::CONTEXTS as $context ) {
				$key    = self::option_key( $node, $post_id, $context );
				$stored = get_option( $key, array() );
				if ( ! is_array( $stored ) || empty( $stored ) ) {
					continue;
				}

				$resolved_all = array();
				foreach ( $stored as $value ) {
					$resolved = self::resolve_stack_value( (string) $value );
					foreach ( $resolved['families'] as $family ) {
						if ( ! in_array( $family, $resolved_all, true ) ) {
							$resolved_all[] = $family;
						}
					}
					foreach ( $resolved['non_catalog'] as $family ) {
						if ( ! in_array( $family, $non_catalog, true ) ) {
							$non_catalog[] = $family;
						}
					}
				}

				if ( array_values( $stored ) === $resolved_all ) {
					continue; // Already bare names — nothing to rewrite.
				}

				if ( empty( $resolved_all ) ) {
					// Mirror Style_Fonts::update_fonts(): an empty list deletes the option.
					delete_option( $key );
				} else {
					update_option( $key, $resolved_all, false );
				}
				$normalized[] = $key;
			}
		}

		$warnings = array();
		if ( ! empty( $non_catalog ) ) {
			$warnings[] = sprintf(
				/* translators: %s: comma-separated font family names. */
				__( 'Non-catalog font families will not auto-enqueue natively: %s. Install them via design/fonts/install (or rely on the font-carry link).', 'elementor-ultra-mcp' ),
				implode( ', ', $non_catalog )
			);
		}

		return array(
			'normalized'  => $normalized,
			'non_catalog' => $non_catalog,
			'warnings'    => $warnings,
		);
	}

	/**
	 * Register the RENDER-TIME normalization of `Frontend::$fonts_to_enqueue` (contract 18 §7 —
	 * the durable half of the native-path fix).
	 *
	 * The prime-time option rewrite ({@see normalize_collected_fonts()}) is NOT durable on its own:
	 * any atomic cache invalidation (template/status settings writes, design-system flushes) makes
	 * `Atomic_Styles_Manager::before_render()` CLEAR the per-style font options and re-collect the
	 * RAW prop values (`"Fraunces, serif"`, `var(--font-Fraunces)`) during the next frontend
	 * request — LIVE-VERIFIED 2026-06-11 on page 2858 (option normalized at prime, yet
	 * `fonts_to_enqueue` carried the raw stack/var tokens at render and the exact-key catalog
	 * lookup in `Frontend::get_list_of_google_fonts_by_type()` missed again: no Google link).
	 * The durable seam is the CONSUMPTION side, where this hooks twice:
	 *
	 *  - `elementor/frontend/after_enqueue_post_styles` @ PHP_INT_MAX — right after
	 *    `Atomic_Styles_Manager::after_render()` fills the list (wp_enqueue_scripts@20, i.e.
	 *    wp_head@1) and BEFORE `print_fonts_links` (wp_head@7), so the
	 *    `elementor/fonts/register_styles` action hands every OTHER listener (Pro Custom Fonts)
	 *    the normalized names too;
	 *  - `elementor/fonts/register_styles` @ 0 — the safety net for the direct
	 *    `print_fonts_links()` call sites (kits manager, css/base.php) that bypass wp_head.
	 *
	 * `Frontend::$fonts_to_enqueue` is a PUBLIC property (includes/frontend.php:61) rewritten in
	 * place; bare names resolve to themselves, so the pass is idempotent and editor-built pages
	 * are unchanged. Non-catalog names stay bare (Pro Custom Fonts / `design/fonts/install`
	 * registrations match them via `elementor/fonts/additional_fonts` at this same seam).
	 *
	 * @return void
	 */
	public static function register_frontend_normalization() {
		add_action(
			'elementor/frontend/after_enqueue_post_styles',
			array( __CLASS__, 'normalize_fonts_to_enqueue' ),
			PHP_INT_MAX
		);
		add_action(
			'elementor/fonts/register_styles',
			array( __CLASS__, 'normalize_fonts_to_enqueue' ),
			0
		);
	}

	/**
	 * Rewrite `Frontend::$fonts_to_enqueue` in place into bare, catalog-matchable family names
	 * (stacks split, quotes/escapes stripped, `var(--…)` resolved via the active kit, generics and
	 * UA-only tokens dropped, casing canonicalized). See {@see register_frontend_normalization()}.
	 *
	 * @return void
	 */
	public static function normalize_fonts_to_enqueue() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return;
		}
		$frontend = \Elementor\Plugin::instance()->frontend;
		if ( ! is_object( $frontend ) || ! is_array( $frontend->fonts_to_enqueue ) || empty( $frontend->fonts_to_enqueue ) ) {
			return;
		}

		$resolved = array();
		foreach ( $frontend->fonts_to_enqueue as $value ) {
			$result = self::resolve_stack_value( (string) $value );
			foreach ( $result['families'] as $family ) {
				if ( ! in_array( $family, $resolved, true ) ) {
					$resolved[] = $family;
				}
			}
		}

		$frontend->fonts_to_enqueue = $resolved;
	}

	/**
	 * Register the wp_head CSS fix for multi-word font variable names that Elementor writes unquoted.
	 * Elementor generates `--font-*: Multi Word - Font Name` (unquoted) in kit CSS; the ` - ` token
	 * is a CSS delimiter, causing `font-family: var(--font-...)` to parse as invalid and fall back to
	 * the browser default (Times New Roman). A late-priority inline <style> block overrides the broken
	 * variables with properly quoted values so the actual installed fonts render.
	 *
	 * @return void
	 */
	public static function register_font_var_css_fix() {
		add_action( 'wp_head', array( __CLASS__, 'output_font_var_quote_css' ), 100 );
	}

	/**
	 * Output a `:root { --font-*: "Quoted Font Name"; }` block for any global-font-variable whose
	 * value contains unquoted multi-word parts (spaces). Runs at `wp_head@100` — after the kit CSS
	 * `<link>` is printed — so cascade order wins over the broken kit variable definitions.
	 *
	 * @return void
	 */
	public static function output_font_var_quote_css() {
		if ( ! class_exists( '\Elementor\Modules\Variables\Storage\Variables_Repository' )
			|| ! class_exists( '\Elementor\Modules\Variables\Services\Variables_Service' )
			|| ! class_exists( '\Elementor\Plugin' )
			|| ! isset( \Elementor\Plugin::$instance->kits_manager )
		) {
			return;
		}

		try {
			// Variables_Service requires (Variables_Repository $kit, Batch_Processor $bp) — mirror the
			// factory pattern in Elementor\Modules\Variables\Hooks::variables_service().
			$kit    = \Elementor\Plugin::$instance->kits_manager->get_active_kit();
			$repo   = new \Elementor\Modules\Variables\Storage\Variables_Repository( $kit );
			$bp     = new \Elementor\Modules\Variables\Services\Batch_Operations\Batch_Processor();
			$svc    = new \Elementor\Modules\Variables\Services\Variables_Service( $repo, $bp );
			$record = $svc->load();
			$data   = isset( $record['data'] ) && is_array( $record['data'] ) ? $record['data'] : array();
		} catch ( \Throwable $e ) {
			return;
		}

		$rules = array();
		foreach ( $data as $var ) {
			if ( ( $var['type'] ?? '' ) !== 'global-font-variable' ) {
				continue;
			}
			$label = isset( $var['label'] ) ? (string) $var['label'] : '';
			$value = isset( $var['value'] ) ? trim( (string) $var['value'] ) : '';
			if ( '' === $label || '' === $value ) {
				continue;
			}

			// Quote each comma-separated font family name that contains unquoted whitespace.
			$parts   = array_map( 'trim', explode( ',', $value ) );
			$fixed   = array();
			$changed = false;
			foreach ( $parts as $part ) {
				if ( '' === $part ) {
					continue;
				}
				// Already quoted — valid as-is.
				if ( '"' === $part[0] || "'" === $part[0] ) {
					$fixed[] = $part;
					continue;
				}
				// Single identifier (no whitespace) — valid CSS as-is.
				if ( ! preg_match( '/\s/', $part ) ) {
					$fixed[] = $part;
					continue;
				}
				// Multi-word, unquoted — must quote.
				$fixed[] = '"' . str_replace( '"', '\\"', $part ) . '"';
				$changed = true;
			}

			if ( ! $changed || empty( $fixed ) ) {
				continue;
			}

			// The CSS variable name matches what Elementor writes in the kit CSS: '--' . label.
			$rules[] = '--' . $label . ':' . implode( ', ', $fixed );
		}

		if ( empty( $rules ) ) {
			return;
		}

		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- CSS is generated from DB-stored variable labels/values, not user-facing output.
		echo '<style id="emcp-font-var-fix">:root{' . implode( ';', $rules ) . '}</style>' . "\n";
	}

	/**
	 * Resolve ONE stored `font-family` value (possibly a quoted name, a whole fallback stack, or a
	 * `var(--…)` design-variable reference — converted pages mint FONT VARIABLES, so the
	 * prop-transform collects `var(--font-Inter)`, live-verified on page 2658) into its component
	 * bare family names: split on top-level commas (paren-aware — `var(--x, serif)` fallbacks),
	 * resolve `var(--label)` against the active kit's `_elementor_global_variables` (the
	 * `Global_Variable_Transformer` emits `var(--<label>)`), strip quotes/escapes, collapse
	 * whitespace (incl. NBSP), drop {@see GENERIC_FAMILIES}, and canonicalize casing against the
	 * live catalog (`Fonts::get_fonts()` — which already includes `elementor/fonts/additional_fonts`
	 * extras like Pro Custom Fonts). Unmatched real names are KEPT verbatim and reported under
	 * `non_catalog`; an unresolvable `var()` is reported (never silently dropped) but not stored —
	 * the token can never match an enqueue key.
	 *
	 * @param string $value A raw stored font value (e.g. `"Bricolage Grotesque", Inter, sans-serif`).
	 * @return array{families:string[],non_catalog:string[]}
	 */
	public static function resolve_stack_value( string $value ): array {
		$families    = array();
		$non_catalog = array();
		self::resolve_stack_into( $value, $families, $non_catalog, 0 );

		return array(
			'families'    => $families,
			'non_catalog' => $non_catalog,
		);
	}

	/**
	 * Recursive worker for {@see resolve_stack_value} (depth-capped for var-in-var values).
	 *
	 * @param string   $value       Stack/value to resolve.
	 * @param string[] $families    Accumulator (by reference, deduped).
	 * @param string[] $non_catalog Accumulator (by reference, deduped).
	 * @param int      $depth       Current var-resolution depth.
	 * @return void
	 */
	private static function resolve_stack_into( string $value, array &$families, array &$non_catalog, int $depth ): void {
		$catalog = self::catalog_index();

		foreach ( self::split_stack_components( $value ) as $part ) {
			$part = trim( $part );

			// A design-variable reference: resolve the label via the active kit, else the fallback.
			if ( preg_match( '/^var\(\s*--([^,)]+?)\s*(?:,(.*))?\)$/s', $part, $m ) ) {
				$label     = strtolower( trim( $m[1] ) );
				$variables = self::kit_variables_index();
				if ( $depth < self::MAX_VAR_DEPTH && isset( $variables[ $label ] ) ) {
					self::resolve_stack_into( $variables[ $label ], $families, $non_catalog, $depth + 1 );
				} elseif ( $depth < self::MAX_VAR_DEPTH && isset( $m[2] ) && '' !== trim( $m[2] ) ) {
					self::resolve_stack_into( $m[2], $families, $non_catalog, $depth + 1 );
				} elseif ( ! in_array( $part, $non_catalog, true ) ) {
					$non_catalog[] = $part; // Honest report; the raw token is never an enqueue key.
				}
				continue;
			}

			$name = self::clean_family_name( $part );
			if ( '' === $name ) {
				continue;
			}
			$lc = strtolower( $name );
			if ( in_array( $lc, self::GENERIC_FAMILIES, true ) ) {
				continue;
			}

			if ( isset( $catalog[ $lc ] ) ) {
				$name = $catalog[ $lc ]; // Canonical catalog casing — the exact enqueue key.
			} elseif ( ! in_array( $name, $non_catalog, true ) ) {
				$non_catalog[] = $name;
			}

			if ( ! in_array( $name, $families, true ) ) {
				$families[] = $name;
			}
		}
	}

	/**
	 * Split a `font-family` value on TOP-LEVEL commas only (commas inside `var(--x, fallback)` /
	 * any parenthesized term stay attached to their component).
	 *
	 * @param string $value The raw value.
	 * @return string[]
	 */
	public static function split_stack_components( string $value ): array {
		$out   = array();
		$depth = 0;
		$buf   = '';
		$len   = strlen( $value );
		for ( $i = 0; $i < $len; $i++ ) {
			$ch = $value[ $i ]; // Byte-wise is safe: parens/commas are ASCII; UTF-8 passes through.
			if ( '(' === $ch ) {
				++$depth;
			} elseif ( ')' === $ch ) {
				$depth = max( 0, $depth - 1 );
			} elseif ( ',' === $ch && 0 === $depth ) {
				$out[] = $buf;
				$buf   = '';
				continue;
			}
			$buf .= $ch;
		}
		if ( '' !== trim( $buf ) ) {
			$out[] = $buf;
		}
		return $out;
	}

	/**
	 * The active kit's design variables as `lc label => string value` (the CSS custom property the
	 * `Global_Variable_Transformer` emits is `--<label>`). Values keep their raw string (possibly a
	 * stack with escaped quotes — `clean_family_name` handles them downstream). Deleted variables
	 * and non-string values are skipped. Cached per request; empty when no kit/meta exists.
	 *
	 * @return array<string,string>
	 */
	private static function kit_variables_index(): array {
		if ( null !== self::$kit_variables_index ) {
			return self::$kit_variables_index;
		}

		$index  = array();
		$kit_id = (int) get_option( 'elementor_active_kit', 0 );
		if ( $kit_id > 0 ) {
			$raw     = get_post_meta( $kit_id, '_elementor_global_variables', true );
			$decoded = is_string( $raw ) ? json_decode( $raw, true ) : ( is_array( $raw ) ? $raw : null );
			$data    = isset( $decoded['data'] ) && is_array( $decoded['data'] ) ? $decoded['data'] : array();
			foreach ( $data as $variable ) {
				if ( ! is_array( $variable ) || empty( $variable['label'] ) || ! empty( $variable['deleted'] ) ) {
					continue;
				}
				$value = isset( $variable['value']['value'] ) ? $variable['value']['value'] : null;
				if ( ! is_string( $value ) || '' === trim( $value ) ) {
					continue;
				}
				$index[ strtolower( (string) $variable['label'] ) ] = $value;
			}
		}

		self::$kit_variables_index = $index;
		return $index;
	}

	/**
	 * One family-name fragment, cleaned: backslash escapes removed, whitespace (incl. NBSP)
	 * collapsed, surrounding straight/typographic quotes stripped.
	 *
	 * @param string $name Raw fragment (one comma-separated stack entry).
	 */
	public static function clean_family_name( string $name ): string {
		$name = str_replace( array( '\\"', "\\'" ), array( '"', "'" ), $name );
		$name = (string) preg_replace( '/[\s\x{00a0}]+/u', ' ', $name );
		$name = trim( $name );
		$name = (string) preg_replace( '/^["\'\x{2018}\x{2019}\x{201c}\x{201d}]+|["\'\x{2018}\x{2019}\x{201c}\x{201d}]+$/u', '', $name );
		return trim( $name );
	}

	/**
	 * The lowercased `lc family => canonical family` catalog index (Google + system + the
	 * `additional_fonts` filter extras — Pro Custom Fonts included). Cached per request; empty when
	 * Elementor is unavailable (normalization then still splits/unquotes, which is strictly better
	 * than stacks).
	 *
	 * @return array<string,string>
	 */
	private static function catalog_index(): array {
		if ( null !== self::$catalog_index ) {
			return self::$catalog_index;
		}

		$index = array();
		if ( class_exists( '\Elementor\Fonts' ) ) {
			try {
				foreach ( array_keys( \Elementor\Fonts::get_fonts() ) as $family ) {
					$index[ strtolower( (string) $family ) ] = (string) $family;
				}
			} catch ( \Throwable $e ) {
				unset( $e ); // Degrade to no canonicalization.
			}
		}

		self::$catalog_index = $index;
		return $index;
	}

	/** Drop the per-request caches (tests; after an install registers a new family). */
	public static function flush_catalog_index(): void {
		self::$catalog_index       = null;
		self::$kit_variables_index = null;
	}

	/**
	 * The `elementor_atomic_styles_fonts-<node>-<postId>-<context>` option key. Uses Elementor's own
	 * prefix const when loaded so a rename upstream surfaces here.
	 *
	 * @param string $node    `local`|`global`.
	 * @param int    $post_id Post id.
	 * @param string $context `frontend`|`preview`.
	 */
	public static function option_key( string $node, int $post_id, string $context ): string {
		$prefix = defined( '\Elementor\Modules\AtomicWidgets\Styles\FONTS_KEY_PREFIX' )
			? constant( '\Elementor\Modules\AtomicWidgets\Styles\FONTS_KEY_PREFIX' )
			: self::FONTS_OPTION_PREFIX;

		return $prefix . $node . '-' . $post_id . '-' . $context;
	}

	// ---------------------------------------------------------------------
	// design/fonts — list installed non-catalog font families.
	// ---------------------------------------------------------------------

	/**
	 * Return the family names of all non-catalog fonts installed on this site.
	 *
	 * Sources (checked in order):
	 *  1. Pro Custom Fonts CPT (`elementor_font` post titles) — the native enqueue path.
	 *  2. @font-face blocks emitted into the active kit's `custom_css` STRING (Free fallback) by
	 *     {@see install()} — extracted via a simple regex on the font-family declaration.
	 *
	 * The returned strings are the EXACT family names callers should put in `font-family` props.
	 *
	 * @return string[]
	 */
	public static function list_installed_families(): array {
		$families = array();

		// 1. Pro Custom Fonts CPT.
		if ( post_type_exists( self::PRO_FONT_CPT ) ) {
			$posts = get_posts(
				array(
					'post_type'   => self::PRO_FONT_CPT,
					'numberposts' => -1,
					'post_status' => 'publish',
				)
			);
			foreach ( $posts as $p ) {
				$title = trim( $p->post_title );
				if ( '' !== $title && ! in_array( $title, $families, true ) ) {
					$families[] = $title;
				}
			}
		}

		// 2. Kit custom_css @font-face blocks (Free path — families installed via install() only).
		$kit_id = (int) get_option( 'elementor_active_kit', 0 );
		if ( $kit_id > 0 ) {
			$settings = get_post_meta( $kit_id, '_elementor_page_settings', true );
			$css      = '';
			if ( is_array( $settings ) && isset( $settings['custom_css'] ) ) {
				$val = $settings['custom_css'];
				$css = is_string( $val ) ? $val : ( isset( $val['raw'] ) ? (string) base64_decode( $val['raw'] ) : '' );
			}
			if ( '' !== $css ) {
				// Extract font-family from each @font-face block (handles quoted and unquoted names).
				preg_match_all(
					'/@font-face\s*\{[^}]*font-family\s*:\s*["\']?([^"\';\}\n]+)["\']?/i',
					$css,
					$m
				);
				foreach ( $m[1] as $raw ) {
					$fam = self::clean_family_name( $raw );
					if ( '' !== $fam && ! in_array( $fam, $families, true ) ) {
						$families[] = $fam;
					}
				}
			}
		}

		return $families;
	}

	// ---------------------------------------------------------------------
	// design/fonts/upload-zip — bulk ZIP installer.
	// ---------------------------------------------------------------------

	/**
	 * Extract a base64-encoded ZIP and install every OTF/TTF/WOFF/WOFF2 font file found inside.
	 * Family names and weights are read from the OTF/TTF name table automatically.
	 *
	 * @param string $base64_zip Base64-encoded ZIP content.
	 * @return array{installed: array<mixed>, skipped: string[]}|WP_Error
	 */
	public static function install_from_zip( string $base64_zip ) {
		set_time_limit( 300 ); // font uploads can be slow; 5 min ceiling

		if ( ! class_exists( 'ZipArchive' ) ) {
			return new WP_Error( 'VALIDATION_FAILED', 'ZipArchive PHP extension is not available.' );
		}

		$zip_bytes = base64_decode( $base64_zip, true );
		if ( false === $zip_bytes || '' === $zip_bytes ) {
			return new WP_Error( 'VALIDATION_FAILED', 'zip_data is not valid base64.' );
		}

		$tmp_zip = tempnam( sys_get_temp_dir(), 'emcp_fz_' ) . '.zip';
		file_put_contents( $tmp_zip, $zip_bytes );

		$zip = new \ZipArchive();
		if ( true !== $zip->open( $tmp_zip ) ) {
			unlink( $tmp_zip );
			return new WP_Error( 'VALIDATION_FAILED', 'Cannot open ZIP archive — ensure zip_data is a valid ZIP file.' );
		}

		$installed = array();
		$skipped   = array();
		$font_exts = array( 'otf', 'ttf', 'woff', 'woff2' );

		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$entry = $zip->getNameIndex( $i );
			if ( false === $entry || '/' === substr( $entry, -1 ) ) {
				continue; // directory entry
			}
			$filename = basename( $entry );
			$ext      = strtolower( pathinfo( $filename, PATHINFO_EXTENSION ) );
			if ( ! in_array( $ext, $font_exts, true ) ) {
				$skipped[] = $filename;
				continue;
			}

			$font_bytes = $zip->getFromIndex( $i );
			if ( false === $font_bytes ) {
				$skipped[] = $filename;
				continue;
			}

			// Read family/weight/style from the font's name table (OTF/TTF only).
			$meta = null;
			if ( in_array( $ext, array( 'otf', 'ttf' ), true ) ) {
				$meta = self::parse_sfnt_name( $font_bytes );
			}
			if ( null === $meta ) {
				$skipped[] = $filename;
				continue;
			}

			// Build a data-URI source so PHP doesn't attempt a self-HTTP request.
			$source = 'data:font/' . $ext . ';base64,' . base64_encode( $font_bytes );
			$result = self::install(
				array(
					'source' => $source,
					'family' => $meta['family'],
					'weight' => $meta['weight'],
					'style'  => $meta['style'],
				)
			);
			if ( $result instanceof WP_Error ) {
				$skipped[] = $filename . ' (' . $result->get_error_message() . ')';
			} else {
				$installed[] = $result;
			}
		}

		$zip->close();
		@unlink( $tmp_zip );

		return array(
			'installed' => $installed,
			'skipped'   => $skipped,
		);
	}

	/**
	 * Parse the OTF/TTF name table to extract family name, weight, and style.
	 *
	 * @param string $bytes Raw font bytes.
	 * @return array{family:string,weight:int,style:string}|null Null when the name table is unreadable.
	 */
	private static function parse_sfnt_name( string $bytes ): ?array {
		$len = strlen( $bytes );
		if ( $len < 12 ) {
			return null;
		}

		// sfnt header: sfVersion(4) numTables(2) searchRange(2) entrySelector(2) rangeShift(2)
		$num_tables = unpack( 'n', substr( $bytes, 4, 2 ) )[1];

		// Find the 'name' table in the table directory (each record = 16 bytes after the 12-byte header).
		$name_table_offset = null;
		for ( $i = 0; $i < $num_tables && $i < 64; $i++ ) {
			$off = 12 + $i * 16;
			if ( $off + 16 > $len ) {
				break;
			}
			if ( substr( $bytes, $off, 4 ) === 'name' ) {
				$name_table_offset = unpack( 'N', substr( $bytes, $off + 8, 4 ) )[1];
				break;
			}
		}
		if ( null === $name_table_offset || $name_table_offset + 6 > $len ) {
			return null;
		}

		// Name table header: format(2) count(2) stringOffset(2)
		$count    = unpack( 'n', substr( $bytes, $name_table_offset + 2, 2 ) )[1];
		$str_base = $name_table_offset + unpack( 'n', substr( $bytes, $name_table_offset + 4, 2 ) )[1];

		// Read name records (each = 12 bytes).
		$names = array();
		for ( $i = 0; $i < $count && $i < 300; $i++ ) {
			$r = $name_table_offset + 6 + $i * 12;
			if ( $r + 12 > $len ) {
				break;
			}
			$parts    = unpack( 'nplatform/nenc/nlang/nname_id/nlength/noffset', substr( $bytes, $r, 12 ) );
			$platform = (int) $parts['platform'];
			$name_id  = (int) $parts['name_id'];
			$str_off  = $str_base + (int) $parts['offset'];
			$str_len  = (int) $parts['length'];
			if ( $str_off < 0 || $str_off + $str_len > $len ) {
				continue;
			}
			$raw = substr( $bytes, $str_off, $str_len );
			if ( 3 === $platform ) {
				// Windows (3) = UTF-16BE
				$str = mb_convert_encoding( $raw, 'UTF-8', 'UTF-16BE' );
			} elseif ( 1 === $platform ) {
				// Macintosh (1) — assume ASCII (good enough for Latin-script font names)
				$str = preg_replace( '/[^\x20-\x7E]/', '', $raw );
			} else {
				$str = $raw;
			}
			$str = trim( (string) $str );
			if ( '' !== $str ) {
				$names[ $name_id ][ $platform ] = $str;
			}
		}

		// NameID 16 = Typographic Family (preferred), 1 = Font Family, 2 = Subfamily (weight/style).
		$family = $names[16][3] ?? $names[16][1] ?? $names[1][3] ?? $names[1][1] ?? null;
		if ( null === $family ) {
			return null;
		}

		$subfamily = strtolower( (string) ( $names[2][3] ?? $names[2][1] ?? '' ) );
		$weight    = self::weight_from_subfamily( $subfamily );
		// If subfamily gives default weight (400/Regular) but the family name itself encodes a weight,
		// prefer the family name (e.g. "FONTSPRING DEMO - Armin Soft SemiBold" / subfamily "Regular").
		if ( 400 === $weight ) {
			$family_weight = self::weight_from_subfamily( strtolower( $family ) );
			if ( 400 !== $family_weight ) {
				$weight = $family_weight;
			}
		}
		$style = ( str_contains( $subfamily, 'italic' ) || str_contains( $subfamily, 'oblique' ) )
			? 'italic'
			: 'normal';

		return array(
			'family' => $family,
			'weight' => $weight,
			'style'  => $style,
		);
	}

	/**
	 * Map a subfamily string (e.g. "semibold italic") to a numeric CSS weight.
	 *
	 * @param string $sub Lowercase subfamily name.
	 * @return int CSS weight value.
	 */
	private static function weight_from_subfamily( string $sub ): int {
		if ( str_contains( $sub, 'thin' ) ) {
			return 100;
		}
		if ( str_contains( $sub, 'extralight' ) ) {
			return 200;
		}
		if ( str_contains( $sub, 'extra light' ) ) {
			return 200;
		}
		if ( str_contains( $sub, 'ultralight' ) ) {
			return 200;
		}
		if ( str_contains( $sub, 'ultra light' ) ) {
			return 200;
		}
		if ( str_contains( $sub, 'light' ) ) {
			return 300;
		}
		if ( str_contains( $sub, 'medium' ) ) {
			return 500;
		}
		if ( str_contains( $sub, 'demibold' ) ) {
			return 600;
		}
		if ( str_contains( $sub, 'demi bold' ) ) {
			return 600;
		}
		if ( str_contains( $sub, 'semibold' ) ) {
			return 600;
		}
		if ( str_contains( $sub, 'semi bold' ) ) {
			return 600;
		}
		if ( str_contains( $sub, 'extrabold' ) ) {
			return 800;
		}
		if ( str_contains( $sub, 'extra bold' ) ) {
			return 800;
		}
		if ( str_contains( $sub, 'ultrabold' ) ) {
			return 800;
		}
		if ( str_contains( $sub, 'ultra bold' ) ) {
			return 800;
		}
		if ( str_contains( $sub, 'heavy' ) ) {
			return 800;
		}
		if ( str_contains( $sub, 'black' ) ) {
			return 900;
		}
		if ( str_contains( $sub, 'bold' ) ) {
			return 700;
		}
		return 400;
	}

	// ---------------------------------------------------------------------
	// design/fonts/install (contract 18 §7-AI S4).
	// ---------------------------------------------------------------------

	/**
	 * Install a NON-catalog font face: acquire the bytes (`source` = http(s) URL, data-URI, or raw
	 * base64), sniff the REAL format from magic bytes, store the file under uploads as an attachment
	 * (font mime allowed inside this call only), and register the @font-face — Pro Custom Fonts CPT
	 * when available (native enqueue path), else the active kit's `custom_css` STRING setting.
	 *
	 * @param array<string,mixed> $args `{source, family, weight?, style?}`.
	 * @return array<string,mixed>|WP_Error The route `data` payload, or a taxonomy `WP_Error`.
	 */
	public static function install( array $args ) {
		$family = isset( $args['family'] ) ? sanitize_text_field( (string) $args['family'] ) : '';
		$family = self::clean_family_name( $family );
		if ( '' === $family ) {
			return self::invalid( __( 'A non-empty `family` is required.', 'elementor-ultra-mcp' ), array( 'path' => 'family' ) );
		}

		$weight = self::normalize_weight( isset( $args['weight'] ) ? $args['weight'] : '400' );
		if ( null === $weight ) {
			return self::invalid(
				__( 'Invalid `weight`: use a numeric weight 1-1000 (or normal/bold).', 'elementor-ultra-mcp' ),
				array( 'path' => 'weight' )
			);
		}

		$style = isset( $args['style'] ) ? strtolower( trim( (string) $args['style'] ) ) : 'normal';
		if ( ! in_array( $style, array( 'normal', 'italic', 'oblique' ), true ) ) {
			return self::invalid(
				__( 'Invalid `style`: use normal|italic|oblique.', 'elementor-ultra-mcp' ),
				array( 'path' => 'style' )
			);
		}

		$source = isset( $args['source'] ) ? trim( (string) $args['source'] ) : '';
		if ( '' === $source ) {
			return self::invalid( __( 'A non-empty `source` (URL or base64) is required.', 'elementor-ultra-mcp' ), array( 'path' => 'source' ) );
		}

		$bytes = self::acquire_bytes( $source );
		if ( $bytes instanceof WP_Error ) {
			return $bytes;
		}

		$ext = self::sniff_font_format( $bytes );
		if ( null === $ext ) {
			return self::invalid(
				__( 'The source bytes are not a recognized font (woff2/woff/ttf/otf magic expected).', 'elementor-ultra-mcp' ),
				array( 'path' => 'source' ),
				422
			);
		}

		// ── Store under uploads as an attachment (font mimes scoped to THIS call — S4). ──────────
		$filename = sanitize_file_name(
			strtolower( str_replace( ' ', '-', $family ) ) . '-' . $weight . ( 'normal' === $style ? '' : '-' . $style ) . '.' . $ext
		);

		$stored = self::run_with_font_mimes(
			static function () use ( $filename, $bytes ) {
				return wp_upload_bits( $filename, null, $bytes );
			}
		);
		if ( ! is_array( $stored ) || ! empty( $stored['error'] ) ) {
			return self::invalid(
				sprintf(
					/* translators: %s: upload error detail. */
					__( 'Could not store the font file: %s', 'elementor-ultra-mcp' ),
					is_array( $stored ) ? (string) $stored['error'] : 'unknown error'
				),
				array( 'filename' => $filename ),
				422
			);
		}

		$mime          = self::FONT_MIMES[ $ext ];
		$attachment_id = self::run_with_font_mimes(
			static function () use ( $stored, $filename, $mime ) {
				return wp_insert_attachment(
					array(
						'post_mime_type' => $mime,
						'post_title'     => preg_replace( '/\.[^.]+$/', '', $filename ),
						'post_content'   => '',
						'post_status'    => 'inherit',
						'guid'           => $stored['url'],
					),
					$stored['file'],
					0,
					true
				);
			}
		);
		if ( is_wp_error( $attachment_id ) ) {
			return self::invalid( $attachment_id->get_error_message(), array( 'filename' => $filename ), 422 );
		}
		$attachment_id = (int) $attachment_id;

		// ── Register the @font-face. ──────────────────────────────────────────────────────────────
		$font_face = self::build_font_face_css( $family, $weight, $style, $ext, (string) $stored['url'] );
		$warnings  = array();

		if ( self::pro_custom_fonts_available() ) {
			$registered_via = 'pro_custom_fonts';
			$result         = self::register_pro_custom_font( $family, $weight, $style, $ext, (string) $stored['url'], $attachment_id );
			if ( $result instanceof WP_Error ) {
				return $result;
			}
			$font_face = $result; // The regenerated full font-face for the family.
		} else {
			$registered_via = 'kit_custom_css';
			$kit_result     = self::register_kit_custom_css( $family, $weight, $style, $font_face );
			if ( $kit_result instanceof WP_Error ) {
				return $kit_result;
			}
			$warnings[] = __( 'Elementor Pro is not active: the @font-face was appended to the kit custom_css setting, which only renders with Pro. Prefer installing Pro Custom Fonts for the native enqueue path.', 'elementor-ultra-mcp' );
		}

		// New family registrations change the additional_fonts catalog — drop the request cache so a
		// same-request prime canonicalizes against the fresh index.
		self::flush_catalog_index();

		return array(
			'family'         => $family,
			'weight'         => $weight,
			'style'          => $style,
			'format'         => $ext,
			'attachment_id'  => $attachment_id,
			'url'            => (string) $stored['url'],
			'registered_via' => $registered_via,
			'font_face'      => $font_face,
			'warnings'       => $warnings,
		);
	}

	/**
	 * Acquire the font bytes from `source`: an http(s) URL (downloaded server-side), a `data:` URI,
	 * or raw base64. Size-capped at {@see MAX_FONT_BYTES}.
	 *
	 * @param string $source URL / data-URI / base64 payload.
	 * @return string|WP_Error Raw bytes.
	 */
	private static function acquire_bytes( string $source ) {
		if ( preg_match( '#^https?://#i', $source ) ) {
			if ( ! function_exists( 'download_url' ) ) {
				require_once ABSPATH . 'wp-admin/includes/file.php';
			}
			$tmp = download_url( $source, 30 );
			if ( is_wp_error( $tmp ) ) {
				return self::invalid(
					sprintf(
						/* translators: %s: download error detail. */
						__( 'Could not download the font source: %s', 'elementor-ultra-mcp' ),
						$tmp->get_error_message()
					),
					array( 'path' => 'source' ),
					422
				);
			}
			$size = (int) @filesize( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			if ( $size <= 0 || $size > self::MAX_FONT_BYTES ) {
				wp_delete_file( $tmp );
				return self::invalid( __( 'The downloaded font file is empty or exceeds the 10 MiB budget.', 'elementor-ultra-mcp' ), array( 'path' => 'source' ), 422 );
			}
			$bytes = (string) @file_get_contents( $tmp ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents, WordPress.PHP.NoSilencedErrors.Discouraged
			wp_delete_file( $tmp );
			if ( '' === $bytes ) {
				return self::invalid( __( 'The downloaded font file could not be read.', 'elementor-ultra-mcp' ), array( 'path' => 'source' ), 422 );
			}
			return $bytes;
		}

		// data-URI prefix (`data:font/woff2;base64,....`) → strip to the payload.
		if ( 0 === strpos( $source, 'data:' ) ) {
			$comma  = strpos( $source, ',' );
			$source = false !== $comma ? substr( $source, $comma + 1 ) : '';
		}

		// Benign decode of the caller-supplied font payload; the result is magic-byte-gated before any write.
		$bytes = base64_decode( $source, true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		if ( false === $bytes || '' === $bytes ) {
			return self::invalid( __( 'The `source` is neither an http(s) URL nor valid base64.', 'elementor-ultra-mcp' ), array( 'path' => 'source' ) );
		}
		if ( strlen( $bytes ) > self::MAX_FONT_BYTES ) {
			return self::invalid( __( 'The decoded font payload exceeds the 10 MiB budget.', 'elementor-ultra-mcp' ), array( 'path' => 'source' ), 422 );
		}
		return $bytes;
	}

	/**
	 * Sniff the REAL font format from the magic bytes (never trust a filename/extension):
	 * `wOF2` → woff2, `wOFF` → woff, `\0\1\0\0`/`true` → ttf, `OTTO` → otf. Anything else → null.
	 *
	 * @param string $bytes Raw file bytes.
	 * @return string|null The {@see FONT_MIMES} extension key, or null when not a known font.
	 */
	public static function sniff_font_format( string $bytes ): ?string {
		$magic = substr( $bytes, 0, 4 );
		if ( 'wOF2' === $magic ) {
			return 'woff2';
		}
		if ( 'wOFF' === $magic ) {
			return 'woff';
		}
		if ( "\x00\x01\x00\x00" === $magic || 'true' === $magic ) {
			return 'ttf';
		}
		if ( 'OTTO' === $magic ) {
			return 'otf';
		}
		return null;
	}

	/**
	 * Normalize a weight input: ints/numeric strings 1-1000 pass through, `normal`→400, `bold`→700.
	 * Variable ranges are out of scope for v1 (install one static face per call).
	 *
	 * @param mixed $weight Caller weight.
	 * @return string|null Normalized numeric string, or null when invalid.
	 */
	public static function normalize_weight( $weight ): ?string {
		if ( is_string( $weight ) ) {
			$lc = strtolower( trim( $weight ) );
			if ( 'normal' === $lc ) {
				return '400';
			}
			if ( 'bold' === $lc ) {
				return '700';
			}
			$weight = $lc;
		}
		if ( is_numeric( $weight ) ) {
			$n = (int) $weight;
			if ( $n >= 1 && $n <= 1000 && (string) $n === (string) $weight ) {
				return (string) $n;
			}
		}
		return null;
	}

	/**
	 * Run `$fn` with the {@see FONT_MIMES} temporarily allowed as upload mimes (plus the
	 * filetype-and-ext fix — finfo reports font files as `application/octet-stream`). Scoped to the
	 * single call so the relaxation NEVER leaks past this install path (S4: "font mimes allowed on
	 * this path only"; mirrors the media controller's `run_with_svg_mime`). The magic-byte sniff is
	 * the real gate — only verified font bytes reach this helper.
	 *
	 * @param callable $fn The guarded operation.
	 * @return mixed
	 */
	private static function run_with_font_mimes( callable $fn ) {
		$mimes = self::FONT_MIMES;

		$add = static function ( $allowed ) use ( $mimes ) {
			return array_merge( $allowed, $mimes );
		};
		$fix = static function ( $data, $file, $filename ) use ( $mimes ) {
			$ext = strtolower( (string) pathinfo( (string) $filename, PATHINFO_EXTENSION ) );
			if ( isset( $mimes[ $ext ] ) ) {
				$data['ext']  = $ext;
				$data['type'] = $mimes[ $ext ];
			}
			return $data;
		};
		add_filter( 'upload_mimes', $add );
		add_filter( 'wp_check_filetype_and_ext', $fix, 10, 3 );
		try {
			return $fn();
		} finally {
			remove_filter( 'upload_mimes', $add );
			remove_filter( 'wp_check_filetype_and_ext', $fix, 10 );
		}
	}

	/**
	 * Build one @font-face block (same output format as Pro's
	 * `Custom_Fonts::get_font_face_from_data()` so both registration paths render identically).
	 *
	 * @param string $family Family name.
	 * @param string $weight Numeric weight string.
	 * @param string $style  normal|italic|oblique.
	 * @param string $ext    File extension key.
	 * @param string $url    Stored file URL.
	 */
	public static function build_font_face_css( string $family, string $weight, string $style, string $ext, string $url ): string {
		$format = 'ttf' === $ext ? 'truetype' : ( 'otf' === $ext ? 'opentype' : $ext );

		$css  = '@font-face {' . PHP_EOL;
		$css .= "\tfont-family: '" . $family . "';" . PHP_EOL;
		$css .= "\tfont-style: " . $style . ';' . PHP_EOL;
		$css .= "\tfont-weight: " . $weight . ';' . PHP_EOL;
		$css .= "\tfont-display: auto;" . PHP_EOL;
		$css .= "\tsrc: url('" . esc_attr( $url ) . "') format('" . $format . "');" . PHP_EOL . '}';

		return $css;
	}

	/** True when the Pro Custom Fonts CPT path is usable (Pro active + CPT registered). */
	public static function pro_custom_fonts_available(): bool {
		return class_exists( '\ElementorPro\Modules\AssetsManager\AssetTypes\Fonts_Manager' )
			&& post_type_exists( self::PRO_FONT_CPT );
	}

	/**
	 * Register/extend the family's `elementor_font` CPT post: upsert the weight+style row in the
	 * `elementor_font_files` meta (the repeater rows Pro's metabox would write), regenerate the
	 * `elementor_font_face` meta, set the type term, and refresh Pro's cached family list so the
	 * `elementor/fonts/additional_fonts` filter (→ `Fonts::get_font_type()` = `custom`) and the
	 * `elementor/fonts/print_font_links/custom` printer pick the family up on the next render.
	 *
	 * @param string $family        Family (the CPT post_title — Pro resolves font data BY TITLE).
	 * @param string $weight        Numeric weight string.
	 * @param string $style         normal|italic|oblique.
	 * @param string $ext           Stored format key.
	 * @param string $url           Stored file URL.
	 * @param int    $attachment_id Stored attachment id.
	 * @return string|WP_Error The regenerated @font-face CSS for the whole family.
	 */
	private static function register_pro_custom_font( string $family, string $weight, string $style, string $ext, string $url, int $attachment_id ) {
		$existing = get_posts(
			array(
				'post_type'      => self::PRO_FONT_CPT,
				'title'          => $family,
				'post_status'    => 'any',
				'posts_per_page' => 1,
				'fields'         => 'ids',
			)
		);
		$post_id  = ! empty( $existing ) ? (int) $existing[0] : 0;

		if ( $post_id <= 0 ) {
			$inserted = wp_insert_post(
				array(
					'post_type'   => self::PRO_FONT_CPT,
					'post_title'  => $family,
					'post_status' => 'publish',
				),
				true
			);
			if ( is_wp_error( $inserted ) ) {
				return self::invalid( $inserted->get_error_message(), array( 'path' => 'family' ), 422 );
			}
			$post_id = (int) $inserted;
		}

		// Upsert the weight+style row (Pro repeater shape: font_weight/font_style + per-format {url,id}).
		$rows = get_post_meta( $post_id, self::PRO_FONT_FILES_META, true );
		if ( ! is_array( $rows ) ) {
			$rows = array();
		}
		$matched = false;
		foreach ( $rows as $i => $row ) {
			if ( is_array( $row )
				&& isset( $row['font_weight'], $row['font_style'] )
				&& (string) $row['font_weight'] === $weight
				&& (string) $row['font_style'] === $style ) {
				$rows[ $i ][ $ext ] = array(
					'url' => $url,
					'id'  => $attachment_id,
				);
				$matched            = true;
				break;
			}
		}
		if ( ! $matched ) {
			$rows[] = array(
				'font_weight' => $weight,
				'font_style'  => $style,
				$ext          => array(
					'url' => $url,
					'id'  => $attachment_id,
				),
			);
		}
		update_post_meta( $post_id, self::PRO_FONT_FILES_META, $rows );

		// Regenerate the family's full font-face CSS — prefer Pro's own generator (byte-identical to
		// what the metabox save produces), fall back to our compatible builder.
		$font_face = self::pro_generate_font_face( $post_id );
		if ( null === $font_face ) {
			$font_face = '';
			foreach ( $rows as $row ) {
				if ( ! is_array( $row ) ) {
					continue;
				}
				foreach ( array_keys( self::FONT_MIMES ) as $row_ext ) {
					if ( isset( $row[ $row_ext ]['url'] ) ) {
						$font_face .= self::build_font_face_css(
							$family,
							isset( $row['font_weight'] ) ? (string) $row['font_weight'] : '400',
							isset( $row['font_style'] ) ? (string) $row['font_style'] : 'normal',
							$row_ext,
							(string) $row[ $row_ext ]['url']
						) . PHP_EOL;
						break; // One src per row — the best available format wins.
					}
				}
			}
		}
		update_post_meta( $post_id, self::PRO_FONT_FACE_META, $font_face );

		if ( taxonomy_exists( self::PRO_FONT_TAXONOMY ) ) {
			wp_set_object_terms( $post_id, self::PRO_FONT_TERM, self::PRO_FONT_TAXONOMY, false );
		}

		// Refresh Pro's cached `{family: type}` list (register_fonts_in_control regenerates lazily).
		delete_option( self::PRO_FONTS_LIST_OPTION );

		return $font_face;
	}

	/**
	 * Run Pro's own `Custom_Fonts::generate_font_face()` when the assets-manager object graph is
	 * reachable; null otherwise (caller falls back to the compatible builder).
	 *
	 * @param int $post_id The `elementor_font` post.
	 */
	private static function pro_generate_font_face( int $post_id ): ?string {
		try {
			if ( ! class_exists( '\ElementorPro\Plugin' ) ) {
				return null;
			}
			$modules = \ElementorPro\Plugin::instance()->modules_manager;
			if ( ! $modules || ! method_exists( $modules, 'get_modules' ) ) {
				return null;
			}
			$assets = $modules->get_modules( 'assets-manager' );
			if ( ! $assets || ! method_exists( $assets, 'get_assets_manager' ) ) {
				return null;
			}
			$fonts_manager = $assets->get_assets_manager( 'font' );
			if ( ! $fonts_manager || ! method_exists( $fonts_manager, 'get_font_type_object' ) ) {
				return null;
			}
			$custom = $fonts_manager->get_font_type_object( self::PRO_FONT_TERM );
			if ( ! $custom || ! method_exists( $custom, 'generate_font_face' ) ) {
				return null;
			}
			$css = $custom->generate_font_face( $post_id );
			return is_string( $css ) ? $css : null;
		} catch ( \Throwable $e ) {
			unset( $e );
			return null;
		}
	}

	/**
	 * Fallback registration without Pro: append/replace a marker-wrapped @font-face block in the
	 * active kit's `custom_css` page setting. The setting is a plain STRING — the AF1 inverse-trap
	 * pair (style-variant custom_css is `{raw: base64}`; page/kit-settings custom_css is a string;
	 * an object here fatals Pro's custom-css module) — so this writer refuses to touch a non-string.
	 *
	 * @param string $family    Family name.
	 * @param string $weight    Numeric weight string.
	 * @param string $style     normal|italic|oblique.
	 * @param string $font_face The @font-face block to register.
	 * @return true|WP_Error
	 */
	private static function register_kit_custom_css( string $family, string $weight, string $style, string $font_face ) {
		$kit = null;
		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->kits_manager ) ) {
			$kit = \Elementor\Plugin::$instance->kits_manager->get_active_kit();
		}
		if ( ! $kit || ! method_exists( $kit, 'update_settings' ) ) {
			return self::invalid(
				__( 'Neither Pro Custom Fonts nor an active Elementor kit is available to register the @font-face.', 'elementor-ultra-mcp' ),
				array(),
				422
			);
		}

		$current = '';
		if ( method_exists( $kit, 'get_settings' ) ) {
			$current = $kit->get_settings( 'custom_css' );
		}
		if ( null === $current || '' === $current ) {
			$current = '';
		}
		if ( ! is_string( $current ) ) {
			return self::invalid(
				__( 'The kit custom_css setting is not a string (AF1 trap) — refusing to merge the @font-face. Fix the kit setting first (update_settings {custom_css: ""}).', 'elementor-ultra-mcp' ),
				array( 'path' => 'custom_css' ),
				422
			);
		}

		$slug  = sanitize_title( $family . '-' . $weight . '-' . $style );
		$open  = '/* emcp-font:' . $slug . ' */';
		$close = '/* /emcp-font:' . $slug . ' */';
		$block = $open . PHP_EOL . $font_face . PHP_EOL . $close;

		$pattern = '/' . preg_quote( $open, '/' ) . '.*?' . preg_quote( $close, '/' ) . '/s';
		if ( preg_match( $pattern, $current ) ) {
			$updated = (string) preg_replace( $pattern, $block, $current );
		} else {
			$updated = ( '' === trim( $current ) ? '' : rtrim( $current ) . PHP_EOL . PHP_EOL ) . $block;
		}

		$kit->update_settings( array( 'custom_css' => $updated ) );
		return true;
	}

	/**
	 * Build a 400/422 `VALIDATION_FAILED` taxonomy error (12-error-taxonomy.md §4 — the TS client
	 * maps the wire slug back to `VALIDATION_FAILED`).
	 *
	 * @param string              $message Human, actionable message.
	 * @param array<string,mixed> $meta    Structured context.
	 * @param int                 $status  HTTP status (default 400).
	 */
	private static function invalid( string $message, array $meta = array(), int $status = 400 ): WP_Error {
		if ( class_exists( '\Elementor\Ultra\Core\Error' ) ) {
			return Error::make( Error_Codes::VALIDATION_FAILED, $message, $status, $meta );
		}
		return new WP_Error(
			Error_Codes::VALIDATION_FAILED,
			$message,
			array(
				'status' => $status,
				'meta'   => $meta,
			)
		);
	}
}
