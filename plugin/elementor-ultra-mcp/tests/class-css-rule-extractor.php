<?php
/**
 * WP-Q06 — CSS_Rule_Extractor: a whitespace/minification-tolerant reader for the V4 atomic CSS that the
 * `Css_Primer` (WP-P05, the S01-confirmed approach) emits under `uploads/elementor/css/`.
 *
 * Why this exists (14-fixtures-harness.md §3 step 3 / Detailed-Req #3): the render-assertion regression
 * must assert that a SAVED + PRIMED atomic page rendered STYLED — i.e. the per-breakpoint CSS files
 * contain the EXPECTED local-style + global-class selector RULES. Asserting on a raw substring is
 * fragile (whitespace / minification / declaration order). This extractor parses the generated CSS into
 * `selector => [declarations]` blocks so the assertion is STRUCTURAL.
 *
 * SPIKE-VERIFIED FILE NAMING ([S01], SUMMARY.md C1.4 + spec/spikes/scripts/s01-assert-css.mjs):
 *  - local style:  `local-<postId>-<context>-<bp>.css`  → `.elementor .<localStyleId>{...}`
 *  - global class: `global-<postId>-<context>-<bp>.css` → `.elementor .<globalClassId>{...}`
 *  - atomic base:  `base-<bp>.css` (shared; no post id segment)
 *  - context = `frontend` (published) / `preview` (draft); desktop has NO suffix, non-desktop appends
 *    `-<bp>` and is wrapped in a `@media` block.
 *
 * [R5] local-style ids are NOT stable across save: this extractor reads the ACTUAL ids out of the saved
 * `_elementor_data` (the keys of every node's `styles` map and the `settings.classes` refs) — it NEVER
 * assumes the authored ids survive the `Document_Writer` save (which mints/dedupes ids and lets Elementor
 * regenerate element + dependent local-style ids). The global-class id IS stable (it lives in the kit).
 *
 * This is a Q06-OWNED helper; it READS the primer's output and never re-implements the prime (WP-P05
 * owns the `Css_Primer`).
 *
 * @package Elementor\Ultra\Tests
 */

namespace Elementor\Ultra\Tests;

/**
 * Locates + parses the generated atomic CSS files for a primed post and the active kit's global classes.
 */
class CSS_Rule_Extractor {

	/** Frontend render-context segment (published posts) — `Atomic_Widget_Styles::CONTEXT_FRONTEND`. */
	const CONTEXT_FRONTEND = 'frontend';

	/** Preview render-context segment (draft/preview posts). */
	const CONTEXT_PREVIEW = 'preview';

	/** The desktop breakpoint key (no `-<bp>` suffix, no `@media` wrapper). */
	const BREAKPOINT_DESKTOP = 'desktop';

	/**
	 * Absolute CSS dir with a trailing slash (`uploads/elementor/css/`). Mirrors `Css_Primer::css_dir()`
	 * so the extractor reads the SAME directory the primer wrote.
	 *
	 * @return string
	 */
	public function css_dir(): string {
		$upload = wp_upload_dir();
		return trailingslashit( $upload['basedir'] ) . 'elementor/css/';
	}

	/**
	 * The render-context segment for a post's CSS file names: `frontend` for a published post, `preview`
	 * for any non-published (draft/pending/auto-draft) post. Mirrors `Css_Primer::document_context()`.
	 *
	 * @param int $post_id Post id.
	 * @return string
	 */
	public function context_for( int $post_id ): string {
		return ( 'publish' === get_post_status( $post_id ) ) ? self::CONTEXT_FRONTEND : self::CONTEXT_PREVIEW;
	}

	/**
	 * Absolute path to a per-node per-breakpoint CSS file: `<node>-<postId>-<context>-<bp>.css`.
	 *
	 * @param string $node       `local` or `global`.
	 * @param int    $post_id    The primed post id.
	 * @param string $context    `frontend` or `preview`.
	 * @param string $breakpoint Breakpoint key (e.g. `desktop`, `tablet`, `mobile`).
	 * @return string Absolute file path (existence not guaranteed).
	 */
	public function node_file( string $node, int $post_id, string $context, string $breakpoint = self::BREAKPOINT_DESKTOP ): string {
		return $this->css_dir() . $node . '-' . $post_id . '-' . $context . '-' . $breakpoint . '.css';
	}

	/**
	 * Absolute path to the shared atomic base file for a breakpoint: `base-<bp>.css`.
	 *
	 * @param string $breakpoint Breakpoint key.
	 * @return string Absolute file path (existence not guaranteed).
	 */
	public function base_file( string $breakpoint = self::BREAKPOINT_DESKTOP ): string {
		return $this->css_dir() . 'base-' . $breakpoint . '.css';
	}

