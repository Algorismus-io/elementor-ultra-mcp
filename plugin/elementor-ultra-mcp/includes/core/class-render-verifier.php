<?php
/**
 * Contract 18 §7-AI S2 — `Render_Verifier`: the post-save render-verification probe (kills AF2).
 *
 * "A write is not done when it persists — it is done when the document RENDERS." The R4 record
 * (page 2789): a build that was valid + saved + primed + op-logged served a PHP FATAL to every
 * visitor (Pro's custom-css module `trim()` on an object page-settings `custom_css`,
 * elementor-pro/modules/custom-css/module.php:101) while `css_primed:true` reported green. This
 * service is the cheap dynamic probe that catches that class of failure.
 *
 * Probe ladder:
 *  1. LOOPBACK (published posts only — an unauthenticated fetch of a draft 404s by design): GET the
 *     permalink rewritten onto `127.0.0.1:<port>` with an explicit `Host:` header + `redirection 0`
 *     (the S01-verified recipe; `wp_remote_get(home_url())` is unreliable in wp-env/Docker where the
 *     container cannot resolve its own siteurl). A PASS requires a 2xx status AND a NON-EMPTY body
 *     with no fatal marker — an empty 2xx (or an unfollowed 3xx) proves nothing rendered and falls
 *     through to the dispatch probe instead of counting as a verdict.
 *  2. DISPATCH (the MANDATORY fallback, and the primary path for drafts / unreachable loopback):
 *     in-process render of the document — regenerate the post CSS file
 *     (`Elementor\Core\Files\CSS\Post::update()` fires `elementor/css-file/post/parse`, the exact
 *     hook Pro's custom-css module fatals on) then `Frontend::get_builder_content_for_display()`
 *     (the widget render path), both wrapped in a `\Throwable` catch + output buffering. A throw =
 *     the front-end would fatal.
 *
 * A FAILED probe is a 200 SUCCESS payload with `render_verified:false` (taxonomy `RENDER_FAILED` is
 * SOFT — the save already landed; the caller decides whether to roll back). Every probe is
 * op-logged (route `documents/verify-render`, result `ok`/`render_failed`).
 *
 * @package Elementor\Ultra
 */

namespace Elementor\Ultra\Core;

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Verifies a document actually renders (contract 18 §7-AI S2). Read-only for the document tree;
 * the dispatch probe may regenerate the post's CSS file (idempotent, same as a front-end visit).
 */
final class Render_Verifier {

	/** Loopback fetch timeout (seconds) — mirrors Css_Primer::LOOPBACK_TIMEOUT. */
	const LOOPBACK_TIMEOUT = 8;

	/** Body markers that mean WordPress served a fatal/critical-error page. */
	const FATAL_MARKERS = array(
		'There has been a critical error on this website',
		'Fatal error',
		'Uncaught Error',
		'Uncaught TypeError',
	);

	/**
	 * Run the probe ladder for one document. The caller has already resolved the post exists.
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array{id:int,render_verified:bool,method:string,http_status:?int,fatal:?string,checked_url:?string}
	 */
	public function verify( int $post_id ): array {
		$post      = get_post( $post_id );
		$published = ( $post && 'publish' === $post->post_status );

		$result = null;
		if ( $published ) {
			// (1) loopback permalink fetch — only meaningful when an unauthenticated visitor could
			// see the page; a draft 404s by design and would be a false RENDER_FAILED.
			$result = $this->probe_loopback( $post_id );
		}
		if ( null === $result ) {
			// (2) MANDATORY in-process front-controller dispatch fallback (also the draft path).
			$result = $this->probe_dispatch( $post_id );
		}

		$result['id'] = $post_id;

		$this->op_log( $post_id, $result );

		return $result;
	}

	// ---------------------------------------------------------------------
	// Probe 1: loopback HTTP.
	// ---------------------------------------------------------------------

