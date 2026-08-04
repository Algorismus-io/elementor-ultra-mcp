<?php
/**
 * WP-S02 CLEAN consolidated round-trip (no kit-class deletion, so the source
 * template stays intact and we measure the true save->read->insert behavior).
 *
 * 1. Ensure global class s02rt (label s02rt) exists in the kit.
 * 2. save_item() a fresh atomic block referencing s02rt + 2 local styles.
 * 3. Read back stored DB data (truth) and assert s02rt + local styles survive + ids remapped.
 * 4. get_data() (editor read) -> assert content keeps s02rt ref + populated snapshot.
 * 5. process_global_styles(match_site) with the captured snapshot:
 *      - class already in kit (label match) -> reuse, no dup, ref preserved/remapped.
 * 6. process_global_styles(keep_create) with a renamed-id snapshot:
 *      - forces create-as-new -> new kit id, content remapped via id_map.
 * 7. Save each processed content into a fresh doc; assert relations include the class id.
 *
 * Writes /spikes/s02-roundtrip.json for the assertion harness.
 */
use Elementor\Plugin;
use Elementor\Modules\GlobalClasses\Global_Classes_Repository;
use Elementor\Core\Utils\Template_Library_Import_Export_Utils as U;

if ( ! defined( 'ABSPATH' ) ) { exit; }
$admin = get_user_by( 'login', 'admin' );
if ( $admin ) { wp_set_current_user( $admin->ID ); }
function rt_out( $l, $v ) { echo "==== $l ====\n" . ( is_string( $v ) ? $v : print_r( $v, true ) ) . "\n"; }
function rt_collect( $els ) {
	$ids = []; $sids = []; $crefs = [];
	$w = function ( $els ) use ( &$w, &$ids, &$sids, &$crefs ) {
		foreach ( $els as $el ) {
			if ( isset( $el['id'] ) ) { $ids[] = $el['id']; }
			foreach ( array_keys( $el['styles'] ?? [] ) as $sk ) { $sids[] = $sk; }
			$cv = $el['settings']['classes']['value'] ?? [];
			if ( is_array( $cv ) ) { foreach ( $cv as $c ) { $crefs[] = $c; } }
			if ( ! empty( $el['elements'] ) ) { $w( $el['elements'] ); }
		}
	};
	$w( $els );
	return [ 'ids' => $ids, 'style_ids' => $sids, 'class_refs' => array_values( array_unique( $crefs ) ) ];
}

$out = [];
$gc = 's02rt';

// 1) ensure global class exists
$repo = Global_Classes_Repository::make()->set_preview( false );
$items = $repo->all()->get_items()->all();
$order = $repo->get_order();
$gc_def = [ 'id' => $gc, 'type' => 'class', 'label' => $gc, 'variants' => [ [
	'meta' => [ 'breakpoint' => 'desktop', 'state' => null ],
	'props' => [ 'background' => [ '$$type' => 'background', 'value' => [ 'color' => [ '$$type' => 'color', 'value' => 'rgb(12, 34, 56)' ] ] ] ],
] ] ];
if ( ! isset( $items[ $gc ] ) ) {
	$order[] = $gc;
	$repo->apply_changes( [ $gc => $gc_def ], [ 'added' => [ $gc ], 'order' => true ], $order );
}
rt_out( 'KIT_LABELS', Global_Classes_Repository::make()->set_preview( false )->all_labels() );

// 2) build + save_item
$src = [ 'div' => 's02rtdiv', 'head' => 's02rthead', 'btn' => 's02rtbtn' ];
$hl = 'e-s02rthead-local'; $bl = 'e-s02rtbtn-local';
$tree = [ [
	'id' => $src['div'], 'elType' => 'e-div-block', 'isInner' => false,
	'settings' => [ 'classes' => [ '$$type' => 'classes', 'value' => [ $gc ] ] ], 'styles' => [],
	'elements' => [
		[ 'id' => $src['head'], 'elType' => 'widget', 'widgetType' => 'e-heading', 'isInner' => false,
		  'settings' => [ 'classes' => [ '$$type' => 'classes', 'value' => [ $hl ] ], 'tag' => [ '$$type' => 'string', 'value' => 'h2' ],
			'title' => [ '$$type' => 'html-v3', 'value' => [ 'content' => [ '$$type' => 'string', 'value' => 'RT Card' ], 'children' => [] ] ] ],
		  'styles' => [ $hl => [ 'id' => $hl, 'type' => 'class', 'label' => 'headlocal', 'variants' => [ [ 'meta' => [ 'breakpoint' => 'desktop', 'state' => null ],
			'props' => [ 'color' => [ '$$type' => 'color', 'value' => 'rgb(255, 200, 0)' ], 'font-size' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 36 ] ] ] ] ] ] ],
		  'elements' => [] ],
		[ 'id' => $src['btn'], 'elType' => 'widget', 'widgetType' => 'e-button', 'isInner' => false,
		  'settings' => [ 'classes' => [ '$$type' => 'classes', 'value' => [ $bl ] ],
			'text' => [ '$$type' => 'html-v3', 'value' => [ 'content' => [ '$$type' => 'string', 'value' => 'RT Btn' ], 'children' => [] ] ] ],
		  'styles' => [ $bl => [ 'id' => $bl, 'type' => 'class', 'label' => 'btnlocal', 'variants' => [ [ 'meta' => [ 'breakpoint' => 'desktop', 'state' => null ],
			'props' => [ 'color' => [ '$$type' => 'color', 'value' => 'rgb(0,0,0)' ] ] ] ] ] ],
		  'elements' => [] ],
	],
] ];