	/**
	 * Read a CSS file's raw bytes (authoritative on-disk bytes, per [S01] — HTTP-served `.css` may
	 * transiently 304/empty so the regression reads the filesystem). Returns '' when missing/unreadable.
	 * Clears the stat cache so a freshly-primed file is read correctly.
	 *
	 * @param string $abs_path Absolute file path.
	 * @return string File contents, or '' when absent/unreadable.
	 */
	public function read_css( string $abs_path ): string {
		clearstatcache( true, $abs_path );
		if ( ! is_readable( $abs_path ) ) {
			return '';
		}
		$contents = @file_get_contents( $abs_path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- test harness reads a generated CSS file.
		return is_string( $contents ) ? $contents : '';
	}

	/**
	 * Parse a CSS string into an ordered list of rule blocks. Whitespace/minification tolerant: it strips
	 * `/* *​/` comments, unwraps `@media`/`@supports` at-rule wrappers (so nested rules are flattened to the
	 * top level for selector lookup), then splits on `}` and, per block, on the FIRST `{` into a selector
	 * and a declaration list. Each block becomes `{ selector, declarations[], raw }`.
	 *
	 * @param string $css Raw CSS.
	 * @return array<int,array{selector:string,declarations:array<int,array{property:string,value:string}>,raw:string}>
	 */
	public function parse_rules( string $css ): array {
		// Strip CSS comments.
		$css = (string) preg_replace( '#/\*.*?\*/#s', '', $css );

		// Unwrap at-rule wrappers (e.g. `@media (max-width:768px){ .x{...} }`). We only care about the
		// inner selector rules; removing the `@media(...){` opener + its matching close lets the generic
		// `}`-split below recover the inner rules. This is a tolerant flatten, not a full CSS parser.
		$css = (string) preg_replace( '#@[a-zA-Z-]+[^{};]*\{#', '', $css );

		$rules  = array();
		$chunks = explode( '}', $css );
		foreach ( $chunks as $chunk ) {
			$brace = strpos( $chunk, '{' );
			if ( false === $brace ) {
				continue;
			}
			$selector = trim( substr( $chunk, 0, $brace ) );
			$body     = trim( substr( $chunk, $brace + 1 ) );
			if ( '' === $selector ) {
				continue;
			}

			$declarations = array();
			foreach ( explode( ';', $body ) as $decl ) {
				$decl = trim( $decl );
				if ( '' === $decl ) {
					continue;
				}
				$colon = strpos( $decl, ':' );
				if ( false === $colon ) {
					continue;
				}
				$declarations[] = array(
					'property' => trim( substr( $decl, 0, $colon ) ),
					'value'    => trim( substr( $decl, $colon + 1 ) ),
				);
			}

			$rules[] = array(
				'selector'     => $selector,
				'declarations' => $declarations,
				'raw'          => $selector . '{' . $body . '}',
			);
		}

		return $rules;
	}

	/**
	 * Whether any parsed rule's selector CONTAINS the given class token (`.<id>`). Tolerant of the
	 * `.elementor .<id>` prefix Elementor scopes atomic CSS with, descendant/compound selectors, and
	 * minification. Returns the matching rule blocks (empty array = not present).
	 *
	 * @param array<int,array<string,mixed>> $rules     Parsed rules from {@see parse_rules()}.
	 * @param string                         $class_id  The style/class id WITHOUT the leading dot.
	 * @return array<int,array<string,mixed>> Matching rule blocks.
	 */
	public function rules_for_class( array $rules, string $class_id ): array {
		$needle = '.' . $class_id;
		$out    = array();
		foreach ( $rules as $rule ) {
			$selector = isset( $rule['selector'] ) ? (string) $rule['selector'] : '';
			// Match `.<id>` as a class token: the needle followed by a non-identifier char or end.
			if ( $this->selector_has_class( $selector, $class_id ) ) {
				$out[] = $rule;
			} elseif ( '' !== $needle && false !== strpos( $selector, $needle ) ) {
				// Defensive fallback for exotic selectors; the token check above is the primary path.
				$out[] = $rule;
			}
		}
		return $out;
	}

	/**
	 * True when a selector references `.<class_id>` as a whole class token (not as a prefix of a longer
	 * id). E.g. `.elementor .s01hero` matches `s01hero`; `.s01heroine` does NOT.
	 *
	 * @param string $selector A CSS selector.
	 * @param string $class_id The class id WITHOUT the leading dot.
	 * @return bool
	 */
	public function selector_has_class( string $selector, string $class_id ): bool {
		if ( '' === $class_id ) {
			return false;
		}
		// `\.` + the (regex-quoted) id + a boundary: end, whitespace, combinator, comma, colon, etc.
		$pattern = '/\.' . preg_quote( $class_id, '/' ) . '(?![A-Za-z0-9_-])/';
		return 1 === preg_match( $pattern, $selector );
	}

	/**
	 * Whether the rule blocks for a class declare ANY property (i.e. the selector exists AND carries at
	 * least one declaration). A primed-but-empty `.x{}` block is NOT a styled render.
	 *
	 * @param array<int,array<string,mixed>> $rules    Parsed rules.
	 * @param string                         $class_id Class id WITHOUT the leading dot.
	 * @return bool
	 */
	public function class_has_declarations( array $rules, string $class_id ): bool {
		foreach ( $this->rules_for_class( $rules, $class_id ) as $rule ) {
			if ( ! empty( $rule['declarations'] ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The declared value of a property for a class (the first match across that class's rule blocks), or
	 * null when the class/property is absent. Lets a fixture assert a SPECIFIC declaration (e.g.
	 * `font-size: 48px`) rather than only selector presence.
	 *
	 * @param array<int,array<string,mixed>> $rules    Parsed rules.
	 * @param string                         $class_id Class id WITHOUT the leading dot.
	 * @param string                         $property CSS property name.
	 * @return string|null
	 */
	public function declared_value( array $rules, string $class_id, string $property ): ?string {
		foreach ( $this->rules_for_class( $rules, $class_id ) as $rule ) {
			foreach ( (array) $rule['declarations'] as $decl ) {
				if ( isset( $decl['property'] ) && strtolower( (string) $decl['property'] ) === strtolower( $property ) ) {
					return (string) $decl['value'];
				}
			}
		}
		return null;
	}

	// ---------------------------------------------------------------------
	// Saved-tree introspection ([R5] — read ACTUAL ids from `_elementor_data`).
	// ---------------------------------------------------------------------

	/**
	 * Read the saved tree's local-style ids + referenced global-class ids out of `_elementor_data`. A
	 * style id is "local" when it is a KEY of some node's `styles` map; a referenced class id that is NOT
	 * a local-style key is "global" (it lives in the kit). Mirrors `Css_Primer::collect_expected_style_ids`
	 * so the extractor asserts EXACTLY the selectors the primer was responsible for emitting ([R5]).
	 *
	 * @param int $post_id The saved post id.
	 * @return array{local:string[],global:string[]}
	 */
	public function expected_ids_from_saved( int $post_id ): array {
		$raw  = get_post_meta( $post_id, '_elementor_data', true );
		$data = is_string( $raw ) ? json_decode( $raw, true ) : $raw;
		if ( ! is_array( $data ) ) {
			return array(
				'local'  => array(),
				'global' => array(),
			);
		}

		$local   = array();
		$classes = array();
		$this->walk_collect( $data, $local, $classes );

		$local  = array_values( array_unique( $local ) );
		$global = array();
		foreach ( $classes as $class_id ) {
			if ( ! in_array( $class_id, $local, true ) ) {
				$global[] = $class_id;
			}
		}

		return array(
			'local'  => $local,
			'global' => array_values( array_unique( $global ) ),
		);
	}

	/**
	 * Recursive collector for {@see expected_ids_from_saved()}.
	 *
	 * @param array<int,mixed> $elements Element nodes.
	 * @param string[]         $local    Local-style ids accumulator (by reference).
	 * @param string[]         $classes  Referenced class ids accumulator (by reference).
	 * @return void
	 */
	private function walk_collect( array $elements, array &$local, array &$classes ): void {
		foreach ( $elements as $element ) {
			if ( ! is_array( $element ) ) {
				continue;
			}
			if ( isset( $element['styles'] ) && is_array( $element['styles'] ) ) {
				foreach ( array_keys( $element['styles'] ) as $style_id ) {
					$local[] = (string) $style_id;
				}
			}
			if ( isset( $element['settings']['classes']['$$type'], $element['settings']['classes']['value'] )
				&& 'classes' === $element['settings']['classes']['$$type']
				&& is_array( $element['settings']['classes']['value'] )
			) {
				foreach ( $element['settings']['classes']['value'] as $class_id ) {
					$classes[] = (string) $class_id;
				}
			}
			if ( isset( $element['elements'] ) && is_array( $element['elements'] ) ) {
				$this->walk_collect( $element['elements'], $local, $classes );
			}
		}
	}

	// ---------------------------------------------------------------------
	// Active-kit global-class CSS (the kit-level path for global-class-only renders, §3-step-3 / WP-Q06
	// interface note). The atomic global-class CSS for a class referenced ON a post is emitted into the
	// per-doc `global-<postId>-...css` file; this helper additionally resolves the active kit id so a
	// test can read/flush the kit-level CSS via Cache_Service::flush_design_system().
	// ---------------------------------------------------------------------

	/**
	 * The active Elementor kit post id (0 when unavailable). Mirrors `Cache_Service::active_kit_id()`.
	 *
	 * @return int
	 */
	public function active_kit_id(): int {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return 0;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->kits_manager ) || ! method_exists( $plugin->kits_manager, 'get_active_id' ) ) {
			return 0;
		}
		return (int) $plugin->kits_manager->get_active_id();
	}

	/**
	 * Convenience: parse a node file in one call. Returns the parsed rules (empty array when the file is
	 * missing/empty).
	 *
	 * @param string $node       `local` or `global`.
	 * @param int    $post_id    Post id.
	 * @param string $context    `frontend` or `preview`.
	 * @param string $breakpoint Breakpoint key.
	 * @return array<int,array<string,mixed>>
	 */
	public function rules_in_node_file( string $node, int $post_id, string $context, string $breakpoint = self::BREAKPOINT_DESKTOP ): array {
		return $this->parse_rules( $this->read_css( $this->node_file( $node, $post_id, $context, $breakpoint ) ) );
	}
}
