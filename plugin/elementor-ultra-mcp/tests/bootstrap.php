<?php
/**
 * WP-F06 — PHPUnit bootstrap for the companion plugin's authoritative dry_run suite.
 *
 * Runs INSIDE wp-env (`.wp-env.json` at repo root) with Elementor 4.1.1 + Pro 4.1.0 + the companion
 * plugin active, and the experiments from each fixture's `requires` activatable (14-fixtures-harness.md
 * §3 step 1). It boots the WordPress PHPUnit test framework, force-activates Elementor + Pro + this
 * plugin via `muplugins_loaded`, and points the fixture loader at the single golden-fixtures directory.
 *
 * The fixtures live at the repo root (`packages/shared/fixtures`), which is NOT mounted into the
 * wp-env container by default — only the plugin dir is (`.wp-env.json` mappings). Provide the path via
 * the `ELEMENTOR_ULTRA_FIXTURES_DIR` environment variable when running `composer test:php`; otherwise
 * this bootstrap falls back to the monorepo-relative layout (works when the repo root is mounted).
 *
 * @package Elementor\Ultra\Tests
 */

// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals -- WP test-framework bootstrap conventions.

// Resolve the WordPress test library (wp-env / wp-phpunit conventions).
$_tests_dir = getenv( 'WP_TESTS_DIR' );
if ( ! $_tests_dir ) {
	$_tests_dir = getenv( 'WP_PHPUNIT__DIR' );
}
if ( ! $_tests_dir && file_exists( '/wordpress-phpunit/includes/functions.php' ) ) {
	$_tests_dir = '/wordpress-phpunit';
}
if ( ! $_tests_dir ) {
	$_tests_dir = rtrim( sys_get_temp_dir(), '/\\' ) . '/wordpress-tests-lib';
}

$_functions = $_tests_dir . '/includes/functions.php';
if ( ! file_exists( $_functions ) ) {
	fwrite( // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fwrite
		STDERR,
		"[bootstrap] Could not find {$_functions}. Set WP_TESTS_DIR / WP_PHPUNIT__DIR to the WordPress " .
		"PHPUnit test library (provided by wp-env). Skipping PHP suite.\n"
	);
	// Exit 0 so a missing test library does not fail CI before the wp-env lane is wired (WP-F07).
	exit( 0 );
}

// Resolve the golden-fixtures directory (the single copy; 14-fixtures-harness.md §1).
$_fixtures_dir = getenv( 'ELEMENTOR_ULTRA_FIXTURES_DIR' );
if ( ! $_fixtures_dir ) {
	// Fallback to the monorepo layout: plugin/elementor-ultra-mcp/tests -> repo root.
	$_fixtures_dir = dirname( __DIR__, 3 ) . '/packages/shared/fixtures';
}
if ( ! defined( 'ELEMENTOR_ULTRA_FIXTURES_DIR' ) ) {
	define( 'ELEMENTOR_ULTRA_FIXTURES_DIR', $_fixtures_dir );
}

// The WP test bootstrap requires the Yoast PHPUnit Polyfills (composer require-dev); load them first.
$_polyfills = dirname( __DIR__ ) . '/vendor/yoast/phpunit-polyfills/phpunitpolyfills-autoload.php';
if ( file_exists( $_polyfills ) ) {
	require_once $_polyfills;
}

require_once $_functions;

/**
 * Force-activate Elementor (+ Pro, if present) and the companion plugin before WP loads, so the
 * atomic registry + experiments are available to the dry_run validator (§3 step 1).
 */
function _elementor_ultra_manually_load_plugins() {
	$candidates = array(
		'elementor/elementor.php',
		'elementor-pro/elementor-pro.php',
		'elementor-ultra-mcp/elementor-ultra-mcp.php',
	);
	foreach ( $candidates as $rel ) {
		$path = WP_PLUGIN_DIR . '/' . $rel;
		if ( file_exists( $path ) ) {
			require_once $path;
		}
	}
}
tests_add_filter( 'muplugins_loaded', '_elementor_ultra_manually_load_plugins' );

// The fixture loader + test cases live alongside this bootstrap.
require_once __DIR__ . '/class-fixture-loader.php';

// Start the WordPress test environment.
require $_tests_dir . '/includes/bootstrap.php';

// phpcs:enable WordPress.NamingConventions.PrefixAllGlobals
