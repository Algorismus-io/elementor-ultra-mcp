<?php
/**
 * WP-S01 Approach B: PROGRAMMATIC prime (no HTTP loopback).
 *
 * The atomic styles manager binds:
 *   - elementor/post/render          -> records the post id
 *   - elementor/frontend/after_enqueue_post_styles -> enqueue_styles() (the emitter)
 *
 * enqueue_styles() bails unless post_ids is non-empty, then fires
 *   do_action('elementor/atomic-widgets/styles/register', $manager, $post_ids)
 * which is where Atomic_Widget_Styles + Atomic_Global_Styles register their
 * per-post style callbacks, after which the CSS_Files_Manager writes the files.
 *
 * So in-process we can try to emit the files by dispatching, in order:
 *   1) do_action('elementor/post/render', $post_id)
 *   2) do_action('elementor/frontend/after_enqueue_post_styles')
 *
 * This requires the frontend + atomic styles manager hooks to be REGISTERED in
 * the current (CLI) request. They normally register on 'wp'/frontend init; in a
 * non-frontend request they may not be wired. We force frontend init first.
 *
 * Reads state from $S01_STATE (default /spikes/s01-state.json).
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

function s01b_out( $label, $val ) {
	echo "==== $label ====\n";
	echo ( is_string( $val ) ? $val : print_r( $val, true ) ) . "\n";
}
function s01b_files( $css_dir ) {
	clearstatcache();
	return is_dir( $css_dir ) ? array_values( array_diff( scandir( $css_dir ), [ '.', '..' ] ) ) : [];
}

// Reset atomic cache-validity so a render regenerates. The per-breakpoint files
// will NOT be (re)written by get() if cache-validity still marks them valid, so we
// must invalidate the atomic style subtrees explicitly (this both deletes any
// existing files and invalidates the nested cache-validity nodes).
do_action( 'elementor/atomic-widgets/styles/clear', [ 'local' ] );
do_action( 'elementor/atomic-widgets/styles/clear', [ 'global' ] );
do_action( 'elementor/atomic-widgets/styles/clear', [ 'base' ] );
s01b_out( 'RESIDUAL css files', s01b_files( $css_dir ) );

// Did the frontend register the atomic-styles-manager hook? (It registers on init.)
$has_after_enqueue = has_action( 'elementor/frontend/after_enqueue_post_styles' );
$has_post_render   = has_action( 'elementor/post/render' );
$has_styles_reg    = has_action( 'elementor/atomic-widgets/styles/register' );
s01b_out( 'HOOKS before forcing frontend', [
	'after_enqueue_post_styles' => $has_after_enqueue ? 'registered' : 'NONE',
	'post/render'               => $has_post_render ? 'registered' : 'NONE',
	'atomic-widgets/styles/register' => $has_styles_reg ? 'registered' : 'NONE',
] );

// Force WordPress to think we are on the singular front-end for this post so that
// any context checks (is_singular / get_the_ID) behave during the dispatch.
global $wp_query, $post;
$post = get_post( $post_id );
setup_postdata( $post );
$wp_query->is_singular = true;
$wp_query->is_page = true;
$wp_query->queried_object = $post;
$wp_query->queried_object_id = $post_id;

// Ensure Elementor frontend hooks are registered (they may be lazy on CLI).
if ( isset( Plugin::$instance->frontend ) && method_exists( Plugin::$instance->frontend, 'register_styles' ) ) {
	// no-op; just ensuring the object exists
}
do_action( 'wp' ); // let late frontend registrations attach

$has_after_enqueue2 = has_action( 'elementor/frontend/after_enqueue_post_styles' );
$has_post_render2   = has_action( 'elementor/post/render' );
$has_styles_reg2    = has_action( 'elementor/atomic-widgets/styles/register' );
s01b_out( 'HOOKS after do_action(wp)', [
	'after_enqueue_post_styles' => $has_after_enqueue2 ? 'registered' : 'NONE',
	'post/render'               => $has_post_render2 ? 'registered' : 'NONE',
	'atomic-widgets/styles/register' => $has_styles_reg2 ? 'registered' : 'NONE',
] );

// PROGRAMMATIC DISPATCH of the render + enqueue flow.
do_action( 'elementor/post/render', $post_id );
do_action( 'elementor/frontend/after_enqueue_post_styles' );

s01b_out( 'AFTER programmatic dispatch css files', s01b_files( $css_dir ) );

$local_path  = $css_dir . "local-{$post_id}-frontend-desktop.css";
$global_path = $css_dir . "global-{$post_id}-frontend-desktop.css";
$base_path   = $css_dir . 'base-desktop.css';

s01b_out( 'LOCAL CSS', file_exists( $local_path ) ? file_get_contents( $local_path ) : '(missing)' );
s01b_out( 'GLOBAL CSS', file_exists( $global_path ) ? file_get_contents( $global_path ) : '(missing)' );
s01b_out( 'BASE CSS', file_exists( $base_path ) ? ( filesize( $base_path ) . ' bytes' ) : '(missing)' );

$local_ok  = file_exists( $local_path ) && strpos( file_get_contents( $local_path ), $local_style_id ) !== false;
$global_ok = file_exists( $global_path ) && strpos( file_get_contents( $global_path ), $global_class_id ) !== false;
s01b_out( 'APPROACH_B VERDICT', ( $local_ok && $global_ok ) ? 'PASS' : 'FAIL (local_ok=' . var_export( $local_ok, true ) . ' global_ok=' . var_export( $global_ok, true ) . ')' );
