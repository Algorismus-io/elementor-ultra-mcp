# Release runbook

How to cut a release of the two distributable artifacts:

1. **`@youragency/elementor-ultra-mcp`** — the `npx`-distributable TypeScript MCP server tarball.
2. **`elementor-ultra-mcp.zip`** — the installable companion WordPress plugin (also droppable as a
   network mu-plugin).

The pipeline is **dry-run by default**: a tag push (or a `workflow_dispatch` without `publish: true`)
builds + verifies the artifacts but **never publishes**. Publishing is an explicit, opt-in step.

Owned by WP-Q08. The CI workflow that invokes these scripts is `.github/workflows/release.yml`
(WP-F07). The MCP SDK 2.x guard (`scripts/ci/check-sdk-version.mjs`, WP-F07) runs as a release gate.

---

## The packaging scripts (WP-Q08)

| Script               | Command               | What it does                                                                                                                                                                                                             |
| -------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pack-server.mjs`    | `pnpm pack:server`    | Builds, stages a publish-ready copy (publish name, bundled `@elementor-ultra/shared`), and `npm pack`s the npx tarball. Asserts the bin shebang + `@modelcontextprotocol/sdk@^1.29` pin.                                 |
| `pack-plugin.mjs`    | `pnpm pack:plugin`    | `composer install --no-dev` (Jetpack autoloader), prunes via `.distignore`, zips to `elementor-ultra-mcp.zip` (installable plugin + mu-plugin layout).                                                                   |
| `verify-package.mjs` | `pnpm verify:package` | Installs the packed tarball into a temp dir and runs the bin (clean startup/exit with & without env); validates the plugin-zip structure (bootstrap header, `Requires Plugins`, activation hook). Re-runs the SDK guard. |
| `bump-version.mjs`   | `pnpm bump <kind>`    | Bumps the server + plugin versions in lockstep (5 sites) and rolls `CHANGELOG.md`.                                                                                                                                       |

---

## Release flow

### 1. Bump the version (lockstep)

```bash
pnpm bump patch          # or: minor | major | <explicit x.y.z>
pnpm bump --check        # assert all five version sites are aligned
```

`pnpm bump` updates, in lockstep:

- `packages/server/package.json` `version`
- `package.json` (repo root) `version`
- `plugin/elementor-ultra-mcp/elementor-ultra-mcp.php` `Version:` header **and** `EMCP_VERSION`
- `plugin/elementor-ultra-mcp/readme.txt` `Stable tag:`
- `CHANGELOG.md` (rolls `[Unreleased]` into a dated release section)

Edit the rolled `CHANGELOG.md` release section so it reads cleanly, then commit:

```bash
git commit -am "chore(release): vX.Y.Z"
```

### 2. Verify locally (optional but recommended)

```bash
pnpm verify:package      # packs both artifacts + runs the full verification
```

### 3. Tag → CI builds + verifies (dry-run)

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag push triggers `release.yml`, which:

1. runs the **SDK 2.x release gate** (`check-sdk-version.mjs`),
2. `pnpm build`,
3. `pnpm pack:server` + `pnpm pack:plugin`,
4. (recommended) `pnpm verify:package`,
5. uploads the tarball + zip as build artifacts.

**It stops here** — nothing is published on a tag push.

### 4. Publish (explicit, opt-in)

Trigger the workflow manually with `publish: true` (Actions → release → Run workflow), which performs:

- `npm publish` of the server tarball (uses `NPM_TOKEN`), and
- a GitHub Release attaching `elementor-ultra-mcp.zip`.

Confirm afterwards:

```bash
npx -y @youragency/elementor-ultra-mcp   # prints the missing-env notice and exits 0
```

---

## Notes

- **No 2.x MCP SDK, ever.** The pin is locked at `@modelcontextprotocol/sdk@^1.29`; the guard fails
  the release on any `@modelcontextprotocol` 2.x in the lockfile (`15-engineering-standards.md §7`).
- **The plugin zip is the companion only** — it does not bundle Elementor or Elementor Pro. Those are
  installed separately on each target site.
- **The packaging logic is stable across phases.** Only the packaged _content_ grows as verticals
  land; the scripts do not change.
