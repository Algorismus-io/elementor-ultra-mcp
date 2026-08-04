# MCP Inspector smoke payloads — INDEX

WP-Q03 — the minimal valid smoke payload per **lean ★ tool** for the MCP Inspector smoke suite
(`spec/contracts/14-fixtures-harness.md §8`; tool catalog `spec/contracts/13-tool-catalog.md §5.2`).

Each `smoke.<full.tool.name>.json` is a `kind:"smoke"` fixture envelope (`14-fixtures-harness.md §2`)
carrying `{tool, arguments}` — the minimal valid input for the named lean ★ tool. The suite
(`packages/server/src/test-harness/smoke.test.ts`, driver `smoke-driver.ts`) launches the built server
over stdio with `ULTRA_TOOLS=lean` + App-Password env (`§5.4`), calls each ★ tool with its payload, and
asserts **no protocol error (`-326xx`)** + an `outputSchema`-conformant result (`§8`).

## Ownership

- **WP-Q03 owns 16** of the 18 lean ★ smoke payloads (the rows below marked `Q03`).
- **WP-H12 owns 2** — `smoke.elementor.convert.html_to_tree.json` + `smoke.elementor.convert.html_to_page.json`
  (the HTML-corpus WP) — listed here for completeness; this suite CONSUMES them.
- The smoke-suite frozen expectation constants (`LEAN_STAR_TOOLS`/`META_TOOLS`/`RESOURCE_URIS`/`PROMPT_NAMES`)
  - the `inspector-smoke.ts` skeleton are **WP-F06**'s; Q03 reuses them and never edits them.

## Classification (read-only vs mutating)

- **read-only** — runs unconditionally (modulo capability gate); never persists.
- **mutating (draft)** — targets the shared **disposable draft** (created in setup, trashed in teardown);
  uses `{{DRAFT_*}}` tokens the driver substitutes with the live draft id / container id / element id /
  fresh `base_hash` (re-read after setup — never cached, S02/R5).
- **mutating (self-contained)** — creates its own throwaway doc / library item; the driver trashes it in
  teardown. Never touches a real page.

| # (§5.2) | Tool                               | Payload file                                  | Class | Smoke type                                           | Capability gate (`requires` / driver)                         | Owner  |
| -------- | ---------------------------------- | --------------------------------------------- | ----- | ---------------------------------------------------- | ------------------------------------------------------------- | ------ |
| 1        | `elementor.tools.search`           | `smoke.elementor.tools.search.json`           | R     | read-only                                            | none                                                          | Q03    |
| 2        | `elementor.site.capabilities`      | `smoke.elementor.site.capabilities.json`      | R     | read-only                                            | none (the probe itself)                                       | Q03    |
| 3        | `elementor.pages.list`             | `smoke.elementor.pages.list.json`             | R     | read-only                                            | none                                                          | Q03    |
| 4        | `elementor.page.get_structure`     | `smoke.elementor.page.get_structure.json`     | R     | read-only (reads disposable draft)                   | none (uses `{{DRAFT_POST_ID}}`)                               | Q03    |
| 5        | `elementor.page.create`            | `smoke.elementor.page.create.json`            | M     | mutating (self-contained)                            | none                                                          | Q03    |
| 6        | `elementor.page.build`             | `smoke.elementor.page.build.json`             | M     | mutating (self-contained)                            | `e_atomic_elements`                                           | Q03    |
| 7        | `elementor.page.dry_run`           | `smoke.elementor.page.dry_run.json`           | R     | read-only (no persistence)                           | `e_atomic_elements`                                           | Q03    |
| 8        | `elementor.schema.widget`          | `smoke.elementor.schema.widget.json`          | R     | read-only                                            | `e_atomic_elements`                                           | Q03    |
| 9        | `elementor.schema.styles`          | `smoke.elementor.schema.styles.json`          | R     | read-only                                            | `e_atomic_elements`                                           | Q03    |
| 10       | `elementor.breakpoints.get`        | `smoke.elementor.breakpoints.get.json`        | R     | read-only                                            | none                                                          | Q03    |
| 11       | `elementor.widget.insert`          | `smoke.elementor.widget.insert.json`          | M     | mutating (draft)                                     | `e_atomic_elements`; `{{DRAFT_POST_ID/PARENT_ID/BASE_HASH}}`  | Q03    |
| 12       | `elementor.widget.update_settings` | `smoke.elementor.widget.update_settings.json` | M     | mutating (draft)                                     | `e_atomic_elements`; `{{DRAFT_POST_ID/ELEMENT_ID/BASE_HASH}}` | Q03    |
| 13       | `elementor.design.classes.list`    | `smoke.elementor.design.classes.list.json`    | R     | read-only                                            | `e_classes`                                                   | Q03    |
| 14       | `elementor.design.classes.upsert`  | `smoke.elementor.design.classes.upsert.json`  | M     | mutating (design system)                             | `e_classes` + `UPDATE_CLASS` cap (S05)                        | Q03    |
| 15       | `elementor.design.variables.list`  | `smoke.elementor.design.variables.list.json`  | R     | read-only                                            | `e_variables`                                                 | Q03    |
| 16       | `elementor.media.sideload_url`     | `smoke.elementor.media.sideload_url.json`     | M     | mutating (self-contained)                            | none                                                          | Q03    |
| 17       | `elementor.convert.html_to_tree`   | `smoke.elementor.convert.html_to_tree.json`   | R     | read-only                                            | `e_atomic_elements`                                           | WP-H12 |
| 18       | `elementor.convert.html_to_page`   | `smoke.elementor.convert.html_to_page.json`   | M     | read-only here (`commit:false` — never auto-commits) | `e_atomic_elements`                                           | WP-H12 |

18 payloads total = the 18 lean ★ tools (`13-tool-catalog.md §5.2`). The always-available meta-trio
(`tools.list_endpoints`/`tools.get_schema`/`tools.invoke`) is enabled in both profiles and asserted
present by name in `tools/list`, but has no per-tool smoke payload (they are TS dispatch wrappers, not a
distinct surface under §8(b)).

## Grow-green

The server core (WP-T01) boots a populated registry, but proxied/orchestration HANDLERS land with later
verticals (WP-T##/H##/R##). Until a tool's handler is attached — or the App-Password env / built bin /
live REST routes are present — each live check **SKIPs** with a clear reason (handler-not-attached
sentinel, capability gate, missing env). The suite is green from MVP; the final DoD requires all 18 live.

## Tokens (disposable-draft injection)

| Token                  | Substituted with                                                     |
| ---------------------- | -------------------------------------------------------------------- |
| `{{DRAFT_POST_ID}}`    | the live disposable-draft document id                                |
| `{{DRAFT_PARENT_ID}}`  | the draft's root container id (`widget.insert` parent)               |
| `{{DRAFT_ELEMENT_ID}}` | an existing widget id in the draft (`widget.update_settings` target) |
| `{{DRAFT_BASE_HASH}}`  | the fresh `base_hash` re-read after setup (never cached)             |
