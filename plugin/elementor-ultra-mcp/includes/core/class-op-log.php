<?php
/**
 * WP-P14 — Ops audit-log store: the shared write-trail every WRITE route appends one row to.
 *
 * Contract authority: 10-rest-api.md §11 (op-log row fields `(op_id, post_id, user, route,
 * before/after base_hash, result, ts)` + the `route`->`tool` response mapping), §0.8 (`op_id`
 * recorded per write; consulted for idempotent-replay detection), §0.11 (pagination contract);
 * 15-engineering-standards.md §3 (observability is a cross-cutting PHP-owned concern).
 *
 * Design (WP-P14 Implementation Notes):
 *  - A custom table `{$wpdb->prefix}emcp_ops` (NOT wp_options/postmeta) so `op_id`/`post_id`/`ts`
 *    are indexable for cheap idempotency + audit lookups. Created via `dbDelta`, guarded by a
 *    stored schema-version option so `dbDelta` only runs when the schema changes.
 *  - {@see Op_Log::init()} is wired EARLY by {@see \Elementor\Ultra\Plugin::init()} (behind a
 *    `class_exists` guard), before controllers register, so the store exists for the writer
 *    (WP-P04), every WRITE controller, and the Abilities observability handler (WP-P16) — all of
 *    which call {@see Op_Log::record()} behind a `class_exists('\Elementor\Ultra\Core\Op_Log')`
 *    guard so a build WITHOUT this WP degrades to no-logging (the WRITE still succeeds).
 *  - {@see Op_Log::record()} is FAILURE-TOLERANT: a logging failure must NEVER fail the underlying
 *    WRITE (wrapped in try/catch, swallowed + `error_log`).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The single op-log store + entry point. Static surface so it is callable from anywhere behind a
 * cheap `class_exists` guard without instantiation.
 */
final class Op_Log {

	/** Unprefixed custom-table base name (final table = `{$wpdb->prefix}emcp_ops`). */
	const TABLE = 'emcp_ops';

	/** Option storing the installed schema version (gates `dbDelta` so it only runs on change). */
	const SCHEMA_OPTION = 'emcp_ops_schema_version';

	/** Current schema version — bump on any column/index change to re-run `dbDelta`. */
	const SCHEMA_VERSION = '1';

	/** Default retention cap for {@see Op_Log::prune()} (keep at most this many newest rows). */
	const DEFAULT_KEEP = 5000;

	/** Run an opportunistic {@see Op_Log::prune()} roughly once per this many records. */
	const PRUNE_EVERY = 200;

	/**
	 * Ensure the op-log store exists. Idempotent + cheap: `dbDelta` runs only when the stored
	 * schema version differs from {@see Op_Log::SCHEMA_VERSION} (WP-P14 Implementation Notes).
	 *
	 * Wired by {@see \Elementor\Ultra\Plugin::init()} early (before controllers register) so the
	 * table is guaranteed present when the first WRITE route appends a row.
	 *
	 * @return void
	 */
	public static function init() {
		self::register_controller();

		if ( get_option( self::SCHEMA_OPTION ) === self::SCHEMA_VERSION ) {
			return;
		}
		self::install();
		update_option( self::SCHEMA_OPTION, self::SCHEMA_VERSION );
	}

	/**
	 * Load + wire the WP-P14 {@see \Elementor\Ultra\Rest\Ops_Controller} so its `GET /ops/log` route
	 * registers. The SPL autoloader only loads a controller file when its class is referenced, and the
	 * WP-P02 spine `Registrar` does not include controller files itself (the parallelism principle), so
	 * the controller's self-registration action would never be parsed unless something loads the file.
	 *
	 * {@see Op_Log::init()} is the natural loader: the WP-P01 spine invokes it EARLY (during
	 * `Plugin::init()` on `plugins_loaded`, BEFORE `rest_api_init` fires and BEFORE the registrar runs),
	 * and both files are WP-P14's. `require_once` the controller file (when present) so its
	 * `add_action( Registrar::REGISTER_ACTION, … )` self-registration is in place when the registrar
	 * fires that action on `rest_api_init`. Guarded so a build without the controller file is a no-op.
	 *
	 * @return void
	 */
	private static function register_controller() {
		$controller = EMCP_PATH . 'includes/rest/class-ops-controller.php';
		if ( ! class_exists( '\Elementor\Ultra\Rest\Ops_Controller' ) && is_readable( $controller ) ) {
			require_once $controller;
		}
	}

