<?php
/**
 * WP-P12 — Templates & Kits REST controller (auto-loaded; self-registers on the WP-P02 registrar).
 *
 * Contract authority: 10-rest-api.md §7 (TEMPLATES/KITS routes), §0.9 (validate-before-save),
 * §0.10 (atomic CSS priming), §0.11 (pagination), §0.3 (capability map); 11-authoring-contract.md
 * §8.1 (replace ALL ids on clone/insert to avoid cross-document collision); 12-error-taxonomy.md
 * §3.1 (ATOMIC_*), §3.5 (IMPORT_REMAP_FAILED, NOT_FOUND).
 *
 * Spike-Verified Corrections (Wave 1, WP-S02 — spec/spikes/WP-S02-findings.md, SUMMARY.md §C2/R5):
 *  - [S02] `save_item` (POST /elementor/v1/template-library/templates, sources/local.php:482) re-IDs
 *    elements AND dependent local-style ids and registers global-class RELATIONS, but does NOT merge
 *    global classes into a kit and does NOT run `on_import` (no image sideload on save).
 *  - [S02] insert / JSON-import MUST replicate the editor's TWO-step path: `get_data($template_id)`
 *    (local.php:703 — re-IDs again + attaches the `global_classes` snapshot) →
 *    `Templates_Manager::process_global_styles({content, global_classes, import_mode=match_site})`
 *    (manager.php:693 — merges/creates classes into the kit + rewrites content refs via the id_map) →
 *    `Document::save` the processed content. Calling `save_item` alone does NOT merge classes.
 *  - [S02] FILE import (`prepare_import_template_data` → `process_export_import_content('on_import')`,
 *    sources/base.php:478) is the ONLY path that sideloads images. We reuse Elementor's own
 *    `Templates_Manager::import_template()` for file imports so `on_import` + the merge filter run.
 *  - [R5] Local-style ids are regenerated on EVERY save; never assume any are stable across save —
 *    we always re-read the saved tree (the writer does) for the fresh `base_hash`.
 *  - Failures (bad atomic envelopes, missing snapshot on insert, MAX_ITEMS(1000) overflow →
 *    `flattened_classes_count`, orphan-ref pruning by `get_data`) surface as IMPORT_REMAP_FAILED.
 *
 * Reuses (does NOT reimplement) the LIVE PHP services: `\Elementor\Ultra\Validator`
 * (authoritative dry-run), `Document_Writer` (transactional save: validate→backup→save→prime;
 * base_hash optimistic lock), `Id_Service::dedupe_for_insert` (FRESH ids + local-style backrefs),
 * `Css_Primer` (atomic prime). Kit routes wrap the Elementor import-export module.
 *
 * Self-registration: adds itself to the WP-P02 {@see Registrar} on the `elementor_ultra/rest/register`
 * action so wiring NEVER edits the spine `class-registrar.php` / `class-plugin.php` (parallelism rule).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Document_Writer;
use Elementor\Ultra\Core\Id_Service;
use Elementor\Ultra\Core\Op_Log;
use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Validator;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The TEMPLATES / KITS REST controller (10-rest-api.md §7).
 */
final class Templates_Controller extends Abstract_Controller {

	/** The Elementor library CPT post type (`Source_Local::CPT`). */
	const TEMPLATE_CPT = 'elementor_library';

	/** The per-template-type meta key (`Document::TYPE_META_KEY`). */
	const TYPE_META_KEY = '_elementor_template_type';

	/** The local source id passed to `Templates_Manager` (`Source_Local::get_id()`). */
	const SOURCE_LOCAL = 'local';

	/** Default insert import mode — reuse a kit class BY LABEL (no duplicate); [R5] / [S02]. */
	const IMPORT_MODE_MATCH_SITE = 'match_site';

	/** The kit-export download token meta key (one-time, authenticated download). */
	const KIT_TOKEN_OPTION_PREFIX = 'emcp_kit_download_';

