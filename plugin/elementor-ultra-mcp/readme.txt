=== Elementor Ultra MCP ===
Contributors: algorismus
Tags: elementor, mcp, rest-api, automation, ai
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Requires Plugins: elementor
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Companion WordPress plugin for the Elementor Ultra MCP server. Exposes the elementor-ultra/v1 REST seam consumed by the external TypeScript MCP server.

== Description ==

Elementor Ultra MCP is the companion WordPress plugin half of the Elementor Ultra MCP system. It exposes a versioned REST API under the `elementor-ultra/v1` namespace that an external TypeScript MCP (Model Context Protocol) server calls to read and author Elementor documents safely.

The plugin provides:

* A custom REST seam (documents, schema, design system, media, templates, Pro surfaces, ops, and a `site/capabilities` probe) authenticated with WordPress Application Passwords.
* An authoritative element-tree validator and transactional, backup-first writes.
* V4 atomic CSS priming, optimistic concurrency (base_hash), and idempotency (op_id).
* An idempotent activation grant of the migration-only `elementor_global_classes_update_class` capability so global-class writes work for the agent user.

The plugin never fatals when Elementor is absent or incompatible: it reports site health through `site/capabilities` instead.

== Installation ==

1. Ensure Elementor (4.1.0 or newer) is installed and active.
2. Upload the `elementor-ultra-mcp` directory to `wp-content/plugins/`.
3. Activate the plugin through the WordPress Plugins screen. Activation idempotently grants the `elementor_global_classes_update_class` capability to the administrator role.
4. Create a dedicated user and an Application Password, then point the Elementor Ultra MCP server at the site.

== Frequently Asked Questions ==

= Does it require Elementor Pro? =

No. All free routes work without Elementor Pro. Pro-only routes return a structured `PRO_REQUIRED` error when Pro is inactive.

= What capability does it grant? =

Only `elementor_global_classes_update_class` (Elementor's migration-only, administrator-granted capability that gates global-class writes). The grant is idempotent and re-activation-safe.

== Changelog ==

= 1.0.0 =
* Initial release: plugin bootstrap, autoloader, idempotent UPDATE_CLASS activation grant, and the shared experiment/Pro/capability Guards service.
