<?php
/**
 * Contract 18 §7 — Cluster G regression suite (wave 18).
 *
 * Covers the PHP halves of the §7 rows this cluster owns:
 *  - §7-AI S1: the document-settings ALLOWLIST (`Validator::validate_settings` + the
 *    `Document_Writer::apply_settings_merge` front-guard) — an object `custom_css` on PAGE settings
 *    (the R4 build-#1 fatal, AF1) is a hard `SETTINGS_INVALID`, never a write.
 *  - §7-AI S2: `Render_Verifier::verify` returns the frozen probe shape and never throws (the
 *    in-process dispatch fallback is MANDATORY where the loopback cannot connect — the wp-env case).
 *  - §7-AI S3: `Document_Writer` resolves nav-menu `menu` values to the canonical slug at save and
 *    flags unresolvable values as `UNBOUND_MENU` warnings (assert via the private resolver to stay
 *    Elementor-document independent).
 *  - M-e: the derived per-step batch op_id is SALTED with the step index, so two identical-route
 *    steps in one batch no longer collide into a silent idempotent replay.
 *  - Taxonomy appendix: `Error_Codes` carries the 31-code set incl. `SETTINGS_INVALID` +
 *    `RENDER_FAILED` with the frozen metadata.
 *  - Hardening residuals (wave-18 review):
 *    (a) `Backup_Service::rollback` runs the S1 settings allowlist on the SNAPSHOT settings — a
 *        pre-S1 snapshot carrying the AF1 object `custom_css` is a hard `SETTINGS_INVALID`, never
 *        a green re-persist of the sitewide fatal;
 *    (b) `Render_Verifier` loopback no longer passes a 2xx with an EMPTY body (status+marker-only
 *        was the lying-probe class) — empty/redirect responses fall through to the dispatch probe,
 *        a fatal-marker body fails outright.
 *
 * @package Elementor\Ultra\Tests
 */

namespace Elementor\Ultra\Tests;

use Elementor\Ultra\Core\Backup_Service;
use Elementor\Ultra\Core\Batch_Runner;
use Elementor\Ultra\Core\Document_Writer;
use Elementor\Ultra\Core\Render_Verifier;
use Elementor\Ultra\Error_Codes;
use Elementor\Ultra\Validator;
use WP_Error;
use WP_UnitTestCase;

/**
 * @group contract-18
 * @group cluster-g
 */
