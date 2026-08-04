<?php
/**
 * WP-P06 — Documents REST controller: the flagship DOCUMENTS surface (Contract 10 §2 + §14 + §10 ids).
 *
 * The whole document write/read surface: list/create/get/get-settings/update-settings, the AUTHORITATIVE
 * `dry-run`, `save`/`replace-tree`, the granular `elements` op batch, `prime-css`, `backup`/`backups`/
 * `rollback`, `duplicate`, `delete`, `export`, `lock-status`, and `ids`. It is THIN GLUE: it parses +
 * schema-validates request args, delegates to the live core services (Validator, Document_Writer,
 * Css_Primer, Backup_Service, Id_Service, Global_Classes_Service), and shapes the §0.5/§0.6 envelopes.
 * No business logic that belongs in a core service is duplicated here.
 *
 * Contract authority:
 *  - 10-rest-api.md §2 (all DOCUMENTS routes), §14 (element-op batch), §10 (`GET /documents/{id}/ids`),
 *    §0.5/§0.6 (envelopes), §0.7 (status table), §0.8 (op_id/base_hash/locking), §0.9 (dry-run
 *    authoritative), §0.10 (atomic CSS priming), §0.11 (pagination), §0.3/§15 (caps).
 *  - 11-authoring-contract.md §8 (validation), §10 (priming / NEVER raw-write _elementor_data).
 *  - 12-error-taxonomy.md §3.1/§3.2/§3.5 (codes).
 *
 * SPIKE-VERIFIED CORRECTIONS (Wave 1):
 *  - [S04] `PUT /documents/{id}/settings` delegates to {@see Document_Writer::apply_settings_merge} which
 *    calls `Document::update_settings($patch)` (deep `array_replace_recursive`) — NEVER a bare
 *    `save(['settings'=>$patch])` (that REPLACES wholesale + a `{}` patch deletes the meta). An empty
 *    post-strip patch is rejected (400) rather than silently no-op'd / wiping the meta.
 *  - [S01/C1] Any save/replace-tree/elements/rollback path primes atomic CSS through the Css_Primer when
 *    `prime_css:true`; otherwise it reports `prime_required:true`/`css_primed:false` (§0.10). The
 *    `prime-css` route delegates to the live primer (web-server uid writes the files).
 *  - [R5] Local-style ids are NOT stable across save; this controller never caches them — the writer
 *    re-reads ids + base_hash after the write.
 *  - [S07/R2] CSS-affecting routes rely on the services that flush/prime in-process (web-server uid).
 *
 * The granular `elements` applier ({@see Element_Ops}, in this file) is a PURE in-memory tree transform:
 * it applies all ops in order, then hands the FULL resulting tree to {@see Document_Writer::replace_tree}
 * so there is exactly ONE `Document::save` (Contract 10 §14 "one Document::save, never N partial saves").
 *
 * Self-registers with the WP-P02 {@see Registrar} via the `elementor_ultra/rest/register` action — it
 * NEVER edits the spine `class-registrar.php` / `class-plugin.php` (the parallelism principle).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Backup_Service;
use Elementor\Ultra\Core\Css_Primer;
use Elementor\Ultra\Core\Document_Writer;
use Elementor\Ultra\Core\Global_Classes_Service;
use Elementor\Ultra\Core\Id_Service;
use Elementor\Ultra\Core\Render_Verifier;
use Elementor\Ultra\Validator;
use Elementor\Ultra\Error_Codes;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The DOCUMENTS REST controller (10-rest-api.md §2/§14/§10).
 */
final class Documents_Controller extends Abstract_Controller {

	/** The id path-segment pattern for document routes. */
	const ID_PATTERN = '(?P<id>\d+)';

	/**
	 * Revision meta tagging an autosave revision as an MCP-minted `want_preview` dry-run artifact.
	 * Value = an md5 fingerprint of the revision's `_elementor_data` at preview-write time, so a later
	 * REAL editor autosave (which overwrites the same revision) invalidates the tag and is never
	 * mistaken for a discardable preview.
	 */
	const PREVIEW_META = '_emcp_preview';

	/** Valid `status` enum for the list route (10 §2.1). */
	const LIST_STATUSES = array( 'any', 'publish', 'draft', 'trash', 'pending', 'private' );

	/** Valid `status` enum for create / duplicate (10 §2.2/§2.9). */
	const CREATE_STATUSES = array( 'draft', 'publish', 'pending', 'private' );

	/** Valid `op` enum for the granular element batch (10 §14). */
	const ELEMENT_OPS = array(
		'insert',
		'update_settings',
		'move',
		'delete',
		'set_classes',
		'set_local_style',
		'bind_dynamic',
		'bind_global',
	);

	// =================================================================================================
	// Route registration (Detailed Requirements #1 — every route declares its own args + permission).
	// =================================================================================================

	/**
	 * Register all 18 document routes under `elementor-ultra/v1` with the §15 caps (10 §2/§14/§10).
	 *
	 * @return void
	 */
	public function register_routes(): void {
		$id = self::ID_PATTERN;

		// GET /documents — list (CAP_READ, paginated §0.11, §2.1).
		$this->route(
			'/documents',
			WP_REST_Server::READABLE,
			array( $this, 'list_documents' ),
			Permissions::can_read(),
			array(
				'status'    => array(
					'type'     => 'string',
					'required' => false,
					'default'  => 'any',
					'enum'     => self::LIST_STATUSES,
				),
				'post_type' => array(
					'type'     => array( 'array', 'string' ),
					'required' => false,
				),
				'limit'     => $this->limit_arg(),
				'cursor'    => $this->cursor_arg(),
				'fields'    => $this->fields_arg(),
			)
		);

		// POST /documents — create (CAP_EDIT_POST → edit_posts for create, §2.2).
		$this->route(
			'/documents',
			WP_REST_Server::CREATABLE,
			array( $this, 'create_document' ),
			Permissions::can_edit_post(),
			array(
				'title'         => array(
					'type'              => 'string',
					'required'          => false,
					'default'           => 'New Page',
					'sanitize_callback' => 'sanitize_text_field',
				),
				'post_type'     => array(
					'type'              => 'string',
					'required'          => false,
					'default'           => 'page',
					'sanitize_callback' => 'sanitize_key',
				),
				'template_type' => array(
					'type'              => 'string',
					'required'          => false,
					'sanitize_callback' => 'sanitize_key',
				),
				'status'        => array(
					'type'     => 'string',
					'required' => false,
					'default'  => 'draft',
					'enum'     => self::CREATE_STATUSES,
				),
				'op_id'         => $this->op_id_arg(),
			)
		);

		// GET /documents/{id} — tree + base_hash (CAP_READ, §2.4).
		$this->route(
			'/documents/' . $id,
			WP_REST_Server::READABLE,
			array( $this, 'get_document' ),
			Permissions::can_read(),
			array(
				'id'         => $this->id_arg(),
				'depth'      => array(
					'type'     => 'integer',
					'required' => false,
					'minimum'  => 0,
				),
				'subtree_id' => array(
					'type'     => 'string',
					'required' => false,
				),
				'projection' => array(
					'type'     => 'string',
					'required' => false,
					'default'  => 'full',
					'enum'     => array( 'full', 'summary' ),
				),
			)
		);

		// GET /documents/{id}/settings (CAP_READ, §2.5).
		$this->route(
			'/documents/' . $id . '/settings',
			WP_REST_Server::READABLE,
			array( $this, 'get_settings' ),
			Permissions::can_read(),
			array( 'id' => $this->id_arg() )
		);

		// PUT /documents/{id}/settings — GET-merge-PUT (CAP_EDIT_POST, §2.5, [S04]).
		$this->route(
			'/documents/' . $id . '/settings',
			WP_REST_Server::EDITABLE,
			array( $this, 'put_settings' ),
			Permissions::can_edit_post(),
			array(
				'id'        => $this->id_arg(),
				'settings'  => array(
					'type'     => 'object',
					'required' => true,
				),
				'base_hash' => $this->base_hash_arg(),
				'op_id'     => $this->op_id_arg(),
			)
		);

		// POST /documents/{id}/dry-run — AUTHORITATIVE validate + diff, NO persist (CAP_EDIT_POST, §2.3).
		// {id} may be 0 (a new tree); allow id=0 by also matching a literal "0".
		$this->route(
			'/documents/(?P<id>\d+)/dry-run',
			WP_REST_Server::CREATABLE,
			array( $this, 'dry_run' ),
			Permissions::can_edit_post(),
			array(
				'id'           => $this->id_arg( false ),
				'elements'     => array(
					'type'     => 'array',
					'required' => true,
				),
				'settings'     => array(
					'type'     => 'object',
					'required' => false,
				),
				'generation'   => array(
					'type'     => 'string',
					'required' => false,
					'enum'     => array( 'v4', 'v3', 'auto' ),
				),
				'want_preview' => array(
					'type'     => 'boolean',
					'required' => false,
					'default'  => false,
				),
				'op_id'        => $this->op_id_arg(),
			)
		);

		// POST /documents/{id}/save (CAP_EDIT_POST, §2.6).
		$this->route(
			'/documents/' . $id . '/save',
			WP_REST_Server::CREATABLE,
			array( $this, 'save_document' ),
			Permissions::can_edit_post(),
			array(
				'id'            => $this->id_arg(),
				'elements'      => array(
					'type'     => 'array',
					'required' => false,
				),
				'settings'      => array(
					'type'     => 'object',
					'required' => false,
				),
				'base_hash'     => $this->base_hash_arg(),
				'op_id'         => $this->op_id_arg(),
				'prime_css'     => $this->bool_arg( false ),
				'force'         => $this->bool_arg( false ),
				'backup'        => $this->bool_arg( true ),
				// Contract 18 §7-AI S2 — run the post-save+prime render-verification probe in-request.
				'verify_render' => $this->bool_arg( false ),
			)
		);

		// POST /documents/{id}/replace-tree (CAP_EDIT_POST, §2.6 — elements + base_hash REQUIRED).
		$this->route(
			'/documents/' . $id . '/replace-tree',
			WP_REST_Server::CREATABLE,
			array( $this, 'replace_tree' ),
			Permissions::can_edit_post(),
			array(
				'id'            => $this->id_arg(),
				'elements'      => array(
					'type'     => 'array',
					'required' => true,
				),
				'settings'      => array(
					'type'     => 'object',
					'required' => false,
				),
				'base_hash'     => array(
					'type'     => 'string',
					'required' => true,
				),
				'op_id'         => $this->op_id_arg(),
				'prime_css'     => $this->bool_arg( false ),
				'force'         => $this->bool_arg( false ),
				'backup'        => $this->bool_arg( true ),
				// Contract 18 §7-AI S2 — run the post-save+prime render-verification probe in-request.
				'verify_render' => $this->bool_arg( false ),
			)
		);

		// POST /documents/{id}/elements — granular op batch (CAP_EDIT_POST, §14 — base_hash REQUIRED).
		$this->route(
			'/documents/' . $id . '/elements',
			WP_REST_Server::CREATABLE,
			array( $this, 'apply_elements' ),
			Permissions::can_edit_post(),
			array(
				'id'        => $this->id_arg(),
				'ops'       => array(
					'type'     => 'array',
					'required' => true,
				),
				'base_hash' => array(
					'type'     => 'string',
					'required' => true,
				),
				'force'     => $this->bool_arg( false ),
				'prime_css' => $this->bool_arg( false ),
				'op_id'     => $this->op_id_arg(),
			)
		);

		// POST /documents/{id}/prime-css (CAP_EDIT_POST, §2.7).
		$this->route(
			'/documents/' . $id . '/prime-css',
			WP_REST_Server::CREATABLE,
			array( $this, 'prime_css' ),
			Permissions::can_edit_post(),
			array(
				'id'          => $this->id_arg(),
				'approach'    => array(
					'type'     => 'string',
					'required' => false,
					'default'  => 'auto',
					'enum'     => array( 'loopback', 'programmatic', 'auto' ),
				),
				'breakpoints' => array(
					'type'     => 'array',
					'required' => false,
				),
				'op_id'       => $this->op_id_arg(),
			)
		);

		// POST /documents/{id}/backup (CAP_EDIT_POST, §2.8).
		$this->route(
			'/documents/' . $id . '/backup',
			WP_REST_Server::CREATABLE,
			array( $this, 'backup_document' ),
			Permissions::can_edit_post(),
			array(
				'id'    => $this->id_arg(),
				'label' => array(
					'type'              => 'string',
					'required'          => false,
					'sanitize_callback' => 'sanitize_text_field',
				),
				'op_id' => $this->op_id_arg(),
			)
		);

		// GET /documents/{id}/backups — list snapshots (CAP_READ, paginated, §2.8).
		$this->route(
			'/documents/' . $id . '/backups',
			WP_REST_Server::READABLE,
			array( $this, 'list_backups' ),
			Permissions::can_read(),
			array(
				'id'     => $this->id_arg(),
				'limit'  => $this->limit_arg(),
				'cursor' => $this->cursor_arg(),
				'fields' => $this->fields_arg(),
			)
		);

		// POST /documents/{id}/rollback (CAP_EDIT_POST, §2.8).
		$this->route(
			'/documents/' . $id . '/rollback',
			WP_REST_Server::CREATABLE,
			array( $this, 'rollback_document' ),
			Permissions::can_edit_post(),
			array(
				'id'        => $this->id_arg(),
				// phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key -- REST arg-schema key (the snapshot handle, §2.8), not a meta query.
				'meta_key'  => array(
					'type'     => 'string',
					'required' => true,
				),
				'prime_css' => $this->bool_arg( false ),
				'op_id'     => $this->op_id_arg(),
			)
		);

		// POST /documents/{id}/verify-render — the §7-AI S2 render-verification probe (CAP_READ).
		$this->route(
			'/documents/' . $id . '/verify-render',
			WP_REST_Server::CREATABLE,
			array( $this, 'verify_render_document' ),
			Permissions::can_read(),
			array( 'id' => $this->id_arg() )
		);

		// POST /documents/{id}/duplicate (CAP_EDIT_POST, §2.9).
		$this->route(
			'/documents/' . $id . '/duplicate',
			WP_REST_Server::CREATABLE,
			array( $this, 'duplicate_document' ),
			Permissions::can_edit_post(),
			array(
				'id'     => $this->id_arg(),
				'title'  => array(
					'type'              => 'string',
					'required'          => false,
					'sanitize_callback' => 'sanitize_text_field',
				),
				'status' => array(
					'type'     => 'string',
					'required' => false,
					'default'  => 'draft',
					'enum'     => self::CREATE_STATUSES,
				),
				'op_id'  => $this->op_id_arg(),
			)
		);

		// DELETE /documents/{id} (CAP_EDIT_POST, §2.9).
		$this->route(
			'/documents/' . $id,
			WP_REST_Server::DELETABLE,
			array( $this, 'delete_document' ),
			Permissions::can_edit_post(),
			array(
				'id'    => $this->id_arg(),
				'force' => $this->bool_arg( false ),
			)
		);

		// POST /documents/{id}/export (CAP_READ, §2.9).
		$this->route(
			'/documents/' . $id . '/export',
			WP_REST_Server::CREATABLE,
			array( $this, 'export_document' ),
			Permissions::can_read(),
			array( 'id' => $this->id_arg() )
		);

		// GET /documents/{id}/lock-status (CAP_READ, §2.10).
		$this->route(
			'/documents/' . $id . '/lock-status',
			WP_REST_Server::READABLE,
			array( $this, 'lock_status' ),
			Permissions::can_read(),
			array( 'id' => $this->id_arg() )
		);

		// GET /documents/{id}/ids — used-id set for a document (CAP_READ, §10).
		$this->route(
			'/documents/' . $id . '/ids',
			WP_REST_Server::READABLE,
			array( $this, 'document_ids' ),
			Permissions::can_read(),
			array( 'id' => $this->id_arg() )
		);
	}

