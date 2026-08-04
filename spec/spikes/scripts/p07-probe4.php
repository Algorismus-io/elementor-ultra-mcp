<?php
if ( ! class_exists('\Elementor\Plugin') ) { echo "NO ELEMENTOR\n"; return; }
$plugin = \Elementor\Plugin::$instance;
$w = $plugin->widgets_manager->get_widget_types('e-heading');
$schema = $w::get_props_schema();

echo "=== jsonSerialize of each prop (this is what Elementor exposes to editor) ===\n";
foreach (['classes','tag','title','link','attributes','_cssid','display-conditions'] as $name) {
  if (!isset($schema[$name])) { echo "$name MISSING\n"; continue; }
  $pt = $schema[$name];
  echo "--- $name (key=".$pt->get_key().")\n";
  if ($pt instanceof JsonSerializable) {
    echo json_encode($pt->jsonSerialize()) . "\n";
  }
}

echo "\n=== dynamic detection ===\n";
foreach ($schema as $name=>$pt) {
  $dyn = 'no-method';
  if (method_exists($pt,'is_dynamic_active')) $dyn = $pt->is_dynamic_active() ? 'Y':'N';
  // also union members may carry dynamic
  $hasDynMember = false;
  if (method_exists($pt,'get_prop_types')) {
    foreach ($pt->get_prop_types() as $m) {
      if ($m->get_key()==='dynamic') $hasDynMember=true;
    }
  }
  echo "  $name: is_dynamic_active=$dyn unionHasDynamic=" . ($hasDynMember?'Y':'N') . "\n";
}

echo "\n=== Prop_Type base: get_key / get_settings always present? ===\n";
$base = '\Elementor\Modules\AtomicWidgets\PropTypes\Base\Prop_Type';
echo "$base exists=" . (class_exists($base)||interface_exists($base)?'Y':'N') . "\n";

echo "\n=== Does Atomic_Widget_Base define VERSION const or method ===\n";
$r = new ReflectionClass($w);
echo "class=" . $r->getName() . "\n";
$cur = $r;
while ($cur) {
  foreach ($cur->getConstants() as $cn=>$cv) {
    if (stripos($cn,'version')!==false) echo "  const ".$cur->getName()."::$cn=".wp_json_encode($cv)."\n";
  }
  $cur = $cur->getParentClass();
}
foreach (['get_atomic_settings_schema','version','get_initial_config'] as $mm) {
  echo "  method $mm=" . (method_exists($w,$mm)?'Y':'N') . "\n";
}
