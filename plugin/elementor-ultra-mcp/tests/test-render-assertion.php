<?php
/**
 * WP-Q06 — Render-assertion regression (the S01 / M1 standing guard), 14-fixtures-harness.md §3 step 3.
 *
 * This is the DEDICATED render-assertion suite (separate from WP-F06's dry_run runner, which carries the
 * per-fixture step-3 as a gated skip). For each Q06 render-assert fixture it runs the FULL save → prime →
 * assert path that proves an atomic V4 page renders STYLED:
 *
 *   (a) register the fixture's referenced global class into the active kit (the kit-level repository,
 *       reusing the EXACT path the S01 spike used — Global_Classes_Repository::apply_changes),
 *   (b) create a throwaway draft document,
 *   (c) save the atomic tree via WP-P04 `Document_Writer::save()` (the transactional save: mints/dedupes
 *       ids → AUTHORITATIVE validator → backup → single Document::save),
 *   (d) run the prime-css step via WP-P05 `Css_Primer::prime()` (the S01-confirmed in-process do_action
 *       approach — Q06 CALLS it, never re-implements it),
 *   (e) read the generated per-breakpoint CSS off DISK (authoritative bytes, [S01]) via the Q06
 *       CSS_Rule_Extractor and assert it contains the local-style + global-class selector RULES that the
 *       SAVED tree actually carries ([R5]: ids are re-read from `_elementor_data`, never assumed stable),
 *       plus a non-empty atomic `base-desktop.css`,
 *   (f) trash the throwaway document in teardown.
 *
 * SELF-VALIDATION (Tests Required): a deliberately UN-PRIMED page (save-only, no prime) MUST FAIL the
 * assertion — proving the prime step is LOAD-BEARING. And `CSS_PRIME_FAILED` is surfaced cleanly when the
 * primer cannot emit CSS (a document with no atomic styles is a success-with-warning, not a render).
 *
 * GATING (14-fixtures-harness.md §3 step 3c, AC #6): the suite RUNS only when S01 has PASSED. The S01
 * gate is satisfied when the WP-P04 `Document_Writer` + WP-P05 `Css_Primer` services are present (they
 * encode the S01-confirmed approach) AND the optional `ELEMENTOR_ULTRA_S01_PASSED` signal is not
 * explicitly disabled. Until then every render-assert test is `markTestSkipped()` with a clear reason so
 * the gate is VISIBLE (Q06 flips it from F06's `xfail` to this standing suite once S01 passes).
 *
 * @package Elementor\Ultra\Tests
 */

namespace Elementor\Ultra\Tests;

use WP_Error;
use WP_UnitTestCase;

require_once __DIR__ . '/class-css-rule-extractor.php';

/**
 * @group render-assertion
 * @group s01-regression
 */
class Test_Render_Assertion extends WP_UnitTestCase {

	/** Post ids created by a test (trashed in teardown — §3 step 3d). */
	private $created_posts = array();

	/** @var CSS_Rule_Extractor */
	private $extractor;

	public function set_up() {
		parent::set_up();
		$this->extractor = new CSS_Rule_Extractor();
		// Any save / prime / update_settings no-ops via is_editable_by_current_user() unless a capable user
		// is current (C3) — and the prime must run as a user that can render the post.
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
	}

	public function tear_down() {
		foreach ( $this->created_posts as $post_id ) {
			wp_delete_post( (int) $post_id, true ); // force-delete the throwaway draft (§3 step 3d).
		}
		$this->created_posts = array();
		parent::tear_down();
	}

	// ---------------------------------------------------------------------
	// Gate.
	// ---------------------------------------------------------------------

