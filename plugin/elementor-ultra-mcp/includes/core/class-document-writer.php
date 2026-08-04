<?php
/**
 * WP-P04 — Document_Writer: the transactional write core every WRITE route routes through.
 *
 * Performs the locked sequence (10-rest-api.md §2.6, 15-engineering-standards.md §3.7 / item 7):
 *   is_editable -> lock/autosave check -> base_hash check -> idempotency replay -> backup ->
 *   id mint/dedupe -> AUTHORITATIVE validate (never persist on invalid) -> SINGLE Document::save ->
 *   embed op_id -> new base_hash + diff + backup handle -> optional CSS prime -> op-log row.
 *
 * Contract authority:
 *  - 10-rest-api.md §0.8 (op_id/base_hash/locking), §0.9 (dry-run-before-commit), §0.10 (atomic CSS
 *    priming flag), §2.5 (settings GET-merge-PUT), §2.6 (save/replace-tree behaviour + response payload),
 *    §2.10 (lock status).
 *  - 11-authoring-contract.md §8.1 (id handling), §10 (NEVER raw-write _elementor_data — only Document::save).
 *  - 12-error-taxonomy.md §3.2 (LOCK_HELD/AUTOSAVE_CONFLICT/CONCURRENCY_STALE_HASH/IDEMPOTENT_REPLAY),
 *    §3.5 (NOT_EDITABLE, NOT_FOUND, CSS_PRIME_FAILED).
 *  - 15-engineering-standards.md item 5 (never raw-write), item 7 (transactional, single save),
 *    item 8 (revision-independent backup).
 *
 * SPIKE-VERIFIED CORRECTIONS:
 *  - [S01] A headless Document::save of an atomic tree writes _elementor_data + global-class relations but
 *    emits ZERO front-end atomic CSS. This writer MUST therefore trigger an explicit CSS prime after an
 *    atomic save (prime_css:true), and otherwise report prime_required:true / css_primed:false (§0.10).
 *  - [S01] Document::save first guards is_editable_by_current_user() and silently returns FALSE writing
 *    nothing when there is no capable current user. The writer enforces is_editable() up front (NOT_EDITABLE)
 *    and any CLI/test path MUST wp_set_current_user(<capable id>) first or the save no-ops.
 *  - [S01/R5 — corrected] Elementor's Document::save does NOT regenerate element/local-style ids (verified
 *    empirically); the historical "ids unstable across save" symptom was THIS writer remapping the
 *    document's own ids. The writer dedupes intra-tree only (no against-document remap on save/replace)
 *    so element + local-style ids stay stable; it still re-reads ids + base_hash after the write.
 *  - [S04] Page SETTINGS-only patches go through Document::update_settings() (deep array_replace_recursive),
 *    NOT a bare save(['settings'=>$patch]) which REPLACES wholesale and wipes unrelated keys.
 *  - [R9] The unstyled residual only affects headless/export consumers; the writer relies on the explicit
 *    prime step, not first-visit rendering.
 *
 * Soft (guarded) dependencies: WP-P05 Css_Primer + Cache_Service and WP-P14 Op_Log are all behind
 * class_exists guards so this WP builds + tests independently (priming stubbed => css_primed:false /
 * prime_required:true). Hard dependency: WP-P03 Validator (validate-before-persist, the universal rule).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

use Elementor\Ultra\Diff_Builder;
use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Validator;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Transactional document writer. No route logic — the service WP-P06 (documents) and every other write
 * controller call. All methods are static so any controller can call them without wiring.
 */
final class Document_Writer {

	/** The document-settings sub-bucket the op_id is embedded into (10 §0.8). */
	const OP_ID_SETTINGS_BUCKET = 'editor_settings';

	/** The op_id key within the editor_settings bucket. */
	const OP_ID_SETTINGS_KEY = '_emcp_op_id';

	/** Post-meta fallback for the last applied op_id (Implementation Notes — set right after a save). */
	const OP_ID_META = '_emcp_last_op_id';

	/**
	 * The transactional save (10 §2.6). `$args` =
	 *   { elements?, settings?, base_hash?, op_id?, force?:bool, backup?:bool=true, prime_css?:bool=false }.
	 * Runs the full locked sequence and returns the §2.6 `data` payload or a WP_Error (409/422/404/403).
	 *
	 * @param int                 $post_id The target document.
	 * @param array<string,mixed> $args    The save arguments (above).
	 *
	 * @return array<string,mixed>|WP_Error
	 */
	public static function save( int $post_id, array $args ) {
		return self::write( $post_id, $args, false );
	}

