<?php
/**
 * WP-S01 step 1: headless atomic save.
 *
 * - Creates a global class "s01hero" (one prop: color) via the Global_Classes_Repository diff API.
 * - Builds an atomic tree: e-div-block > (e-heading + e-button).
 *   - The heading carries ONE LOCAL style (referenced from its `classes` prop).
 *   - The button carries the ONE GLOBAL class "s01hero" (referenced from its `classes` prop).
 * - Saves headless via Plugin::$instance->documents->get($id)->save(['elements'=>$tree,'settings'=>[]]).
 * - Asserts _elementor_data written, prints relations meta, and shows NO atomic CSS exists yet.
 *
 * Writes the created post id + ids to /spikes/s01-state.json for downstream steps.
 */

use Elementor\Plugin;
use Elementor\Modules\GlobalClasses\Global_Classes_Repository;

if ( ! defined( 'ABSPATH' ) ) { exit; }

// WP-CLI eval-file runs as user 0; Document::save() bails out via
// is_editable_by_current_user() unless a capable user is the current user.
$admin = get_user_by( 'login', 'admin' );
if ( $admin ) {
	wp_set_current_user( $admin->ID );
}

function s01_out( $label, $val ) {
	echo "==== $label ====\n";
	echo ( is_string( $val ) ? $val : print_r( $val, true ) ) . "\n";
}

$mod = \Elementor\Plugin::$instance->experiments;
s01_out( 'EXPERIMENTS', [
	'e_atomic_elements' => $mod->is_feature_active( 'e_atomic_elements' ),
	'e_classes'         => $mod->is_feature_active( 'e_classes' ),
	'e_variables'       => $mod->is_feature_active( 'e_variables' ),
] );

// ---------------------------------------------------------------------------
// 1) Create the global class via the repository diff API (the real path).
// ---------------------------------------------------------------------------
$global_class_id    = 's01hero';           // class id == label for simplicity
$global_class_label = 's01hero';

$repo = Global_Classes_Repository::make()->set_preview( false );

$existing = $repo->all()->get_items()->all();
$existing_order = $repo->get_order();

$global_item = [
	'id'    => $global_class_id,
	'type'  => 'class',
	'label' => $global_class_label,
	'variants' => [
		[
			'meta'  => [ 'breakpoint' => 'desktop', 'state' => null ],
			'props' => [
				'background' => [
					'$$type' => 'background',
					'value'  => [
						'color' => [ '$$type' => 'color', 'value' => 'rgb(255, 0, 128)' ],
					],
				],
				'padding' => [
					'$$type' => 'dimensions',
					'value'  => [
						'block-start' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 24 ] ],
						'block-end'   => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 24 ] ],
						'inline-start'=> [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 32 ] ],
						'inline-end'  => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 32 ] ],
					],
				],
			],
		],
	],
];

$touched = [ $global_class_id => $global_item ];
$changes = [
	'added'    => isset( $existing[ $global_class_id ] ) ? [] : [ $global_class_id ],
	'deleted'  => [],
	'modified' => isset( $existing[ $global_class_id ] ) ? [ $global_class_id ] : [],
	'order'    => false,
];
$order = $existing_order;
if ( ! in_array( $global_class_id, $order, true ) ) {
	$order[] = $global_class_id;
}

try {
	$repo->apply_changes( $touched, $changes, $order );
	s01_out( 'GLOBAL_CLASS_APPLY', 'apply_changes OK for ' . $global_class_id );
} catch ( \Throwable $e ) {
	s01_out( 'GLOBAL_CLASS_APPLY_ERROR', $e->getMessage() );
}

$verify = Global_Classes_Repository::make()->set_preview( false )->get( $global_class_id );
s01_out( 'GLOBAL_CLASS_VERIFY', $verify ? 'stored: ' . wp_json_encode( array_keys( $verify ) ) . ' label=' . ( $verify['label'] ?? '?' ) : 'NOT STORED' );

// ---------------------------------------------------------------------------
// 2) Build the atomic tree.
// ---------------------------------------------------------------------------
$div_id     = 's01div01';
$heading_id = 's01head1';
$button_id  = 's01btn01';
$local_style_id = 'e-' . $heading_id . '-local';  // referenced from heading.classes