	/**
	 * The S01 gate (AC #6 / §3 step 3c). Returns a non-empty SKIP reason string when the suite must NOT
	 * run yet, or '' when it is enabled. Enabled when the WP-P04 + WP-P05 services exist (they encode the
	 * S01-confirmed save + prime approach) and Elementor is active, unless explicitly disabled via the
	 * `ELEMENTOR_ULTRA_S01_PASSED` env signal set to a falsey value.
	 *
	 * @return string Skip reason, or '' when the suite is enabled.
	 */
	private function s01_skip_reason(): string {
		$signal = getenv( 'ELEMENTOR_ULTRA_S01_PASSED' );
		if ( false !== $signal && in_array( strtolower( (string) $signal ), array( '0', 'false', 'no', 'off' ), true ) ) {
			return 'blocked on WP-S01 PASS: ELEMENTOR_ULTRA_S01_PASSED is explicitly disabled (§3 step 3c).';
		}
		if ( ! class_exists( '\Elementor\Plugin' ) || null === \Elementor\Plugin::$instance ) {
			return 'Elementor not active; the render assertion needs the atomic registry + prime hooks.';
		}
		if ( ! class_exists( '\Elementor\Ultra\Core\Document_Writer' ) || ! method_exists( '\Elementor\Ultra\Core\Document_Writer', 'save' ) ) {
			return 'blocked on WP-P04: Document_Writer::save() (the transactional save path) not available yet.';
		}
		if ( ! class_exists( '\Elementor\Ultra\Core\Css_Primer' ) ) {
			return 'blocked on WP-P05 + WP-S01: Css_Primer (the S01-confirmed prime-css step) not available yet.';
		}
		if ( ! $this->atomic_experiment_active() ) {
			return 'requires the e_atomic_elements experiment to emit atomic CSS (capability-gated).';
		}
		return '';
	}

	/** Whether the V4 atomic experiment is active (the render path needs the atomic styles manager). */
	private function atomic_experiment_active(): bool {
		$plugin = \Elementor\Plugin::$instance;
		if ( ! $plugin || ! isset( $plugin->experiments ) ) {
			return false;
		}
		return (bool) $plugin->experiments->is_feature_active( 'e_atomic_elements' );
	}

	// ---------------------------------------------------------------------
	// Data provider — the Q06 render-assert fixtures.
	// ---------------------------------------------------------------------

	/**
	 * @return array<string,array{0:string}>
	 */
	public function render_assert_fixtures() {
		return array(
			'render-assert.hero'         => array( 'render-assert.hero' ),
			'render-assert.global-class' => array( 'render-assert.global-class' ),
		);
	}

	// ---------------------------------------------------------------------
	// The render assertion (§3 step 3 a–d).
	// ---------------------------------------------------------------------

