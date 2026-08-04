<?php
/**
 * Contract 18 §7 — Fonts tests: the NATIVE font-pipeline normalization (Font system strategy) +
 * `POST /design/fonts/install` (§7-AI S4).
 *
 * Covers, mirroring the live-verified root cause (quoted names / fallback stacks fail
 * `Fonts::get_font_type()`'s exact catalog-key lookup, so converted pages natively enqueued NOTHING):
 *
 *  - `Fonts_Service::resolve_stack_value()` — splits stacks, strips quotes/escapes/NBSP, drops CSS
 *    generics + UA-only stack tokens, canonicalizes casing against the live catalog, and reports
 *    non-catalog families (never silently drops a real name).
 *  - `Fonts_Service::normalize_collected_fonts()` — rewrites the per-post
 *    `elementor_atomic_styles_fonts-*` options (the values the prime dispatch collects) to bare
 *    catalog-matchable names; idempotent; deletes an option whose every entry is generic-only. The
 *    §7 corpus guard's PHP proxy: every normalized entry must resolve via `Fonts::get_font_type()`.
 *  - `Fonts_Service::install()` — magic-byte sniffing (woff2/woff/ttf/otf; junk rejected), uploads
 *    storage with font mimes allowed ONLY inside the call (S4 — the global allowlist stays
 *    font-free), and @font-face registration via the Pro Custom Fonts CPT when available (CPT post
 *    + repeater meta + regenerated font-face meta + refreshed family list) else kit custom CSS
 *    (plain STRING — the AF1 inverse-trap is asserted, never an object write).
 *  - The REST surface: CAP_MANAGE gate (subscriber → 403 CAPABILITY_MISSING envelope) and a
 *    successful admin install through `POST /elementor-ultra/v1/design/fonts/install`.
 *
 * @package Elementor\Ultra\Tests
 */

namespace Elementor\Ultra\Tests;

use Elementor\Ultra\Core\Fonts_Service;
use WP_REST_Request;
use WP_UnitTestCase;

/**
 * Fonts cluster suite (contract 18 §7 + §7-AI S4).
 *
 * @group fonts
 * @group contract-18
 */
class Test_Fonts extends WP_UnitTestCase {

	/** A minimal byte payload per format: the magic prefix + padding (the sniff is the gate). */
	const FAKE_WOFF2 = "wOF2\x00\x01\x02\x03 elementor-ultra test face padding";

	/** Skip without the service; reset caches; act as an administrator. */
	public function set_up() {
		parent::set_up();
		if ( ! class_exists( '\Elementor\Ultra\Core\Fonts_Service' ) ) {
			$this->markTestSkipped( 'Fonts_Service is not loaded (companion plugin inactive).' );
		}
		Fonts_Service::flush_catalog_index();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
	}

	// ---------------------------------------------------------------------
	// resolve_stack_value / clean_family_name (the value-shape root cause).
	// ---------------------------------------------------------------------

	/** Stacks split and quotes strip into bare names. */
	public function test_resolve_stack_value_splits_stacks_and_strips_quotes() {
		$result = Fonts_Service::resolve_stack_value( '"Bricolage Grotesque", Inter, sans-serif' );
		$this->assertSame( array( 'Bricolage Grotesque', 'Inter' ), $result['families'] );

		$quoted = Fonts_Service::resolve_stack_value( '"JetBrains Mono"' );
		$this->assertSame( array( 'JetBrains Mono' ), $quoted['families'] );
	}

	/** CSS generics + UA-only stack tokens are dropped; real names are kept + reported. */
	public function test_resolve_stack_value_drops_generics_and_ua_stack_tokens() {
		// The live field stack from page 1034 (Public Sans build).
		$result = Fonts_Service::resolve_stack_value( 'Public Sans,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' );
		$this->assertSame( array( 'Public Sans', 'Segoe UI' ), $result['families'] );
		// `Segoe UI` is real-but-uncatalogued → reported, never silently dropped.
		$this->assertContains( 'Segoe UI', $result['non_catalog'] );
		$this->assertNotContains( '-apple-system', $result['non_catalog'] );

		$generics_only = Fonts_Service::resolve_stack_value( 'serif, sans-serif, system-ui' );
		$this->assertSame( array(), $generics_only['families'] );
	}

