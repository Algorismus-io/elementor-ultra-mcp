<?php
/**
 * WP-F06 — The AUTHORITATIVE dry_run round-trip suite (14-fixtures-harness.md §3) + the
 * settings-merge regression ([S04/C3/R3]).
 *
 * For each capability-met `kind:"tree"` fixture: load `tree` + `settings`, call the companion
 * validator `\Elementor\Ultra\Validator::dry_run($elements, $settings)` (WP-P03), assert
 * `result.valid === fixture.expect.valid`, and on invalid assert the returned error-CODE SET equals
 * `fixture.expect.errors` (order-independent, §3 step 2d). The render assertion (S1, §3 step 3) is
 * present but SKIPPED with a clear reason until WP-S01 PASS.
 *
 * GATING (Wave-1 skeleton): `Validator::dry_run()` is WP-P03. Until that class exists this suite
 * `markTestSkipped()`s with a clear message (never fails) so the harness lands in Wave 1; WP-P03's DoD
 * flips it on. Likewise the merge-regression test skips until `Document::update_settings()` is
 * reachable via the companion settings controller.
 *
 * @package Elementor\Ultra\Tests
 */

namespace Elementor\Ultra\Tests;

use WP_UnitTestCase;

/**
 * @group fixtures
 * @group dry-run
 */
class Test_Dry_Run_Fixtures extends WP_UnitTestCase {

	/**
	 * @var Fixture_Loader
	 */
	private $loader;

	/**
	 * @var array<string,mixed>
	 */
	private $caps;

	public function set_up() {
		parent::set_up();
		$this->loader = new Fixture_Loader();
		$this->caps   = Fixture_Loader::live_capability_snapshot();

		// C3/R3: writes/dry-run no-op via is_editable_by_current_user() unless an editor is current.
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
	}

	/**
	 * Skip the whole suite with a clear message if the WP-P03 validator is not present yet.
	 *
	 * @return bool True if the validator is available.
	 */
	private function require_validator() {
		if ( ! class_exists( '\Elementor\Ultra\Validator' ) || ! method_exists( '\Elementor\Ultra\Validator', 'dry_run' ) ) {
			$this->markTestSkipped(
				'\Elementor\Ultra\Validator::dry_run() not available yet (WP-P03 pending). ' .
				'The fixtures harness lands in Wave 1; WP-P03 enables this authoritative round-trip.'
			);
			return false;
		}
		return true;
	}

	/**
	 * Data provider: every `kind:"tree"` fixture (gating is applied inside the test so skipped fixtures
	 * surface as skipped, not omitted).
	 *
	 * @return array<string,array{0:array<string,mixed>}>
	 */
	public function tree_fixtures() {
		$loader = new Fixture_Loader();
		$out    = array();
		foreach ( $loader->load_by_kind( 'tree' ) as $env ) {
			$out[ $env['__id'] ] = array( $env );
		}
		// PHPUnit requires at least one data set; provide a sentinel so the suite is discoverable
		// even before any tree fixtures exist on a given checkout.
		if ( empty( $out ) ) {
			$out['__no_fixtures__'] = array( array( '__id' => '__no_fixtures__', 'kind' => 'tree', 'expect' => array( 'valid' => true ) ) );
		}
		return $out;
	}

	/**
	 * @dataProvider tree_fixtures
	 *
	 * @param array<string,mixed> $env Decoded fixture envelope.
	 */
	public function test_dry_run_verdict_and_error_set( array $env ) {
		if ( '__no_fixtures__' === $env['__id'] ) {
			$this->markTestSkipped( 'No tree fixtures present in packages/shared/fixtures (WP-Q01 adds the corpus).' );
			return;
		}
		if ( ! Fixture_Loader::is_runnable( $env, $this->caps ) ) {
			$this->markTestSkipped( "Fixture '{$env['__id']}' requires unmet on this install (capability-gated)." );
			return;
		}
		if ( ! $this->require_validator() ) {
			return;
		}

		$elements = isset( $env['tree'] ) ? $env['tree'] : array();
		$settings = isset( $env['settings'] ) ? $env['settings'] : array();

		$result = \Elementor\Ultra\Validator::dry_run( $elements, $settings );

		$valid = is_array( $result ) ? ( ! empty( $result['valid'] ) ) : ( isset( $result->valid ) && $result->valid );
		$this->assertSame(
			(bool) $env['expect']['valid'],
			(bool) $valid,
			"dry_run verdict mismatch for fixture '{$env['__id']}'."
		);

		if ( empty( $env['expect']['valid'] ) ) {
			$errors    = is_array( $result ) && isset( $result['errors'] ) ? $result['errors'] : array();
			$got_codes = array();
			foreach ( $errors as $e ) {
				$code = is_array( $e ) ? ( isset( $e['code'] ) ? $e['code'] : null ) : ( isset( $e->code ) ? $e->code : null );
				if ( null !== $code ) {
					$got_codes[] = $code;
				}
			}
			$want = isset( $env['expect']['errors'] ) ? (array) $env['expect']['errors'] : array();
			sort( $got_codes );
			sort( $want );
			$this->assertSame(
				$want,
				array_values( array_unique( $got_codes ) ),
				"dry_run error-code SET mismatch for fixture '{$env['__id']}'."
			);
		}
	}

