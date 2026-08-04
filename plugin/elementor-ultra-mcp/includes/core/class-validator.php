<?php
/**
 * WP-P03 — Validator: the AUTHORITATIVE dry-run element-tree validator (the locked "PHP dry_run is
 * authoritative, TS prefilter is a pre-filter only" decision, 11-authoring-contract.md preamble).
 *
 * Contract authority:
 *  - 10-rest-api.md §0.9 (dry-run-before-commit), §2.3 (dry-run route payload).
 *  - 11-authoring-contract.md §3 (typed envelope), §5 (styles), §8 (rules R1-R9).
 *  - 12-error-taxonomy.md §3.1 (validation codes), §4 (NEVER string-match the throw — catch the type /
 *    classify by phase, copy the raw text into the message, never into the `code`).
 *  - 14-fixtures-harness.md §3 (the round-trip protocol: `valid` + error-code SET).
 *  - schemas/diff.schema.json#/$defs/{DryRunResult,ValidationError,Diff} (the FROZEN output shape).
 *
 * HOW PHASE IS KNOWN WITHOUT STRING-MATCHING (12 §4, P03 Implementation Notes): the atomic save flow in
 * has-atomic-base.php::get_data_for_save() runs parse_atomic_settings() (Props_Parser, throws "Settings
 * validation failed." at :113) and THEN parse_atomic_styles() (Style_Parser, throws "Styles validation
 * failed for style ..." at :97). Both throw a generic \Exception. To classify by PHASE rather than by
 * message text, this validator REPLAYS that exact flow with the SAME public parsers: it runs
 * Props_Parser::make( $instance::get_props_schema() )->parse( $settings ) and inspects the STRUCTURED
 * Parse_Result::is_valid()/errors() — a settings failure ⇒ ATOMIC_SETTINGS_INVALID; then per style runs
 * Style_Parser::make( Style_Schema::get() )->parse( $style ) — a style failure ⇒ ATOMIC_STYLES_INVALID.
 * The phase is the parser that returned is_valid()===false, never the message. The raw parser text is
 * copied verbatim into the human `message` (schema ValidationError.message), never into the `code`.
 *
 * NO PERSISTENCE (10 §2.3, §0.9, P03 #10): instantiation + parsing are read-only by construction
 * (create_element_instance + get_props_schema + the parsers touch no post meta / CSS / revisions). The
 * existing `before` tree for the diff is READ via get_post_meta and NEVER instantiated (P03 notes #d).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra;

use Elementor\Ultra\Diff_Builder;
use Exception;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The single source of truth for element-tree validity. Every WRITE route calls validate_only()/dry_run()
 * before persisting; nothing is persisted on failure.
 */
final class Validator {

	/** Atomic phase markers (control flow only — never compared against an Elementor message). */
	const PHASE_SETTINGS = 'settings';
	const PHASE_STYLES   = 'styles';

	/**
	 * The authoritative validate + diff (no persist). Returns a DryRunResult-shaped assoc array
	 * (schemas/diff.schema.json#/$defs/DryRunResult): { valid, errors[], diff, preview_url:null }.
	 * `valid = empty(errors)`. `preview_url` is ALWAYS null — the dry-run ROUTE (WP-P06) fills it when
	 * `want_preview` (P03 #11).
	 *
	 * @param array<int,array<string,mixed>> $elements        The candidate tree (array of nodes).
	 * @param array<string,mixed>            $settings        Optional page settings (validated structurally only here).
	 * @param int                            $post_id         When >0, diff against the existing document tree.
	 * @param string                         $generation_hint 'auto'|'v4'|'v3' — biases ambiguous cases only.
	 *
	 * @return array{valid:bool,errors:array<int,array<string,mixed>>,diff:array<string,mixed>,generation_detected:string,id_collisions:string[],preview_url:null}
	 */
	public static function dry_run( array $elements, array $settings = array(), int $post_id = 0, string $generation_hint = 'auto' ): array {
		$collision_ids = array();
		$errors        = array_merge(
			// Contract 18 §7-AI S1 — the document-settings allowlist pass (kills AF1) runs FIRST so a
			// render-fatal settings shape is reported even when the tree itself is valid.
			self::validate_settings( $settings ),
			self::validate_tree( $elements, $post_id, $collision_ids )
		);

		// `before` for the diff: the existing document tree (read-only, never instantiated, P03 notes #d).
		$before = ( $post_id > 0 ) ? self::read_existing_tree( $post_id ) : null;
		$diff   = Diff_Builder::build( $before, $elements );

		return array(
			'valid'               => empty( $errors ),
			'errors'              => array_values( $errors ),
			'diff'                => $diff,
			'generation_detected' => self::detect_tree_generation( $elements, $generation_hint ),
			'id_collisions'       => array_values( array_unique( $collision_ids ) ),
			'preview_url'         => null,
		);
	}

	/**
	 * The validation half WITHOUT the diff — the fast, side-effect-free hot path every write controller
	 * (save / replace-tree / elements / templates) calls before persisting (10 §0.9, P03 #note "keep
	 * validate_only fast"). Returns { valid, errors }.
	 *
	 * @param array<int,array<string,mixed>> $elements The candidate tree.
	 * @param array<string,mixed>            $settings Optional page settings.
	 *
	 * @return array{valid:bool,errors:array<int,array<string,mixed>>}
	 */
	public static function validate_only( array $elements, array $settings = array() ): array {
		$collision_ids = array();
		$errors        = array_merge(
			self::validate_settings( $settings ),
			self::validate_tree( $elements, 0, $collision_ids )
		);

		return array(
			'valid'  => empty( $errors ),
			'errors' => array_values( $errors ),
		);
	}

