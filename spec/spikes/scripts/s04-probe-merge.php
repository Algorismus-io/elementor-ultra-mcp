<?php
/**
 * WP-S04 probe: does Document::save(['settings'=>...]) MERGE or REPLACE
 * the _elementor_page_settings meta? Also tests Document::update_settings()
 * for comparison, and nested-key behavior.
 */

use Elementor\Plugin;
use Elementor\Core\Settings\Page\Manager as PageManager;

function out( $label, $val ) {
	echo "==== $label ====\n";
	echo var_export( $val, true ) . "\n\n";
}

function read_meta( $id ) {
	// raw, unserialized post meta exactly as stored
	return get_post_meta( $id, PageManager::META_KEY, true );
}

// ---------------------------------------------------------------------------
// Create a fresh Elementor page
// ---------------------------------------------------------------------------
$post_id = wp_insert_post( [
	'post_title'  => 'WP-S04 probe page ' . time(),
	'post_status' => 'publish',
	'post_type'   => 'page',
] );
update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );

echo "META_KEY = " . PageManager::META_KEY . "\n";
echo "post_id  = $post_id\n\n";

$doc = Plugin::$instance->documents->get( $post_id );
if ( ! $doc ) {
	echo "ERROR: could not get document for post $post_id\n";
	return;
}
echo "doc class = " . get_class( $doc ) . "\n\n";

// ---------------------------------------------------------------------------
// TEST A: save() path with a 3-key seed, then a 1-key patch
// ---------------------------------------------------------------------------
echo "############ TEST A: Document::save(['settings'=>...]) ############\n\n";

// Seed: 3 top-level keys of different types + 1 nested array
$doc->save( [ 'settings' => [
	'a' => 1,
	'b' => 'two',
	'c' => [ 'x' => 'nested-x', 'y' => 'nested-y' ],
] ] );
out( 'A1 after seed {a,b,c{x,y}}', read_meta( $post_id ) );

// re-fetch doc fresh to avoid in-memory caching influencing the test
$doc = Plugin::$instance->documents->get( $post_id, false );

// Patch: a single unrelated key
$doc->save( [ 'settings' => [ 'b' => 'CHANGED' ] ] );
out( 'A2 after save() patch {b:CHANGED}', read_meta( $post_id ) );

$metaA = read_meta( $post_id );
$a_survived  = ( is_array( $metaA ) && array_key_exists( 'a', $metaA ) );
$c_survived  = ( is_array( $metaA ) && array_key_exists( 'c', $metaA ) );
echo "A VERDICT: key 'a' survived patch? " . ( $a_survived ? 'YES (merge)' : 'NO (replace)' ) . "\n";
echo "A VERDICT: key 'c' survived patch? " . ( $c_survived ? 'YES (merge)' : 'NO (replace)' ) . "\n\n";

// ---------------------------------------------------------------------------
// TEST B: update_settings() path (the documented "merge" method)
// ---------------------------------------------------------------------------
echo "############ TEST B: Document::update_settings([...]) ############\n\n";

$post_id2 = wp_insert_post( [
	'post_title'  => 'WP-S04 probe page B ' . time(),
	'post_status' => 'publish',
	'post_type'   => 'page',
] );
update_post_meta( $post_id2, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_id2, '_elementor_version', ELEMENTOR_VERSION );

$doc2 = Plugin::$instance->documents->get( $post_id2 );

$doc2->save( [ 'settings' => [
	'a' => 1,
	'b' => 'two',
	'c' => [ 'x' => 'nested-x', 'y' => 'nested-y' ],
] ] );
out( 'B1 after seed {a,b,c{x,y}}', read_meta( $post_id2 ) );

$doc2 = Plugin::$instance->documents->get( $post_id2, false );

// patch one top-level key + one nested key via update_settings
$doc2->update_settings( [ 'b' => 'CHANGED', 'c' => [ 'x' => 'NEWX' ] ] );
out( 'B2 after update_settings({b:CHANGED, c:{x:NEWX}})', read_meta( $post_id2 ) );

$metaB = read_meta( $post_id2 );
$a_survived_B   = ( is_array( $metaB ) && array_key_exists( 'a', $metaB ) );
$cy_survived_B  = ( is_array( $metaB ) && isset( $metaB['c'] ) && is_array( $metaB['c'] ) && array_key_exists( 'y', $metaB['c'] ) );
$cx_changed_B   = ( is_array( $metaB ) && isset( $metaB['c']['x'] ) && $metaB['c']['x'] === 'NEWX' );
echo "B VERDICT: top-level 'a' survived update_settings? " . ( $a_survived_B ? 'YES' : 'NO' ) . "\n";
echo "B VERDICT: nested 'c.y' survived (deep merge)? " . ( $cy_survived_B ? 'YES' : 'NO' ) . "\n";
echo "B VERDICT: nested 'c.x' updated to NEWX? " . ( $cx_changed_B ? 'YES' : 'NO' ) . "\n\n";

echo "DONE. cleanup post ids: $post_id, $post_id2\n";
wp_delete_post( $post_id, true );
wp_delete_post( $post_id2, true );
echo "cleaned up.\n";
