=== Ultra for Elementor ===
Contributors: algorismus
Tags: elementor, ai, mcp, rest-api, automation
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Requires Plugins: elementor
Stable tag: 1.2.3
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Let AI agents build and edit real Elementor pages on your site — a safe, versioned REST surface with validation, backups, and rollback.

== Description ==

Ultra for Elementor is the WordPress half of the open-source **Elementor Ultra** stack: it gives an external AI agent (Claude Code, Cursor, Windsurf, or any MCP-capable client) a safe, authoritative way to author Elementor pages on your site.

The agent side runs on your machine — an MCP server with ~90 tools and a JSX→Elementor compiler. This plugin is the site side: a versioned REST API under the `elementor-ultra/v1` namespace that validates every write before it lands.

**What the plugin provides:**

* A custom REST seam — documents, schema, design system (classes, variables, global colors and fonts), media, templates, Pro surfaces, ops, and a `site/capabilities` health probe — authenticated with standard WordPress Application Passwords.
* An authoritative element-tree validator: malformed or unknown Elementor structures are rejected server-side before they ever save.
* Transactional, backup-first writes with per-page rollback.
* Elementor V4 atomic CSS priming, optimistic concurrency (`base_hash`), and idempotent operations (`op_id`).
* Graceful degradation: if Elementor is absent or incompatible the plugin never fatals — it reports the situation through `site/capabilities`.

**What you can build with the full stack:** real production pages. Eight complete site redesigns were built live on camera by an AI agent — one prompt each, 17–31 minutes, zero human edits, finished pages fully editable in the normal Elementor editor. Films and scrollable results: [docs.wpos.ai/ultra/examples](https://docs.wpos.ai/ultra/examples/overview).

The whole stack is open source (MIT/GPL): [github.com/Algorismus-io/elementor-ultra](https://github.com/Algorismus-io/elementor-ultra).

Ultra for Elementor is an independent project. It is not affiliated with or endorsed by Elementor Ltd; "Elementor" is a trademark of Elementor Ltd, used here to describe interoperability.

== Installation ==

1. Ensure Elementor (4.1.0 or newer) is installed and active.
2. Install and activate Ultra for Elementor.
3. Create a dedicated user and an Application Password (Users → Profile → Application Passwords).
4. On your machine, paste the setup prompt from [the GitHub repo](https://github.com/Algorismus-io/elementor-ultra) into your AI agent, or run `npx @algorismus/create-elementor-ultra` — the wizard connects the MCP server and CLI to your site using the Application Password.

== Frequently Asked Questions ==

= Does my content leave my site? =

The plugin itself sends nothing anywhere. Your AI agent (running on your machine) reads and writes your site over authenticated REST — the same trust model as any REST client you authorize with an Application Password.

= Does it require Elementor Pro? =

No. All free routes work without Pro. Pro-only routes return a structured `PRO_REQUIRED` error when Pro is inactive.

= Are the pages it builds locked to this plugin? =

No. Output is standard Elementor V4 atomic JSON. Deactivate the plugin and every page remains a normal, fully editable Elementor page.

= What happens if the agent writes something broken? =

Writes are validated server-side against an authoritative element-tree validator before saving, saves are backup-first, and every page can be rolled back.

= What capability does it grant? =

Only `elementor_global_classes_update_class` — Elementor's migration-only, administrator-granted capability that gates global-class writes. The grant is idempotent and re-activation-safe.

== Screenshots ==

1. An AI agent building a page section by section through the live dev loop — every save deploys and hot-reloads the real site.
2. The finished page open in the native Elementor editor: standard widgets, standard navigator, fully editable.
3. Verification gates checking a deployed page at desktop, wide, and mobile breakpoints.
4. A complete redesign built from one prompt in 31 minutes of agent time.

== Changelog ==

= 1.2.3 =
* Deploy performance: `X-EMCP-Skip-Reprime` header skips redundant CSS re-priming on batched writes.
* Design-system surface hardening; capability probe additions.

= 1.2.0 =
* Design system routes: classes, variables, global colors and fonts; templates and Pro surfaces; ops log.

= 1.0.0 =
* Initial release: plugin bootstrap, REST seam, authoritative validator, transactional backup-first writes, V4 atomic CSS priming, idempotent activation grant.

== Upgrade Notice ==

= 1.2.3 =
Faster batched deploys and a hardened design-system surface. Safe upgrade; no schema changes.
