# Elementor Ultra MCP

**The agent control surface for Elementor.** A Model Context Protocol server + companion
WordPress plugin that let AI agents read, build, refactor and govern real Elementor sites —
Editor V4 atomic elements first, V3 classic fallback — with authoritative server-side
validation, diffs, backups and rollback on every write.

- **`packages/server`** — TypeScript MCP server: **40 tools** (`elementor.page.*`,
  `widget`, `design`, `templates`, `media`, `nav`, `pro.*`, HTML→Elementor convert),
  stdio + HTTP transports, lean/full tool profiles.
- **`plugin/elementor-ultra-mcp`** — WordPress plugin exposing the authoritative REST seam
  (`/wp-json/elementor-ultra/v1/*`): every write goes through Elementor's own
  `Document::save()` with backup snapshots, optimistic concurrency (`base_hash`),
  idempotency (`op_id`) replay, the authoritative validator, and mandatory CSS priming.
- **`packages/shared`** — the frozen contract surface: REST route registry, error taxonomy,
  JSON-schema mirrors, golden fixtures. Byte-identical to `spec/contracts/schemas` (CI-guarded).
- **`spec/`** — the full engineering record: contracts, spike verdicts and work packages
  the system was built against.

Pairs with [elementor-jsx](https://github.com/Algorismus-io/elementor-jsx) — the JSX→Elementor
compiler whose deploys ride this plugin's REST seam.

## Quickstart (use it with an agent)

1. Install the companion plugin on your WordPress site (zip from Releases; requires
   Elementor ≥ 4.1) and create an application password.
2. Wire the server into your MCP client (`.mcp.json`):

```jsonc
{
  "mcpServers": {
    "elementor-ultra": {
      "command": "node",
      "args": ["/path/to/elementor-ultra-mcp/packages/server/dist/index.js"],
      "env": {
        "WP_URL": "https://your-site.com",
        "WP_USER": "admin",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx",
        "ULTRA_TOOLS": "full",
      },
    },
  },
}
```

3. Ask your agent to list pages, dry-run a tree, build a page. Every mutation is validated
   by Elementor's own parsers server-side before anything saves; invalid trees are rejected
   atomically with a taxonomy error code.

## Licensing

- TypeScript packages (`packages/*`): **MIT** © 2026 [Algorismus](https://algorismus.io)
- WordPress plugin (`plugin/elementor-ultra-mcp`): **GPL-2.0-or-later** (WordPress convention)

Not affiliated with or endorsed by Elementor Ltd — "Elementor" is their trademark; this is
an independent integration that targets their page format.

---

## Prerequisites

| Tool     | Version                | Notes                                                         |
| -------- | ---------------------- | ------------------------------------------------------------- |
| Node.js  | **≥ 20 LTS**           | `.nvmrc` pins `20`. `engine-strict=true` is enforced.         |
| pnpm     | **9.x**                | The package manager; the lockfile is committed.               |
| Docker   | running                | Required by `@wordpress/env` (wp-env) for the dev WP site.    |
| PHP      | ≥ 7.4 _(in container)_ | Provided by the wp-env Docker container — no host PHP needed. |
| Composer | _(in container)_       | The plugin's Composer/PHPCS setup is provided by WP-P01.      |

You do **not** need PHP or Composer on the host; the PHP tooling runs inside the wp-env container.

---

## Install & build

```bash
pnpm install        # installs all workspace deps; writes/uses pnpm-lock.yaml
pnpm build          # turbo: compiles packages/shared + packages/server (strict TS)
pnpm lint           # eslint (typescript-eslint, recommended-type-checked) across the workspace
pnpm format:check   # prettier --check
pnpm test:unit      # turbo: vitest run in each package
```

### Running the server bin (no tools wired yet)

After `pnpm build`, the server bin exists at `packages/server/dist/index.js`. With **no env set** it
prints a clear message and exits cleanly (exit code 0):

```bash
node packages/server/dist/index.js
# -> elementor-ultra-mcp: missing required environment variable(s): WP_URL, WP_USER, WP_APP_PASSWORD. ...
```

When configured, it reads the following environment variables:

| Variable          | Required | Meaning                                               |
| ----------------- | -------- | ----------------------------------------------------- |
| `WP_URL`          | yes      | Base URL of the target WordPress site.                |
| `WP_USER`         | yes      | WordPress username (Application-Password owner).      |
| `WP_APP_PASSWORD` | yes      | WordPress **Application Password** (HTTP Basic auth). |
| `MCP_TRANSPORT`   | no       | `stdio` (default) or `http` (Streamable HTTP).        |
| `ULTRA_TOOLS`     | no       | `lean` (default) or `full` tool profile.              |

> The real transport binding + tool registry are added by **WP-T01** in `packages/server/src/server.ts`.
> The bin (`index.ts`) lazily `import()`s `./server.js` and prints _"server core not yet wired"_ until
> that module exists — so the bin compiles and boots standalone on this scaffold.

---

## Local WordPress dev site (wp-env)

The dev site uses [`@wordpress/env`](https://www.npmjs.com/package/@wordpress/env) and pins
**Elementor 4.1.1** + **Elementor Pro 4.1.0** _exactly_ via **local plugin zips** (not the wp.org
slug, which pulls the latest version and does not host Pro at all).

### Where the plugin zips live (and where Pro must be placed)

`.wp-env.json` references two local zips under **`.wp-env-plugins/`** (a **gitignored** directory):

```
.wp-env-plugins/
├─ elementor.4.1.1.zip        # Elementor free 4.1.1
└─ elementor-pro.4.1.0.zip    # Elementor Pro 4.1.0  (licensed; not on wp.org)
```

These zips are **not committed** (they are licensed binaries and are gitignored). After a fresh
clone you must place them yourself:

```bash
mkdir -p .wp-env-plugins
cp /path/to/elementor.4.1.1.zip      .wp-env-plugins/elementor.4.1.1.zip
cp /path/to/elementor-pro.4.1.0.zip  .wp-env-plugins/elementor-pro.4.1.0.zip
```

The exact filenames above must match the paths in `.wp-env.json`.

### Start / stop

```bash
pnpm wp-env:start   # boots WordPress + Elementor 4.1.1 + Pro 4.1.0; mounts the companion plugin
pnpm wp-env:stop
```

`.wp-env.json` also mounts **`./plugin/elementor-ultra-mcp`** as a plugin. That directory's contents
(the bootstrap, `composer.json`, `phpcs.xml.dist`, `readme.txt`, and `includes/`) are created by
**WP-P01**; once they land the companion plugin is activatable in the wp-env site. The plugin's own
Composer/PHPCS configuration is also provided by WP-P01.

---

## Monorepo layout

```
elementor-ultra-mcp/
├─ packages/
│  ├─ server/      # TS MCP server (bin: elementor-ultra-mcp)
│  └─ shared/      # shared types + JSON Schemas + fixtures
├─ plugin/
│  └─ elementor-ultra-mcp/   # companion WP plugin (PHP) — populated by WP-P01
├─ spec/           # frozen architecture + contracts + work packages
├─ .wp-env.json    # pins Elementor 4.1.1 + Pro 4.1.0 (local zips) + mounts the plugin
└─ (root tooling: pnpm-workspace.yaml, turbo.json, tsconfig.base.json, eslint, prettier)
```

## MCP SDK pin (LOCKED)

`packages/server` pins **`@modelcontextprotocol/sdk ^1.29`** with `zod` as a required peer.
Never add any `@modelcontextprotocol/*` **2.x** package — in 1.x, `inputSchema`/`outputSchema` are
**ZodRawShape maps** and transports are deep `.js` imports. CI guards against a 2.x dependency
appearing in the lockfile (WP-F07).
