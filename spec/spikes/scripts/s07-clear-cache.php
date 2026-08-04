<?php
/**
 * WP-S07 spike: exercise Elementor files_manager->clear_cache() programmatically
 * and report which files remain in uploads/elementor/css/ + the running uid.
 */
$css_dir = WP_CONTENT_DIR . '/uploads/elementor/css/';

$before = glob( $css_dir . '*' );
WP_CLI::log( 'RUN-UID: ' . ( function_exists( 'posix_getuid' ) ? posix_getuid() : 'posix-unavailable' ) );
WP_CLI::log( 'FILES-BEFORE: ' . count( $before ) );
foreach ( $before as $f ) {
	WP_CLI::log( '  before: ' . basename( $f ) . ' (writable-dir=' . ( is_writable( dirname( $f ) ) ? 'yes' : 'no' ) . ', writable-file=' . ( is_writable( $f ) ? 'yes' : 'no' ) . ')' );
}

\Elementor\Plugin::$instance->files_manager->clear_cache();

clearstatcache();
$after = glob( $css_dir . '*' );
WP_CLI::log( 'FILES-AFTER: ' . count( $after ) );
foreach ( $after as $f ) {
	WP_CLI::log( '  remaining: ' . basename( $f ) );
}

global $wpdb;
$css_meta = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key='_elementor_css'" );
$cache_meta = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key='_elementor_element_cache'" );
WP_CLI::log( 'META-AFTER _elementor_css=' . $css_meta . ' _elementor_element_cache=' . $cache_meta );
WP_CLI::log( 'VERDICT: ' . ( count( $after ) === 0 ? 'FILES-CLEARED' : 'FILES-REMAIN' ) );