	/**
	 * Overwrite the WHOLE element tree (10 §2.6 `replace-tree`). Identical sequence to {@see save()} but
	 * `elements` AND `base_hash` are REQUIRED.
	 *
	 * @param int                 $post_id The target document.
	 * @param array<string,mixed> $args    The replace arguments.
	 *
	 * @return array<string,mixed>|WP_Error
	 */
	public static function replace_tree( int $post_id, array $args ) {
		$elements = $args['elements'] ?? null;
		if ( ! is_array( $elements ) ) {
			return self::error(
				Error_Codes::VALIDATION_FAILED,
				__( 'replace_tree requires an "elements" array.', 'elementor-ultra-mcp' ),
				422,
				array( 'path' => 'elements' )
			);
		}
		if ( ! isset( $args['base_hash'] ) || '' === (string) $args['base_hash'] ) {
			return self::error(
				Error_Codes::CONCURRENCY_STALE_HASH,
				__( 'replace_tree requires a base_hash for optimistic concurrency. Re-read the document for a fresh base_hash.', 'elementor-ultra-mcp' ),
				409,
				array( 'post_id' => $post_id )
			);
		}

		return self::write( $post_id, $args, true );
	}

	/**
	 * GET-merge-PUT page settings (10 §2.5, spike [S04]). Reads the full `_elementor_page_settings`, deep
	 * merges the patch (scalar/object deep-merge; top-level numeric repeater arrays replaced wholesale), and
	 * persists via `Document::update_settings()` (the deep-merge path) so partial updates never wipe
	 * unrelated keys regardless of save_settings()'s merge-vs-replace behaviour. Returns `{success, settings}`.
	 *
	 * @param int                 $post_id   The target document.
	 * @param array<string,mixed> $patch     The settings patch.
	 * @param string|null         $base_hash Optional optimistic-concurrency token.
	 * @param string|null         $op_id     Optional op id (recorded; settings-only writes do not embed it).
	 *
	 * @return array{success:bool,settings:array<string,mixed>}|WP_Error
	 */
	public static function apply_settings_merge( int $post_id, array $patch, ?string $base_hash = null, ?string $op_id = null ) {
		// Contract 18 §7-AI S1 (kills AF1): the document-settings allowlist runs BEFORE any merge —
		// an object/array `custom_css` deep-merged into page settings fatals Pro's custom-css module
		// on every front-end render while the save reports green.
		$settings_errors = Validator::validate_settings( $patch );
		if ( ! empty( $settings_errors ) ) {
			return self::error(
				Error_Codes::SETTINGS_INVALID,
				sprintf(
					/* translators: %d: number of settings validation errors. */
					_n( 'Document-settings validation failed (%d error); nothing was written.', 'Document-settings validation failed (%d errors); nothing was written.', count( $settings_errors ), 'elementor-ultra-mcp' ),
					count( $settings_errors )
				),
				422,
				array(),
				$settings_errors,
				$op_id
			);
		}

		$editable = self::is_editable( $post_id );
		if ( is_wp_error( $editable ) ) {
			return $editable;
		}

		$hash_check = self::assert_base_hash( $post_id, $base_hash, false );
		if ( is_wp_error( $hash_check ) ) {
			return $hash_check;
		}

		$document = self::get_document( $post_id );
		if ( null === $document ) {
			return self::error( Error_Codes::NOT_FOUND, sprintf( 'Document %d not found.', $post_id ), 404 );
		}

		$current = get_post_meta( $post_id, '_elementor_page_settings', true );
		$current = is_array( $current ) ? $current : array();

		$merged = self::deep_merge( $current, $patch );

		// [S04]: update_settings() does array_replace_recursive($existing, $new) internally — the deep-merge
		// path. We pass the PATCH (not the full merged set) so its native deep-merge applies; our own
		// deep_merge above also guarantees the returned/echoed value is the merged result.
		if ( method_exists( $document, 'update_settings' ) ) {
			$document->update_settings( $patch );
		} else {
			// Defensive fallback: persist the fully merged set via save (never a bare patch — that would wipe).
			$document->save( array( 'settings' => $merged ) );
		}

		self::op_log( $post_id, $op_id, 'documents/settings', '', self::base_hash( $post_id ), 'ok' );

		$settings_after = get_post_meta( $post_id, '_elementor_page_settings', true );
		$settings_after = is_array( $settings_after ) ? $settings_after : $merged;

		return array(
			'success'  => true,
			'settings' => $settings_after,
		);
	}

	/**
	 * The editable-by-current-user gate (10 §0.3, 12 §3.5 NOT_EDITABLE). Wraps
	 * `Document::is_editable_by_current_user()`. Returns true or a 403 NOT_EDITABLE WP_Error.
	 *
	 * @param int $post_id The target document.
	 *
	 * @return true|WP_Error
	 */
	public static function is_editable( int $post_id ) {
		$document = self::get_document( $post_id );
		if ( null === $document ) {
			return self::error( Error_Codes::NOT_FOUND, sprintf( 'Document %d not found or not Elementor-built.', $post_id ), 404 );
		}

		if ( method_exists( $document, 'is_editable_by_current_user' ) && ! $document->is_editable_by_current_user() ) {
			return self::error(
				Error_Codes::NOT_EDITABLE,
				__( 'The current user cannot edit this document.', 'elementor-ultra-mcp' ),
				403,
				array( 'post_id' => $post_id )
			);
		}

		return true;
	}

