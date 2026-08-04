<?php
/**
 * Contract 18 §7-AI S4 — Fonts REST controller: `POST /design/fonts/install`.
 *
 * Contract authority: 18-figma-frontend.md §7-AI S4 (kills AF5 — "fonts have no first-class path";
 * the R4 Five Pathways docker-cp + html-widget @font-face recipe retires once this lands) + §7
 * "Font system strategy" (the NATIVE atomic enqueue covers ~1600 Google-catalog families once the
 * `Css_Primer`/`Fonts_Service` normalization fires; THIS route is for NON-catalog faces only —
 * Armin Soft / Novaletra class design fonts).
 *
 * This controller is a THIN REST facade (WP-P13 pattern): ALL logic lives in
 * {@see \Elementor\Ultra\Core\Fonts_Service::install()} — bytes acquisition (url|base64),
 * magic-byte format sniffing, uploads storage with font mimes allowed ONLY inside that call
 * (the media routes still reject fonts — S4 "font mimes allowed on this path only"), and the
 * font-face registration (Pro Custom Fonts CPT when available → native enqueue path; else the
 * active kit's `custom_css` STRING setting). The controller owns the route schema, the CAP_MANAGE
 * gate (matches Pro's own Fonts_Manager::CAPABILITY = manage_options), the success envelope, and
 * the op-log row.
 *
 * Self-registration (WP-P01 spine parallelism): adds itself via the `elementor_ultra/rest/register`
 * action — NEVER edits the spine `Registrar`/`Plugin` files.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Rest;

use Elementor\Ultra\Core\Fonts_Service;
use WP_Error;
use WP_REST_Request;
use WP_REST_Server;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * The FONTS REST controller (contract 18 §7-AI S4). One route: the CAP_MANAGE font-face install.
 */
final class Fonts_Controller extends Abstract_Controller {

	/** Op-log `route` value for the install write (10-rest-api.md §11; WP-P14 store). */
	const OP_ROUTE_INSTALL = 'design/fonts/install';

	/** Op-log `route` value for the ZIP upload write. */
	const OP_ROUTE_UPLOAD_ZIP = 'design/fonts/upload-zip';

	/**
	 * Register routes:
	 *  - `GET /design/fonts` CAP_READ — list installed non-catalog font families.
	 *  - `POST /design/fonts/install` CAP_MANAGE — store a woff2/woff/ttf/otf face under uploads and
	 *    register its @font-face (Pro Custom Fonts CPT when available, else kit custom CSS).
	 *  - `POST /design/fonts/upload-zip` CAP_MANAGE — extract a ZIP and bulk-install all font files
	 *    inside, reading family names automatically from each file's name table.
	 *
	 * @return void
	 */
	public function register_routes(): void {
		$this->route(
			'/design/fonts',
			WP_REST_Server::READABLE,
			array( $this, 'list_fonts' ),
			Permissions::can_read(),
			array()
		);

		$this->route(
			'/design/fonts/install',
			WP_REST_Server::CREATABLE,
			array( $this, 'install' ),
			Permissions::can_manage(),
			array(
				'source' => array(
					'type'        => 'string',
					'required'    => true,
					'description' => 'The font bytes: an http(s) URL, a data: URI, or raw base64 (woff2/woff/ttf/otf; the REAL format is sniffed from magic bytes).',
				),
				'family' => array(
					'type'              => 'string',
					'required'          => true,
					'sanitize_callback' => 'sanitize_text_field',
					'description'       => 'The font-family name to register (the exact string atomic font-family props should use).',
				),
				'weight' => array(
					'type'        => array( 'string', 'integer' ),
					'required'    => false,
					'default'     => '400',
					'description' => 'Numeric weight 1-1000 (or normal/bold). One static face per call.',
				),
				'style'  => array(
					'type'        => 'string',
					'required'    => false,
					'default'     => 'normal',
					'enum'        => array( 'normal', 'italic', 'oblique' ),
					'description' => 'The font-style of this face.',
				),
				'op_id'  => array(
					'type'        => 'string',
					'required'    => false,
					'description' => 'Idempotency / audit id (^[A-Za-z0-9_.-]{1,64}$).',
				),
			)
		);

		$this->route(
			'/design/fonts/upload-zip',
			WP_REST_Server::CREATABLE,
			array( $this, 'upload_zip' ),
			Permissions::can_manage(),
			array(
				'zip_data' => array(
					'type'        => 'string',
					'required'    => true,
					'description' => 'Base64-encoded ZIP file containing OTF/TTF/WOFF/WOFF2 font files. Family names and weights are read from each file\'s name table automatically.',
				),
				'op_id'    => array(
					'type'        => 'string',
					'required'    => false,
					'description' => 'Idempotency / audit id (^[A-Za-z0-9_.-]{1,64}$).',
				),
			)
		);
	}