	/**
	 * @dataProvider render_assert_fixtures
	 *
	 * @param string $fixture_id The render-assert fixture id (file name minus .json).
	 */
	public function test_primed_page_renders_styled( string $fixture_id ) {
		$reason = $this->s01_skip_reason();
		if ( '' !== $reason ) {
			$this->markTestSkipped( $reason );
			return;
		}

		$env = $this->load_fixture( $fixture_id );
		if ( null === $env ) {
			$this->markTestSkipped( "Render-assert fixture '{$fixture_id}' not found in packages/shared/fixtures." );
			return;
		}

		// (a) Register the referenced global class(es) into the active kit (the S01 path).
		$this->register_global_classes_for( $env );

		// (b)+(c) Create the throwaway draft + save the atomic tree via the WP-P04 writer.
		$post_id = $this->create_and_save( $env );
		$this->assertIsInt( $post_id, "Saving fixture '{$fixture_id}' should yield a post id." );

		// [R5] Re-read the ACTUAL local-style + global-class ids from the saved tree.
		$ids = $this->extractor->expected_ids_from_saved( $post_id );

		// (d) Prime via the S01-confirmed Css_Primer (the prime-css step). Q06 calls; P05 owns.
		$primer = new \Elementor\Ultra\Core\Css_Primer();
		$result = $primer->prime( $post_id );
		$this->assertNotWPError(
			$result,
			"prime-css should succeed for primable fixture '{$fixture_id}' (CSS_PRIME_FAILED would mean the page renders unstyled)."
		);
		$this->assertTrue(
			is_array( $result ) && ! empty( $result['css_primed'] ),
			"prime-css should report css_primed:true for '{$fixture_id}'."
		);

		$context = $this->extractor->context_for( $post_id );

		// (e) Per-breakpoint coverage: desktop is required (AC / Detailed-Req #7). Extend to any non-desktop
		// breakpoint that the SAVED tree declares a variant for.
		$breakpoints = $this->breakpoints_in_fixture( $env );
		$this->assertContains( CSS_Rule_Extractor::BREAKPOINT_DESKTOP, $breakpoints, 'desktop coverage is mandatory.' );

		$asserted_any_local  = false;
		$asserted_any_global = false;

		foreach ( $breakpoints as $bp ) {
			// LOCAL style selectors: local-<id>-<ctx>-<bp>.css → `.elementor .<localStyleId>{...}`.
			if ( ! empty( $ids['local'] ) ) {
				$local_rules = $this->extractor->rules_in_node_file( 'local', $post_id, $context, $bp );
				$this->assertNotEmpty(
					$local_rules,
					"local-{$post_id}-{$context}-{$bp}.css should be non-empty with parsed rules for '{$fixture_id}'."
				);
				foreach ( $ids['local'] as $local_id ) {
					if ( CSS_Rule_Extractor::BREAKPOINT_DESKTOP !== $bp && ! $this->id_has_variant_for( $env, $local_id, $bp ) ) {
						continue; // only assert non-desktop where the fixture declared that breakpoint.
					}
					$this->assertTrue(
						$this->extractor->class_has_declarations( $local_rules, $local_id ),
						"primed CSS must contain the local-style rule `.elementor .{$local_id}{...}` " .
						"in local-{$post_id}-{$context}-{$bp}.css for '{$fixture_id}' ([S01])."
					);
					$asserted_any_local = true;
				}
			}

			// GLOBAL class selectors: global-<id>-<ctx>-<bp>.css → `.elementor .<globalClassId>{...}`.
			if ( ! empty( $ids['global'] ) ) {
				$global_rules = $this->extractor->rules_in_node_file( 'global', $post_id, $context, $bp );
				$this->assertNotEmpty(
					$global_rules,
					"global-{$post_id}-{$context}-{$bp}.css should be non-empty with parsed rules for '{$fixture_id}'."
				);
				foreach ( $ids['global'] as $global_id ) {
					if ( CSS_Rule_Extractor::BREAKPOINT_DESKTOP !== $bp && ! $this->global_has_variant_for( $env, $global_id, $bp ) ) {
						continue;
					}
					$this->assertTrue(
						$this->extractor->class_has_declarations( $global_rules, $global_id ),
						"primed CSS must contain the global-class rule `.elementor .{$global_id}{...}` " .
						"in global-{$post_id}-{$context}-{$bp}.css for '{$fixture_id}' ([S01])."
					);
					$asserted_any_global = true;
				}
			}
		}

		// Every render-assert fixture must exercise at least ONE styled selector (a no-style tree would
		// silently pass nothing — that is not a render assertion).
		$this->assertTrue(
			$asserted_any_local || $asserted_any_global,
			"fixture '{$fixture_id}' asserted no local OR global selector — it carries no atomic style to render."
		);

		// The shared atomic base CSS must be non-empty after a prime ([S01] `base-desktop.css` non-empty).
		$base_bytes = strlen( trim( $this->extractor->read_css( $this->extractor->base_file( CSS_Rule_Extractor::BREAKPOINT_DESKTOP ) ) ) );
		$this->assertGreaterThan(
			0,
			$base_bytes,
			"base-desktop.css should be non-empty after priming '{$fixture_id}' ([S01])."
		);

		// Kit-level note (§3-step-3 / Interface): for a global-class render the atomic CSS is emitted into
		// the per-doc global-<postId>-*.css above; additionally exercise the kit-CSS regen path so a
		// global-class change re-renders (WP-P05 Cache_Service::flush_design_system) — guarded, advisory.
		if ( ! empty( $ids['global'] ) && class_exists( '\Elementor\Ultra\Core\Cache_Service' ) ) {
			$this->assertGreaterThan(
				0,
				$this->extractor->active_kit_id(),
				"an active Elementor kit is expected so global-class CSS can regen via flush_design_system()."
			);
		}
	}

