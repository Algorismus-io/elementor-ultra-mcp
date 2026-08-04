<?php
/**
 * WP-P04 — Backup_Service: revision-independent snapshots + restore for the write engine.
 *
 * Contract authority:
 *  - 10-rest-api.md §2.8 (`POST /backup`, `GET /backups`, `POST /rollback` payloads).
 *  - 11-authoring-contract.md §10 (NEVER raw-write `_elementor_data`; restores go through Document::save).
 *  - 15-engineering-standards.md §3.8 / item 8 (revision-independent backup BEFORE every write —
 *    `_emcp_backup_{ts}` meta AND wp_save_post_revision, because agency sites often set
 *    WP_POST_REVISIONS=false).
 *
 * SPIKE-VERIFIED CORRECTIONS:
 *  - [R6] Deleting a kit class rewrites all docs -> a rollback must full-flush + re-prime the dependents;
 *    this service triggers a per-post CSS/cache delete on rollback and a re-prime (V4) / Post_CSS regen
 *    (V3), delegating the flush to WP-P05 Cache_Service / Css_Primer behind class_exists guards.
 *  - [S07/C6] CSS flush is reliable only as the web-server uid; rollback runs in the authed REST request
 *    (web-server uid) so the per-post delete + regen lands on disk.
 *
 * Snapshots READ raw `_elementor_data` + `_elementor_page_settings` meta (read-only is allowed, 11 §10),
 * but RESTORES persist exclusively via `Document::save(['elements','settings'])` — never a raw meta write.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Takes revision-independent snapshots into `_emcp_backup_{ts}` meta (+ a WP revision) and restores them
 * via the document pipeline. The write engine ({@see Document_Writer}) calls snapshot() before every write.
 */
final class Backup_Service {

	/** The meta-key prefix for revision-independent snapshots (10 §2.8). */
	const META_PREFIX = '_emcp_backup_';

	/** Default cap on retained snapshots per post (Detailed Req #7 — avoid meta bloat). */
	const DEFAULT_KEEP = 20;

	/**
	 * Take a revision-independent snapshot of a document (10 §2.8). Copies `_elementor_data` +
	 * `_elementor_page_settings` into a single `_emcp_backup_{ts}` meta (JSON
	 * `{data, settings, ts, label, base_hash, op_id}`) AND calls `wp_save_post_revision`. Prunes old
	 * snapshots after creating the new one. Returns the backup handle.
	 *
	 * @param int         $post_id The document id.
	 * @param string|null $label   Optional human label.
	 * @param string|null $op_id   Optional op id (§0.8) recorded with the snapshot.
	 *
	 * @return array{meta_key:string,revision_id:int,ts:int,label:?string,base_hash:string}
	 */
	public static function snapshot( int $post_id, ?string $label = null, ?string $op_id = null ): array {
		$data      = get_post_meta( $post_id, '_elementor_data', true );
		$settings  = get_post_meta( $post_id, '_elementor_page_settings', true );
		$ts        = time();
		$meta_key  = self::META_PREFIX . $ts;
		$base_hash = self::base_hash( $post_id );

		// Avoid clobbering a snapshot taken in the same second (rapid successive writes).
		$suffix = 0;
		while ( '' !== (string) get_post_meta( $post_id, $meta_key, true ) ) {
			++$suffix;
			$meta_key = self::META_PREFIX . $ts . '_' . $suffix;
		}

		$payload = array(
			'data'      => is_string( $data ) ? $data : wp_json_encode( $data ),
			'settings'  => is_array( $settings ) ? $settings : array(),
			'ts'        => $ts,
			'label'     => null !== $label ? (string) $label : null,
			'base_hash' => $base_hash,
			'op_id'     => null !== $op_id ? (string) $op_id : null,
		);

		// Stored as a JSON string (wp_slash to survive WP's wp_unslash on insert).
		update_post_meta( $post_id, $meta_key, wp_slash( (string) wp_json_encode( $payload ) ) );

		// The revision half — independent of WP_POST_REVISIONS (Standards §3.8).
		$revision_id = (int) self::save_revision( $post_id );

		// Cap retained snapshots (Detailed Req #7).
		self::prune( $post_id, self::DEFAULT_KEEP );

		return array(
			// phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- response payload key (10 §2.8), not a query arg.
			'meta_key'    => $meta_key,
			'revision_id' => $revision_id,
			'ts'          => $ts,
			'label'       => $payload['label'],
			'base_hash'   => $base_hash,
		);
	}