	/**
	 * Contract 18 §7-AI S1 — the DOCUMENT-settings typed ALLOWLIST pass (kills AF1; mirrored by
	 * spec/contracts/schemas/page-settings.schema.json and the TS `pageSettingsInputSchema` prefilter).
	 *
	 * Unknown keys pass through untouched; KNOWN keys with render-fatal shapes are hard SETTINGS_INVALID
	 * errors:
	 *  - `custom_css` MUST be a plain string. The object `{raw:<base64>}` shape is the STYLE-VARIANT form
	 *    (contract 11 §5); on PAGE settings Elementor Pro's custom-css module calls `trim()` on it
	 *    (elementor-pro/modules/custom-css/module.php:101) and FATALS every front-end render while the
	 *    save itself reports green (the R4 build-#1 record). This is the AF1 inverse-trap pair.
	 *  - `template` must be a known `_wp_page_template` value (incl. `elementor_canvas`).
	 *  - `hide_title` must be boolean (the legacy switcher strings 'yes'/'' also pass so stored
	 *    settings round-trip through GET-merge-PUT).
	 *  - `post_status` must be a valid status.
	 *
	 * @param array<string,mixed> $settings The candidate document-settings bag.
	 *
	 * @return array<int,array<string,mixed>> ValidationError-shaped rows (empty = settings pass).
	 */
	public static function validate_settings( array $settings ): array {
		$errors = array();

		if ( array_key_exists( 'custom_css', $settings ) && ! is_string( $settings['custom_css'] ) ) {
			$errors[] = self::error(
				Error_Codes::SETTINGS_INVALID,
				sprintf(
					/* translators: %s: the received PHP type. */
					__( 'settings.custom_css must be a plain CSS string on page/document settings (received %s). The {raw:<base64>} object shape is the STYLE-variant form and fatals the front-end render (Pro custom-css module). Recovery for an already-broken page: update_settings {custom_css: ""}.', 'elementor-ultra-mcp' ),
					gettype( $settings['custom_css'] )
				),
				array(),
				'settings.custom_css'
			);
		}

		if ( array_key_exists( 'template', $settings ) ) {
			$allowed_tpl = array( 'default', 'elementor_canvas', 'elementor_header_footer', 'elementor_theme' );
			if ( ! is_string( $settings['template'] ) || ! in_array( $settings['template'], $allowed_tpl, true ) ) {
				$errors[] = self::error(
					Error_Codes::SETTINGS_INVALID,
					sprintf(
						/* translators: %s: the allowed template values. */
						__( 'settings.template must be one of: %s.', 'elementor-ultra-mcp' ),
						implode( ', ', $allowed_tpl )
					),
					array(),
					'settings.template'
				);
			}
		}

		if ( array_key_exists( 'hide_title', $settings ) ) {
			$hide = $settings['hide_title'];
			if ( ! is_bool( $hide ) && 'yes' !== $hide && '' !== $hide ) {
				$errors[] = self::error(
					Error_Codes::SETTINGS_INVALID,
					__( 'settings.hide_title must be a boolean (or the legacy switcher strings "yes"/"").', 'elementor-ultra-mcp' ),
					array(),
					'settings.hide_title'
				);
			}
		}

		if ( array_key_exists( 'post_status', $settings ) ) {
			$allowed_status = array( 'draft', 'publish', 'pending', 'private', 'future' );
			if ( ! is_string( $settings['post_status'] ) || ! in_array( $settings['post_status'], $allowed_status, true ) ) {
				$errors[] = self::error(
					Error_Codes::SETTINGS_INVALID,
					sprintf(
						/* translators: %s: the allowed status values. */
						__( 'settings.post_status must be one of: %s.', 'elementor-ultra-mcp' ),
						implode( ', ', $allowed_status )
					),
					array(),
					'settings.post_status'
				);
			}
		}

		return $errors;
	}