	/**
	 * Lock + newer-autosave status (10 §2.10) — used by the lock-status route and the pre-write check.
	 *
	 * @param int $post_id The target document.
	 *
	 * @return array{locked:bool,locked_by:?int,newer_autosave:bool,autosave_ts:?int,autosave_author:?int}
	 */
	public static function lock_status( int $post_id ): array {
		$locked_by = function_exists( 'wp_check_post_lock' ) ? wp_check_post_lock( $post_id ) : false;
		$locked    = false !== $locked_by && null !== $locked_by;

		$newer_autosave  = false;
		$autosave_ts     = null;
		$autosave_author = null;

		$document = self::get_document( $post_id );
		if ( null !== $document && method_exists( $document, 'get_newer_autosave' ) ) {
			$autosave = $document->get_newer_autosave();
			if ( $autosave && is_object( $autosave ) ) {
				$newer_autosave = true;
				$autosave_post  = method_exists( $autosave, 'get_post' ) ? $autosave->get_post() : null;
				if ( $autosave_post && is_object( $autosave_post ) ) {
					$autosave_ts     = isset( $autosave_post->post_modified_gmt )
						? (int) mysql2date( 'U', $autosave_post->post_modified_gmt, false )
						: null;
					$autosave_author = isset( $autosave_post->post_author ) ? (int) $autosave_post->post_author : null;
				}
			}
		}

		return array(
			'locked'          => $locked,
			'locked_by'       => $locked ? (int) $locked_by : null,
			'newer_autosave'  => $newer_autosave,
			'autosave_ts'     => $autosave_ts,
			'autosave_author' => $autosave_author,
		);
	}

	// ------------------------------------------------------------------------------------------------
	// Internal: the locked write sequence.
	// ------------------------------------------------------------------------------------------------

