<?php
/**
 * WP-P10 — Media REST controller (list/search, sideload external URL with dedupe, raw/base64 upload).
 *
 * Contract authority:
 *  - 10-rest-api.md §5 (MEDIA routes): §5.1 `GET /media` (CAP_READ, list/search + `sizes`),
 *    §5.2 `POST /media/sideload` (CAP_UPLOAD, `media_handle_sideload` + source-hash dedupe),
 *    §5.3 `POST /media/upload` (CAP_UPLOAD, multipart `file` OR JSON `{data:<base64>,filename}`).
 *  - 10-rest-api.md §0.3 (CAP_UPLOAD = `upload_files`; CAP_READ = `edit_posts`), §0.11 (pagination).
 *  - 11-authoring-contract.md §3.1/§3.2 (`image-src` is id-XOR-url; emit ID-only for internal media —
 *    the converter sideloads FIRST, then references `attachment_id`). This controller NEVER writes
 *    element trees; it only manages attachments and returns the `attachment_id` the authoring
 *    `image-attachment-id` envelope consumes.
 *  - 12-error-taxonomy.md §3.1/§3.5/§4: the wire codes `E_BAD_REQUEST` (bad/unreachable URL) and
 *    `E_MEDIA_TYPE` (disallowed mime) both map 1:1 to the frozen taxonomy code `VALIDATION_FAILED`
 *    (see `packages/server/src/wp/client.ts` SLUG_TO_CODE) — emitted with the contract HTTP statuses
 *    (400 for a bad request, 422 for a disallowed mime). A missing attachment is `NOT_FOUND` (404).
 *
 * Spike notes honoured: image sideload happens only on a real file import (WP-S02) — this controller
 * performs that import explicitly via `media_handle_sideload`. No CSS prime / tree write is involved,
 * so none of the prime/flush spike traps (S01/S07) apply here.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Error_Codes;
use WP_Error;
use WP_Query;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * MEDIA controller: list/search attachments, sideload an external URL (with source-hash dedupe), and
 * upload raw bytes / base64 into the WordPress media library. Extends the WP-P02 base so it inherits
 * the `{success,data}` envelope, the taxonomy error helpers, the `op_id` parser and the §0.11
 * pagination trait.
 */
final class Media_Controller extends Abstract_Controller {

	/**
	 * Attachment meta key carrying the source-bytes hash used for sideload dedupe (10-rest-api.md §5.2,
	 * RESEARCH.md §5.5). Matches Elementor's own image-import convention so re-imports agree.
	 */
	const META_SOURCE_HASH = '_elementor_source_image_hash';

	/**
	 * Attachment meta key carrying the original source URL (diagnostics only; the hash is the dedupe key
	 * because URL query-strings churn). 10-rest-api.md §5.2 Implementation Notes.
	 */
	const META_SOURCE_URL = '_elementor_source_image_url';