class Test_Contract18_Cluster_G extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
	}

	/* ---------------------------------------------------------------------------------------------
	 * Taxonomy appendix (SETTINGS_INVALID + RENDER_FAILED).
	 * ------------------------------------------------------------------------------------------ */

	public function test_error_codes_carry_the_31_code_set_with_the_contract18_appendices() {
		$all = Error_Codes::all();
		$this->assertCount( 31, $all );
		$this->assertContains( Error_Codes::SETTINGS_INVALID, $all );
		$this->assertContains( Error_Codes::RENDER_FAILED, $all );

		$meta = Error_Codes::meta();
		$this->assertSame( 422, $meta[ Error_Codes::SETTINGS_INVALID ]['http_status'] );
		$this->assertFalse( $meta[ Error_Codes::SETTINGS_INVALID ]['soft'] );
		$this->assertSame( 200, $meta[ Error_Codes::RENDER_FAILED ]['http_status'] );
		$this->assertTrue( $meta[ Error_Codes::RENDER_FAILED ]['soft'] );
	}

	/* ---------------------------------------------------------------------------------------------
	 * §7-AI S1 — the document-settings allowlist (kills AF1).
	 * ------------------------------------------------------------------------------------------ */

	public function test_validate_settings_rejects_the_af1_object_custom_css() {
		$errors = Validator::validate_settings(
			array( 'custom_css' => array( '$$type' => 'string', 'value' => 'Ym9keXt9' ) )
		);
		$this->assertCount( 1, $errors );
		$this->assertSame( Error_Codes::SETTINGS_INVALID, $errors[0]['code'] );
	}

	public function test_validate_settings_accepts_the_plain_string_custom_css() {
		$this->assertSame( array(), Validator::validate_settings( array( 'custom_css' => 'body { margin: 0; }' ) ) );
	}

	public function test_validate_settings_enforces_template_and_post_status_enums() {
		$this->assertSame( array(), Validator::validate_settings( array( 'template' => 'elementor_canvas' ) ) );
		$bad_tpl = Validator::validate_settings( array( 'template' => 'twentytwenty.php' ) );
		$this->assertSame( Error_Codes::SETTINGS_INVALID, $bad_tpl[0]['code'] );

		$this->assertSame( array(), Validator::validate_settings( array( 'post_status' => 'publish' ) ) );
		$bad_status = Validator::validate_settings( array( 'post_status' => 'banana' ) );
		$this->assertSame( Error_Codes::SETTINGS_INVALID, $bad_status[0]['code'] );
	}

	public function test_validate_settings_hide_title_accepts_bool_and_legacy_strings_only() {
		$this->assertSame( array(), Validator::validate_settings( array( 'hide_title' => true ) ) );
		$this->assertSame( array(), Validator::validate_settings( array( 'hide_title' => 'yes' ) ) );
		$this->assertSame( array(), Validator::validate_settings( array( 'hide_title' => '' ) ) );
		$bad = Validator::validate_settings( array( 'hide_title' => array( 'on' => true ) ) );
		$this->assertSame( Error_Codes::SETTINGS_INVALID, $bad[0]['code'] );
	}

	public function test_validate_settings_lets_unknown_keys_pass() {
		$this->assertSame(
			array(),
			Validator::validate_settings( array( 'background_background' => 'classic', 'future_key' => array( 'x' => 1 ) ) )
		);
	}

	public function test_apply_settings_merge_refuses_the_af1_shape_before_any_write() {
		$post_id = self::factory()->post->create( array( 'post_type' => 'page' ) );
		$result  = Document_Writer::apply_settings_merge(
			$post_id,
			array( 'custom_css' => array( 'raw' => 'Ym9keXt9' ) )
		);
		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( Error_Codes::SETTINGS_INVALID, $result->get_error_code() );
		// Nothing was written.
		$this->assertSame( '', (string) get_post_meta( $post_id, '_elementor_page_settings', true ) );
	}

	/* ---------------------------------------------------------------------------------------------
	 * §7-AI S2 — render verification probe shape (dispatch fallback is MANDATORY).
	 * ------------------------------------------------------------------------------------------ */

	public function test_render_verifier_returns_the_frozen_probe_shape_and_never_throws() {
		$post_id = self::factory()->post->create( array( 'post_type' => 'page', 'post_status' => 'draft' ) );
		$probe   = ( new Render_Verifier() )->verify( $post_id );

		$this->assertIsArray( $probe );
		foreach ( array( 'id', 'render_verified', 'method', 'http_status', 'fatal', 'checked_url' ) as $key ) {
			$this->assertArrayHasKey( $key, $probe );
		}
		$this->assertSame( $post_id, $probe['id'] );
		// A DRAFT must never take the unauthenticated loopback path (it would 404 by design).
		$this->assertSame( 'dispatch', $probe['method'] );
		$this->assertIsBool( $probe['render_verified'] );
	}

	public function test_render_verifier_loopback_does_not_pass_a_2xx_with_an_empty_body() {
		$post_id = self::factory()->post->create( array( 'post_type' => 'page', 'post_status' => 'publish' ) );

		// Intercept the loopback fetch: a 200 with an EMPTY body (the pre-hardening lying pass).
		$mock = static function () {
			return array(
				'headers'  => array(),
				'body'     => '',
				'response' => array(
					'code'    => 200,
					'message' => 'OK',
				),
			);
		};
		add_filter( 'pre_http_request', $mock );
		try {
			$probe = ( new Render_Verifier() )->verify( $post_id );
		} finally {
			remove_filter( 'pre_http_request', $mock );
		}

		// An empty 2xx proves nothing rendered — the verdict MUST come from the dispatch probe.
		$this->assertSame( 'dispatch', $probe['method'] );
		$this->assertIsBool( $probe['render_verified'] );
	}

	public function test_render_verifier_loopback_passes_a_2xx_with_a_real_body_and_fails_a_fatal_marker() {
		$post_id = self::factory()->post->create( array( 'post_type' => 'page', 'post_status' => 'publish' ) );

		$body = '<!doctype html><html><body><p>rendered</p></body></html>';
		$mock = static function () use ( &$body ) {
			return array(
				'headers'  => array(),
				'body'     => $body,
				'response' => array(
					'code'    => 200,
					'message' => 'OK',
				),
			);
		};
		add_filter( 'pre_http_request', $mock );
		try {
			$healthy = ( new Render_Verifier() )->verify( $post_id );
			$body    = 'before <p>There has been a critical error on this website</p> after';
			$fatal   = ( new Render_Verifier() )->verify( $post_id );
		} finally {
			remove_filter( 'pre_http_request', $mock );
		}

		$this->assertSame( 'loopback', $healthy['method'] );
		$this->assertTrue( $healthy['render_verified'] );

		$this->assertSame( 'loopback', $fatal['method'] );
		$this->assertFalse( $fatal['render_verified'] );
		$this->assertSame( 'There has been a critical error on this website', $fatal['fatal'] );
	}

	/* ---------------------------------------------------------------------------------------------
	 * Hardening (a) — rollback refuses snapshots whose settings the render path would fatal on.
	 * ------------------------------------------------------------------------------------------ */

	public function test_rollback_refuses_a_pre_s1_snapshot_carrying_the_af1_object_custom_css() {
		$post_id = self::factory()->post->create( array( 'post_type' => 'page' ) );

		// A synthetic PRE-S1 snapshot: valid payload shape, but settings carry the AF1 object
		// custom_css (the R4 build-#1 fatal). The S1 allowlist did not exist when it was taken.
		$meta_key = '_emcp_backup_1700000000';
		$payload  = array(
			'data'     => '[]',
			'settings' => array( 'custom_css' => array( 'raw' => 'Ym9keXt9' ) ),
			'ts'       => 1700000000,
		);
		update_post_meta( $post_id, $meta_key, wp_slash( (string) wp_json_encode( $payload ) ) );

		$result = Backup_Service::rollback( $post_id, $meta_key );

		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( Error_Codes::SETTINGS_INVALID, $result->get_error_code() );
		// Nothing was restored — the fatal settings never reached _elementor_page_settings.
		$this->assertSame( '', (string) get_post_meta( $post_id, '_elementor_page_settings', true ) );
	}

	public function test_rollback_settings_gate_is_not_force_bypassable() {
		$post_id  = self::factory()->post->create( array( 'post_type' => 'page' ) );
		$meta_key = '_emcp_backup_1700000001';
		$payload  = array(
			'data'     => '[]',
			'settings' => array( 'custom_css' => array( 'raw' => 'Ym9keXt9' ) ),
			'ts'       => 1700000001,
		);
		update_post_meta( $post_id, $meta_key, wp_slash( (string) wp_json_encode( $payload ) ) );

		// force:true overrides CONCURRENCY gates, never render-safety.
		$result = Backup_Service::rollback( $post_id, $meta_key, false, null, true );

		$this->assertInstanceOf( WP_Error::class, $result );
		$this->assertSame( Error_Codes::SETTINGS_INVALID, $result->get_error_code() );
	}

	/* ---------------------------------------------------------------------------------------------
	 * §7-AI S3 — nav-menu slug resolution at save / UNBOUND_MENU flag.
	 * ------------------------------------------------------------------------------------------ */

	public function test_writer_resolves_nav_menu_values_and_flags_unbound_menus() {
		$menu_id = wp_create_nav_menu( 'Cluster G Menu' );
		$menu    = wp_get_nav_menu_object( $menu_id );

		$elements = array(
			array(
				'id'         => 'nav0001',
				'elType'     => 'widget',
				'widgetType' => 'nav-menu',
				'settings'   => array( 'menu' => 'Cluster G Menu' ), // by NAME — resolves to the slug.
			),
			array(
				'id'         => 'nav0002',
				'elType'     => 'widget',
				'widgetType' => 'nav-menu',
				'settings'   => array( 'menu' => 'definitely-not-a-menu' ),
			),
		);

		$warnings = array();
		$method   = new \ReflectionMethod( Document_Writer::class, 'resolve_nav_menus' );
		$method->setAccessible( true );
		$method->invokeArgs( null, array( &$elements, &$warnings ) );

		$this->assertSame( $menu->slug, $elements[0]['settings']['menu'] );
		$this->assertCount( 1, $warnings );
		$this->assertSame( 'UNBOUND_MENU', $warnings[0]['code'] );
		$this->assertSame( 'nav0002', $warnings[0]['element_id'] );
	}

	/* ---------------------------------------------------------------------------------------------
	 * M-e — the derived per-step batch op_id is salted with the step index.
	 * ------------------------------------------------------------------------------------------ */

	public function test_batch_step_op_ids_differ_for_identical_route_steps() {
		$runner = new Batch_Runner();
		$method = new \ReflectionMethod( Batch_Runner::class, 'step_op_id' );
		$method->setAccessible( true );

		$first  = $method->invoke( $runner, 'batch-op-123', 'documents/settings', 0 );
		$second = $method->invoke( $runner, 'batch-op-123', 'documents/settings', 1 );

		$this->assertNotSame( $first, $second );
		$this->assertLessThanOrEqual( 64, strlen( $first ) );
		$this->assertLessThanOrEqual( 64, strlen( $second ) );
		// The salt must survive the 64-char truncation even for a long batch op id + route.
		$long_a = $method->invoke( $runner, str_repeat( 'x', 60 ), 'documents/replace-tree', 0 );
		$long_b = $method->invoke( $runner, str_repeat( 'x', 60 ), 'documents/replace-tree', 1 );
		$this->assertNotSame( $long_a, $long_b );
	}
}