	/** Wrong casing canonicalizes to the exact catalog key. */
	public function test_resolve_stack_value_canonicalizes_against_the_catalog() {
		if ( ! class_exists( '\Elementor\Fonts' ) ) {
			$this->markTestSkipped( 'Elementor is not loaded; no catalog to canonicalize against.' );
		}
		// Wrong casing in the stored value must resolve to the EXACT catalog key the frontend
		// enqueue matches on (`Fonts::get_font_type()` is an exact array-key lookup).
		$result = Fonts_Service::resolve_stack_value( '"jetbrains mono", monospace' );
		$this->assertSame( array( 'JetBrains Mono' ), $result['families'] );
		$this->assertSame( array(), $result['non_catalog'] );
		$this->assertNotFalse( \Elementor\Fonts::get_font_type( 'JetBrains Mono' ) );
	}

	/** Escaped quotes and NBSP whitespace are tolerated. */
	public function test_clean_family_name_handles_escapes_and_nbsp() {
		$this->assertSame( 'JetBrains Mono', Fonts_Service::clean_family_name( '\\"JetBrains Mono\\"' ) );
		$this->assertSame( 'JetBrains Mono', Fonts_Service::clean_family_name( "JetBrains\u{00a0}Mono" ) );
		$this->assertSame( '', Fonts_Service::clean_family_name( '  ""  ' ) );
	}

	/** Top-level-comma split keeps var() fallbacks attached. */
	public function test_split_stack_components_is_paren_aware() {
		$this->assertSame(
			array( 'var(--font-X, serif)', ' Inter', ' sans-serif' ),
			Fonts_Service::split_stack_components( 'var(--font-X, serif), Inter, sans-serif' )
		);
		$this->assertSame( array( 'Inter' ), Fonts_Service::split_stack_components( 'Inter' ) );
		$this->assertSame( array(), Fonts_Service::split_stack_components( '' ) );
	}

	/** A `var(--label)` reference resolves via the active kit variables (live page 2658 shape). */
	public function test_resolve_stack_value_resolves_design_variable_references() {
		// Converted pages mint font DESIGN VARIABLES: the prop-transform collects the transformed
		// `var(--<label>)` token (live page 2658) — resolution goes through the active kit's
		// `_elementor_global_variables` meta (escaped-quote stack values included).
		$kit_id = self::factory()->post->create( array( 'post_type' => 'page' ) );
		update_post_meta(
			$kit_id,
			'_elementor_global_variables',
			wp_json_encode(
				array(
					'data' => array(
						'e-gv-0000001' => array(
							'type'  => 'global-font-variable',
							'label' => 'font-Inter',
							'value' => array(
								'$$type' => 'string',
								'value'  => 'Inter',
							),
						),
						'e-gv-0000002' => array(
							'type'  => 'global-font-variable',
							'label' => 'font-stack',
							'value' => array(
								'$$type' => 'string',
								'value'  => '\\"Segoe UI\\", Roboto, sans-serif',
							),
						),
					),
				)
			)
		);
		$previous_kit = get_option( 'elementor_active_kit' );
		update_option( 'elementor_active_kit', $kit_id );
		Fonts_Service::flush_catalog_index();

		try {
			$resolved = Fonts_Service::resolve_stack_value( 'var(--font-Inter)' );
			$this->assertSame( array( 'Inter' ), $resolved['families'] );
			$this->assertSame( array(), $resolved['non_catalog'] );

			// A variable whose value is itself a stack resolves through (escapes stripped, generics dropped).
			$stacked = Fonts_Service::resolve_stack_value( 'var(--font-stack)' );
			$this->assertSame( array( 'Segoe UI', 'Roboto' ), $stacked['families'] );

			// Unknown variable WITH a fallback → the fallback resolves; without one → honest report.
			$fallback = Fonts_Service::resolve_stack_value( 'var(--font-missing, Inter), serif' );
			$this->assertSame( array( 'Inter' ), $fallback['families'] );
			$unknown = Fonts_Service::resolve_stack_value( 'var(--font-missing)' );
			$this->assertSame( array(), $unknown['families'] );
			$this->assertSame( array( 'var(--font-missing)' ), $unknown['non_catalog'] );
		} finally {
			update_option( 'elementor_active_kit', $previous_kit );
			Fonts_Service::flush_catalog_index();
		}
	}

