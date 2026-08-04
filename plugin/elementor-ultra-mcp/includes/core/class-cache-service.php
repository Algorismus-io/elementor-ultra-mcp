<?php
/**
 * WP-P05 — `Cache_Service`: V3 `Post_CSS` regen + the full `files_manager->clear_cache()` flush.
 *
 * Contract authority: 10-rest-api.md §0.12 (cache side effects), §9 (cache routes);
 * 11-authoring-contract.md §10 (`Post_CSS::create($id)->update()` no-ops for atomic);
 * 15-engineering-standards.md §6 (S7 spike-gate).
 *
 * SPIKE-VERIFIED CORRECTIONS (WP-S07 findings, spec/spikes/WP-S07-findings.md + SUMMARY.md C6):
 *  - The flush is reliable ONLY as the uid that owns `uploads/elementor/css/*` (web-server uid 33 / Apache).
 *    A CLI sidecar (uid 82) clears DB meta but FAILS to unlink files while STILL reporting Success. The
 *    in-process REST handler satisfies the uid requirement; do NOT flush from a differently-imaged CLI container.
 *  - `clear_cache()` does NOT check the return of `unlink()` and reports success even when deletion FAILS
 *    (`core/files/manager.php:111-113`). NEVER trust the success string — this service MUST assert
 *    `glob(uploads/elementor/css/*)` is empty after a flush (R2).
 *  - For global/kit/class writes the flush MUST run in-process via
 *    `\Elementor\Plugin::$instance->files_manager->clear_cache()` (optionally `->generate_css()`).
 *  - Multisite `--network` is UNVERIFIED (no multisite on the live target, S07). `network:true` is gated:
 *    when multisite is present it fans out via `get_sites()` + `switch_to_blog()` with a per-site
 *    files-cleared assertion; on a single-site install it degrades to the current site and records a warning.
 *
 * `Post_CSS::create($id)->update()` is GENUINELY a no-op for atomic content (11 §10) — that is the entire
 * reason {@see Css_Primer} exists. `regen_post` is the V3 path; it does NOT prime atomic CSS.
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Wraps V3 `Post_CSS` regen and the full Elementor CSS flush (used by document + design-system writes).
 */
final class Cache_Service {

	/** Global regen batch size — 100 Elementor-built posts per run (10-rest-api.md §9). */
	const REGEN_BATCH = 100;

	/**
	 * V3 per-post regen: `Post_CSS::create($post_id)->update()` (10-rest-api.md §9). This is a NO-OP for
	 * atomic pages (11 §10) — atomic CSS is primed by {@see Css_Primer}, not here.
	 *
	 * @param int $post_id Post to regenerate.
	 * @return bool True when the regen ran; false when Elementor / the Post_CSS class is unavailable.
	 */
	public function regen_post( int $post_id ): bool {
		if ( ! $this->post_css_available() ) {
			return false;
		}

		$css_file = \Elementor\Core\Files\CSS\Post::create( $post_id );
		if ( ! $css_file || ! method_exists( $css_file, 'update' ) ) {
			return false;
		}

		$css_file->update();
		return true;
	}

