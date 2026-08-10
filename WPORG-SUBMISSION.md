# WordPress.org submission — "Ultra for Elementor"

Directory listing prep for the companion plugin. The directory disallows plugin
names/slugs that LEAD with a trademark, so the listing name is **Ultra for
Elementor**, slug request **`ultra-for-elementor`**. GitHub/npm names stay as
they are.

## Before submitting (code changes on a `wporg` branch)

1. Rename the plugin dir + main file to `ultra-for-elementor/ultra-for-elementor.php`.
2. Header changes in the main file:
   - `Plugin Name: Ultra for Elementor`
   - `Text Domain: ultra-for-elementor` (and update `load_plugin_textdomain` if used)
   - Keep `Requires Plugins: elementor` (this is the supported dependency header).
3. Replace `readme.txt` with `plugin/elementor-ultra-mcp/readme-wporg-draft.txt`
   (already written; update "Tested up to" to the current WP release at submit time).
4. Directory rules sweep: no minified-only JS without sources, no external
   script/tracking calls, sanitized/escaped I/O (the REST layer already does this —
   re-run `phpcs` with the WordPress-Extra ruleset to be sure).
5. Build a clean zip: no `composer.lock` dev deps, no `tests/`, no `.dist` files.

## Assets (upload to SVN `/assets` after approval)

- `icon-256x256.png` + `icon-128x128.png` — the Ultra mark on `#0B0B10`.
- `banner-1544x500.png` + `banner-772x250.png` — "One prompt in. A site out."
  over a film still (use the housemait editor-proof frame).
- `screenshot-1..4.png` — match the numbered captions in the readme (dev-loop
  split view, Elementor editor with the built page, gates output, finished site).
  Stills from the editorial films work: extract at the relevant marks.

## Submission flow

1. wordpress.org account (org-owned email, not personal), then
   https://wordpress.org/plugins/developers/add/ — upload the zip.
2. Review queue is human; current wait is typically 2–6 weeks. Reviewers reply
   by email; respond fast to keep queue position.
3. Expected review pushback to be ready for:
   - **Trademark**: name/slug lead with "Ultra" ✓; readme carries the
     non-affiliation line ✓; make sure NO asset uses Elementor's logo.
   - **"Plugin is a bridge to an external service"**: it isn't a service — the
     MCP server runs on the user's machine. Say exactly that in the review reply;
     the readme FAQ "Does my content leave my site?" pre-answers it.
   - **Application Passwords**: standard core auth, no custom tokens — say so.
4. After approval: SVN checkout, commit `trunk/` + `assets/`, tag `1.2.3`,
   set stable tag. GitHub stays the development home; SVN is release-only.

## Positioning note

The listing sells the OUTCOME (AI agents build real, editable Elementor pages
safely), not the architecture. The films at
https://docs.wpos.ai/ultra/examples/overview are the proof — the readme links
them; the screenshots repeat them.