	/**
	 * Fetch the permalink rewritten onto the loopback address (S01 recipe: `127.0.0.1[:port]` +
	 * explicit `Host:` header + `redirection 0`). Returns the probe outcome, or NULL when the probe
	 * is INCONCLUSIVE — loopback unreachable (connection-level failure), an unfollowed 3xx, or a 2xx
	 * whose body is empty (nothing demonstrably rendered) — the dispatch fallback then decides.
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array{render_verified:bool,method:string,http_status:?int,fatal:?string,checked_url:?string}|null
	 */
	private function probe_loopback( int $post_id ): ?array {
		$permalink = get_permalink( $post_id );
		if ( ! is_string( $permalink ) || '' === $permalink ) {
			return null;
		}

		$home = wp_parse_url( home_url() );
		$host = isset( $home['host'] ) ? (string) $home['host'] : 'localhost';
		if ( isset( $home['port'] ) ) {
			$host .= ':' . $home['port'];
		}

		// Rewrite the permalink's scheme+host to the loopback address, preserving path + query so
		// rewrite rules resolve exactly as a real visit would; the Host header carries the real host.
		// Try the siteurl's own port first, then bare port 80 (the S01 recipe — Docker/wp-env maps
		// the public port to 80 INSIDE the container, so the siteurl port often refuses there).
		$parts = wp_parse_url( $permalink );
		$path  = isset( $parts['path'] ) ? (string) $parts['path'] : '/';
		$query = isset( $parts['query'] ) ? '?' . (string) $parts['query'] : '';

		$candidates = array();
		if ( isset( $home['port'] ) ) {
			$candidates[] = 'http://127.0.0.1:' . (int) $home['port'] . $path . $query;
		}
		$candidates[] = 'http://127.0.0.1' . $path . $query;

		$response = null;
		foreach ( array_unique( $candidates ) as $url ) {
			$attempt = wp_remote_get(
				$url,
				array(
					'timeout'     => self::LOOPBACK_TIMEOUT,
					'redirection' => 0,
					'sslverify'   => false,
					'headers'     => array( 'Host' => $host ),
				)
			);
			if ( ! is_wp_error( $attempt ) ) {
				$response = $attempt;
				break;
			}
		}

		if ( null === $response ) {
			// Connection-level failure (container cannot loop back) — NOT a render verdict.
			return null;
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$body   = (string) wp_remote_retrieve_body( $response );

		$marker = $this->find_fatal_marker( $body );
		if ( null !== $marker ) {
			return array(
				'render_verified' => false,
				'method'          => 'loopback',
				'http_status'     => $status,
				'fatal'           => $marker,
				'checked_url'     => $permalink,
			);
		}

		if ( $status < 200 || $status >= 400 ) {
			return array(
				'render_verified' => false,
				'method'          => 'loopback',
				'http_status'     => $status,
				'fatal'           => sprintf( 'HTTP %d from the permalink probe', $status ),
				'checked_url'     => $permalink,
			);
		}

		// An unfollowed 3xx (redirection 0) or a 2xx with an EMPTY body proves NOTHING rendered —
		// status+marker alone is the lying-probe class the hardening pass killed. NOT a verdict:
		// fall through to the MANDATORY in-process dispatch probe, which actually runs the render.
		if ( $status >= 300 || '' === trim( $body ) ) {
			return null;
		}

		return array(
			'render_verified' => true,
			'method'          => 'loopback',
			'http_status'     => $status,
			'fatal'           => null,
			'checked_url'     => $permalink,
		);
	}

	/** The first fatal marker present in a response body, or null. */
	private function find_fatal_marker( string $body ): ?string {
		foreach ( self::FATAL_MARKERS as $marker ) {
			if ( false !== strpos( $body, $marker ) ) {
				return $marker;
			}
		}
		return null;
	}

	// ---------------------------------------------------------------------
	// Probe 2: in-process front-controller dispatch (MANDATORY fallback).
	// ---------------------------------------------------------------------

	/**
	 * Render the document in-process, exercising the exact code paths a front-end visit runs that
	 * are known to fatal on bad persisted state:
	 *  - `Elementor\Core\Files\CSS\Post::update()` — fires `elementor/css-file/post/parse`, where
	 *    Pro's custom-css module `trim()`s the page-settings `custom_css` (the AF1 fatal site);
	 *  - `Frontend::get_builder_content_for_display()` — instantiates + renders every widget.
	 *
	 * Any `\Throwable` = the front-end would fatal → `render_verified:false` with the message.
	 *
	 * @param int $post_id The document id.
	 *
	 * @return array{render_verified:bool,method:string,http_status:?int,fatal:?string,checked_url:?string}
	 */
	private function probe_dispatch( int $post_id ): array {
		$fatal     = null;
		$exercised = false;
		$level     = ob_get_level();

		try {
			ob_start();

			if ( class_exists( '\Elementor\Core\Files\CSS\Post' ) ) {
				$css_file = \Elementor\Core\Files\CSS\Post::create( $post_id );
				if ( $css_file && method_exists( $css_file, 'update' ) ) {
					$css_file->update();
					$exercised = true;
				}
			}

			if ( class_exists( '\Elementor\Plugin' )
				&& isset( \Elementor\Plugin::$instance->frontend )
				&& method_exists( \Elementor\Plugin::$instance->frontend, 'get_builder_content_for_display' )
			) {
				\Elementor\Plugin::$instance->frontend->get_builder_content_for_display( $post_id );
				$exercised = true;
			}

			ob_end_clean();
		} catch ( \Throwable $e ) {
			// Drain any buffers the throw left open.
			while ( ob_get_level() > $level ) {
				ob_end_clean();
			}
			$fatal = sprintf( '%s: %s', get_class( $e ), $e->getMessage() );
		}

		// HARDENING: when the Elementor render path is absent (class_exists guards all no-op'd —
		// e.g. Elementor deactivated mid-request, or a broken install), NOTHING was probed. A
		// `render_verified:true` here would be the lying-gate class — report unverified instead.
		if ( null === $fatal && ! $exercised ) {
			$fatal = 'Elementor render path unavailable in-process (no CSS parse, no widget render was exercised) — the probe could not run; treat the document as UNVERIFIED, not as passing.';
		}

		return array(
			'render_verified' => null === $fatal,
			'method'          => 'dispatch',
			'http_status'     => null,
			'fatal'           => $fatal,
			'checked_url'     => null,
		);
	}

	// ---------------------------------------------------------------------
	// Op-log (soft dep, mirrors Document_Writer::op_log).
	// ---------------------------------------------------------------------

	/**
	 * Append one op-log row for the probe (route `documents/verify-render`; result `ok` /
	 * `render_failed`). Guarded soft dependency — never fails the probe.
	 *
	 * @param int                 $post_id The document id.
	 * @param array<string,mixed> $result  The probe outcome.
	 *
	 * @return void
	 */
	private function op_log( int $post_id, array $result ): void {
		if ( ! class_exists( '\Elementor\Ultra\Core\Op_Log' ) || ! method_exists( '\Elementor\Ultra\Core\Op_Log', 'record' ) ) {
			return;
		}
		Op_Log::record(
			array(
				'op_id'       => null,
				'post_id'     => $post_id,
				'route'       => 'documents/verify-render',
				'before_hash' => null,
				'after_hash'  => null,
				'result'      => ! empty( $result['render_verified'] ) ? 'ok' : 'render_failed',
			)
		);
	}
}