	/**
	 * Register every §7 route. Each declares its own `args` schema + capability `permission_callback`.
	 *
	 * @return void
	 */
	public function register_routes(): void {
		// GET /templates — list (paginated). CAP_READ.
		$this->route(
			'/templates',
			WP_REST_Server::READABLE,
			array( $this, 'list_templates' ),
			Permissions::can_read(),
			array(
				'type'   => array(
					'type'              => array( 'array', 'string' ),
					'required'          => false,
					'sanitize_callback' => array( $this, 'sanitize_type_filter' ),
				),
				'limit'  => array(
					'type'     => 'integer',
					'required' => false,
					'default'  => 25,
					'minimum'  => 1,
					'maximum'  => 100,
				),
				'cursor' => array(
					'type'     => 'string',
					'required' => false,
				),
				'fields' => array(
					'type'     => array( 'array', 'string' ),
					'required' => false,
				),
			)
		);

		// GET /templates/{id} — content + page_settings. CAP_READ.
		$this->route(
			'/templates/(?P<id>\d+)',
			WP_REST_Server::READABLE,
			array( $this, 'get_template' ),
			Permissions::can_read(),
			array(
				'id' => array(
					'type'              => 'integer',
					'required'          => true,
					'sanitize_callback' => 'absint',
				),
			)
		);

		// POST /templates — save reusable block/page. CAP_EDIT_POST (create => edit_posts).
		$this->route(
			'/templates',
			WP_REST_Server::CREATABLE,
			array( $this, 'save_template' ),
			Permissions::can_edit_post(),
			array(
				'title'         => array(
					'type'              => 'string',
					'required'          => false,
					'sanitize_callback' => 'sanitize_text_field',
				),
				'type'          => array(
					'type'     => 'string',
					'required' => true,
				),
				'content'       => array(
					'type'     => 'array',
					'required' => true,
				),
				'page_settings' => array(
					'type'     => 'object',
					'required' => false,
				),
				'op_id'         => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);

		// POST /templates/import — import .json/.zip (file) OR inline content (JSON). CAP_MANAGE.
		$this->route(
			'/templates/import',
			WP_REST_Server::CREATABLE,
			array( $this, 'import_template' ),
			Permissions::can_manage(),
			array(
				'file_path'   => array(
					'type'     => 'string',
					'required' => false,
				),
				'content'     => array(
					'type'     => array( 'array', 'object' ),
					'required' => false,
				),
				'import_mode' => array(
					'type'     => 'string',
					'required' => false,
					'default'  => self::IMPORT_MODE_MATCH_SITE,
				),
				'title'       => array(
					'type'              => 'string',
					'required'          => false,
					'sanitize_callback' => 'sanitize_text_field',
				),
				'type'        => array(
					'type'     => 'string',
					'required' => false,
				),
				'op_id'       => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);

		// POST /templates/{id}/insert — paste a block into a page with FRESH ids. CAP_EDIT_POST.
		$this->route(
			'/templates/(?P<id>\d+)/insert',
			WP_REST_Server::CREATABLE,
			array( $this, 'insert_template' ),
			Permissions::can_edit_post(),
			array(
				'id'        => array(
					'type'              => 'integer',
					'required'          => true,
					'sanitize_callback' => 'absint',
				),
				'post_id'   => array(
					'type'              => 'integer',
					'required'          => true,
					'sanitize_callback' => 'absint',
				),
				'content'   => array(
					'type'     => array( 'array', 'object' ),
					'required' => false,
				),
				'parent_id' => array(
					'type'     => 'string',
					'required' => false,
				),
				'index'     => array(
					'type'     => 'integer',
					'required' => false,
				),
				'base_hash' => array(
					'type'     => 'string',
					'required' => false,
				),
				'force'     => array(
					'type'     => 'boolean',
					'required' => false,
					'default'  => false,
				),
				'op_id'     => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);

		// POST /kit/export — full-site kit zip. CAP_MANAGE.
		$this->route(
			'/kit/export',
			WP_REST_Server::CREATABLE,
			array( $this, 'kit_export' ),
			Permissions::can_manage(),
			array(
				'include'       => array(
					'type'     => array( 'array', 'string' ),
					'required' => false,
				),
				'kitInfo'       => array(
					'type'     => 'object',
					'required' => false,
				),
				'customization' => array(
					'type'     => 'object',
					'required' => false,
				),
				'op_id'         => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);

		// GET /kit/download/{token} — authenticated one-time kit-zip download. CAP_MANAGE.
		$this->route(
			'/kit/download/(?P<token>[A-Za-z0-9]+)',
			WP_REST_Server::READABLE,
			array( $this, 'kit_download' ),
			Permissions::can_manage(),
			array(
				'token' => array(
					'type'     => 'string',
					'required' => true,
				),
			)
		);

		// POST /kit/import — upload + import kit. CAP_MANAGE.
		$this->route(
			'/kit/import',
			WP_REST_Server::CREATABLE,
			array( $this, 'kit_import' ),
			Permissions::can_manage(),
			array(
				'session'       => array(
					'type'     => 'string',
					'required' => false,
				),
				'file_path'     => array(
					'type'     => 'string',
					'required' => false,
				),
				'include'       => array(
					'type'     => array( 'array', 'string' ),
					'required' => false,
				),
				'customization' => array(
					'type'     => 'object',
					'required' => false,
				),
				'op_id'         => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);

		// POST /kit/revert — revert the supplied kit-import session (must be the current last;
		// `required` enforced in the handler so the failure is a taxonomy 400, not a WP arg error). CAP_MANAGE.
		$this->route(
			'/kit/revert',
			WP_REST_Server::CREATABLE,
			array( $this, 'kit_revert' ),
			Permissions::can_manage(),
			array(
				'session' => array(
					'type'     => 'string',
					'required' => false,
				),
				'op_id'   => array(
					'type'     => 'string',
					'required' => false,
				),
			)
		);
	}

	// -----------------------------------------------------------------------
	// §7 — GET /templates (list)
	// -----------------------------------------------------------------------

	/**
	 * `GET /templates` — list library templates (10-rest-api.md §7, paginated §0.11). Reads via
	 * `Templates_Manager` (local source) so the same listing the editor sees is returned; optional
	 * `type` filter; offset pagination. CAP_READ.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function list_templates( WP_REST_Request $request ) {
		$manager = $this->templates_manager();
		if ( null === $manager ) {
			// Library unavailable: introspectable empty page rather than a 500.
			return $this->ok(
				array(
					'items'       => array(),
					'next_cursor' => null,
					'total'       => 0,
				)
			);
		}

		$type_filter = $request->get_param( 'type' );
		$type_filter = $this->normalize_type_filter( $type_filter );

		$templates = $manager->get_templates( array( self::SOURCE_LOCAL ) );
		if ( ! is_array( $templates ) ) {
			$templates = array();
		}

		$items = array();
		foreach ( $templates as $tpl ) {
			if ( ! is_array( $tpl ) ) {
				continue;
			}
			$type = isset( $tpl['type'] ) ? (string) $tpl['type'] : '';
			if ( ! empty( $type_filter ) && ! in_array( $type, $type_filter, true ) ) {
				continue;
			}
			$items[] = array(
				'template_id' => isset( $tpl['template_id'] ) ? (int) $tpl['template_id'] : 0,
				'title'       => isset( $tpl['title'] ) ? (string) $tpl['title'] : '',
				'type'        => $type,
			);
		}

		$paged = $this->paginate( $items, $request, count( $items ) );

		return $this->ok( $paged );
	}

	// -----------------------------------------------------------------------
	// §7 — GET /templates/{id}
	// -----------------------------------------------------------------------

	/**
	 * `GET /templates/{id}` — template content + page_settings (10-rest-api.md §7). Reads via the local
	 * source `get_data` (which re-IDs read content + attaches the global_classes snapshot) so the
	 * payload is insert-ready. Missing id → 404 NOT_FOUND. CAP_READ.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function get_template( WP_REST_Request $request ) {
		$template_id = (int) $request->get_param( 'id' );

		$post = get_post( $template_id );
		if ( ! $post || self::TEMPLATE_CPT !== $post->post_type ) {
			return $this->not_found( sprintf( 'Template %d not found.', $template_id ) );
		}

		$manager = $this->templates_manager();
		if ( null === $manager ) {
			return $this->internal( __( 'The Elementor template library is unavailable.', 'elementor-ultra-mcp' ) );
		}

		$data = $manager->get_template_data(
			array(
				'source'             => self::SOURCE_LOCAL,
				'template_id'        => $template_id,
				'with_page_settings' => true,
			)
		);

		if ( is_wp_error( $data ) ) {
			return $this->not_found( $data->get_error_message() );
		}

		$content       = ( is_array( $data ) && isset( $data['content'] ) && is_array( $data['content'] ) ) ? $data['content'] : array();
		$page_settings = ( is_array( $data ) && isset( $data['page_settings'] ) && is_array( $data['page_settings'] ) ) ? $data['page_settings'] : array();

		return $this->ok(
			array(
				'template_id'   => $template_id,
				'title'         => $post->post_title,
				'type'          => (string) get_post_meta( $template_id, self::TYPE_META_KEY, true ),
				'content'       => $content,
				'page_settings' => $page_settings,
			)
		);
	}

	// -----------------------------------------------------------------------
	// §7 — POST /templates (save)
	// -----------------------------------------------------------------------

	/**
	 * `POST /templates` — save a reusable block/page (10-rest-api.md §7, validate-before-save §0.9).
	 *
	 * [S02] Validates `content` via the AUTHORITATIVE validator FIRST (422 ATOMIC_* on failure; nothing
	 * is written). Then saves through `Source_Local::save_item` which re-IDs elements + dependent
	 * local-style ids and registers global-class relations (same pipeline as an editor save). [S02]
	 * does NOT merge global classes and does NOT sideload images — image src is kept as-is on save.
	 * [R5] local-style ids are regenerated on save; callers must re-read. CAP_EDIT_POST.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function save_template( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$type    = (string) $request->get_param( 'type' );
		$content = $request->get_param( 'content' );
		$title   = $request->get_param( 'title' );
		$title   = ( is_string( $title ) && '' !== $title ) ? $title : __( 'Untitled', 'elementor-ultra-mcp' );

		$page_settings = $request->get_param( 'page_settings' );
		$page_settings = is_array( $page_settings ) ? $page_settings : array();

		if ( '' === $type ) {
			return $this->bad_request( __( 'A non-empty template `type` is required.', 'elementor-ultra-mcp' ), array( 'path' => 'type' ), $op_id );
		}
		if ( ! is_array( $content ) ) {
			return $this->bad_request( __( 'A `content` array (the element tree) is required.', 'elementor-ultra-mcp' ), array( 'path' => 'content' ), $op_id );
		}

		// (§0.9) AUTHORITATIVE validation BEFORE save — write NOTHING on failure.
		$verdict = Validator::validate_only( $content, $page_settings );
		if ( empty( $verdict['valid'] ) ) {
			$errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
			return $this->validation_failed( $errors, $op_id );
		}

		$source = $this->local_source();
		if ( null === $source ) {
			return $this->internal( __( 'The Elementor local template source is unavailable.', 'elementor-ultra-mcp' ) );
		}

		// [S02] save_item re-IDs + persists + registers relations (it may throw on a bad atomic envelope
		// despite our pre-validate — surface that as a structured ATOMIC_* error, never a 500 string).
		try {
			$template_id = $source->save_item(
				array(
					'title'         => $title,
					'type'          => $type,
					'content'       => $content,
					'page_settings' => $page_settings,
				)
			);
		} catch ( \Throwable $e ) {
			return $this->import_remap_failed( $e->getMessage(), array( 'phase' => 'save' ), $op_id );
		}

		if ( is_wp_error( $template_id ) ) {
			return $this->import_remap_failed( $template_id->get_error_message(), array( 'phase' => 'save' ), $op_id );
		}

		$template_id = (int) $template_id;
		$saved_type  = (string) get_post_meta( $template_id, self::TYPE_META_KEY, true );
		$saved_type  = '' !== $saved_type ? $saved_type : $type;

		$this->log_op(
			$op_id,
			'templates/save',
			array(
				'post_id' => $template_id,
				'result'  => 'ok',
			)
		);

		return $this->ok(
			array(
				'template_id' => $template_id,
				'type'        => $saved_type,
			)
		);
	}

	// -----------------------------------------------------------------------
	// §7 — POST /templates/import
	// -----------------------------------------------------------------------

	/**
	 * `POST /templates/import` — import a .json/.zip FILE or inline JSON `content` into the library
	 * (10-rest-api.md §7).
	 *
	 * [S02] FILE import is delegated to `Templates_Manager::import_template()` /
	 * `Source_Local::import_template()` which chains `prepare_import_template_data` →
	 * `process_export_import_content('on_import')` (image SIDELOAD + element remap) → the
	 * `import/process_content` merge filter (global classes/variables merged by `import_mode`). This is
	 * the ONLY path that sideloads images, so we never reimplement sideload here.
	 *
	 * INLINE content (no file): save it to the library via `save_item` (re-IDs + registers relations).
	 * Image src is kept as-is (sideload is a file-import concern, [S02]); a merge/remap failure → 422
	 * IMPORT_REMAP_FAILED (12 §3.5). CAP_MANAGE.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function import_template( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$file_path   = $request->get_param( 'file_path' );
		$content     = $request->get_param( 'content' );
		$import_mode = $request->get_param( 'import_mode' );
		$import_mode = ( is_string( $import_mode ) && '' !== $import_mode ) ? $import_mode : self::IMPORT_MODE_MATCH_SITE;

		$has_file    = is_string( $file_path ) && '' !== trim( $file_path );
		$has_content = is_array( $content ) && ! empty( $content );

		if ( ! $has_file && ! $has_content ) {
			return $this->bad_request(
				__( 'Provide either a `file_path` (.json/.zip) or inline `content` to import.', 'elementor-ultra-mcp' ),
				array( 'path' => 'file_path' ),
				$op_id
			);
		}

		// -------- FILE import: reuse Elementor's on_import (sideload) + merge filter. --------
		if ( $has_file ) {
			return $this->import_from_file( trim( (string) $file_path ), $import_mode, $op_id );
		}

		// -------- INLINE JSON content: save to the library (re-IDs + relations). --------
		$type  = $request->get_param( 'type' );
		$type  = ( is_string( $type ) && '' !== $type ) ? $type : 'container';
		$title = $request->get_param( 'title' );
		$title = ( is_string( $title ) && '' !== $title ) ? $title : __( 'Imported template', 'elementor-ultra-mcp' );

		// The `content` may be a library-format envelope ({content, page_settings, type, ...}) or a bare
		// element tree. Normalize to an element tree + page_settings.
		$elements      = $content;
		$page_settings = array();
		if ( isset( $content['content'] ) && is_array( $content['content'] ) ) {
			$elements      = $content['content'];
			$page_settings = isset( $content['page_settings'] ) && is_array( $content['page_settings'] ) ? $content['page_settings'] : array();
			if ( isset( $content['type'] ) && is_string( $content['type'] ) && '' !== $content['type'] ) {
				$type = $content['type'];
			}
		}

		if ( ! is_array( $elements ) || empty( $elements ) ) {
			return $this->bad_request(
				__( 'Inline `content` did not contain an element tree.', 'elementor-ultra-mcp' ),
				array( 'path' => 'content' ),
				$op_id
			);
		}

		// (§0.9) validate the candidate tree before any write.
		$verdict = Validator::validate_only( $elements, $page_settings );
		if ( empty( $verdict['valid'] ) ) {
			$errors = isset( $verdict['errors'] ) && is_array( $verdict['errors'] ) ? $verdict['errors'] : array();
			return $this->validation_failed( $errors, $op_id );
		}

		$source = $this->local_source();
		if ( null === $source ) {
			return $this->internal( __( 'The Elementor local template source is unavailable.', 'elementor-ultra-mcp' ) );
		}

		try {
			$template_id = $source->save_item(
				array(
					'title'         => $title,
					'type'          => $type,
					'content'       => $elements,
					'page_settings' => $page_settings,
				)
			);
		} catch ( \Throwable $e ) {
			return $this->import_remap_failed( $e->getMessage(), array( 'phase' => 'import_inline' ), $op_id );
		}

		if ( is_wp_error( $template_id ) ) {
			return $this->import_remap_failed( $template_id->get_error_message(), array( 'phase' => 'import_inline' ), $op_id );
		}

		$template_id = (int) $template_id;

		$this->log_op(
			$op_id,
			'templates/import',
			array(
				'post_id' => $template_id,
				'result'  => 'ok',
			)
		);

		return $this->ok(
			array(
				'imported_ids' => array( $template_id ),
				'warnings'     => array(),
			)
		);
	}

	/**
	 * Import a .json/.zip FILE via Elementor's own importer ([S02] — chains `on_import` image sideload +
	 * the merge filter). Returns the §7 `{imported_ids,warnings}` envelope or an IMPORT_REMAP_FAILED.
	 *
	 * @param string      $file_path   Absolute server path to the .json/.zip file.
	 * @param string      $import_mode `match_site`|`keep_create`.
	 * @param string|null $op_id       Echoed op_id.
	 * @return WP_REST_Response|WP_Error
	 */
	private function import_from_file( string $file_path, string $import_mode, ?string $op_id ) {
		if ( ! file_exists( $file_path ) || ! is_readable( $file_path ) ) {
			return $this->not_found( sprintf( 'Import file not found or unreadable: %s', $file_path ), $op_id );
		}

		$source = $this->local_source();
		if ( null === $source ) {
			return $this->internal( __( 'The Elementor local template source is unavailable.', 'elementor-ultra-mcp' ) );
		}

		// `Source_Local::import_template($name, $path, $import_mode)` runs prepare_import_template_data
		// (on_import sideload + element remap) then the import/process_content merge filter.
		try {
			$result = $source->import_template( wp_basename( $file_path ), $file_path, $import_mode );
		} catch ( \Throwable $e ) {
			return $this->import_remap_failed( $e->getMessage(), array( 'phase' => 'import_file' ), $op_id );
		}

		if ( is_wp_error( $result ) ) {
			return $this->import_remap_failed( $result->get_error_message(), array( 'phase' => 'import_file' ), $op_id );
		}

		// `import_template` returns an array of imported template descriptors.
		$imported_ids = array();
		$warnings     = array();
		if ( is_array( $result ) ) {
			foreach ( $result as $item ) {
				if ( is_array( $item ) && isset( $item['template_id'] ) ) {
					$imported_ids[] = (int) $item['template_id'];
				} elseif ( is_numeric( $item ) ) {
					$imported_ids[] = (int) $item;
				}
			}
		}

		if ( empty( $imported_ids ) ) {
			return $this->import_remap_failed(
				__( 'The import produced no templates (the file may be empty or malformed).', 'elementor-ultra-mcp' ),
				array( 'phase' => 'import_file' ),
				$op_id
			);
		}

		$this->log_op(
			$op_id,
			'templates/import',
			array(
				'result' => 'ok',
				'meta'   => array( 'imported_ids' => $imported_ids ),
			)
		);

		return $this->ok(
			array(
				'imported_ids' => $imported_ids,
				'warnings'     => $warnings,
			)
		);
	}

	// -----------------------------------------------------------------------
	// §7 — POST /templates/{id}/insert
	// -----------------------------------------------------------------------

	/**
	 * `POST /templates/{id}/insert` — paste a template/block into a page with FRESH ids
	 * (10-rest-api.md §7; 11-authoring-contract.md §8.1; spike S02 two-step insert).
	 *
	 * Flow (the editor's TWO-step path, [S02]):
	 *  1. Resolve the block content + `global_classes` snapshot: for a template id via the local source
	 *     `get_data` (re-IDs + attaches the snapshot); for inline `content`, use it as-is (no snapshot).
	 *  2. `Templates_Manager::process_global_styles({content, global_classes, import_mode=match_site})`
	 *     merges the referenced global classes INTO the target kit (reuse-by-label) and rewrites the
	 *     content's class refs via the returned id_map. A merge failure / flatten is surfaced.
	 *  3. `Id_Service::dedupe_for_insert` regenerates ALL element ids (+ local-style backrefs) against
	 *     the TARGET document's used-id set (§8.1 — zero cross-document collision).
	 *  4. Splice the fresh content into the target tree at `parent_id`/`index`.
	 *  5. Persist via `Document_Writer::save` (single transactional save: lock/base_hash/backup/validate/
	 *     save/prime). When the inserted content is atomic, CSS is primed (`css_primed`, S1).
	 *
	 * Returns `{success, inserted_ids, base_hash, css_primed}`. CAP_EDIT_POST.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function insert_template( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$template_id = (int) $request->get_param( 'id' );
		$post_id     = (int) $request->get_param( 'post_id' );
		$parent_id   = $request->get_param( 'parent_id' );
		$parent_id   = ( is_string( $parent_id ) && '' !== $parent_id ) ? $parent_id : null;
		$index       = $request->get_param( 'index' );
		$index       = ( null === $index || '' === $index ) ? null : (int) $index;
		$base_hash   = $request->get_param( 'base_hash' );
		$base_hash   = ( is_string( $base_hash ) && '' !== $base_hash ) ? $base_hash : null;
		$force       = (bool) $request->get_param( 'force' );
		$inline      = $request->get_param( 'content' );

		if ( $post_id <= 0 ) {
			return $this->bad_request( __( 'A target `post_id` is required.', 'elementor-ultra-mcp' ), array( 'path' => 'post_id' ), $op_id );
		}

		// The target document MUST exist + be Elementor-built (resolves NOT_FOUND too).
		$target_tree = $this->read_document_tree( $post_id );
		if ( null === $target_tree ) {
			return $this->not_found( sprintf( 'Target document %d not found or not Elementor-built.', $post_id ), $op_id );
		}

		// (1) Resolve the source content + the global_classes snapshot.
		$content        = null;
		$global_classes = null;
		if ( is_array( $inline ) && ! empty( $inline ) ) {
			// Inline content: support a library envelope or a bare element tree.
			if ( isset( $inline['content'] ) && is_array( $inline['content'] ) ) {
				$content        = $inline['content'];
				$global_classes = ( isset( $inline['global_classes'] ) && is_array( $inline['global_classes'] ) ) ? $inline['global_classes'] : null;
			} else {
				$content = $inline;
			}
		} else {
			// Template id: get_data re-IDs content + attaches the global_classes snapshot ([S02]).
			$manager = $this->templates_manager();
			if ( null === $manager ) {
				return $this->internal( __( 'The Elementor template library is unavailable.', 'elementor-ultra-mcp' ) );
			}
			$data = $manager->get_template_data(
				array(
					'source'      => self::SOURCE_LOCAL,
					'template_id' => $template_id,
				)
			);
			if ( is_wp_error( $data ) ) {
				return $this->not_found( $data->get_error_message(), $op_id );
			}
			$content        = ( is_array( $data ) && isset( $data['content'] ) && is_array( $data['content'] ) ) ? $data['content'] : null;
			$global_classes = ( is_array( $data ) && isset( $data['global_classes'] ) && is_array( $data['global_classes'] ) ) ? $data['global_classes'] : null;
		}

		if ( ! is_array( $content ) || empty( $content ) ) {
			return $this->not_found( sprintf( 'Template %d has no insertable content.', $template_id ), $op_id );
		}

		// (2) Merge referenced global classes INTO the target kit + rewrite content refs ([S02]).
		$processed = $this->process_global_styles( $content, $global_classes, self::IMPORT_MODE_MATCH_SITE );
		if ( $processed instanceof WP_Error ) {
			return $processed;
		}
		$content        = $processed['content'];
		$merge_warnings = $processed['warnings'];

		// (3) FRESH ids (replace ALL ids + local-style backrefs) vs the TARGET's used-id set (§8.1).
		$used         = Id_Service::used_ids( $post_id );
		$existing     = isset( $used['ids'] ) && is_array( $used['ids'] ) ? $used['ids'] : array();
		$deduped      = Id_Service::dedupe_for_insert( $content, $existing );
		$fresh        = $deduped['elements'];
		$inserted_ids = $this->top_level_ids( $fresh );

		// (4) Splice into the target tree at parent_id / index.
		$spliced = $this->splice_into_tree( $target_tree, $fresh, $parent_id, $index );
		if ( $spliced instanceof WP_Error ) {
			return $spliced;
		}

		// (5) Transactional save (validate→backup→save→prime) via the writer.
		$result = Document_Writer::save(
			$post_id,
			array(
				'elements'  => $spliced,
				'base_hash' => $base_hash,
				'op_id'     => $op_id,
				'force'     => $force,
				'backup'    => true,
				'prime_css' => true,
			)
		);

		if ( is_wp_error( $result ) ) {
			return $result;
		}

		$this->log_op(
			$op_id,
			'templates/insert',
			array(
				'post_id' => $post_id,
				'result'  => 'ok',
				'meta'    => array(
					'template_id'  => $template_id,
					'inserted_ids' => $inserted_ids,
				),
			)
		);

		return $this->ok(
			array(
				'success'      => true,
				'inserted_ids' => $inserted_ids,
				'base_hash'    => $result['base_hash'],
				'css_primed'   => ! empty( $result['css_primed'] ),
				'warnings'     => $merge_warnings,
			)
		);
	}

	/**
	 * Replicate the editor's `process_global_styles` step ([S02], manager.php:693): merge the referenced
	 * global classes into the target kit (reuse-by-label under `match_site`) and rewrite the content's
	 * class refs via the returned id_map. Returns `{content, warnings}` or an IMPORT_REMAP_FAILED.
	 *
	 * When no snapshot is present the content is returned as-is (no global-class refs to merge); a
	 * `flattened_classes_count` > 0 is surfaced as a warning (MAX_ITEMS overflow → silent flatten, [S02]).
	 *
	 * @param array<int,array<string,mixed>> $content        The block content (element tree).
	 * @param array<string,mixed>|null       $global_classes The `{items,order}` snapshot from get_data.
	 * @param string                         $import_mode    `match_site`|`keep_create`.
	 * @return array{content:array<int,array<string,mixed>>,warnings:string[]}|WP_Error
	 */
	private function process_global_styles( array $content, ?array $global_classes, string $import_mode ) {
		$manager = $this->templates_manager();

		// No snapshot AND no manager → nothing to merge; pass content through unchanged.
		if ( null === $manager || ! method_exists( $manager, 'process_global_styles' ) ) {
			return array(
				'content'  => $content,
				'warnings' => array(),
			);
		}

		$args = array(
			'content'     => $content,
			'import_mode' => $import_mode,
		);
		if ( is_array( $global_classes ) && ! empty( $global_classes ) ) {
			$args['global_classes'] = $global_classes;
		}

		try {
			$result = $manager->process_global_styles( $args );
		} catch ( \Throwable $e ) {
			return $this->import_remap_failed( $e->getMessage(), array( 'phase' => 'process_global_styles' ) );
		}

		if ( is_wp_error( $result ) ) {
			return $this->import_remap_failed( $result->get_error_message(), array( 'phase' => 'process_global_styles' ) );
		}

		$out_content = ( is_array( $result ) && isset( $result['content'] ) && is_array( $result['content'] ) ) ? $result['content'] : $content;

		$warnings = array();
		if ( is_array( $result ) && ! empty( $result['flattened_classes_count'] ) ) {
			$warnings[] = sprintf(
				/* translators: %d: number of global classes flattened to local styles. */
				__( '%d global class(es) exceeded the kit limit and were flattened to local styles (relation lost).', 'elementor-ultra-mcp' ),
				(int) $result['flattened_classes_count']
			);
		}
		if ( is_array( $result ) && ! empty( $result['flattened_variables_count'] ) ) {
			$warnings[] = sprintf(
				/* translators: %d: number of variables flattened. */
				__( '%d variable(s) exceeded the kit limit and were flattened.', 'elementor-ultra-mcp' ),
				(int) $result['flattened_variables_count']
			);
		}

		return array(
			'content'  => $out_content,
			'warnings' => $warnings,
		);
	}

	// -----------------------------------------------------------------------
	// §7 — KIT export / import / revert
	// -----------------------------------------------------------------------

	/**
	 * `POST /kit/export` — build a full-site kit zip (10-rest-api.md §7). Thin wrapper over the
	 * import-export module's `export_kit()`. The produced server-side zip is registered under a one-time
	 * authenticated download token (no public exposure); the caller GETs `kit/download/{token}`.
	 * Returns `{download_url,session}`. CAP_MANAGE.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function kit_export( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$module = $this->import_export_module();
		if ( null === $module || ! method_exists( $module, 'export_kit' ) ) {
			return $this->internal( __( 'The Elementor import/export module is unavailable.', 'elementor-ultra-mcp' ) );
		}

		$include  = $this->normalize_include( $request->get_param( 'include' ) );
		$kit_info = $request->get_param( 'kitInfo' );
		$kit_info = is_array( $kit_info ) ? $kit_info : array();

		$settings = array(
			'include'  => $include,
			'kit_info' => $kit_info,
		);

		$customization = $request->get_param( 'customization' );
		if ( is_array( $customization ) && ! empty( $customization ) ) {
			$settings['customization'] = $customization;
		}

		try {
			$result = $module->export_kit( $settings );
		} catch ( \Throwable $e ) {
			return $this->internal( sprintf( 'Kit export failed: %s', $e->getMessage() ), $op_id );
		}

		$file_name = is_array( $result ) && isset( $result['file_name'] ) ? (string) $result['file_name'] : '';
		if ( '' === $file_name || ! file_exists( $file_name ) ) {
			return $this->internal( __( 'Kit export produced no file.', 'elementor-ultra-mcp' ), $op_id );
		}

		// Register a one-time authenticated download token (path stored server-side, not exposed).
		$token   = $this->register_download_token( $file_name );
		$session = $token;

		$download_url = rest_url( $this->namespace() . '/kit/download/' . $token );

		$this->log_op(
			$op_id,
			'kit/export',
			array(
				'result' => 'ok',
				'meta'   => array(
					'session' => $session,
					'include' => $include,
				),
			)
		);

		return $this->ok(
			array(
				'download_url' => $download_url,
				'session'      => $session,
			)
		);
	}

	/**
	 * `GET /kit/download/{token}` — stream the one-time kit zip registered by `kit/export`. The token is
	 * consumed (single-use). CAP_MANAGE.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function kit_download( WP_REST_Request $request ) {
		$token = (string) $request->get_param( 'token' );
		$path  = $this->consume_download_token( $token );

		if ( null === $path || ! file_exists( $path ) || ! is_readable( $path ) ) {
			return $this->not_found( __( 'The download token is invalid, expired, or already used.', 'elementor-ultra-mcp' ) );
		}

		// Stream the file directly. We bypass the JSON envelope for a binary download.
		$size = (int) filesize( $path );
		header( 'Content-Type: application/zip' );
		header( 'Content-Disposition: attachment; filename="' . wp_basename( $path ) . '"' );
		header( 'Content-Length: ' . $size );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_readfile -- streaming a server-generated kit zip to the authenticated caller.
		readfile( $path );
		exit;
	}

	/**
	 * `POST /kit/import` — upload + import a kit zip (10-rest-api.md §7). Thin wrapper over
	 * `import_kit($path,$settings)`. Returns `{session,imported,warnings}`. CAP_MANAGE.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function kit_import( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$module = $this->import_export_module();
		if ( null === $module || ! method_exists( $module, 'import_kit' ) ) {
			return $this->internal( __( 'The Elementor import/export module is unavailable.', 'elementor-ultra-mcp' ) );
		}

		$file_path = $request->get_param( 'file_path' );
		$file_path = is_string( $file_path ) ? trim( $file_path ) : '';

		if ( '' === $file_path || ! file_exists( $file_path ) || ! is_readable( $file_path ) ) {
			return $this->bad_request(
				__( 'A readable `file_path` to a kit .zip is required.', 'elementor-ultra-mcp' ),
				array( 'path' => 'file_path' ),
				$op_id
			);
		}

		$include  = $this->normalize_include( $request->get_param( 'include' ) );
		$settings = array();
		if ( ! empty( $include ) ) {
			$settings['include'] = $include;
		}
		$customization = $request->get_param( 'customization' );
		if ( is_array( $customization ) && ! empty( $customization ) ) {
			$settings['customization'] = $customization;
		}

		try {
			$imported = $module->import_kit( $file_path, $settings );
		} catch ( \Throwable $e ) {
			return $this->import_remap_failed( sprintf( 'Kit import failed: %s', $e->getMessage() ), array( 'phase' => 'kit_import' ), $op_id );
		}

		// The active import session id is the revert handle.
		$session = $this->current_import_session_id();

		$this->log_op(
			$op_id,
			'kit/import',
			array(
				'result' => 'ok',
				'meta'   => array( 'session' => $session ),
			)
		);

		return $this->ok(
			array(
				'session'  => $session,
				'imported' => is_array( $imported ) ? $imported : array(),
				'warnings' => array(),
			)
		);
	}

	/**
	 * `POST /kit/revert` — revert the supplied kit-import session (10-rest-api.md §7). Upstream only
	 * supports reverting the LAST imported session (`revert_last_imported_kit()` takes no session,
	 * app/modules/import-export/module.php:438), so the supplied `session` is REQUIRED and verified
	 * against the current last session id BEFORE reverting — a mismatch is a 409 (the session the agent
	 * confirmed is no longer the revert target; a newer import landed in between). Returns
	 * `{reverted, session}` with the session that was actually reverted. CAP_MANAGE.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function kit_revert( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$session = $request->get_param( 'session' );
		$session = is_string( $session ) ? trim( $session ) : '';
		if ( '' === $session ) {
			return $this->bad_request(
				__( 'A `session` id (returned by kit import) is required so the revert targets the confirmed session.', 'elementor-ultra-mcp' ),
				array( 'path' => 'session' ),
				$op_id
			);
		}

		$module = $this->import_export_module();
		if ( null === $module || ! method_exists( $module, 'revert_last_imported_kit' ) ) {
			return $this->internal( __( 'The Elementor import/export module is unavailable.', 'elementor-ultra-mcp' ) );
		}

		$current = $this->current_import_session_id();
		if ( '' === $current ) {
			return $this->not_found(
				__( 'There is no kit-import session to revert.', 'elementor-ultra-mcp' ),
				$op_id
			);
		}
		if ( $session !== $current ) {
			// Upstream can only revert the LAST session; reverting here would destroy a DIFFERENT,
			// newer import than the one the caller confirmed. Surface a stale-target 409 instead.
			return $this->fail(
				Error_Codes::CONCURRENCY_STALE_HASH,
				sprintf(
					/* translators: 1: requested session id, 2: current last session id. */
					__( 'Session "%1$s" is not the last imported kit session (current last: "%2$s"); only the last session can be reverted. Re-check the import sessions and retry with the current session id.', 'elementor-ultra-mcp' ),
					$session,
					$current
				),
				409,
				array(
					'session'         => $session,
					'current_session' => $current,
				),
				array(),
				$op_id
			);
		}

		try {
			$module->revert_last_imported_kit();
		} catch ( \Throwable $e ) {
			return $this->internal( sprintf( 'Kit revert failed: %s', $e->getMessage() ), $op_id );
		}

		$this->log_op(
			$op_id,
			'kit/revert',
			array(
				'result' => 'ok',
				'meta'   => array( 'session' => $session ),
			)
		);

		return $this->ok(
			array(
				'reverted' => true,
				'session'  => $session,
			)
		);
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/**
	 * The Elementor templates manager, or null when Elementor is not loaded.
	 *
	 * @return \Elementor\TemplateLibrary\Manager|null
	 */
	private function templates_manager() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::instance();
		if ( ! isset( $plugin->templates_manager ) || null === $plugin->templates_manager ) {
			return null;
		}
		return $plugin->templates_manager;
	}

	/**
	 * The local template source (`Source_Local`), or null.
	 *
	 * @return \Elementor\TemplateLibrary\Source_Local|null
	 */
	private function local_source() {
		$manager = $this->templates_manager();
		if ( null === $manager || ! method_exists( $manager, 'get_source' ) ) {
			return null;
		}
		$source = $manager->get_source( self::SOURCE_LOCAL );
		return ( false === $source || null === $source ) ? null : $source;
	}

	/**
	 * The Elementor import-export module. Preferred: `Plugin::$instance->app->get_component('import-export')`.
	 *
	 * The App registers that component in its constructor gated on `current_user_can('manage_options')`
	 * evaluated AT CONSTRUCTION TIME — in a REST request the App may be constructed before the user is
	 * resolved, so the component can be absent even for an admin (our route already gates on CAP_MANAGE).
	 * We therefore fall back to a fresh `\Elementor\App\Modules\ImportExport\Module` instance, which is a
	 * stateless wrapper over the Export/Import/Revert processes — the same object the App would register.
	 *
	 * @return object|null
	 */
	private function import_export_module() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::instance();
		if ( isset( $plugin->app ) && null !== $plugin->app && method_exists( $plugin->app, 'get_component' ) ) {
			$module = $plugin->app->get_component( 'import-export' );
			if ( is_object( $module ) ) {
				return $module;
			}
		}

		// Fallback: instantiate the module directly (the route is already CAP_MANAGE-gated).
		$module_class = '\Elementor\App\Modules\ImportExport\Module';
		if ( class_exists( $module_class ) ) {
			return new $module_class();
		}

		return null;
	}