	/**
	 * Global V3 regen, batched 100/run (10-rest-api.md §9). Iterates Elementor-built posts
	 * (`meta_key=_elementor_edit_mode`, value `builder`) `REGEN_BATCH` at a time calling {@see regen_post}.
	 * `network:true` mirrors `wp elementor flush-css --network` (S07) — see {@see network_fanout}.
	 *
	 * @param bool $network When true and the install is multisite, regen across all sites (S07-gated).
	 * @return array{regenerated:int,scope?:string,warnings?:string[]}
	 */
	public function regen_global( bool $network = false ): array {
		if ( $network ) {
			$fanout = $this->network_fanout( fn() => $this->regen_global( false ) );
			if ( null !== $fanout ) {
				$total    = 0;
				$warnings = $fanout['warnings'];
				foreach ( $fanout['results'] as $result ) {
					$total += isset( $result['regenerated'] ) ? (int) $result['regenerated'] : 0;
				}
				return array(
					'regenerated' => $total,
					'scope'       => 'network',
					'warnings'    => $warnings,
				);
			}
			// Degrade to current-site regen with a warning (S07: single-site `--network` is a no-op).
			$single             = $this->regen_global( false );
			$single['warnings'] = array( 'network:true requested but the install is single-site; regenerated the current site only (S07).' );
			return $single;
		}

		if ( ! $this->post_css_available() ) {
			return array( 'regenerated' => 0 );
		}

		$regenerated = 0;
		$offset      = 0;

		do {
			$ids = get_posts(
				array(
					'post_type'        => 'any',
					'post_status'      => 'any',
					'posts_per_page'   => self::REGEN_BATCH,
					'offset'           => $offset,
					'fields'           => 'ids',
					'no_found_rows'    => true,
					'suppress_filters' => true,
					'meta_key'         => '_elementor_edit_mode', // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
					'meta_value'       => 'builder',              // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
				)
			);

			foreach ( $ids as $id ) {
				if ( $this->regen_post( (int) $id ) ) {
					++$regenerated;
				}
			}

			$offset += self::REGEN_BATCH;
		} while ( count( $ids ) === self::REGEN_BATCH );

		return array( 'regenerated' => $regenerated );
	}

	/**
	 * Full flush: `\Elementor\Plugin::$instance->files_manager->clear_cache()` (10-rest-api.md §0.12, §9;
	 * `core/files/manager.php:107-117`). Per S07/C6/R2 the success string is NOT trusted — after the flush
	 * this asserts `glob(uploads/elementor/css/*)` is empty and returns FALSE when stale files remain (the
	 * uid-mismatch silent-failure trap). When run in-process (REST handler / web-server uid) the assertion
	 * passes; when run as a non-owner uid it correctly reports failure instead of lying.
	 *
	 * @param bool $network When true and the install is multisite, flush across all sites (S07-gated).
	 * @return bool True when the CSS dir is empty after the flush (files actually deleted); false otherwise.
	 */
	public function flush_all( bool $network = false ): bool {
		if ( $network ) {
			$fanout = $this->network_fanout( fn() => $this->flush_all( false ) );
			if ( null !== $fanout ) {
				$ok = true;
				foreach ( $fanout['results'] as $result ) {
					$ok = $ok && ( true === $result );
				}
				return $ok;
			}
			// Degrade to current site (single-site `--network` is a documented no-op, S07).
			return $this->flush_all( false );
		}

		$manager = $this->files_manager();
		if ( null === $manager || ! method_exists( $manager, 'clear_cache' ) ) {
			return false;
		}

		$manager->clear_cache();

		// S07/R2: NEVER trust the Success string — assert the CSS dir is actually empty.
		return $this->css_dir_empty();
	}

	/**
	 * Per-post flush used after raw restores / by rollback: delete `_elementor_css` +
	 * `_elementor_element_cache` meta and `Post_CSS::create($id)->delete()` the file
	 * (10-rest-api.md §0.12; `core/files/manager.php:107-117` per-post equivalent).
	 *
	 * @param int $post_id Post to flush.
	 * @return void
	 */
	public function flush_post( int $post_id ): void {
		delete_post_meta( $post_id, '_elementor_css' );          // Post_CSS::META_KEY.
		delete_post_meta( $post_id, '_elementor_element_cache' ); // Document_Base::CACHE_META_KEY.

		if ( $this->post_css_available() ) {
			$css_file = \Elementor\Core\Files\CSS\Post::create( $post_id );
			if ( $css_file && method_exists( $css_file, 'delete' ) ) {
				$css_file->delete();
			}
		}
	}