	/**
	 * Per-node generation detection (11 §8 R6). Atomic = an `e-*` container elType, or elType 'widget' with
	 * an `e-*` widgetType, or typed-envelope settings. Classic = everything else (section/column/container
	 * + classic widgets with flat settings). Returns 'v4' | 'v3' (per the interface; tree-level 'mixed' is
	 * computed by detect_tree_generation()).
	 *
	 * @param array<string,mixed> $node A single node.
	 *
	 * @return string 'v4'|'v3'
	 */
	public static function detect_generation( array $node ): string {
		$el_type     = isset( $node['elType'] ) && is_string( $node['elType'] ) ? $node['elType'] : '';
		$widget_type = isset( $node['widgetType'] ) && is_string( $node['widgetType'] ) ? $node['widgetType'] : '';

		// Atomic container elType ('e-*' but not 'widget').
		if ( '' !== $el_type && 0 === strpos( $el_type, 'e-' ) ) {
			return 'v4';
		}
		// Atomic widget: elType 'widget' with an 'e-*' widgetType.
		if ( 'widget' === $el_type && 0 === strpos( $widget_type, 'e-' ) ) {
			return 'v4';
		}
		// Atomic sibling keys / typed-envelope settings also mark v4 (defensive — covers e-* shapes whose
		// type prefix was stripped). A node carrying a `styles` map or any {$$type,value} envelope is atomic.
		if ( self::has_typed_envelope_settings( $node ) ) {
			return 'v4';
		}

		return 'v3';
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Internal: tree validation
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Walk + validate the whole tree, aggregating ALL detectable errors (P03 #12). Collects structural
	 * checks (R1, R3, R4, R9, unknown-types) for every node, plus the authoritative instantiate-and-parse
	 * verdict (ATOMIC_SETTINGS_INVALID / ATOMIC_STYLES_INVALID) per atomic node. Continues to the next node
	 * after a per-node atomic throw so the agent sees as many problems as possible in one pass.
	 *
	 * @param array<int,array<string,mixed>> $elements      The candidate tree.
	 * @param int                            $post_id       When >0, also collide ids against the existing doc.
	 * @param string[]                       $collision_ids Out-param: ids that collide (within tree or vs doc).
	 *
	 * @return array<int,array<string,mixed>> Validation errors (ValidationError-shaped).
	 */
	private static function validate_tree( array $elements, int $post_id, array &$collision_ids ): array {
		$errors = array();

		// --- ID uniqueness across the whole tree (R3 / DUPLICATE_ELEMENT_ID). ---
		$seen_ids    = array();
		$dup_in_tree = array();
		$flat        = self::flatten_nodes( $elements );
		foreach ( $flat as $entry ) {
			$node = $entry['node'];
			$id   = isset( $node['id'] ) && is_string( $node['id'] ) ? $node['id'] : null;
			if ( null === $id || '' === $id ) {
				continue; // R1 handles the missing-id case per node below.
			}
			if ( isset( $seen_ids[ $id ] ) ) {
				$dup_in_tree[ $id ] = true;
			}
			$seen_ids[ $id ] = true;
		}

		// Collide against the existing document's used-id set when editing (R3 on merge).
		$existing_ids = ( $post_id > 0 ) ? self::existing_used_ids( $post_id ) : array();

		foreach ( array_keys( $dup_in_tree ) as $dup_id ) {
			$collision_ids[] = $dup_id;
			$errors[]        = self::error(
				Error_Codes::DUPLICATE_ELEMENT_ID,
				sprintf(
					/* translators: %s: the colliding element id. */
					__( 'Duplicate element id "%1$s" appears more than once in the tree; it collides on the .elementor-element-%2$s selector. Use ids/remap.', 'elementor-ultra-mcp' ),
					$dup_id,
					$dup_id
				),
				array( 'element_id' => $dup_id )
			);
		}
		// Against-document id reuse (R3) is INFORMATIONAL, not fatal, for the dry_run/full-tree-save path.
		// The authoritative write (Document_Writer::write → Id_Service::remap_tree( $elements, $post_id ))
		// auto-remaps any candidate id that already exists in the target document BEFORE it validates (which
		// it does with post_id=0). So a tree whose ids coincide with the target's own ids — e.g. the SAME
		// tree read back from the document and re-submitted (a full replace, NOT a foreign insert) — is
		// accepted by save and MUST therefore pass dry_run too: a tree save() accepts MUST pass dry_run on
		// read-back (save→read→dry_run round-trip stability). We still SURFACE the reused ids in
		// `id_collisions` (the dry_run informational signal) so the caller knows the write will remap them,
		// but we do NOT emit a `valid:false` DUPLICATE_ELEMENT_ID for them. Genuine INTRA-tree duplicates
		// (two nodes in the same submitted tree sharing one id, handled above) remain a hard error — that is
		// the ambiguity 12-error-taxonomy.md §DUPLICATE_ELEMENT_ID names ("two nodes share an id").
		if ( ! empty( $existing_ids ) ) {
			foreach ( array_keys( $seen_ids ) as $id ) {
				if ( isset( $existing_ids[ $id ] ) && ! isset( $dup_in_tree[ $id ] ) ) {
					$collision_ids[] = $id;
				}
			}
		}

		// --- Local-style id uniqueness across the tree (R4: duplicate local-style ids silently clash). ---
		$seen_style_ids = array();
		foreach ( $flat as $entry ) {
			$node   = $entry['node'];
			$styles = isset( $node['styles'] ) && is_array( $node['styles'] ) ? $node['styles'] : array();
			foreach ( array_keys( $styles ) as $style_id ) {
				$style_id = (string) $style_id;
				if ( isset( $seen_style_ids[ $style_id ] ) ) {
					$el_id    = isset( $node['id'] ) && is_string( $node['id'] ) ? $node['id'] : '';
					$errors[] = self::error(
						Error_Codes::LOCAL_STYLE_UNLINKED,
						sprintf(
							/* translators: %s: the duplicated local-style id. */
							__( 'Local-style id "%s" is declared on more than one element; local-style ids must be unique across the tree (R4).', 'elementor-ultra-mcp' ),
							$style_id
						),
						array(
							'element_id' => $el_id,
							'style_id'   => $style_id,
						)
					);
				}
				$seen_style_ids[ $style_id ] = true;
			}
		}

		// --- Per-node checks. ---
		foreach ( $flat as $entry ) {
			$errors = array_merge( $errors, self::validate_node( $entry['node'], $entry['path'] ) );
		}

		return $errors;
	}

	/**
	 * All per-node checks for a single node: R1 (structural shape), unknown-type (R2), R9 (image-src XOR,
	 * structural), R4 (local-style mirrored into classes), and the authoritative atomic instantiate-and-parse
	 * verdict (ATOMIC_SETTINGS_INVALID / ATOMIC_STYLES_INVALID).
	 *
	 * @param mixed  $node The node (asserted to be an array by R1).
	 * @param string $path Dotted request-body path for this node (e.g. 'elements[2]').
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function validate_node( $node, string $path ): array {
		$errors = array();

		// R1 — every node is an object with a non-empty string id + elType (P03 #7). A malformed node
		// (e.g. settings not an array) must yield VALIDATION_FAILED with a path, never a PHP fatal (P03 note).
		if ( ! is_array( $node ) ) {
			return array(
				self::error(
					Error_Codes::VALIDATION_FAILED,
					__( 'Node is not an object.', 'elementor-ultra-mcp' ),
					array(),
					$path
				),
			);
		}

		$id = isset( $node['id'] ) && is_string( $node['id'] ) ? $node['id'] : '';
		if ( '' === $id ) {
			$errors[] = self::error(
				Error_Codes::VALIDATION_FAILED,
				__( 'Node is missing a non-empty string "id" (R1).', 'elementor-ultra-mcp' ),
				array(),
				$path . '.id'
			);
		}

		$el_type = isset( $node['elType'] ) && is_string( $node['elType'] ) ? $node['elType'] : '';
		if ( '' === $el_type ) {
			$errors[] = self::error(
				Error_Codes::VALIDATION_FAILED,
				__( 'Node is missing a non-empty string "elType" (R1).', 'elementor-ultra-mcp' ),
				array( 'element_id' => $id ),
				$path . '.elType'
			);
		}

		if ( isset( $node['settings'] ) && ! is_array( $node['settings'] ) ) {
			$errors[] = self::error(
				Error_Codes::VALIDATION_FAILED,
				__( 'Node "settings" must be an object (R1).', 'elementor-ultra-mcp' ),
				array( 'element_id' => $id ),
				$path . '.settings'
			);
		}
		if ( isset( $node['styles'] ) && ! is_array( $node['styles'] ) ) {
			$errors[] = self::error(
				Error_Codes::VALIDATION_FAILED,
				__( 'Node "styles" must be an object (R1).', 'elementor-ultra-mcp' ),
				array( 'element_id' => $id ),
				$path . '.styles'
			);
		}

		// If the shape is too broken to safely instantiate, stop here for this node (avoid a fatal).
		if ( '' === $el_type || ( isset( $node['settings'] ) && ! is_array( $node['settings'] ) ) ) {
			return $errors;
		}

		$is_atomic = ( 'v4' === self::detect_generation( $node ) );

		// R2a — a 'widget' node with an EMPTY/missing widgetType is STRUCTURALLY malformed: it is NOT a
		// droppable legacy widget — Elementor's frontend renderer fatals on it ("Undefined array key
		// 'widgetType'" → HTTP 500, document.php:2079). Always a HARD UNKNOWN_WIDGET_TYPE (never the
		// silently_dropped warning tier), so dry-run rejects it and a page that would 500 can NEVER save.
		if ( 'widget' === $el_type && ( ! isset( $node['widgetType'] ) || ! is_string( $node['widgetType'] ) || '' === $node['widgetType'] ) ) {
			$errors[] = self::error(
				Error_Codes::UNKNOWN_WIDGET_TYPE,
				__( 'A "widget" node is missing a non-empty "widgetType"; it cannot render and aborts the save (would fatal the frontend).', 'elementor-ultra-mcp' ),
				array( 'element_id' => $id ),
				$path . '.widgetType'
			);
			return array_merge( $errors, self::recurse_unsupported( $node ) );
		}

		// R2 — registered type. Atomic unknown ⇒ hard UNKNOWN_WIDGET_TYPE (real save THROWS); classic
		// unknown ⇒ UNKNOWN_WIDGET_TYPE warning-tier with meta.silently_dropped:true (real save DROPS it).
		$requested_type = ( 'widget' === $el_type && isset( $node['widgetType'] ) && is_string( $node['widgetType'] ) )
			? $node['widgetType']
			: $el_type;

		$type_registered = self::is_type_registered( $el_type, isset( $node['widgetType'] ) && is_string( $node['widgetType'] ) ? $node['widgetType'] : '' );

		if ( ! $type_registered ) {
			$meta = array(
				'element_id'     => $id,
				'requested_type' => $requested_type,
			);
			if ( ! $is_atomic ) {
				$meta['silently_dropped'] = true;
			}
			$errors[] = self::error(
				Error_Codes::UNKNOWN_WIDGET_TYPE,
				sprintf(
					/* translators: 1: requested widget/element type, 2: 'silently dropped' or 'aborts the save'. */
					__( 'Unknown type "%1$s" is not registered on this site; on save it %2$s.', 'elementor-ultra-mcp' ),
					$requested_type,
					$is_atomic ? __( 'aborts the whole save (atomic nodes throw)', 'elementor-ultra-mcp' ) : __( 'is silently dropped (legacy node)', 'elementor-ultra-mcp' )
				),
				$meta
			);
			// Cannot instantiate an unregistered type — skip the deeper atomic checks for this node.
			return array_merge( $errors, self::recurse_unsupported( $node ) );
		}

		if ( $is_atomic ) {
			// R9 — structural image-src XOR (precise path/code). The instantiate path also catches it, but
			// the structural check gives the exact prop (P03 #6).
			$errors = array_merge( $errors, self::check_image_src_xor( $node, $id, $path ) );

			// R4 — every styles-map id MUST appear in settings.classes.value (§5.1). A styles id absent from
			// classes silently detaches ⇒ LOCAL_STYLE_UNLINKED (P03 #5).
			$errors = array_merge( $errors, self::check_local_styles_linked( $node, $id ) );

			// Authoritative atomic verdict (settings phase then styles phase — mirrors get_data_for_save()).
			$errors = array_merge( $errors, self::validate_atomic_node( $node, $id ) );

			// LAYOUT GATE — a flex ROW with a gap whose direct children's %-widths already sum to >=100%
			// leaves NO room for the gap → the items overflow/shrink-wrong, or (with wrap) drop to
			// fewer-per-row. The #1 hand-authored grid bug (`width:25%` × 4 + gap). Static, zero false
			// positives (>=100% + any gap cannot fit). Fix: CSS grid (grid-template-columns:repeat(N,1fr)).
			$errors = array_merge( $errors, self::check_flex_overflow( $node, $id, $path ) );
		}

		return $errors;
	}

	/**
	 * Collapse a node's local-style props into the effective DESKTOP/base set (later variants win).
	 *
	 * @param array<string,mixed> $node An atomic node.
	 * @return array<string,mixed> prop-name → typed-value.
	 */
	private static function node_desktop_props( array $node ): array {
		$out = array();
		if ( ! isset( $node['styles'] ) || ! is_array( $node['styles'] ) ) {
			return $out;
		}
		foreach ( $node['styles'] as $def ) {
			if ( ! is_array( $def ) || ! isset( $def['variants'] ) || ! is_array( $def['variants'] ) ) {
				continue;
			}
			foreach ( $def['variants'] as $v ) {
				$bp = $v['meta']['breakpoint'] ?? null;
				if ( ( null === $bp || 'desktop' === $bp ) && isset( $v['props'] ) && is_array( $v['props'] ) ) {
					$out = array_merge( $out, $v['props'] );
				}
			}
		}
		return $out;
	}

	/**
	 * LAYOUT GATE: flag a flex-ROW container whose direct children's `%` widths sum to >=100% while a
	 * `gap` is set — that layout cannot fit (the gap is never subtracted from the percentages).
	 *
	 * @param array<string,mixed> $node The container node.
	 * @param string              $id   Its id.
	 * @param string              $path Tree path.
	 * @return array<int,array<string,mixed>>
	 */
	private static function check_flex_overflow( array $node, string $id, string $path ): array {
		$children = ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) ? $node['elements'] : array();
		if ( count( $children ) < 2 ) {
			return array();
		}
		$cp      = self::node_desktop_props( $node );
		$display = $cp['display']['value'] ?? '';
		$fd      = $cp['flex-direction']['value'] ?? '';
		$is_flex = ( 'e-flexbox' === ( $node['elType'] ?? '' ) ) || 'flex' === $display || 'inline-flex' === $display;
		$is_grid = 'grid' === $display || 'inline-grid' === $display;
		$is_row  = 'column' !== $fd && 'column-reverse' !== $fd;
		if ( ! $is_flex || $is_grid || ! $is_row ) {
			return array();
		}
		$gap      = $cp['gap'] ?? null;
		$gap_size = ( is_array( $gap ) && isset( $gap['value']['size'] ) ) ? (float) $gap['value']['size'] : 0.0;
		if ( $gap_size <= 0 ) {
			return array();
		}
		$sum = 0.0;
		$cnt = 0;
		foreach ( $children as $ch ) {
			if ( ! is_array( $ch ) ) {
				continue;
			}
			$w = self::node_desktop_props( $ch )['width'] ?? null;
			if ( is_array( $w ) && 'size' === ( $w['$$type'] ?? '' ) && '%' === ( $w['value']['unit'] ?? '' ) ) {
				$sum += (float) ( $w['value']['size'] ?? 0 );
				++$cnt;
			}
		}
		if ( $cnt < 2 || $sum < 100.0 ) {
			return array();
		}
		return array(
			self::error(
				Error_Codes::VALIDATION_FAILED,
				sprintf(
					/* translators: 1: element id, 2: number of %-width children, 3: summed percentage. */
					__( 'Flex-row "%1$s": %2$d direct children have %%-widths summing to %3$g%% with a gap set — the gap is NOT subtracted from the percentages, so they overflow / shrink wrong / wrap to fewer-per-row. Use CSS grid for gap-aware columns: display:"grid", grid-template-columns:"repeat(N, 1fr)", gap — children need no width. (Or make the %%-widths sum to clearly under 100 to leave room for the gap.)', 'elementor-ultra-mcp' ),
					$id,
					(int) $cnt,
					$sum
				),
				array( 'element_id' => $id ),
				$path
			),
		);
	}

	/**
	 * The authoritative atomic instantiate-and-parse verdict for a single atomic node. Replays
	 * get_data_for_save()'s flow with the SAME public parsers so the PHASE (settings vs styles) is known
	 * from WHICH parser returned is_valid()===false — NOT from any message (12 §4). Wrapped defensively so a
	 * parser/Elementor fault becomes a structured error, never a fatal.
	 *
	 * @param array<string,mixed> $node The atomic node.
	 * @param string              $id   The node id (for meta.element_id).
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function validate_atomic_node( array $node, string $id ): array {
		// Guard: Elementor + the atomic stack must be present (free-route safety, P01 Guards).
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return array();
		}

		try {
			$instance = \Elementor\Plugin::$instance->elements_manager->create_element_instance( $node );
		} catch ( Exception $e ) {
			// An unexpected instantiation throw — classify defensively as a settings-phase atomic failure
			// (the only place a bare \Exception escapes before parsing) and surface the raw text in the
			// message (never the code, 12 §4).
			return array( self::atomic_error( self::PHASE_SETTINGS, $id, '', $e->getMessage() ) );
		}

		if ( null === $instance ) {
			// Should have been caught by the registered-type check; defensively report it.
			return array(
				self::error(
					Error_Codes::UNKNOWN_WIDGET_TYPE,
					__( 'Atomic node could not be instantiated (unknown or unsupported type).', 'elementor-ultra-mcp' ),
					array(
						'element_id'     => $id,
						'requested_type' => isset( $node['widgetType'] ) ? (string) $node['widgetType'] : ( isset( $node['elType'] ) ? (string) $node['elType'] : '' ),
					)
				),
			);
		}

		$errors = array();

		// ---- Settings phase (Props_Parser, mirrors parse_atomic_settings, throws at :113). ----
		$settings_failed = false;
		try {
			$schema   = self::props_schema_for( $instance );
			$settings = isset( $node['settings'] ) && is_array( $node['settings'] ) ? $node['settings'] : array();

			if ( null !== $schema && class_exists( '\Elementor\Modules\AtomicWidgets\Parsers\Props_Parser' ) ) {
				$result = \Elementor\Modules\AtomicWidgets\Parsers\Props_Parser::make( $schema )->parse( $settings );
				if ( ! $result->is_valid() ) {
					$settings_failed = true;
					$errors[]        = self::atomic_error(
						self::PHASE_SETTINGS,
						$id,
						'',
						self::parse_errors_text( $result )
					);
				}
			}
		} catch ( Exception $e ) {
			// Replay path itself threw — fall back to the authoritative get_data_for_save() (below).
			$settings_failed = true;
		}

		// ---- Styles phase (Style_Parser, mirrors parse_atomic_styles, throws at :97). ----
		// Only meaningful once settings parse (get_data_for_save aborts at the first phase that throws); but
		// we still surface style failures independently to give the agent the fullest picture per pass.
		$styles = isset( $node['styles'] ) && is_array( $node['styles'] ) ? $node['styles'] : array();
		if ( ! empty( $styles ) && class_exists( '\Elementor\Modules\AtomicWidgets\Parsers\Style_Parser' ) && class_exists( '\Elementor\Modules\AtomicWidgets\Styles\Style_Schema' ) ) {
			try {
				$style_schema = \Elementor\Modules\AtomicWidgets\Styles\Style_Schema::get();
				foreach ( $styles as $style_id => $style ) {
					if ( ! is_array( $style ) ) {
						continue; // R1 structural style issues handled elsewhere; skip non-array.
					}
					$sresult = \Elementor\Modules\AtomicWidgets\Parsers\Style_Parser::make( $style_schema )->parse( $style );
					if ( ! $sresult->is_valid() ) {
						$errors[] = self::atomic_error(
							self::PHASE_STYLES,
							$id,
							(string) $style_id,
							self::parse_errors_text( $sresult )
						);
					}
				}
			} catch ( Exception $e ) {
				// Defensive: a styles-parse fault classifies as a styles-phase failure (phase by control flow).
				$errors[] = self::atomic_error( self::PHASE_STYLES, $id, '', $e->getMessage() );
			}
		}

		// TRUTHFULNESS GATE (false-valid #1): Props_Parser::validate() only iterates SCHEMA keys, so any style
		// prop NOT in the atomic Style_Schema is SILENTLY DROPPED while parse() still reports valid. That makes
		// `valid:true` a lie for flex-grow/flex-basis/flex-shrink (the schema has the COMPOSITE `flex` prop, not
		// the longhands), background-color (schema has `background`), and any typo — all vanish at render. Surface
		// each as a hard error with a concrete fix so `valid` reflects what will actually render.
		if ( ! empty( $styles ) && class_exists( '\Elementor\Modules\AtomicWidgets\Styles\Style_Schema' ) ) {
			$schema_for_props = \Elementor\Modules\AtomicWidgets\Styles\Style_Schema::get();
			foreach ( $styles as $style_id => $style ) {
				if ( ! is_array( $style ) || ! isset( $style['variants'] ) || ! is_array( $style['variants'] ) ) {
					continue;
				}
				foreach ( $style['variants'] as $vi => $variant ) {
					$vprops = ( isset( $variant['props'] ) && is_array( $variant['props'] ) ) ? $variant['props'] : array();
					foreach ( array_keys( $vprops ) as $pk ) {
						if ( ! array_key_exists( (string) $pk, $schema_for_props ) ) {
							$errors[] = self::atomic_error(
								self::PHASE_STYLES,
								$id,
								(string) $style_id,
								sprintf(
									/* translators: 1: prop name, 2: variant index, 3: actionable hint. */
									__( 'variants[%2$d].%1$s: unsupported style prop — absent from the atomic Style_Schema, so Elementor silently drops it and it never renders. %3$s', 'elementor-ultra-mcp' ),
									(string) $pk,
									(int) $vi,
									self::style_prop_hint( (string) $pk )
								)
							);
						}
					}

					// TRUTHFULNESS GATE (false-valid #2): custom_css.raw is run through base64_decode() at render
					// (Elementor\Utils::decode_string). PLAIN CSS decodes to nothing and is SILENTLY dropped while
					// the parser still reports valid. Flag non-base64 raw so the agent encodes it.
					if ( isset( $variant['custom_css']['raw'] ) && is_string( $variant['custom_css']['raw'] )
						&& '' !== $variant['custom_css']['raw']
						&& false === base64_decode( $variant['custom_css']['raw'], true ) ) {
						$errors[] = self::atomic_error(
							self::PHASE_STYLES,
							$id,
							(string) $style_id,
							sprintf(
								/* translators: %d: variant index. */
								__( 'variants[%d].custom_css.raw must be BASE64-encoded CSS — Elementor base64_decode()s it at render, so plain CSS is silently dropped. Encode the CSS declarations (base64) before sending. Prefer native props where possible (gradients/shadows/flex are all native).', 'elementor-ultra-mcp' ),
								(int) $vi
							)
						);
					}
				}
			}
		}

		// Fallback to the AUTHORITATIVE end-to-end path only when the replay produced NOTHING but a real save
		// WOULD throw — guarantees we never report valid where Elementor would abort. Catches both phases via
		// the single \Exception; classified as settings-phase by default (12 §4 — phase by the path we are on,
		// not the message). Skipped when we already have a verdict (avoids a duplicate code for one node).
		if ( empty( $errors ) ) {
			try {
				$instance->get_data_for_save();
			} catch ( Exception $e ) {
				$errors[] = self::atomic_error( self::PHASE_SETTINGS, $id, '', $e->getMessage() );
			}
		}

		return $errors;
	}

	/**
	 * R4 / §5.1 — every styles-map id must be present in settings.classes.value (else it silently detaches).
	 *
	 * @param array<string,mixed> $node The atomic node.
	 * @param string              $id   The node id.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function check_local_styles_linked( array $node, string $id ): array {
		$styles = isset( $node['styles'] ) && is_array( $node['styles'] ) ? $node['styles'] : array();
		if ( empty( $styles ) ) {
			return array();
		}

		$class_values = self::classes_value( $node );
		$errors       = array();

		foreach ( array_keys( $styles ) as $style_id ) {
			$style_id = (string) $style_id;
			if ( ! in_array( $style_id, $class_values, true ) ) {
				$errors[] = self::error(
					Error_Codes::LOCAL_STYLE_UNLINKED,
					sprintf(
						/* translators: 1: local-style id, 2: element id. */
						__( 'Local style "%1$s" on element "%2$s" is not listed in settings.classes.value, so it would silently detach and never render (R4, §5.1).', 'elementor-ultra-mcp' ),
						$style_id,
						$id
					),
					array(
						'element_id' => $id,
						'style_id'   => $style_id,
					)
				);
			}
		}

		return $errors;
	}

	/**
	 * R9 — structural image-src XOR. Scans settings for any `{$$type:'image-src'}` envelope and asserts its
	 * value carries id XOR url (mirrors image-src-prop-type.php:36-44 `$has_id xor $has_url`). Recurses into
	 * nested envelopes (e.g. an `image` object prop whose `src` field is an image-src).
	 *
	 * @param array<string,mixed> $node The atomic node.
	 * @param string              $id   The node id.
	 * @param string              $path Dotted node path.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function check_image_src_xor( array $node, string $id, string $path ): array {
		$settings = isset( $node['settings'] ) && is_array( $node['settings'] ) ? $node['settings'] : array();
		$errors   = array();

		foreach ( $settings as $prop_name => $value ) {
			foreach ( self::find_image_src( $value, (string) $prop_name ) as $hit ) {
				$inner   = isset( $hit['value']['value'] ) && is_array( $hit['value']['value'] ) ? $hit['value']['value'] : array();
				$has_id  = self::envelope_present( $inner, 'id' );
				$has_url = self::envelope_present( $inner, 'url' );

				if ( ! ( $has_id xor $has_url ) ) {
					$errors[] = self::error(
						Error_Codes::IMAGE_SRC_XOR_VIOLATION,
						sprintf(
							/* translators: 1: prop name, 2: element id. */
							__( 'image-src on prop "%1$s" of element "%2$s" must carry exactly one of id or url (never both, never neither) (R9, image-src-prop-type.php:36-44).', 'elementor-ultra-mcp' ),
							$hit['prop'],
							$id
						),
						array(
							'element_id' => $id,
							'prop'       => $hit['prop'],
						),
						$path . '.settings.' . $hit['prop']
					);
				}
			}
		}

		return $errors;
	}

	/*
	------------------------------------------------------------------------------------------------
	 * Internal: helpers
	 * --------------------------------------------------------------------------------------------- */

	/**
	 * Recursively find every `{$$type:'image-src'}` envelope within a settings value, returning
	 * `[{prop:<dotted>, value:<envelope>}]`.
	 *
	 * @param mixed  $value   A settings value (envelope, nested object/array, or scalar).
	 * @param string $prop    The dotted prop path accumulated so far.
	 *
	 * @return array<int,array{prop:string,value:array<string,mixed>}>
	 */
	private static function find_image_src( $value, string $prop ): array {
		$hits = array();
		if ( ! is_array( $value ) ) {
			return $hits;
		}

		if ( isset( $value['$$type'] ) && 'image-src' === $value['$$type'] ) {
			$hits[] = array(
				'prop'  => $prop,
				'value' => $value,
			);
		}

		// Descend into nested envelope payloads / object-field maps to catch image-src nested inside `image`.
		foreach ( $value as $key => $child ) {
			if ( '$$type' === $key || ! is_array( $child ) ) {
				continue;
			}
			$child_prop = ( 'value' === $key ) ? $prop : $prop . '.' . $key;
			$hits       = array_merge( $hits, self::find_image_src( $child, $child_prop ) );
		}

		return $hits;
	}

	/**
	 * Whether a sub-envelope (`id` / `url` inside an image-src value) is "present" — mirrors
	 * `! empty($value[<key>])` over the (possibly wrapped) inner value (image-src-prop-type.php:35-40).
	 *
	 * @param array<string,mixed> $inner The image-src `value` map ({id?, url?, alt?}).
	 * @param string              $key   'id' | 'url'.
	 */
	private static function envelope_present( array $inner, string $key ): bool {
		if ( ! array_key_exists( $key, $inner ) ) {
			return false;
		}
		$entry = $inner[ $key ];
		if ( null === $entry || '' === $entry || array() === $entry ) {
			return false;
		}
		// Wrapped envelope: present iff its inner `value` is non-empty (0 and '0' count as present like Elementor).
		if ( is_array( $entry ) && array_key_exists( 'value', $entry ) ) {
			$v = $entry['value'];
			return ! ( null === $v || '' === $v || array() === $v );
		}
		return ! empty( $entry );
	}

	/**
	 * The bare-string array from a node's `classes` envelope (settings.classes.value), per §3 ("classes
	 * value is a BARE string array").
	 *
	 * @param array<string,mixed> $node The node.
	 *
	 * @return string[]
	 */
	private static function classes_value( array $node ): array {
		$settings = isset( $node['settings'] ) && is_array( $node['settings'] ) ? $node['settings'] : array();
		$classes  = isset( $settings['classes'] ) && is_array( $settings['classes'] ) ? $settings['classes'] : array();
		$value    = isset( $classes['value'] ) && is_array( $classes['value'] ) ? $classes['value'] : array();

		return array_values(
			array_filter(
				array_map( 'strval', $value ),
				static function ( $v ) {
					return '' !== $v;
				}
			)
		);
	}

	/**
	 * Whether an elType / widgetType is registered on this site (R2). Atomic + classic via the managers
	 * (P03 #3 / #note: guard with the registered-type set before relying on a null return). Returns true
	 * when Elementor is absent so the dry-run never spuriously fails on a non-Elementor harness (the atomic
	 * parse step is itself guarded).
	 *
	 * @param string $el_type     The node elType.
	 * @param string $widget_type The node widgetType ('' when not a widget).
	 */
	private static function is_type_registered( string $el_type, string $widget_type ): bool {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return true;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin ) {
			return true;
		}

		if ( 'widget' === $el_type ) {
			if ( '' === $widget_type ) {
				return false; // A widget node with no widgetType cannot resolve to a type.
			}
			if ( isset( $plugin->widgets_manager ) && method_exists( $plugin->widgets_manager, 'get_widget_types' ) ) {
				$types = $plugin->widgets_manager->get_widget_types();
				return is_array( $types ) && array_key_exists( $widget_type, $types );
			}
			return true;
		}

		if ( isset( $plugin->elements_manager ) && method_exists( $plugin->elements_manager, 'get_element_types' ) ) {
			$types = $plugin->elements_manager->get_element_types();
			return is_array( $types ) && array_key_exists( $el_type, $types );
		}

		return true;
	}

	/**
	 * The atomic props schema for an instantiated element. `get_props_schema()` is a public static on the
	 * atomic base (has-atomic-base.php:310). Returns null when it is not resolvable (non-atomic instance).
	 *
	 * @param object $instance An Elementor element instance.
	 *
	 * @return array<string,mixed>|null
	 */
	private static function props_schema_for( $instance ): ?array {
		if ( ! is_object( $instance ) || ! method_exists( $instance, 'get_props_schema' ) ) {
			return null;
		}
		try {
			$schema = $instance::get_props_schema();
		} catch ( Exception $e ) {
			return null;
		}
		return is_array( $schema ) ? $schema : null;
	}

	/**
	 * Read the structured parser errors off a Parse_Result as a string for the human message + verbatim
	 * `parser_errors` (NEVER used as the code, 12 §4). Uses the public errors()->to_string() shape
	 * (parse-result.php / parse-errors.php). Returns '' if unavailable.
	 *
	 * @param object $result A Parse_Result.
	 */
	private static function parse_errors_text( $result ): string {
		if ( ! is_object( $result ) || ! method_exists( $result, 'errors' ) ) {
			return '';
		}
		try {
			$errors = $result->errors();
			if ( is_object( $errors ) && method_exists( $errors, 'to_string' ) ) {
				return (string) $errors->to_string();
			}
		} catch ( Exception $e ) {
			return '';
		}
		return '';
	}

	/**
	 * Build a ValidationError for an atomic phase failure (schemas/diff.schema.json#/$defs/ValidationError).
	 * The phase is supplied by the CALLER (control flow), not parsed from a message: 'settings' ⇒
	 * ATOMIC_SETTINGS_INVALID, 'styles' ⇒ ATOMIC_STYLES_INVALID. The raw parser text is copied into the
	 * message verbatim (schema ValidationError.message) — it NEVER becomes the code.
	 *
	 * @param string $phase         self::PHASE_SETTINGS | self::PHASE_STYLES.
	 * @param string $element_id    The throwing element id.
	 * @param string $style_id      The throwing style id (styles phase only; '' otherwise).
	 * @param string $parser_errors The raw appended parser text (verbatim).
	 *
	 * @return array<string,mixed>
	 */
	/**
	 * Actionable fix hint for a style prop that is absent from the atomic Style_Schema (so it would be
	 * silently dropped). Points the agent at the real prop instead of the longhand/typo it tried.
	 *
	 * @param string $prop The unsupported style prop name.
	 * @return string Human guidance appended to the validation error.
	 */
	private static function style_prop_hint( string $prop ): string {
		$hints = array(
			'flex-grow'        => 'Flex sizing uses the composite "flex" prop {"$$type":"flex","value":{"flexGrow":<number>,"flexShrink":<number>,"flexBasis":<size>}}; for reliable, proven column sizing set an explicit "width" (e.g. {"$$type":"size","value":{"unit":"%","size":31}}).',
			'flex-shrink'      => 'Use the composite "flex" prop (flexGrow/flexShrink/flexBasis), or an explicit "width" — not the longhands.',
			'flex-basis'       => 'Use the composite "flex" prop (flexGrow/flexShrink/flexBasis), or an explicit "width" — not the longhands.',
			'background-color' => 'Use "background": {"$$type":"background","value":{"color":{"$$type":"color","value":"#hex"}}}.',
			'background-image' => 'Use "background" with a background-overlay (image/gradient) value.',
		);
		return isset( $hints[ $prop ] )
			? $hints[ $prop ]
			: 'Call elementor_schema_styles for the exact supported prop name (it may differ from the CSS longhand).';
	}

	private static function atomic_error( string $phase, string $element_id, string $style_id, string $parser_errors ): array {
		$code = ( self::PHASE_STYLES === $phase )
			? Error_Codes::ATOMIC_STYLES_INVALID
			: Error_Codes::ATOMIC_SETTINGS_INVALID;

		$meta = array( 'element_id' => $element_id );
		if ( self::PHASE_STYLES === $phase && '' !== $style_id ) {
			$meta['style_id'] = $style_id;
		}

		$human = ( self::PHASE_STYLES === $phase )
			? sprintf(
				/* translators: 1: style id, 2: element id. */
				__( 'Atomic styles validation failed for style "%1$s" on element "%2$s".', 'elementor-ultra-mcp' ),
				$style_id,
				$element_id
			)
			: sprintf(
				/* translators: %s: element id. */
				__( 'Atomic settings validation failed on element "%s".', 'elementor-ultra-mcp' ),
				$element_id
			);

		if ( '' !== $parser_errors ) {
			// Copy the raw Elementor parser text verbatim into the message (schema ValidationError.message,
			// 12 §4) — for agent self-correction. NEVER into the code.
			$human .= ' ' . $parser_errors;
		}

		return self::error( $code, $human, $meta );
	}

	/**
	 * Build a ValidationError assoc array that validates against schemas/diff.schema.json#/$defs/ValidationError
	 * (additionalProperties:false — only code/message/element_id/style_id/prop/retryable are permitted). Meta
	 * keys are HOISTED to the matching top-level schema fields; any extra meta key (e.g. requested_type,
	 * silently_dropped) is folded into the human message so no information is lost while the object stays
	 * schema-valid. `path` (10 §2.3) is appended to the message too (the schema has no `path` field).
	 *
	 * @param string              $code    A taxonomy code (Error_Codes::*).
	 * @param string              $message Human, actionable message.
	 * @param array<string,mixed> $meta    Code-specific structured context (element_id/style_id/prop + extras).
	 * @param string              $path    Optional dotted request-body path (folded into the message).
	 *
	 * @return array<string,mixed>
	 */
	private static function error( string $code, string $message, array $meta = array(), string $path = '' ): array {
		$out = array(
			'code'      => $code,
			'message'   => $message,
			'retryable' => Error_Codes::is_retryable( $code ),
		);

		// Hoist the schema-permitted locator fields.
		if ( isset( $meta['element_id'] ) && is_string( $meta['element_id'] ) && '' !== $meta['element_id'] ) {
			$out['element_id'] = $meta['element_id'];
		}
		if ( isset( $meta['style_id'] ) && is_string( $meta['style_id'] ) && '' !== $meta['style_id'] ) {
			$out['style_id'] = $meta['style_id'];
		}
		if ( isset( $meta['prop'] ) && is_string( $meta['prop'] ) && '' !== $meta['prop'] ) {
			$out['prop'] = $meta['prop'];
		}

		// Fold non-schema context into the message so the object remains additionalProperties:false-clean.
		$extra = array();
		if ( isset( $meta['requested_type'] ) && '' !== (string) $meta['requested_type'] ) {
			$extra[] = 'requested_type=' . (string) $meta['requested_type'];
		}
		if ( ! empty( $meta['silently_dropped'] ) ) {
			$extra[] = 'silently_dropped=true';
		}
		if ( '' !== $path ) {
			$extra[] = 'path=' . $path;
		}
		if ( ! empty( $extra ) ) {
			$out['message'] .= ' (' . implode( '; ', $extra ) . ')';
		}

		return $out;
	}

	/**
	 * Flatten a tree into a list of `{node, path}` entries (depth-first). `path` is the dotted request-body
	 * location (elements[0].elements[2] ...). Children live under `elements` for both generations.
	 *
	 * @param array<int,array<string,mixed>> $elements The tree.
	 * @param string                         $prefix   The dotted path prefix.
	 *
	 * @return array<int,array{node:mixed,path:string}>
	 */
	private static function flatten_nodes( array $elements, string $prefix = 'elements' ): array {
		$out = array();
		$i   = 0;
		foreach ( $elements as $node ) {
			$path  = $prefix . '[' . $i . ']';
			$out[] = array(
				'node' => $node,
				'path' => $path,
			);
			if ( is_array( $node ) && isset( $node['elements'] ) && is_array( $node['elements'] ) && ! empty( $node['elements'] ) ) {
				$out = array_merge( $out, self::flatten_nodes( $node['elements'], $path . '.elements' ) );
			}
			++$i;
		}
		return $out;
	}

	/**
	 * Whether a node carries typed-envelope settings (any settings value is a `{$$type,value}` map) or an
	 * atomic `styles` map — a structural marker that the node is V4 atomic even if its type prefix is absent.
	 *
	 * @param array<string,mixed> $node The node.
	 */
	private static function has_typed_envelope_settings( array $node ): bool {
		if ( isset( $node['styles'] ) && is_array( $node['styles'] ) && ! empty( $node['styles'] ) ) {
			return true;
		}
		$settings = isset( $node['settings'] ) && is_array( $node['settings'] ) ? $node['settings'] : array();
		foreach ( $settings as $value ) {
			if ( is_array( $value ) && isset( $value['$$type'] ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Tree-level generation: 'v4' if every node is atomic, 'v3' if every node is classic, else 'mixed'
	 * (P03 #8). Per-node detection always wins; the hint only biases a fully-ambiguous (empty) tree.
	 *
	 * @param array<int,array<string,mixed>> $elements The tree.
	 * @param string                         $hint     'auto'|'v4'|'v3'.
	 *
	 * @return string 'v4'|'v3'|'mixed'
	 */
	private static function detect_tree_generation( array $elements, string $hint ): string {
		$flat = self::flatten_nodes( $elements );
		$gens = array();
		foreach ( $flat as $entry ) {
			if ( is_array( $entry['node'] ) ) {
				$gens[ self::detect_generation( $entry['node'] ) ] = true;
			}
		}

		if ( empty( $gens ) ) {
			// Ambiguous empty tree — bias by hint, defaulting to v4 (the primary target).
			return in_array( $hint, array( 'v3', 'v4' ), true ) ? $hint : 'v4';
		}
		if ( isset( $gens['v4'] ) && isset( $gens['v3'] ) ) {
			return 'mixed';
		}
		return isset( $gens['v4'] ) ? 'v4' : 'v3';
	}

	/**
	 * The set of element ids already used in a document (R3 on merge). Prefers WP-P04's Id_Service when
	 * available (behind class_exists/method_exists, P03 note #d — never a hard dependency); else reads
	 * `_elementor_data` and flattens. Returns a `{id => true}` set.
	 *
	 * @param int $post_id The target document.
	 *
	 * @return array<string,bool>
	 */
	private static function existing_used_ids( int $post_id ): array {
		// Optional fast path via WP-P04 (decoupled — only if present).
		if ( class_exists( '\Elementor\Ultra\Id_Service' ) && method_exists( '\Elementor\Ultra\Id_Service', 'used_ids' ) ) {
			$ids = \Elementor\Ultra\Id_Service::used_ids( $post_id );
			if ( is_array( $ids ) ) {
				$set = array();
				foreach ( $ids as $id ) {
					$set[ (string) $id ] = true;
				}
				return $set;
			}
		}

		$tree = self::read_existing_tree( $post_id );
		if ( null === $tree ) {
			return array();
		}
		$set = array();
		foreach ( self::flatten_nodes( $tree ) as $entry ) {
			$node = $entry['node'];
			if ( is_array( $node ) && isset( $node['id'] ) && is_string( $node['id'] ) && '' !== $node['id'] ) {
				$set[ $node['id'] ] = true;
			}
		}
		return $set;
	}

	/**
	 * Read the existing `_elementor_data` tree for a post as a decoded array, WITHOUT instantiating it
	 * (P03 note #d — the existing tree is assumed valid; instantiating it would be slow and could spuriously
	 * throw on Elementor-version drift). Returns null when absent / unreadable.
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array<int,array<string,mixed>>|null
	 */
	private static function read_existing_tree( int $post_id ): ?array {
		if ( $post_id <= 0 || ! function_exists( 'get_post_meta' ) ) {
			return null;
		}
		$raw = get_post_meta( $post_id, '_elementor_data', true );
		if ( is_array( $raw ) ) {
			return $raw;
		}
		if ( is_string( $raw ) && '' !== $raw ) {
			$decoded = json_decode( $raw, true );
			return is_array( $decoded ) ? $decoded : null;
		}
		return null;
	}

	/**
	 * For an unregistered node, still validate its children (so an unknown wrapper does not hide deeper
	 * errors). The flatten walk already visits children, so this is a no-op placeholder kept for clarity;
	 * children are validated by the top-level flatten loop regardless.
	 *
	 * @param array<string,mixed> $node The unregistered node.
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function recurse_unsupported( array $node ): array {
		unset( $node );
		return array();
	}
}
