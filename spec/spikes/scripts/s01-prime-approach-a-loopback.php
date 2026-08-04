<?php
/**
 * WP-S01 Approach A: LOOPBACK prime (server-side HTTP GET that primes atomic CSS).
 *
 * Findings baked in:
 *  - WP's siteurl (http://localhost:8899) is the host-published port; it is NOT
 *    reachable from inside the WP container. The internal Apache listens on :80.
 *  - Hitting the internal listener with the WRONG Host triggers a 301 canonical
 *    redirect to siteurl (unreachable). The fix: GET the internal loopback address
 *    with a Host header equal to the site's host, and do NOT follow redirects.
 *  - This is the "self loopback host mismatch" caveat the prime-css WP must handle:
 *    prefer wp_remote_get(home_url()) (works in prod where the domain resolves to
 *    the same host); fall back to a 127.0.0.1 GET + explicit Host header.
 *
 * Run AFTER s01-save-atomic-tree.php. Reads /spikes/s01-state.json.
 * Establish the residual first by deleting the css files as www-data:
 *   docker compose ... exec -T wordpress sh -c "rm -f .../uploads/elementor/css/*.css"
 * AND firing the clear-cache hook (done below) so cache-validity is reset.
 */

use Elementor\Plugin;

if ( ! defined( 'ABSPATH' ) ) { exit; }

$admin = get_user_by( 'login', 'admin' );
if ( $admin ) { wp_set_current_user( $admin->ID ); }

$state_path = getenv( 'S01_STATE' ) ?: '/spikes/s01-state.json';
$state = json_decode( file_get_contents( $state_path ), true );
$post_id = (int) $state['post_id'];
$css_dir = $state['css_dir'];
$local_style_id = $state['local_style_id'];
$global_class_id = $state['global_class_id'];

function s01a_out( $label, $val ) {
	echo "==== $label ====\n";
	echo ( is_string( $val ) ? $val : print_r( $val, true ) ) . "\n";
}
function s01a_files( $css_dir ) {
	clearstatcache();
	return is_dir( $css_dir ) ? array_values( array_diff( scandir( $css_dir ), [ '.', '..' ] ) ) : [];
}

// Reset atomic cache-validity so a render regenerates (mirrors files clear_cache hook).
do_action( 'elementor/core/files/clear_cache' );
s01a_out( 'RESIDUAL css files (after manual rm + cache-validity reset)', s01a_files( $css_dir ) );

// ---- Loopback recipe ----
// 1) Try the canonical wp_remote_get(home_url()) first (prod-correct path).
$home_url = add_query_arg( 'page_id', $post_id, home_url( '/' ) );
$home_url = get_permalink( $post_id );
s01a_out( 'LOOPBACK A1 wp_remote_get(home_url)', $home_url );
$r1 = wp_remote_get( $home_url, [ 'timeout' => 30, 'sslverify' => false, 'redirection' => 0 ] );
s01a_out( 'A1 result', is_wp_error( $r1 ) ? 'WP_ERROR: ' . $r1->get_error_message() : ( 'HTTP ' . wp_remote_retrieve_response_code( $r1 ) . ' bytes=' . strlen( wp_remote_retrieve_body( $r1 ) ) ) );

// 2) Fallback: internal loopback IP + Host header (dev host-mismatch path).
$home_host = wp_parse_url( home_url(), PHP_URL_HOST );
$home_port = wp_parse_url( home_url(), PHP_URL_PORT );
$host_header = $home_host . ( $home_port ? ':' . $home_port : '' );
$internal_url = 'http://127.0.0.1/?page_id=' . $post_id;
s01a_out( 'LOOPBACK A2 internal IP', $internal_url . ' [Host: ' . $host_header . ']' );
$r2 = wp_remote_get( $internal_url, [
	'timeout' => 30,
	'sslverify' => false,
	'redirection' => 0,
	'headers' => [ 'Host' => $host_header ],
] );
s01a_out( 'A2 result', is_wp_error( $r2 ) ? 'WP_ERROR: ' . $r2->get_error_message() : ( 'HTTP ' . wp_remote_retrieve_response_code( $r2 ) . ' bytes=' . strlen( wp_remote_retrieve_body( $r2 ) ) ) );

// ---- Re-check the per-breakpoint atomic CSS files ----
$local_path  = $css_dir . "local-{$post_id}-frontend-desktop.css";
$global_path = $css_dir . "global-{$post_id}-frontend-desktop.css";
$base_path   = $css_dir . 'base-desktop.css';

s01a_out( 'AFTER_LOOPBACK css files', s01a_files( $css_dir ) );
s01a_out( 'LOCAL CSS', file_exists( $local_path ) ? file_get_contents( $local_path ) : '(missing)' );
s01a_out( 'GLOBAL CSS', file_exists( $global_path ) ? file_get_contents( $global_path ) : '(missing)' );
s01a_out( 'BASE CSS', file_exists( $base_path ) ? ( filesize( $base_path ) . ' bytes' ) : '(missing)' );

$local_ok  = file_exists( $local_path ) && strpos( file_get_contents( $local_path ), $local_style_id ) !== false;
$global_ok = file_exists( $global_path ) && strpos( file_get_contents( $global_path ), $global_class_id ) !== false;
s01a_out( 'APPROACH_A VERDICT', ( $local_ok && $global_ok ) ? 'PASS' : 'FAIL (local_ok=' . var_export( $local_ok, true ) . ' global_ok=' . var_export( $global_ok, true ) . ')' );
