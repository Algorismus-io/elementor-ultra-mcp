<?php
/**
 * Provisioning for the Docker-free Elementor Ultra dev site (WordPress Playground / PHP-WASM).
 * Runs as a blueprint runPHP step. Kept in a file (not an escaped JSON string) so it stays readable.
 */
ini_set('display_errors', '1');
error_reporting(E_ALL);

require_once '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

// Blueprint steps run with NO logged-in user. Elementor's Kits Manager hooks option updates
// (blogname -> kit "site_name") through Document::save_settings, which hard-fails "Access denied"
// unless the current user can edit. Establish admin context BEFORE touching Elementor-mirrored options.
$admin = get_user_by('login', 'admin');
if (!$admin) { echo "ULTRA_ERR=no-admin-user\n"; return; }
wp_set_current_user($admin->ID);

update_option('blogname', 'Elementor Ultra Dev');
foreach (['e_atomic_elements', 'e_classes', 'e_variables'] as $exp) {
    update_option('elementor_experiment-' . $exp, 'active');
}

// WP_ENVIRONMENT_TYPE via defineWpConfigConsts is RUNTIME-only — a persisted install that boots
// without the blueprint loses it, WordPress stops treating the site as `local`, and app-password
// Basic auth over plain HTTP starts 401ing. Bake it into wp-config.php so it survives restarts.
$cfg = '/wordpress/wp-config.php';
if (is_readable($cfg)) {
    $c = file_get_contents($cfg);
    if (strpos($c, 'WP_ENVIRONMENT_TYPE') === false) {
        $inject = "define( 'WP_ENVIRONMENT_TYPE', 'local' );\n\n";
        $marker = "/* That's all, stop editing!";
        $c = (strpos($c, $marker) !== false) ? str_replace($marker, $inject . $marker, $c) : $c . "\n" . $inject;
        file_put_contents($cfg, $c);
    }
}

// Pretty permalinks — /wp-json/* only resolves under them (else every REST call 301s to HTML).
global $wp_rewrite;
$wp_rewrite->set_permalink_structure('/%postname%/');
$wp_rewrite->flush_rules(true);

if (!class_exists('WP_Application_Passwords')) { echo "ULTRA_ERR=no-app-password-class\n"; return; }
$made = WP_Application_Passwords::create_new_application_password($admin->ID, ['name' => 'elementor-ultra']);
if (is_wp_error($made)) { echo 'ULTRA_ERR=' . $made->get_error_message() . "\n"; return; }

// Playground swallows successful runPHP stdout, so hand the credential back over the mounted out dir.
file_put_contents('/ultra-out/credentials.json', json_encode([
    'WP_URL'          => 'http://127.0.0.1:8899',
    'WP_USER'         => $admin->user_login,
    'WP_APP_PASSWORD' => $made[0],
    'elementor'       => defined('ELEMENTOR_VERSION') ? ELEMENTOR_VERSION : 'MISSING',
    'plugin_active'   => is_plugin_active('elementor-ultra-mcp/elementor-ultra-mcp.php'),
    'env_type'        => wp_get_environment_type(),
], JSON_PRETTY_PRINT) . "\n");
echo "ULTRA_DONE\n";