	/**
	 * The shared locked write sequence for save() + replace_tree() (10 §2.6, Standards item 7).
	 *
	 * @param int                 $post_id      The target document.
	 * @param array<string,mixed> $args         The write args.
	 * @param bool                $is_replace   Whether this is replace_tree (elements required).
	 *
	 * @return array<string,mixed>|WP_Error
	 */
	private static function write( int $post_id, array $args, bool $is_replace ) {
		$elements    = isset( $args['elements'] ) && is_array( $args['elements'] ) ? $args['elements'] : null;
		$settings_in = isset( $args['settings'] ) && is_array( $args['settings'] ) ? $args['settings'] : null;
		$base_hash   = isset( $args['base_hash'] ) ? (string) $args['base_hash'] : null;
		$op_id       = isset( $args['op_id'] ) && '' !== (string) $args['op_id'] ? (string) $args['op_id'] : null;
		$force       = ! empty( $args['force'] );
		$do_backup   = ! array_key_exists( 'backup', $args ) || ! empty( $args['backup'] );
		$prime_css   = ! empty( $args['prime_css'] );

		if ( null === $elements && null === $settings_in ) {
			return self::error(
				Error_Codes::VALIDATION_FAILED,
				__( 'save requires at least one of "elements" or "settings".', 'elementor-ultra-mcp' ),
				422
			);
		}

		// (1) editable-by-user gate (also resolves NOT_FOUND).
		$editable = self::is_editable( $post_id );
		if ( is_wp_error( $editable ) ) {
			return $editable;
		}

		// (4) Idempotency replay (BEFORE any mutation) — same op_id already applied => return prior result.
		if ( null !== $op_id && self::op_already_applied( $post_id, $op_id ) ) {
			return self::idempotent_result( $post_id, $op_id );
		}

		// (2) lock + autosave check unless force.
		if ( ! $force ) {
			$lock = self::lock_status( $post_id );
			if ( $lock['locked'] ) {
				return self::error(
					Error_Codes::LOCK_HELD,
					__( 'The document is locked by another user in the editor. Pass force:true to override.', 'elementor-ultra-mcp' ),
					409,
					array( 'locked_by' => $lock['locked_by'] )
				);
			}
			if ( $lock['newer_autosave'] ) {
				return self::error(
					Error_Codes::AUTOSAVE_CONFLICT,
					__( 'A newer autosave exists for this document. Pass force:true to override.', 'elementor-ultra-mcp' ),
					409,
					array(
						'autosave_ts'     => $lock['autosave_ts'],
						'autosave_author' => $lock['autosave_author'],
					)
				);
			}
		}

		// (3) base_hash optimistic-lock check (required for replace_tree, optional for save).
		$hash_check = self::assert_base_hash( $post_id, $base_hash, $force );
		if ( is_wp_error( $hash_check ) ) {
			return $hash_check;
		}

		$before_hash = self::base_hash( $post_id );
		$before_tree = self::read_tree( $post_id );

		// (5) backup BEFORE write.
		$backup_handle = null;
		if ( $do_backup ) {
			$backup_handle = Backup_Service::snapshot( $post_id, $is_replace ? 'pre-replace-tree' : 'pre-save', $op_id );
		}

		// (6) mint/dedupe ids — INTRA-TREE collisions only (settings-only writes skip this). The incoming
		// elements REPLACE the document's whole tree (Document::save persists `elements` wholesale), so the
		// document's OWN current ids are NOT collisions: a read-modify-write tree keeps its element ids —
		// and therefore its dependent local-style ids, which embed the element id — stable across saves.
		// Deduping against $post_id here regenerated EVERY id on EVERY write (the real source of the
		// "[R5] ids unstable across save" symptom). Cross-document dedupe is reserved for true inserts
		// ({@see Id_Service::dedupe_for_insert} — templates/element-insert paths).
		$remapped_ids = array();
		if ( null !== $elements ) {
			$remap        = Id_Service::remap_tree( $elements, 0 );
			$elements     = $remap['elements'];
			$remapped_ids = $remap['remapped'];

			// (6a) Canonicalize local-style ids to the CSS-safe form Elementor emits (sanitize_key), keeping
			// the triple (styles map KEY === styles[].id === settings.classes.value) consistent with the
			// RENDERED CSS SELECTOR. Without this, a human-readable mixed-case local-style id (e.g. `heroWrap`)
			// renders `class="heroWrap"` in the HTML but `.herowrap` in the primed CSS — a case mismatch that
			// leaves the element unstyled and (correctly) trips CSS_PRIME_FAILED. Idempotent for Elementor's
			// own all-lowercase `e-<id>-<7hex>` ids. See Id_Service::normalize_local_style_ids.
			$elements = Id_Service::normalize_local_style_ids( $elements );
		}

		// (6b) Contract 18 §7-AI S3 — resolve nav-menu bindings at save: a nav-menu/mega-menu widget's
		// `settings.menu` value is resolved against the live nav_menu terms (accepts slug, name, or
		// term id) and normalized to the canonical SLUG (the form the Pro widget's slug-keyed control
		// and `wp_nav_menu()` both accept — spike-verified in class-nav-controller.php). An
		// unresolvable value is flagged `UNBOUND_MENU` in the response warnings — never a hard error
		// (the save proceeds; the widget renders menu-less until bound).
		$warnings = array();
		if ( null !== $elements ) {
			self::resolve_nav_menus( $elements, $warnings );
		}

		// (7) AUTHORITATIVE validate — write NOTHING on failure (10 §0.9). `validate_only` covers BOTH
		// the tree and the §7-AI S1 document-settings allowlist; a settings-only save still runs the
		// settings pass explicitly (an object custom_css through `save` fatals the front-end — AF1).
		$verdict_errors = array();
		if ( null !== $elements ) {
			$verdict = Validator::validate_only( $elements, $settings_in ?? array() );
			if ( empty( $verdict['valid'] ) ) {
				$verdict_errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
			}
		} elseif ( null !== $settings_in ) {
			$verdict_errors = Validator::validate_settings( $settings_in );
		}
		if ( ! empty( $verdict_errors ) ) {
			// §7-AI S1: a settings-allowlist violation surfaces SETTINGS_INVALID as the envelope code;
			// every other validation class keeps the historical ATOMIC_SETTINGS_INVALID envelope (the
			// TS-side validation-failure normalizers key on this fixed family).
			$first_code = ( isset( $verdict_errors[0]['code'] ) && Error_Codes::SETTINGS_INVALID === $verdict_errors[0]['code'] )
				? Error_Codes::SETTINGS_INVALID
				: Error_Codes::ATOMIC_SETTINGS_INVALID;
			return self::error(
				$first_code,
				sprintf(
					/* translators: %d: number of validation errors. */
					_n( 'Element-tree validation failed (%d error); nothing was written.', 'Element-tree validation failed (%d errors); nothing was written.', count( $verdict_errors ), 'elementor-ultra-mcp' ),
					count( $verdict_errors )
				),
				422,
				array(),
				$verdict_errors,
				$op_id
			);
		}

		// (8) embed op_id into editor_settings._emcp_op_id so it threads into Document::save.
		$settings_payload = self::build_settings_payload( $post_id, $settings_in, $op_id );

		// (9) SINGLE Document::save(['elements','settings']). Never two partial saves (Standards item 7).
		$save_data = array();
		if ( null !== $elements ) {
			$save_data['elements'] = $elements;
		}
		if ( null !== $settings_payload ) {
			$save_data['settings'] = $settings_payload;
		}

		$document = self::get_document( $post_id );
		if ( null === $document ) {
			return self::error( Error_Codes::NOT_FOUND, sprintf( 'Document %d not found.', $post_id ), 404 );
		}

		$saved = $document->save( $save_data );
		if ( ! $saved ) {
			return self::error(
				Error_Codes::NOT_EDITABLE,
				__( 'Document::save was rejected (not editable by the current user, or the save returned false).', 'elementor-ultra-mcp' ),
				403,
				array( 'post_id' => $post_id )
			);
		}

		// Persist the op_id to the dedicated meta too (replay detection survives even if the settings key
		// were stripped — Implementation Notes). Set immediately after the successful save.
		if ( null !== $op_id ) {
			update_post_meta( $post_id, self::OP_ID_META, $op_id );
		}

		// (10) new base_hash + diff. Re-read the SAVED tree (authoritative post-save state).
		$after_tree = self::read_tree( $post_id );
		$diff       = Diff_Builder::build( $before_tree, is_array( $after_tree ) ? $after_tree : ( $elements ?? array() ) );
		$new_hash   = self::base_hash( $post_id );

		// (10b) DROP MANIFEST: anything the caller submitted that did NOT survive Document::save()
		// (e.g. widgets Elementor's element manager refuses to hydrate) used to vanish silently —
		// the agent's only detection path was a screenshot. Compare submitted ids (post-remap)
		// against the re-read tree and report every casualty with enough identity to act on.
		$dropped_elements = array();
		if ( null !== $elements && is_array( $after_tree ) ) {
			$submitted_index = array();
			self::index_elements( $elements, $submitted_index );
			$saved_ids = array();
			self::index_elements( $after_tree, $saved_ids );
			foreach ( $submitted_index as $eid => $meta ) {
				$live_id = isset( $remapped_ids[ $eid ] ) ? $remapped_ids[ $eid ] : $eid;
				if ( ! isset( $saved_ids[ $live_id ] ) ) {
					$dropped_elements[] = array(
						'id'         => $eid,
						'elType'     => $meta['elType'],
						'widgetType' => $meta['widgetType'],
						'parent_id'  => $meta['parent'],
						'reason'     => 'not present in the saved tree (Document::save dropped it — most often an unregistered/unhydratable widgetType)',
					);
				}
			}
		}

		// (8/§0.10) prime_required: any atomic node + not primed in-request.
		$is_atomic      = self::is_atomic_document( $post_id );
		$css_primed     = false;
		$prime_required = $is_atomic;

		if ( $is_atomic && $prime_css && class_exists( '\Elementor\Ultra\Core\Css_Primer' ) ) {
			$primer = new Css_Primer();
			$result = $primer->prime( $post_id );
			if ( is_array( $result ) && ! empty( $result['css_primed'] ) ) {
				$css_primed     = true;
				$prime_required = false;
			}
		}

		// (11) op-log row (guarded).
		self::op_log( $post_id, $op_id, $is_replace ? 'documents/replace-tree' : 'documents/save', $before_hash, $new_hash, 'ok' );

		$result = array(
			'id'                => $post_id,
			'diff'              => $diff,
			'base_hash'         => $new_hash,
			'preview_url'       => self::preview_url( $post_id ),
			'backup_handle'     => $backup_handle,
			'css_primed'        => $css_primed,
			'prime_required'    => $prime_required,
			'remapped_ids'      => $remapped_ids,
			'idempotent_replay' => false,
			'op_id'             => $op_id,
		);
		if ( ! empty( $dropped_elements ) ) {
			$result['dropped_elements'] = $dropped_elements;
			$warnings[]                 = sprintf(
				'%d submitted element(s) were dropped by Document::save — see dropped_elements.',
				count( $dropped_elements )
			);
		}
		if ( ! empty( $warnings ) ) {
			$result['warnings'] = array_values( $warnings );
		}
		return $result;
	}