	/**
	 * List a document's snapshots newest-first (10 §2.8 `GET /backups`). Each item:
	 * `{meta_key, ts, label, base_hash}`. Returns a plain list (the controller applies §0.11 pagination).
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array<int,array{meta_key:string,ts:int,label:?string,base_hash:string}>
	 */
	public static function list_backups( int $post_id ): array {
		$items = array();

		foreach ( self::snapshot_meta( $post_id ) as $meta_key => $payload ) {
			$items[] = array(
				// phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- response payload key (10 §2.8), not a query arg.
				'meta_key'  => $meta_key,
				'ts'        => isset( $payload['ts'] ) ? (int) $payload['ts'] : self::ts_from_key( $meta_key ),
				'label'     => isset( $payload['label'] ) ? $payload['label'] : null,
				'base_hash' => isset( $payload['base_hash'] ) ? (string) $payload['base_hash'] : '',
			);
		}

		// Newest first.
		usort(
			$items,
			static function ( $a, $b ) {
				return $b['ts'] <=> $a['ts'];
			}
		);

		return $items;
	}

	/**
	 * Restore a snapshot (10 §2.8 `POST /rollback`). Reads the `_emcp_backup_{meta_key}` payload, restores
	 * `_elementor_data` + `_elementor_page_settings` via `Document::save(['elements','settings'])` (NOT raw
	 * meta — 11 §10), deletes the per-post CSS/cache, and regenerates: V4 atomic → `Css_Primer::prime`
	 * (when `$prime_css`); V3 → `Post_CSS::create($id)->update()`. Returns the new base_hash.
	 *
	 * The restore is itself transactional (Standards item 7/8, mirroring {@see Document_Writer::write}):
	 *  - `$meta_key` MUST be a real `_emcp_backup_*` snapshot with the expected payload shape — any other
	 *    meta key (e.g. `_elementor_data`, `_elementor_page_settings`) would decode to a bogus payload and
	 *    silently wipe the page, so it is rejected up front.
	 *  - editable -> lock/autosave -> optional base_hash gates run BEFORE any mutation (LOCK_HELD /
	 *    AUTOSAVE_CONFLICT / CONCURRENCY_STALE_HASH, 12 §3.2; `$force` overrides, as in the writer).
	 *  - snapshot SETTINGS pass the contract-18 §7-AI S1 allowlist (`Validator::validate_settings`)
	 *    BEFORE the restore — a pre-S1 snapshot carrying the AF1 object `custom_css` is a hard
	 *    `SETTINGS_INVALID`, never a re-persisted sitewide fatal (NOT `$force`-bypassable: force
	 *    overrides concurrency gates, not render-safety).
	 *  - a `pre-rollback` snapshot of the CURRENT state is taken before restoring (backup BEFORE every
	 *    write) and its handle is returned, so a rollback to the wrong snapshot can itself be undone.
	 *
	 * @param int         $post_id   The document id.
	 * @param string      $meta_key  The snapshot meta key (`_emcp_backup_{ts}`).
	 * @param bool        $prime_css When true, prime V4 atomic CSS after restore.
	 * @param string|null $base_hash Optional optimistic-concurrency token (10 §0.8); checked when non-empty.
	 * @param bool        $force     When true, bypass the lock/autosave + base_hash gates (writer parity).
	 * @param string|null $op_id     Optional op id (§0.8) recorded with the pre-rollback snapshot.
	 *
	 * @return array{id:int,restored_from:string,base_hash:string,css_primed:bool,pre_rollback_backup:array<string,mixed>}|WP_Error
	 */
	public static function rollback( int $post_id, string $meta_key, bool $prime_css = false, ?string $base_hash = null, bool $force = false, ?string $op_id = null ) {
		if ( $post_id <= 0 || ! get_post( $post_id ) ) {
			return self::not_found( sprintf( 'Document %d not found.', $post_id ) );
		}

		// Only our own snapshots are restorable. Without this gate an arbitrary meta key (e.g.
		// `_elementor_page_settings`) decodes to an array with no `data` key and the restore would persist
		// an EMPTY tree — a silent destructive write.
		if ( 0 !== strpos( $meta_key, self::META_PREFIX ) ) {
			return self::not_found(
				sprintf( '"%s" is not a snapshot meta key (expected an "%s*" handle) on document %d.', $meta_key, self::META_PREFIX, $post_id )
			);
		}

		$raw = get_post_meta( $post_id, $meta_key, true );
		if ( '' === (string) $raw ) {
			return self::not_found( sprintf( 'Snapshot "%s" not found on document %d.', $meta_key, $post_id ) );
		}

		$payload = self::decode_payload( $raw );
		if ( null === $payload || ! self::is_snapshot_payload( $payload ) ) {
			return self::not_found( sprintf( 'Snapshot "%s" on document %d is unreadable (not a valid snapshot payload).', $meta_key, $post_id ) );
		}

		$elements = self::decode_elements( $payload['data'] );
		$settings = isset( $payload['settings'] ) && is_array( $payload['settings'] ) ? $payload['settings'] : array();

		// S1 parity on the RESTORE path (contract 18 §7-AI): a PRE-S1 snapshot can carry render-fatal
		// settings shapes — e.g. the AF1 object `custom_css` Pro's custom-css module `trim()`s into a
		// sitewide fatal. Re-persisting it via Document::save() would re-create the exact failure the
		// settings allowlist exists to kill, with a green rollback result. Validate BEFORE any mutation
		// (the writer's save path validates its own settings; rollback bypasses apply_settings_merge).
		if ( ! empty( $settings ) && class_exists( '\Elementor\Ultra\Validator' ) ) {
			$settings_errors = \Elementor\Ultra\Validator::validate_settings( $settings );
			if ( ! empty( $settings_errors ) ) {
				return self::error(
					\Elementor\Ultra\Error_Codes::SETTINGS_INVALID,
					sprintf(
						/* translators: 1: snapshot meta key, 2: first validation message. */
						__( 'Rollback refused: snapshot "%1$s" carries document settings the front-end render would fatal on (%2$s). Restore a healthier snapshot, or strip the offending key (e.g. update_settings {custom_css: ""}) and re-snapshot.', 'elementor-ultra-mcp' ),
						$meta_key,
						isset( $settings_errors[0]['message'] ) ? (string) $settings_errors[0]['message'] : 'invalid settings shape'
					),
					422,
					array(
						'post_id'  => $post_id,
						'snapshot' => $meta_key,
						'errors'   => $settings_errors,
					)
				);
			}
		}

		$document = self::get_document( $post_id );
		if ( null === $document ) {
			return self::not_found( sprintf( 'Document %d is not Elementor-built; cannot rollback.', $post_id ) );
		}

		// Transactional gates (writer parity — Document_Writer guarded so the service degrades in isolation).
		if ( class_exists( __NAMESPACE__ . '\Document_Writer' ) ) {
			$editable = Document_Writer::is_editable( $post_id );
			if ( is_wp_error( $editable ) ) {
				return $editable;
			}

			if ( ! $force ) {
				// wp_check_post_lock() lives in wp-admin/includes/post.php, which is NOT loaded on REST
				// requests — without it lock_status() silently reports locked:false and the LOCK_HELD gate
				// is dead code over REST (another editor's _edit_lock would be clobbered).
				if ( ! function_exists( 'wp_check_post_lock' ) ) {
					require_once ABSPATH . 'wp-admin/includes/post.php';
				}
				$lock = Document_Writer::lock_status( $post_id );
				if ( $lock['locked'] ) {
					return self::error(
						\Elementor\Ultra\Error_Codes::LOCK_HELD,
						__( 'The document is locked by another user in the editor; rollback would clobber their work. Pass force:true to override.', 'elementor-ultra-mcp' ),
						409,
						array( 'locked_by' => $lock['locked_by'] )
					);
				}
				if ( $lock['newer_autosave'] ) {
					return self::error(
						\Elementor\Ultra\Error_Codes::AUTOSAVE_CONFLICT,
						__( 'A newer autosave exists for this document; rollback would discard it. Pass force:true to override.', 'elementor-ultra-mcp' ),
						409,
						array(
							'autosave_ts'     => $lock['autosave_ts'],
							'autosave_author' => $lock['autosave_author'],
						)
					);
				}
			}
		}

		// Optional optimistic-concurrency check (10 §0.8) — skipped when no hash supplied or forced.
		if ( null !== $base_hash && '' !== $base_hash && ! $force ) {
			$actual = self::base_hash( $post_id );
			if ( ! hash_equals( $actual, $base_hash ) ) {
				return self::error(
					\Elementor\Ultra\Error_Codes::CONCURRENCY_STALE_HASH,
					__( 'The document changed since you last read it (stale base_hash). Re-read for a fresh base_hash and retry.', 'elementor-ultra-mcp' ),
					409,
					array(
						'post_id'           => $post_id,
						'expected_hash'     => $base_hash,
						'current_base_hash' => $actual,
					)
				);
			}
		}

		// Backup BEFORE the write (Standards item 8) — the one snapshot that makes rollback reversible.
		// Taken AFTER decoding the target payload, so prune() can never drop the snapshot being restored.
		$pre_rollback = self::snapshot( $post_id, 'pre-rollback', $op_id );

		// Restore via Document::save — the ONLY persist path (11 §10). save() deletes _elementor_css +
		// _elementor_element_cache internally (core/base/document.php:867,872).
		$save_data = array( 'elements' => $elements );
		// Only restore settings when the snapshot captured them (an empty {} would wipe page settings).
		if ( ! empty( $settings ) ) {
			$save_data['settings'] = $settings;
		}

		$saved = $document->save( $save_data );
		if ( ! $saved ) {
			return new WP_Error(
				\Elementor\Ultra\Error_Codes::NOT_EDITABLE,
				__( 'Rollback failed: the document is not editable by the current user (or the save was rejected).', 'elementor-ultra-mcp' ),
				array(
					'status' => 403,
					'meta'   => array( 'post_id' => $post_id ),
				)
			);
		}

		// Belt-and-suspenders cache delete (the prime/regen needs a clean slate; [S07] runs as web-server uid).
		self::flush_post_css( $post_id );

		// Regenerate per generation ([R6] dependents must be re-primed after a class-rewriting restore).
		$css_primed = self::regen_after_restore( $post_id, $prime_css );

		return array(
			'id'                  => $post_id,
			'restored_from'       => $meta_key,
			'base_hash'           => self::base_hash( $post_id ),
			'css_primed'          => $css_primed,
			// The undo-the-undo handle: the state that existed just before this rollback.
			'pre_rollback_backup' => $pre_rollback,
		);
	}

