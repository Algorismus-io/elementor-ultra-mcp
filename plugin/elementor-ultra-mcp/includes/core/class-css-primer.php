<?php
/**
 * WP-P05 — `Css_Primer`: the MANDATORY V4 atomic-CSS priming step.
 *
 * Contract authority: 10-rest-api.md §0.10 (atomic CSS priming RULE), §2.7 (prime-css route payload);
 * 11-authoring-contract.md §10 (CSS priming invariants); 12-error-taxonomy.md §3.5 (`CSS_PRIME_FAILED`);
 * 15-engineering-standards.md §3.9 (atomic CSS priming), §6 (S1 spike-gate).
 *
 * THE LOCKED DECISION: V4 atomic CSS does NOT render on a headless `Document::save()`
 * (`modules/atomic-widgets/styles/atomic-styles-manager.php:47-150` — atomic styles register only on
 * the frontend `elementor/frontend/after_enqueue_post_styles` + `elementor/atomic-widgets/styles/register`
 * hooks). After any headless save this service makes the per-breakpoint atomic CSS files actually exist.
 *
 * SPIKE-VERIFIED CORRECTIONS (WP-S01 findings, spec/spikes/WP-S01-findings.md + SUMMARY.md C1):
 *  - DEFAULT to Approach B (in-process `do_action` dispatch, NO network) executed inside the
 *    authenticated REST request. The exact 5-step sequence per primed post id (S01):
 *      1. `wp_set_current_user(<capable id>)` (already the App-Password user in REST);
 *      2. `do_action('elementor/atomic-widgets/styles/clear', ['local'|'global'|'base'])` — invalidate
 *         atomic cache-validity BEFORE dispatch, else the prime is a SILENT no-op (R1: `CSS_Files_Manager::get()`
 *         returns null WITHOUT regenerating when `Cache_Validity::is_valid()` is TRUE even if the file is
 *         missing on disk — validity persists in `elementor_atomic_cache_validity__{local,global,base}` options);
 *      3. `do_action('elementor/post/render', $post_id)` (pushes the id into `Atomic_Styles_Manager::$post_ids`);
 *      4. `do_action('elementor/frontend/after_enqueue_post_styles')` (runs `enqueue_styles()` → fires
 *         `elementor/atomic-widgets/styles/register` → emits the per-breakpoint files);
 *      5. re-read the per-breakpoint files and assert non-empty + expected selector present, else `CSS_PRIME_FAILED`.
 *  - MUST run as the uid that owns `uploads/elementor/css/*` (web-server uid). The in-process REST handler
 *    satisfies this; a differently-imaged CLI sidecar (uid 82) silently writes nothing (R2). This service is
 *    designed to run inside the REST request.
 *  - File naming: the context segment comes from the rendering request's PREVIEW MODE
 *    (`Preview::is_editor_or_preview()`), NOT post status — inside a REST request both checks are false,
 *    so the in-process dispatch always emits `-frontend-` files (drafts included). `preview` only appears
 *    for real browser preview visits (`?elementor-preview=`). Desktop has no suffix,
 *    non-desktop breakpoints append `-<bp>` + a `@media` wrapper. local:
 *    `local-<postId>-frontend-desktop.css` → `.elementor .<localStyleId>{...}`; global:
 *    `global-<postId>-frontend-desktop.css` → `.elementor .<globalClassId>{...}`; base: `base-desktop.css`.
 *  - Approach A (loopback HTTP) is OPTIONAL cross-check only. `wp_remote_get(home_url()/get_permalink())`
 *    is NOT reliable (cURL error 7 on host/port/proxy mismatch). The robust recipe is
 *    `GET http://127.0.0.1:<port>/?page_id=<id>` + explicit `Host: <host>` header + `redirection => 0`.
 *
 * `css_primed:false` with `warnings[]` is a SUCCESS (200-with-warning), NOT an error (10 §2.7). A hard
 * internal failure (document missing, or post HAS atomic styles but CSS is absent/empty after the prime
 * sequence) raises a `CSS_PRIME_FAILED` `WP_Error` (12 §3.5, retryable=500).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

use Elementor\Ultra\Error_Codes;
use WP_Error;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Primes V4 atomic CSS after a headless save (the LOCKED decision + spike WP-S01).
 */
final class Css_Primer {

	/** Approach: in-process `do_action` dispatch, no network (S01 RECOMMENDED DEFAULT). */
	const APPROACH_PROGRAMMATIC = 'programmatic';

	/** Approach: server-side loopback HTTP GET (S01 OPTIONAL cross-check only, fragile). */
	const APPROACH_LOOPBACK = 'loopback';

	/** Approach: use the S01-proven approach. Resolves to {@see APPROACH_PROGRAMMATIC} per WP-S01. */
	const APPROACH_AUTO = 'auto';

