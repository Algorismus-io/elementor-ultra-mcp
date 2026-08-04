<?php
// From-scratch reset: delete all content + design-system artifacts (keep WP/Elementor/Pro/plugin/experiments).
$counts = ['page'=>0,'post'=>0,'elementor_library'=>0,'e_global_class'=>0,'attachment'=>0];
foreach ( array_keys($counts) as $pt ) {
	$ids = get_posts([ 'post_type'=>$pt, 'post_status'=>'any', 'numberposts'=>-1, 'fields'=>'ids' ]);
	foreach ( $ids as $id ) { wp_delete_post( $id, true ); $counts[$pt]++; }
}
// Reset the active kit's design-system index/frontend meta (global classes + variables).
$kit = (int) get_option('elementor_active_kit');
$meta_keys = [
	'_elementor_global_classes', '_elementor_global_classes_order',
	'_elementor_global_classes_labels', '_elementor_global_classes_labels_preview',
	'_elementor_global_classes_post_ids', '_elementor_global_classes_sync_to_v3',
	'_elementor_global_variables',
];
$cleared = [];
if ( $kit ) {
	foreach ( $meta_keys as $k ) { if ( metadata_exists('post',$kit,$k) ) { delete_post_meta($kit,$k); $cleared[]=$k; } }
}
echo "DELETED: " . wp_json_encode($counts) . "\n";
echo "KIT($kit) META CLEARED: " . wp_json_encode($cleared) . "\n";
