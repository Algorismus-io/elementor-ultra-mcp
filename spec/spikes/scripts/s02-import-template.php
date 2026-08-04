<?php
/**
 * WP-S02 step 2 (corrected): re-import / insert the saved template into ANOTHER
 * document, exercising the REAL editor "insert template" pipeline:
 *
 *   (a) Source_Local::get_data(template_id)  -> content (re-IDed) + global_classes snapshot
 *       (CAPTURED WHILE the class still exists in the kit, so the snapshot is populated
 *        and content keeps the global-class ref — this is what the editor receives.)
 *   (b) Templates_Manager::process_global_styles({content, global_classes, import_mode})
 *         == apply_filters('elementor/template_library/import/process_content', ...)
 *         -> merges global classes into the kit and rewrites class ids in content
 *   (c) Document::save() the processed content into a fresh draft doc.
 *
 * Scenarios:
 *   B (clean kit, class re-created): delete s02card AFTER capturing get_data, then merge ->
 *      class must be RE-CREATED in the kit (no orphan), content ref preserved.
 *   A (label-match reuse + id remap): kit already has s02card (the just-recreated one);
 *      import the captured snapshot but with the class id renamed to s02card-imp (label
 *      still 's02card') -> merge must REUSE the existing kit class (no dup) and REMAP
 *      s02card-imp -> existing kit id in content (id_map proof).
 */

use Elementor\Plugin;
use Elementor\Modules\GlobalClasses\Global_Classes_Repository;
use Elementor\Core\Utils\Template_Library_Import_Export_Utils;

if ( ! defined( 'ABSPATH' ) ) { exit; }

$admin = get_user_by( 'login', 'admin' );
if ( $admin ) { wp_set_current_user( $admin->ID ); }

function s02i_out( $label, $val ) {
	echo "==== $label ====\n";
	echo ( is_string( $val ) ? $val : print_r( $val, true ) ) . "\n";
}
function s02_collect( $els ) {
	$ids = []; $style_ids = []; $class_refs = [];
	$walk = function ( $els ) use ( &$walk, &$ids, &$style_ids, &$class_refs ) {
		foreach ( $els as $el ) {
			if ( isset( $el['id'] ) ) { $ids[] = $el['id']; }
			foreach ( array_keys( $el['styles'] ?? [] ) as $sk ) { $style_ids[] = $sk; }
			$cv = $el['settings']['classes']['value'] ?? [];
			if ( is_array( $cv ) ) { foreach ( $cv as $c ) { $class_refs[] = $c; } }
			if ( ! empty( $el['elements'] ) ) { $walk( $el['elements'] ); }
		}
	};
	$walk( $els );
	return [ 'ids' => $ids, 'style_ids' => $style_ids, 'class_refs' => array_values( array_unique( $class_refs ) ) ];
}

$state = json_decode( file_get_contents( '/spikes/s02-state.json' ), true );
$template_id = (int) $state['template_id'];
$gc_id = $state['gc_id']; // s02card
s02i_out( 'TEMPLATE_ID / GC_ID', [ $template_id, $gc_id ] );

$source = Plugin::$instance->templates_manager->get_source( 'local' );
$manager = Plugin::$instance->templates_manager;

// Make sure s02card EXISTS in the kit before we read (the import run is independent).
$repo = Global_Classes_Repository::make()->set_preview( false );
$labels_now = $repo->all_labels();
if ( ! in_array( 's02card', $labels_now, true ) ) {
	$items = $repo->all()->get_items()->all();
	$order = $repo->get_order();
	$items[ $gc_id ] = [
		'id' => $gc_id, 'type' => 'class', 'label' => $gc_id,
		'variants' => [ [ 'meta' => [ 'breakpoint' => 'desktop', 'state' => null ], 'props' => [
			'background' => [ '$$type' => 'background', 'value' => [ 'color' => [ '$$type' => 'color', 'value' => 'rgb(12, 34, 56)' ] ] ],
			'padding' => [ '$$type' => 'dimensions', 'value' => [
				'block-start' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 20 ] ],
				'block-end'   => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 20 ] ],
				'inline-start'=> [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 28 ] ],
				'inline-end'  => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 28 ] ],
			] ],
		] ] ],
	];
	if ( ! in_array( $gc_id, $order, true ) ) { $order[] = $gc_id; }
	$repo->apply_changes( [ $gc_id => $items[ $gc_id ] ], [ 'added' => [ $gc_id ], 'order' => true ], $order );
}
s02i_out( 'KIT_LABELS_BEFORE_READ', Global_Classes_Repository::make()->set_preview( false )->all_labels() );