	// =================================================================================================
	// §2.1 list
	// =================================================================================================

	/**
	 * `GET /documents` (10 §2.1). Lists posts with `_elementor_edit_mode='builder'`, mapping
	 * `type=_elementor_template_type`, filtered by `status`/`post_type`, paginated per §0.11.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response
	 */
	public function list_documents( WP_REST_Request $request ): WP_REST_Response {
		$status     = (string) $request->get_param( 'status' );
		$post_types = $this->normalize_post_types( $request->get_param( 'post_type' ) );

		$query_args = array(
			'post_type'      => $post_types,
			'post_status'    => ( 'any' === $status ) ? 'any' : $status,
			'posts_per_page' => -1,
			'fields'         => 'ids',
			'no_found_rows'  => true,
			'meta_query'     => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query -- list query keyed by the Elementor builder flag (§2.1).
				array(
					'key'   => '_elementor_edit_mode',
					'value' => 'builder',
				),
			),
		);

		$post_ids = get_posts( $query_args );
		$items    = array();
		foreach ( $post_ids as $post_id ) {
			$post_id = (int) $post_id;
			$post    = get_post( $post_id );
			if ( null === $post ) {
				continue;
			}
			$items[] = array(
				'id'                   => $post_id,
				'title'                => get_the_title( $post_id ),
				'status'               => (string) $post->post_status,
				'url'                  => (string) get_permalink( $post_id ),
				'type'                 => (string) get_post_meta( $post_id, '_elementor_template_type', true ),
				'edit_url'             => $this->edit_url( $post_id ),
				'built_with_elementor' => true,
			);
		}

		$paged = $this->paginate( $items, $request, count( $items ) );

