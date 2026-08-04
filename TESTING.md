# Testing the ULTRA Elementor MCP

This walks you through driving the MCP yourself against the live local WordPress site.

## What's already set up

- **Live WordPress** at `http://localhost:8899` (Docker stack in `tools/wp-stack/docker-compose.yml`) with **Elementor 4.1.1 + Pro 4.1.0** and the **companion plugin** (`elementor-ultra-mcp`) active, V4 atomic experiments on.
- **wp-admin:** `http://localhost:8899/wp-admin` — user `admin` / pass `admin`.
- **MCP server** built at `packages/server/dist/index.js`, registered as a project MCP server in `.mcp.json` (points at the site with an Application Password, `ULTRA_TOOLS=full` = all 86 tools).

If the site isn't running, bring it up:

```sh
docker compose -p elementor-mcp -f tools/wp-stack/docker-compose.yml up -d
```

If you ever need a fresh build of the server:

```sh
pnpm install && pnpm build
```

## Connect a client

### Option A — Claude Code (you're already here)

`.mcp.json` is in the repo root, so Claude Code will offer to enable the `elementor-ultra` server. **Restart Claude Code** (or run `/mcp` to check status / approve it). Once connected, just ask in plain language — e.g. _"Use the elementor-ultra tools to build a pricing page."_ Run `/mcp` to see it listed and to inspect its tools.

### Option B — Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (merge into any existing `mcpServers`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "elementor-ultra": {
      "command": "node",
      "args": ["/Users/shahmir/projects/elementor-mcp/packages/server/dist/index.js"],
      "env": {
        "WP_URL": "http://localhost:8899",
        "WP_USER": "admin",
        "WP_APP_PASSWORD": "SET-VIA-WP_APP_PASSWORD-ENV",
        "ULTRA_TOOLS": "full"
      }
    }
  }
}
```

### Option C — MCP Inspector (raw tool exploration)

```sh
WP_URL=http://localhost:8899 WP_USER=admin WP_APP_PASSWORD="SET-VIA-WP_APP_PASSWORD-ENV" ULTRA_TOOLS=full \
  npx @modelcontextprotocol/inspector node packages/server/dist/index.js
```

Opens a UI to list/call every tool by hand and see raw inputs/outputs.

> **Tool profile:** `ULTRA_TOOLS=full` exposes all 86 tools. Set `ULTRA_TOOLS=lean` (~21 star tools) if a client feels overwhelmed; the lean set still covers build/edit/design basics.

## Things to try (example prompts)

Watch results live at `http://localhost:8899/wp-admin/edit.php?post_type=page` (and open any page in the Elementor editor or its public URL).

**Build a page from a brief**

> "Build a landing page called _Acme Cloud_: a hero (headline, subheadline, two buttons), a 3-column feature row, and a closing call-to-action. Use a blue accent. Dry-run first, show me the diff, then commit it and give me the preview URL."

**Edit an existing page safely**

> "On the _Acme Cloud_ page, change the hero headline to 'Ship faster' and make the feature headings larger. Show the diff before saving, and keep a backup so we can roll back."
>
> "Actually, roll that back to the previous version."

**HTML → native widgets (the flagship)**

> "Convert this HTML into native Elementor widgets (dry-run, show me the coverage report and which widgets it mapped to): `<section><h1>Welcome</h1><p>We build great software.</p><a class='button' href='/contact'>Get in touch</a></section>`"
>
> "Good — now commit it as a new page and confirm it renders styled."

**Design system**

> "List the global classes and design variables on the site. Add a `brand-primary` color variable set to #2563eb."

**Elementor Pro**

> "Create a single-post theme template that applies to all posts, with a heading bound to the dynamic post title."
>
> "Create an exit-intent popup with a headline and a sign-up button."
>
> "Build a contact form with name, email, and message fields that emails the site admin."

**Discovery / introspection**

> "What can you do on this Elementor site? Probe the site capabilities and list the available tools."

## How to verify what happened

- **Pages list:** `http://localhost:8899/wp-admin/edit.php?post_type=page`
- **Open in Elementor:** edit any page → it opens in the V4 atomic editor.
- **Public render (styled):** click _View Page_ / open the preview URL the tool returns.
- **Theme templates / popups:** `http://localhost:8899/wp-admin/edit.php?post_type=elementor_library`
- **Media (sideloaded images):** `http://localhost:8899/wp-admin/upload.php`
- **Audit trail:** ask _"show the ops log"_ (every write is recorded with an op_id + before/after hash).

## Safety model (what the MCP guarantees)

- **Never blind-writes:** atomic trees are validated by the authoritative PHP `dry_run` before any save; invalid input is rejected, nothing is persisted.
- **Backups + rollback:** every write snapshots the prior state; ask to roll back any page.
- **HTML conversion never auto-commits:** you always get a dry-run + diff + coverage report and must confirm before it writes.
- **Optimistic locking:** concurrent/stale edits are caught (`base_hash`).
- **CSS is primed:** after a save the atomic CSS is regenerated so pages render styled immediately.

## Reset the test site

Wipe all pages/templates and start clean (keeps WordPress + plugins):

```sh
dc() { docker compose -p elementor-mcp -f tools/wp-stack/docker-compose.yml run --rm wpcli wp "$@"; }
dc post list --post_type=page,elementor_library --format=ids | xargs -n1 -I{} sh -c 'docker compose -p elementor-mcp -f tools/wp-stack/docker-compose.yml run --rm wpcli wp post delete {} --force'
```

Re-mint the Application Password (if you ever rotate it — then update `.mcp.json`):

```sh
docker compose -p elementor-mcp -f tools/wp-stack/docker-compose.yml run --rm wpcli \
  wp user application-password create admin elementor-mcp --porcelain
```

## Troubleshooting

- **Client shows no tools / connection error:** confirm `packages/server/dist/index.js` exists (`pnpm build`), and that `node` is on your PATH. The server prints a clear message to stderr and exits if `WP_URL`/`WP_USER`/`WP_APP_PASSWORD` are missing.
- **401/403 from tools:** the app password or user is wrong — re-mint it (above) and update `.mcp.json`.
- **Site unreachable:** `docker compose -p elementor-mcp -f tools/wp-stack/docker-compose.yml ps` — bring it up with `up -d`.
- **A tool says a capability/experiment is missing:** ask _"probe site capabilities"_ — it reports which experiments/caps are active.
