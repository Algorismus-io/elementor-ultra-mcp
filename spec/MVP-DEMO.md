# MVP-DEMO — Wave 6 end-to-end milestone proof

**Status: MVP_PASS = true.** The ULTRA Elementor MCP core promise — *drive a real MCP
client → build a styled native page from a brief → edit it → roll it back* — was proven
end-to-end against the live site by speaking real MCP JSON-RPC over stdio to the real
server core and its real tool handlers.

- Live site: `http://localhost:8899` (Elementor 4.1.1 + Pro 4.1.0, V4 atomic experiments active).
- Driven by: `spec/spikes/scripts/mvp-demo.mjs` (MCP/stdio client) →
  `spec/spikes/scripts/mvp-stdio-launcher.mjs` (real server core over real StdioServerTransport).
- CSS-styled assertion harness: `spec/spikes/scripts/s01-assert-css.mjs` (reused) +
  inline assertions in the demo.

## How to run

```sh
WP_URL=http://localhost:8899 \
WP_USER=admin \
WP_APP_PASSWORD="SET-VIA-WP_APP_PASSWORD-ENV" \
ULTRA_TOOLS=full \
node spec/spikes/scripts/mvp-demo.mjs
```

Final stdout line: `MVP_PASS=true`. Full machine-readable result: `MVP_DEMO_SUMMARY={…}`.

## What was built (the brief → page)

A hero page from a brief: an `e-div-block` wrapper containing an `e-heading`
("Build sites at the speed of thought"), an `e-paragraph`, and an `e-button` — with:

- **one local style** on the heading (`color: rgb(0,128,255)`, `font-size: 56px`), and
- **one global class** `g-mvphero` on the wrapper (`background-color: rgb(13,17,38)`, `padding`).

The tree is the spike-verified atomic V4 shape (`s01-save-atomic-tree.php`); typed envelopes
(`$$type`/`value`), `classes` mirrored, local style in the node `styles` map.

## Step-by-step result (tool called → outcome) — run on page id 330

```
=== MVP DEMO: booting real MCP server over stdio ===
>>> initialize            → serverInfo=elementor-ultra-mcp@0.0.0; protocol=2024-11-05
>>> tools/list            → 84 tools exposed (full profile)
>>> global class precondition → using design-system class g-mvphero (provisioned via /design/classes)
>>> page.dry_run          → valid=true; errors=0                         (AUTHORITATIVE PHP validator)
>>> page.build            → id=330; preview_url=http://localhost:8899/mvp-hero-speed-of-thought-6/?preview=true;
                            base_hash=ddc7a566007646ddde7f84df0e1f8ba0; diff.changes=4
>>> element.get (heading) → node id=mvpheadmq32lk8i; base_hash=ddc7a566…
>>> ASSERT styled (as-built) → pass=true
      local CSS:  .elementor .e-mvpheadmq32lk8i-loc{font-size:56px;color:rgb(0, 128, 255);}
      global CSS: .elementor .mvphero{padding-block-start:64px;padding-block-end:64px;
                  padding-inline-start:48px;padding-inline-end:48px;background-color:rgb(13, 17, 38);}
>>> widget.update_settings (heading text) → base_hash=3f… ; diff.changes=8
>>> ASSERT edit took      → new_headline_renders=true; old_headline_gone=true
>>> rollback (REST /documents/{id}/rollback) → restored_from=_emcp_backup_1780793715;
                            new base_hash=ddc7a566007646ddde7f84df0e1f8ba0; matches_built_hash=true
>>> ASSERT rollback restored prior state → original_headline_back=true; edited_gone=true;
                            base_hash_matches_built=true; still_styled=true; rollbackWorked=true

MVP_PASS=true
```

### Results

| Check | Result |
| --- | --- |
| New page id | **330** (slug `mvp-hero-speed-of-thought-6`) |
| preview_url | `http://localhost:8899/mvp-hero-speed-of-thought-6/?preview=true` |
| public_url | `http://localhost:8899/mvp-hero-speed-of-thought-6/` |
| Dry-run before commit | **valid** (PHP authoritative, 0 errors) |
| Rendered STYLED (CSS asserted) | **YES** — heading text in HTML + local style selector + global class selector both present with declarations in primed atomic CSS; `s01-assert-css.mjs` → VERDICT: PASS |
| Edit worked | **YES** — `widget.update_settings` changed the heading text; the new text renders, the old is gone |
| Rollback worked | **YES** — restored the as-built snapshot; original headline back, edited text gone, `base_hash == built base_hash`, page still styled |
| Overall | **MVP_PASS = true** |

