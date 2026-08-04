<?php
global $wpdb;
$rows=$wpdb->get_col("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE '_transient_emcp_schema_%'");
echo "schema transient count: ".count($rows)."\n";
foreach($rows as $r) echo "  $r\n";
