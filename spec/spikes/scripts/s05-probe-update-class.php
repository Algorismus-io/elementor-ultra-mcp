<?php
/**
 * WP-S05 probe: UPDATE_CLASS capability presence for the admin user.
 *
 * Probes current_user_can / user_can for the Elementor global-classes caps,
 * dumps the administrator role caps, and checks where the constant comes from.
 */

function out($k, $v) { echo $k . ': ' . (is_bool($v) ? ($v ? 'TRUE' : 'FALSE') : (string) $v) . "\n"; }

echo "=== WP-S05 PROBE: UPDATE_CLASS capability presence ===\n\n";

// 1) Resolve the admin user.
$admin = get_user_by('login', 'admin');
if (!$admin) {
    echo "ERROR: admin user not found\n";
    return;
}
out('admin user ID', $admin->ID);
out('admin roles', implode(',', $admin->roles));
echo "\n";

// 2) Resolve the cap constant from Elementor (do not hardcode the string blindly).
$cap_const = null;
if (class_exists('\Elementor\Modules\GlobalClasses\Utils\Add_Capabilities')) {
    $rc = new ReflectionClass('\Elementor\Modules\GlobalClasses\Utils\Add_Capabilities');
    echo "Add_Capabilities class FOUND: " . $rc->getFileName() . "\n";
    foreach ($rc->getConstants() as $name => $val) {
        echo "  const $name = $val\n";
    }
    if ($rc->hasConstant('UPDATE_CLASS')) {
        $cap_const = $rc->getConstant('UPDATE_CLASS');
    }
} else {
    echo "Add_Capabilities class NOT found via that FQCN; searching declared classes...\n";
    foreach (get_declared_classes() as $c) {
        if (stripos($c, 'Add_Capabilities') !== false) {
            echo "  candidate: $c\n";
            $rc = new ReflectionClass($c);
            echo "    file: " . $rc->getFileName() . "\n";
            foreach ($rc->getConstants() as $name => $val) {
                echo "    const $name = $val\n";
            }
            if (!$cap_const && $rc->hasConstant('UPDATE_CLASS')) {
                $cap_const = $rc->getConstant('UPDATE_CLASS');
            }
        }
    }
}
echo "\n";

$caps_to_test = [
    'elementor_global_classes_update_class',
    'elementor_global_classes_create_class',
    'elementor_global_classes_delete_class',
    'manage_options',
    'edit_posts',
];
if ($cap_const && !in_array($cap_const, $caps_to_test, true)) {
    array_unshift($caps_to_test, $cap_const);
}
out('resolved UPDATE_CLASS constant value', $cap_const ?: '(unresolved)');
echo "\n";

// 3) Probe via user_can (does not require a session) for the admin user.
echo "--- user_can(admin, <cap>) ---\n";
foreach ($caps_to_test as $cap) {
    out("user_can:$cap", user_can($admin, $cap));
}
echo "\n";

// 4) Probe via current_user_can after setting the current user (REST/permission_callback path).
wp_set_current_user($admin->ID);
out('current user ID after set', get_current_user_id());
echo "--- current_user_can(<cap>) (admin set as current) ---\n";
foreach ($caps_to_test as $cap) {
    out("current_user_can:$cap", current_user_can($cap));
}
echo "\n";

// 5) Dump the administrator role's full cap list, focus on elementor_* caps.
$role = get_role('administrator');
if ($role) {
    echo "--- administrator role caps containing 'global_classes' or 'elementor' ---\n";
    $found_any = false;
    foreach ($role->capabilities as $cap => $granted) {
        if (stripos($cap, 'global_classes') !== false || stripos($cap, 'elementor') !== false) {
            out("  role-cap:$cap", $granted ? true : false);
            $found_any = true;
        }
    }
    if (!$found_any) {
        echo "  (no elementor/global_classes caps present on administrator role)\n";
    }
    echo "\n";
    out('administrator role has UPDATE_CLASS key', isset($role->capabilities['elementor_global_classes_update_class']));
    out('administrator role UPDATE_CLASS value', isset($role->capabilities['elementor_global_classes_update_class']) ? ($role->capabilities['elementor_global_classes_update_class'] ? 'true' : 'false') : '(absent)');
} else {
    echo "ERROR: administrator role not found\n";
}
echo "\n";

// 6) Check whether the migration option flag indicates the migration ran.
echo "--- migration / option flags ---\n";
global $wpdb;
$opts = $wpdb->get_results("SELECT option_name, LEFT(option_value,200) AS v FROM {$wpdb->options} WHERE option_name LIKE '%capabilit%' OR option_name LIKE '%global_classes%' OR option_name LIKE 'elementor_%version%' OR option_name = 'elementor_version'");
foreach ($opts as $o) {
    echo "  {$o->option_name} = {$o->v}\n";
}

echo "\n=== END PROBE ===\n";