		return $this->ok( $paged );
	}

	// =================================================================================================
	// §2.2 create
	// =================================================================================================

	/**
	 * `POST /documents` (10 §2.2). Wraps `Plugin::$instance->documents->create($type,$post_data,...)`,
	 * deriving `template_type` from `post_type` when omitted. Returns `{id,edit_url,status,type}`.
	 * Idempotent on `op_id` (10 §0.8): a replayed op_id returns the originally created post with
	 * `replayed:true` instead of minting a duplicate page.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function create_document( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		// op_id replay guard (mirrors the save-path guard, 10 §0.8): a retried create with the same
		// op_id must NOT mint a duplicate page — return the previously created post instead. The
		// lookup is ROUTE-SCOPED to the documents/create op-log row (post_id-scoping is impossible
		// pre-create): one op_id may carry MULTIPLE rows — page_build reuses a single op_id for its
		// create + save calls, so after a successful build the NEWEST row for the op_id is
		// `documents/save` and a latest-row lookup (Op_Log::find_by_op_id) would miss the prior
		// create and mint a duplicate page on retry.
		if ( null !== $op_id ) {
			$prior_id = $this->find_prior_create_post_id( $op_id );
			if ( $prior_id > 0
				&& null !== get_post( $prior_id )
				&& ! in_array( (string) get_post_status( $prior_id ), array( 'trash', 'auto-draft' ), true ) ) {
				$prior_template = (string) get_post_meta( $prior_id, '_wp_page_template', true );
				return $this->ok(
					array(
						'id'                => $prior_id,
						'edit_url'          => $this->edit_url( $prior_id ),
						'status'            => (string) get_post_status( $prior_id ),
						'type'              => (string) get_post_meta( $prior_id, '_elementor_template_type', true ),
						'template'          => '' !== $prior_template ? $prior_template : null,
						'replayed'          => true,
						'idempotent_replay' => true,
					)
				);
			}
		}

		$documents = $this->documents_manager();
		if ( null === $documents ) {
			return $this->fail( Error_Codes::UPSTREAM_ERROR, __( 'Elementor documents manager is unavailable.', 'elementor-ultra-mcp' ), 502, array(), array(), $op_id );
		}

		$title         = (string) $request->get_param( 'title' );
		$post_type     = (string) $request->get_param( 'post_type' );
		$status        = (string) $request->get_param( 'status' );
		$template_type = $request->get_param( 'template_type' );
		$template_type = ( is_string( $template_type ) && '' !== $template_type )
			? $template_type
			: $this->derive_template_type( $post_type );

		$document = $documents->create(
			$template_type,
			array(
				'post_title'  => '' !== $title ? $title : 'New Page',
				'post_status' => $status,
				'post_type'   => $post_type,
			)
		);

		if ( is_wp_error( $document ) ) {
			return $this->map_wp_error( $document );
		}
		if ( ! is_object( $document ) || ! method_exists( $document, 'get_main_id' ) ) {
			return $this->fail( Error_Codes::INTERNAL_ERROR, __( 'Document creation returned an unexpected result.', 'elementor-ultra-mcp' ), 500, array(), array(), $op_id );
		}

		$post_id = (int) $document->get_main_id();

		// Honor the advertised `template` param → WP `_wp_page_template` (Elementor Canvas / Full-Width).
		$template     = $request->get_param( 'template' );
		$template_set = null;
		if ( is_string( $template ) && '' !== $template
			&& in_array( $template, array( 'default', 'elementor_canvas', 'elementor_header_footer' ), true ) ) {
			update_post_meta( $post_id, '_wp_page_template', $template );
			$template_set = $template;
		}

		$this->op_log( $post_id, $op_id, 'documents/create', '', $this->current_base_hash( $post_id ) );

		return $this->ok(
			array(
				'id'                => $post_id,
				'edit_url'          => $this->edit_url( $post_id ),
				'status'            => (string) get_post_status( $post_id ),
				'type'              => (string) get_post_meta( $post_id, '_elementor_template_type', true ),
				'template'          => $template_set,
				'replayed'          => false,
				'idempotent_replay' => false,
			)
		);
	}

	// =================================================================================================
	// §2.4 get
	// =================================================================================================

	/**
	 * `GET /documents/{id}` (10 §2.4). Returns the tree + `base_hash` + `generation` + `type`, honoring
	 * `depth` (truncate), `subtree_id` (return only that subtree), and `projection=summary`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_document( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];

		$tree = $this->read_tree( $post_id );
		if ( null === $tree || ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		$depth      = $request->get_param( 'depth' );
		$subtree_id = $request->get_param( 'subtree_id' );
		$projection = (string) $request->get_param( 'projection' );

		$elements = $tree;

		if ( is_string( $subtree_id ) && '' !== $subtree_id ) {
			$found = $this->find_subtree( $elements, $subtree_id );
			if ( null === $found ) {
				return $this->fail(
					Error_Codes::NOT_FOUND,
					sprintf(
						/* translators: %s: element id. */
						__( 'Element "%s" was not found in this document.', 'elementor-ultra-mcp' ),
						$subtree_id
					),
					404,
					array(
						'post_id'    => $post_id,
						'subtree_id' => $subtree_id,
					)
				);
			}
			$elements = array( $found );
		}

		if ( null !== $depth && '' !== $depth ) {
			$elements = $this->truncate_depth( $elements, max( 0, (int) $depth ) );
		}

		if ( 'summary' === $projection ) {
			$elements = $this->project_summary( $elements );
		}

		$settings = get_post_meta( $post_id, '_elementor_page_settings', true );

		return $this->ok(
			array(
				'id'         => $post_id,
				'elements'   => array_values( $elements ),
				'settings'   => is_array( $settings ) ? $settings : array(),
				'base_hash'  => $this->current_base_hash( $post_id ),
				'generation' => $this->tree_generation( $tree ),
				'type'       => (string) get_post_meta( $post_id, '_elementor_template_type', true ),
			)
		);
	}

	// =================================================================================================
	// §2.5 settings GET / PUT
	// =================================================================================================

	/**
	 * `GET /documents/{id}/settings` (10 §2.5). Returns `{settings:_elementor_page_settings}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_settings( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}
		$settings = get_post_meta( $post_id, '_elementor_page_settings', true );
		return $this->ok( array( 'settings' => is_array( $settings ) ? $settings : array() ) );
	}

	/**
	 * `PUT /documents/{id}/settings` (10 §2.5, spike [S04]). Delegates to
	 * {@see Document_Writer::apply_settings_merge} which calls `Document::update_settings()` (deep merge).
	 * Rejects an empty post-strip patch (400) rather than wiping the meta. Returns `{success,settings}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function put_settings( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];

		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		$patch = $request->get_param( 'settings' );
		if ( ! is_array( $patch ) || array() === $patch ) {
			// [S04] An empty patch through the save path would DELETE the meta — reject it explicitly.
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'settings must be a non-empty object. A PUT {} is not a no-op; "clear all settings" is a separate explicit operation.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'settings' ),
				array(),
				$op_id
			);
		}

		// PAGE TEMPLATE: `template` is the WP `_wp_page_template` post meta, NOT an `_elementor_page_settings`
		// key — Elementor's settings merge silently drops it. Intercept it here so the MCP can set the
		// Elementor Canvas / Full-Width layout (the agent no longer needs out-of-band wp-cli for full-bleed).
		$template_applied = null;
		if ( array_key_exists( 'template', $patch ) ) {
			$tpl         = is_string( $patch['template'] ) ? $patch['template'] : '';
			$allowed_tpl = array( 'default', 'elementor_canvas', 'elementor_header_footer', 'elementor_theme' );
			if ( ! in_array( $tpl, $allowed_tpl, true ) ) {
				// §7-AI S1: a known settings key with a bad shape is SETTINGS_INVALID (422), aligned
				// with the validator's allowlist (page-settings.schema.json).
				return $this->fail(
					Error_Codes::SETTINGS_INVALID,
					__( 'settings.template must be one of: default, elementor_canvas, elementor_header_footer, elementor_theme.', 'elementor-ultra-mcp' ),
					422,
					array( 'path' => 'settings.template' ),
					array(),
					$op_id
				);
			}
			update_post_meta( $post_id, '_wp_page_template', $tpl );
			$template_applied = $tpl;
			unset( $patch['template'] );
		}

		// Only a template change was requested — skip the (now-empty) settings merge.
		if ( array() === $patch ) {
			$current = get_post_meta( $post_id, '_elementor_page_settings', true );
			return $this->ok(
				array(
					'success'  => true,
					'template' => $template_applied,
					'settings' => is_array( $current ) ? $current : array(),
				)
			);
		}

		$base_hash = $request->get_param( 'base_hash' );
		$base_hash = ( is_string( $base_hash ) && '' !== $base_hash ) ? $base_hash : null;

		$result = Document_Writer::apply_settings_merge( $post_id, $patch, $base_hash, $op_id );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		if ( null !== $template_applied && is_array( $result ) ) {
			$result['template'] = $template_applied;
		}

		return $this->ok( $result );
	}

	// =================================================================================================
	// §2.3 dry-run (AUTHORITATIVE)
	// =================================================================================================

	/**
	 * `POST /documents/{id}/dry-run` (10 §2.3, §0.9). The SINGLE SOURCE OF TRUTH for validity. Calls
	 * {@see Validator::dry_run}; `{id}=0` validates a brand-new tree. On `valid:false` returns 422 with
	 * the §0.6 envelope `errors[]`; on `valid:true` returns the §2.3 success `data`. When
	 * `want_preview:true` and valid, writes a per-user autosave + fills `preview_url` (the controller owns
	 * this; the validator returns `preview_url:null`). Persists NOTHING for the published tree.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function dry_run( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];

		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$elements = $request->get_param( 'elements' );
		if ( ! is_array( $elements ) ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'dry-run requires an "elements" array.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'elements' ),
				array(),
				$op_id
			);
		}

		// Non-zero id must exist (§2.3 — 404 when absent). id=0 skips is_editable/lock (no post).
		if ( $post_id > 0 && ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		$settings = $request->get_param( 'settings' );
		$settings = is_array( $settings ) ? $settings : array();

		$generation = $request->get_param( 'generation' );
		$generation = ( is_string( $generation ) && '' !== $generation ) ? $generation : 'auto';

		$result = Validator::dry_run( $elements, $settings, $post_id, $generation );

		if ( empty( $result['valid'] ) ) {
			$errors = isset( $result['errors'] ) && is_array( $result['errors'] ) ? $result['errors'] : array();
			// §7-AI S1: a settings-allowlist violation surfaces SETTINGS_INVALID as the envelope code;
			// every other validation class keeps the historical ATOMIC_SETTINGS_INVALID envelope (the
			// TS dry_run normalizer keys on this fixed family).
			$first_code = ( isset( $errors[0]['code'] ) && Error_Codes::SETTINGS_INVALID === $errors[0]['code'] )
				? Error_Codes::SETTINGS_INVALID
				: Error_Codes::ATOMIC_SETTINGS_INVALID;
			return $this->fail(
				$first_code,
				sprintf(
					/* translators: %d: number of validation errors. */
					_n( 'Element-tree validation failed (%d error).', 'Element-tree validation failed (%d errors).', count( $errors ), 'elementor-ultra-mcp' ),
					count( $errors )
				),
				422,
				array(),
				$errors,
				$op_id
			);
		}

		// want_preview: write a per-user autosave REVISION (never the published tree) and build the
		// preview URL. When no true preview is possible (e.g. drafts — upstream ajax_save would write
		// the original post, which a dry-run must never do) we return preview_url:null + a warning.
		$preview_url     = null;
		$preview_warning = null;
		if ( $request->get_param( 'want_preview' ) && $post_id > 0 ) {
			$preview_url = $this->write_preview_autosave( $post_id, $elements, $settings );
			if ( null === $preview_url ) {
				$preview_warning = __( 'Preview unavailable: an autosave preview is only supported for published/private posts; nothing was persisted.', 'elementor-ultra-mcp' );
			}
		}

		$data = array(
			'valid'               => true,
			'errors'              => array(),
			'diff'                => isset( $result['diff'] ) ? $result['diff'] : array(),
			'preview_url'         => $preview_url,
			'id_collisions'       => isset( $result['id_collisions'] ) ? array_values( $result['id_collisions'] ) : array(),
			'generation_detected' => isset( $result['generation_detected'] ) ? $result['generation_detected'] : 'v4',
		);
		if ( null !== $preview_warning ) {
			$data['preview_warning'] = $preview_warning;
		}

		return $this->ok( $data );
	}

	// =================================================================================================
	// §2.6 save / replace-tree
	// =================================================================================================

	/**
	 * `POST /documents/{id}/save` (10 §2.6). Delegates to {@see Document_Writer::save} (which validates
	 * AUTHORITATIVELY before persisting + writes nothing on failure). Returns the §2.6 `data` verbatim.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function save_document( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		// A verified want_preview dry-run autosave is an ephemeral artifact — discard it so the
		// writer's newer-autosave gate does not 409 the canonical preview-then-commit flow.
		$this->discard_preview_autosave( $post_id );

		$result = Document_Writer::save( $post_id, $this->write_args( $request, $op_id ) );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		$result = $this->maybe_verify_render( $request, $post_id, $result );
		return $this->ok( $result );
	}

	/**
	 * `POST /documents/{id}/replace-tree` (10 §2.6). `elements` + `base_hash` REQUIRED (the arg schema
	 * enforces both → 400 SCHEMA_INVALID_PARAMS when missing). Delegates to
	 * {@see Document_Writer::replace_tree}. Returns the §2.6 `data` verbatim.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function replace_tree( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		// Discard a verified want_preview dry-run autosave (see save_document) before the writer's gates.
		$this->discard_preview_autosave( $post_id );

		$result = Document_Writer::replace_tree( $post_id, $this->write_args( $request, $op_id ) );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		$result = $this->maybe_verify_render( $request, $post_id, $result );
		return $this->ok( $result );
	}

	/**
	 * Contract 18 §7-AI S2 — when the write request asked for `verify_render`, run the probe AFTER
	 * save+prime and fold `render_verified` + `render_probe` into the §2.6 payload. A failed probe is
	 * NOT an error (the save landed; `RENDER_FAILED` is soft) — the verifier op-logs the outcome.
	 *
	 * @param WP_REST_Request     $request The current request.
	 * @param int                 $post_id The saved document.
	 * @param array<string,mixed> $result  The writer's §2.6 payload.
	 * @return array<string,mixed>
	 */
	private function maybe_verify_render( WP_REST_Request $request, int $post_id, array $result ): array {
		if ( ! $request->get_param( 'verify_render' ) ) {
			return $result;
		}
		$probe = ( new Render_Verifier() )->verify( $post_id );

		$result['render_verified'] = ! empty( $probe['render_verified'] );
		$result['render_probe']    = array(
			'render_verified' => ! empty( $probe['render_verified'] ),
			'method'          => isset( $probe['method'] ) ? (string) $probe['method'] : 'dispatch',
			'http_status'     => isset( $probe['http_status'] ) ? $probe['http_status'] : null,
			'fatal'           => isset( $probe['fatal'] ) ? $probe['fatal'] : null,
			'checked_url'     => isset( $probe['checked_url'] ) ? $probe['checked_url'] : null,
		);
		return $result;
	}

	// =================================================================================================
	// §7-AI S2 verify-render (contract 18)
	// =================================================================================================

	/**
	 * `POST /documents/{id}/verify-render` (contract 18 §7-AI S2). The standalone render-verification
	 * probe for ANY document: loopback permalink fetch with the MANDATORY in-process front-controller
	 * dispatch fallback; asserts HTTP 200 + no fatal marker; op-logged. A failed probe is a 200
	 * SUCCESS payload with `render_verified:false` (taxonomy `RENDER_FAILED` is soft) — the document
	 * is unchanged either way.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function verify_render_document( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		$probe = ( new Render_Verifier() )->verify( $post_id );

		return $this->ok( $probe );
	}

	// =================================================================================================
	// §14 granular element-op batch
	// =================================================================================================

	/**
	 * `POST /documents/{id}/elements` (10 §14). REQUIRES `base_hash`. Reads the current tree, applies all
	 * ops IN ORDER in memory (a PURE transform via {@see Element_Ops}), then routes the resulting WHOLE
	 * tree through {@see Document_Writer::replace_tree} (single validate + single save — "one
	 * Document::save, never N partial saves"). Any op failing validation → 422, nothing persisted.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function apply_elements( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		$ops = $request->get_param( 'ops' );
		if ( ! is_array( $ops ) ) {
			return $this->fail(
				Error_Codes::SCHEMA_INVALID_PARAMS,
				__( 'elements batch requires an "ops" array.', 'elementor-ultra-mcp' ),
				400,
				array( 'path' => 'ops' ),
				array(),
				$op_id
			);
		}

		$base_hash = (string) $request->get_param( 'base_hash' );

		// Discard a verified want_preview dry-run autosave (see save_document) before the writer's gates.
		$this->discard_preview_autosave( $post_id );

		// Optimistic-concurrency BEFORE we read+transform (so a stale read yields 409, not a silent merge).
		$hash_check = $this->assert_base_hash( $post_id, $base_hash, (bool) $request->get_param( 'force' ) );
		if ( is_wp_error( $hash_check ) ) {
			return $hash_check;
		}

		$current = $this->read_tree( $post_id );
		$current = is_array( $current ) ? $current : array();

		// Pure in-memory transform: apply every op in order; collect new ids for inserts.
		$applied = Element_Ops::apply( $current, $ops, $post_id );
		if ( $applied instanceof WP_Error ) {
			// Attach the op_id to the schema/not-found op error envelope.
			$data = (array) $applied->get_error_data();
			if ( null !== $op_id ) {
				$applied->add_data( array_merge( $data, array( 'op_id' => $op_id ) ) );
			}
			return $applied;
		}

		// ONE save of the resulting whole tree (validate-before-persist happens inside the writer, §0.9).
		$result = Document_Writer::replace_tree(
			$post_id,
			array(
				'elements'  => $applied['elements'],
				'base_hash' => $base_hash,
				'op_id'     => $op_id,
				'force'     => (bool) $request->get_param( 'force' ),
				'prime_css' => (bool) $request->get_param( 'prime_css' ),
				'backup'    => true,
			)
		);
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		// §14 response shape (a trimmed save payload + the in-memory remapped-ids from the applier).
		return $this->ok(
			array(
				'id'           => $post_id,
				'diff'         => isset( $result['diff'] ) ? $result['diff'] : array(),
				'base_hash'    => isset( $result['base_hash'] ) ? $result['base_hash'] : $this->current_base_hash( $post_id ),
				'css_primed'   => ! empty( $result['css_primed'] ),
				'remapped_ids' => isset( $applied['remapped'] ) ? $applied['remapped'] : array(),
			)
		);
	}

	// =================================================================================================
	// §2.7 prime-css
	// =================================================================================================

	/**
	 * `POST /documents/{id}/prime-css` (10 §2.7). Delegates to {@see Css_Primer::prime}; returns its
	 * payload. A `css_primed:false` + `warnings[]` is a 200-with-warning (NOT an error).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function prime_css( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		if ( ! class_exists( '\Elementor\Ultra\Core\Css_Primer' ) ) {
			return $this->fail( Error_Codes::CSS_PRIME_FAILED, __( 'CSS primer is unavailable.', 'elementor-ultra-mcp' ), 500, array( 'post_id' => $post_id ) );
		}

		$approach    = (string) $request->get_param( 'approach' );
		$breakpoints = $request->get_param( 'breakpoints' );
		$breakpoints = is_array( $breakpoints ) ? array_values( array_filter( $breakpoints, 'is_string' ) ) : array();

		$primer = new Css_Primer();
		$result = $primer->prime( $post_id, '' !== $approach ? $approach : 'auto', $breakpoints );
		if ( is_wp_error( $result ) ) {
			return $result; // CSS_PRIME_FAILED — the only error case (§2.7).
		}

		return $this->ok( $result );
	}

	// =================================================================================================
	// §2.8 backup / backups / rollback
	// =================================================================================================

	/**
	 * `POST /documents/{id}/backup` (10 §2.8). Delegates to {@see Backup_Service::snapshot}.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function backup_document( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		$label  = $request->get_param( 'label' );
		$label  = ( is_string( $label ) && '' !== $label ) ? $label : null;
		$handle = Backup_Service::snapshot( $post_id, $label, $op_id );

		return $this->ok( array( 'backup_handle' => $handle ) );
	}

	/**
	 * `GET /documents/{id}/backups` (10 §2.8). Lists snapshots newest-first, paginated per §0.11.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function list_backups( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}
		$items = Backup_Service::list_backups( $post_id );
		return $this->ok( $this->paginate( $items, $request, count( $items ) ) );
	}

	/**
	 * `POST /documents/{id}/rollback` (10 §2.8). Delegates to {@see Backup_Service::rollback} (honors
	 * `prime_css`). Returns `{id,restored_from,base_hash,css_primed}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function rollback_document( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}
		$post_id  = (int) $request['id'];
		$meta_key = (string) $request->get_param( 'meta_key' );

		// Discard a verified want_preview dry-run autosave (see save_document) — Backup_Service::rollback
		// runs the same newer-autosave gate as the writer ("preview looked wrong → rollback" must work).
		$this->discard_preview_autosave( $post_id );

		$result = Backup_Service::rollback( $post_id, $meta_key, (bool) $request->get_param( 'prime_css' ) );
		if ( is_wp_error( $result ) ) {
			return $result;
		}

		$this->op_log( $post_id, $op_id, 'documents/rollback', '', isset( $result['base_hash'] ) ? (string) $result['base_hash'] : '' );

		return $this->ok( $result );
	}

	// =================================================================================================
	// §2.9 duplicate / delete / export
	// =================================================================================================

	/**
	 * `POST /documents/{id}/duplicate` (10 §2.9). Deep-copies `_elementor_*` meta into a new post with
	 * FRESH ids via {@see Id_Service::dedupe_for_insert}. Returns `{id,edit_url}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function duplicate_document( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$source_id = (int) $request['id'];
		$source    = get_post( $source_id );
		if ( null === $source || ! $this->is_elementor_post( $source_id ) ) {
			return $this->not_found( $source_id );
		}

		$title  = $request->get_param( 'title' );
		$title  = ( is_string( $title ) && '' !== $title ) ? $title : ( get_the_title( $source_id ) . ' (copy)' );
		$status = (string) $request->get_param( 'status' );

		$new_id = wp_insert_post(
			array(
				'post_title'  => $title,
				'post_status' => $status,
				'post_type'   => $source->post_type,
				'post_author' => get_current_user_id(),
			),
			true
		);
		if ( is_wp_error( $new_id ) ) {
			return $this->map_wp_error( $new_id );
		}
		$new_id = (int) $new_id;

		// Copy every _elementor_* meta, regenerating ids in _elementor_data (mirror export id replacement,
		// core/base/document.php:1641-1654).
		$source_meta = get_post_meta( $source_id );
		foreach ( (array) $source_meta as $meta_key => $values ) {
			if ( 0 !== strpos( (string) $meta_key, '_elementor' ) ) {
				continue;
			}
			// Skip our own backup snapshots — a copy should start with a clean history.
			if ( 0 === strpos( (string) $meta_key, Backup_Service::META_PREFIX ) ) {
				continue;
			}
			$raw = is_array( $values ) ? ( $values[0] ?? '' ) : $values;
			$raw = maybe_unserialize( $raw );

			if ( '_elementor_data' === $meta_key ) {
				$tree = is_string( $raw ) ? json_decode( $raw, true ) : $raw;
				if ( is_array( $tree ) ) {
					$fresh = Id_Service::dedupe_for_insert( $tree, array() );
					$raw   = wp_json_encode( $fresh['elements'] );
				}
			}

			update_post_meta( $new_id, $meta_key, wp_slash( $raw ) );
		}

		$this->op_log( $new_id, $op_id, 'documents/duplicate', '', $this->current_base_hash( $new_id ) );

		return $this->ok(
			array(
				'id'       => $new_id,
				'edit_url' => $this->edit_url( $new_id ),
			)
		);
	}

	/**
	 * `DELETE /documents/{id}` (10 §2.9). Trashes by default; `force=true` permanently deletes. Returns
	 * `{id,deleted,trashed}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function delete_document( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		if ( null === get_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		$force = (bool) $request->get_param( 'force' );

		if ( $force ) {
			$result = wp_delete_post( $post_id, true );
		} else {
			$result = wp_trash_post( $post_id );
		}

		if ( ! $result ) {
			return $this->fail(
				Error_Codes::INTERNAL_ERROR,
				__( 'The document could not be deleted.', 'elementor-ultra-mcp' ),
				500,
				array( 'post_id' => $post_id )
			);
		}

		return $this->ok(
			array(
				'id'      => $post_id,
				'deleted' => true,
				'trashed' => ! $force,
			)
		);
	}

	/**
	 * `POST /documents/{id}/export` (10 §2.9). Emits library-format JSON INCLUDING referenced global
	 * classes/variables (so the block is portable). Reads global classes via
	 * {@see Global_Classes_Service} (read-only); when unavailable, inlines a minimal collector over the
	 * tree's referenced class ids.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function export_document( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];

		$tree = $this->read_tree( $post_id );
		if ( null === $tree || ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}

		$page_settings = get_post_meta( $post_id, '_elementor_page_settings', true );
		$page_settings = is_array( $page_settings ) ? $page_settings : array();

		$referenced = $this->collect_referenced_class_ids( $tree );

		return $this->ok(
			array(
				'content'          => array_values( $tree ),
				'page_settings'    => $page_settings,
				'type'             => (string) get_post_meta( $post_id, '_elementor_template_type', true ),
				'version'          => defined( 'ELEMENTOR_VERSION' ) ? (string) ELEMENTOR_VERSION : '',
				'global_classes'   => $this->export_global_classes( $referenced ),
				'global_variables' => $this->export_global_variables(),
			)
		);
	}

	// =================================================================================================
	// §2.10 lock-status & §10 ids
	// =================================================================================================

	/**
	 * `GET /documents/{id}/lock-status` (10 §2.10). Wraps {@see Document_Writer::lock_status} + base_hash.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function lock_status( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}
		$lock = Document_Writer::lock_status( $post_id );
		return $this->ok(
			array(
				'id'                  => $post_id,
				'locked'              => (bool) $lock['locked'],
				'locked_by'           => $lock['locked_by'],
				'newer_autosave'      => (bool) $lock['newer_autosave'],
				// Additive: true when the newer autosave is a verified MCP want_preview artifact (the
				// write routes discard it automatically, so it does NOT block a save with a fresh hash).
				'autosave_is_preview' => (bool) $lock['newer_autosave'] && $this->preview_autosave_id( $post_id ) > 0,
				'autosave_ts'         => $lock['autosave_ts'],
				'autosave_author'     => $lock['autosave_author'],
				'base_hash'           => $this->current_base_hash( $post_id ),
			)
		);
	}

	/**
	 * `GET /documents/{id}/ids` (10 §10). Thin wrapper over {@see Id_Service::used_ids}. Returns
	 * `{ids,local_style_ids}`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function document_ids( WP_REST_Request $request ) {
		$post_id = (int) $request['id'];
		if ( ! $this->is_elementor_post( $post_id ) ) {
			return $this->not_found( $post_id );
		}
		$used = Id_Service::used_ids( $post_id );
		return $this->ok(
			array(
				'ids'             => isset( $used['ids'] ) ? array_values( $used['ids'] ) : array(),
				'local_style_ids' => isset( $used['local_style_ids'] ) ? array_values( $used['local_style_ids'] ) : array(),
			)
		);
	}

	// =================================================================================================
	// Internal helpers (parse → service-call → envelope; no business logic).
	// =================================================================================================

	/**
	 * Build the {@see Document_Writer::save}/`replace_tree` args from a save/replace request (§2.6).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @param string|null     $op_id   The validated op id.
	 * @return array<string,mixed>
	 */
	private function write_args( WP_REST_Request $request, ?string $op_id ): array {
		$args = array(
			'op_id'     => $op_id,
			'prime_css' => (bool) $request->get_param( 'prime_css' ),
			'force'     => (bool) $request->get_param( 'force' ),
			'backup'    => null === $request->get_param( 'backup' ) ? true : (bool) $request->get_param( 'backup' ),
		);

		$elements = $request->get_param( 'elements' );
		if ( is_array( $elements ) ) {
			$args['elements'] = $elements;
		}
		$settings = $request->get_param( 'settings' );
		if ( is_array( $settings ) ) {
			$args['settings'] = $settings;
		}
		$base_hash = $request->get_param( 'base_hash' );
		if ( is_string( $base_hash ) && '' !== $base_hash ) {
			$args['base_hash'] = $base_hash;
		}

		return $args;
	}

	/**
	 * Write a per-user autosave for `want_preview` (10 §2.3) and return the preview URL with the
	 * `post_preview_{id}` nonce. NEVER touches the published `_elementor_data`: Document::save() always
	 * writes `_elementor_data` on ITS OWN post id (`post_status=autosave` only defines DOING_AUTOSAVE —
	 * it does NOT route to a revision), so we must save on the AUTOSAVE document obtained via
	 * `get_autosave(0, true)`, exactly like upstream `Documents_Manager::ajax_save`. Upstream only
	 * creates that autosave revision for published/private posts (for drafts ajax_save writes to the
	 * original — forbidden here, dry-run persists nothing), so for any other status we skip the write
	 * and return null (the caller surfaces a warning). The written revision is tagged with
	 * {@see self::PREVIEW_META} (a content fingerprint) so the write routes can recognize + discard it
	 * instead of 409ing AUTOSAVE_CONFLICT on the preview-then-commit flow.
	 *
	 * @param int                            $post_id  The document id.
	 * @param array<int,array<string,mixed>> $elements The candidate tree.
	 * @param array<string,mixed>            $settings The candidate settings.
	 * @return string|null
	 */
	private function write_preview_autosave( int $post_id, array $elements, array $settings ): ?string {
		// Mirror ajax_save: an autosave REVISION exists only for published/private posts.
		$post_status = (string) get_post_status( $post_id );
		if ( ! in_array( $post_status, array( 'publish', 'private' ), true ) ) {
			return null;
		}

		$document = $this->get_document_instance( $post_id );
		if ( null === $document || ! method_exists( $document, 'get_autosave' ) ) {
			return null;
		}

		$autosave = $document->get_autosave( 0, true );
		if ( ! is_object( $autosave ) || ! method_exists( $autosave, 'save' ) || ! method_exists( $autosave, 'get_post' ) ) {
			return null;
		}

		// Hard guard: refuse to write unless the target really is a DIFFERENT post (the revision).
		$autosave_post = $autosave->get_post();
		$autosave_id   = ( is_object( $autosave_post ) && isset( $autosave_post->ID ) ) ? (int) $autosave_post->ID : 0;
		if ( $autosave_id <= 0 || $autosave_id === $post_id ) {
			return null;
		}

		$autosave->save(
			array(
				'elements' => $elements,
				'settings' => array_merge( $settings, array( 'post_status' => 'autosave' ) ),
			)
		);

		// Tag the revision as an MCP-minted PREVIEW, fingerprinted on the tree just saved, so the
		// canonical preview-then-commit flow works: a subsequent save/replace-tree/rollback discards a
		// VERIFIED preview autosave instead of tripping the writer's newer-autosave gate with a 409
		// AUTOSAVE_CONFLICT (which the TS client never retries, and whose only escape — force:true —
		// also disables the base_hash check). Revisions need the raw metadata API: update_post_meta()
		// silently redirects writes to the parent post.
		update_metadata( 'post', $autosave_id, self::PREVIEW_META, $this->autosave_fingerprint( $autosave_id ) );

		if ( ! function_exists( 'get_preview_post_link' ) ) {
			return null;
		}
		$url = get_preview_post_link(
			$post_id,
			array(
				'preview_id'    => $post_id,
				'preview_nonce' => wp_create_nonce( 'post_preview_' . $post_id ),
			)
		);
		return ( is_string( $url ) && '' !== $url ) ? $url : null;
	}

	/**
	 * The md5 fingerprint of a revision's CURRENT `_elementor_data` (the {@see self::PREVIEW_META} tag
	 * value). Read via the raw metadata API — `get_post_meta()` is fine for reads, but symmetry with the
	 * revision-targeted write keeps the access path obvious.
	 *
	 * @param int $revision_id The autosave revision id.
	 */
	private function autosave_fingerprint( int $revision_id ): string {
		$raw = get_metadata( 'post', $revision_id, '_elementor_data', true );
		if ( is_array( $raw ) ) {
			$raw = (string) wp_json_encode( $raw );
		}
		return md5( is_string( $raw ) ? $raw : '' );
	}

	/**
	 * The current user's autosave-revision id IF AND ONLY IF it is a VERIFIED MCP-minted preview
	 * (the {@see self::PREVIEW_META} tag exists AND still fingerprints the revision's current
	 * `_elementor_data`); 0 otherwise. A real editor autosave that overwrote the revision since the
	 * preview write changes the content, breaks the fingerprint, and is therefore never reported as a
	 * preview — the writer's newer-autosave gate keeps protecting it. Per-user lookup matches the
	 * writer's gate (`Document::get_newer_autosave()` → `wp_get_post_autosave(id, current_user)`).
	 *
	 * @param int $post_id The main document id.
	 * @return int The preview autosave revision id, or 0.
	 */
	private function preview_autosave_id( int $post_id ): int {
		if ( ! function_exists( 'wp_get_post_autosave' ) ) {
			return 0;
		}
		$autosave = wp_get_post_autosave( $post_id, get_current_user_id() );
		if ( ! $autosave || ! isset( $autosave->ID ) ) {
			return 0;
		}
		$autosave_id = (int) $autosave->ID;
		if ( $autosave_id <= 0 || $autosave_id === $post_id ) {
			return 0;
		}

		$tag = get_metadata( 'post', $autosave_id, self::PREVIEW_META, true );
		if ( ! is_string( $tag ) || '' === $tag ) {
			return 0;
		}

		return hash_equals( $tag, $this->autosave_fingerprint( $autosave_id ) ) ? $autosave_id : 0;
	}

	/**
	 * Discard the current user's autosave revision when (and only when) it is a verified MCP preview
	 * ({@see self::preview_autosave_id}). Called by the write routes BEFORE delegating to the writer:
	 * a `want_preview` dry-run mints an autosave revision NEWER than the main post, which otherwise
	 * trips the writer's newer-autosave gate (409 AUTOSAVE_CONFLICT — never retried by the TS client)
	 * on the canonical preview-then-commit flow even with a correct base_hash. The preview is an
	 * ephemeral dry-run artifact, so discarding it loses nothing; optimistic concurrency is untouched
	 * (a stale base_hash still 409s CONCURRENCY_STALE_HASH inside the writer, and non-preview
	 * autosaves still 409 AUTOSAVE_CONFLICT).
	 *
	 * @param int $post_id The main document id.
	 * @return bool Whether a preview autosave was discarded.
	 */
	private function discard_preview_autosave( int $post_id ): bool {
		$autosave_id = $this->preview_autosave_id( $post_id );
		if ( $autosave_id <= 0 || ! function_exists( 'wp_delete_post_revision' ) ) {
			return false;
		}
		$deleted = wp_delete_post_revision( $autosave_id );
		return (bool) $deleted && ! is_wp_error( $deleted );
	}

	/**
	 * Read a post's `_elementor_data` tree as a decoded array (read-only). Null when absent/unreadable.
	 *
	 * @param int $post_id The document id.
	 * @return array<int,array<string,mixed>>|null
	 */
	private function read_tree( int $post_id ): ?array {
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
	 * Whether a post is an Elementor-built document (`_elementor_edit_mode='builder'`).
	 *
	 * @param int $post_id The document id.
	 */
	private function is_elementor_post( int $post_id ): bool {
		if ( $post_id <= 0 || null === get_post( $post_id ) ) {
			return false;
		}
		return 'builder' === (string) get_post_meta( $post_id, '_elementor_edit_mode', true );
	}

	/**
	 * The Elementor documents manager (or null when Elementor is unavailable).
	 *
	 * @return object|null
	 */
	private function documents_manager() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		return ( null !== $plugin && isset( $plugin->documents ) ) ? $plugin->documents : null;
	}

	/**
	 * Resolve a document instance via the documents manager (or null).
	 *
	 * @param int $post_id The document id.
	 * @return object|null
	 */
	private function get_document_instance( int $post_id ) {
		$documents = $this->documents_manager();
		if ( null === $documents ) {
			return null;
		}
		$document = $documents->get( $post_id );
		return ( $document && is_object( $document ) ) ? $document : null;
	}

	/**
	 * The Elementor editor URL for a document.
	 *
	 * @param int $post_id The document id.
	 */
	private function edit_url( int $post_id ): string {
		$document = $this->get_document_instance( $post_id );
		if ( null !== $document && method_exists( $document, 'get_edit_url' ) ) {
			$url = $document->get_edit_url();
			if ( is_string( $url ) && '' !== $url ) {
				return $url;
			}
		}
		return (string) get_edit_post_link( $post_id, 'raw' );
	}

	/**
	 * Derive the Elementor `template_type` from a WP post type (10 §2.2 — page→`wp-page`, post→`wp-post`).
	 *
	 * @param string $post_type The WP post type.
	 */
	private function derive_template_type( string $post_type ): string {
		switch ( $post_type ) {
			case 'page':
				return 'wp-page';
			case 'post':
				return 'wp-post';
			default:
				return 'wp-' . $post_type;
		}
	}

	/**
	 * Normalize the list-route `post_type` param into a clean string[] (defaulting to all Elementor-built
	 * public post types).
	 *
	 * @param mixed $raw The raw param.
	 * @return string[]
	 */
	private function normalize_post_types( $raw ): array {
		if ( is_string( $raw ) && '' !== $raw ) {
			return array( sanitize_key( $raw ) );
		}
		if ( is_array( $raw ) && ! empty( $raw ) ) {
			$out = array();
			foreach ( $raw as $pt ) {
				if ( is_string( $pt ) && '' !== $pt ) {
					$out[] = sanitize_key( $pt );
				}
			}
			if ( ! empty( $out ) ) {
				return $out;
			}
		}
		// Default: every public post type (Elementor can build pages/posts/CPTs).
		$types = get_post_types( array( 'public' => true ), 'names' );
		return ! empty( $types ) ? array_values( $types ) : array( 'page', 'post' );
	}

	/**
	 * Find a subtree rooted at `$target_id` anywhere in the tree (depth-first). Null when absent.
	 *
	 * @param array<int,array<string,mixed>> $elements  The tree.
	 * @param string                         $target_id The element id to find.
	 * @return array<string,mixed>|null
	 */
	private function find_subtree( array $elements, string $target_id ): ?array {
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			if ( isset( $node['id'] ) && (string) $node['id'] === $target_id ) {
				return $node;
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$found = $this->find_subtree( $node['elements'], $target_id );
				if ( null !== $found ) {
					return $found;
				}
			}
		}
		return null;
	}

	/**
	 * Truncate a tree to `$depth` levels (depth 0 = strip all children; the root nodes are level 0).
	 *
	 * @param array<int,array<string,mixed>> $elements The tree.
	 * @param int                            $depth    Levels of children to keep.
	 * @return array<int,array<string,mixed>>
	 */
	private function truncate_depth( array $elements, int $depth ): array {
		$out = array();
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				$out[] = $node;
				continue;
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$node['elements'] = ( $depth > 0 )
					? $this->truncate_depth( $node['elements'], $depth - 1 )
					: array();
			}
			$out[] = $node;
		}
		return $out;
	}

	/**
	 * Project a tree to the `summary` shape (`{id,elType,widgetType}` per node, recursing into children).
	 *
	 * @param array<int,array<string,mixed>> $elements The tree.
	 * @return array<int,array<string,mixed>>
	 */
	private function project_summary( array $elements ): array {
		$out = array();
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			$summary = array(
				'id'         => isset( $node['id'] ) ? $node['id'] : null,
				'elType'     => isset( $node['elType'] ) ? $node['elType'] : null,
				'widgetType' => isset( $node['widgetType'] ) ? $node['widgetType'] : null,
			);
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) && ! empty( $node['elements'] ) ) {
				$summary['elements'] = $this->project_summary( $node['elements'] );
			}
			$out[] = $summary;
		}
		return $out;
	}

	/**
	 * The dominant generation of a tree (`v4` when any node is atomic, else `v3`) using the live
	 * {@see Validator::detect_generation}.
	 *
	 * @param array<int,array<string,mixed>> $elements The tree.
	 */
	private function tree_generation( array $elements ): string {
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			if ( 'v4' === Validator::detect_generation( $node ) ) {
				return 'v4';
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) && 'v4' === $this->tree_generation( $node['elements'] ) ) {
				return 'v4';
			}
		}
		return 'v3';
	}

	/**
	 * Collect the global/local class ids referenced anywhere in a tree via the typed `classes` envelope
	 * (`settings.classes.value[]`) — used to export the referenced global classes (§2.9).
	 *
	 * @param array<int,array<string,mixed>> $elements The tree.
	 * @return string[]
	 */
	private function collect_referenced_class_ids( array $elements ): array {
		$ids = array();
		$this->walk_class_refs( $elements, $ids );
		return array_values( array_unique( $ids ) );
	}

	/**
	 * Depth-first accumulate referenced class ids from every node's `settings.classes.value[]`.
	 *
	 * @param array<int,array<string,mixed>> $elements The (sub)tree.
	 * @param string[]                       $ids      Accumulator (by reference).
	 */
	private function walk_class_refs( array $elements, array &$ids ): void {
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			if ( isset( $node['settings']['classes']['value'] ) && is_array( $node['settings']['classes']['value'] ) ) {
				foreach ( $node['settings']['classes']['value'] as $cid ) {
					if ( is_string( $cid ) && '' !== $cid ) {
						$ids[] = $cid;
					}
				}
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$this->walk_class_refs( $node['elements'], $ids );
			}
		}
	}

	/**
	 * Export the referenced global classes (10 §2.9). Prefers the repository-backed
	 * {@see Global_Classes_Service} (canonical path, Contract 15 §3.6); when unavailable returns an empty
	 * map. Only classes actually referenced by `$referenced` are emitted (portability without bloat).
	 *
	 * @param string[] $referenced The class ids referenced by the tree.
	 * @return array<string,mixed>
	 */
	private function export_global_classes( array $referenced ): array {
		if ( empty( $referenced ) || ! class_exists( '\Elementor\Ultra\Core\Global_Classes_Service' ) ) {
			return array();
		}
		$service  = new Global_Classes_Service();
		$snapshot = $service->list();
		if ( is_wp_error( $snapshot ) || ! isset( $snapshot['items'] ) || ! is_array( $snapshot['items'] ) ) {
			return array();
		}
		$ref = array_fill_keys( $referenced, true );
		$out = array();
		foreach ( $snapshot['items'] as $id => $item ) {
			if ( isset( $ref[ (string) $id ] ) ) {
				$out[ (string) $id ] = $item;
			}
		}
		return $out;
	}

	/**
	 * Export the site's global variables (10 §2.9) read-only via Elementor's variables service when
	 * present; an empty map otherwise (the design WP owns the canonical write/read path).
	 *
	 * @return array<string,mixed>
	 */
	private function export_global_variables(): array {
		$fqcn = '\Elementor\Modules\Variables\Classes\Variables_Repository';
		if ( ! class_exists( $fqcn ) || ! class_exists( '\Elementor\Plugin' ) ) {
			return array();
		}
		try {
			$kit = \Elementor\Plugin::$instance->kits_manager->get_active_kit();
			if ( ! is_object( $kit ) ) {
				return array();
			}
			$repo = new $fqcn( $kit );
			if ( ! method_exists( $repo, 'variables' ) ) {
				return array();
			}
			$db = $repo->variables();
			return ( isset( $db['data'] ) && is_array( $db['data'] ) ) ? $db['data'] : array();
		} catch ( \Throwable $e ) {
			return array();
		}
	}

	/**
	 * Standard 404 NOT_FOUND for an absent/non-Elementor document (10 §0.7 / §2.4).
	 *
	 * @param int $post_id The document id.
	 */
	private function not_found( int $post_id ): WP_Error {
		return $this->fail(
			Error_Codes::NOT_FOUND,
			sprintf(
				/* translators: %d: post id. */
				__( 'Document %d was not found or is not Elementor-built.', 'elementor-ultra-mcp' ),
				$post_id
			),
			404,
			array( 'post_id' => $post_id )
		);
	}

	/**
	 * Append one op-log row behind a class_exists guard (WP-P14 soft dep — never fails the route).
	 *
	 * @param int         $post_id     The document id.
	 * @param string|null $op_id       The op id.
	 * @param string      $route       The route/tool label.
	 * @param string      $before_hash The pre-op base_hash.
	 * @param string      $after_hash  The post-op base_hash.
	 */
	private function op_log( int $post_id, ?string $op_id, string $route, string $before_hash, string $after_hash ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		\Elementor\Ultra\Core\Op_Log::record(
			array(
				'op_id'       => $op_id,
				'post_id'     => $post_id,
				'route'       => $route,
				'before_hash' => '' !== $before_hash ? $before_hash : null,
				'after_hash'  => '' !== $after_hash ? $after_hash : null,
				'result'      => 'ok',
			)
		);
	}

	/**
	 * Find the post id minted by a PRIOR `documents/create` op-log row for an op_id (10 §0.8 create
	 * idempotency). ROUTE-SCOPED on purpose: {@see \Elementor\Ultra\Core\Op_Log::find_by_op_id} returns
	 * only the single NEWEST row for an op_id, but one op_id can legitimately carry multiple rows (the
	 * page_build tool reuses one op_id for create + save, and {@see \Elementor\Ultra\Core\Document_Writer}
	 * logs a `documents/save` row under it) — so the create replay guard must match the newest row whose
	 * route is exactly `documents/create`, not inspect the latest row's route.
	 *
	 * @param string $op_id The operation id.
	 * @return int The previously created post id, or 0 when no prior create row exists.
	 */
	private function find_prior_create_post_id( string $op_id ): int {
		if ( '' === $op_id
			|| ! class_exists( '\Elementor\Ultra\Core\Op_Log' )
			|| ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'table_name' ) ) {
			return 0;
		}

		global $wpdb;
		$table = \Elementor\Ultra\Core\Op_Log::table_name();

		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- $table from $wpdb->prefix; values are placeholders.
		$sql = $wpdb->prepare( "SELECT post_id FROM {$table} WHERE op_id = %s AND route = %s ORDER BY ts DESC, id DESC LIMIT 1", $op_id, 'documents/create' );
		// phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- prepared above; custom plugin table (no core API).
		$post_id = $wpdb->get_var( $sql );

		return null === $post_id ? 0 : (int) $post_id;
	}

	// =================================================================================================
	// Arg-schema factories (kept tiny + reused so malformed args yield 400 SCHEMA_INVALID_PARAMS).
	// =================================================================================================

	/**
	 * The `{id}` path arg schema.
	 *
	 * @param bool $require_positive When true, the id must be >= 1 (a real post); false allows 0 (dry-run).
	 * @return array<string,mixed>
	 */
	private function id_arg( bool $require_positive = true ): array {
		$arg = array(
			'type'              => 'integer',
			'required'          => true,
			'sanitize_callback' => 'absint',
		);
		if ( $require_positive ) {
			$arg['minimum'] = 1;
		} else {
			$arg['minimum'] = 0;
		}
		return $arg;
	}

	/** The optional `op_id` arg schema (validated for real in {@see Abstract_Controller::read_op_id}). */
	private function op_id_arg(): array {
		return array(
			'type'     => 'string',
			'required' => false,
		);
	}

	/** The optional `base_hash` arg schema. */
	private function base_hash_arg(): array {
		return array(
			'type'     => 'string',
			'required' => false,
		);
	}

	/**
	 * A boolean arg schema with a default.
	 *
	 * @param bool $default_value The default value.
	 * @return array<string,mixed>
	 */
	private function bool_arg( bool $default_value ): array {
		return array(
			'type'     => 'boolean',
			'required' => false,
			'default'  => $default_value,
		);
	}

	/** The §0.11 `limit` arg schema. */
	private function limit_arg(): array {
		return array(
			'type'     => 'integer',
			'required' => false,
			'default'  => 25,
			'minimum'  => 1,
			'maximum'  => 100,
		);
	}

	/** The §0.11 `cursor` arg schema. */
	private function cursor_arg(): array {
		return array(
			'type'     => 'string',
			'required' => false,
		);
	}

	/** The §0.11 `fields` projection arg schema. */
	private function fields_arg(): array {
		return array(
			'type'     => array( 'array', 'string' ),
			'required' => false,
		);
	}
}