	/**
	 * Register the three MEDIA routes under `elementor-ultra/v1` (10-rest-api.md §5). Each route declares
	 * its own `args` schema + capability `permission_callback` (15-engineering-standards.md §3.3).
	 *
	 * @return void
	 */
	public function register_routes(): void {
		// §5.1 GET /media — list/search attachments (CAP_READ).
		$this->route(
			'/media',
			WP_REST_Server::READABLE,
			array( $this, 'list_media' ),
			Permissions::can_read(),
			array(
				'query'  => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Free-text search across attachment title and filename.', 'elementor-ultra-mcp' ),
				),
				'mime'   => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'MIME filter, e.g. image/png.', 'elementor-ultra-mcp' ),
				),
				'limit'  => array(
					'type'        => 'integer',
					'required'    => false,
					'description' => __( 'Page size (default 25, max 100).', 'elementor-ultra-mcp' ),
				),
				'cursor' => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Opaque pagination cursor; omit for the first page.', 'elementor-ultra-mcp' ),
				),
				'fields' => array(
					'required'    => false,
					'description' => __( 'Top-level field projection.', 'elementor-ultra-mcp' ),
				),
			)
		);

		// §5.2 POST /media/sideload — import external URL into library (CAP_UPLOAD).
		$this->route(
			'/media/sideload',
			WP_REST_Server::CREATABLE,
			array( $this, 'sideload_media' ),
			Permissions::can_upload(),
			array(
				'url'   => array(
					'type'        => 'string',
					'required'    => true,
					'description' => __( 'External URL to import into the media library.', 'elementor-ultra-mcp' ),
				),
				'alt'   => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Alt text to set on the imported attachment.', 'elementor-ultra-mcp' ),
				),
				'title' => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Title to set on the imported attachment.', 'elementor-ultra-mcp' ),
				),
				'op_id' => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Optional op_id for the op-log (^[A-Za-z0-9_.-]{1,64}$).', 'elementor-ultra-mcp' ),
				),
			)
		);

		// §5.3 POST /media/upload — upload raw bytes / base64 (CAP_UPLOAD).
		$this->route(
			'/media/upload',
			WP_REST_Server::CREATABLE,
			array( $this, 'upload_media' ),
			Permissions::can_upload(),
			array(
				// Schema kept permissive: multipart sends `file` out-of-band; JSON sends `data`+`filename`.
				'data'     => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Base64-encoded file bytes (JSON body alternative to multipart).', 'elementor-ultra-mcp' ),
				),
				'filename' => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Filename for a base64 upload (required when `data` is supplied).', 'elementor-ultra-mcp' ),
				),
				'alt'      => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Alt text to set on the uploaded attachment.', 'elementor-ultra-mcp' ),
				),
				'op_id'    => array(
					'type'        => 'string',
					'required'    => false,
					'description' => __( 'Optional op_id for the op-log (^[A-Za-z0-9_.-]{1,64}$).', 'elementor-ultra-mcp' ),
				),
			)
		);
	}

	// -----------------------------------------------------------------------
	// §5.1 — GET /media (list/search)
	// -----------------------------------------------------------------------

	/**
	 * List/search attachments (10-rest-api.md §5.1). Searches title + filename via `WP_Query` `s=`,
	 * filters by `mime`, paginates with the §0.11 keyset window (offset cursor), and returns the
	 * registered image `sizes` per item so the converter / image authoring can choose a `size`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response
	 */
	public function list_media( WP_REST_Request $request ): WP_REST_Response {
		$page_args = $this->read_pagination_args( $request );

		$query = $request->get_param( 'query' );
		$mime  = $request->get_param( 'mime' );

		$args = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'posts_per_page' => $page_args['limit'],
			'offset'         => $page_args['offset'],
			'orderby'        => 'date',
			'order'          => 'DESC',
			'no_found_rows'  => false, // We want a total for the §0.11 envelope.
		);

		if ( is_string( $query ) && '' !== $query ) {
			// `WP_Query` `s=` on attachments matches post_title and the attached file (guid/filename).
			$args['s'] = $query;
		}

		if ( is_string( $mime ) && '' !== $mime ) {
			$args['post_mime_type'] = $mime;
		}

		$wp_query = new WP_Query( $args );

		$items = array();
		foreach ( $wp_query->posts as $post ) {
			$items[] = $this->attachment_summary( (int) $post->ID );
		}

		$total       = (int) $wp_query->found_posts;
		$has_more    = ( $page_args['offset'] + $page_args['limit'] ) < $total;
		$next_cursor = $has_more ? $this->encode_cursor( $page_args['offset'] + $page_args['limit'] ) : null;

		// Keyset mode: the query already returned exactly this page; the trait only applies `fields`.
		$data = $this->paginate( $items, $request, $total, true, $next_cursor );

		return $this->ok( $data );
	}

	// -----------------------------------------------------------------------
	// §5.2 — POST /media/sideload (import external URL, dedupe)
	// -----------------------------------------------------------------------

	/**
	 * Sideload an external URL into the media library (10-rest-api.md §5.2). DEDUPE: hashes the
	 * downloaded bytes and looks up an existing attachment by `_elementor_source_image_hash`; on a hit
	 * the existing attachment is returned with `deduped:true` and NOTHING is re-imported. On a fresh
	 * import the hash + source URL are stored and `deduped:false` is returned. Disallowed mimes → 422
	 * `VALIDATION_FAILED` (wire `E_MEDIA_TYPE`); bad/unreachable URLs → 400 `VALIDATION_FAILED` (wire
	 * `E_BAD_REQUEST`).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function sideload_media( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$url = $request->get_param( 'url' );
		if ( ! is_string( $url ) || '' === trim( $url ) ) {
			return $this->bad_request( __( 'A non-empty `url` is required.', 'elementor-ultra-mcp' ), array( 'path' => 'url' ), $op_id );
		}
		$url = trim( $url );

		// Validate the URL shape up-front (a syntactically bad URL never reaches the network).
		if ( ! wp_http_validate_url( $url ) ) {
			return $this->bad_request(
				__( 'The supplied `url` is not a valid, fetchable URL.', 'elementor-ultra-mcp' ),
				array(
					'path' => 'url',
					'url'  => $url,
				),
				$op_id
			);
		}

		// Reject a disallowed extension before any network call (cheap mime gate on the URL path).
		$mime_check = $this->guard_url_mime( $url );
		if ( $mime_check instanceof WP_Error ) {
			$mime_check->add_data( array_merge( (array) $mime_check->get_error_data(), $op_id ? array( 'op_id' => $op_id ) : array() ) );
			return $mime_check;
		}

		$this->load_admin_media_includes();

		// Download to a temp file so we can hash the BYTES for dedupe (robust to URL query churn).
		$tmp = download_url( $url );
		if ( is_wp_error( $tmp ) ) {
			return $this->bad_request(
				sprintf(
					/* translators: %s: upstream download error message. */
					__( 'Could not download the URL: %s', 'elementor-ultra-mcp' ),
					$tmp->get_error_message()
				),
				array(
					'path' => 'url',
					'url'  => $url,
				),
				$op_id
			);
		}

		$source_hash = @md5_file( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- a hash failure is handled below.
		if ( ! is_string( $source_hash ) || '' === $source_hash ) {
			$this->cleanup_tmp( $tmp );
			return $this->fail(
				Error_Codes::INTERNAL_ERROR,
				__( 'Could not hash the downloaded file.', 'elementor-ultra-mcp' ),
				500,
				array( 'url' => $url ),
				array(),
				$op_id
			);
		}

		// DEDUPE: an existing attachment with the same source-bytes hash short-circuits the import.
		$existing = $this->find_attachment_by_source_hash( $source_hash );
		if ( $existing > 0 ) {
			$this->cleanup_tmp( $tmp );
			$this->apply_meta( $existing, $request->get_param( 'alt' ), $request->get_param( 'title' ) );
			$this->log_op(
				$op_id,
				'media.sideload',
				array(
					'attachment_id' => $existing,
					'deduped'       => true,
				)
			);

			$summary            = $this->attachment_summary( $existing );
			$summary['deduped'] = true;
			return $this->ok(
				array(
					'attachment_id' => $existing,
					'url'           => $summary['url'],
					'sizes'         => $summary['sizes'],
					'deduped'       => true,
				)
			);
		}

		// Fresh import: hand the temp file to core's sideload helper.
		$file_array = array(
			'name'     => $this->filename_from_url( $url ),
			'tmp_name' => $tmp,
		);

		// SVG is handled by its own sanitize + mime-relax path below — DON'T run the raster byte-sniff on it
		// (wp_get_image_mime() only recognizes raster bytes and would wrongly reject valid SVGs).
		$looks_svg = in_array( strtolower( (string) pathinfo( $file_array['name'], PATHINFO_EXTENSION ) ), array( 'svg', 'svgz' ), true );

		// CONTENT SNIFF: when the URL filename has no recognized type (extensionless image CDNs), derive
		// the real type from the downloaded BYTES and give the file a proper name+extension so core accepts
		// it. This is the authoritative gate for deferred URLs — reject anything that isn't a known image.
		if ( ! $looks_svg && false === wp_check_filetype( $file_array['name'] )['type'] ) {
			$real_mime = function_exists( 'wp_get_image_mime' ) ? wp_get_image_mime( $tmp ) : false;
			$ext_map   = array(
				'image/png'     => 'png',
				'image/jpeg'    => 'jpg',
				'image/gif'     => 'gif',
				'image/webp'    => 'webp',
				'image/svg+xml' => 'svg',
			);
			if ( is_string( $real_mime ) && isset( $ext_map[ $real_mime ] ) ) {
				$stem               = sanitize_file_name( (string) pathinfo( $file_array['name'], PATHINFO_FILENAME ) );
				$file_array['name'] = ( '' !== $stem ? $stem : 'image' ) . '.' . $ext_map[ $real_mime ];
			} else {
				$this->cleanup_tmp( $tmp );
				return $this->media_type_error(
					__( 'The downloaded file is not a supported image type (sniffed from bytes).', 'elementor-ultra-mcp' ),
					array( 'url' => $url )
				);
			}
		}

		// SVG: sanitize the bytes IN PLACE before import, then relax the mime gate just for this handoff.
		$is_svg = in_array( strtolower( (string) pathinfo( $file_array['name'], PATHINFO_EXTENSION ) ), array( 'svg', 'svgz' ), true );
		if ( $is_svg ) {
			$san = $this->sanitize_svg_file( $tmp );
			if ( $san instanceof WP_Error ) {
				$this->cleanup_tmp( $tmp );
				return $san;
			}
		}

		$attachment_id = $is_svg
			? $this->run_with_svg_mime(
				static function () use ( $file_array ) {
					return media_handle_sideload( $file_array, 0 );
				}
			)
			: media_handle_sideload( $file_array, 0 );

		if ( is_wp_error( $attachment_id ) ) {
			$this->cleanup_tmp( $tmp ); // `media_handle_sideload` unlinks on success; clean up on failure.
			// A mime/upload rejection from core surfaces as a disallowed-type error (422); other
			// failures are a bad request (400). Core uses `upload_error` for mime rejection.
			$slug = (string) $attachment_id->get_error_code();
			if ( 'upload_error' === $slug || false !== strpos( $slug, 'mime' ) ) {
				return $this->media_type_error(
					$attachment_id->get_error_message(),
					array( 'url' => $url ),
					$op_id
				);
			}
			return $this->bad_request(
				$attachment_id->get_error_message(),
				array(
					'path' => 'url',
					'url'  => $url,
				),
				$op_id
			);
		}

		$attachment_id = (int) $attachment_id;

		// Persist the dedupe meta so re-imports of the same source coalesce.
		update_post_meta( $attachment_id, self::META_SOURCE_HASH, $source_hash );
		update_post_meta( $attachment_id, self::META_SOURCE_URL, esc_url_raw( $url ) );
		$this->apply_meta( $attachment_id, $request->get_param( 'alt' ), $request->get_param( 'title' ) );

		$this->log_op(
			$op_id,
			'media.sideload',
			array(
				'attachment_id' => $attachment_id,
				'deduped'       => false,
			)
		);

		$summary = $this->attachment_summary( $attachment_id );
		return $this->ok(
			array(
				'attachment_id' => $attachment_id,
				'url'           => $summary['url'],
				'sizes'         => $summary['sizes'],
				'deduped'       => false,
			)
		);
	}

	// -----------------------------------------------------------------------
	// §5.3 — POST /media/upload (raw bytes / base64)
	// -----------------------------------------------------------------------

	/**
	 * Upload raw bytes (multipart `file` part) OR a base64 JSON body `{data,filename}` into the media
	 * library (10-rest-api.md §5.3). Validates the mime BEFORE writing to disk; disallowed → 422
	 * `VALIDATION_FAILED` (wire `E_MEDIA_TYPE`); a malformed body → 400 `VALIDATION_FAILED` (wire
	 * `E_BAD_REQUEST`).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return WP_REST_Response|WP_Error
	 */
	public function upload_media( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$this->load_admin_media_includes();

		$files = $request->get_file_params();

		// Branch 1: multipart/form-data with a `file` part.
		if ( isset( $files['file'] ) && is_array( $files['file'] ) ) {
			return $this->upload_multipart( $files['file'], $request->get_param( 'alt' ), $op_id );
		}

		// Branch 2: JSON base64 `{data,filename}`.
		$data     = $request->get_param( 'data' );
		$filename = $request->get_param( 'filename' );
		if ( is_string( $data ) && '' !== $data ) {
			return $this->upload_base64( $data, $filename, $request->get_param( 'alt' ), $op_id );
		}

		return $this->bad_request(
			__( 'Provide either a multipart `file` part or a JSON body `{data:<base64>,filename}`.', 'elementor-ultra-mcp' ),
			array( 'path' => 'file|data' ),
			$op_id
		);
	}

	/**
	 * Handle a multipart `file` upload via `media_handle_sideload` (which validates mime and runs the
	 * full attachment + metadata pipeline). 10-rest-api.md §5.3.
	 *
	 * @param array<string,mixed> $file  The `$_FILES['file']` entry.
	 * @param string|null         $alt   Optional alt text.
	 * @param string|null         $op_id Optional op_id.
	 * @return WP_REST_Response|WP_Error
	 */
	private function upload_multipart( array $file, $alt, ?string $op_id ) {
		$name     = isset( $file['name'] ) ? (string) $file['name'] : '';
		$tmp_name = isset( $file['tmp_name'] ) ? (string) $file['tmp_name'] : '';

		if ( '' === $name || '' === $tmp_name || ! is_uploaded_file( $tmp_name ) ) {
			return $this->bad_request(
				__( 'The multipart `file` part is missing or invalid.', 'elementor-ultra-mcp' ),
				array( 'path' => 'file' ),
				$op_id
			);
		}

		// Validate mime by filename + bytes BEFORE the library write.
		$mime_check = $this->guard_filename_mime( $name, $tmp_name );
		if ( $mime_check instanceof WP_Error ) {
			$mime_check->add_data( array_merge( (array) $mime_check->get_error_data(), $op_id ? array( 'op_id' => $op_id ) : array() ) );
			return $mime_check;
		}

		$file_array = array(
			'name'     => $name,
			'tmp_name' => $tmp_name,
		);

		// SVG path (contract 18 §7 — the sanitizer ported from /media/sideload): sanitize the bytes
		// IN PLACE first (the real security boundary), then run the import with the mime relaxed for
		// just this call. Without the relaxation media_handle_sideload rejects SVG outright.
		$ext    = strtolower( (string) pathinfo( $name, PATHINFO_EXTENSION ) );
		$is_svg = in_array( $ext, array( 'svg', 'svgz' ), true );
		if ( $is_svg ) {
			$sanitized = $this->sanitize_svg_file( $tmp_name );
			if ( $sanitized instanceof WP_Error ) {
				$sanitized->add_data( array_merge( (array) $sanitized->get_error_data(), $op_id ? array( 'op_id' => $op_id ) : array() ) );
				return $sanitized;
			}
			$attachment_id = $this->run_with_svg_mime(
				static function () use ( $file_array ) {
					return media_handle_sideload( $file_array, 0 );
				}
			);
		} else {
			$attachment_id = media_handle_sideload( $file_array, 0 );
		}
		if ( is_wp_error( $attachment_id ) ) {
			$slug = (string) $attachment_id->get_error_code();
			if ( 'upload_error' === $slug || false !== strpos( $slug, 'mime' ) ) {
				return $this->media_type_error( $attachment_id->get_error_message(), array( 'filename' => $name ), $op_id );
			}
			return $this->bad_request( $attachment_id->get_error_message(), array( 'path' => 'file' ), $op_id );
		}

		$attachment_id = (int) $attachment_id;
		$this->apply_meta( $attachment_id, $alt, null );
		$this->log_op(
			$op_id,
			'media.upload',
			array(
				'attachment_id' => $attachment_id,
				'mode'          => 'multipart',
			)
		);

		$summary = $this->attachment_summary( $attachment_id );
		return $this->ok(
			array(
				'attachment_id' => $attachment_id,
				'url'           => $summary['url'],
				'sizes'         => $summary['sizes'],
			)
		);
	}

	/**
	 * Handle a base64 JSON upload: decode, validate mime, `wp_upload_bits`, then `wp_insert_attachment`
	 * + `wp_generate_attachment_metadata`. 10-rest-api.md §5.3.
	 *
	 * @param string      $data     Base64 file bytes.
	 * @param mixed       $filename Target filename.
	 * @param string|null $alt      Optional alt text.
	 * @param string|null $op_id    Optional op_id.
	 * @return WP_REST_Response|WP_Error
	 */
	private function upload_base64( string $data, $filename, $alt, ?string $op_id ) {
		if ( ! is_string( $filename ) || '' === trim( $filename ) ) {
			return $this->bad_request(
				__( 'A base64 upload requires a non-empty `filename`.', 'elementor-ultra-mcp' ),
				array( 'path' => 'filename' ),
				$op_id
			);
		}
		$filename = sanitize_file_name( trim( $filename ) );

		// Strip an optional data-URI prefix (`data:image/png;base64,....`).
		if ( 0 === strpos( $data, 'data:' ) ) {
			$comma = strpos( $data, ',' );
			if ( false !== $comma ) {
				$data = substr( $data, $comma + 1 );
			}
		}

		// Benign decode of a client-supplied base64 image payload (10-rest-api.md §5.3), not code obfuscation.
		$bytes = base64_decode( $data, true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- decoding the uploaded file bytes; the result is mime-gated before any write.
		if ( false === $bytes || '' === $bytes ) {
			return $this->bad_request(
				__( 'The `data` field is not valid base64.', 'elementor-ultra-mcp' ),
				array( 'path' => 'data' ),
				$op_id
			);
		}

		// Validate mime by filename + the decoded bytes (write the bytes to a temp file to sniff).
		$tmp = wp_tempnam( $filename );
		if ( ! $tmp ) {
			return $this->fail(
				Error_Codes::INTERNAL_ERROR,
				__( 'Could not allocate a temp file for the upload.', 'elementor-ultra-mcp' ),
				500,
				array(),
				array(),
				$op_id
			);
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- temp sniff file, not a managed upload.
		file_put_contents( $tmp, $bytes );

		$mime_check = $this->guard_filename_mime( $filename, $tmp );
		if ( $mime_check instanceof WP_Error ) {
			$this->cleanup_tmp( $tmp );
			$mime_check->add_data( array_merge( (array) $mime_check->get_error_data(), $op_id ? array( 'op_id' => $op_id ) : array() ) );
			return $mime_check;
		}

		// SVG path (contract 18 §7 — the sanitizer ported from /media/sideload): sanitize the sniffed
		// temp file IN PLACE (the real security boundary) and carry the SANITIZED bytes forward; the
		// managed write below then runs with the mime relaxed for just this call.
		$ext    = strtolower( (string) pathinfo( $filename, PATHINFO_EXTENSION ) );
		$is_svg = in_array( $ext, array( 'svg', 'svgz' ), true );
		if ( $is_svg ) {
			$sanitized = $this->sanitize_svg_file( $tmp );
			if ( $sanitized instanceof WP_Error ) {
				$this->cleanup_tmp( $tmp );
				$sanitized->add_data( array_merge( (array) $sanitized->get_error_data(), $op_id ? array( 'op_id' => $op_id ) : array() ) );
				return $sanitized;
			}
			$clean_bytes = @file_get_contents( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- re-reading the just-sanitized temp file.
			if ( is_string( $clean_bytes ) && '' !== $clean_bytes ) {
				$bytes = $clean_bytes;
			}
		}
		$this->cleanup_tmp( $tmp );

		// Write the managed file. `wp_upload_bits` re-checks the filetype against allowed mimes itself,
		// so the SVG path runs it with the mime relaxed (the bytes are already sanitized above).
		$upload = $is_svg
			? $this->run_with_svg_mime(
				static function () use ( $filename, $bytes ) {
					return wp_upload_bits( $filename, null, $bytes );
				}
			)
			: wp_upload_bits( $filename, null, $bytes );
		if ( ! empty( $upload['error'] ) ) {
			return $this->media_type_error( (string) $upload['error'], array( 'filename' => $filename ), $op_id );
		}

		$file_path = $upload['file'];
		$file_url  = $upload['url'];
		$file_type = wp_check_filetype( $file_path );
		if ( $is_svg ) {
			// Core's mime table has no svg entry; pin the sanitized upload's real type.
			$file_type['type'] = 'image/svg+xml';
		}

		$attachment = array(
			'post_mime_type' => $file_type['type'] ? $file_type['type'] : 'application/octet-stream',
			'post_title'     => preg_replace( '/\.[^.]+$/', '', basename( $file_path ) ),
			'post_content'   => '',
			'post_status'    => 'inherit',
			'guid'           => $file_url,
		);

		$attachment_id = wp_insert_attachment( $attachment, $file_path, 0, true );
		if ( is_wp_error( $attachment_id ) ) {
			return $this->bad_request( $attachment_id->get_error_message(), array( 'path' => 'data' ), $op_id );
		}
		$attachment_id = (int) $attachment_id;

		// Generate the full metadata (sizes etc.) — requires image.php (loaded above).
		$metadata = wp_generate_attachment_metadata( $attachment_id, $file_path );
		if ( is_array( $metadata ) ) {
			wp_update_attachment_metadata( $attachment_id, $metadata );
		}

		$this->apply_meta( $attachment_id, $alt, null );
		$this->log_op(
			$op_id,
			'media.upload',
			array(
				'attachment_id' => $attachment_id,
				'mode'          => 'base64',
			)
		);

		$summary = $this->attachment_summary( $attachment_id );
		return $this->ok(
			array(
				'attachment_id' => $attachment_id,
				'url'           => $summary['url'],
				'sizes'         => $summary['sizes'],
			)
		);
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Build the per-item attachment summary the §5.1/§5.2/§5.3 responses share:
	 * `{attachment_id,url,title,alt,mime,sizes}`. `sizes` is the registered-size map with url + width +
	 * height per size (full,large,...) so the converter / image authoring can pick a `size`
	 * (11-authoring-contract.md §3.1 image prop `size`).
	 *
	 * @param int $attachment_id The attachment post id.
	 * @return array<string,mixed>
	 */
	private function attachment_summary( int $attachment_id ): array {
		return array(
			'attachment_id' => $attachment_id,
			'url'           => (string) wp_get_attachment_url( $attachment_id ),
			'title'         => (string) get_the_title( $attachment_id ),
			'alt'           => (string) get_post_meta( $attachment_id, '_wp_attachment_image_alt', true ),
			'mime'          => (string) get_post_mime_type( $attachment_id ),
			'sizes'         => $this->attachment_sizes( $attachment_id ),
		);
	}

	/**
	 * Build the `sizes` map for an attachment: every registered image size that resolved, plus `full`,
	 * each as `{url,width,height}`. Returns an empty object for non-image attachments.
	 *
	 * @param int $attachment_id The attachment post id.
	 * @return array<string,array{url:string,width:int,height:int}>
	 */
	private function attachment_sizes( int $attachment_id ): array {
		$sizes = array();

		if ( ! wp_attachment_is_image( $attachment_id ) ) {
			return $sizes;
		}

		// `full` is always available for an image.
		$full = wp_get_attachment_image_src( $attachment_id, 'full' );
		if ( is_array( $full ) ) {
			$sizes['full'] = array(
				'url'    => (string) $full[0],
				'width'  => (int) $full[1],
				'height' => (int) $full[2],
			);
		}

		foreach ( get_intermediate_image_sizes() as $size ) {
			$src = wp_get_attachment_image_src( $attachment_id, $size );
			// `wp_get_attachment_image_src` returns the full image (with `$src[3]===false`) when the named
			// size does not physically exist; skip those so `sizes` only lists real renditions.
			if ( is_array( $src ) && isset( $src[3] ) && true === $src[3] ) {
				$sizes[ $size ] = array(
					'url'    => (string) $src[0],
					'width'  => (int) $src[1],
					'height' => (int) $src[2],
				);
			}
		}

		return $sizes;
	}

	/**
	 * Look up an existing attachment by its stored source-bytes hash (dedupe key). Returns the
	 * attachment id or 0 when none matches.
	 *
	 * @param string $source_hash The md5 of the source bytes.
	 * @return int
	 */
	private function find_attachment_by_source_hash( string $source_hash ): int {
		$query = new WP_Query(
			array(
				'post_type'              => 'attachment',
				'post_status'            => 'inherit',
				'posts_per_page'         => 1,
				'fields'                 => 'ids',
				'no_found_rows'          => true,
				'update_post_term_cache' => false,
				'meta_query'             => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query -- intentional dedupe lookup keyed on a single indexed meta value.
					array(
						'key'   => self::META_SOURCE_HASH,
						'value' => $source_hash,
					),
				),
			)
		);

		if ( empty( $query->posts ) ) {
			return 0;
		}

		return (int) $query->posts[0];
	}

	/**
	 * Apply `alt`/`title` to an attachment after import (10-rest-api.md §5.2). Skips empty values so a
	 * dedupe hit does not clobber existing metadata with blanks.
	 *
	 * @param int   $attachment_id The attachment post id.
	 * @param mixed $alt           Alt text (string|null).
	 * @param mixed $title         Title (string|null).
	 * @return void
	 */
	private function apply_meta( int $attachment_id, $alt, $title ): void {
		if ( is_string( $alt ) && '' !== trim( $alt ) ) {
			update_post_meta( $attachment_id, '_wp_attachment_image_alt', sanitize_text_field( $alt ) );
		}
		if ( is_string( $title ) && '' !== trim( $title ) ) {
			wp_update_post(
				array(
					'ID'         => $attachment_id,
					'post_title' => sanitize_text_field( $title ),
				)
			);
		}
	}

	/**
	 * Load the WP admin includes that `media_handle_sideload` / `media_handle_upload` /
	 * `wp_generate_attachment_metadata` need (REST requests do not load admin includes).
	 * 10-rest-api.md §5 Implementation Notes.
	 *
	 * @return void
	 */
	private function load_admin_media_includes(): void {
		if ( ! function_exists( 'media_handle_sideload' ) ) {
			require_once ABSPATH . 'wp-admin/includes/media.php';
		}
		if ( ! function_exists( 'download_url' ) || ! function_exists( 'wp_handle_sideload' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		if ( ! function_exists( 'wp_generate_attachment_metadata' ) ) {
			require_once ABSPATH . 'wp-admin/includes/image.php';
		}
	}

	/**
	 * Mime gate by URL path: derive a filename from the URL and check its extension against the allowed
	 * mime types. Returns true|WP_Error (422 `VALIDATION_FAILED` on a disallowed/unknown type, including
	 * SVG unless SVG support is enabled). 10-rest-api.md §5.2, 12-error-taxonomy.md §4 (`E_MEDIA_TYPE`).
	 *
	 * @param string $url The source URL.
	 * @return true|WP_Error
	 */
	private function guard_url_mime( string $url ) {
		$path = wp_parse_url( $url, PHP_URL_PATH );
		$name = is_string( $path ) ? basename( $path ) : '';
		if ( '' === $name ) {
			// No filename in the path — defer the decision to the post-download sniff (core gates again).
			return true;
		}
		// If the URL filename has no RECOGNIZED type (extensionless, or a non-file ext like clearbit's
		// `/doordash.com`), defer to the post-download byte sniff in sideload_media() rather than reject
		// here — many image/logo CDNs serve images from extensionless URLs.
		$probe = wp_check_filetype( $name );
		if ( false === $probe['type'] || '' === (string) $probe['type'] ) {
			return true;
		}
		return $this->guard_filename_mime( $name, null );
	}

	/**
	 * Mime gate by filename (and optionally the on-disk bytes): rejects a type not in
	 * `get_allowed_mime_types()` for the current user, and rejects SVG unless SVG support is enabled.
	 * Returns true|WP_Error (422 `VALIDATION_FAILED`, wire `E_MEDIA_TYPE`).
	 *
	 * @param string      $filename The proposed filename.
	 * @param string|null $tmp_path Optional on-disk path to sniff (`wp_check_filetype_and_ext`).
	 * @return true|WP_Error
	 */
	/**
	 * Run $fn with SVG temporarily registered as an allowed upload mime. Scoped to the single
	 * media_handle_sideload() call so the relaxation never leaks past the import. The bytes are
	 * sanitized via sanitize_svg_file() BEFORE this runs — sanitization is the real security boundary.
	 *
	 * @param callable $fn
	 * @return mixed
	 */
	private function run_with_svg_mime( callable $fn ) {
		$add = static function ( $mimes ) {
			$mimes['svg']  = 'image/svg+xml';
			$mimes['svgz'] = 'image/svg+xml';
			return $mimes;
		};
		$fix = static function ( $data, $file, $filename, $mimes = null, $real_mime = null ) {
			$ext = strtolower( (string) pathinfo( (string) $filename, PATHINFO_EXTENSION ) );
			if ( in_array( $ext, array( 'svg', 'svgz' ), true ) ) {
				$data['ext']  = $ext;
				$data['type'] = 'image/svg+xml';
			}
			return $data;
		};
		add_filter( 'upload_mimes', $add );
		add_filter( 'wp_check_filetype_and_ext', $fix, 10, 5 );
		try {
			return $fn();
		} finally {
			remove_filter( 'upload_mimes', $add );
			remove_filter( 'wp_check_filetype_and_ext', $fix, 10 );
		}
	}

	/**
	 * Sanitize an SVG file IN PLACE using Elementor's own SVG sanitizer (strips scripts/handlers/etc).
	 * Returns true on success, or a 422 media-type WP_Error if the sanitizer is unavailable or the file
	 * cannot be made safe. This is the security gate that lets us accept SVG icons via the MCP.
	 *
	 * @param string $path On-disk path to the downloaded SVG.
	 * @return true|WP_Error
	 */
	private function sanitize_svg_file( string $path ) {
		$content = @file_get_contents( $path ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		if ( ! is_string( $content ) || '' === $content ) {
			return $this->media_type_error( __( 'Could not read the SVG for sanitization.', 'elementor-ultra-mcp' ), array() );
		}
		$clean = null;
		try {
			if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->uploads_manager ) ) {
				$handler = \Elementor\Plugin::$instance->uploads_manager->get_file_type_handlers( 'svg' );
				if ( $handler && method_exists( $handler, 'sanitizer' ) ) {
					$clean = $handler->sanitizer( $content );
				}
			}
		} catch ( \Throwable $e ) {
			$clean = null;
		}
		if ( ! is_string( $clean ) || '' === $clean ) {
			return $this->media_type_error(
				__( 'SVG failed sanitization (unsafe content or sanitizer unavailable); not imported.', 'elementor-ultra-mcp' ),
				array( 'mime' => 'image/svg+xml' )
			);
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		@file_put_contents( $path, $clean ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		return true;
	}

	private function guard_filename_mime( string $filename, ?string $tmp_path ) {
		$allowed = get_allowed_mime_types();

		$ext    = strtolower( (string) pathinfo( $filename, PATHINFO_EXTENSION ) );
		$is_svg = in_array( $ext, array( 'svg', 'svgz' ), true );

		if ( null !== $tmp_path && file_exists( $tmp_path ) ) {
			$check = wp_check_filetype_and_ext( $tmp_path, $filename );
		} else {
			$check = wp_check_filetype( $filename, $allowed );
			// Normalise to the same shape `wp_check_filetype_and_ext` returns.
			$check = array(
				'ext'             => $check['ext'],
				'type'            => $check['type'],
				'proper_filename' => false,
			);
		}

		$type = isset( $check['type'] ) ? $check['type'] : false;

		// SVG is permitted but ONLY after sanitization (sanitize_svg_file() runs at the upload site, with
		// the mime relaxed via run_with_svg_mime()). Allow it past this static gate; the sanitizer is the
		// real security boundary. Enables real vector icons (e-svg) through the MCP.
		if ( $is_svg ) {
			return true;
		}

		if ( false === $type || '' === $type ) {
			return $this->media_type_error(
				__( 'The file type is not permitted on this site.', 'elementor-ultra-mcp' ),
				array(
					'filename'      => $filename,
					'ext'           => $ext,
					'allowed_count' => count( $allowed ),
				)
			);
		}

		if ( ! in_array( $type, $allowed, true ) ) {
			return $this->media_type_error(
				/* translators: %s: the detected mime type. */
				sprintf( __( 'The mime type %s is not permitted on this site.', 'elementor-ultra-mcp' ), $type ),
				array(
					'filename' => $filename,
					'mime'     => $type,
				)
			);
		}

		return true;
	}

	/**
	 * Best-effort filename from a URL (used as the sideload `name`). Falls back to a synthetic name.
	 *
	 * @param string $url The source URL.
	 * @return string
	 */
	private function filename_from_url( string $url ): string {
		$path = wp_parse_url( $url, PHP_URL_PATH );
		$name = is_string( $path ) ? basename( $path ) : '';
		$name = sanitize_file_name( $name );
		if ( '' === $name || false === strpos( $name, '.' ) ) {
			$name = 'sideload-' . md5( $url ) . '.tmp';
		}
		return $name;
	}

	/**
	 * Delete a temp file if it still exists (cleanup after a failed sideload/upload).
	 *
	 * @param string|false $tmp The temp path.
	 * @return void
	 */
	private function cleanup_tmp( $tmp ): void {
		if ( is_string( $tmp ) && '' !== $tmp && file_exists( $tmp ) ) {
			wp_delete_file( $tmp );
		}
	}

	/**
	 * Record an op-log row when the WP-P14 store is present (guarded — absent before WP-P14 ships).
	 * Never throws; an op-log failure must not fail the media operation.
	 *
	 * @param string|null         $op_id   The op_id (or null when absent).
	 * @param string              $op      The operation name (e.g. `media.sideload`).
	 * @param array<string,mixed> $context Structured context.
	 * @return void
	 */
	private function log_op( ?string $op_id, string $op, array $context ): void {
		if ( null === $op_id ) {
			return;
		}
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		try {
			\Elementor\Ultra\Core\Op_Log::record(
				$op_id,
				array_merge( array( 'op' => $op ), $context )
			);
		} catch ( \Throwable $e ) {
			unset( $e ); // Op-log is best-effort; never surface its failure.
		}
	}

	/**
	 * Build the 400 bad-request taxonomy error (wire `E_BAD_REQUEST` -> `VALIDATION_FAILED`, 400).
	 * 12-error-taxonomy.md §4; the TS client SLUG_TO_CODE maps `E_BAD_REQUEST` -> `VALIDATION_FAILED`.
	 *
	 * @param string              $message Human, actionable message.
	 * @param array<string,mixed> $meta    Structured context.
	 * @param string|null         $op_id   Echoed op_id when supplied.
	 * @return WP_Error
	 */
	private function bad_request( string $message, array $meta = array(), ?string $op_id = null ): WP_Error {
		return $this->fail( Error_Codes::VALIDATION_FAILED, $message, 400, $meta, array(), $op_id );
	}

	/**
	 * Build the 422 disallowed-mime taxonomy error (wire `E_MEDIA_TYPE` -> `VALIDATION_FAILED`, 422).
	 * 12-error-taxonomy.md §4; the TS client SLUG_TO_CODE maps `E_MEDIA_TYPE` -> `VALIDATION_FAILED`.
	 *
	 * @param string              $message Human, actionable message.
	 * @param array<string,mixed> $meta    Structured context.
	 * @param string|null         $op_id   Echoed op_id when supplied.
	 * @return WP_Error
	 */
	private function media_type_error( string $message, array $meta = array(), ?string $op_id = null ): WP_Error {
		return $this->fail( Error_Codes::VALIDATION_FAILED, $message, 422, $meta, array(), $op_id );
	}
}

/*
 * Self-registration (10-rest-api.md §0.1; class-registrar.php docblock). The controller adds itself on
 * the registrar's action so wiring it NEVER edits the WP-P02 spine. Guarded by `class_exists` so the
 * file is safe to load standalone (e.g. under php -l or PHPUnit without the registrar present).
 */
if ( ! defined( 'EMCP_MEDIA_CONTROLLER_REGISTERED' ) ) {
	define( 'EMCP_MEDIA_CONTROLLER_REGISTERED', true );
	add_action(
		'elementor_ultra/rest/register',
		static function ( $registrar ) {
			if ( $registrar instanceof Registrar ) {
				$registrar->register_controller( new Media_Controller() );
			}
		}
	);
}