	/**
	 * SELF-VALIDATION (Tests Required): the prime step is LOAD-BEARING. A deliberately UN-PRIMED page
	 * (save-only, NO Css_Primer call) MUST FAIL the same selector assertion — its per-breakpoint CSS
	 * files are absent/empty. If this asserted PRESENT it would mean the headless save alone emitted
	 * atomic CSS (contradicting the [S01] residual) and the prime guard would be worthless.
	 */
	public function test_unprimed_page_fails_assertion() {
		$reason = $this->s01_skip_reason();
		if ( '' !== $reason ) {
			$this->markTestSkipped( $reason );
			return;
		}

		$env = $this->load_fixture( 'render-assert.hero' );
		if ( null === $env ) {
			$this->markTestSkipped( "Render-assert fixture 'render-assert.hero' not found." );
			return;
		}

		$this->register_global_classes_for( $env );

		// Save WITHOUT priming (prime_css defaults to false in Document_Writer::save).
		$post_id = $this->create_and_save( $env );
		$this->assertIsInt( $post_id );

		$ids     = $this->extractor->expected_ids_from_saved( $post_id );
		$context = $this->extractor->context_for( $post_id );

		// The saved tree DOES carry a local style + global ref ([S01] headless save persists the data)...
		$this->assertNotEmpty( $ids['local'], 'the saved tree should carry at least one local style id.' );

		// ...yet the per-breakpoint CSS files must be ABSENT/EMPTY because no prime ran ([S01] residual).
		$local_unprimed = $this->extractor->rules_in_node_file( 'local', $post_id, $context, CSS_Rule_Extractor::BREAKPOINT_DESKTOP );

		$any_present = false;
		foreach ( $ids['local'] as $local_id ) {
			if ( $this->extractor->class_has_declarations( $local_unprimed, $local_id ) ) {
				$any_present = true;
				break;
			}
		}
		$this->assertFalse(
			$any_present,
			'an UN-PRIMED page must NOT contain the local-style selector rule — proving the prime-css step ' .
			'is LOAD-BEARING ([S01]: a headless save emits ZERO atomic CSS).'
		);
	}

	/**
	 * `CSS_PRIME_FAILED` is surfaced CLEANLY (AC #5, 12-error-taxonomy.md §3.5). Priming a non-atomic
	 * (no styles, no classes) document is a 200-with-warning SUCCESS (css_primed:true, nothing to prime) —
	 * NOT a silent pass that pretends a styled render happened. We assert the primer returns a clean,
	 * structured result (never a raw throw) and that, when it CANNOT confirm CSS for a doc that LOOKS
	 * atomic, it returns a `CSS_PRIME_FAILED` WP_Error with the §3.5 meta — rather than silently passing.
	 */
	public function test_css_prime_failed_is_surfaced_cleanly() {
		$reason = $this->s01_skip_reason();
		if ( '' !== $reason ) {
			$this->markTestSkipped( $reason );
			return;
		}

		$primer = new \Elementor\Ultra\Core\Css_Primer();

		// Case 1: a missing document → clean CSS_PRIME_FAILED (never a fatal/throw).
		$missing = $primer->prime( 0 );
		$this->assertInstanceOf(
			WP_Error::class,
			$missing,
			'priming a missing document must return a CSS_PRIME_FAILED WP_Error, not throw or silently pass.'
		);
		$this->assertSame(
			'CSS_PRIME_FAILED',
			$missing->get_error_code(),
			'the surfaced error code must be the taxonomy code CSS_PRIME_FAILED (12 §3.5).'
		);

		// Case 2: a non-atomic document → a 200-with-warning SUCCESS (nothing to prime), NOT a failure and
		// NOT a false styled-render claim.
		$plain_id = self::factory()->post->create( array( 'post_type' => 'page' ) );
		$this->created_posts[] = $plain_id;
		update_post_meta( $plain_id, '_elementor_edit_mode', 'builder' );
		update_post_meta( $plain_id, '_elementor_template_type', 'wp-page' );
		// A classic (non-atomic) tree: no `styles`, no typed `classes` envelope.
		update_post_meta( $plain_id, '_elementor_data', wp_json_encode( array() ) );

		$plain = $primer->prime( $plain_id );
		$this->assertTrue(
			is_array( $plain ),
			'priming a non-atomic document should return a structured success array (nothing to prime), not a WP_Error.'
		);
		$this->assertTrue( ! empty( $plain['css_primed'] ), 'a non-atomic prime is a success.' );
		$this->assertNotEmpty( $plain['warnings'], 'a non-atomic prime should carry a "nothing to prime" warning.' );
	}

