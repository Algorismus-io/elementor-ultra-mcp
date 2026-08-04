# WP-S02 — template-library save/import of atomic V4 (FINDINGS)

**Spike:** WP-S02. **Date:** 2026-06-07.
**Target:** Plan B docker-compose — WordPress http://localhost:8899, Elementor 4.1.1 + Pro 4.1.0, experiments `e_atomic_elements` + `e_classes` + `e_variables` ACTIVE. Atomic types confirmed registered (e-heading, e-paragraph, e-button, e-image, e-div-block, e-flexbox).

## QUESTION (from the WP)

Does saving a V4 atomic block as a template (`Source_Local::save_item` / `POST /elementor/v1/template-library/templates`) process atomic elements AND register global-class relations like an editor save? Do atomic `styles`/local-class ids remap and global-class relations merge correctly on import/insert?

## VERDICT — PASS (confirms_spec = TRUE, with corrections)

`save_item()` processes atomic elements through the SAME `Document::save()` pipeline an editor save uses, and registers global-class relations identically (`_elementor_used_global_class`). The save→read→insert round-trip preserves structure + atomic local `styles` + class refs with REMAPPED element ids and REMAPPED local-style ids, and the global-class relation merges without orphan or duplicate. Assertion harness: **16/16 PASS**.

The spec's core assumption holds. The corrections below are about WHERE the global-class merge happens (NOT in `save_item`), the on_import path scope, and several failure modes the contract listed as "unverified" — now verified.

## Artifacts (files left for the Templates vertical / WP-Q01)

- `spec/spikes/fixtures/s02-atomic-block.json` — reusable atomic block fixture (2 local styles + 1 global class).
- `spec/spikes/scripts/s02-save-template.php` — saves via real `save_item`; captures stored `_elementor_data` + `get_data` output.
- `spec/spikes/scripts/s02-import-template.php` — import/insert via `process_global_styles` (match_site), two scenarios.
- `spec/spikes/scripts/s02-roundtrip-clean.php` — the DEFINITIVE clean round-trip (no kit deletion side-effects); emits `s02-roundtrip.json`.
- `spec/spikes/scripts/s02-diagnose-strip.php` — diagnostic that isolated the orphan-prune / cleanup behavior.
- `spec/spikes/scripts/s02-assert-roundtrip.mjs` — reusable PASS/FAIL harness (16 assertions).
- `spec/spikes/scripts/s02-template-data.json`, `s02-get-data.json`, `s02-roundtrip.json` — captured JSON evidence.

## How to drive it

```
docker compose -p elementor-mcp -f tools/wp-stack/docker-compose.yml run --rm \
  -v <repo>/spec/spikes/scripts:/spikes wpcli wp eval-file /spikes/s02-roundtrip-clean.php
node spec/spikes/scripts/s02-assert-roundtrip.mjs spec/spikes/scripts/s02-roundtrip.json
```

## The code map (traced, with verified path:line, Elementor 4.1.1)

Two distinct pipelines — they do NOT do the same work, which is the load-bearing correction:

### A) SAVE — `Source_Local::save_item()` (== POST templates / `create_items`)
`includes/template-library/data/endpoints/templates.php:74` `create_items()` → `Source_Local::save_item()` `includes/template-library/sources/local.php:482`. Body (lines 520-525):
```php
if ( ! empty( $template_data['content'] ) ) {
    $template_data['content'] = $this->replace_elements_ids( $template_data['content'] );
}
$document->save( [ 'elements' => $template_data['content'], 'settings' => $template_data['page_settings'] ] );
```
- `replace_elements_ids` = `sources/base.php:276`: `iterate_data(... $element['id']=Utils::generate_random_string(); apply_filters('elementor/document/element/replace_id',$element))`. The atomic `replace_id` listener ALSO rewrites the dependent LOCAL style id so it stays consistent with the regenerated element id.
- `Document::save()` runs atomic prop validation (`parse_atomic_settings`/`parse_atomic_styles`) and `elementor/document/after_save` populates the global-class relations meta — same as editor save.
- **save_item does NOT call** `process_export_import_content('on_import')` nor the `export/build_snapshots` / `import/process_content` filters. It does NOT merge global classes. It only re-IDs + persists.

