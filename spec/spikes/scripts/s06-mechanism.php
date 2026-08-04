<?php
// WP-S06: confirm WHICH mechanism authenticates the Basic-auth request

echo "=== authentication filters in play ===\n";
echo "has 'wp_authenticate_application_password' callback: " . var_export(has_filter('wp_authenticate_application_password'), true) . "\n";
echo "has 'application_password_is_api_request' callback: " . var_export(has_filter('application_password_is_api_request'), true) . "\n";
echo "has 'rest_authentication_errors' callback: " . var_export(has_filter('rest_authentication_errors'), true) . "\n";

echo "\n=== is any Basic-Auth plugin active? ===\n";
$plugins = get_option('active_plugins', array());
foreach ($plugins as $p) { echo "  active plugin: $p\n"; }
$muplugins = wp_get_mu_plugins();
foreach ($muplugins as $p) { echo "  mu-plugin: " . basename($p) . "\n"; }

echo "\n=== application_password_is_api_request value ===\n";
// This filter defaults true when REST/XML-RPC. It gates whether app passwords are even tried.
echo "apply_filters(application_password_is_api_request, false): " . var_export(apply_filters('application_password_is_api_request', false), true) . "\n";

echo "\n=== why availability is false but auth still works ===\n";
echo "wp_is_application_passwords_available() = " . var_export(wp_is_application_passwords_available(), true) . "\n";
echo "  (this gates CREATION/listing in admin UI + the availability advertisement, NOT runtime auth of an existing password)\n";

echo "\n=== Source check: does WP gate AUTHENTICATION on is_ssl/availability? ===\n";
// In wp-includes/user.php wp_authenticate_application_password() the early-return is:
//   if ( ! wp_is_application_passwords_available() ) return $input_user;  (WP 5.6 - 6.x)
// Let's verify the actual installed source.
$src = ABSPATH . 'wp-includes/user.php';
if (file_exists($src)) {
    $code = file_get_contents($src);
    $pos = strpos($code, 'function wp_authenticate_application_password');
    if ($pos !== false) {
        echo substr($code, $pos, 1400) . "\n";
    } else {
        echo "function not found in user.php\n";
    }
}
echo "\n=== WP version ===\n";
echo "wp version: " . get_bloginfo('version') . "\n";
