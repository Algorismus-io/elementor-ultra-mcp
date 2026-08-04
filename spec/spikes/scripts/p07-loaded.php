<?php
$inc = get_included_files();
foreach ($inc as $f) if (strpos($f,'elementor-ultra-mcp/includes/rest/')!==false) echo $f."\n";
echo "Media_Controller loaded? " . (class_exists('\Elementor\Ultra\Rest\Media_Controller')?'Y':'N')."\n";
echo "Schema_Controller loaded? " . (class_exists('\Elementor\Ultra\Rest\Schema_Controller')?'Y':'N')."\n";