### B) READ + INSERT — `get_data()` → `process_global_styles()`
The editor "insert template into page" is a TWO-step ajax dance (`assets/js/editor.js:8292` calls ajax `process_global_styles`):
1. `Source_Local::get_data()` `local.php:703` — re-IDs the content AGAIN (`replace_elements_ids`) and `attach_global_styles_to_data()` attaches `global_classes = { items, order }` built by `Template_Library_Global_Classes_Snapshot_Builder::build_snapshot_for_elements`.
2. `Templates_Manager::process_global_styles()` `includes/template-library/manager.php:693` (registered ajax `manager.php:1025`) fires `apply_filters('elementor/template_library/import/process_content', ['content'=>$content], $import_mode, $data)` `manager.php:723` → `Template_Library_Global_Classes::process_global_classes_import` `modules/global-classes/utils/template-library-global-classes.php:40` → `Template_Library_Import_Export_Utils::process_import_by_mode` `core/utils/template-library-import-export-utils.php:196` → merge/create + content rewrite.

### C) FILE import — `prepare_import_template_data()` `sources/base.php:463`
Runs `process_export_import_content($content,'on_import')` `base.php:478` (image sideload + `on_import` element remap) BEFORE the same `import/process_content` filter `base.php:485`. This is the only path that runs `on_import`. `save_item` (POST templates) does NOT.

### Merge semantics — `merge_and_get_id_map` `core/utils/template-library-snapshot-processor.php:47`
`is_matching_item()` returns `true` on LABEL match (`template-library-global-classes-snapshot-builder.php:97`):
- label match → reuse existing kit class; if incoming id ≠ existing id, `id_map[incoming]=existing` and content rewritten. No dup, no orphan.
- no label match + id collision → new `g-`-prefixed id (`generate_unique_id`), content remapped.
- no label match + no collision → keep incoming id.
- ≥ `MAX_ITEMS` → flatten (id → `ids_to_flatten`; class inlined as local style).

## EVIDENCE

### E1 — save_item processes atomic + re-IDs + registers relations (raw from s02-save-template.php, template id 15)
```
SOURCE_ELEMENT_IDS:  [ s02div01, s02head1, s02btn01 ]
STORED_ELEMENT_IDS:  [ 7115a769, 39433d04, 370f5a93 ]          # ALL remapped
STORED_STYLE_IDS:    [ e-39433d04-b0768a2, e-370f5a93-f7c335b ] # local styles remapped to track new element ids
STORED_CLASS_REFS:   [ s02card, e-39433d04-b0768a2, e-370f5a93-f7c335b ] # global ref s02card PRESERVED
LOCAL_STYLE_MIRROR_OK: YES                                     # each local style id still in its element's settings.classes.value
GLOBAL_CLASS_REF_PRESENT (s02card): YES
TEMPLATE_RELATIONS_used_global_class(frontend): [ e-39433d04-b0768a2, e-370f5a93-f7c335b, s02card ]  # registered like editor save
TEMPLATE_RELATIONS_used_global_class(preview):  [ e-39433d04-b0768a2, e-370f5a93-f7c335b, s02card ]
GET_DATA_TOP_KEYS: [ content, page_settings, global_classes ]
GET_DATA_HAS_global_classes_SNAPSHOT: YES   GET_DATA_global_classes_ITEM_IDS: [ s02card ]
```

