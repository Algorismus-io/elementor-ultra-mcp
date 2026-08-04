<?php
echo "=== Locate Add_Capabilities + global classes REST permission_callback ===\n\n";

// Force-load the GlobalClasses module classes if possible.
$candidates = [
    '\Elementor\Modules\GlobalClasses\Utils\Add_Capabilities',
    '\Elementor\Modules\GlobalClasses\Add_Capabilities',
];
foreach ($candidates as $c) {
    echo "class_exists($c): " . (class_exists($c) ? 'YES' : 'no') . "\n";
}
echo "\n";

// Search all declared classes for Add_Capabilities (after autoload attempts).
foreach (get_declared_classes() as $cl) {
    if (stripos($cl, 'Add_Capabilities') !== false || stripos($cl, 'GlobalClasses') !== false) {
        $rc = new ReflectionClass($cl);
        echo "DECLARED: $cl\n  file: " . $rc->getFileName() . "\n";
    }
}
echo "\n";

// Grep the Elementor plugin dir on disk for the cap string + constant defs.
$base = WP_PLUGIN_DIR;
echo "WP_PLUGIN_DIR = $base\n\n";

function rgrep($dir, $needle, &$hits, $max = 60) {
    if (count($hits) >= $max) return;
    $it = @scandir($dir);
    if (!$it) return;
    foreach ($it as $f) {
        if ($f === '.' || $f === '..') continue;
        $p = $dir . '/' . $f;
        if (is_dir($p)) { rgrep($p, $needle, $hits, $max); }
        elseif (substr($f, -4) === '.php') {
            $c = @file_get_contents($p);
            if ($c !== false && strpos($c, $needle) !== false) {
                foreach (explode("\n", $c) as $ln => $line) {
                    if (strpos($line, $needle) !== false) {
                        $hits[] = $p . ':' . ($ln + 1) . ': ' . trim($line);
                        if (count($hits) >= $max) return;
                    }
                }
            }
        }
    }
}

echo "--- files referencing 'elementor_global_classes_update_class' ---\n";
$hits = [];
rgrep($base . '/elementor/modules/global-classes', 'update_class', $hits, 40);
if (empty($hits)) {
    // wider search
    rgrep($base . '/elementor', 'global_classes_update_class', $hits, 40);
}
foreach ($hits as $h) echo "  $h\n";
echo "\n";

echo "--- files defining UPDATE_CLASS / const + add_cap in global-classes ---\n";
$hits2 = [];
rgrep($base . '/elementor/modules/global-classes', 'UPDATE_CLASS', $hits2, 40);
foreach ($hits2 as $h) echo "  $h\n";
echo "\n";

echo "--- add_cap / Add_Capabilities references ---\n";
$hits3 = [];
rgrep($base . '/elementor/modules/global-classes', 'add_cap', $hits3, 40);
foreach ($hits3 as $h) echo "  $h\n";

echo "\n=== END ===\n";
