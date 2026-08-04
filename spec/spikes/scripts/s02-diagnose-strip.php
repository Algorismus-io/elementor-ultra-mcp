<?php
/**
 * WP-S02 diagnostic: WHY does get_data() drop the global-class ref?
 * Hypothesis: get_elements_data() prunes global-class ids not present (by ID) in the kit.
 * Reset the kit so it has an item whose ID == 's02card' (label s02card), then re-read.
 */
use Elementor\Plugin;
use Elementor\Modules\GlobalClasses\Global_Classes_Repository;

if ( ! defined( 'ABSPATH' ) ) { exit; }
$admin = get_user_by( 'login', 'admin' );
if ( $admin ) { wp_set_current_user( $admin->ID ); }
function d_out( $l, $v ) { echo "==== $l ====\n" . ( is_string( $v ) ? $v : print_r( $v, true ) ) . "\n"; }

$state = json_decode( file_get_contents( '/spikes/s02-state.json' ), true );
$template_id = (int) $state['template_id'];

// Show raw stored data class refs (authoritative truth in DB).
$raw = json_decode( get_post_meta( $template_id, '_elementor_data', true ), true );
$div_classes = $raw[0]['settings']['classes']['value'] ?? null;
d_out( 'STORED_DB_DIV_CLASS_REFS (truth)', $div_classes );

// Reset kit: remove any s02card* and create a clean id 's02card' (label s02card).
$repo = Global_Classes_Repository::make()->set_preview( false );
$items = $repo->all()->get_items()->all();
$order = $repo->get_order();
foreach ( array_keys( $items ) as $id ) {
	if ( ( $items[ $id ]['label'] ?? '' ) === 's02card' ) { unset( $items[ $id ] ); }
}
$order = array_values( array_filter( $order, fn( $id ) => isset( $items[ $id ] ) ) );
$items['s02card'] = [
	'id' => 's02card', 'type' => 'class', 'label' => 's02card',
	'variants' => [ [ 'meta' => [ 'breakpoint' => 'desktop', 'state' => null ], 'props' => [
		'background' => [ '$$type' => 'background', 'value' => [ 'color' => [ '$$type' => 'color', 'value' => 'rgb(12, 34, 56)' ] ] ],
	] ] ],
];
$order[] = 's02card';
$repo->apply_changes( $items, [ 'added' => [ 's02card' ], 'deleted' => [], 'order' => true ], $order );
d_out( 'KIT_LABELS_AFTER_RESET', Global_Classes_Repository::make()->set_preview( false )->all_labels() );
d_out( 'KIT_ITEM_IDS_AFTER_RESET', array_keys( Global_Classes_Repository::make()->set_preview( false )->all()->get_items()->all() ) );

// Now read get_data again — does s02card survive in content + snapshot?
$source = Plugin::$instance->templates_manager->get_source( 'local' );
$data = $source->get_data( [ 'template_id' => $template_id ] );
$div = $data['content'][0] ?? [];
d_out( 'GETDATA_DIV_CLASS_REFS (kit id == s02card)', $div['settings']['classes']['value'] ?? null );
d_out( 'GETDATA_SNAPSHOT_ITEM_IDS', array_keys( $data['global_classes']['items'] ?? [] ) );

// Also test get_elements_data directly (the method get_data calls before replace ids).
$document = Plugin::$instance->documents->get( $template_id );
$elems = $document->get_elements_data();
$div2 = $elems[0] ?? [];
d_out( 'RAW_get_elements_data_DIV_CLASS_REFS', $div2['settings']['classes']['value'] ?? null );