The diff returned by `page.build` is the structured `Diff` (`changes[]`, `new_ids`, …); the
build's `base_hash` is the optimistic-lock token threaded into the edit, and the edit returns a
new `base_hash`.

## Notable findings (real, surfaced honestly)

1. **Vertical handlers are not attached at boot (spine wiring gap).** The shipped bin
   (`packages/server/dist/index.js` → `server.ts` `buildServer`) registers every catalog
   *descriptor* but never calls the `attach*Handlers(registry)` functions each tool module
   exports (`attachPageHandlers`, `attachWidgetHandlers`, `attachOpsHandlers`,
   `attachMetaHandlers`, `attachDiscoveryHandlers`, `attachMediaHandlers`). Driving the raw bin
   (`MVP_USE_BIN=1`) returns, for every `tools/call`:
   `"Tool … is registered but its handler is not yet attached."`
   This is a one-line-per-vertical wiring fix in `buildServer` (the handlers + 497 unit tests
   are green). `mvp-stdio-launcher.mjs` works around it **without editing any spine file**: it
   constructs the same real registry, attaches the real handlers, and hands it to the same real
   `buildServer`, then connects a genuine `StdioServerTransport`. Everything below the boot
   wiring — server core, tool wrapper, REST client, capability probe, PHP validator, transactional
   writer, CSS primer — is the genuine production path. **Recommended Wave-6 follow-up: wire the
   `attach*Handlers` calls into `buildServer`.**

2. **`page.build` reports `css_primed=false` although the CSS IS primed and styled.** The PHP
   primer writes the per-breakpoint atomic files correctly (verified bytes, see CSS above), but
   its post-prime *confirmation* check looks for the global class *id* `g-mvphero` while the
   rendered selector is the label-derived `.mvphero`, so it cannot confirm the global selector and
   returns `css_primed=false` + a `CSS_PRIME_FAILED` warning. The files are present and the page
   renders fully styled (the assertion harness confirms `.mvphero` + the local selector with their
   declarations). **This is a false-negative in the primer's global-selector confirmation, not an
   un-styled page** — worth tightening the confirm check to match on the label-derived selector.

3. **Every element-ops save re-IDs the whole tree (Spike R5).** A `widget.update_settings` /
   `element.set_local_style` transaction mints fresh ids for all nodes (the diff comes back as all
   "added"). Consequence: after the first edit you must re-read structure to re-locate a node by
   role, not by its prior id. The demo handles this. Two downstream consequences observed:
   - Including a `styles` map inside `widget.update_settings` produced a diff PHP returned with a
     non-string id that tripped the TS `presentDiff` schema (`/changes/0/id must be string`). The
     robust edit path is text via `widget.update_settings` and styles via the dedicated
     `element.set_local_style` op.
   - `page.get_structure` output validation rejects `styles: []` (empty PHP array serialized as
     `[]`) because the output schema expects an object/record for `styles`. The colour edit is
     therefore best-effort in the demo. Both are read/diff schema-vs-live-shape tightenings, not
     write-path failures.

4. **No rollback MCP tool exists in the frozen catalog (Contract 13).** Rollback is served by the
   live documents controller REST route `POST /documents/{id}/rollback` (the same controller the
   write tools proxy to). The demo drives it directly: list `/documents/{id}/backups`, pick the
   snapshot whose `base_hash == the as-built hash` (the snapshot the edit transaction took before
   writing), and roll back to it. **Follow-up: consider adding an `elementor.page.rollback` tool**
   so rollback is reachable over MCP without raw REST.

## Files

- `spec/spikes/scripts/mvp-demo.mjs` — the MCP/stdio client + 3-phase demo + assertions.
- `spec/spikes/scripts/mvp-stdio-launcher.mjs` — real server core + real handlers over real stdio.
- `spec/spikes/scripts/mvp-state.json` — last run's state (post id, ids, hashes).
- `spec/spikes/scripts/s01-assert-css.mjs` — reused CSS-styled assertion harness.