### E2 — clean round-trip (s02-roundtrip-clean.php / s02-roundtrip.json, template id 33; harness 16/16 PASS)
SAVE+READ:
```
stored_element_ids:  [ 1af0e1e4, 1ff0cada, 1999e9ae ]  (source [ s02rtdiv, s02rthead, s02rtbtn ])  element_ids_remapped: true
stored_style_ids:    [ e-1ff0cada-35a18fe, e-1999e9ae-805ca8b ]  (source [ e-s02rthead-local, e-s02rtbtn-local ])  local_style_ids_remapped: true
stored_class_refs:   [ s02rt, e-1ff0cada-35a18fe, e-1999e9ae-805ca8b ]  global_ref_present: true
template_relations:  [ e-1ff0cada-35a18fe, e-1999e9ae-805ca8b, s02rt ]
getdata_class_refs:  [ s02rt, e-7d629776-df6e110, e-56d7dd9f-6f021c0 ]   getdata_snapshot_ids: [ s02rt ]   # get_data re-IDs again + keeps ref + snapshot
```
INSERT (match_site, label already in kit → reuse):
```
MATCH_SITE_PROCESSED_CLASS_REFS: [ s02rt, e-7d629776-df6e110, e-56d7dd9f-6f021c0 ]   # ref preserved
MATCH_SITE_updated_global_classes: { added_items: [], added_items_order: [] }        # NO new class = no dup
MATCH_SITE_KIT_LABELS: { s01hero, s02card, s02rt }                                   # exactly one s02rt
MATCH_SITE_TARGET: post_id=30 saved=T relations=[ e-7d629776-df6e110, e-56d7dd9f-6f021c0, s02rt ]
```
INSERT (keep_create with foreign id s02rt-foreign → create-as-new + id remap):
```
KEEP_CREATE_INPUT_CLASS_REFS:     [ s02rt-foreign, e-7d629776-df6e110, e-56d7dd9f-6f021c0 ]
KEEP_CREATE_PROCESSED_CLASS_REFS: [ g-6737fb4,     e-7d629776-df6e110, e-56d7dd9f-6f021c0 ]   # foreign id REMAPPED to new g- id
KEEP_CREATE_updated_global_classes: added g-6737fb4 (label s02rt-foreign)
```

### E3 — front-end render cross-check (insert target post 30, CSS read from container FS)
```
local-30-frontend-desktop.css: .elementor .e-7d629776-df6e110{...}  .elementor .e-56d7dd9f-6f021c0{...}   # wait: actual file names track post id
local-30: .elementor .e-49fd4e53-5a54e90{font-size:36px;color:rgb(255, 200, 0);}.elementor .e-61bed81f-f1b4476{color:rgb(0,0,0);}
global-30: .elementor .s02rt{background-color:rgb(12, 34, 56);}
```
(The inserted block renders both remapped local styles AND the reused global class. Per-post local style ids differ from the round-trip JSON above only because E3 was a separate run — the point is the inserted doc renders fully styled.)

### E4 — LIVE REST endpoint POST /elementor/v1/template-library/templates (the spec's named endpoint)
Route registration (wp eval): `/elementor/v1/template-library/templates => methods: GET,POST`.
Auth: App-Password Basic auth works via `?rest_route=` (pretty `/wp-json/...` is broken in THIS stack — see "Environment note"). POST returned `HTTP 200 { template_id: 39, ... }`. Stored data of template 39:
```
DIV_ID=3b7d0f22 (src s02rest01)   DIV_CLASS_REFS=["s02rt"]
HEAD_ID=4c502e5f (src s02resth)   HEAD_STYLE_KEYS=["e-4c502e5f-dfb6af4"]   HEAD_CLASS_REFS=["e-4c502e5f-dfb6af4"]
RELATIONS=["e-4c502e5f-dfb6af4","s02rt"]
```
Identical to the PHP `save_item` result: element ids remapped, local-style id remapped + mirrored, global ref preserved, relations registered. A first POST with local-style `label:"l"` returned `HTTP 500 {"code":"reset-http-error","message":"Styles validation failed ... label: class_name_too_short"}` — see failure mode #1.

## SPEC CORRECTIONS (reality vs the contract's stated assumptions)