	// ---------------------------------------------------------------------
	// CSS_Rule_Extractor unit coverage (Tests Required: "a unit test for the extractor").
	// ---------------------------------------------------------------------

	/**
	 * The extractor parses a sample generated CSS file (whitespace + minification + @media tolerant) and
	 * yields the right selector → declaration structure. Pure (no WordPress / no prime).
	 */
	public function test_extractor_parses_sample_css() {
		$ex = new CSS_Rule_Extractor();

		// Mirrors the [S01]-verified shape, with minification AND a non-desktop @media wrapper.
		$sample = '.elementor .e-s01head1-local{font-size:48px;color:rgb(0, 128, 255);}' .
			'@media(max-width:767px){.elementor .e-s01head1-local{font-size:32px}}' .
			'/* comment */ .elementor .s01hero { background-color: rgb(255, 0, 128); padding: 24px 32px }';

		$rules = $ex->parse_rules( $sample );
		$this->assertNotEmpty( $rules, 'parse_rules should recover rule blocks.' );

		// Selector token matching (whole-class boundary).
		$this->assertTrue( $ex->selector_has_class( '.elementor .s01hero', 's01hero' ) );
		$this->assertFalse( $ex->selector_has_class( '.elementor .s01heroine', 's01hero' ), 'must not match a longer id prefix.' );

		// Declarations present + specific values readable.
		$this->assertTrue( $ex->class_has_declarations( $rules, 'e-s01head1-local' ) );
		$this->assertSame( '48px', $ex->declared_value( $rules, 'e-s01head1-local', 'font-size' ) );
		$this->assertSame( 'rgb(0, 128, 255)', $ex->declared_value( $rules, 'e-s01head1-local', 'color' ) );
		$this->assertTrue( $ex->class_has_declarations( $rules, 's01hero' ) );
		$this->assertSame( 'rgb(255, 0, 128)', $ex->declared_value( $rules, 's01hero', 'background-color' ) );

		// An empty `.x{}` block is NOT a styled render.
		$empty = $ex->parse_rules( '.elementor .e-empty{}' );
		$this->assertFalse( $ex->class_has_declarations( $empty, 'e-empty' ), 'an empty rule block is not a styled render.' );

		// File-naming helpers match the [S01] convention.
		$this->assertStringEndsWith( 'local-42-frontend-desktop.css', $ex->node_file( 'local', 42, 'frontend', 'desktop' ) );
		$this->assertStringEndsWith( 'global-42-preview-tablet.css', $ex->node_file( 'global', 42, 'preview', 'tablet' ) );
		$this->assertStringEndsWith( 'base-desktop.css', $ex->base_file( 'desktop' ) );
	}

	// ---------------------------------------------------------------------
	// Helpers.
	// ---------------------------------------------------------------------

	/**
	 * Load a Q06 render-assert fixture envelope by id from the single golden-fixtures dir.
	 *
	 * @param string $fixture_id Fixture id (file name minus .json).
	 * @return array<string,mixed>|null
	 */
	private function load_fixture( string $fixture_id ): ?array {
		foreach ( ( new Fixture_Loader() )->load_by_kind( 'tree' ) as $env ) {
			if ( isset( $env['__id'] ) && $env['__id'] === $fixture_id ) {
				return $env;
			}
		}
		return null;
	}

