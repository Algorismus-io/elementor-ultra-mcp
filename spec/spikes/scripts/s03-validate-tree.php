<?php
/**
 * WP-S03 — authoritative atomic style validation probe.
 *
 * The ticket requires grounding the convert classifier empirically:
 * "build candidate atomic trees and run them through Elementor save validation
 *  to see what sticks." This runs candidate native style props through the
 * AUTHORITATIVE save-path validator — Style_Parser::parse() (the same class the
 * atomic save uses to validate a local/global style: it runs Props_Parser
 * validate + sanitize against the live Style_Schema and returns structured
 * errors). A prop that survives parse() with no error STICKS as a native prop;
 * one that errors must fall back.
 *
 * It does NOT persist anything (parse() is pure validation).
 *
 * Run inside the wordpress container (web-server uid) with wp-load:
 *   php -r 'define("WP_USE_THEMES",false); require "wp-load.php"; require "/tmp/s03-validate-tree.php";'
 */
use Elementor\Modules\AtomicWidgets\Styles\Style_Schema;
use Elementor\Modules\AtomicWidgets\Parsers\Style_Parser;

if ( ! class_exists( '\Elementor\Modules\AtomicWidgets\Styles\Style_Schema' ) ||
     ! class_exists( '\Elementor\Modules\AtomicWidgets\Parsers\Style_Parser' ) ) {
    fwrite( STDERR, "atomic classes not found\n" ); exit( 1 );
}
$schema = Style_Schema::get();
$parser = Style_Parser::make( $schema );

/** Wrap a single prop in a complete, otherwise-valid local style and parse it. */
function probe_prop( $parser, $prop, $typed ) {
    $style = [
        'id'    => 's03probe',
        'type'  => 'class',
        'label' => 's03probe',
        'variants' => [ [
            'meta'  => [ 'breakpoint' => 'desktop', 'state' => null ],
            'props' => [ $prop => $typed ],
        ] ],
    ];
    $res = $parser->parse( $style );
    $errors = $res->errors()->all();
    $stuck = empty( $errors );
    return [ $stuck, $stuck ? 'valid' : json_encode( $errors ) ];
}

$cases = [
    // EASY (expected STICK)
    [ 'color rgb', 'color', [ '$$type' => 'color', 'value' => 'rgb(31, 41, 51)' ] ],
    [ 'font-size px', 'font-size', [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 36 ] ] ],
    [ 'line-height em', 'line-height', [ '$$type' => 'size', 'value' => [ 'unit' => 'em', 'size' => 1.15 ] ] ],
    [ 'font-weight 700', 'font-weight', [ '$$type' => 'string', 'value' => '700' ] ],
    [ 'padding dimensions', 'padding', [ '$$type' => 'dimensions', 'value' => [
        'block-start' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 32 ] ],
        'inline-end'  => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 28 ] ],
        'block-end'   => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 32 ] ],
        'inline-start'=> [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 28 ] ],
    ] ] ],
    [ 'border-radius size', 'border-radius', [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 16 ] ] ],
    [ 'display flex', 'display', [ '$$type' => 'string', 'value' => 'flex' ] ],
    [ 'justify-content space-between', 'justify-content', [ '$$type' => 'string', 'value' => 'space-between' ] ],
    [ 'gap size', 'gap', [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 24 ] ] ],
    [ 'opacity %', 'opacity', [ '$$type' => 'size', 'value' => [ 'unit' => '%', 'size' => 50 ] ] ],
    [ 'grid-template-columns repeat', 'grid-template-columns', [ '$$type' => 'string', 'value' => 'repeat(3, 1fr)' ] ],
    [ 'grid-template-columns auto-fit minmax', 'grid-template-columns', [ '$$type' => 'string', 'value' => 'repeat(auto-fit, minmax(280px, 1fr))' ] ],
    [ 'text-decoration none', 'text-decoration', [ '$$type' => 'string', 'value' => 'none' ] ],
    [ 'background solid color', 'background', [ '$$type' => 'background', 'value' => [
        'color' => [ '$$type' => 'color', 'value' => 'rgb(255,255,255)' ],
    ] ] ],

    // HARD / borderline (the typed-object props — does the converter's decompose stick?)
    [ 'box-shadow single', 'box-shadow', [ '$$type' => 'box-shadow', 'value' => [
        [ '$$type' => 'shadow', 'value' => [
            'hOffset' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 0 ] ],
            'vOffset' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 1 ] ],
            'blur'    => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 3 ] ],
            'spread'  => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 0 ] ],
            'color'   => [ '$$type' => 'color', 'value' => 'rgba(16,24,40,0.08)' ],
        ] ],
    ] ] ],
    [ 'transform translateY', 'transform', [ '$$type' => 'transform', 'value' => [
        [ '$$type' => 'transform-move', 'value' => [
            'y' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => -6 ] ],
        ] ],
    ] ] ],
    [ 'transform GARBAGE inner shape', 'transform', [ '$$type' => 'transform', 'value' => [
        [ '$$type' => 'nonsense', 'value' => [ 'z' => 1 ] ],
    ] ] ],
    [ 'filter blur', 'filter', [ '$$type' => 'filter', 'value' => [
        [ '$$type' => 'css-filter-func', 'value' => [
            'func' => [ '$$type' => 'string', 'value' => 'blur' ],
            'size' => [ '$$type' => 'size', 'value' => [ 'unit' => 'px', 'size' => 64 ] ],
        ] ],
    ] ] ],

    // EXPECTED FALL (the honest ceilings)
    [ 'font-weight 650 (off-enum)', 'font-weight', [ '$$type' => 'string', 'value' => '650' ] ],
    [ 'align-items baseline (off-enum)', 'align-items', [ '$$type' => 'string', 'value' => 'baseline' ] ],
    [ 'display table (no enum member)', 'display', [ '$$type' => 'string', 'value' => 'table' ] ],
    [ 'color garbage value', 'color', [ '$$type' => 'color', 'value' => 'not-a-color-xyz' ] ],
    [ 'background gradient as string', 'background', [ '$$type' => 'string', 'value' => 'linear-gradient(135deg,#4f46e5,#7c3aed)' ] ],
    [ 'transform as bare string', 'transform', [ '$$type' => 'string', 'value' => 'translateY(-6px)' ] ],
    [ 'box-shadow as bare string', 'box-shadow', [ '$$type' => 'string', 'value' => '0 1px 3px rgba(0,0,0,.1)' ] ],
    [ 'transition as bare string', 'transition', [ '$$type' => 'string', 'value' => 'transform .2s ease' ] ],
];

$pass = 0; $fail = 0;
echo "AUTHORITATIVE_STYLE_PARSE_PROBE (Style_Parser::parse)\n";
echo "====================================================\n";
foreach ( $cases as $c ) {
    [ $label, $prop, $typed ] = $c;
    [ $ok, $why ] = probe_prop( $parser, $prop, $typed );
    printf( "[%s] %-40s -> %s\n", $ok ? 'STICK' : ' FALL', $label, substr( $why, 0, 70 ) );
    $ok ? $pass++ : $fail++;
}
echo "====================================================\n";
echo "STICK=$pass FALL=$fail\n";
