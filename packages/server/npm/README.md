# @algorismus/elementor-ultra-mcp

MCP server that gives AI agents ~90 tools to build and govern real Elementor sites — read, build and
refactor pages, HTML→Elementor conversion, the design system, Pro widgets — with authoritative
server-side validation, backups and rollback on every write.

Requires the companion WordPress plugin (`elementor-ultra-mcp.zip`, in the repo releases) and a
WordPress application password.

## Run

```jsonc
// in your MCP client config (Claude Desktop/Code, Cursor, Windsurf, VS Code)
{
  "mcpServers": {
    "elementor-ultra": {
      "command": "npx",
      "args": ["-y", "@algorismus/elementor-ultra-mcp"],
      "env": {
        "WP_URL": "https://your-site.com",
        "WP_USER": "admin",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx",
        "ULTRA_TOOLS": "full"
      }
    }
  }
}
```

Or run the one-command installer: `npx @algorismus/create-elementor-ultra`.

Full docs, source, and the companion plugin: https://github.com/Algorismus-io/elementor-ultra-mcp

MIT © Algorismus. `playwright` is an optional dependency — only the browser-based convert tools need it.
