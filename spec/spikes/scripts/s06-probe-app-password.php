<?php
// WP-S06 probe: Application Passwords availability over plain HTTP

echo "=== environment ===\n";
echo "wp_get_environment_type(): " . wp_get_environment_type() . "\n";
echo "is_ssl(): " . var_export(is_ssl(), true) . "\n";
echo "site_url(): " . site_url() . "\n";
echo "home_url(): " . home_url() . "\n";

echo "\n=== application passwords availability ===\n";
echo "wp_is_application_passwords_available(): " . var_export(wp_is_application_passwords_available(), true) . "\n";

$admin = get_user_by('login', 'admin');
if ($admin) {
    echo "admin user ID: " . $admin->ID . "\n";
    echo "wp_is_application_passwords_available_for_user(admin): " . var_export(wp_is_application_passwords_available_for_user($admin), true) . "\n";
    echo "admin can unfiltered_html: " . var_export(user_can($admin, 'unfiltered_html'), true) . "\n";
    echo "admin can edit_posts: " . var_export(user_can($admin, 'edit_posts'), true) . "\n";

    // list existing app passwords
    $pwds = WP_Application_Passwords::get_user_application_passwords($admin->ID);
    echo "existing app passwords count: " . count($pwds) . "\n";
    foreach ($pwds as $p) {
        echo "  - name=" . $p['name'] . " uuid=" . $p['uuid'] . "\n";
    }
} else {
    echo "admin user NOT found\n";
}

echo "\n=== filter state ===\n";
echo "has filter 'wp_is_application_passwords_available': " . var_export(has_filter('wp_is_application_passwords_available'), true) . "\n";

echo "\n=== constants ===\n";
echo "WP_ENVIRONMENT_TYPE constant defined: " . var_export(defined('WP_ENVIRONMENT_TYPE'), true) . "\n";
if (defined('WP_ENVIRONMENT_TYPE')) echo "  value: " . WP_ENVIRONMENT_TYPE . "\n";