$tree = [
	[
		'id'        => $div_id,
		'elType'    => 'e-div-block',
		'settings'  => [
			'classes' => [ '$$type' => 'classes', 'value' => [] ],
		],
		'styles'    => [],
		'isInner'   => false,
		'elements'  => [
			[
				'id'       => $heading_id,
				'elType'   => 'widget',
				'widgetType' => 'e-heading',
				'settings' => [
					'classes' => [ '$$type' => 'classes', 'value' => [ $local_style_id ] ],
					'tag'     => [ '$$type' => 'string', 'value' => 'h1' ],
					'title'   => [
						'$$type' => 'html-v3',
						'value'  => [
							'content'  => [ '$$type' => 'string', 'value' => 'S01 Atomic Hero' ],
							'children' => [],
						],
					],
				],
				'styles'   => [
					$local_style_id => [
						'id'    => $local_style_id,
						'type'  => 'class',
						'label' => 'local',
						'variants' => [
							[
								'meta'  => [ 'breakpoint' => 'desktop', 'state' => null ],
								'props' => [
									'color' => [ '$$type' => 'color', 'value' => 'rgb(0, 128, 255)' ],
									'font-size' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 48 ] ],
								],
							],
						],
					],
				],
				'elements' => [],
				'isInner'  => false,
			],
			[
				'id'       => $button_id,
				'elType'   => 'widget',
				'widgetType' => 'e-button',
				'settings' => [
					'classes' => [ '$$type' => 'classes', 'value' => [ $global_class_id ] ],
					'text'    => [
						'$$type' => 'html-v3',
						'value'  => [
							'content'  => [ '$$type' => 'string', 'value' => 'Click me' ],
							'children' => [],
						],
					],
				],
				'styles'   => [],
				'elements' => [],
				'isInner'  => false,
			],
		],
	],
];

// ---------------------------------------------------------------------------
// 3) Create the post and save headless.
// ---------------------------------------------------------------------------
$post_id = wp_insert_post( [
	'post_title'  => 'S01 Atomic Hero',
	'post_status' => 'publish',
	'post_type'   => 'page',
] );
s01_out( 'POST_CREATED', 'post_id=' . $post_id );

// Mark as an Elementor page (V4 atomic doc type).
update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
update_post_meta( $post_id, '_elementor_template_type', 'wp-page' );

$document = Plugin::$instance->documents->get( $post_id );
if ( ! $document ) {
	s01_out( 'FATAL', 'no document for post ' . $post_id );
	return;
}
s01_out( 'DOC_CLASS', get_class( $document ) );
s01_out( 'CURRENT_USER', get_current_user_id() . ' editable=' . ( $document->is_editable_by_current_user() ? 'YES' : 'NO' ) . ' unfiltered_html=' . ( current_user_can( 'unfiltered_html' ) ? 'YES' : 'NO' ) );

try {
	$saved = $document->save( [ 'elements' => $tree, 'settings' => [] ] );
	s01_out( 'DOCUMENT_SAVE', $saved ? 'save() returned TRUE' : 'save() returned FALSE/0' );
} catch ( \Throwable $e ) {
	s01_out( 'DOCUMENT_SAVE_ERROR', $e->getMessage() . "\n" . $e->getTraceAsString() );
}

// ---------------------------------------------------------------------------
// 4) Verify persistence + relations.
// ---------------------------------------------------------------------------
$raw = get_post_meta( $post_id, '_elementor_data', true );
s01_out( '_elementor_data_LEN', is_string( $raw ) ? strlen( $raw ) : '(not a string) ' . gettype( $raw ) );
s01_out( '_elementor_data_HAS_LOCAL_STYLE', ( is_string( $raw ) && strpos( $raw, $local_style_id ) !== false ) ? 'YES' : 'NO' );
s01_out( '_elementor_data_HAS_GLOBAL_CLASS_REF', ( is_string( $raw ) && strpos( $raw, $global_class_id ) !== false ) ? 'YES' : 'NO' );

$used_frontend = get_post_meta( $post_id, '_elementor_used_global_class', false );
s01_out( 'RELATIONS_used_global_class(frontend)', $used_frontend );
$used_preview = get_post_meta( $post_id, '_elementor_used_global_class_preview', false );
s01_out( 'RELATIONS_used_global_class(preview)', $used_preview );

// ---------------------------------------------------------------------------
// 5) Residual: show NO atomic CSS file exists yet.
// ---------------------------------------------------------------------------
$upload = wp_upload_dir();
$css_dir = trailingslashit( $upload['basedir'] ) . 'elementor/css/';
$files = is_dir( $css_dir ) ? array_values( array_diff( scandir( $css_dir ), [ '.', '..' ] ) ) : [];
s01_out( 'CSS_DIR', $css_dir );
s01_out( 'CSS_FILES_AFTER_SAVE (expect none/no-atomic)', $files );

// Persist state for downstream steps.
$state = [
	'post_id'        => $post_id,
	'permalink'      => get_permalink( $post_id ),
	'div_id'         => $div_id,
	'heading_id'     => $heading_id,
	'button_id'      => $button_id,
	'local_style_id' => $local_style_id,
	'global_class_id'=> $global_class_id,
	'css_dir'        => $css_dir,
];
file_put_contents( '/spikes/s01-state.json', wp_json_encode( $state, JSON_PRETTY_PRINT ) );
s01_out( 'STATE_WRITTEN', $state );