	/**
	 * The approach `auto` resolves to, RECORDED by spike WP-S01.
	 *
	 * spec/spikes/WP-S01-findings.md §"Recommended WP-P04 approach" + SUMMARY.md §3:
	 * "Approach B (in-process programmatic `do_action` dispatch) as primary". Both A and B PASS, but A's
	 * `wp_remote_get(home_url())` is fragile across host/port/proxy mismatches; B has no network dependency.
	 *
	 * @var string
	 */
	const AUTO_APPROACH = self::APPROACH_PROGRAMMATIC;

	/** Frontend render context segment (non-preview requests, any post status), `Atomic_Widget_Styles::CONTEXT_FRONTEND`. */
	const CONTEXT_FRONTEND = 'frontend';

	/** Preview render context segment (editor/preview-mode requests only), `Atomic_Widget_Styles::CONTEXT_PREVIEW`. */
	const CONTEXT_PREVIEW = 'preview';

	/** The desktop breakpoint key (no media wrapper, no `-<bp>` suffix). */
	const BREAKPOINT_DESKTOP = 'desktop';

	/** Default loopback timeout in seconds (bounded; a timeout becomes a warning, never a throw). */
	const LOOPBACK_TIMEOUT = 5;

	/**
	 * Prime the V4 atomic CSS for a post (10-rest-api.md §2.7).
	 *
	 * Returns the §2.7 `data` block:
	 *   `{ id, css_primed:bool, approach_used:"programmatic"|"loopback", css_files:string[], css_bytes:int, warnings:string[] }`
	 *
	 * `css_primed:false` + `warnings[]` is a 200-with-warning SUCCESS (the residual "unstyled until first
	 * real hit" case). A `WP_Error('CSS_PRIME_FAILED')` is returned ONLY when priming cannot even be
	 * attempted (document missing) OR when the post HAS atomic styles/classes but the expected per-breakpoint
	 * CSS is absent/empty after the full prime sequence (S01 trap).
	 *
	 * @param int      $post_id     Post to prime.
	 * @param string   $approach    `programmatic|loopback|auto` (default `auto` → {@see AUTO_APPROACH}).
	 * @param string[] $breakpoints Optional breakpoint keys to restrict priming/verification (§2.7).
	 * @return array<string,mixed>|WP_Error
	 */
	public function prime( int $post_id, string $approach = self::APPROACH_AUTO, array $breakpoints = array() ) {
		$document = $this->get_document( $post_id );
		if ( null === $document ) {
			return $this->prime_failed( $post_id, $approach, 'Document not found or not Elementor-built; cannot prime CSS.' );
		}

		$approach_used = $this->resolve_approach( $approach );

		// No-op safety (#9): an all-V3 (non-atomic) document needs no prime — that is success, not failure.
		if ( ! $this->is_atomic_document( $post_id ) ) {
			return array(
				'id'            => $post_id,
				'css_primed'    => true,
				'approach_used' => $approach_used,
				'css_files'     => array(),
				'css_bytes'     => 0,
				'warnings'      => array( 'Document has no atomic styles/classes; nothing to prime.' ),
			);
		}

		$warnings        = array();
		$active_breaks   = $this->resolve_breakpoints( $breakpoints );
		$context         = $this->document_context();
		$expected_styles = $this->collect_expected_style_ids( $post_id );

		// ------------------------------------------------------------------
		// Dispatch the chosen prime approach (5-step sequence per S01).
		// ------------------------------------------------------------------
		if ( self::APPROACH_LOOPBACK === $approach_used ) {
			$loopback_warning = $this->dispatch_loopback( $post_id, $context );
			if ( '' !== $loopback_warning ) {
				$warnings[] = $loopback_warning;
			}
		} else {
			$this->dispatch_programmatic( $post_id );
		}

		// ------------------------------------------------------------------
		// Contract 18 §7 "Font system strategy" — make the NATIVE font enqueue fire.
		// The dispatch above just re-collected every atomic `font-family` prop value into the
		// `elementor_atomic_styles_fonts-{local|global}-<id>-<context>` options (the prop-transform
		// collection DOES run headlessly — live-verified), but the values are raw CSS (quoted names /
		// fallback stacks) and the frontend's `Fonts::get_font_type()` is an EXACT catalog-key lookup,
		// so every converted page silently enqueued NOTHING (the root cause; hypotheses "headless prime
		// skips collection" and "canvas template skips enqueue" were both disproven live). Normalize the
		// stored values to bare canonical family names so the next real render natively enqueues them;
		// non-catalog families surface as a warning (install via design/fonts/install, or the carry
		// link covers them). Best-effort: a normalization failure warns, never fails the prime.
		// ------------------------------------------------------------------
		if ( class_exists( '\Elementor\Ultra\Core\Fonts_Service' ) ) {
			try {
				$font_normalization = Fonts_Service::normalize_collected_fonts( $post_id );
				$warnings           = array_merge( $warnings, $font_normalization['warnings'] );
			} catch ( \Throwable $e ) {
				$warnings[] = sprintf( 'Native font normalization failed (fonts may not auto-enqueue): %s', $e->getMessage() );
			}
		}

		// ------------------------------------------------------------------
		// Step 5: re-read per-breakpoint files; assert non-empty + selector present.
		// ------------------------------------------------------------------
		$css_dir       = $this->css_dir();
		$css_files     = array();
		$css_bytes     = 0;
		$confirmed_any = false;

		// Local style files: local-<id>-<context>-<bp>.css → .elementor .<localStyleId>{...}
		// A local style's rendered selector IS its id, so id == selector token here.
		$local_check = $this->verify_node(
			$css_dir,
			'local',
			$post_id,
			$context,
			$active_breaks,
			$this->identity_selectors( $expected_styles['local'] )
		);
		// Global class files: global-<id>-<context>-<bp>.css → .elementor .<LABEL>{...}.
		// IMPORTANT (#2): the rendered selector for a global class is the LABEL-derived class
		// (e.g. id `g-mvphero` with label `mvphero` renders `.mvphero`), NOT the class id. We resolve
		// each id to its label via the Global_Classes_Repository and assert the label-derived selector.
		$global_check = $this->verify_node(
			$css_dir,
			'global',
			$post_id,
			$context,
			$active_breaks,
			$this->global_selectors( $expected_styles['global'] )
		);

		$css_files = array_merge( $local_check['files'], $global_check['files'] );
		$css_bytes = $local_check['bytes'] + $global_check['bytes'];

		// Base atomic CSS (base-<bp>.css) is shared (no post id); record its presence but it is not a
		// per-post selector confirmation.
		$base_files = $this->base_files( $css_dir, $active_breaks );
		foreach ( $base_files as $base_file ) {
			$css_files[] = basename( $base_file );
			$css_bytes  += $this->file_bytes( $base_file );
		}
		$css_files = array_values( array_unique( $css_files ) );

		// Determine confirmation. Atomic detection trips on the `e-` type prefix alone, so an atomic doc
		// can legitimately carry ZERO local styles and ZERO class references (structure-first builds of
		// bare e-heading/e-flexbox); the prime is only "confirmed" when EVERY expected selector is present.
		$expected_local  = ! empty( $expected_styles['local'] );
		$expected_global = ! empty( $expected_styles['global'] );

		// Vacuous success: nothing to verify is NOT a failure — mirror the non-atomic no-op branch
		// (200-with-warning per 10-rest-api.md §2.7), never CSS_PRIME_FAILED.
		if ( ! $expected_local && ! $expected_global ) {
			$warnings[] = 'Document has atomic elements but no local styles or class references to verify; nothing to prime.';
			return array(
				'id'            => $post_id,
				'css_primed'    => true,
				'approach_used' => $approach_used,
				'css_files'     => $css_files,
				'css_bytes'     => $css_bytes,
				'warnings'      => $warnings,
			);
		}

		$local_ok  = ! $expected_local || $local_check['all_selectors_present'];
		$global_ok = ! $expected_global || $global_check['all_selectors_present'];

		// Surface any missing-selector detail as warnings so callers can diagnose the residual case.
		$warnings = array_merge( $warnings, $local_check['warnings'], $global_check['warnings'] );

		$confirmed_any = ( $expected_local && $local_check['all_selectors_present'] )
			|| ( $expected_global && $global_check['all_selectors_present'] );

		if ( $local_ok && $global_ok && $confirmed_any ) {
			return array(
				'id'            => $post_id,
				'css_primed'    => true,
				'approach_used' => $approach_used,
				'css_files'     => $css_files,
				'css_bytes'     => $css_bytes,
				'warnings'      => $warnings,
			);
		}

		// Internal settle-retry before failing: on slow/WASM hosts the first verification can race the
		// generator's own async invalidation (observed: first prime after a save fails, an identical
		// retry ~2s later succeeds — every field agent ended up hand-writing this retry). One settle +
		// re-dispatch + re-verify converts those into successes; a repeat failure is the real S01 trap.
		static $retried = array();
		if ( empty( $retried[ $post_id ] ) ) {
			$retried[ $post_id ] = true;
			usleep( 1500000 );
			// The in-request object cache can hold PRE-SAVE cache-validity options (the save updated
			// them mid-request), making the generator believe its files are still valid while the
			// flush already deleted them. Drop the runtime cache so re-dispatch sees truth.
			wp_cache_flush();
			$this->dispatch_programmatic( $post_id );
			$result = $this->prime( $post_id, $approach, $breakpoints );
			unset( $retried[ $post_id ] );
			if ( ! is_wp_error( $result ) ) {
				$result['warnings'][] = 'First verification failed; succeeded on internal settle-retry.';
			}
			return $result;
		}
		unset( $retried[ $post_id ] );

		// A document that LOOKED atomic by detection but yielded no expected selectors after a full prime
		// sequence is the S01 hard-failure trap (stale-valid cache / wrong uid / not writable). Raise
		// CSS_PRIME_FAILED so the caller can retry (12 §3.5 retryable=500).
		return $this->prime_failed(
			$post_id,
			$approach_used,
			sprintf(
				'Atomic CSS could not be confirmed after priming (post %d): expected selectors were absent or the per-breakpoint files were empty. The page may render unstyled.',
				$post_id
			),
			array(
				'css_files' => $css_files,
				'css_bytes' => $css_bytes,
				'warnings'  => $warnings,
			)
		);
	}