	// ---------------------------------------------------------------------
	// normalize_collected_fonts (the Css_Primer post-dispatch step).
	// ---------------------------------------------------------------------

	/** The live-observed option shapes rewrite to bare catalog names, idempotently. */
	public function test_normalize_collected_fonts_rewrites_the_live_observed_shapes() {
		$post_id = self::factory()->post->create();
		$key     = Fonts_Service::option_key( 'global', $post_id, 'frontend' );

		// The EXACT value shapes observed live on the wp-stack target (pages 2089/2658).
		update_option(
			$key,
			array(
				'"JetBrains Mono"',
				'Inter, sans-serif',
				'"Bricolage Grotesque", Inter, sans-serif',
				'"JetBrains Mono", monospace',
			),
			false
		);

		$result = Fonts_Service::normalize_collected_fonts( $post_id );
		$this->assertContains( $key, $result['normalized'] );

		$stored = get_option( $key );
		$this->assertSame( array( 'JetBrains Mono', 'Inter', 'Bricolage Grotesque' ), $stored );

		// §7 guard (PHP proxy): every normalized entry must resolve via the NATIVE catalog lookup.
		if ( class_exists( '\Elementor\Fonts' ) ) {
			foreach ( $stored as $family ) {
				$this->assertNotFalse(
					\Elementor\Fonts::get_font_type( $family ),
					"Normalized family '{$family}' must hit the catalog exactly (native enqueue key)."
				);
			}
		}

		// Idempotent: a second pass rewrites nothing.
		$again = Fonts_Service::normalize_collected_fonts( $post_id );
		$this->assertSame( array(), $again['normalized'] );
		$this->assertSame( $stored, get_option( $key ) );
	}

	/** Non-catalog families are reported + kept bare; generic-only options are deleted. */
	public function test_normalize_collected_fonts_reports_non_catalog_and_deletes_empty() {
		$post_id   = self::factory()->post->create();
		$local_key = Fonts_Service::option_key( 'local', $post_id, 'frontend' );

		update_option( $local_key, array( 'FONTSPRING DEMO - Armin Soft SemiBold, sans-serif' ), false );
		$result = Fonts_Service::normalize_collected_fonts( $post_id );
		$this->assertContains( 'FONTSPRING DEMO - Armin Soft SemiBold', $result['non_catalog'] );
		$this->assertNotEmpty( $result['warnings'] );
		// The non-catalog name is KEPT bare (a later fonts.install registration matches it at render).
		$this->assertSame( array( 'FONTSPRING DEMO - Armin Soft SemiBold' ), get_option( $local_key ) );

		// Generic-only entries → the option is deleted (mirrors Style_Fonts::update_fonts()).
		update_option( $local_key, array( 'serif, sans-serif' ), false );
		Fonts_Service::normalize_collected_fonts( $post_id );
		$this->assertFalse( get_option( $local_key ) );
	}

	// ---------------------------------------------------------------------
	// normalize_fonts_to_enqueue (the RENDER-TIME consumption-seam half).
	// ---------------------------------------------------------------------