/**
 * The granular element-op applier (10 §14). A PURE in-memory tree transform — it NEVER persists. It
 * applies the op list in order against an in-memory tree, mints fresh ids for inserts (and dedupes them
 * against the existing tree), and mirrors `set_local_style` ids into `settings.classes.value` (Contract
 * 11 §5.1, R4). The controller hands the resulting WHOLE tree to {@see Document_Writer::replace_tree} so
 * there is exactly ONE save (validate-before-persist is the writer's job).
 *
 * Co-located in the controller file by design (WP-P06 Detailed Requirements #8 / Implementation Notes —
 * "the controller may use a small in-file `Element_Ops` applier"); it is a private, controller-scoped
 * helper with no independent consumer, so the one-class-per-file convention is intentionally relaxed.
 *
 * phpcs:disable Generic.Files.OneObjectStructurePerFile.MultipleFound -- ticket-authorized in-file applier (WP-P06 §8).
 */
final class Element_Ops {

	/**
	 * Apply every op in order to a copy of `$tree`. Returns `{elements, remapped}` or a WP_Error (400 for
	 * a malformed/unknown op; 404 for a referenced element id that is absent).
	 *
	 * @param array<int,array<string,mixed>> $tree    The current tree (will be transformed on a copy).
	 * @param array<int,array<string,mixed>> $ops     The op list (10 §14).
	 * @param int                            $post_id The target document (for id-dedupe of inserts).
	 * @return array{elements:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	public static function apply( array $tree, array $ops, int $post_id ) {
		$remapped = array();

		foreach ( $ops as $index => $op ) {
			if ( ! is_array( $op ) || ! isset( $op['op'] ) || ! is_string( $op['op'] ) ) {
				return self::bad_op( $index, 'each op requires a string "op" field.' );
			}
			$kind = $op['op'];
			if ( ! in_array( $kind, Documents_Controller::ELEMENT_OPS, true ) ) {
				return self::bad_op( $index, sprintf( 'unknown op "%s".', $kind ) );
			}

			switch ( $kind ) {
				case 'insert':
					$result = self::op_insert( $tree, $op, $index, $post_id );
					break;
				case 'update_settings':
					$result = self::op_update_settings( $tree, $op, $index );
					break;
				case 'move':
					$result = self::op_move( $tree, $op, $index );
					break;
				case 'delete':
					$result = self::op_delete( $tree, $op, $index );
					break;
				case 'set_classes':
					$result = self::op_set_classes( $tree, $op, $index );
					break;
				case 'set_local_style':
					$result = self::op_set_local_style( $tree, $op, $index );
					break;
				case 'bind_global':
					$result = self::op_bind_global( $tree, $op, $index );
					break;
				case 'bind_dynamic':
					$result = self::op_bind_dynamic( $tree, $op, $index );
					break;
				default:
					$result = self::bad_op( $index, sprintf( 'op "%s" is not implemented.', $kind ) );
			}

			if ( $result instanceof WP_Error ) {
				return $result;
			}
			$tree = $result['tree'];
			if ( ! empty( $result['remapped'] ) ) {
				$remapped = array_merge( $remapped, $result['remapped'] );
			}
		}

		return array(
			'elements' => $tree,
			'remapped' => $remapped,
		);
	}

	/**
	 * `insert`: mint fresh ids for the node (and its subtree) against the existing tree, then place it
	 * under `parent_id` at `index`.
	 *
	 * @param array<int,array<string,mixed>> $tree    The tree.
	 * @param array<string,mixed>            $op      The op.
	 * @param int                            $idx     The op index (for error paths).
	 * @param int                            $post_id The document id (id-dedupe seed).
	 * @return array{tree:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	private static function op_insert( array $tree, array $op, int $idx, int $post_id ) {
		if ( ! isset( $op['node'] ) || ! is_array( $op['node'] ) ) {
			return self::bad_op( $idx, 'insert requires a "node" object.' );
		}
		$parent_id = isset( $op['parent_id'] ) && is_string( $op['parent_id'] ) ? $op['parent_id'] : '';
		$index     = isset( $op['index'] ) ? (int) $op['index'] : 0;

		// Fresh ids for the inserted subtree, deduped vs the document's used ids AND the in-memory tree.
		$existing = Id_Service::used_ids( $post_id )['ids'];
		foreach ( self::flatten_ids( $tree ) as $tid ) {
			$existing[] = $tid;
		}
		$fresh    = Id_Service::dedupe_for_insert( array( $op['node'] ), array_values( array_unique( $existing ) ) );
		$node     = $fresh['elements'][0];
		$remapped = $fresh['remapped'];

		if ( '' === $parent_id ) {
			// Top-level insert.
			array_splice( $tree, max( 0, min( $index, count( $tree ) ) ), 0, array( $node ) );
			return array(
				'tree'     => $tree,
				'remapped' => $remapped,
			);
		}

		$placed = false;
		$tree   = self::map_node(
			$tree,
			$parent_id,
			static function ( array $target ) use ( $node, $index, &$placed ) {
				$children = isset( $target['elements'] ) && is_array( $target['elements'] ) ? $target['elements'] : array();
				array_splice( $children, max( 0, min( $index, count( $children ) ) ), 0, array( $node ) );
				$target['elements'] = $children;
				$placed             = true;
				return $target;
			}
		);
		if ( ! $placed ) {
			return self::not_found_element( $idx, $parent_id );
		}

		return array(
			'tree'     => $tree,
			'remapped' => $remapped,
		);
	}

	/**
	 * `update_settings`: deep-merge a settings patch into the target element.
	 *
	 * @param array<int,array<string,mixed>> $tree The tree.
	 * @param array<string,mixed>            $op   The op.
	 * @param int                            $idx  The op index.
	 * @return array{tree:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	private static function op_update_settings( array $tree, array $op, int $idx ) {
		$target_id = self::require_element_id( $op, $idx );
		if ( $target_id instanceof WP_Error ) {
			return $target_id;
		}
		$patch = isset( $op['settings'] ) && is_array( $op['settings'] ) ? $op['settings'] : array();

		$found = false;
		$tree  = self::map_node(
			$tree,
			$target_id,
			static function ( array $target ) use ( $patch, &$found ) {
				$current            = isset( $target['settings'] ) && is_array( $target['settings'] ) ? $target['settings'] : array();
				$target['settings'] = self::deep_merge( $current, $patch );
				$found              = true;
				return $target;
			}
		);
		if ( ! $found ) {
			return self::not_found_element( $idx, $target_id );
		}
		return array(
			'tree'     => $tree,
			'remapped' => array(),
		);
	}

	/**
	 * `move`: relocate an element to `new_parent_id` at `index` (extract then re-insert; ids unchanged).
	 *
	 * @param array<int,array<string,mixed>> $tree The tree.
	 * @param array<string,mixed>            $op   The op.
	 * @param int                            $idx  The op index.
	 * @return array{tree:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	private static function op_move( array $tree, array $op, int $idx ) {
		$target_id = self::require_element_id( $op, $idx );
		if ( $target_id instanceof WP_Error ) {
			return $target_id;
		}
		$new_parent = isset( $op['new_parent_id'] ) && is_string( $op['new_parent_id'] ) ? $op['new_parent_id'] : '';
		$index      = isset( $op['index'] ) ? (int) $op['index'] : 0;

		$extracted = null;
		$tree      = self::extract_node( $tree, $target_id, $extracted );
		if ( null === $extracted ) {
			return self::not_found_element( $idx, $target_id );
		}

		if ( '' === $new_parent ) {
			array_splice( $tree, max( 0, min( $index, count( $tree ) ) ), 0, array( $extracted ) );
			return array(
				'tree'     => $tree,
				'remapped' => array(),
			);
		}

		$placed = false;
		$tree   = self::map_node(
			$tree,
			$new_parent,
			static function ( array $target ) use ( $extracted, $index, &$placed ) {
				$children = isset( $target['elements'] ) && is_array( $target['elements'] ) ? $target['elements'] : array();
				array_splice( $children, max( 0, min( $index, count( $children ) ) ), 0, array( $extracted ) );
				$target['elements'] = $children;
				$placed             = true;
				return $target;
			}
		);
		if ( ! $placed ) {
			return self::not_found_element( $idx, $new_parent );
		}
		return array(
			'tree'     => $tree,
			'remapped' => array(),
		);
	}

	/**
	 * `delete`: remove an element (and its subtree).
	 *
	 * @param array<int,array<string,mixed>> $tree The tree.
	 * @param array<string,mixed>            $op   The op.
	 * @param int                            $idx  The op index.
	 * @return array{tree:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	private static function op_delete( array $tree, array $op, int $idx ) {
		$target_id = self::require_element_id( $op, $idx );
		if ( $target_id instanceof WP_Error ) {
			return $target_id;
		}
		$extracted = null;
		$tree      = self::extract_node( $tree, $target_id, $extracted );
		if ( null === $extracted ) {
			return self::not_found_element( $idx, $target_id );
		}
		return array(
			'tree'     => $tree,
			'remapped' => array(),
		);
	}

	/**
	 * `set_classes`: replace the element's `settings.classes.value` with the supplied id list (typed
	 * `classes` envelope, Contract 11 §5.1).
	 *
	 * @param array<int,array<string,mixed>> $tree The tree.
	 * @param array<string,mixed>            $op   The op.
	 * @param int                            $idx  The op index.
	 * @return array{tree:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	private static function op_set_classes( array $tree, array $op, int $idx ) {
		$target_id = self::require_element_id( $op, $idx );
		if ( $target_id instanceof WP_Error ) {
			return $target_id;
		}
		$class_ids = isset( $op['class_ids'] ) && is_array( $op['class_ids'] ) ? array_values( array_filter( $op['class_ids'], 'is_string' ) ) : array();

		$found = false;
		$tree  = self::map_node(
			$tree,
			$target_id,
			static function ( array $target ) use ( $class_ids, &$found ) {
				$target = self::set_class_value( $target, $class_ids );
				$found  = true;
				return $target;
			}
		);
		if ( ! $found ) {
			return self::not_found_element( $idx, $target_id );
		}
		return array(
			'tree'     => $tree,
			'remapped' => array(),
		);
	}

	/**
	 * `set_local_style`: upsert a style in the element's `styles` map AND ensure its id is present in
	 * `settings.classes.value` (Contract 11 §5.1, R4 — the style map key, styles[].id, and the classes
	 * back-ref stay consistent).
	 *
	 * @param array<int,array<string,mixed>> $tree The tree.
	 * @param array<string,mixed>            $op   The op.
	 * @param int                            $idx  The op index.
	 * @return array{tree:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	private static function op_set_local_style( array $tree, array $op, int $idx ) {
		$target_id = self::require_element_id( $op, $idx );
		if ( $target_id instanceof WP_Error ) {
			return $target_id;
		}
		$style_id = isset( $op['style_id'] ) && is_string( $op['style_id'] ) ? $op['style_id'] : '';
		if ( '' === $style_id ) {
			return self::bad_op( $idx, 'set_local_style requires a "style_id".' );
		}
		$variant = isset( $op['variant'] ) && is_array( $op['variant'] ) ? $op['variant'] : null;
		if ( null === $variant ) {
			return self::bad_op( $idx, 'set_local_style requires a "variant" object.' );
		}

		$found = false;
		$tree  = self::map_node(
			$tree,
			$target_id,
			static function ( array $target ) use ( $style_id, $variant, &$found ) {
				$styles = isset( $target['styles'] ) && is_array( $target['styles'] ) ? $target['styles'] : array();

				// Upsert the style definition: append/replace the variant for this style id.
				$style    = isset( $styles[ $style_id ] ) && is_array( $styles[ $style_id ] ) ? $styles[ $style_id ] : array();
				$variants = isset( $style['variants'] ) && is_array( $style['variants'] ) ? $style['variants'] : array();

				// Replace a variant with the same meta (breakpoint+state), else append.
				$replaced = false;
				foreach ( $variants as $i => $existing_variant ) {
					if ( is_array( $existing_variant ) && self::same_variant_meta( $existing_variant, $variant ) ) {
						$variants[ $i ] = $variant;
						$replaced       = true;
						break;
					}
				}
				if ( ! $replaced ) {
					$variants[] = $variant;
				}

				$style['id']         = $style_id; // styles[].id mirrors the map key (style-definition.php).
				$style['label']      = isset( $style['label'] ) ? $style['label'] : 'local';
				$style['type']       = isset( $style['type'] ) ? $style['type'] : 'class';
				$style['variants']   = array_values( $variants );
				$styles[ $style_id ] = $style;
				$target['styles']    = $styles;

				// R4: ensure the style id is in settings.classes.value.
				$current = array();
				if ( isset( $target['settings']['classes']['value'] ) && is_array( $target['settings']['classes']['value'] ) ) {
					$current = array_values( array_filter( $target['settings']['classes']['value'], 'is_string' ) );
				}
				if ( ! in_array( $style_id, $current, true ) ) {
					$current[] = $style_id;
				}
				$target = self::set_class_value( $target, $current );

				$found = true;
				return $target;
			}
		);
		if ( ! $found ) {
			return self::not_found_element( $idx, $target_id );
		}
		return array(
			'tree'     => $tree,
			'remapped' => array(),
		);
	}

	/**
	 * `bind_global`: write the V3 `__globals__[control]` encoding on the target element (Contract 11 §7).
	 *
	 * @param array<int,array<string,mixed>> $tree The tree.
	 * @param array<string,mixed>            $op   The op.
	 * @param int                            $idx  The op index.
	 * @return array{tree:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	private static function op_bind_global( array $tree, array $op, int $idx ) {
		$target_id = self::require_element_id( $op, $idx );
		if ( $target_id instanceof WP_Error ) {
			return $target_id;
		}
		$control    = isset( $op['control'] ) && is_string( $op['control'] ) ? $op['control'] : '';
		$global_ref = isset( $op['global_ref'] ) && is_string( $op['global_ref'] ) ? $op['global_ref'] : '';
		if ( '' === $control || '' === $global_ref ) {
			return self::bad_op( $idx, 'bind_global requires "control" and "global_ref".' );
		}

		$found = false;
		$tree  = self::map_node(
			$tree,
			$target_id,
			static function ( array $target ) use ( $control, $global_ref, &$found ) {
				$settings                = isset( $target['settings'] ) && is_array( $target['settings'] ) ? $target['settings'] : array();
				$globals                 = isset( $settings['__globals__'] ) && is_array( $settings['__globals__'] ) ? $settings['__globals__'] : array();
				$globals[ $control ]     = $global_ref;
				$settings['__globals__'] = $globals;
				$target['settings']      = $settings;
				$found                   = true;
				return $target;
			}
		);
		if ( ! $found ) {
			return self::not_found_element( $idx, $target_id );
		}
		return array(
			'tree'     => $tree,
			'remapped' => array(),
		);
	}

	/**
	 * `bind_dynamic`: for MVP this writes the V3 `__dynamic__[control]` encoding (Contract 11 §6). The
	 * ATOMIC (V4) dynamic prop envelope is spike-discovered and deferred to a Pro/dynamic WP; a V4-only
	 * caller should use `pro/dynamic/bind`. Here we emit the V3 shape with the supplied tag.
	 *
	 * @param array<int,array<string,mixed>> $tree The tree.
	 * @param array<string,mixed>            $op   The op.
	 * @param int                            $idx  The op index.
	 * @return array{tree:array<int,array<string,mixed>>,remapped:array<string,string>}|WP_Error
	 */
	private static function op_bind_dynamic( array $tree, array $op, int $idx ) {
		$target_id = self::require_element_id( $op, $idx );
		if ( $target_id instanceof WP_Error ) {
			return $target_id;
		}
		$control  = isset( $op['control'] ) && is_string( $op['control'] ) ? $op['control'] : '';
		$tag_name = isset( $op['tag_name'] ) && is_string( $op['tag_name'] ) ? $op['tag_name'] : '';
		if ( '' === $control || '' === $tag_name ) {
			return self::bad_op( $idx, 'bind_dynamic requires "control" and "tag_name".' );
		}
		$tag_settings = isset( $op['tag_settings'] ) && is_array( $op['tag_settings'] ) ? $op['tag_settings'] : array();
		$encoded      = rawurlencode( (string) wp_json_encode( $tag_settings, JSON_FORCE_OBJECT ) );
		$dynamic      = sprintf( '[elementor-tag id="%s" name="%s" settings="%s"]', substr( md5( $target_id . $control ), 0, 7 ), $tag_name, $encoded );

		$found = false;
		$tree  = self::map_node(
			$tree,
			$target_id,
			static function ( array $target ) use ( $control, $dynamic, &$found ) {
				$settings                = isset( $target['settings'] ) && is_array( $target['settings'] ) ? $target['settings'] : array();
				$dyn                     = isset( $settings['__dynamic__'] ) && is_array( $settings['__dynamic__'] ) ? $settings['__dynamic__'] : array();
				$dyn[ $control ]         = $dynamic;
				$settings['__dynamic__'] = $dyn;
				$target['settings']      = $settings;
				$found                   = true;
				return $target;
			}
		);
		if ( ! $found ) {
			return self::not_found_element( $idx, $target_id );
		}
		return array(
			'tree'     => $tree,
			'remapped' => array(),
		);
	}