	/**
	 * True when the post's tree contains atomic `e-*` nodes or any node with a `styles` map — only atomic
	 * docs need priming (11-authoring-contract.md §10). Reads raw `_elementor_data` (no `Document::save`
	 * side effects). Detects: any `elType`/`widgetType` beginning `e-`, any non-empty `styles` map, or any
	 * typed `classes` envelope referencing a class.
	 *
	 * @param int $post_id Post to inspect.
	 */
	public function is_atomic_document( int $post_id ): bool {
		$raw = get_post_meta( $post_id, '_elementor_data', true );
		if ( empty( $raw ) ) {
			return false;
		}

		$data = is_string( $raw ) ? json_decode( $raw, true ) : $raw;
		if ( ! is_array( $data ) ) {
			return false;
		}

		return $this->tree_has_atomic( $data );
	}

	// ---------------------------------------------------------------------
	// Approach dispatchers.
	// ---------------------------------------------------------------------

	/**
	 * Approach B (S01 default): in-process programmatic dispatch. The 5-step sequence (no network):
	 *   1. wp_set_current_user (already the App-Password user in REST — re-asserted defensively);
	 *   2. styles/clear [local]/[global]/[base] (invalidate atomic cache-validity BEFORE dispatch, R1);
	 *   3. post/render $post_id (push id into Atomic_Styles_Manager);
	 *   4. after_enqueue_post_styles (run enqueue_styles() → fire styles/register → emit files).
	 * (Step 5 re-read/assert happens in {@see prime()}.)
	 *
	 * @param int $post_id Post to prime.
	 * @return void
	 */
	private function dispatch_programmatic( int $post_id ): void {
		// Step 1: ensure a capable current user (REST handler already is the App-Password user).
		$current = get_current_user_id();
		if ( $current > 0 ) {
			wp_set_current_user( $current );
		}

		// Set up the singular front-end query context so context checks behave during dispatch (S01).
		$this->setup_singular_context( $post_id );

		// Step 2: invalidate atomic cache-validity so get() actually (re)writes the files (R1 trap).
		do_action( 'elementor/atomic-widgets/styles/clear', array( 'local' ) );
		do_action( 'elementor/atomic-widgets/styles/clear', array( 'global' ) );
		do_action( 'elementor/atomic-widgets/styles/clear', array( 'base' ) );

		// Let any lazy frontend hook registrations attach (Elementor wires the atomic styles manager on init).
		do_action( 'wp' );

		// Step 3: push the post id into Atomic_Styles_Manager::$post_ids.
		do_action( 'elementor/post/render', $post_id );

		// Step 4: run enqueue_styles() → fires elementor/atomic-widgets/styles/register → emits files.
		do_action( 'elementor/frontend/after_enqueue_post_styles' );
	}

