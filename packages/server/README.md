# Elementor Ultra MCP — server

The `npx`-distributable [Model Context Protocol](https://modelcontextprotocol.io) server for safely
reading and authoring **Elementor** documents on a WordPress site. It pairs with the companion
WordPress plugin (`elementor-ultra-mcp`) that exposes the `elementor-ultra/v1` REST seam this server
calls. Built on `@modelcontextprotocol/sdk@^1.29`.

> This package is the **TypeScript MCP server only**. It does **not** bundle Elementor, Elementor
> Pro, or the companion plugin — install those separately on each target site (see below).

## Quick start (npx, stdio — Claude Desktop / local MCP clients)

No install needed; run it on demand with `npx`. Add this to your MCP client config (e.g. Claude
Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "elementor-ultra": {
      "command": "npx",
      "args": ["-y", "@youragency/elementor-ultra-mcp"],
      "env": {
        "WP_URL": "https://clientsite.test",
        "WP_USER": "mcp-agent",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx",
        "ULTRA_TOOLS": "lean"
      }
    }
  }
}
```

The server reads its config **once at startup** from the environment. With no `WP_URL`/`WP_USER`/
`WP_APP_PASSWORD` set it prints a short notice and exits cleanly (so you can probe that the binary
runs before wiring credentials).

## Environment configuration

| Variable          | Required | Default | Description                                                                                                        |
| ----------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `WP_URL`          | yes      | —       | Base URL of the WordPress site (e.g. `https://clientsite.test`).                                                   |
| `WP_USER`         | yes      | —       | WordPress username for the agent (an admin with `unfiltered_html`).                                                |
| `WP_APP_PASSWORD` | yes      | —       | The user's [Application Password](https://wordpress.org/documentation/article/application-passwords/) (spaces ok). |
| `ULTRA_TOOLS`     | no       | `lean`  | Tool profile: `lean` (curated surface) or `full` (every tool).                                                     |
| `MCP_TRANSPORT`   | no       | `stdio` | Transport: `stdio` (local) or `http` (Streamable HTTP, hosted).                                                    |

Authentication is **HTTP Basic** using `base64(WP_USER:WP_APP_PASSWORD)`, sent to both `wp/v2/*` and
`elementor-ultra/v1/*`. This is the security boundary — the companion plugin's REST routes each gate
on `current_user_can(...)`, not on a nonce.

## Transports

- **stdio** (`MCP_TRANSPORT=stdio`, default) — for local clients like Claude Desktop, launched via
  `npx`. The process speaks MCP over stdin/stdout.
- **Streamable HTTP** (`MCP_TRANSPORT=http`) — for hosted/serverless use. Clients connect to the MCP
  endpoint URL and send `Authorization: Basic <base64(user:app-password)>`:

  ```json
  {
    "url": "https://your-host/elementor-ultra-mcp",
    "headers": { "Authorization": "Basic <base64(user:app-password)>" }
  }
  ```

## Per-site setup (companion plugin + App Password)

Each target WordPress site needs the companion plugin and a dedicated agent App Password:

1. **Install Elementor** (4.1.0+) and activate it. (Pro is optional; Pro tools degrade gracefully
   when absent.)
2. **Install the companion plugin** `elementor-ultra-mcp` — either as a normal plugin
   (`wp-content/plugins/`) or, on multisite, dropped as a network mu-plugin
   (`wp-content/mu-plugins/`). Activation idempotently grants the
   `elementor_global_classes_update_class` capability so global-class writes work for the agent user.
3. **Create a dedicated admin user** for the agent and ensure it has `unfiltered_html`.
4. **Generate an Application Password** for that user (Users → Profile → Application Passwords) and
   put it in `WP_APP_PASSWORD`.
5. **Verify** via the `site.capabilities` tool that `can_update_class=true`, the V4 atomic experiment
   is active, and `classes_migrated=true`.

> **Local/dev (plain HTTP):** Application Password Basic auth works over plain HTTP. If the WP admin
> UI refuses to _create_ an App Password on a non-SSL host, the companion plugin enables creation on
> `local` environments only; production keeps HTTPS.

## Multisite / agency fan-out

One server instance can fan out to many sites: hold a config map of `site URL → {url, basicToken}`
and point clients at the per-site credentials. Ship the companion plugin as a network mu-plugin so a
single codebase serves every subsite, each with its own App Password.

## License

GPL-2.0-or-later.