	/**
	 * Render assertion / S1 regression (§3 step 3) — gated SKIP until Spike S01 PASS. The per-fixture
	 * primed-CSS assertion (prime-css emits per-breakpoint CSS containing the expected selectors) is
	 * carried here so the gate is VISIBLE; WP-Q06 owns the standalone render-assertion suite once S01
	 * passes (Implementation Notes).
	 */
	public function test_render_assertion_is_gated_until_s01() {
		$this->markTestSkipped(
			'blocked on WP-S01 PASS: the prime-css render assertion (per-breakpoint CSS contains the ' .
			'expected local-style / global-class selectors) is enabled after Spike S01 (§3 step 3).'
		);
	}

	/**
	 * Settings deep-merge regression ([S04/C3/R3], SUMMARY.md C3/R3). Seeds a page with the fixture's
	 * `merge_regression.seed` (≥3 settings of different types incl. a nested map AND a repeater), applies
	 * the `patch` (one top-level key + one nested sub-key), and asserts the omitted top-level key AND the
	 * omitted nested sibling (e.g. padding.left) AND both repeater rows SURVIVE unchanged while the
	 * patched keys updated. FAILS if the controller bare-saves (REPLACE) instead of update_settings()
	 * (deep merge). The current user is an administrator (set in set_up) or save()/update_settings()
	 * no-op via is_editable_by_current_user() (C3).
	 */
	public function test_settings_merge_regression() {
		$fixtures = $this->loader->load_by_kind( 'design' );
		$merge    = null;
		foreach ( $fixtures as $env ) {
			if ( isset( $env['merge_regression'] ) && is_array( $env['merge_regression'] ) ) {
				$merge = $env['merge_regression'];
				break;
			}
		}
		if ( null === $merge ) {
			$this->markTestSkipped( 'No settings-merge regression fixture found (trees/design/page-settings.merge-regression.json).' );
			return;
		}

		// The merge is performed by Document::update_settings() (deep array_replace_recursive), reachable
		// via the companion settings controller (WP-P06). Until that controller exists, skip with reason.
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			$this->markTestSkipped( 'Elementor not active; cannot exercise Document::update_settings().' );
			return;
		}

		$post_id = self::factory()->post->create( array( 'post_type' => 'page' ) );
		$document = \Elementor\Plugin::$instance->documents->get( $post_id );
		if ( ! $document || ! method_exists( $document, 'update_settings' ) ) {
			$this->markTestSkipped(
				'Document::update_settings() not reachable (WP-P06 settings controller pending). ' .
				'This regression is enabled by WP-P06 DoD ([S04/C3/R3]).'
			);
			return;
		}

		// Seed, then PATCH via update_settings (deep merge — NOT a bare save()).
		$document->update_settings( $merge['seed'] );
		$document->save( array() );
		$document->update_settings( $merge['patch'] );
		$document->save( array() );

		$after = get_post_meta( $post_id, '_elementor_page_settings', true );
		$after = is_array( $after ) ? $after : array();

		foreach ( (array) $merge['survives'] as $path => $expected ) {
			$this->assertSame(
				$expected,
				$this->dot_get( $after, $path ),
				"settings-merge regression: '{$path}' should SURVIVE the partial patch unchanged " .
				'(a bare save() would have wiped it — [S04/C3/R3]).'
			);
		}
		foreach ( (array) $merge['updates'] as $path => $expected ) {
			$this->assertSame(
				$expected,
				$this->dot_get( $after, $path ),
				"settings-merge regression: '{$path}' should be UPDATED by the patch."
			);
		}
	}

	/**
	 * Read a dotted path (supporting numeric repeater indices, e.g. `links.0.label`) from a nested array.
	 *
	 * @param array<string,mixed> $arr  Nested array.
	 * @param string              $path Dotted path.
	 * @return mixed|null
	 */
	private function dot_get( array $arr, $path ) {
		$node = $arr;
		foreach ( explode( '.', $path ) as $seg ) {
			if ( is_array( $node ) && array_key_exists( $seg, $node ) ) {
				$node = $node[ $seg ];
			} else {
				return null;
			}
		}
		return $node;
	}
}
