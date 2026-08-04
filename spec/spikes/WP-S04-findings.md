# WP-S04 — Spike findings: `Document::save_settings()` merge-vs-replace semantics

**Spike:** WP-S04
**Question:** Does `Document::save(['settings'=>…])` / `save_settings()` deep-merge a patch into existing page settings, or REPLACE them wholesale?
**Date:** 2026-06-07
**Target:** http://localhost:8899 — Elementor 4.1.1 + Pro 4.1.0 (Plan B docker-compose stack)
**Meta key under test:** `_elementor_page_settings`

---

## VERDICT

| Method | Semantics |
|---|---|
| `Document::save(['settings'=>…])` → `save_settings()` → `PageManager::save_settings_to_db()` | **REPLACE (wholesale overwrite)** — at top level AND nested. Any key omitted from the patch is WIPED. |
| `Document::update_settings([...])` | **DEEP MERGE** — `array_replace_recursive(existing, patch)` then `save_settings()`. Top-level and nested keys survive; only supplied paths change. |

`confirms_spec = false`. The spec's stated assumption (RESEARCH.md §5.2 note: the built-in `update-page-settings` ability comments "merged" — treated as *unverified*) is **correct in spirit but conflates two different methods**. The merge behavior belongs to `update_settings()`, NOT to the low-level `save()`/`save_settings()` write that `PUT /documents/{id}/settings` would naturally reach for. The default save path REPLACES.

**Bottom line for the plugin: a `PUT /documents/{id}/settings` controller that does a bare `$doc->save(['settings'=>$patch])` WILL silently wipe every unrelated page setting. The route MUST either (a) call `$doc->update_settings($patch)` (which already deep-merges), or (b) implement GET-merge-PUT itself. Option (a) is the canonical, lower-risk choice because Elementor already maintains that merge logic.**

---

## Source-code evidence (the "why")

File: `wp-content/plugins/elementor/core/base/document.php`

- `save( $data )` — line **795**. When `! empty($data['settings'])` it calls `$this->save_settings( $data['settings'] )` at line **852**. It passes the patch straight through; there is NO read-merge of existing meta.
- `update_settings( array $new_settings )` — line **~905**. Body:
  ```php
  $document_settings = $this->get_meta( PageManager::META_KEY );
  if ( ! $document_settings ) { $document_settings = []; }
  $this->save_settings( array_replace_recursive( $document_settings, $new_settings ) );
  ```
  → this is the GET-merge-PUT, **already implemented inside Elementor**, using `array_replace_recursive` (a DEEP merge).
- `save_settings( $settings )` — line **~1809**: `$page_settings_manager->save_settings( $settings, $this->post->ID )`.

File: `wp-content/plugins/elementor/core/settings/base/manager.php`
- `save_settings( array $settings, $id )` — line **168**: strips "special settings", then `save_settings_to_db( $settings_to_save, $id )`. No merge with the DB value.

File: `wp-content/plugins/elementor/core/settings/page/manager.php`
- `const META_KEY = '_elementor_page_settings';` — line **31**.
- `save_settings_to_db( array $settings, $id )` — line **204**:
  ```php
  if ( ! empty( $settings ) ) {
      update_metadata( 'post', $id, self::META_KEY, wp_slash( $settings ) );  // <-- wholesale overwrite (REPLACE)
  } else {
      delete_metadata( 'post', $id, self::META_KEY );                          // <-- empty patch DELETES the meta
  }
  ```
  `update_metadata` replaces the entire serialized meta value; it does not merge.

---

## Empirical evidence

All probe scripts live in `spec/spikes/scripts/`. Run via:
`docker compose -p elementor-mcp -f tools/wp-stack/docker-compose.yml run --rm -v <scripts>:/spikes wpcli wp eval-file /spikes/<file>.php`

### Gotcha discovered during the spike (important for ALL future save-path spikes/tests)
`save()` calls `is_editable_by_current_user()` early and **returns `false` without writing** when there is no logged-in user — which is the default in a bare `wp eval-file` / wp-cli context. In probes v1–v3 this made every `save()` leave the meta empty (`''`), masking the real semantics. The fix is to `wp_set_current_user( <admin id> )` before calling `save()`. This is the same constraint the REST route runs under (it executes as the authenticated user), so it is not a problem for the real PUT route — but **any regression test that exercises `save()`/`update_settings()` directly must set a current user with edit caps**, or the save silently no-ops.

### TEST C (probe v2) — raw write semantics, isolates the DB write from control filtering
Raw-seeded `_elementor_page_settings = {seed_a:1, seed_b:'two', seed_c:{x,y}}`, then called the protected `save_settings(['template'=>'elementor_canvas'])` via reflection:
```
C0 raw-seeded meta:   {seed_a:1, seed_b:'two', seed_c:{x:'X', y:'Y'}}
C1 after save_settings({template}):  ''
C VERDICT: pre-existing 'seed_a' survived save_settings()?  NO (REPLACE)
```
(`template` is a "special setting" handled via `_wp_page_template`, so it is stripped before the DB write → empty array → `delete_metadata`. The point stands: the prior meta was destroyed, not merged.)

### TEST D (probe v2) — `update_settings()` against pre-existing meta
Raw-seeded the same 3 keys, then `update_settings(['seed_b'=>'CHANGED','seed_c'=>['x'=>'NEWX']])`:
```
D0:  {seed_a:1, seed_b:'two', seed_c:{x:'X', y:'Y'}}
D1:  {seed_a:1, seed_b:'CHANGED', seed_c:{x:'NEWX', y:'Y'}}
D VERDICT: 'seed_a' survived?            YES
D VERDICT: nested 'seed_c.y' survived?   YES (deep merge)
D VERDICT: nested 'seed_c.x' == NEWX?    YES
D VERDICT: 'seed_b' == CHANGED?          YES
```
→ `update_settings()` is a confirmed **deep merge** (top-level + nested).