	/**
	 * Contract 18 §7-AI S3 — walk a tree and resolve every nav-menu/mega-menu widget's `settings.menu`
	 * value IN PLACE to the canonical menu SLUG, or append an `UNBOUND_MENU` warning row when no
	 * nav_menu term matches. Accepts slug, name, or numeric term id (everything
	 * `wp_get_nav_menu_object()` resolves).
	 *
	 * @param array<int,array<string,mixed>> $elements The tree (modified in place).
	 * @param array<int,array<string,mixed>> $warnings Out-param: `{code,message,element_id}` rows.
	 *
	 * @return void
	 */
	private static function resolve_nav_menus( array &$elements, array &$warnings ): void {
		$bindable = array( 'nav-menu', 'mega-menu' );

		foreach ( $elements as &$node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			$widget_type = isset( $node['widgetType'] ) && is_string( $node['widgetType'] ) ? $node['widgetType'] : '';
			if ( in_array( $widget_type, $bindable, true )
				&& isset( $node['settings'] ) && is_array( $node['settings'] )
				&& isset( $node['settings']['menu'] ) && is_scalar( $node['settings']['menu'] )
				&& '' !== (string) $node['settings']['menu']
			) {
				$requested = $node['settings']['menu'];
				$menu_obj  = function_exists( 'wp_get_nav_menu_object' ) ? wp_get_nav_menu_object( is_numeric( $requested ) ? (int) $requested : (string) $requested ) : false;
				if ( $menu_obj && isset( $menu_obj->slug ) ) {
					// Normalize to the canonical slug (the Pro widget's slug-keyed control value).
					$node['settings']['menu'] = (string) $menu_obj->slug;
				} else {
					$warnings[] = array(
						'code'       => 'UNBOUND_MENU',
						'element_id' => isset( $node['id'] ) ? (string) $node['id'] : '',
						'message'    => sprintf(
							/* translators: 1: the requested menu value, 2: the widget type. */
							__( 'No nav_menu term matches "%1$s" on this %2$s widget; the menu binding was left as-is and the widget will render menu-less. Create the menu (nav.menus.create) or re-bind (nav.bind_widget).', 'elementor-ultra-mcp' ),
							(string) $requested,
							$widget_type
						),
					);
				}
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				self::resolve_nav_menus( $node['elements'], $warnings );
			}
		}
		unset( $node );
	}