	/**
	 * Contract 18 §7 — the durable native-path half: cache invalidation re-collects RAW
	 * stack/`var()` values AFTER the prime-time option rewrite (live-verified on page 2858), so
	 * `Frontend::$fonts_to_enqueue` itself must normalize at the consumption seam or the exact-key
	 * catalog lookup misses again and the page natively loads no fonts.
	 */
	public function test_normalize_fonts_to_enqueue_rewrites_the_frontend_list_in_place() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			$this->markTestSkipped( 'Elementor not loaded.' );
		}
		$frontend = \Elementor\Plugin::instance()->frontend;
		$previous = $frontend->fonts_to_enqueue;
		try {
			// The EXACT shapes observed at render time on page 2858 (raw stack + var token) plus
			// an already-bare name (idempotence) and a generic-only entry (dropped).
			$frontend->fonts_to_enqueue = array( 'Fraunces, serif', 'Inter', 'serif' );
			Fonts_Service::normalize_fonts_to_enqueue();
			$this->assertSame( array( 'Fraunces', 'Inter' ), $frontend->fonts_to_enqueue );

			// Every survivor must hit the catalog exactly (the native enqueue key — §7 guard proxy).
			if ( class_exists( '\Elementor\Fonts' ) ) {
				foreach ( $frontend->fonts_to_enqueue as $family ) {
					$this->assertNotFalse( \Elementor\Fonts::get_font_type( $family ) );
				}
			}

			// Idempotent: a second pass is a no-op.
			Fonts_Service::normalize_fonts_to_enqueue();
			$this->assertSame( array( 'Fraunces', 'Inter' ), $frontend->fonts_to_enqueue );
		} finally {
			$frontend->fonts_to_enqueue = $previous;
		}
	}

	/** The boot wiring registers BOTH consumption-seam hooks (wp_head path + direct print paths). */
	public function test_frontend_normalization_hooks_are_registered() {
		Fonts_Service::register_frontend_normalization();
		$this->assertNotFalse(
			has_action(
				'elementor/frontend/after_enqueue_post_styles',
				array( Fonts_Service::class, 'normalize_fonts_to_enqueue' )
			)
		);
		$this->assertNotFalse(
			has_action(
				'elementor/fonts/register_styles',
				array( Fonts_Service::class, 'normalize_fonts_to_enqueue' )
			)
		);
	}

	// ---------------------------------------------------------------------
	// install(): sniffing, storage, mime scoping, registration.
	// ---------------------------------------------------------------------

	/** Magic-byte sniffing accepts the four font formats and rejects junk. */
	public function test_sniff_font_format_magic_bytes() {
		$this->assertSame( 'woff2', Fonts_Service::sniff_font_format( self::FAKE_WOFF2 ) );
		$this->assertSame( 'woff', Fonts_Service::sniff_font_format( "wOFF\x00pad" ) );
		$this->assertSame( 'ttf', Fonts_Service::sniff_font_format( "\x00\x01\x00\x00pad" ) );
		$this->assertSame( 'ttf', Fonts_Service::sniff_font_format( 'truetype-mac' ) );
		$this->assertSame( 'otf', Fonts_Service::sniff_font_format( 'OTTOpad' ) );
		$this->assertNull( Fonts_Service::sniff_font_format( '<svg onload=x>' ) );
		$this->assertNull( Fonts_Service::sniff_font_format( '' ) );
	}

	/** Weight normalization: numerics pass, normal/bold map, junk rejected. */
	public function test_normalize_weight() {
		$this->assertSame( '400', Fonts_Service::normalize_weight( 'normal' ) );
		$this->assertSame( '700', Fonts_Service::normalize_weight( 'bold' ) );
		$this->assertSame( '550', Fonts_Service::normalize_weight( 550 ) );
		$this->assertSame( '100', Fonts_Service::normalize_weight( '100' ) );
		$this->assertNull( Fonts_Service::normalize_weight( '100 900' ) );
		$this->assertNull( Fonts_Service::normalize_weight( 'heavy' ) );
		$this->assertNull( Fonts_Service::normalize_weight( 0 ) );
	}

	/** Non-font bytes are rejected with VALIDATION_FAILED. */
	public function test_install_rejects_non_font_bytes() {
		$result = Fonts_Service::install(
			array(
				'source' => base64_encode( '<script>alert(1)</script>' ),
				'family' => 'Evil Face',
			)
		);
		$this->assertWPError( $result );
		$this->assertSame( 'VALIDATION_FAILED', $result->get_error_code() );
	}

	/** A woff2 install stores the attachment and registers the face (S4 happy path). */
	public function test_install_stores_the_face_and_registers_it() {
		if ( ! Fonts_Service::pro_custom_fonts_available() && null === $this->active_kit() ) {
			$this->markTestSkipped( 'Neither Pro Custom Fonts nor an active Elementor kit is available.' );
		}

		$result = Fonts_Service::install(
			array(
				'source' => base64_encode( self::FAKE_WOFF2 ),
				'family' => 'Novaletra Serif CF',
				'weight' => 700,
				'style'  => 'normal',
			)
		);
		$this->assertIsArray( $result );
		$this->assertSame( 'Novaletra Serif CF', $result['family'] );
		$this->assertSame( '700', $result['weight'] );
		$this->assertSame( 'woff2', $result['format'] );

		// The file landed under uploads as a real attachment with the font mime.
		$attachment_id = (int) $result['attachment_id'];
		$this->assertGreaterThan( 0, $attachment_id );
		$this->assertSame( 'font/woff2', get_post_mime_type( $attachment_id ) );
		$path = get_attached_file( $attachment_id );
		$this->assertFileExists( $path );
		$this->assertStringStartsWith( 'wOF2', (string) file_get_contents( $path ) );

		// The @font-face block names the family + face.
		$this->assertStringContainsString( "font-family: 'Novaletra Serif CF'", $result['font_face'] );
		$this->assertStringContainsString( 'font-weight: 700', $result['font_face'] );

		if ( Fonts_Service::pro_custom_fonts_available() ) {
			$this->assertSame( 'pro_custom_fonts', $result['registered_via'] );
			$posts = get_posts(
				array(
					'post_type'      => Fonts_Service::PRO_FONT_CPT,
					'title'          => 'Novaletra Serif CF',
					'post_status'    => 'any',
					'posts_per_page' => 1,
					'fields'         => 'ids',
				)
			);
			$this->assertNotEmpty( $posts, 'The elementor_font CPT post must exist.' );
			$rows = get_post_meta( (int) $posts[0], Fonts_Service::PRO_FONT_FILES_META, true );
			$this->assertIsArray( $rows );
			$this->assertSame( '700', (string) $rows[0]['font_weight'] );
			$this->assertSame( $attachment_id, (int) $rows[0]['woff2']['id'] );
			$face_meta = get_post_meta( (int) $posts[0], Fonts_Service::PRO_FONT_FACE_META, true );
			$this->assertStringContainsString( 'Novaletra Serif CF', (string) $face_meta );
			// The cached family list was invalidated so additional_fonts re-registers the family.
			$this->assertFalse( get_option( Fonts_Service::PRO_FONTS_LIST_OPTION ) );
		} else {
			$this->assertSame( 'kit_custom_css', $result['registered_via'] );
			$kit = $this->active_kit();
			$css = $kit->get_settings( 'custom_css' );
			// AF1 inverse-trap: the kit setting stays a plain STRING carrying the marker-wrapped block.
			$this->assertIsString( $css );
			$this->assertStringContainsString( '/* emcp-font:novaletra-serif-cf-700-normal */', $css );
			$this->assertStringContainsString( "font-family: 'Novaletra Serif CF'", $css );
		}

		// S4: font mimes are allowed ON THIS PATH ONLY — the global allowlist stays font-free.
		$this->assertArrayNotHasKey( 'woff2', get_allowed_mime_types() );
		$this->assertFalse( in_array( 'font/woff2', get_allowed_mime_types(), true ) );
	}

	/** Re-installing the same weight+style upserts the Pro repeater row. */
	public function test_install_is_upsert_per_weight_style_row_on_pro() {
		if ( ! Fonts_Service::pro_custom_fonts_available() ) {
			$this->markTestSkipped( 'Pro Custom Fonts unavailable.' );
		}

		$args   = array(
			'source' => base64_encode( self::FAKE_WOFF2 ),
			'family' => 'Armin Soft',
			'weight' => '600',
		);
		$first  = Fonts_Service::install( $args );
		$second = Fonts_Service::install( $args ); // Same face re-installed → row replaced, not duplicated.
		$this->assertIsArray( $first );
		$this->assertIsArray( $second );

		$posts = get_posts(
			array(
				'post_type'      => Fonts_Service::PRO_FONT_CPT,
				'title'          => 'Armin Soft',
				'post_status'    => 'any',
				'posts_per_page' => -1,
				'fields'         => 'ids',
			)
		);
		$this->assertCount( 1, $posts, 'Re-installing must reuse the family CPT post.' );
		$rows = get_post_meta( (int) $posts[0], Fonts_Service::PRO_FONT_FILES_META, true );
		$this->assertCount( 1, $rows, 'Same weight+style must upsert the row, not append.' );
	}

	// ---------------------------------------------------------------------
	// REST surface: POST /design/fonts/install.
	// ---------------------------------------------------------------------

	/** The route denies non-manage users (403). */
	public function test_route_requires_cap_manage() {
		if ( ! class_exists( '\Elementor\Ultra\Rest\Fonts_Controller' ) ) {
			$this->markTestSkipped( 'Fonts_Controller is not loaded.' );
		}
		$this->boot_rest();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'subscriber' ) ) );

		$request = new WP_REST_Request( 'POST', '/elementor-ultra/v1/design/fonts/install' );
		$request->set_body_params(
			array(
				'source' => base64_encode( self::FAKE_WOFF2 ),
				'family' => 'Denied Face',
			)
		);
		$response = rest_do_request( $request );
		$this->assertSame( 403, $response->get_status() );
	}

	/** The route installs for an administrator and returns the success envelope. */
	public function test_route_installs_for_admin() {
		if ( ! class_exists( '\Elementor\Ultra\Rest\Fonts_Controller' ) ) {
			$this->markTestSkipped( 'Fonts_Controller is not loaded.' );
		}
		if ( ! Fonts_Service::pro_custom_fonts_available() && null === $this->active_kit() ) {
			$this->markTestSkipped( 'Neither Pro Custom Fonts nor an active Elementor kit is available.' );
		}
		$this->boot_rest();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );

		$request = new WP_REST_Request( 'POST', '/elementor-ultra/v1/design/fonts/install' );
		$request->set_body_params(
			array(
				'source' => base64_encode( self::FAKE_WOFF2 ),
				'family' => 'Route Face',
				'weight' => 'bold',
				'style'  => 'italic',
				'op_id'  => 'fonts-install-test-1',
			)
		);
		$response = rest_do_request( $request );
		$this->assertSame( 200, $response->get_status() );

		$data = $response->get_data();
		$this->assertTrue( $data['success'] );
		$this->assertSame( 'Route Face', $data['data']['family'] );
		$this->assertSame( '700', $data['data']['weight'] );
		$this->assertSame( 'italic', $data['data']['style'] );
		$this->assertContains( $data['data']['registered_via'], array( 'pro_custom_fonts', 'kit_custom_css' ) );
	}

	// ---------------------------------------------------------------------
	// Helpers.
	// ---------------------------------------------------------------------

	/** Boot a fresh REST server so the registrar's `rest_api_init` registration fires. */
	private function boot_rest(): void {
		global $wp_rest_server; // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- WP core REST global, standard test pattern.
		$wp_rest_server = new \WP_REST_Server(); // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited, WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedVariableFound -- WP core REST global, standard test pattern.
		do_action( 'rest_api_init', $wp_rest_server ); // phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- WP core hook.
	}

	/** The active Elementor kit document, or null. */
	private function active_kit() {
		if ( ! class_exists( '\Elementor\Plugin' ) || ! isset( \Elementor\Plugin::$instance->kits_manager ) ) {
			return null;
		}
		$kit = \Elementor\Plugin::$instance->kits_manager->get_active_kit();
		return ( $kit && method_exists( $kit, 'update_settings' ) ) ? $kit : null;
	}
}
