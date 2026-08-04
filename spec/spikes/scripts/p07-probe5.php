<?php
if ( ! class_exists('\Elementor\Plugin') ) { echo "NO ELEMENTOR\n"; return; }
$plugin = \Elementor\Plugin::$instance;
$w = $plugin->widgets_manager->get_widget_types('e-heading');

echo "=== get_initial_config version ===\n";
$cfg = $w->get_initial_config();
echo "config keys: " . implode(",", array_keys($cfg)) . "\n";
echo "config['version'] = " . (isset($cfg['version'])?wp_json_encode($cfg['version']):'absent') . "\n";
echo "config['atomic_props_schema'] present=" . (isset($cfg['atomic_props_schema'])?'Y':'N') . "\n";

echo "\n=== units across style schema (collect available_units from size members) ===\n";
$sc = '\Elementor\Modules\AtomicWidgets\Styles\Style_Schema';
$schema = $sc::get_style_schema();
$unitSets = [];
function collect_units($pt, &$unitSets, $propname) {
  if ($pt->get_key()==='size' && method_exists($pt,'get_settings')) {
    $s = $pt->get_settings();
    if (isset($s['available_units'])) {
      $unitSets[$propname] = $s['available_units'];
    }
  }
  if (method_exists($pt,'get_prop_types')) {
    foreach ($pt->get_prop_types() as $m) collect_units($m, $unitSets, $propname);
  }
}
foreach ($schema as $name=>$pt) collect_units($pt, $unitSets, $name);
// group distinct unit sets
$distinct = [];
foreach ($unitSets as $name=>$u) {
  $key = implode(",", $u);
  $distinct[$key][] = $name;
}
foreach ($distinct as $units=>$props) {
  echo "UNITS [$units] : " . count($props) . " props (e.g. " . implode(",", array_slice($props,0,5)) . ")\n";
}

echo "\n=== font-size unit set (typography) vs width (standard) ===\n";
foreach (['width','font-size','line-height','padding'] as $p) {
  if (isset($unitSets[$p])) echo "  $p => " . implode(",", $unitSets[$p]) . "\n";
  else echo "  $p => (no direct size units; union)\n";
}
