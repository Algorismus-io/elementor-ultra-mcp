<?php
if ( ! class_exists('\Elementor\Plugin') ) { echo "NO ELEMENTOR\n"; return; }
$plugin = \Elementor\Plugin::$instance;

echo "=== Style_Schema ===\n";
$sclass = '\Elementor\Modules\AtomicWidgets\Styles\Style_Schema';
echo "exists Style_Schema=" . (class_exists($sclass)?'Y':'N') . "\n";
if ( class_exists($sclass) ) {
  $rm = method_exists($sclass,'get_style_schema') ? 'get_style_schema' : (method_exists($sclass,'get') ? 'get' : null);
  echo "method=" . ($rm ?: 'NONE') . "\n";
  // it may be instance method
  $inst = new $sclass();
  $schema = method_exists($inst,'get') ? $inst->get() : ( method_exists($sclass,'get_style_schema') ? $sclass::get_style_schema() : []);
  echo "style prop count=" . count($schema) . "\n";
  echo "first 15 keys: " . implode(", ", array_slice(array_keys($schema),0,15)) . "\n";
  // examine a plain enum prop and a union prop
  foreach (['display','padding','font-weight','color'] as $p) {
    if (isset($schema[$p])) {
      $pt = $schema[$p];
      echo "--- '$p' class=" . get_class($pt) . " key=" . (method_exists($pt,'get_key')?$pt->get_key():'?') . "\n";
      if (method_exists($pt,'get_settings')) echo "    settings=" . wp_json_encode($pt->get_settings()) . "\n";
      // union members?
      if (method_exists($pt,'get_prop_types')) {
        $members = $pt->get_prop_types();
        $mk = [];
        foreach ($members as $mm) $mk[] = method_exists($mm,'get_key')?$mm->get_key():get_class($mm);
        echo "    union members=" . implode(",",$mk) . "\n";
      }
    } else { echo "--- '$p' NOT IN SCHEMA\n"; }
  }
}

echo "\n=== Breakpoints ===\n";
$bp = $plugin->breakpoints;
echo "class=" . get_class($bp) . "\n";
$active = $bp->get_active_breakpoints();
foreach ($active as $key => $b) {
  echo "key=$key dir=" . (method_exists($b,'get_direction')?$b->get_direction():'?')
    . " val=" . (method_exists($b,'get_value')?$b->get_value():'?')
    . " label=" . (method_exists($b,'get_label')?$b->get_label():'?') . "\n";
}
echo "has get_device_min_breakpoint=" . (method_exists($bp,'get_device_min_breakpoint')?'Y':'N') . "\n";
// Breakpoints_Manager constants for keys
$bm = '\Elementor\Core\Breakpoints\Manager';
echo "Manager const BREAKPOINT_KEY_MOBILE=" . (defined("$bm::BREAKPOINT_KEY_MOBILE") ? constant("$bm::BREAKPOINT_KEY_MOBILE") : '?') . "\n";

echo "\n=== Size_Constants ===\n";
foreach (['\Elementor\Modules\AtomicWidgets\PropTypes\Size_Constants'] as $sc) {
  echo "$sc exists=" . (class_exists($sc)?'Y':'N') . "\n";
  if (class_exists($sc)) {
    $r = new ReflectionClass($sc);
    foreach ($r->getMethods(ReflectionMethod::IS_STATIC | ReflectionMethod::IS_PUBLIC) as $m) {
      echo "  static method: " . $m->getName() . "\n";
    }
    foreach ($r->getConstants() as $cn=>$cv) {
      echo "  const $cn=" . wp_json_encode($cv) . "\n";
    }
  }
}

echo "\n=== Style_States ===\n";
$ss = '\Elementor\Modules\AtomicWidgets\Styles\Style_States';
echo "$ss exists=" . (class_exists($ss)?'Y':'N') . "\n";
if (class_exists($ss)) {
  $r = new ReflectionClass($ss);
  foreach ($r->getConstants() as $cn=>$cv) echo "  const $cn=" . wp_json_encode($cv) . "\n";
  foreach ($r->getMethods(ReflectionMethod::IS_STATIC | ReflectionMethod::IS_PUBLIC) as $m) {
    echo "  static method: " . $m->getName() . "\n";
  }
  if (method_exists($ss,'get_states')) echo "  get_states()=" . wp_json_encode($ss::get_states()) . "\n";
}