	/**
	 * Cap retained snapshots to `$keep` newest, deleting older `_emcp_backup_*` meta (Detailed Req #7 —
	 * avoid meta bloat as snapshots persist across writes). Returns the number pruned.
	 *
	 * @param int $post_id The document id.
	 * @param int $keep    Number of newest snapshots to retain.
	 *
	 * @return int
	 */
	public static function prune( int $post_id, int $keep = self::DEFAULT_KEEP ): int {
		$keep  = max( 0, $keep );
		$items = self::list_backups( $post_id ); // newest first.
		if ( count( $items ) <= $keep ) {
			return 0;
		}

		$pruned = 0;
		foreach ( array_slice( $items, $keep ) as $item ) {
			if ( delete_post_meta( $post_id, $item['meta_key'] ) ) {
				++$pruned;
			}
		}
		return $pruned;
	}

	// ------------------------------------------------------------------------------------------------
	// Internal: meta + payload helpers.
	// ------------------------------------------------------------------------------------------------

	/**
	 * All `_emcp_backup_*` snapshots for a post as `{meta_key => decoded payload}`.
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	private static function snapshot_meta( int $post_id ): array {
		$all = get_post_meta( $post_id );
		if ( ! is_array( $all ) ) {
			return array();
		}

		$out = array();
		foreach ( $all as $meta_key => $values ) {
			if ( 0 !== strpos( (string) $meta_key, self::META_PREFIX ) ) {
				continue;
			}
			$raw     = is_array( $values ) ? ( $values[0] ?? '' ) : $values;
			$payload = self::decode_payload( $raw );
			if ( null !== $payload ) {
				$out[ (string) $meta_key ] = $payload;
			}
		}
		return $out;
	}

	/**
	 * Decode a stored snapshot meta value to its payload array. The value may arrive slashed (WP stores
	 * meta unslashed but get_post_meta returns it raw); json_decode handles both.
	 *
	 * @param mixed $raw The stored meta value.
	 *
	 * @return array<string,mixed>|null
	 */
	private static function decode_payload( $raw ): ?array {
		if ( is_array( $raw ) ) {
			return $raw;
		}
		if ( ! is_string( $raw ) || '' === $raw ) {
			return null;
		}
		$decoded = json_decode( $raw, true );
		if ( ! is_array( $decoded ) ) {
			// May have been stored slashed; retry after unslash.
			$decoded = json_decode( wp_unslash( $raw ), true );
		}
		return is_array( $decoded ) ? $decoded : null;
	}