	// ------------------------------------------------------------------------------------------------
	// Pure tree-walk + merge helpers.
	// ------------------------------------------------------------------------------------------------

	/**
	 * Apply `$mutator` to the node whose id === `$target_id` (depth-first; the first match wins). Returns
	 * the new tree (the original is not mutated).
	 *
	 * @param array<int,array<string,mixed>> $elements  The (sub)tree.
	 * @param string                         $target_id The element id to mutate.
	 * @param callable                       $mutator   `fn(array $node): array`.
	 * @return array<int,array<string,mixed>>
	 */
	private static function map_node( array $elements, string $target_id, callable $mutator ): array {
		$out = array();
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				$out[] = $node;
				continue;
			}
			if ( isset( $node['id'] ) && (string) $node['id'] === $target_id ) {
				$node  = $mutator( $node );
				$out[] = $node;
				continue;
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$node['elements'] = self::map_node( $node['elements'], $target_id, $mutator );
			}
			$out[] = $node;
		}
		return $out;
	}

	/**
	 * Remove the node with id === `$target_id` from the tree and return the new tree; the removed node is
	 * written to `$extracted` (null when not found).
	 *
	 * @param array<int,array<string,mixed>> $elements  The (sub)tree.
	 * @param string                         $target_id The element id to extract.
	 * @param array<string,mixed>|null       $extracted Out-param: the removed node (by reference).
	 * @return array<int,array<string,mixed>>
	 */
	private static function extract_node( array $elements, string $target_id, ?array &$extracted ): array {
		$out = array();
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				$out[] = $node;
				continue;
			}
			if ( isset( $node['id'] ) && (string) $node['id'] === $target_id ) {
				$extracted = $node; // Found — drop it from the output.
				continue;
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				$node['elements'] = self::extract_node( $node['elements'], $target_id, $extracted );
			}
			$out[] = $node;
		}
		return $out;
	}

	/**
	 * Set a node's `settings.classes` to the typed envelope `{$$type:'classes', value:string[]}`.
	 *
	 * @param array<string,mixed> $node      The node.
	 * @param string[]            $class_ids The class ids.
	 * @return array<string,mixed>
	 */
	private static function set_class_value( array $node, array $class_ids ): array {
		$settings            = isset( $node['settings'] ) && is_array( $node['settings'] ) ? $node['settings'] : array();
		$settings['classes'] = array(
			'$$type' => 'classes',
			'value'  => array_values( $class_ids ),
		);
		$node['settings']    = $settings;
		return $node;
	}

	/**
	 * Whether two style variants share the same `meta` (breakpoint+state) — the upsert key.
	 *
	 * @param array<string,mixed> $a The first variant.
	 * @param array<string,mixed> $b The second variant.
	 */
	private static function same_variant_meta( array $a, array $b ): bool {
		$am = isset( $a['meta'] ) && is_array( $a['meta'] ) ? $a['meta'] : array();
		$bm = isset( $b['meta'] ) && is_array( $b['meta'] ) ? $b['meta'] : array();
		$ab = isset( $am['breakpoint'] ) ? $am['breakpoint'] : null;
		$bb = isset( $bm['breakpoint'] ) ? $bm['breakpoint'] : null;
		$as = isset( $am['state'] ) ? $am['state'] : null;
		$bs = isset( $bm['state'] ) ? $bm['state'] : null;
		return $ab === $bb && $as === $bs;
	}

	/**
	 * Recursive deep-merge (mirrors {@see Document_Writer}): scalar keys overwrite; nested assoc arrays
	 * merge; numeric-indexed (repeater) arrays are replaced wholesale by the patch.
	 *
	 * @param array<string,mixed> $base  The base.
	 * @param array<string,mixed> $patch The patch (wins per key).
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
				$base[ $key ] = $value;
			}
		}
		return $base;
	}

	/**
	 * Whether an array is associative (string keys) vs a numeric list.
	 *
	 * @param array<mixed> $arr The array.
	 */
	private static function is_assoc( array $arr ): bool {
		if ( array() === $arr ) {
			return true;
		}
		return array_keys( $arr ) !== range( 0, count( $arr ) - 1 );
	}

	/**
	 * Flatten every element id in a tree (for id-dedupe of inserts).
	 *
	 * @param array<int,array<string,mixed>> $elements The tree.
	 * @return string[]
	 */
	private static function flatten_ids( array $elements ): array {
		$ids = array();
		foreach ( $elements as $node ) {
			if ( ! is_array( $node ) ) {
				continue;
			}
			if ( isset( $node['id'] ) && is_string( $node['id'] ) ) {
				$ids[] = $node['id'];
			}
			if ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) {
				foreach ( self::flatten_ids( $node['elements'] ) as $cid ) {
					$ids[] = $cid;
				}
			}
		}
		return $ids;
	}

	/**
	 * Require + extract the `element_id` from an op (400 when absent).
	 *
	 * @param array<string,mixed> $op  The op.
	 * @param int                 $idx The op index.
	 * @return string|WP_Error
	 */
	private static function require_element_id( array $op, int $idx ) {
		$id = isset( $op['element_id'] ) && is_string( $op['element_id'] ) ? $op['element_id'] : '';
		if ( '' === $id ) {
			return self::bad_op( $idx, sprintf( '%s requires an "element_id".', isset( $op['op'] ) ? (string) $op['op'] : 'op' ) );
		}
		return $id;
	}

	/**
	 * A 400 SCHEMA_INVALID_PARAMS for a malformed/unknown op (10 §0.7).
	 *
	 * @param int    $idx     The op index.
	 * @param string $message The detail.
	 */
	private static function bad_op( int $idx, string $message ): WP_Error {
		return \Elementor\Ultra\Rest\Response::error(
			Error_Codes::SCHEMA_INVALID_PARAMS,
			sprintf(
				/* translators: 1: op index, 2: detail. */
				__( 'Invalid element op at index %1$d: %2$s', 'elementor-ultra-mcp' ),
				$idx,
				$message
			),
			400,
			array( 'path' => sprintf( 'ops[%d]', $idx ) )
		);
	}

	/**
	 * A 404 NOT_FOUND for an op referencing an absent element id (10 §14 — "404 (post or referenced
	 * element id)").
	 *
	 * @param int    $idx        The op index.
	 * @param string $element_id The missing element id.
	 */
	private static function not_found_element( int $idx, string $element_id ): WP_Error {
		return \Elementor\Ultra\Rest\Response::error(
			Error_Codes::NOT_FOUND,
			sprintf(
				/* translators: 1: element id, 2: op index. */
				__( 'Element "%1$s" referenced by op index %2$d was not found in the document.', 'elementor-ultra-mcp' ),
				$element_id,
				$idx
			),
			404,
			array(
				'path'       => sprintf( 'ops[%d].element_id', $idx ),
				'element_id' => $element_id,
			)
		);
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar; we
 * hand it a fresh controller instance so it registers all DOCUMENTS routes without any edit to the spine
 * `class-registrar.php` / `class-plugin.php`.
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Documents_Controller() );
		}
	}
);
