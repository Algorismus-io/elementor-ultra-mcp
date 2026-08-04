# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog tracks both distributable artifacts, which version in lockstep (see `RELEASE.md`):

- `@youragency/elementor-ultra-mcp` — the npx MCP server, and
- `elementor-ultra-mcp.zip` — the companion WordPress plugin.

`pnpm bump` rolls the `[Unreleased]` section below into a dated release entry.

## [Unreleased]

### Added

- Release packaging (WP-Q08): `pnpm pack:server` (npx tarball), `pnpm pack:plugin`
  (`elementor-ultra-mcp.zip`), `pnpm verify:package` (packed-artifact verification), and `pnpm bump`
  (lockstep version bump). Release runbook in `RELEASE.md`; npx user docs in
  `packages/server/README.md`.