$source = Plugin::$instance->templates_manager->get_source( 'local' );
$tid = $source->save_item( [ 'title' => 'S02 RT Template', 'type' => 'container', 'content' => $tree, 'page_settings' => [] ] );
if ( is_wp_error( $tid ) ) { rt_out( 'SAVE_ERR', $tid->get_error_message() ); return; }
$tid = (int) $tid;
rt_out( 'TEMPLATE_ID', $tid );

// 3) stored DB truth
$stored = json_decode( get_post_meta( $tid, '_elementor_data', true ), true );
$st = rt_collect( $stored );
rt_out( 'STORED_DB_ELEMENT_IDS', $st['ids'] );
rt_out( 'STORED_DB_STYLE_IDS', $st['style_ids'] );
rt_out( 'STORED_DB_CLASS_REFS (must include ' . $gc . ')', $st['class_refs'] );
rt_out( 'STORED_DB_ELEMENT_IDS_REMAPPED', [ 'div' => ! in_array( $src['div'], $st['ids'], true ), 'head' => ! in_array( $src['head'], $st['ids'], true ), 'btn' => ! in_array( $src['btn'], $st['ids'], true ) ] );
rt_out( 'STORED_DB_LOCAL_STYLE_IDS_REMAPPED', [ 'head' => ! in_array( $hl, $st['style_ids'], true ), 'btn' => ! in_array( $bl, $st['style_ids'], true ) ] );
rt_out( 'STORED_DB_GLOBAL_REF_PRESENT', in_array( $gc, $st['class_refs'], true ) );
$rel_tpl = get_post_meta( $tid, '_elementor_used_global_class', false );
rt_out( 'TEMPLATE_RELATIONS_REGISTERED', $rel_tpl );

// 4) get_data (editor read)
$data = $source->get_data( [ 'template_id' => $tid ] );
$gd = rt_collect( $data['content'] );
rt_out( 'GETDATA_CLASS_REFS (must include ' . $gc . ')', $gd['class_refs'] );
rt_out( 'GETDATA_STYLE_IDS', $gd['style_ids'] );
rt_out( 'GETDATA_SNAPSHOT_ITEM_IDS (must include ' . $gc . ')', array_keys( $data['global_classes']['items'] ?? [] ) );

$out['save_and_read'] = [
	'template_id' => $tid,
	'stored_class_refs' => $st['class_refs'],
	'stored_style_ids' => $st['style_ids'],
	'stored_element_ids' => $st['ids'],
	'source_ids' => array_values( $src ),
	'source_style_ids' => [ $hl, $bl ],
	'element_ids_remapped' => ! array_intersect( array_values( $src ), $st['ids'] ),
	'local_style_ids_remapped' => ! array_intersect( [ $hl, $bl ], $st['style_ids'] ),
	'global_ref_present' => in_array( $gc, $st['class_refs'], true ),
	'template_relations' => $rel_tpl,
	'getdata_class_refs' => $gd['class_refs'],
	'getdata_snapshot_ids' => array_keys( $data['global_classes']['items'] ?? [] ),
];

$manager = Plugin::$instance->templates_manager;