	/**
	 * `GET /design/fonts` handler. Returns the family names of all non-catalog fonts installed
	 * on this site (Pro CPT path and kit custom_css path).
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return \WP_REST_Response
	 */
	public function list_fonts( WP_REST_Request $request ) {
		return $this->ok( array( 'families' => Fonts_Service::list_installed_families() ) );
	}

	/**
	 * `POST /design/fonts/install` handler. Delegates to {@see Fonts_Service::install()}; a
	 * `WP_Error` (taxonomy `VALIDATION_FAILED` 400/422) passes through verbatim so WordPress
	 * serializes the §0.6 envelope.
	 *
	 * Response `data`: `{ family, weight, style, format, attachment_id, url, registered_via:
	 * "pro_custom_fonts"|"kit_custom_css", font_face, warnings[] }` — `family` is the resolved
	 * string callers should put in `font-family` props; `font_face` is the registered CSS block.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function install( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$result = Fonts_Service::install(
			array(
				'source' => $request->get_param( 'source' ),
				'family' => $request->get_param( 'family' ),
				'weight' => $request->get_param( 'weight' ),
				'style'  => $request->get_param( 'style' ),
			)
		);
		if ( $result instanceof WP_Error ) {
			return $result;
		}

		$this->record_op(
			$op_id,
			array(
				'family'         => $result['family'],
				'weight'         => $result['weight'],
				'style'          => $result['style'],
				'format'         => $result['format'],
				'attachment_id'  => $result['attachment_id'],
				'registered_via' => $result['registered_via'],
			)
		);

		return $this->ok( $result );
	}

	/**
	 * `POST /design/fonts/upload-zip` handler. Extracts a base64-encoded ZIP and installs every
	 * OTF/TTF/WOFF/WOFF2 font found inside. Family names and weights are read from the name table.
	 *
	 * Response `data`: `{ installed: face[], skipped: string[] }`.
	 *
	 * @param WP_REST_Request $request The current request.
	 * @return \WP_REST_Response|WP_Error
	 */
	public function upload_zip( WP_REST_Request $request ) {
		$op_id = $this->read_op_id( $request );
		if ( $op_id instanceof WP_Error ) {
			return $op_id;
		}

		$result = Fonts_Service::install_from_zip( (string) $request->get_param( 'zip_data' ) );
		if ( $result instanceof WP_Error ) {
			return $result;
		}

		$this->record_op(
			$op_id,
			array(
				'installed_count' => count( $result['installed'] ),
				'skipped_count'   => count( $result['skipped'] ),
				'route'           => self::OP_ROUTE_UPLOAD_ZIP,
			)
		);

		return $this->ok( $result );
	}

	/**
	 * Append one op-log row for the install WRITE (10-rest-api.md §11; WP-P14 store). Guarded +
	 * best-effort: a build without the store degrades to no-logging; the install still succeeds.
	 *
	 * @param string|null         $op_id The validated request op_id (or null → no row).
	 * @param array<string,mixed> $meta  Structured context for the row.
	 * @return void
	 */
	private function record_op( ?string $op_id, array $meta ): void {
		if ( null === $op_id ) {
			return;
		}
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		try {
			\Elementor\Ultra\Core\Op_Log::record(
				array(
					'op_id'   => $op_id,
					'post_id' => null,
					'route'   => self::OP_ROUTE_INSTALL,
					'result'  => 'ok',
					'meta'    => $meta,
				)
			);
		} catch ( \Throwable $e ) {
			unset( $e ); // Op-log is best-effort; it must never fail the install.
		}
	}
}

/*
 * Self-registration with the WP-P02 registrar (WP-P01 spine parallelism). The registrar fires
 * `elementor_ultra/rest/register` on `rest_api_init`, passing the live registrar; we hand it a fresh
 * controller instance so the fonts route registers WITHOUT any edit to the spine files.
 */
add_action(
	Registrar::REGISTER_ACTION,
	static function ( $registrar ) {
		if ( $registrar instanceof Registrar ) {
			$registrar->register_controller( new Fonts_Controller() );
		}
	}
);
