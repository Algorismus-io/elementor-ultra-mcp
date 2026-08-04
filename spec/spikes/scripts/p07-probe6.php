<?php
if ( ! class_exists('\Elementor\Plugin') ) { echo "NO ELEMENTOR\n"; return; }
$plugin = \Elementor\Plugin::$instance;

function inspect($el, $label) {
  if (!$el) { echo "$label: NULL\n"; return; }
  $isAtomic = method_exists($el,'get_props_schema');
  // robust atomic detection: instance of Atomic base, or has get_props_schema static
  $atomicBase = '\Elementor\Modules\AtomicWidgets\Base\Atomic_Element_Base';
  $atomicWidgetBase = '\Elementor\Modules\AtomicWidgets\Base\Atomic_Widget_Base';
  $isa = ($el instanceof $atomicBase) || ($el instanceof $atomicWidgetBase);
  $elType = method_exists($el,'get_type') ? $el::get_type() : (method_exists($el,'get_element_type')?$el->get_element_type():'?');
  echo "$label: class=".get_class($el)." get_props_schema=".($isAtomic?'Y':'N')." instanceof Atomic*=".($isa?'Y':'N')." elType=$elType\n";
}

inspect($plugin->elements_manager->get_element_types('e-div-block'),'e-div-block');
inspect($plugin->elements_manager->get_element_types('container'),'container (classic)');
inspect($plugin->widgets_manager->get_widget_types('e-heading'),'e-heading');
inspect($plugin->widgets_manager->get_widget_types('heading'),'heading (classic)');
inspect($plugin->widgets_manager->get_widget_types('e-form'),'e-form (widget?)');

echo "\n=== atomic base classes existence ===\n";
foreach ([
 '\Elementor\Modules\AtomicWidgets\Base\Atomic_Element_Base',
 '\Elementor\Modules\AtomicWidgets\Base\Atomic_Widget_Base',
] as $c) echo "$c exists=".(class_exists($c)?'Y':'N')."\n";

echo "\n=== how to know e-div-block is a container? ===\n";
$d = $plugin->elements_manager->get_element_types('e-div-block');
foreach (['is_dynamic','get_default_children_elements'] as $m) echo "  $m=".(method_exists($d,$m)?'Y':'N')."\n";
// elType 'widget' vs container element type. Atomic containers have elType != 'widget'.
$cfgD = $d->get_initial_config();
echo "  div-block elType cfg=" . ($cfgD['elType'] ?? '?') . "\n";
$cfgH = $plugin->widgets_manager->get_widget_types('e-heading')->get_initial_config();
echo "  e-heading elType cfg=" . ($cfgH['elType'] ?? '?') . "\n";

echo "\n=== how a widget type resolves: widgets_manager vs elements_manager ===\n";
// e-div-block lives in elements_manager; e-heading in widgets_manager. We must try both.
echo "widgets_manager has e-div-block? " . ($plugin->widgets_manager->get_widget_types('e-div-block')?'Y':'N') . "\n";
echo "elements_manager has e-heading? " . ($plugin->elements_manager->get_element_types('e-heading')?'Y':'N') . "\n";