// 5) MATCH_SITE merge (class label already in kit -> reuse, no dup)
$pm = $manager->process_global_styles( [
	'content' => wp_json_encode( $data['content'] ),
	'global_classes' => wp_json_encode( $data['global_classes'] ?? [] ),
	'import_mode' => U::IMPORT_MODE_MATCH_SITE,
] );
$pmc = rt_collect( is_wp_error( $pm ) ? [] : $pm['content'] );
rt_out( 'MATCH_SITE_PROCESSED_CLASS_REFS', $pmc['class_refs'] );
rt_out( 'MATCH_SITE_updated_global_classes (expect none = reuse)', is_wp_error($pm) ? $pm->get_error_message() : ( $pm['updated_global_classes'] ?? '(none)' ) );
rt_out( 'MATCH_SITE_KIT_LABELS (no dup)', Global_Classes_Repository::make()->set_preview( false )->all_labels() );

$pa = wp_insert_post( [ 'post_title' => 'S02 RT Target MATCH', 'post_status' => 'publish', 'post_type' => 'page' ] );
update_post_meta( $pa, '_elementor_edit_mode', 'builder' ); update_post_meta( $pa, '_elementor_template_type', 'wp-page' );
$sa = Plugin::$instance->documents->get( $pa )->save( [ 'elements' => $pm['content'], 'settings' => [] ] );
$rel_a = get_post_meta( $pa, '_elementor_used_global_class', false );
rt_out( 'MATCH_SITE_TARGET', [ 'post_id' => $pa, 'saved' => $sa ? 'T' : 'F', 'relations' => $rel_a ] );

$out['match_site'] = [
	'processed_class_refs' => $pmc['class_refs'],
	'updated_global_classes' => is_wp_error($pm) ? null : ( $pm['updated_global_classes'] ?? null ),
	'kit_labels' => Global_Classes_Repository::make()->set_preview( false )->all_labels(),
	'target_post_id' => $pa, 'target_relations' => $rel_a,
	'ref_preserved' => in_array( $gc, $pmc['class_refs'], true ),
];

// 6) KEEP_CREATE with a renamed snapshot id -> create-as-new + id remap.
$import_id = 's02rt-foreign';
$content_kc = $data['content'];
$rewrite = function ( $els ) use ( &$rewrite, $gc, $import_id ) {
	foreach ( $els as &$el ) {
		$cv = $el['settings']['classes']['value'] ?? null;
		if ( is_array( $cv ) ) { $el['settings']['classes']['value'] = array_map( fn( $c ) => $c === $gc ? $import_id : $c, $cv ); }
		if ( ! empty( $el['elements'] ) ) { $el['elements'] = $rewrite( $el['elements'] ); }
	}
	return $els;
};
$content_kc = $rewrite( $content_kc );
$kc_in = rt_collect( $content_kc );
rt_out( 'KEEP_CREATE_INPUT_CLASS_REFS', $kc_in['class_refs'] );
$snap_kc = [ 'items' => [ $import_id => [ 'id' => $import_id, 'type' => 'class', 'label' => 's02rt-foreign',
	'variants' => [ [ 'meta' => [ 'breakpoint' => 'desktop', 'state' => null ], 'props' => [ 'background' => [ '$$type' => 'background', 'value' => [ 'color' => [ '$$type' => 'color', 'value' => 'rgb(9, 9, 9)' ] ] ] ] ] ] ] ], 'order' => [ $import_id ] ];
$pk = $manager->process_global_styles( [
	'content' => wp_json_encode( $content_kc ),
	'global_classes' => wp_json_encode( $snap_kc ),
	'import_mode' => U::IMPORT_MODE_KEEP_CREATE,
] );
$pkc = rt_collect( is_wp_error( $pk ) ? [] : $pk['content'] );
rt_out( 'KEEP_CREATE_PROCESSED_CLASS_REFS', $pkc['class_refs'] );
rt_out( 'KEEP_CREATE_updated_global_classes (expect new item created)', is_wp_error($pk) ? $pk->get_error_message() : ( $pk['updated_global_classes'] ?? '(none)' ) );
rt_out( 'KEEP_CREATE_KIT_LABELS', Global_Classes_Repository::make()->set_preview( false )->all_labels() );

$out['keep_create'] = [
	'input_class_refs' => $kc_in['class_refs'],
	'processed_class_refs' => $pkc['class_refs'],
	'updated_global_classes' => is_wp_error($pk) ? null : ( $pk['updated_global_classes'] ?? null ),
	'kit_labels' => Global_Classes_Repository::make()->set_preview( false )->all_labels(),
	'import_id' => $import_id,
];

file_put_contents( '/spikes/s02-roundtrip.json', wp_json_encode( $out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
rt_out( 'ROUNDTRIP_WRITTEN', '/spikes/s02-roundtrip.json' );