### TEST v4 — the clean, definitive `save()` REPLACE proof (admin user set, real persistable controls)
```
current user = admin ; can unfiltered_html? yes
post_id = 47 ; editable_by_current_user = YES

save() seed returned: true
seed meta:
  { background_background: 'classic',
    background_color: '#333333',
    padding: { unit:'px', top:'10', right:'20', bottom:'30', left:'40', isLinked:false } }

save() patch returned: true   (patch = { background_color: '#444444' } ONLY)
after save({background_color ONLY}):
  { background_color: '#444444' }

VERDICT background_background survived omission?  NO (REPLACE)
VERDICT padding (nested) survived omission?       NO (REPLACE)
VERDICT remaining keys: background_color
```
→ Patching a single key via `save()` **wiped** both the other top-level key (`background_background`) and the nested `padding` map. Unambiguous **REPLACE** at top-level and nested.

---

## Nuances worth recording

1. **Special settings are stripped on every save.** `Base\Manager::save_settings()` removes `get_special_settings_names()` (e.g. `template` → stored as `_wp_page_template`, plus `post_status`, `post_title`, etc.) before writing `_elementor_page_settings`. A patch consisting only of special settings can therefore reduce the saved array to empty → `delete_metadata` deletes the meta. The plugin's update logic must treat special settings as a distinct concern; they are NOT round-tripped through `_elementor_page_settings`.
2. **Empty patch deletes the meta.** `save_settings_to_db` calls `delete_metadata` when the (post-strip) settings array is empty. A naive REPLACE PUT with `{}` would therefore delete all page settings.
3. **`update_settings()` uses `array_replace_recursive`** — a deep merge. Note the standard caveat: `array_replace_recursive` merges associative maps deeply but **does NOT element-merge numerically-indexed arrays** (e.g. repeaters / multi-item lists) — it replaces matching integer indices and keeps extras from the base, which can produce a hybrid for shorter replacement lists. For repeater-style settings (Elementor repeaters are lists of `{_id, ...}` rows) a patch that sends a *shorter* list will leave stale trailing rows from the base. This is the one place where even `update_settings()` does not behave like a clean "replace this whole list" — callers wanting to replace a repeater wholesale must send the full intended list, and the plugin should document this.
4. **`is_editable_by_current_user()` gate** (see gotcha above) — affects test harness setup, not production.

---

## Impact on dependent WPs

- **`page.update_settings` tool / `PUT /documents/{id}/settings` controller (Documents controller WP, WP-P##):**
  - **DO NOT** implement the route as a bare `$doc->save(['settings'=>$patch])` — that REPLACES and silently wipes unrelated settings.
  - **Recommended implementation:** call `$doc->update_settings($patch)`. Elementor's own method already performs the GET-merge-PUT (deep `array_replace_recursive`) and keeps the special-setting handling correct. This is preferable to re-implementing the merge in the plugin.
  - If for any reason the controller must build the payload itself (e.g. to control repeater replacement semantics or to validate), it MUST do explicit GET-merge-PUT: read current `_elementor_page_settings` (via `$doc->get_settings()` / `get_meta(META_KEY)`), deep-merge the patch, then save — exactly mirroring `update_settings()`.
  - **Special-settings caveat:** route validation should be aware that `template`, `post_status`, `post_title`, etc. are special and not stored in `_elementor_page_settings`; passing them through `save_settings` strips them. Round-trip behavior for these differs from ordinary controls.
  - **Empty/whole-replace caveat:** never PUT `{}` expecting a no-op; an empty settings array deletes the meta. A semantic "clear all settings" must be an explicit, separate operation.

- **Mandatory regression test for the route WP (specified here, implemented by the controller WP):**
  1. Seed a page via the route/`update_settings` with ≥3 settings of different types, including one nested map (e.g. `background_color`, `background_background`, and a nested `padding` object).
  2. PUT a patch that updates exactly ONE top-level key and ONE nested sub-key, omitting the others.
  3. Assert: the omitted top-level key still present and unchanged; the omitted nested sibling (e.g. `padding.left`) still present and unchanged; the patched keys updated. (i.e., partial update must NOT wipe unrelated keys — guards against accidental use of bare `save()`.)
  4. Test-harness note: the test must run as a user with edit caps (`wp_set_current_user`) or `save()`/`update_settings()` will no-op via `is_editable_by_current_user()`.
  5. (Recommended) A repeater-specific assertion: seed a 2-row repeater, patch unrelated key, assert both rows survive; document the `array_replace_recursive` shorter-list caveat.

- **Spike gate S4 status:** **PASS** — definitive verdict recorded. `page.update_settings` can be finalized using `Document::update_settings()` (deep-merge) as the implementation, with the regression test above as the gate.

---

## Files

- `spec/spikes/scripts/s04-probe-merge.php` — v1 (initial; uncovered the CLI no-user gotcha)
- `spec/spikes/scripts/s04-probe-merge2.php` — v2 (reflection raw-write TEST C + update_settings TEST D)
- `spec/spikes/scripts/s04-probe-merge3.php` — v3 (real persistable controls; still hit the no-user gate)
- `spec/spikes/scripts/s04-probe-merge4.php` — v4 (admin user set; the clean definitive REPLACE proof)
