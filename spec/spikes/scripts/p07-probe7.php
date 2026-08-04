<?php
if ( ! class_exists('\Elementor\Plugin') ) { echo "NO ELEMENTOR\n"; return; }
$plugin = \Elementor\Plugin::$instance;
echo "e-form via elements_manager: " . ($plugin->elements_manager->get_element_types('e-form')?'FOUND':'null') . "\n";
$f = $plugin->elements_manager->get_element_types('e-form');
if ($f) {
  echo "  class=".get_class($f)." has get_props_schema=".(method_exists($f,'get_props_schema')?'Y':'N')."\n";
  $s = $f::get_props_schema();
  echo "  e-form props: " . implode(",", array_keys($s)) . "\n";
}
// instance call to static works?
$h = $plugin->widgets_manager->get_widget_types('e-heading');
$viaInstance = $h->get_props_schema();
echo "instance->get_props_schema() count=" . count($viaInstance) . " (works)\n";
// unknown type
echo "unknown 'e-nope' widget=" . ($plugin->widgets_manager->get_widget_types('e-nope')?'found':'null') . " element=" . ($plugin->elements_manager->get_element_types('e-nope')?'found':'null') . "\n";