	/**
	 * Whether a decoded payload has the {@see snapshot()} shape: a `data` key (string or array) AND a
	 * numeric `ts`. Guards rollback against corrupt/foreign `_emcp_backup_*` meta whose absent `data`
	 * would otherwise restore an empty tree.
	 *
	 * @param array<string,mixed> $payload The decoded payload.
	 */
	private static function is_snapshot_payload( array $payload ): bool {
		if ( ! array_key_exists( 'data', $payload ) || ( ! is_string( $payload['data'] ) && ! is_array( $payload['data'] ) ) ) {
			return false;
		}
		return isset( $payload['ts'] ) && is_numeric( $payload['ts'] );
	}

	/**
	 * Decode the snapshot's `data` (the captured `_elementor_data`) into an elements array.
	 *
	 * @param mixed $data The snapshot `data` (JSON string or array).
	 *
	 * @return array<int,array<string,mixed>>
	 */
	private static function decode_elements( $data ): array {
		if ( is_array( $data ) ) {
			return $data;
		}
		if ( is_string( $data ) && '' !== $data ) {
			$decoded = json_decode( $data, true );
			return is_array( $decoded ) ? $decoded : array();
		}
		return array();
	}

	/**
	 * The ts encoded in a `_emcp_backup_{ts}[_n]` meta key.
	 *
	 * @param string $meta_key The snapshot meta key.
	 */
	private static function ts_from_key( string $meta_key ): int {
		$tail = substr( $meta_key, strlen( self::META_PREFIX ) );
		$ts   = (int) strtok( $tail, '_' );
		return $ts;
	}