	/**
	 * Whether the document already reflects `$op_id` (10 §0.8 idempotency). True when the dedicated
	 * `_emcp_last_op_id` meta OR the embedded `editor_settings._emcp_op_id` equals it.
	 *
	 * @param int    $post_id The document id.
	 * @param string $op_id   The candidate op id.
	 */
	private static function op_already_applied( int $post_id, string $op_id ): bool {
		$meta = (string) get_post_meta( $post_id, self::OP_ID_META, true );
		if ( '' !== $meta && hash_equals( $meta, $op_id ) ) {
			return true;
		}

		$settings = get_post_meta( $post_id, '_elementor_page_settings', true );
		if ( is_array( $settings )
			&& isset( $settings[ self::OP_ID_SETTINGS_BUCKET ][ self::OP_ID_SETTINGS_KEY ] )
			&& hash_equals( (string) $settings[ self::OP_ID_SETTINGS_BUCKET ][ self::OP_ID_SETTINGS_KEY ], $op_id )
		) {
			return true;
		}

		return false;
	}

	/**
	 * Build the §2.6 response for an idempotent replay (10 §0.8) — current state, NOT re-applied.
	 *
	 * @param int    $post_id The document id.
	 * @param string $op_id   The replayed op id.
	 *
	 * @return array<string,mixed>
	 */
	private static function idempotent_result( int $post_id, string $op_id ): array {
		$is_atomic = self::is_atomic_document( $post_id );

		return array(
			'id'                => $post_id,
			'diff'              => array(
				'changes'     => array(),
				'new_ids'     => array(),
				'changed_ids' => array(),
				'removed_ids' => array(),
			),
			'base_hash'         => self::base_hash( $post_id ),
			'preview_url'       => self::preview_url( $post_id ),
			'backup_handle'     => null,
			'css_primed'        => false,
			'prime_required'    => $is_atomic,
			'remapped_ids'      => array(),
			'idempotent_replay' => true,
			'op_id'             => $op_id,
		);
	}

	/**
	 * Build the settings bucket to pass into Document::save: the caller's settings patch (or array() when
	 * none) with `editor_settings._emcp_op_id` embedded so the op_id persists with the save (10 §0.8).
	 * Returns null when there is no op_id AND no settings patch (so save() leaves settings untouched).
	 *
	 * NOTE: for a tree write Document::save replaces settings wholesale (save_settings), so we merge the
	 * op_id into the EXISTING settings to avoid wiping unrelated keys when only embedding the op_id.
	 *
	 * @param int                      $post_id  The document id.
	 * @param array<string,mixed>|null $patch    The caller's settings patch (null when only elements change).
	 * @param string|null              $op_id    The op id to embed (null = none).
	 *
	 * @return array<string,mixed>|null
	 */
	private static function build_settings_payload( int $post_id, ?array $patch, ?string $op_id ): ?array {
		if ( null === $patch && null === $op_id ) {
			return null;
		}

		// Start from existing settings so embedding the op_id (or a partial patch) never wipes other keys.
		$existing = get_post_meta( $post_id, '_elementor_page_settings', true );
		$base     = is_array( $existing ) ? $existing : array();

		$merged = ( null !== $patch ) ? self::deep_merge( $base, $patch ) : $base;

		if ( null !== $op_id ) {
			if ( ! isset( $merged[ self::OP_ID_SETTINGS_BUCKET ] ) || ! is_array( $merged[ self::OP_ID_SETTINGS_BUCKET ] ) ) {
				$merged[ self::OP_ID_SETTINGS_BUCKET ] = array();
			}
			$merged[ self::OP_ID_SETTINGS_BUCKET ][ self::OP_ID_SETTINGS_KEY ] = $op_id;
		}

		return $merged;
	}

