#!/bin/bash
# Builds the wp.org submission zip (WPORG-SUBMISSION.md): renames the plugin to
# "Ultra for Elementor" (directory disallows leading-trademark names), swaps the
# i18n text domain + user-facing brand strings, applies the wp.org readme.
# REST namespace (elementor-ultra/v1) is intentionally untouched.
# Usage: scripts/release/build-wporg-zip.sh <clean-plugin-zip> <out-dir>
set -e
SRC_ZIP=${1:?clean plugin zip}; OUT=${2:-.}
WP_TESTED=$(curl -s "https://api.wordpress.org/core/version-check/1.7/" | python3 -c "import json,sys; v=json.load(sys.stdin)['offers'][0]['version']; print('.'.join(v.split('.')[:2]))")
STABLE=$(grep -m1 "Version:" "$(dirname "$0")/../../plugin/elementor-ultra-mcp/elementor-ultra-mcp.php" | sed 's/[^0-9.]//g')
T=$(mktemp -d); unzip -q "$SRC_ZIP" -d "$T"
mv "$T/elementor-ultra-mcp" "$T/ultra-for-elementor"
mv "$T/ultra-for-elementor/elementor-ultra-mcp.php" "$T/ultra-for-elementor/ultra-for-elementor.php"
find "$T/ultra-for-elementor" -name "*.php" -exec sed -i '' \
  -e "s/'elementor-ultra-mcp'/'ultra-for-elementor'/g" \
  -e "s/Elementor Ultra MCP/Ultra for Elementor/g" {} +
sed -i '' \
  -e "s/^ \* Plugin Name:.*/ * Plugin Name:       Ultra for Elementor/" \
  -e "s/^ \* Text Domain:.*/ * Text Domain:       ultra-for-elementor/" \
  "$T/ultra-for-elementor/ultra-for-elementor.php"
cp "$(dirname "$0")/../../plugin/elementor-ultra-mcp/readme-wporg-draft.txt" "$T/ultra-for-elementor/readme.txt"
sed -i '' -e "s/^Tested up to:.*/Tested up to: $WP_TESTED/" -e "s/^Stable tag:.*/Stable tag: $STABLE/" "$T/ultra-for-elementor/readme.txt"
(cd "$T" && zip -qr ultra-for-elementor.zip ultra-for-elementor)
mv "$T/ultra-for-elementor.zip" "$OUT/"
echo "built $OUT/ultra-for-elementor.zip (Tested up to $WP_TESTED, stable $STABLE)"
