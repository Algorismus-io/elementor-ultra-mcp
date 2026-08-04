<?php
if ( ! class_exists('\Elementor\Plugin') ) { echo "NO ELEMENTOR\n"; return; }
$plugin = \Elementor\Plugin::$instance;

echo "=== Style_States::get_valid_states ===\n";
$ss = '\Elementor\Modules\AtomicWidgets\Styles\Style_States';
echo "get_valid_states=" . wp_json_encode($ss::get_valid_states()) . "\n";

echo "\n=== Size unit source ===\n";
// find Size_Prop_Type and how it stores units
$sp = '\Elementor\Modules\AtomicWidgets\PropTypes\Size_Prop_Type';
echo "$sp exists=" . (class_exists($sp)?'Y':'N') . "\n";
if (class_exists($sp)) {
  $inst = $sp::make();
  echo "key=" . $inst->get_key() . "\n";
  echo "settings=" . wp_json_encode($inst->get_settings()) . "\n";
}
// Search for unit constants
foreach ([
  '\Elementor\Modules\AtomicWidgets\PropTypes\Size_Constants',
  '\Elementor\Modules\AtomicWidgets\Utils\Size_Constants',
  '\Elementor\Modules\AtomicWidgets\PropTypes\Primitives\Size_Prop_Type',
] as $c) {
  echo "$c exists=" . (class_exists($c)?'Y':'N') . "\n";
}

echo "\n=== grep for unit enum in style-schema (find available units) ===\n";
// Look at a width prop union dimensions/size to find unit settings
$sc = '\Elementor\Modules\AtomicWidgets\Styles\Style_Schema';
$schema = $sc::get_style_schema();
$w = $schema['width'];
echo "width class=" . get_class($w) . " key=" . $w->get_key() . "\n";
if (method_exists($w,'get_prop_types')) {
  foreach ($w->get_prop_types() as $m) {
    echo "  member key=" . $m->get_key() . " class=" . get_class($m) . "\n";
    if ($m->get_key()==='size' && method_exists($m,'get_settings')) {
      echo "    size settings=" . wp_json_encode($m->get_settings()) . "\n";
    }
  }
}

echo "\n=== Reflect a Union prop: how to enumerate members generically ===\n";
$u = $schema['padding'];
$r = new ReflectionClass($u);
echo "Union methods: ";
foreach ($r->getMethods(ReflectionMethod::IS_PUBLIC) as $m) { if (!$m->isStatic()) echo $m->getName().","; }
echo "\n";

echo "\n=== version of an atomic widget instance ===\n";
$w2 = $plugin->widgets_manager->get_widget_types('e-heading');
foreach (['get_version','get_atomic_version'] as $vm) {
  echo "$vm exists=" . (method_exists($w2,$vm)?'Y':'N');
  if (method_exists($w2,$vm)) echo " => " . wp_json_encode($w2->$vm());
  echo "\n";
}
// Container?
$em = $plugin->elements_manager;
$dt = $em->get_element_types('e-div-block');
echo "e-div-block class=" . ($dt?get_class($dt):'NULL') . "\n";
if ($dt) {
  echo "  has get_props_schema=" . (method_exists($dt,'get_props_schema')?'Y':'N') . "\n";
  echo "  is container? has get_default_children_placeholder_selector? n/a; check elType=" . (method_exists($dt,'get_type')?$dt::get_type():'?') . "\n";
}

echo "\n=== classic widget get_controls shape ===\n";
$h = $plugin->widgets_manager->get_widget_types('heading');
echo "heading class=" . get_class($h) . "\n";
echo "has get_controls=" . (method_exists($h,'get_controls')?'Y':'N') . "\n";
if (method_exists($h,'get_controls')) {
  $ctrls = $h->get_controls();
  echo "controls count=" . count($ctrls) . " first keys: " . implode(",", array_slice(array_keys($ctrls),0,8)) . "\n";
}