	/**
	 * Approach A (S01 OPTIONAL cross-check): server-side loopback. Uses the robust S01 recipe
	 * (`127.0.0.1` on the listen port + explicit `Host:` header + `redirection => 0`) because
	 * `wp_remote_get(home_url())` is unreliable (cURL error 7 on host/port/proxy mismatch). Still
	 * invalidates atomic cache-validity first (R1). Failures become a `warnings[]` entry — never a throw.
	 *
	 * @param int    $post_id Post to prime.
	 * @param string $context Render context segment (`frontend`/`preview`) the verification expects.
	 * @return string A warning string when the loopback could not be confirmed, else '' (empty).
	 */
	private function dispatch_loopback( int $post_id, string $context ): string {
		// Invalidate atomic cache-validity first (R1) — a loopback render is also a silent no-op otherwise.
		do_action( 'elementor/atomic-widgets/styles/clear', array( 'local' ) );
		do_action( 'elementor/atomic-widgets/styles/clear', array( 'global' ) );
		do_action( 'elementor/atomic-widgets/styles/clear', array( 'base' ) );

		$home = wp_parse_url( home_url() );
		$host = isset( $home['host'] ) ? (string) $home['host'] : 'localhost';
		if ( isset( $home['port'] ) ) {
			$host .= ':' . $home['port'];
		}

		// S01 robust recipe: hit the loopback address on port 80 with an explicit Host header and no redirects.
		$url      = 'http://127.0.0.1/?page_id=' . $post_id;
		$response = wp_remote_get(
			$url,
			array(
				'timeout'     => self::LOOPBACK_TIMEOUT,
				'redirection' => 0,
				'sslverify'   => false,
				'headers'     => array( 'Host' => $host ),
			)
		);

		if ( is_wp_error( $response ) ) {
			return sprintf(
				'Loopback prime could not reach the site (%s); the CSS may be unstyled until the first real visit.',
				$response->get_error_message()
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		if ( $status < 200 || $status >= 400 ) {
			return sprintf( 'Loopback prime returned HTTP %d; the CSS may be unstyled until the first real visit.', $status );
		}

		return '';
	}

	// ---------------------------------------------------------------------
	// Verification (step 5).
	// ---------------------------------------------------------------------

	/**
	 * Verify a node group (`local`|`global`) across the requested breakpoints: each
	 * `<node>-<postId>-<context>-<bp>.css` must be non-empty AND contain every expected selector.
	 *
	 * @param string               $css_dir            Absolute CSS dir (trailing slash).
	 * @param string               $node               `local` or `global`.
	 * @param int                  $post_id            Post id segment.
	 * @param string               $context            `frontend` or `preview`.
	 * @param string[]             $breakpoints        Breakpoint keys to verify.
	 * @param array<string,string> $expected_selectors Map of style/class id => the bare class TOKEN whose
	 *                                                  `.elementor .<token>` selector must appear. For local
	 *                                                  styles the token IS the id; for global classes the
	 *                                                  token is the LABEL-derived class (#2).
	 * @return array{files:string[],bytes:int,all_selectors_present:bool,warnings:string[]}
	 */
	private function verify_node( string $css_dir, string $node, int $post_id, string $context, array $breakpoints, array $expected_selectors ): array {
		$files    = array();
		$bytes    = 0;
		$warnings = array();

		if ( empty( $expected_selectors ) ) {
			return array(
				'files'                 => $files,
				'bytes'                 => $bytes,
				'all_selectors_present' => true,
				'warnings'              => $warnings,
			);
		}

		// Track which expected ids we have confirmed across all breakpoint files for this node.
		$confirmed = array_fill_keys( array_keys( $expected_selectors ), false );

		foreach ( $breakpoints as $bp ) {
			$handle = $node . '-' . $post_id . '-' . $context . '-' . $bp;
			$path   = $css_dir . $handle . '.css';

			if ( ! is_readable( $path ) ) {
				continue;
			}

			$contents = (string) @file_get_contents( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			$len      = strlen( trim( $contents ) );
			if ( $len <= 0 ) {
				continue;
			}

			$files[] = basename( $path );
			$bytes  += $this->file_bytes( $path );

			foreach ( $expected_selectors as $id => $token ) {
				if ( '' !== $token && false !== strpos( $contents, '.' . $token ) ) {
					$confirmed[ $id ] = true;
				}
			}
		}

		$missing = array();
		foreach ( $confirmed as $id => $ok ) {
			if ( ! $ok ) {
				$token     = isset( $expected_selectors[ $id ] ) ? $expected_selectors[ $id ] : '';
				$missing[] = ( '' !== $token && $token !== $id ) ? sprintf( '%s (.%s)', $id, $token ) : (string) $id;
			}
		}

		if ( ! empty( $missing ) ) {
			$warnings[] = sprintf(
				'%s selector(s) not confirmed in primed CSS for post %d: %s.',
				$node,
				$post_id,
				implode( ', ', $missing )
			);
		}

		return array(
			'files'                 => array_values( array_unique( $files ) ),
			'bytes'                 => $bytes,
			'all_selectors_present' => empty( $missing ),
			'warnings'              => $warnings,
		);
	}

	/**
	 * The shared atomic `base-<bp>.css` files for the requested breakpoints (no post id segment).
	 *
	 * @param string   $css_dir     Absolute CSS dir (trailing slash).
	 * @param string[] $breakpoints Breakpoint keys.
	 * @return string[] Absolute paths of existing, non-empty base files.
	 */
	private function base_files( string $css_dir, array $breakpoints ): array {
		$out = array();
		foreach ( $breakpoints as $bp ) {
			$path = $css_dir . 'base-' . $bp . '.css';
			if ( is_readable( $path ) && filesize( $path ) > 0 ) {
				$out[] = $path;
			}
		}
		return $out;
	}

	// ---------------------------------------------------------------------
	// Tree inspection helpers.
	// ---------------------------------------------------------------------

	/**
	 * Recursive atomic detection: an element is atomic when its `elType`/`widgetType` starts with `e-`,
	 * or it carries a non-empty `styles` map, or its `settings.classes` references a class.
	 *
	 * @param array<int,mixed> $elements Element nodes.
	 */
	private function tree_has_atomic( array $elements ): bool {
		foreach ( $elements as $element ) {
			if ( ! is_array( $element ) ) {
				continue;
			}

			$el_type     = isset( $element['elType'] ) ? (string) $element['elType'] : '';
			$widget_type = isset( $element['widgetType'] ) ? (string) $element['widgetType'] : '';

			if ( 0 === strpos( $el_type, 'e-' ) || 0 === strpos( $widget_type, 'e-' ) ) {
				return true;
			}

			if ( isset( $element['styles'] ) && is_array( $element['styles'] ) && ! empty( $element['styles'] ) ) {
				return true;
			}

			if ( $this->settings_reference_classes( $element ) ) {
				return true;
			}

			if ( isset( $element['elements'] ) && is_array( $element['elements'] ) && $this->tree_has_atomic( $element['elements'] ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Whether an element's `settings.classes` is the typed atomic envelope referencing >=1 class id.
	 *
	 * @param array<string,mixed> $element Element node.
	 */
	private function settings_reference_classes( array $element ): bool {
		if ( ! isset( $element['settings']['classes'] ) || ! is_array( $element['settings']['classes'] ) ) {
			return false;
		}
		$classes = $element['settings']['classes'];
		if ( ( $classes['$$type'] ?? '' ) !== 'classes' ) {
			return false;
		}
		return isset( $classes['value'] ) && is_array( $classes['value'] ) && ! empty( $classes['value'] );
	}

	/**
	 * Collect the expected style/class ids whose selectors must appear after a prime:
	 *  - `local`: every key of every element's `styles` map (the local style ids in `local-*.css`).
	 *  - `global`: every class id referenced via the typed `settings.classes` envelope (in `global-*.css`).
	 * Local style ids ALSO appear in `settings.classes.value` (S01 shape) — to disambiguate, an id is
	 * treated as local when it is a key in any `styles` map, else global.
	 *
	 * @param int $post_id Post to inspect.
	 * @return array{local:string[],global:string[]}
	 */
	private function collect_expected_style_ids( int $post_id ): array {
		$raw  = get_post_meta( $post_id, '_elementor_data', true );
		$data = is_string( $raw ) ? json_decode( $raw, true ) : $raw;
		if ( ! is_array( $data ) ) {
			return array(
				'local'  => array(),
				'global' => array(),
			);
		}

		$local   = array();
		$classes = array();
		$this->walk_collect( $data, $local, $classes );

		$local = array_values( array_unique( $local ) );

		// Global = referenced class ids that are NOT local style ids.
		$global = array();
		foreach ( $classes as $class_id ) {
			if ( ! in_array( $class_id, $local, true ) ) {
				$global[] = $class_id;
			}
		}

		return array(
			'local'  => $local,
			'global' => array_values( array_unique( $global ) ),
		);
	}

	/**
	 * Recursive collector for {@see collect_expected_style_ids}.
	 *
	 * @param array<int,mixed> $elements Element nodes.
	 * @param string[]         $local    Accumulator for local style ids (by reference).
	 * @param string[]         $classes  Accumulator for referenced class ids (by reference).
	 * @return void
	 */
	private function walk_collect( array $elements, array &$local, array &$classes ): void {
		foreach ( $elements as $element ) {
			if ( ! is_array( $element ) ) {
				continue;
			}

			if ( isset( $element['styles'] ) && is_array( $element['styles'] ) ) {
				foreach ( array_keys( $element['styles'] ) as $style_id ) {
					$local[] = (string) $style_id;
				}
			}

			if ( $this->settings_reference_classes( $element ) ) {
				foreach ( $element['settings']['classes']['value'] as $class_id ) {
					$classes[] = (string) $class_id;
				}
			}

			if ( isset( $element['elements'] ) && is_array( $element['elements'] ) ) {
				$this->walk_collect( $element['elements'], $local, $classes );
			}
		}
	}

	/**
	 * Build the `id => selector-token` map for local style ids (the selector token IS the id; a local
	 * style renders `.elementor .<id>{...}`).
	 *
	 * @param string[] $ids Local style ids.
	 * @return array<string,string> id => id.
	 */
	private function identity_selectors( array $ids ): array {
		$out = array();
		foreach ( $ids as $id ) {
			$id = (string) $id;
			if ( '' !== $id ) {
				$out[ $id ] = $id;
			}
		}
		return $out;
	}

	/**
	 * Build the `id => selector-token` map for global class ids (#2). The rendered selector for a global
	 * class is its LABEL-derived class (`.elementor .<label>{...}`), NOT the class id — so we resolve
	 * each id's label via the Global_Classes_Repository. When a label cannot be resolved (degraded build /
	 * missing class) we fall back to the id itself so the genuine-failure path still trips on a truly
	 * missing/empty file.
	 *
	 * @param string[] $ids Global class ids.
	 * @return array<string,string> id => label-derived class token (falls back to id).
	 */
	private function global_selectors( array $ids ): array {
		$out = array();
		if ( empty( $ids ) ) {
			return $out;
		}

		$labels = $this->global_class_labels();

		foreach ( $ids as $id ) {
			$id = (string) $id;
			if ( '' === $id ) {
				continue;
			}
			$label      = isset( $labels[ $id ] ) ? (string) $labels[ $id ] : '';
			$out[ $id ] = '' !== $label ? $label : $id;
		}
		return $out;
	}

	/**
	 * Resolve the live `id => label` map for global classes via Elementor's `Global_Classes_Repository`
	 * (the authoritative source; never raw kit meta). Returns an empty map when the module / kit is
	 * unavailable (degraded build) so {@see global_selectors} falls back to the id.
	 *
	 * @return array<string,string> Global class id => label.
	 */
	private function global_class_labels(): array {
		$repository_class = '\Elementor\Modules\GlobalClasses\Global_Classes_Repository';
		if ( ! class_exists( $repository_class ) ) {
			return array();
		}

		$kit = $this->active_kit();
		if ( null === $kit ) {
			return array();
		}

		try {
			$repository = $repository_class::make( $kit );
			if ( method_exists( $repository, 'all_labels' ) ) {
				$labels = $repository->all_labels();
				return is_array( $labels ) ? $labels : array();
			}

			// Fallback: derive labels from the full items snapshot.
			$snapshot = $repository->all()->get();
			$items    = isset( $snapshot['items'] ) && is_array( $snapshot['items'] ) ? $snapshot['items'] : array();
			$out      = array();
			foreach ( $items as $id => $item ) {
				if ( is_array( $item ) && isset( $item['label'] ) ) {
					$out[ (string) $id ] = (string) $item['label'];
				}
			}
			return $out;
		} catch ( \Throwable $e ) {
			unset( $e );
			return array();
		}
	}

	/** The active Elementor kit, or null when the kits manager is unavailable. */
	private function active_kit() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->kits_manager ) ) {
			return null;
		}
		$manager = $plugin->kits_manager;
		if ( ! method_exists( $manager, 'get_active_kit' ) ) {
			return null;
		}
		return $manager->get_active_kit();
	}

	// ---------------------------------------------------------------------
	// Context / breakpoints / paths.
	// ---------------------------------------------------------------------

	/**
	 * The render-context segment for the CSS file names this prime will emit. Elementor names atomic CSS
	 * files from the PREVIEW MODE of the rendering request, NOT the post status:
	 * `Atomic_Widget_Styles::register_styles` keys the context off
	 * `Plugin::$instance->preview->is_editor_or_preview()` (`is_preview() || is_preview_mode()`), and both
	 * are false inside a REST request — so the in-process dispatch writes `-frontend-` files even for
	 * drafts. Verification MUST read the SAME family, so we mirror the dispatch-side check instead of post
	 * status. (The S01 "draft = preview" naming only holds for real browser preview visits carrying
	 * `?elementor-preview=`; it never applies to this service's programmatic/loopback dispatch.)
	 */
	private function document_context(): string {
		if ( class_exists( '\Elementor\Plugin' ) ) {
			$plugin = \Elementor\Plugin::$instance;
			if ( null !== $plugin
				&& isset( $plugin->preview )
				&& method_exists( $plugin->preview, 'is_editor_or_preview' )
				&& $plugin->preview->is_editor_or_preview()
			) {
				return self::CONTEXT_PREVIEW;
			}
		}
		return self::CONTEXT_FRONTEND;
	}

	/**
	 * Resolve the breakpoint keys to prime/verify. When `$requested` is non-empty it is honored verbatim
	 * (10 §2.7 scoping). When empty, prime ALL active breakpoints (Detailed Requirements #3): desktop +
	 * the site's active responsive breakpoints (via `Breakpoints_Manager::get_active_devices_list()`).
	 * Falls back to `['desktop']` when the manager is unavailable.
	 *
	 * @param string[] $requested Caller-supplied breakpoints (may be empty).
	 * @return string[] De-duplicated, desktop-first breakpoint keys.
	 */
	private function resolve_breakpoints( array $requested ): array {
		$requested = array_values( array_filter( array_map( 'strval', $requested ) ) );
		if ( ! empty( $requested ) ) {
			return array_values( array_unique( $requested ) );
		}

		$manager = $this->breakpoints_manager();
		if ( null !== $manager && method_exists( $manager, 'get_active_devices_list' ) ) {
			$list = $manager->get_active_devices_list( array( 'add_desktop' => true ) );
			if ( is_array( $list ) && ! empty( $list ) ) {
				if ( ! in_array( self::BREAKPOINT_DESKTOP, $list, true ) ) {
					array_unshift( $list, self::BREAKPOINT_DESKTOP );
				}
				return array_values( array_unique( array_map( 'strval', $list ) ) );
			}
		}

		return array( self::BREAKPOINT_DESKTOP );
	}

	/** The Elementor Breakpoints_Manager, or null when Elementor/the manager is absent. */
	private function breakpoints_manager() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->breakpoints ) ) {
			return null;
		}
		return $plugin->breakpoints;
	}

	/**
	 * Mark the global query as the singular front-end view of `$post_id` so context checks
	 * (is_singular / get_the_ID) behave during programmatic dispatch (S01).
	 *
	 * @param int $post_id Post id.
	 * @return void
	 */
	private function setup_singular_context( int $post_id ): void {
		global $wp_query, $post;
		$resolved = get_post( $post_id );
		if ( ! $resolved ) {
			return;
		}
		$post = $resolved; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		setup_postdata( $post );
		if ( $wp_query instanceof \WP_Query ) {
			$wp_query->is_singular       = true;
			$wp_query->is_page           = ( 'page' === $resolved->post_type );
			$wp_query->is_single         = ( 'page' !== $resolved->post_type );
			$wp_query->queried_object    = $resolved;
			$wp_query->queried_object_id = $post_id;
		}
	}

	/** Absolute CSS dir with a trailing slash (`uploads/elementor/css/`). */
	private function css_dir(): string {
		$upload = wp_upload_dir();
		$dir    = trailingslashit( $upload['basedir'] ) . 'elementor/css/';
		// A cache clear can delete the whole css DIRECTORY, after which every generator write dies
		// with "file_put_contents(...): No such file or directory" and priming self-fails forever
		// (observed on PHP-WASM where the writer never recreates it). Recreate it on every resolve —
		// wp_mkdir_p is a no-op when it already exists.
		if ( ! is_dir( $dir ) ) {
			wp_mkdir_p( $dir );
		}
		return $dir;
	}

	/**
	 * Byte size of a CSS file (0 when missing/empty). Uses filesize; clears the stat cache so a freshly
	 * written file is sized correctly.
	 *
	 * @param string $path Absolute file path.
	 */
	private function file_bytes( string $path ): int {
		clearstatcache( true, $path );
		if ( ! is_readable( $path ) ) {
			return 0;
		}
		$size = filesize( $path );
		return false === $size ? 0 : (int) $size;
	}

	/**
	 * The Elementor document for a post, or null when missing / not Elementor-built.
	 *
	 * @param int $post_id Post id.
	 * @return object|null
	 */
	private function get_document( int $post_id ) {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->documents ) ) {
			return null;
		}
		$document = $plugin->documents->get( $post_id );
		return $document ? $document : null;
	}

	/**
	 * Resolve `auto` to the S01-recorded approach; pass `loopback`/`programmatic` through; an unknown
	 * value resolves to the auto approach.
	 *
	 * @param string $approach Requested approach.
	 */
	private function resolve_approach( string $approach ): string {
		if ( self::APPROACH_LOOPBACK === $approach ) {
			return self::APPROACH_LOOPBACK;
		}
		if ( self::APPROACH_PROGRAMMATIC === $approach ) {
			return self::APPROACH_PROGRAMMATIC;
		}
		return self::AUTO_APPROACH;
	}

	/**
	 * Build a `CSS_PRIME_FAILED` `WP_Error` (12-error-taxonomy.md §3.5, retryable=500). `meta.post_id` +
	 * `meta.approach` are REQUIRED by the §3.5 row; extra context (files/bytes/warnings) is merged in.
	 *
	 * @param int                 $post_id  Post that failed to prime.
	 * @param string              $approach Approach attempted.
	 * @param string              $message  Human, actionable message.
	 * @param array<string,mixed> $extra    Extra meta (css_files, css_bytes, warnings).
	 * @return WP_Error
	 */
	private function prime_failed( int $post_id, string $approach, string $message, array $extra = array() ): WP_Error {
		$meta = array_merge(
			array(
				'post_id'  => $post_id,
				'approach' => $approach,
			),
			$extra
		);

		if ( class_exists( '\Elementor\Ultra\Core\Error' ) ) {
			return \Elementor\Ultra\Core\Error::make(
				Error_Codes::CSS_PRIME_FAILED,
				$message,
				Error_Codes::http_status( Error_Codes::CSS_PRIME_FAILED ),
				$meta
			);
		}

		// Defensive fallback if the WP-P02 Error factory is not loaded (never expected in-plugin).
		return new WP_Error(
			Error_Codes::CSS_PRIME_FAILED,
			$message,
			array(
				'status' => Error_Codes::http_status( Error_Codes::CSS_PRIME_FAILED ),
				'meta'   => $meta,
			)
		);
	}
}
