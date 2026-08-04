<?php
/**
 * WP-S04 probe v3: prove REPLACE with a NON-special, persistable control key
 * (background_color) so the result is not affected by special-setting stripping.
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

$post_id = wp_insert_post( [
	'post_title'  => 'WP-S04 v3 ' . time(),
	'post_status' => 'publish',
	'post_type'   => 'page',
] );
update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );

$doc = Plugin::$instance->documents->get( $post_id );
echo "post_id = $post_id\n\n";

// Seed via save() with two real, persistable, non-special controls.
$doc->save( [ 'settings' => [
	'background_background' => 'classic',
	'background_color'      => '#111111',
] ] );
out( 'S1 after save() seed {background_background, background_color}', read_meta( $post_id ) );

// Now patch a DIFFERENT single key via save().
$doc = Plugin::$instance->documents->get( $post_id, false );
$doc->save( [ 'settings' => [
	'background_background' => 'classic',
	'background_color'      => '#222222',
] ] );
out( 'S2 after save() {background_color:#222222 only changes color}', read_meta( $post_id ) );

// Critical REPLACE test: patch with ONLY one key, omit the other entirely.
$doc = Plugin::$instance->documents->get( $post_id, false );
// re-seed two keys first
$doc->save( [ 'settings' => [
	'background_background' => 'classic',
	'background_color'      => '#333333',
	'padding'              => [ 'unit' => 'px', 'top' => '10', 'right' => '20', 'bottom' => '30', 'left' => '40', 'isLinked' => false ],
] ] );
out( 'S3 re-seed three keys (incl nested padding)', read_meta( $post_id ) );

$doc = Plugin::$instance->documents->get( $post_id, false );
// Patch with ONLY background_color (omit background_background + padding)
$doc->save( [ 'settings' => [ 'background_color' => '#444444' ] ] );
out( 'S4 after save({background_color ONLY}) -- did other keys survive?', read_meta( $post_id ) );

$m = read_meta( $post_id );
echo "VERDICT background_background survived omission? " . ( ( is_array($m) && array_key_exists('background_background',$m) ) ? 'YES (merge)' : 'NO (REPLACE)' ) . "\n";
echo "VERDICT padding (nested) survived omission?      " . ( ( is_array($m) && array_key_exists('padding',$m) ) ? 'YES (merge)' : 'NO (REPLACE)' ) . "\n";
echo "VERDICT only background_color remains?           " . ( ( is_array($m) && array_keys($m) === ['background_color'] ) ? 'YES' : 'no' ) . "\n";
echo "raw remaining keys: " . ( is_array($m) ? implode(',', array_keys($m)) : '(not array: '.var_export($m,true).')' ) . "\n\n";

wp_delete_post( $post_id, true );
echo "cleaned up $post_id\n";