// (a) CAPTURE get_data WHILE the class exists.
$captured = $source->get_data( [ 'template_id' => $template_id ] );
$cap = s02_collect( $captured['content'] );
s02i_out( 'CAPTURED_CONTENT_ELEMENT_IDS', $cap['ids'] );
s02i_out( 'CAPTURED_CONTENT_STYLE_IDS', $cap['style_ids'] );
s02i_out( 'CAPTURED_CONTENT_CLASS_REFS (must include s02card)', $cap['class_refs'] );
s02i_out( 'CAPTURED_SNAPSHOT_ITEM_IDS (must include s02card)', array_keys( $captured['global_classes']['items'] ?? [] ) );

$result = [
	'captured' => [
		'content_class_refs' => $cap['class_refs'],
		'content_style_ids' => $cap['style_ids'],
		'content_element_ids' => $cap['ids'],
		'snapshot_item_ids' => array_keys( $captured['global_classes']['items'] ?? [] ),
	],
];

// ===========================================================================
// SCENARIO B: delete s02card from kit, then import captured payload -> re-create.
// ===========================================================================
s02i_out( 'SCENARIO', 'B (clean kit -> class re-created, no orphan)' );
$repoB = Global_Classes_Repository::make()->set_preview( false );
$itemsB = $repoB->all()->get_items()->all();
$orderB = $repoB->get_order();
if ( isset( $itemsB[ $gc_id ] ) ) {
	unset( $itemsB[ $gc_id ] );
	$repoB->apply_changes( $itemsB, [ 'deleted' => [ $gc_id ], 'order' => true ], array_values( array_filter( $orderB, fn( $id ) => $id !== $gc_id ) ) );
}
s02i_out( 'B_KIT_LABELS_AFTER_DELETE', Global_Classes_Repository::make()->set_preview( false )->all_labels() );

$proc_b = $manager->process_global_styles( [
	'content' => wp_json_encode( $captured['content'] ),
	'global_classes' => wp_json_encode( $captured['global_classes'] ?? [] ),
	'import_mode' => Template_Library_Import_Export_Utils::IMPORT_MODE_MATCH_SITE,
] );
if ( is_wp_error( $proc_b ) ) { s02i_out( 'B_PROCESS_WP_ERROR', $proc_b->get_error_code() . ': ' . $proc_b->get_error_message() ); return; }
$after_b = s02_collect( $proc_b['content'] );
s02i_out( 'B_PROCESSED_CLASS_REFS', $after_b['class_refs'] );
s02i_out( 'B_PROCESSED_STYLE_IDS', $after_b['style_ids'] );
s02i_out( 'B_updated_global_classes', $proc_b['updated_global_classes'] ?? '(none)' );
s02i_out( 'B_KIT_LABELS_AFTER_IMPORT (s02card must be back, exactly once)', Global_Classes_Repository::make()->set_preview( false )->all_labels() );

$post_b = wp_insert_post( [ 'post_title' => 'S02 Import Target B', 'post_status' => 'publish', 'post_type' => 'page' ] );
update_post_meta( $post_b, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_b, '_elementor_template_type', 'wp-page' );
$saved_b = Plugin::$instance->documents->get( $post_b )->save( [ 'elements' => $proc_b['content'], 'settings' => [] ] );
s02i_out( 'B_TARGET_DOC_SAVE', [ 'post_id' => $post_b, 'saved' => $saved_b ? 'TRUE' : 'FALSE' ] );
$rel_b = get_post_meta( $post_b, '_elementor_used_global_class', false );
s02i_out( 'B_TARGET_RELATIONS (must include s02card)', $rel_b );

$result['scenario_b'] = [
	'kit_labels_after_delete' => Global_Classes_Repository::make()->set_preview( false )->all_labels(),
	'processed_class_refs' => $after_b['class_refs'],
	'processed_style_ids' => $after_b['style_ids'],
	'updated_global_classes' => $proc_b['updated_global_classes'] ?? null,
	'kit_labels_after_import' => Global_Classes_Repository::make()->set_preview( false )->all_labels(),
	'target_post_id' => $post_b,
	'target_relations' => $rel_b,
];

