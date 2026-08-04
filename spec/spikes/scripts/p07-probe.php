<?php
// Probe Elementor APIs for WP-P07 schema controller accuracy.
if ( ! class_exists('\Elementor\Plugin') ) { echo "NO ELEMENTOR\n"; return; }
$plugin = \Elementor\Plugin::$instance;

echo "=== widgets_manager->get_widget_types keys (first 30) ===\n";
$wt = $plugin->widgets_manager->get_widget_types();
$keys = array_keys($wt);
echo implode(", ", array_slice($keys, 0, 30)) . "\n";
echo "total widget types: " . count($keys) . "\n";

echo "\n=== elements_manager->get_element_types keys ===\n";
$em = $plugin->elements_manager;
$et = $em->get_element_types();
echo implode(", ", array_keys($et)) . "\n";

echo "\n=== e-heading instance class + methods ===\n";
$type = 'e-heading';
$w = $plugin->widgets_manager->get_widget_types($type);
if ( $w ) {
  echo "class=" . get_class($w) . "\n";
  echo "has get_props_schema=" . (method_exists($w,'get_props_schema')?'Y':'N') . "\n";
  echo "has get_atomic_controls=" . (method_exists($w,'get_atomic_controls')?'Y':'N') . "\n";
  echo "has get_version=" . (method_exists($w,'get_version')?'Y':'N') . "\n";
  if ( method_exists($w,'get_props_schema') ) {
    $schema = $w::get_props_schema();
    echo "props_schema keys: " . implode(", ", array_keys($schema)) . "\n";
    echo "count props: " . count($schema) . "\n";
    // examine one prop type structure
    foreach ($schema as $name => $pt) {
      echo "--- prop '$name': class=" . get_class($pt) . "\n";
      echo "    get_key=" . (method_exists($pt,'get_key')?$pt->get_key():'?') . "\n";
      echo "    has get_default=" . (method_exists($pt,'get_default')?'Y':'N');
      echo " has get_settings=" . (method_exists($pt,'get_settings')?'Y':'N');
      echo " has is_dynamic_active=" . (method_exists($pt,'is_dynamic_active')?'Y':'N') . "\n";
      if (method_exists($pt,'get_default')) {
        $d = $pt->get_default();
        echo "    default=" . wp_json_encode($d) . "\n";
      }
      if (method_exists($pt,'get_settings')) {
        echo "    settings=" . wp_json_encode($pt->get_settings()) . "\n";
      }
    }
  }
}