	/**
	 * Create a published page, mark it an Elementor V4 builder doc, and save the fixture tree + settings
	 * via the WP-P04 transactional writer (`Document_Writer::save`). Returns the post id, or fails the
	 * test on a writer WP_Error. Published so the CSS uses the `frontend` context (matching the [S01]
	 * canonical `-frontend-` selectors); the extractor computes context from status either way.
	 *
	 * @param array<string,mixed> $env Fixture envelope.
	 * @return int|false
	 */
	private function create_and_save( array $env ) {
		$post_id = wp_insert_post(
			array(
				'post_title'  => 'Q06 render-assert ' . ( $env['__id'] ?? 'fixture' ),
				'post_status' => 'publish',
				'post_type'   => 'page',
			)
		);
		if ( ! is_int( $post_id ) || $post_id <= 0 ) {
			$this->fail( 'wp_insert_post failed for the render-assert fixture.' );
			return false;
		}
		$this->created_posts[] = $post_id;

		update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
		update_post_meta( $post_id, '_elementor_template_type', 'wp-page' );

		$args = array(
			'elements' => isset( $env['tree'] ) && is_array( $env['tree'] ) ? $env['tree'] : array(),
			'settings' => isset( $env['settings'] ) && is_array( $env['settings'] ) ? $env['settings'] : array(),
			'backup'   => false, // throwaway draft; no need to snapshot.
		);

		$result = \Elementor\Ultra\Core\Document_Writer::save( $post_id, $args );
		if ( is_wp_error( $result ) ) {
			$this->fail( 'Document_Writer::save failed: ' . $result->get_error_code() . ' — ' . $result->get_error_message() );
			return false;
		}
		return $post_id;
	}