// ===========================================================================
// SCENARIO A: kit has s02card; import same content but class id renamed to
// s02card-imp (label still s02card) -> reuse existing kit id, remap in content.
// ===========================================================================
s02i_out( 'SCENARIO', 'A (label-match reuse + id remap, no dup)' );
$kit_a = Global_Classes_Repository::make()->set_preview( false );
$existing_id = array_search( 's02card', $kit_a->all_labels(), true );
s02i_out( 'A_EXISTING_KIT_ID_FOR_LABEL_s02card', $existing_id );

$import_id = 's02card-imp';
$content_a = $captured['content'];
$rewrite = function ( $els ) use ( &$rewrite, $existing_id, $import_id ) {
	foreach ( $els as &$el ) {
		$cv = $el['settings']['classes']['value'] ?? null;
		if ( is_array( $cv ) ) {
			$el['settings']['classes']['value'] = array_map( fn( $c ) => $c === $existing_id ? $import_id : $c, $cv );
		}
		if ( ! empty( $el['elements'] ) ) { $el['elements'] = $rewrite( $el['elements'] ); }
	}
	return $els;
};
$content_a = $rewrite( $content_a );
$pre_a = s02_collect( $content_a );
s02i_out( 'A_INPUT_CLASS_REFS (contains import id)', $pre_a['class_refs'] );

$snapshot_a = [ 'items' => [ $import_id => [
	'id' => $import_id, 'type' => 'class', 'label' => 's02card',
	'variants' => [ [ 'meta' => [ 'breakpoint' => 'desktop', 'state' => null ], 'props' => [
		'background' => [ '$$type' => 'background', 'value' => [ 'color' => [ '$$type' => 'color', 'value' => 'rgb(12, 34, 56)' ] ] ],
	] ] ],
] ], 'order' => [ $import_id ] ];

$proc_a = $manager->process_global_styles( [
	'content' => wp_json_encode( $content_a ),
	'global_classes' => wp_json_encode( $snapshot_a ),
	'import_mode' => Template_Library_Import_Export_Utils::IMPORT_MODE_MATCH_SITE,
] );
if ( is_wp_error( $proc_a ) ) { s02i_out( 'A_PROCESS_WP_ERROR', $proc_a->get_error_code() . ': ' . $proc_a->get_error_message() ); return; }
$after_a = s02_collect( $proc_a['content'] );
s02i_out( 'A_PROCESSED_CLASS_REFS (import id remapped to existing kit id)', $after_a['class_refs'] );
s02i_out( 'A_updated_global_classes (expect none = reuse, NOT a new class)', $proc_a['updated_global_classes'] ?? '(none)' );
s02i_out( 'A_KIT_LABELS_AFTER (expect exactly one s02card, no DUP_)', Global_Classes_Repository::make()->set_preview( false )->all_labels() );

$post_a = wp_insert_post( [ 'post_title' => 'S02 Import Target A', 'post_status' => 'publish', 'post_type' => 'page' ] );
update_post_meta( $post_a, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_a, '_elementor_template_type', 'wp-page' );
$saved_a = Plugin::$instance->documents->get( $post_a )->save( [ 'elements' => $proc_a['content'], 'settings' => [] ] );
s02i_out( 'A_TARGET_DOC_SAVE', [ 'post_id' => $post_a, 'saved' => $saved_a ? 'TRUE' : 'FALSE' ] );
$rel_a = get_post_meta( $post_a, '_elementor_used_global_class', false );
s02i_out( 'A_TARGET_RELATIONS', $rel_a );

$result['scenario_a'] = [
	'import_id' => $import_id,
	'existing_kit_id' => $existing_id,
	'input_class_refs' => $pre_a['class_refs'],
	'processed_class_refs' => $after_a['class_refs'],
	'remapped_to_existing' => in_array( $existing_id, $after_a['class_refs'], true ) && ! in_array( $import_id, $after_a['class_refs'], true ),
	'updated_global_classes' => $proc_a['updated_global_classes'] ?? null,
	'kit_labels_after' => Global_Classes_Repository::make()->set_preview( false )->all_labels(),
	'target_post_id' => $post_a,
	'target_relations' => $rel_a,
];

file_put_contents( '/spikes/s02-import-result.json', wp_json_encode( $result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
s02i_out( 'IMPORT_RESULT_WRITTEN', '/spikes/s02-import-result.json' );
