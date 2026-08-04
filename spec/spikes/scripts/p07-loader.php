<?php
// Inspect what is hooked on the registrar's REGISTER_ACTION and rest_api_init.
echo "REGISTER_ACTION = elementor_ultra/rest/register\n";
global $wp_filter;
foreach (['elementor_ultra/rest/register','rest_api_init','plugins_loaded','init'] as $hook) {
  echo "--- hook '$hook' ---\n";
  if (isset($wp_filter[$hook])) {
    foreach ($wp_filter[$hook]->callbacks as $prio=>$cbs) {
      foreach ($cbs as $id=>$cb) {
        $fn = $cb['function'];
        if (is_array($fn)) {
          $cls = is_object($fn[0])?get_class($fn[0]):$fn[0];
          echo "  [$prio] $cls::{$fn[1]}\n";
        } elseif (is_string($fn)) {
          echo "  [$prio] $fn\n";
        } else {
          echo "  [$prio] (closure)\n";
        }
      }
    }
  } else echo "  (none)\n";
}
// Is there a generic controllers loader?
echo "\nSchema_Controller class loaded? " . (class_exists('\Elementor\Ultra\Rest\Schema_Controller')?'Y':'N') . "\n";
echo "Registrar loaded? " . (class_exists('\Elementor\Ultra\Rest\Registrar')?'Y':'N') . "\n";
// list all included files under includes/rest
$inc = get_included_files();
$rest = array_filter($inc, fn($f)=>strpos($f,'includes/rest/')!==false);
echo "\nincluded rest files:\n" . implode("\n", $rest) . "\n";
