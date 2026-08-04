<?php
$sc='\Elementor\Modules\AtomicWidgets\Styles\Style_Schema';
$schema=$sc::get_style_schema();
$p=$schema['padding'];
$ser=$p->jsonSerialize();
echo "padding jsonSerialize prop_types keys: " . implode(",", array_keys($ser['prop_types'])) . "\n";
$pure=json_decode(json_encode($ser),true);
echo "after json roundtrip prop_types keys: " . implode(",", array_keys($pure['prop_types'])) . "\n";
