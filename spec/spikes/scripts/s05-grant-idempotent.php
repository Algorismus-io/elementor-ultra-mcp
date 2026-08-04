<?php
/**
 * WP-S05: demonstrate the exact idempotent add_cap grant WP-P01 must perform.
 * Mirrors Elementor's Add_Capabilities migration: $role->add_cap( UPDATE_CLASS ).
 * Configurable for an agent role beyond administrator.
 */

const UPDATE_CLASS = 'elementor_global_classes_update_class';

// Roles WP-P01 should grant to: administrator + a configurable agent role.
// (Default to administrator; agent role configurable.)
$target_roles = [ 'administrator' ];

// Optional: pass an agent role via env/arg for the configurable case.
// e.g. define an "elementor_agent" role test if it exists.
if (get_role('elementor_agent')) {
    $target_roles[] = 'elementor_agent';
}

function grant_cap(array $roles, string $cap): array {
    $log = [];
    foreach ($roles as $role_name) {
        $role = get_role($role_name);
        if (!$role) { $log[] = "  $role_name: ROLE MISSING (skip)"; continue; }
        $had = isset($role->capabilities[$cap]) && $role->capabilities[$cap];
        $role->add_cap($cap); // idempotent: WP only writes if changed
        $role2 = get_role($role_name); // re-fetch fresh
        $now = isset($role2->capabilities[$cap]) && $role2->capabilities[$cap];
        $log[] = "  $role_name: had=" . ($had ? 'true' : 'false') . " -> now=" . ($now ? 'true' : 'false');
    }
    return $log;
}

$admin = get_user_by('login', 'admin');

echo "=== BEFORE grant ===\n";
$role = get_role('administrator');
echo "administrator has UPDATE_CLASS: " . (isset($role->capabilities[UPDATE_CLASS]) && $role->capabilities[UPDATE_CLASS] ? 'TRUE' : 'FALSE') . "\n";
echo "user_can(admin, UPDATE_CLASS): " . (user_can($admin, UPDATE_CLASS) ? 'TRUE' : 'FALSE') . "\n\n";

echo "=== RUN 1: add_cap(UPDATE_CLASS) ===\n";
foreach (grant_cap($target_roles, UPDATE_CLASS) as $l) echo $l . "\n";
wp_cache_flush();
$role = get_role('administrator');
echo "after run1, administrator has UPDATE_CLASS: " . (isset($role->capabilities[UPDATE_CLASS]) && $role->capabilities[UPDATE_CLASS] ? 'TRUE' : 'FALSE') . "\n";
echo "after run1, user_can(admin, UPDATE_CLASS): " . (user_can($admin, UPDATE_CLASS) ? 'TRUE' : 'FALSE') . "\n\n";

echo "=== RUN 2 (re-run, must be a no-op / safe) ===\n";
foreach (grant_cap($target_roles, UPDATE_CLASS) as $l) echo $l . "\n";
wp_cache_flush();
$role = get_role('administrator');
echo "after run2, administrator has UPDATE_CLASS: " . (isset($role->capabilities[UPDATE_CLASS]) && $role->capabilities[UPDATE_CLASS] ? 'TRUE' : 'FALSE') . "\n";
echo "after run2, user_can(admin, UPDATE_CLASS): " . (user_can($admin, UPDATE_CLASS) ? 'TRUE' : 'FALSE') . "\n\n";

echo "=== RESULT: cap " . (user_can($admin, UPDATE_CLASS) ? 'RESTORED' : 'STILL MISSING') . " ===\n";
