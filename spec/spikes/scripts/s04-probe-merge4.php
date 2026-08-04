<?php
/**
 * WP-S04 probe v4: figure out WHY save() leaves meta empty in wp-cli.
 * Hypothesis: is_editable_by_current_user() is false (no logged-in user in CLI),
 * so save() bails early (returns false) and never writes. Set an admin user
 * and re-test save() merge-vs-replace with valid keys.
 */

use Elementor\Plugin;
use Elementor\Core\Settings\Page\Manager as PageManager;

function out( $label, $val ) {
	echo "==== $label ====\n";
	echo var_export( $val, true ) . "\n\n";
}
function read_meta( $id ) {
	return get_post_meta( $id, PageManager::META_KEY, true );
}

// Become admin so is_editable_by_current_user() passes.
$admin = get_user_by( 'login', 'admin' );
wp_set_current_user( $admin->ID );
echo "current user = " . wp_get_current_user()->user_login . " ; can unfiltered_html? " . ( current_user_can('unfiltered_html') ? 'yes' : 'no' ) . "\n\n";

$post_id = wp_insert_post( [
	'post_title'  => 'WP-S04 v4 ' . time(),
	'post_status' => 'publish',
	'post_type'   => 'page',
	'post_author' => $admin->ID,
] );
update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );

$doc = Plugin::$instance->documents->get( $post_id );
echo "post_id = $post_id ; editable_by_current_user = " . ( $doc->is_editable_by_current_user() ? 'YES' : 'NO' ) . "\n\n";

// Seed THREE valid persistable keys incl a nested one.
$ret1 = $doc->save( [ 'settings' => [
	'background_background' => 'classic',
	'background_color'      => '#333333',
	'padding'               => [ 'unit' => 'px', 'top' => '10', 'right' => '20', 'bottom' => '30', 'left' => '40', 'isLinked' => false ],
] ] );
echo "save() seed returned: " . var_export( $ret1, true ) . "\n";
out( 'seed meta', read_meta( $post_id ) );

// Patch with ONLY background_color, omitting the other two.
$doc = Plugin::$instance->documents->get( $post_id, false );
$ret2 = $doc->save( [ 'settings' => [ 'background_color' => '#444444' ] ] );
echo "save() patch returned: " . var_export( $ret2, true ) . "\n";
out( 'after save({background_color ONLY})', read_meta( $post_id ) );

$m = read_meta( $post_id );
echo "VERDICT background_background survived omission? " . ( ( is_array($m) && array_key_exists('background_background',$m) ) ? 'YES (merge)' : 'NO (REPLACE)' ) . "\n";
echo "VERDICT padding (nested) survived omission?      " . ( ( is_array($m) && array_key_exists('padding',$m) ) ? 'YES (merge)' : 'NO (REPLACE)' ) . "\n";
echo "VERDICT remaining keys: " . ( is_array($m) ? implode(',', array_keys($m)) : '(not array: '.var_export($m,true).')' ) . "\n";

wp_delete_post( $post_id, true );
echo "cleaned up $post_id\n";