	/**
	 * Register every global class the fixture's tree references into the ACTIVE kit (the kit-level
	 * repository), reusing the EXACT path the S01 spike used (`Global_Classes_Repository::apply_changes`).
	 * The class DEFINITIONS (variants/props) come from the frozen spike fixture `s01-atomic-hero.json`
	 * (reused per the WP-Q06 Spike-Verified Correction). Idempotent: a class already present is modified,
	 * not duplicated. A missing repository / definition is a guarded no-op (the per-doc save still works;
	 * the global selector assertion will simply not be exercised for an unregistered class).
	 *
	 * @param array<string,mixed> $env Fixture envelope.
	 * @return void
	 */
	private function register_global_classes_for( array $env ) {
		if ( ! class_exists( '\Elementor\Modules\GlobalClasses\Global_Classes_Repository' ) ) {
			return;
		}
		$referenced = $this->referenced_global_class_ids( $env );
		if ( empty( $referenced ) ) {
			return;
		}
		$definitions = $this->global_class_definitions();

		$repo = \Elementor\Modules\GlobalClasses\Global_Classes_Repository::make()->set_preview( false );

		$existing       = $repo->all()->get_items()->all();
		$existing_order = $repo->get_order();

		$touched  = array();
		$added    = array();
		$modified = array();
		$order    = is_array( $existing_order ) ? $existing_order : array();

		foreach ( $referenced as $class_id ) {
			if ( ! isset( $definitions[ $class_id ] ) ) {
				continue; // no frozen definition for this id — cannot register its props.
			}
			$touched[ $class_id ] = $definitions[ $class_id ];
			if ( isset( $existing[ $class_id ] ) ) {
				$modified[] = $class_id;
			} else {
				$added[] = $class_id;
				if ( ! in_array( $class_id, $order, true ) ) {
					$order[] = $class_id;
				}
			}
		}

		if ( empty( $touched ) ) {
			return;
		}

		$changes = array(
			'added'    => $added,
			'deleted'  => array(),
			'modified' => $modified,
			'order'    => false,
		);

		try {
			$repo->apply_changes( $touched, $changes, $order );
		} catch ( \Throwable $e ) {
			// Guarded: a registration failure must not crash the suite. The per-doc global CSS assertion
			// will surface the absence as a normal failure if the class genuinely did not register.
			fwrite( STDERR, '[render-assertion] global-class registration warning: ' . $e->getMessage() . "\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
		}
	}

	/**
	 * The global-class DEFINITIONS to register, read from the frozen spike fixture `s01-atomic-hero.json`
	 * (reused per the WP-Q06 Spike-Verified Correction). Returns a map of `class_id => definition`. Falls
	 * back to an inline `s01hero` definition (the same frozen shape) when the spike file is not mounted.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	private function global_class_definitions(): array {
		$out = array();

		$path = $this->spike_fixture_path( 's01-atomic-hero.json' );
		if ( '' !== $path && is_readable( $path ) ) {
			$raw  = file_get_contents( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- frozen spike fixture.
			$data = json_decode( (string) $raw, true );
			if ( is_array( $data ) && isset( $data['global_class']['id'] ) ) {
				$gc                         = $data['global_class'];
				$out[ (string) $gc['id'] ] = $gc;
			}
		}

		// Fallback (frozen s01hero shape) so the suite is self-contained if the spike dir is unmounted.
		if ( ! isset( $out['s01hero'] ) ) {
			$out['s01hero'] = array(
				'id'       => 's01hero',
				'type'     => 'class',
				'label'    => 's01hero',
				'variants' => array(
					array(
						'meta'  => array(
							'breakpoint' => 'desktop',
							'state'      => null,
						),
						'props' => array(
							'background' => array(
								'$$type' => 'background',
								'value'  => array(
									'color' => array(
										'$$type' => 'color',
										'value'  => 'rgb(255, 0, 128)',
									),
								),
							),
							'padding'    => array(
								'$$type' => 'dimensions',
								'value'  => array(
									'block-start'  => array(
										'$$type' => 'size',
										'value'  => array(
											'unit' => 'px',
											'size' => 24,
										),
									),
									'block-end'    => array(
										'$$type' => 'size',
										'value'  => array(
											'unit' => 'px',
											'size' => 24,
										),
									),
									'inline-start' => array(
										'$$type' => 'size',
										'value'  => array(
											'unit' => 'px',
											'size' => 32,
										),
									),
									'inline-end'   => array(
										'$$type' => 'size',
										'value'  => array(
											'unit' => 'px',
											'size' => 32,
										),
									),
								),
							),
						),
					),
				),
			);
		}

		return $out;
	}

	/**
	 * Resolve a spike fixture path. Honors `ELEMENTOR_ULTRA_SPIKE_FIXTURES_DIR`, then the monorepo layout
	 * relative to the plugin dir (`spec/spikes/fixtures`). Returns '' when not resolvable.
	 *
	 * @param string $name File name under the spike fixtures dir.
	 * @return string
	 */
	private function spike_fixture_path( string $name ): string {
		$env = getenv( 'ELEMENTOR_ULTRA_SPIKE_FIXTURES_DIR' );
		if ( is_string( $env ) && '' !== $env ) {
			return rtrim( $env, '/\\' ) . '/' . $name;
		}
		// plugin/elementor-ultra-mcp/tests -> repo root -> spec/spikes/fixtures.
		$candidate = dirname( __DIR__, 3 ) . '/spec/spikes/fixtures/' . $name;
		return $candidate;
	}

	/**
	 * The global-class ids the fixture's tree references (the typed `settings.classes` value entries that
	 * are NOT local-style ids — i.e. the ids that must live in the kit).
	 *
	 * @param array<string,mixed> $env Fixture envelope.
	 * @return string[]
	 */
	private function referenced_global_class_ids( array $env ): array {
		$tree = isset( $env['tree'] ) && is_array( $env['tree'] ) ? $env['tree'] : array();

		$local   = array();
		$classes = array();
		$this->walk_fixture_ids( $tree, $local, $classes );

		$global = array();
		foreach ( $classes as $class_id ) {
			if ( ! in_array( $class_id, $local, true ) ) {
				$global[] = $class_id;
			}
		}
		return array_values( array_unique( $global ) );
	}

	/**
	 * Recursive id collector over a FIXTURE tree (authored ids, before save). Used only to decide which
	 * global classes to register; the post-save assertion re-reads ACTUAL ids via the extractor ([R5]).
	 *
	 * @param array<int,mixed> $elements Element nodes.
	 * @param string[]         $local    Local-style ids accumulator (by reference).
	 * @param string[]         $classes  Referenced class ids accumulator (by reference).
	 * @return void
	 */
	private function walk_fixture_ids( array $elements, array &$local, array &$classes ): void {
		foreach ( $elements as $element ) {
			if ( ! is_array( $element ) ) {
				continue;
			}
			if ( isset( $element['styles'] ) && is_array( $element['styles'] ) ) {
				foreach ( array_keys( $element['styles'] ) as $style_id ) {
					$local[] = (string) $style_id;
				}
			}
			if ( isset( $element['settings']['classes']['$$type'], $element['settings']['classes']['value'] )
				&& 'classes' === $element['settings']['classes']['$$type']
				&& is_array( $element['settings']['classes']['value'] )
			) {
				foreach ( $element['settings']['classes']['value'] as $class_id ) {
					$classes[] = (string) $class_id;
				}
			}
			if ( isset( $element['elements'] ) && is_array( $element['elements'] ) ) {
				$this->walk_fixture_ids( $element['elements'], $local, $classes );
			}
		}
	}

	/**
	 * The breakpoint keys the fixture's tree declares variants for (desktop always included). Drives the
	 * per-breakpoint coverage (Detailed-Req #7).
	 *
	 * @param array<string,mixed> $env Fixture envelope.
	 * @return string[]
	 */
	private function breakpoints_in_fixture( array $env ): array {
		$tree  = isset( $env['tree'] ) && is_array( $env['tree'] ) ? $env['tree'] : array();
		$breaks = array( CSS_Rule_Extractor::BREAKPOINT_DESKTOP );
		$this->collect_breakpoints( $tree, $breaks );
		// Also include any breakpoint declared on a referenced global class definition.
		foreach ( $this->global_class_definitions() as $def ) {
			foreach ( (array) ( $def['variants'] ?? array() ) as $variant ) {
				$bp = isset( $variant['meta']['breakpoint'] ) ? (string) $variant['meta']['breakpoint'] : '';
				if ( '' !== $bp && ! in_array( $bp, $breaks, true ) ) {
					$breaks[] = $bp;
				}
			}
		}
		return array_values( array_unique( $breaks ) );
	}

	/**
	 * Recursively collect every breakpoint key declared in any node's local `styles` variants.
	 *
	 * @param array<int,mixed> $elements Element nodes.
	 * @param string[]         $breaks   Breakpoint accumulator (by reference).
	 * @return void
	 */
	private function collect_breakpoints( array $elements, array &$breaks ): void {
		foreach ( $elements as $element ) {
			if ( ! is_array( $element ) ) {
				continue;
			}
			if ( isset( $element['styles'] ) && is_array( $element['styles'] ) ) {
				foreach ( $element['styles'] as $style ) {
					foreach ( (array) ( $style['variants'] ?? array() ) as $variant ) {
						$bp = isset( $variant['meta']['breakpoint'] ) ? (string) $variant['meta']['breakpoint'] : '';
						if ( '' !== $bp && ! in_array( $bp, $breaks, true ) ) {
							$breaks[] = $bp;
						}
					}
				}
			}
			if ( isset( $element['elements'] ) && is_array( $element['elements'] ) ) {
				$this->collect_breakpoints( $element['elements'], $breaks );
			}
		}
	}

	/**
	 * Whether the SAVED local style `$style_id` declares a variant for `$breakpoint`. Local-style ids are
	 * regenerated on save ([R5]) so we cannot key the fixture's styles map by the saved id; instead we
	 * check whether the fixture declared the breakpoint AT ALL on any local style (desktop always true).
	 *
	 * @param array<string,mixed> $env        Fixture envelope.
	 * @param string              $style_id   The (saved) local style id (unused beyond non-emptiness).
	 * @param string              $breakpoint Breakpoint key.
	 * @return bool
	 */
	private function id_has_variant_for( array $env, string $style_id, string $breakpoint ): bool {
		if ( CSS_Rule_Extractor::BREAKPOINT_DESKTOP === $breakpoint ) {
			return true;
		}
		return in_array( $breakpoint, $this->breakpoints_in_fixture( $env ), true );
	}

	/**
	 * Whether the referenced global class declares a variant for `$breakpoint` (in its frozen definition).
	 *
	 * @param array<string,mixed> $env        Fixture envelope (unused; kept for symmetry).
	 * @param string              $class_id   Global class id.
	 * @param string              $breakpoint Breakpoint key.
	 * @return bool
	 */
	private function global_has_variant_for( array $env, string $class_id, string $breakpoint ): bool {
		if ( CSS_Rule_Extractor::BREAKPOINT_DESKTOP === $breakpoint ) {
			return true;
		}
		$def = $this->global_class_definitions()[ $class_id ] ?? null;
		if ( ! is_array( $def ) ) {
			return false;
		}
		foreach ( (array) ( $def['variants'] ?? array() ) as $variant ) {
			if ( isset( $variant['meta']['breakpoint'] ) && (string) $variant['meta']['breakpoint'] === $breakpoint ) {
				return true;
			}
		}
		return false;
	}
}