	/**
	 * Recursive deep-merge (Implementation Notes): scalar keys overwrite; nested assoc arrays merge;
	 * numeric-indexed (repeater) arrays are REPLACED wholesale by the patch. NOT array_merge_recursive
	 * (which duplicates scalars).
	 *
	 * @param array<string,mixed> $base  The base settings.
	 * @param array<string,mixed> $patch The patch (wins per key).
	 *
	 * @return array<string,mixed>
	 */
	private static function deep_merge( array $base, array $patch ): array {
		foreach ( $patch as $key => $value ) {
			if ( is_array( $value )
				&& isset( $base[ $key ] )
				&& is_array( $base[ $key ] )
				&& self::is_assoc( $value )
				&& self::is_assoc( $base[ $key ] )
			) {
				$base[ $key ] = self::deep_merge( $base[ $key ], $value );
			} else {
				// Scalars, numeric (repeater) arrays, and new keys: the patch replaces wholesale.
				$base[ $key ] = $value;
			}
		}
		return $base;
	}

	/**
	 * Whether an array is associative (string keys) vs a numeric list (a repeater).
	 *
	 * @param array<mixed> $arr The array.
	 */
	private static function is_assoc( array $arr ): bool {
		if ( array() === $arr ) {
			return true; // An empty {} merges as an object.
		}
		return array_keys( $arr ) !== range( 0, count( $arr ) - 1 );
	}

	// ------------------------------------------------------------------------------------------------
	// Internal: WP / Elementor seams + concurrency helpers.
	// ------------------------------------------------------------------------------------------------

	/**
	 * Optimistic-concurrency check (10 §0.8). Skips when `$expected` is null OR `$force`. On mismatch a 409
	 * CONCURRENCY_STALE_HASH WP_Error (canonical taxonomy code, 12 §3.2) carrying current_base_hash meta.
	 *
	 * @param int         $post_id  The document id.
	 * @param string|null $expected Caller-supplied base_hash (null = no check).
	 * @param bool        $force    When true, bypass entirely.
	 *
	 * @return true|WP_Error
	 */
	private static function assert_base_hash( int $post_id, ?string $expected, bool $force ) {
		if ( null === $expected || '' === $expected || $force ) {
			return true;
		}
		$actual = self::base_hash( $post_id );
		if ( hash_equals( $actual, (string) $expected ) ) {
			return true;
		}
		return self::error(
			Error_Codes::CONCURRENCY_STALE_HASH,
			__( 'The document changed since you last read it (stale base_hash). Re-read for a fresh base_hash and retry.', 'elementor-ultra-mcp' ),
			409,
			array(
				'post_id'           => $post_id,
				'expected_hash'     => $expected,
				'current_base_hash' => $actual,
			)
		);
	}

	/**
	 * The optimistic-concurrency token: `md5( _elementor_data )` (10 §0.8).
	 *
	 * @param int $post_id The document id.
	 */
	private static function base_hash( int $post_id ): string {
		return md5( (string) get_post_meta( $post_id, '_elementor_data', true ) );
	}