	// ------------------------------------------------------------------------------------------------
	// Internal: WP / Elementor seams.
	// ------------------------------------------------------------------------------------------------

	/**
	 * `wp_save_post_revision` wrapper — the revision half of the backup. Returns the revision id (0 when
	 * revisions are disabled or no change to snapshot).
	 *
	 * @param int $post_id The document id.
	 */
	private static function save_revision( int $post_id ): int {
		if ( ! function_exists( 'wp_save_post_revision' ) ) {
			return 0;
		}
		$rev = wp_save_post_revision( $post_id );
		return is_int( $rev ) ? $rev : 0;
	}

	/**
	 * Resolve a document instance (or null). Guarded so the service degrades gracefully without Elementor.
	 *
	 * @param int $post_id The document id.
	 *
	 * @return object|null
	 */
	private static function get_document( int $post_id ) {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
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
	 * Delete the per-post Elementor CSS + cache (prefer WP-P05 Cache_Service; else Post_CSS). Runs in the
	 * authed REST request as the web-server uid so the delete actually lands ([S07/C6]).
	 *
	 * @param int $post_id The document id.
	 */
	private static function flush_post_css( int $post_id ): void {
		if ( class_exists( '\Elementor\Ultra\Core\Cache_Service' ) && method_exists( '\Elementor\Ultra\Core\Cache_Service', 'flush_post' ) ) {
			( new Cache_Service() )->flush_post( $post_id );
			return;
		}
		if ( class_exists( '\Elementor\Core\Files\CSS\Post' ) ) {
			\Elementor\Core\Files\CSS\Post::create( $post_id )->delete();
		}
	}

	/**
	 * Regenerate CSS after a restore. V4 atomic → Css_Primer::prime (when $prime_css and the primer is
	 * present); V3 → Post_CSS::create($id)->update(). Returns whether atomic CSS was confirmed primed.
	 *
	 * @param int  $post_id   The document id.
	 * @param bool $prime_css Whether to prime V4 atomic CSS.
	 */
	private static function regen_after_restore( int $post_id, bool $prime_css ): bool {
		$is_atomic = self::is_atomic_document( $post_id );

		if ( $is_atomic ) {
			if ( $prime_css && class_exists( '\Elementor\Ultra\Core\Css_Primer' ) ) {
				$primer = new Css_Primer();
				$result = $primer->prime( $post_id );
				if ( is_array( $result ) && ! empty( $result['css_primed'] ) ) {
					return true;
				}
			}
			// Atomic page not primed in-request — caller must call prime-css (10 §0.10).
			return false;
		}

		// V3 path: eager regen so the restored page renders immediately.
		if ( class_exists( '\Elementor\Core\Files\CSS\Post' ) ) {
			\Elementor\Core\Files\CSS\Post::create( $post_id )->update();
		}
		return true; // V3 needs no atomic prime — restored CSS is regenerated.
	}

	/**
	 * Whether a document's tree is V4 atomic (prefer the Css_Primer detector; else a structural scan).
	 *
	 * @param int $post_id The document id.
	 */
	private static function is_atomic_document( int $post_id ): bool {
		if ( class_exists( '\Elementor\Ultra\Core\Css_Primer' ) && method_exists( '\Elementor\Ultra\Core\Css_Primer', 'is_atomic_document' ) ) {
			return ( new Css_Primer() )->is_atomic_document( $post_id );
		}

		$raw  = get_post_meta( $post_id, '_elementor_data', true );
		$data = is_string( $raw ) ? json_decode( $raw, true ) : $raw;
		if ( ! is_array( $data ) ) {
			return false;
		}
		return self::tree_has_atomic( $data );
	}

	/**
	 * Structural fallback atomic detector: any `e-*` elType/widgetType or any non-empty `styles` map.
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
	 * The optimistic-concurrency token for a document: `md5( _elementor_data )` (10 §0.8).
	 *
	 * @param int $post_id The document id.
	 */
	private static function base_hash( int $post_id ): string {
		return md5( (string) get_post_meta( $post_id, '_elementor_data', true ) );
	}

	/**
	 * Build a 404 NOT_FOUND WP_Error in the taxonomy envelope shape (10 §2.8 errors).
	 *
	 * @param string $message Human message.
	 */
	private static function not_found( string $message ): WP_Error {
		return new WP_Error(
			\Elementor\Ultra\Error_Codes::NOT_FOUND,
			$message,
			array( 'status' => 404 )
		);
	}

	/**
	 * Build a taxonomy WP_Error in the envelope shape (10 §0.6, 12 §2) — prefer the central WP-P02 Error
	 * factory (consistent envelope); fall back to a bare WP_Error.
	 *
	 * @param string              $code    Taxonomy code (Error_Codes::*).
	 * @param string              $message Human message.
	 * @param int                 $status  HTTP status.
	 * @param array<string,mixed> $meta    Code-specific meta.
	 */
	private static function error( string $code, string $message, int $status, array $meta = array() ): WP_Error {
		if ( class_exists( '\Elementor\Ultra\Core\Error' ) && method_exists( '\Elementor\Ultra\Core\Error', 'make' ) ) {
			return Error::make( $code, $message, $status, $meta );
		}
		return new WP_Error(
			$code,
			$message,
			array(
				'status' => $status,
				'meta'   => $meta,
			)
		);
	}
}
