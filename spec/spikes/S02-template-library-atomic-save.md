# S02 — template-library save/import of atomic V4 (PASS)

**Verdict:** PASS. `Source_Local::save_item()` (== `POST /elementor/v1/template-library/templates` → `Endpoints\Templates::create_items()`) DOES process V4 atomic elements through the full `Document::save()` pipeline AND registers global-class relations exactly like an editor save. Atomic local `styles` survive; local-style ids remap to track the regenerated element ids; the global-class reference survives. Import/insert (`Templates_Manager::process_global_styles` == `elementor/template_library/import/process_content`) merges global classes without orphan or duplicate and remaps class ids via an id_map.

## Remap entry points (verified `path:line`, Elementor 4.1.1)

- **Save id remap:** `includes/template-library/sources/local.php:520` — `save_item()` calls `replace_elements_ids($content)` then `$document->save()`. `replace_elements_ids` = `includes/template-library/sources/base.php:276` → `Plugin::$instance->db->iterate_data(... fn => $element['id']=Utils::generate_random_string(); apply_filters('elementor/document/element/replace_id', ...))`. The atomic `replace_id` listener also rewrites the dependent LOCAL style id so it stays consistent with the new element id.
- **Relations registration (== editor):** `elementor/document/after_save` populates `_elementor_used_global_class[ _preview ]` from the saved tree (`Global_Classes_Relations`). save_item gets this for free because it uses `Document::save()`.
- **Export snapshot (file/cloud):** `includes/template-library/sources/base.php:558` filter `elementor/template_library/export/build_snapshots` → `Template_Library_Global_Classes::add_global_classes_snapshot` (`modules/global-classes/utils/template-library-global-classes.php:13`) → `Template_Library_Global_Classes_Snapshot_Builder::build_snapshot_for_elements`.
- **Read snapshot (editor insert):** `includes/template-library/sources/local.php:746` `get_data()` → `attach_global_styles_to_data()` (`base.php`) attaches `global_classes = { items, order }`.
- **Import merge + class-id remap:** filter `elementor/template_library/import/process_content` fired at `includes/template-library/manager.php:723` (`process_global_styles`) and `includes/template-library/sources/base.php:485` (`prepare_import_template_data`, the file-import path). Handler = `Template_Library_Global_Classes::process_global_classes_import` (`template-library-global-classes.php:40`) → `Template_Library_Import_Export_Utils::process_import_by_mode` (`core/utils/template-library-import-export-utils.php:196`) → merge/create via `Template_Library_Global_Classes_Snapshot_Builder::merge_snapshot_and_get_id_map | create_snapshot_as_new` and content rewrite via `Template_Library_Global_Classes_Element_Transformer::rewrite_elements_classes_ids`.
- **File-import on_import (image sideload etc.):** `base.php:478` `process_export_import_content($content,'on_import')` runs BEFORE the import filter (this is the image-sideload / `on_import` remap path the spec referenced). Note: `save_item` (POST templates) does NOT call this — `on_import` only runs on the import-from-FILE path.

## Merge semantics (match_site, the editor default)

`merge_and_get_id_map` (`core/utils/template-library-snapshot-processor.php:47`) + `is_matching_item()=true` (`template-library-global-classes-snapshot-builder.php:97`, label-based):
- **label match** → reuse existing kit class; if incoming id ≠ existing id, add `incoming→existing` to `id_map` and rewrite content. **No dup, no orphan.**
- **no label match, id collision** → new `g-`-prefixed id, content remapped.
- **no label match, no collision** → keep incoming id.
- **over `MAX_ITEMS`** → flatten (id in `ids_to_flatten`; class inlined as local style by `flatten_elements_classes`). This is the only "lossy" branch.
- `keep_create` mode always creates new (`g-` ids); `keep_flatten` always inlines.

## IMPORT_REMAP_FAILED conditions the Templates vertical must handle

1. **Atomic styles validation throws** on save (`label: class_name_too_short`, `invalid_value`, etc.) — `parse_atomic_styles`/`parse_atomic_settings` reject bad local-style labels/prop envelopes. Local-style `label` must be ≥ a min length (a 1-char label "l" failed). Surface as structured error.
2. **Snapshot missing on insert** — if you call `process_global_styles`/import with content that references a global class but an EMPTY `global_classes` snapshot, the ref cannot be merged. Always pair inserted content with the snapshot from `get_data`. (The MCP must carry `global_classes` alongside `content`.)
3. **Class scrubbed by cleanup** — deleting a global class from the kit fires `Global_Classes_Cleanup::unapply_deleted_classes` (`modules/global-classes/global-classes-cleanup.php:40`) which REWRITES every document's `_elementor_data` to drop that class id (incl. saved templates). A template saved earlier can silently lose its global-class refs if the class is later deleted. Treat global classes as shared mutable state.
4. **`get_data` prunes orphan refs** — a global-class id present in stored content but absent (by ID) from the current kit is dropped from `get_data` content AND yields an empty snapshot. So a template authored against a class id that no longer exists returns un-classed content.
5. **MAX_ITEMS overflow → flatten** — over the kit's class cap, imported classes are flattened to local styles (visual parity, but the relation is lost). Detect via `flattened_classes_count` in the `process_global_styles` response.

## Divergence from editor save (load-bearing)

`save_item` matches editor save for atomic processing + relation registration, with ONE deliberate difference: it does NOT perform the global-class MERGE. Save only re-IDs elements and persists; the global-class merge/remap happens at INSERT time (the editor's two-step `get_data` → `process_global_styles` ajax dance, manager.php:1025), or on file-import via `prepare_import_template_data`. The Templates vertical's `templates.insert_into_page` / `templates.import` MUST replicate the `get_data` → `process_global_styles(import_mode)` step, not just `save_item`.

See `WP-S02-findings.md` for raw command output, the captured template JSON, and the assertion harness result (16/16 PASS).