	/**
	 * The full flush every design-system write triggers (10-rest-api.md §0.12): classes / variables /
	 * global colors / fonts / element-defaults / sync. Thin alias over {@see flush_all}(false) PLUS clearing
	 * the active kit's own cached CSS (`kit.php:105`) so kit-class deletions/edits do not serve stale CSS.
	 * WP-P08/P09 call this after EVERY design-system write.
	 *
	 * @return bool True when the CSS dir is empty after the flush; false otherwise (S07/R2 assertion).
	 */
	public function flush_design_system(): bool {
		$flushed = $this->flush_all( false );

		// Also clear the active kit's own post CSS so kit/global-class changes re-render (kit.php:105).
		$kit_id = $this->active_kit_id();
		if ( $kit_id > 0 ) {
			$this->flush_post( $kit_id );
		}

		// Re-assert after the kit flush (the kit flush may have written nothing new, but a non-owner uid
		// flush would already have failed the first assertion).
		return $flushed && $this->css_dir_empty();
	}

	// ---------------------------------------------------------------------
	// Internals.
	// ---------------------------------------------------------------------

	/**
	 * Multisite fan-out helper (S07). When the install is multisite, run `$op` under each site via
	 * `switch_to_blog()`/`restore_current_blog()` and collect per-site results + warnings. Returns null on
	 * a single-site install so the caller can degrade to the current site (S07: single-site `--network` is
	 * a documented no-op, and the multisite path inherits the uid + silent-success caveats per subsite).
	 *
	 * @param callable $op Per-site operation returning the per-site result.
	 * @return array{results:array<int,mixed>,warnings:string[]}|null
	 */
	private function network_fanout( callable $op ) {
		if ( ! function_exists( 'is_multisite' ) || ! is_multisite() || ! function_exists( 'get_sites' ) ) {
			return null;
		}

		$results  = array();
		$warnings = array(
			'Multisite --network fan-out is UNVERIFIED (S07): inherits the uid-ownership and silent-success caveats per subsite; verify per-site CSS dirs are empty.',
		);

		$sites = get_sites( array( 'fields' => 'ids' ) );
		foreach ( $sites as $blog_id ) {
			switch_to_blog( (int) $blog_id );
			try {
				$results[ (int) $blog_id ] = $op();
			} finally {
				restore_current_blog();
			}
		}

		return array(
			'results'  => $results,
			'warnings' => $warnings,
		);
	}

	/** Whether the V3 `Post_CSS` class + Elementor plugin are available. */
	private function post_css_available(): bool {
		return class_exists( '\Elementor\Core\Files\CSS\Post' )
			&& class_exists( '\Elementor\Plugin' )
			&& null !== \Elementor\Plugin::$instance;
	}

	/** The Elementor files manager, or null when Elementor/the manager is absent. */
	private function files_manager() {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return null;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->files_manager ) ) {
			return null;
		}
		return $plugin->files_manager;
	}

	/** The active kit's post id, or 0 when the kits manager is unavailable / no kit. */
	private function active_kit_id(): int {
		if ( ! class_exists( '\Elementor\Plugin' ) ) {
			return 0;
		}
		$plugin = \Elementor\Plugin::$instance;
		if ( null === $plugin || ! isset( $plugin->kits_manager ) ) {
			return 0;
		}
		$manager = $plugin->kits_manager;
		if ( ! method_exists( $manager, 'get_active_id' ) ) {
			return 0;
		}
		return (int) $manager->get_active_id();
	}

	/**
	 * Whether `uploads/elementor/css/` is empty (no files remain). The S07/R2 post-flush assertion that
	 * replaces trusting `clear_cache()`'s success string. A missing dir counts as empty.
	 */
	private function css_dir_empty(): bool {
		$upload  = wp_upload_dir();
		$css_dir = trailingslashit( $upload['basedir'] ) . 'elementor/css/';
		clearstatcache();

		if ( ! is_dir( $css_dir ) ) {
			return true;
		}

		$entries = glob( $css_dir . '*' );
		if ( false === $entries ) {
			// glob() failure — treat as "not confirmed empty" rather than lying about success.
			return false;
		}

		return 0 === count( $entries );
	}
}