	/**
	 * Read the target document's `_elementor_data` tree, or null when the post is missing / not built.
	 *
	 * @param int $post_id The target document.
	 * @return array<int,array<string,mixed>>|null
	 */
	private function read_document_tree( int $post_id ): ?array {
		if ( $post_id <= 0 ) {
			return null;
		}
		$post = get_post( $post_id );
		if ( ! $post ) {
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
		// An Elementor-built post with an empty tree is still a valid insert target.
		if ( 'builder' === get_post_meta( $post_id, '_elementor_edit_mode', true ) ) {
			return array();
		}
		return null;
	}

	/**
	 * Splice `$nodes` into `$tree` at `$parent_id` (null = root) and `$index` (null = append). Returns
	 * the new tree, or a 404 NOT_FOUND WP_Error when `$parent_id` is not found in the tree.
	 *
	 * @param array<int,array<string,mixed>> $tree      The target document tree.
	 * @param array<int,array<string,mixed>> $nodes     The fresh-id nodes to insert.
	 * @param string|null                    $parent_id Parent element id, or null for the root level.
	 * @param int|null                       $index     Insertion index, or null to append.
	 * @return array<int,array<string,mixed>>|WP_Error
	 */
	private function splice_into_tree( array $tree, array $nodes, ?string $parent_id, ?int $index ) {
		if ( null === $parent_id ) {
			return $this->splice_at( $tree, $nodes, $index );
		}

		$found = false;
		$tree  = $this->splice_into_parent( $tree, $nodes, $parent_id, $index, $found );

		if ( ! $found ) {
			return $this->not_found( sprintf( 'parent_id "%s" was not found in the target document.', $parent_id ) );
		}

		return $tree;
	}

	/**
	 * Recursive parent search: insert `$nodes` under the element whose id === `$parent_id`.
	 *
	 * @param array<int,array<string,mixed>> $nodes_in  Sibling list to scan.
	 * @param array<int,array<string,mixed>> $insert    Nodes to insert.
	 * @param string                         $parent_id Target parent id.
	 * @param int|null                       $index     Insertion index (null = append).
	 * @param bool                           $found     Set true (by-ref) when the parent is matched.
	 * @return array<int,array<string,mixed>>
	 */
	private function splice_into_parent( array $nodes_in, array $insert, string $parent_id, ?int $index, bool &$found ): array {
		$out = array();
		foreach ( $nodes_in as $node ) {
			if ( $found ) {
				$out[] = $node;
				continue;
			}
			if ( is_array( $node ) && isset( $node['id'] ) && (string) $node['id'] === $parent_id ) {
				$children         = ( isset( $node['elements'] ) && is_array( $node['elements'] ) ) ? $node['elements'] : array();
				$node['elements'] = $this->splice_at( $children, $insert, $index );
				$found            = true;
				$out[]            = $node;
				continue;
			}
			if ( is_array( $node ) && isset( $node['elements'] ) && is_array( $node['elements'] ) && ! empty( $node['elements'] ) ) {
				$node['elements'] = $this->splice_into_parent( $node['elements'], $insert, $parent_id, $index, $found );
			}
			$out[] = $node;
		}
		return $out;
	}

	/**
	 * Insert `$nodes` into `$siblings` at `$index` (null/out-of-range = append).
	 *
	 * @param array<int,array<string,mixed>> $siblings The sibling list.
	 * @param array<int,array<string,mixed>> $nodes    Nodes to insert.
	 * @param int|null                       $index    Insertion index (null = append).
	 * @return array<int,array<string,mixed>>
	 */
	private function splice_at( array $siblings, array $nodes, ?int $index ): array {
		$siblings = array_values( $siblings );
		if ( null === $index || $index < 0 || $index > count( $siblings ) ) {
			return array_merge( $siblings, array_values( $nodes ) );
		}
		array_splice( $siblings, $index, 0, array_values( $nodes ) );
		return $siblings;
	}

	/**
	 * The top-level element ids of a node list (the ids of the inserted blocks).
	 *
	 * @param array<int,array<string,mixed>> $nodes Node list.
	 * @return string[]
	 */
	private function top_level_ids( array $nodes ): array {
		$ids = array();
		foreach ( $nodes as $node ) {
			if ( is_array( $node ) && isset( $node['id'] ) && '' !== (string) $node['id'] ) {
				$ids[] = (string) $node['id'];
			}
		}
		return $ids;
	}

	/**
	 * Normalize the `type` list filter (array | comma string) to a clean string[].
	 *
	 * @param mixed $value Raw `type` param.
	 * @return string[]
	 */
	private function normalize_type_filter( $value ): array {
		if ( is_array( $value ) ) {
			$out = array();
			foreach ( $value as $v ) {
				if ( is_string( $v ) && '' !== trim( $v ) ) {
					$out[] = trim( $v );
				}
			}
			return $out;
		}
		if ( is_string( $value ) && '' !== trim( $value ) ) {
			$out = array();
			foreach ( explode( ',', $value ) as $v ) {
				$v = trim( $v );
				if ( '' !== $v ) {
					$out[] = $v;
				}
			}
			return $out;
		}
		return array();
	}

	/**
	 * Sanitize callback for the `type` filter arg (array of slugs OR a single slug/comma string).
	 *
	 * @param mixed $value Raw arg value.
	 * @return array<int,string>|string
	 */
	public function sanitize_type_filter( $value ) {
		if ( is_array( $value ) ) {
			return array_map( 'sanitize_key', array_filter( $value, 'is_string' ) );
		}
		return is_string( $value ) ? sanitize_text_field( $value ) : '';
	}

	/**
	 * Normalize the kit `include` selector (array | comma string) to the import-export module's keys.
	 * Default = all standard parts when omitted.
	 *
	 * @param mixed $value Raw `include` param.
	 * @return string[]
	 */
	private function normalize_include( $value ): array {
		$out = array();
		if ( is_array( $value ) ) {
			foreach ( $value as $v ) {
				if ( is_string( $v ) && '' !== trim( $v ) ) {
					$out[] = trim( $v );
				}
			}
		} elseif ( is_string( $value ) && '' !== trim( $value ) ) {
			foreach ( explode( ',', $value ) as $v ) {
				$v = trim( $v );
				if ( '' !== $v ) {
					$out[] = $v;
				}
			}
		}
		if ( empty( $out ) ) {
			$out = array( 'content', 'templates', 'settings' );
		}
		return $out;
	}

	/**
	 * The active import session id (revert handle) read from Elementor's import-session option, or ''.
	 *
	 * @return string
	 */
	private function current_import_session_id(): string {
		$sessions = get_option( 'elementor_import_sessions', array() );
		if ( ! is_array( $sessions ) || empty( $sessions ) ) {
			return '';
		}
		$keys = array_keys( $sessions );
		$last = end( $keys );
		return is_string( $last ) ? $last : (string) $last;
	}

	/**
	 * Register a one-time, authenticated download token for a server-side kit zip path. Stored as a
	 * transient (1 hour TTL) keyed by the token; consumed (deleted) on first download.
	 *
	 * @param string $file_path Absolute path to the kit zip.
	 * @return string The opaque token.
	 */
	private function register_download_token( string $file_path ): string {
		$token = wp_generate_password( 24, false, false );
		set_transient( self::KIT_TOKEN_OPTION_PREFIX . $token, $file_path, HOUR_IN_SECONDS );
		return $token;
	}

	/**
	 * Consume (read + delete) a kit-download token, returning the stored path or null.
	 *
	 * @param string $token The opaque token.
	 * @return string|null
	 */
	private function consume_download_token( string $token ): ?string {
		if ( '' === $token ) {
			return null;
		}
		$key  = self::KIT_TOKEN_OPTION_PREFIX . $token;
		$path = get_transient( $key );
		if ( false === $path || ! is_string( $path ) || '' === $path ) {
			return null;
		}
		delete_transient( $key );
		return $path;
	}

	/**
	 * Best-effort op-log append (10 §11). Never throws; a logging failure can NEVER fail the write.
	 *
	 * @param string|null         $op_id   The request op_id (null = skip).
	 * @param string              $route   The route/tool identifier.
	 * @param array<string,mixed> $context `{post_id?,result?,meta?}`.
	 * @return void
	 */
	private function log_op( ?string $op_id, string $route, array $context ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		try {
			Op_Log::record(
				array(
					'op_id'   => $op_id,
					'post_id' => isset( $context['post_id'] ) ? (int) $context['post_id'] : null,
					'route'   => $route,
					'result'  => isset( $context['result'] ) ? (string) $context['result'] : 'ok',
					'meta'    => isset( $context['meta'] ) ? $context['meta'] : null,
				)
			);
		} catch ( \Throwable $e ) {
			unset( $e ); // Best-effort; never surface.
		}
	}

	// ------------------------------------------------------------------------------------------------
	// Error helpers (taxonomy-coded; 12-error-taxonomy.md).
	// ------------------------------------------------------------------------------------------------

	/**
	 * 400 bad-request (wire `E_BAD_REQUEST` -> `VALIDATION_FAILED`, 400).
	 *
	 * @param string              $message Actionable message.
	 * @param array<string,mixed> $meta    Structured context.
	 * @param string|null         $op_id   Echoed op_id.
	 * @return WP_Error
	 */
	private function bad_request( string $message, array $meta = array(), ?string $op_id = null ): WP_Error {
		return $this->fail( Error_Codes::VALIDATION_FAILED, $message, 400, $meta, array(), $op_id );
	}

	/**
	 * 404 NOT_FOUND (12 §3.5).
	 *
	 * @param string      $message Message.
	 * @param string|null $op_id   Echoed op_id.
	 * @return WP_Error
	 */
	private function not_found( string $message, ?string $op_id = null ): WP_Error {
		return $this->fail( Error_Codes::NOT_FOUND, $message, 404, array(), array(), $op_id );
	}

	/**
	 * 422 ATOMIC_SETTINGS_INVALID with per-item validation errors (12 §3.1; 10 §0.9 — nothing written).
	 *
	 * @param array<int,array<string,mixed>> $errors Per-item validation errors.
	 * @param string|null                    $op_id  Echoed op_id.
	 * @return WP_Error
	 */
	private function validation_failed( array $errors, ?string $op_id = null ): WP_Error {
		return $this->fail(
			Error_Codes::ATOMIC_SETTINGS_INVALID,
			sprintf(
				/* translators: %d: number of validation errors. */
				_n( 'Template content validation failed (%d error); nothing was written.', 'Template content validation failed (%d errors); nothing was written.', count( $errors ), 'elementor-ultra-mcp' ),
				count( $errors )
			),
			422,
			array(),
			$errors,
			$op_id
		);
	}

	/**
	 * 422 IMPORT_REMAP_FAILED (12 §3.5) — bad atomic envelopes, missing snapshot, merge/relation failure.
	 *
	 * @param string              $message Message (the raw parser/merge text, never string-matched).
	 * @param array<string,mixed> $meta    Structured context (e.g. `phase`).
	 * @param string|null         $op_id   Echoed op_id.
	 * @return WP_Error
	 */
	private function import_remap_failed( string $message, array $meta = array(), ?string $op_id = null ): WP_Error {
		return $this->fail( Error_Codes::IMPORT_REMAP_FAILED, $message, 422, $meta, array(), $op_id );
	}

	/**
	 * 500 INTERNAL_ERROR.
	 *
	 * @param string      $message Message.
	 * @param string|null $op_id   Echoed op_id.
	 * @return WP_Error
	 */
	private function internal( string $message, ?string $op_id = null ): WP_Error {
		return $this->fail( Error_Codes::INTERNAL_ERROR, $message, 500, array(), array(), $op_id );
	}
}

/*
 * --------------------------------------------------------------------------
 * Self-registration with the WP-P02 registrar (Parallelization Notes).
 * --------------------------------------------------------------------------
 * The registrar fires `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar;
 * we hand it a fresh controller instance so it registers the §7 routes without ANY edit to the spine
 * `class-registrar.php` / `class-plugin.php`. Guarded so the file is safe to load standalone (php -l,
 * PHPUnit without the registrar present).
 */
if ( ! defined( 'EMCP_TEMPLATES_CONTROLLER_REGISTERED' ) ) {
	define( 'EMCP_TEMPLATES_CONTROLLER_REGISTERED', true );
	add_action(
		Registrar::REGISTER_ACTION,
		static function ( $registrar ) {
			if ( $registrar instanceof Registrar ) {
				$registrar->register_controller( new Templates_Controller() );
			}
		}
	);
}