	/**
	 * Create/upgrade the `{$wpdb->prefix}emcp_ops` table via `dbDelta` (WP-P14 Detailed
	 * Requirements #1). Columns: `id, op_id (varchar 64), post_id (bigint), user_login (varchar),
	 * route (varchar), before_hash (char 32), after_hash (char 32), result (varchar), ts (bigint),
	 * meta (longtext)`, indexed on `post_id`, `op_id`, `ts`.
	 *
	 * @return void
	 */
	public static function install() {
		global $wpdb;

		$table           = self::table_name();
		$charset_collate = $wpdb->get_charset_collate();

		// dbDelta is picky about formatting: two spaces after PRIMARY KEY, KEY on its own lines.
		$sql = "CREATE TABLE {$table} (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			op_id varchar(64) DEFAULT NULL,
			post_id bigint(20) DEFAULT NULL,
			user_login varchar(60) DEFAULT NULL,
			route varchar(191) DEFAULT NULL,
			before_hash char(32) DEFAULT NULL,
			after_hash char(32) DEFAULT NULL,
			result varchar(64) DEFAULT NULL,
			ts bigint(20) DEFAULT NULL,
			meta longtext DEFAULT NULL,
			PRIMARY KEY  (id),
			KEY post_id (post_id),
			KEY op_id (op_id),
			KEY ts (ts)
		) {$charset_collate};";

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		dbDelta( $sql );
	}

	/**
	 * Append exactly one op-log row for a WRITE route invocation (10-rest-api.md §11). The single
	 * entry point for BOTH the REST path and the Abilities observability handler (WP-P16) — keep
	 * `record()` the only writer so both paths land in the same store.
	 *
	 * FAILURE-TOLERANT (WP-P14 Implementation Notes): never throws; a logging failure is swallowed
	 * and `error_log`-ged so it can NEVER fail the underlying WRITE. Returns the inserted row id, or
	 * `0` when the row could not be written.
	 *
	 * @param array{op_id?:?string,post_id?:?int,user?:?string,route?:?string,before_hash?:?string,after_hash?:?string,result?:?string,ts?:?int,meta?:mixed} $row Row fields (all optional; missing values default sensibly).
	 * @return int Inserted row id, or 0 on failure.
	 */
	public static function record( array $row ): int {
		try {
			global $wpdb;

			$user_login = isset( $row['user'] ) && '' !== (string) $row['user']
				? (string) $row['user']
				: self::current_user_login();

			$ts = isset( $row['ts'] ) && null !== $row['ts'] ? (int) $row['ts'] : time();

			$meta = null;
			if ( isset( $row['meta'] ) && null !== $row['meta'] ) {
				$meta = is_string( $row['meta'] ) ? $row['meta'] : (string) wp_json_encode( $row['meta'] );
			}

			$data = array(
				'op_id'       => self::nullable_string( $row['op_id'] ?? null, 64 ),
				'post_id'     => isset( $row['post_id'] ) && null !== $row['post_id'] ? (int) $row['post_id'] : null,
				'user_login'  => self::nullable_string( $user_login, 60 ),
				'route'       => self::nullable_string( $row['route'] ?? null, 191 ),
				'before_hash' => self::nullable_string( $row['before_hash'] ?? null, 32 ),
				'after_hash'  => self::nullable_string( $row['after_hash'] ?? null, 32 ),
				'result'      => self::nullable_string( $row['result'] ?? null, 64 ),
				'ts'          => $ts,
				'meta'        => $meta,
			);

			$formats = array( '%s', '%d', '%s', '%s', '%s', '%s', '%s', '%d', '%s' );

			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- custom plugin table; no core API exists for it.
			$inserted = $wpdb->insert( self::table_name(), $data, $formats );
			if ( false === $inserted ) {
				return 0;
			}

			$id = (int) $wpdb->insert_id;

			// Opportunistic prune ~every Nth row so the table never grows unbounded (Detailed Req #5).
			if ( $id > 0 && 0 === $id % self::PRUNE_EVERY ) {
				self::prune();
			}

			return $id;
		} catch ( \Throwable $e ) {
			// A logging failure must NEVER fail the underlying WRITE (WP-P14 Implementation Notes).
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- intentional diagnostic; logging must never throw.
			error_log( 'Elementor Ultra MCP Op_Log::record failed: ' . $e->getMessage() );
			return 0;
		}
	}

	/**
	 * Query the op log, newest first, optionally filtered by `post_id`/`user`, paginated per
	 * 10-rest-api.md §0.11 (10-rest-api.md §11). Returns the §0.11 `{items,next_cursor,total}`
	 * envelope; each item carries the §11 response shape with `route` mapped to `tool`.
	 *
	 * @param array{post_id?:?int,user?:?string,limit?:int,offset?:int} $args Filters + window.
	 * @return array{items:array<int,array<string,mixed>>,next_cursor:?string,total:?int}
	 */
	public static function query( array $args ): array {
		global $wpdb;

		$limit  = isset( $args['limit'] ) ? max( 1, min( 100, (int) $args['limit'] ) ) : 25;
		$offset = isset( $args['offset'] ) ? max( 0, (int) $args['offset'] ) : 0;

		list( $where_sql, $where_params ) = self::build_where( $args );

		$table = self::table_name();

		// Total (unfiltered-by-page count for the active filter) — cheap, indexed.
		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- $table from $wpdb->prefix, $where_sql is parameterized below.
		$count_sql = "SELECT COUNT(*) FROM {$table} {$where_sql}";
		if ( ! empty( $where_params ) ) {
			// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared -- prepared with the collected params.
			$count_sql = $wpdb->prepare( $count_sql, $where_params );
		}
		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- see prepare above.
		$total = (int) $wpdb->get_var( $count_sql );

		// Fetch one extra row to learn whether a next page exists.
		$page_params = array_merge( $where_params, array( $limit + 1, $offset ) );
		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- $table from $wpdb->prefix; LIMIT/OFFSET are %d placeholders.
		$rows_sql = "SELECT * FROM {$table} {$where_sql} ORDER BY ts DESC, id DESC LIMIT %d OFFSET %d";
		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- prepared with the collected params.
		$rows = $wpdb->get_results( $wpdb->prepare( $rows_sql, $page_params ), ARRAY_A );
		if ( ! is_array( $rows ) ) {
			$rows = array();
		}

		$has_more = count( $rows ) > $limit;
		if ( $has_more ) {
			$rows = array_slice( $rows, 0, $limit );
		}

		$items = array();
		foreach ( $rows as $row ) {
			$items[] = self::shape_item( $row );
		}

		return array(
			'items'       => $items,
			'next_cursor' => $has_more ? self::encode_cursor( $offset + $limit ) : null,
			'total'       => $total,
		);
	}

	/**
	 * Idempotency-support helper (10-rest-api.md §0.8): find the most recent prior row for an
	 * `op_id` (optionally scoped to a `post_id`). The writer's idempotent-replay check consults this
	 * to detect a prior application (in addition to the `editor_settings._emcp_op_id` embed).
	 *
	 * @param string $op_id   The operation id to look up.
	 * @param int    $post_id Optional target post id scope (0 = any).
	 * @return array<string,mixed>|null The prior row (§11 shape) or null when none exists.
	 */
	public static function find_by_op_id( string $op_id, int $post_id = 0 ): ?array {
		if ( '' === $op_id ) {
			return null;
		}

		global $wpdb;
		$table = self::table_name();

		if ( $post_id > 0 ) {
			// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- $table from $wpdb->prefix; values are placeholders.
			$sql = $wpdb->prepare( "SELECT * FROM {$table} WHERE op_id = %s AND post_id = %d ORDER BY ts DESC, id DESC LIMIT 1", $op_id, $post_id );
		} else {
			// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- $table from $wpdb->prefix; value is a placeholder.
			$sql = $wpdb->prepare( "SELECT * FROM {$table} WHERE op_id = %s ORDER BY ts DESC, id DESC LIMIT 1", $op_id );
		}

		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- prepared above; custom table.
		$row = $wpdb->get_row( $sql, ARRAY_A );
		if ( ! is_array( $row ) ) {
			return null;
		}

		return self::shape_item( $row );
	}

	/**
	 * Cap table growth by deleting the oldest rows beyond the newest `$keep` (WP-P14 Detailed
	 * Requirements #5). Called opportunistically from {@see Op_Log::record()} ~every Nth row, and
	 * available for a scheduled prune. No-op when the row count is within the cap.
	 *
	 * @param int $keep Maximum number of newest rows to retain.
	 * @return int Number of rows deleted.
	 */
	public static function prune( int $keep = self::DEFAULT_KEEP ): int {
		global $wpdb;

		$keep  = max( 0, $keep );
		$table = self::table_name();

		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- $table from $wpdb->prefix.
		$total = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" );
		if ( $total <= $keep ) {
			return 0;
		}

		// The id boundary: rows with id <= cutoff are the oldest surplus rows to delete. We find the
		// id of the row at offset $keep when ordered newest-first; everything older than it is pruned.
		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- $table from $wpdb->prefix; OFFSET is a placeholder.
		$cutoff_sql = $wpdb->prepare( "SELECT id FROM {$table} ORDER BY id DESC LIMIT 1 OFFSET %d", $keep );
		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- prepared above.
		$cutoff_id = (int) $wpdb->get_var( $cutoff_sql );
		if ( $cutoff_id <= 0 ) {
			return 0;
		}

		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- $table from $wpdb->prefix; value is a placeholder.
		$deleted = $wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE id <= %d", $cutoff_id ) );

		return false === $deleted ? 0 : (int) $deleted;
	}

	/**
	 * The fully-prefixed custom-table name `{$wpdb->prefix}emcp_ops`.
	 */
	public static function table_name(): string {
		global $wpdb;
		return $wpdb->prefix . self::TABLE;
	}

	/**
	 * Map a raw DB row to the 10-rest-api.md §11 response item shape (`route`->`tool`); `meta` is
	 * JSON-decoded when present.
	 *
	 * @param array<string,mixed> $row Raw associative DB row.
	 * @return array<string,mixed>
	 */
	private static function shape_item( array $row ): array {
		$meta = null;
		if ( isset( $row['meta'] ) && null !== $row['meta'] && '' !== $row['meta'] ) {
			$decoded = json_decode( (string) $row['meta'], true );
			$meta    = null === $decoded ? (string) $row['meta'] : $decoded;
		}

		return array(
			'id'          => isset( $row['id'] ) ? (int) $row['id'] : 0,
			'op_id'       => isset( $row['op_id'] ) ? $row['op_id'] : null,
			'post_id'     => isset( $row['post_id'] ) && null !== $row['post_id'] ? (int) $row['post_id'] : null,
			'user'        => isset( $row['user_login'] ) ? $row['user_login'] : null,
			'tool'        => isset( $row['route'] ) ? $row['route'] : null,
			'before_hash' => isset( $row['before_hash'] ) ? $row['before_hash'] : null,
			'after_hash'  => isset( $row['after_hash'] ) ? $row['after_hash'] : null,
			'result'      => isset( $row['result'] ) ? $row['result'] : null,
			'ts'          => isset( $row['ts'] ) && null !== $row['ts'] ? (int) $row['ts'] : null,
			'meta'        => $meta,
		);
	}

	/**
	 * Build the WHERE clause + ordered params for the `post_id`/`user` filters.
	 *
	 * @param array{post_id?:?int,user?:?string} $args Filters.
	 * @return array{0:string,1:array<int,mixed>} `[sql, params]`.
	 */
	private static function build_where( array $args ): array {
		$clauses = array();
		$params  = array();

		if ( isset( $args['post_id'] ) && null !== $args['post_id'] && '' !== $args['post_id'] ) {
			$clauses[] = 'post_id = %d';
			$params[]  = (int) $args['post_id'];
		}

		if ( isset( $args['user'] ) && '' !== (string) $args['user'] ) {
			$clauses[] = 'user_login = %s';
			$params[]  = (string) $args['user'];
		}

		$sql = empty( $clauses ) ? '' : ( 'WHERE ' . implode( ' AND ', $clauses ) );
		return array( $sql, $params );
	}

	/**
	 * The current user's `user_login` (10-rest-api.md §11 `user`), or empty string when no user.
	 */
	private static function current_user_login(): string {
		if ( ! function_exists( 'wp_get_current_user' ) ) {
			return '';
		}
		$user = wp_get_current_user();
		return ( $user && isset( $user->user_login ) ) ? (string) $user->user_login : '';
	}

	/**
	 * Coerce a value to a length-capped string or null (DB column safety).
	 *
	 * @param mixed $value  Candidate value.
	 * @param int   $length Max column length.
	 * @return string|null
	 */
	private static function nullable_string( $value, int $length ): ?string {
		if ( null === $value || '' === $value ) {
			return null;
		}
		$str = (string) $value;
		if ( strlen( $str ) > $length ) {
			$str = substr( $str, 0, $length );
		}
		return $str;
	}

	/**
	 * Encode an offset into the opaque pagination cursor: base64( {"offset":N} ) — byte-identical to
	 * the WP-P02 {@see \Elementor\Ultra\Rest\Pagination} trait scheme so the controller and store
	 * agree on cursor semantics (10-rest-api.md §0.11).
	 *
	 * @param int $offset Zero-based offset.
	 */
	private static function encode_cursor( int $offset ): string {
		return base64_encode( (string) wp_json_encode( array( 'offset' => $offset ) ) );
	}
}