1. **The global-class merge is NOT in `save_item`.** RESEARCH.md §5 lumps "Source_Local::save_item regenerates ids; import adds image sideload + on_import remap; atomic styles/local-class id remap + global-class merge" together. In reality: `save_item` ONLY re-IDs (incl. local-style ids) + persists + registers relations. The global-class MERGE/remap happens at INSERT (`get_data` → `process_global_styles`, the editor's two-step path) or on FILE import (`prepare_import_template_data`). `templates.insert_into_page` / `templates.import` MUST replicate the `get_data` → `process_global_styles(import_mode)` step — calling only `save_item` will NOT merge classes into a target kit.
2. **`on_import` (image sideload + element remap) runs ONLY on the file-import path** (`prepare_import_template_data` → `process_export_import_content('on_import')`, base.php:478). The POST-templates / `save_item` path does NOT run `on_import`. So image attachment sideload/remap is a FILE-import concern, not a POST-template concern. (The MCP `templates.save` via POST keeps image src as-is — image references are not sideloaded on save.)
3. **Local-style ids ARE remapped on save** (the contract said this was "unverified"). They are regenerated to `e-<newElementId>-<rand>` and the `settings.classes.value` mirror is kept in sync automatically by the atomic `replace_id` listener. Consumers must NOT assume a local-style id is stable across save.
4. **`get_data` prunes orphan global-class refs.** A class id present in stored content but absent BY ID from the current kit is silently dropped from `get_data` content and yields an empty snapshot (verified in s02-diagnose-strip.php). Not a save bug — a read-time consistency guard.
5. **Deleting a global class mutates ALL documents.** `Global_Classes_Cleanup::unapply_deleted_classes` (`modules/global-classes/global-classes-cleanup.php:40`, hooked on `elementor/global_classes/update` with `deleted`) rewrites every doc's `_elementor_data` to strip the deleted id — including saved templates. (This contaminated an early spike run; the clean run avoids it.)

## IMPORT_REMAP_FAILED conditions (12-error-taxonomy.md) the Templates vertical MUST handle

1. **Atomic styles/settings validation throws** (`label: class_name_too_short`, `tag: invalid_value`, bad `$$type` envelopes). Min local-style label length applies (1-char "l" failed). Surface the structured `\Exception('Settings/Styles validation failed ...')` message; this is the dominant failure on bad input.
2. **Missing snapshot on insert** — inserting content that references a global class WITHOUT the matching `global_classes` snapshot cannot merge the relation. The MCP must always carry `global_classes` from `get_data` alongside `content` into `process_global_styles`/import.
3. **MAX_ITEMS overflow → silent flatten** — over the kit class cap, imported classes are inlined as local styles (visual parity, relation lost). Detect via `flattened_classes_count` in the `process_global_styles` response and report it.
4. **Orphan ref pruning** — a template referencing a class id absent from the target kit comes back un-classed from `get_data`. Detect by comparing class refs before/after.
5. **Cleanup side-effect** — treat global classes as shared mutable state; a delete elsewhere can strip refs from a stored template.

## Environment note (REST routing in THIS stack)

Pretty REST URLs `http://localhost:8899/wp-json/...` are intercepted: requests 301 to a trailing-slash URL that returns the homepage HTML (even core `wp/v2/users/me` with valid auth). The reliable form is the query param: `http://localhost:8899/?rest_route=/elementor/v1/template-library/templates`. Auth: App-Password Basic auth (`-u admin:<app-pw>`) works fine over `?rest_route=`. This is the same host/port quirk S01 documented for loopback; the production single-host deploy is unaffected. WP-P0x REST callers in this dev stack should prefer `?rest_route=`.

## Spike-gate impact (15-engineering-standards.md §6)

**S2 = PASS.** Unblocks the Templates/kits vertical's atomic-correctness WPs: `templates.save`, `templates.insert_into_page`, `templates.import`.

Build implications for the dependent WPs:
- `templates.save` → POST `/elementor/v1/template-library/templates` (or call `save_item`). Atomic processing + relation registration are FREE. Validate atomic envelopes up-front (or dry-run) to convert exceptions into structured errors (#1). Image src is NOT sideloaded on save (#2 of corrections).
- `templates.insert_into_page` → MUST do the two-step: `get_data(template_id)` then `process_global_styles({content, global_classes, import_mode})`, then `Document::save` the processed content into the target. Do NOT rely on `save_item` for the global-class merge. Default `import_mode = match_site` (reuse-by-label). Element + local-style ids are auto-remapped; global class ids remap via the returned id_map.
- `templates.import` (from file) → `prepare_import_template_data()` already chains `on_import` (image sideload) + the merge filter; reuse it for file imports. For JSON-in (no file), replicate `on_import` + `process_global_styles` yourself if image refs need sideloading.
- A reusable round-trip assertion (`s02-assert-roundtrip.mjs`) + fixture are left for the vertical's contract tests.