	/**
	 * Resolve a document instance (or null when Elementor / the doc is absent).
	 *
	 * @param int $post_id The document id.
	 *
	 * @return object|null
	 */
	private static function get_document( int $post_id ) {
		if ( $post_id <= 0 || ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->documents ) ) {
			return null;
		}
		$document = $plugin->documents->get( $post_id );
		return ( $document && is_object( $document ) ) ? $document : null;
	}

	/**
	 * The post's `_elementor_data` tree as a decoded array (read-only; for the diff `before`). Null when
	 * absent.
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array<int,array<string,mixed>>|null
	 */
	/**
	 * Flatten an element tree into `id => {elType, widgetType, parent}` (drop-manifest support,
	 * step 10b). Nodes without an id are skipped (they cannot be tracked across the save).
	 *
	 * @param array       $elements Element list (each with optional `elements` children).
	 * @param array       $out      Accumulator (by reference).
	 * @param string|null $parent   Parent element id for the current depth.
	 */
	private static function index_elements( array $elements, array &$out, ?string $parent = null ): void {
		foreach ( $elements as $el ) {
			if ( ! is_array( $el ) ) {
				continue;
			}
			$eid = isset( $el['id'] ) && is_string( $el['id'] ) ? $el['id'] : null;
			if ( null !== $eid ) {
				$out[ $eid ] = array(
					'elType'     => isset( $el['elType'] ) ? (string) $el['elType'] : '',
					'widgetType' => isset( $el['widgetType'] ) ? (string) $el['widgetType'] : null,
					'parent'     => $parent,
				);
			}
			if ( isset( $el['elements'] ) && is_array( $el['elements'] ) ) {
				self::index_elements( $el['elements'], $out, $eid );
			}
		}
	}

	private static function read_tree( int $post_id ): ?array {
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
	 * Whether the document's tree is V4 atomic (prefer the Css_Primer detector; else a structural scan).
	 *
	 * @param int $post_id The document id.
	 */
	private static function is_atomic_document( int $post_id ): bool {
		if ( class_exists( '\Elementor\Ultra\Core\Css_Primer' ) && method_exists( '\Elementor\Ultra\Core\Css_Primer', 'is_atomic_document' ) ) {
			return ( new Css_Primer() )->is_atomic_document( $post_id );
		}
		$tree = self::read_tree( $post_id );
		return null !== $tree && self::tree_has_atomic( $tree );
	}

	/**
	 * Structural atomic detector fallback: any `e-*` elType/widgetType or any non-empty `styles` map.
	 *
	 * @param array<int,array<string,mixed>> $elements The tree.
	 */
	private static function tree_has_atomic( array $elements ): bool {
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			$el_type     = isset( $node['elType'] ) && is_string( $node['elType'] ) ? $node['elType'] : '';
			$widget_type = isset( $node['widgetType'] ) && is_string( $node['widgetType'] ) ? $node['widgetType'] : '';
			if ( 0 === strpos( $el_type, 'e-' ) || 0 === strpos( $widget_type, 'e-' ) ) {
				return true;
			}
			if ( isset( $node['styles'] ) && is_array( $node['styles'] ) && ! empty( $node['styles'] ) ) {
				return true;
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) && self::tree_has_atomic( $node['elements'] ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The WP preview URL for a document (the §2.6 `preview_url`). Null when not derivable.
	 *
	 * @param int $post_id The document id.
	 */
	private static function preview_url( int $post_id ): ?string {
		if ( ! function_exists( 'get_preview_post_link' ) ) {
			return null;
		}
		$url = get_preview_post_link( $post_id );
		return ( is_string( $url ) && '' !== $url ) ? $url : null;
	}

	/**
	 * Append one op-log row behind a class_exists guard (WP-P14; soft dep — never fails the write).
	 *
	 * @param int         $post_id     The document id.
	 * @param string|null $op_id       The op id.
	 * @param string      $route       The route/tool label.
	 * @param string      $before_hash The pre-write base_hash.
	 * @param string      $after_hash  The post-write base_hash.
	 * @param string      $result      The result label.
	 */
	private static function op_log( int $post_id, ?string $op_id, string $route, string $before_hash, string $after_hash, string $result ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		Op_Log::record(
			array(
				'op_id'       => $op_id,
				'post_id'     => $post_id,
				'route'       => $route,
				'before_hash' => '' !== $before_hash ? $before_hash : null,
				'after_hash'  => '' !== $after_hash ? $after_hash : null,
				'result'      => $result,
			)
		);
	}

	/**
	 * Build a taxonomy WP_Error in the envelope shape (10 §0.6, 12 §2). The CANONICAL taxonomy code is the
	 * WP_Error code; `data.status` + meta + errors[] populate the §0.6 envelope.
	 *
	 * @param string                         $code    Taxonomy code (Error_Codes::*).
	 * @param string                         $message Human message.
	 * @param int                            $status  HTTP status.
	 * @param array<string,mixed>            $meta    Code-specific meta.
	 * @param array<int,array<string,mixed>> $errors  Per-item validation errors.
	 * @param string|null                    $op_id   Echoed op id.
	 */
	private static function error( string $code, string $message, int $status, array $meta = array(), array $errors = array(), ?string $op_id = null ): WP_Error {
		// Prefer the central WP-P02 Error factory (consistent envelope); fall back to a bare WP_Error.
		if ( class_exists( '\Elementor\Ultra\Core\Error' ) && method_exists( '\Elementor\Ultra\Core\Error', 'make' ) ) {
			$error = Error::make( $code, $message, $status, $meta, $errors );
			if ( null !== $op_id ) {
				$data = (array) $error->get_error_data();
				$error->add_data( array_merge( $data, array( 'op_id' => $op_id ) ) );
			}
			return $error;
		}

		$data = array(
			'status' => $status,
			'meta'   => $meta,
		);
		if ( ! empty( $errors ) ) {
			$data['errors'] = array_values( $errors );
		}
		if ( null !== $op_id ) {
			$data['op_id'] = $op_id;
		}
		return new WP_Error( $code, $message, $data );
	}
}
