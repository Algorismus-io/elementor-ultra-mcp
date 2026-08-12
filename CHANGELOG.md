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

- Plugin: COMPONENTS REST controller (SPEC 2.0 "ultra-mcp plugin extension") —
  `GET/POST elementor-ultra/v1/components` + `PUT elementor-ultra/v1/components/{id}/elements`.
  The free-tier create path (native `elementor/v1/components` POST requires an ACTIVE Pro
  license) and the missing update-elements route, both driving Elementor's own
  `Components_Repository` behind `manage_options`. Validation is NATIVE-CLASS reuse
  (`Save_Components_Validator`, `Circular_Dependency_Validator`, `Non_Atomic_Widget_Validator`,
  `Component_Overridable_Props_Parser`) with Elementor's verbatim 422 codes
  (`components_validation_failed`, `circular_dependency_detected`,
  `non_atomic_element_in_component`, `settings_validation_failed`) so behavior cannot drift from
  native. Updates write via the component document's own `save()` with `post_status: publish`
  (the native publish flow's write shape); the overridable-props registry is written via
  `Component::update_overridable_props()` directly, dodging the after_save hook's Pro re-gate.
  Guard rail: 501 `EXPERIMENT_INACTIVE` naming `e_components` + `e_atomic_elements` when the
  module is unavailable.
- Fixtures: golden trees for the components wire shapes — `e-component.instance`
  (component-instance envelope, schema_source.id ≡ component_id), `e-component.instance.chain`
  (the prop-forwarding overridable-wrapping-override chain envelope), and
  `e-component.overridable-setting` (the universal overridable settings union on a definition
  tree); `e-component` added to the authoring `element-node.schema.json` widget enum; the
  harness "full install" capability snapshot now includes `e_components` @ 4.2.1.

## [1.0.1] - 2026-08-11

### Added

- Release packaging (WP-Q08): `pnpm pack:server` (npx tarball), `pnpm pack:plugin`
  (`elementor-ultra-mcp.zip`), `pnpm verify:package` (packed-artifact verification), and `pnpm bump`
  (lockstep version bump). Release runbook in `RELEASE.md`; npx user docs in
  `packages/server/README.md`.
