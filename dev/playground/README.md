# Docker-free local dev site (WordPress Playground)

When Docker isn't available, this stands up a full local WordPress + Elementor (free) + the
companion plugin with **no Docker, no PHP, no MySQL** — just Node. It runs WordPress compiled to
PHP-WASM (WordPress Playground).

```
node dev/playground/setup-playground.mjs
```

First run installs the Playground CLI (into this folder only, never the workspace), provisions the
site, and prints `WP_URL` / `WP_USER` / `WP_APP_PASSWORD`. It handles the things that otherwise bite:

- pretty permalinks (else `/wp-json/*` 301s to HTML)
- `WP_ENVIRONMENT_TYPE=local` **baked into wp-config.php** (else app-password auth 401s over plain HTTP,
  and it silently vanishes on restart if only set at runtime)
- admin user context before Elementor's Kits Manager runs (else provisioning fatals "Access denied")
- app-password minting, V4 atomic experiments

The site persists to `dev/playground/.wordpress`, so pages + credentials survive restarts. Re-run to
reboot; delete that folder to reset. `ULTRA_PORT=8901 node dev/playground/setup-playground.mjs` to
change the port. Leave the process running while you work.

Deploying to it needs no wp-cli — `exjsx` ≥ 1.1.2 detects the Elementor version over REST.
