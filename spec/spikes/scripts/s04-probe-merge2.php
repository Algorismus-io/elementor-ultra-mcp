<?php
/**
 * WP-S04 probe v2: use REAL registered page-setting control names so the
 * settings actually persist, then determine MERGE vs REPLACE for
 * Document::save(['settings'=>...]) vs Document::update_settings().
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
	'post_title'  => 'WP-S04 v2 ' . time(),
	'post_status' => 'publish',
	'post_type'   => 'page',
] );
update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );

$doc = Plugin::$instance->documents->get( $post_id );
echo "post_id = $post_id ; doc = " . get_class( $doc ) . "\n\n";

// Discover real control names available on this document's page settings.
$controls = $doc->get_controls();
$names = array_keys( $controls );
echo "Total registered controls: " . count( $names ) . "\n";
echo "Sample control names: " . implode( ', ', array_slice( $names, 0, 40 ) ) . "\n\n";

// Pick a few simple scalar text/select controls we can set unambiguously.
// Common stable ones: 'post_title', 'template', 'page_layout' may exist.
$candidates = [ 'template', 'post_status', 'page_title', 'hide_title' ];
$present = [];
foreach ( $candidates as $c ) {
	echo "candidate '$c' registered? " . ( isset( $controls[ $c ] ) ? 'YES' : 'no' ) . "\n";
	if ( isset( $controls[ $c ] ) ) $present[] = $c;
}
echo "\n";

// ---------------------------------------------------------------------------
// Definitive low-level confirmation of the write op (REPLACE):
// Seed meta DIRECTLY with arbitrary keys, then call save() with a different
// key set, and observe whether save() overwrote or merged the raw meta.
// This isolates the WRITE semantics from control-validation/filtering.
// ---------------------------------------------------------------------------
echo "############ TEST C: raw write semantics of save_settings ############\n\n";

// Seed raw meta directly so we KNOW it exists, bypassing any save() filtering.
update_post_meta( $post_id, PageManager::META_KEY, [ 'seed_a' => 1, 'seed_b' => 'two', 'seed_c' => [ 'x' => 'X', 'y' => 'Y' ] ] );
out( 'C0 raw-seeded meta', read_meta( $post_id ) );

// Now call the protected save_settings via reflection with a single key.
$ref = new ReflectionMethod( $doc, 'save_settings' );
$ref->setAccessible( true );
$ref->invoke( $doc, [ 'template' => 'elementor_canvas' ] );
out( 'C1 after save_settings({template}) [REPLACE test]', read_meta( $post_id ) );

$metaC = read_meta( $post_id );
$seed_a_survived = ( is_array( $metaC ) && array_key_exists( 'seed_a', $metaC ) );
echo "C VERDICT: pre-existing 'seed_a' survived save_settings()? " . ( $seed_a_survived ? 'YES (merge)' : 'NO (REPLACE)' ) . "\n";
echo "C VERDICT: only the new key remains? " . ( is_array($metaC) && array_keys($metaC) === ['template'] ? 'YES' : 'no' ) . "\n\n";

// ---------------------------------------------------------------------------
// TEST D: update_settings() against a raw-seeded meta (merge confirmation)
// ---------------------------------------------------------------------------
echo "############ TEST D: update_settings against pre-existing meta ############\n\n";
update_post_meta( $post_id, PageManager::META_KEY, [ 'seed_a' => 1, 'seed_b' => 'two', 'seed_c' => [ 'x' => 'X', 'y' => 'Y' ] ] );
out( 'D0 raw-seeded meta', read_meta( $post_id ) );

$doc = Plugin::$instance->documents->get( $post_id, false ); // fresh, clears get_meta cache
$doc->update_settings( [ 'seed_b' => 'CHANGED', 'seed_c' => [ 'x' => 'NEWX' ] ] );
out( 'D1 after update_settings({seed_b:CHANGED, seed_c:{x:NEWX}})', read_meta( $post_id ) );

$metaD = read_meta( $post_id );
echo "D VERDICT: 'seed_a' survived?            " . ( ( is_array($metaD) && array_key_exists('seed_a',$metaD) ) ? 'YES' : 'NO' ) . "\n";
echo "D VERDICT: nested 'seed_c.y' survived?   " . ( ( is_array($metaD) && isset($metaD['seed_c']['y']) ) ? 'YES (deep merge)' : 'NO' ) . "\n";
echo "D VERDICT: nested 'seed_c.x' == NEWX?    " . ( ( is_array($metaD) && ($metaD['seed_c']['x'] ?? null) === 'NEWX' ) ? 'YES' : 'no' ) . "\n";
echo "D VERDICT: 'seed_b' == CHANGED?          " . ( ( is_array($metaD) && ($metaD['seed_b'] ?? null) === 'CHANGED' ) ? 'YES' : 'no' ) . "\n\n";

wp_delete_post( $post_id, true );
echo "cleaned up post $post_id\n";
